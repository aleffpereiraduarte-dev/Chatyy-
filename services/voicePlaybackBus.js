// Voice-message auto-advance bus (WhatsApp parity).
//
// When a voice note finishes playing, AudioPlayer emits `finished(msgId)`.
// chat-conversation listens, walks the messages array forward to find the
// NEXT voice-or-audio message from the SAME sender within 60s of the one
// that just finished, then emits `requestPlay(nextMsgId)`. Each AudioPlayer
// subscribes to requestPlay and starts playback if its msgId matches.
//
// This avoids prop-drilling refs through every bubble and keeps AudioPlayer
// loosely coupled.

const _finishedListeners = new Set();
const _requestPlayListeners = new Set();

// Cache of (messageId → conversationId) so the auto-ack hook below can
// look up the conversation when the chat-conversation screen only passes
// the messageId on emit. Populated by the bubble when it mounts via
// trackVoiceMessage() — and by the WS prefetch path for inbound voices.
const _voiceConvMap = new Map();
// Dedup set so a single voice note doesn't ack twice in the same session.
const _ackedThisSession = new Set();

export function trackVoiceMessage(messageId, conversationId, isOwn) {
  if (messageId == null) return;
  // Don't ack our own outgoing voices — played receipts are receiver-side.
  // We only skip when explicitly told isOwn === true; an absent flag means
  // "caller doesn't know, register it" (server-side chat_voice_played
  // ignores acks for own messages, so a stray call is harmless).
  if (isOwn === true) return;
  _voiceConvMap.set(String(messageId), conversationId || null);
}

export function onAudioFinished(fn) {
  _finishedListeners.add(fn);
  return () => _finishedListeners.delete(fn);
}

// Held when we tried to ack a played message but were offline. Drained on
// the next network_resumed pulse from audioPlaybackBus so the receipts
// don't disappear silently when the user plays voices in airplane mode.
const _pendingAcks = new Map(); // messageId(str) → convId

export function emitAudioFinished(messageId) {
  for (const fn of _finishedListeners) {
    try { fn(messageId); } catch {}
  }
  // WhatsApp "played" receipt — fire ONCE per session per message id.
  // Receiver-only: tracker skipped own messages on register, so anything
  // in _voiceConvMap is inbound. Fire-and-forget; chatVoicePlayed in
  // api.js is itself batched to coalesce auto-playback queues into a
  // single POST per 250ms window.
  try {
    if (messageId == null) return;
    const key = String(messageId);
    if (_ackedThisSession.has(key)) return;
    if (!_voiceConvMap.has(key)) return; // own msg or never tracked
    _ackedThisSession.add(key);
    const convId = _voiceConvMap.get(key);
    // OFFLINE-FIRST: when the device has no connectivity (user played the
    // voice from disk cache), queue the ack and let the resume hook flush
    // it on reconnect. Otherwise fire-and-forget immediately.
    let online = true;
    try {
      const { isOnline } = require('./audioPlaybackBus');
      online = typeof isOnline === 'function' ? isOnline() : true;
    } catch {}
    if (!online) {
      _pendingAcks.set(key, convId);
    } else {
      const { chatVoicePlayed } = require('./api');
      if (typeof chatVoicePlayed === 'function') {
        chatVoicePlayed(messageId, convId).catch(() => {
          // Network blip between predicate + actual call — re-queue so the
          // resume hook picks it up.
          _pendingAcks.set(key, convId);
        });
      }
    }
    // Cap the dedup set so a long-lived session doesn't grow unbounded.
    if (_ackedThisSession.size > 5000) {
      const drop = Array.from(_ackedThisSession).slice(0, 1000);
      for (const k of drop) _ackedThisSession.delete(k);
    }
  } catch {}
}

// Drain held played-receipt acks. Called when audioPlaybackBus emits
// `network_resumed` (NetInfo back online, or mail-ws re-authed). The acks
// dedup against the server's UNIQUE constraint so a stray double-flush is
// harmless.
function _flushPendingAcks() {
  if (_pendingAcks.size === 0) return;
  try {
    const { chatVoicePlayed } = require('./api');
    if (typeof chatVoicePlayed !== 'function') return;
    for (const [mid, convId] of _pendingAcks.entries()) {
      chatVoicePlayed(mid, convId).catch(() => {});
    }
    _pendingAcks.clear();
  } catch {}
}
// Wire resume hook lazily so importing voicePlaybackBus doesn't pull
// networkInfo eagerly at module-load (avoid cycles + Fast Refresh churn).
try {
  const bus = require('./audioPlaybackBus');
  bus?.onNetworkTransition?.((evt) => {
    if (evt === 'network_resumed') _flushPendingAcks();
  });
} catch {}

export function onRequestPlay(fn) {
  _requestPlayListeners.add(fn);
  return () => _requestPlayListeners.delete(fn);
}

export function emitRequestPlay(messageId) {
  for (const fn of _requestPlayListeners) {
    try { fn(messageId); } catch {}
  }
}
