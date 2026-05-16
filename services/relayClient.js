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
  isAvailable,
};
