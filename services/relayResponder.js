/**
 * Stage 3+4 — Web↔Phone history relay (JS side).
 *
 * When the web companion device asks "give me messages for conversation X"
 * via WebSocket, the server forwards a `relay_request` event to the phone's
 * chat_user_<email> channel. This module listens for that event, dispatches
 * to localDb read functions, and replies with `relay_response`.
 *
 * Companion behavior (Stage 4):
 *   - If the phone is BACKGROUNDED but the JS bundle is alive (Expo "active"
 *     or "inactive" state), this module handles the request directly — no
 *     native wake needed.
 *   - If the phone is KILLED, the silent FCM push wakes the native handler
 *     (RelayWakeService on Android, RelayWakeAppDelegateSubscriber on iOS).
 *     Those native handlers respond with `error: js_unavailable`. The web
 *     side retries; by then the silent push has also kicked Expo's headless
 *     background task and this module loads and handles the retry.
 *
 * Whitelist matches the server's RELAY_ACTION_WHITELIST in
 * scripts/ws-server-stage4-relay.patch.js — keep them in sync.
 */

import mailWs from './websocket';
// Lazy + tolerant imports so the web bundle (which uses localDb.web.js, a
// stripped subset that omits FTS5) doesn't crash on missing exports. Each
// handler null-checks the function before calling it.
import * as localDb from './localDb';

const getMessages = localDb.getMessages || (async () => null);
const getConversations = localDb.getConversations || (async () => null);
const getContacts = localDb.getContacts || (async () => null);
const searchMessagesFTS = localDb.searchMessagesFTS || (async () => []);

let installed = false;
let unsubscribe = null;

/**
 * Read the most recent N messages for a conversation. Server requested
 * params shape: { conversation_id, limit?, before_id? }.
 */
async function handleGetMessages(params) {
  const conversationId = params?.conversation_id ?? params?.conversationId;
  const limit = Math.min(parseInt(params?.limit, 10) || 50, 200);
  const beforeId = params?.before_id ?? params?.beforeId ?? null;
  if (!conversationId) {
    return { error: 'missing_conversation_id' };
  }
  const rows = await getMessages(conversationId, limit, beforeId);
  return { messages: rows || [], conversation_id: conversationId };
}

/**
 * Return the full conversation list. No params needed — localDb scopes by
 * the current user's email automatically.
 */
async function handleGetConversations() {
  const rows = await getConversations();
  return { conversations: rows || [] };
}

/**
 * Look up a single message by id. We don't have a dedicated localDb
 * function for this; the cheapest path is getMessages(convId) and filter.
 * If the requester doesn't provide a conversation_id, we can't satisfy it
 * efficiently — return missing_conversation_id.
 */
async function handleGetMessage(params) {
  const conversationId = params?.conversation_id ?? params?.conversationId;
  const id = params?.id ?? params?.message_id;
  if (!conversationId || !id) {
    return { error: 'missing_id_or_conversation_id' };
  }
  const rows = await getMessages(conversationId, 200, null);
  const found = (rows || []).find(m => String(m.id) === String(id)) || null;
  return { message: found };
}

/**
 * Full-text search across the user's conversations (FTS5 index).
 * Params: { query, conversation_id?, limit? }.
 */
async function handleSearchMessages(params) {
  const query = String(params?.query || '').trim();
  const conversationId = params?.conversation_id ?? null;
  const limit = Math.min(parseInt(params?.limit, 10) || 50, 200);
  if (query.length < 2) {
    return { results: [] };
  }
  const rows = await searchMessagesFTS(query, limit, conversationId);
  return { results: rows || [] };
}

async function handleGetContacts() {
  // localDb.getContacts() exists for the on-device address book cache.
  // Returns whatever shape the schema stores (rows of {email, name, ...}).
  let rows = [];
  try {
    const fn = getContacts;
    if (typeof fn === 'function') rows = await fn();
  } catch (e) {
    return { error: 'contacts_unavailable', message: e?.message || String(e) };
  }
  return { contacts: rows || [] };
}

// Whitelist of supported actions. New actions MUST also be added to the
// server-side RELAY_ACTION_WHITELIST or the request is rejected before it
// ever reaches us — see scripts/ws-server-stage4-relay.patch.js.
const HANDLERS = {
  get_messages: handleGetMessages,
  get_conversations: handleGetConversations,
  get_message: handleGetMessage,
  search_messages: handleSearchMessages,
  get_contacts: handleGetContacts,
};

async function handleRelayRequest(msg) {
  // msg shape (server-emitted): { type: 'relay_request', requestId, action,
  // params, requester, ts }. Some servers (legacy / debug) may put fields
  // under a `data` key — handle both.
  const m = msg && msg.data && typeof msg.data === 'object' ? msg.data : msg;
  const requestId = m?.requestId || m?.request_id;
  const action = m?.action;
  const params = m?.params || {};
  const requester = m?.requester || m?.target_email || '';

  if (!requestId) return;

  const handler = HANDLERS[action];
  if (!handler) {
    mailWs.send({
      type: 'relay_response',
      requestId,
      target_email: requester,
      error: 'unknown_action',
      ts: Date.now(),
    });
    return;
  }

  try {
    const data = await handler(params);
    // If the handler itself returned an `error` field, pass it through —
    // otherwise wrap the response in `data`.
    if (data && data.error) {
      mailWs.send({
        type: 'relay_response',
        requestId,
        target_email: requester,
        error: data.error,
        ts: Date.now(),
      });
    } else {
      mailWs.send({
        type: 'relay_response',
        requestId,
        target_email: requester,
        data,
        ts: Date.now(),
      });
    }
  } catch (e) {
    console.warn('[relayResponder] handler error:', e?.message || e);
    mailWs.send({
      type: 'relay_response',
      requestId,
      target_email: requester,
      error: 'handler_failed',
      message: e?.message || String(e),
      ts: Date.now(),
    });
  }
}

/**
 * Install the listener. Safe to call multiple times — only the first call
 * registers; subsequent calls are no-ops. Returns an unsubscribe function.
 *
 * Typical wiring: call this once from a top-level effect after the WS is
 * connected (e.g. in AuthContext post-login or in _layout.js).
 */
export function installRelayResponder() {
  if (installed) return unsubscribe || (() => {});
  installed = true;
  // mailWs.on returns an unsubscribe function (see services/websocket.js).
  unsubscribe = mailWs.on('relay_request', handleRelayRequest);
  return () => {
    try { unsubscribe && unsubscribe(); } catch {}
    installed = false;
    unsubscribe = null;
  };
}

export default { installRelayResponder };
