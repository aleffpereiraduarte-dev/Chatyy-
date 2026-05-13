import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Dimensions,
  Animated, Easing, StatusBar, PanResponder, AppState,
  Modal, Pressable, ScrollView, ActivityIndicator,
} from 'react-native';
import { IconSmile, IconSparkles } from '../components/Icons';
import Svg, { Path as SvgPath, Circle as SvgCircleHand, Line as SvgLine } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
// Lazy haptic — not all platforms have it; we want a tap on noise/hand toggles
let _hapticTap = () => {};
try {
  const _h = require('../services/haptics');
  if (_h?.tap) _hapticTap = (intensity) => { try { _h.tap(intensity || 'light'); } catch {} };
} catch {}
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconMic, IconMicOff, IconVideo, IconVideoOff, IconPhoneOff,
  IconVolume2, IconVolume, IconArrowLeft, IconChevronDown, IconCameraFlip, IconScreenShare,
  IconPause, IconPlay, IconMoreHorizontal, IconPhone, IconRecord,
  IconZap, IconUserPlus, IconX, IconSearch,
} from '../components/Icons';
import { getPendingOffer, getPendingIceCandidates, getPendingTurnCredentials, setCallActive } from '../components/IncomingCallListener';
// Lazy-load to break circular dependency
let setActiveCall = () => {};
let clearActiveCall = () => {};
let addCallToHistory = () => {};

// Load them on first use
const initCallModules = (() => {
  let loaded = false;
  return () => {
    if (!loaded) {
      // Defensive: ChatCallsTab is ~148KB with many deps. If a child import
      // throws on a broken native build we must NOT let it kill /call —
      // the user has a ringing call and a white screen means they can't
      // even press decline. Isolated try per require so one fail doesn't
      // void the other.
      try {
        const activeCallBar = require('../components/ActiveCallBar');
        if (activeCallBar?.setActiveCall) setActiveCall = activeCallBar.setActiveCall;
        if (activeCallBar?.clearActiveCall) clearActiveCall = activeCallBar.clearActiveCall;
      } catch (e) { console.warn('[Call] ActiveCallBar load failed:', e?.message); }
      try {
        const chatCallsTab = require('../components/ChatCallsTab');
        if (chatCallsTab?.addCallToHistory) addCallToHistory = chatCallsTab.addCallToHistory;
      } catch (e) { console.warn('[Call] ChatCallsTab load failed:', e?.message); }
      loaded = true;
    }
  };
})();

// Lazy-load callkeep only on native. Single object ref so Hermes minifier
// doesn't TDZ on individual `let` bindings — same bug that broke incoming
// call native screen, fixed by collapsing to one object.
const callKeep = {
  reportConnected: () => {},
  endCall: () => {},
  startCall: async () => ({ success: false }),
};

if (Platform.OS !== 'web') {
  try {
    const ck = require('../services/callkeep');
    if (ck.reportConnected) callKeep.reportConnected = ck.reportConnected;
    if (ck.endCall) callKeep.endCall = ck.endCall;
    if (ck.startCall) callKeep.startCall = ck.startCall;
  } catch (e) {
    console.warn('[Call] Failed to load callkeep:', e.message);
  }
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// ── Global state for minimized calls ──
// When user taps back arrow, the call is "minimized" — WebRTC resources
// move here so the component can unmount without killing the connection.
// Global call state lives in services/callState.js so it survives module re-imports
// (Expo Router loads screens as separate chunks; module-level vars don't share).
import { getGlobalCall as _getGC, setGlobalCall as _setGC, clearGlobalCall as _clearGC, onAudioInterruption as _onAudioInterruption, onNetworkChange as _onNetworkChange } from '../services/callState';
export const getGlobalCall = _getGC;
export const clearGlobalCall = _clearGC;

function CallScreenInner() {
  // Initialize call modules on first render (breaks circular dependency)
  useEffect(() => {
    initCallModules();
  }, []);

  const router = useRouter();
  const params = useLocalSearchParams();
  const {
    callId, contactName, contactEmail,
    isVideo: isVideoParam, conversationId,
    isCaller: isCallerParam,
  } = params;
  const { user } = useAuth();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  // Call state
  const [audioMuted, setAudioMuted] = useState(false);
  const [videoEnabled, setVideoEnabled] = useState(isVideoParam === '1' || isVideoParam === 'true');
  // Refs that mirror state so WS handlers (handleOffer/handleAnswer/etc.)
  // read the freshest value instead of a stale closure capture — bug from
  // audit 2026-05-12: handleOffer sent answer with stale `video` flag if the
  // user toggled camera mid-ring, peer never knew video was live.
  const videoEnabledRef = useRef(videoEnabled);
  useEffect(() => { videoEnabledRef.current = videoEnabled; }, [videoEnabled]);
  // Mirror audioMuted into a ref so handleOffer (which fires on ICE restart
  // + late renegotiation) reads the freshest value instead of the stale
  // closure capture. Without this, a user who muted mid-call had their
  // mic forcibly re-enabled (audioTrack.enabled = true) by the next
  // renegotiation pass — visible as "mute button does nothing on the
  // second leg of the call".
  const audioMutedRef = useRef(audioMuted);
  useEffect(() => { audioMutedRef.current = audioMuted; }, [audioMuted]);
  // Default: earpiece (false) for audio calls, speaker (true) for video calls
  const [speakerOn, setSpeakerOn] = useState(isVideoParam === '1' || isVideoParam === 'true' ? true : false);
  const [callDuration, setCallDuration] = useState(0);
  const [peerConnected, setPeerConnected] = useState(false);
  // peerRinging: caller-only intermediate state. Flips true when we receive
  // the first signaling frame back from the callee (call_answer or first
  // call_ice), which proves their device received our offer and is "ringing".
  // Cleared once peerConnected flips true.
  const [peerRinging, setPeerRinging] = useState(false);
  const [ended, setEnded] = useState(false);
  // Pre-connect watchdog (#892 fix 3). If we stay in 'new'/'connecting'
  // for >8s without flipping to peerConnected/peerRinging, the user sees the
  // dark background with the avatar but no readable signal — white-screen
  // perception even when the JS tree is healthy. Flip this true after 8s to
  // surface an explicit "Conectando…" overlay with spinner so they know the
  // app is alive (not crashed) and still have a hangup affordance.
  const [showSlowConnectOverlay, setShowSlowConnectOverlay] = useState(false);
  useEffect(() => {
    if (peerConnected || peerRinging || ended) {
      setShowSlowConnectOverlay(false);
      return;
    }
    const t8 = setTimeout(() => setShowSlowConnectOverlay(true), 8000);
    return () => clearTimeout(t8);
  }, [peerConnected, peerRinging, ended]);
  const [errorMsg, setErrorMsg] = useState(null);
  const [facingFront, setFacingFront] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [peerScreenSharing, setPeerScreenSharing] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [showEmojiBar, setShowEmojiBar] = useState(false);
  // Add-participant modal — only relevant in group calls (R643).
  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const [addParticipantQuery, setAddParticipantQuery] = useState('');
  const [addParticipantBusy, setAddParticipantBusy] = useState(false);
  const [addParticipantCandidates, setAddParticipantCandidates] = useState([]);
  const [floatingEmojis, setFloatingEmojis] = useState([]);
  const [onHold, setOnHold] = useState(false);
  // Peer-side hold flag — set when the remote sends call_hold with on:true.
  // Drives the "X em espera" banner so the local user knows why audio/video
  // appears frozen and stops talking expecting a reply.
  const [peerOnHold, setPeerOnHold] = useState(false);
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  // Quick-reactions row — opens on long-press of the "more" button (or
  // after user taps a dedicated reactions trigger). Provides a 5-emoji
  // FaceTime-style row that fires floating reactions without the user
  // having to drill into the More sheet. Auto-dismisses 4s after open.
  const [showQuickReactions, setShowQuickReactions] = useState(false);
  const quickReactionsTimerRef = useRef(null);
  const holdStateRef = useRef({ audioWasMuted: false, videoWasEnabled: false });
  // Tracks whether the local user has sent a "switch to video" request and
  // is waiting for the peer's accept. Used by handleToggleVideo to short-
  // circuit the first press (just send the request) and complete the upgrade
  // on the second pass triggered by the WS 'accepted' callback.
  const videoUpgradeRequestedRef = useRef(false);
  const videoUpgradeTimeoutRef = useRef(null);
  const [activeFilter, setActiveFilter] = useState(null);
  const [showFilterPicker, setShowFilterPicker] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [remoteIsRecording, setRemoteIsRecording] = useState(false);
  const [remoteAudioMuted, setRemoteAudioMuted] = useState(false);
  // Peer's camera state — independent from our local `videoEnabled`. When the
  // remote peer disables their camera, RTCView keeps painting the last frame
  // until the track ends, so we must hide the view ourselves. Starts `true`
  // because we assume peer has camera on in a video call; the very first
  // call_video_toggle (or the absence of an active video track) will reset.
  const [peerVideoEnabled, setPeerVideoEnabled] = useState(true);
  // Pending video upgrade request from peer ({ from } when set, null otherwise)
  const [pendingVideoRequest, setPendingVideoRequest] = useState(null);
  // Non-blocking toast for the *outgoing* video upgrade request: shows a
  // small overlay with countdown + cancel button instead of a blocking Alert.
  // null when idle; { secondsLeft } when waiting for peer to accept.
  const [videoUpgradeToast, setVideoUpgradeToast] = useState(null);
  // audit gap #5 — TURN refresh failure toast (3 strikes from webrtc.js).
  // Auto-fades after 4s; user can still call but media may stall mid-network
  // change because we have no relay path.
  const [turnFailedToast, setTurnFailedToast] = useState(false);
  useEffect(() => {
    const { DeviceEventEmitter } = require('react-native');
    const sub = DeviceEventEmitter.addListener('webrtc:turn_refresh_failed', () => {
      setTurnFailedToast(true);
      setTimeout(() => setTurnFailedToast(false), 4000);
    });
    return () => sub.remove();
  }, []);
  const videoUpgradeCountdownRef = useRef(null);
  const [noiseCancellation, setNoiseCancellation] = useState(true);

  // Group call state
  const isGroupCall = params.groupCall === '1' || params.groupCall === 'true';
  const [groupPeers, setGroupPeers] = useState(new Map());
  const groupPeersRef = useRef(new Map()); // { email -> { pc, stream, name } }
  // Raise-hand state — group call only.
  // `handRaised` is local; `raisedHands` maps participant email → { name, ts }
  // Auto-lower fires after 60s; the timer ref lets the user lower manually
  // and reset cleanly. The host (call starter, isCaller===true) sees the
  // list as a banner; everyone else just sees the per-tile overlay on the
  // raised participant.
  const [handRaised, setHandRaised] = useState(false);
  const [raisedHands, setRaisedHands] = useState(new Map());
  const raisedHandsRef = useRef(new Map());
  const handRaiseTimerRef = useRef(null);
  const handLowerTimersRef = useRef(new Map()); // email → timeout id (for remote auto-lower)
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const recordingStartTimeRef = useRef(null);
  const [connectionQuality, setConnectionQuality] = useState('good'); // 'good', 'medium', 'poor'
  const [qualityScore, setQualityScore] = useState(5); // 1-5 score
  const [rttMs, setRttMs] = useState(null); // round-trip time in ms
  const [showWeakBanner, setShowWeakBanner] = useState(false);
  const [suggestAudioOnly, setSuggestAudioOnly] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [networkType, setNetworkType] = useState(null); // 'wifi', 'cellular', etc.
  const iceRestartCountRef = useRef(0);
  const turnFetchRetryRef = useRef(0);
  const statsIntervalRef = useRef(null);
  const iceTimeoutRef = useRef(null);
  const turnRefreshRef = useRef(null);
  const lastQualityRef = useRef(5);
  const wakeLockRef = useRef(null);
  const netInfoUnsubRef = useRef(null);
  const lastNetTypeRef = useRef(null);
  const turnExpiresAtRef = useRef(0); // timestamp when TURN creds expire
  // wave w3 — track ICE failure recurrence so we can refresh TURN creds
  // before retrying when failures are consecutive (stale-credential symptom).
  const iceConsecutiveFailRef = useRef(0);
  // wave w3 — stats-based "Conexão instável" pill (high packet loss >5%
  // sustained > 10s) + audio-track-stall alert (peer's audio bytesReceived
  // didn't tick for ~3 consecutive samples = ~6-15s depending on netType).
  const [showUnstable, setShowUnstable] = useState(false);
  const [audioStalled, setAudioStalled] = useState(false);

  // Subtle reconnect micro-banner: shown when peerConnected && reconnecting
  // (e.g. ICE restart while media still flowing). Fades in/out over 300ms so
  // it doesn't flash the user with the loud orange overlay used pre-connect.
  const reconnectMicroFade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const visible = reconnecting && peerConnected && !ended;
    Animated.timing(reconnectMicroFade, {
      toValue: visible ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [reconnecting, peerConnected, ended, reconnectMicroFade]);

  // Draggable PiP
  const pipPosition = useRef(new Animated.ValueXY({ x: SCREEN_W - 126, y: 80 })).current;
  const pipPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5,
      onPanResponderGrant: () => { pipPosition.extractOffset(); },
      onPanResponderMove: Animated.event([null, { dx: pipPosition.x, dy: pipPosition.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, g) => {
        pipPosition.flattenOffset();
        // Snap to nearest edge — Y clamp aumentado pra 340 (era 280) pra
        // garantir que o PIP nunca cobre o controls bar mesmo no estado
        // group call com top row wrapping.
        const snapX = g.moveX > SCREEN_W / 2 ? SCREEN_W - 126 : 16;
        const snapY = Math.max(60, Math.min(g.moveY - 80, SCREEN_H - 340));
        Animated.spring(pipPosition, { toValue: { x: snapX, y: snapY }, friction: 7, tension: 100, useNativeDriver: false }).start();
      },
    })
  ).current;

  const timerRef = useRef(null);
  const callerTimeoutRef = useRef(null);
  const disconnectTimeoutRef = useRef(null);
  const callDurationRef = useRef(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const controlsFadeAnim = useRef(new Animated.Value(1)).current;
  // Spring entrance for the bottom action bar + top status strip on mount
  // (FaceTime/WhatsApp parity). Drives translateY + opacity over ~260ms so
  // the controls don't pop in flat as the screen renders.
  const barEnterAnim = useRef(new Animated.Value(0)).current;
  // End-state overlay fade — sits over the screen for ~1.5s after hangup
  // with the avatar + "Chamada encerrada · 02:14" card before we navigate
  // back. Drops the jarring instant-pop transition that used to flash
  // straight to /chat.
  const endCardAnim = useRef(new Animated.Value(0)).current;
  const endedRef = useRef(false);
  // Stash WhatsApp-grade Opus params on the SDP. The Opus payload type
  // varies (typically 111) so we look it up dynamically. Adds:
  //   • maxaveragebitrate=24000 (clear voice without wasting bandwidth)
  //   • useinbandfec=1            (forward error correction for packet loss)
  //   • usedtx=1                  (silence suppression)
  //   • stereo=0                  (mono is enough for voice, half the bytes)
  //   • cbr=0                     (variable bitrate adapts to network)
  // Same config WhatsApp uses according to BlogGeek's wireshark analysis.
  // eslint-disable-next-line no-unused-vars
  // Prefer better video codecs when available: VP9 > H.264 > VP8. Some
  // iOS devices negotiate VP8 by default which has ~30% worse PSNR at the
  // same bitrate. We reorder the transceiver's codec preferences so the
  // first offer advertises VP9 first, falling through on peers without it.
  const applyCodecPreferences = (pc) => {
    try {
      if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return;
      const videoCaps = RTCRtpReceiver.getCapabilities('video');
      if (!videoCaps || !videoCaps.codecs) return;
      const order = (mimeType) => {
        const mt = (mimeType || '').toLowerCase();
        if (mt === 'video/vp9') return 0;
        if (mt === 'video/h264') return 1;
        if (mt === 'video/vp8') return 2;
        if (mt === 'video/av1') return 3; // encoder lento ainda, deixa por último
        return 10;
      };
      const sorted = [...videoCaps.codecs].sort((a, b) => order(a.mimeType) - order(b.mimeType));
      for (const t of pc.getTransceivers()) {
        if (t.sender?.track?.kind === 'video' || t.receiver?.track?.kind === 'video') {
          if (typeof t.setCodecPreferences === 'function') {
            try { t.setCodecPreferences(sorted); } catch {}
          }
        }
      }
    } catch {}
  };

  const applyOpusTuning = (sdp) => {
    if (!sdp) return sdp;
    try {
      const lines = sdp.split('\r\n');
      // Find the Opus rtpmap → "a=rtpmap:111 opus/48000/2"
      let opusPt = null;
      for (const l of lines) {
        const m = l.match(/^a=rtpmap:(\d+)\s+opus\//i);
        if (m) { opusPt = m[1]; break; }
      }
      if (!opusPt) return sdp;
      const fmtpLineIdx = lines.findIndex(l => l.startsWith(`a=fmtp:${opusPt}`));
      // WhatsApp-grade Opus:
      //   maxaveragebitrate=24000  → 24 kbps target, matches WA wireshark capture
      //   stereo=0                  → mono (voice), metade dos bytes
      //   cbr=0                     → VBR adapta à rede
      //   useinbandfec=1            → FEC inline recupera 1 pacote perdido
      //   usedtx=1                  → DTX corta silêncio (economia ~40%)
      //   minptime=10               → permite pacotes curtos (10ms) = menor latência
      //   ptime=20                  → pacote alvo 20ms (default 60ms! reduz latência 40ms)
      //   maxplaybackrate=48000     → full wide-band no receptor
      //   sprop-maxcapturerate=48000→ full wide-band no emissor (sem downsample)
      //   sprop-stereo=0            → reforça mono no caminho de envio
      const params = 'maxaveragebitrate=24000;useinbandfec=1;usedtx=1;stereo=0;cbr=0;minptime=10;ptime=20;maxplaybackrate=48000;sprop-maxcapturerate=48000;sprop-stereo=0';
      if (fmtpLineIdx >= 0) {
        // Append our params to the existing fmtp line
        const existing = lines[fmtpLineIdx];
        if (!/maxaveragebitrate=/.test(existing)) {
          lines[fmtpLineIdx] = existing + ';' + params;
        }
      } else {
        // Insert a new fmtp line right after the rtpmap
        const rtpmapIdx = lines.findIndex(l => l.startsWith(`a=rtpmap:${opusPt}`));
        if (rtpmapIdx >= 0) {
          lines.splice(rtpmapIdx + 1, 0, `a=fmtp:${opusPt} ${params}`);
        }
      }
      return lines.join('\r\n');
    } catch {
      return sdp;
    }
  };
  const minimizedRef = useRef(false);
  const controlsTimerRef = useRef(null);

  // ─── Call state machine (Skype/WhatsApp pattern) ───────────────
  // Formal states prevent the race conditions that the bare endedRef
  // boolean was missing. Each transition must move forward, never back.
  //
  //   idle → dialing → ringing → connecting → active → ending → ended
  //                                         ↘ failed → ended
  //
  // The 'ending' state is the critical one: we set it BEFORE sending BYE
  // and BEFORE tearing down media, so the ICE state callback can see we're
  // already shutting down and not fire its own cleanup race.
  const callStateRef = useRef('idle');
  const setCallStateInternal = useCallback((next) => {
    const order = ['idle', 'dialing', 'ringing', 'connecting', 'active', 'ending', 'ended'];
    const cur = callStateRef.current;
    const curIdx = order.indexOf(cur);
    const nextIdx = order.indexOf(next);
    if (nextIdx < 0 || nextIdx < curIdx) return; // never go backwards
    callStateRef.current = next;
    if (__DEV__) console.log('[call] state', cur, '→', next);
  }, []);

  // Native AudioSession (iOS) — proper category/mode and notifyOthersOnDeactivation
  const _NativeAudioSession = (() => {
    if (Platform.OS !== 'ios') return null;
    try { return require('../modules/expo-audio-session').default; } catch { return null; }
  })();

  // WebRTC refs
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const iceCandidateQueueRef = useRef([]);
  const wsUnsubsRef = useRef([]);
  const screenStreamRef = useRef(null);

  // Native streams for RTCView
  const [localStreamUrl, setLocalStreamUrl] = useState(null);
  const [remoteStreamUrl, setRemoteStreamUrl] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);

  const isCaller = isCallerParam === '1' || isCallerParam === 'true';
  // Null safety: peer info (name/email) can be undefined/null during setup
  // (e.g. CallKit pushed offer arrived before contact resolution finished, or
  // the calling param was missing in the deep-link URL). Anything we render
  // into <Text> must be a non-empty string — passing null/undefined would
  // render nothing, but passing an object/number can throw "Objects are not
  // valid as a React child" mid-render and white-screen the call. Force a
  // String() coercion at the source so every consumer downstream is safe,
  // and fall back to a generic locale label instead of a bare "?".
  const _safePeerName = (() => {
    if (contactName && typeof contactName === 'string' && contactName.trim()) return contactName.trim();
    if (typeof contactEmail === 'string' && contactEmail.includes('@')) {
      const local = contactEmail.split('@')[0];
      if (local) return local;
    }
    return t('call.unknownPeer') || 'Chamada';
  })();
  const callerName = String(_safePeerName);
  // Email may also be missing — coerce to string for AvatarCircle/get_avatar
  // so they never receive `undefined` and short-circuit cleanly.
  const _safePeerEmail = typeof contactEmail === 'string' ? contactEmail : '';

  // Auto-hide controls after 5s when video is showing
  const resetControlsTimer = useCallback(() => {
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    setControlsVisible(true);
    Animated.timing(controlsFadeAnim, { toValue: 1, duration: 200, useNativeDriver: false }).start();
    controlsTimerRef.current = setTimeout(() => {
      if (videoEnabled && peerConnected) {
        Animated.timing(controlsFadeAnim, { toValue: 0, duration: 300, useNativeDriver: false }).start(() => {
          setControlsVisible(false);
        });
      }
    }, 5000);
  }, [videoEnabled, peerConnected, controlsFadeAnim]);

  // Toggle controls on tap (video mode)
  const handleScreenTap = useCallback(() => {
    if (!videoEnabled || !peerConnected) return;
    if (controlsVisible) {
      Animated.timing(controlsFadeAnim, { toValue: 0, duration: 300, useNativeDriver: false }).start(() => {
        setControlsVisible(false);
      });
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    } else {
      resetControlsTimer();
    }
  }, [videoEnabled, peerConnected, controlsVisible, resetControlsTimer, controlsFadeAnim]);

  // Wake lock - keep screen on during call (web + native)
  // Expose a teardown handle so external surfaces (CallKit's native end
  // button on the lock screen, system DND triggering call_end, etc.) can
  // tear down the active call without depending on the React tree being
  // mounted in foreground. Cleared on unmount so a stale screen never
  // intercepts the next call's hangup. We deliberately route through a ref
  // because handleEndCall is a useCallback declared further down the file —
  // depending on it directly here would TDZ-crash the dep array on the very
  // first render (handleEndCall not initialized yet at this point).
  const handleEndCallRef = useRef(null);
  useEffect(() => {
    try {
      if (typeof globalThis !== 'undefined') {
        globalThis.__chatyyTeardownActiveCall = (incomingCallId, source) => {
          if (!incomingCallId || incomingCallId === callId) {
            console.log('[Call] external teardown requested by', source);
            try { handleEndCallRef.current && handleEndCallRef.current(); } catch {}
          }
        };
      }
    } catch {}
    return () => {
      try { if (typeof globalThis !== 'undefined') delete globalThis.__chatyyTeardownActiveCall; } catch {}
    };
  }, [callId]);

  // Spring entrance — fires once on mount. Drives the status strip +
  // bottom action bar in from translateY:24 → 0 with fade. 260ms per spec,
  // tension/friction tuned to read snappy not bouncy on a call surface.
  // useNativeDriver:false to compose cleanly with controlsFadeAnim (which is
  // non-native because it animates layout-driven opacity on Animated.View).
  useEffect(() => {
    Animated.spring(barEnterAnim, {
      toValue: 1,
      tension: 110,
      friction: 11,
      useNativeDriver: false,
    }).start();
  }, [barEnterAnim]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      if (navigator.wakeLock) {
        navigator.wakeLock.request('screen').then(lock => { wakeLockRef.current = lock; }).catch(() => {});
      }
    } else {
      // Native: use expo-keep-awake
      try {
        const { activateKeepAwakeAsync, deactivateKeepAwake } = require('expo-keep-awake');
        activateKeepAwakeAsync('call-screen').catch(() => {});
        wakeLockRef.current = { release: () => deactivateKeepAwake('call-screen') };
      } catch {}
    }
    return () => {
      if (wakeLockRef.current) {
        try { wakeLockRef.current.release(); } catch {}
        wakeLockRef.current = null;
        // Belt-and-suspenders: even if release() throws on iOS (rare but
        // documented), force expo-keep-awake to drop the tag so the screen
        // doesn't stay on for hours after the call ends.
        if (Platform.OS !== 'web') {
          try {
            const { deactivateKeepAwake } = require('expo-keep-awake');
            deactivateKeepAwake?.('call-screen');
          } catch {}
        }
      }
    };
  }, []);

  // ── System audio interruption + network reachability ──────────────
  // Listen for PSTN call interruptions (handled natively via AVAudioSession
  // .interruptionNotification in ExpoCallKitModule) and pause/resume the
  // local mic accordingly. This makes Chatyy calls behave like WhatsApp.
  const [networkStatus, setNetworkStatus] = useState('online');
  useEffect(() => {
    const offAudio = _onAudioInterruption((state) => {
      try {
        if (!localStreamRef.current) return;
        if (state === 'began') {
          localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = false; });
          localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = false; });
        } else if (state === 'ended') {
          if (!audioMuted) localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = true; });
          if (videoEnabled) localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = true; });
        }
      } catch {}
    });
    const offNet = _onNetworkChange((status) => {
      setNetworkStatus(status);
    });
    return () => { offAudio(); offNet(); };
  }, []);

  // Send signaling message via WebSocket — declared BEFORE all useEffects that use it
  const sendSignaling = useCallback((type, data) => {
    try {
      const mailWs = require('../services/websocket').default;
      if (mailWs.isConnected) {
        mailWs._send({ type, ...data });
      }
    } catch {}
  }, []);

  // Keep call alive when app goes to background — pause video, keep audio + connection
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (!localStreamRef.current) return;
      if (nextState === 'background' || nextState === 'inactive') {
        // Pause local video but keep audio and peer connection alive
        localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = false; });
      } else if (nextState === 'active') {
        // Resume video when coming back to foreground
        if (videoEnabled) {
          localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = true; });
        }
      }
    });
    return () => sub.remove();
  }, [videoEnabled]);

  // Network change detection (WiFi <-> cellular) -> trigger ICE restart
  useEffect(() => {
    let cleanup = () => {};
    try {
      const NetInfo = require('@react-native-community/netinfo').default;
      const unsub = NetInfo.addEventListener((state) => {
        const newType = state?.type || 'unknown';
        const wasConnected = lastNetTypeRef.current !== null;
        const typeChanged = lastNetTypeRef.current && lastNetTypeRef.current !== newType;
        lastNetTypeRef.current = newType;
        setNetworkType(newType);

        // If network type changed mid-call and we're connected, trigger ICE restart
        if (wasConnected && typeChanged && peerConnected && !endedRef.current && pcRef.current) {
          console.log('[Call] Network changed:', lastNetTypeRef.current, '->', newType, '— triggering ICE restart');
          setReconnecting(true);
          iceRestartCountRef.current = 0; // Reset counter for network-change restarts

          // Refresh TURN credentials first, then restart ICE
          const doRestart = async () => {
            try {
              const mailWs = require('../services/websocket').default;
              if (mailWs.isConnected) {
                const creds = await new Promise((resolve) => {
                  const u = mailWs.on('turn_credentials', (d) => { u(); resolve(d?.credentials || d); });
                  mailWs._send({ type: 'get_turn_credentials' });
                  setTimeout(() => { u(); resolve(null); }, 3000);
                });
                if (creds?.urls) {
                  turnCredsRef.current = creds;
                  turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
                  if (pcRef.current?.setConfiguration) {
                    try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
                  }
                }
              }
            } catch {}

            // Now do ICE restart
            const pc = pcRef.current;
            if (pc && pc.signalingState === 'stable') {
              try {
                const offer = await pc.createOffer({ iceRestart: true });
                await pc.setLocalDescription(offer);
                sendSignaling('call_offer', {
                  call_id: callId,
                  target_email: contactEmail,
                  sdp: offer.sdp,
                  sdp_type: offer.type,
                  ice_restart: true,
                });
                console.log('[Call] ICE restart offer sent after network change');
              } catch (e) {
                console.warn('[Call] ICE restart after network change failed:', e?.message);
              }
            }
          };
          doRestart();
        }
      });
      cleanup = unsub;
    } catch {
      // NetInfo not available (web or missing dependency) — use online/offline events
      if (Platform.OS === 'web') {
        const handleOnline = () => {
          if (peerConnected && !endedRef.current && pcRef.current) {
            console.log('[Call] Browser came online — triggering ICE restart');
            setReconnecting(true);
            iceRestartCountRef.current = 0;
            const pc = pcRef.current;
            if (pc && pc.signalingState === 'stable') {
              pc.createOffer({ iceRestart: true }).then(async offer => {
                // Without await, sendSignaling can fire before localDescription
                // is actually set, so the server forwards an offer the peer
                // can't apply (renegotiation race → "video freeze loop").
                await pc.setLocalDescription(offer);
                sendSignaling('call_offer', {
                  call_id: callId,
                  target_email: contactEmail,
                  sdp: offer.sdp,
                  sdp_type: offer.type,
                  ice_restart: true,
                });
              }).catch(() => {});
            }
          }
        };
        window.addEventListener('online', handleOnline);
        cleanup = () => window.removeEventListener('online', handleOnline);
      }
    }
    netInfoUnsubRef.current = cleanup;
    return () => { if (netInfoUnsubRef.current) netInfoUnsubRef.current(); };
  }, [peerConnected, callId, contactEmail, sendSignaling]);

  // Mark call as active so IncomingCallListener doesn't interfere with signaling
  useEffect(() => {
    setCallActive(true);
    return () => {
      if (!minimizedRef.current) setCallActive(false);
    };
  }, []);

  // ── Group call: join room + peer signaling ──
  useEffect(() => {
    if (!isGroupCall || ended) return;
    let mailWs;
    try { mailWs = require('../services/websocket').default; } catch { return; }
    if (!mailWs.isConnected) return;

    mailWs._send({ type: 'group_call_join', call_id: callId, email: user?.email, name: user?.email?.split('@')[0] });

    const onPeerJoined = async (data) => {
      if (data.email === user?.email) return;
      try {
        const PeerConn = rtcRef.current.PeerConnection || (Platform.OS === 'web' ? window.RTCPeerConnection : null);
        if (!PeerConn) return;
        const pc = new PeerConn(getIceConfig());
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current));
          applyCodecPreferences(pc);
        }
        const peerStream = new MediaStream();
        pc.ontrack = (e) => { peerStream.addTrack(e.track); _updateGroupPeer(data.email, { stream: peerStream, name: data.name || data.email?.split('@')[0] }); };
        pc.onicecandidate = (e) => { if (e.candidate) mailWs._send({ type: 'group_call_ice', call_id: callId, target_email: data.email, candidate: e.candidate, from_email: user?.email }); };
        const offer = await pc.createOffer();
        offer.sdp = applyOpusTuning(offer.sdp);
        await pc.setLocalDescription(offer);
        mailWs._send({ type: 'group_call_offer', call_id: callId, target_email: data.email, sdp: offer.sdp, sdp_type: offer.type, from_email: user?.email, from_name: user?.email?.split('@')[0] });
        // Queue de ICE pra candidates que chegam antes da remote description
        groupPeersRef.current.set(data.email, { pc, stream: peerStream, name: data.name || data.email?.split('@')[0], iceQueue: [] });
        setGroupPeers(new Map(groupPeersRef.current));
      } catch (e) { console.warn('[GroupCall] peer join error:', e?.message); }
    };

    const onPeerLeft = (data) => {
      const peer = groupPeersRef.current.get(data.email);
      if (peer?.pc) {
        // Stop inbound tracks explicitly before closing the connection.
        // pc.close() is supposed to release them but on some webrtc stacks
        // (older Safari, react-native-webrtc <94) the underlying decoder
        // keeps running for a beat, leaking memory and burning battery on
        // long group calls with frequent join/leave churn.
        try { peer.pc.getReceivers().forEach(r => { try { r.track?.stop(); } catch {} }); } catch {}
        try { peer.pc.getSenders().forEach(s => { try { s.track?.stop(); } catch {} }); } catch {}
        try { peer.pc.close(); } catch {}
      }
      groupPeersRef.current.delete(data.email);
      setGroupPeers(new Map(groupPeersRef.current));
    };

    const onOffer = async (data) => {
      if (data.from_email === user?.email) return;
      try {
        const PeerConn = rtcRef.current.PeerConnection || (Platform.OS === 'web' ? window.RTCPeerConnection : null);
        const SessDesc = rtcRef.current.SessionDescription || (Platform.OS === 'web' ? window.RTCSessionDescription : null);
        if (!PeerConn || !SessDesc) return;
        const pc = new PeerConn(getIceConfig());
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current));
          applyCodecPreferences(pc);
        }
        const peerStream = new MediaStream();
        pc.ontrack = (e) => { peerStream.addTrack(e.track); _updateGroupPeer(data.from_email, { stream: peerStream, name: data.from_name || data.from_email?.split('@')[0] }); };
        pc.onicecandidate = (e) => { if (e.candidate) mailWs._send({ type: 'group_call_ice', call_id: callId, target_email: data.from_email, candidate: e.candidate, from_email: user?.email }); };
        await pc.setRemoteDescription(new SessDesc({ type: data.sdp_type, sdp: data.sdp }));
        const answer = await pc.createAnswer();
        answer.sdp = applyOpusTuning(answer.sdp);
        await pc.setLocalDescription(answer);
        mailWs._send({ type: 'group_call_answer', call_id: callId, target_email: data.from_email, sdp: answer.sdp, sdp_type: answer.type, from_email: user?.email });
        groupPeersRef.current.set(data.from_email, { pc, stream: peerStream, name: data.from_name || data.from_email?.split('@')[0], iceQueue: [] });
        setGroupPeers(new Map(groupPeersRef.current));
      } catch (e) { console.warn('[GroupCall] offer handling error:', e?.message); }
    };

    const onAnswer = async (data) => {
      const peer = groupPeersRef.current.get(data.from_email);
      if (peer?.pc) {
        const SessDesc = rtcRef.current.SessionDescription || (Platform.OS === 'web' ? window.RTCSessionDescription : null);
        if (SessDesc) {
          try {
            await peer.pc.setRemoteDescription(new SessDesc({ type: data.sdp_type, sdp: data.sdp }));
            // Drena queue de ICE acumulado enquanto a remote description
            // ainda não tinha sido setada (candidates chegam em paralelo)
            if (peer.iceQueue && peer.iceQueue.length) {
              for (const c of peer.iceQueue) {
                try { await peer.pc.addIceCandidate(c); } catch {}
              }
              peer.iceQueue = [];
            }
          } catch {}
        }
      }
    };

    const onIce = async (data) => {
      const peer = groupPeersRef.current.get(data.from_email);
      if (!peer?.pc) return;
      // Se remote description ainda não foi setada, bufferiza — o browser
      // descarta candidates silenciosamente antes do setRemoteDescription.
      if (!peer.pc.remoteDescription || !peer.pc.remoteDescription.type) {
        if (!peer.iceQueue) peer.iceQueue = [];
        peer.iceQueue.push(data.candidate);
        return;
      }
      try { await peer.pc.addIceCandidate(data.candidate); } catch {}
    };

    const u1 = mailWs.on('group_call_peer_joined', onPeerJoined);
    const u2 = mailWs.on('group_call_peer_left', onPeerLeft);
    const u3 = mailWs.on('group_call_offer', onOffer);
    const u4 = mailWs.on('group_call_answer', onAnswer);
    const u5 = mailWs.on('group_call_ice', onIce);

    // Cap adaptativo de bitrate em group call. Uplink = (N-1)×, então com 3
    // pessoas cada um envia 2 streams. Sem cap, cada stream tenta usar a
    // banda toda e a rede colapsa. Meet/WhatsApp dividem o budget pelo
    // número de peers. Recalcula a cada peer join/leave.
    const reapplyGroupBitrateCap = () => {
      try {
        const peerCount = Math.max(1, groupPeersRef.current.size);
        // Budget total alvo: ~2 Mbps upload (celular 4G típico). Divide:
        //   2 peers → 1 Mbps cada
        //   3 peers → 666 kbps cada
        //   4+     → 500 kbps cada (piso)
        const perPeerBitrate = Math.max(400_000, Math.floor(2_000_000 / peerCount));
        const perPeerFps = peerCount >= 4 ? 15 : (peerCount === 3 ? 20 : 24);
        for (const [, peer] of groupPeersRef.current) {
          if (!peer?.pc) continue;
          for (const sender of peer.pc.getSenders()) {
            if (sender.track?.kind !== 'video') continue;
            try {
              const params = sender.getParameters();
              if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
              params.encodings[0].maxBitrate = perPeerBitrate;
              params.encodings[0].maxFramerate = perPeerFps;
              sender.setParameters(params).catch(() => {});
            } catch {}
          }
        }
      } catch {}
    };

    // Observer: refaz o cap quando o mapa de peers muda
    const groupSizeWatcher = setInterval(reapplyGroupBitrateCap, 3000);

    return () => {
      clearInterval(groupSizeWatcher);
      u1(); u2(); u3(); u4(); u5();
      groupPeersRef.current.forEach(p => { try { p.pc?.close(); } catch {} });
      groupPeersRef.current.clear();
    };
  }, [isGroupCall, callId, user?.email, ended]);

  const _updateGroupPeer = useCallback((email, updates) => {
    const existing = groupPeersRef.current.get(email) || {};
    groupPeersRef.current.set(email, { ...existing, ...updates });
    setGroupPeers(new Map(groupPeersRef.current));
  }, []);

  // Register active call for the green bar
  useEffect(() => {
    setActiveCall({
      callId,
      contactName: callerName,
      contactEmail,
      isVideo: isVideoParam === '1' || isVideoParam === 'true',
      conversationId,
      isCaller,
    });
    // Don't clear on unmount if minimized — the bar should remain
    return () => {
      if (!minimizedRef.current) clearActiveCall();
    };
  }, []);

  // Restore from minimized global state (when returning via ActiveCallBar)
  useEffect(() => {
    const gc = _getGC();
    if (gc && gc.callId === callId) {
      console.log('[Call] Restoring minimized call');
      pcRef.current = gc.pc;
      localStreamRef.current = gc.localStream;
      screenStreamRef.current = gc.screenStream;
      wsUnsubsRef.current = gc.wsUnsubs || [];
      callDurationRef.current = gc.duration || 0;
      setCallDuration(gc.duration || 0);
      setPeerConnected(true);
      minimizedRef.current = false;
      _clearGC();
    }
  }, [callId]);

  // Minimize: go back to chat without ending the call
  const handleMinimize = useCallback(() => {
    // Save WebRTC resources to global so they survive unmount
    _setGC({
      callId,
      pc: pcRef.current,
      localStream: localStreamRef.current,
      screenStream: screenStreamRef.current,
      wsUnsubs: wsUnsubsRef.current,
      duration: callDurationRef.current,
      contactEmail,
      isCaller,
    });
    // Prevent cleanup from destroying the connection
    minimizedRef.current = true;
    pcRef.current = null;
    localStreamRef.current = null;
    screenStreamRef.current = null;
    wsUnsubsRef.current = [];

    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/chat');
    }
  }, [callId, contactEmail, isCaller, router]);

  // Store RTC constructors in refs (different on web vs native)
  const rtcRef = useRef({
    PeerConnection: null,
    SessionDescription: null,
    IceCandidate: null,
  });

  const formatDuration = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // ICE servers config
  // TURN URLs use turn.chatyy.com.br — grey-cloud DNS A record (NOT Cloudflare
  // proxied) pointing to coturn on 217.216.67.99. CF proxy doesn't pass UDP.
  const TURN_FALLBACK_URLS = [
    'turn:turn.chatyy.com.br:3478?transport=udp',
    'turn:turn.chatyy.com.br:3478?transport=tcp',
    'turns:turn.chatyy.com.br:5349?transport=tcp',
  ];
  const STUN_ONLY_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:turn.chatyy.com.br:3478' },
  ];
  const turnCredsRef = useRef(null);
  const getIceConfig = () => {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:turn.chatyy.com.br:3478' },
      ],
      // Configs avançados REMOVIDOS — user reportou "não pode conectar com
      // servidor" logo que tenta ligar. bundlePolicy/iceCandidatePoolSize
      // podem falhar em versões específicas do react-native-webrtc da
      // plataforma. Voltando pro default WebRTC standard — Opus tuning +
      // codec preference continuam (são aplicados no SDP, não aqui).
    };
    if (turnCredsRef.current) {
      config.iceServers.push({
        urls: turnCredsRef.current.urls || TURN_FALLBACK_URLS,
        username: turnCredsRef.current.username,
        credential: turnCredsRef.current.credential,
      });
    }
    return config;
  };

  // *** MOVED UP: sendSignaling must be declared before any useEffect that lists it as a dependency ***
  // (const declarations have no hoisting — Metro web bundler evaluates deps at hook call time)

  // Attach remote stream for playback
  const attachRemoteStream = useCallback((stream) => {
    setRemoteStream(stream);

    if (Platform.OS === 'web') {
      let el = document.getElementById('remoteCallAudio');
      if (!el) {
        el = document.createElement('audio');
        el.id = 'remoteCallAudio';
        el.autoplay = true;
        el.playsInline = true;
        document.body.appendChild(el);
      }
      el.srcObject = stream;
      remoteAudioRef.current = el;

      if (stream.getVideoTracks().length > 0) {
        let vid = document.getElementById('remoteCallVideo');
        if (!vid) {
          vid = document.createElement('video');
          vid.id = 'remoteCallVideo';
          vid.autoplay = true;
          vid.playsInline = true;
          vid.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;';
          document.body.appendChild(vid);
        }
        vid.srcObject = stream;
        remoteVideoRef.current = vid;
      }
    } else {
      if (stream?.toURL) {
        setRemoteStreamUrl(stream.toURL());
      }
    }
  }, []);

  // Apply video filter to web remote video
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const vid = document.getElementById('remoteCallVideo');
    if (vid) {
      const filters = { warm: 'saturate(1.3) sepia(0.15) brightness(1.05)', cool: 'saturate(0.9) hue-rotate(15deg) brightness(1.05)', bw: 'grayscale(1)', vintage: 'sepia(0.4) contrast(1.1) brightness(0.95)', beauty: 'brightness(1.08) contrast(0.95) saturate(1.1) blur(0.3px)' };
      vid.style.filter = (activeFilter && filters[activeFilter]) || 'none';
    }
  }, [activeFilter]);

  // Handle incoming ICE candidate
  const handleIceCandidate = useCallback(async (data) => {
    if (!data?.candidate) return;
    const pc = pcRef.current;

    if (!pc || !pc.remoteDescription) {
      iceCandidateQueueRef.current.push(data.candidate);
      return;
    }

    try {
      await pc.addIceCandidate(new (rtcRef.current.IceCandidate || RTCIceCandidate)(data.candidate));
    } catch (e) { console.warn('[Call] addIceCandidate failed:', e?.message); }
  }, []);

  // Handle incoming SDP answer (caller receives this)
  const handleAnswer = useCallback(async (data) => {
    const pc = pcRef.current;
    if (!pc || !data?.sdp) return;
    // Guard against late answer arriving after call ended/teardown started.
    // Without this, setPeerRinging + setRemoteDescription fire on a closed
    // PC and either warn ("setRemoteDescription on closed connection") or
    // throw — both visible to user as a phantom "ringing" or crash banner.
    if (endedRef.current) return;
    if (pc.signalingState === 'closed' || pc.connectionState === 'closed') return;
    // Late/duplicate call_answer guard: only apply when we're actually
    // waiting for an answer. If state is 'stable' the offer/answer cycle
    // already completed (or we never sent an offer — e.g. a re-delivered
    // answer after WS reconnect), and setRemoteDescription would throw
    // `InvalidStateError`, killing the call setup silently. Cross-platform
    // call regression (#877) traced to this when iOS sender retried the
    // offer mid-flight and Android sent two answers back-to-back.
    if (pc.signalingState !== 'have-local-offer') {
      console.log('[Call] handleAnswer: skipping, signalingState=' + pc.signalingState);
      return;
    }

    // Caller proof-of-life: peer device processed our offer enough to send
    // an answer back. Flip to "ringing" UI until ICE actually connects.
    try { setPeerRinging(true); } catch {}

    try {
      await pc.setRemoteDescription(new (rtcRef.current.SessionDescription || RTCSessionDescription)({
        type: data.sdp_type || data.type || 'answer',
        sdp: data.sdp,
      }));

      for (const candidate of iceCandidateQueueRef.current) {
        try { await pc.addIceCandidate(new (rtcRef.current.IceCandidate || RTCIceCandidate)(candidate)); } catch (e) { console.warn('[Call] addIceCandidate failed:', e?.message); }
      }
      iceCandidateQueueRef.current = [];
    } catch (err) {
      console.error('Failed to set remote answer:', err);
    }
  }, []);

  // Handle incoming SDP offer (callee receives this)
  const handleOffer = useCallback(async (data) => {
    const pc = pcRef.current;
    if (!pc || !data?.sdp) return;
    // Drop late offers that arrive after teardown — see handleAnswer guard.
    if (endedRef.current) return;
    if (pc.signalingState === 'closed' || pc.connectionState === 'closed') return;

    // ROOT-CAUSE FIX (2026-05-12): when a callee receives `call_offer` over WS
    // BEFORE the setupCall flow has finished addTrack (getUserMedia race), the
    // answer SDP is created with zero local senders. Result: caller's audio
    // m-line lands on `recvonly` at the callee end, so the audio engine never
    // binds the inbound stream to playback. The classic "conecta mas ninguém
    // escuta o outro" bug. We now wait up to 3s for the local stream to be
    // ready before answering; if it never shows, we proceed anyway (better a
    // mute call than no call), and the upgrade path can re-negotiate when the
    // mic becomes available.
    const waitForLocalTracks = async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (endedRef.current) return false;
        if (localStreamRef.current && localStreamRef.current.getTracks().length > 0) {
          // Also ensure we've actually bound tracks to senders — check sender count.
          if (pc.getSenders && pc.getSenders().some(s => s.track)) return true;
          // Stream exists but no sender has a track yet — bind via replaceTrack
          // on the fixed-order transceivers (added at PC creation). Avoid
          // addTrack here: it would append a NEW m-line and break the locked
          // ordering that the m-line-mismatch fix (2026-05-12) depends on.
          try {
            const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
            const audioTrack = localStreamRef.current.getAudioTracks()[0];
            const videoTrack = localStreamRef.current.getVideoTracks()[0];
            const audioTx = transceivers.find(tr => tr.sender && (tr.sender.track?.kind === 'audio' || tr.receiver?.track?.kind === 'audio' || tr.mid === '0'));
            const videoTx = transceivers.find(tr => tr.sender && (tr.sender.track?.kind === 'video' || tr.receiver?.track?.kind === 'video' || tr.mid === '1'));
            if (audioTrack && audioTx?.sender && audioTx.sender.track !== audioTrack) {
              try { await audioTx.sender.replaceTrack(audioTrack); } catch {}
            }
            if (videoTrack && videoTx?.sender && videoTx.sender.track !== videoTrack) {
              try { await videoTx.sender.replaceTrack(videoTrack); } catch {}
            }
            return true;
          } catch {}
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    };
    await waitForLocalTracks();

    try {
      // Glare: both sides sent offers simultaneously. Polite peer rolls back.
      if (pc.signalingState === 'have-local-offer') {
        await pc.setLocalDescription({type: 'rollback'});
      }

      // Pre-seed recvonly transceivers se ainda não existem — garante m-line order
      // (audio=0, video=1) ANTES de setRemoteDescription. Sem isso, em answer-via-push
      // o handleOffer pode rodar antes do setupCall criar transceivers, e createAnswer
      // sai com m-lines em ordem aleatória → tela preta sem handshake (#3).
      try {
        if (pc.getTransceivers && pc.getTransceivers().length === 0 && pc.addTransceiver) {
          pc.addTransceiver('audio', { direction: 'recvonly' });
          pc.addTransceiver('video', { direction: 'recvonly' });
          console.log('[Call] handleOffer: pre-seeded recvonly transceivers (audio,video)');
        }
      } catch (preseedErr) {
        console.warn('[Call] pre-seed tx failed:', preseedErr?.message);
      }

      await pc.setRemoteDescription(new (rtcRef.current.SessionDescription || RTCSessionDescription)({
        type: data.sdp_type || data.type || 'offer',
        sdp: data.sdp,
      }));

      // Pre-answer audit — bind tracks via replaceTrack on the locked-order
      // transceivers (audio first, video second) instead of addTrack. addTrack
      // would shift m-line positions and trip "subsequent offer doesn't match"
      // on the next renegotiation.
      try {
        const localStream = localStreamRef.current;
        if (localStream && pc.getTransceivers) {
          const transceivers = pc.getTransceivers();
          const audioTrack = localStream.getAudioTracks()[0];
          const videoTrack = localStream.getVideoTracks()[0];
          const audioTx = transceivers.find(tr => tr.sender && (tr.sender.track?.kind === 'audio' || tr.receiver?.track?.kind === 'audio' || tr.mid === '0'));
          const videoTx = transceivers.find(tr => tr.sender && (tr.sender.track?.kind === 'video' || tr.receiver?.track?.kind === 'video' || tr.mid === '1'));
          if (audioTrack && audioTx?.sender && audioTx.sender.track !== audioTrack) {
            try { await audioTx.sender.replaceTrack(audioTrack); console.log('[Call] pre-answer: replaceTrack audio'); } catch {}
          }
          if (videoTrack && videoTx?.sender && videoTx.sender.track !== videoTrack) {
            try { await videoTx.sender.replaceTrack(videoTrack); console.log('[Call] pre-answer: replaceTrack video'); } catch {}
          }
          if (audioTrack && !audioMutedRef.current) audioTrack.enabled = true;
          if (videoTrack && videoEnabledRef.current) videoTrack.enabled = true;
          console.log('[Call] pre-answer audit: tx=' + transceivers.length + ' audioTx=' + !!audioTx + ' videoTx=' + !!videoTx);
        }
      } catch {}

      // Force the answer to advertise both audio + video reception. Without
      // this, browsers omit the video m-line in the answer when no local
      // video track was added yet, which permanently freezes incoming video
      // even if the caller is sending it. The corresponding addTrack for
      // local video happens later when the user enables their camera.
      const answer = await pc.createAnswer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      // Apply WhatsApp-grade Opus tuning to the answer SDP as well — without
      // this the callee falls back to default Opus (60ms ptime, no FEC, no
      // DTX) while the caller is tuned. Mismatch surfaces as 1-3s of audio
      // delay post-answer (#841) because the audio engine waits for the
      // negotiated payload format to align before unmuting playback.
      try { answer.sdp = applyOpusTuning(answer.sdp); } catch {}
      await pc.setLocalDescription(answer);

      sendSignaling('call_answer', {
        call_id: callId,
        target_email: contactEmail,
        sdp: answer.sdp,
        sdp_type: answer.type,
        video: !!videoEnabledRef.current,
      });

      for (const candidate of iceCandidateQueueRef.current) {
        try { await pc.addIceCandidate(new (rtcRef.current.IceCandidate || RTCIceCandidate)(candidate)); } catch (e) { console.warn('[Call] addIceCandidate failed:', e?.message); }
      }
      iceCandidateQueueRef.current = [];
    } catch (err) {
      console.error('Failed to handle offer:', err);
    }
  }, [callId, contactEmail, sendSignaling]);

  // End the call — Skype/WhatsApp-style ordered teardown.
  //
  // Order matters because each step depends on the previous one being done:
  //   1. Move state to 'ending' so concurrent ICE callbacks bail out
  //   2. Stop ringtone (caller-side ringing UI)
  //   3. Stop sending media (pause RTP) — gives the other side a clean fade-out
  //   4. Send BYE with retry/ACK (3 attempts, 1.5s timeout each)
  //   5. Close PeerConnection
  //   6. Release AudioSession with notifyOthersOnDeactivation (Spotify resumes)
  //   7. End CallKit transaction
  //   8. Persist to history + nav back
  const handleEndCall = useCallback(() => {
    // If group call, send leave and close all peer connections
    if (isGroupCall) {
      try {
        const mailWs = require('../services/websocket').default;
        if (mailWs.isConnected) mailWs._send({ type: 'group_call_leave', call_id: callId, email: user?.email });
      } catch {}
      groupPeersRef.current.forEach(p => { try { p.pc?.close(); } catch {} });
      groupPeersRef.current.clear();
      setGroupPeers(new Map());
    }

    if (endedRef.current) return;
    if (callStateRef.current === 'ending' || callStateRef.current === 'ended') return;
    setCallStateInternal('ending');
    endedRef.current = true;
    minimizedRef.current = false;
    _clearGC();
    setEnded(true);
    clearActiveCall();
    // Libera o dedup flag pra próxima ligação pro mesmo/qualquer peer
    try { if (globalThis.__chatyyLastCallInviteId === callId) delete globalThis.__chatyyLastCallInviteId; } catch {}

    // Cancel all timers / interval / network listeners FIRST so callbacks
    // racing with the teardown can't fire.
    if (callerTimeoutRef.current) clearTimeout(callerTimeoutRef.current);
    if (disconnectTimeoutRef.current) clearTimeout(disconnectTimeoutRef.current);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    if (iceTimeoutRef.current) { clearTimeout(iceTimeoutRef.current); iceTimeoutRef.current = null; }
    if (turnRefreshRef.current) { clearInterval(turnRefreshRef.current); turnRefreshRef.current = null; }
    if (netInfoUnsubRef.current) { try { netInfoUnsubRef.current(); } catch {} netInfoUnsubRef.current = null; }
    if (wakeLockRef.current) { try { wakeLockRef.current.release(); } catch {} wakeLockRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    // Stop ringtone immediately — this is the UX change the user notices.
    try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}

    // Pause RTP send so the other side hears silence rather than a glitch.
    if (localStreamRef.current) {
      try {
        localStreamRef.current.getTracks().forEach(t => { try { t.enabled = false; } catch {} });
      } catch {}
    }

    // Send BYE with retry + ACK. Fire-and-forget the retry loop so the UI
    // doesn't block on it — but we DO wait briefly before tearing down media
    // to give the message a chance to flush over the WebSocket.
    // Exponential backoff (0.6s, 1.2s, 2.4s, 4s, 5s) over 6 attempts so a
    // brief WS flap during hangup doesn't leave the peer thinking the call
    // is still active. Worst case: ~13s total before giving up.
    // Send BYE with up to 2 retries on a short backoff. The original loop
    // tried 6× with up to ~13s of redundant traffic gated on a __lastCallEndAckId
    // global that nothing in the codebase ever sets — the short-circuit
    // never fired, so every hangup was sending six redundant call_end
    // messages. The Go WS persists call state for a few seconds after the
    // first call_end and the peer's listener is idempotent, so 1 send + 1
    // retry on a 1.2s backoff (in case of WS flap) is enough.
    const sendByeWithRetry = async () => {
      // 3-attempt schedule (0ms, 800ms, 1800ms) — matches WhatsApp/Skype
      // retry curves observed in pcap captures. 2× wasn't enough in dual-
      // network handoff scenarios (WiFi→LTE during hangup tap): the first
      // send raced the network switch and was dropped, the second arrived
      // after the WS reconnect retry interval and the peer was already in a
      // ghost-ringing state. 3 attempts spread across ~2s covers the WS
      // reconnect window without spamming the relay.
      const delays = [0, 800, 1800];
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]));
        try {
          sendSignaling('call_end', {
            call_id: callId,
            target_email: contactEmail,
            reason: 'hangup',
            attempt: attempt + 1,
          });
        } catch {}
      }
    };
    sendByeWithRetry().catch(() => {});

    // Persist to history (independent of teardown)
    addCallToHistory({
      contactEmail,
      contactName: callerName,
      callId,
      type: isCaller ? 'outgoing' : 'incoming',
      video: isVideoParam === '1' || isVideoParam === 'true',
      timestamp: Date.now(),
      duration: callDurationRef.current,
    }).catch(() => {});

    // Auto-update the in-thread call_card so every chat shows the final
    // duration as soon as the call ends. WhatsApp/Telegram parity: the
    // bubble flips from "Calling…" / "Ringing" to "Call · 3m 12s" on both
    // sides without anyone re-opening the chat. Only fires when the peer
    // actually connected for >3s — anything shorter is treated as a
    // not-really-a-call (call_notify already wrote the missed/cancelled
    // status, and overwriting here would clobber it).
    try {
      const dur = Number(callDurationRef.current) || 0;
      if (dur > 3) {
        const apiMod = require('../services/api');
        apiMod.callStatus?.(callId, 'completed', dur).catch(() => {});
      }
    } catch {}

    // Upload call recording if active
    if (isRecording || recordedChunksRef.current.length > 0) {
      if (mediaRecorderRef.current) {
        if (Platform.OS === 'web' && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      }
      // Small delay to let final data chunks arrive before uploading
      setTimeout(() => { uploadRecordingAsync().catch(() => {}); }, 500);
    }

    // Stop screen sharing
    if (screenStreamRef.current) {
      try { screenStreamRef.current.getTracks().forEach(t => t.stop()); } catch {}
      screenStreamRef.current = null;
    }

    if (localStreamRef.current) {
      try { localStreamRef.current.getTracks().forEach(t => t.stop()); } catch {}
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }
    // Drop any buffered ICE candidates so a stale candidate from this
    // call can never be applied to the next PeerConnection (component
    // remount preserves the iceCandidateQueueRef instance across HMR /
    // PiP minimization re-entry; clearing here is the only place that
    // catches the explicit-end path).
    try { iceCandidateQueueRef.current = []; } catch {}

    // Audio session: prefer the new native module (notifies Spotify/Music
    // to resume). Fall back to expo-audio for parity if the module isn't
    // present (e.g. on older builds). We also explicitly disable the
    // proximity sensor so the screen doesn't stay dark after the call
    // (was the "desliga mas n desliga" bug).
    try { _NativeAudioSession?.enableProximitySensor?.(false); } catch {}
    if (_NativeAudioSession?.deactivate) {
      _NativeAudioSession.deactivate().catch(() => {});
    } else if (Platform.OS !== 'web') {
      try {
        const { setAudioModeAsync } = require('expo-audio');
        setAudioModeAsync({
          interruptionMode: 'mixWithOthers',
          playsInSilentMode: false,
          shouldPlayInBackground: false,
          allowsRecording: false,
        });
      } catch {}
      try {
        const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
        RTCAudioSession.audioSessionDidDeactivate();
      } catch {}
    }

    callKeep.endCall(callId);
    setCallStateInternal('ended');
    // Always clear the global "call active" flag on the explicit end path
    // (codex finding: cleanup didn't always reset it, so IncomingCallListener
    // stayed suppressed and missed the next incoming call until app restart).
    try { setCallActive(false); } catch {}
    if (Platform.OS === 'web') {
      try { document.getElementById('remoteCallAudio')?.remove(); } catch {}
      try { document.getElementById('remoteCallVideo')?.remove(); } catch {}
      try { document.getElementById('localCallVideo')?.remove(); } catch {}
    }
    wsUnsubsRef.current.forEach(unsub => { try { unsub(); } catch {} });
    wsUnsubsRef.current = [];

    // FaceTime-style end card — fade in over 220ms, hold ~1.1s, then nav.
    // The total budget stays close to 1.5s so the user reads the duration +
    // "encerrada" label before the screen pops back. Native driver because
    // we only animate opacity.
    try {
      Animated.timing(endCardAnim, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      }).start();
    } catch {}

    setTimeout(() => {
      try {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/chat');
        }
      } catch {
        try { router.replace('/chat'); } catch {}
      }
    }, 1500);
  }, [callId, contactEmail, sendSignaling, router, endCardAnim]);

  // Keep handleEndCallRef pointing at the latest handleEndCall so the
  // external __chatyyTeardownActiveCall (registered above before
  // handleEndCall is declared) can dispatch through it without TDZ.
  useEffect(() => {
    handleEndCallRef.current = handleEndCall;
  }, [handleEndCall]);

  // Reconnect: tear down existing PC, fetch fresh TURN credentials, and re-create
  const handleReconnect = useCallback(async () => {
    if (endedRef.current) return;
    console.log('[Call] handleReconnect: retrying connection...');
    setConnectionFailed(false);
    setErrorMsg(null);
    setReconnecting(true);
    iceRestartCountRef.current = 0;

    // Close old peer connection
    if (pcRef.current) {
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }

    try {
      const mailWs = require('../services/websocket').default;
      const video = isVideoParam === '1' || isVideoParam === 'true';

      // Fetch fresh TURN credentials
      let turnSuccess = false;
      for (let attempt = 0; attempt < 3 && !turnSuccess; attempt++) {
        try {
          const creds = await new Promise((resolve) => {
            const unsub = mailWs.on('turn_credentials', (data) => {
              unsub();
              resolve(data?.credentials || data);
            });
            mailWs._send({ type: 'get_turn_credentials' });
            setTimeout(() => { unsub(); resolve(null); }, 5000);
          });
          if (creds?.urls) {
            turnCredsRef.current = creds;
            turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
            turnSuccess = true;
          } else if (attempt < 2) {
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch {
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!turnSuccess) {
        console.log('[Call] Reconnect: TURN unavailable, using STUN-only');
        turnCredsRef.current = null;
      }

      let RTC_PeerConnection, RTC_SessionDescription;
      if (Platform.OS === 'web') {
        RTC_PeerConnection = window.RTCPeerConnection;
        RTC_SessionDescription = window.RTCSessionDescription;
      } else {
        const webrtc = require('@stream-io/react-native-webrtc');
        RTC_PeerConnection = webrtc.RTCPeerConnection;
        RTC_SessionDescription = webrtc.RTCSessionDescription;
      }

      const pc = new RTC_PeerConnection(getIceConfig());
      pcRef.current = pc;

      // ICE timeout for reconnect
      if (iceTimeoutRef.current) clearTimeout(iceTimeoutRef.current);
      iceTimeoutRef.current = setTimeout(() => {
        if (!endedRef.current &&
            pc.iceConnectionState !== 'connected' &&
            pc.iceConnectionState !== 'completed') {
          console.log('[Call] Reconnect ICE timeout after 30s');
          setErrorMsg(t('call.connectionFailed') || 'Não foi possível conectar. Tente novamente.');
          setConnectionFailed(true);
          setReconnecting(false);
        }
      }, 30000);

      // Re-add local tracks — use fixed-order transceivers + replaceTrack
      // so m-lines never reorder across the reconnect (would otherwise hit
      // "subsequent offer doesn't match" same as the initial caller path).
      if (localStreamRef.current) {
        const stream = localStreamRef.current;
        try {
          const audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
          const videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
          const audioTrack = stream.getAudioTracks()[0];
          const videoTrack = stream.getVideoTracks()[0];
          if (audioTrack && audioTx?.sender) { try { await audioTx.sender.replaceTrack(audioTrack); } catch {} }
          if (videoTrack && videoTx?.sender) { try { await videoTx.sender.replaceTrack(videoTrack); } catch {} }
          else if (videoTx) { try { videoTx.direction = 'inactive'; } catch {} }
        } catch (e) {
          stream.getTracks().forEach(track => { try { pc.addTrack(track, stream); } catch {} });
        }
        applyCodecPreferences(pc);
      }

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          attachRemoteStream(event.streams[0]);
          setPeerConnected(true);
          setReconnecting(false);
          callKeep.reportConnected(callId);
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignaling('call_ice', {
            call_id: callId,
            target_email: contactEmail,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log('[Call] Reconnect ICE state:', state);
        if (state === 'connected' || state === 'completed') {
          if (iceTimeoutRef.current) { clearTimeout(iceTimeoutRef.current); iceTimeoutRef.current = null; }
          setPeerConnected(true);
          setReconnecting(false);
          setConnectionFailed(false);
          setErrorMsg(null);
          iceRestartCountRef.current = 0;
        } else if (state === 'failed') {
          setConnectionFailed(true);
          setReconnecting(false);
          setErrorMsg(t('call.connectionFailed') || 'Não foi possível conectar. Tente novamente.');
        }
      };

      if (pc.onconnectionstatechange !== undefined) {
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') setPeerConnected(true);
          else if (pc.connectionState === 'failed') {
            setConnectionFailed(true);
            setReconnecting(false);
            setErrorMsg(t('call.connectionFailed') || 'Não foi possível conectar. Tente novamente.');
          }
        };
      }

      // Create and send new offer with ICE restart
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: video,
        iceRestart: true,
      });
      // WhatsApp-grade Opus tuning: 24kbps target, FEC for packet loss
      // recovery, DTX (silence suppression) to save bandwidth.
      offer.sdp = applyOpusTuning(offer.sdp);
      await pc.setLocalDescription(offer);

      sendSignaling('call_offer', {
        call_id: callId,
        target_email: contactEmail,
        conversation_id: conversationId,
        sdp: offer.sdp,
        sdp_type: offer.type,
        video,
        ice_restart: true,
      });

      console.log('[Call] Reconnect offer sent');
    } catch (err) {
      console.error('[Call] Reconnect error:', err);
      setReconnecting(false);
      setConnectionFailed(true);
      setErrorMsg(t('call.connectionFailed') || 'Não foi possível conectar. Tente novamente.');
    }
  }, [callId, contactEmail, conversationId, isVideoParam, sendSignaling, attachRemoteStream, t]);

  // Initialize WebRTC call
  useEffect(() => {
    let RTC_PeerConnection, RTC_SessionDescription, RTC_IceCandidate, getUserMediaFn;

    if (Platform.OS === 'web') {
      RTC_PeerConnection = window.RTCPeerConnection;
      RTC_SessionDescription = window.RTCSessionDescription;
      RTC_IceCandidate = window.RTCIceCandidate;
      getUserMediaFn = (constraints) => navigator.mediaDevices.getUserMedia(constraints);
    } else {
      try {
        const webrtc = require('@stream-io/react-native-webrtc');
        RTC_PeerConnection = webrtc.RTCPeerConnection;
        RTC_SessionDescription = webrtc.RTCSessionDescription;
        RTC_IceCandidate = webrtc.RTCIceCandidate;
        getUserMediaFn = (constraints) => webrtc.mediaDevices.getUserMedia(constraints);
      } catch {
        setErrorMsg(t('call.webOnly') || 'Chamadas não disponíveis nesta versão');
        return;
      }
    }

    rtcRef.current = {
      PeerConnection: RTC_PeerConnection,
      SessionDescription: RTC_SessionDescription,
      IceCandidate: RTC_IceCandidate,
    };

    let mounted = true;

    const setupCall = async () => {
      try {
        // Stop ringtone and release audio session BEFORE WebRTC takes over
        try {
          const { stopRingtone } = require('../services/ringtone');
          stopRingtone();
        } catch {}
        // PRE-WARM InCallManager + ExpoAudioSession BEFORE getUserMedia.
        // Without this, AVAudioSession only gets the right category after
        // the local mic stream is up (lines ~1641-1679), which means the
        // first 1-3s of incoming RTP packets get dropped by the iOS audio
        // engine — user reported "atendi mas demora pra ouvir a voz".
        // WhatsApp pre-warms in CallKit's CXAnswerCallAction; this is the
        // RN-level equivalent. Removed the 300ms ringtone-release sleep
        // since stopRingtone() is synchronous and the AVAudioSession
        // re-category below preempts whatever the ringtone left behind.
        if (Platform.OS !== 'web') {
          try {
            const InCallManager = require('react-native-incall-manager').default;
            const isVideo = isVideoParam === '1' || isVideoParam === 'true';
            InCallManager.start({ media: isVideo ? 'video' : 'audio', auto: false });
          } catch (e) { console.log('[Call] InCallManager.start err:', e?.message); }
          try {
            const ExpoAudioSession = require('../modules/expo-audio-session').default;
            const isVideo = isVideoParam === '1' || isVideoParam === 'true';
            if (isVideo) ExpoAudioSession.activateForVideoCall?.();
            else ExpoAudioSession.activateForCall?.(false);
          } catch {}
        }

        const video = isVideoParam === '1' || isVideoParam === 'true';
        console.log('[Call] setupCall: isCaller=' + isCaller + ' video=' + video + ' callId=' + callId);

        const mailWs = require('../services/websocket').default;

        const unsubTurn = mailWs.on('call_turn_credentials', (data) => {
          if (data?.call_id === callId && data?.credentials) {
            turnCredsRef.current = data.credentials;
            turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
            if (pcRef.current && pcRef.current.setConfiguration) {
              try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
            }
          }
        });
        const unsubAnswer = mailWs.on('call_answer', (data) => {
          if (data?.call_id === callId) handleAnswer(data);
        });
        const unsubIce = mailWs.on('call_ice', (data) => {
          if (data?.call_id === callId) {
            // First ICE from peer also confirms their device picked up our
            // offer — flip ringing state. Idempotent; statusText gives
            // priority to peerConnected so this never "downgrades" UI.
            try { if (mounted) setPeerRinging(true); } catch {}
            handleIceCandidate(data);
          }
        });
        const unsubOffer = mailWs.on('call_offer', (data) => {
          if (data?.call_id === callId) {
            if (data.turn_credentials) {
              turnCredsRef.current = data.turn_credentials;
              if (pcRef.current && pcRef.current.setConfiguration) {
                try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
              }
            }
            handleOffer(data);
          }
        });
        const callAcceptedRef = { current: false };
        const unsubAccepted = mailWs.on('call_accepted', (data) => {
          if (data?.call_id === callId && mounted) {
            callAcceptedRef.current = true;
            if (callerTimeoutRef.current) clearTimeout(callerTimeoutRef.current);
            try {
              const { stopRingtone } = require('../services/ringtone');
              stopRingtone();
            } catch {}
          }
        });
        const unsubEnd = mailWs.on('call_end', (data) => {
          if (callAcceptedRef.current && data?.reason === 'declined') return;
          if (data?.call_id === callId && mounted && !endedRef.current) {
            endedRef.current = true;
            setEnded(true);
            clearActiveCall();
            // Log call to history (remote ended)
            addCallToHistory({
              contactEmail,
              contactName: callerName,
              callId,
              type: isCaller ? 'outgoing' : 'incoming',
              video: isVideoParam === '1' || isVideoParam === 'true',
              timestamp: Date.now(),
              duration: callDurationRef.current,
            }).catch(() => {});
            try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}
            if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
            if (statsIntervalRef.current) { clearInterval(statsIntervalRef.current); statsIntervalRef.current = null; }
            if (iceTimeoutRef.current) { clearTimeout(iceTimeoutRef.current); iceTimeoutRef.current = null; }
            if (turnRefreshRef.current) { clearInterval(turnRefreshRef.current); turnRefreshRef.current = null; }
            if (controlsTimerRef.current) { clearTimeout(controlsTimerRef.current); controlsTimerRef.current = null; }
            if (disconnectTimeoutRef.current) { clearTimeout(disconnectTimeoutRef.current); disconnectTimeoutRef.current = null; }
            setCallActive(false);
            if (Platform.OS !== 'web') {
              try {
                const { setAudioModeAsync } = require('expo-audio');
                setAudioModeAsync({ interruptionMode: 'mixWithOthers', playsInSilentMode: false, shouldPlayInBackground: false, allowsRecording: false });
              } catch {}
              try {
                const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
                RTCAudioSession.audioSessionDidDeactivate();
              } catch {}
            }
            callKeep.endCall(callId);
            if (localStreamRef.current) {
              localStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
              localStreamRef.current = null;
            }
            if (screenStreamRef.current) {
              screenStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
              screenStreamRef.current = null;
            }
            if (pcRef.current) {
              try { pcRef.current.close(); } catch {}
              pcRef.current = null;
            }
            if (Platform.OS === 'web') {
              try { document.getElementById('remoteCallAudio')?.remove(); } catch {}
              try { document.getElementById('remoteCallVideo')?.remove(); } catch {}
            }
            setTimeout(() => { try { router.canGoBack() ? router.back() : router.replace('/chat'); } catch { try { router.replace('/chat'); } catch {} } }, 1500);
          }
        });
        // Voicemail surface: when the recipient never picks up (server fires
        // `call_missed` after 30s of RINGING) or explicitly declines
        // (`call_declined` with can_leave_voicemail=true), redirect the
        // caller to the voicemail recorder. We only act on the caller side
        // — the callee already saw the missed-call bubble in their chat.
        const goToVoicemail = (reason, recipient, payload) => {
          if (!isCaller) return;
          if (callAcceptedRef.current) return; // call already connected; ignore late events
          if (endedRef.current) return;
          endedRef.current = true;
          // Stop any caller-side ringing tone first.
          try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}
          if (callerTimeoutRef.current) clearTimeout(callerTimeoutRef.current);
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
          if (statsIntervalRef.current) { clearInterval(statsIntervalRef.current); statsIntervalRef.current = null; }
          if (iceTimeoutRef.current) { clearTimeout(iceTimeoutRef.current); iceTimeoutRef.current = null; }
          if (turnRefreshRef.current) { clearInterval(turnRefreshRef.current); turnRefreshRef.current = null; }
          // Tear down media + PC quickly — no sense holding the mic open.
          try { localStreamRef.current?.getTracks?.().forEach(t => { try { t.stop(); } catch {} }); } catch {}
          localStreamRef.current = null;
          try { pcRef.current?.close?.(); } catch {}
          pcRef.current = null;
          try { setCallActive(false); } catch {}
          try { callKeep.endCall(callId); } catch {}
          // Log the missed/declined call to local history so it shows in
          // the Calls tab even before the chat sync round-trips.
          try {
            addCallToHistory({
              contactEmail: recipient || contactEmail,
              contactName: callerName,
              callId,
              type: 'outgoing',
              video: isVideoParam === '1' || isVideoParam === 'true',
              timestamp: Date.now(),
              duration: 0,
              status: reason === 'declined' ? 'declined' : 'missed',
            }).catch(() => {});
          } catch {}
          // Hand off to the voicemail recorder. We use replace so back-out
          // of the recorder lands on /chat, not the dead call screen.
          const qp = new URLSearchParams({
            recipient: recipient || contactEmail || '',
            name: callerName || '',
            conversationId: String(payload?.conversation_id || conversationId || ''),
            reason: reason || 'missed',
          });
          try { router.replace('/voicemail-recorder?' + qp.toString()); } catch {
            try { router.replace('/chat'); } catch {}
          }
        };
        const unsubMissed = mailWs.on('call_missed', (data) => {
          if (!data || data.call_id !== callId) return;
          if (data.can_leave_voicemail === false) return;
          goToVoicemail('missed', data.recipient_email || contactEmail, data);
        });
        const unsubDeclined = mailWs.on('call_declined', (data) => {
          if (!data || data.call_id !== callId) return;
          // call_declined fires for the caller when the callee taps
          // Decline. Only offer voicemail if the server signals it.
          if (!data.can_leave_voicemail) return;
          goToVoicemail('declined', data.recipient_email || data.email || contactEmail, data);
        });

        wsUnsubsRef.current = [unsubTurn, unsubAnswer, unsubIce, unsubOffer, unsubAccepted, unsubEnd, unsubMissed, unsubDeclined];

        // Set audio mode BEFORE getUserMedia so music pauses immediately when calling.
        // Prefer the native AVAudioSession module — it sets the right category
        // (.playAndRecord), mode (.voiceChat / .videoChat), and Bluetooth options
        // and properly notifies other apps. expo-audio is a fallback.
        if (Platform.OS === 'ios' && _NativeAudioSession?.activateForCall) {
          try {
            const isVideo = isVideoParam === '1' || isVideoParam === 'true';
            if (isVideo) {
              _NativeAudioSession.activateForVideoCall().catch(() => {});
            } else {
              _NativeAudioSession.activateForCall(false).catch(() => {});
            }
          } catch (e) {
            console.log('[Call] native audio session error:', e?.message);
          }
        } else if (Platform.OS === 'android') {
          // Android: força MODE_IN_COMMUNICATION via InCallManager ANTES do getUserMedia,
          // pra WebRTC abrir AudioRecord no perfil voice-call (não music) e ativar
          // AEC/AGC nativos. expo-audio AudioModule.setAudioMode REVERTE pra MODE_NORMAL
          // silenciosamente — não usar aqui. Kotlin prewarm (IncomingCallActivity#841)
          // só cobre answer-via-push, não outgoing.
          try {
            const InCallManager = require('react-native-incall-manager').default;
            const isVideo = isVideoParam === '1' || isVideoParam === 'true';
            InCallManager.start({ media: isVideo ? 'video' : 'audio', auto: true });
            InCallManager.setForceSpeakerphoneOn(isVideo);
            console.log('[Call] InCallManager.start mode=' + (isVideo ? 'video' : 'audio'));
          } catch (e) {
            console.log('[Call] InCallManager.start error:', e?.message);
            // Last-resort fallback — expo-audio doesn't set IN_COMMUNICATION but at least
            // pauses music so user knows call is on.
            try {
              const { AudioModule } = require('expo-audio');
              AudioModule.setAudioMode({ interruptionMode: 'doNotMix', playsInSilentMode: true, shouldPlayInBackground: true });
            } catch (e2) { console.log('[Call] fallback AudioModule error:', e2?.message); }
          }
        }

        const mediaPromise = getUserMediaFn({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            // HD audio: stereo 48kHz. Opus handles the encoding — we just
            // need the mic to capture wide-band. Reduces "tinny" sound that
            // 16kHz narrowband causes on phone ear speakers.
            channelCount: { ideal: 2 },
            sampleRate: { ideal: 48000 },
            sampleSize: { ideal: 16 },
          },
          video: video ? {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
            facingMode: 'user',
          } : false,
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Permissão de câmera/microfone expirou')), 30000)
        );
        let stream;
        try {
          stream = await Promise.race([mediaPromise, timeoutPromise]);
        } catch (mediaErr) {
          console.error('[Call] getUserMedia primary failed:', mediaErr?.message);
          // Fallback: se video falhou (câmera ocupada, perm recusada), tenta audio-only
          // pra não cair em "tela preta sem nada". Usuário pode ligar a câmera depois.
          if (video) {
            try {
              console.log('[Call] retry getUserMedia audio-only fallback');
              stream = await getUserMediaFn({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } },
                video: false,
              });
              setVideoEnabled(false);
              videoEnabledRef.current = false;
              try { setErrorMsg(t('call.videoUnavailable') || 'Câmera indisponível — usando só áudio'); } catch {}
            } catch (audioErr) {
              console.error('[Call] getUserMedia audio-only also failed:', audioErr?.message);
              throw mediaErr;
            }
          } else {
            throw mediaErr;
          }
        }
        console.log('[Call] getUserMedia OK: audio=' + stream.getAudioTracks().length + ' video=' + stream.getVideoTracks().length);

        if (!mounted) {
          stream.getTracks().forEach(tr => tr.stop());
          return;
        }

        localStreamRef.current = stream;

        if (Platform.OS !== 'web') {
          try {
            const { setAudioModeAsync } = require('expo-audio');
            await setAudioModeAsync({
              interruptionMode: 'doNotMix',
              playsInSilentMode: true,
              shouldPlayInBackground: true,
              allowsRecording: true,
            });
          } catch (audioErr) {
            console.log('[Call] expo-audio setAudioModeAsync error:', audioErr);
          }
          try {
            const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
            // Initialize RTC audio session with proper configuration
            RTCAudioSession.audioSessionDidActivate();
            // Explicitly set active to enable speaker/receiver routing
            if (RTCAudioSession.audioSessionSetActive) {
              RTCAudioSession.audioSessionSetActive(true);
            }
            console.log('[Call] RTCAudioSession activated');
          } catch (e) {
            console.warn('[Call] RTCAudioSession error:', e?.message);
          }
          // Force earpiece for audio calls, speaker for video calls (WhatsApp behavior).
          // 2026-05-12: setForceSpeakerphoneOn(false) was leaving Android in a
          // limbo state where neither earpiece nor speaker routed the WebRTC
          // RX audio (video calls worked because speaker=true bypasses it).
          // chooseAudioRoute is explicit + WhatsApp-grade.
          try {
            const InCallManager = require('react-native-incall-manager').default;
            const shouldSpeaker = isVideoParam === '1' || isVideoParam === 'true';
            if (shouldSpeaker) {
              InCallManager.setForceSpeakerphoneOn(true);
              if (typeof InCallManager.chooseAudioRoute === 'function') {
                try { InCallManager.chooseAudioRoute('SPEAKER_PHONE'); } catch {}
              }
            } else {
              // Audio call → earpiece. Be explicit: force speakerphone OFF
              // AND request EARPIECE route. Some Android devices need both.
              InCallManager.setForceSpeakerphoneOn(false);
              if (typeof InCallManager.chooseAudioRoute === 'function') {
                try { InCallManager.chooseAudioRoute('EARPIECE'); } catch (e) {
                  console.warn('[Call] chooseAudioRoute EARPIECE failed:', e?.message);
                }
              }
            }
            console.log('[Call] Initial audio route:', shouldSpeaker ? 'SPEAKER' : 'EARPIECE');
          } catch (e) {
            console.warn('[Call] InCallManager initial route error:', e?.message);
          }

          // Android: re-affirm MODE_IN_COMMUNICATION + audio focus AFTER
          // getUserMedia + expo-audio + InCallManager have run. Reported
          // 2026-05-12: call connects (ICE + tracks ok) but no audio at all
          // — root cause was expo-audio.setAudioMode resetting Android's
          // AudioManager.mode back to MODE_NORMAL, which silences WebRTC
          // audio engine (the engine routes to USAGE_VOICE_COMMUNICATION
          // streams ONLY when mode == MODE_IN_COMMUNICATION). Re-call our
          // native ExpoAudioSession.activateForCall to FORCE the right
          // mode + request audio focus again.
          if (Platform.OS === 'android') {
            try {
              const ExpoAudioSession = require('../modules/expo-audio-session').default;
              const useSpeaker = isVideoParam === '1' || isVideoParam === 'true';
              if (useSpeaker) ExpoAudioSession.activateForVideoCall?.();
              else ExpoAudioSession.activateForCall?.(false);
              console.log('[Call] Android: re-activated audio session post-getUserMedia');
            } catch (e) {
              console.warn('[Call] Android post-gUM audio session error:', e?.message);
            }
          }
          // Also use expo-audio-session module for iOS. We call the full
          // activateForCall / activateForVideoCall so the category is set
          // correctly (not just the speaker route override), and enable
          // the proximity sensor so the screen blanks when the phone is
          // at the user's ear (WhatsApp / native Phone app behavior).
          try {
            const ExpoAudioSession = require('../modules/expo-audio-session').default;
            const isVideoCall = isVideoParam === '1' || isVideoParam === 'true';
            if (isVideoCall) {
              ExpoAudioSession.activateForVideoCall?.();
            } else {
              ExpoAudioSession.activateForCall?.(false); // earpiece default
            }
            // Enable proximity ONLY for audio calls (video stays on).
            if (!isVideoCall) {
              ExpoAudioSession.enableProximitySensor?.(true);
            }
          } catch {}
        }

        if (Platform.OS !== 'web' && stream?.toURL) {
          setLocalStreamUrl(stream.toURL());
        }
        // Web: create local video PiP element
        if (Platform.OS === 'web' && video) {
          let localVid = document.getElementById('localCallVideo');
          if (!localVid) {
            localVid = document.createElement('video');
            localVid.id = 'localCallVideo';
            localVid.autoplay = true;
            localVid.playsInline = true;
            localVid.muted = true;
            localVid.dataset.expanded = '0';
            localVid.style.cssText = 'position:fixed;bottom:180px;right:16px;width:110px;height:160px;object-fit:cover;z-index:30;border-radius:16px;border:2px solid rgba(255,255,255,0.25);cursor:grab;transition:width 200ms ease, height 200ms ease;';
            document.body.appendChild(localVid);
            // Make draggable
            let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
            localVid.addEventListener('mousedown', (e) => {
              dragging = true; startX = e.clientX; startY = e.clientY;
              const rect = localVid.getBoundingClientRect();
              origX = rect.left; origY = rect.top;
              localVid.style.cursor = 'grabbing';
              e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
              if (!dragging) return;
              localVid.style.left = (origX + e.clientX - startX) + 'px';
              localVid.style.top = (origY + e.clientY - startY) + 'px';
              localVid.style.right = 'auto';
              localVid.style.bottom = 'auto';
            });
            document.addEventListener('mouseup', () => { dragging = false; if (localVid) localVid.style.cursor = 'grab'; });
            // Double-click to toggle a 2x maximized PiP — gives a quick "look
            // at me" preview without leaving the call. The transition CSS
            // above smooths the size change.
            localVid.addEventListener('dblclick', () => {
              const isExpanded = localVid.dataset.expanded === '1';
              if (isExpanded) {
                localVid.style.width = '110px'; localVid.style.height = '160px';
                localVid.dataset.expanded = '0';
              } else {
                localVid.style.width = '220px'; localVid.style.height = '320px';
                localVid.dataset.expanded = '1';
              }
            });
            // First-mount affordance toast — auto-fade after ~2s. We don't
            // route this through Toast/Alert because we want zero React state
            // churn on the call screen; the DOM node lives & dies on its own.
            try {
              const toast = document.createElement('div');
              toast.id = 'localCallVideoToast';
              toast.textContent = 'Toque duplo para ampliar';
              toast.style.cssText = 'position:fixed;bottom:140px;right:16px;padding:6px 12px;background:rgba(0,0,0,0.72);color:#fff;font-size:12px;border-radius:14px;z-index:31;pointer-events:none;opacity:0;transition:opacity 220ms ease;';
              document.body.appendChild(toast);
              requestAnimationFrame(() => { toast.style.opacity = '1'; });
              setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => { try { toast.remove(); } catch {} }, 260);
              }, 2000);
            } catch {}
          }
          localVid.srcObject = stream;
        }

        // Get TURN credentials with retry (up to 3 attempts)
        if (isCaller) {
          let turnSuccess = false;
          for (let attempt = 0; attempt < 3 && !turnSuccess; attempt++) {
            try {
              const turnPromise = new Promise((resolve) => {
                const unsub = mailWs.on('turn_credentials', (data) => {
                  unsub();
                  resolve(data?.credentials || data);
                });
                mailWs._send({ type: 'get_turn_credentials' });
                setTimeout(() => { unsub(); resolve(null); }, 5000);
              });
              const creds = await turnPromise;
              if (creds?.urls) {
                turnCredsRef.current = creds;
                turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
                turnSuccess = true;
              } else if (attempt < 2) {
                console.log('[Call] TURN credential fetch empty, retry', attempt + 1);
                await new Promise(r => setTimeout(r, 1000));
              }
            } catch (e) {
              console.log('[Call] TURN credential fetch error, retry', attempt + 1, e?.message);
              if (attempt < 2) {
                await new Promise(r => setTimeout(r, 1000));
              }
            }
          }
          if (!turnSuccess) {
            console.log('[Call] TURN credentials unavailable after 3 attempts, proceeding with STUN-only (P2P)');
          }
        } else {
          const pendingTurn = getPendingTurnCredentials();
          if (pendingTurn?.urls) {
            turnCredsRef.current = pendingTurn;
            turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
          }
        }

        const pc = new RTC_PeerConnection(getIceConfig());
        pcRef.current = pc;

        // Periodic TURN credential refresh. Cred lifetime is ~24h on our
        // Coturn cluster; refresh every 20h to stay ahead of expiry on long
        // calls (rare but real for kid-mode parental-supervised sessions).
        // Without this, a call that survives past 23h breaks silently when
        // the relay starts rejecting allocations mid-stream.
        if (turnRefreshRef.current) { clearInterval(turnRefreshRef.current); turnRefreshRef.current = null; }
        turnRefreshRef.current = setInterval(async () => {
          if (endedRef.current) return;
          // Only refresh when we're getting close to expiry (<2h) to avoid
          // burning requests on short calls.
          const remaining = turnExpiresAtRef.current - Date.now();
          if (remaining > 2 * 60 * 60 * 1000) return;
          try {
            const mailWs = require('../services/websocket').default;
            if (!mailWs.isConnected) return;
            const creds = await new Promise((resolve) => {
              const u = mailWs.on('turn_credentials', (d) => { u(); resolve(d?.credentials || d); });
              mailWs._send({ type: 'get_turn_credentials' });
              setTimeout(() => { u(); resolve(null); }, 4000);
            });
            if (creds?.urls) {
              turnCredsRef.current = creds;
              turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
              try { pcRef.current?.setConfiguration?.(getIceConfig()); } catch {}
              console.log('[Call] TURN credentials refreshed proactively');
            }
          } catch {}
        }, 60 * 60 * 1000); // check every hour

        // ICE connection timeout — 45 seconds to establish connection
        // (30s was too short for mobile networks with TURN relay negotiation)
        if (iceTimeoutRef.current) clearTimeout(iceTimeoutRef.current);
        iceTimeoutRef.current = setTimeout(() => {
          if (mounted && !endedRef.current &&
              pc.iceConnectionState !== 'connected' &&
              pc.iceConnectionState !== 'completed') {
            console.log('[Call] ICE timeout after 45s, state:', pc.iceConnectionState);
            // Instead of immediately failing, try one ICE restart with relay-only
            if (iceRestartCountRef.current === 0 && turnCredsRef.current) {
              console.log('[Call] ICE timeout — attempting relay-only restart');
              iceRestartCountRef.current++;
              setReconnecting(true);
              pc.createOffer({ iceRestart: true }).then(async offer => {
                await pc.setLocalDescription(offer);
                sendSignaling('call_offer', {
                  call_id: callId,
                  target_email: contactEmail,
                  sdp: offer.sdp,
                  sdp_type: offer.type,
                  ice_restart: true,
                });
              }).catch(() => {
                setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
                setConnectionFailed(true);
                setReconnecting(false);
              });
              // Give the restart another 20s
              iceTimeoutRef.current = setTimeout(() => {
                if (mounted && !endedRef.current &&
                    pc.iceConnectionState !== 'connected' &&
                    pc.iceConnectionState !== 'completed') {
                  setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
                  setConnectionFailed(true);
                  setReconnecting(false);
                }
              }, 20000);
            } else {
              setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
              setConnectionFailed(true);
              setReconnecting(false);
            }
          }
        }, 45000);

        // CRITICAL (2026-05-12): use addTransceiver in FIXED ORDER (audio, then
        // video) so m-line positions are locked at PC creation. WebRTC rejects
        // a subsequent offer whose m-lines drift from a previous offer/answer
        // (saw "order of m-lines in subsequent offer doesn't match" on caller
        // setLocalDescription, blocking every Chatyy↔Chatyy call). Tracks then
        // bind via replaceTrack, which doesn't disturb m-line ordering.
        try {
          const audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
          const videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
          const audioTrack = stream.getAudioTracks()[0];
          const videoTrack = stream.getVideoTracks()[0];
          if (audioTrack && audioTx?.sender) {
            try { await audioTx.sender.replaceTrack(audioTrack); } catch {}
          }
          if (videoTrack && videoTx?.sender) {
            try { await videoTx.sender.replaceTrack(videoTrack); } catch {}
          } else if (videoTx) {
            try { videoTx.direction = 'inactive'; } catch {}
          }
        } catch (e) {
          console.warn('[Call] addTransceiver path failed, falling back to addTrack:', e?.message);
          stream.getTracks().forEach(track => { try { pc.addTrack(track, stream); } catch {} });
        }
        // Reorder codec preference (VP9 > H.264 > VP8) antes do offer
        applyCodecPreferences(pc);

        // Seed HD bitrate on the video sender before the adaptive stats
        // loop kicks in (~3s delay). Without this, the encoder starts at
        // its default ~300kbps and the first few seconds of video look
        // pixelated. 1.5Mbps is a safe HD floor; the adaptive loop will
        // bump it to 2.5Mbps when quality reads 5 or trim it down on
        // weaker networks.
        try {
          for (const sender of pc.getSenders()) {
            if (sender.track?.kind !== 'video') continue;
            try {
              const params = sender.getParameters();
              if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
              params.encodings[0].maxBitrate = 1500000;
              params.encodings[0].maxFramerate = 30;
              params.encodings[0].networkPriority = 'high';
              params.encodings[0].priority = 'high';
              sender.setParameters(params).catch(() => {});
            } catch {}
          }
        } catch {}

        // ── NAT keepalive via DataChannel ──
        // Some mobile carriers have aggressive NAT timeouts (15-30s).
        // A DataChannel ping every 10s keeps the UDP binding alive.
        try {
          const keepaliveDC = pc.createDataChannel('keepalive', { ordered: false, maxRetransmits: 0 });
          const keepaliveInterval = setInterval(() => {
            try {
              if (keepaliveDC.readyState === 'open') keepaliveDC.send('ping');
            } catch {}
          }, 10000);
          keepaliveDC.onclose = () => clearInterval(keepaliveInterval);
          // Clean up on call end
          const origClose = pc.close.bind(pc);
          pc.close = () => { clearInterval(keepaliveInterval); origClose(); };
        } catch (e) {
          console.log('[Call] DataChannel keepalive setup failed:', e?.message);
        }

        pc.ontrack = (event) => {
          const stream = event.streams?.[0];
          if (stream) {
            attachRemoteStream(stream);
          } else if (event.track) {
            // Track arrived without a stream (renegotiation / addTrack without stream)
            // Create a new MediaStream and attach the track
            if (Platform.OS === 'web') {
              const ms = new MediaStream();
              ms.addTrack(event.track);
              attachRemoteStream(ms);
            }
          }
          if (mounted) {
            setPeerConnected(true);
            callKeep.reportConnected(callId);
            if (Platform.OS !== 'web') {
              try {
                const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
                RTCAudioSession.audioSessionDidActivate();
              } catch {}
              // Android: another re-affirm — once remote track arrives, force
              // the audio mode back to MODE_IN_COMMUNICATION in case anything
              // (expo-av, sound effects, ringtone teardown) reset it. This is
              // the LAST safety net before audio is expected to flow.
              if (Platform.OS === 'android') {
                try {
                  const ExpoAudioSession = require('../modules/expo-audio-session').default;
                  const useSpeaker = isVideoParam === '1' || isVideoParam === 'true';
                  if (useSpeaker) ExpoAudioSession.activateForVideoCall?.();
                  else ExpoAudioSession.activateForCall?.(false);
                } catch {}
              }
            }
          }
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            sendSignaling('call_ice', {
              call_id: callId,
              target_email: contactEmail,
              candidate: event.candidate.toJSON(),
            });
          }
        };

        pc.oniceconnectionstatechange = () => {
          const state = pc.iceConnectionState;
          console.log('[Call] ICE state:', state);
          if (disconnectTimeoutRef.current) { clearTimeout(disconnectTimeoutRef.current); disconnectTimeoutRef.current = null; }
          if (state === 'connected' || state === 'completed') {
            // Clear ICE timeout on successful connection
            if (iceTimeoutRef.current) { clearTimeout(iceTimeoutRef.current); iceTimeoutRef.current = null; }
            if (mounted) {
              setPeerConnected(true);
              setReconnecting(false);
              iceRestartCountRef.current = 0;
              // wave w3: reset consecutive fail counter on success so the
              // next isolated 'failed' doesn't immediately trigger TURN refresh.
              iceConsecutiveFailRef.current = 0;
            }
          } else if (state === 'disconnected') {
            // Brief disconnections are normal (WiFi<->cell, tunnel, etc.) - wait before acting
            // wave w3: raised window 3s → 5s. Short transients (tunnel, AP roam,
            // Wi-Fi DTIM doze) routinely take 2-4s to clear; restarting at 3s
            // sometimes caused a redundant offer right when the original path
            // was about to re-converge. 5s matches the spec for "real" drop.
            if (mounted) setReconnecting(true);
            console.log('[call_quality_w3] ice disconnected, waiting 5s before auto-restart');
            disconnectTimeoutRef.current = setTimeout(async () => {
              if (mounted && !endedRef.current && pcRef.current?.iceConnectionState === 'disconnected') {
                console.log('[call_quality_w3] still disconnected after 5s, restarting ICE');
                // Refresh TURN credentials if they might be stale
                if (!turnExpiresAtRef.current || (turnExpiresAtRef.current - Date.now()) < 2 * 60 * 60 * 1000) {
                  try {
                    const mailWs = require('../services/websocket').default;
                    if (mailWs.isConnected) {
                      const creds = await new Promise((resolve) => {
                        const u = mailWs.on('turn_credentials', (d) => { u(); resolve(d?.credentials || d); });
                        mailWs._send({ type: 'get_turn_credentials' });
                        setTimeout(() => { u(); resolve(null); }, 3000);
                      });
                      if (creds?.urls) {
                        turnCredsRef.current = creds;
                        turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
                        if (pcRef.current?.setConfiguration) {
                          try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
                        }
                      }
                    }
                  } catch {}
                }

                // Try ICE restart first (up to 3 times) before showing retry button
                if (iceRestartCountRef.current < 3) {
                  console.log('[Call] ICE restart attempt', iceRestartCountRef.current + 1);
                  iceRestartCountRef.current++;
                  try {
                    if (pcRef.current.signalingState === 'stable') {
                      pcRef.current.createOffer({ iceRestart: true }).then(async offer => {
                        await pcRef.current.setLocalDescription(offer);
                        sendSignaling('call_offer', {
                          call_id: callId,
                          target_email: contactEmail,
                          sdp: offer.sdp,
                          sdp_type: offer.type,
                          ice_restart: true,
                        });
                      }).catch(() => {});
                    } else {
                      console.log('[Call] Skipping ICE restart, signalingState:', pcRef.current.signalingState);
                    }
                  } catch {}
                } else {
                  console.log('[Call] ICE restart failed after 3 attempts, showing reconnect button');
                  setConnectionFailed(true);
                  setReconnecting(false);
                  setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
                }
              }
            }, 5000);
          } else if (state === 'failed') {
            // Try ICE restart on failure (up to 3 times)
            if (mounted && !endedRef.current && iceRestartCountRef.current < 3) {
              console.log('[Call] ICE failed, attempting restart', iceRestartCountRef.current + 1);
              setReconnecting(true);
              iceRestartCountRef.current++;
              // wave w3: consecutive ICE failures usually mean the TURN
              // credentials we got at setup are stale or the relay we picked
              // is unhealthy. On the 2nd+ consecutive fail, fetch fresh
              // creds from backend BEFORE the restart so the new offer
              // re-picks a working relay path.
              iceConsecutiveFailRef.current++;
              const doRestart = async () => {
                if (iceConsecutiveFailRef.current >= 2) {
                  console.log('[call_quality_w3] consecutive ICE fail (' + iceConsecutiveFailRef.current + '), refreshing TURN creds before restart');
                  try {
                    const mailWs = require('../services/websocket').default;
                    if (mailWs.isConnected) {
                      const creds = await new Promise((resolve) => {
                        const u = mailWs.on('turn_credentials', (d) => { u(); resolve(d?.credentials || d); });
                        mailWs._send({ type: 'get_turn_credentials' });
                        setTimeout(() => { u(); resolve(null); }, 3000);
                      });
                      if (creds?.urls) {
                        turnCredsRef.current = creds;
                        turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
                        if (pcRef.current?.setConfiguration) {
                          try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
                        }
                        console.log('[call_quality_w3] TURN creds refreshed after consecutive fail');
                      }
                    }
                  } catch (e) { console.log('[call_quality_w3] TURN refresh error', e?.message); }
                }
                try {
                  if (!pcRef.current || pcRef.current.signalingState !== 'stable') {
                    console.log('[Call] Skipping ICE restart on failure, signalingState:', pcRef.current?.signalingState);
                    return;
                  }
                  const offer = await pcRef.current.createOffer({ iceRestart: true });
                  await pcRef.current.setLocalDescription(offer);
                  sendSignaling('call_offer', {
                    call_id: callId,
                    target_email: contactEmail,
                    sdp: offer.sdp,
                    sdp_type: offer.type,
                    ice_restart: true,
                  });
                } catch {
                  if (mounted && !endedRef.current) {
                    setConnectionFailed(true);
                    setReconnecting(false);
                    setErrorMsg(t('call.connectionFailed') || 'Não foi possível conectar. Tente novamente.');
                  }
                }
              };
              doRestart();
            } else if (mounted && !endedRef.current) {
              // All ICE restarts exhausted — show reconnect button
              setConnectionFailed(true);
              setReconnecting(false);
              setErrorMsg(t('call.connectionFailed') || 'Não foi possível conectar. Tente novamente.');
            }
          } else if (state === 'closed') {
            if (mounted && !endedRef.current) {
              handleEndCall();
            }
          }
        };

        if (pc.onconnectionstatechange !== undefined) {
          pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            console.log('[Call] Connection state:', state);
            if (state === 'connected') {
              if (mounted) {
                setPeerConnected(true);
                setReconnecting(false);
                setConnectionFailed(false);
              }
              // ROOT-CAUSE GUARD (2026-05-12): user reported "conecta mas não
              // envia áudio nem vídeo" — peers see ICE 'connected' but no
              // RTP flowing. Verify all local senders have a non-null,
              // enabled track; force-enable + verify transceiver direction
              // is sendrecv. If any sender is missing its track (race during
              // setupCall), re-attach from localStreamRef.
              try {
                const localStream = localStreamRef.current;
                if (localStream && pcRef.current) {
                  const senders = pcRef.current.getSenders ? pcRef.current.getSenders() : [];
                  const localTracks = localStream.getTracks();
                  // Re-enable any track muted in transit (track.enabled = false)
                  for (const t of localTracks) {
                    if (t.kind === 'audio' && !audioMuted) t.enabled = true;
                    if (t.kind === 'video' && videoEnabledRef.current) t.enabled = true;
                  }
                  // Re-bind any track that lost its sender via replaceTrack
                  // on the matching transceiver. Avoid addTrack here — it
                  // would append a NEW m-line and break already-negotiated
                  // SDP ordering (see 2026-05-12 m-line mismatch fix).
                  const transceivers = pcRef.current.getTransceivers ? pcRef.current.getTransceivers() : [];
                  for (const t of localTracks) {
                    const bound = senders.find(s => s.track === t);
                    if (!bound) {
                      const tx = transceivers.find(tr => tr.sender && (tr.sender.track?.kind === t.kind || (!tr.sender.track && (tr.receiver?.track?.kind === t.kind || tr.mid === (t.kind === 'audio' ? '0' : '1')))));
                      if (tx && tx.sender) {
                        try { tx.sender.replaceTrack(t).catch(() => {}); } catch {}
                      }
                    }
                  }
                  // Force transceivers to sendrecv (defaults can degrade to
                  // sendonly/recvonly mid-negotiation on RN WebRTC)
                  try {
                    const transceivers = pcRef.current.getTransceivers ? pcRef.current.getTransceivers() : [];
                    for (const tr of transceivers) {
                      if (tr.direction !== 'sendrecv' && tr.direction !== 'stopped') {
                        try { tr.direction = 'sendrecv'; } catch {}
                      }
                    }
                  } catch {}
                  console.log('[Call] post-connect track audit: senders=' + senders.length + ' localTracks=' + localTracks.length);
                }
              } catch (auditErr) {
                console.warn('[Call] post-connect audit err:', auditErr?.message);
              }
              // WhatsApp-grade: when ICE finally lands, re-affirm Android audio
              // routing one more time. Reports of "voz só vem alguns segundos
              // depois" trace back to AudioManager.setMode flipping AFTER the
              // first RTP packets arrive — re-asserting category here forces
              // the playback path to bind to the call stream immediately. iOS
              // is unaffected (CallKit owns the session) so we skip it.
              if (Platform.OS === 'android') {
                try {
                  const InCallManager = require('react-native-incall-manager').default;
                  if (typeof InCallManager.setForceSpeakerphoneOn === 'function') {
                    const wantSpeaker = !!videoEnabledRef.current;
                    InCallManager.setForceSpeakerphoneOn(wantSpeaker);
                  }
                  if (typeof InCallManager.chooseAudioRoute === 'function') {
                    InCallManager.chooseAudioRoute(videoEnabledRef.current ? 'SPEAKER_PHONE' : 'EARPIECE');
                  }
                } catch {}
                try {
                  const ExpoAudioSession = require('../modules/expo-audio-session').default;
                  if (videoEnabledRef.current) ExpoAudioSession.activateForVideoCall?.();
                  else ExpoAudioSession.activateForCall?.(false);
                } catch {}
              }
            } else if (state === 'disconnected') {
              // Brief disconnections happen during network switches - don't end call yet
              if (mounted) setReconnecting(true);
            } else if (state === 'failed') {
              // Try ICE restart before giving up
              if (mounted && !endedRef.current && iceRestartCountRef.current < 3) {
                console.log('[Call] connectionState failed, attempting ICE restart');
                setReconnecting(true);
                iceRestartCountRef.current++;
                if (pcRef.current?.signalingState === 'stable') {
                  pcRef.current.createOffer({ iceRestart: true }).then(async offer => {
                    await pcRef.current.setLocalDescription(offer);
                    sendSignaling('call_offer', {
                      call_id: callId,
                      target_email: contactEmail,
                      sdp: offer.sdp,
                      sdp_type: offer.type,
                      ice_restart: true,
                    });
                  }).catch(() => {
                    if (mounted && !endedRef.current) {
                      setConnectionFailed(true);
                      setReconnecting(false);
                      setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
                    }
                  });
                }
              } else if (mounted && !endedRef.current) {
                setConnectionFailed(true);
                setReconnecting(false);
                setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
              }
            }
          };
        }

        if (isCaller) {
          // Dedup guard: se o setupCall rodou 2x (effect deps instáveis
          // como `t` do LanguageContext mudando identidade entre renders),
          // a gente detecta o call_invite já enviado pelo flag global e
          // curto-circuita. Antes isso causava invite duplicado + offer
          // disparado pra call_id já encerrado (visível no log do WS).
          if (!mounted || endedRef.current) {
            console.log('[Call] setupCall caller path aborted — mounted=' + mounted + ' ended=' + endedRef.current);
            return;
          }
          if (globalThis.__chatyyLastCallInviteId === callId) {
            console.log('[Call] call_invite already sent for ' + callId + ' — skipping duplicate');
          } else {
            globalThis.__chatyyLastCallInviteId = callId;
            callKeep.startCall(callId, callerName, contactEmail, video);
            sendSignaling('call_invite', {
              call_id: callId,
              target_email: contactEmail,
              conversation_id: conversationId,
              video,
            });
          }

          // Wait for callee to accept before creating offer (45s max)
          console.log('[Call] Waiting for callee to accept...');

          const acceptPromise = new Promise((resolve) => {
            const checkAccept = setInterval(() => {
              // Aborta o poll se o caller já desligou — assim createOffer
              // nunca dispara pra uma chamada morta.
              if (endedRef.current || !mounted) {
                clearInterval(checkAccept);
                resolve(false);
                return;
              }
              if (callAcceptedRef.current) {
                clearInterval(checkAccept);
                console.log('[Call] Callee accepted!');
                resolve(true);
              }
            }, 100);
            setTimeout(() => {
              clearInterval(checkAccept);
              console.log('[Call] Accept timeout - proceeding with offer anyway (fallback)');
              resolve(false);
            }, 45000);
          });

          await acceptPromise;

          // GUARD: se já desligou (user pressionou end, timeout, ICE falhou)
          // durante o wait, não manda offer. Era o principal culpado do
          // spam de SDP pro call_id morto visto no log.
          if (endedRef.current || !mounted || !pcRef.current) {
            console.log('[Call] caller setup aborted after accept wait — ended=' + endedRef.current);
            return;
          }

          // PRE-OFFER TRACK AUDIT — uses replaceTrack on the fixed-order
          // transceivers from PC creation so m-line ordering NEVER changes
          // (fix for "subsequent offer doesn't match" error, 2026-05-12).
          // Original concern (Android→iOS muted): a track missing on the PC
          // when createOffer ran — solved here by checking each transceiver
          // for a bound track and replaceTrack-ing from localStream if not.
          try {
            const localStream = localStreamRef.current;
            if (localStream && pc.getTransceivers) {
              const transceivers = pc.getTransceivers();
              const audioTx = transceivers.find(t => (t.sender?.track?.kind === 'audio') || (t.receiver?.track?.kind === 'audio') || t.mid === '0');
              const videoTx = transceivers.find(t => (t.sender?.track?.kind === 'video') || (t.receiver?.track?.kind === 'video') || t.mid === '1');
              const audioTrack = localStream.getAudioTracks()[0];
              const videoTrack = localStream.getVideoTracks()[0];
              console.log('[Call] pre-offer audit: tx=' + transceivers.length + ' audioTx=' + !!audioTx + ' videoTx=' + !!videoTx + ' audioTrack=' + !!audioTrack + ' videoTrack=' + !!videoTrack);
              if (audioTx && audioTx.sender && audioTrack && audioTx.sender.track !== audioTrack) {
                try { await audioTx.sender.replaceTrack(audioTrack); console.log('[Call] pre-offer: replaceTrack audio'); } catch (e) { console.warn('[Call] pre-offer replaceTrack audio err:', e?.message); }
              }
              if (videoTx && videoTx.sender && videoTrack && videoTx.sender.track !== videoTrack) {
                try { await videoTx.sender.replaceTrack(videoTrack); console.log('[Call] pre-offer: replaceTrack video'); } catch (e) { console.warn('[Call] pre-offer replaceTrack video err:', e?.message); }
              }
              // Force track.enabled=true (the worst-of-both case is a
              // muted track in the SDP — peer's WebRTC engine then drops
              // RTP at the decoder because the m-line says active but
              // packets show silence/black frames).
              try {
                if (audioTrack && !audioMuted) audioTrack.enabled = true;
                if (videoTrack && video) videoTrack.enabled = true;
              } catch {}
            }
          } catch (auditErr) {
            console.warn('[Call] pre-offer audit failed:', auditErr?.message);
          }

          console.log('[Call] Creating offer...');
          let offer;
          try {
            offer = await pc.createOffer({
              offerToReceiveAudio: true,
              offerToReceiveVideo: video,
            });
            // WhatsApp-grade Opus tuning: 24kbps + FEC + DTX
            offer.sdp = applyOpusTuning(offer.sdp);
          } catch (offerErr) {
            console.error('createOffer failed:', offerErr);
            sendSignaling('call_debug', { call_id: callId, error: 'createOffer: ' + (offerErr?.message || String(offerErr)) });
            throw offerErr;
          }

          if (endedRef.current || !mounted) return;

          try {
            await pc.setLocalDescription(offer);
          } catch (sdErr) {
            console.error('setLocalDescription failed:', sdErr);
            sendSignaling('call_debug', { call_id: callId, error: 'setLocalDesc: ' + (sdErr?.message || String(sdErr)) });
            throw sdErr;
          }

          if (endedRef.current || !mounted) return;

          sendSignaling('call_offer', {
            call_id: callId,
            target_email: contactEmail,
            conversation_id: conversationId,
            sdp: offer.sdp,
            sdp_type: offer.type,
            video,
          });
          console.log('[Call] Offer sent after accept, sdp length:', offer.sdp?.length || 0);

          callerTimeoutRef.current = setTimeout(() => {
            if (mounted && !endedRef.current && !pcRef.current?.remoteDescription) {
              sendSignaling('call_debug', { call_id: callId, msg: 'caller timeout: no answer after 60s' });
              handleEndCall();
            }
          }, 60000);
        } else {
          const pendingOffer = getPendingOffer(callId);
          console.log('[Call] callee setup: has_pending=' + (!!pendingOffer) + ' has_sdp=' + (!!pendingOffer?.sdp));

          if (pendingOffer && pendingOffer.sdp) {
            try {
              await pc.setRemoteDescription(new RTC_SessionDescription({
                type: pendingOffer.type || 'offer',
                sdp: pendingOffer.sdp,
              }));

              const answer = await pc.createAnswer();
              // Apply Opus tuning to the answer SDP too — both peers must agree
              answer.sdp = applyOpusTuning(answer.sdp);
              await pc.setLocalDescription(answer);

              sendSignaling('call_answer', {
                call_id: callId,
                target_email: contactEmail,
                sdp: answer.sdp,
                sdp_type: answer.type,
              });
              console.log('[Call] callee answer sent, sdp_len:', answer.sdp?.length || 0);

              // Drain only candidates buffered for THIS call_id — without
              // the keying, candidates from a previous call could be applied
              // to the new PeerConnection and break ICE.
              const bufferedCandidates = getPendingIceCandidates(callId);
              if (bufferedCandidates.length > 0) {
                console.log('[Call] processing', bufferedCandidates.length, 'buffered ICE candidates');
                for (const candidate of bufferedCandidates) {
                  try { await pc.addIceCandidate(new RTC_IceCandidate(candidate)); } catch (e) { console.warn('[Call] addIceCandidate failed:', e?.message); }
                }
              }

              for (const candidate of iceCandidateQueueRef.current) {
                try { await pc.addIceCandidate(new RTC_IceCandidate(candidate)); } catch (e) { console.warn('[Call] addIceCandidate failed:', e?.message); }
              }
              iceCandidateQueueRef.current = [];
            } catch (calleeErr) {
              sendSignaling('call_debug', { call_id: callId, error: 'callee SDP error: ' + (calleeErr?.message || String(calleeErr)) });
              throw calleeErr;
            }
          } else {
            sendSignaling('call_debug', { call_id: callId, msg: 'callee: no pending SDP, requesting offer...' });
            try {
              mailWs._send({
                type: 'call_request_offer',
                call_id: callId,
              });
            } catch {}
          }
        }
      } catch (err) {
        console.error('Call setup error:', err);
        if (mounted) {
          setErrorMsg(err.message || t('call.connectionFailed') || 'Erro ao iniciar chamada');
          setConnectionFailed(true);
        }
      }
    };

    setupCall();

    return () => {
      mounted = false;
      if (callerTimeoutRef.current) clearTimeout(callerTimeoutRef.current);
      if (disconnectTimeoutRef.current) clearTimeout(disconnectTimeoutRef.current);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
      if (iceTimeoutRef.current) clearTimeout(iceTimeoutRef.current);
      if (turnRefreshRef.current) clearInterval(turnRefreshRef.current);
      if (videoUpgradeTimeoutRef.current) { clearTimeout(videoUpgradeTimeoutRef.current); videoUpgradeTimeoutRef.current = null; }
      if (videoUpgradeCountdownRef.current) { clearInterval(videoUpgradeCountdownRef.current); videoUpgradeCountdownRef.current = null; }
      if (quickReactionsTimerRef.current) { clearTimeout(quickReactionsTimerRef.current); quickReactionsTimerRef.current = null; }

      // If minimized, don't destroy WebRTC resources — they're saved globally
      if (minimizedRef.current) {
        console.log('[Call] Unmounting minimized — preserving WebRTC');
        return;
      }

      wsUnsubsRef.current.forEach(unsub => { try { unsub(); } catch {} });
      wsUnsubsRef.current = [];
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
        screenStreamRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
        localStreamRef.current = null;
      }
      if (pcRef.current) {
        try { pcRef.current.close(); } catch {}
        pcRef.current = null;
      }
      if (callId) callKeep.endCall(callId);
      if (Platform.OS !== 'web') {
        try {
          const { setAudioModeAsync } = require('expo-audio');
          setAudioModeAsync({ interruptionMode: 'mixWithOthers', playsInSilentMode: false, shouldPlayInBackground: false, allowsRecording: false });
        } catch {}
        try {
          const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
          RTCAudioSession.audioSessionDidDeactivate();
        } catch {}
      }
      if (Platform.OS === 'web') {
        try { document.getElementById('remoteCallAudio')?.remove(); } catch {}
        try { document.getElementById('remoteCallVideo')?.remove(); } catch {}
        try { document.getElementById('localCallVideo')?.remove(); } catch {}
      }
      // Failsafe: ensure the global call holder is cleared so a zombie
      // PeerConnection from a hard-back navigation can't leak into the next
      // call attempt and break it with stale ICE state.
      try { _clearGC(); } catch {}
    };
  }, []); // Run once on mount

  // Calling tone (caller only). Fade is gone — initial value is 1 to avoid
  // a regression where useNativeDriver:false on opacity stalled on a busy JS
  // thread, leaving the screen transparent over the previous white view.
  useEffect(() => {
    if (isCaller) {
      const { startCallingTone, stopRingtone } = require('../services/ringtone');
      startCallingTone();
      return () => stopRingtone();
    }
  }, []);

  // Avatar pulse while waiting
  useEffect(() => {
    if (peerConnected) return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [peerConnected]);

  // Call timer + quality stats when connected
  useEffect(() => {
    if (!peerConnected) return;
    const { stopRingtone } = require('../services/ringtone');
    stopRingtone();
    timerRef.current = setInterval(() => setCallDuration(d => { callDurationRef.current = d + 1; return d + 1; }), 1000);

    // Monitor connection quality via WebRTC stats. Poll every 2s on wifi
    // for snappy bitrate adapt, but slow to 5s on cellular so long calls
    // don't burn ~10% extra battery on 4G/LTE for stats we rarely act on.
    let prevBytesReceived = 0;
    let prevTimestamp = 0;
    // wave w3: "Conexão instável" pill (high loss sustained >10s) + audio stall detect.
    let highLossStartTs = 0;
    let lastPacketsLost = 0;
    let lastPacketsReceived = 0;
    let audioStallSamples = 0;
    const statsIntervalMs = (networkType && networkType !== 'wifi') ? 5000 : 2000;
    statsIntervalRef.current = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc || endedRef.current) return;
      try {
        const stats = await pc.getStats();
        let rtt = null;
        let packetsLost = 0;
        let packetsTotal = 0;
        let bytesReceived = 0;
        let currentTimestamp = 0;
        let videoFramesDecoded = 0;
        let videoFramesDropped = 0;
        let videoWidth = 0;
        let videoHeight = 0;
        let availableBandwidth = null;

        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            rtt = report.currentRoundTripTime;
            if (report.availableOutgoingBitrate) {
              availableBandwidth = report.availableOutgoingBitrate;
            }
          }
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            packetsLost = report.packetsLost || 0;
            packetsTotal = (report.packetsReceived || 0) + packetsLost;
            bytesReceived = report.bytesReceived || 0;
            currentTimestamp = report.timestamp || Date.now();
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            videoFramesDecoded = report.framesDecoded || 0;
            videoFramesDropped = report.framesDropped || 0;
            videoWidth = report.frameWidth || 0;
            videoHeight = report.frameHeight || 0;
          }
        });

        // Calculate quality score (1-5) based on RTT and packet loss
        const currentRttMs = rtt !== null ? Math.round(rtt * 1000) : null;
        const lossRate = packetsTotal > 0 ? packetsLost / packetsTotal : 0;
        let score = 5;
        let quality = 'good';

        if (rtt !== null) {
          if (rtt < 0.1 && lossRate < 0.01) { score = 5; quality = 'good'; }
          else if (rtt < 0.2 && lossRate < 0.03) { score = 4; quality = 'good'; }
          else if (rtt < 0.4 && lossRate < 0.05) { score = 3; quality = 'medium'; }
          else if (rtt < 0.8) { score = 2; quality = 'poor'; }
          else { score = 1; quality = 'poor'; }
        }

        // Check for no data flowing (connection stalled)
        if (prevBytesReceived > 0 && bytesReceived === prevBytesReceived && currentTimestamp - prevTimestamp > 5000) {
          quality = 'poor';
          score = 1;
        }

        // wave w3 — stats-based "Conexão instável" pill.
        // Cumulative packetsLost can stay high after early-call drops even when
        // current loss is 0%, so we compute the per-interval DELTA. Pill flips
        // on only after loss > 5% has been sustained for >= 10s (debounces
        // momentary RTP burst spikes that don't actually hurt the call).
        try {
          const lostDelta = Math.max(0, packetsLost - lastPacketsLost);
          const recvDelta = Math.max(0, (packetsTotal - packetsLost) - lastPacketsReceived);
          const intervalLossRate = (lostDelta + recvDelta) > 0
            ? lostDelta / (lostDelta + recvDelta)
            : 0;
          lastPacketsLost = packetsLost;
          lastPacketsReceived = packetsTotal - packetsLost;
          if (intervalLossRate > 0.05) {
            if (highLossStartTs === 0) highLossStartTs = Date.now();
            if (Date.now() - highLossStartTs >= 10000) {
              if (!showUnstable) {
                console.log('[call_quality_w3] sustained packet loss >5% for >10s, showing unstable pill (loss=' + (intervalLossRate * 100).toFixed(1) + '%)');
                setShowUnstable(true);
              }
            }
          } else {
            // Loss recovered — clear streak + hide pill.
            if (highLossStartTs !== 0) {
              highLossStartTs = 0;
              if (showUnstable) {
                console.log('[call_quality_w3] packet loss recovered, hiding unstable pill');
                setShowUnstable(false);
              }
            }
          }
        } catch {}

        // wave w3 — audio device monitoring. If peer's audio bytesReceived
        // doesn't tick for 3 consecutive samples (≈ 6-15s depending on
        // netType), it means RemoteAudioTrack stopped delivering data even
        // though ICE may still report 'connected'. Surface a UI alert so the
        // user knows it's the audio path, not their headset.
        try {
          if (prevBytesReceived > 0 && bytesReceived === prevBytesReceived) {
            audioStallSamples++;
            if (audioStallSamples >= 3 && !audioStalled) {
              console.log('[call_quality_w3] remote audio stalled (' + audioStallSamples + ' samples, ' + (audioStallSamples * statsIntervalMs) + 'ms with 0 bytes)');
              setAudioStalled(true);
            }
          } else if (bytesReceived > prevBytesReceived) {
            if (audioStallSamples > 0 && audioStalled) {
              console.log('[call_quality_w3] remote audio resumed after stall');
            }
            audioStallSamples = 0;
            if (audioStalled) setAudioStalled(false);
          }
        } catch {}

        prevBytesReceived = bytesReceived;
        prevTimestamp = currentTimestamp;

        setConnectionQuality(quality);
        setQualityScore(score);
        if (currentRttMs !== null) setRttMs(currentRttMs);

        // Show weak connection banner when quality drops to 2 or below
        setShowWeakBanner(score <= 2);

        // Suggest audio-only when quality is 1 (bad) and video is enabled
        setSuggestAudioOnly(score === 1 && videoEnabled);

        // Adaptive bitrate — adjust video sender encoding based on quality
        if (score !== lastQualityRef.current) {
          lastQualityRef.current = score;
          const senders = pc.getSenders();
          for (const sender of senders) {
            if (sender.track?.kind === 'video') {
              try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                  params.encodings = [{}];
                }
                // Adaptive: bitrate + framerate + resolução. Só cortar o
                // bitrate em rede ruim encoda 720p com poucos bits e fica
                // blocky. Melhor baixar a resolução junto — mesmo bitrate
                // em 360p vira um quadro nítido. WhatsApp faz igual.
                switch (score) {
                  case 5:
                    params.encodings[0].maxBitrate = 2500000;
                    params.encodings[0].maxFramerate = 30;
                    params.encodings[0].scaleResolutionDownBy = 1;   // 720p
                    break;
                  case 4:
                    params.encodings[0].maxBitrate = 1500000;
                    params.encodings[0].maxFramerate = 24;
                    params.encodings[0].scaleResolutionDownBy = 1.5; // 480p
                    break;
                  case 3:
                    params.encodings[0].maxBitrate = 800000;
                    params.encodings[0].maxFramerate = 15;
                    params.encodings[0].scaleResolutionDownBy = 2;   // 360p
                    break;
                  case 2:
                    params.encodings[0].maxBitrate = 400000;
                    params.encodings[0].maxFramerate = 10;
                    params.encodings[0].scaleResolutionDownBy = 3;   // 240p
                    break;
                  default:
                    params.encodings[0].maxBitrate = 150000;
                    params.encodings[0].maxFramerate = 5;
                    params.encodings[0].scaleResolutionDownBy = 4;   // 180p
                    break;
                }
                // Network priority hint (DSCP EF / CS5) — roteadores que
                // respeitam QoS priorizam os pacotes do call.
                params.encodings[0].networkPriority = 'high';
                params.encodings[0].priority = 'high';
                await sender.setParameters(params);
              } catch {}
            }
          }
        }
      } catch {}
    }, statsIntervalMs);

    // Refresh TURN credentials every hour (they expire in 24h, but refresh early)
    // Also refresh if they're about to expire (< 2 hours remaining)
    turnRefreshRef.current = setInterval(async () => {
      try {
        // Skip if TURN creds are still fresh (more than 2h remaining)
        if (turnExpiresAtRef.current && (turnExpiresAtRef.current - Date.now()) > 2 * 60 * 60 * 1000) return;

        const mailWs = require('../services/websocket').default;
        if (!mailWs.isConnected) return;
        const creds = await new Promise((resolve) => {
          const unsub = mailWs.on('turn_credentials', (data) => {
            unsub();
            resolve(data?.credentials || data);
          });
          mailWs._send({ type: 'get_turn_credentials' });
          setTimeout(() => { unsub(); resolve(null); }, 5000);
        });
        if (creds?.urls && pcRef.current) {
          turnCredsRef.current = creds;
          turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
          try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
          console.log('[Call] TURN credentials refreshed');
        }
      } catch {}
    }, 60 * 60 * 1000); // Every hour

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
      if (turnRefreshRef.current) clearInterval(turnRefreshRef.current);
    };
  }, [peerConnected]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Toggle mute — capture state BEFORE the toggle so the UI flag matches the
  // value we actually wrote, not the value we read after the OS-side change
  // (which on slow 3G can race and read the previous state).
  const handleToggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (audioTrack) {
      const wasEnabled = audioTrack.enabled;
      audioTrack.enabled = !wasEnabled;
      setAudioMuted(wasEnabled);
      // Broadcast to peer so they see the "X está no mudo" indicator. Peer
      // had no way to know — they were talking to silence and assumed call
      // was glitching. Mirror call_video_toggle pattern.
      try {
        sendSignaling('call_audio_muted', {
          call_id: callId,
          target_email: contactEmail,
          muted: wasEnabled, // wasEnabled true → now muted
        });
      } catch {}
    }
    resetControlsTimer();
  }, [resetControlsTimer, callId, contactEmail, sendSignaling]);

  // Toggle noise cancellation / echo cancellation / auto gain
  const handleToggleNoiseCancellation = useCallback(async () => {
    if (!localStreamRef.current) return;
    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (audioTrack) {
      const newVal = !noiseCancellation;
      try {
        if (typeof audioTrack.applyConstraints === 'function') {
          await audioTrack.applyConstraints({
            noiseSuppression: newVal,
            echoCancellation: newVal,
            autoGainControl: newVal,
          });
        }
      } catch (e) {
        console.log('[Call] applyConstraints error:', e?.message);
      }
      setNoiseCancellation(newVal);
    }
    _hapticTap('light');
    resetControlsTimer();
  }, [noiseCancellation, resetControlsTimer]);

  // Toggle raise-hand (group calls only). Broadcasts via the existing
  // call_reaction-style signaling channel; mirrors locally for the user's
  // own tile, then auto-lowers after 60s. Manual re-tap clears the timer.
  const handleToggleHandRaise = useCallback(() => {
    if (!isGroupCall) return;
    const next = !handRaised;
    setHandRaised(next);
    _hapticTap(next ? 'medium' : 'light');
    try {
      sendSignaling('call_hand_raise', {
        call_id: callId,
        conversation_id: conversationId,
        raised: next,
        name: user?.name || (user?.email || '').split('@')[0],
      });
    } catch {}
    // Update local raisedHands so the host's banner reflects ourselves too.
    try {
      const me = (user?.email || '').toLowerCase();
      if (me) {
        if (next) {
          raisedHandsRef.current.set(me, { name: user?.name || me.split('@')[0], ts: Date.now(), self: true });
        } else {
          raisedHandsRef.current.delete(me);
        }
        setRaisedHands(new Map(raisedHandsRef.current));
      }
    } catch {}
    if (handRaiseTimerRef.current) { try { clearTimeout(handRaiseTimerRef.current); } catch {} handRaiseTimerRef.current = null; }
    if (next) {
      handRaiseTimerRef.current = setTimeout(() => {
        // Self-lower after 60s — re-enter the toggle so signaling fires.
        setHandRaised(false);
        try {
          sendSignaling('call_hand_raise', {
            call_id: callId,
            conversation_id: conversationId,
            raised: false,
            name: user?.name || (user?.email || '').split('@')[0],
          });
        } catch {}
        try {
          const me = (user?.email || '').toLowerCase();
          if (me) {
            raisedHandsRef.current.delete(me);
            setRaisedHands(new Map(raisedHandsRef.current));
          }
        } catch {}
        handRaiseTimerRef.current = null;
      }, 60000);
    }
    resetControlsTimer();
  }, [isGroupCall, handRaised, callId, conversationId, user, sendSignaling, resetControlsTimer]);

  // Toggle video (supports upgrading audio-only call to video)
  const handleToggleVideo = useCallback(async () => {
    if (!localStreamRef.current || !pcRef.current) return;

    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (videoTrack) {
      // Existing video track — just toggle enabled
      videoTrack.enabled = !videoTrack.enabled;
      const nowEnabled = videoTrack.enabled;
      setVideoEnabled(nowEnabled);
      if (Platform.OS !== 'web' && localStreamRef.current.toURL) {
        setLocalStreamUrl(nowEnabled ? localStreamRef.current.toURL() : null);
      }
      // Web: show/hide local video PiP
      if (Platform.OS === 'web') {
        const localVid = document.getElementById('localCallVideo');
        if (localVid) {
          localVid.style.display = nowEnabled ? 'block' : 'none';
        }
      }
      // Notify remote peer about video state change
      sendSignaling('call_video_toggle', {
        call_id: callId,
        target_email: contactEmail,
        video_enabled: nowEnabled,
      });
    } else {
      // No video track exists — this is an audio-only call upgrading to video.
      // FaceTime/WhatsApp pattern: ASK the peer first. If they accept,
      // they enable their camera too AND respond with action='accepted',
      // which then fires the actual upgrade via the listener below. So
      // here we just send the request and bail out — peer's response will
      // re-call this function (videoEnabled stays false until then).
      const requestSent = videoUpgradeRequestedRef.current;
      if (!requestSent) {
        videoUpgradeRequestedRef.current = true;
        try {
          sendSignaling('call_video_request', {
            call_id: callId,
            target_email: contactEmail,
            action: 'request',
          });
        } catch {}
        // Auto-clear the flag if peer never replies in 30s. Without this,
        // the requester pressing the video button a second time would skip
        // the request branch and silently activate their camera, fooling
        // them into thinking the peer accepted.
        try {
          if (videoUpgradeTimeoutRef.current) clearTimeout(videoUpgradeTimeoutRef.current);
          videoUpgradeTimeoutRef.current = setTimeout(() => {
            videoUpgradeRequestedRef.current = false;
            videoUpgradeTimeoutRef.current = null;
            setVideoUpgradeToast(null);
            if (videoUpgradeCountdownRef.current) {
              clearInterval(videoUpgradeCountdownRef.current);
              videoUpgradeCountdownRef.current = null;
            }
          }, 30000);
        } catch {}
        // Non-blocking toast with regressive counter (replaces Alert.alert
        // which froze the UI). User can cancel via the inline button, and
        // the toast auto-dismisses on accept/decline/timeout.
        try {
          if (videoUpgradeCountdownRef.current) clearInterval(videoUpgradeCountdownRef.current);
          setVideoUpgradeToast({ secondsLeft: 30 });
          videoUpgradeCountdownRef.current = setInterval(() => {
            setVideoUpgradeToast(prev => {
              if (!prev) return null;
              const next = prev.secondsLeft - 1;
              if (next <= 0) {
                if (videoUpgradeCountdownRef.current) {
                  clearInterval(videoUpgradeCountdownRef.current);
                  videoUpgradeCountdownRef.current = null;
                }
                return null;
              }
              return { secondsLeft: next };
            });
          }, 1000);
        } catch {}
        // Don't activate camera yet. Listener for action='accepted' will
        // re-trigger handleToggleVideo (with the flag now set) and the
        // real upgrade path runs.
        return;
      }
      // Peer accepted (or we're past the request gate) — clear the timeout.
      try {
        if (videoUpgradeTimeoutRef.current) {
          clearTimeout(videoUpgradeTimeoutRef.current);
          videoUpgradeTimeoutRef.current = null;
        }
      } catch {}
      // requestSent is true — peer accepted; clear the flag and proceed.
      videoUpgradeRequestedRef.current = false;
      try {
        let getUserMediaFn;
        if (Platform.OS === 'web') {
          getUserMediaFn = (c) => navigator.mediaDevices.getUserMedia(c);
        } else {
          const webrtc = require('@stream-io/react-native-webrtc');
          getUserMediaFn = (c) => webrtc.mediaDevices.getUserMedia(c);
        }
        const videoStream = await getUserMediaFn({
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
            facingMode: facingFront ? 'user' : 'environment',
          },
        });
        const newTrack = videoStream.getVideoTracks()[0];
        localStreamRef.current.addTrack(newTrack);

        // Check if there's already a video sender (transceiver) we can reuse.
        // The original audio-only setup answer-side requested offerToReceiveVideo,
        // which creates a recvonly transceiver. Reuse it via replaceTrack, but
        // we MUST bump the transceiver direction to 'sendrecv' (it's recvonly
        // by default) — without that, the peer never receives our media even
        // though replaceTrack succeeded. That's the bug that caused the
        // acceptor of a video-upgrade to see only their own video.
        let usedExistingSender = false;
        const existingSender = pcRef.current.getSenders().find(s => s.track === null || s.track?.kind === 'video');
        if (existingSender) {
          await existingSender.replaceTrack(newTrack);
          usedExistingSender = true;
          try {
            const transceivers = pcRef.current.getTransceivers?.() || [];
            for (const tr of transceivers) {
              if (tr.sender === existingSender) {
                if (tr.direction !== 'sendrecv') {
                  try { tr.direction = 'sendrecv'; } catch {}
                }
                break;
              }
            }
          } catch (e) {
            console.warn('[Call] could not flip transceiver to sendrecv:', e?.message);
          }
        } else {
          // No video sender exists — add new track to peer connection
          pcRef.current.addTrack(newTrack, localStreamRef.current);
        }
        // Renegotiation flag — both addTrack and "flip recvonly→sendrecv"
        // change the SDP, so we always need a fresh offer/answer roundtrip.
        const _needsRenegotiation = true; // eslint-disable-line no-unused-vars

        // Seed HD bitrate on the just-attached video sender. Mirrors the
        // initial setup so the first frames after audio→video upgrade
        // aren't blocky (encoder defaults to ~300kbps otherwise).
        try {
          for (const s of pcRef.current.getSenders()) {
            if (s.track?.kind !== 'video') continue;
            try {
              const params = s.getParameters();
              if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
              params.encodings[0].maxBitrate = 1500000;
              params.encodings[0].maxFramerate = 30;
              params.encodings[0].networkPriority = 'high';
              params.encodings[0].priority = 'high';
              s.setParameters(params).catch(() => {});
            } catch {}
          }
        } catch {}

        setVideoEnabled(true);

        // Web: create local video PiP element if it doesn't exist
        if (Platform.OS === 'web') {
          let localVid = document.getElementById('localCallVideo');
          if (!localVid) {
            localVid = document.createElement('video');
            localVid.id = 'localCallVideo';
            localVid.autoplay = true;
            localVid.playsInline = true;
            localVid.muted = true;
            localVid.dataset.expanded = '0';
            localVid.style.cssText = 'position:fixed;bottom:180px;right:16px;width:110px;height:160px;object-fit:cover;z-index:30;border-radius:16px;border:2px solid rgba(255,255,255,0.25);cursor:grab;transition:width 200ms ease, height 200ms ease;';
            document.body.appendChild(localVid);
            // Make draggable
            let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
            localVid.addEventListener('mousedown', (e) => {
              dragging = true; startX = e.clientX; startY = e.clientY;
              const rect = localVid.getBoundingClientRect();
              origX = rect.left; origY = rect.top;
              localVid.style.cursor = 'grabbing';
              e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
              if (!dragging) return;
              localVid.style.left = (origX + e.clientX - startX) + 'px';
              localVid.style.top = (origY + e.clientY - startY) + 'px';
              localVid.style.right = 'auto';
              localVid.style.bottom = 'auto';
            });
            document.addEventListener('mouseup', () => { dragging = false; if (localVid) localVid.style.cursor = 'grab'; });
            // Double-click toggles 2x maximized PiP (matches behavior of the
            // first-mount path so audio→video upgrade feels identical).
            localVid.addEventListener('dblclick', () => {
              const isExpanded = localVid.dataset.expanded === '1';
              if (isExpanded) {
                localVid.style.width = '110px'; localVid.style.height = '160px';
                localVid.dataset.expanded = '0';
              } else {
                localVid.style.width = '220px'; localVid.style.height = '320px';
                localVid.dataset.expanded = '1';
              }
            });
            // Affordance toast: same pattern as the first-mount path. Skipped
            // if we already showed it during the initial getUserMedia setup.
            try {
              if (!document.getElementById('localCallVideoToast')) {
                const toast = document.createElement('div');
                toast.id = 'localCallVideoToast';
                toast.textContent = 'Toque duplo para ampliar';
                toast.style.cssText = 'position:fixed;bottom:140px;right:16px;padding:6px 12px;background:rgba(0,0,0,0.72);color:#fff;font-size:12px;border-radius:14px;z-index:31;pointer-events:none;opacity:0;transition:opacity 220ms ease;';
                document.body.appendChild(toast);
                requestAnimationFrame(() => { toast.style.opacity = '1'; });
                setTimeout(() => {
                  toast.style.opacity = '0';
                  setTimeout(() => { try { toast.remove(); } catch {} }, 260);
                }, 2000);
              }
            } catch {}
          }
          localVid.srcObject = localStreamRef.current;
          localVid.style.display = 'block';
        }

        if (Platform.OS !== 'web' && localStreamRef.current.toURL) {
          setLocalStreamUrl(localStreamRef.current.toURL());
        }

        // Notify remote peer that video was enabled (audio→video upgrade)
        sendSignaling('call_video_toggle', {
          call_id: callId,
          target_email: contactEmail,
          video_enabled: true,
        });

        // Renegotiate so the remote peer knows about the new video track.
        // Aplica Opus tuning + codec preference antes da nova offer — sem
        // isso o upgrade audio→video perdia as otimizações (voz voltava
        // pra ptime 60ms, vídeo negociava VP8 em vez de VP9).
        try {
          applyCodecPreferences(pcRef.current);
          const offer = await pcRef.current.createOffer();
          offer.sdp = applyOpusTuning(offer.sdp);
          await pcRef.current.setLocalDescription(offer);
          sendSignaling('call_offer', {
            call_id: callId,
            target_email: contactEmail,
            sdp: offer.sdp,
            sdp_type: offer.type,
          });
        } catch (reErr) {
          console.error('[Call] renegotiation after video add failed:', reErr);
        }
      } catch (err) {
        console.error('[Call] Failed to add video track:', err);
      }
    }
    resetControlsTimer();
  }, [facingFront, resetControlsTimer, callId, contactEmail, sendSignaling]);

  // Flip camera (front/back)
  const handleFlipCamera = useCallback(async () => {
    if (!localStreamRef.current || !pcRef.current) return;
    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (!videoTrack) return;

    const newFacing = !facingFront;

    if (Platform.OS !== 'web') {
      // Native: use _switchCamera() if available (react-native-webrtc)
      try {
        if (typeof videoTrack._switchCamera === 'function') {
          videoTrack._switchCamera();
          setFacingFront(newFacing);
          resetControlsTimer();
          return;
        }
      } catch {}
    }

    // Web fallback: get new stream with opposite facingMode
    try {
      let getUserMediaFn;
      if (Platform.OS === 'web') {
        getUserMediaFn = (c) => navigator.mediaDevices.getUserMedia(c);
      } else {
        const webrtc = require('@stream-io/react-native-webrtc');
        getUserMediaFn = (c) => webrtc.mediaDevices.getUserMedia(c);
      }

      const newStream = await getUserMediaFn({
        video: {
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 30 },
          facingMode: newFacing ? 'user' : 'environment',
        },
      });

      const newTrack = newStream.getVideoTracks()[0];

      // Replace track in peer connection
      const sender = pcRef.current.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newTrack);
      }

      // Stop old track and replace in local stream
      videoTrack.stop();
      localStreamRef.current.removeTrack(videoTrack);
      localStreamRef.current.addTrack(newTrack);

      if (Platform.OS !== 'web' && localStreamRef.current.toURL) {
        setLocalStreamUrl(localStreamRef.current.toURL());
      }

      setFacingFront(newFacing);
    } catch (err) {
      console.error('[Call] flip camera error:', err);
    }
    resetControlsTimer();
  }, [facingFront, resetControlsTimer]);

  // Load conversation members the first time the add-participant modal opens.
  // We filter out anyone already on the call client-side via groupPeersRef so
  // the user only sees people who can actually be invited (no duplicates).
  //
  // Fallback: when the convo is 1:1 (only 2 members) OR chatGroupInfo returns
  // nothing useful, we additionally pull the user's contacts + recent chat
  // conversations so the list isn't limited to that single existing peer.
  useEffect(() => {
    if (!showAddParticipant) return;
    let cancelled = false;
    (async () => {
      try {
        const api = require('../services/api');
        const inCall = new Set([
          (user?.email || '').toLowerCase(),
          ...Array.from(groupPeersRef.current?.keys?.() || []).map(e => (e || '').toLowerCase()),
        ]);
        if (contactEmail) inCall.add((contactEmail + '').toLowerCase());

        const seen = new Map(); // email -> candidate (dedupe)
        const addCandidate = (raw) => {
          if (!raw) return;
          const email = ((raw.email || raw.peer_email || raw.member_email || '') + '').toLowerCase();
          if (!email || inCall.has(email)) return;
          if (seen.has(email)) return;
          seen.set(email, {
            email,
            name: raw.name || raw.display_name || raw.peer_name || email.split('@')[0],
          });
        };

        // 1) Try conversation members first (group calls).
        let members = [];
        if (conversationId) {
          try {
            const r = await api.chatGroupInfo(conversationId);
            members = r?.data?.members || r?.members || [];
          } catch {}
          members.forEach(addCandidate);
        }

        // 2) If the convo is 1:1 (< 2 invitable members) OR no convo at all,
        //    pull user's address book + recent chat conversations as fallback.
        if (seen.size < 1 || !conversationId || members.length < 3) {
          try {
            const c = await api.getContactsList?.();
            const contacts = c?.data?.contacts || c?.contacts || c?.data || c || [];
            if (Array.isArray(contacts)) contacts.forEach(addCandidate);
          } catch {}
          try {
            const cv = await api.chatConversations?.();
            const convos = cv?.data?.conversations || cv?.conversations || cv?.data || cv || [];
            if (Array.isArray(convos)) {
              convos.forEach(co => {
                // direct conversations expose peer_email; group convos expose members[]
                if (co?.peer_email) addCandidate({ email: co.peer_email, name: co.peer_name || co.name });
                if (Array.isArray(co?.members)) co.members.forEach(addCandidate);
              });
            }
          } catch {}
        }

        if (cancelled) return;
        setAddParticipantCandidates(Array.from(seen.values()));
      } catch (e) {
        if (__DEV__) console.warn('[call.addParticipant.load]', e?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [showAddParticipant, conversationId, user?.email, contactEmail]);

  const handleInviteToCall = useCallback(async (email) => {
    if (!email || addParticipantBusy) return;
    setAddParticipantBusy(true);
    try {
      const { chatCallInvite } = require('../services/api');
      await chatCallInvite(conversationId, callId, [email], !!isVideoParam);
      // Optimistic UX — remove invitee from candidate list so the row disappears.
      setAddParticipantCandidates(prev => prev.filter(c => (c.email || '').toLowerCase() !== email.toLowerCase()));
    } catch (e) {
      if (__DEV__) console.warn('[call.invite]', e?.message);
    } finally {
      setAddParticipantBusy(false);
    }
  }, [callId, conversationId, isVideoParam, addParticipantBusy]);

  // Screen share (web only)
  const handleScreenShare = useCallback(async () => {
    if (!pcRef.current) return;

    // Helper: pega getDisplayMedia do lugar certo por plataforma.
    // - Web: passes the constraints object as the W3C spec dictates.
    // - Native: @stream-io/react-native-webrtc.getDisplayMedia() accepts no
    //   arguments. On iOS it needs a ReplayKit broadcast extension to
    //   actually work, and on Android it needs a foreground service +
    //   MediaProjection. If the native module isn't there, we throw
    //   'unsupported' so the upstream catch shows the friendly alert.
    const getDisplay = async (constraints) => {
      if (Platform.OS === 'web') {
        if (!navigator?.mediaDevices?.getDisplayMedia) throw new Error('unsupported');
        return navigator.mediaDevices.getDisplayMedia(constraints);
      }
      // Native: lib expõe getDisplayMedia mas só funciona com extension nativa.
      try {
        const webrtc = require('@stream-io/react-native-webrtc');
        if (webrtc?.mediaDevices?.getDisplayMedia) {
          // Lib signature ignora os constraints; chame sem args pra evitar
          // type-mismatch quando a ponte JNI valida o argumento.
          return webrtc.mediaDevices.getDisplayMedia();
        }
      } catch {}
      throw new Error('unsupported');
    };

    if (screenSharing) {
      // Stop screen sharing, restore camera
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(t => t.stop());
        screenStreamRef.current = null;
      }
      const videoTrack = localStreamRef.current?.getVideoTracks()[0];
      if (videoTrack) {
        const sender = pcRef.current.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(videoTrack);
      }
      setScreenSharing(false);
      sendSignaling('call_screen_share', {
        call_id: callId,
        target_email: contactEmail,
        screen_sharing: false,
      });
    } else {
      // Start screen sharing
      try {
        const screenStream = await getDisplay({ video: true });
        screenStreamRef.current = screenStream;

        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = pcRef.current.getSenders().find(s => s.track?.kind === 'video');
        let needsRenegotiation = false;
        if (sender) {
          // Existing video sender (video call): replaceTrack is hot-swappable
          // and the peer sees the new track without renegotiating.
          await sender.replaceTrack(screenTrack);
        } else {
          // Audio call: no video sender exists. addTrack adds it but the peer
          // won't receive video until we send a fresh offer with the new
          // m-line. Without this branch, audio-call screen share silently
          // failed — the local track was added but never reached the remote.
          pcRef.current.addTrack(screenTrack, screenStream);
          needsRenegotiation = true;
        }

        if (needsRenegotiation) {
          try {
            applyCodecPreferences(pcRef.current);
            const offer = await pcRef.current.createOffer();
            offer.sdp = applyOpusTuning(offer.sdp);
            await pcRef.current.setLocalDescription(offer);
            sendSignaling('call_offer', {
              call_id: callId,
              target_email: contactEmail,
              sdp: offer.sdp,
              sdp_type: offer.type,
            });
          } catch (renegErr) {
            console.warn('[Call] screen share renegotiation failed:', renegErr?.message);
          }
        }

        // When user stops sharing via browser/OS UI
        screenTrack.onended = () => {
          setScreenSharing(false);
          screenStreamRef.current = null;
          const camTrack = localStreamRef.current?.getVideoTracks()[0];
          if (camTrack) {
            const s = pcRef.current?.getSenders()?.find(s => s.track?.kind === 'video');
            if (s) s.replaceTrack(camTrack).catch(() => {});
          }
          sendSignaling('call_screen_share', {
            call_id: callId,
            target_email: contactEmail,
            screen_sharing: false,
          });
        };

        setScreenSharing(true);
        sendSignaling('call_screen_share', {
          call_id: callId,
          target_email: contactEmail,
          screen_sharing: true,
        });
      } catch (e) {
        if (e?.message === 'unsupported') {
          try {
            const { Alert } = require('react-native');
            Alert.alert(
              t('call.shareScreen') || 'Compartilhar tela',
              t('call.shareScreenUnsupported') || 'Compartilhamento de tela não disponível nesta versão do app.',
            );
          } catch {}
        }
        // User cancelled o picker ou não suportado: silencioso
      }
    }
    resetControlsTimer();
  }, [screenSharing, resetControlsTimer, callId, contactEmail, sendSignaling, t]);

  // Toggle speaker
  const handleToggleSpeaker = useCallback(async () => {
    const newSpeakerOn = !speakerOn;
    setSpeakerOn(newSpeakerOn);

    if (Platform.OS === 'web') {
      // Web: use setSinkId to switch between default (earpiece-like) and speaker output
      const audioEl = remoteAudioRef.current || document.getElementById('remoteCallAudio');
      if (audioEl && typeof audioEl.setSinkId === 'function') {
        try {
          // Enumerate audio output devices to find a speaker
          const devices = await navigator.mediaDevices.enumerateDevices();
          const outputDevices = devices.filter(d => d.kind === 'audiooutput');
          if (newSpeakerOn) {
            // Try to find a speaker device (usually the default or one labeled 'speaker')
            const speaker = outputDevices.find(d =>
              d.label.toLowerCase().includes('speaker') ||
              d.label.toLowerCase().includes('alto-falante')
            ) || outputDevices.find(d => d.deviceId === 'default') || outputDevices[0];
            if (speaker) {
              await audioEl.setSinkId(speaker.deviceId);
            }
          } else {
            // Switch to communications device (earpiece-like) if available, otherwise default
            const earpiece = outputDevices.find(d =>
              d.deviceId === 'communications' ||
              d.label.toLowerCase().includes('earpiece') ||
              d.label.toLowerCase().includes('fone')
            );
            if (earpiece) {
              await audioEl.setSinkId(earpiece.deviceId);
            } else {
              await audioEl.setSinkId('default');
            }
          }
        } catch (err) {
          console.log('[Call] setSinkId error:', err);
        }
      }
    } else {
      // Native: prefer ExpoAudioSession.setSpeaker (uses AVAudioSession's
      // overrideOutputAudioPort which is the only reliable iOS toggle).
      // InCallManager fights with the audio session ExpoAudioSession set up
      // at call start and the route doesn't actually flip — that's why the
      // speaker button felt dead. Run ExpoAudioSession FIRST, then keep
      // InCallManager as a secondary nudge for legacy paths.
      let nativeOk = false;
      try {
        const ExpoAudioSession = require('../modules/expo-audio-session').default;
        if (ExpoAudioSession?.setSpeaker) {
          await ExpoAudioSession.setSpeaker(newSpeakerOn);
          // Proximity sensor: OFF when speaker on (you're holding the phone
          // away to look at it), ON when speaker off (back to ear-piece pose)
          ExpoAudioSession.enableProximitySensor?.(!newSpeakerOn);
          nativeOk = true;
          console.log('[Call] ExpoAudioSession.setSpeaker:', newSpeakerOn ? 'ON' : 'OFF');
        }
      } catch (e) {
        console.warn('[Call] ExpoAudioSession.setSpeaker error:', e?.message);
      }
      // Legacy fallback (only when ExpoAudioSession unavailable — Android too)
      if (!nativeOk) {
        try {
          const { setAudioModeAsync } = require('expo-audio');
          await setAudioModeAsync({
            interruptionMode: 'doNotMix',
            playsInSilentMode: true,
            shouldPlayInBackground: true,
            allowsRecording: true,
          });
        } catch {}
        try {
          const InCallManager = require('react-native-incall-manager').default;
          InCallManager.setForceSpeakerphoneOn(newSpeakerOn);
          console.log('[Call] InCallManager.setForceSpeakerphoneOn fallback:', newSpeakerOn ? 'ON' : 'OFF');
        } catch (e) {
          console.warn('[Call] InCallManager error:', e?.message);
        }
      }
    }
    resetControlsTimer();
  }, [speakerOn, resetControlsTimer]);

  // Emoji reactions on call
  const CALL_EMOJIS = useMemo(() => ['❤️', '😂', '😮', '👏', '🔥', '🎉', '👍', '😢'], []);

  const handleSendEmoji = useCallback((emoji) => {
    const id = Date.now() + Math.random();
    const x = 20 + Math.random() * (SCREEN_W - 80);
    const anim = new Animated.Value(0);
    setFloatingEmojis(prev => [...prev, { id, emoji, x, anim }]);
    Animated.timing(anim, {
      toValue: 1,
      duration: 2000,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(() => {
      setFloatingEmojis(prev => prev.filter(e => e.id !== id));
    });
    // Broadcast the reaction to the peer so they see the same floating emoji.
    // Without this the reaction was purely cosmetic on the sender's side —
    // user reported "coracao não reflete pra pessoa". Mirror the same
    // sendSignaling pattern as call_video_toggle / call_screen_share.
    try {
      sendSignaling('call_reaction', {
        call_id: callId,
        target_email: contactEmail,
        emoji,
      });
    } catch {}
    setShowEmojiBar(false);
    resetControlsTimer();
  }, [resetControlsTimer, callId, contactEmail, sendSignaling]);

  // Hold call — mute audio + disable video temporarily
  const handleToggleHold = useCallback(() => {
    if (!localStreamRef.current) return;
    const newHold = !onHold;

    if (newHold) {
      // Going on hold: save current state, mute audio, disable video
      holdStateRef.current.audioWasMuted = audioMuted;
      holdStateRef.current.videoWasEnabled = videoEnabled;

      // Mute audio
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = false;
      setAudioMuted(true);

      // Disable video if enabled
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack && videoTrack.enabled) {
        videoTrack.enabled = false;
        setVideoEnabled(false);
        if (Platform.OS === 'web') {
          const localVid = document.getElementById('localCallVideo');
          if (localVid) localVid.style.display = 'none';
        }
        if (Platform.OS !== 'web') setLocalStreamUrl(null);
      }
    } else {
      // Coming off hold: restore previous state
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = !holdStateRef.current.audioWasMuted;
      setAudioMuted(holdStateRef.current.audioWasMuted);

      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack && holdStateRef.current.videoWasEnabled) {
        videoTrack.enabled = true;
        setVideoEnabled(true);
        if (Platform.OS === 'web') {
          const localVid = document.getElementById('localCallVideo');
          if (localVid) localVid.style.display = 'block';
        }
        if (Platform.OS !== 'web' && localStreamRef.current.toURL) {
          setLocalStreamUrl(localStreamRef.current.toURL());
        }
      }
    }

    setOnHold(newHold);

    // Notify the peer so they see an "Em espera" banner. Without this, the
    // other party just sees the call freeze with no explanation. Mirrors the
    // existing call_video_toggle / call_screen_share patterns.
    try {
      sendSignaling('call_hold', {
        call_id: callId,
        target_email: contactEmail,
        on: newHold,
      });
    } catch {}

    resetControlsTimer();
  }, [onHold, audioMuted, videoEnabled, resetControlsTimer, callId, contactEmail, sendSignaling]);

  // Listen for remote peer's hold notification — mirror state into peerOnHold
  // so the banner renders. Also guards against the multi-device echo where Go
  // WS broadcasts the message back to the sender's own other sessions.
  useEffect(() => {
    try {
      const mailWs = require('../services/websocket').default;
      const unsub = mailWs.on('call_hold', (data) => {
        if (data?.call_id && data.call_id !== callId) return;
        try {
          const me = (user?.email || '').toLowerCase();
          const sender = (data?.email || data?.from_email || '').toLowerCase();
          if (sender && me && sender === me) return;
        } catch {}
        setPeerOnHold(!!(data?.on ?? data?.on_hold ?? data?.hold));
      });
      return () => { try { unsub(); } catch {} };
    } catch {}
  }, [callId, user?.email]);

  // ── Call Recording ──
  // Uses MediaRecorder (web) to capture the mixed audio from the peer connection.
  // On native, we capture the local audio stream. The recording is uploaded after call end.
  const handleToggleRecording = useCallback(() => {
    if (isRecording) {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
      // Notify remote peer
      sendSignaling('call_recording', { call_id: callId, target_email: contactEmail, recording: false });
    } else {
      // Start recording
      try {
        if (Platform.OS === 'web') {
          // On web, capture remote audio + local audio into a single MediaRecorder
          const audioCtx = new AudioContext();
          const dest = audioCtx.createMediaStreamDestination();

          // Mix remote audio
          const remoteStream = remoteAudioRef.current?.srcObject;
          if (remoteStream) {
            const remoteSrc = audioCtx.createMediaStreamSource(remoteStream);
            remoteSrc.connect(dest);
          }

          // Mix local audio
          if (localStreamRef.current) {
            const localAudioTracks = localStreamRef.current.getAudioTracks();
            if (localAudioTracks.length > 0) {
              const localAudioStream = new MediaStream(localAudioTracks);
              const localSrc = audioCtx.createMediaStreamSource(localAudioStream);
              localSrc.connect(dest);
            }
          }

          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';
          const recorder = new MediaRecorder(dest.stream, { mimeType });
          recordedChunksRef.current = [];
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
          };
          recorder.onstop = () => {
            audioCtx.close().catch(() => {});
          };
          recorder.start(1000); // collect data every second
          mediaRecorderRef.current = recorder;
          recordingStartTimeRef.current = Date.now();
          setIsRecording(true);
          // Notify remote peer
          sendSignaling('call_recording', { call_id: callId, target_email: contactEmail, recording: true });
        } else {
          // Native: use expo-audio Recording API
          (async () => {
            try {
              const { Audio } = require('expo-audio');
              const recording = new Audio.Recording();
              await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
              await recording.startAsync();
              mediaRecorderRef.current = recording;
              recordingStartTimeRef.current = Date.now();
              setIsRecording(true);
              sendSignaling('call_recording', { call_id: callId, target_email: contactEmail, recording: true });
            } catch (err) {
              console.warn('[Call] Failed to start native recording:', err);
            }
          })();
        }
      } catch (err) {
        console.warn('[Call] Recording error:', err);
      }
    }
    resetControlsTimer();
  }, [isRecording, callId, contactEmail, sendSignaling, resetControlsTimer]);

  // Upload recording after call ends (called from handleEndCall)
  const uploadRecordingAsync = useCallback(async () => {
    try {
      const { uploadCallRecording } = require('../services/api');
      if (Platform.OS === 'web') {
        if (recordedChunksRef.current.length === 0) return;
        const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
        await uploadCallRecording({ blob, name: `recording-${callId}.webm`, type: 'audio/webm' }, null, callId);
        recordedChunksRef.current = [];
      } else {
        const recording = mediaRecorderRef.current;
        if (!recording) return;
        try {
          await recording.stopAndUnloadAsync();
          const uri = recording.getURI();
          if (uri) {
            await uploadCallRecording({ uri, name: `recording-${callId}.m4a`, type: 'audio/mp4' }, null, callId);
          }
        } catch {}
      }
    } catch (err) {
      console.warn('[Call] Recording upload error:', err);
    }
  }, [callId]);

  // Listen for remote peer's recording notification
  useEffect(() => {
    try {
      const mailWs = require('../services/websocket').default;
      const unsub = mailWs.on('call_recording', (data) => {
        if (data?.call_id !== callId) return;
        setRemoteIsRecording(!!data.recording);
      });
      wsUnsubsRef.current.push(unsub);
    } catch {}
  }, [callId]);

  // Listen for remote peer's video toggle notification
  useEffect(() => {
    try {
      const mailWs = require('../services/websocket').default;
      const unsub = mailWs.on('call_video_toggle', (data) => {
        if (data?.call_id !== callId) return;
        const remoteVideoOn = data.video_enabled ?? data.videoEnabled;
        console.log('[Call] Remote peer video toggle:', remoteVideoOn);

        // Update peer-camera state for ALL platforms. Native RTCView holds
        // the last frame if we keep rendering it after peer disables — gate
        // the render on this flag so we fall back to the avatar overlay.
        setPeerVideoEnabled(!!remoteVideoOn);

        // When remote enables video, ensure we show the remote video element
        if (Platform.OS === 'web' && remoteVideoOn) {
          // The remote video element will be created/updated when the track arrives via ontrack
          // but we should ensure the remoteCallVideo element exists
          setTimeout(() => {
            const remoteStream = remoteAudioRef.current?.srcObject;
            if (remoteStream && remoteStream.getVideoTracks().length > 0) {
              let vid = document.getElementById('remoteCallVideo');
              if (!vid) {
                vid = document.createElement('video');
                vid.id = 'remoteCallVideo';
                vid.autoplay = true;
                vid.playsInline = true;
                vid.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;';
                document.body.appendChild(vid);
              }
              vid.srcObject = remoteStream;
              remoteVideoRef.current = vid;
            }
          }, 500);
        }

        // When remote disables video, hide the remote video element
        if (Platform.OS === 'web' && !remoteVideoOn) {
          const vid = document.getElementById('remoteCallVideo');
          if (vid) {
            vid.remove();
            remoteVideoRef.current = null;
          }
        }
      });

      // call_audio_muted — peer toggled their mic. Show "X está no mudo"
      // indicator. WhatsApp/Telegram parity: you should see the other side
      // is muted so you don't keep talking expecting them to hear.
      const unsubMuted = mailWs.on('call_audio_muted', (data) => {
        if (data.call_id && data.call_id !== callId) return;
        // Multi-device guard: Go WS broadcasts to ALL sessions of the
        // target_email, including the sender's other devices. Without
        // this check, a 2-device user (web + phone) would see "X está
        // no mudo" pointed at themselves when they hit mute.
        try {
          const me = (user?.email || '').toLowerCase();
          const sender = (data?.email || data?.from_email || '').toLowerCase();
          if (sender && me && sender === me) return;
        } catch {}
        setRemoteAudioMuted(!!data.muted);
      });

      // call_video_request — peer wants to switch from audio to video.
      // FaceTime/WhatsApp pattern: prompt the user to accept before
      // forcibly enabling their camera. Stored in state for the modal UI.
      // Three actions: 'request' (peer asks), 'accepted' (peer agreed to
      // OUR earlier request — fire the actual upgrade locally), 'declined'.
      const unsubVideoReq = mailWs.on('call_video_request', (data) => {
        if (data.call_id && data.call_id !== callId) return;
        try {
          const me = (user?.email || '').toLowerCase();
          const sender = (data?.email || data?.from_email || '').toLowerCase();
          if (sender && me && sender === me) return;
        } catch {}
        if (data.action === 'request') {
          setPendingVideoRequest({ from: data.email || contactEmail });
        } else if (data.action === 'cancel' || data.action === 'declined') {
          const wasWaiting = videoUpgradeRequestedRef.current;
          setPendingVideoRequest(null);
          // If WE were the one waiting, clear the flag so a future press
          // restarts the request flow rather than silently activating.
          videoUpgradeRequestedRef.current = false;
          try {
            if (videoUpgradeTimeoutRef.current) {
              clearTimeout(videoUpgradeTimeoutRef.current);
              videoUpgradeTimeoutRef.current = null;
            }
          } catch {}
          // Dismiss outgoing toast (peer rejected/cancelled).
          try {
            setVideoUpgradeToast(null);
            if (videoUpgradeCountdownRef.current) {
              clearInterval(videoUpgradeCountdownRef.current);
              videoUpgradeCountdownRef.current = null;
            }
          } catch {}
          // Tell the requester their peer declined. Only show on the side
          // that was actually waiting (wasWaiting) AND only for 'declined'
          // (cancel is when the requester themselves cancelled — no popup).
          if (wasWaiting && data.action === 'declined') {
            try {
              const { Alert } = require('react-native');
              Alert.alert(
                t('call.videoRequestDeclinedTitle') || 'Recusado',
                (t('call.videoRequestDeclinedBody') || '{name} recusou o vídeo.').replace('{name}', (contactName || contactEmail || '')),
              );
            } catch {}
          }
        } else if (data.action === 'accepted') {
          // Peer accepted our request. The flag is already set; calling
          // handleToggleVideo now skips the request branch and runs the
          // real camera-enable + renegotiation path.
          try {
            setVideoUpgradeToast(null);
            if (videoUpgradeCountdownRef.current) {
              clearInterval(videoUpgradeCountdownRef.current);
              videoUpgradeCountdownRef.current = null;
            }
          } catch {}
          try { handleToggleVideo(); } catch {}
        }
      });

      // call_reaction — peer sent a floating emoji. Mirror the local
      // animation so it flies up on our screen too. Without this listener,
      // user reported "coracao não reflete pra pessoa" — sender saw it
      // float but receiver got nothing because there was no broadcast
      // (now fixed in handleSendEmoji) AND no listener (now fixed here).
      const unsubReaction = mailWs.on('call_reaction', (data) => {
        if (!data?.emoji) return;
        if (data.call_id && data.call_id !== callId) return;
        try {
          const me = (user?.email || '').toLowerCase();
          const sender = (data?.email || data?.from_email || '').toLowerCase();
          if (sender && me && sender === me) return;
        } catch {}
        const id = Date.now() + Math.random();
        const x = 20 + Math.random() * (SCREEN_W - 80);
        const anim = new Animated.Value(0);
        setFloatingEmojis(prev => [...prev, { id, emoji: data.emoji, x, anim }]);
        Animated.timing(anim, {
          toValue: 1,
          duration: 2000,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }).start(() => {
          setFloatingEmojis(prev => prev.filter(e => e.id !== id));
        });
      });

      // call_hand_raise — group-call only; remote participant raised or
      // lowered their hand. We mirror into raisedHandsRef so the host's
      // banner re-renders, and add a per-email auto-lower timer in case
      // the WS lower event never arrives (network drop, app backgrounded).
      const unsubHandRaise = mailWs.on('call_hand_raise', (data) => {
        if (data?.call_id && data.call_id !== callId) return;
        const fromEmail = ((data?.email || data?.from_email || '') + '').toLowerCase();
        if (!fromEmail) return;
        // Skip own echo — Go WS broadcasts to the sender's other sessions.
        try {
          const me = (user?.email || '').toLowerCase();
          if (me && fromEmail === me) return;
        } catch {}
        const raised = !!data?.raised;
        // Clear any existing auto-lower timer for this email — either we're
        // lowering now or starting a fresh 60s window.
        const existingTimer = handLowerTimersRef.current.get(fromEmail);
        if (existingTimer) { try { clearTimeout(existingTimer); } catch {} handLowerTimersRef.current.delete(fromEmail); }
        if (raised) {
          raisedHandsRef.current.set(fromEmail, {
            name: data?.name || fromEmail.split('@')[0],
            ts: Date.now(),
          });
          // Defensive auto-lower in case the WS lower event drops.
          const timer = setTimeout(() => {
            raisedHandsRef.current.delete(fromEmail);
            setRaisedHands(new Map(raisedHandsRef.current));
            handLowerTimersRef.current.delete(fromEmail);
          }, 60000);
          handLowerTimersRef.current.set(fromEmail, timer);
        } else {
          raisedHandsRef.current.delete(fromEmail);
        }
        setRaisedHands(new Map(raisedHandsRef.current));
      });

      return () => {
        try { unsub(); } catch {}
        try { unsubReaction(); } catch {}
        try { unsubMuted(); } catch {}
        try { unsubVideoReq(); } catch {}
        try { unsubHandRaise(); } catch {}
        try {
          handLowerTimersRef.current.forEach(t => { try { clearTimeout(t); } catch {} });
          handLowerTimersRef.current.clear();
        } catch {}
        try { if (handRaiseTimerRef.current) { clearTimeout(handRaiseTimerRef.current); handRaiseTimerRef.current = null; } } catch {}
      };
    } catch {}
  }, [callId]);

  // Listen for remote peer's screen share notification
  useEffect(() => {
    try {
      const mailWs = require('../services/websocket').default;
      const unsub = mailWs.on('call_screen_share', (data) => {
        if (data?.call_id !== callId) return;
        setPeerScreenSharing(!!data.screen_sharing);
      });
      return () => { try { unsub(); } catch {} };
    } catch {}
  }, [callId]);

  // Video filters
  const VIDEO_FILTERS = useMemo(() => [
    { key: null, label: 'Normal', color: '#fff' },
    { key: 'warm', label: '☀️ Warm', color: '#ff9800' },
    { key: 'cool', label: '❄️ Cool', color: '#03a9f4' },
    { key: 'bw', label: '⬛ B&W', color: '#888' },
    { key: 'vintage', label: '📷 Vintage', color: '#d4a574' },
    { key: 'beauty', label: '✨ Beauty', color: '#e91e63' },
  ], []);

  // Load saved filter from AsyncStorage on mount
  useEffect(() => {
    AsyncStorage.getItem('call_video_filter').then(saved => {
      if (saved && saved !== 'null') setActiveFilter(saved);
    }).catch(() => {});
  }, []);

  // Save filter preference whenever it changes
  useEffect(() => {
    AsyncStorage.setItem('call_video_filter', activeFilter || 'null').catch(() => {});
  }, [activeFilter]);

  // Apply CSS filter to local video element on web
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const localVid = document.getElementById('localCallVideo');
    if (localVid) {
      const style = getFilterStyle(activeFilter);
      localVid.style.filter = style.filter || 'none';
    }
  }, [activeFilter]);

  const getFilterStyle = useCallback((filter) => {
    if (!filter) return {};
    switch (filter) {
      case 'warm': return Platform.OS === 'web' ? { filter: 'saturate(1.3) sepia(0.15) brightness(1.05)' } : { opacity: 0.92 };
      case 'cool': return Platform.OS === 'web' ? { filter: 'saturate(0.9) hue-rotate(15deg) brightness(1.05)' } : {};
      case 'bw': return Platform.OS === 'web' ? { filter: 'grayscale(1)' } : {};
      case 'vintage': return Platform.OS === 'web' ? { filter: 'sepia(0.4) contrast(1.1) brightness(0.95)' } : {};
      case 'beauty': return Platform.OS === 'web' ? { filter: 'brightness(1.08) contrast(0.95) saturate(1.1) blur(0.3px)' } : {};
      default: return {};
    }
  }, []);

  // Status text — three intermediate states for the caller before connection:
  //   connecting (no peer signal yet) → "Conectando..."
  //   ringing (peer device received offer, sent answer/ICE) → "Tocando..."
  //   connected → call duration
  // Caller-only: callee skips straight to peerConnected once they accept.
  let statusText = t('call.connecting') || 'Conectando...';
  if (peerRinging && !peerConnected) statusText = t('call.ringing') || 'Tocando...';
  if (connectionFailed) statusText = t('call.connectionFailed') || 'Não foi possível conectar. Tente novamente.';
  else if (errorMsg) statusText = errorMsg;
  else if (ended) statusText = t('call.ended') || 'Chamada encerrada';
  else if (reconnecting && !peerConnected) statusText = t('call.reconnecting') || 'Reconectando...';
  else if (onHold) statusText = (t('call.onHold') || 'Em espera') + ' · ' + formatDuration(callDuration);
  else if (screenSharing) statusText = t('call.screenSharing') || 'Compartilhando tela';
  else if (peerScreenSharing) statusText = formatDuration(callDuration);
  else if (peerConnected) statusText = formatDuration(callDuration);

  // Signal bars component — maps 5-level quality score to visual bars
  const SignalBars = ({ quality, score, rtt }) => {
    // Map quality score (1-5) to bar count (1-5)
    const bars = score || (quality === 'good' ? 4 : quality === 'medium' ? 2 : 1);
    const color = bars >= 4 ? '#7C3AED' : bars === 3 ? '#f59e0b' : '#ef4444';
    // audit gap #4 — when quality fell below 3 the WebRTC helper drops
    // bitrate/framerate via adaptBitrate(). Surface that with a tiny ↓
    // indicator next to the bars so the user knows we're already
    // compensating for their bad connection (not just rendering a bad call).
    const bitrateAdapted = bars > 0 && bars < 3;
    return (
      <View
        style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height: 14, marginLeft: 8 }}
        accessibilityLabel={bitrateAdapted ? (t?.('call.qualityAutoLowered') || 'Reduzimos a qualidade pra manter conexão') : undefined}
      >
        {[1, 2, 3, 4, 5].map(i => (
          <View key={i} style={{ width: 3, height: 2 + i * 2.5, borderRadius: 1, backgroundColor: i <= bars ? color : 'rgba(255,255,255,0.2)' }} />
        ))}
        {bitrateAdapted && (
          <Svg width={9} height={11} viewBox="0 0 24 24" style={{ marginLeft: 3 }}>
            <SvgPath d="M12 5v14M5 12l7 7 7-7" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </Svg>
        )}
        {rtt !== null && rtt !== undefined && (
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 9, marginLeft: 3, fontVariant: ['tabular-nums'] }}>{rtt}ms</Text>
        )}
      </View>
    );
  };

  // Get RTCView for native video rendering
  const RTCView = Platform.OS !== 'web' ? (() => {
    try { return require('@stream-io/react-native-webrtc').RTCView; } catch { return null; }
  })() : null;

  // showRemoteVideo also depends on the native RTCView module being
  // loadable. If the @stream-io/react-native-webrtc module is missing
  // (broken native build), RTCView resolves null above and the absoluteFill
  // <RTCView/> never renders — without this check we'd still claim video
  // is "showing" and hide the avatar/centerArea fallback below, leaving
  // the user staring at an empty black screen instead of the avatar +
  // status + decline button.
  const remoteVideoAvailable = Platform.OS === 'web' ? !!remoteVideoRef.current : (!!remoteStreamUrl && !!RTCView);
  const showRemoteVideo = videoEnabled && peerConnected && peerVideoEnabled && remoteVideoAvailable;
  const showLocalVideo = videoEnabled && (Platform.OS === 'web' ? !!localStreamRef.current : (!!localStreamUrl && !!RTCView));
  const isVideoCall = isVideoParam === '1' || isVideoParam === 'true';

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Remote video (full screen) — native. `peerVideoEnabled` gate is
          required: RTCView keeps the last frame painted after peer disables
          their camera, so without this we'd freeze on the last image. */}
      {Platform.OS !== 'web' && RTCView && remoteStreamUrl && videoEnabled && peerConnected && peerVideoEnabled && (
        <RTCView
          streamURL={remoteStreamUrl}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
          zOrder={0}
        />
      )}

      {/* Subtle vignette / blur around remote video — brand-purple soft
          edge so the remote frame reads cinematic instead of butting
          flush against the black bezel. Web uses real backdropFilter,
          native falls back to a dark vignette ring. Sits between the
          video (zOrder 0) and the overlay UI (zIndex 5). */}
      {showRemoteVideo && (
        <View pointerEvents="none" style={styles.videoVignette}>
          <View style={styles.videoVignetteTop} />
          <View style={styles.videoVignetteBottom} />
          <View style={styles.videoVignetteEdgeLeft} />
          <View style={styles.videoVignetteEdgeRight} />
        </View>
      )}

      {/* Tap area to toggle controls in video mode */}
      <TouchableOpacity
        activeOpacity={1}
        onPress={handleScreenTap}
        style={StyleSheet.absoluteFill}
      >
        {/* Audio-only overlay / video overlay */}
        <View style={[styles.audioOverlay, {
          backgroundColor: showRemoteVideo ? 'transparent' : (isVideoCall ? '#064e3b' : '#1a1a2e'),
        }]}>
          {/* Status strip — FaceTime parity. Signal bars left, duration
              center, PiP right. Sits above the WhatsApp-style top bar so
              the eye finds connection quality + duration at a glance
              without scanning the (longer) name/status line. */}
          {peerConnected && !ended && (
            <Animated.View
              pointerEvents="box-none"
              style={[styles.statusStrip, {
                paddingTop: insets.top + 8,
                opacity: Animated.multiply(controlsFadeAnim, barEnterAnim),
                transform: [{
                  translateY: barEnterAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-12, 0],
                  }),
                }],
              }]}
            >
              <View style={styles.statusStripSide}>
                <SignalBars quality={connectionQuality} score={qualityScore} rtt={rttMs} />
              </View>
              <View style={styles.statusStripCenter} pointerEvents="none">
                <Text style={styles.statusStripDuration} accessibilityLabel={t('call.duration') || 'Duração'}>
                  {formatDuration(callDuration)}
                </Text>
              </View>
              <View style={[styles.statusStripSide, { justifyContent: 'flex-end' }]}>
                <TouchableOpacity
                  onPress={handleMinimize}
                  style={styles.pipBtn}
                  accessibilityLabel={t('call.pip') || 'Picture-in-picture'}
                  accessibilityRole="button"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
                    {/* Outer screen */}
                    <SvgPath
                      d="M3 6.5A2.5 2.5 0 015.5 4h13A2.5 2.5 0 0121 6.5v11a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 17.5v-11z"
                      stroke="#fff"
                      strokeWidth={1.6}
                      fill="none"
                    />
                    {/* Inner PiP rectangle */}
                    <SvgPath
                      d="M12.5 12h6v5h-6z"
                      fill="#fff"
                    />
                  </Svg>
                </TouchableOpacity>
              </View>
            </Animated.View>
          )}

          {/* Top bar - WhatsApp style */}
          <Animated.View style={[styles.topBar, { paddingTop: peerConnected && !ended ? 4 : insets.top + 10, opacity: controlsFadeAnim }]}>
            <TouchableOpacity onPress={handleMinimize} style={styles.backBtn} accessibilityLabel={t('call.minimize') || 'Minimizar'}>
              <IconChevronDown size={22} color="#fff" />
            </TouchableOpacity>
            <View style={styles.topInfo}>
              <Text style={styles.topName} numberOfLines={1}>{callerName}</Text>
              {!peerConnected && (
                <Text style={[styles.topStatus, reconnecting && { color: '#f59e0b' }]}>{statusText}</Text>
              )}
              {peerConnected && (onHold || screenSharing || peerScreenSharing) && (
                <Text style={[styles.topStatus, reconnecting && { color: '#f59e0b' }]}>
                  {onHold ? (t('call.onHold') || 'Em espera')
                    : screenSharing ? (t('call.screenSharing') || 'Compartilhando tela')
                    : (t('call.peerSharing') || 'Tela compartilhada')}
                </Text>
              )}
            </View>
            {/* Encryption indicator - WhatsApp style. SVG lock per project
                guideline (no emoji in UI chrome). */}
            {peerConnected && (
              <View style={styles.encryptionBadge}>
                <Svg width={11} height={11} viewBox="0 0 24 24" fill="none">
                  <SvgPath
                    d="M7 11V8a5 5 0 0110 0v3M5 11h14v9H5z"
                    stroke="rgba(255,255,255,0.85)"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </Svg>
                <Text style={[styles.encryptionText, { marginLeft: 4 }]}>E2E</Text>
              </View>
            )}
          </Animated.View>

          {/* Raised-hand banner — only the host (call starter) sees the
              full list. Compact chip per raised hand, ordered by ts. Hides
              automatically when raisedHands clears. */}
          {isGroupCall && isCaller && raisedHands.size > 0 && peerConnected && !ended && (
            <View style={styles.handRaiseBanner}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" style={{ marginRight: 6 }}>
                <SvgPath d="M9 11V5.5a1.5 1.5 0 113 0V11M12 11V4a1.5 1.5 0 113 0v8M15 11V5a1.5 1.5 0 113 0v8.5M9 11V8.5a1.5 1.5 0 10-3 0V14a6 6 0 0012 0v-1.5" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
              <Text style={styles.handRaiseBannerText} numberOfLines={1}>
                {(() => {
                  const arr = Array.from(raisedHands.entries()).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
                  const names = arr.map(([, v]) => v.name || 'Participante').slice(0, 3).join(', ');
                  const extra = arr.length > 3 ? ` +${arr.length - 3}` : '';
                  return `${names}${extra} · ${t('call.handRaisedSuffix') || 'mão levantada'}`;
                })()}
              </Text>
            </View>
          )}

          {/* Recording indicator banner */}
          {(isRecording || remoteIsRecording) && peerConnected && !ended && (
            <View style={styles.recordingBanner}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingBannerText}>
                {isRecording && remoteIsRecording
                  ? (t('call.bothRecording') || 'Both sides recording')
                  : isRecording
                    ? (t('call.recording') || 'Recording...')
                    : (t('call.remoteRecording') || 'Other party is recording')}
              </Text>
            </View>
          )}

          {/* Reconnecting overlay — shown during ICE restart (network flap,
              wifi↔cellular handoff). WhatsApp parity: user sees clear status
              instead of frozen screen until ICE renegotiation completes.
              Pre-connect we show the loud orange banner; post-connect (media
              still flowing through ICE restart) we show the subtle one below. */}
          {reconnecting && !ended && !peerConnected && (
            <Animated.View
              style={[styles.reconnectBanner, {
                // Slide-down from the top inset edge as the banner appears.
                transform: [{
                  translateY: barEnterAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-40, 0],
                  }),
                }],
              }]}
            >
              {/* Signal-loss SVG — broadcast tower with a slash, brand-amber. */}
              <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" style={{ marginRight: 8 }}>
                <SvgPath d="M5 12c2-2 5-2 7 0M3 9c4-4 11-4 15 0M7 15c1-1 3-1 4 0" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                <SvgCircleHand cx={12} cy={18.5} r={1.3} fill="#fff" />
                <SvgLine x1={3} y1={21} x2={21} y2={3} stroke="#fff" strokeWidth={1.6} strokeLinecap="round" opacity={0.7} />
              </Svg>
              <Text style={styles.reconnectBannerText}>{t('call.reconnecting') || 'Reconectando…'}</Text>
              <ActivityIndicator size="small" color="rgba(255,255,255,0.9)" style={{ marginLeft: 8 }} />
            </Animated.View>
          )}

          {/* Subtle reconnect micro-banner — peerConnected but ICE is
              renegotiating. Lower-key tinted background so it doesn't yell
              when media is still flowing. Fades in/out via reconnectMicroFade. */}
          {!ended && (
            <Animated.View
              pointerEvents="none"
              style={[styles.weakBanner, {
                backgroundColor: 'rgba(255,165,0,0.15)',
                opacity: reconnectMicroFade,
              }]}
            >
              <Text style={[styles.weakBannerText, { color: 'rgba(255,255,255,0.85)', fontSize: 12 }]}>
                {t('call.reconnecting') || 'Reconectando…'}
              </Text>
            </Animated.View>
          )}

          {/* Weak connection warning banner */}
          {showWeakBanner && peerConnected && !ended && !reconnecting && (
            <View style={styles.weakBanner}>
              <Text style={styles.weakBannerText}>{t('call.poorConnection') || 'Conexao fraca'}</Text>
            </View>
          )}

          {/* wave w3 — "Conexão instável" pill: sustained >5% packet loss
              for >10s, even if RTT-based score didn't drop. Distinct from
              the weak banner because the user may NOT see RTT spikes but
              IS hearing choppy audio (loss-only path). Hidden when reconnecting
              or weak-banner is already showing to avoid stacking. */}
          {showUnstable && peerConnected && !ended && !reconnecting && !showWeakBanner && (
            <View style={[styles.weakBanner, { backgroundColor: 'rgba(202,138,4,0.92)' }]}>
              <Text style={styles.weakBannerText}>{t('call.unstableConnection') || 'Conexão instável'}</Text>
            </View>
          )}

          {/* wave w3 — audio stall alert: peer's audio bytesReceived hasn't
              ticked for 3+ samples. Means RemoteAudioTrack stalled. Red
              backdrop because it's worse than a quality drop (no audio at
              all). User can then bail and redial instead of waiting. */}
          {audioStalled && peerConnected && !ended && (
            <View style={[styles.weakBanner, { backgroundColor: 'rgba(127,29,29,0.92)' }]}>
              <Text style={[styles.weakBannerText, { flex: 1 }]} numberOfLines={2}>
                {t('call.audioStalled') || 'Sem áudio do outro lado'}
              </Text>
            </View>
          )}

          {/* TURN refresh failure toast — surfaced after 3 strikes from
              webrtc.js. Tells the user we can't relay if they roam to a
              network that needs TURN; auto-fades after 4s. (audit gap #5) */}
          {turnFailedToast && !ended && (
            <View style={[styles.weakBanner, { backgroundColor: 'rgba(127,29,29,0.92)' }]}>
              <Text style={[styles.weakBannerText, { flex: 1 }]} numberOfLines={2}>
                {t?.('call.turnFailedReducedQuality') || 'Qualidade reduzida (sem relay disponível)'}
              </Text>
            </View>
          )}

          {/* Outgoing video upgrade request toast — non-blocking. Shows
              regressive countdown + cancel button. Auto-dismisses on
              accept / decline / timeout (handled in WS listener). */}
          {videoUpgradeToast && !ended && (
            <View style={[styles.weakBanner, { backgroundColor: 'rgba(31,41,55,0.92)', flexDirection: 'row', justifyContent: 'space-between' }]}>
              <Text style={[styles.weakBannerText, { flex: 1 }]} numberOfLines={1}>
                {(t('call.videoRequestSentBody') || 'Aguardando aceitação...') + ' ' + videoUpgradeToast.secondsLeft + 's'}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  // Tell peer we're abandoning the request so their incoming
                  // prompt clears too; then reset our local state.
                  try {
                    sendSignaling('call_video_request', {
                      call_id: callId,
                      target_email: contactEmail,
                      action: 'cancel',
                    });
                  } catch {}
                  videoUpgradeRequestedRef.current = false;
                  if (videoUpgradeTimeoutRef.current) {
                    clearTimeout(videoUpgradeTimeoutRef.current);
                    videoUpgradeTimeoutRef.current = null;
                  }
                  if (videoUpgradeCountdownRef.current) {
                    clearInterval(videoUpgradeCountdownRef.current);
                    videoUpgradeCountdownRef.current = null;
                  }
                  setVideoUpgradeToast(null);
                }}
                style={{ marginLeft: 12, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.18)' }}
                accessibilityLabel={t('call.cancel') || 'Cancelar'}
              >
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>
                  {t('call.cancel') || 'Cancelar'}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Screen sharing banner — you are sharing */}
          {screenSharing && peerConnected && !ended && (
            <View style={[styles.screenShareBanner, (isRecording || remoteIsRecording) && { top: 120 }]}>
              <IconScreenShare size={16} color="#fff" />
              <Text style={styles.screenShareBannerText}>
                {t('call.youAreSharing') || 'You are sharing your screen'}
              </Text>
              <TouchableOpacity
                onPress={handleScreenShare}
                style={styles.screenShareStopBtn}
                activeOpacity={0.7}
              >
                <Text style={styles.screenShareStopBtnText}>{t('call.stopSharing') || 'Stop'}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Peer screen sharing indicator */}
          {peerScreenSharing && peerConnected && !ended && !screenSharing && (
            <View style={[styles.peerScreenShareBanner, (isRecording || remoteIsRecording) && { top: 120 }]}>
              <IconScreenShare size={16} color="#fff" />
              <Text style={styles.screenShareBannerText}>
                {t('call.peerSharing') || 'Peer is sharing their screen'}
              </Text>
            </View>
          )}

          {/* Peer muted indicator */}
          {remoteAudioMuted && peerConnected && !ended && !peerOnHold && (
            <View style={styles.peerMutedBanner}>
              <IconMicOff size={14} color="#fff" />
              <Text style={styles.peerMutedBannerText}>
                {(t('call.peerMuted') || '{name} está no mudo').replace('{name}', callerName)}
              </Text>
            </View>
          )}

          {/* Peer hold indicator — takes precedence over muted banner. */}
          {peerOnHold && peerConnected && !ended && (
            <View style={styles.peerMutedBanner}>
              <IconPause size={14} color="#fff" />
              <Text style={styles.peerMutedBannerText}>
                {(t('call.peerOnHold') || '{name} em espera').replace('{name}', callerName)}
              </Text>
            </View>
          )}

          {/* Peer wants to switch to video — accept/decline sheet.
              WhatsApp/iMessage-style: icon + title + 2 round pill buttons
              with explicit color semantics (green=accept, red=decline) +
              decline icon X / accept icon Video. The earlier flat slab with
              a single purple "Aceitar" button was confusing — users couldn't
              tell which side accepted without reading. */}
          {pendingVideoRequest && peerConnected && !ended && (
            <View style={styles.videoRequestSheet}>
              <View style={styles.videoRequestIconCircle}>
                <IconVideo size={28} color="#fff" />
              </View>
              <Text style={styles.videoRequestTitle}>
                {(t('call.videoRequestTitle') || '{name} quer ativar o vídeo').replace('{name}', callerName)}
              </Text>
              <Text style={styles.videoRequestSubtitle}>
                {t('call.videoRequestSubtitle') || 'Aceitar ativa sua câmera também'}
              </Text>
              <View style={styles.videoRequestActions}>
                <TouchableOpacity
                  style={[styles.videoRequestBtn, styles.videoRequestBtnDecline]}
                  activeOpacity={0.85}
                  onPress={() => {
                    try {
                      sendSignaling('call_video_request', {
                        call_id: callId,
                        target_email: contactEmail,
                        action: 'declined',
                      });
                    } catch {}
                    setPendingVideoRequest(null);
                  }}
                >
                  <IconX size={18} color="#fff" />
                  <Text style={styles.videoRequestBtnText}>{t('common.decline') || 'Recusar'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.videoRequestBtn, styles.videoRequestBtnAccept]}
                  activeOpacity={0.85}
                  onPress={() => {
                    try {
                      sendSignaling('call_video_request', {
                        call_id: callId,
                        target_email: contactEmail,
                        action: 'accepted',
                      });
                    } catch {}
                    setPendingVideoRequest(null);
                    // Acceptor needs the flag SET so handleToggleVideo skips
                    // the "send request" branch and goes straight to the
                    // enable-camera path. Without this, acceptor would ping
                    // a fresh request back at the original requester.
                    videoUpgradeRequestedRef.current = true;
                    if (!videoEnabled) handleToggleVideo();
                  }}
                >
                  <IconVideo size={18} color="#fff" />
                  <Text style={[styles.videoRequestBtnText, { color: '#fff' }]}>{t('common.accept') || 'Aceitar'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Suggest audio-only when quality is very bad */}
          {suggestAudioOnly && peerConnected && !ended && (
            <TouchableOpacity
              style={styles.audioOnlyBanner}
              onPress={() => {
                handleToggleVideo();
                setSuggestAudioOnly(false);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.audioOnlyBannerText}>
                {t('call.suggestAudioOnly') || 'Conexao muito fraca. Toque para desativar o video.'}
              </Text>
            </TouchableOpacity>
          )}

          {/* Center - Avatar (shown when no video or not connected yet) */}
          {!showRemoteVideo && (
            <View style={styles.centerArea}>
              {/* Pulse rings behind avatar */}
              {!peerConnected && (
                <>
                  <Animated.View style={[styles.pulseRing, styles.pulseRingOuter, {
                    transform: [{ scale: pulseAnim }],
                    opacity: Animated.subtract(1, Animated.multiply(pulseAnim, 0.5)),
                  }]} />
                  <Animated.View style={[styles.pulseRing, styles.pulseRingInner, {
                    transform: [{ scale: pulseAnim }],
                  }]} />
                </>
              )}
              <Animated.View style={{ transform: [{ scale: peerConnected ? 1 : pulseAnim }] }}>
                {/* Audio-only gets a larger, more presentational avatar
                    (FaceTime parity). Video upgrade requests / audio-only
                    calls keep the smaller 140 footprint to leave space
                    for the local PiP and reaction row. */}
                <AvatarCircle name={callerName} email={_safePeerEmail} size={isVideoCall ? 140 : 168} />
                {/* Raised-hand overlay — appears on the contact's avatar
                    when they (or, in 1:1, the only remote) have their hand
                    up. In group calls each peer's tile would render its own;
                    here we surface raisedHands.has(contactEmail). */}
                {(() => {
                  if (!isGroupCall) return null;
                  const key = (contactEmail || '').toLowerCase();
                  if (!key || !raisedHands.has(key)) return null;
                  return (
                    <View style={styles.handRaiseOverlay}>
                      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
                        <SvgPath d="M9 11V5.5a1.5 1.5 0 113 0V11M12 11V4a1.5 1.5 0 113 0v8M15 11V5a1.5 1.5 0 113 0v8.5M9 11V8.5a1.5 1.5 0 10-3 0V14a6 6 0 0012 0v-1.5" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                      </Svg>
                    </View>
                  );
                })()}
                {/* When the local user has their hand raised, mirror the
                    same chip near the avatar so they see their own state. */}
                {isGroupCall && handRaised && (
                  <View style={[styles.handRaiseOverlay, { right: -8, top: -8, backgroundColor: '#fbbf24' }]}>
                    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
                      <SvgPath d="M9 11V5.5a1.5 1.5 0 113 0V11M12 11V4a1.5 1.5 0 113 0v8M15 11V5a1.5 1.5 0 113 0v8.5M9 11V8.5a1.5 1.5 0 10-3 0V14a6 6 0 0012 0v-1.5" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                    </Svg>
                  </View>
                )}
              </Animated.View>
              <Text style={[styles.centerName, !isVideoCall && styles.centerNameAudio]} numberOfLines={1}>{callerName}</Text>
              <Text style={[styles.centerStatus, connectionFailed && { color: '#ef4444' }]}>{statusText}</Text>
              {ended && (
                <Text style={styles.endedHint}>{t('call.ended') || 'Chamada encerrada'}</Text>
              )}
              {connectionFailed && !ended && (
                <View style={styles.reconnectContainer}>
                  <TouchableOpacity
                    style={styles.reconnectBtn}
                    onPress={handleReconnect}
                    activeOpacity={0.7}
                  >
                    <IconPhone size={18} color="#fff" />
                    <Text style={styles.reconnectBtnText}>{t('call.reconnect') || 'Reconectar'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.reconnectEndBtn}
                    onPress={handleEndCall}
                    activeOpacity={0.7}
                  >
                    <IconPhoneOff size={18} color="#fff" />
                    <Text style={styles.reconnectEndBtnText}>{t('call.hangUp') || 'Desligar'}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* When video connected, show minimal overlay */}
          {showRemoteVideo && (
            <View style={styles.centerArea}>
              <View style={{ flex: 1 }} />
              {ended && (
                <Text style={styles.endedHint}>{t('call.ended') || 'Chamada encerrada'}</Text>
              )}
            </View>
          )}
        </View>
      </TouchableOpacity>

      {/* Floating emoji reactions */}
      {floatingEmojis.map(({ id, emoji, x, anim }) => (
        <Animated.View
          key={id}
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: x,
            bottom: 200,
            zIndex: 50,
            opacity: anim.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 1, 0] }),
            transform: [{
              translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [0, -SCREEN_H * 0.5] }),
            }, {
              scale: anim.interpolate({ inputRange: [0, 0.15, 0.3, 1], outputRange: [0.3, 1.3, 1, 0.8] }),
            }],
          }}
        >
          <Text style={{ fontSize: 48 }}>{emoji}</Text>
        </Animated.View>
      ))}

      {/* Local video preview (picture-in-picture) — draggable */}
      {Platform.OS !== 'web' && RTCView && localStreamUrl && videoEnabled && (
        <Animated.View
          {...pipPanResponder.panHandlers}
          style={[styles.localVideoContainer, { transform: pipPosition.getTranslateTransform() }]}
        >
          <RTCView
            streamURL={localStreamUrl}
            style={styles.localVideo}
            objectFit="cover"
            mirror={facingFront}
            zOrder={1}
          />
          <TouchableOpacity style={styles.pipFlipBtn} onPress={handleFlipCamera} activeOpacity={0.7}>
            <IconCameraFlip size={16} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* "More" bottom sheet — emoji reactions + video effects */}
      {showMoreSheet && peerConnected && !ended && (
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setShowMoreSheet(false)}
          style={styles.moreSheetOverlay}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.moreSheet, { paddingBottom: insets.bottom + 20 }]}>
            {/* Drag handle */}
            <View style={styles.moreSheetHandle} />

            {/* Emoji reactions section */}
            <Text style={styles.moreSheetSectionTitle}>{t('call.reactions') || 'Reacoes'}</Text>
            <View style={styles.moreSheetEmojiRow}>
              {CALL_EMOJIS.map(emoji => (
                <TouchableOpacity key={emoji} onPress={() => { handleSendEmoji(emoji); setShowMoreSheet(false); }} style={styles.emojiBtnItem}>
                  <Text style={{ fontSize: 32 }}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Advanced controls — moved out of the always-on top row to
                avoid label truncation on narrow phones (Hold + Noise were
                pushing the row past the screen edge). */}
            <Text style={[styles.moreSheetSectionTitle, { marginTop: 16 }]}>{t('call.controls') || 'Controles'}</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={() => { handleToggleHold(); setShowMoreSheet(false); }}
                style={[styles.recordSheetBtn, { flex: 1 }]}
                activeOpacity={0.7}
              >
                <View style={[styles.recordSheetIcon, onHold && styles.recordSheetIconActive]}>
                  {onHold ? <IconPlay size={20} color={onHold ? '#fff' : '#7C3AED'} /> : <IconPause size={20} color="#7C3AED" />}
                </View>
                <Text style={styles.recordSheetLabel}>{onHold ? (t('call.unhold') || 'Retomar') : (t('call.hold') || 'Espera')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { handleToggleNoiseCancellation(); setShowMoreSheet(false); }}
                style={[styles.recordSheetBtn, { flex: 1 }]}
                activeOpacity={0.7}
              >
                <View style={[styles.recordSheetIcon, noiseCancellation && styles.recordSheetIconActive]}>
                  <IconZap size={20} color={noiseCancellation ? '#fff' : '#7C3AED'} />
                </View>
                <Text style={styles.recordSheetLabel}>{noiseCancellation ? (t('call.noiseOn') || 'Ruído ON') : (t('call.noiseOff') || 'Ruído OFF')}</Text>
              </TouchableOpacity>
            </View>

            {/* Record call section */}
            <Text style={[styles.moreSheetSectionTitle, { marginTop: 16 }]}>{t('call.recordSection') || 'Record'}</Text>
            <TouchableOpacity
              onPress={() => { handleToggleRecording(); setShowMoreSheet(false); }}
              style={styles.recordSheetBtn}
              activeOpacity={0.7}
            >
              <View style={[styles.recordSheetIcon, isRecording && styles.recordSheetIconActive]}>
                <IconRecord size={20} color={isRecording ? '#fff' : '#ef4444'} />
              </View>
              <Text style={styles.recordSheetLabel}>
                {isRecording ? (t('call.stopRecording') || 'Stop recording') : (t('call.startRecording') || 'Record call')}
              </Text>
            </TouchableOpacity>

            {/* Video filters section — only when video is enabled */}
            {videoEnabled && (
              <>
                <Text style={[styles.moreSheetSectionTitle, { marginTop: 16 }]}>{t('call.effects') || 'Efeitos'}</Text>
                <View style={styles.moreSheetFilterRow}>
                  {VIDEO_FILTERS.map(f => (
                    <TouchableOpacity
                      key={f.key || 'none'}
                      onPress={() => { setActiveFilter(f.key); setShowMoreSheet(false); }}
                      style={[styles.filterItem, activeFilter === f.key && styles.filterItemActive]}
                    >
                      <View style={[styles.filterDot, { backgroundColor: f.color }]} />
                      <Text style={styles.filterLabel}>{f.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      {/* Bottom controls — WhatsApp style: 2 rows.
          Only `!ended` gates the row: previously `!connectionFailed` also
          hid it, which meant if the call failed mid-video (RTCView still
          painted the last remote frame) the user lost every visible
          button — read as a frozen/white screen with no way to hang up.
          The centerArea reconnect/end fallback only shows when
          `!showRemoteVideo`, so we must keep this hangup reachable in all
          other states. */}
      {!ended && (
        <Animated.View style={[styles.controlsBar, {
          paddingBottom: insets.bottom + 16,
          // controlsFadeAnim handles tap-to-hide. barEnterAnim drives the
          // mount entrance (slide-up + fade) — multiplied so the entrance
          // wins on first paint and tap-fade wins thereafter.
          opacity: Animated.multiply(controlsFadeAnim, barEnterAnim),
          transform: [{
            translateY: barEnterAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [28, 0],
            }),
          }],
        }]}>
          {/* Secondary row: advanced controls (noise, hand, screen-share,
              add participant, filters, more). The primary 5-button row
              below carries mute / video / hangup / camera / speaker. */}
          <View style={styles.controlsRowTop}>
            {/* Noise suppression toggle — surfaces the existing
                noiseSuppression constraint (was buried in the More sheet).
                Distinct icon for on (waveform line) vs off (waveform with
                a slash) so the state is glance-able. */}
            <TouchableOpacity
              style={styles.controlBtn}
              onPress={handleToggleNoiseCancellation}
              activeOpacity={0.7}
              accessibilityLabel={noiseCancellation ? (t('call.noiseOn') || 'Ruído ON') : (t('call.noiseOff') || 'Ruído OFF')}
              accessibilityRole="button"
            >
              <View style={[styles.controlBtnCircle, noiseCancellation && styles.controlBtnCircleActive]}>
                <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
                  {/* Waveform — symmetric vertical bars resembling audio levels */}
                  <SvgLine x1="4" y1="10" x2="4" y2="14" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
                  <SvgLine x1="8" y1="7" x2="8" y2="17" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
                  <SvgLine x1="12" y1="4" x2="12" y2="20" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
                  <SvgLine x1="16" y1="7" x2="16" y2="17" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
                  <SvgLine x1="20" y1="10" x2="20" y2="14" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
                  {!noiseCancellation && (
                    <SvgLine x1="3" y1="21" x2="21" y2="3" stroke="#ef4444" strokeWidth={2.4} strokeLinecap="round" />
                  )}
                </Svg>
              </View>
              <Text style={styles.controlLabel} numberOfLines={1}>
                {noiseCancellation ? (t('call.noiseOn') || 'Ruído ON') : (t('call.noiseOff') || 'Ruído OFF')}
              </Text>
            </TouchableOpacity>

            {/* Raise hand — group call only. Toggles handRaised state and
                signals call_hand_raise to peers. ✋ palette + waving lines
                kept in plain SVG (no emoji per project guidelines). */}
            {isGroupCall && (
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={handleToggleHandRaise}
                activeOpacity={0.7}
                accessibilityLabel={handRaised ? (t('call.handLower') || 'Abaixar mão') : (t('call.handRaise') || 'Levantar mão')}
                accessibilityRole="button"
              >
                <View style={[styles.controlBtnCircle, handRaised && styles.controlBtnCircleActive]}>
                  <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
                    {/* Stylized open palm: thumb + 4 fingers */}
                    <SvgPath
                      d="M9 11V5.5a1.5 1.5 0 113 0V11M12 11V4a1.5 1.5 0 113 0v8M15 11V5a1.5 1.5 0 113 0v8.5M9 11V8.5a1.5 1.5 0 10-3 0V14a6 6 0 0012 0v-1.5"
                      stroke="#fff"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </Svg>
                </View>
                <Text style={styles.controlLabel} numberOfLines={1}>
                  {handRaised ? (t('call.handLower') || 'Abaixar') : (t('call.handRaise') || 'Mão')}
                </Text>
              </TouchableOpacity>
            )}

            {/* Screen share — sempre visivel. Antes era gated por
                peerConnected, dando sensacao de "botao quebrado" durante o
                ringing. Agora aparece disabled (label "Aguardando...") ate
                conectar. */}
            <TouchableOpacity
              style={[styles.controlBtn, !peerConnected && { opacity: 0.45 }]}
              onPress={peerConnected ? handleScreenShare : undefined}
              disabled={!peerConnected}
              activeOpacity={0.7}
              accessibilityLabel={t('call.screenShare') || 'Tela'}
            >
              <View style={[styles.controlBtnCircle, screenSharing && styles.controlBtnCircleScreenShare]}>
                <IconScreenShare size={22} color="#fff" />
              </View>
              <Text style={styles.controlLabel} numberOfLines={1}>{t('call.screenShare') || 'Tela'}</Text>
            </TouchableOpacity>

            {/* Add participant — agora visivel em 1:1 tambem. Antes so
                aparecia em group call, deixando user achando que estava
                "quebrado". Em 1:1, o ack vai upgradar pra group via
                chat_call_invite. */}
            {peerConnected && (
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={() => setShowAddParticipant(true)}
                activeOpacity={0.7}
                accessibilityLabel={t('call.addParticipant') || 'Adicionar'}
                accessibilityRole="button"
              >
                <View style={styles.controlBtnCircle}>
                  <IconUserPlus size={22} color="#fff" />
                </View>
                <Text style={styles.controlLabel} numberOfLines={1}>{t('call.addParticipant') || 'Adicionar'}</Text>
              </TouchableOpacity>
            )}

            {/* Filters — hidden until real-time video processing lands as a
                native module (react-native-vision-camera + frame processor).
                The previous button was a stub that toggled state but never
                applied anything to the stream — reported 2026-05-12. */}
            {false && videoEnabled && peerConnected && (
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={() => setShowFilterPicker(prev => !prev)}
                activeOpacity={0.7}
                accessibilityLabel={t('call.filters') || 'Efeitos'}
                accessibilityRole="button"
              >
                <View style={[styles.controlBtnCircle, showFilterPicker && styles.controlBtnCircleActive]}>
                  <IconSparkles size={22} color="#fff" />
                </View>
                <Text style={styles.controlLabel} numberOfLines={1}>{t('call.filters') || 'Efeitos'}</Text>
              </TouchableOpacity>
            )}

            {/* More — opens the More sheet (record / hold / advanced) */}
            {peerConnected && (
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={() => setShowMoreSheet(prev => !prev)}
                activeOpacity={0.7}
                accessibilityLabel={t('call.more') || 'Mais'}
                accessibilityRole="button"
              >
                <View style={[styles.controlBtnCircle, showMoreSheet && styles.controlBtnCircleActive]}>
                  <IconMoreHorizontal size={22} color="#fff" />
                </View>
                <Text style={styles.controlLabel} numberOfLines={1}>{t('call.more') || 'Mais'}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Quick-reactions row — FaceTime parity. Long-press the "more"
              button (or anywhere on the controls bar) to reveal. Floats
              just above the primary row so the user can tap an emoji
              without moving their thumb far. Auto-fades after 4s. */}
          {showQuickReactions && peerConnected && !ended && (
            <View style={styles.quickReactionsRow}>
              {['❤️', '🎉', '👏', '😂', '😮'].map(emoji => (
                <TouchableOpacity
                  key={emoji}
                  onPress={() => {
                    handleSendEmoji(emoji);
                    setShowQuickReactions(false);
                    if (quickReactionsTimerRef.current) {
                      clearTimeout(quickReactionsTimerRef.current);
                      quickReactionsTimerRef.current = null;
                    }
                  }}
                  style={styles.quickReactionBtn}
                  accessibilityLabel={`React ${emoji}`}
                  activeOpacity={0.7}
                >
                  <Text style={{ fontSize: 30 }}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Primary row — 5 big 56pt buttons (FaceTime/WhatsApp parity).
              Mute, video, HANGUP (destaked red, larger), switch camera,
              speaker. Hangup sits center-large; everything else uses the
              same 56pt circle so the row feels structured. Long-press the
              row to reveal quick reactions. Filters/more/raise-hand etc.
              live in the wrapping top row above + More sheet. */}
          <Pressable
            style={styles.controlsRowPrimary}
            onLongPress={() => {
              if (!peerConnected) return;
              _hapticTap('medium');
              setShowQuickReactions(true);
              if (quickReactionsTimerRef.current) clearTimeout(quickReactionsTimerRef.current);
              quickReactionsTimerRef.current = setTimeout(() => setShowQuickReactions(false), 4000);
            }}
            delayLongPress={350}
          >
            {/* Mute */}
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={handleToggleMute}
              activeOpacity={0.7}
              accessibilityLabel={audioMuted ? (t('call.unmute') || 'Ativar som') : (t('call.mute') || 'Silenciar')}
              accessibilityRole="button"
            >
              <View style={[styles.primaryBtnCircle, audioMuted && styles.primaryBtnCircleActive]}>
                {audioMuted ? <IconMicOff size={26} color="#fff" /> : <IconMic size={26} color="#fff" />}
              </View>
              <Text style={styles.primaryBtnLabel} numberOfLines={1}>{audioMuted ? (t('call.unmute') || 'Som') : (t('call.mute') || 'Mudo')}</Text>
            </TouchableOpacity>

            {/* Video toggle */}
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={handleToggleVideo}
              activeOpacity={0.7}
              accessibilityLabel={videoEnabled ? (t('call.videoOff') || 'Desligar vídeo') : (t('call.videoOn') || 'Ligar vídeo')}
              accessibilityRole="button"
            >
              <View style={[styles.primaryBtnCircle, videoEnabled && styles.primaryBtnCircleActive]}>
                {videoEnabled ? <IconVideo size={26} color="#fff" /> : <IconVideoOff size={26} color="#fff" />}
              </View>
              <Text style={styles.primaryBtnLabel} numberOfLines={1}>{t('call.video') || 'Vídeo'}</Text>
            </TouchableOpacity>

            {/* HANGUP — destaked red, slightly larger to read as primary
                action. Center of the row so right/left are balanced. */}
            <TouchableOpacity
              style={styles.primaryHangupBtn}
              onPress={handleEndCall}
              activeOpacity={0.7}
              accessibilityLabel={t('call.hangUp') || 'Desligar'}
              accessibilityRole="button"
            >
              <IconPhoneOff size={30} color="#fff" />
            </TouchableOpacity>

            {/* Switch camera — only when video is on. In audio-only calls,
                render an invisible spacer instead of a second "Mais" button
                (the secondary row already has one — the duplicate was the
                "2 Mais lado a lado" reported 2026-05-12). Keeps 5-slot
                symmetry without confusing the user with two More buttons. */}
            {videoEnabled ? (
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={handleFlipCamera}
                activeOpacity={0.7}
                accessibilityLabel={t('call.flipCamera') || 'Girar câmera'}
                accessibilityRole="button"
              >
                <View style={styles.primaryBtnCircle}>
                  <IconCameraFlip size={26} color="#fff" />
                </View>
                <Text style={styles.primaryBtnLabel} numberOfLines={1}>{t('call.flipCamera') || 'Girar'}</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.primaryBtn} pointerEvents="none" />
            )}

            {/* Speaker */}
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={handleToggleSpeaker}
              activeOpacity={0.7}
              accessibilityLabel={speakerOn ? (t('call.speakerOff') || 'Desligar viva-voz') : (t('call.speakerOn') || 'Viva-voz')}
              accessibilityRole="button"
            >
              <View style={[styles.primaryBtnCircle, speakerOn && styles.primaryBtnCircleActive]}>
                <IconVolume2 size={26} color="#fff" />
              </View>
              <Text style={styles.primaryBtnLabel} numberOfLines={1}>{t('call.speaker') || 'Som'}</Text>
            </TouchableOpacity>
          </Pressable>
        </Animated.View>
      )}

      {/* Add participant modal — opened by the "+" button in group call
          controls. Lists conversation members not yet in the call; tapping
          a row rings them via VoIP push (CallKit on iOS) so they can join
          the same LiveKit room without restarting the call. */}
      <Modal
        visible={showAddParticipant}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAddParticipant(false)}
      >
        <Pressable style={styles.addPartOverlay} onPress={() => setShowAddParticipant(false)}>
          <Pressable style={styles.addPartSheet} onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.addPartHeader}>
              <Text style={styles.addPartTitle}>{t('call.addParticipantTitle') || 'Adicionar à chamada'}</Text>
              <TouchableOpacity onPress={() => setShowAddParticipant(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <IconX size={22} color="#fff" />
              </TouchableOpacity>
            </View>
            {addParticipantCandidates.length === 0 ? (
              <Text style={styles.addPartEmpty}>{t('call.addParticipantEmpty') || 'Todos do grupo já estão na chamada.'}</Text>
            ) : (
              <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
                {addParticipantCandidates.map((m) => {
                  const email = m.email || '';
                  const name = m.display_name || m.name || email.split('@')[0];
                  return (
                    <TouchableOpacity
                      key={email}
                      style={styles.addPartRow}
                      onPress={() => handleInviteToCall(email)}
                      disabled={addParticipantBusy}
                      activeOpacity={0.7}
                    >
                      <AvatarCircle email={email} name={name} size={40} />
                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <Text style={styles.addPartName} numberOfLines={1}>{name}</Text>
                        <Text style={styles.addPartEmail} numberOfLines={1}>{email}</Text>
                      </View>
                      <View style={styles.addPartCallBtn}>
                        <IconPhone size={16} color="#fff" />
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Slow-connect overlay (#892 fix 3) — if we stay in pre-connect for
          >8s, paint an explicit "Conectando…" overlay with spinner over the
          rest of the call screen. Without this, a stuck pcState='new' (e.g.
          ICE gathering on a hostile network, TURN auth pending) looks like
          a hung black screen even though everything is alive. Surface the
          spinner + tappable hangup so the user always has a way out. */}
      {showSlowConnectOverlay && !peerConnected && !peerRinging && !ended && (
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: 'rgba(0,0,0,0.55)',
            zIndex: 998,
          }}
          accessibilityLiveRegion="polite"
          accessibilityLabel={t('call.connecting') || 'Conectando...'}
        >
          <View style={{
            paddingVertical: 20, paddingHorizontal: 28,
            borderRadius: 18,
            backgroundColor: 'rgba(20,20,28,0.92)',
            alignItems: 'center',
            maxWidth: 320,
          }}>
            <ActivityIndicator size="large" color="#7C3AED" />
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 14 }}>
              {t('call.connecting') || 'Conectando...'}
            </Text>
            <Text style={{ color: '#cbd5e1', fontSize: 12.5, marginTop: 6, textAlign: 'center', lineHeight: 17 }}>
              {t('call.slowConnectHint') || 'A conexão está demorando. Toque em desligar para tentar de novo.'}
            </Text>
            <TouchableOpacity
              onPress={() => { try { handleEndCallRef.current && handleEndCallRef.current(); } catch {} }}
              style={{
                marginTop: 16,
                paddingVertical: 10, paddingHorizontal: 22,
                backgroundColor: '#dc2626',
                borderRadius: 999,
                flexDirection: 'row', alignItems: 'center',
              }}
              accessibilityRole="button"
              accessibilityLabel={t('call.hangup') || 'Desligar'}
            >
              <IconPhoneOff size={16} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: '700', marginLeft: 8 }}>
                {t('call.hangup') || 'Desligar'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* End-state card — fades over the screen for ~1.5s after hangup so
          the user reads "Chamada encerrada · MM:SS" with the contact's
          avatar before /call pops back. FaceTime/Skype parity. Pointer
          events disabled so it never blocks the still-pending teardown. */}
      {ended && (
        <Animated.View
          pointerEvents="none"
          style={[styles.endCardOverlay, { opacity: endCardAnim }]}
        >
          <View style={styles.endCard}>
            <AvatarCircle name={callerName} email={_safePeerEmail} size={84} />
            <Text style={styles.endCardName} numberOfLines={1}>{callerName}</Text>
            <View style={styles.endCardRow}>
              <Text style={styles.endCardLabel} numberOfLines={1}>
                {t('call.ended') || 'Chamada encerrada'}
              </Text>
              {callDuration > 0 && (
                <>
                  <Text style={styles.endCardDot}>·</Text>
                  <Text style={styles.endCardDuration}>{formatDuration(callDuration)}</Text>
                </>
              )}
            </View>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  audioOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 5,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    zIndex: 10,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topInfo: {
    flex: 1,
    marginLeft: 12,
  },
  topName: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  topStatus: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    marginTop: 1,
  },
  encryptionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 3,
  },
  encryptionIcon: {
    fontSize: 10,
  },
  encryptionText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 10,
    fontWeight: '600',
  },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 180,
  },
  pulseRing: {
    position: 'absolute',
    borderRadius: 999,
    borderWidth: 1,
  },
  pulseRingOuter: {
    width: 200,
    height: 200,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  pulseRingInner: {
    width: 170,
    height: 170,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  centerName: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    marginTop: 24,
    textAlign: 'center',
  },
  centerStatus: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 15,
    marginTop: 6,
  },
  endedHint: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    marginTop: 12,
  },
  reconnectContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 24,
  },
  reconnectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#7C3AED',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 30,
  },
  reconnectBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  reconnectEndBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#ef4444',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 30,
  },
  reconnectEndBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  controlsBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    alignItems: 'center',
    paddingTop: 20,
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  controlsRowTop: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    rowGap: 12,
    columnGap: 18,
    marginBottom: 18,
  },
  controlsRowBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  controlsBottomSide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    minWidth: 64,
    flex: 1,
    justifyContent: 'center',
  },
  controlBtn: {
    alignItems: 'center',
    gap: 6,
    width: 60,
  },
  controlBtnPlaceholder: {
    width: 60,
  },
  controlBtnActive: {},
  controlBtnCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlBtnCircleActive: {
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  controlBtnCircleScreenShare: {
    backgroundColor: '#7C3AED',
  },
  controlLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 11,
    fontWeight: '500',
    textAlign: 'center',
  },
  endCallBtn: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  localVideoContainer: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 110,
    height: 156,
    borderRadius: 18,
    overflow: 'hidden',
    zIndex: 30,
    // Deeper shadow + hairline brand-purple ring so the PiP reads "lifted"
    // off the remote frame instead of butted flat against it (FaceTime
    // parity). Web ignores elevation; native uses it for Android raised
    // surface, iOS draws shadow from shadowColor/Opacity/Radius/Offset.
    elevation: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.32)',
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  localVideo: {
    flex: 1,
  },
  pipFlipBtn: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 28,
    paddingVertical: 10,
    paddingHorizontal: 12,
    zIndex: 40,
    ...Platform.select({
      web: { backdropFilter: 'blur(16px)' },
      default: {},
    }),
  },
  emojiBtnItem: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 20,
    paddingVertical: 12,
    paddingHorizontal: 16,
    zIndex: 40,
    ...Platform.select({
      web: { backdropFilter: 'blur(16px)' },
      default: {},
    }),
  },
  filterItem: {
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 12,
    gap: 4,
  },
  filterItemActive: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  filterDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  filterLabel: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '500',
  },
  controlBtnCircleHold: {
    backgroundColor: '#f59e0b',
  },
  recordingBanner: {
    position: 'absolute',
    top: 80,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(239, 68, 68, 0.9)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 15,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#fff',
    marginRight: 8,
  },
  recordingBannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  recordSheetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  recordSheetIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  recordSheetIconActive: {
    backgroundColor: '#ef4444',
  },
  recordSheetLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
  },
  weakBanner: {
    position: 'absolute',
    top: 100,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(239, 68, 68, 0.85)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
    zIndex: 15,
  },
  weakBannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  audioOnlyBanner: {
    position: 'absolute',
    top: 140,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(245, 158, 11, 0.9)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    zIndex: 15,
  },
  audioOnlyBannerText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
  screenShareBanner: {
    position: 'absolute',
    top: 80,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(124, 58, 237, 0.9)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    zIndex: 15,
  },
  screenShareBannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  screenShareStopBtn: {
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  screenShareStopBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  peerScreenShareBanner: {
    position: 'absolute',
    top: 80,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(59, 130, 246, 0.9)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: 15,
  },
  peerMutedBanner: {
    position: 'absolute',
    top: 80,
    alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    borderRadius: 18,
    paddingVertical: 6,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    zIndex: 16,
  },
  peerMutedBannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
  },
  // Raise-hand overlay sits in the avatar's top-right corner — bright
  // amber circle so it pops on both video bg and dark gradient bg.
  handRaiseOverlay: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f59e0b',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#000',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 4,
    zIndex: 8,
  },
  handRaiseBanner: {
    position: 'absolute',
    top: 70,
    alignSelf: 'center',
    backgroundColor: 'rgba(245, 158, 11, 0.95)',
    borderRadius: 18,
    paddingVertical: 6,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '85%',
    zIndex: 17,
  },
  handRaiseBannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
  },
  videoRequestSheet: {
    position: 'absolute',
    // Lifted from 180 → 240 so the sheet doesn't overlap the bottom call
    // controls (Mudo/Video/Hangup/Alto-falante). On phones with safe area
    // bottom inset (iPhone 14/15/16) the previous 180 was clipping the
    // controls behind the sheet — reported 2026-05-12 print.
    bottom: 240,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(20, 20, 26, 0.97)',
    borderRadius: 24,
    paddingTop: 28,
    paddingBottom: 20,
    paddingHorizontal: 24,
    zIndex: 30,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 12 },
    elevation: 24,
  },
  videoRequestIconCircle: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#7c3aed',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
    shadowColor: '#7c3aed',
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  videoRequestTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 6,
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  videoRequestSubtitle: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 22,
    lineHeight: 18,
  },
  videoRequestActions: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  videoRequestBtn: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  videoRequestBtnDecline: {
    backgroundColor: 'rgba(239, 68, 68, 0.9)',
  },
  videoRequestBtnAccept: {
    backgroundColor: '#22c55e',
    shadowColor: '#22c55e',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  videoRequestBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  },
  moreSheetOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 45,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  moreSheet: {
    backgroundColor: 'rgba(30,30,30,0.97)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    paddingHorizontal: 20,
    ...Platform.select({
      web: { backdropFilter: 'blur(20px)' },
      default: {},
    }),
  },
  moreSheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignSelf: 'center',
    marginBottom: 16,
  },
  moreSheetSectionTitle: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
    marginLeft: 4,
  },
  moreSheetEmojiRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 4,
  },
  moreSheetFilterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 8,
  },
  groupGallery: {
    position: 'absolute',
    top: 100,
    left: 4,
    right: 4,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 4,
    zIndex: 8,
  },
  groupGalleryCell: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  groupGalleryCellPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
  },
  groupGalleryNameBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  groupGalleryNameText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },

  // ── Add participant modal (R644) ──────────────────────────────────────
  addPartOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 16,
  },
  addPartSheet: {
    width: '100%', maxWidth: 420,
    backgroundColor: '#1c1c1e',
    borderRadius: 22, paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  addPartHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 10,
  },
  addPartTitle: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  addPartEmpty: { color: 'rgba(255,255,255,0.6)', textAlign: 'center', paddingVertical: 32, paddingHorizontal: 24, fontSize: 14, lineHeight: 20 },
  addPartRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 18,
    ...(Platform.OS === 'web' ? { transition: 'background-color 160ms ease', cursor: 'pointer' } : {}),
  },
  addPartName: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  addPartEmail: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '500', marginTop: 2 },
  addPartCallBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#25D366',
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 10,
  },

  // ── Polish round (FaceTime/WhatsApp parity) ────────────────────────────
  // Status strip — sits above the WhatsApp-style topBar. Signal bars left,
  // duration center (mm:ss), PiP button right.
  statusStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    zIndex: 11,
  },
  statusStripSide: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 24,
  },
  statusStripCenter: {
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusStripDuration: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.4,
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: 'hidden',
  },
  pipBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Audio-only avatar name — bigger / bolder than the video variant so
  // the call has a presentational subject when there's no remote frame.
  centerNameAudio: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -0.6,
    marginTop: 28,
  },

  // Remote-video vignette ring — soft brand-purple edges so the video
  // frame reads cinematic instead of butting against the black bezel.
  // 4 stripes (top/bottom/left/right) keep the GPU cost trivial vs a
  // real Gaussian blur.
  videoVignette: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  videoVignetteTop: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 90,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  videoVignetteBottom: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    height: 220,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  videoVignetteEdgeLeft: {
    position: 'absolute',
    top: 90, bottom: 220, left: 0,
    width: 14,
    backgroundColor: 'rgba(124,58,237,0.06)',
  },
  videoVignetteEdgeRight: {
    position: 'absolute',
    top: 90, bottom: 220, right: 0,
    width: 14,
    backgroundColor: 'rgba(124,58,237,0.06)',
  },

  // Primary 5-button row — mute, video, HANGUP (red), camera/more, speaker.
  // 56pt circles per FaceTime/WhatsApp; hangup is 64pt + brand red so it
  // reads as primary action without label noise.
  controlsRowPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginBottom: 4,
    gap: 6,
  },
  primaryBtn: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    flex: 1,
    gap: 6,
    paddingTop: 4,
  },
  primaryBtnCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnCircleActive: {
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  primaryBtnLabel: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: -0.1,
  },
  primaryHangupBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    shadowColor: '#ef4444',
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },

  // Quick reactions row — tap-and-hold the primary controls bar to reveal
  // 5 emojis (FaceTime parity). Auto-fades after 4s.
  quickReactionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 32,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 12,
    alignSelf: 'center',
    gap: 4,
    ...Platform.select({
      web: { backdropFilter: 'blur(12px)' },
      default: {},
    }),
  },
  quickReactionBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // End-state card — fades over the whole screen after hangup so the user
  // reads contact name + duration before /call pops back. Sits above
  // everything (zIndex 60) so even leftover banners don't bleed through.
  endCardOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 60,
    ...Platform.select({
      web: { backdropFilter: 'blur(18px)' },
      default: {},
    }),
  },
  endCard: {
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingVertical: 28,
    backgroundColor: 'rgba(28,28,32,0.92)',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    minWidth: 240,
    maxWidth: '80%',
  },
  endCardName: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginTop: 14,
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  endCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    gap: 6,
  },
  endCardLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontWeight: '500',
  },
  endCardDot: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    marginHorizontal: 2,
  },
  endCardDuration: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },

  // Reconnect slide-down banner — replaces the old flat weakBanner with a
  // dedicated row that includes a broadcast SVG + label + spinner. Sits at
  // the top of the screen so the user sees status without blocking the
  // center avatar or the action bar.
  reconnectBanner: {
    position: 'absolute',
    top: 80,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245,158,11,0.95)',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 16,
    zIndex: 18,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  reconnectBannerText: {
    color: '#fff',
    fontSize: 13.5,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
});

// Call-specific ErrorBoundary safety net (#892 fix 1). If a render path inside
// CallScreen throws (native module missing on stale build, null prop access
// on a midflight WebRTC callback, etc.) the generic app boundary would show
// a "tente novamente" page that does NOT end the still-alive WebRTC session —
// the user can't even hang up. Use a call-specific fallback with a single
// big red "Desligar" button that tears down via __chatyyTeardownActiveCall +
// router.back() so the silent render crash never traps the user mid-ringtone.
//
// Sentry reporting + crash_report beacon mirror the generic ErrorBoundary
// so post-mortems still land, tagged surface='call' for filtering.
class CallErrorBoundary extends React.Component {
  state = { hasError: false, error: null };
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, errorInfo) {
    console.error('[CallErrorBoundary]', error?.message, error?.stack, errorInfo?.componentStack);
    try {
      const { Sentry } = require('../services/sentry');
      Sentry.captureException(error, { tags: { surface: 'call' } });
    } catch {}
    try {
      fetch('https://chatyy.com.br/api/email.php?action=crash_report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: error?.message || 'CallScreen crash',
          stack: (error?.stack || '').substring(0, 3000),
          component: (errorInfo?.componentStack || '').substring(0, 2000),
          surface: 'call',
          fatal: true,
        }),
      }).catch(() => {});
    } catch {}
  }
  _hangup = () => {
    // Tear down the still-alive WebRTC session via the global teardown ref
    // (set up inside CallScreenInner). If it's gone or throws, still fall
    // back to router.back() so the user always escapes the dead UI.
    try {
      if (typeof globalThis !== 'undefined' && typeof globalThis.__chatyyTeardownActiveCall === 'function') {
        globalThis.__chatyyTeardownActiveCall(null, 'CallErrorBoundary');
      }
    } catch {}
    try { _clearGC && _clearGC(); } catch {}
    try { setCallActive && setCallActive(false); } catch {}
    try {
      const { router } = require('expo-router');
      router.back();
    } catch {}
    this.setState({ hasError: false, error: null });
  };
  render() {
    if (this.state.hasError) {
      return (
        <View style={{
          flex: 1,
          backgroundColor: '#0a0a0f',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
        }}>
          <View style={{
            width: 64, height: 64, borderRadius: 32,
            backgroundColor: 'rgba(239,68,68,0.15)',
            alignItems: 'center', justifyContent: 'center',
            marginBottom: 20,
          }}>
            <Svg width={32} height={32} viewBox="0 0 24 24" fill="none">
              <SvgPath d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="#ef4444" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </View>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8, textAlign: 'center' }}>
            Tela de chamada teve um erro
          </Text>
          <Text style={{ color: '#94a3b8', fontSize: 14, marginBottom: 28, textAlign: 'center', lineHeight: 20 }}>
            Toque para desligar e tentar novamente.
          </Text>
          <TouchableOpacity
            onPress={this._hangup}
            activeOpacity={0.85}
            style={{
              backgroundColor: '#dc2626',
              paddingVertical: 14, paddingHorizontal: 32,
              borderRadius: 999,
              flexDirection: 'row', alignItems: 'center',
              shadowColor: '#dc2626', shadowOpacity: 0.4, shadowRadius: 16,
            }}
            accessibilityRole="button"
            accessibilityLabel="Desligar"
          >
            <IconPhoneOff size={20} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700', marginLeft: 10 }}>
              Desligar
            </Text>
          </TouchableOpacity>
          {__DEV__ && this.state.error?.message ? (
            <Text selectable style={{ color: '#f87171', fontSize: 11, marginTop: 24, fontFamily: 'monospace', textAlign: 'center' }} numberOfLines={4}>
              {this.state.error.message}
            </Text>
          ) : null}
        </View>
      );
    }
    return this.props.children;
  }
}

export default function CallScreen(props) {
  return (
    <CallErrorBoundary>
      <CallScreenInner {...props} />
    </CallErrorBoundary>
  );
}
