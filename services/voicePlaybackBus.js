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

export function onAudioFinished(fn) {
  _finishedListeners.add(fn);
  return () => _finishedListeners.delete(fn);
}

export function emitAudioFinished(messageId) {
  for (const fn of _finishedListeners) {
    try { fn(messageId); } catch {}
  }
}

export function onRequestPlay(fn) {
  _requestPlayListeners.add(fn);
  return () => _requestPlayListeners.delete(fn);
}

export function emitRequestPlay(messageId) {
  for (const fn of _requestPlayListeners) {
    try { fn(messageId); } catch {}
  }
}
