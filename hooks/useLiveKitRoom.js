// [2026-10-07 native-group-call] useLiveKitRoom — native (RN, no WebView)
// LiveKit room for the GROUP call screen (app/group-call.js, behind the
// NATIVE_GROUP_CALL flag). Deliberately a MINIMAL copy of the room/audio setup
// in app/call.js (which stays untouched): same registerGlobals order, same
// audio-session configuration, same route APIs (LK AudioSession.selectAudioOutput
// + services/callkeep.setSpeakerEnabled on iOS), same audio publish defaults
// (services/livekitTuning.buildAudioRoomOptions).
//
// Audio-session pitfalls this hook respects (see memory notes
// call_oneway_audio_mic_dead_playback_2026_07_22 and
// call_viva_voz_earpiece_tracksubscribe_2026_10_04):
//   - stopAllAudio() (silences music/ringtone) runs BEFORE we configure the LK
//     session, never after — it touches expo-audio's setAudioMode (it already
//     passes allowsRecording:true, but LK must be the last writer anyway).
//   - iOS: category is set via setAppleAudioConfiguration(localAndRemote) BEFORE
//     startAudioSession (playAndRecord + voiceChat/videoChat) — never .playback.
//   - iOS: lkOutputId('earpiece') is just 'default'; what REALLY forces the
//     earpiece is ExpoCallKit.setSpeakerEnabled(false). The route jumps to the
//     speaker when the first REMOTE audio track subscribes, so we re-assert the
//     desired route at 0/400/1200/2500 ms after that (and 700/1800 ms after the
//     session starts). Guarded by speakerTouchedRef: never fight the user.
//
// Route policy (task spec): audio-only → earpiece, video → speaker; turning the
// camera on later flips to speaker unless the user picked a route by hand.
//
// Video: group tiles are small, so we publish VP8 with SIMULCAST (h180/h360 +
// 540p top) — the same codec/simulcast the web room (/livekit-room.html)
// publishes. (H.264 has no simulcast in libwebrtc, which is why 1:1 call.js
// uses H.264 single-layer; groups need the ladder so thumbnails pull the LOW
// layer.) Subscribers: setVisibleTiles() enables only on-screen cameras and
// caps their layer (HIGH for 1–2 tiles, MEDIUM for 2×2, LOW for paginated grid).
//
// Everything native is lazy-required and guarded: if @livekit/react-native is
// missing, isNativeLiveKitAvailable() returns false and the screen keeps the
// WebView path.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';

let _lkClient = null;
function lkClient() {
  if (_lkClient) return _lkClient;
  try { _lkClient = require('livekit-client'); } catch { _lkClient = null; }
  return _lkClient;
}
let _lkRn = null;
function lkRn() {
  if (_lkRn) return _lkRn;
  if (Platform.OS === 'web') return null;
  try { _lkRn = require('@livekit/react-native'); } catch { _lkRn = null; }
  return _lkRn;
}

export function isNativeLiveKitAvailable() {
  if (Platform.OS === 'web') return false;
  const rn = lkRn();
  const c = lkClient();
  return !!(rn && rn.VideoView && rn.AudioSession && c && typeof c.Room === 'function');
}

export function getLiveKitVideoView() {
  const rn = lkRn();
  return rn ? rn.VideoView || null : null;
}

// Same registration order as app/call.js ensureLiveKitRegistered():
// _layout's opts-registration (autoConfigureAudioSession:false) first, then
// the screen's own registerGlobals(). Module-level guard → once per JS runtime.
let _registered = false;
function ensureRegistered() {
  if (_registered) return true;
  if (Platform.OS === 'web') { _registered = true; return true; }
  try { if (typeof globalThis !== 'undefined' && typeof globalThis.__chatyyEnsureLiveKitGlobals === 'function') globalThis.__chatyyEnsureLiveKitGlobals(); } catch {}
  const rn = lkRn();
  if (!rn) return false;
  if (typeof rn.registerGlobals === 'function') {
    try { rn.registerGlobals(); } catch (e) { console.warn('[GroupLK] registerGlobals failed:', e?.message); }
  }
  _registered = true;
  return true;
}

// Mirrors app/call.js lkOutputId(): iOS only understands 'default' |
// 'force_speaker'; Android takes 'speaker' / 'earpiece' directly.
function lkOutputId(route) {
  if (Platform.OS === 'ios') return route === 'speaker' ? 'force_speaker' : 'default';
  return route;
}

// ── UTF-8 (data messages carry emoji; Hermes may lack TextDecoder) ──
export function utf8Encode(str) {
  try { if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str); } catch {}
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}
export function utf8Decode(bytes) {
  try { if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes); } catch {}
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp;
    if (b < 0x80) { cp = b; i += 1; }
    else if (b < 0xe0) { cp = ((b & 31) << 6) | (bytes[i + 1] & 63); i += 2; }
    else if (b < 0xf0) { cp = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; }
    else { cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); i += 4; }
    s += String.fromCodePoint(cp);
  }
  return s;
}

async function ensureAndroidPermissions(withCamera) {
  if (Platform.OS !== 'android') return;
  try {
    const perms = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
    if (withCamera) perms.push(PermissionsAndroid.PERMISSIONS.CAMERA);
    await PermissionsAndroid.requestMultiple(perms);
  } catch {}
}

// Plain view-model snapshot of every participant (local first). Tiles render
// from this; the Room object never leaks into React state.
function snapshotParticipants(room) {
  const c = lkClient();
  const Track = c && c.Track;
  const out = [];
  const add = (p, isLocal) => {
    if (!p) return;
    const identity = String(p.identity || '');
    if (!identity) return;
    let cam = null;
    let mic = null;
    try {
      cam = Track ? p.getTrackPublication(Track.Source.Camera) : null;
      mic = Track ? p.getTrackPublication(Track.Source.Microphone) : null;
    } catch {}
    const vt = cam && !cam.isMuted ? (cam.videoTrack || cam.track || null) : null;
    let meta = {};
    try { meta = p.metadata ? (JSON.parse(p.metadata) || {}) : {}; } catch { meta = {}; }
    const attrs = p.attributes || {};
    const email = identity.toLowerCase();
    out.push({
      sid: p.sid || identity,
      identity,
      email,
      name: p.name || meta.name || meta.display_name || (identity.includes('@') ? identity.split('@')[0] : identity),
      isLocal,
      isSpeaking: !!p.isSpeaking,
      audioLevel: Number(p.audioLevel || 0),
      muted: isLocal ? !p.isMicrophoneEnabled : (mic ? !!mic.isMuted : true),
      videoOn: !!vt,
      videoTrack: vt,
      videoSid: vt ? String(vt.sid || cam.trackSid || '') : '',
      role: Number(meta.role || attrs.role || 0) || 0,
      handRaised: attrs.hand_raised === '1',
      joinedAt: p.joinedAt ? +p.joinedAt : 0,
    });
  };
  add(room.localParticipant, true);
  try { room.remoteParticipants.forEach((p) => add(p, false)); } catch {}
  return out;
}

/**
 * @param {object} o
 * @param {boolean} o.enabled       connect only when true (and url+token set)
 * @param {string}  o.url           LiveKit wss url (chat_livekit_token data.url)
 * @param {string}  o.token         LiveKit JWT   (chat_livekit_token data.token)
 * @param {boolean} o.startVideo    publish camera on join (video call)
 * @param {Array}   o.iceServers    optional TURN list from the token payload
 * @param {string}  o.dataTopic     topic for data messages (reactions / hands)
 * @param {Function} o.onData       (msgObject, fromIdentity) for decoded JSON data on dataTopic
 * @param {Function} o.onDisconnected ({ reason, reasonName }) after a NON-client disconnect
 */
export default function useLiveKitRoom({
  enabled,
  url,
  token,
  startVideo = false,
  iceServers = null,
  dataTopic = 'chatyy.call',
  onData,
  onDisconnected,
} = {}) {
  const roomRef = useRef(null);
  const onDataRef = useRef(onData);
  const onDiscRef = useRef(onDisconnected);
  onDataRef.current = onData;
  onDiscRef.current = onDisconnected;

  const [state, setState] = useState('idle'); // idle|connecting|connected|reconnecting|disconnected|error
  const [error, setError] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [activeSpeakers, setActiveSpeakers] = useState([]); // lowercase identities, loudest first
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(!!startVideo);
  const [speakerOn, setSpeakerOn] = useState(!!startVideo);
  const [facingFront, setFacingFront] = useState(true);

  const speakerOnRef = useRef(!!startVideo);
  const speakerTouchedRef = useRef(false);
  const firstRemoteAudioRef = useRef(false);
  const timersRef = useRef([]);
  const rebuildTimerRef = useRef(null);
  const visibilityRef = useRef({ ids: null, quality: 'high' });
  const camBusyRef = useRef(false);

  const later = (fn, ms) => { timersRef.current.push(setTimeout(fn, ms)); };

  const rebuild = useCallback(() => {
    if (rebuildTimerRef.current) return;
    rebuildTimerRef.current = setTimeout(() => {
      rebuildTimerRef.current = null;
      const room = roomRef.current;
      if (!room) return;
      try { setParticipants(snapshotParticipants(room)); } catch {}
    }, 60);
  }, []);

  // ── audio route (same two knobs call.js uses) ──
  const applyRoute = useCallback((toSpeaker) => {
    const AS = lkRn()?.AudioSession;
    try {
      const p = AS?.selectAudioOutput?.(lkOutputId(toSpeaker ? 'speaker' : 'earpiece'));
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
    if (Platform.OS === 'ios') {
      try { require('../services/callkeep').setSpeakerEnabled?.(!!toSpeaker); } catch {}
    }
  }, []);

  // Re-assert the DESIRED route (only matters for earpiece on iOS, where the
  // OS jumps to speaker on late session activation / first remote audio).
  const reassertRoute = useCallback(() => {
    if (speakerTouchedRef.current) return;
    if (speakerOnRef.current) return;
    applyRoute(false);
  }, [applyRoute]);

  // Apply the current visibility/quality wish to remote camera publications.
  const applyVisibility = useCallback(() => {
    const room = roomRef.current;
    const c = lkClient();
    if (!room || !c) return;
    const { ids, quality } = visibilityRef.current;
    if (!ids) return; // grid hasn't reported yet → leave adaptiveStream alone
    const vis = new Set(ids.map((x) => String(x || '').toLowerCase()));
    const VQ = c.VideoQuality || { LOW: 0, MEDIUM: 1, HIGH: 2 };
    const q = quality === 'high' ? VQ.HIGH : quality === 'medium' ? VQ.MEDIUM : VQ.LOW;
    try {
      room.remoteParticipants.forEach((p) => {
        let pub = null;
        try { pub = p.getTrackPublication(c.Track.Source.Camera); } catch {}
        if (!pub || !pub.isDesired) return;
        const on = vis.has(String(p.identity || '').toLowerCase());
        try { if (pub.isEnabled !== on) pub.setEnabled(on); } catch {}
        if (on) { try { pub.setVideoQuality(q); } catch {} }
      });
    } catch {}
  }, []);

  const setVisibleTiles = useCallback((identities, quality) => {
    visibilityRef.current = { ids: Array.isArray(identities) ? identities : [], quality: quality || 'low' };
    applyVisibility();
  }, [applyVisibility]);

  // ── connect / teardown ──
  useEffect(() => {
    if (!enabled || !url || !token) return undefined;
    if (Platform.OS === 'web') return undefined;
    let cancelled = false;
    let room = null;
    const AS = lkRn()?.AudioSession;
    firstRemoteAudioRef.current = false;
    speakerOnRef.current = !!startVideo;
    speakerTouchedRef.current = false;
    setSpeakerOn(!!startVideo);
    setState('connecting');
    setError(null);

    (async () => {
      if (!ensureRegistered()) throw new Error('livekit_unavailable');
      const c = lkClient();
      if (!c || typeof c.Room !== 'function') throw new Error('livekit_client_missing');
      const { Room, RoomEvent, VideoPresets, DisconnectReason } = c;

      await ensureAndroidPermissions(!!startVideo);
      if (cancelled) return;

      // 1. Silence other media/ringtone FIRST (expo-audio write), then let LK
      //    be the last writer of the session.
      try { require('../services/audioManager').stopAllAudio?.(); } catch {}

      // 2. Session config BEFORE activation (call.js connectToRoom parity).
      if (AS) {
        try {
          const rn = lkRn();
          if (Platform.OS === 'ios' && typeof AS.setAppleAudioConfiguration === 'function'
              && typeof rn.getDefaultAppleAudioConfigurationForMode === 'function') {
            const cfg = rn.getDefaultAppleAudioConfigurationForMode('localAndRemote', !!startVideo);
            await AS.setAppleAudioConfiguration(cfg);
          } else if (Platform.OS === 'android' && typeof AS.configureAudio === 'function' && rn.AndroidAudioTypePresets) {
            await AS.configureAudio({
              android: {
                preferredOutputList: [startVideo ? 'speaker' : 'earpiece'],
                audioTypeOptions: rn.AndroidAudioTypePresets.communication,
              },
            });
          }
        } catch (eCfg) { console.warn('[GroupLK] audio configure err:', eCfg?.message); }
        try { await AS.startAudioSession(); } catch (eS) { console.warn('[GroupLK] startAudioSession err:', eS?.message); }
      }
      applyRoute(!!startVideo);
      if (Platform.OS === 'ios' && !startVideo) { later(reassertRoute, 700); later(reassertRoute, 1800); }
      if (cancelled) return;

      // 3. Room.
      let audioOpts = { audioCaptureDefaults: undefined, publishDefaults: {} };
      try {
        audioOpts = require('../services/livekitTuning').buildAudioRoomOptions({ initialBitrate: 48000, videoCall: !!startVideo });
      } catch {}
      const simLayers = [];
      if (VideoPresets?.h180) simLayers.push(VideoPresets.h180);
      if (VideoPresets?.h360) simLayers.push(VideoPresets.h360);
      const roomOpts = {
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: audioOpts.audioCaptureDefaults,
        videoCaptureDefaults: {
          facingMode: 'user',
          resolution: { width: 960, height: 540, frameRate: 24 },
        },
        publishDefaults: {
          ...(audioOpts.publishDefaults || {}),
          videoCodec: 'vp8',
          simulcast: true,
          videoSimulcastLayers: simLayers.length ? simLayers : undefined,
          videoEncoding: { maxBitrate: 700_000, maxFramerate: 24 },
          degradationPreference: 'balanced',
        },
        rtcConfig: (Array.isArray(iceServers) && iceServers.length)
          ? { iceServers, iceTransportPolicy: 'all' }
          : { iceTransportPolicy: 'all' },
      };
      room = new Room(roomOpts);
      roomRef.current = room;

      const onAny = () => rebuild();
      room
        .on(RoomEvent.ParticipantConnected, onAny)
        .on(RoomEvent.ParticipantDisconnected, onAny)
        .on(RoomEvent.TrackPublished, onAny)
        .on(RoomEvent.TrackUnpublished, onAny)
        .on(RoomEvent.TrackMuted, onAny)
        .on(RoomEvent.TrackUnmuted, onAny)
        .on(RoomEvent.LocalTrackPublished, onAny)
        .on(RoomEvent.LocalTrackUnpublished, onAny)
        .on(RoomEvent.TrackUnsubscribed, onAny)
        .on(RoomEvent.ParticipantMetadataChanged, onAny)
        .on(RoomEvent.ParticipantNameChanged, onAny)
        .on(RoomEvent.TrackSubscribed, (track) => {
          if (track && track.kind === 'audio' && !firstRemoteAudioRef.current) {
            firstRemoteAudioRef.current = true;
            // iOS jumps to speaker when remote audio really starts — win it back.
            if (Platform.OS === 'ios') {
              reassertRoute();
              later(reassertRoute, 400);
              later(reassertRoute, 1200);
              later(reassertRoute, 2500);
            }
          }
          if (track && track.kind === 'video') applyVisibility();
          rebuild();
        })
        .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          const sorted = (speakers || []).slice().sort((a, b) => (b.audioLevel || 0) - (a.audioLevel || 0));
          setActiveSpeakers(sorted.map((p) => String(p.identity || '').toLowerCase()).filter(Boolean));
          rebuild();
        })
        .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
          if (topic && dataTopic && topic !== dataTopic) return;
          let msg = null;
          try { msg = JSON.parse(utf8Decode(payload)); } catch { return; }
          if (!msg || typeof msg !== 'object') return;
          try { onDataRef.current?.(msg, String(participant?.identity || '').toLowerCase()); } catch {}
        })
        .on(RoomEvent.Reconnecting, () => setState('reconnecting'))
        .on(RoomEvent.Reconnected, () => { setState('connected'); rebuild(); })
        .on(RoomEvent.MediaDevicesError, (e) => {
          console.warn('[GroupLK] media devices error', e?.message);
          setCamOn(false);
          rebuild();
        })
        .on(RoomEvent.Disconnected, (reason) => {
          setState('disconnected');
          if (DisconnectReason && reason === DisconnectReason.CLIENT_INITIATED) return;
          let reasonName = '';
          try { reasonName = DisconnectReason ? String(DisconnectReason[reason] || reason) : String(reason); } catch {}
          try { onDiscRef.current?.({ reason, reasonName }); } catch {}
        });
      try {
        if (RoomEvent.ParticipantAttributesChanged) room.on(RoomEvent.ParticipantAttributesChanged, onAny);
      } catch {}

      await room.connect(url, token, { autoSubscribe: true });
      if (cancelled) { try { await room.disconnect(); } catch {} return; }
      setState('connected');
      rebuild();

      try { await room.localParticipant.setMicrophoneEnabled(true); setMicOn(true); }
      catch (eMic) { console.warn('[GroupLK] mic enable failed', eMic?.message); setMicOn(false); }
      if (startVideo) {
        try { await room.localParticipant.setCameraEnabled(true); setCamOn(true); }
        catch (eCam) { console.warn('[GroupLK] camera enable failed', eCam?.message); setCamOn(false); }
      } else {
        setCamOn(false);
      }
      // Route again after publish (mic capture can re-activate the session).
      applyRoute(speakerOnRef.current);
      rebuild();
    })().catch((e) => {
      if (cancelled) return;
      console.warn('[GroupLK] connect failed:', e?.message);
      setError(String(e?.message || 'connect_failed'));
      setState('error');
    });

    return () => {
      cancelled = true;
      timersRef.current.forEach((t) => { try { clearTimeout(t); } catch {} });
      timersRef.current = [];
      if (rebuildTimerRef.current) { try { clearTimeout(rebuildTimerRef.current); } catch {} rebuildTimerRef.current = null; }
      const r = room || roomRef.current;
      roomRef.current = null;
      if (r) {
        try { r.removeAllListeners(); } catch {}
        try { const p = r.disconnect(); if (p && p.catch) p.catch(() => {}); } catch {}
      }
      // Give audio focus back to other apps (call.js teardown parity).
      try { const p = AS?.stopAudioSession?.(); if (p && p.catch) p.catch(() => {}); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, url, token]);

  // ── actions ──
  const setMic = useCallback(async (on) => {
    const room = roomRef.current;
    if (!room) return;
    try { await room.localParticipant.setMicrophoneEnabled(!!on); setMicOn(!!on); } catch (e) { console.warn('[GroupLK] mic toggle', e?.message); }
    rebuild();
  }, [rebuild]);

  const toggleMic = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    setMic(!room.localParticipant.isMicrophoneEnabled);
  }, [setMic]);

  const setCam = useCallback(async (on) => {
    const room = roomRef.current;
    if (!room || camBusyRef.current) return;
    camBusyRef.current = true;
    try {
      if (on) await ensureAndroidPermissions(true);
      await room.localParticipant.setCameraEnabled(!!on);
      setCamOn(!!on);
      if (!on) setFacingFront(true);
      // Video → speaker (unless the user already chose a route).
      if (on && !speakerTouchedRef.current && !speakerOnRef.current) {
        speakerOnRef.current = true;
        setSpeakerOn(true);
        applyRoute(true);
      }
    } catch (e) {
      console.warn('[GroupLK] cam toggle', e?.message);
    } finally {
      camBusyRef.current = false;
    }
    rebuild();
  }, [rebuild, applyRoute]);

  const toggleCam = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    setCam(!room.localParticipant.isCameraEnabled);
  }, [setCam]);

  const flipCamera = useCallback(async () => {
    const room = roomRef.current;
    const c = lkClient();
    if (!room || !c) return;
    let track = null;
    try { track = room.localParticipant.getTrackPublication(c.Track.Source.Camera)?.videoTrack; } catch {}
    if (!track) return;
    const nextFront = !facingFront;
    try {
      if (typeof track.switchCamera === 'function') await track.switchCamera();
      else if (typeof track.restartTrack === 'function') await track.restartTrack({ facingMode: nextFront ? 'user' : 'environment' });
      setFacingFront(nextFront);
    } catch (e) {
      console.warn('[GroupLK] flip camera err:', e?.message);
    }
    rebuild();
  }, [facingFront, rebuild]);

  const setSpeaker = useCallback((on) => {
    speakerTouchedRef.current = true;
    speakerOnRef.current = !!on;
    setSpeakerOn(!!on);
    applyRoute(!!on);
  }, [applyRoute]);

  const toggleSpeaker = useCallback(() => setSpeaker(!speakerOnRef.current), [setSpeaker]);

  const sendData = useCallback(async (obj) => {
    const room = roomRef.current;
    if (!room || !obj) return false;
    try {
      await room.localParticipant.publishData(utf8Encode(JSON.stringify(obj)), { reliable: true, topic: dataTopic });
      return true;
    } catch (e) {
      if (__DEV__) console.warn('[GroupLK] publishData', e?.message);
      return false;
    }
  }, [dataTopic]);

  // Persist the hand state on the participant (late joiners see it) — needs
  // canUpdateOwnMetadata on the token; best-effort, data message is primary.
  const setHandAttribute = useCallback((raised) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      const p = room.localParticipant.setAttributes?.({ hand_raised: raised ? '1' : '0' });
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }, []);

  const setRemoteVolume = useCallback((email, volume) => {
    const room = roomRef.current;
    if (!room) return;
    const k = String(email || '').toLowerCase();
    const v = typeof volume === 'number' ? Math.max(0, Math.min(1, volume)) : 1;
    try {
      room.remoteParticipants.forEach((p) => {
        if (String(p.identity || '').toLowerCase() === k && typeof p.setVolume === 'function') p.setVolume(v);
      });
    } catch {}
  }, []);

  const leave = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try { await room.disconnect(); } catch {}
  }, []);

  return {
    state,
    error,
    participants,
    activeSpeakers,
    primarySpeaker: activeSpeakers[0] || null,
    micOn,
    camOn,
    speakerOn,
    facingFront,
    setMic,
    toggleMic,
    setCam,
    toggleCam,
    flipCamera,
    setSpeaker,
    toggleSpeaker,
    sendData,
    setHandAttribute,
    setRemoteVolume,
    setVisibleTiles,
    leave,
  };
}
