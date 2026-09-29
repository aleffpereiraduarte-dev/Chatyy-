/**
 * services/phoenixAdapter.js — flag-gated bridge between the legacy mailWs
 * dispatch (services/websocket.js) and the new Phoenix real-time hub
 * (services/phoenixClient.js).
 *
 * Strangler-fig migration step 4 — the FINAL client wiring. This module is the
 * ONLY place that knows both transports. It is 100% ADDITIVE and gated behind
 * USE_PHOENIX_HUB (services/flags.js, DEFAULT OFF). While the flag is OFF:
 *   - Nothing here is imported at module-load time by the legacy hot paths
 *     (the callers `require()` this file lazily, INSIDE a flag check), so the
 *     bundle graph and behavior of the legacy Go WS path are byte-for-byte
 *     unchanged.
 *   - startPhoenix() is never called, so no Phoenix socket is opened.
 *
 * ─── What it does when the flag is ON (parallel transport / cutover) ───
 *  INBOUND: opens phoenixClient, joins the user's chat + call channels, and
 *  forwards every Phoenix channel event straight into `mailWs._handleMessage()`
 *  as a legacy-shaped `{ type, data }` frame. Feeding through _handleMessage
 *  (rather than a raw emit) is deliberate: the app's existing `mailWs.on(...)`
 *  listeners fire UNCHANGED *and* they inherit the legacy dedup (_trackMsgId),
 *  media prefetch, and delivery-ack side effects — so a message that arrives
 *  over BOTH transports during shadow-testing is de-duplicated for free.
 *
 *  OUTBOUND: `phoenixOutbound(frame)` / `phoenixRelayChat(...)` translate the
 *  legacy `{ type, ... }` frames the app sends via mailWs into Phoenix channel
 *  pushes. Only chat/call/presence/typing/receipt frames are claimed; Go-WS
 *  protocol frames (ping/auth/ack/resume/subscribe/…) are left for the Go WS,
 *  which stays connected for EMAIL real-time (the Phoenix hub is chat+calls
 *  only).
 *
 * ─── EVENT NAME / SHAPE MAPPING (Go/legacy  ⇄  Phoenix) ───
 *  Calls: identical names both ways — call_invite / call_accepted /
 *    call_declined / call_offer / call_answer / call_ice / call_end /
 *    call_reaction / call_audio_muted / call_video_request. No remap needed.
 *  Chat:  Phoenix emits `new_message`/`read`; the app listens for
 *    `chat_message`/`message_read`. Those two are remapped below
 *    (INBOUND_ALIAS). typing/reaction/edit/delete/etc. share names.
 *  Presence: Phoenix uses presence_state/presence_diff (a metas map). The app
 *    listens for per-user `presence` frames. We translate best-effort (see
 *    _forwardPresence*). Presence also has an HTTP poll fallback in the app,
 *    so a partial translation is non-fatal.
 *
 *  ⚠️ OUTBOUND PUSH CONTRACT (topic + event + payload) — the one part that
 *     cannot be verified from the client alone. See _outboundTopicFor() and
 *     phoenixRelayChat() for the exact assumptions. They are centralized here
 *     so the founder can correct them in ONE place after checking the hub,
 *     before flipping USE_PHOENIX_HUB on. Chat SENDS are non-load-bearing
 *     (HTTP chat_send persists + the server fans out `new_message` on
 *     Phoenix); call signaling SENDS are load-bearing (no HTTP fallback).
 */

import { isPhoenixHubEnabled, PHOENIX_HUB_URL } from './flags';

// ─── lazy singletons (avoid import cycles with websocket.js) ───
function _phoenix() {
  try { return require('./phoenixClient').default; } catch { return null; }
}
function _mailWs() {
  try { return require('./websocket').default; } catch { return null; }
}

let _started = false;
let _myEmail = null;
const _joinedConvs = new Set();
const _globalUnsubs = [];

// ─── Topic helpers ───
function _userChatTopic(email) { return 'chat:' + String(email || '').toLowerCase(); }
function _userCallTopic(email) { return 'call:' + String(email || '').toLowerCase(); }
function _convTopic(convId) { return 'chat:conv:' + String(convId); }

// ─── Inbound: event names that pass THROUGH with type=<event> ───
// These names already match the app's mailWs.on(...) listeners (see the audit
// in the task), so forwarding them as `{ type:<event>, data:payload }` makes
// the existing handlers fire with the identical shape the Go WS delivers.
const INBOUND_PASSTHROUGH = [
  // chat
  'chat_message', 'chat_summary', 'chat_reaction', 'chat_edit', 'chat_delete',
  'chat_read', 'chat_delivered', 'chat_react', 'reaction', 'message_read',
  'message_delivered', 'message_status', 'message_edited',
  'typing', 'stopped_typing', 'user_typing', 'user_recording',
  'removed_from_conversation', 'envelope_available', 'silent_sync',
  // calls — names identical to the Go/legacy hub
  'call_invite', 'call_accepted', 'call_declined', 'call_offer', 'call_answer',
  'call_ice', 'call_end', 'call_reject', 'call_reaction', 'call_audio_muted',
  'call_video_request', 'call_missed', 'call_blocked', 'call_turn_credentials',
  'turn_credentials',
];

// Phoenix-native event names → the legacy `type` the app listens for.
const INBOUND_ALIAS = {
  new_message: 'chat_message',
  read: 'message_read',
};

// Feed a legacy-shaped frame through the SAME dispatch the Go WS uses so all
// existing listeners + dedup + prefetch + delivery-ack run identically.
// Most _handleMessage cases emit `msg.data || msg`, so nesting the Phoenix
// payload under `data` reproduces the exact shape the app's listeners receive.
function _dispatchToMailWs(legacyType, payload) {
  const ws = _mailWs();
  if (!ws || typeof ws._handleMessage !== 'function') return;
  try {
    ws._handleMessage({ type: legacyType, data: payload });
  } catch {}
}

// A FEW _handleMessage cases (notably `presence`) emit the WHOLE frame, not
// `msg.data`, and the app's presence listeners read data.email / data.status /
// data.last_seen at the top level. For those we spread the payload's fields
// onto the frame itself so the emitted object carries them at the top level.
function _dispatchFlat(legacyType, payload) {
  const ws = _mailWs();
  if (!ws || typeof ws._handleMessage !== 'function') return;
  try {
    ws._handleMessage({ type: legacyType, ...(payload || {}) });
  } catch {}
}

// Best-effort presence translation. Phoenix presence_state is a snapshot
// { <key>: { metas: [...] } }; presence_diff is { joins, leaves }. The app's
// `presence` listeners expect a per-user frame. We emit one `presence` per key.
function _forwardPresenceState(payload) {
  try {
    const keys = Object.keys(payload || {});
    for (const key of keys) {
      _dispatchFlat('presence', { email: String(key).toLowerCase(), status: 'online', source: 'phoenix' });
    }
  } catch {}
}
function _forwardPresenceDiff(payload) {
  try {
    const joins = (payload && payload.joins) || {};
    const leaves = (payload && payload.leaves) || {};
    for (const key of Object.keys(joins)) {
      _dispatchFlat('presence', { email: String(key).toLowerCase(), status: 'online', source: 'phoenix' });
    }
    for (const key of Object.keys(leaves)) {
      _dispatchFlat('presence', { email: String(key).toLowerCase(), status: 'offline', source: 'phoenix' });
    }
  } catch {}
}

// Register the global inbound forwarders on the Phoenix socket. phoenixClient's
// on(event, cb) fires for that event across ALL joined channels, so a single
// set of listeners covers chat:<email>, call:<email>, and every chat:conv:<id>.
function _wireInbound() {
  const px = _phoenix();
  if (!px || typeof px.on !== 'function') return;

  for (const name of INBOUND_PASSTHROUGH) {
    const unsub = px.on(name, (payload) => _dispatchToMailWs(name, payload));
    if (typeof unsub === 'function') _globalUnsubs.push(unsub);
  }
  for (const src of Object.keys(INBOUND_ALIAS)) {
    const legacyType = INBOUND_ALIAS[src];
    const unsub = px.on(src, (payload) => _dispatchToMailWs(legacyType, payload));
    if (typeof unsub === 'function') _globalUnsubs.push(unsub);
  }
  // Presence snapshot / diff → per-user `presence` frames (best-effort).
  const uState = px.on('presence_state', (payload) => _forwardPresenceState(payload));
  if (typeof uState === 'function') _globalUnsubs.push(uState);
  const uDiff = px.on('presence_diff', (payload) => _forwardPresenceDiff(payload));
  if (typeof uDiff === 'function') _globalUnsubs.push(uDiff);
  // In case the hub emits a Go-style flat `presence` / `presence_update`
  // frame directly, forward it flat too (email/status at the top level).
  for (const pname of ['presence', 'presence_update']) {
    const up = px.on(pname, (payload) => _dispatchFlat('presence', payload));
    if (typeof up === 'function') _globalUnsubs.push(up);
  }
}

/**
 * Open the Phoenix hub in parallel with the (still-connected) Go WS and join
 * the user's chat + call channels. Idempotent per-email. Call this from the
 * SAME place the Go WS is started (context/MailContext.js), gated behind
 * isPhoenixHubEnabled().
 */
export function startPhoenix(bearer, myEmail) {
  if (!isPhoenixHubEnabled()) return false;
  const px = _phoenix();
  if (!px) return false;

  const ws = _mailWs();
  const email = (myEmail || (ws && ws.email) || '').toLowerCase();
  if (!email) return false;

  // Already running for this identity → nothing to do.
  if (_started && _myEmail === email) {
    // Refresh bearer on the live socket (sliding token renewal).
    try { if (bearer) px.connect(bearer, PHOENIX_HUB_URL); } catch {}
    return true;
  }
  // Different identity (account switch) → tear the old one down first.
  if (_started && _myEmail && _myEmail !== email) {
    stopPhoenix();
  }

  _myEmail = email;
  _started = true;
  _joinedConvs.clear();

  try {
    _wireInbound();
    px.connect(bearer, PHOENIX_HUB_URL);
    // Per-user fan-out channels (join is what authorizes topic access; the
    // client rejoins them automatically on every reconnect).
    try { px.joinChannel(_userChatTopic(email)); } catch {}
    try { px.joinChannel(_userCallTopic(email)); } catch {}
  } catch {}
  return true;
}

/** Tear down the Phoenix transport (logout / account switch). Safe if never started. */
export function stopPhoenix() {
  // Never started (e.g. flag OFF) → do nothing, and crucially DON'T import the
  // phoenixClient socket module. Keeps the flag-OFF logout path untouched.
  if (!_started && _globalUnsubs.length === 0) return;
  const px = _phoenix();
  for (const unsub of _globalUnsubs.splice(0)) {
    try { unsub(); } catch {}
  }
  _joinedConvs.clear();
  _started = false;
  _myEmail = null;
  if (px && typeof px.disconnect === 'function') {
    try { px.disconnect(); } catch {}
  }
}

/**
 * Join a conversation's Phoenix channel (chat:conv:<id>) so typing / presence /
 * receipts for the open thread flow. Idempotent. Call from the same place the
 * app already does mailWs.subscribe(`chat_<id>`). Per-user new_message delivery
 * does NOT depend on this (it arrives on chat:<email>); this is for the
 * conversation-scoped signaling.
 */
export function phoenixJoinConversation(conversationId) {
  if (!isPhoenixHubEnabled() || !_started || conversationId == null) return false;
  const key = String(conversationId);
  if (_joinedConvs.has(key)) return true;
  const px = _phoenix();
  if (!px || typeof px.joinChannel !== 'function') return false;
  try {
    px.joinChannel(_convTopic(key));
    _joinedConvs.add(key);
    return true;
  } catch { return false; }
}

// Ensure a conv channel is joined (used before conv-scoped outbound pushes).
function _ensureConv(convId) {
  if (convId == null) return null;
  const key = String(convId);
  if (!_joinedConvs.has(key)) phoenixJoinConversation(key);
  return _convTopic(key);
}

// Outbound frame `type` → which channel topic to push on, given payload.
// Returns null when the frame is NOT a Phoenix concern (→ caller keeps Go WS).
//
// ⚠️ ASSUMPTION (verify against the hub before flipping the flag): the client
// pushes on a channel it JOINED (its own chat:/call: topic, or the open
// chat:conv: topic) and the server routes to the peer using the payload's
// target_email / conversation_id. The client does NOT join a peer's call:
// topic, so call signaling is pushed on the SENDER's own call:<email>.
function _outboundTopicFor(type, payload) {
  switch (type) {
    // ── call signaling (LOAD-BEARING: no HTTP fallback) ──
    case 'call_invite':
    case 'call_accepted':
    case 'call_declined':
    case 'call_offer':
    case 'call_answer':
    case 'call_ice':
    case 'call_end':
    case 'call_reject':
    case 'call_reaction':
    case 'call_audio_muted':
    case 'call_video_request':
    case 'call_turn_request':
      return _userCallTopic(_myEmail);

    // ── conversation-scoped chat signaling ──
    case 'typing':
    case 'stopped_typing':
    case 'message_read':
    case 'reaction':
    case 'conv_focus':
    case 'conv_blur': {
      const cid = payload && payload.conversation_id;
      if (cid != null) return _ensureConv(cid);
      return _userChatTopic(_myEmail);
    }

    // ── user-level presence ──
    case 'presence':
      return _userChatTopic(_myEmail);

    default:
      // ping / auth / ack / resume / subscribe / unsubscribe / presence_query /
      // presence_subscribe / chat_message(queue) / etc. → NOT a Phoenix concern.
      return null;
  }
}

/**
 * Route a single legacy outbound frame `{ type, ...fields }` over Phoenix.
 * Returns TRUE if it was claimed + pushed (caller must then NOT send it over
 * the Go WS), FALSE to let the Go WS handle it. Called from mailWs._send().
 */
export function phoenixOutbound(frame) {
  if (!isPhoenixHubEnabled() || !_started || !frame || !frame.type) return false;
  // If the Phoenix socket is not actually open, DON'T claim the frame — let it
  // fall through to the Go WS (which queues chat/call frames + replays on
  // reconnect). This avoids black-holing a signaling frame during a Phoenix
  // outage; during parallel shadow-testing the Go hub still handles it.
  const pxReady = _phoenix();
  if (!pxReady || !pxReady.isConnected) return false;
  const type = frame.type;
  // Split { type, ...payload } → payload (Phoenix payloads carry no `type`).
  const payload = {};
  for (const k of Object.keys(frame)) { if (k !== 'type') payload[k] = frame[k]; }

  const topic = _outboundTopicFor(type, payload);
  if (!topic) return false; // not ours — leave it on the Go WS

  const px = _phoenix();
  if (!px || typeof px.joinChannel !== 'function') return false;
  try {
    // joinChannel is idempotent and returns the channel handle; push() sends
    // even before the join ack lands (Phoenix keys the push by join_ref).
    const ch = px.joinChannel(topic);
    if (ch && typeof ch.push === 'function') ch.push(type, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Route an optimistic chat relay over Phoenix instead of the Go WS relay.
 * Mirrors mailWs.relayChatMessage(conversationId, message, tempId, memberEmails).
 * NON-LOAD-BEARING: durable delivery is HTTP chat_send; this is the real-time
 * optimistic relay to online peers only.
 *
 * ⚠️ ASSUMPTION: the hub accepts a `chat_message` push on chat:conv:<id> with
 * this payload shape and fans it out to peers. Verify before flipping on.
 */
export function phoenixRelayChat(conversationId, message, tempId, memberEmails) {
  if (!isPhoenixHubEnabled() || !_started || conversationId == null) return false;
  const px = _phoenix();
  if (!px || typeof px.joinChannel !== 'function' || !px.isConnected) return false;
  try {
    const topic = _convTopic(conversationId);
    _ensureConv(conversationId);
    const ch = px.joinChannel(topic);
    if (ch && typeof ch.push === 'function') {
      ch.push('chat_message', {
        conversation_id: conversationId,
        message,
        temp_id: tempId || '',
        member_emails: memberEmails || [],
      });
      return true;
    }
  } catch {}
  return false;
}

/** Whether the Phoenix transport is currently active (flag on + started). */
export function isPhoenixActive() {
  return isPhoenixHubEnabled() && _started;
}
