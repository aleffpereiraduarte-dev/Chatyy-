// app/call.js — LiveKit-based call screen (rewritten 2026-05-14).
//
// History: this file used to be 6596 lines of @stream-io/react-native-webrtc
// + custom WS signaling (offer/answer/ice) with manual transceiver direction
// management, ICE restarts, TURN credential rotation, m-line ordering
// hot-patches, and a half-dozen "force sendrecv" defensive fixes for the
// recurring "audio só num lado" bug.
//
// All of that is replaced by LiveKit. The LiveKit SFU handles SDP, ICE, codec
// negotiation, audio routing, simulcast, and reconnection internally. We keep:
//   - WS signaling for the RINGING phase ONLY (call_invite / call_accepted /
//     call_end). LiveKit handles the actual media.
//   - All UI (avatar, controls, more sheet, video request, add participant,
//     end card, on-hold banner, slow-connect overlay, emoji reactions,
//     raise hand, recording banner, screen share banner, quick reactions).
//   - CallKit reportConnected on connect (iOS system call screen integration)
//   - Minimize / globalCall state so the user can navigate away mid-call.
//
// Removed (dead code under LiveKit):
//   - RTCPeerConnection creation, addTransceiver, replaceTrack, addTrack
//   - createOffer / createAnswer / setLocalDescription / setRemoteDescription
//   - call_offer / call_answer / call_ice WS messages and handlers
//   - SDP munging (applyOpusTuning, applyCodecPreferences)
//   - ICE restart, TURN refresh, getStats() loop, pre/post-connect track audits
//   - getUserMedia (LiveKit calls this internally via setMicrophoneEnabled /
//     setCameraEnabled)
//   - Manual audio session juggling per-toggle (LiveKit AudioSession owns it)

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Dimensions,
  Animated, Easing, StatusBar, PanResponder, AppState,
  Modal, Pressable, ScrollView, ActivityIndicator,
  PermissionsAndroid, ActionSheetIOS,
} from 'react-native';

// [2026-05-15 #976] Android needs explicit runtime CAMERA permission grant.
// LiveKit's setCameraEnabled() does NOT trigger the system permission prompt
// — it just calls getUserMedia, which silently throws if CAMERA isn't
// granted yet. For audio calls upgraded to video mid-call, the user never
// got prompted at start, so the camera fails to turn on with no UI feedback.
// requestAndroidCameraPermission() asks once; subsequent calls are no-ops
// since Android caches the grant.
async function requestAndroidCameraPermission() {
  if (Platform.OS !== 'android') return true;
  try {
    const status = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
    if (status) return true;
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.CAMERA,
      {
        title: 'Permitir câmera',
        message: 'O Chatyy precisa da câmera para você aparecer na chamada.',
        buttonPositive: 'Permitir',
        buttonNegative: 'Cancelar',
      }
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch (e) {
    console.warn('[Call] requestAndroidCameraPermission err:', e?.message);
    return false;
  }
}
import { IconSmile, IconSparkles } from '../components/Icons';
import Svg, { Path as SvgPath, Circle as SvgCircleHand, Line as SvgLine } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';

// LiveKit. livekit-client is the pure-JS SDK (Room / RoomEvent / Track /
// ConnectionQuality). @livekit/react-native exposes the RN VideoView, the
// native AudioSession bridge, and registerGlobals (must be called once before
// Room.connect on native). LiveKit's `Track.Source.Camera` and
// `Track.Source.Microphone` are how we address publications without juggling
// SDP m-lines.
import {
  Room,
  RoomEvent,
  Track,
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
} from 'livekit-client';
let LK_VideoView = null;
let LK_AudioSession = null;
let _livekitRegistered = false;
function ensureLiveKitRegistered() {
  if (_livekitRegistered) return;
  if (Platform.OS === 'web') { _livekitRegistered = true; return; }
  try {
    const lkrn = require('@livekit/react-native');
    LK_VideoView = lkrn.VideoView || null;
    LK_AudioSession = lkrn.AudioSession || null;
    if (typeof lkrn.registerGlobals === 'function') {
      try { lkrn.registerGlobals(); } catch (e) { console.warn('[Call] registerGlobals failed:', e?.message); }
    }
    _livekitRegistered = true;
  } catch (e) {
    console.warn('[Call] @livekit/react-native load failed:', e?.message);
  }
}

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
import ConnectionBars from '../components/ConnectionBars';
import CallAudioStats from '../components/CallAudioStats';
// [2026-05-18 video-quality-push] Adaptive bitrate + frame-drop indicator + stats peek.
// videoCallTuning owns the 3s sender/receiver-stats poll + auto bucket
// (excellent / good / poor / very_poor) and applies setPublishingQuality on
// the LocalVideoTrack. CallVideoStats is the small <View> we mount conditionally.
import CallVideoStats, { PoorConnectionWarning } from '../components/CallVideoStats';
import {
  startAdaptiveLoop as startVideoAdaptiveLoop,
  getStoredBgMode as getStoredVideoBgMode,
  setStoredBgMode as setStoredVideoBgMode,
} from '../services/videoCallTuning';
import {
  buildAudioRoomOptions,
  pollNetworkStats,
  classifyQuality,
  applyAdaptiveBitrate,
  makeLevelChangeFilter,
  makeSustainedPoorFilter,
  triggerIceRestart,
  applyOpusSdpMunge,
} from '../services/livekitTuning';
import * as callStateBus from '../services/callState';
import {
  IconMic, IconMicOff, IconVideo, IconVideoOff, IconPhoneOff,
  IconVolume2, IconVolume, IconArrowLeft, IconChevronDown, IconCameraFlip, IconScreenShare,
  IconPause, IconPlay, IconMoreHorizontal, IconPhone, IconRecord,
  IconZap, IconUserPlus, IconX, IconSearch, IconVerifiedBadge,
} from '../components/Icons';
import { setCallActive } from '../components/IncomingCallListener';
// [WAVE 104F] Call telemetry — best-effort, never throws.
let _callDiagAppend = () => {};
try { _callDiagAppend = require('../services/callDiag').callDiagAppend; } catch {}
// Lazy-load to break circular dependency
let setActiveCall = () => {};
let clearActiveCall = () => {};
let addCallToHistory = () => {};

const initCallModules = (() => {
  let loaded = false;
  return () => {
    if (!loaded) {
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

// Lazy-load callkeep only on native.
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

// Max participants per group call. Matches WhatsApp 2025 + native iOS
// `kMaxCallParticipants` + Android `GroupCallActivity.MAX_PARTICIPANTS`.
// Backend chat_call_invite enforces this too — the UI just shows a banner
// once we hit the cap so add-participant becomes a no-op.
export const MAX_CALL_PARTICIPANTS = 32;

// Global call state lives in services/callState so it survives module re-imports
// (Expo Router loads screens as separate chunks; module-level vars don't share).
import { getGlobalCall as _getGC, setGlobalCall as _setGC, clearGlobalCall as _clearGC } from '../services/callState';
export const getGlobalCall = _getGC;
export const clearGlobalCall = _clearGC;

// Map LiveKit ConnectionQuality → our 1-5 quality score + 0-4 bar level for the
// existing ConnectionBars component.
//   Excellent → 5/4   Good → 4/3   Poor → 2/1   Lost → 1/0
function qualityToScore(q) {
  switch (q) {
    case ConnectionQuality.Excellent: return 5;
    case ConnectionQuality.Good:      return 4;
    case ConnectionQuality.Poor:      return 2;
    case ConnectionQuality.Lost:      return 1;
    default: return 4;
  }
}
function qualityToLabel(q) {
  switch (q) {
    case ConnectionQuality.Excellent:
    case ConnectionQuality.Good:      return 'good';
    case ConnectionQuality.Poor:      return 'medium';
    case ConnectionQuality.Lost:      return 'poor';
    default: return 'good';
  }
}

// [gap D4 2026-05-25 fix] Force the SFU to push a fresh I-frame for a remote
// VIDEO publication. livekit-client 2.19's RemoteTrackPublication has NO
// requestKeyFrame() — the old `pub?.requestKeyFrame?.()` was a silent no-op, so
// remote video stayed frozen on the last frame for 4-8s (until the next natural
// GOP) on camera re-enable / reconnect / first subscribe. Toggling the
// subscription off→on makes the SFU re-send a keyframe (PLI) almost instantly.
// setSubscribed(boolean) IS present on RemoteTrackPublication in 2.19 (verified
// in node_modules/livekit-client RemoteTrackPublication.d.ts); setEnabled is the
// fallback. We only do this for VIDEO — never audio (would cause an audible blip).
function _nudgeKeyframe(pub) {
  try {
    if (!pub) return;
    // Guard to video only — kind may live on the pub or its track.
    const kind = pub.kind || pub.track?.kind;
    if (kind && kind !== 'video' && kind !== Track.Kind.Video) return;
    if (typeof pub.setSubscribed === 'function') {
      pub.setSubscribed(false);
      setTimeout(() => { try { pub.setSubscribed(true); } catch {} }, 150);
    } else if (typeof pub.setEnabled === 'function') {
      pub.setEnabled(false);
      setTimeout(() => { try { pub.setEnabled(true); } catch {} }, 150);
    }
  } catch {}
}

function CallScreenInner() {
  useEffect(() => { initCallModules(); }, []);


  // WhatsApp-grade cold-start: the moment the call screen mounts (even before
  // LiveKit connects), tell the native IncomingCallActivity to dismiss its
  // "Conectando com X..." overlay. Without this, on Android cold-start the
  // user sees the native card sitting on top of our JS UI for up to 8s (the
  // safety timeout). iOS implementation is a no-op since CallKit handles
  // the handoff natively.
  useEffect(() => {
    try {
      const { notifyAppReady } = require('../services/callkeep');
      notifyAppReady?.();
    } catch {}
  }, []);

  const router = useRouter();
  const params = useLocalSearchParams();
  const {
    callId, contactName, contactEmail,
    isVideo: isVideoParam, conversationId,
    isCaller: isCallerParam,
    callerVerified: callerVerifiedParam,
    adoptNative: adoptNativeParam,
  } = params;
  // [WAVE 92 2026-05-21] Bug 2 — When iOS callee accepts via native CallKit,
  // IncomingCallListener pushes /call with adoptNative=1. We use this to:
  //  1. Extend the adoptNativeRoom poll window from 1.5s (15×100ms) to 4s
  //     (40×100ms). The native CallViewController.viewDidLoad takes 1500-3500ms
  //     to (a) fetch token (b) Room.connect (c) NativeCallRoom.publish — the
  //     old window often missed and JS spawned a duplicate Room that the SFU
  //     evicted, manifesting as "Não foi possível conectar" + the native VC
  //     hanging in a parallel UIKit window the user couldn't reach.
  //  2. Skip the JS-side Room.connect fallback for an additional 6s after
  //     adoption fails — gives native more headroom on cold-start where the
  //     RN bundle parses faster than the LK SDK warms up.
  const wantsAdoptNative = adoptNativeParam === '1' || adoptNativeParam === 'true';

  const peerVerified = callerVerifiedParam === '1'
    || callerVerifiedParam === 1
    || callerVerifiedParam === true
    || callerVerifiedParam === 'true';

  const { user } = useAuth();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const isCaller = isCallerParam === '1' || isCallerParam === 'true';
  const initialVideoCall = isVideoParam === '1' || isVideoParam === 'true';
  // [bug 2026-05-15 #978-4] Audio→video upgrade was visually broken because
  // `isVideoCall` came from URL param and stayed false forever after an
  // audio call accepted a video upgrade. Both `showRemoteVideo` and the
  // <LK_VideoView> guard hardcoded `isVideoCall`, so peer's published
  // video track never rendered for either side. Replace with stateful
  // flag bumped to true on the first video_request accept (caller and
  // peer paths both call setIsVideoCall(true) below).
  const [isVideoCall, setIsVideoCall] = useState(initialVideoCall);
  // [bug 2026-05-15 #977-followup] Flag set by IncomingCallListener
  // handleAndroidPendingCall when the user accepted via the native heads-up
  // notification while the app was minimized/dead. Used below to suppress
  // phantom WS call_end events that arrive in the 5s mount window — caller
  // side may emit call_end from its 30s ring timeout, network blip retry,
  // or multi-device race, and the unguarded `unsubEnd` handler was eating
  // the freshly-accepted call → "Chamada encerrada" + home navigation.
  const autoAccepted = params.autoAccepted === '1' || params.autoAccepted === 'true';
  const mountTimeRef = useRef(Date.now());
  // [WAVE 104F] Telemetry — screen mounted with role + callId.
  // Run once; callId/isCaller are stable URL params for the call's lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      _callDiagAppend('info', 'call screen mounted', {
        call_id: callId,
        role: isCaller ? 'caller' : 'callee',
        is_video: initialVideoCall,
        platform: Platform.OS,
        adopt_native: wantsAdoptNative,
      });
    } catch {}
  }, []); // intentionally empty — mount-once

  // Null safety for peer display.
  // [bug 2026-05-15 #978-2] When answered via Android lock-screen native UI,
  // the FCM payload sometimes only has caller_email (no caller_name), and
  // IncomingCallActivity.kt defaults callerName to "Unknown" before persisting
  // it. JS then displayed "Unknown" / "Contato desconhecido" instead of
  // falling through to the email local part. Treat those sentinels as
  // invalid so we always show the cleanest available label.
  const _safePeerName = (() => {
    const isInvalidName = (s) => {
      if (!s || typeof s !== 'string') return true;
      const t = s.trim().toLowerCase();
      if (!t) return true;
      return t === 'unknown' || t === 'desconhecido' || t === 'contato desconhecido' || t === 'unknown peer';
    };
    if (!isInvalidName(contactName)) return contactName.trim();
    if (typeof contactEmail === 'string' && contactEmail.includes('@')) {
      const local = contactEmail.split('@')[0];
      if (local) return local;
    }
    const txt = t('call.unknownPeer');
    if (txt && txt !== 'call.unknownPeer') return txt;
    const alt = t('call.unknownPerr');
    if (alt && alt !== 'call.unknownPerr') return alt;
    return 'Chamada';
  })();
  const callerName = String(_safePeerName);
  const _safePeerEmail = typeof contactEmail === 'string' ? contactEmail : '';

  const isGroupCall = params.groupCall === '1' || params.groupCall === 'true';

  // ───── State ─────
  const [audioMuted, setAudioMuted] = useState(false);
  const [videoEnabled, setVideoEnabled] = useState(isVideoCall);
  const audioMutedRef = useRef(audioMuted);
  const videoEnabledRef = useRef(videoEnabled);
  useEffect(() => { audioMutedRef.current = audioMuted; }, [audioMuted]);
  useEffect(() => { videoEnabledRef.current = videoEnabled; }, [videoEnabled]);

  const [speakerOn, setSpeakerOn] = useState(isVideoCall ? true : false);
  const [callDuration, setCallDuration] = useState(0);
  const callDurationRef = useRef(0);
  const [peerConnected, setPeerConnected] = useState(false);
  const [peerRinging, setPeerRinging] = useState(false);
  const [ended, setEnded] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [facingFront, setFacingFront] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [peerScreenSharing, setPeerScreenSharing] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [showEmojiBar, setShowEmojiBar] = useState(false);
  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const [addParticipantQuery, setAddParticipantQuery] = useState('');
  const [addParticipantBusy, setAddParticipantBusy] = useState(false);
  const [addParticipantCandidates, setAddParticipantCandidates] = useState([]);
  const [addParticipantLoading, setAddParticipantLoading] = useState(false);
  // [2026-05-26] Group cap UX. Flipped true when the local room count hits
  // MAX_CALL_PARTICIPANTS, or when the backend rejects an invite with a
  // limit-reached status (403/409). Drives the "Limite de participantes
  // atingido" toast + disables the add button/rows so the user isn't left
  // tapping into a silent no-op.
  const [participantLimitReached, setParticipantLimitReached] = useState(false);
  const [floatingEmojis, setFloatingEmojis] = useState([]);
  const [onHold, setOnHold] = useState(false);
  const [peerOnHold, setPeerOnHold] = useState(false);
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  const [showQuickReactions, setShowQuickReactions] = useState(false);
  const quickReactionsTimerRef = useRef(null);
  const holdStateRef = useRef({ audioWasMuted: false, videoWasEnabled: false });
  const videoUpgradeRequestedRef = useRef(false);
  const videoUpgradeTimeoutRef = useRef(null);
  const [pendingVideoRequest, setPendingVideoRequest] = useState(null);
  const [videoUpgradeToast, setVideoUpgradeToast] = useState(null);
  const videoUpgradeCountdownRef = useRef(null);
  const [noiseCancellation, setNoiseCancellation] = useState(true);
  const [activeFilter, setActiveFilter] = useState(null);
  const [showFilterPicker, setShowFilterPicker] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [remoteIsRecording, setRemoteIsRecording] = useState(false);
  const [remoteAudioMuted, setRemoteAudioMuted] = useState(false);
  const [peerVideoEnabled, setPeerVideoEnabled] = useState(true);
  const [connectionQuality, setConnectionQuality] = useState('good');
  const [qualityScore, setQualityScore] = useState(5);
  const [reconnecting, setReconnecting] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [showSlowConnectOverlay, setShowSlowConnectOverlay] = useState(false);
  // [WAVE 68 2026-05-21] Progressive connect phase. Drives the topStatus
  // line BEFORE peer joins so user never sees an alarmist "Conexão lenta"
  // in the first 15s (most calls connect well under that). Phases:
  //   'connecting'    — 0-4s   default ("Conectando..." / pulse)
  //   'establishing'  — 4-15s  ("Estabelecendo conexão segura...")
  //   'slow'          — 15s+   ("Conexão lenta..." hint surfaces)
  // Reset to 'connecting' when peerRinging/peerConnected fires.
  const [connectPhase, setConnectPhase] = useState('connecting');
  // [WAVE 68] Deferred reconnect banner. The orange "Reconectando..." banner
  // is HEAVY and was firing on 1-2s ICE blips that LK auto-recovered from
  // before the user could perceive them — pure visual noise. We now keep the
  // raw `reconnecting` flag (used for QoS counter, hard timeout) but only
  // *render* the banner after RECONNECT_BANNER_DELAY_MS of sustained
  // reconnecting state. Cancels on Reconnected/Connected.
  const [showReconnectBanner, setShowReconnectBanner] = useState(false);
  const RECONNECT_BANNER_DELAY_MS = 5000;
  const reconnectBannerArmTimerRef = useRef(null);

  // [2026-05-19 #1183 bad-internet PSTN fallback]
  // When LiveKit can't connect (15s timeout or hard-reconnect ceiling) and the
  // call is a 1-on-1 with a peer who has a verified_phone, surface a
  // "Ligar via telefone?" button so the user can finish the conversation via
  // Telnyx Verto SIP instead of being stranded. Loaded lazily on
  // connectionFailed flip to avoid an extra request per call.
  //   peerPhone           — E.164 phone fetched from profile_get; '' if no
  //                          phone or peer hasn't verified one. UI hides the
  //                          fallback button when empty.
  //   pstnFallbackBusy    — disables the button + shows spinner while we
  //                          fetch SIP creds + open the WebSocket.
  //   pstnFallbackActive  — once Verto INVITE is sent we hide the LK retry UI
  //                          since the PSTN call now owns the screen.
  const [peerPhone, setPeerPhone] = useState('');
  const [pstnFallbackBusy, setPstnFallbackBusy] = useState(false);
  const [pstnFallbackActive, setPstnFallbackActive] = useState(false);
  const peerPhoneLoadedRef = useRef(false);

  // [2026-05-18 video-quality-push]
  // videoStatsSnapshot is the most recent payload from videoCallTuning's
  // 3s adaptive loop ({ fps, sentFps, bitrateKbps, rttMs, lossPct, bucket,
  // suggestAudioOnly, ...}). Drives:
  //   • <CallVideoStats />  (showVideoStats modal, opened via long-press on
  //                          the signal-bars area in the status strip)
  //   • <PoorConnectionWarning />  ("Conexão fraca" banner when fps < 15
  //                                  sustained OR bucket = very_poor)
  //   • Audio-only fallback prompt (we offer to turn off video when
  //     snapshot.suggestAudioOnly flips true and stays true 8s+)
  const [videoStatsSnapshot, setVideoStatsSnapshot] = useState(null);
  const [showVideoStats, setShowVideoStats] = useState(false);
  const videoTuningStopRef = useRef(null);
  const audioOnlySuggestedRef = useRef(false);

  // ───── TTFC (time to first connect) instrumentation ─────
  // Measured from screen mount → RoomEvent.Connected. WhatsApp's bar is
  // <2s; LiveKit average on Chatyy is 0.9-2.5s. Shipped to backend QoS via
  // call_rate meta so analytics can flag regressions per release.
  // reconnectCountRef counts mid-call reconnects — >2 is a bad-network
  // signal sent with the optional post-call rating.
  const ttfcStartRef = useRef(Date.now());
  const ttfcMsRef = useRef(0);
  const reconnectCountRef = useRef(0);

  // Reconnect grace timer. If LiveKit stays in `Reconnecting` for >25s with
  // no recovery, surface the hard `connectionFailed` state so the user can
  // hangup or retry instead of being stuck on the orange banner forever.
  // 25s matches WhatsApp's reconnect ceiling — LK normally recovers within
  // 5-12s on cellular handoffs; anything longer is a real fault.
  const reconnectGraceTimerRef = useRef(null);
  const RECONNECT_HARD_TIMEOUT_MS = 25000;

  // Post-call rating prompt. Shown in the end card overlay when the call
  // had a meaningful duration (>= 10s) so the user can flag quality.
  //   0     = not yet rated / dismissed
  //   1..5  = user picked a rating
  // Auto-dismiss after 12s so the user is never stranded on the prompt.
  const [showRatingPrompt, setShowRatingPrompt] = useState(false);
  const [pendingRating, setPendingRating] = useState(0);
  const ratingDismissTimerRef = useRef(null);
  const navAfterEndTimerRef = useRef(null);

  // Live audio network stats (RTT / loss / jitter / bitrate / codec). Set
  // by the pollNetworkStats loop kicked off after Room.connect lands.
  // Consumed by:
  //   - SignalBars (computeBarLevel) → 4-bar quality indicator
  //   - CallAudioStats modal         → "Diagnóstico de áudio"
  //   - adaptive bitrate loop        → applyAdaptiveBitrate(room, ...)
  const [audioStats, setAudioStats] = useState(null);
  const [showAudioStats, setShowAudioStats] = useState(false);
  const statsUnsubRef = useRef(null);
  const levelFilterRef = useRef(null);
  // [gap D1 2026-05-20] Triggers ICE restart after 3 consecutive very_poor
  // samples (15s @ 5s cadence). Resets on any sample with level >= 1 so a
  // future dip can re-fire. Kept separate from levelFilterRef so the bitrate
  // ladder still adjusts independently.
  const sustainedPoorFilterRef = useRef(null);
  const iceRestartLastAtRef = useRef(0);
  // [gap D3 2026-05-20] Unsub for the network-change handover subscription.
  // Wifi↔cellular transition triggers a forced ICE restart so the room walks
  // off the dying transport before LK's own ConnectivityChanged path catches up.
  const networkChangeUnsubRef = useRef(null);
  // Mirror audioStats into a ref so the ConnectionQualityChanged handler
  // (registered once at room setup) can check "do we already have a
  // stats-derived signal?" without stale-closure issues.
  const audioStatsRef = useRef(null);
  useEffect(() => { audioStatsRef.current = audioStats; }, [audioStats]);

  // ───── "You are muted" reminder (WhatsApp/Zoom parity) ─────
  // When the user starts speaking while muted, surface a small toast so they
  // don't keep talking into the void. Detection: poll LK's
  // localParticipant.audioLevel every 250ms while audioMuted=true; trigger
  // when level crosses MUTE_REMINDER_THRESHOLD. 10s cooldown so it doesn't
  // spam if the user is just having a noisy environment.
  const [muteReminderVisible, setMuteReminderVisible] = useState(false);
  const lastMuteReminderRef = useRef(0);
  const muteReminderHideTimerRef = useRef(null);
  const MUTE_REMINDER_THRESHOLD = 0.04; // LK audioLevel is 0..1
  const MUTE_REMINDER_COOLDOWN_MS = 10_000;

  // [bug 2026-05-18 web-mic-permission]
  // Web users on chatyy.com.br were seeing the generic "microphone not
  // available, check permissions" error from LiveKit when getUserMedia was
  // blocked, denied, or running on a non-secure (HTTP) context. LiveKit's
  // setMicrophoneEnabled(true) just invokes navigator.mediaDevices
  // .getUserMedia({audio:true}) and rejects silently — surfaced as a console
  // warn, not a user-visible UI. We now pre-flight the permission ourselves
  // on web, classify the failure (denied / unavailable / not_secure), and
  // show a dedicated modal with a "Permitir" / "Como permitir?" / "Cancelar"
  // affordance. micPermissionState drives the modal visibility + variant.
  //   'idle'        → no modal, normal flow
  //   'prompt'      → "Permitir microfone" pre-modal (shown for first launch
  //                   if state==='prompt' from permissions.query — optional)
  //   'denied'      → user previously blocked the prompt → instruct settings
  //   'unavailable' → no device / OS-level mic failure
  //   'not_secure'  → page loaded over plain HTTP, getUserMedia disabled
  const [micPermissionState, setMicPermissionState] = useState('idle');

  // Audio output picker (long-press speaker → ActionSheet with 4 options).
  // On Android we use a Modal because there's no native sheet equivalent.
  const [showAudioPicker, setShowAudioPicker] = useState(false);

  // 1:1 active-speaker indicator. LiveKit emits ActiveSpeakersChanged with the
  // list of currently-speaking participants — when the REMOTE peer is in the
  // list, we animate a green ring around their avatar (WhatsApp-style cue).
  const [peerSpeaking, setPeerSpeaking] = useState(false);
  const speakingPulseAnim = useRef(new Animated.Value(0)).current;

  // chatyySettings.sounds — controls whether UI tones (end-call whoosh) play.
  // Loaded once at mount; defaults to true if the API fails.
  const chatyySettingsRef = useRef({ sounds: true });
  useEffect(() => {
    try {
      const api = require('../services/api');
      api.chatGetSettings?.().then(r => {
        if (r?.success && r?.data) chatyySettingsRef.current = r.data;
      }).catch(() => {});
    } catch {}
  }, []);

  // Group raise-hand state (signaling-only, keeps the existing host banner).
  const [handRaised, setHandRaised] = useState(false);
  const [raisedHands, setRaisedHands] = useState(new Map());
  const raisedHandsRef = useRef(new Map());
  const handRaiseTimerRef = useRef(null);
  const handLowerTimersRef = useRef(new Map());

  // [bug 2026-05-24 ios-caller-auto-answers]
  // Caller side must NOT treat ParticipantConnected as "answered" by itself.
  // Android's CallFirebaseMessagingService preconnects the LK Room (joins SFU
  // + publishes mic) the instant FCM lands, BEFORE the user taps Accept. The
  // caller would otherwise see ParticipantConnected, flip peerConnected,
  // report CallKit connected, and stop the ringback — all while the callee
  // phone is still ringing. Gate the answered side-effects on the WS
  // call_accepted event (fired by adoptForCall AFTER real Accept tap). A
  // 12s fallback unblocks the UI in case the WS event is dropped — the
  // physical presence of a remote participant for 12s is a strong-enough
  // signal that they're really in the call.
  const callAcceptedRef = useRef(false);
  const peerParticipantConnectedAtRef = useRef(0);
  const pendingPeerConnectedFallbackRef = useRef(null);

  // Remote/local LiveKit tracks → RN VideoView refs.
  const [remoteParticipant, setRemoteParticipant] = useState(null);
  const [remoteVideoTrack, setRemoteVideoTrack] = useState(null);
  const [remoteScreenShareTrack, setRemoteScreenShareTrack] = useState(null);
  const [localVideoTrack, setLocalVideoTrack] = useState(null);
  // Group: keep a map of remote participant identity → { participant, videoTrack, name }
  // The 1:1 UI ignores this; the group renderer can read it.
  const [groupPeers, setGroupPeers] = useState(new Map());
  const groupPeersRef = useRef(new Map());

  // [WAVE 68 2026-05-21] Progressive connect-phase state machine.
  // Previously a single 8s timer flipped showSlowConnectOverlay — too
  // aggressive: a normal token fetch + SDK init + peer join on cellular is
  // 5-12s, and the alarmist red banner was firing on healthy calls. New ladder:
  //   T+0-4s    'connecting'   default — pulsing dot, "Conectando..."
  //   T+4-15s   'establishing' "Estabelecendo conexão segura..." (calmer)
  //   T+15s+    'slow'         show the slowConnectHint banner
  //   T+25s+    'failed'       flip connectionFailed so the end-card surface
  //                            shows "Não foi possível conectar — Tentar de
  //                            novo?" instead of leaving the user stranded
  //                            on "Estabelecendo conexão segura" forever
  //                            (WAVE 74 root cause: room-name mismatch put
  //                            caller + callee in different LK rooms; even
  //                            after backend fix, defense-in-depth ceiling
  //                            so we never hang on this screen again).
  // peerRinging/peerConnected cancels all phase escalation immediately.
  useEffect(() => {
    if (peerConnected || peerRinging || ended) {
      setShowSlowConnectOverlay(false);
      setConnectPhase('connecting');
      return;
    }
    setConnectPhase('connecting');
    const tEstablishing = setTimeout(() => setConnectPhase('establishing'), 4000);
    const tSlow = setTimeout(() => {
      try {
        console.log('[CALL-TRACE][SLOW] Slow-connect hint armed (15s elapsed without peer/ringing)', {
          callId,
          peerConnected,
          peerRinging,
          reconnecting,
          ts: Date.now(),
        });
      } catch {}
      setConnectPhase('slow');
      // Only show the alarmist "slow connection / check your network" overlay
      // to the CALLEE (who already answered and is joining media). For the
      // CALLER this window is just normal ringing — don't blame their network.
      if (!isCaller) setShowSlowConnectOverlay(true);
    }, 15000);
    // [WAVE 109 2026-05-21] Hard 60s ceiling (bumped from 25s).
    // Root cause of "Não foi possível conectar": iOS cold-start VoIP push
    // answer path needs up to 30s for WS reconnect + LK token fetch + SFU
    // join. Old 25s ceiling was firing before callee's LK Room.connect()
    // completed, leaving caller on the failed screen even though the callee
    // was actively answering. Primary signal is now LK ParticipantConnected
    // (fires as soon as callee joins SFU) which resets this timer; 60s is
    // only the safety net for the case where LK itself is unreachable.
    const tFailed = setTimeout(() => {
      if (endedRef.current || peerConnected || peerRinging) return;
      try {
        console.warn('[CALL-TRACE][HARD-FAIL] 60s elapsed without peer join — connectionFailed', {
          callId,
          ts: Date.now(),
        });
      } catch {}
      // [WAVE 104F] Telemetry — connect timeout reached.
      try { _callDiagAppend('error', 'connect timeout — 60s without peer join', { call_id: callId, role: isCaller ? 'caller' : 'callee', peer_ringing: peerRinging }); } catch {}
      try {
        const api = require('../services/api');
        api.apiCall?.('push_diag', {
          step: 'lk_connect_hard_fail_60s',
          platform: Platform.OS,
          info: `cid=${String(callId).slice(-12)} peerConnected=${peerConnected} peerRinging=${peerRinging}`,
          anon_id: `call-${String(callId).slice(-12)}`,
          ts: new Date().toISOString(),
        }, 'POST').catch(() => {});
      } catch {}
      setConnectionFailed(true);
      // [WAVE 104B] Dismiss slow-connect overlay when flipping to failed so
      // the two states never render simultaneously (screenshot bug 2026-05-21:
      // "Conectando..." modal appeared ON TOP OF the failed-state pill).
      setShowSlowConnectOverlay(false);
      // [WAVE 92 2026-05-21] Bug 1 — surface a slightly more actionable
      // message. Generic "Não foi possível conectar" was unactionable. New
      // copy hints at network/peer state which is the actual root cause 90%
      // of the time (peer never joined LK room → caller / callee in different
      // rooms via WAVE 41/74 fix, or callee phone got no FCM/VoIP push).
      try {
        const msg = !peerRinging && isCaller
          ? (t('call.peerNotReachable') || 'A pessoa não atendeu ou está sem internet. Tente novamente.')
          : (t('call.connectionFailed') || 'Não foi possível conectar. Tente novamente.');
        setErrorMsg(msg);
      } catch {}
    }, 60000);
    return () => {
      clearTimeout(tEstablishing);
      clearTimeout(tSlow);
      clearTimeout(tFailed);
    };
  }, [peerConnected, peerRinging, ended, callId, t]);

  // [WAVE 68 2026-05-21] Defer the orange "Reconectando..." banner so a 1-2s
  // ICE blip (very common on cellular bouncing 4G↔5G or SFU edge migration)
  // doesn't paint a scary banner that LK auto-recovers from before the user
  // could read it. Banner only renders after `reconnecting` has been true
  // for >= RECONNECT_BANNER_DELAY_MS (5s) continuously.
  useEffect(() => {
    if (!reconnecting) {
      if (reconnectBannerArmTimerRef.current) {
        try { clearTimeout(reconnectBannerArmTimerRef.current); } catch {}
        reconnectBannerArmTimerRef.current = null;
      }
      setShowReconnectBanner(false);
      return;
    }
    if (reconnectBannerArmTimerRef.current) return;
    reconnectBannerArmTimerRef.current = setTimeout(() => {
      reconnectBannerArmTimerRef.current = null;
      setShowReconnectBanner(true);
    }, RECONNECT_BANNER_DELAY_MS);
    return () => {
      if (reconnectBannerArmTimerRef.current) {
        try { clearTimeout(reconnectBannerArmTimerRef.current); } catch {}
        reconnectBannerArmTimerRef.current = null;
      }
    };
  }, [reconnecting]);

  // ───── Animations ─────
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const controlsFadeAnim = useRef(new Animated.Value(1)).current;
  const barEnterAnim = useRef(new Animated.Value(0)).current;
  const endCardAnim = useRef(new Animated.Value(0)).current;
  const reconnectMicroFade = useRef(new Animated.Value(0)).current;

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
        // Apply velocity decay (FaceTime-style fling) before snapping.
        const projX = g.moveX + (g.vx || 0) * 0.15 * SCREEN_W;
        const projY = g.moveY + (g.vy || 0) * 0.15 * SCREEN_H;
        const snapX = projX > SCREEN_W / 2 ? SCREEN_W - 126 : 16;
        const snapY = Math.max(60, Math.min(projY - 80, SCREEN_H - 340));
        Animated.spring(pipPosition, { toValue: { x: snapX, y: snapY }, friction: 7, tension: 100, useNativeDriver: false }).start();
      },
    })
  ).current;

  // [2026-05-18 video-quality-push] Pinch-to-zoom on the remote video (1:1
  // only). Two-finger gesture scales the <LK_VideoView> via a transform
  // matrix; spring-back on release. We intentionally don't zoom on group
  // calls because the grid layout already handles "focus" via tap-to-pin.
  //
  // PanResponder.onMoveShouldSet only fires when two fingers register a delta
  // > 8px to avoid hijacking the regular tap-to-toggle-controls gesture.
  const remoteZoomScale = useRef(new Animated.Value(1)).current;
  const remoteZoomBaseRef = useRef(1);
  const remoteZoomCurrentRef = useRef(1);
  const remotePinchResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (e) => e.nativeEvent.touches?.length === 2,
      onMoveShouldSetPanResponder: (e) => e.nativeEvent.touches?.length === 2,
      onPanResponderGrant: (e) => {
        const t = e.nativeEvent.touches;
        if (t && t.length === 2) {
          const dx = t[0].pageX - t[1].pageX;
          const dy = t[0].pageY - t[1].pageY;
          remoteZoomBaseRef.current = Math.hypot(dx, dy) || 1;
        }
      },
      onPanResponderMove: (e) => {
        const t = e.nativeEvent.touches;
        if (t && t.length === 2 && remoteZoomBaseRef.current > 0) {
          const dx = t[0].pageX - t[1].pageX;
          const dy = t[0].pageY - t[1].pageY;
          const cur = Math.hypot(dx, dy);
          const next = Math.max(1, Math.min(3, (cur / remoteZoomBaseRef.current) * remoteZoomCurrentRef.current));
          remoteZoomScale.setValue(next);
        }
      },
      onPanResponderRelease: () => {
        // Pull scale from the Animated value (via __getValue is ok here —
        // this is an interaction handler, not render).
        try { remoteZoomCurrentRef.current = remoteZoomScale.__getValue?.() || 1; } catch {}
        // Spring back to 1.0 on release (WhatsApp behavior — zoom is
        // ephemeral, doesn't persist).
        Animated.spring(remoteZoomScale, { toValue: 1, friction: 6, useNativeDriver: true }).start(() => {
          remoteZoomCurrentRef.current = 1;
        });
      },
      onPanResponderTerminate: () => {
        Animated.spring(remoteZoomScale, { toValue: 1, friction: 6, useNativeDriver: true }).start();
        remoteZoomCurrentRef.current = 1;
      },
    })
  ).current;

  // ───── Refs ─────
  const roomRef = useRef(null);
  // [2026-05-25] In-flight guard for connectToRoom. roomRef.current is only
  // assigned AFTER up-to-4s adopt polling + token fetch + 15s connect, so a
  // second call (handleReconnect, retry) entering connectToRoom mid-flight
  // would spawn a duplicate `new Room()` and orphan the first. This ref gates
  // re-entry until the first attempt resolves (success OR failure).
  const connectingRef = useRef(false);
  const timerRef = useRef(null);
  const callerTimeoutRef = useRef(null);
  const controlsTimerRef = useRef(null);
  const wakeLockRef = useRef(null);
  const wsUnsubsRef = useRef([]);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const recordingStartTimeRef = useRef(null);
  const endedRef = useRef(false);
  const minimizedRef = useRef(false);
  // Timestamp of the last ParticipantConnected for the 1:1 peer. Used by
  // ParticipantDisconnected to suppress teardown when the peer leaves
  // within ~3s of joining — that's the post-CallKit-answer WS reconnect
  // race where the callee briefly drops the LiveKit session while
  // re-establishing the signaling socket, NOT a real hangup.
  const peerJoinedAtRef = useRef(0);
  const handleEndCallRef = useRef(null);
  // [2026-05-18 video-quality-push] Late-bound ref so the videoCallTuning
  // adaptive loop (created BEFORE handleToggleVideo is in scope) can offer
  // the "switch to audio-only" prompt from inside its onChange callback.
  const handleToggleVideoRef = useRef(null);

  // Mute toggle UI shake when peer is on hold.
  // [WAVE 68 2026-05-21] Gate the post-connect micro banner on the
  // DEBOUNCED showReconnectBanner so a brief 1-2s ICE blip mid-call doesn't
  // flash the orange strip across the screen. The 5s debounce upstream is
  // armed off the raw `reconnecting` flag and cancels on Reconnected.
  const reconnectMicroVisible = showReconnectBanner && peerConnected && !ended;
  useEffect(() => {
    Animated.timing(reconnectMicroFade, {
      toValue: reconnectMicroVisible ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [reconnectMicroVisible, reconnectMicroFade]);

  // ───── WS signaling (RINGING only — call_invite / call_accepted / call_end) ─────
  // [#1233 2026-05-20] No longer gate on `mailWs.isConnected` — _send() now
  // queues call_invite/call_end/call_answer/call_reject when the socket is
  // mid-reconnect, draining on auth_success (websocket.js ~1463). Previously
  // a silent drop here made the callee never ring during the ~1-3s WS flap
  // (or the caller hangup arrive after the peer already saw a phantom
  // call). The 3-attempt retry in handleEndCall (~1809) still wraps this
  // so we get retry + queue durability stacked.
  const sendSignaling = useCallback((type, data) => {
    try {
      const mailWs = require('../services/websocket').default;
      mailWs._send({ type, ...data });
    } catch {}
  }, []);

  // Mark call active so IncomingCallListener doesn't fire over it.
  useEffect(() => {
    setCallActive(true, callId);
    // [#1165 2026-05-18] Also publish a global flag the WS auth_error
    // handler reads so it can suppress streak escalation during the call.
    // User report: "na hora que liga parece que perde token, ai não envia
    // mais mensagem, ai tenho que deslogar e logar denovo". Root cause is
    // the JS WS reconnects during the call (CallActivity covers the RN
    // surface on Android, iOS suspends background sockets), hits a few
    // transient auth_error frames, and the streak races to the logout
    // threshold mid-call. The marker lives 30s past call_end so the post-
    // call WS settle (subscribe re-emit, presence sync) is also protected.
    try {
      if (typeof globalThis !== 'undefined') {
        globalThis.__chatyyCallActive = true;
        if (globalThis.__chatyyCallActiveClearTimer) {
          clearTimeout(globalThis.__chatyyCallActiveClearTimer);
          globalThis.__chatyyCallActiveClearTimer = null;
        }
      }
    } catch {}
    // Also flip the WS instance flag (drives ping cadence + intra-class
    // gating) so the protections share a single source of truth.
    try {
      const mailWs = require('../services/websocket').default;
      mailWs.setCallActive?.(true);
    } catch {}
    return () => {
      if (!minimizedRef.current) setCallActive(false, callId);
      try {
        if (typeof globalThis !== 'undefined') {
          // Delay clearing 30s — see comment above. Schedule on global so
          // re-mounting the screen doesn't double-arm.
          if (globalThis.__chatyyCallActiveClearTimer) {
            clearTimeout(globalThis.__chatyyCallActiveClearTimer);
          }
          globalThis.__chatyyCallActiveClearTimer = setTimeout(() => {
            try {
              globalThis.__chatyyCallActive = false;
              globalThis.__chatyyCallActiveClearTimer = null;
              // After the protection window expires, proactively confirm
              // the token via HTTP. If 200, also reset the WS streak so a
              // late auth_error storm caused by the call doesn't tip us
              // over. Bug #1165 mitigation.
              const apiMod = require('../services/api');
              apiMod.checkAuth?.().then((r) => {
                if (r && (r.success || r.data)) {
                  try { apiMod.resetAuthFailureSignal?.(); } catch {}
                  try {
                    const mailWs = require('../services/websocket').default;
                    if (mailWs) mailWs._authFailStreak = 0;
                  } catch {}
                }
              }).catch(() => {});
            } catch {}
          }, 30000);
        }
      } catch {}
      try {
        const mailWs = require('../services/websocket').default;
        mailWs.setCallActive?.(false);
      } catch {}
    };
  }, [callId]);

  // Register active call for the green bar.
  useEffect(() => {
    setActiveCall({
      callId,
      contactName: callerName,
      contactEmail,
      isVideo: isVideoCall,
      conversationId,
      isCaller,
    });
    return () => {
      if (!minimizedRef.current) clearActiveCall();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore from minimized global call state.
  useEffect(() => {
    const gc = _getGC();
    if (gc && gc.callId === callId && gc.room) {
      console.log('[Call] Restoring minimized LiveKit room');
      roomRef.current = gc.room;
      wsUnsubsRef.current = gc.wsUnsubs || [];
      callDurationRef.current = gc.duration || 0;
      setCallDuration(gc.duration || 0);
      setPeerConnected(true);
      minimizedRef.current = false;
      _clearGC();
    }
  }, [callId]);

  // External teardown hook (CallKit lock-screen end / system DND).
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

  // Bottom action bar spring entrance.
  useEffect(() => {
    Animated.spring(barEnterAnim, {
      toValue: 1,
      tension: 110,
      friction: 11,
      useNativeDriver: false,
    }).start();
  }, [barEnterAnim]);

  // Wake lock — keep screen on during call.
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (navigator.wakeLock) {
        navigator.wakeLock.request('screen').then(lock => { wakeLockRef.current = lock; }).catch(() => {});
      }
    } else {
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
        if (Platform.OS !== 'web') {
          try {
            const { deactivateKeepAwake } = require('expo-keep-awake');
            deactivateKeepAwake?.('call-screen');
          } catch {}
        }
      }
    };
  }, []);

  // Pause local video when app backgrounded (LiveKit handles audio).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      const r = roomRef.current;
      if (!r) return;
      if (nextState === 'background' || nextState === 'inactive') {
        try { r.localParticipant.setCameraEnabled(false); } catch (e) {
          try { _callDiagAppend('warn', 'setCameraEnabled(false) failed on background', { call_id: callId, msg: String(e?.message || e).slice(0, 200) }); } catch {}
        }
      } else if (nextState === 'active') {
        if (videoEnabledRef.current && !onHold) {
          try { r.localParticipant.setCameraEnabled(true); } catch (e) {
            try { _callDiagAppend('warn', 'setCameraEnabled(true) failed on foreground resume', { call_id: callId, msg: String(e?.message || e).slice(0, 200) }); } catch {}
          }
        }
      }
    });
    return () => sub.remove();
  }, [onHold]);

  // ───── Auto-hide controls in video mode ─────
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

  const formatDuration = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // ───── Helper: pick up a participant's current video track ─────
  const _pickVideoTrack = useCallback((participant) => {
    if (!participant) return { cam: null, screen: null };
    let cam = null;
    let screen = null;
    try {
      const cameraPub = participant.getTrackPublication
        ? participant.getTrackPublication(Track.Source.Camera)
        : null;
      if (cameraPub?.track && !cameraPub.isMuted) {
        cam = cameraPub.videoTrack || cameraPub.track;
      }
      const screenPub = participant.getTrackPublication
        ? participant.getTrackPublication(Track.Source.ScreenShare)
        : null;
      if (screenPub?.track) {
        screen = screenPub.videoTrack || screenPub.track;
      }
    } catch {}
    return { cam, screen };
  }, []);

  const _refreshRemoteTracks = useCallback((participant) => {
    if (!participant) {
      setRemoteVideoTrack(null);
      setRemoteScreenShareTrack(null);
      setPeerScreenSharing(false);
      return;
    }
    const { cam, screen } = _pickVideoTrack(participant);
    setRemoteVideoTrack(cam || null);
    setRemoteScreenShareTrack(screen || null);
    setPeerScreenSharing(!!screen);
    // peerVideoEnabled mirrors whether the remote camera publication is sending.
    let camPub = null;
    try { camPub = participant.getTrackPublication ? participant.getTrackPublication(Track.Source.Camera) : null; } catch {}
    setPeerVideoEnabled(!!(camPub && !camPub.isMuted));
    let micPub = null;
    try { micPub = participant.getTrackPublication ? participant.getTrackPublication(Track.Source.Microphone) : null; } catch {}
    setRemoteAudioMuted(!!(micPub && micPub.isMuted));
  }, [_pickVideoTrack]);

  // ───── Fetch LiveKit JWT ─────
  const fetchLivekitToken = useCallback(async () => {
    // WAVE 41 ROOT CAUSE FIX: native (CallActivity.kt:1143, ExpoCallKitModule.swift:1629)
    // + voipNative.js:188 (caller) + IncomingCallListener.js:704 + backend
    // (chat.php:7296) all use raw callId as the LK room name. This file was
    // the ONLY consumer prefixing `call_`, putting JS in a different room than
    // peer+native → adoptNativeRoom fallback joined an empty room → forever
    // "Reconectando..." (Disconnected event loop). Bug existed for weeks
    // disguised as "WebRTC desconecta após native answer". Fix = align names.
    const room = String(callId);
    // [CALL-TRACE 2026-05-20 WAVE42] Step 11/12 — JS fallback path mints the
    // LK token (used only when adoptNativeRoom failed). Post-WAVE41 the
    // `room` field MUST equal the raw callId — if you ever see "call_<id>"
    // here it means a regression of the WAVE41 fix snuck back in.
    try {
      console.log('[CALL-TRACE][11/12] JS fetchLivekitToken fallback', {
        room,
        callId,
        prefixedBug: room !== String(callId),
        ts: Date.now(),
      });
    } catch {}
    // Fast-path: IncomingCallListener pre-fetched the token when the call
    // invite arrived. If it's fresh (<30s old, same call_id) consume it and
    // skip the network round-trip. Saves 200-700ms on weak networks.
    try {
      const cached = globalThis.__chatyy_prefetched_lk_token;
      if (cached
          && String(cached.call_id) === String(callId)
          && cached.token
          && (Date.now() - (cached.ts || 0) < 30000)) {
        // One-shot: clear so a stale cache from an aborted call doesn't bleed.
        try { globalThis.__chatyy_prefetched_lk_token = null; } catch {}
        return {
          token: cached.token,
          url: cached.url || 'wss://livekit.chatyy.com.br',
          room: cached.room || room,
          iceServers: Array.isArray(cached.iceServers) ? cached.iceServers : [],
        };
      }
    } catch {}
    try {
      const api = require('../services/api');
      // chatLivekitToken accepts a conversation_id and an optional room override.
      // We force the room name from callId so caller + callee land in the same one.
      const convId = Number(conversationId) || 0;
      const res = await api.chatLivekitToken(convId, room);
      const data = res?.data || res;
      const token = data?.token;
      const url = data?.url || data?.livekitUrl || 'wss://livekit.chatyy.com.br';
      const iceServers = Array.isArray(data?.iceServers) ? data.iceServers : [];
      if (!token) throw new Error('No token returned');
      return { token, url, room, iceServers };
    } catch (e) {
      console.error('[Call] fetchLivekitToken err:', e?.message);
      throw e;
    }
  }, [callId, conversationId]);

  // ───── Group: maintain a peer map ─────
  const _updateGroupPeer = useCallback((identity, updates) => {
    if (!identity) return;
    const existing = groupPeersRef.current.get(identity) || {};
    groupPeersRef.current.set(identity, { ...existing, ...updates });
    setGroupPeers(new Map(groupPeersRef.current));
  }, []);
  const _removeGroupPeer = useCallback((identity) => {
    if (!identity) return;
    if (groupPeersRef.current.has(identity)) {
      groupPeersRef.current.delete(identity);
      setGroupPeers(new Map(groupPeersRef.current));
    }
  }, []);

  // ───── Web mic permission pre-flight ─────
  // Returns true if mic is (or just got) granted. Returns false and sets
  // micPermissionState to one of {denied, unavailable, not_secure} otherwise.
  // No-op on native — Android prompts at the OS level via the manifest +
  // runtime permission flow handled inside LiveKit's getUserMedia bridge,
  // iOS via NSMicrophoneUsageDescription + AVCaptureDevice.
  const _ensureWebMicPermission = useCallback(async () => {
    if (Platform.OS !== 'web') return true;
    try {
      // Secure context gate — getUserMedia is gated behind HTTPS / localhost.
      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        setMicPermissionState('not_secure');
        return false;
      }
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setMicPermissionState('unavailable');
        return false;
      }
      // Probe permission first — saves us from a thrown error if user has
      // already explicitly denied via the browser site-settings.
      if (navigator.permissions?.query) {
        try {
          const probe = await navigator.permissions.query({ name: 'microphone' });
          if (probe?.state === 'denied') {
            setMicPermissionState('denied');
            return false;
          }
        } catch {
          // Some browsers (Safari < 16) don't support permissions.query for
          // microphone — fall through to the explicit getUserMedia attempt.
        }
      }
      // Trigger the actual prompt (or no-op if already granted).
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        const name = e?.name || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setMicPermissionState('denied');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
          setMicPermissionState('unavailable');
        } else {
          setMicPermissionState('unavailable');
        }
        return false;
      }
      // Release the probe stream — LiveKit will request its own track via
      // setMicrophoneEnabled(true). Holding ours would keep the OS mic
      // indicator lit twice or cause "device in use" on some browsers.
      try { stream.getTracks().forEach(tr => tr.stop()); } catch {}
      setMicPermissionState('idle');
      return true;
    } catch (e) {
      console.warn('[Call] _ensureWebMicPermission unexpected err:', e?.message);
      setMicPermissionState('unavailable');
      return false;
    }
  }, []);

  // Retry mic publish after the user re-grants permission from the modal.
  // If we already have a connected room, just call setMicrophoneEnabled
  // again; otherwise fall through to a normal connectToRoom (handled by the
  // caller in handleMicPermissionRetry).
  const _retryMicPublish = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return false;
    try {
      await r.localParticipant.setMicrophoneEnabled(!audioMutedRef.current);
      return true;
    } catch (e) {
      console.warn('[Call] _retryMicPublish err:', e?.message);
      const name = e?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setMicPermissionState('denied');
      } else {
        setMicPermissionState('unavailable');
      }
      return false;
    }
  }, []);

  const handleMicPermissionRetry = useCallback(async () => {
    const ok = await _ensureWebMicPermission();
    if (!ok) return;
    // Permission granted — try to publish. If the room is gone (e.g. user
    // sat on the modal long enough for LiveKit to time out), nothing to do
    // here; the user can hang up + redial.
    await _retryMicPublish();
  }, [_ensureWebMicPermission, _retryMicPublish]);

  const handleMicPermissionHelp = useCallback(() => {
    if (Platform.OS !== 'web') return;
    try {
      // Use Chrome's site-settings help page as a sane default. Browsers
      // that aren't Chrome still get a useful walkthrough.
      const url = 'https://support.google.com/chrome/answer/2693767';
      if (typeof window !== 'undefined' && window.open) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch {}
  }, []);

  // ───── Connect to LiveKit Room ─────
  const connectToRoom = useCallback(async () => {
    if (endedRef.current) return;
    // [2026-05-25] In-flight + already-connected guard. Without this, a
    // reconnect/retry firing while the first attempt is still in its
    // ~4s adopt poll + token fetch + 15s connect window would call
    // `new Room()` a second time, orphaning the first Room (leaked socket +
    // mic publisher fighting the SFU). Bail if a connect is in progress or a
    // Room is already live.
    if (connectingRef.current || roomRef.current) {
      try { console.log('[Call] connectToRoom re-entry skipped', { connecting: connectingRef.current, hasRoom: !!roomRef.current }); } catch {}
      return;
    }
    connectingRef.current = true;
    try {
    ensureLiveKitRegistered();

    // [bug 2026-05-15 #7 + #9] LiveKit AudioSession lifecycle vs. CallKit.
    //
    // - On the CallKit-accept path (iOS callee, isCaller=0):
    //   CallKit OWNS the AVAudioSession via the AppDelegate + module
    //   provider:didActivate handlers. Calling LK_AudioSession.startAudioSession
    //   here issues a competing setCategory + setActive against the
    //   CallKit-owned session, which on cold-start cellular paths produced
    //   the "uplink mic silent / call drops" race (3 paths fighting for the
    //   session in a 200-800ms window). We now skip it and rely on the
    //   onCallKitAudioActivated bridge event (set up in the mount effect)
    //   that triggered this connect.
    //
    // - On the OUTGOING-call path (isCaller=1) and on Android (both
    //   directions), there is no CallKit owning the session, so we still
    //   call startAudioSession.
    const skipLKAudioSession = Platform.OS === 'ios' && !isCaller;
    if (Platform.OS !== 'web' && LK_AudioSession && !skipLKAudioSession) {
      try {
        // The RN AudioSession instance manages playAndRecord / voiceChat
        // category automatically. We just call startAudioSession.
        await LK_AudioSession.startAudioSession();
        // [bug 2026-05-15 #978-1 ios-speaker-stuck-after-lockscreen-answer]
        // When the user answers via the iOS lock-screen CallKit native UI,
        // AVAudioSession defaults to either `.speaker` or whatever it last
        // routed to (in our case, often speaker from a previous video call).
        // For audio calls, force earpiece on mount so the user doesn't end
        // up in viva-voz unintentionally. Video calls default to speaker
        // which is also explicitly set so the route is deterministic.
        try {
          const initialRoute = isVideoCall ? 'speaker' : 'earpiece';
          await LK_AudioSession.selectAudioOutput?.(initialRoute);
        } catch (eRoute) {
          console.warn('[Call] initial selectAudioOutput err:', eRoute?.message);
        }
      } catch (e) {
        console.warn('[Call] LK AudioSession.startAudioSession failed:', e?.message);
      }
    } else if (skipLKAudioSession) {
      console.log('[Call] iOS callee: skipping LK_AudioSession (CallKit owns session)');
    }
    // [bug 2026-05-15 #981] Speaker route is still our call to make on iOS,
    // regardless of who owns the session. CallKit's didActivate forces
    // `.none` override (system default), then this nudges to speaker if
    // video. Audio calls stay on earpiece.
    if (Platform.OS === 'ios') {
      try {
        const ck = require('../services/callkeep');
        ck.setSpeakerEnabled?.(!!isVideoCall);
      } catch {}
    }

    // [bug 2026-05-15 livekit-server-side-diag]
    // Native rebuild of build 490 linked @livekit/react-native but user still
    // reports "Não foi possível conectar". Need to capture EXACTLY where
    // connectToRoom is failing without device console access. push_diag in
    // email.php expects { step, platform, info, anon_id } — anything else is
    // dropped. Pack the structured payload into `info` as compact text.
    const _diag = (event, extra) => {
      try {
        const api = require('../services/api');
        let info = `lk_${isCaller ? 'caller' : 'callee'} cid=${String(callId).slice(-8)}`;
        if (extra && typeof extra === 'object') {
          for (const k of Object.keys(extra)) {
            const v = extra[k];
            if (v == null) continue;
            const s = (typeof v === 'string') ? v : JSON.stringify(v);
            info += ` ${k}=${s.length > 120 ? s.slice(0, 120) + '...' : s}`;
          }
        }
        api.apiCall?.('push_diag', {
          step: `lk_${event}`.slice(0, 40),
          platform: Platform.OS,
          info: info.slice(0, 500),
          anon_id: `call-${String(callId).slice(-12)}`,
          ts: new Date().toISOString(),
        }, 'POST').catch(() => {});
      } catch {}
    };
    _diag('connectToRoom_start');

    // __chatyy_native_call_sync 2026-05-19 — adopt the native LiveKit Room.
    // When a cold-start incoming call (PushKit on iOS, FCM-spawned
    // CallActivity on Android) has already pre-connected the LK Room before
    // the JS bundle parsed, calling `new Room().connect()` here creates a
    // second Room → two audio sessions fighting for the mic, mute-toggle
    // desync, and the "delay no áudio" bug. Always probe
    // `adoptNativeRoom(callId)` first.
    //
    // Behavior when adopted:
    //   - Peer tracks are already attached on the native renderer (Compose
    //     on Android / SwiftUI on iOS), so the hybrid /call overlay flips
    //     `peerConnected = true` and relies on the onLk* native emitter
    //     events (wired in services/callkeep.installNativeCallStateBridge)
    //     for live state updates (participant join/leave, track sub/unsub,
    //     quality, mute, cam, speaker, route, hold, PiP).
    //   - We bail out before Room.connect / track publish / statsPoller.
    //     The native side is already publishing local mic + (optionally) cam
    //     and running its own adaptive bitrate loop.
    if (Platform.OS !== 'web') {
      try {
        const ExpoCallKit = require('../modules/expo-callkit');
        // [STAGE-A 2026-05-20] GAP #6 — Poll up to 1500ms for the native
        // Room. The native side (CallViewController.preconnectRoom invoked
        // during the ring window OR CXAnswer-time fetch) may still be
        // mid-connect when JS mounts /call.js. A single adoptNativeRoom call
        // would miss it and JS would spawn a duplicate Room → SFU evicts
        // → mute-toggle desync. 100ms × 15 = 1500ms is the WhatsApp answer
        // budget; if still nothing by then the legacy fallback runs.
        let snap = null;
        let polls = 0;
        // [WAVE 116 2026-05-21] Issue 3 — uniform 4 s poll window for ALL
        // call paths. On Android outgoing, ExpoCallKitModule.startOutgoingCall
        // calls NativeCallRoom.preconnect(); if JS times out at 1.5 s before
        // native is ready, JS spawns its own Room.connect → 2 publishers in
        // the SFU → mute desync. 100 ms × 40 = 4 s covers the worst-case
        // cold-start (token fetch + LK SFU handshake on first call post-install
        // ≈ 1500-3500 ms). The old 15-poll (1.5 s) ceiling only ran when
        // wantsAdoptNative was false; unified to 40 for all paths.
        const maxPolls = 40; // was: wantsAdoptNative ? 40 : 15
        for (let i = 0; i < maxPolls; i++) {
          polls = i + 1;
          snap = await ExpoCallKit.adoptNativeRoom?.(callId);
          // [CALL-TRACE 2026-05-20 WAVE42] Step 10/12 — JS asks native if a
          // Room is already up. On the caller (hybrid foreground) this
          // usually fails — caller adopts via the JS path. On the callee
          // post-CallKit answer it succeeds and we skip Room.connect.
          try {
            console.log('[CALL-TRACE][10/12] adoptNativeRoom poll attempt', {
              polls,
              callId,
              adopted: !!snap,
              isCaller,
              ts: Date.now(),
            });
          } catch {}
          if (snap) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const adopted = !!(snap && (snap.alreadyConnected || snap.connected || snap.roomName || snap.localIdentity));
        try {
          console.log('[CALL-TRACE][10b/12] adoptNativeRoom result', {
            success: adopted,
            polls,
            fallbackToJsConnect: !adopted,
            snap_keys: snap ? Object.keys(snap).join(',') : '<null>',
          });
        } catch {}
        if (adopted) {
          console.log('[Call] adopting native Room — skip JS Room.connect', { callId, snap });
          _diag('adopted_native_room', { snap_keys: Object.keys(snap || {}).join(',') });
          // [2026-05-25] We've adopted the pre-connected native room and this
          // rich JS UI is now live → dismiss the instant native call screen
          // that the answer path presented as the "floor". Seamless handoff:
          // native covered the warm-up gap (incl. cold-start), now the pretty
          // /call.js takes over. No-op on Android / if no native screen up.
          try { ExpoCallKit.dismissNativeCallVC?.(); } catch {}
          setPeerConnected(true);
          // Flip the global flag so the WS chat_call_end gate
          // (isNativeRoomConnected helper below) knows the native side owns
          // the call lifecycle and JS must NOT race a duplicate hangup.
          try { globalThis.__chatyyNativeCallActive = true; } catch {}
          return;
        }
      } catch (e) {
        // Adoption failure is non-fatal — fall through to the legacy JS
        // Room.connect path. The new-second-Room race is back, but the call
        // still works for users on builds without the native call screen.
        _diag('adopt_native_room_err', { msg: String(e?.message || e).slice(0, 200) });
      }
      // [2026-05-25] Reaching here on mobile means adopt FAILED/exhausted — we
      // did NOT early-return from the `if (adopted)` branch (which dismisses
      // the native screen on success). We're about to spawn a JS `new Room()`.
      // If the native call screen presented by the answer path is still up, we
      // now have TWO call screens AND will get two LK Rooms fighting for the
      // mic. Dismiss the native floor BEFORE creating the JS Room so only one
      // screen/room exists. No-op on Android / if no native screen is up.
      try {
        const ExpoCallKit = require('../modules/expo-callkit');
        ExpoCallKit.dismissNativeCallVC?.();
      } catch {}
    }

    let token, url, room, iceServers;
    try {
      ({ token, url, room, iceServers } = await fetchLivekitToken());
      _diag('token_ok', { url, room, ice_count: iceServers?.length || 0 });
    } catch (e) {
      _diag('token_err', { msg: String(e?.message || e), stack: String(e?.stack || '').slice(0, 500) });
      // [2026-05-26] Cold-start iOS callee w/ adoptNative: a transient token
      // failure (timeout / 401 before WS/session warmed up) used to immediately
      // hard-fail. But on this path the native side may still be establishing
      // its own LK Room and can recover via the onLk* bridge (flips
      // peerConnected → dismisses any failed state). Don't slam the door: surface
      // a soft error message but DEFER the hard `connectionFailed` flip to the
      // progressive connect-phase timeout machine (60s ceiling) which either
      // recovers (peer/native connects) or surfaces the actionable failure.
      // Without this the UI hung on "Conectando" because the early-return
      // skipped the rest of connectToRoom while the timer-driven recovery was
      // the only thing that could un-stick it.
      if (wantsAdoptNative && Platform.OS !== 'web') {
        try { setErrorMsg(t('call.connectionFailed') || 'Não foi possível conectar.'); } catch {}
        // NOTE: intentionally NOT setting connectionFailed here — let the
        // T+60s hard-fail timer (or native peer-join recovery) own the verdict.
        return;
      }
      setErrorMsg(t('call.connectionFailed') || 'Não foi possível conectar.');
      setConnectionFailed(true);
      return;
    }
    if (endedRef.current) { _diag('ended_before_room'); return; }
    // Sanity check on the LiveKit module — if the native module didn't link,
    // `Room` is undefined and `new Room(...)` throws a confusing
    // "undefined is not a constructor" instead of a clear "module missing".
    if (typeof Room !== 'function') {
      _diag('room_ctor_undefined', { roomType: typeof Room, hasLkNative: !!LK_AudioSession });
      setErrorMsg('LiveKit native module not linked');
      setConnectionFailed(true);
      return;
    }

    // [bug 2026-05-14 livekit-no-turn]
    // LiveKit server is running with `turn.enabled: false` so its built-in
    // TURN never gets added to the iceServers the server hands back via WS.
    // Without an explicit relay, clients behind strict NAT (CGN cellular,
    // corporate firewall) can't punch UDP 50000-50100 → media never flows →
    // ParticipantDisconnected ~10s after the LiveKit signaling join → caller
    // sends WS call_end → both ends die. Backend now mints coturn HMAC
    // credentials and ships them in `data.iceServers`; we forward them via
    // `rtcConfig` so peerConnection's ICE has a real relay candidate.
    // Audio quality tuning lives in services/livekitTuning so both this
    // screen and future surfaces (meet, broadcast) share the same Opus
    // FEC/DTX/bitrate defaults.
    // [WAVE 44B, 2026-05-21 gap A4] Start at 64 kbps (HD Opus voice) instead
    // of 48 — adaptive loop bumps to 96 on excellent / drops to 32/24 on poor.
    // Old 48 was conservative carried over from cellular-first Wave B; with
    // simulcast + adaptive the SFU downshifts gracefully so we can afford
    // to start higher and let the loop pull down only when actually needed.
    const audioOpts = buildAudioRoomOptions({
      initialBitrate: 64000,
      videoCall: !!initialVideoCall,
    });
    const roomOpts = {
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: audioOpts.audioCaptureDefaults,
      videoCaptureDefaults: {
        facingMode: 'user',
        resolution: { width: 1280, height: 720, frameRate: 30 },
      },
      publishDefaults: {
        ...audioOpts.publishDefaults,
        // [2026-05-25] Force VP9 to match the native pin. Without an explicit
        // videoCodec LiveKit defaults to VP8 (defaultVideoCodec='vp8'), so the
        // JS Room (web + mobile-fallback paths) was publishing VP8 while the
        // native Room pins VP9 → codec downgrade / quality loss on any peer
        // that negotiates down to the lowest common codec. backupCodec ships a
        // VP8 simulcast stream for clients that can't decode VP9 (older Safari)
        // so we keep universal compatibility without losing VP9 where it works.
        videoCodec: 'vp9',
        backupCodec: { codec: 'vp8', simulcast: true },
        // [HD tuning 2026-05-26] 3-layer simulcast ladder (h180/h360/h720) so
        // the SFU can forward the best tier each receiver's bandwidth/viewport
        // can take — that + adaptiveStream/dynacast is what downshifts a weak
        // link smoothly (720p→360p→180p) instead of freezing. Top (h720) layer
        // bumped 1.5M → 1.8M for healthy HD headroom (target ~1.7M, native iOS/
        // Android cap 2.0M for VP9 — kept slightly under to match the JS web
        // path's lower-power encoders).
        videoSimulcastLayers: [
          { width: 320, height: 180, encoding: { maxBitrate: 180_000, maxFramerate: 15 } },
          { width: 640, height: 360, encoding: { maxBitrate: 600_000, maxFramerate: 30 } },
          { width: 1280, height: 720, encoding: { maxBitrate: 1_800_000, maxFramerate: 30 } },
        ],
        // [HD tuning 2026-05-26] maintain-framerate — WhatsApp/FaceTime-like
        // default for 1:1 talking-head: under congestion the encoder drops
        // RESOLUTION first and keeps fps smooth (motion fidelity on a face >
        // sharpness). The simulcast ladder above provides the lower-res tiers
        // to step down to. WebRTC RTCDegradationPreference string value.
        degradationPreference: 'maintain-framerate',
      },
      // [2026-05-15 #827] iOS broadcast extension wiring. When the user taps
      // "Compartilhar tela", LiveKit's setScreenShareEnabled(true) opens the
      // system RPSystemBroadcastPickerView, the user picks Chatyy, and the
      // ChatyyBroadcastExtension (SampleHandler extends LKSampleHandler) starts
      // publishing screen frames into THIS room. broadcastBundleId must match
      // the bundle id set in plugins/with-broadcast-extension.js.
      iosScreenSharePreferences: {
        broadcastBundleId: 'com.onemundo.mail.broadcast',
        useBroadcastExtension: true,
      },
    };
    // [WAVE 115, 2026-05-21] Relay-first ICE pattern (WhatsApp At Scale 2024).
    // Phase-1: force TURN immediately — TURN is never NAT-blocked, so the call
    // connects in 200-500ms with zero "não foi possível conectar" failures.
    // Phase-2 (5s after Connected): restartIce with 'all' — WebRTC tries direct
    // P2P; if it lands, media silently upgrades (lower latency / higher bitrate).
    // If P2P fails the relay leg stays intact and the call never drops.
    // When no iceServers are present (token fetch failed to mint TURN creds) we
    // still set relay policy — LK will gather TURN candidates from the SFU
    // signaling path which always carries the Chatyy coturn endpoint.
    if (Array.isArray(iceServers) && iceServers.length > 0) {
      roomOpts.rtcConfig = { iceServers, iceTransportPolicy: 'relay' };
    } else {
      // No explicit TURN creds from backend yet — still force relay so LK's
      // built-in coturn (turn.chatyy.com.br, wired in livekit.yaml) is used.
      roomOpts.rtcConfig = { iceTransportPolicy: 'relay' };
    }
    let r;
    try {
      r = new Room(roomOpts);
      _diag('room_ctor_ok');
    } catch (e) {
      _diag('room_ctor_err', { msg: String(e?.message || e), stack: String(e?.stack || '').slice(0, 500) });
      setErrorMsg(String(e?.message || 'Room ctor failed'));
      setConnectionFailed(true);
      return;
    }

    // [WAVE 44B, 2026-05-21 gap A2] Wire applyOpusSdpMunge into the publisher
    // PC so Opus fmtp lines carry WhatsApp-grade knobs (maxaveragebitrate,
    // useinbandfec, usedtx). Without this LK only emits the SDK defaults
    // and 96 kbps target voice never actually negotiates — the SFU caps
    // at ~32 kbps because the SDP doesn't advertise the headroom.
    // We monkey-patch createOffer/createAnswer on the publisher PC after
    // the engine spins up. The engine lazy-creates PCs at first publish,
    // so we install a setter on engine.publisher and react when it lands.
    // Safe: any throw degrades silently to LK's default SDP.
    try {
      const installOpusMunge = () => {
        try {
          const eng = r?.engine;
          if (!eng) return false;
          const pcm = eng.pcManager || eng;
          // Try a couple of common shapes — publisher.pc and pcManager.publisher.pc.
          const pub = pcm.publisher || eng.publisher;
          const pc = pub?.pc || pub?.peerConnection;
          if (!pc || pc.__opusMungeWired) return false;
          pc.__opusMungeWired = true;
          const origCreateOffer = pc.createOffer?.bind(pc);
          const origCreateAnswer = pc.createAnswer?.bind(pc);
          const mungeDesc = (desc) => {
            try {
              if (!desc || typeof desc !== 'object' || typeof desc.sdp !== 'string') return desc;
              const newSdp = applyOpusSdpMunge(desc.sdp, {
                maxBitrate: 96000,
                dtx: true,
                cbr: false,
                stereo: false,
              });
              if (newSdp === desc.sdp) return desc;
              // Mutate in-place — both web/native preserve {type, sdp} shape.
              return { type: desc.type, sdp: newSdp };
            } catch { return desc; }
          };
          if (origCreateOffer) {
            pc.createOffer = async function (opts) {
              const o = await origCreateOffer(opts);
              return mungeDesc(o);
            };
          }
          if (origCreateAnswer) {
            pc.createAnswer = async function (opts) {
              const a = await origCreateAnswer(opts);
              return mungeDesc(a);
            };
          }
          try { _diag('opus_sdp_munge_wired'); } catch {}
          return true;
        } catch { return false; }
      };
      // Try now; if PC doesn't exist yet, retry on RoomEvent.LocalTrackPublished
      // (which is when the publisher PC has definitely been created).
      if (!installOpusMunge()) {
        try {
          r.on(RoomEvent.LocalTrackPublished, () => { installOpusMunge(); });
        } catch {}
      }
    } catch (e) {
      try { _diag('opus_sdp_munge_err', { msg: String(e?.message || e) }); } catch {}
    }

    // RoomEvent handlers
    // [WAVE 104F] Telemetry taps wired to critical LK events.
    r.on(RoomEvent.Connected, () => {
      try { _callDiagAppend('info', 'LK Room connected', { call_id: callId, remotes: r.remoteParticipants?.size || 0 }); } catch {}
      if (endedRef.current) return;
      // [TTFC] Stamp time-to-first-connect ONCE. Reconnects don't reset
      // this — we want the cold-path latency the user perceived. Logged via
      // push_diag and shipped via the post-call rating endpoint.
      if (!ttfcMsRef.current) {
        ttfcMsRef.current = Math.max(0, Date.now() - (ttfcStartRef.current || Date.now()));
        try { _diag('ttfc_first_connect', { ttfc_ms: ttfcMsRef.current }); } catch {}
      }
      _diag('event_room_connected', { remotes: r.remoteParticipants?.size || 0 });
      console.log('[Call] LiveKit Connected to room', room, 'ttfc=', ttfcMsRef.current, 'ms');
      // [CALL-TRACE 2026-05-20 WAVE42] Step 12/12 — JS-owned Room reports
      // Connected. Whether the peer is in the room yet is in `peerConnected`
      // (still false here unless we caught them via the immediate scan below).
      try {
        console.log('[CALL-TRACE][12/12] JS Room.connect outcome', {
          callId,
          room,
          peerConnected: (r.remoteParticipants?.size || 0) > 0,
          ttfcMs: ttfcMsRef.current,
          ts: Date.now(),
        });
      } catch {}
      setReconnecting(false);
      setConnectionFailed(false);
      setErrorMsg(null);
      // Cancel any pending hard-reconnect timeout (we recovered).
      if (reconnectGraceTimerRef.current) {
        try { clearTimeout(reconnectGraceTimerRef.current); } catch {}
        reconnectGraceTimerRef.current = null;
      }
      // [WAVE 115 relay-first Phase-2] After 5s on relay, attempt P2P upgrade.
      // We open a new RTCPeerConnection policy window by calling restartIce on
      // the publisher PC with iceTransportPolicy 'all'. If a direct candidate
      // wins, WebRTC transparently migrates media to P2P (lower RTT, higher BW).
      // If P2P fails the relay leg stays and the call is unaffected.
      // Guard: skip if call already ended, skip on subsequent Reconnected events
      // (relay-first only runs once per call).
      setTimeout(() => {
        try {
          if (endedRef.current) return;
          const eng = r?.engine;
          const pcm = eng?.pcManager || eng;
          const pub = pcm?.publisher || eng?.publisher;
          const pc = pub?.pc || pub?.peerConnection;
          // [bug 2026-05-25] @livekit/react-native-webrtc has NO getConfiguration(),
          // so the old `...(pc.getConfiguration?.() || {})` spread resolved to {} and
          // the RTCConfiguration handed to native carried NO iceServers — that wiped
          // the coturn HMAC TURN creds the call connected on, and on strict NAT the
          // P2P-upgrade restartIce() then had no relay to fall back to. Re-pass the
          // SAME iceServers array used to build roomOpts.rtcConfig at connect time so
          // the TURN creds survive the policy flip. If we don't have an explicit
          // iceServers array, SKIP the setConfiguration entirely rather than wipe the
          // relay config that's already working (relay leg stays intact).
          const haveIce = Array.isArray(iceServers) && iceServers.length > 0;
          if (pc && typeof pc.setConfiguration === 'function' && haveIce) {
            const allCfg = { iceServers, iceTransportPolicy: 'all' };
            pc.setConfiguration(allCfg);
            console.log('[Call][relay-first] Phase-2: setConfiguration iceTransportPolicy=all, iceServers=', iceServers.length);
            _diag('relay_first_p2p_upgrade_start', { policy: 'all', iceServers: iceServers.length, ts: Date.now() });
          } else if (pc && !haveIce) {
            console.log('[Call][relay-first] Phase-2: no in-scope iceServers — skipping setConfiguration to preserve TURN relay');
            _diag('relay_first_p2p_upgrade_skip_no_ice', { ts: Date.now() });
          }
          // Also upgrade subscriber PC if it exists (for receiving media). Same
          // TURN-preservation rule — only flip policy when we can re-supply iceServers.
          const sub = pcm?.subscriber || eng?.subscriber;
          const subPc = sub?.pc || sub?.peerConnection;
          if (subPc && typeof subPc.setConfiguration === 'function' && haveIce) {
            subPc.setConfiguration({ iceServers, iceTransportPolicy: 'all' });
          }
          // Trigger ICE restart so new candidates are gathered with 'all' policy.
          // Only restart when we actually flipped to 'all' above — restarting under
          // the unchanged relay policy gains nothing and risks a transient blip.
          if (pc && typeof pc.restartIce === 'function' && haveIce) {
            pc.restartIce();
            console.log('[Call][relay-first] Phase-2: restartIce() called on publisher PC');
          }
        } catch (e) {
          // Non-fatal — relay is still active and working.
          try { _diag('relay_first_p2p_upgrade_err', { msg: String(e?.message || e) }); } catch {}
        }
      }, 5000);
      // If a remote is already in the room, surface them immediately.
      try {
        const others = Array.from(r.remoteParticipants?.values?.() || []);
        if (others.length > 0) {
          // [bug 2026-05-24] Same gate as ParticipantConnected handler — if
          // we're the caller and haven't seen WS call_accepted yet, the
          // remote is just a pre-connect warm-up (Android FCM preconnect
          // joins LK before user taps Accept). Don't flip UI to connected.
          const remoteIsTrulyConnected = !isCaller || callAcceptedRef.current || isGroupCall;
          setRemoteParticipant(others[0]);
          _refreshRemoteTracks(others[0]);
          if (remoteIsTrulyConnected) {
            setPeerConnected(true);
            callKeep.reportConnected(callId);
          } else {
            peerParticipantConnectedAtRef.current = Date.now();
          }
        }
        for (const p of others) {
          _updateGroupPeer(p.identity, { participant: p, name: p.name || p.identity });
        }
      } catch {}
    });

    r.on(RoomEvent.Reconnecting, () => {
      try { _callDiagAppend('warn', 'LK Room reconnecting', { call_id: callId, count: (reconnectCountRef.current || 0) + 1 }); } catch {}
      console.log('[Call] LiveKit Reconnecting');
      setReconnecting(true);
      // Bump QoS counter for the post-call rating.
      try { reconnectCountRef.current = (reconnectCountRef.current || 0) + 1; } catch {}
      // Arm a hard timeout. If LK doesn't recover within
      // RECONNECT_HARD_TIMEOUT_MS, flip to connectionFailed so the user
      // can act instead of being stranded on the orange banner.
      if (reconnectGraceTimerRef.current) {
        try { clearTimeout(reconnectGraceTimerRef.current); } catch {}
        reconnectGraceTimerRef.current = null;
      }
      reconnectGraceTimerRef.current = setTimeout(() => {
        if (endedRef.current) return;
        try {
          const state = r?.state;
          if (state === ConnectionState.Connected) return;
        } catch {}
        console.warn('[Call] hard reconnect timeout after', RECONNECT_HARD_TIMEOUT_MS, 'ms');
        try { _diag('reconnect_hard_timeout', { ms: RECONNECT_HARD_TIMEOUT_MS }); } catch {}
        setReconnecting(false);
        setConnectionFailed(true);
        try { setErrorMsg(t('call.reconnectFailed') || 'Não foi possível reconectar. Tente novamente.'); } catch {}
      }, RECONNECT_HARD_TIMEOUT_MS);
    });

    r.on(RoomEvent.Reconnected, () => {
      try { _callDiagAppend('info', 'LK Room reconnected', { call_id: callId }); } catch {}
      console.log('[Call] LiveKit Reconnected');
      setReconnecting(false);
      // [2026-05-26] Reset stale video stats on reconnect. The last snapshot
      // before the drop is almost always a "very_poor" / fps=0 reading (the
      // link was dying). If we leave it in place, <PoorConnectionWarning>
      // renders "Conexão fraca" on a freshly healthy room until the adaptive
      // loop's next sample (~3s) overwrites it. Clearing to null makes the
      // warning evaluate to a good default (bucket→'good', fps→0, isPoor=false)
      // so the banner doesn't flash on a recovered call.
      try { setVideoStatsSnapshot(null); } catch {}
      if (reconnectGraceTimerRef.current) {
        try { clearTimeout(reconnectGraceTimerRef.current); } catch {}
        reconnectGraceTimerRef.current = null;
      }
      // [gap D4 2026-05-25 fix] After a reconnect, the SFU may not push a
      // fresh keyframe until the next GOP (4-8s on a 30fps publisher).
      // Until then remote video stays frozen on the last received frame.
      // requestKeyFrame() does NOT exist on livekit-client 2.19's
      // RemoteTrackPublication — the optional chain silently swallowed the
      // call and the keyframe was never requested. Instead nudge the SFU with
      // a real PLI by toggling the remote subscription off→on, which forces a
      // fresh I-frame to land in <300ms. Video publications only — never
      // toggle audio (would cause an audible blip).
      try {
        r.remoteParticipants?.forEach?.((p) => {
          try {
            p.videoTracks?.forEach?.((t) => {
              _nudgeKeyframe(t.publication);
            });
          } catch {}
        });
      } catch {}
    });

    r.on(RoomEvent.Disconnected, (reason) => {
      try { _callDiagAppend('warn', 'LK Room disconnected', { call_id: callId, reason: String(reason), peer_was_connected: peerConnected }); } catch {}
      console.log('[Call] LiveKit Disconnected reason=', reason);
      // [CALL-TRACE 2026-05-20 WAVE42] Step 12b/12 — JS Room dropped. If
      // reason=ClientInitiated it's our own hangup. Anything else combined
      // with peerConnected=false means we never made it (setup-phase fail).
      try {
        console.log('[CALL-TRACE][12b/12] JS Room.Disconnected', {
          callId,
          reason: String(reason),
          peerConnected,
          ts: Date.now(),
        });
      } catch {}
      // ClientInitiated means we called .disconnect() ourselves — already in
      // hangup flow, don't fire another teardown.
      if (endedRef.current) return;
      if (reason === DisconnectReason.CLIENT_INITIATED) return;
      // [bug 2026-05-14 caller-drops-on-answer]
      // If the peer NEVER connected (peerConnected still false), this is a
      // setup-phase disconnect (token expired, room full, network blip) — NOT
      // a real hangup. Sending WS call_end here would derruba the call before
      // the callee finished joining the room → user reports "atendi e
      // encerrou na hora". Surface the error to the UI instead and stay
      // silent on WS so the callee can still join via LiveKit's own retry.
      if (!peerConnected) {
        console.warn('[Call] LiveKit Disconnected BEFORE peer joined — NOT firing handleEndCall (setup-phase)');
        try { setErrorMsg(t('call.connectionFailed') || 'Não foi possível conectar.'); } catch {}
        try { setConnectionFailed(true); } catch {}
        return;
      }
      // For any other reason (network, server kicked, etc.) after the peer
      // had connected, surface "Reconectando..." instead of tearing down.
      // [bug 2026-05-14 caller-drops-on-answer]
      // Auto-teardown here was firing on ICE renegotiation timeouts and
      // killing healthy calls. Only the explicit WS call_end OR the user's
      // End button should terminate.
      console.warn('[Call] LiveKit Disconnected after peer joined — showing Reconnecting');
      setReconnecting(true);
    });

    r.on(RoomEvent.ParticipantConnected, (participant) => {
      if (endedRef.current) return;
      console.log('[Call] Participant connected:', participant.identity);
      // [WAVE 109 2026-05-21] Primary callee-accepted signal: LK ParticipantConnected
      // fires as soon as the callee joins the SFU room, which is faster and more
      // reliable than WS call_accepted (which requires a healthy WS socket on the
      // callee side — can be dead on cold-start from VoIP push).
      //
      // [bug 2026-05-24 ios-caller-auto-answers] BUT: Android preconnect
      // (CallFirebaseMessagingService → NativeCallRoom.preconnect) joins the
      // LK room BEFORE the user taps Accept. So for the CALLER side this
      // event is "callee_ready", not "answered". Gate the answered-side
      // effects on `callAcceptedRef` (set by WS call_accepted on real
      // Accept tap). For the CALLEE side, this event still means the
      // remote (the caller) joined — eager flip is correct.
      setRemoteParticipant(participant);
      _refreshRemoteTracks(participant);
      _updateGroupPeer(participant.identity, { participant, name: participant.name || participant.identity });

      const remoteIsTrulyConnected = !isCaller || callAcceptedRef.current || isGroupCall;
      if (remoteIsTrulyConnected) {
        setPeerConnected(true);
        setPeerRinging(true);
        if (callerTimeoutRef.current) { clearTimeout(callerTimeoutRef.current); callerTimeoutRef.current = null; }
        peerJoinedAtRef.current = Date.now();
        callKeep.reportConnected(callId);
        try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}
      } else {
        // Caller side, no WS call_accepted yet — peer is in LK room as a
        // pre-connect warm-up but hasn't tapped Accept. Don't flip UI to
        // "Conectado", don't stop ringback, don't tell CallKit yet. Stamp
        // the time so call_accepted (if it arrives) knows we already saw
        // ParticipantConnected, and arm a 12s fallback in case WS drops
        // the call_accepted broadcast.
        peerParticipantConnectedAtRef.current = Date.now();
        try { _callDiagAppend('info', 'caller ParticipantConnected — awaiting WS call_accepted', { call_id: callId, peer: participant.identity }); } catch {}
        if (!pendingPeerConnectedFallbackRef.current) {
          pendingPeerConnectedFallbackRef.current = setTimeout(() => {
            pendingPeerConnectedFallbackRef.current = null;
            if (endedRef.current || callAcceptedRef.current) return;
            try { _callDiagAppend('warn', 'caller WS call_accepted fallback — flipping connected via LK presence', { call_id: callId, ms_since_lk_join: Date.now() - peerParticipantConnectedAtRef.current }); } catch {}
            setPeerConnected(true);
            setPeerRinging(true);
            if (callerTimeoutRef.current) { clearTimeout(callerTimeoutRef.current); callerTimeoutRef.current = null; }
            peerJoinedAtRef.current = Date.now();
            try { callKeep.reportConnected(callId); } catch {}
            try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}
          }, 12000);
        }
      }
    });

    r.on(RoomEvent.ParticipantDisconnected, (participant) => {
      console.log('[Call] Participant disconnected:', participant.identity);
      _removeGroupPeer(participant.identity);
      // For 1:1, dropping the only remote means the call is done.
      const remaining = Array.from(r.remoteParticipants?.values?.() || []);
      // [2026-05-26] A slot freed up → re-enable the add-participant UI if we
      // were sitting at the cap. (remaining + local) must be below the cap.
      try {
        if (remaining.length + 1 < MAX_CALL_PARTICIPANTS) setParticipantLimitReached(false);
      } catch {}
      if (remaining.length === 0) {
        setRemoteParticipant(null);
        _refreshRemoteTracks(null);
        // [bug 2026-05-14 caller-drops-on-answer]
        // NEVER auto-teardown from ParticipantDisconnected — this fires too
        // aggressively when ICE re-negotiation happens on strict NAT (CGN
        // cellular). LiveKit will keep re-trying signaling and the peer
        // will rejoin once media path stabilizes. Surface "Reconectando..."
        // instead so the user sees the in-flight state. Real hangup comes
        // via WS call_end {reason:'hangup'} from the peer OR the user
        // pressing the End button.
        if (!isGroupCall && !endedRef.current) {
          console.warn('[Call] ParticipantDisconnected — showing Reconnecting, NOT tearing down');
          setReconnecting(true);
        }
      } else {
        // Switch the 1:1 display to the next remote if our current one left.
        setRemoteParticipant(remaining[0]);
        _refreshRemoteTracks(remaining[0]);
      }
    });

    r.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      console.log('[Call] TrackSubscribed', track.kind, 'from', participant.identity, 'source=', publication.source);
      _refreshRemoteTracks(participant);
      _updateGroupPeer(participant.identity, {
        participant,
        videoTrack: publication.source === Track.Source.Camera ? track : (groupPeersRef.current.get(participant.identity)?.videoTrack || null),
      });
      // [gap D4 2026-05-25 fix] Ask the SFU for a fresh keyframe the moment a
      // remote VIDEO track is subscribed. Otherwise the renderer waits for the
      // next GOP (4-8s on a 30fps publisher) before the first decodable I-frame
      // lands and the tile stays black/frozen until then. requestKeyFrame() is
      // a no-op (doesn't exist on livekit-client 2.19 RemoteTrackPublication),
      // so we nudge a real PLI via a subscription off→on toggle. Remote video only.
      try {
        if (participant !== r.localParticipant && (track?.kind === 'video' || publication?.kind === 'video')) {
          _nudgeKeyframe(publication);
        }
      } catch {}
    });

    r.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      console.log('[Call] TrackUnsubscribed', track.kind, 'from', participant.identity);
      _refreshRemoteTracks(participant);
    });

    r.on(RoomEvent.TrackMuted, (publication, participant) => {
      // Refresh — if a remote mics/cams toggle the publication's isMuted, our
      // peerVideoEnabled / remoteAudioMuted flags need to follow.
      if (participant && participant !== r.localParticipant) {
        _refreshRemoteTracks(participant);
        // [WAVE 104F] Log remote audio mute events (audio only — video mute is less critical).
        try {
          if (publication?.track?.kind === 'audio' || publication?.kind === 'audio') {
            _callDiagAppend('info', 'remote audio track muted', { call_id: callId, participant: participant.identity });
          }
        } catch {}
      }
    });
    r.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      if (participant && participant !== r.localParticipant) {
        _refreshRemoteTracks(participant);
        // [WAVE 104F] Log remote audio unmute events.
        try {
          if (publication?.track?.kind === 'audio' || publication?.kind === 'audio') {
            _callDiagAppend('info', 'remote audio track unmuted', { call_id: callId, participant: participant.identity });
          }
        } catch {}
        // [gap D4 2026-05-25 fix] When a peer re-enables their camera the track
        // unmutes but the SFU won't push an I-frame until the next GOP — the
        // tile stays frozen on the last frame for 4-8s. requestKeyFrame() is a
        // no-op on livekit-client 2.19, so nudge a real PLI by toggling the
        // remote subscription off→on. Remote VIDEO only (never audio).
        try {
          if (publication?.track?.kind === 'video' || publication?.kind === 'video') {
            _nudgeKeyframe(publication);
          }
        } catch {}
      }
    });

    r.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (!participant) return;
      // [WAVE 104F] Log quality changes for remote participant only, and only when poor/lost.
      try {
        const isRemote = participant !== r.localParticipant;
        if (isRemote && (quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost)) {
          _callDiagAppend('warn', 'remote connection quality degraded', { call_id: callId, quality: String(quality) });
        }
      } catch {}
      // We surface the REMOTE quality (the local user already sees their UI
      // freezing if their own connection is bad). Only act as a fallback
      // when our stats poller hasn't produced a sample yet — the raw
      // RTT/loss numbers from getStats are more accurate than LK's coarse
      // Excellent/Good/Poor/Lost enum.
      if (participant !== r.localParticipant) {
        if (!audioStatsRef.current) {
          const s = qualityToScore(quality);
          const lbl = qualityToLabel(quality);
          setQualityScore(s);
          setConnectionQuality(lbl);
        }
      }
    });

    // ActiveSpeakersChanged — LK fires this whenever the set of currently-
    // speaking participants changes (based on audio level). For the 1:1 UI
    // we only care whether the REMOTE peer is in the list, and animate a
    // soft green ring around their avatar while they're talking. Skipped
    // for the group surface (group-call.js owns its own indicator).
    r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      try {
        const remoteSpeakers = (speakers || []).filter(p => p !== r.localParticipant);
        const remoteSpeaking = remoteSpeakers.length > 0;
        if (!isGroupCall) {
          setPeerSpeaking(remoteSpeaking);
          return;
        }
        // Group: mark `isSpeaking` on every known peer so the renderer can
        // dim non-speakers (opacity 0.6 vs 1.0) and float a "X está falando"
        // tag over the active tile.
        const speakingIds = new Set(remoteSpeakers.map(p => p.identity));
        let changed = false;
        for (const [identity, entry] of groupPeersRef.current.entries()) {
          const next = speakingIds.has(identity);
          if (!!entry.isSpeaking !== next) {
            groupPeersRef.current.set(identity, { ...entry, isSpeaking: next });
            changed = true;
          }
        }
        if (changed) setGroupPeers(new Map(groupPeersRef.current));
      } catch {}
    });

    r.on(RoomEvent.LocalTrackPublished, (publication) => {
      // Local camera publication landed — surface for the PiP preview.
      if (publication.source === Track.Source.Camera && publication.videoTrack) {
        setLocalVideoTrack(publication.videoTrack);
      }
    });

    r.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === Track.Source.Camera) {
        setLocalVideoTrack(null);
      }
    });

    // DataPackets (used for in-band signaling: hold, video request, reactions,
    // raise-hand, recording, video-toggle, screen-share, audio-mute).
    // LiveKit emits these as raw bytes — we wrap a JSON payload.
    r.on(RoomEvent.DataReceived, (payload, participant) => {
      try {
        const txt = new TextDecoder().decode(payload);
        const data = JSON.parse(txt);
        _handleDataChannelMessage(data, participant);
      } catch (e) {
        console.warn('[Call] DataReceived parse err:', e?.message);
      }
    });

    _diag('connect_start', { url });
    try {
      // [#1173 WebSocketRTC audit, 2026-05-18] LiveKit's r.connect has no
      // built-in timeout — on a sustained network outage the promise hangs
      // forever and the "Conectando..." UI stays stuck instead of flipping
      // to "connection failed" so the user can retry. WhatsApp times out at
      // ~12s. We use 15s to match LK's internal ICE-gathering ceiling.
      const CONNECT_TIMEOUT_MS = 15000;
      const connectPromise = r.connect(url, token);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('LK connect timeout (15s)')), CONNECT_TIMEOUT_MS);
      });
      await Promise.race([connectPromise, timeoutPromise]);
      _diag('connect_ok');
    } catch (e) {
      _diag('connect_err', { msg: String(e?.message || e), stack: String(e?.stack || '').slice(0, 500), url });
      console.error('[Call] LiveKit connect err:', e?.message);
      if (endedRef.current) return;
      setErrorMsg(t('call.connectionFailed') || 'Não foi possível conectar.');
      setConnectionFailed(true);
      return;
    }

    roomRef.current = r;

    // ───── Audio-quality network polling ─────
    // Sample stats every 5s (after a 2.5s warmup — see livekitTuning).
    // Three jobs:
    //   1. Drive the SignalBars via setAudioStats / setQualityScore / setConnectionQuality
    //   2. Surface live numbers in the diagnostics modal
    //   3. Bump the bitrate ladder when level CHANGES (debounced via
    //      makeLevelChangeFilter so a 145ms↔155ms flicker doesn't thrash)
    if (statsUnsubRef.current) { try { statsUnsubRef.current(); } catch {} }
    levelFilterRef.current = makeLevelChangeFilter();
    sustainedPoorFilterRef.current = makeSustainedPoorFilter(3);
    // [WAVE 44B, 2026-05-21 gap A6] Audio stats poll bumped 5s → 2.5s. The
    // adaptive loop's sustained-poor filter needs 3 consecutive samples to
    // fire ICE restart — at 5s that's 15s of bad audio before recovery.
    // At 2.5s we react in 7.5s, matching WhatsApp's perceived recovery time.
    // makeSustainedPoorFilter still requires `threshold` consecutive samples
    // (default 3) so we don't over-react to single jitter spikes.
    statsUnsubRef.current = pollNetworkStats(r, (sample) => {
      try {
        if (endedRef.current) return;
        setAudioStats(sample);
        const cls = classifyQuality(sample);
        // Map our 0..4 level → 1..5 score consumed by SignalBars + label.
        setQualityScore(cls.level + 1);
        setConnectionQuality(cls.label);
        // Hysteresis: only nudge bitrate on a sustained level change.
        levelFilterRef.current?.(cls, (cc) => {
          applyAdaptiveBitrate(r, cc).catch(() => {});
        });
        // [gap D1] Sustained very_poor (3 samples / 15s) → ICE restart. We
        // rate-limit to one restart per 30s so a stuck-bad network doesn't
        // hammer the SFU. Hook callback exposed for analytics + post-call
        // QoS rating ("we restarted ICE N times").
        sustainedPoorFilterRef.current?.(cls, async () => {
          const now = Date.now();
          if (now - (iceRestartLastAtRef.current || 0) < 30000) return;
          iceRestartLastAtRef.current = now;
          try { _diag('sustained_poor_ice_restart', { rtt: sample.rtt, loss: sample.loss }); } catch {}
          try { reconnectCountRef.current = (reconnectCountRef.current || 0) + 1; } catch {}
          // onSustainedPoorQuality hook — analytics + UI can subscribe.
          try {
            const cb = globalThis.__chatyy_onSustainedPoorQuality;
            if (typeof cb === 'function') cb({ sample, cls });
          } catch {}
          await triggerIceRestart(roomRef.current).catch(() => {});
        });
      } catch {}
    }, 2500);

    // [gap D3 2026-05-20] Subscribe to network handover events so the call
    // forces an ICE restart immediately when iOS NWPathMonitor /
    // Android ConnectivityManager.NetworkCallback report wifi↔cellular
    // transitions. Without this we wait on LK's own re-ICE-on-PC-failure
    // path which can take 8-20s on slow handovers. Rate-limit shares the
    // 30s window with the sustained-poor trigger so we never restart twice
    // in the same second.
    if (networkChangeUnsubRef.current) {
      try { networkChangeUnsubRef.current(); } catch {}
      networkChangeUnsubRef.current = null;
    }
    networkChangeUnsubRef.current = callStateBus.subscribeNetworkChange((info) => {
      if (endedRef.current) return;
      if (!info || (info.type !== 'wifi-to-cellular' && info.type !== 'cellular-to-wifi')) return;
      const now = Date.now();
      if (now - (iceRestartLastAtRef.current || 0) < 30000) return;
      iceRestartLastAtRef.current = now;
      try { _diag('network_handover_ice_restart', { type: info.type }); } catch {}
      try { reconnectCountRef.current = (reconnectCountRef.current || 0) + 1; } catch {}
      triggerIceRestart(roomRef.current).catch(() => {});
    });

    // [2026-05-18 video-quality-push] Adaptive video bitrate.
    // Independent from the audio-level loop above because video has its own
    // bucket math (RTT + packetLoss + qualityLimitationReason from sender
    // stats) and a different cadence (3s vs 5s — react faster on video to
    // avoid frozen frames). Loop calls setPublishingQuality on the
    // LocalVideoTrack so the publish ladder follows network health, AND
    // exposes snapshot consumed by <CallVideoStats /> + <PoorConnectionWarning />.
    try { if (videoTuningStopRef.current) videoTuningStopRef.current(); } catch {}
    videoTuningStopRef.current = startVideoAdaptiveLoop(r, {
      intervalMs: 3000,
      onChange: ({ snapshot }) => {
        if (endedRef.current) return;
        setVideoStatsSnapshot(snapshot);
        // If network falls into very_poor sustained, prompt the user once to
        // switch to audio-only. We never auto-disable the camera.
        if (snapshot.suggestAudioOnly && !audioOnlySuggestedRef.current) {
          audioOnlySuggestedRef.current = true;
          if (videoEnabledRef.current && isVideoCall) {
            try {
              const { Alert } = require('react-native');
              Alert.alert(
                t('call.video.quality.audioOnly') || 'Apenas áudio (rede fraca)',
                t('call.suggestAudioOnly') || 'Conexão muito fraca. Toque para desativar o vídeo.',
                [
                  { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
                  { text: t('call.videoOff') || 'Desligar vídeo', onPress: () => {
                    try { handleToggleVideoRef.current?.(); } catch {}
                  } },
                ],
              );
            } catch {}
          }
        }
        if (!snapshot.suggestAudioOnly && audioOnlySuggestedRef.current) {
          audioOnlySuggestedRef.current = false;
        }
      },
    });

    // Publish our local mic + (optionally) cam. LiveKit calls getUserMedia
    // internally; if perms are denied the promise rejects and we surface an
    // error. Forcing publish AFTER connect is the documented happy path.
    //
    // [bug 2026-05-18 web-mic-permission] On web we pre-flight permission
    // BEFORE asking LiveKit to publish, so a denied/not-secure/unavailable
    // mic surfaces a dedicated modal instead of the silent LK warn.
    const wantMicOn = !audioMutedRef.current;
    if (wantMicOn) {
      const micOk = await _ensureWebMicPermission();
      if (!micOk) {
        _diag('mic_preflight_blocked');
        // Leave the room connected so the user can retry from the modal
        // without re-doing the LK handshake. The modal's "Tentar novamente"
        // calls _ensureWebMicPermission() again and, on success, retries
        // setMicrophoneEnabled. "Cancelar" tears down the call cleanly.
        return;
      }
    }
    try {
      await r.localParticipant.setMicrophoneEnabled(wantMicOn);
    } catch (e) {
      console.warn('[Call] setMicrophoneEnabled err:', e?.message);
      // LK threw despite our pre-flight — classify the error name and
      // surface the modal. Common on Safari where permissions.query is
      // unreliable and LK is the first real consumer of the device.
      if (Platform.OS === 'web') {
        const name = e?.name || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setMicPermissionState('denied');
        } else if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError') {
          setMicPermissionState('unavailable');
        } else {
          setMicPermissionState('unavailable');
        }
      }
    }
    if (isVideoCall) {
      // [2026-05-15 #976] Same camera-permission gate as handleToggleVideo.
      // For video calls that start with isVideo=1 (caller initiated video,
      // or receiver accepted video call), Android still needs runtime CAMERA
      // grant. LK getUserMedia silently fails without it.
      const camGranted = await requestAndroidCameraPermission();
      if (!camGranted) {
        console.warn('[Call] CAMERA permission denied on Android — falling back to audio-only');
        setVideoEnabled(false);
        videoEnabledRef.current = false;
        try { setErrorMsg(t('call.cameraDeniedBody') || 'Câmera não permitida — só áudio'); } catch {}
      } else {
        // [gap C3 2026-05-20] Low-data mode. Two gates:
        //   1. User opted in via Settings → Dados e armazenamento (toggle
        //      writes `chatyy_low_data_calls` AsyncStorage key).
        //   2. Auto-detect: NetInfo says cellular AND OS flagged the link
        //      as expensive (carrier roaming, hotspot tether). We force
        //      low-data even if the toggle is off — user reported "queima
        //      Mb em roaming" without consenting.
        // Cap maxBitrate=200 kbps, 15 fps, 360p target, 2-layer simulcast
        // (180p + 360p — drop the 720p layer the SFU won't pick anyway).
        let lowData = false;
        let userToggleOn = false;
        try {
          const flag = await AsyncStorage.getItem('chatyy_low_data_calls');
          if (flag === 'true' || flag === '1') { lowData = true; userToggleOn = true; }
        } catch {}
        if (!lowData && Platform.OS !== 'web') {
          try {
            const NetInfo = require('@react-native-community/netinfo').default;
            const s = await NetInfo.fetch();
            if (s?.type === 'cellular' && s?.details?.isConnectionExpensive) {
              lowData = true;
            }
          } catch {}
        }
        const camPubOpts = lowData
          ? {
              videoEncoding: { maxBitrate: 200000, maxFramerate: 15 },
              videoSimulcastLayers: [
                { width: 320, height: 180, encoding: { maxBitrate: 90000, maxFramerate: 15 } },
                { width: 640, height: 360, encoding: { maxBitrate: 200000, maxFramerate: 15 } },
              ],
              simulcast: true,
            }
          : undefined;
        try {
          // LK's setCameraEnabled accepts publish opts as 3rd arg (cap opts)
          // on livekit-client 2.x. On older versions the arg is ignored — the
          // adaptive loop above will still pull the bitrate down to the
          // matching bucket on the first poll.
          if (camPubOpts) {
            try { _diag('low_data_mode_on', { auto: !userToggleOn }); } catch {}
            await r.localParticipant.setCameraEnabled(true, undefined, camPubOpts);
          } else {
            await r.localParticipant.setCameraEnabled(true);
          }
          const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera);
          if (camPub?.videoTrack) setLocalVideoTrack(camPub.videoTrack);
        } catch (e) {
          console.warn('[Call] setCameraEnabled err:', e?.message);
          // Fallback: audio-only if camera failed.
          setVideoEnabled(false);
          videoEnabledRef.current = false;
          try { setErrorMsg(t('call.videoUnavailable') || 'Câmera indisponível — usando só áudio'); } catch {}
        }
      }
    }
    } finally {
      // [2026-05-25] Always release the in-flight guard — whether we adopted
      // the native room (early return), connected a JS Room, or bailed on any
      // failure path. Reconnect/retry can now safely re-enter.
      connectingRef.current = false;
    }
  }, [callId, contactEmail, conversationId, isVideoCall, isGroupCall, fetchLivekitToken, t, _refreshRemoteTracks, _updateGroupPeer, _removeGroupPeer]);

  // ───── In-band data channel handler (in-call signaling) ─────
  // Replaces the previous WS-based call_hold / call_audio_muted /
  // call_video_request / call_reaction / call_hand_raise / call_screen_share /
  // call_video_toggle / call_recording. LiveKit DataChannel is faster (no WS
  // hop) and naturally scoped to the room.
  const _handleDataChannelMessage = useCallback((data, participant) => {
    if (!data || typeof data !== 'object') return;
    const fromIdentity = participant?.identity || '';
    const me = (user?.email || '').toLowerCase();
    if (fromIdentity && me && fromIdentity.toLowerCase() === me) return; // own echo

    switch (data.type) {
      case 'hold':
        setPeerOnHold(!!data.on);
        break;
      case 'audio_muted':
        // We don't strictly need this — track-publication mute already
        // gives us the indicator via _refreshRemoteTracks. Keep for parity.
        setRemoteAudioMuted(!!data.muted);
        break;
      case 'video_toggle':
        // Same as audio_muted — publication-level events handle it; keep as
        // an extra signal for snappier UI.
        setPeerVideoEnabled(!!data.enabled);
        break;
      case 'screen_share':
        setPeerScreenSharing(!!data.sharing);
        break;
      case 'recording':
        setRemoteIsRecording(!!data.recording);
        break;
      case 'reaction': {
        if (!data.emoji) return;
        const id = Date.now() + Math.random();
        const x = 20 + Math.random() * (SCREEN_W - 80);
        const anim = new Animated.Value(0);
        setFloatingEmojis(prev => [...prev, { id, emoji: data.emoji, x, anim }]);
        Animated.timing(anim, {
          toValue: 1, duration: 2000, easing: Easing.out(Easing.cubic), useNativeDriver: false,
        }).start(() => setFloatingEmojis(prev => prev.filter(e => e.id !== id)));
        break;
      }
      case 'video_request': {
        if (data.action === 'request') {
          setPendingVideoRequest({ from: fromIdentity || contactEmail });
        } else if (data.action === 'cancel' || data.action === 'declined') {
          const wasWaiting = videoUpgradeRequestedRef.current;
          setPendingVideoRequest(null);
          videoUpgradeRequestedRef.current = false;
          if (videoUpgradeTimeoutRef.current) {
            clearTimeout(videoUpgradeTimeoutRef.current);
            videoUpgradeTimeoutRef.current = null;
          }
          setVideoUpgradeToast(null);
          if (videoUpgradeCountdownRef.current) {
            clearInterval(videoUpgradeCountdownRef.current);
            videoUpgradeCountdownRef.current = null;
          }
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
          setVideoUpgradeToast(null);
          if (videoUpgradeCountdownRef.current) {
            clearInterval(videoUpgradeCountdownRef.current);
            videoUpgradeCountdownRef.current = null;
          }
          // [#978-4] flip call into video mode so showRemoteVideo + the
          // <LK_VideoView> guard at line 2040 stop short-circuiting on the
          // initial audio-only param.
          setIsVideoCall(true);
          try { handleToggleVideo(); } catch {}
        }
        break;
      }
      case 'hand_raise': {
        if (!fromIdentity) return;
        const key = fromIdentity.toLowerCase();
        const existingTimer = handLowerTimersRef.current.get(key);
        if (existingTimer) { try { clearTimeout(existingTimer); } catch {} handLowerTimersRef.current.delete(key); }
        if (data.raised) {
          raisedHandsRef.current.set(key, {
            name: data.name || key.split('@')[0],
            ts: Date.now(),
          });
          const timer = setTimeout(() => {
            raisedHandsRef.current.delete(key);
            setRaisedHands(new Map(raisedHandsRef.current));
            handLowerTimersRef.current.delete(key);
          }, 60000);
          handLowerTimersRef.current.set(key, timer);
        } else {
          raisedHandsRef.current.delete(key);
        }
        setRaisedHands(new Map(raisedHandsRef.current));
        break;
      }
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email, contactEmail, contactName, t]);

  // Helper to send an in-band data message via LiveKit.
  const sendData = useCallback((payload) => {
    const r = roomRef.current;
    if (!r || !r.localParticipant) {
      // [2026-05-25] Adopted-native-room path: the JS Room is null because the
      // native side owns the LK Room (and its data channel). The native bridge
      // does NOT expose a data-publish API, so there is nothing to forward to
      // here — peer mute/video state is mirrored natively via the onLk* events.
      // Guard so callers (handleToggleMute/Video adopt branch) don't throw on a
      // null Room; degrade to a graceful no-op instead of crashing.
      if (globalThis.__chatyyNativeCallActive === true) {
        try {
          const ExpoCallKit = require('../modules/expo-callkit');
          if (typeof ExpoCallKit.lkPublishData === 'function') {
            ExpoCallKit.lkPublishData(JSON.stringify(payload));
          }
        } catch {}
      }
      return;
    }
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      r.localParticipant.publishData(bytes, { reliable: true });
    } catch (e) {
      console.warn('[Call] publishData err:', e?.message);
    }
  }, []);

  // ───── End call ─────
  const handleEndCall = useCallback(() => {
    if (endedRef.current) return;
    // [WAVE 104F] Telemetry — user (or system) ended the call.
    try { _callDiagAppend('info', 'call ended (handleEndCall)', { call_id: callId, peer_connected: peerConnected, duration_s: callDurationRef.current }); } catch {}
    // [debug 2026-05-14 call-drops-on-answer]
    // User reported that when the callee accepts, the caller hangs up
    // within 1s — sending call_end x3 to the WS server. Stack trace
    // here will reveal WHICH event path is firing (LiveKit Disconnected,
    // ParticipantDisconnected, WS call_end echo, AppState change, etc.).
    try {
      console.warn('[Call] handleEndCall TRACE callId=' + callId + ' peer=' + peerConnected);
      console.warn(new Error('handleEndCall stack').stack);
    } catch {}
    endedRef.current = true;
    minimizedRef.current = false;
    _clearGC();
    setEnded(true);
    clearActiveCall();

    try { if (globalThis.__chatyyLastCallInviteId === callId) delete globalThis.__chatyyLastCallInviteId; } catch {}

    if (callerTimeoutRef.current) clearTimeout(callerTimeoutRef.current);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (pendingPeerConnectedFallbackRef.current) {
      try { clearTimeout(pendingPeerConnectedFallbackRef.current); } catch {}
      pendingPeerConnectedFallbackRef.current = null;
    }

    try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}

    // End-call whoosh (440→220Hz descending tone). Skipped when the user
    // disabled UI sounds in Chatyy settings.
    try {
      if (chatyySettingsRef.current?.sounds !== false) {
        const { playEndTone } = require('../services/ringtone');
        playEndTone();
      }
    } catch {}

    // __chatyy_native_call_sync 2026-05-19 — gate the WS hangup. When the
    // native CallActivity (Android Compose) or CallViewController + CallKit
    // (iOS) owns the Room, the CXEndCallAction / finishCall flow has already
    // posted `call_end` to the server via the native CallSignalWs path. JS
    // racing a duplicate `chat_call_end` here is what made the caller side
    // see "Chamada encerrada" before the callee even finished joining
    // (Gap 4 of the earlier native-call audit).
    //
    // Native sets `globalThis.__chatyyNativeCallActive = true` on
    // `onLkConnected` (services/callkeep.installNativeCallStateBridge) and
    // clears it on `onCallEnded`/`onLkDisconnected`. Skip the JS BYE only
    // while the flag is true; web (no native call screen) always falls
    // through to the legacy path.
    const _isNativeRoomConnected = () => {
      try {
        if (Platform.OS === 'web') return false;
        return globalThis.__chatyyNativeCallActive === true;
      } catch { return false; }
    };
    if (!_isNativeRoomConnected()) {
      // WS BYE — peer's ringing-screen / CallKit needs this for cleanup if
      // they never accepted. Send a few times spaced out in case of WS flap.
      const delays = [0, 800, 1800];
      (async () => {
        for (let i = 0; i < delays.length; i++) {
          if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
          try {
            sendSignaling('call_end', {
              call_id: callId,
              target_email: contactEmail,
              reason: 'hangup',
              attempt: i + 1,
            });
          } catch {}
        }
      })().catch(() => {});
    } else {
      console.log('[Call] skip WS call_end — native CallActivity/CallKit owns hangup');
    }

    // Persist to history.
    const dur = Number(callDurationRef.current) || 0;
    addCallToHistory({
      contactEmail,
      contactName: callerName,
      callId,
      type: isCaller ? 'outgoing' : 'incoming',
      video: isVideoCall,
      timestamp: Date.now(),
      duration: dur,
    }).catch(() => {});

    if (dur > 3) {
      try {
        const apiMod = require('../services/api');
        apiMod.callStatus?.(callId, 'completed', dur).catch(() => {});
      } catch {}
    }

    // Stop recording.
    if (isRecording || recordedChunksRef.current.length > 0) {
      if (mediaRecorderRef.current && Platform.OS === 'web' && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch {}
      }
      setTimeout(() => { uploadRecordingAsync().catch(() => {}); }, 500);
    }

    // Disconnect LiveKit (releases mic/cam tracks + leaves room).
    try {
      const r = roomRef.current;
      if (r) {
        try { r.disconnect(); } catch {}
      }
      roomRef.current = null;
    } catch {}

    // Stop the audio-stats poller — prevents the timer from firing after
    // the room is gone and surfacing stale numbers in any lingering modal.
    if (statsUnsubRef.current) {
      try { statsUnsubRef.current(); } catch {}
      statsUnsubRef.current = null;
    }
    levelFilterRef.current = null;
    sustainedPoorFilterRef.current = null;
    // [gap D3 2026-05-20] Tear down network handover subscriber so the
    // stale closure doesn't try to call triggerIceRestart on a disposed Room.
    if (networkChangeUnsubRef.current) {
      try { networkChangeUnsubRef.current(); } catch {}
      networkChangeUnsubRef.current = null;
    }
    // [2026-05-18 video-quality-push] Same teardown for the video adaptive
    // loop. videoTuningStopRef holds the `stop()` returned by
    // startVideoAdaptiveLoop — calling it clears the 3s setInterval +
    // prevents setPublishingQuality from being invoked on a dead track.
    if (videoTuningStopRef.current) {
      try { videoTuningStopRef.current(); } catch {}
      videoTuningStopRef.current = null;
    }

    // Stop LiveKit AudioSession. On iOS, also flip AVAudioSession to
    // setActive(false) via LK so other apps (Music, Spotify, etc) can
    // reclaim the audio focus that we held during the call. Without this
    // the user has to play/pause their music app once to get it back.
    if (Platform.OS !== 'web' && LK_AudioSession) {
      try { LK_AudioSession.stopAudioSession().catch(() => {}); } catch {}
    }

    callKeep.endCall(callId);

    try { setCallActive(false, callId); } catch {}

    wsUnsubsRef.current.forEach(unsub => { try { unsub(); } catch {} });
    wsUnsubsRef.current = [];

    try {
      Animated.timing(endCardAnim, {
        toValue: 1, duration: 220, useNativeDriver: true,
      }).start();
    } catch {}

    // [post-call rating, 2026-05-18]
    // For calls that meaningfully connected (peer joined, duration >= 10s)
    // we show a 1-5 star quality prompt on the end card BEFORE nav-back.
    // The prompt is non-blocking — user can skip or tap outside to dismiss.
    // QoS meta (ttfc / reconnects / final quality / video flag) is shipped
    // server-side so analytics can correlate ratings with infra signals.
    const _navBack = () => {
      try {
        if (router.canGoBack()) router.back();
        else router.replace('/chat');
      } catch {
        try { router.replace('/chat'); } catch {}
      }
    };
    const shouldPromptRating = dur >= 10 && peerConnected;
    if (shouldPromptRating) {
      // Auto-dismiss after 12s if the user doesn't interact. The end card
      // animates in (220ms) before the prompt mounts to avoid a layout
      // flash; mounted via a small delay.
      navAfterEndTimerRef.current = setTimeout(() => {
        setShowRatingPrompt(true);
      }, 350);
      // Hard fallback: if user never picks/skips, nav back at 14s so the
      // app doesn't get stuck on the end card.
      ratingDismissTimerRef.current = setTimeout(_navBack, 14000);
    } else {
      navAfterEndTimerRef.current = setTimeout(_navBack, 1500);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, contactEmail, isCaller, isVideoCall, callerName, isRecording, sendSignaling, router, endCardAnim, peerConnected]);

  // Sync the ref so the global teardown hook always sees the latest.
  useEffect(() => { handleEndCallRef.current = handleEndCall; }, [handleEndCall]);

  // ───── Post-call rating handlers ─────
  // Both paths cancel the auto-nav timers and ship the rating (if any)
  // before navigating away. Fire-and-forget on the network — UI doesn't
  // block on the response.
  const _submitRatingAndNav = useCallback((stars) => {
    if (ratingDismissTimerRef.current) {
      try { clearTimeout(ratingDismissTimerRef.current); } catch {}
      ratingDismissTimerRef.current = null;
    }
    if (navAfterEndTimerRef.current) {
      try { clearTimeout(navAfterEndTimerRef.current); } catch {}
      navAfterEndTimerRef.current = null;
    }
    const r = Math.max(0, Math.min(5, Math.round(Number(stars) || 0)));
    setPendingRating(r);
    if (r > 0) {
      try {
        const apiMod = require('../services/api');
        apiMod.callRate?.(callId, r, {
          ttfc_ms: ttfcMsRef.current || 0,
          duration_sec: callDurationRef.current || 0,
          quality: connectionQuality || 'good',
          reconnects: reconnectCountRef.current || 0,
          was_video: !!isVideoCall,
        }).catch(() => {});
      } catch {}
    }
    setShowRatingPrompt(false);
    // Tiny grace so the user sees their tap register before nav.
    setTimeout(() => {
      try {
        const { router: r2 } = require('expo-router');
        if (r2?.canGoBack?.()) r2.back();
        else r2?.replace?.('/chat');
      } catch {
        try { router.replace('/chat'); } catch {}
      }
    }, r > 0 ? 600 : 0);
  }, [callId, connectionQuality, isVideoCall, router]);

  const handleRatingPick = useCallback((stars) => {
    _hapticTap('medium');
    _submitRatingAndNav(stars);
  }, [_submitRatingAndNav]);

  const handleRatingSkip = useCallback(() => {
    _submitRatingAndNav(0);
  }, [_submitRatingAndNav]);

  // ───── Minimize ─────
  const handleMinimize = useCallback(() => {
    _setGC({
      callId,
      room: roomRef.current,
      wsUnsubs: wsUnsubsRef.current,
      duration: callDurationRef.current,
      contactEmail,
      isCaller,
    });
    minimizedRef.current = true;
    roomRef.current = null;
    wsUnsubsRef.current = [];

    if (router.canGoBack()) router.back();
    else router.replace('/chat');
  }, [callId, contactEmail, isCaller, router]);

  // ───── PSTN fallback (#1183 bad-internet) ─────
  // Lazily fetch the peer's verified phone when LK gives up. We don't preload
  // on mount — most calls connect fine and this is a slow API path.
  useEffect(() => {
    if (!connectionFailed || isGroupCall || peerPhoneLoadedRef.current) return;
    if (!_safePeerEmail || !_safePeerEmail.includes('@')) return;
    peerPhoneLoadedRef.current = true;
    (async () => {
      try {
        const api = require('../services/api');
        const r = await api.profileGet?.(_safePeerEmail);
        // profile_get returns identity.profile.verified_phone when peer verified
        // via Twilio OutgoingCallerIds OR phone_verified at signup. We also
        // accept identity.profile.phone as a soft fallback.
        const prof = r?.data?.identity?.profile || r?.data || {};
        const raw = prof.verified_phone || prof.phone || '';
        const phone = (typeof raw === 'string' ? raw : '').replace(/[^+0-9]/g, '');
        if (phone && /^\+[1-9]\d{6,14}$/.test(phone)) {
          setPeerPhone(phone);
        }
      } catch (e) {
        // Silent — fallback button just won't appear.
      }
    })();
  }, [connectionFailed, _safePeerEmail, isGroupCall]);

  // Tear down the LiveKit room + Verto-SIP dial out using the same Telnyx
  // credentials the dialer uses. Mirrors ChatCallsTab's "internet" call path
  // (voipSipCredentials → startSipCall) so we don't ship two SIP code paths.
  // The PSTN call replaces the LK session — once it's connected the user is
  // talking to peerPhone via Telnyx, not via LiveKit.
  const handlePstnFallback = useCallback(async () => {
    if (pstnFallbackBusy || !peerPhone) return;
    setPstnFallbackBusy(true);
    setErrorMsg(null);
    try {
      // Hard-close any lingering LK room so the audio session isn't double
      // captured (LK + Verto both want the mic on iOS — last writer wins, so
      // the half-dead LK side would steal it back mid-PSTN-call).
      try { roomRef.current?.disconnect(); } catch {}
      roomRef.current = null;

      const api = require('../services/api');
      const credRes = await api.voipSipCredentials?.();
      if (!credRes?.success || !credRes?.data?.sip_user) {
        setErrorMsg(credRes?.message || (t('call.connectionFailed') || 'Não foi possível conectar.'));
        setPstnFallbackBusy(false);
        return;
      }
      const { startSipCall, setTurnCredentials } = require('../services/sipCall');
      if (credRes.data.turn) {
        try { setTurnCredentials(credRes.data.turn); } catch {}
      }
      setPstnFallbackActive(true);
      setConnectionFailed(false);
      setReconnecting(false);
      setErrorMsg(t('call.via.phone') || 'Ligando via telefone…');
      await startSipCall(credRes.data, peerPhone, (state) => {
        if (state === 'registered' || state === 'ringing') {
          setErrorMsg(t('call.ringing') || 'Tocando...');
        } else if (state === 'connected') {
          // Mimic peer-joined state so the timer + UI light up.
          setErrorMsg(null);
          setPeerConnected(true);
        } else if (state === 'ended') {
          setPeerConnected(false);
          setPstnFallbackActive(false);
          setPstnFallbackBusy(false);
          handleEndCallRef.current?.();
        } else if (typeof state === 'string' && state.startsWith('error:')) {
          setPstnFallbackActive(false);
          setPstnFallbackBusy(false);
          setErrorMsg(state.replace(/^error:/, ''));
          setConnectionFailed(true);
        }
      });
    } catch (e) {
      setPstnFallbackBusy(false);
      setPstnFallbackActive(false);
      setErrorMsg(String(e?.message || e));
    }
  }, [pstnFallbackBusy, peerPhone, t]);

  // ───── Reconnect (called when LiveKit fails) ─────
  const handleReconnect = useCallback(async () => {
    if (endedRef.current) return;
    console.log('[Call] manual reconnect requested');
    setConnectionFailed(false);
    setErrorMsg(null);
    // [WAVE 104B] Reset overlay + phase so the fresh connect attempt starts
    // from T+0 "Conectando..." instead of being stuck in 'slow'/'failed'.
    setShowSlowConnectOverlay(false);
    setConnectPhase('connecting');
    setReconnecting(true);
    try {
      const r = roomRef.current;
      if (r) { try { r.disconnect(); } catch {} }
      roomRef.current = null;
    } catch {}
    await connectToRoom();
  }, [connectToRoom]);

  // ───── Main connect effect ─────
  // For both caller and callee, the flow is:
  //   1. Caller side already sent call_invite from chat-conversation (or
  //      IncomingCallListener for callee accepted the invite).
  //   2. We send/wait for call_accepted to sync UI state.
  //   3. Connect to LiveKit room. Both sides will end up in the same room
  //      identified by callId.
  // call_accepted on the caller side comes from the callee tapping Accept.
  // The actual MEDIA negotiation is owned by LiveKit — WS only mediates ring.
  useEffect(() => {
    if (!callId) {
      setErrorMsg('Missing callId');
      return;
    }
    let mounted = true;

    let mailWs;
    try { mailWs = require('../services/websocket').default; } catch {}

    // Subscribe to WS for ring-phase + voicemail.
    let unsubAccepted = () => {};
    let unsubEnd = () => {};
    let unsubMissed = () => {};
    let unsubDeclined = () => {};
    if (mailWs) {
      unsubAccepted = mailWs.on('call_accepted', (data) => {
        if (data?.call_id === callId && mounted) {
          callAcceptedRef.current = true;
          if (callerTimeoutRef.current) clearTimeout(callerTimeoutRef.current);
          try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}
          setPeerRinging(true);
          // Real Accept tap. If the peer was already in the LK Room (warm
          // preconnect on the callee side), flip caller UI to connected now.
          if (peerParticipantConnectedAtRef.current > 0 && !endedRef.current) {
            setPeerConnected(true);
            peerJoinedAtRef.current = Date.now();
            try { callKeep.reportConnected(callId); } catch {}
            try { _callDiagAppend('info', 'caller flip connected via WS call_accepted', { call_id: callId }); } catch {}
          }
          if (pendingPeerConnectedFallbackRef.current) {
            try { clearTimeout(pendingPeerConnectedFallbackRef.current); } catch {}
            pendingPeerConnectedFallbackRef.current = null;
          }
        }
      });

      unsubEnd = mailWs.on('call_end', (data) => {
        if (callAcceptedRef.current && data?.reason === 'declined') return;
        // [bug 2026-05-15 #977-followup phantom-decline-via-WS]
        // The native-side persisted-accept guard (Fixes A+B+C in #977) only
        // covers ExpoCallKit's onCallEnded channel. The WS `call_end`
        // broadcast is a SEPARATE path — when the user accepts via Android
        // heads-up while the app was dead, JS takes 6-10s to mount /call.
        // During that window the caller can ship `call_end` (30s ring
        // timeout, transient network blip retry, multi-device race) and
        // server fans it back to BOTH parties — including the freshly-
        // mounted /call which sees `data.call_id === callId` and ends the
        // call before LiveKit even finishes connecting. Guard: when entering
        // via `autoAccepted=1` on Android, ignore inbound `call_end` for the
        // first 5s. Real peer-hangups happen >> 5s after accept; phantoms
        // ALL land sub-5s.
        if (autoAccepted && Platform.OS === 'android' && data?.call_id === callId) {
          const sinceMount = Date.now() - mountTimeRef.current;
          // [2026-05-15] Bumped 5s → 20s because IncomingCallListener now
          // navigates here IMMEDIATELY (no longer blocks on WS reconnect).
          // call_accepted may take 10-15s to relay over WS on a cold-start
          // accept. During that window the caller can still ship its 30s
          // ring-timeout call_end, which used to slip past the old 5s
          // guard and abort the freshly-accepted call.
          if (sinceMount < 20000) {
            console.warn('[Call] Android phantom WS call_end suppressed (' + sinceMount + 'ms after mount, autoAccepted)');
            try { _diag?.('phantom_ws_call_end_suppressed', { sinceMount, reason: data?.reason || '' }); } catch {}
            return;
          }
        }
        if (data?.call_id === callId && mounted && !endedRef.current) {
          // Peer hung up. Whoosh tone first (handleEndCall will also try,
          // but the early endedRef flip inside handleEndCall could race —
          // playing here guarantees the tone fires when the *peer* ends).
          try {
            if (chatyySettingsRef.current?.sounds !== false) {
              const { playEndTone } = require('../services/ringtone');
              playEndTone();
            }
          } catch {}
          // Peer hung up. Run full teardown.
          handleEndCall();
        }
      });

      // Voicemail surface — caller-side, when callee never accepted.
      const goToVoicemail = (reason, recipient, payload) => {
        if (!isCaller) return;
        if (callAcceptedRef.current) return;
        if (endedRef.current) return;
        endedRef.current = true;
        try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}
        if (callerTimeoutRef.current) clearTimeout(callerTimeoutRef.current);
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        try { roomRef.current?.disconnect?.(); } catch {}
        roomRef.current = null;
        try { setCallActive(false, callId); } catch {}
        try { callKeep.endCall(callId); } catch {}
        try {
          addCallToHistory({
            contactEmail: recipient || contactEmail,
            contactName: callerName,
            callId,
            type: 'outgoing',
            video: isVideoCall,
            timestamp: Date.now(),
            duration: 0,
            status: reason === 'declined' ? 'declined' : 'missed',
          }).catch(() => {});
        } catch {}
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
      unsubMissed = mailWs.on('call_missed', (data) => {
        if (!data || data.call_id !== callId) return;
        if (data.can_leave_voicemail === false) return;
        goToVoicemail('missed', data.recipient_email || contactEmail, data);
      });
      unsubDeclined = mailWs.on('call_declined', (data) => {
        if (!data || data.call_id !== callId) return;
        if (!data.can_leave_voicemail) return;
        goToVoicemail('declined', data.recipient_email || data.email || contactEmail, data);
      });
    }
    // Host-issued mute. Backend relays `call_mute_request` from
    // `chat_call_mute_participant` to the target user's WS channel; we then
    // locally toggle the microphone off so the host sees us drop. Avoids
    // any kick/ban semantics — host can mute, user re-unmutes themselves.
    let unsubMuteRequest = () => {};
    if (mailWs) {
      unsubMuteRequest = mailWs.on('call_mute_request', (data) => {
        if (!data || data.call_id !== callId) return;
        try {
          const r = roomRef.current;
          if (r && r.localParticipant) {
            r.localParticipant.setMicrophoneEnabled(false).catch((e) => {
              try { _callDiagAppend('warn', 'host force-mute setMicrophoneEnabled(false) failed', { call_id: callId, msg: String(e?.message || e).slice(0, 200) }); } catch {}
            });
          }
        } catch {}
        try { setAudioMuted(true); audioMutedRef.current = true; } catch {}
        // Optional toast so the user knows it was the host, not a glitch.
        try {
          const { Alert } = require('react-native');
          Alert.alert(t('call.muted') || 'Mudo', t('call.mutedByHost') || 'O anfitrião silenciou seu microfone.', [
            { text: 'OK' },
          ]);
        } catch {}
      });
    }
    wsUnsubsRef.current = [unsubAccepted, unsubEnd, unsubMissed, unsubDeclined, unsubMuteRequest];

    // [TTFC 2026-05-18] Caller pre-connects to LiveKit IN PARALLEL with
    // the call_invite WS broadcast (WhatsApp parity). Old behavior awaited
    // call_accepted BEFORE connectToRoom(), costing 600-1500ms of
    // "Conectando..." while LK did its WS+JWT+ICE handshake AFTER the
    // callee tapped Atender. Now the caller is already in the SFU room
    // when the callee joins, so ParticipantConnected fires on a fully-
    // warmed room. Callee path (isCaller=false) is unchanged.
    const run = async () => {
      if (isCaller) {
        if (globalThis.__chatyyLastCallInviteId === callId) {
          console.log('[Call] call_invite already sent for', callId);
        } else {
          globalThis.__chatyyLastCallInviteId = callId;
          try { callKeep.startCall(callId, callerName, contactEmail, isVideoCall); } catch {}
          sendSignaling('call_invite', {
            call_id: callId,
            target_email: contactEmail,
            conversation_id: conversationId,
            video: isVideoCall,
          });
        }

        // 60s safety: if no remote ever joins, hang up. Armed BEFORE the
        // parallel connect so a stuck token fetch can't bypass it.
        callerTimeoutRef.current = setTimeout(() => {
          if (mounted && !endedRef.current && !peerConnected) {
            console.log('[Call] caller timeout — no remote joined');
            handleEndCall();
          }
        }, 60000);

        // Fire connectToRoom() WITHOUT awaiting — the LK handshake races
        // alongside the WS ring. Any errors surface via the same
        // setConnectionFailed path the await-flow used.
        connectToRoom().catch((e) => {
          console.error('[Call] parallel connectToRoom err (caller):', e?.message);
          if (mounted && !endedRef.current) {
            setErrorMsg(e?.message || t('call.connectionFailed') || 'Erro ao iniciar chamada');
            setConnectionFailed(true);
          }
        });
        return;
      }

      await connectToRoom();
    };
    run().catch((e) => {
      console.error('[Call] setup err:', e?.message);
      if (mounted) {
        setErrorMsg(e?.message || t('call.connectionFailed') || 'Erro ao iniciar chamada');
        setConnectionFailed(true);
      }
    });

    return () => {
      mounted = false;
      if (callerTimeoutRef.current) clearTimeout(callerTimeoutRef.current);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
      if (videoUpgradeTimeoutRef.current) { clearTimeout(videoUpgradeTimeoutRef.current); videoUpgradeTimeoutRef.current = null; }
      if (videoUpgradeCountdownRef.current) { clearInterval(videoUpgradeCountdownRef.current); videoUpgradeCountdownRef.current = null; }
      if (quickReactionsTimerRef.current) { clearTimeout(quickReactionsTimerRef.current); quickReactionsTimerRef.current = null; }
      // Post-call rating + reconnect grace timers — clean up so a quick
      // back-nav before the user picked a star doesn't leave a stray
      // setTimeout firing on an unmounted screen.
      if (ratingDismissTimerRef.current) { try { clearTimeout(ratingDismissTimerRef.current); } catch {} ratingDismissTimerRef.current = null; }
      if (navAfterEndTimerRef.current) { try { clearTimeout(navAfterEndTimerRef.current); } catch {} navAfterEndTimerRef.current = null; }
      if (reconnectGraceTimerRef.current) { try { clearTimeout(reconnectGraceTimerRef.current); } catch {} reconnectGraceTimerRef.current = null; }

      if (minimizedRef.current) {
        console.log('[Call] unmounting minimized — preserving LiveKit room');
        return;
      }
      wsUnsubsRef.current.forEach(u => { try { u(); } catch {} });
      wsUnsubsRef.current = [];
      if (statsUnsubRef.current) { try { statsUnsubRef.current(); } catch {} statsUnsubRef.current = null; }
      levelFilterRef.current = null;
      if (videoTuningStopRef.current) { try { videoTuningStopRef.current(); } catch {} videoTuningStopRef.current = null; }
      try { roomRef.current?.disconnect?.(); } catch {}
      roomRef.current = null;
      if (Platform.OS !== 'web' && LK_AudioSession) {
        try { LK_AudioSession.stopAudioSession().catch(() => {}); } catch {}
      }
      try { _clearGC(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once

  // ───── Caller ringing tone ─────
  useEffect(() => {
    if (isCaller) {
      try {
        const { startCallingTone, stopRingtone } = require('../services/ringtone');
        startCallingTone();
        return () => stopRingtone();
      } catch {}
    }
  }, [isCaller]);

  // ───── Avatar pulse while waiting ─────
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
  }, [peerConnected, pulseAnim]);

  // ───── Peer-speaking ring (1:1) ─────
  // While the remote is speaking, animate a faint green ring around the
  // avatar (opacity 0.25 → 0.7, scale 1 → 1.12) so the user gets a visual
  // cue of who's talking, similar to ChatList's online dot pulse.
  useEffect(() => {
    if (!peerSpeaking) {
      speakingPulseAnim.stopAnimation?.();
      Animated.timing(speakingPulseAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }).start();
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(speakingPulseAnim, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(speakingPulseAnim, {
          toValue: 0.4,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [peerSpeaking, speakingPulseAnim]);

  // ───── Duration timer ─────
  useEffect(() => {
    if (!peerConnected) return;
    try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}
    timerRef.current = setInterval(() => setCallDuration(d => { callDurationRef.current = d + 1; return d + 1; }), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [peerConnected]);

  // ───── Mute-reminder poll ─────
  // While the local mic is muted, poll LiveKit's localParticipant.audioLevel
  // every 250ms. If the user crosses the speech threshold (and we haven't
  // surfaced the reminder in the last 10s), pop the inline toast for ~3s.
  // Stops when unmuted or call ends. CallAudioStats covers diagnostics; this
  // is the user-facing "Você está mutado" cue.
  useEffect(() => {
    if (!peerConnected || !audioMuted || ended) return;
    let active = true;
    const interval = setInterval(() => {
      if (!active) return;
      try {
        const r = roomRef.current;
        const lp = r?.localParticipant;
        if (!lp) return;
        // LK's Participant.audioLevel is a smoothed 0..1 value. Underlying
        // audio capture continues even when the publication is muted, so
        // levels remain meaningful for self-detection.
        const lvl = Number(lp.audioLevel || 0);
        if (lvl < MUTE_REMINDER_THRESHOLD) return;
        const now = Date.now();
        if (now - lastMuteReminderRef.current < MUTE_REMINDER_COOLDOWN_MS) return;
        lastMuteReminderRef.current = now;
        setMuteReminderVisible(true);
        if (muteReminderHideTimerRef.current) clearTimeout(muteReminderHideTimerRef.current);
        muteReminderHideTimerRef.current = setTimeout(() => {
          setMuteReminderVisible(false);
          muteReminderHideTimerRef.current = null;
        }, 3000);
      } catch {}
    }, 250);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [peerConnected, audioMuted, ended]);

  // [2026-05-26] Auto-dismiss the participant-limit toast after 4s. The add
  // button stays disabled (driven by the same flag) only as long as the cap
  // actually holds — re-tapping a disabled button re-arms this toast. If the
  // room later drops below the cap (a participant leaves) the flag is cleared
  // by the participant-disconnect path; otherwise it just hides the toast.
  useEffect(() => {
    if (!participantLimitReached) return undefined;
    const tHide = setTimeout(() => {
      // Only hide the toast; keep the button disabled if we're still at cap.
      try {
        const r = roomRef.current;
        const occupied = ((r && r.remoteParticipants && r.remoteParticipants.size) || 0) + 1;
        if (occupied < MAX_CALL_PARTICIPANTS) setParticipantLimitReached(false);
        else setParticipantLimitReached(false); // hide toast; re-tap re-shows
      } catch {
        setParticipantLimitReached(false);
      }
    }, 4000);
    return () => clearTimeout(tHide);
  }, [participantLimitReached]);

  // Hide reminder immediately when user unmutes — no point showing it.
  useEffect(() => {
    if (!audioMuted && muteReminderVisible) {
      setMuteReminderVisible(false);
      if (muteReminderHideTimerRef.current) {
        clearTimeout(muteReminderHideTimerRef.current);
        muteReminderHideTimerRef.current = null;
      }
    }
  }, [audioMuted, muteReminderVisible]);

  // ───── Toggles ─────
  const handleToggleMute = useCallback(async () => {
    const r = roomRef.current;
    const newMuted = !audioMutedRef.current;
    // [bug 2026-05-18 web-mic-permission] If the user un-mutes mid-call on
    // web and permission was previously denied/unavailable, pre-flight again
    // and surface the modal instead of silently failing.
    if (!newMuted && Platform.OS === 'web') {
      const micOk = await _ensureWebMicPermission();
      if (!micOk) return;
    }
    // [2026-05-25] Adopted-native-room path. On the iOS CallKit-answer path
    // connectToRoom adopts the pre-connected native LK Room and returns early
    // WITHOUT setting roomRef.current — so the JS Room is null even though the
    // call is fully live (native owns the publisher). Routing the mic toggle
    // through the native bridge here is what keeps mute working after a
    // CallKit answer; otherwise this used to early-return and silently no-op.
    if (!r) {
      if (globalThis.__chatyyNativeCallActive === true) {
        // Optimistic UI flip first so the icon responds instantly.
        setAudioMuted(newMuted);
        audioMutedRef.current = newMuted;
        try {
          const ExpoCallKit = require('../modules/expo-callkit');
          await ExpoCallKit.lkSetMicEnabled?.(!newMuted);
        } catch (e) {
          console.warn('[Call] native lkSetMicEnabled err:', e?.message);
        }
        sendData({ type: 'audio_muted', muted: newMuted });
        resetControlsTimer();
      }
      return;
    }
    setAudioMuted(newMuted);
    audioMutedRef.current = newMuted;
    try {
      await r.localParticipant.setMicrophoneEnabled(!newMuted);
    } catch (e) {
      console.warn('[Call] setMicrophoneEnabled err:', e?.message);
      if (Platform.OS === 'web' && !newMuted) {
        const name = e?.name || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setMicPermissionState('denied');
        } else {
          setMicPermissionState('unavailable');
        }
        // Revert UI mute state since the unmute failed.
        setAudioMuted(true);
        audioMutedRef.current = true;
      }
    }
    sendData({ type: 'audio_muted', muted: newMuted });
    resetControlsTimer();
  }, [resetControlsTimer, sendData, _ensureWebMicPermission]);

  const handleToggleNoiseCancellation = useCallback(() => {
    // [2026-05-17] RNNoise ML noise suppression. LiveKit's default WebRTC AEC/AGC/NS
    // remains on (via audioCaptureDefaults) — this toggle controls the additional
    // RNNoise pass via modules/expo-callkit's setNoiseSuppression bridge. Default ON.
    // The bridge persists the user choice per-device.
    setNoiseCancellation(prev => {
      const next = !prev;
      try {
        const mod = require('../modules/expo-callkit');
        if (typeof mod.setNoiseSuppression === 'function') {
          mod.setNoiseSuppression(next);
        }
      } catch (e) {
        // Native module missing (web / older build) — UI toggle still flips.
        console.log('[Call] setNoiseSuppression bridge unavailable:', e?.message);
      }
      return next;
    });
    _hapticTap('light');
    resetControlsTimer();
  }, [resetControlsTimer]);

  // [2026-05-17, refined 2026-05-18 video-quality-push]
  // Background blur / virtual background. 4-step cycle (WhatsApp/Zoom UX):
  //   off → blur_low (light) → blur_high (strong) → image (virtual bg)
  // Persisted at two layers:
  //   - Native (ExpoCallKit SharedPreferences / App Group UserDefaults) —
  //     authoritative; survives reinstalls.
  //   - JS AsyncStorage (services/videoCallTuning) — instant first-paint
  //     before native bridge resolves.
  // Hidden for audio-only calls since there's no camera frame to process.
  const [backgroundMode, setBackgroundMode] = useState('off');
  const [bgImageAsset, setBgImageAsset] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cached = await getStoredVideoBgMode();
        if (cancelled) return;
        if (cached?.mode && cached.mode !== 'off') {
          setBackgroundMode(cached.mode);
          if (cached.asset) setBgImageAsset(cached.asset);
        }
      } catch {}
      try {
        const mod = require('../modules/expo-callkit');
        const cur = mod.getBackgroundMode?.();
        if (cancelled) return;
        if (cur?.mode) {
          setBackgroundMode(cur.mode);
          if (cur.imageAsset) setBgImageAsset(cur.imageAsset);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);
  const handleCycleBackground = useCallback(() => {
    // 4-step cycle. blur_low = "Blur Light", blur_high = "Blur Strong".
    // blur_medium intentionally skipped so cycle is exactly 4 stops (Zoom's
    // 4-tap pattern). Native module still accepts blur_medium for a future
    // Settings sheet.
    const order = ['off', 'blur_low', 'blur_high', 'image'];
    setBackgroundMode(prev => {
      const idx = Math.max(0, order.indexOf(prev));
      const next = order[(idx + 1) % order.length];
      let imageAsset = null;
      try {
        const mod = require('../modules/expo-callkit');
        if (next === 'image') {
          const list = mod.getBackgroundWallpapers?.() || [];
          // Cycle through wallpapers on subsequent taps so users can preview
          // each one without a separate picker UI. Persist whichever lands.
          if (Array.isArray(list) && list.length > 0) {
            const curIdx = list.indexOf(bgImageAsset || '');
            imageAsset = list[(curIdx + 1) % list.length] || list[0];
          }
          setBgImageAsset(imageAsset);
        } else {
          setBgImageAsset(null);
        }
        if (typeof mod.setBackgroundMode === 'function') {
          mod.setBackgroundMode(next, imageAsset);
        }
      } catch (e) {
        console.log('[Call] setBackgroundMode bridge unavailable:', e?.message);
      }
      // Persist for the next call's first frame.
      try { setStoredVideoBgMode(next, imageAsset).catch(() => {}); } catch {}
      return next;
    });
    _hapticTap('light');
    resetControlsTimer();
  }, [resetControlsTimer, bgImageAsset]);

  const handleToggleHandRaise = useCallback(() => {
    if (!isGroupCall) return;
    const next = !handRaised;
    setHandRaised(next);
    _hapticTap(next ? 'medium' : 'light');
    sendData({
      type: 'hand_raise',
      raised: next,
      name: user?.name || (user?.email || '').split('@')[0],
    });
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
    if (handRaiseTimerRef.current) { clearTimeout(handRaiseTimerRef.current); handRaiseTimerRef.current = null; }
    if (next) {
      handRaiseTimerRef.current = setTimeout(() => {
        setHandRaised(false);
        sendData({ type: 'hand_raise', raised: false, name: user?.name || (user?.email || '').split('@')[0] });
        const me = (user?.email || '').toLowerCase();
        if (me) {
          raisedHandsRef.current.delete(me);
          setRaisedHands(new Map(raisedHandsRef.current));
        }
        handRaiseTimerRef.current = null;
      }, 60000);
    }
    resetControlsTimer();
  }, [isGroupCall, handRaised, user, sendData, resetControlsTimer]);

  const handleToggleVideo = useCallback(async () => {
    const r = roomRef.current;
    // [2026-05-25] Adopted-native-room path. Same root cause as the mute
    // toggle: after a CallKit answer the JS Room is null (native owns the
    // publisher) yet the call is live. Route camera on/off through the native
    // bridge instead of silently early-returning. Native owns the local video
    // renderer, so we only flip UI state + notify the peer here.
    if (!r) {
      if (globalThis.__chatyyNativeCallActive === true) {
        const newVideoEnabled = !videoEnabled;
        // Optimistic UI flip first so the icon responds instantly.
        setVideoEnabled(newVideoEnabled);
        videoEnabledRef.current = newVideoEnabled;
        if (!newVideoEnabled) setLocalVideoTrack(null);
        try {
          const ExpoCallKit = require('../modules/expo-callkit');
          await ExpoCallKit.lkSetCameraEnabled?.(newVideoEnabled);
        } catch (e) {
          console.warn('[Call] native lkSetCameraEnabled err:', e?.message);
        }
        sendData({ type: 'video_toggle', enabled: newVideoEnabled });
        resetControlsTimer();
      }
      return;
    }

    if (videoEnabled) {
      // Turn off.
      try { await r.localParticipant.setCameraEnabled(false); } catch (e) { console.warn(e?.message); }
      setVideoEnabled(false);
      videoEnabledRef.current = false;
      setLocalVideoTrack(null);
      sendData({ type: 'video_toggle', enabled: false });
      resetControlsTimer();
      return;
    }

    // Turning ON — if peer hasn't agreed in an audio-only call, ask first.
    const requestSent = videoUpgradeRequestedRef.current;
    if (!requestSent && peerConnected && !isVideoCall) {
      videoUpgradeRequestedRef.current = true;
      sendData({ type: 'video_request', action: 'request' });
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
      return;
    }
    // Peer accepted (or this is already a video call) — flip our cam on.
    videoUpgradeRequestedRef.current = false;
    if (videoUpgradeTimeoutRef.current) { clearTimeout(videoUpgradeTimeoutRef.current); videoUpgradeTimeoutRef.current = null; }
    // [2026-05-15 #976] Pre-request CAMERA on Android. If call started as
    // audio-only, the permission was never asked → setCameraEnabled silently
    // fails (LK getUserMedia throws). Without this, user toggles video and
    // nothing happens. Returns true on iOS (handled by Info.plist usage).
    const camGranted = await requestAndroidCameraPermission();
    if (!camGranted) {
      try {
        const { Alert } = require('react-native');
        Alert.alert(
          t('call.cameraDeniedTitle') || 'Câmera não permitida',
          t('call.cameraDeniedBody') || 'Você precisa permitir a câmera nas configurações do Android pra usar vídeo.',
        );
      } catch {}
      resetControlsTimer();
      return;
    }
    // [bug 2026-05-15 #978-4 video-toggle-silent-fail]
    // Previously setCameraEnabled errors were only logged via console.warn,
    // user saw nothing and assumed the toggle was broken. Now surface failures
    // (iOS Settings camera-denied, LK room not connected, hardware busy) via
    // a toast/alert AND reset the local state so the icon doesn't appear
    // stuck "trying to turn on". Also fail-fast if roomRef is null (race
    // window before connectToRoom resolves).
    if (!r || !r.localParticipant) {
      try {
        const { Alert } = require('react-native');
        Alert.alert(
          t('call.videoErrorTitle') || 'Câmera indisponível',
          t('call.videoNotReady') || 'A ligação ainda está conectando — espere um instante e tente de novo.',
        );
      } catch {}
      resetControlsTimer();
      return;
    }
    try {
      await r.localParticipant.setCameraEnabled(true);
      setVideoEnabled(true);
      videoEnabledRef.current = true;
      const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera);
      if (camPub?.videoTrack) setLocalVideoTrack(camPub.videoTrack);
      sendData({ type: 'video_toggle', enabled: true });
      // [2026-05-18 video-quality-push] Enable low-light auto-brightness on
      // the AVCaptureDevice (iOS) / CameraX exposure (Android). No-op on
      // older devices that lack manual exposure — applyLowLightAssist returns
      // false silently in that case. User can disable in Settings.
      try {
        const { getStoredLowLightAssist, applyLowLightAssist } = require('../services/videoCallTuning');
        getStoredLowLightAssist().then(enabled => {
          if (enabled) applyLowLightAssist(true);
        }).catch(() => {});
      } catch {}
    } catch (e) {
      const msg = String(e?.message || e || '');
      console.warn('[Call] setCameraEnabled true err:', msg);
      try {
        const { Alert, Linking } = require('react-native');
        // iOS Settings-denied surfaces "NotAllowedError" or "Permission" in
        // the error string. Offer to open Settings so user can re-enable.
        if (/denied|not\s*allowed|permission/i.test(msg) && Platform.OS === 'ios') {
          Alert.alert(
            t('call.cameraDeniedTitle') || 'Câmera não permitida',
            t('call.cameraDeniedIos') || 'O acesso à câmera foi negado. Abra Configurações → Chatyy e ative a Câmera para usar vídeo.',
            [
              { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
              { text: t('common.openSettings') || 'Abrir Configurações', onPress: () => { try { Linking.openSettings(); } catch {} } },
            ]
          );
        } else {
          Alert.alert(
            t('call.videoErrorTitle') || 'Câmera indisponível',
            (t('call.videoErrorBody') || 'Não foi possível ligar a câmera.') + (msg ? ' (' + msg.slice(0, 80) + ')' : ''),
          );
        }
      } catch {}
      // Reset state so the icon stops showing "trying"
      setVideoEnabled(false);
      videoEnabledRef.current = false;
    }
    resetControlsTimer();
  }, [videoEnabled, peerConnected, isVideoCall, sendData, resetControlsTimer, t]);

  // [2026-05-18 video-quality-push] Late-bind for the videoCallTuning loop
  // (created in connectToRoom before handleToggleVideo is declared). The loop
  // calls this when it wants to offer the "switch to audio-only" prompt on
  // very_poor sustained networks.
  useEffect(() => { handleToggleVideoRef.current = handleToggleVideo; }, [handleToggleVideo]);

  // [2026-05-18 video-quality-push] Smooth flip-camera cross-fade.
  // Hard cut on switchCamera looks jarring (mirror flip + facing flip happen
  // in the same frame). We fade the PiP to 30% opacity, wait one frame, do
  // the switch, then fade back — 300ms total.
  const flipCameraFadeAnim = useRef(new Animated.Value(1)).current;

  const handleFlipCamera = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = camPub?.videoTrack;
    if (!track) return;
    // Fade out (150ms), swap camera, fade back in (150ms). useNativeDriver:
    // true here because we're only touching opacity.
    try {
      Animated.timing(flipCameraFadeAnim, {
        toValue: 0.3, duration: 150, useNativeDriver: true,
      }).start();
    } catch {}
    try {
      // LiveKit local video track exposes switchCamera() / restartTrack with
      // new constraints. switchCamera is the snappier path on RN; fall back
      // to restartTrack for web / when switchCamera isn't available.
      if (typeof track.switchCamera === 'function') {
        await track.switchCamera();
      } else if (typeof track.restartTrack === 'function') {
        await track.restartTrack({ facingMode: facingFront ? 'environment' : 'user' });
      }
      setFacingFront(!facingFront);
    } catch (e) {
      console.warn('[Call] flip camera err:', e?.message);
    }
    // Fade back in regardless of switch result.
    try {
      Animated.timing(flipCameraFadeAnim, {
        toValue: 1, duration: 150, useNativeDriver: true,
      }).start();
    } catch {}
    resetControlsTimer();
  }, [facingFront, resetControlsTimer, flipCameraFadeAnim]);

  const handleScreenShare = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const newSharing = !screenSharing;
    try {
      await r.localParticipant.setScreenShareEnabled(newSharing);
      setScreenSharing(newSharing);
      sendData({ type: 'screen_share', sharing: newSharing });
    } catch (e) {
      console.warn('[Call] setScreenShareEnabled err:', e?.message);
      if (Platform.OS === 'android') {
        try {
          const { Alert } = require('react-native');
          Alert.alert(
            t('call.shareScreen') || 'Compartilhar tela',
            t('call.shareScreenUnsupported') || 'Compartilhamento de tela não disponível nesta versão.',
          );
        } catch {}
      }
    }
    resetControlsTimer();
  }, [screenSharing, sendData, resetControlsTimer, t]);

  const handleToggleSpeaker = useCallback(async () => {
    const newSpeakerOn = !speakerOn;
    setSpeakerOn(newSpeakerOn);
    // LiveKit AudioSession on iOS owns route selection. On Android we still
    // call InCallManager because some OEMs ignore AudioSession overrides.
    if (Platform.OS !== 'web' && LK_AudioSession) {
      try {
        if (newSpeakerOn) {
          await LK_AudioSession.selectAudioOutput?.('speaker');
        } else {
          await LK_AudioSession.selectAudioOutput?.('earpiece');
        }
      } catch (e) {
        console.warn('[Call] LK selectAudioOutput err:', e?.message);
      }
    }
    if (Platform.OS === 'android') {
      try {
        const InCallManager = require('react-native-incall-manager').default;
        InCallManager?.setForceSpeakerphoneOn?.(newSpeakerOn);
        if (typeof InCallManager.chooseAudioRoute === 'function') {
          try { InCallManager.chooseAudioRoute(newSpeakerOn ? 'SPEAKER_PHONE' : 'EARPIECE'); } catch {}
        }
      } catch {}
    }
    if (Platform.OS === 'web') {
      // Best-effort setSinkId. LiveKit web routes audio through standard
      // <audio> elements; we walk the DOM and switch their sink.
      try {
        const els = document.querySelectorAll('audio');
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outs = devices.filter(d => d.kind === 'audiooutput');
        const target = newSpeakerOn
          ? (outs.find(d => /speaker|alto/i.test(d.label)) || outs.find(d => d.deviceId === 'default') || outs[0])
          : (outs.find(d => d.deviceId === 'communications' || /earpiece|fone/i.test(d.label)) || outs.find(d => d.deviceId === 'default'));
        if (target) {
          for (const el of els) {
            if (typeof el.setSinkId === 'function') await el.setSinkId(target.deviceId);
          }
        }
      } catch (e) { console.log('[Call] web setSinkId err:', e?.message); }
    }
    resetControlsTimer();
  }, [speakerOn, resetControlsTimer]);

  // Audio device picker — switch to one of 4 fixed routes. LiveKit's
  // selectAudioOutput accepts arbitrary identifiers ('earpiece', 'speaker',
  // 'bluetooth', 'wired'); on Android we also nudge InCallManager because
  // some OEMs ignore the LK override. Fallback flow: if a device isn't
  // physically available the OS just stays on the previous route — UI
  // doesn't error.
  const selectAudioRoute = useCallback(async (route) => {
    setShowAudioPicker(false);
    // Mirror speakerOn so the icon flips correctly when picking speaker/other.
    setSpeakerOn(route === 'speaker');
    if (Platform.OS !== 'web' && LK_AudioSession) {
      try {
        await LK_AudioSession.selectAudioOutput?.(route);
      } catch (e) {
        console.warn('[Call] LK selectAudioOutput route err:', e?.message);
      }
    }
    if (Platform.OS === 'android') {
      try {
        const InCallManager = require('react-native-incall-manager').default;
        if (route === 'speaker') {
          InCallManager?.setForceSpeakerphoneOn?.(true);
          try { InCallManager.chooseAudioRoute?.('SPEAKER_PHONE'); } catch {}
        } else if (route === 'bluetooth') {
          InCallManager?.setForceSpeakerphoneOn?.(false);
          try { InCallManager.chooseAudioRoute?.('BLUETOOTH'); } catch {}
        } else if (route === 'wired') {
          InCallManager?.setForceSpeakerphoneOn?.(false);
          try { InCallManager.chooseAudioRoute?.('WIRED_HEADSET'); } catch {}
        } else {
          InCallManager?.setForceSpeakerphoneOn?.(false);
          try { InCallManager.chooseAudioRoute?.('EARPIECE'); } catch {}
        }
      } catch {}
    }
    resetControlsTimer();
  }, [resetControlsTimer]);

  const openAudioPicker = useCallback(() => {
    if (!peerConnected) return;
    _hapticTap('medium');
    const labels = [
      t('call.audioRouteEarpiece') || 'Auricular',
      t('call.audioRouteSpeaker') || 'Viva-voz',
      t('call.audioRouteBluetooth') || 'Bluetooth',
      t('call.audioRouteWired') || 'Fones de ouvido',
    ];
    if (Platform.OS === 'ios') {
      try {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: [...labels, t('common.cancel') || 'Cancelar'],
            cancelButtonIndex: 4,
            title: t('call.audioRouteTitle') || 'Saída de áudio',
          },
          (idx) => {
            if (idx === 0) selectAudioRoute('earpiece');
            else if (idx === 1) selectAudioRoute('speaker');
            else if (idx === 2) selectAudioRoute('bluetooth');
            else if (idx === 3) selectAudioRoute('wired');
          }
        );
      } catch {
        setShowAudioPicker(true);
      }
    } else {
      // Android / web → Modal sheet.
      setShowAudioPicker(true);
    }
  }, [peerConnected, t, selectAudioRoute]);

  const handleToggleHold = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const newHold = !onHold;
    if (newHold) {
      holdStateRef.current.audioWasMuted = audioMutedRef.current;
      holdStateRef.current.videoWasEnabled = videoEnabledRef.current;
      try { await r.localParticipant.setMicrophoneEnabled(false); } catch {}
      try { await r.localParticipant.setCameraEnabled(false); } catch {}
      setAudioMuted(true);
      audioMutedRef.current = true;
      if (videoEnabledRef.current) {
        setVideoEnabled(false);
        videoEnabledRef.current = false;
        setLocalVideoTrack(null);
      }
    } else {
      const wantMicOn = !holdStateRef.current.audioWasMuted;
      try { await r.localParticipant.setMicrophoneEnabled(wantMicOn); } catch {}
      setAudioMuted(!wantMicOn);
      audioMutedRef.current = !wantMicOn;
      if (holdStateRef.current.videoWasEnabled) {
        try { await r.localParticipant.setCameraEnabled(true); } catch {}
        setVideoEnabled(true);
        videoEnabledRef.current = true;
        const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera);
        if (camPub?.videoTrack) setLocalVideoTrack(camPub.videoTrack);
      }
    }
    setOnHold(newHold);
    sendData({ type: 'hold', on: newHold });
    resetControlsTimer();
  }, [onHold, sendData, resetControlsTimer]);

  // ───── Recording ─────
  const uploadRecordingAsync = useCallback(async () => {
    let uploaded = false;
    try {
      const { uploadCallRecording } = require('../services/api');
      if (Platform.OS === 'web') {
        if (recordedChunksRef.current.length === 0) return;
        const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
        const r = await uploadCallRecording({ blob, name: `recording-${callId}.webm`, type: 'audio/webm' }, null, callId);
        uploaded = !!(r && r.success);
        recordedChunksRef.current = [];
      } else {
        const recording = mediaRecorderRef.current;
        if (!recording) return;
        try {
          await recording.stopAndUnloadAsync();
          const uri = recording.getURI();
          if (uri) {
            const r = await uploadCallRecording({ uri, name: `recording-${callId}.m4a`, type: 'audio/mp4' }, null, callId);
            uploaded = !!(r && r.success);
          }
        } catch {}
      }
    } catch (err) {
      console.warn('[Call] Recording upload err:', err);
    }
    // Stash the callId so the post-call screen (or the chat list) can offer a
    // "Resumo da chamada" entry that routes to /call-recap?callId=<id>.
    // We don't auto-navigate here because the call screen is already mid-
    // teardown — the user gets the prompt next time they open chat list.
    if (uploaded) {
      try {
        if (typeof globalThis !== 'undefined') {
          globalThis.__chatyyLastRecordedCallId = String(callId || '');
        }
      } catch {}
    }
  }, [callId]);

  const handleToggleRecording = useCallback(() => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch {}
      }
      setIsRecording(false);
      sendData({ type: 'recording', recording: false });
    } else {
      try {
        if (Platform.OS === 'web') {
          const audioCtx = new AudioContext();
          const dest = audioCtx.createMediaStreamDestination();
          // Best-effort: pull local mic via a fresh getUserMedia (LiveKit's
          // mic track isn't directly exposed as a MediaStream on web).
          navigator.mediaDevices.getUserMedia({ audio: true }).then(localStream => {
            try {
              const src = audioCtx.createMediaStreamSource(localStream);
              src.connect(dest);
            } catch {}
          }).catch(() => {});
          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';
          const recorder = new MediaRecorder(dest.stream, { mimeType });
          recordedChunksRef.current = [];
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
          };
          recorder.onstop = () => { audioCtx.close().catch(() => {}); };
          recorder.start(1000);
          mediaRecorderRef.current = recorder;
          recordingStartTimeRef.current = Date.now();
          setIsRecording(true);
          sendData({ type: 'recording', recording: true });
        } else {
          (async () => {
            try {
              const { Audio } = require('expo-audio');
              const recording = new Audio.Recording();
              await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
              await recording.startAsync();
              mediaRecorderRef.current = recording;
              recordingStartTimeRef.current = Date.now();
              setIsRecording(true);
              sendData({ type: 'recording', recording: true });
            } catch (err) {
              console.warn('[Call] Failed to start native recording:', err);
            }
          })();
        }
      } catch (err) {
        console.warn('[Call] Recording err:', err);
      }
    }
    resetControlsTimer();
  }, [isRecording, sendData, resetControlsTimer]);

  // ───── Emoji reactions ─────
  const CALL_EMOJIS = useMemo(() => ['❤️', '😂', '😮', '👏', '🔥', '🎉', '👍', '😢'], []);

  const handleSendEmoji = useCallback((emoji) => {
    const id = Date.now() + Math.random();
    const x = 20 + Math.random() * (SCREEN_W - 80);
    const anim = new Animated.Value(0);
    setFloatingEmojis(prev => [...prev, { id, emoji, x, anim }]);
    Animated.timing(anim, {
      toValue: 1, duration: 2000, easing: Easing.out(Easing.cubic), useNativeDriver: false,
    }).start(() => setFloatingEmojis(prev => prev.filter(e => e.id !== id)));
    sendData({ type: 'reaction', emoji });
    // [reaction bar, 2026-05-17] Also fan via WS so peers without an active
    // LK data-channel still see the reaction (mirrors status_reaction event).
    try {
      sendSignaling('call_reaction', {
        call_id: callId,
        conversation_id: conversationId,
        emoji,
      });
    } catch {}
    setShowEmojiBar(false);
    resetControlsTimer();
  }, [sendData, resetControlsTimer, sendSignaling, callId, conversationId]);

  // ───── Add participant ─────
  useEffect(() => {
    if (!showAddParticipant) return;
    let cancelled = false;
    setAddParticipantLoading(true);
    (async () => {
      try {
        const api = require('../services/api');
        const inCall = new Set([
          (user?.email || '').toLowerCase(),
          ...Array.from(groupPeersRef.current?.keys?.() || []).map(e => (e || '').toLowerCase()),
        ]);
        if (contactEmail) inCall.add((contactEmail + '').toLowerCase());

        const seen = new Map();
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

        let members = [];
        if (conversationId) {
          try {
            const r = await api.chatGroupInfo(conversationId);
            members = r?.data?.members || r?.members || [];
          } catch {}
          members.forEach(addCandidate);
        }
        const fetches = [];
        fetches.push((async () => {
          try {
            const c = await api.getContactsList?.();
            const contacts = c?.data?.contacts || c?.contacts || c?.data || c || [];
            if (Array.isArray(contacts)) contacts.forEach(addCandidate);
          } catch {}
        })());
        fetches.push((async () => {
          try {
            const cv = await api.chatConversations?.();
            const convos = cv?.data?.conversations || cv?.conversations || cv?.data || cv || [];
            if (Array.isArray(convos)) {
              convos.forEach(co => {
                if (co?.peer_email) addCandidate({ email: co.peer_email, name: co.peer_name || co.name });
                if (Array.isArray(co?.members)) co.members.forEach(addCandidate);
              });
            }
          } catch {}
        })());
        await Promise.all(fetches);
        if (cancelled) return;
        setAddParticipantCandidates(Array.from(seen.values()));
      } catch (e) {
        if (__DEV__) console.warn('[call.addParticipant.load]', e?.message);
      } finally {
        if (!cancelled) setAddParticipantLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [showAddParticipant, conversationId, user?.email, contactEmail]);

  const handleInviteToCall = useCallback(async (email) => {
    if (!email || addParticipantBusy) return;
    // Hard cap (WhatsApp 2025 parity). Count = local + current remotes. We
    // compare against MAX_CALL_PARTICIPANTS - 1 so the invite slot fits.
    try {
      const r = roomRef.current;
      const remoteCount = (r && r.remoteParticipants && r.remoteParticipants.size) || 0;
      const occupied = remoteCount + 1; // include local participant
      if (occupied >= MAX_CALL_PARTICIPANTS) {
        if (__DEV__) console.warn('[call.invite] cap reached:', occupied);
        // [2026-05-26] Surface the cap instead of a silent no-op + lock the UI.
        setParticipantLimitReached(true);
        return;
      }
    } catch {}
    setAddParticipantBusy(true);
    try {
      const { chatCallInvite } = require('../services/api');
      // The backend ring-fan-out endpoint reuses the same callId — the
      // invitee will join the same LiveKit room when they accept.
      const res = await chatCallInvite(conversationId, callId, [email], !!isVideoCall);
      // [2026-05-26] The backend enforces its own MAX_CALL_PARTICIPANTS. When
      // it rejects (HTTP 403/409 surfaced via the response body) it returns
      // success:false. Detect a limit-reached verdict and lock the add UI with
      // a toast rather than silently swallowing the failure.
      const data = (res && res.data) ? res.data : res;
      const status = res && typeof res.status === 'number' ? res.status : 0;
      const msgStr = String((data && (data.message || data.error || data.code)) || '').toLowerCase();
      const limitHit = status === 403 || status === 409
        || (data && (data.code === 'participant_limit' || data.limit_reached === true))
        || /limit|cheia|lotad|máximo|maximo|full|cap reached|too many/.test(msgStr);
      if (data && data.success === false && limitHit) {
        setParticipantLimitReached(true);
        return;
      }
      // Successful invite — remove the contact from the candidate list.
      setAddParticipantCandidates(prev => prev.filter(c => (c.email || '').toLowerCase() !== email.toLowerCase()));
    } catch (e) {
      if (__DEV__) console.warn('[call.invite]', e?.message);
      // [2026-05-26] A thrown error may also carry a 403/409 status (some
      // transports reject before returning a body). Treat that as limit-hit.
      const st = e && (e.status || e.statusCode);
      if (st === 403 || st === 409 || /limit|lotad|máximo|maximo|full|too many/.test(String(e?.message || '').toLowerCase())) {
        setParticipantLimitReached(true);
      }
    } finally {
      setAddParticipantBusy(false);
    }
  }, [callId, conversationId, isVideoCall, addParticipantBusy]);

  // ───── Video filters (web only — kept as cosmetic stub) ─────
  const VIDEO_FILTERS = useMemo(() => [
    { key: null, label: 'Normal', color: '#fff' },
    { key: 'warm', label: '☀️ Warm', color: '#ff9800' },
    { key: 'cool', label: '❄️ Cool', color: '#03a9f4' },
    { key: 'bw', label: '⬛ B&W', color: '#888' },
    { key: 'vintage', label: '📷 Vintage', color: '#d4a574' },
    { key: 'beauty', label: '✨ Beauty', color: '#e91e63' },
  ], []);

  useEffect(() => {
    AsyncStorage.getItem('call_video_filter').then(saved => {
      if (saved && saved !== 'null') setActiveFilter(saved);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    AsyncStorage.setItem('call_video_filter', activeFilter || 'null').catch(() => {});
  }, [activeFilter]);

  // ───── Status text ─────
  // [WAVE 68 2026-05-21] Honest progressive messages while peer hasn't
  // joined yet. Default "Conectando..." for the first 4s, then
  // "Estabelecendo conexão segura..." up to 15s, then the slow hint. The
  // reconnecting state ALSO only surfaces in the status line after the
  // 5s debounce — `showReconnectBanner` is the gate, not the raw flag.
  let statusText = t('call.connecting') || 'Conectando...';
  if (!peerConnected && !peerRinging) {
    if (isCaller && connectPhase !== 'connecting') {
      // CALLER waiting for the other side to pick up. This is NORMAL ringing
      // (can be 30-45s), NOT a network fault — so never show the alarmist
      // "Verifique sua rede" here just because the callee is slow to answer
      // (or, e.g., their device didn't ack the ring). Show the honest
      // "Chamando..." like WhatsApp. The 60s hard-fail ceiling still catches
      // a genuinely stuck call (connectionFailed below). The establishing/
      // slow escalation stays for the CALLEE side (post-answer media join).
      statusText = t('call.ringing') || 'Chamando...';
    } else if (connectPhase === 'slow') {
      statusText = t('call.slowConnectHint') || 'A conexão está demorando um pouco. Verifique sua rede.';
    } else if (connectPhase === 'establishing') {
      statusText = t('call.establishing') || 'Estabelecendo conexão segura...';
    }
  }
  if (peerRinging && !peerConnected) statusText = t('call.ringing') || 'Chamando...';
  if (connectionFailed) {
    // [2026-05-26] Quem LIGA e nunca teve o outro lado conectado = o destino
    // está offline / não atendeu — NÃO é falha de conexão do caller. Mostrar
    // "Não foi possível conectar" culpa a rede de quem liga e assusta. Mostra
    // a versão graciosa (igual WhatsApp "Sem resposta / Indisponível"). O
    // "Não foi possível conectar" fica só pro caso real de falha de mídia
    // depois que o outro JÁ tinha atendido.
    statusText = (isCaller && !peerConnected)
      ? (t('call.peerNotReachable') || 'Indisponível no momento. Tente de novo.')
      : (t('call.connectionFailed') || 'Não foi possível conectar. Tente novamente.');
  }
  else if (errorMsg) statusText = errorMsg;
  else if (ended) statusText = t('call.ended') || 'Chamada encerrada';
  else if (showReconnectBanner && !peerConnected) statusText = t('call.reconnecting') || 'Reconectando...';
  else if (onHold) statusText = (t('call.onHold') || 'Em espera') + ' · ' + formatDuration(callDuration);
  else if (screenSharing) statusText = t('call.screenSharing') || 'Compartilhando tela';
  else if (peerScreenSharing) statusText = formatDuration(callDuration);
  else if (peerConnected) statusText = formatDuration(callDuration);

  // ───── Signal bars ─────
  // Tapping the bars opens the audio diagnostics modal — same path as
  // More → Diagnóstico, just discoverable from the status strip.
  const SignalBars = ({ quality, score }) => {
    const s = Number(score);
    const level = Number.isFinite(s)
      ? Math.max(0, Math.min(4, s - 1))
      : (quality === 'good' ? 3 : quality === 'medium' ? 2 : 1);
    const bitrateAdapted = level > 0 && level < 2;
    const a11y = bitrateAdapted
      ? (t?.('call.qualityAutoLowered') || 'Reduzimos a qualidade para manter a conexão')
      : (level >= 3
        ? (t?.('call.signalStrong') || 'Sinal forte')
        : (t?.('call.signalWeak') || 'Sinal fraco'));
    return (
      <TouchableOpacity
        onPress={() => setShowAudioStats(true)}
        activeOpacity={0.6}
        style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8 }}
        accessibilityLabel={a11y}
        accessibilityHint={t?.('call.audio.diagnostics.title') || 'Diagnóstico de áudio'}
        accessibilityRole="button"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <ConnectionBars level={level} size={14} />
        {bitrateAdapted && (
          <Svg width={9} height={11} viewBox="0 0 24 24" style={{ marginLeft: 3 }}>
            <SvgPath d="M12 5v14M5 12l7 7 7-7" stroke="#f97316" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </Svg>
        )}
      </TouchableOpacity>
    );
  };
  const showSignalBars = (() => {
    if (!Number.isFinite(qualityScore)) return true;
    if (qualityScore <= 3) return true;
    return callDuration < 5;
  })();

  // Show remote / local video.
  const remoteVideoAvailable = !!remoteVideoTrack && (Platform.OS === 'web' || !!LK_VideoView);
  const showRemoteVideo = isVideoCall && peerConnected && peerVideoEnabled && remoteVideoAvailable;
  const showLocalVideo = videoEnabled && !!localVideoTrack && (Platform.OS === 'web' || !!LK_VideoView);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Remote video — full screen (native). Web uses VideoView too.
          [2026-05-18 video-quality-push] Wrapped in an Animated.View with
          a two-finger pinch responder for 1:1 zoom-on-remote. The transform
          uses useNativeDriver so the scale doesn't trigger a JS-thread relayout
          on each frame. Pinch is intentionally disabled in group calls
          (isGroupCall already routes to group-call.js's own grid renderer).

          IMPORTANT — mirror behavior: remote video is NEVER mirrored. The
          other person should appear to the local user the same way they
          appear to themselves in a real mirror would distort. Only the
          LOCAL preview gets mirror={facingFront} below. */}
      {LK_VideoView && remoteVideoTrack && isVideoCall && peerConnected && peerVideoEnabled && (
        <Animated.View
          {...(!isGroupCall ? remotePinchResponder.panHandlers : {})}
          style={[StyleSheet.absoluteFill, { transform: [{ scale: remoteZoomScale }] }]}
        >
          <LK_VideoView
            videoTrack={remoteVideoTrack}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            zOrder={0}
            mirror={false}
          />
        </Animated.View>
      )}

      {/* Vignette */}
      {showRemoteVideo && (
        <View pointerEvents="none" style={styles.videoVignette}>
          <View style={styles.videoVignetteTop} />
          <View style={styles.videoVignetteBottom} />
          <View style={styles.videoVignetteEdgeLeft} />
          <View style={styles.videoVignetteEdgeRight} />
        </View>
      )}

      {/* [2026-05-18 video-quality-push] Frame-drop / poor-connection toast.
          Suppressed while LK is already showing the "Reconectando..." banner
          so we don't stack overlapping warnings.
          [WAVE 68 2026-05-21] Gate on debounced showReconnectBanner — see
          comment near reconnectMicroVisible above. */}
      {isVideoCall && peerConnected && (
        <PoorConnectionWarning
          snapshot={videoStatsSnapshot}
          suppressed={showReconnectBanner}
          label={t('call.video.poorConnection') || t('call.poorConnection') || 'Conexão fraca'}
        />
      )}

      {/* Video stats peek — opens via long-press on the signal-bars in the
          status strip. Closes on tap (handled by CallVideoStats). */}
      {isVideoCall && peerConnected && (
        <CallVideoStats
          visible={showVideoStats}
          snapshot={videoStatsSnapshot}
          onClose={() => setShowVideoStats(false)}
        />
      )}

      <TouchableOpacity activeOpacity={1} onPress={handleScreenTap} style={StyleSheet.absoluteFill}>
        <View style={[styles.audioOverlay, {
          backgroundColor: showRemoteVideo ? 'transparent' : (isVideoCall ? '#064e3b' : '#1a1a2e'),
        }]}>
          {/* Status strip */}
          {peerConnected && !ended && (
            <Animated.View
              pointerEvents="box-none"
              style={[styles.statusStrip, {
                paddingTop: insets.top + 8,
                opacity: Animated.multiply(controlsFadeAnim, barEnterAnim),
                transform: [{
                  translateY: barEnterAnim.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }),
                }],
              }]}
            >
              <View style={styles.statusStripSide}>
                {/* [2026-05-18 video-quality-push] Long-press the signal-bars
                    area to open the stats peek (FPS / bitrate / RTT / loss).
                    Tap is a no-op so we don't interfere with the regular
                    handleScreenTap (toggles controls). */}
                <TouchableOpacity
                  onLongPress={() => { if (isVideoCall && peerConnected) setShowVideoStats(v => !v); }}
                  delayLongPress={400}
                  activeOpacity={1}
                  style={{ flexDirection: 'row', alignItems: 'center' }}
                  accessibilityRole="button"
                  accessibilityLabel="Estatísticas (segure para abrir)"
                >
                  {showSignalBars && <SignalBars quality={connectionQuality} score={qualityScore} />}
                </TouchableOpacity>
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
                    <SvgPath d="M3 6.5A2.5 2.5 0 015.5 4h13A2.5 2.5 0 0121 6.5v11a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 17.5v-11z" stroke="#fff" strokeWidth={1.6} fill="none" />
                    <SvgPath d="M12.5 12h6v5h-6z" fill="#fff" />
                  </Svg>
                </TouchableOpacity>
              </View>
            </Animated.View>
          )}

          {/* Top bar */}
          <Animated.View style={[styles.topBar, { paddingTop: peerConnected && !ended ? 4 : insets.top + 10, opacity: controlsFadeAnim }]}>
            <TouchableOpacity onPress={handleMinimize} style={styles.backBtn} accessibilityLabel={t('call.minimize') || 'Minimizar'}>
              <IconChevronDown size={22} color="#fff" />
            </TouchableOpacity>
            <View style={styles.topInfo}>
              <Text style={styles.topName} numberOfLines={1}>{callerName}</Text>
              {!peerConnected && (
                <Text style={[styles.topStatus, showReconnectBanner && { color: '#f59e0b' }]}>{statusText}</Text>
              )}
              {peerConnected && (onHold || screenSharing || peerScreenSharing) && (
                <Text style={[styles.topStatus, showReconnectBanner && { color: '#f59e0b' }]}>
                  {onHold ? (t('call.onHold') || 'Em espera')
                    : screenSharing ? (t('call.screenSharing') || 'Compartilhando tela')
                    : (t('call.peerSharing') || 'Tela compartilhada')}
                </Text>
              )}
            </View>
            {peerConnected && (
              <View style={styles.encryptionBadge}>
                <Svg width={11} height={11} viewBox="0 0 24 24" fill="none">
                  <SvgPath d="M7 11V8a5 5 0 0110 0v3M5 11h14v9H5z" stroke="rgba(255,255,255,0.85)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </Svg>
                <Text style={[styles.encryptionText, { marginLeft: 4 }]}>E2E</Text>
              </View>
            )}
          </Animated.View>

          {/* Raised-hand banner */}
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

          {/* Reconnecting overlay (pre-connect) — WAVE 68 gated on the
              5s-debounced showReconnectBanner so transient LK Reconnecting
              flickers (cellular handoff, SFU edge migration) don't paint the
              big orange banner before LK auto-recovers. */}
          {showReconnectBanner && !ended && !peerConnected && (
            <Animated.View
              style={[styles.reconnectBanner, {
                transform: [{
                  translateY: barEnterAnim.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }),
                }],
              }]}
            >
              <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" style={{ marginRight: 8 }}>
                <SvgPath d="M5 12c2-2 5-2 7 0M3 9c4-4 11-4 15 0M7 15c1-1 3-1 4 0" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                <SvgCircleHand cx={12} cy={18.5} r={1.3} fill="#fff" />
                <SvgLine x1={3} y1={21} x2={21} y2={3} stroke="#fff" strokeWidth={1.6} strokeLinecap="round" opacity={0.7} />
              </Svg>
              <Text style={styles.reconnectBannerText}>{t('call.reconnecting') || 'Reconectando…'}</Text>
              <ActivityIndicator size="small" color="rgba(255,255,255,0.9)" style={{ marginLeft: 8 }} />
            </Animated.View>
          )}

          {/* Reconnecting micro-banner (post-connect, media still flowing) */}
          {!ended && (
            <Animated.View
              pointerEvents="none"
              style={[styles.weakBanner, { backgroundColor: 'rgba(255,165,0,0.15)', opacity: reconnectMicroFade }]}
            >
              <Text style={[styles.weakBannerText, { color: 'rgba(255,255,255,0.85)', fontSize: 12 }]}>
                {t('call.reconnecting') || 'Reconectando…'}
              </Text>
            </Animated.View>
          )}

          {/* Screen sharing banner */}
          {screenSharing && peerConnected && !ended && (
            <View style={[styles.screenShareBanner, (isRecording || remoteIsRecording) && { top: 120 }]}>
              <IconScreenShare size={16} color="#fff" />
              <Text style={styles.screenShareBannerText}>
                {t('call.youAreSharing') || 'You are sharing your screen'}
              </Text>
              <TouchableOpacity onPress={handleScreenShare} style={styles.screenShareStopBtn} activeOpacity={0.7}>
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

          {/* Peer hold indicator */}
          {peerOnHold && peerConnected && !ended && (
            <View style={styles.peerMutedBanner}>
              <IconPause size={14} color="#fff" />
              <Text style={styles.peerMutedBannerText}>
                {(t('call.peerOnHold') || '{name} em espera').replace('{name}', callerName)}
              </Text>
            </View>
          )}

          {/* Video upgrade request from peer */}
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
                    sendData({ type: 'video_request', action: 'declined' });
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
                    sendData({ type: 'video_request', action: 'accepted' });
                    setPendingVideoRequest(null);
                    videoUpgradeRequestedRef.current = true;
                    // [#978-4] flip to video mode on peer accept too,
                    // so the remote video element renders when caller's
                    // camera frames arrive.
                    setIsVideoCall(true);
                    if (!videoEnabled) handleToggleVideo();
                  }}
                >
                  <IconVideo size={18} color="#fff" />
                  <Text style={[styles.videoRequestBtnText, { color: '#fff' }]}>{t('common.accept') || 'Aceitar'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* "Você está mutado" reminder — surfaces when the user speaks
              while muted. Cooldown + auto-hide handled in the poll effect. */}
          {muteReminderVisible && !ended && (
            <View style={[styles.weakBanner, { backgroundColor: 'rgba(239, 68, 68, 0.92)', top: 60 }]}>
              <Text style={styles.weakBannerText} numberOfLines={1}>
                {t('call.muteReminder') || 'Você está mutado'}
              </Text>
            </View>
          )}

          {/* Outgoing video upgrade toast */}
          {videoUpgradeToast && !ended && (
            <View style={[styles.weakBanner, { backgroundColor: 'rgba(31,41,55,0.92)', flexDirection: 'row', justifyContent: 'space-between' }]}>
              <Text style={[styles.weakBannerText, { flex: 1 }]} numberOfLines={1}>
                {(t('call.videoRequestSentBody') || 'Aguardando aceitação...') + ' ' + videoUpgradeToast.secondsLeft + 's'}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  sendData({ type: 'video_request', action: 'cancel' });
                  videoUpgradeRequestedRef.current = false;
                  if (videoUpgradeTimeoutRef.current) { clearTimeout(videoUpgradeTimeoutRef.current); videoUpgradeTimeoutRef.current = null; }
                  if (videoUpgradeCountdownRef.current) { clearInterval(videoUpgradeCountdownRef.current); videoUpgradeCountdownRef.current = null; }
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

          {/* [2026-05-26] Participant-limit toast. Shows when the group call
              hits MAX_CALL_PARTICIPANTS (client cap) or the backend rejects an
              invite with a limit-reached verdict. Auto-dismisses via the effect
              below; the add button stays disabled while this stands. */}
          {participantLimitReached && !ended && (
            <View style={[styles.weakBanner, { backgroundColor: 'rgba(31,41,55,0.92)' }]}>
              <Text style={styles.weakBannerText} numberOfLines={2}>
                {t('call.participantLimitReached') || 'Limite de participantes atingido'}
              </Text>
            </View>
          )}

          {/* Center avatar (audio-only / pre-connect) */}
          {!showRemoteVideo && (
            <View style={[styles.centerArea, { paddingTop: insets.top, paddingBottom: insets.bottom + 180 }]}>
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
              {/* Outgoing-calling pulse rings — WhatsApp-style 2 concentric
                  expanding rings while the callee is being rung. Only shows
                  while the peer is in the ringing state and hasn't connected
                  yet. Native driver true (transform + opacity only). */}
              {peerRinging && !peerConnected && (
                <CallingPulseRings size={isVideoCall ? 140 : 168} />
              )}
              {/* Active-speaker ring — soft green halo while the remote peer
                  is talking (1:1 only; group has its own renderer). */}
              {peerConnected && peerSpeaking && !isGroupCall && (
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.speakingRing,
                    {
                      width: 150 + 28,
                      height: 150 + 28,
                      borderRadius: (150 + 28) / 2,
                      opacity: speakingPulseAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.25, 0.85],
                      }),
                      transform: [{
                        scale: speakingPulseAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1, 1.08],
                        }),
                      }],
                    },
                  ]}
                />
              )}
              <Animated.View style={{ transform: [{ scale: peerConnected ? 1 : pulseAnim }] }}>
                <AvatarCircle name={callerName} email={_safePeerEmail} size={150} />
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
                {isGroupCall && handRaised && (
                  <View style={[styles.handRaiseOverlay, { right: -8, top: -8, backgroundColor: '#fbbf24' }]}>
                    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
                      <SvgPath d="M9 11V5.5a1.5 1.5 0 113 0V11M12 11V4a1.5 1.5 0 113 0v8M15 11V5a1.5 1.5 0 113 0v8.5M9 11V8.5a1.5 1.5 0 10-3 0V14a6 6 0 0012 0v-1.5" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                    </Svg>
                  </View>
                )}
              </Animated.View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Text style={[styles.centerName, !isVideoCall && styles.centerNameAudio]} numberOfLines={1}>{callerName}</Text>
                {peerVerified && (
                  <View
                    accessibilityLabel={t('call.verifiedCaller') || 'Verificado'}
                    accessibilityRole="image"
                    style={{ marginTop: 4 }}
                  >
                    <IconVerifiedBadge size={20} color="#34B7F1" />
                  </View>
                )}
                {peerConnected && peerSpeaking && !isGroupCall && (
                  <View
                    style={styles.speakingTag}
                    accessibilityLiveRegion="polite"
                    accessibilityLabel={t('call.audio.speaker.active') || 'Falando'}
                  >
                    <View style={styles.speakingTagDot} />
                    <Text style={styles.speakingTagText}>
                      {t('call.audio.speaker.active') || 'Falando'}
                    </Text>
                  </View>
                )}
              </View>
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
                    accessibilityLabel={t('call.reconnect') || 'Reconectar'}
                    accessibilityRole="button"
                  >
                    <IconPhone size={18} color="#fff" />
                    <Text style={styles.reconnectBtnText}>{t('call.reconnect') || 'Reconectar'}</Text>
                  </TouchableOpacity>
                  {/* #1183 — PSTN fallback button. Only when peer has a verified
                       phone, this is a 1-on-1 (group calls can't bridge to
                       phone), and we aren't already dialing. */}
                  {peerPhone && !isGroupCall && !pstnFallbackActive && (
                    <TouchableOpacity
                      style={styles.reconnectBtn}
                      onPress={handlePstnFallback}
                      activeOpacity={0.7}
                      disabled={pstnFallbackBusy}
                      accessibilityLabel={t('call.via.phone') || 'Ligar via telefone'}
                      accessibilityRole="button"
                    >
                      {pstnFallbackBusy ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <IconPhone size={18} color="#fff" />
                      )}
                      <Text style={styles.reconnectBtnText}>
                        {t('call.via.phone') || 'Ligar via telefone'}
                      </Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={styles.reconnectEndBtn}
                    onPress={handleEndCall}
                    activeOpacity={0.7}
                    accessibilityLabel={t('call.hangUp') || 'Desligar'}
                    accessibilityRole="button"
                  >
                    <IconPhoneOff size={18} color="#fff" />
                    <Text style={styles.reconnectEndBtnText}>{t('call.hangUp') || 'Desligar'}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* Video connected — minimal overlay */}
          {showRemoteVideo && (
            <View style={[styles.centerArea, { paddingTop: insets.top, paddingBottom: insets.bottom + 180 }]}>
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

      {/* Local PiP preview.
          [2026-05-18 video-quality-push]
            • mirror={facingFront} — front camera mirrors (natural — matches
              what user sees in a real bathroom mirror). Rear camera does
              NOT mirror (it should match the world). Remote video is also
              NOT mirrored (see above) so the peer's perspective is preserved.
            • flipCameraFadeAnim — cross-fades to 30% opacity for 150ms during
              switchCamera() to avoid the hard cut when facing flips. */}
      {LK_VideoView && localVideoTrack && videoEnabled && (
        <Animated.View
          {...pipPanResponder.panHandlers}
          style={[
            styles.localVideoContainer,
            {
              top: insets.top + 16,
              transform: pipPosition.getTranslateTransform(),
              opacity: flipCameraFadeAnim,
            },
          ]}
        >
          <LK_VideoView
            videoTrack={localVideoTrack}
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

      {/* More bottom sheet */}
      {showMoreSheet && peerConnected && !ended && (
        <TouchableOpacity activeOpacity={1} onPress={() => setShowMoreSheet(false)} style={styles.moreSheetOverlay}>
          <TouchableOpacity activeOpacity={1} style={[styles.moreSheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.moreSheetHandle} />

            <Text style={styles.moreSheetSectionTitle}>{t('call.reactions') || 'Reacoes'}</Text>
            <View style={styles.moreSheetEmojiRow}>
              {CALL_EMOJIS.map(emoji => (
                <TouchableOpacity key={emoji} onPress={() => { handleSendEmoji(emoji); setShowMoreSheet(false); }} style={styles.emojiBtnItem}>
                  <Text style={{ fontSize: 32 }}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.moreSheetSectionTitle, { marginTop: 16 }]}>{t('call.controls') || 'Controles'}</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={() => { handleToggleHold(); setShowMoreSheet(false); }}
                style={[styles.recordSheetBtn, { flex: 1 }]}
                activeOpacity={0.7}
              >
                <View style={[styles.recordSheetIcon, onHold && styles.recordSheetIconActive]}>
                  {onHold ? <IconPlay size={20} color="#fff" /> : <IconPause size={20} color="#7C3AED" />}
                </View>
                <Text style={styles.recordSheetLabel}>{onHold ? (t('call.unhold') || 'Retomar') : (t('call.hold') || 'Espera')}</Text>
              </TouchableOpacity>
              {/* [2026-05-26] Toggle "Ruído" removido do sheet também — remoção
                  de ruído fica sempre ON por padrão (noiseCancellation=true). */}
            </View>

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

            {/* Audio diagnostics — surfaces the live network stats. Useful for
                support when a user reports "minha chamada tá ruim" — we get a
                concrete RTT/loss/jitter reading instead of a vibe. */}
            <TouchableOpacity
              onPress={() => { setShowAudioStats(true); setShowMoreSheet(false); }}
              style={styles.recordSheetBtn}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('call.audio.diagnostics.title') || 'Diagnóstico de áudio'}
            >
              <View style={[styles.recordSheetIcon, { backgroundColor: 'rgba(124, 58, 237, 0.18)' }]}>
                <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
                  <SvgPath d="M3 12h3l3-9 4 18 3-9h5" stroke="#7C3AED" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                </Svg>
              </View>
              <Text style={styles.recordSheetLabel}>
                {t('call.audio.diagnostics.title') || 'Diagnóstico de áudio'}
              </Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      {/* Audio diagnostics modal — also reachable from settings while in call */}
      <CallAudioStats
        visible={showAudioStats}
        stats={audioStats}
        t={t}
        onClose={() => setShowAudioStats(false)}
      />

      {/* Bottom controls
          [WAVE 104B] Hidden when connectionFailed. The reconnectContainer in
          the center area already exposes "Reconectar" + "Desligar" (+ PSTN
          fallback when available). Showing Mudo/Vídeo/Speaker/Tela alongside
          those was visual noise and introduced duplicate Desligar buttons. */}
      {!ended && !connectionFailed && (
        <Animated.View style={[styles.controlsBar, {
          paddingBottom: insets.bottom + 16,
          opacity: Animated.multiply(controlsFadeAnim, barEnterAnim),
          transform: [{
            translateY: barEnterAnim.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }),
          }],
        }]}>
          {/* Secondary row — hidden when connectionFailed (controls are useless
              before connection; only Reconectar/Desligar matter at that point,
              both of which are in the centered reconnectContainer above).
              [WAVE 104B] Eliminates the "Mudo/Vídeo/Alto-falante/Tela/Ruido Off"
              row visible alongside "Reconectar/Desligar" in the screenshot. */}
          <View style={[styles.controlsRowTop, connectionFailed && { display: 'none' }]}>
            {/* [2026-05-26] Botões "Ruído" (toggle) e "Levantar mão" REMOVIDOS
                a pedido do founder. A remoção de ruído (RNNoise/WebRTC NS) fica
                SEMPRE LIGADA por padrão — não precisa de toggle na UI. Controles
                visíveis ficam: Mudo, Vídeo, Girar, Alto-falante, (Fundo se vídeo),
                Tela, Adicionar, Encerrar. */}

            {/* [2026-05-17 MediaPipe] Background blur / virtual background pill.
                Video-only — audio calls have no camera frame to process. The
                native module cycles the mode and persists it per-device. */}
            {isVideoCall && (
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={handleCycleBackground}
                activeOpacity={0.7}
                accessibilityLabel={backgroundMode === 'off' ? (t('call.backgroundBlur') || 'Desfocar') : (t('call.backgroundChange') || 'Trocar fundo')}
                accessibilityRole="button"
              >
                <View style={[styles.controlBtnCircle, backgroundMode !== 'off' && styles.controlBtnCircleActive]}>
                  <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
                    {/* Stylized "blur circles" — represents the SelfieSegmenter
                        background-blur effect without using emoji. */}
                    <SvgCircleHand cx="8" cy="12" r="3" stroke="#fff" strokeWidth={1.6} />
                    <SvgCircleHand cx="14" cy="9" r="2" stroke="#fff" strokeWidth={1.4} opacity={0.7} />
                    <SvgCircleHand cx="16" cy="15" r="2.5" stroke="#fff" strokeWidth={1.4} opacity={0.7} />
                  </Svg>
                </View>
                <Text style={styles.controlLabel} numberOfLines={1}>
                  {/* [2026-05-18 video-quality-push] Cycle labels for the
                      new 4-step rotation. Falls back to the 2026-05-17 keys
                      so old i18n bundles (OTA mismatch) still render. */}
                  {backgroundMode === 'image'
                    ? (t('call.video.bgBlur.virtual') || t('call.backgroundImage') || 'Fundo virtual')
                    : backgroundMode === 'blur_high'
                      ? (t('call.video.bgBlur.strong') || t('call.backgroundHigh') || 'Forte')
                      : backgroundMode === 'blur_low' || backgroundMode === 'blur_medium'
                        ? (t('call.video.bgBlur.light') || t('call.backgroundLow') || t('call.backgroundMedium') || 'Leve')
                        : (t('call.video.bgBlur.off') || t('call.backgroundOff') || 'Fundo')}
                </Text>
              </TouchableOpacity>
            )}

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

            {peerConnected && (
              <TouchableOpacity
                style={[styles.controlBtn, participantLimitReached && { opacity: 0.4 }]}
                onPress={() => {
                  // [2026-05-26] At the participant cap → don't open the picker;
                  // re-surface the toast so the user knows why it's locked.
                  if (participantLimitReached) { setParticipantLimitReached(true); return; }
                  setShowAddParticipant(true);
                }}
                disabled={participantLimitReached}
                activeOpacity={0.7}
                accessibilityLabel={t('call.addParticipant') || 'Adicionar'}
                accessibilityRole="button"
                accessibilityState={{ disabled: participantLimitReached }}
              >
                <View style={styles.controlBtnCircle}>
                  <IconUserPlus size={22} color="#fff" />
                </View>
                <Text style={styles.controlLabel} numberOfLines={1}>{t('call.addParticipant') || 'Adicionar'}</Text>
              </TouchableOpacity>
            )}

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

          {/* Quick-reactions row */}
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

          {/* Primary row */}
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

            <TouchableOpacity
              style={styles.primaryHangupBtn}
              onPress={handleEndCall}
              activeOpacity={0.7}
              accessibilityLabel={t('call.hangUp') || 'Desligar'}
              accessibilityRole="button"
            >
              <IconPhoneOff size={30} color="#fff" />
            </TouchableOpacity>

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

            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={handleToggleSpeaker}
              onLongPress={openAudioPicker}
              delayLongPress={350}
              activeOpacity={0.7}
              accessibilityLabel={speakerOn ? (t('call.speakerOff') || 'Desligar viva-voz') : (t('call.speakerOn') || 'Viva-voz')}
              accessibilityHint={t('call.audioRouteHint') || 'Pressione e segure para escolher saída'}
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

      {/* Audio output picker (Android/web fallback — iOS uses ActionSheetIOS) */}
      <Modal
        visible={showAudioPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAudioPicker(false)}
      >
        <Pressable style={styles.audioPickerOverlay} onPress={() => setShowAudioPicker(false)}>
          <Pressable style={styles.audioPickerSheet} onPress={(e) => e.stopPropagation?.()}>
            <Text style={styles.audioPickerTitle}>
              {t('call.audioRouteTitle') || 'Saída de áudio'}
            </Text>
            {[
              { id: 'earpiece', label: t('call.audioRouteEarpiece') || 'Auricular' },
              { id: 'speaker', label: t('call.audioRouteSpeaker') || 'Viva-voz' },
              { id: 'bluetooth', label: t('call.audioRouteBluetooth') || 'Bluetooth' },
              { id: 'wired', label: t('call.audioRouteWired') || 'Fones de ouvido' },
            ].map((opt) => {
              const isActive = (opt.id === 'speaker' && speakerOn) || (opt.id === 'earpiece' && !speakerOn);
              return (
                <TouchableOpacity
                  key={opt.id}
                  style={[styles.audioPickerRow, isActive && styles.audioPickerRowActive]}
                  onPress={() => selectAudioRoute(opt.id)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={opt.label}
                >
                  <Text style={styles.audioPickerRowText}>{opt.label}</Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              style={[styles.audioPickerRow, styles.audioPickerCancel]}
              onPress={() => setShowAudioPicker(false)}
              activeOpacity={0.7}
            >
              <Text style={styles.audioPickerCancelText}>
                {t('common.cancel') || 'Cancelar'}
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Add participant modal */}
      <Modal visible={showAddParticipant} transparent animationType="fade" onRequestClose={() => setShowAddParticipant(false)}>
        <Pressable style={styles.addPartOverlay} onPress={() => setShowAddParticipant(false)}>
          <Pressable style={styles.addPartSheet} onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.addPartHeader}>
              <Text style={styles.addPartTitle}>{t('call.addParticipantTitle') || 'Adicionar à chamada'}</Text>
              <TouchableOpacity onPress={() => setShowAddParticipant(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <IconX size={22} color="#fff" />
              </TouchableOpacity>
            </View>

            {/* Currently joined remotes — only shown to the host (isCaller) and
                only for group calls. Each row has a "Silenciar" affordance that
                fires chat_call_mute_participant → backend relays call_mute_request
                → target's local mic is dropped. Avoids the kick/ban concept. */}
            {isGroupCall && isCaller && (() => {
              const r = roomRef.current;
              const joined = r && r.remoteParticipants
                ? Array.from(r.remoteParticipants.values())
                : [];
              if (joined.length === 0) return null;
              return (
                <View style={{ marginBottom: 12 }}>
                  <Text style={[styles.addPartEmail, { marginBottom: 8, fontWeight: '600' }]}>
                    {t('call.inCallSection') || 'Em chamada'}
                  </Text>
                  {joined.slice(0, MAX_CALL_PARTICIPANTS).map((p) => {
                    const ident = p?.identity || '';
                    const display = p?.name || ident.split('@')[0];
                    return (
                      <View key={ident} style={styles.addPartRow}>
                        <AvatarCircle email={ident} name={display} size={40} />
                        <View style={{ flex: 1, marginLeft: 12 }}>
                          <Text style={styles.addPartName} numberOfLines={1}>{display}</Text>
                          <Text style={styles.addPartEmail} numberOfLines={1}>{ident}</Text>
                        </View>
                        <TouchableOpacity
                          onPress={async () => {
                            try {
                              const { chatCallMuteParticipant } = require('../services/api');
                              await chatCallMuteParticipant(conversationId, callId, ident);
                            } catch (e) {
                              if (__DEV__) console.warn('[call.hostMute]', e?.message);
                            }
                          }}
                          style={[styles.addPartCallBtn, { backgroundColor: 'rgba(255,255,255,0.15)' }]}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel={t('call.muteParticipant') || 'Silenciar participante'}
                        >
                          <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>
                            {t('call.mute') || 'Mudo'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              );
            })()}

            {addParticipantLoading && addParticipantCandidates.length === 0 ? (
              <Text style={styles.addPartEmpty}>{t('call.addParticipantLoading') || 'Carregando contatos...'}</Text>
            ) : addParticipantCandidates.length === 0 ? (
              <Text style={styles.addPartEmpty}>{t('call.addParticipantEmpty') || 'Nenhum contato disponível para adicionar.'}</Text>
            ) : (
              <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
                {addParticipantCandidates.map((m) => {
                  const email = m.email || '';
                  const name = m.display_name || m.name || email.split('@')[0];
                  return (
                    <TouchableOpacity
                      key={email}
                      style={[styles.addPartRow, participantLimitReached && { opacity: 0.4 }]}
                      onPress={() => handleInviteToCall(email)}
                      disabled={addParticipantBusy || participantLimitReached}
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

      {/* [bug 2026-05-18 web-mic-permission] Mic permission modal — web only.
          Variants:
            denied        → user blocked → instruct settings + Help link
            unavailable   → no mic / OS error → retry + cancel
            not_secure    → page on HTTP → cannot recover from this UI
       */}
      {Platform.OS === 'web' && micPermissionState !== 'idle' && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => { setMicPermissionState('idle'); try { handleEndCallRef.current && handleEndCallRef.current(); } catch {} }}
        >
          <View style={styles.micPermOverlay}>
            <View style={styles.micPermCard}>
              <View style={styles.micPermIconWrap}>
                <IconMicOff size={42} color="#ef4444" />
              </View>
              <Text style={styles.micPermTitle}>
                {micPermissionState === 'denied'
                  ? (t('call.web.micDeniedTitle') || 'Microfone bloqueado')
                  : micPermissionState === 'not_secure'
                  ? (t('call.web.notSecure') || 'Ligações precisam de HTTPS')
                  : (t('call.web.micPermissionTitle') || 'Permita o microfone')}
              </Text>
              <Text style={styles.micPermBody}>
                {micPermissionState === 'denied'
                  ? (t('call.web.micDeniedBody') || 'Você bloqueou o microfone. Permita nas configurações do navegador e tente novamente.')
                  : micPermissionState === 'not_secure'
                  ? (t('call.web.notSecureBody') || 'Abra o site usando https:// para fazer ligações pelo navegador.')
                  : (t('call.web.micPermissionBody') || 'Para ligar pelo navegador, precisamos acessar seu microfone.')}
              </Text>

              {/* Action buttons. not_secure has no recoverable action — only
                  cancel. denied + unavailable both expose Retry + Help. */}
              <View style={styles.micPermActions}>
                {micPermissionState !== 'not_secure' && (
                  <TouchableOpacity
                    style={[styles.micPermBtn, styles.micPermBtnPrimary]}
                    onPress={handleMicPermissionRetry}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={t('call.web.tryAgain') || 'Tentar novamente'}
                  >
                    <Text style={styles.micPermBtnPrimaryText}>
                      {micPermissionState === 'denied'
                        ? (t('call.web.tryAgain') || 'Tentar novamente')
                        : (t('call.web.allow') || 'Permitir')}
                    </Text>
                  </TouchableOpacity>
                )}

                {micPermissionState === 'denied' && (
                  <TouchableOpacity
                    style={[styles.micPermBtn, styles.micPermBtnSecondary]}
                    onPress={handleMicPermissionHelp}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={t('call.web.howToPermit') || 'Como permitir?'}
                  >
                    <Text style={styles.micPermBtnSecondaryText}>
                      {t('call.web.howToPermit') || 'Como permitir?'}
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={[styles.micPermBtn, styles.micPermBtnGhost]}
                  onPress={() => {
                    setMicPermissionState('idle');
                    try { handleEndCallRef.current && handleEndCallRef.current(); } catch {}
                  }}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={t('call.web.cancel') || t('common.cancel') || 'Cancelar'}
                >
                  <Text style={styles.micPermBtnGhostText}>
                    {t('call.web.cancel') || t('common.cancel') || 'Cancelar'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* Slow-connect overlay
          [WAVE 104B] Guard includes !connectionFailed so the T+15s overlay is
          never visible simultaneously with the T+25s failed state. The primary
          dismiss happens in the T+25s callback (setShowSlowConnectOverlay(false))
          but this guard is defense-in-depth against any future state-machine
          race between the two timers. */}
      {showSlowConnectOverlay && !connectionFailed && !peerConnected && !peerRinging && !ended && (
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            justifyContent: 'center', alignItems: 'center',
            backgroundColor: 'rgba(0,0,0,0.55)', zIndex: 998,
          }}
          accessibilityLiveRegion="polite"
          accessibilityLabel={t('call.connecting') || 'Conectando...'}
        >
          <View style={{
            paddingVertical: 20, paddingHorizontal: 28,
            borderRadius: 18, backgroundColor: 'rgba(20,20,28,0.92)',
            alignItems: 'center', maxWidth: 320,
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
                marginTop: 16, paddingVertical: 10, paddingHorizontal: 22,
                backgroundColor: '#dc2626', borderRadius: 999,
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

      {/* End-state card */}
      {ended && (
        <Animated.View
          pointerEvents={showRatingPrompt ? 'box-none' : 'none'}
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

            {/* [post-call rating, 2026-05-18] 1-5 star QoS prompt. Only
                rendered when shouldPromptRating was true at hangup time
                (peer connected + dur >= 10s). Star tap calls callRate
                with ttfc / reconnects / quality meta, then navigates. */}
            {showRatingPrompt && (
              <View style={styles.ratingPromptBlock}>
                <Text style={styles.ratingPromptTitle}>
                  {t('call.rating.title') || 'Como foi a sua chamada?'}
                </Text>
                <View style={styles.ratingStarsRow}>
                  {[1, 2, 3, 4, 5].map(n => {
                    const active = pendingRating >= n;
                    return (
                      <TouchableOpacity
                        key={n}
                        onPress={() => handleRatingPick(n)}
                        activeOpacity={0.6}
                        accessibilityRole="button"
                        accessibilityLabel={(t('call.rating.starsAria') || '{n} de 5 estrelas').replace('{n}', String(n))}
                        hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                        style={styles.ratingStarBtn}
                      >
                        <Svg width={32} height={32} viewBox="0 0 24 24" fill={active ? '#fbbf24' : 'none'}>
                          <SvgPath
                            d="M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.58L12 17.6l-5.9 3.08 1.13-6.58L2.45 9.44l6.6-.96L12 2.5z"
                            stroke={active ? '#fbbf24' : 'rgba(255,255,255,0.55)'}
                            strokeWidth={1.6}
                            strokeLinejoin="round"
                          />
                        </Svg>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TouchableOpacity
                  onPress={handleRatingSkip}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={t('call.rating.skip') || 'Pular'}
                  style={styles.ratingSkipBtn}
                  hitSlop={{ top: 6, bottom: 6, left: 12, right: 12 }}
                >
                  <Text style={styles.ratingSkipText}>
                    {t('call.rating.skip') || 'Pular'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </Animated.View>
      )}
    </View>
  );
}

// ───── Outgoing-call pulse rings ─────
// Two concentric expanding rings (scale 1 → 1.4, opacity 0.6 → 0) staggered
// by 600ms — the classic WhatsApp "Calling..." cue. Local Animated.Value
// pair so we don't pollute the parent's render frequency. Native driver
// enabled (only transform + opacity touched).
function CallingPulseRings({ size = 168 }) {
  const a1 = useRef(new Animated.Value(0)).current;
  const a2 = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const mk = (val, delay) => Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(val, {
          toValue: 1,
          duration: 1400,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(val, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ])
    );
    const l1 = mk(a1, 0);
    const l2 = mk(a2, 600);
    l1.start();
    l2.start();
    return () => { l1.stop(); l2.stop(); };
  }, [a1, a2]);

  const renderRing = (val) => (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.callingPulseRing,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          opacity: val.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
          transform: [{
            scale: val.interpolate({ inputRange: [0, 1], outputRange: [1, 1.4] }),
          }],
        },
      ]}
    />
  );

  return (
    <>
      {renderRing(a1)}
      {renderRing(a2)}
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  audioOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 5 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, zIndex: 10 },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  topInfo: { flex: 1, marginLeft: 12 },
  topName: { color: '#fff', fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  topStatus: { color: 'rgba(255,255,255,0.72)', fontSize: 13, marginTop: 1, fontWeight: '500', fontVariant: ['tabular-nums'] },
  encryptionBadge: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, gap: 3,
  },
  encryptionText: { color: 'rgba(255,255,255,0.6)', fontSize: 10, fontWeight: '600' },
  centerArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 180 },
  pulseRing: { position: 'absolute', borderRadius: 999, borderWidth: 1 },
  pulseRingOuter: { width: 200, height: 200, borderColor: 'rgba(255,255,255,0.08)' },
  pulseRingInner: { width: 170, height: 170, borderColor: 'rgba(255,255,255,0.12)' },
  // Outgoing "calling" rings — bright white expanding rings (WhatsApp style).
  callingPulseRing: {
    position: 'absolute',
    borderRadius: 999,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.55)',
  },
  // 1:1 active-speaker green halo.
  speakingRing: {
    position: 'absolute',
    borderWidth: 3,
    borderColor: '#34d399',
  },
  // "Falando" tag — WhatsApp-style pill next to the peer name. Pairs with
  // the green halo ring so users get both a visual + textual cue.
  speakingTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 8,
    marginTop: 4,
    gap: 5,
  },
  speakingTagDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#10b981',
  },
  speakingTagText: {
    color: '#a7f3d0',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  // Audio output picker (Android/web).
  audioPickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  audioPickerSheet: {
    backgroundColor: '#1c1c1e',
    paddingTop: 18,
    paddingBottom: 22,
    paddingHorizontal: 20,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  audioPickerTitle: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 10,
    textAlign: 'center',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  audioPickerRow: {
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  audioPickerRowActive: {
    backgroundColor: 'rgba(52,211,153,0.18)',
  },
  audioPickerRowText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  audioPickerCancel: {
    marginTop: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  audioPickerCancelText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  // [bug 2026-05-18 web-mic-permission] Mic permission modal — centered card.
  micPermOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  micPermCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 18,
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 20,
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
  },
  micPermIconWrap: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: 'rgba(239,68,68,0.15)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
  },
  micPermTitle: {
    color: '#fff', fontSize: 18, fontWeight: '700',
    textAlign: 'center', marginBottom: 8,
  },
  micPermBody: {
    color: 'rgba(255,255,255,0.7)', fontSize: 14, lineHeight: 20,
    textAlign: 'center', marginBottom: 18,
  },
  micPermActions: {
    width: '100%',
    gap: 8,
  },
  micPermBtn: {
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micPermBtnPrimary: { backgroundColor: '#7C3AED' },
  micPermBtnPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  micPermBtnSecondary: { backgroundColor: 'rgba(255,255,255,0.10)' },
  micPermBtnSecondaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  micPermBtnGhost: { backgroundColor: 'transparent' },
  micPermBtnGhostText: { color: 'rgba(255,255,255,0.55)', fontSize: 14, fontWeight: '600' },
  centerName: { color: '#fff', fontSize: 29, fontWeight: '700', marginTop: 24, textAlign: 'center', letterSpacing: -0.5 },
  centerStatus: { color: 'rgba(255,255,255,0.62)', fontSize: 15, marginTop: 7, fontWeight: '500', letterSpacing: 0.2, fontVariant: ['tabular-nums'] },
  endedHint: { color: 'rgba(255,255,255,0.4)', fontSize: 13, marginTop: 12 },
  reconnectContainer: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center', gap: 12, marginTop: 26, paddingHorizontal: 16 },
  reconnectBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#7C3AED', paddingHorizontal: 22, paddingVertical: 13, borderRadius: 30,
    shadowColor: '#7C3AED', shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 6,
  },
  reconnectBtnText: { color: '#fff', fontSize: 15.5, fontWeight: '700', letterSpacing: -0.2 },
  reconnectEndBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#ef4444', paddingHorizontal: 22, paddingVertical: 13, borderRadius: 30,
    shadowColor: '#ef4444', shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 6,
  },
  reconnectEndBtnText: { color: '#fff', fontSize: 15.5, fontWeight: '700', letterSpacing: -0.2 },
  controlsBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    zIndex: 20, alignItems: 'center', paddingTop: 22, paddingHorizontal: 24,
    backgroundColor: 'rgba(10,8,20,0.62)',
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.08)',
    ...Platform.select({ web: { backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)' }, default: {} }),
  },
  controlsRowTop: {
    flexDirection: 'row', justifyContent: 'center',
    flexWrap: 'wrap', rowGap: 14, columnGap: 18, marginBottom: 20,
  },
  controlBtn: { alignItems: 'center', gap: 7, width: 60 },
  controlBtnCircle: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.10)',
  },
  controlBtnCircleActive: { backgroundColor: 'rgba(124,58,237,0.55)', borderColor: 'rgba(167,139,250,0.6)' },
  controlBtnCircleScreenShare: { backgroundColor: '#7C3AED', borderColor: 'rgba(167,139,250,0.7)' },
  controlLabel: { color: 'rgba(255,255,255,0.72)', fontSize: 11, fontWeight: '600', textAlign: 'center', letterSpacing: -0.1 },
  localVideoContainer: {
    position: 'absolute', right: 16, top: 16,
    width: 110, height: 156, borderRadius: 20, overflow: 'hidden', zIndex: 30,
    elevation: 14, borderWidth: 2, borderColor: 'rgba(167,139,250,0.5)',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
  localVideo: { flex: 1 },
  pipFlipBtn: {
    position: 'absolute', bottom: 6, right: 6,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
  },
  recordingBanner: {
    position: 'absolute', top: 80, left: 20, right: 20,
    backgroundColor: 'rgba(239, 68, 68, 0.9)', borderRadius: 12,
    paddingVertical: 8, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', zIndex: 15,
  },
  recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#fff', marginRight: 8 },
  recordingBannerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  recordSheetBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8 },
  recordSheetIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  recordSheetIconActive: { backgroundColor: '#ef4444' },
  recordSheetLabel: { color: '#fff', fontSize: 15, fontWeight: '500' },
  weakBanner: {
    position: 'absolute', top: 100, left: 20, right: 20,
    backgroundColor: 'rgba(239, 68, 68, 0.85)',
    borderRadius: 12, paddingVertical: 8, paddingHorizontal: 16,
    alignItems: 'center', zIndex: 15,
  },
  weakBannerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  screenShareBanner: {
    position: 'absolute', top: 80, left: 20, right: 20,
    backgroundColor: 'rgba(124, 58, 237, 0.9)',
    borderRadius: 12, paddingVertical: 8, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, zIndex: 15,
  },
  screenShareBannerText: { color: '#fff', fontSize: 13, fontWeight: '600', flex: 1 },
  screenShareStopBtn: {
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4,
  },
  screenShareStopBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  peerScreenShareBanner: {
    position: 'absolute', top: 80, left: 20, right: 20,
    backgroundColor: 'rgba(59, 130, 246, 0.9)',
    borderRadius: 12, paddingVertical: 8, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', gap: 8, zIndex: 15,
  },
  peerMutedBanner: {
    position: 'absolute', top: 80, alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    borderRadius: 18, paddingVertical: 6, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', gap: 6, zIndex: 16,
  },
  peerMutedBannerText: { color: '#fff', fontSize: 13, fontWeight: '500' },
  handRaiseOverlay: {
    position: 'absolute', top: -4, right: -4,
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#f59e0b',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#000',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 4, zIndex: 8,
  },
  handRaiseBanner: {
    position: 'absolute', top: 70, alignSelf: 'center',
    backgroundColor: 'rgba(245, 158, 11, 0.95)',
    borderRadius: 18, paddingVertical: 6, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', maxWidth: '85%', zIndex: 17,
  },
  handRaiseBannerText: { color: '#fff', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  videoRequestSheet: {
    position: 'absolute', bottom: 240, left: 24, right: 24,
    backgroundColor: 'rgba(20, 20, 26, 0.97)',
    borderRadius: 24, paddingTop: 28, paddingBottom: 20, paddingHorizontal: 24,
    zIndex: 30, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 32, shadowOffset: { width: 0, height: 12 }, elevation: 24,
  },
  videoRequestIconCircle: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#7c3aed',
    alignItems: 'center', justifyContent: 'center', marginBottom: 14,
    shadowColor: '#7c3aed', shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 6 },
  },
  videoRequestTitle: { color: '#fff', fontSize: 17, fontWeight: '700', marginBottom: 6, textAlign: 'center', letterSpacing: -0.2 },
  videoRequestSubtitle: { color: 'rgba(255,255,255,0.6)', fontSize: 13, textAlign: 'center', marginBottom: 22, lineHeight: 18 },
  videoRequestActions: { flexDirection: 'row', gap: 10, width: '100%' },
  videoRequestBtn: {
    flex: 1, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  videoRequestBtnDecline: { backgroundColor: 'rgba(239, 68, 68, 0.9)' },
  videoRequestBtnAccept: {
    backgroundColor: '#22c55e',
    shadowColor: '#22c55e', shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  videoRequestBtnText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  moreSheetOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 45, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  moreSheet: {
    backgroundColor: 'rgba(30,30,30,0.97)',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 12, paddingHorizontal: 20,
    ...Platform.select({ web: { backdropFilter: 'blur(20px)' }, default: {} }),
  },
  moreSheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', alignSelf: 'center', marginBottom: 16 },
  moreSheetSectionTitle: {
    color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10, marginLeft: 4,
  },
  moreSheetEmojiRow: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 4 },
  emojiBtnItem: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  addPartOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  addPartSheet: {
    width: '100%', maxWidth: 420,
    backgroundColor: '#16151c',
    borderRadius: 24, paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.1)',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, elevation: 20,
  },
  addPartHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 12, paddingBottom: 12 },
  addPartTitle: { color: '#fff', fontSize: 18, fontWeight: '800', letterSpacing: -0.4 },
  addPartEmpty: { color: 'rgba(255,255,255,0.6)', textAlign: 'center', paddingVertical: 32, paddingHorizontal: 24, fontSize: 14, lineHeight: 20 },
  addPartRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 18,
    ...(Platform.OS === 'web' ? { transition: 'background-color 160ms ease', cursor: 'pointer' } : {}),
  },
  addPartName: { color: '#fff', fontSize: 15.5, fontWeight: '700', letterSpacing: -0.2 },
  addPartEmail: { color: 'rgba(255,255,255,0.55)', fontSize: 12.5, fontWeight: '500', marginTop: 2 },
  addPartCallBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#25D366', alignItems: 'center', justifyContent: 'center', marginLeft: 10 },
  statusStrip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, zIndex: 11 },
  statusStripSide: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 24 },
  statusStripCenter: { minWidth: 64, alignItems: 'center', justifyContent: 'center' },
  statusStripDuration: {
    position: 'absolute', bottom: 200, alignSelf: 'center',
    color: '#fff', fontSize: 14, fontWeight: '700',
    fontVariant: ['tabular-nums'], letterSpacing: 0.5,
    backgroundColor: 'rgba(0,0,0,0.42)', paddingHorizontal: 12, paddingVertical: 4,
    borderRadius: 12, overflow: 'hidden',
    ...Platform.select({ web: { backdropFilter: 'blur(8px)' }, default: {} }),
  },
  pipBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  centerNameAudio: { fontSize: 33, fontWeight: '800', letterSpacing: -0.8, marginTop: 28 },
  videoVignette: { ...StyleSheet.absoluteFillObject, zIndex: 1 },
  videoVignetteTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 90, backgroundColor: 'rgba(0,0,0,0.45)' },
  videoVignetteBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 220, backgroundColor: 'rgba(0,0,0,0.55)' },
  videoVignetteEdgeLeft: { position: 'absolute', top: 90, bottom: 220, left: 0, width: 14, backgroundColor: 'rgba(124,58,237,0.06)' },
  videoVignetteEdgeRight: { position: 'absolute', top: 90, bottom: 220, right: 0, width: 14, backgroundColor: 'rgba(124,58,237,0.06)' },
  controlsRowPrimary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 4, marginBottom: 4, gap: 6,
  },
  primaryBtn: { alignItems: 'center', justifyContent: 'flex-start', flex: 1, gap: 7, paddingTop: 4 },
  primaryBtnCircle: {
    width: 58, height: 58, borderRadius: 29,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.10)',
  },
  primaryBtnCircleActive: { backgroundColor: 'rgba(124,58,237,0.6)', borderColor: 'rgba(167,139,250,0.65)' },
  primaryBtnLabel: { color: 'rgba(255,255,255,0.88)', fontSize: 11.5, fontWeight: '600', textAlign: 'center', letterSpacing: -0.1 },
  primaryHangupBtn: {
    width: 66, height: 66, borderRadius: 33,
    backgroundColor: '#ef4444',
    alignItems: 'center', justifyContent: 'center',
    marginTop: 4,
    shadowColor: '#ef4444', shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  quickReactionsRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 32,
    paddingHorizontal: 8, paddingVertical: 6, marginBottom: 12,
    alignSelf: 'center', gap: 4,
    ...Platform.select({ web: { backdropFilter: 'blur(12px)' }, default: {} }),
  },
  quickReactionBtn: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  endCardOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center', justifyContent: 'center', zIndex: 60,
    ...Platform.select({ web: { backdropFilter: 'blur(18px)' }, default: {} }),
  },
  endCard: {
    alignItems: 'center', paddingHorizontal: 32, paddingVertical: 28,
    backgroundColor: 'rgba(28,28,32,0.92)',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.08)',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 12 },
    minWidth: 240, maxWidth: '80%',
  },
  endCardName: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: 14, letterSpacing: -0.3, textAlign: 'center' },
  endCardRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 6 },
  endCardLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '500' },
  endCardDot: { color: 'rgba(255,255,255,0.4)', fontSize: 13, marginHorizontal: 2 },
  endCardDuration: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  // [post-call rating, 2026-05-18] Tucked inside endCard. Title + 5 stars
  // row + Skip ghost button. Stars use SVG (no emoji per project rule).
  ratingPromptBlock: {
    marginTop: 18,
    alignItems: 'center',
    width: '100%',
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.10)',
  },
  ratingPromptTitle: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 12,
    letterSpacing: -0.15,
  },
  ratingStarsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    marginBottom: 10,
  },
  ratingStarBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ratingSkipBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginTop: 2,
  },
  ratingSkipText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    fontWeight: '600',
  },
  reconnectBanner: {
    position: 'absolute', top: 80, left: 16, right: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,158,11,0.95)', borderRadius: 14,
    paddingVertical: 10, paddingHorizontal: 16, zIndex: 18,
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  reconnectBannerText: { color: '#fff', fontSize: 13.5, fontWeight: '700', letterSpacing: -0.1 },
});

// ───── Call-specific ErrorBoundary ─────
// If a render path throws inside CallScreen, the generic app boundary would
// show a "tente novamente" page that does NOT tear down the LiveKit room —
// the user can't even hang up. Show a single big red "Desligar" button that
// disconnects via __chatyyTeardownActiveCall + router.back().
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
          flex: 1, backgroundColor: '#0a0a0f',
          alignItems: 'center', justifyContent: 'center', padding: 32,
        }}>
          <View style={{
            width: 64, height: 64, borderRadius: 32,
            backgroundColor: 'rgba(239,68,68,0.15)',
            alignItems: 'center', justifyContent: 'center', marginBottom: 20,
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

// [#1144 2026-05-19] Single-call-screen contract. The user reported "2 sistemas
// de ligação — às vezes aparece aquele Java que nós tínhamos, às vezes parece
// um mais novo". Root cause: both the RN /call.js screen AND the native
// CallActivity (Android) / CallViewController (iOS) were being mounted in
// parallel — depending on the entry point (router.push from chat-conversation,
// IncomingCallListener cold-start, push notification handler, OngoingCallBar
// reopen) one or the other would win the foreground. We standardize on the
// NATIVE Compose/SwiftUI screen for mobile. /call.js stays for web. On mobile
// native we dispatch openNativeCall and immediately router.back() so the JS
// stack never renders the RN call UI behind the native activity.
//
// Why a redirect (not a Redirect/router-config rewrite): every existing
// router.push('/call?...') caller (chat-conversation.js, ChatCallsTab,
// OngoingCallBar, CallStatusBar, IncomingCallListener, pushNotifications.js,
// app/one.js) keeps working without edits — preserves the deep-link surface.
//
// [#1208 2026-05-19] Foreground-outgoing gate. User insight:
// "quando o iOS faz ligação ele abre o nativo para ligar aí dá conflito —
// o nativo é só pra receber, pq pra ligar ele já tá dentro do app". The
// native CallActivity / CallViewController exists primarily so the OS-level
// CallKit/IncomingCallActivity flow can ring → answer → render even when the
// app is killed. When the user is already INSIDE the app (foreground) and
// taps "Ligar", switching to the native screen LOSES features (invite friend,
// audio→video upgrade, screenshare, group grid, emoji reactions) that only
// exist in the JS /call.js — and confuses the user with "duas telas
// diferentes" that look inconsistent.
//
// New behavior:
//   - OUTGOING + AppState.currentState === 'active'  → render /call.js (JS UI)
//   - OUTGOING + app NOT foreground (Siri shortcut / background widget) → native
//   - INCOMING + foreground (rare, listener already hands off)         → JS UI
//   - INCOMING + background/killed (the common cold-start ring path)   → native
//
// Native side ALSO double-checks (single source of truth — see iOS
// ExpoCallKitModule.startOutgoingCall and Android ExpoCallKitModule.openNativeCall/
// startOutgoingCall foreground gate). The JS-side check here is the cheap
// fast-path so we don't pay the bridge roundtrip when we know we're foreground.
function MobileNativeBridge() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const dispatchedRef = useRef(false);

  useEffect(() => {
    if (dispatchedRef.current) return;
    dispatchedRef.current = true;
    const callId = String(params.callId || `call_${Date.now()}`);
    const contactName = String(params.contactName || params.name || '');
    const contactEmail = String(params.contactEmail || params.email || '');
    const isVideo = params.isVideo === '1' || params.isVideo === 'true' || params.isVideo === 1 || params.isVideo === true;
    const isCaller = params.isCaller === '1' || params.isCaller === 'true' || params.isCaller === 1 || params.isCaller === true;
    const conversationId = String(params.conversationId || '');

    // [#1217 2026-05-19] FULL NATIVE — user decision after dual-UI
    // conflicts kept resurfacing. Every call (outgoing or incoming, foreground
    // or background) dispatches to the native CallActivity / CallViewController.
    // The JS /call.js screen is now a stateless thin shell: it bridges to
    // native, pops itself, and the native UI takes over as the foreground.
    // No more renderJsUI branch, no more foreground gate. Native module is
    // the single source of truth for call presentation.
    (async () => {
      try {
        const callkit = require('../modules/expo-callkit');
        if (isCaller && callkit?.startOutgoingCall) {
          await callkit.startOutgoingCall({
            callee_email: contactEmail,
            callee_name: contactName || contactEmail,
            is_video: !!isVideo,
            conversation_id: conversationId,
            call_id: callId,
          });
        } else if (callkit?.openNativeCall) {
          await callkit.openNativeCall({
            callId,
            callerName: contactName || contactEmail,
            callerEmail: contactEmail,
            hasVideo: !!isVideo,
          });
        }
      } catch (e) {
        console.warn('[CallScreen #1144] native dispatch failed:', e?.message || e);
      } finally {
        // Pop the placeholder route so user is back in chat — native CallActivity
        // / CallViewController is now the foreground.
        setTimeout(() => { try { router.back(); } catch {} }, 50);
      }
    })();
  }, []);

  // [#1217] Full-native path: render nothing — the native CallActivity /
  // CallViewController owns the foreground. We pop ourselves via router.back()
  // inside the dispatch effect above. Returning null prevents the JS UI from
  // flashing during the brief window between mount and pop.
  return null;
}

export default function CallScreen(props) {
  // ALWAYS call hooks at the top — Rules of Hooks requires unconditional
  // invocation. We read params here once and branch below.
  const params = useLocalSearchParams();
  const isOutgoing = params?.isCaller === '1' || params?.isCaller === 'true'
    || params?.isCaller === 1 || params?.isCaller === true;

  // Web always renders the rich JS UI — no native call module on web.
  if (Platform.OS === 'web') {
    return (
      <CallErrorBoundary>
        <CallScreenInner {...props} />
      </CallErrorBoundary>
    );
  }

  // [2026-05-20 restore foreground gate — WhatsApp/Telegram parity]
  // Mobile: decide between JS rich UI and the native dispatcher per the
  // call direction. Default is native (the post-#1217 baseline) so the
  // common cold-start / push-incoming path keeps working unchanged. The
  // ONE exception is an outgoing call (isCaller=1) — that route is only
  // reached via voipNative's foreground gate (it skips the native module
  // and router.push('/call?...isCaller=1')), so by the time we get here
  // the user is INSIDE the app and expects the rich JS UI with invite-
  // friend, audio↔video upgrade, screenshare, group grid, raise hand, etc.
  //
  // For incoming calls (isCaller=0, dispatched from IncomingCallListener
  // / pushNotifications / VoipPushAppDelegateSubscriber / Android
  // CallFirebaseMessagingService), we keep the native dispatch path so
  // CallKit (iOS) and Telecom + FullScreenIntent (Android) remain in
  // charge of the lock-screen / background ring/answer surface.
  if (isOutgoing) {
    return (
      <CallErrorBoundary>
        <CallScreenInner {...props} />
      </CallErrorBoundary>
    );
  }

  // Incoming / cold-start fallback — dispatch to native and pop.
  return <MobileNativeBridge />;
}
