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
  retryNow,
  nextDueAt,
  refreshBacklog,
  hasBacklog,
  classifySendResult,
  cleanup as outboxCleanup,
} from './messageOutbox';

// ── WS-FIRST SEND flag (default OFF) ─────────────────────────────────────
// [2026-06-28] When TRUE *and* the socket is healthy, the worker attempts a
// `chat_send` WS frame first and waits up to WS_ACK_TIMEOUT_MS for a
// `message_ack` (latency ~5–30ms vs HTTP's ~150–400ms). On timeout / not-
// healthy / any error it transparently falls back to _httpSend (today's
// path). With the flag FALSE the behaviour is byte-for-byte identical to
// today: every outbox-drained text send goes straight to HTTP.
//
// DO NOT flip this to true until the C++ hub ships its `chat_send` handler
// AND chat.php's chat_send accepts the X-WS-Internal internal POST. See the
// QA checklist — flipping it before the server side is live just burns one
// WS_ACK_TIMEOUT_MS per send before the HTTP fallback (harmless but pointless).
const WS_FIRST_SEND = false;

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
// [send-reliability 2026-10-06] One-shot timer armed at the earliest
// next_retry_at so a 1s/2s/4s backoff actually fires at 1s/2s/4s. Before, a
// row put on backoff was only re-examined by the 60s periodic timer (the
// self-rearm poke ran at t+0, saw it still backing off and skipped it), so the
// "1s" first retry was really ~60s.
let _wakeTimer = null;
let _wakeAt = 0;
function _scheduleWake(at) {
  if (_stopped || at == null || !Number.isFinite(Number(at))) return; // at=0 means 'due now'
  const now = Date.now();
  const due = Math.max(at, now + 250);
  if (_wakeTimer && _wakeAt && _wakeAt <= due) return; // an earlier wake already armed
  if (_wakeTimer) { try { clearTimeout(_wakeTimer); } catch {} }
  _wakeAt = due;
  _wakeTimer = setTimeout(() => { _wakeTimer = null; _wakeAt = 0; poke(); }, due - now);
}
async function _afterDrain() {
  try { await refreshBacklog(); } catch {}
  try {
    const at = await nextDueAt();
    if (at != null) _scheduleWake(at);
  } catch {}
}

/**
 * True when a NEW foreground send for this conversation must NOT go straight
 * to the network because an older message of the same conversation is still
 * waiting (backoff) or being sent by the worker — sending it now would
 * overtake the older one (order break). The caller hands the row to the
 * worker instead (messageOutbox.release + poke).
 */
export function isConversationBusy(conversationId) {
  if (conversationId == null) return false;
  const c = Number(conversationId);
  return _inflight.has(c) || _inflight.has(conversationId) || hasBacklog(c);
}

/**
 * Connectivity regained (WS authenticated / NetInfo up / foreground / boot):
 * reclaim orphaned 'sending' rows, make every queued row due now and drain.
 */
export function kick(reason = 'kick') {
  if (_stopped) return Promise.resolve();
  void reason;
  return Promise.resolve()
    .then(() => recoverStuck().catch(() => 0))
    .then(() => retryNow().catch(() => 0))
    .then(() => { _mediaQueue()?.kick?.()?.catch?.(() => {}); }) // [2026-10-07 send-media]
    .then(() => poke());
}
let _cleanupTimer = null;
let _appStateSub = null;
let _netInfoUnsub = null;
let _wsAuthedUnsub = null;
let _wsReconnectedUnsub = null;
let _wsAckUnsub = null;
let _outboxSubUnsub = null;

// Lazily-required helpers to avoid circular imports at module load.
function _api() {
  try { return require('./api'); } catch { return null; }
}
function _ws() {
  try { return require('./websocket').default; } catch { return null; }
}
// [2026-10-07 send-media] upload lane (compress + resumable upload).
function _mediaQueue() {
  try { const m = require('./mediaSendQueue'); return m.default || m; } catch { return null; }
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
  // Reclaim orphaned 'sending' heads (not owned by an in-flight send of this
  // process) so they can't block their conversation until the next kick.
  try { await recoverStuck(); } catch {}
  try {
    if (conversationId != null) {
      await _drainOneConversation(conversationId);
    } else {
      await _drainAllConversations();
    }
  } finally {
    await _afterDrain();
  }
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
  // [2026-10-07 send-media] msg lane only — upload-lane rows belong to
  // mediaSendQueue (they must not head-block text while bytes upload).
  const pending = await getPending(null, { lane: 'msg' }); // ordered conv ASC, seq ASC
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
    // [send-reliability] A row 'sending' (foreground HTTP in flight, or an
    // orphan awaiting recoverStuck) is the head of its conversation: BLOCK the
    // conversation so a later queued row can't overtake it. 'failed' (hard
    // reject, waiting for the user's tap) does not block later messages.
    if (row.state === 'sending') { startedThisPass.add(conv); continue; }
    if (row.state !== 'queued') continue;
    // Number(), not `| 0`: epoch-ms overflows ToInt32 and the comparison was
    // never true — backoff was dead and failed rows burned all attempts at
    // poke() speed (pair fix with messageOutbox._hydrate).
    if ((Number(row.next_retry_at) || 0) > now) {
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
const MEDIA_TYPES = new Set(['image', 'video', 'voice', 'audio', 'file', 'video_note']); // [2026-10-07 send-media] + video_note

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

  // WS-FIRST (flag-gated, default OFF). When WS_FIRST_SEND is true AND the
  // socket is authenticated/healthy, try a `chat_send` frame first and wait
  // up to WS_ACK_TIMEOUT_MS for the server's `message_ack`. Any other result
  // ('timeout' / 'skip' / unhealthy) falls through to the HTTP path below.
  //
  // With WS_FIRST_SEND=false (today) this whole block is skipped and every
  // send goes straight to HTTP — byte-for-byte the current behaviour.
  //
  // [#bugfix 2026-05-25 — historical] WS-first was disabled because the C++
  // WS server had NO `chat_send` handler, so _tryWsSend always timed out and
  // burned WS_ACK_TIMEOUT_MS before HTTP. That handler now exists in the hub
  // (gated; see /opt/chatyy-ws-cpp/src/main.cpp), so the path is re-enabled
  // here behind the flag. _tryWsSend already marks the row 'sent' on ack.
  if (WS_FIRST_SEND) {
    let wsResult = 'skip';
    try {
      wsResult = await _tryWsSend(row);
    } catch {
      wsResult = 'skip';
    }
    if (wsResult === 'ok') return; // acked over WS — _tryWsSend marked it sent
    // 'timeout' / 'skip' / anything else → HTTP fallback below.
  }

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
  // [2026-10-07 send-media] Rows promoted from mediaSendQueue already have the
  // bytes on the CDN (p.cdn_url) — commit only, never re-upload. Legacy rows
  // (enqueued by older bundles, no cdn_url) keep the upload-here path below.
  const localUri = p.cdn_url ? null : (p.local_uri || p.uri || p.file_url || null);
  const mimeType = p.mime_type || p.type_mime || '';
  const fileName = p.file_name || p.name || 'file';
  const fileSize = p.file_size || 0;
  const msgType = p.type || 'file'; // image|video|voice|audio|file
  const caption = p.caption || p.content || '';

  // Web blob lost after reload — hard fail. UI shows "re-attach" prompt
  // bound to the failed row's client_message_id.
  if (p._blob_lost) {
    await markFailed(cmi, 'blob_lost', { kind: 'hard' });
    return;
  }
  if (!localUri && !p.cdn_url) {
    await markFailed(cmi, 'no_local_uri', { kind: 'hard' });
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
    let cdnUrl = p.cdn_url || null;
    let serverSize = p.server_size || fileSize;
    let serverName = p.server_file_name || fileName;
    let rustResult = null;
    if (!cdnUrl) try {
      if (fileSize > 1 * 1024 * 1024 && api.rustChunkedUpload) {
        rustResult = await api.rustChunkedUpload(filePayload, p.sender_email || null, 'chat');
      } else if (api.rustUpload) {
        rustResult = await api.rustUpload(filePayload, p.sender_email || null, 'chat');
      }
    } catch (e) {
      // Rust path failed — silent, PHP fallback below.
      rustResult = null;
    }
    if (!cdnUrl && rustResult?.success && rustResult.cdn_url) {
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
        ...(p.reply_to_id ? { reply_to_id: p.reply_to_id } : {}),
      }, 'POST');
    } else if (api.chatUploadFile && localUri) {
      // PHP fallback — single combined upload + chat_send. Pass cmi so a
      // replay of this outbox row (response lost on a previous attempt)
      // dedups server-side instead of landing a duplicate photo/blob.
      r = await api.chatUploadFile(
        p.conversation_id,
        filePayload,
        caption,
        !!p.view_once,
        null,
        msgType,
        null,
        false,
        cmi,
      );
    }

    if (r && (r.success || r.message_id || r.data?.message_id)) {
      // Trailing fallbacks r.data?.id / r.id cover the dedup (23505) response:
      // chat_send returns the existing message ROW as {data:{id}} (no
      // message_id key), so without these a race-deduplicated media send did
      // markSent(cmi, null) — the optimistic bubble never got the canonical
      // server id and could resurface as a ghost/duplicate.
      const serverId = r.message_id || r.data?.message_id || r.data?.message?.id || r.message?.id || r.data?.id || r.id || null;
      await markSent(cmi, serverId);
      // Emit a WS-style local fan-out so any mounted chat screen swaps the
      // optimistic bubble for the server-canonical row. Same hook the
      // offlineCache replay path uses.
      try {
        const ws = _ws();
        const serverMsg = r.data?.message || r.data || { id: serverId, client_message_id: cmi };
        ws?.emit?.('chat_message', {
          conversation_id: p.conversation_id,
          message: { ...serverMsg, client_message_id: serverMsg.client_message_id || cmi },
        });
        ws?.relayChatMessage?.(p.conversation_id, serverMsg, p.temp_id || null, []);
        // [2026-10-07 send-media] adopt the local file as the CDN cache copy +
        // drop the durable outbox copy.
        _mediaQueue()?.onCommitted?.({ ...p, client_message_id: cmi }, serverMsg)?.catch?.(() => {});
      } catch {}
      return;
    }

    const errMsg = r?.message || r?.error || 'upload_failed';
    // [send-reliability] Hard errors (413/415/403/size/mime) → 'failed' (tap
    // to retry); anything transient keeps the clock and retries with backoff.
    let kind = classifySendResult(r);
    if (kind === 'ok') kind = 'transient';
    if (/too large|\b413\b|\b415\b|mime|unsupported/i.test(String(errMsg))) kind = 'hard';
    await markFailed(cmi, errMsg, { kind });
  } catch (e) {
    const k = classifySendResult(null, e);
    await markFailed(cmi, e, { kind: k === 'ok' ? 'transient' : k });
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
    await markFailed(row.client_message_id, 'api_unavailable', { kind: 'transient' });
    return;
  }
  const p = row.payload || {};
  const cmi = row.client_message_id;
  let r = null;
  try {
    r = await api.chatSend(
      p.conversation_id,
      p.content || '',
      p.type || 'text',
      p.reply_to_id || null,
      p.mentions || null,
      p.file_url || null,
      p.temp_id || null,
      p.client_message_id || cmi,
      p.topic_id || null,
      // Retries always skip the Rust fast-path (stable temp_id) — PHP dedups
      // on client_message_id and returns the original row.
      { ...(p.opts || {}), skipRust: true },
    );
  } catch (e) {
    const k = classifySendResult(null, e);
    await markFailed(cmi, e, { kind: k === 'ok' ? 'transient' : k });
    return;
  }
  const kind = classifySendResult(r);
  if (kind === 'ok') {
    // chat_send returns the inserted (or dedup-hit) row at r.data.id.
    const serverId = r.data?.id || r.message_id || r.data?.message_id || r.message?.id || null;
    await markSent(cmi, serverId);
    _publishServerRow(p, r, cmi);
    return;
  }
  await markFailed(cmi, r?.message || r?.error || ('http_' + (r?.__httpStatus ?? 0)), { kind });
}

// Reconcile an open chat screen + caches with the server row by client id:
// emits the same local 'chat_message' event the offline replay uses, which
// chat-conversation's handler matches on client_message_id/_client_id and
// swaps the optimistic tmp_ bubble in place (no duplicate bubble). We do NOT
// relay over WS again: chat_send's server fan-out already broadcast the
// canonical row to the peers.
function _publishServerRow(p, r, cmi) {
  try {
    const row = (r && r.data && r.data.id != null) ? r.data : null;
    if (!row || r.envelope_mode) return;
    const serverMsg = { ...row, client_message_id: row.client_message_id || cmi };
    if (p && p.display_content && serverMsg.content !== p.display_content && p._e2e) {
      serverMsg.content = p.display_content; serverMsg._e2e = true;
    }
    try {
      const cc = require('./chatCache');
      cc.removePendingMessage?.(p.conversation_id, p.temp_id)?.catch?.(() => {});
      cc.cacheSingleMessage?.(p.conversation_id, serverMsg)?.catch?.(() => {});
    } catch {}
    try {
      const { removeChatSendFromQueueByClientMsgId } = require('./offlineCache');
      removeChatSendFromQueueByClientMsgId?.(cmi)?.catch?.(() => {});
    } catch {}
    const ws = _ws();
    ws?.emit?.('chat_message', { conversation_id: p.conversation_id, message: serverMsg });
  } catch {}
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

  // On boot, recover any rows stuck mid-flight from a previous crash. Nothing
  // is owned yet in this fresh JS context, so EVERY 'sending' row is an
  // orphan of the previous process → requeued immediately (attempt not
  // counted), then drained in seq order. Backlog set is rebuilt so the
  // foreground won't overtake them.
  recoverStuck().then((n) => {
    if (n > 0) {
      try { console.log('[sendWorker] recovered', n, 'stuck row(s)'); } catch {}
    }
    return refreshBacklog();
  }).catch(() => {});

  // Initial drain after a short delay so the app finishes booting first.
  setTimeout(() => { kick('boot'); }, 1500);
  // [2026-10-07 send-media] media upload lane shares the worker lifecycle.
  try { _mediaQueue()?.start?.(); } catch {}

  // AppState — drain on foreground transition (backoff reset: the network may
  // have come back while we were suspended and no timer fired).
  try {
    _appStateSub = AppState.addEventListener?.('change', (state) => {
      if (state === 'active') kick('foreground');
    });
  } catch {}

  // NetInfo — drain on reconnect.
  try {
    const NetInfo = require('@react-native-community/netinfo');
    const Net = NetInfo?.default || NetInfo;
    if (Net?.addEventListener) {
      let _wasOnline = null;
      _netInfoUnsub = Net.addEventListener((state) => {
        const online = !!(state?.isConnected && state?.isInternetReachable !== false);
        // Only an offline→online EDGE resets backoff (NetInfo re-emits the
        // same state often; a plain poke is enough for those).
        if (online && _wasOnline === false) kick('netinfo');
        else if (online) poke();
        _wasOnline = online;
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
        // Authenticated socket = transport + session are proven alive → reset
        // backoff and flush now. 'connected' (pre-auth) just pokes.
        if (st === 'authenticated') kick('ws_auth');
        else if (st === 'connected') poke();
      };
      _wsAuthedUnsub = ws.on('connection', connListener);
      _wsAckUnsub = ws.on('message_ack', (msg) => {
        // [send-reliability] Only a PERSISTENCE ack (carries the outbox's
        // client_message_id) may flip a row to 'sent'. The Go hub's
        // message_ack is a RELAY ack keyed by temp_id — the message reached
        // the hub, not PG — so trusting it could mark an unsaved row sent
        // and stop its retries (silent loss).
        const cmi = msg?.client_message_id;
        if (!cmi) return;
        const serverId = msg?.msg_id || msg?.server_id || msg?.id || null;
        markSent(cmi, serverId).catch(() => {});
      });
    }
  } catch {}

  // [send-reliability] Any outbox transition (foreground ✓ / failure, a
  // release, a requeue from tap-to-retry) re-arms the drain: rows queued
  // behind a just-finished head go out immediately instead of on the 60s tick.
  try {
    _outboxSubUnsub = messageOutbox.subscribe('*', (snap) => {
      const st = snap && snap.state;
      // [2026-10-07 send-media] upload-lane rows (tap-to-retry requeue, backoff)
      // are drained by mediaSendQueue, not by this FIFO.
      if (snap && snap.lane === 'upload') { if (st === 'queued') _mediaQueue()?.drain?.(); return; }
      if (st === 'sent' || st === 'queued' || st === 'failed' || st === 'removed') _scheduleWake(Date.now());
    });
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
  if (_wakeTimer) { try { clearTimeout(_wakeTimer); } catch {} _wakeTimer = null; _wakeAt = 0; }
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
  try { _outboxSubUnsub?.(); } catch {}
  _outboxSubUnsub = null;
  _inflight.clear();
  try { _mediaQueue()?.stop?.(); } catch {}
}

export default { start, stop, poke, send, kick, isConversationBusy };
