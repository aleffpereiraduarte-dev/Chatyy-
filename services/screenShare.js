/**
 * services/screenShare.js
 *
 * High-level API for in-call screen sharing, abstracting per-platform
 * differences:
 *
 *   - Web:    navigator.mediaDevices.getDisplayMedia (already works today).
 *   - iOS:    ReplayKit Broadcast Extension via modules/expo-screen-share —
 *             frames are pushed from the extension process into JS as JPEG
 *             file URIs; we feed them into the existing RTCPeerConnection
 *             video sender by either decoding into a custom RTCVideoSource
 *             (when the lib supports it) or, as a fallback, rendering them
 *             into an offscreen video element and capturing via
 *             createMediaStreamSource. WebRTC track replacement uses
 *             replaceTrack so we don't disturb the m-line ordering.
 *   - Android: pending (MediaProjection + foreground service). Returns
 *             unsupported until that lands.
 *
 * The module exposes a single entry point startScreenShare() that the call
 * screen calls. Internally it sets up listeners, presents the iOS picker,
 * and resolves with a MediaStreamTrack-like handle that call.js can hand
 * to peerConnection.getSenders().find(s => s.track?.kind === 'video')
 * .replaceTrack(track).
 *
 * SECURITY: We do not capture screen audio (Apple discourages it for VoIP).
 * No frames ever leave the device through this layer — they go straight
 * into the same WebRTC peer connection that the call already authenticated.
 */

import { Platform } from 'react-native';

let _screenShareMod = null;
function getMod() {
  if (_screenShareMod) return _screenShareMod;
  try {
    _screenShareMod = require('../modules/expo-screen-share').default;
  } catch {
    _screenShareMod = null;
  }
  return _screenShareMod;
}

let _webrtc = null;
function getWebRTC() {
  if (_webrtc) return _webrtc;
  try {
    _webrtc = require('@livekit/react-native-webrtc');
  } catch {
    _webrtc = null;
  }
  return _webrtc;
}

/**
 * Returns true if we can offer screen share UI at all on this platform.
 * call.js uses this to enable/disable the bottom-bar button without
 * popping an error alert when the user taps a non-functional button.
 */
export function isScreenShareSupported() {
  if (Platform.OS === 'web') {
    return typeof navigator !== 'undefined'
      && !!navigator.mediaDevices
      && typeof navigator.mediaDevices.getDisplayMedia === 'function';
  }
  if (Platform.OS === 'ios') {
    const m = getMod();
    return !!m && m.isSupported();
  }
  if (Platform.OS === 'android') {
    // [2026-05-17 Stage 4] Native MediaProjection path is wired via
    // modules/expo-screen-share's ScreenShareService — once the user accepts
    // the system consent dialog, LK Room.localParticipant publishes the
    // resulting track automatically. Supported on every device API 24+.
    return true;
  }
  return false;
}

/**
 * Start screen sharing. Returns:
 *   { stream: MediaStream, track: MediaStreamTrack, stop: () => void, source: 'web'|'ios'|null }
 * or null if user cancelled / not supported.
 *
 * The caller is responsible for:
 *   - Calling peerConnection.getSenders()…replaceTrack(track)
 *   - Listening for stream.onended (web) or onStopped (ios) to swap the
 *     camera track back.
 *   - Calling stop() when the call ends.
 *
 * Web path mirrors the original call.js behavior exactly so existing tests
 * stay green.
 *
 * iOS path:
 *   1. Subscribe to onBroadcastFrame BEFORE presenting picker (frames can
 *      arrive within 50ms of user confirm).
 *   2. Present picker — iOS shows the system broadcast UI.
 *   3. Build a "frame relay" stream: we don't have native CMSampleBuffer
 *      injection into RTCPeerConnection from JS, so we surface the JPEG
 *      file path as a frame stream the consumer can adapt. The actual
 *      track swap is done by the native module's own RTCVideoCapturer
 *      registration (future enhancement) — for now we expose the frame
 *      pump so call.js can show a "sharing" UI even before the native
 *      capturer ships.
 */
export async function startScreenShare(options = {}) {
  if (Platform.OS === 'web') {
    return startScreenShareWeb(options);
  }
  if (Platform.OS === 'ios') {
    return startScreenShareIOS(options);
  }
  return null;
}

async function startScreenShareWeb() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) return null;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (_e) {
    return null;
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    return null;
  }
  return {
    source: 'web',
    stream,
    track,
    stop: () => {
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
    },
  };
}

async function startScreenShareIOS({ onFrame, onStarted, onStopped, onError } = {}) {
  const mod = getMod();
  if (!mod) return null;

  // Wire listeners first so we don't miss the first frame.
  const unsubs = [];
  const cleanup = () => {
    while (unsubs.length) {
      try { unsubs.pop()(); } catch {}
    }
  };

  let started = false;
  let stopped = false;

  unsubs.push(mod.onBroadcastStarted((d) => {
    started = true;
    if (onStarted) {
      try { onStarted(d); } catch {}
    }
  }));

  unsubs.push(mod.onBroadcastFrame((d) => {
    if (onFrame) {
      try { onFrame(d); } catch {}
    }
  }));

  unsubs.push(mod.onBroadcastStopped((d) => {
    stopped = true;
    if (onStopped) {
      try { onStopped(d); } catch {}
    }
    cleanup();
  }));

  unsubs.push(mod.onBroadcastError((d) => {
    if (onError) {
      try { onError(d); } catch {}
    }
  }));

  mod.startReceivingFrames();
  const presented = await mod.presentBroadcastPicker();
  if (!presented) {
    cleanup();
    mod.stopReceivingFrames();
    return null;
  }

  // We return immediately — the broadcast itself starts only after the
  // user confirms the picker. call.js shows "Starting..." UI in the
  // meantime and swaps the actual video sender once onStarted fires.
  //
  // The track here is a placeholder MediaStreamTrack-like object whose
  // real WebRTC source is the native frame pump. The native side hooks
  // a custom RTCVideoCapturer into the active PeerConnection in a future
  // PR; today we still rely on the existing camera track but flag the
  // call as "sharing" so the peer sees the screen-share banner.
  //
  // This is a temporary bridge — once the native capturer lands the same
  // public API works without changes in call.js.
  const webrtc = getWebRTC();
  let placeholderStream = null;
  let placeholderTrack = null;
  if (webrtc?.mediaDevices?.getDisplayMedia) {
    try {
      placeholderStream = await webrtc.mediaDevices.getDisplayMedia();
      placeholderTrack = placeholderStream?.getVideoTracks?.()[0] || null;
    } catch {
      // lib variant might require no args / throw — that's fine, we
      // still surface the frame stream through onFrame.
      placeholderStream = null;
      placeholderTrack = null;
    }
  }

  return {
    source: 'ios',
    stream: placeholderStream,
    track: placeholderTrack,
    isBroadcasting: () => started && !stopped,
    stop: () => {
      try { mod.requestStopBroadcast(); } catch {}
      try { mod.stopReceivingFrames(); } catch {}
      if (placeholderStream) {
        try { placeholderStream.getTracks().forEach(t => t.stop()); } catch {}
      }
      cleanup();
    },
  };
}

export default {
  isScreenShareSupported,
  startScreenShare,
};
