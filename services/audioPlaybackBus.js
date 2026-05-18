/**
 * Audio/Video Playback Bus — offline-first network-drop guard.
 *
 * Problem: when the radio drops mid-playback the various media players
 * (expo-audio AudioPlayer, expo-video VideoPlayer, HTML <audio>/<video>)
 * react inconsistently. expo-av historically PAUSED on transport error;
 * expo-video can keep going if it's reading from a local file; web
 * <audio> with a blob: URL is unaffected, but a network URL <audio>
 * stalls. The user wants WhatsApp parity: if the asset is already on
 * disk locally, network state is irrelevant — playback continues.
 *
 * Strategy: any player consults `isLocalPlaybackUri(uri)` before honoring
 * a network-drop pause. When the URI is file:// / blob: / content://
 * we skip the pause. Server-side retry features (waveform polling, ack
 * resends, etc.) consult `shouldDeferNetworkRetries()` so they don't
 * thrash the radio while playback is happening offline.
 *
 * Also bridges WS reconnect → resume: when the WS comes back we emit
 * `network_resumed` so listeners (typing/presence pollers, played-ack
 * batchers) can re-arm. Playback never gets touched.
 *
 * The bus is intentionally tiny — just a pub-sub + 2 predicate helpers.
 * The decision-making lives in the consumers.
 */
import { Platform } from 'react-native';

const _networkListeners = new Set();
let _online = true; // optimistic — networkInfo updates us
let _wired = false;

function _wire() {
  if (_wired) return;
  _wired = true;
  try {
    const { onNetworkChange, isConnected } = require('./networkInfo');
    _online = typeof isConnected === 'function' ? !!isConnected() : true;
    if (typeof onNetworkChange === 'function') {
      onNetworkChange((state) => {
        const next = !!state?.isConnected;
        if (next === _online) return;
        _online = next;
        // Fan out. Listeners are responsible for filtering by their own
        // playback state — the bus doesn't know which players are alive.
        const evt = next ? 'network_resumed' : 'network_dropped';
        for (const fn of _networkListeners) { try { fn(evt, state); } catch {} }
      });
    }
  } catch {}
  // WS reconnect: belt-and-suspenders. Even if NetInfo missed the
  // transition (cellular ↔ wifi handoff is sometimes invisible), the
  // mail-ws "authenticated" event proves we have working connectivity.
  try {
    const mailWs = require('./websocket').default;
    mailWs?.on?.('authenticated', () => {
      if (_online) return;
      _online = true;
      for (const fn of _networkListeners) { try { fn('network_resumed', null); } catch {} }
    });
  } catch {}
}
_wire();

/**
 * True when the URI points to local storage (file://, content://, blob:)
 * — playback should NOT be paused on network drop because the bytes are
 * on disk. Used by audio/video players' AppState + network listeners
 * to decide whether a pause is warranted.
 */
export function isLocalPlaybackUri(uri) {
  if (!uri || typeof uri !== 'string') return false;
  if (uri.startsWith('file://')) return true;
  if (uri.startsWith('content://')) return true;
  if (uri.startsWith('blob:')) return true;
  return false;
}

/**
 * Subscribe to network-state transitions. Callback receives
 * (event, networkState) where event is 'network_dropped' | 'network_resumed'.
 * Returns an unsubscribe fn. Use this in audio/video player components
 * to gate server-feature pauses (typing, presence, played-acks).
 */
export function onNetworkTransition(fn) {
  _networkListeners.add(fn);
  return () => _networkListeners.delete(fn);
}

/**
 * Snapshot of current connectivity (cached locally so callers don't have
 * to import networkInfo separately).
 */
export function isOnline() {
  return _online;
}

/**
 * True when server-side retries should be deferred. Today this is just
 * the inverse of isOnline() — but having a dedicated predicate gives us
 * room to add more nuance later (e.g. "metered connection, audio is
 * already playing, don't burn cellular bytes for ack POST").
 */
export function shouldDeferNetworkRetries() {
  return !_online;
}

/**
 * Convenience guard for the pause-on-network-drop path. Returns true
 * when a player listening for AppState/Network changes should ACTUALLY
 * pause playback. Today: pause only if (offline) AND (uri is remote).
 * Local files always keep playing; offline playback of cached audio is
 * the whole point of the offline-first push.
 */
export function shouldPausePlaybackOnNetworkDrop(uri) {
  if (_online) return false; // not actually offline → never pause
  if (isLocalPlaybackUri(uri)) return false; // bytes on disk → keep playing
  return true;
}
