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
} from 'react-native';
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
import {
  IconMic, IconMicOff, IconVideo, IconVideoOff, IconPhoneOff,
  IconVolume2, IconVolume, IconArrowLeft, IconChevronDown, IconCameraFlip, IconScreenShare,
  IconPause, IconPlay, IconMoreHorizontal, IconPhone, IconRecord,
  IconZap, IconUserPlus, IconX, IconSearch, IconVerifiedBadge,
} from '../components/Icons';
import { setCallActive } from '../components/IncomingCallListener';
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
  } = params;

  const peerVerified = callerVerifiedParam === '1'
    || callerVerifiedParam === 1
    || callerVerifiedParam === true
    || callerVerifiedParam === 'true';

  const { user } = useAuth();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const isCaller = isCallerParam === '1' || isCallerParam === 'true';
  const isVideoCall = isVideoParam === '1' || isVideoParam === 'true';

  // Null safety for peer display.
  const _safePeerName = (() => {
    if (contactName && typeof contactName === 'string' && contactName.trim()) return contactName.trim();
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

  // Group raise-hand state (signaling-only, keeps the existing host banner).
  const [handRaised, setHandRaised] = useState(false);
  const [raisedHands, setRaisedHands] = useState(new Map());
  const raisedHandsRef = useRef(new Map());
  const handRaiseTimerRef = useRef(null);
  const handLowerTimersRef = useRef(new Map());

  // Remote/local LiveKit tracks → RN VideoView refs.
  const [remoteParticipant, setRemoteParticipant] = useState(null);
  const [remoteVideoTrack, setRemoteVideoTrack] = useState(null);
  const [remoteScreenShareTrack, setRemoteScreenShareTrack] = useState(null);
  const [localVideoTrack, setLocalVideoTrack] = useState(null);
  // Group: keep a map of remote participant identity → { participant, videoTrack, name }
  // The 1:1 UI ignores this; the group renderer can read it.
  const [groupPeers, setGroupPeers] = useState(new Map());
  const groupPeersRef = useRef(new Map());

  // Slow-connect overlay (#892 fix 3): pre-connect > 8s → explicit Conectando overlay.
  useEffect(() => {
    if (peerConnected || peerRinging || ended) {
      setShowSlowConnectOverlay(false);
      return;
    }
    const t8 = setTimeout(() => setShowSlowConnectOverlay(true), 8000);
    return () => clearTimeout(t8);
  }, [peerConnected, peerRinging, ended]);

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
        const snapX = g.moveX > SCREEN_W / 2 ? SCREEN_W - 126 : 16;
        const snapY = Math.max(60, Math.min(g.moveY - 80, SCREEN_H - 340));
        Animated.spring(pipPosition, { toValue: { x: snapX, y: snapY }, friction: 7, tension: 100, useNativeDriver: false }).start();
      },
    })
  ).current;

  // ───── Refs ─────
  const roomRef = useRef(null);
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

  // Mute toggle UI shake when peer is on hold.
  const reconnectMicroVisible = reconnecting && peerConnected && !ended;
  useEffect(() => {
    Animated.timing(reconnectMicroFade, {
      toValue: reconnectMicroVisible ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [reconnectMicroVisible, reconnectMicroFade]);

  // ───── WS signaling (RINGING only — call_invite / call_accepted / call_end) ─────
  const sendSignaling = useCallback((type, data) => {
    try {
      const mailWs = require('../services/websocket').default;
      if (mailWs.isConnected) {
        mailWs._send({ type, ...data });
      }
    } catch {}
  }, []);

  // Mark call active so IncomingCallListener doesn't fire over it.
  useEffect(() => {
    setCallActive(true, callId);
    return () => {
      if (!minimizedRef.current) setCallActive(false, callId);
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
        try { r.localParticipant.setCameraEnabled(false); } catch {}
      } else if (nextState === 'active') {
        if (videoEnabledRef.current && !onHold) {
          try { r.localParticipant.setCameraEnabled(true); } catch {}
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
    const room = `call_${callId}`;
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

  // ───── Connect to LiveKit Room ─────
  const connectToRoom = useCallback(async () => {
    if (endedRef.current) return;
    ensureLiveKitRegistered();

    // Start LK AudioSession on native (sets the right iOS category + Android
    // mode for WebRTC voice routing). Idempotent — safe to call again on
    // reconnect.
    if (Platform.OS !== 'web' && LK_AudioSession) {
      try {
        // The RN AudioSession instance manages playAndRecord / voiceChat
        // category automatically. We just call startAudioSession.
        await LK_AudioSession.startAudioSession();
      } catch (e) {
        console.warn('[Call] LK AudioSession.startAudioSession failed:', e?.message);
      }
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

    let token, url, room, iceServers;
    try {
      ({ token, url, room, iceServers } = await fetchLivekitToken());
      _diag('token_ok', { url, room, ice_count: iceServers?.length || 0 });
    } catch (e) {
      _diag('token_err', { msg: String(e?.message || e), stack: String(e?.stack || '').slice(0, 500) });
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
    const roomOpts = {
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
      videoCaptureDefaults: {
        facingMode: 'user',
        resolution: { width: 1280, height: 720, frameRate: 30 },
      },
      publishDefaults: {
        videoSimulcastLayers: [
          { width: 320, height: 180, encoding: { maxBitrate: 150_000, maxFramerate: 15 } },
          { width: 640, height: 360, encoding: { maxBitrate: 500_000, maxFramerate: 25 } },
          { width: 1280, height: 720, encoding: { maxBitrate: 1_500_000, maxFramerate: 30 } },
        ],
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
    if (Array.isArray(iceServers) && iceServers.length > 0) {
      roomOpts.rtcConfig = { iceServers, iceTransportPolicy: 'all' };
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

    // RoomEvent handlers
    r.on(RoomEvent.Connected, () => {
      if (endedRef.current) return;
      _diag('event_room_connected', { remotes: r.remoteParticipants?.size || 0 });
      console.log('[Call] LiveKit Connected to room', room);
      setReconnecting(false);
      setConnectionFailed(false);
      setErrorMsg(null);
      // If a remote is already in the room, surface them immediately.
      try {
        const others = Array.from(r.remoteParticipants?.values?.() || []);
        if (others.length > 0) {
          setPeerConnected(true);
          setRemoteParticipant(others[0]);
          _refreshRemoteTracks(others[0]);
          callKeep.reportConnected(callId);
        }
        for (const p of others) {
          _updateGroupPeer(p.identity, { participant: p, name: p.name || p.identity });
        }
      } catch {}
    });

    r.on(RoomEvent.Reconnecting, () => {
      console.log('[Call] LiveKit Reconnecting');
      setReconnecting(true);
    });

    r.on(RoomEvent.Reconnected, () => {
      console.log('[Call] LiveKit Reconnected');
      setReconnecting(false);
    });

    r.on(RoomEvent.Disconnected, (reason) => {
      console.log('[Call] LiveKit Disconnected reason=', reason);
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
      setPeerConnected(true);
      peerJoinedAtRef.current = Date.now();
      setRemoteParticipant(participant);
      _refreshRemoteTracks(participant);
      _updateGroupPeer(participant.identity, { participant, name: participant.name || participant.identity });
      callKeep.reportConnected(callId);
      try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}
    });

    r.on(RoomEvent.ParticipantDisconnected, (participant) => {
      console.log('[Call] Participant disconnected:', participant.identity);
      _removeGroupPeer(participant.identity);
      // For 1:1, dropping the only remote means the call is done.
      const remaining = Array.from(r.remoteParticipants?.values?.() || []);
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
      }
    });
    r.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      if (participant && participant !== r.localParticipant) {
        _refreshRemoteTracks(participant);
      }
    });

    r.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (!participant) return;
      // We surface the REMOTE quality (the local user already sees their UI
      // freezing if their own connection is bad).
      if (participant !== r.localParticipant) {
        const s = qualityToScore(quality);
        const lbl = qualityToLabel(quality);
        setQualityScore(s);
        setConnectionQuality(lbl);
      }
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
      await r.connect(url, token);
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

    // Publish our local mic + (optionally) cam. LiveKit calls getUserMedia
    // internally; if perms are denied the promise rejects and we surface an
    // error. Forcing publish AFTER connect is the documented happy path.
    try {
      await r.localParticipant.setMicrophoneEnabled(!audioMutedRef.current);
    } catch (e) {
      console.warn('[Call] setMicrophoneEnabled err:', e?.message);
    }
    if (isVideoCall) {
      try {
        await r.localParticipant.setCameraEnabled(true);
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
    if (!r || !r.localParticipant) return;
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

    try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}

    // WS BYE — peer's ringing-screen / CallKit needs this for cleanup if they
    // never accepted. Send a few times spaced out in case of WS flap.
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

    // Stop LiveKit AudioSession.
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

    setTimeout(() => {
      try {
        if (router.canGoBack()) router.back();
        else router.replace('/chat');
      } catch {
        try { router.replace('/chat'); } catch {}
      }
    }, 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, contactEmail, isCaller, isVideoCall, callerName, isRecording, sendSignaling, router, endCardAnim]);

  // Sync the ref so the global teardown hook always sees the latest.
  useEffect(() => { handleEndCallRef.current = handleEndCall; }, [handleEndCall]);

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

  // ───── Reconnect (called when LiveKit fails) ─────
  const handleReconnect = useCallback(async () => {
    if (endedRef.current) return;
    console.log('[Call] manual reconnect requested');
    setConnectionFailed(false);
    setErrorMsg(null);
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

    const callAcceptedRef = { current: false };

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
        }
      });

      unsubEnd = mailWs.on('call_end', (data) => {
        if (callAcceptedRef.current && data?.reason === 'declined') return;
        if (data?.call_id === callId && mounted && !endedRef.current) {
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
    wsUnsubsRef.current = [unsubAccepted, unsubEnd, unsubMissed, unsubDeclined];

    // Caller: send invite + start CallKit, then wait for accept before joining
    // the LiveKit room. Callee: join the room immediately (their accept
    // surfaced this screen via IncomingCallListener).
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

        // Wait up to 45s for accept. Even without accept we still try to
        // connect — if the callee accepts late LiveKit picks them up.
        const acceptPromise = new Promise((resolve) => {
          const interval = setInterval(() => {
            if (endedRef.current || !mounted) { clearInterval(interval); resolve(false); return; }
            if (callAcceptedRef.current) { clearInterval(interval); resolve(true); return; }
          }, 100);
          setTimeout(() => { clearInterval(interval); resolve(false); }, 45000);
        });
        await acceptPromise;
        if (endedRef.current || !mounted) return;

        // 60s safety: if no remote ever joins, hang up.
        callerTimeoutRef.current = setTimeout(() => {
          if (mounted && !endedRef.current && !peerConnected) {
            console.log('[Call] caller timeout — no remote joined');
            handleEndCall();
          }
        }, 60000);
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

      if (minimizedRef.current) {
        console.log('[Call] unmounting minimized — preserving LiveKit room');
        return;
      }
      wsUnsubsRef.current.forEach(u => { try { u(); } catch {} });
      wsUnsubsRef.current = [];
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

  // ───── Duration timer ─────
  useEffect(() => {
    if (!peerConnected) return;
    try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}
    timerRef.current = setInterval(() => setCallDuration(d => { callDurationRef.current = d + 1; return d + 1; }), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [peerConnected]);

  // ───── Toggles ─────
  const handleToggleMute = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const newMuted = !audioMutedRef.current;
    setAudioMuted(newMuted);
    audioMutedRef.current = newMuted;
    try {
      await r.localParticipant.setMicrophoneEnabled(!newMuted);
    } catch (e) {
      console.warn('[Call] setMicrophoneEnabled err:', e?.message);
    }
    sendData({ type: 'audio_muted', muted: newMuted });
    resetControlsTimer();
  }, [resetControlsTimer, sendData]);

  const handleToggleNoiseCancellation = useCallback(() => {
    // LiveKit always has echoCancellation + noiseSuppression + AGC enabled
    // via audioCaptureDefaults. The toggle is now a cosmetic switch (we
    // surface it in the UI but the real path is config-time only). Keep the
    // setter so the icon flips, and haptic feedback.
    setNoiseCancellation(v => !v);
    _hapticTap('light');
    resetControlsTimer();
  }, [resetControlsTimer]);

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
    if (!r) return;

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
    try {
      await r.localParticipant.setCameraEnabled(true);
      setVideoEnabled(true);
      videoEnabledRef.current = true;
      const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera);
      if (camPub?.videoTrack) setLocalVideoTrack(camPub.videoTrack);
      sendData({ type: 'video_toggle', enabled: true });
    } catch (e) {
      console.warn('[Call] setCameraEnabled true err:', e?.message);
    }
    resetControlsTimer();
  }, [videoEnabled, peerConnected, isVideoCall, sendData, resetControlsTimer]);

  const handleFlipCamera = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = camPub?.videoTrack;
    if (!track) return;
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
    resetControlsTimer();
  }, [facingFront, resetControlsTimer]);

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
      console.warn('[Call] Recording upload err:', err);
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
    setShowEmojiBar(false);
    resetControlsTimer();
  }, [sendData, resetControlsTimer]);

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
    setAddParticipantBusy(true);
    try {
      const { chatCallInvite } = require('../services/api');
      // The backend ring-fan-out endpoint reuses the same callId — the
      // invitee will join the same LiveKit room when they accept.
      await chatCallInvite(conversationId, callId, [email], !!isVideoCall);
      setAddParticipantCandidates(prev => prev.filter(c => (c.email || '').toLowerCase() !== email.toLowerCase()));
    } catch (e) {
      if (__DEV__) console.warn('[call.invite]', e?.message);
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

  // ───── Signal bars ─────
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
      <View
        style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8 }}
        accessibilityLabel={a11y}
        accessibilityRole="image"
      >
        <ConnectionBars level={level} size={14} />
        {bitrateAdapted && (
          <Svg width={9} height={11} viewBox="0 0 24 24" style={{ marginLeft: 3 }}>
            <SvgPath d="M12 5v14M5 12l7 7 7-7" stroke="#f97316" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </Svg>
        )}
      </View>
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

      {/* Remote video — full screen (native). Web uses VideoView too. */}
      {LK_VideoView && remoteVideoTrack && isVideoCall && peerConnected && peerVideoEnabled && (
        <LK_VideoView
          videoTrack={remoteVideoTrack}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
          zOrder={0}
        />
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
                {showSignalBars && <SignalBars quality={connectionQuality} score={qualityScore} />}
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

          {/* Reconnecting overlay (pre-connect) */}
          {reconnecting && !ended && !peerConnected && (
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
                    if (!videoEnabled) handleToggleVideo();
                  }}
                >
                  <IconVideo size={18} color="#fff" />
                  <Text style={[styles.videoRequestBtnText, { color: '#fff' }]}>{t('common.accept') || 'Aceitar'}</Text>
                </TouchableOpacity>
              </View>
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

          {/* Center avatar (audio-only / pre-connect) */}
          {!showRemoteVideo && (
            <View style={styles.centerArea}>
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
                <AvatarCircle name={callerName} email={_safePeerEmail} size={isVideoCall ? 140 : 168} />
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
              </View>
              <Text style={[styles.centerStatus, connectionFailed && { color: '#ef4444' }]}>{statusText}</Text>
              {ended && (
                <Text style={styles.endedHint}>{t('call.ended') || 'Chamada encerrada'}</Text>
              )}
              {connectionFailed && !ended && (
                <View style={styles.reconnectContainer}>
                  <TouchableOpacity style={styles.reconnectBtn} onPress={handleReconnect} activeOpacity={0.7}>
                    <IconPhone size={18} color="#fff" />
                    <Text style={styles.reconnectBtnText}>{t('call.reconnect') || 'Reconectar'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.reconnectEndBtn} onPress={handleEndCall} activeOpacity={0.7}>
                    <IconPhoneOff size={18} color="#fff" />
                    <Text style={styles.reconnectEndBtnText}>{t('call.hangUp') || 'Desligar'}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* Video connected — minimal overlay */}
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

      {/* Local PiP preview */}
      {LK_VideoView && localVideoTrack && videoEnabled && (
        <Animated.View
          {...pipPanResponder.panHandlers}
          style={[styles.localVideoContainer, { transform: pipPosition.getTranslateTransform() }]}
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
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      {/* Bottom controls */}
      {!ended && (
        <Animated.View style={[styles.controlsBar, {
          paddingBottom: insets.bottom + 16,
          opacity: Animated.multiply(controlsFadeAnim, barEnterAnim),
          transform: [{
            translateY: barEnterAnim.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }),
          }],
        }]}>
          {/* Secondary row */}
          <View style={styles.controlsRowTop}>
            <TouchableOpacity
              style={styles.controlBtn}
              onPress={handleToggleNoiseCancellation}
              activeOpacity={0.7}
              accessibilityLabel={noiseCancellation ? (t('call.noiseOn') || 'Ruído ON') : (t('call.noiseOff') || 'Ruído OFF')}
              accessibilityRole="button"
            >
              <View style={[styles.controlBtnCircle, noiseCancellation && styles.controlBtnCircleActive]}>
                <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
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
                    <SvgPath
                      d="M9 11V5.5a1.5 1.5 0 113 0V11M12 11V4a1.5 1.5 0 113 0v8M15 11V5a1.5 1.5 0 113 0v8.5M9 11V8.5a1.5 1.5 0 10-3 0V14a6 6 0 0012 0v-1.5"
                      stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
                    />
                  </Svg>
                </View>
                <Text style={styles.controlLabel} numberOfLines={1}>
                  {handRaised ? (t('call.handLower') || 'Abaixar') : (t('call.handRaise') || 'Mão')}
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

      {/* Slow-connect overlay */}
      {showSlowConnectOverlay && !peerConnected && !peerRinging && !ended && (
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
        <Animated.View pointerEvents="none" style={[styles.endCardOverlay, { opacity: endCardAnim }]}>
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
  container: { flex: 1, backgroundColor: '#000' },
  audioOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 5 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, zIndex: 10 },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  topInfo: { flex: 1, marginLeft: 12 },
  topName: { color: '#fff', fontSize: 18, fontWeight: '600' },
  topStatus: { color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 1 },
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
  centerName: { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 24, textAlign: 'center' },
  centerStatus: { color: 'rgba(255,255,255,0.6)', fontSize: 15, marginTop: 6 },
  endedHint: { color: 'rgba(255,255,255,0.4)', fontSize: 13, marginTop: 12 },
  reconnectContainer: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 24 },
  reconnectBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#7C3AED', paddingHorizontal: 24, paddingVertical: 14, borderRadius: 30,
  },
  reconnectBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  reconnectEndBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#ef4444', paddingHorizontal: 24, paddingVertical: 14, borderRadius: 30,
  },
  reconnectEndBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  controlsBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    zIndex: 20, alignItems: 'center', paddingTop: 20, paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
  },
  controlsRowTop: {
    flexDirection: 'row', justifyContent: 'center',
    flexWrap: 'wrap', rowGap: 12, columnGap: 18, marginBottom: 18,
  },
  controlBtn: { alignItems: 'center', gap: 6, width: 60 },
  controlBtnCircle: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  controlBtnCircleActive: { backgroundColor: 'rgba(255,255,255,0.35)' },
  controlBtnCircleScreenShare: { backgroundColor: '#7C3AED' },
  controlLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '500', textAlign: 'center' },
  localVideoContainer: {
    position: 'absolute', left: 0, top: 0,
    width: 110, height: 156, borderRadius: 18, overflow: 'hidden', zIndex: 30,
    elevation: 12, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.32)',
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
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
  addPartOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  addPartSheet: {
    width: '100%', maxWidth: 420,
    backgroundColor: '#1c1c1e',
    borderRadius: 22, paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.08)',
  },
  addPartHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 10 },
  addPartTitle: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  addPartEmpty: { color: 'rgba(255,255,255,0.6)', textAlign: 'center', paddingVertical: 32, paddingHorizontal: 24, fontSize: 14, lineHeight: 20 },
  addPartRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 18,
    ...(Platform.OS === 'web' ? { transition: 'background-color 160ms ease', cursor: 'pointer' } : {}),
  },
  addPartName: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  addPartEmail: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '500', marginTop: 2 },
  addPartCallBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#25D366', alignItems: 'center', justifyContent: 'center', marginLeft: 10 },
  statusStrip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, zIndex: 11 },
  statusStripSide: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 24 },
  statusStripCenter: { minWidth: 64, alignItems: 'center', justifyContent: 'center' },
  statusStripDuration: {
    color: '#fff', fontSize: 14, fontWeight: '700',
    fontVariant: ['tabular-nums'], letterSpacing: 0.4,
    backgroundColor: 'rgba(0,0,0,0.35)', paddingHorizontal: 10, paddingVertical: 3,
    borderRadius: 10, overflow: 'hidden',
  },
  pipBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  centerNameAudio: { fontSize: 32, fontWeight: '800', letterSpacing: -0.6, marginTop: 28 },
  videoVignette: { ...StyleSheet.absoluteFillObject, zIndex: 1 },
  videoVignetteTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 90, backgroundColor: 'rgba(0,0,0,0.45)' },
  videoVignetteBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 220, backgroundColor: 'rgba(0,0,0,0.55)' },
  videoVignetteEdgeLeft: { position: 'absolute', top: 90, bottom: 220, left: 0, width: 14, backgroundColor: 'rgba(124,58,237,0.06)' },
  videoVignetteEdgeRight: { position: 'absolute', top: 90, bottom: 220, right: 0, width: 14, backgroundColor: 'rgba(124,58,237,0.06)' },
  controlsRowPrimary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 4, marginBottom: 4, gap: 6,
  },
  primaryBtn: { alignItems: 'center', justifyContent: 'flex-start', flex: 1, gap: 6, paddingTop: 4 },
  primaryBtnCircle: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  primaryBtnCircleActive: { backgroundColor: 'rgba(255,255,255,0.35)' },
  primaryBtnLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '600', textAlign: 'center', letterSpacing: -0.1 },
  primaryHangupBtn: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#ef4444',
    alignItems: 'center', justifyContent: 'center',
    marginTop: 4,
    shadowColor: '#ef4444', shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8,
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

export default function CallScreen(props) {
  return (
    <CallErrorBoundary>
      <CallScreenInner {...props} />
    </CallErrorBoundary>
  );
}
