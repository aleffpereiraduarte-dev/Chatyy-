/**
 * Send Worker — singleton outbox drainer with WS-first delivery.
 *
 * Drives `messageOutbox` rows from `queued` → `sending` → `sent`. Per-
 * conversation FIFO: only one in-flight send per conversation at a time so
 * the recipient sees messages in the same order the sender typed them.
 *
 * Delivery strategy (WhatsApp-grade):
 *   1. WS-first: if socket authenticated, attempt a `chat_send` frame and
 *      wait up to 3s for a `message_ack`. Fastest possible (~5–30ms).
 *   2. HTTP fallback: on WS timeout / disconnect / error, fire api.chatSend
 *      (existing path with full Rust→PHP fallback chain). Server dedups
 *      on (sender_email, client_message_id) so a race here is harmless.
 *
 * Trigger pokes (instant drain on connectivity events):
 *   - AppState → 'active'
 *   - NetInfo → isConnected=true
 *   - WebSocket → 'authenticated' / 'reconnected'
 *
 * Each poke() runs at most one drain at a time across the whole app (mutex).
 * Periodic safety net every 60s catches anything else.
 */
import { Platform, AppState } from 'react-native';
import messageOutbox, {
  enqueue,
  dequeueNext,
  getPending,
  markSending,
  markSent,
  markFailed,
  recoverStuck,
  cleanup as outboxCleanup,
} from './messageOutbox';

// One-shot guards
let _started = false;
let _stopped = false;

// Per-conversation in-flight map prevents overtaking the FIFO order.
const _inflight = new Set(); // conversation_id

// Global mutex so two simultaneous pokes don't race.
let _drainPromise = null;

// WS ack timeout (ms). After this we fall back to HTTP.
// [#1186/Agent C 2026-05-19] DROPPED 3000 → 250ms. The backend Go WS hub
// has NO `case "chat_send":` handler — every frame is silently dropped
// and the worker burned the full 3s waiting for an ack that never came,
// THEN fell back to HTTP. User perception: "demora tempão pra enviar".
// 250ms is well under the human-perceptible latency floor, so on the rare
// path where a WS handler IS added later, healthy ack still lands in time.
const WS_ACK_TIMEOUT_MS = 250;

// Periodic safety drain. 60s matches outboxDrainer.js so the two paths
// don't fight each other.
const PERIODIC_INTERVAL_MS = 60000;

// Cleanup interval — sweep acked rows once per hour.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let _periodicTimer = null;
let _cleanupTimer = null;
let _appStateSub = null;
let _netInfoUnsub = null;
let _wsAuthedUnsub = null;
let _wsReconnectedUnsub = null;
let _wsAckUnsub = null;

// Lazily-required helpers to avoid circular imports at module load.
function _api() {
  try { return require('./api'); } catch { return null; }
}
function _ws() {
  try { return require('./websocket').default; } catch { return null; }
}

/**
 * Enqueue a payload (public helper — most callers go through api.chatSend
 * which writes to its own offline_queue. This is the explicit outbox path
 * for new callers that want full state-machine visibility).
 */
export async function send(payload) {
  const r = await enqueue(payload);
  if (r) poke(payload.conversation_id);
  return r;
}

/**
 * Drain the outbox for the given conversation (or all conversations when
 * conversationId is null). Idempotent — overlapping pokes coalesce.
 */
export function poke(conversationId = null) {
  if (_stopped) return;
  if (_drainPromise) return _drainPromise;
  _drainPromise = _drainLoop(conversationId).finally(() => {
    _drainPromise = null;
  });
  return _drainPromise;
}

async function _drainLoop(conversationId) {
  if (conversationId != null) {
    await _drainOneConversation(conversationId);
    return;
  }
  await _drainAllConversations();
}

// Single-conversation drain: claim the lowest-due row, fan it out, and let
// the per-conv self-rearm (in _kickoff's finally) chase the next seq. We take
// at most one row here because the in-flight guard enforces strict FIFO — the
// next row only goes out after this one resolves.
async function _drainOneConversation(conversationId) {
  if (_inflight.has(Number(conversationId)) || _inflight.has(conversationId)) return;
  const row = await dequeueNext(conversationId);
  if (!row) return;
  if (_inflight.has(row.conversation_id)) return;
  _kickoff(row);
}

// Global drain (conversationId == null). [#bugfix 2026-05-25] Previously this
// called dequeueNext(null) in a loop; that orders by conversation_id ASC, so
// if the lowest-id conversation was already _inflight the loop BROKE outright,
// starving every higher-id conversation until the 60s periodic timer. Now we
// snapshot all pending rows once (already ordered conversation_id ASC, seq
// ASC), then fan out the FIRST due row of each NOT-already-in-flight
// conversation — one in-flight per conversation, many conversations at once.
// A per-pass skip set keeps us from launching two sends for the same conv.
async function _drainAllConversations() {
  const pending = await getPending(null); // ordered conv ASC, seq ASC
  if (!pending || pending.length === 0) return;
  const now = Date.now();
  const startedThisPass = new Set();
  let launched = 0;
  for (const row of pending) {
    if (launched >= 200) break; // catastrophic backstop
    const conv = row.conversation_id;
    // Already in flight or blocked earlier this pass — never launch a
    // higher-seq row of the same conversation (strict FIFO).
    if (_inflight.has(conv) || startedThisPass.has(conv)) continue;
    if (row.state !== 'queued') continue;       // skip sending/failed-waiting
    if ((row.next_retry_at | 0) > now) {
      // [#bugfix FIFO] This is the LOWEST-seq pending row for this conv
      // (rows arrive ordered conv ASC, seq ASC) and it's still in backoff.
      // BLOCK the whole conversation this pass — otherwise a newer
      // (higher-seq) queued message would overtake it and the recipient
      // sees messages out of order. The conv re-evaluates next pass once
      // the backoff elapses.
      startedThisPass.add(conv);
      continue;
    }
    // First due row encountered for this conv wins (lowest seq → FIFO).
    startedThisPass.add(conv);
    _kickoff(row);
    launched++;
  }
}

// Claim a row in-flight and process it. On completion, self-rearm the SAME
// conversation so its remaining backlog drains without waiting on the timer.
function _kickoff(row) {
  _inflight.add(row.conversation_id);
  // Don't await — let each conversation drain in parallel. The per-conv
  // FIFO guarantee comes from the _inflight set + seq ordering.
  _processRow(row).finally(() => {
    _inflight.delete(row.conversation_id);
    // Self-rearm with a GLOBAL poke. A global drain re-evaluates every
    // conversation (including this one's next seq) and fans out one row per
    // not-in-flight conversation — so this both chases the same conv's
    // backlog AND unblocks any conversation that was skipped earlier because
    // it was momentarily in-flight. We deliberately do NOT use a single-conv
    // poke here: poke() coalesces through the mutex, and a single-conv drain
    // would swallow the global re-poke and re-starve higher-id conversations.
    setTimeout(() => { poke(); }, 0);
  });
}

// Media types we treat as "needs upload before chat_send".
const MEDIA_TYPES = new Set(['image', 'video', 'voice', 'audio', 'file']);

async function _processRow(row) {
  const cmi = row.client_message_id;
  const claimed = await markSending(cmi);
  if (!claimed) return; // someone else got it (boot race)

  const payload = row.payload || {};
  const ptype = payload.type || 'text';

  // Media branch — upload local_uri then chain chat_send. WS-first path is
  // text-only because the WS hub has no upload primitive.
  if (MEDIA_TYPES.has(ptype)) {
    await _uploadAndSendMedia(row);
    return;
  }

  // [#bugfix 2026-05-25] WS-first is DISABLED. The C++ WS server has NO
  // `chat_send` handler — every frame we'd send is silently dropped, so
  // _tryWsSend ALWAYS times out (WS_ACK_TIMEOUT_MS) and then falls to HTTP.
  // That's a guaranteed ~250ms of dead latency on every outbox-drained
  // send (queued / retry). Go straight to HTTP instead. _tryWsSend is left
  // intact below as dead code: re-enable this call only once the server
  // actually implements a `case "chat_send":` and replies `message_ack`.
  // (The foreground path in app/chat-conversation.js is unaffected — it
  // does not use this worker.)
  await _httpSend(row);
}

// ---------------------------------------------------------------------------
// Media upload-then-send path
// ---------------------------------------------------------------------------
//
// Mirrors uploadAndSendFile() in app/chat-conversation.js (the foreground
// path) but for offline-queued rows: read the persisted local_uri, push to
// R2 via rustUpload (PHP fallback), then chat_send with the resulting
// cdn_url. Marks the outbox row 'sent' on success, 'failed' otherwise.
//
// Platform caveats:
//   - Native: file:// URIs in documentDirectory persist across launches, so
//     a row enqueued days ago can still be uploaded.
//   - Web: blob:URLs die when the tab closes. payload._blob_lost=true is set
//     on hydrate (by chat-conversation's replay UI). We hard-fail those rows
//     so the UI can prompt re-attach instead of looping forever.
async function _uploadAndSendMedia(row) {
  const api = _api();
  if (!api) {
    await markFailed(row.client_message_id, 'api_unavailable');
    return;
  }
  const p = row.payload || {};
  const cmi = row.client_message_id;
  const localUri = p.local_uri || p.uri || p.file_url || null;
  const mimeType = p.mime_type || p.type_mime || '';
  const fileName = p.file_name || p.name || 'file';
  const fileSize = p.file_size || 0;
  const msgType = p.type || 'file'; // image|video|voice|audio|file
  const caption = p.caption || p.content || '';

  // Web blob lost after reload — hard fail. UI shows "re-attach" prompt
  // bound to the failed row's client_message_id.
  if (p._blob_lost) {
    await markFailed(cmi, 'blob_lost');
    return;
  }
  if (!localUri) {
    await markFailed(cmi, 'no_local_uri');
    return;
  }

  const filePayload = {
    uri: localUri,
    name: fileName,
    type: mimeType,
    size: fileSize,
  };

  try {
    // Try Rust direct-to-R2 upload first; fall back to PHP chatUploadFile.
    let cdnUrl = null;
    let serverSize = fileSize;
    let serverName = fileName;
    let rustResult = null;
    try {
      if (fileSize > 1 * 1024 * 1024 && api.rustChunkedUpload) {
        rustResult = await api.rustChunkedUpload(filePayload, p.sender_email || null, 'chat');
      } else if (api.rustUpload) {
        rustResult = await api.rustUpload(filePayload, p.sender_email || null, 'chat');
      }
    } catch (e) {
      // Rust path failed — silent, PHP fallback below.
      rustResult = null;
    }
    if (rustResult?.success && rustResult.cdn_url) {
      cdnUrl = rustResult.cdn_url;
      serverSize = rustResult.size || fileSize;
      serverName = rustResult.filename || fileName;
    }

    let r = null;
    if (cdnUrl) {
      // Rust uploaded — call chat_send with the cdn_url.
      r = await api.apiCall('chat_send', {
        conversation_id: p.conversation_id,
        content: caption || '',
        type: msgType,
        file_url: cdnUrl,
        file_name: serverName,
        file_size: serverSize,
        view_once: p.view_once ? 1 : 0,
        client_message_id: cmi,
        temp_id: p.temp_id || null,
      }, 'POST');
    } else if (api.chatUploadFile) {
      // PHP fallback — single combined upload + chat_send.
      r = await api.chatUploadFile(
        p.conversation_id,
        filePayload,
        caption,
        !!p.view_once,
        null,
        msgType,
        null,
      );
    }

    if (r && (r.success || r.message_id || r.data?.message_id)) {
      const serverId = r.message_id || r.data?.message_id || r.data?.message?.id || r.message?.id || null;
      await markSent(cmi, serverId);
      // Emit a WS-style local fan-out so any mounted chat screen swaps the
      // optimistic bubble for the server-canonical row. Same hook the
      // offlineCache replay path uses.
      try {
        const ws = _ws();
        const serverMsg = r.data?.message || r.data || { id: serverId, client_message_id: cmi };
        ws?.emit?.('chat_message', {
          conversation_id: p.conversation_id,
          message: serverMsg,
        });
        ws?.relayChatMessage?.(p.conversation_id, serverMsg, p.temp_id || null, []);
      } catch {}
      return;
    }

    const errMsg = r?.message || r?.error || 'upload_failed';
    // Hard errors (413/415/403/size/mime) shouldn't retry; sentinel the row
    // so markFailed treats max-attempts as permanent. We don't have a
    // 'hard fail' flag in messageOutbox, so we fast-fail by pushing attempts
    // to MAX via marking failed in a loop is overkill — simpler: pass the
    // error string and let backoff burn off naturally (UI shows failed).
    await markFailed(cmi, errMsg);
  } catch (e) {
    await markFailed(cmi, e);
  }
}

// ---------------------------------------------------------------------------
// WS path
// ---------------------------------------------------------------------------
async function _tryWsSend(row) {
  const ws = _ws();
  if (!ws || !ws.isConnected || !ws.authenticated) return 'skip';
  const payload = row.payload || {};
  // Minimum required fields. Envelope-mode rows skip WS entirely because the
  // server endpoint is `chat_envelope_send` which doesn't have a WS twin.
  if (payload._envelope_mode) return 'skip';
  if (!payload.conversation_id || !payload.client_message_id) return 'skip';

  return await new Promise((resolve) => {
    let settled = false;
    const ackUnsub = messageOutbox.subscribe(row.client_message_id, () => {});
    const offAck = ws.on?.('message_ack', (msg) => {
      if (settled) return;
      const ackCmi = msg?.client_message_id || msg?.temp_id || '';
      if (ackCmi !== row.client_message_id) return;
      settled = true;
      try { offAck?.(); } catch {}
      try { ackUnsub?.(); } catch {}
      const serverId = msg?.msg_id || msg?.server_id || msg?.id || null;
      markSent(row.client_message_id, serverId).catch(() => {});
      resolve('ok');
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { offAck?.(); } catch {}
      try { ackUnsub?.(); } catch {}
      resolve('timeout');
    }, WS_ACK_TIMEOUT_MS);
    // Send the frame. `chat_send` type tells the Go WS hub to forward to
    // the persistence side (when supported); on legacy hubs without that
    // type, the frame is silently dropped and we time out → HTTP fallback.
    try {
      const frame = {
        type: 'chat_send',
        client_message_id: row.client_message_id,
        conversation_id: payload.conversation_id,
        content: payload.content || '',
        msg_type: payload.type || 'text',
        reply_to_id: payload.reply_to_id || null,
        file_url: payload.file_url || null,
        mentions: payload.mentions || null,
        topic_id: payload.topic_id || null,
      };
      // Use the public _send helper if exposed, else fallback to raw send.
      if (typeof ws._send === 'function') ws._send(frame);
      else if (ws.ws && ws.ws.readyState === 1) ws.ws.send(JSON.stringify(frame));
      else {
        // Socket gone — abort and let HTTP take over.
        clearTimeout(timeout);
        settled = true;
        try { offAck?.(); } catch {}
        try { ackUnsub?.(); } catch {}
        resolve('skip');
      }
    } catch {
      clearTimeout(timeout);
      settled = true;
      try { offAck?.(); } catch {}
      try { ackUnsub?.(); } catch {}
      resolve('skip');
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP fallback path
// ---------------------------------------------------------------------------
async function _httpSend(row) {
  const api = _api();
  if (!api?.chatSend) {
    await markFailed(row.client_message_id, 'api_unavailable');
    return;
  }
  const p = row.payload || {};
  try {
    const r = await api.chatSend(
      p.conversation_id,
      p.content || '',
      p.type || 'text',
      p.reply_to_id || null,
      p.mentions || null,
      p.file_url || null,
      p.temp_id || null,
      p.client_message_id,
      p.topic_id || null,
      p.opts || null,
    );
    if (r && (r.success || r.envelope_mode || r.message_id || r.data?.message_id)) {
      const serverId = r.message_id || r.data?.message_id || r.message?.id || null;
      await markSent(row.client_message_id, serverId);
    } else if (r && r.success === false) {
      // Server-side rejection — backoff.
      await markFailed(row.client_message_id, r.message || r.error || 'rejected');
    } else {
      await markFailed(row.client_message_id, 'unknown_response');
    }
  } catch (e) {
    await markFailed(row.client_message_id, e);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the worker. Wires AppState + NetInfo + WS listeners and starts the
 * periodic safety drain. Safe to call multiple times.
 */
export function start() {
  if (_started) return;
  _started = true;
  _stopped = false;

  // On boot, recover any rows stuck mid-flight from a previous crash.
  recoverStuck().then((n) => {
    if (n > 0) {
      try { console.log('[sendWorker] recovered', n, 'stuck row(s)'); } catch {}
    }
  }).catch(() => {});

  // Initial drain after a short delay so the app finishes booting first.
  setTimeout(() => { poke(); }, 2000);

  // AppState — drain on foreground transition.
  try {
    _appStateSub = AppState.addEventListener?.('change', (state) => {
      if (state === 'active') poke();
    });
  } catch {}

  // NetInfo — drain on reconnect.
  try {
    const NetInfo = require('@react-native-community/netinfo');
    const Net = NetInfo?.default || NetInfo;
    if (Net?.addEventListener) {
      _netInfoUnsub = Net.addEventListener((state) => {
        if (state?.isConnected && state?.isInternetReachable !== false) {
          poke();
        }
      });
    }
  } catch {}

  // WS hooks — drain on socket ready, plus wire msg_ack to flip outbox
  // state in real-time even when our send used HTTP (server broadcasts
  // msg_ack on the sender's channel).
  //
  // [#bugfix] The WS class NEVER emits bare 'authenticated'/'reconnected'
  // events — it emits a single umbrella 'connection' event with a `status`
  // field. The old ws.on('authenticated', …) / ws.on('reconnected', …)
  // listeners were dead and never fired a poke on (re)connect, so the
  // outbox only drained on the 60s safety timer after a reconnect. Listen
  // for the real ready-states instead: 'authenticated' (socket logged in)
  // and 'connected' (fresh/reconnected transport).
  try {
    const ws = _ws();
    if (ws?.on) {
      const connListener = (data) => {
        const st = data?.status;
        if (st === 'authenticated' || st === 'connected') poke();
      };
      _wsAuthedUnsub = ws.on('connection', connListener);
      _wsAckUnsub = ws.on('message_ack', (msg) => {
        const cmi = msg?.client_message_id || msg?.temp_id;
        if (!cmi) return;
        const serverId = msg?.msg_id || msg?.server_id || msg?.id || null;
        markSent(cmi, serverId).catch(() => {});
      });
    }
  } catch {}

  // Periodic safety net.
  _periodicTimer = setInterval(() => { poke(); }, PERIODIC_INTERVAL_MS);
  _cleanupTimer = setInterval(() => { outboxCleanup().catch(() => {}); }, CLEANUP_INTERVAL_MS);
}

export function stop() {
  _stopped = true;
  _started = false;
  if (_periodicTimer) { try { clearInterval(_periodicTimer); } catch {} _periodicTimer = null; }
  if (_cleanupTimer) { try { clearInterval(_cleanupTimer); } catch {} _cleanupTimer = null; }
  try { _appStateSub?.remove?.(); } catch {}
  _appStateSub = null;
  try { _netInfoUnsub?.(); } catch {}
  _netInfoUnsub = null;
  try { _wsAuthedUnsub?.(); } catch {}
  _wsAuthedUnsub = null;
  try { _wsReconnectedUnsub?.(); } catch {}
  _wsReconnectedUnsub = null;
  try { _wsAckUnsub?.(); } catch {}
  _wsAckUnsub = null;
  _inflight.clear();
}

export default { start, stop, poke, send };
