/**
 * Stage 6 — WS relay CLIENT (requester side).
 *
 * Counterpart of services/relayResponder.js. Where relayResponder.js handles
 * incoming relay_request on the phone, this module sits on the WEB side and
 * sends relay_request out → awaits relay_response.
 *
 * Flow:
 *   1. Web bundle calls e.g. chatMessages(convId) in services/api.js.
 *   2. api.js sees Platform.OS === 'web' + isAvailable() and delegates to
 *      one of the helpers below (getMessagesViaRelay, etc.).
 *   3. relayRequest() generates a requestId, sends `{type:'relay_request',
 *      requestId, action, params, requesterDeviceId, requesterKind:'web'}`
 *      over WS, parks the resolver in a Map keyed by requestId.
 *   4. The WS server (prod, Stages 3+4) forwards to the phone via
 *      chat_user_<email>. relayResponder.js on the phone reads SQLite and
 *      sends `relay_response` back. If the phone is offline, the server
 *      fires a silent push to wake it and parks the request 15s. After 15s
 *      it returns `error: 'phone_offline'` or `'relay_timeout'`.
 *   5. websocket.js dispatches relay_response to handleRelayResponse() in
 *      this module via the `relay_response` event channel. The map lookup
 *      resolves or rejects the original Promise.
 *
 * Timeout choice: 12s. Server parks for ~15s on silent-push wake, so we want
 * to give the server time to either succeed OR return its own phone_offline
 * sentinel — without sitting in the UI forever if the server itself died.
 * (Server-side errors come back as fast relay_response with `error`; the
 * timeout below only fires when the server never sends ANYTHING back, e.g.
 * the socket itself died between the request and the response.)
 *
 * WhatsApp-Web pattern: relay is the PRIMARY read path on web. REST is only
 * a fallback through services/api.js when isAvailable() returns false.
 *
 * Relay action whitelist (must match server RELAY_ACTION_WHITELIST AND the
 * phone-side HANDLERS map in relayResponder.js): get_messages,
 * get_conversations, get_starred, get_pinned, search_messages,
 * get_media_url, get_status.
 */
import { Platform } from 'react-native';
import mailWs from './websocket';

const DEFAULT_TIMEOUT_MS = 12000;

// requestId -> { resolve, reject, timer }
const _pending = new Map();

// One-shot WS listener install. websocket.js's default-case _emit fires the
// raw message object for unknown types, but relay_response specifically
// needs requestId/error/data at the TOP level, not just the inner data
// payload (which is what default emit passes). So we install an explicit
// listener for 'relay_response' which we manually emit from websocket.js
// inside an explicit case branch.
let _listenerInstalled = false;
function _ensureListener() {
  if (_listenerInstalled) return;
  _listenerInstalled = true;
  try {
    mailWs.on('relay_response', _handleRelayResponse);
  } catch {
    // mailWs not initialized at module-eval time; we'll retry on next call.
    _listenerInstalled = false;
  }
}

function _genRequestId() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
      return 'rel_' + globalThis.crypto.randomUUID().replace(/-/g, '');
    }
  } catch {}
  // Fallback: time + random hex. Collision risk is negligible since we
  // only need uniqueness across the in-flight pending map (usually <5).
  return 'rel_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
}

function _handleRelayResponse(msg) {
  // msg may be the top-level frame OR have its payload under .data (depends
  // on which path inside websocket.js fires the emit). Normalize.
  const m = msg && typeof msg === 'object' ? msg : {};
  const requestId = m.requestId || m.request_id || m?.data?.requestId || m?.data?.request_id;
  if (!requestId) return;
  const entry = _pending.get(requestId);
  if (!entry) return; // late response after timeout — drop silently
  _pending.delete(requestId);
  if (entry.timer) clearTimeout(entry.timer);
  const error = m.error || m?.data?.error;
  if (error) {
    const err = new Error(String(error));
    err.code = String(error);
    entry.reject(err);
  } else {
    // Phone responder wraps everything in { data: <handler-return> }. Accept
    // both shapes (top-level data field OR a flat payload) so the helpers
    // below don't have to care.
    const payload = (m.data !== undefined && m.data !== null) ? m.data : m;
    entry.resolve(payload);
  }
}

/**
 * Get a stable identifier for this web device. Used by the server to
 * route the response back to US (not some other web tab on the same
 * account). Falls back to the WS-assigned ephemeral id if no persisted
 * device_id exists yet (e.g. user hasn't paired via QR).
 */
function _getRequesterDeviceId() {
  try {
    if (typeof localStorage !== 'undefined') {
      const id = localStorage.getItem('chat_device_id');
      if (id) return id;
    }
  } catch {}
  // No persisted id — server will route on connection email + WS conn id.
  return null;
}

/**
 * Core relay primitive. Sends one relay_request over WS, awaits a matching
 * relay_response (by requestId), resolves with the payload or rejects with
 * an Error whose `.code` is the server-provided error string.
 *
 * Common error codes (raised as Error.code):
 *   - 'phone_offline'    — silent push fired, phone never reconnected in 15s
 *   - 'relay_timeout'    — phone connected but never responded
 *   - 'no_paired_device' — only paired device IS this web (loop) or none
 *   - 'unknown_action'   — action not in whitelist
 *   - 'ws_unavailable'   — local WS not connected (raised before send)
 *   - 'request_timeout'  — no response within our local timeout
 */
export function relayRequest(action, params = {}, timeout = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    _ensureListener();
    if (!mailWs || !mailWs.isConnected) {
      const err = new Error('ws_unavailable');
      err.code = 'ws_unavailable';
      reject(err);
      return;
    }
    const requestId = _genRequestId();
    const requesterDeviceId = _getRequesterDeviceId();
    const frame = {
      type: 'relay_request',
      requestId,
      action,
      params: params || {},
      requesterDeviceId,
      requesterKind: 'web',
    };

    const timer = setTimeout(() => {
      const entry = _pending.get(requestId);
      if (!entry) return;
      _pending.delete(requestId);
      const err = new Error('request_timeout');
      err.code = 'request_timeout';
      entry.reject(err);
    }, Math.max(1000, timeout | 0));

    _pending.set(requestId, { resolve, reject, timer });

    try {
      mailWs.send(frame);
    } catch (e) {
      _pending.delete(requestId);
      clearTimeout(timer);
      const err = new Error('send_failed');
      err.code = 'send_failed';
      err.cause = e;
      reject(err);
    }
  });
}

// ─── High-level helpers (one per whitelisted action) ───
// Each shapes its params to match what the phone-side handler expects in
// services/relayResponder.js. Return shape matches what the corresponding
// REST endpoint would return so callers in api.js can swap transports
// without unwrapping differences.

export async function getMessagesViaRelay(conversationId, beforeId = null, limit = 50) {
  const params = {
    conversation_id: conversationId,
    limit: Math.min(parseInt(limit, 10) || 50, 200),
  };
  if (beforeId) params.before_id = beforeId;
  const data = await relayRequest('get_messages', params);
  // Phone responder returns { messages: [...], conversation_id }.
  // Reshape to the REST response shape: { success: true, data: { messages } }.
  const messages = (data && Array.isArray(data.messages)) ? data.messages : [];
  return { success: true, data: { messages, conversation_id: conversationId } };
}

export async function getConversationsViaRelay() {
  const data = await relayRequest('get_conversations', {});
  const conversations = (data && Array.isArray(data.conversations)) ? data.conversations : [];
  return { success: true, data: { conversations } };
}

export async function getStarredViaRelay() {
  const data = await relayRequest('get_starred', {});
  const messages = (data && Array.isArray(data.messages)) ? data.messages : [];
  return { success: true, data: { messages } };
}

export async function getPinnedViaRelay(conversationId) {
  const params = { conversation_id: conversationId };
  const data = await relayRequest('get_pinned', params);
  const messages = (data && Array.isArray(data.messages)) ? data.messages : [];
  return { success: true, data: { messages, conversation_id: conversationId } };
}

export async function searchMessagesViaRelay(query, conversationId = null) {
  const params = { query: String(query || '').trim() };
  if (conversationId) params.conversation_id = conversationId;
  const data = await relayRequest('search_messages', params);
  // Phone responder returns { results: [...] }.
  const results = (data && (Array.isArray(data.results) ? data.results : (Array.isArray(data.messages) ? data.messages : []))) || [];
  return { success: true, data: { results, conversation_id: conversationId } };
}

/**
 * Bootstrap chat history on a freshly-paired device by pulling conversations
 * + recent messages from the primary peer (the device that has the SQLite
 * history) via relay. Designed to run ONCE right after QR approval — the
 * caller is expected to gate re-runs with a per-email AsyncStorage flag
 * (see chat_bootstrap_done_<email> in app/companion-qr.js).
 *
 * Behavior:
 *  - Fetches conversation list via `get_conversations`.
 *  - Sorts by last_message_time desc, takes the top `maxConversations`.
 *  - For each conv, in batches of 5 concurrent: fetches last 100 messages
 *    via `get_messages` and persists via dbSaveConversations/dbSaveMessages
 *    (INSERT OR REPLACE — idempotent if the row already exists).
 *  - Per-conversation idempotency: if the local SQLite already has any
 *    messages for that conv (dbGetLastMessageId > 0) we SKIP the fetch.
 *    This lets the user re-run the bootstrap manually without re-pulling
 *    a 5MB history every time.
 *  - Errors per-conversation are swallowed (logged via debugLogger if
 *    available). A single bad conv shouldn't tank the whole sync.
 *  - onProgress({ done, total, conversation_id, conversation_name }) is
 *    fired BEFORE each conv fetch starts (so the UI can render
 *    "Sincronizando 12 de 50 conversas — <name>").
 *
 * Params:
 *  - targetDeviceId  (string|null) — the peer to ask. If null, server picks
 *    the first non-web paired device automatically (server-side
 *    `no_paired_device` error covers the empty case).
 *  - maxConversations (number, default 50) — hard cap on convs pulled.
 *    50 covers ~99% of WhatsApp-active accounts; bigger pulls risk OOM
 *    on low-memory Androids during the parallel fetch phase.
 *  - onProgress  (function|null) — UI callback. Called synchronously
 *    inside the worker loop so it can update React state every step.
 *
 * Returns: { success: bool, done: number, total: number, error?: string }
 *
 * Throws nothing — all errors are returned via the result object so the
 * caller doesn't have to wrap the call in try/catch just for telemetry.
 */
export async function bootstrapHistoryFromPeer(opts = {}) {
  // maxConversations is accepted for backwards-compat with old callers but
  // is no longer used to cap the iteration — we now pull EVERY conversation
  // the peer reports. WhatsApp Web-grade: a fresh pair should see the full
  // history, not a "top 50" preview that then leaves the rest invisible
  // until the user happens to scroll into a conv we silently dropped.
  const {
    targetDeviceId = null,
    onProgress = null,
    perBatchLimit = 100,   // messages per get_messages page
    maxBatchesPerConv = 50, // safety cap = up to 5,000 msgs per conv
  } = opts || {};

  // We use the same db.js helpers the rest of the chat stack uses; require
  // lazily so this module stays loadable on web (where db.js is a no-op
  // shim) and so we don't introduce a module-eval cycle.
  let db = null;
  try { db = require('./db'); } catch {}
  const dbSaveConversations = db?.dbSaveConversations || (async () => {});
  const dbSaveMessages      = db?.dbSaveMessages      || (async () => {});
  const _getDb              = db?.getDb               || (() => null);

  let log = null;
  try { log = require('./debugLogger'); } catch {}
  const _log = (msg, extra) => {
    try {
      if (log?.logger?.info) log.logger.info(`[bootstrap] ${msg}`, extra || {});
      else if (log?.info) log.info(`[bootstrap] ${msg}`, extra || {});
      else if (__DEV__) console.log(`[bootstrap] ${msg}`, extra || '');
    } catch {}
  };

  // ── Per-conversation sync checkpoint table ────────────────────────────
  // Stores the oldest message id we've successfully imported for each
  // conversation so a resumed bootstrap (after app kill / network drop)
  // continues paginating from where we left off instead of re-pulling the
  // whole tail. Created lazily — safe to call repeatedly. Separate from the
  // existing db.js `sync_state` table (which is keyed by table_name, not
  // conv_id) to avoid schema conflict and keep migration trivial.
  async function _ensureSyncStateTable() {
    const sqlite = _getDb();
    if (!sqlite || typeof sqlite.execAsync !== 'function') return false;
    try {
      await sqlite.execAsync(
        `CREATE TABLE IF NOT EXISTS chat_conv_sync_state (
          conv_id TEXT PRIMARY KEY,
          oldest_id TEXT,
          last_synced_at INTEGER
        );`
      );
      return true;
    } catch (e) {
      _log('chat_conv_sync_state create failed', { message: e?.message });
      return false;
    }
  }
  async function _getCheckpoint(cid) {
    const sqlite = _getDb();
    if (!sqlite || typeof sqlite.getFirstAsync !== 'function') return null;
    try {
      const row = await sqlite.getFirstAsync(
        'SELECT oldest_id, last_synced_at FROM chat_conv_sync_state WHERE conv_id = ?',
        [String(cid)]
      );
      return row || null;
    } catch { return null; }
  }
  async function _setCheckpoint(cid, oldestId) {
    const sqlite = _getDb();
    if (!sqlite || typeof sqlite.runAsync !== 'function') return;
    try {
      await sqlite.runAsync(
        `INSERT INTO chat_conv_sync_state (conv_id, oldest_id, last_synced_at)
         VALUES (?, ?, ?)
         ON CONFLICT(conv_id) DO UPDATE SET oldest_id = excluded.oldest_id,
                                            last_synced_at = excluded.last_synced_at`,
        [String(cid), oldestId != null ? String(oldestId) : null, Date.now()]
      );
    } catch (e) {
      _log('chat_conv_sync_state upsert failed', { cid, message: e?.message });
    }
  }

  await _ensureSyncStateTable();

  // Step 1 — pull the conversation list. We pass target_device_id so the
  // server routes specifically (otherwise it picks any paired non-web).
  // NOTE: get_conversations on the peer side returns ALL conversations in
  // one shot today (server doesn't paginate the conv list — chat list is
  // bounded by user, typically <500). If/when that backend grows a
  // before_cursor parameter, this is the place to loop.
  let conversations = [];
  try {
    const params = targetDeviceId ? { target_device_id: targetDeviceId } : {};
    const data = await relayRequest('get_conversations', params, 20000);
    conversations = Array.isArray(data?.conversations) ? data.conversations : [];
  } catch (e) {
    _log('get_conversations failed', { code: e?.code, message: e?.message });
    return { success: false, done: 0, total: 0, error: e?.code || e?.message || 'list_failed' };
  }

  if (!conversations.length) {
    return { success: true, done: 0, total: 0 };
  }

  // Sort newest activity first so the user sees their most recent threads
  // hydrated before we drill into long-tail history.
  conversations.sort((a, b) => {
    const ta = String(a?.last_message_time || a?.updated_at || '');
    const tb = String(b?.last_message_time || b?.updated_at || '');
    if (ta === tb) return 0;
    return ta < tb ? 1 : -1;
  });
  // No more `maxConversations` cap — iterate EVERY conv the peer returned.
  const list = conversations;

  // Persist the convo metadata up-front so even if message fetches fail
  // the user at least sees the conversation list immediately.
  try {
    await dbSaveConversations(list);
  } catch (e) {
    _log('dbSaveConversations error (continuing)', { message: e?.message });
  }

  const total = list.length;
  let doneCount = 0;

  // Pull ALL pages of a conversation, oldest cursor advancing each round.
  // Resumes from the per-conv checkpoint so a bootstrap killed mid-flight
  // restarts where it left off rather than reflooding the network with
  // pages we already imported.
  const fetchOne = async (conv) => {
    const cid = conv?.id;
    if (!cid) {
      doneCount++;
      try { onProgress && onProgress({ done: doneCount, total, conversation_id: null, conversation_name: '' }); } catch {}
      return;
    }
    try {
      onProgress && onProgress({
        done: doneCount,
        total,
        conversation_id: cid,
        conversation_name: conv?.name || conv?.display_name || '',
      });
    } catch {}

    // Resume cursor — if we have a checkpoint, page older than it.
    // Otherwise start at the head (no before_id).
    let beforeId = null;
    try {
      const cp = await _getCheckpoint(cid);
      if (cp && cp.oldest_id) beforeId = cp.oldest_id;
    } catch {}

    try {
      for (let batch = 0; batch < maxBatchesPerConv; batch++) {
        const params = { conversation_id: cid, limit: perBatchLimit };
        if (targetDeviceId) params.target_device_id = targetDeviceId;
        if (beforeId) params.before_id = beforeId;

        let data;
        try {
          data = await relayRequest('get_messages', params, 20000);
        } catch (e) {
          _log('get_messages page failed', { cid, batch, code: e?.code, message: e?.message });
          // Bail out of this conv but don't abort the whole bootstrap —
          // the next bootstrap run will pick up at the same checkpoint.
          break;
        }

        const msgs = Array.isArray(data?.messages) ? data.messages : [];
        if (!msgs.length) {
          // Empty page → we've reached the head of history for this conv.
          break;
        }

        try {
          await dbSaveMessages(cid, msgs);
        } catch (e) {
          _log('dbSaveMessages error', { cid, message: e?.message });
        }

        // Find the OLDEST id in this batch to use as the next before_id.
        // Messages can come back in either order from the peer; compute
        // min defensively by numeric id when possible, lexical fallback.
        let oldest = null;
        for (const m of msgs) {
          const id = m?.id;
          if (id == null) continue;
          if (oldest == null) { oldest = id; continue; }
          const a = Number(oldest), b = Number(id);
          if (Number.isFinite(a) && Number.isFinite(b)) {
            if (b < a) oldest = id;
          } else if (String(id) < String(oldest)) {
            oldest = id;
          }
        }
        if (oldest == null) break;

        // Persist checkpoint after every successful page so a kill anywhere
        // in the loop resumes cleanly. Tiny write, no perf concern.
        await _setCheckpoint(cid, oldest);

        // Detect end-of-history signals from server: explicit has_more=false,
        // OR a short page (server didn't fill the batch ⇒ likely the tail).
        const hasMore = (data && (data.has_more === true || data.hasMore === true));
        const explicitNoMore = (data && (data.has_more === false || data.hasMore === false));
        if (explicitNoMore) break;
        if (!hasMore && msgs.length < perBatchLimit) break;

        beforeId = oldest;
      }
    } catch (e) {
      _log('fetchOne unexpected', { cid, message: e?.message });
    } finally {
      doneCount++;
    }
  };

  // Concurrency = 5. Bigger pools OOM low-end Androids when each response
  // can be 100 messages × 16KB raw_json + image previews. 5 keeps us under
  // ~8MB peak working set during the fetch phase. (Now that we paginate
  // deep per conv, the bottleneck is network RTT, not local CPU — but
  // raising this further still risks burning the peer's relay budget.)
  const CONCURRENCY = 5;
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const idx = cursor++;
      await fetchOne(list[idx]);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, list.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Final progress tick so the UI hits "X de X conversas".
  try { onProgress && onProgress({ done: total, total, conversation_id: null, conversation_name: '' }); } catch {}

  return { success: true, done: total, total };
}

/**
 * Is the relay path actually usable right now?
 *
 *  - Web-only (the only platform that can be the "requester" — phones own
 *    the SQLite history and never read via relay).
 *  - WS must be connected + authenticated.
 *  - At least ONE paired device that ISN'T web. If the only paired
 *    device IS another web tab, relay would just loop or hit the
 *    no_paired_device server error — fall back to REST.
 *
 * Returns false on any failure (the registry lookup itself can fail in cold
 * start before the user has paired anything).
 */
export async function isAvailable() {
  if (Platform.OS !== 'web') return false;
  if (!mailWs || !mailWs.isConnected) return false;
  try {
    const { loadDeviceRegistry } = require('./deviceRegistry');
    const r = await loadDeviceRegistry();
    const devices = (r && Array.isArray(r.devices)) ? r.devices : [];
    // At least one paired device that isn't this web tab. Server still
    // disambiguates via requesterDeviceId, but if EVERY paired device is
    // 'web', the only possible target is another web tab and the response
    // would be no_paired_device.
    return devices.some((d) => d && d.kind && d.kind !== 'web');
  } catch {
    return false;
  }
}

// Eager listener install — websocket singleton exists at module-eval.
_ensureListener();

export default {
  relayRequest,
  getMessagesViaRelay,
  getConversationsViaRelay,
  getStarredViaRelay,
  getPinnedViaRelay,
  searchMessagesViaRelay,
  bootstrapHistoryFromPeer,
  isAvailable,
};
