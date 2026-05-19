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
  // Loop until no more due rows. We loop instead of recursing so we don't
  // hammer the call stack on a flush of dozens of queued messages.
  let safetyCounter = 200; // catastrophic backstop, drain at most 200 per pass
  while (safetyCounter-- > 0) {
    const row = await dequeueNext(conversationId);
    if (!row) break;
    if (_inflight.has(row.conversation_id)) {
      // Another send is in flight for this conv — skip and look elsewhere.
      // When ALL active convs are blocked, dequeueNext keeps returning the
      // same row, so we break to avoid a tight loop.
      if (conversationId != null) break;
      // For global drain, advance past this row by claiming we tried it.
      // We can't easily SKIP per-conv in pure SQL without temp table; the
      // simpler path is: break out, let the next poke re-evaluate after
      // the in-flight send resolves.
      break;
    }
    _inflight.add(row.conversation_id);
    // Don't await — let each conversation drain in parallel. The per-conv
    // FIFO guarantee comes from the _inflight set + dequeueNext ordering.
    _processRow(row).finally(() => {
      _inflight.delete(row.conversation_id);
      // Self-rearm: as soon as one row finishes, look for the next in the
      // same conversation. This is what keeps the queue draining without
      // waiting on the periodic timer.
      setTimeout(() => { poke(row.conversation_id); }, 0);
    });
    // Yield to event loop so multiple convs can fan out.
    if (conversationId != null) break; // single-conv drain handled above
  }
}

async function _processRow(row) {
  const cmi = row.client_message_id;
  const claimed = await markSending(cmi);
  if (!claimed) return; // someone else got it (boot race)

  // Try WS-first when authenticated and we have a chat_send-shaped payload.
  // Falls back to HTTP on timeout/error/socket-down.
  const wsResult = await _tryWsSend(row);
  if (wsResult === 'ok') return; // markSent fired inside ack listener
  if (wsResult === 'rejected') {
    // Server explicitly rejected over WS — don't HTTP-retry the same payload
    // immediately, schedule a backoff. UI will surface state='failed'.
    await markFailed(cmi, 'ws_rejected');
    return;
  }
  // WS path didn't land in time → HTTP fallback.
  await _httpSend(row);
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

  // WS hooks — both authenticated (cold-start of socket) and reconnected
  // (post-disconnect re-auth) fire poke, plus we wire msg_ack to flip
  // outbox state in real-time even when our send used HTTP (server
  // broadcasts msg_ack on the sender's channel).
  try {
    const ws = _ws();
    if (ws?.on) {
      _wsAuthedUnsub = ws.on('authenticated', () => { poke(); });
      // 'connection' fires with status='authenticated' too; listen for it
      // as well for older WS plumbing that emits the umbrella event.
      const connListener = (data) => {
        if (data?.status === 'authenticated') poke();
      };
      try { ws.on('connection', connListener); } catch {}
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
