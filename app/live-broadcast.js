import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated,
  Alert, TextInput, Dimensions, StatusBar, FlatList, Keyboard,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import LiveChat from '../components/LiveChat'; // eslint-disable-line no-unused-vars -- kept for fallback
import LiveChatOverlay from '../components/live/LiveChatOverlay';
import AvatarCircle from '../components/AvatarCircle';
import { IconX, IconCameraFlip, IconMic, IconMicOff, IconVideo, IconVideoOff, IconHeart, IconShare, IconSend, IconSettings, IconUserPlus, IconSparkles, IconFilter, IconPin, IconStar, IconStarFilled, IconGlobe, IconLock, IconUsers, IconEye, IconStop, IconCheck, IconBookmark } from '../components/Icons';
import { useTheme } from '../context/ThemeContext';

// Cross-platform WebRTC — same pattern as call.js
let RTC_PeerConnection, RTC_SessionDescription, RTC_IceCandidate, getUserMediaFn, NativeRTCView;
if (Platform.OS === 'web') {
  RTC_PeerConnection = window.RTCPeerConnection;
  RTC_SessionDescription = window.RTCSessionDescription;
  RTC_IceCandidate = window.RTCIceCandidate;
  getUserMediaFn = (c) => navigator.mediaDevices.getUserMedia(c);
} else {
  try {
    const webrtc = require('@livekit/react-native-webrtc');
    RTC_PeerConnection = webrtc.RTCPeerConnection;
    RTC_SessionDescription = webrtc.RTCSessionDescription;
    RTC_IceCandidate = webrtc.RTCIceCandidate;
    getUserMediaFn = (c) => webrtc.mediaDevices.getUserMedia(c);
    NativeRTCView = webrtc.RTCView;
  } catch (e) {
    console.warn('[Live] Failed to load WebRTC:', e);
  }
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const WS_URL = Platform.OS === 'web' ? 'wss://chatyy.com.br/ws' : 'wss://ws.chatyy.com.br/ws';
const LIVE_RED = '#dc2626';
const MAX_HEARTS = 20;

export default function LiveBroadcastScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const { user } = useAuth();
  const { t } = useLanguage();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  // Pre-live state
  const [preStart, setPreStart] = useState(true);
  const [titleInput, setTitleInput] = useState(params.title || '');
  const [countdown, setCountdown] = useState(null);
  const [kbHeight, setKbHeight] = useState(0);
  // Audience pill — Instagram Live "Who can watch": public | friends | private.
  // Affects backend visibility flag in liveStart. Local-only pre-start.
  const [audience, setAudience] = useState('public');
  // Pre-live mirror facing toggle so the host can pick front/back camera
  // BEFORE the countdown — same UX as Instagram & TikTok.
  const [preFacing, setPreFacing] = useState('user');
  // Insights modal (bottom-left pill expansion) — shows the viewers/reactions
  // breakdown with the list of who joined.
  const [insightsOpen, setInsightsOpen] = useState(false);
  // Distinct viewers seen during the live — drives the "X viewers únicos"
  // line on the end-card. Keyed by email; survives churn (viewers leaving
  // mid-broadcast still count once).
  const uniqueViewersRef = useRef(new Set());
  const [uniqueViewers, setUniqueViewers] = useState(0);
  // Recent joins (timestamps + names), drives the insights modal list.
  const [joinFeed, setJoinFeed] = useState([]); // [{email,name,ts}]

  // Live state
  const [sessionId, setSessionId] = useState(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [audioMuted, setAudioMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(false);
  const [liveDuration, setLiveDuration] = useState(0);
  const [hearts, setHearts] = useState([]);
  const [totalLikes, setTotalLikes] = useState(0);
  const [commentDraft, setCommentDraft] = useState('');
  const [connQuality, setConnQuality] = useState('good'); // good | medium | poor
  const [endModal, setEndModal] = useState(false);
  const [saveReplay, setSaveReplay] = useState(true);
  // After teardown, capture whether a replay is actually being produced
  // (CF Stream pipeline = yes; legacy WebRTC P2P = no). Drives the
  // "Ver Lives Salvas" CTA on the end-card vs a plain "Concluído".
  // Replaces the previous opaque UX where the host tapped "Salvar replay"
  // but had no idea where the replay landed (or if it would exist at all).
  const [endedHasRecording, setEndedHasRecording] = useState(false);
  // Codex root cause #6 — freeze the replay-requested intent at performEndLive
  // time. Without this, host could tap "Salvar replay" AFTER liveEnd had
  // already been called with the previous value, and the toggle would
  // silently desync from the actual backend state.
  const [endedReplayRequested, setEndedReplayRequested] = useState(false);
  const [endedReplayStatus, setEndedReplayStatus] = useState('idle'); // idle|processing|none|error
  const [pinnedComment, setPinnedComment] = useState(null);
  // Settings/effects/filter UI state — the right-stack buttons used to be
  // no-op stubs (audit 2026-05-12); now they each open a small bottom sheet
  // so the host has actual controls during a live.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  // 'none' | 'bw' | 'warm' | 'cool' | 'vivid' — applied as a tint overlay
  // (the WebRTC video pipeline doesn't expose a real CSS-filter hook on
  // native, but a semi-transparent overlay reads the same intent).
  const [activeFilter, setActiveFilter] = useState('none');
  // Sparkle/heart particle effect — toggled by the Effects button.
  const [effectsOn, setEffectsOn] = useState(false);
  const [hideChat, setHideChat] = useState(false);
  const [muteReactions, setMuteReactions] = useState(false);
  // Ref mirror so the WS message handler (which lives outside the
  // muteReactions closure window) reads the current toggle value.
  const muteReactionsRef = useRef(false);
  useEffect(() => { muteReactionsRef.current = muteReactions; }, [muteReactions]);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height || 0));
    const h = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { s.remove(); h.remove(); };
  }, []);
  // Invite-friends sheet — replaces the system Share fallback so the host can
  // multi-select contacts and DM them the live link in one tap (TikTok parity).
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteContacts, setInviteContacts] = useState([]); // [{id, name, email}]
  const [inviteSelected, setInviteSelected] = useState(new Set());
  const [inviteSearch, setInviteSearch] = useState('');
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteLoaded, setInviteLoaded] = useState(false);
  // Join-requests inbox — viewers can request to come on as a guest, host
  // sees a small toast/badge and can approve or deny (Instagram "Request to
  // Join", TikTok "Go Live Together").
  const [joinRequests, setJoinRequests] = useState([]); // [{email, name, ts}]
  const [requestsOpen, setRequestsOpen] = useState(false);
  // Active guest co-broadcaster (round 921 — colab mode). Only one slot for
  // now; expanding to multi-guest needs SFU. {email, name, pc, streamURL}.
  const [guestPeer, setGuestPeer] = useState(null);
  // Forward refs so the WS switch above can dispatch to handlers declared
  // further down without hitting TDZ. Same pattern as handleViewerJoinedRef.
  const handleGuestOfferRef = useRef(null);
  const handleGuestIceRef = useRef(null);

  // Refs
  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const wsRef = useRef(null);
  const peersRef = useRef(new Map());
  // Buffer of viewer-join messages that arrived before the broadcaster's
  // camera/mic stream was ready. Drained by a useEffect once
  // localStreamRef.current resolves.
  const pendingViewersRef = useRef(new Map());
  const sessionIdRef = useRef(null);
  const viewerCountTimerRef = useRef(null);
  const durationTimerRef = useRef(null);
  const chatIdRef = useRef(0);
  const facingRef = useRef('user');
  const heartIdRef = useRef(0);
  const endedRef = useRef(false);
  const reconnectTimerRef = useRef(null);
  const liveStartedAckRef = useRef(false);
  const liveStartedAckTimeoutRef = useRef(null);
  // Codex root cause #3 — handleStartLive must await `live_started` ack
  // BEFORE flipping the UI to live. Without this waiter promise, the host
  // is "live" in the local UI while WS subscribe may have failed silently
  // (viewers can't get offers). The waiter is fulfilled in `live_started`.
  const liveStartedWaiterRef = useRef(null);
  // Composer input ref for proper keyboard hide cycle (Codex #5).
  const composerInputRef = useRef(null);
  const endModalTimerRef = useRef(null);
  // Authoritative server viewer count, mirrored to a ref so polling timers
  // can use the latest value without hooking re-renders (Codex #4).
  const viewerCountRef = useRef(0);
  // Guest peer ref + per-guest ICE queue for Codex root cause #7.
  const guestPeerRef = useRef(null);
  const guestIceQueueRef = useRef(new Map());

  // Animations
  const countdownScale = useRef(new Animated.Value(0)).current;
  const countdownOpacity = useRef(new Animated.Value(0)).current;
  const prevViewerCount = useRef(0);
  const viewerBounce = useRef(new Animated.Value(1)).current;
  // Pre-live title placeholder fade — soft sin-wave loop so the input invites
  // the host to type a title even when empty (Instagram Live parity).
  const placeholderFade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!preStart) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(placeholderFade, { toValue: 0.45, duration: 1400, useNativeDriver: true }),
      Animated.timing(placeholderFade, { toValue: 1, duration: 1400, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [preStart, placeholderFade]);
  // End-card spring entrance — scale + opacity from below for the summary.
  const endCardScale = useRef(new Animated.Value(0.85)).current;
  const endCardOpacity = useRef(new Animated.Value(0)).current;
  // Live duration dot heartbeat — same heartbeat the recording bar uses, so
  // any "we're live" surface in the app reads as one rhythm.
  const livePulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(livePulse, { toValue: 1.5, duration: 700, useNativeDriver: true }),
      Animated.timing(livePulse, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);

  // ----- Pre-live polish animations (Instagram-grade) -----
  // Avatar red ring breath — pulses 0.18→0.6 opacity at 1.4s loop so the host
  // sees a heartbeat hint around their face ("you're about to go live").
  const preRingPulse = useRef(new Animated.Value(0)).current;
  // Go-live button red glow halo — same beat as the avatar ring so the eye
  // ties hero + CTA together as one "going live" rhythm.
  const preBtnGlow = useRef(new Animated.Value(0)).current;
  // Audience pill scale — bumps to 1.05 on selection (spring) so the user
  // feels the choice land instead of a static color swap.
  const preAudScale = useRef({
    public: new Animated.Value(audience === 'public' ? 1.05 : 1),
    friends: new Animated.Value(audience === 'friends' ? 1.05 : 1),
    private: new Animated.Value(audience === 'private' ? 1.05 : 1),
  }).current;
  useEffect(() => {
    if (!preStart) return undefined;
    const ringLoop = Animated.loop(Animated.sequence([
      Animated.timing(preRingPulse, { toValue: 1, duration: 1400, useNativeDriver: true }),
      Animated.timing(preRingPulse, { toValue: 0, duration: 1400, useNativeDriver: true }),
    ]));
    const glowLoop = Animated.loop(Animated.sequence([
      Animated.timing(preBtnGlow, { toValue: 1, duration: 1400, useNativeDriver: true }),
      Animated.timing(preBtnGlow, { toValue: 0, duration: 1400, useNativeDriver: true }),
    ]));
    ringLoop.start();
    glowLoop.start();
    return () => { ringLoop.stop(); glowLoop.stop(); };
  }, [preStart, preRingPulse, preBtnGlow]);
  // Spring the active pill up, the rest back to 1. Native driver = no jank.
  useEffect(() => {
    ['public', 'friends', 'private'].forEach((key) => {
      Animated.spring(preAudScale[key], {
        toValue: audience === key ? 1.05 : 1,
        friction: 5,
        tension: 140,
        useNativeDriver: true,
      }).start();
    });
  }, [audience, preAudScale]);

  // ICE config
  const iceConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // Format duration
  const formatDuration = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // Viewer count bounce animation
  useEffect(() => {
    if (viewerCount !== prevViewerCount.current) {
      prevViewerCount.current = viewerCount;
      Animated.sequence([
        Animated.timing(viewerBounce, { toValue: 1.2, duration: 150, useNativeDriver: true }),
        Animated.spring(viewerBounce, { toValue: 1, friction: 4, useNativeDriver: true }),
      ]).start();
    }
  }, [viewerCount]);

  // Native stream URL for RTCView
  const [localStreamUrl, setLocalStreamUrl] = useState(null);

  // Availability check only — do NOT request camera/mic on mount. Apple
  // review rejected eager prompts, and iPad deep-linking to /live-broadcast
  // triggers a permission dialog the user never asked for. The real
  // getUserMedia call now lives in `ensureCameraStream()` below, which runs
  // when the user actively taps "Go Live".
  useEffect(() => {
    if (!getUserMediaFn || !RTC_PeerConnection) {
      setError(t('live.connectionFailed') || 'WebRTC not available');
    }
    return () => {
      const s = localStreamRef.current;
      if (s) {
        try { s.getTracks().forEach(track => track.stop()); } catch {}
        localStreamRef.current = null;
      }
    };
  }, []);

  // Opens the camera + mic the first time the user actively starts a
  // broadcast. Returns true on success, false on error (caller handles UI).
  const ensureCameraStream = useCallback(async () => {
    if (localStreamRef.current) return true;
    if (!getUserMediaFn) {
      setError(t('live.connectionFailed') || 'WebRTC not available');
      return false;
    }
    try {
      // Honor the host's pre-live front/back camera choice. facingMode is
      // best-effort — desktops without a back camera fall back to default,
      // which matches Instagram Live behavior.
      facingRef.current = preFacing;
      const stream = await getUserMediaFn({ video: { facingMode: preFacing }, audio: true });
      localStreamRef.current = stream;
      if (Platform.OS === 'web') {
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      } else {
        if (stream?.toURL) setLocalStreamUrl(stream.toURL());
      }
      // Drain any viewers that joined before the camera was ready.
      // Replay each buffered join through the normal handler now that
      // localStreamRef.current is populated. Without this drain, viewers
      // who hit the live in the first 200-400ms after the host opened
      // the broadcast screen sat on "Conectando..." forever. Using
      // handleViewerJoinedRef to dodge the TDZ — handleViewerJoined is
      // declared further down in the component.
      if (pendingViewersRef.current.size > 0) {
        const pending = Array.from(pendingViewersRef.current.values());
        pendingViewersRef.current.clear();
        console.log('[Live] draining ' + pending.length + ' pending viewer(s)');
        for (const msg of pending) {
          try { handleViewerJoinedRef.current?.(msg); } catch (e) { console.warn('[Live] drain err', e); }
        }
      }
      return true;
    } catch (err) {
      console.warn('[Live] Camera error:', err);
      setError(t('live.connectionFailed') || 'Failed to access camera');
      return false;
    }
  }, [t, preFacing]);

  // Latest-handler ref so ensureCameraStream above can call into
  // handleViewerJoined (declared further down) without creating a
  // forward-reference TDZ crash on first render.
  const handleViewerJoinedRef = useRef(null);

  // Connect to signaling WebSocket. Returns a Promise that resolves on
  // `live_started` ack so handleStartLive can await it before flipping the
  // UI to live (Codex root cause #3). Promise rejects on the 5s watchdog
  // or any premature close.
  const connectSignaling = useCallback(() => {
    // Reset ack state each (re)connect so reconnects also wait for the
    // server's fresh live_started echo.
    liveStartedAckRef.current = false;
    if (liveStartedAckTimeoutRef.current) {
      clearTimeout(liveStartedAckTimeoutRef.current);
      liveStartedAckTimeoutRef.current = null;
    }

    // Close previous WS to prevent orphan connections
    if (wsRef.current) {
      try {
        // Null handlers BEFORE close so the old socket's reconnect timer
        // can't schedule itself over the new one (Codex race-condition note).
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }

    return new Promise((resolve, reject) => {
      liveStartedWaiterRef.current = { resolve, reject };

      const token = api.getAuthToken();
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', token }));
      };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'auth_success': {
          // After auth, start live session. Sem sessionIdRef.current válido,
          // WS server silenciosamente ignora (guard `if (c.email && msg.session_id)`),
          // e o host fica subscrito ao canal user mas NÃO ao canal live_<id> —
          // viewers que pedem join nunca recebem offer → "Conectando..." eterno.
          const sid = sessionIdRef.current;
          if (!sid) {
            console.error('[Live] auth_success but sessionId is null — abort live_start');
            setError(t('live.startFailed') || 'Falha ao iniciar live');
            try { ws.close(); } catch {}
            return;
          }
          console.log('[Live] sending live_start session=' + sid);
          ws.send(JSON.stringify({ type: 'live_start', session_id: sid }));
          // Ack watchdog — if WS server doesn't echo live_started in 5s, the
          // subscribe never happened. Surface the error instead of waiting forever.
          if (liveStartedAckTimeoutRef.current) clearTimeout(liveStartedAckTimeoutRef.current);
          liveStartedAckTimeoutRef.current = setTimeout(() => {
            if (!liveStartedAckRef.current && !endedRef.current) {
              console.error('[Live] live_started ack timeout (5s) — WS subscribe failed');
              setError(t('live.startTimeout') || 'Sem resposta do servidor');
              // Reject the waiter so handleStartLive can bail out instead of
              // staring at a black countdown screen (Codex #3).
              try { liveStartedWaiterRef.current?.reject?.(new Error('live_started timeout')); } catch {}
              liveStartedWaiterRef.current = null;
            }
          }, 5000);
          break;
        }
        case 'live_started':
          // Server confirmed broadcast registered + channel subscribed.
          liveStartedAckRef.current = true;
          if (liveStartedAckTimeoutRef.current) {
            clearTimeout(liveStartedAckTimeoutRef.current);
            liveStartedAckTimeoutRef.current = null;
          }
          console.log('[Live] live_started ack received');
          try { liveStartedWaiterRef.current?.resolve?.(); } catch {}
          liveStartedWaiterRef.current = null;
          break;
        case 'live_viewer_joined':
          handleViewerJoined(msg);
          break;
        case 'live_answer':
          handleViewerAnswer(msg);
          break;
        case 'live_ice':
          handleViewerIce(msg);
          break;
        case 'live_turn_credentials':
          // Update ICE config with TURN credentials
          if (msg.credentials) {
            iceConfig.iceServers = [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: msg.credentials.urls, username: msg.credentials.username, credential: msg.credentials.credential },
            ];
          }
          break;
        case 'live_chat':
          handleChatMessage(msg);
          break;
        case 'live_reaction':
          // Mute toggle silences the heart animation client-side so the host
          // can focus during a busy live without redoing the server pipeline.
          if (!muteReactionsRef.current) {
            // Pass the reactor identity so the heart can float with a tiny
            // avatar chip (Instagram parity) — instantly readable "quem
            // curtiu" without needing a separate toast.
            spawnHeart({ name: msg.reactor_name || msg.reactor_email?.split('@')[0], email: msg.reactor_email });
          }
          break;
        case 'live_viewer_count':
          // Authoritative count from the WS server (channel subs minus the
          // broadcaster). Previously the host only had peersRef.size, which
          // lags 2-5s while WebRTC negotiates and goes stale if a peer fails
          // mid-stream — server count is instant and survives peer drops.
          if (typeof msg.count === 'number') {
            viewerCountRef.current = msg.count;
            setViewerCount(msg.count);
          }
          break;
        case 'live_viewer_left':
          // Server already broadcasts a follow-up viewer_count, but cleaning
          // peer state proactively avoids zombie WebRTC tiles in the host UI.
          if (msg.viewer_id && peersRef.current.has(msg.viewer_id)) {
            try { peersRef.current.get(msg.viewer_id)?.close(); } catch {}
            peersRef.current.delete(msg.viewer_id);
          }
          break;
        case 'live_chat_remove':
          // Another (legit) host instance removed a comment — drop locally.
          if (msg.msg_id) {
            setChatMessages(prev => prev.filter(x => String(x.id) !== String(msg.msg_id)));
          }
          break;
        case 'live_gift':
          // Render a golden gift chip inline in the comment overlay.
          {
            const entry = new Animated.Value(0);
            appendChatMessage({
              id: 'gift_' + String(++chatIdRef.current),
              name: msg.sender_name || (msg.sender_email || '').split('@')[0] || '?',
              email: msg.sender_email,
              type: 'gift',
              gift: msg.gift,
              amount: msg.amount || 1,
              giftLabel: msg.gift ? ((t('live.sentGift') || 'enviou') + ' ' + msg.gift) : (t('live.sentGift') || 'enviou um presente'),
              entry,
            });
            Animated.spring(entry, { toValue: 1, friction: 6, tension: 120, useNativeDriver: true }).start();
          }
          break;
        case 'live_guest_offer':
          // Approved viewer (guest) wants to publish their camera to the host.
          // Stash for the host-side answer; the actual WebRTC negotiation is
          // handled in handleGuestOffer (added in this round). When that
          // succeeds, the guest's stream renders as a PiP card next to host.
          handleGuestOfferRef.current?.(msg);
          break;
        case 'live_guest_ice':
          handleGuestIceRef.current?.(msg);
          break;
        case 'live_guest_left':
          // Drop guest peer + tile if we had one.
          if (msg.guest_email) {
            setGuestPeer(prev => {
              if (prev?.email && prev.email.toLowerCase() === msg.guest_email.toLowerCase()) {
                try { prev.pc?.close(); } catch {}
                return null;
              }
              return prev;
            });
          }
          break;
        case 'live_guest_joined':
          // Inline a system chip "X juntou-se ao colab" — same renderer as the
          // "X entrou" join chip, just different text so viewers see the diff.
          {
            const entry = new Animated.Value(0);
            appendChatMessage({
              id: 'gj_' + String(++chatIdRef.current),
              name: msg.guest_name || (msg.guest_email || '').split('@')[0] || '?',
              email: msg.guest_email,
              type: 'system',
              text: t('live.joinedColab') || 'juntou-se ao colab',
              content: t('live.joinedColab') || 'juntou-se ao colab',
              entry,
            });
            Animated.spring(entry, { toValue: 1, friction: 7, tension: 120, useNativeDriver: true }).start();
          }
          break;
        case 'live_join_request':
          // Viewer wants to come on as a guest (TikTok-style colab — host
          // accepts, both go split-screen). Stack the request and surface
          // a prominent prompt: auto-open the requests sheet so the host
          // can't miss it while filming. Without the auto-open the chip
          // top-right was easy to ignore and user complained the system
          // "didn't work" — they never noticed the chip.
          if (msg.viewer_email) {
            setJoinRequests(prev => {
              if (prev.some(r => r.email === msg.viewer_email)) return prev;
              return [{ email: msg.viewer_email, name: msg.viewer_name || msg.viewer_email.split('@')[0], ts: Date.now() }, ...prev].slice(0, 30);
            });
            // Strong buzz so host feels it on cheek/hand mid-stream.
            try { require('react-native').Vibration.vibrate([0, 80, 60, 80]); } catch {}
            // Auto-open the sheet so accept/deny is one tap away.
            setRequestsOpen(true);
          }
          break;
      }
    };

    ws.onclose = () => {
      if (sessionIdRef.current && !endedRef.current) {
        reconnectTimerRef.current = setTimeout(connectSignaling, 3000);
      }
      // If the live_started waiter is still pending, reject it so callers
      // can bail out instead of awaiting forever (Codex #3 + race notes).
      try { liveStartedWaiterRef.current?.reject?.(new Error('ws closed')); } catch {}
      liveStartedWaiterRef.current = null;
    };

    ws.onerror = (e) => {
      // Antes era silent fail — onerror engolido escondia falhas de TLS/auth/CORS
      // que deixavam o host preso em "Conectando..." sem nunca enviar live_start.
      console.warn('[Live] WS error:', e?.message || e?.type || 'unknown');
      try { setError(t('live.connectionFailed') || 'Falha de conexão ao servidor'); } catch {}
    };
    });
  }, [user, t]);

  // Connection quality heartbeat — heuristic based on peer connection health
  // (we don't have RTC stats parsing yet, so we count failed/connecting peers).
  useEffect(() => {
    if (preStart) return;
    const t = setInterval(() => {
      const peers = Array.from(peersRef.current.values());
      if (!peers.length) { setConnQuality('good'); return; }
      let bad = 0, mid = 0;
      peers.forEach(pc => {
        const s = pc.connectionState;
        if (s === 'failed' || s === 'disconnected') bad++;
        else if (s === 'connecting' || s === 'new') mid++;
      });
      const ratioBad = bad / peers.length;
      const ratioMid = mid / peers.length;
      if (ratioBad > 0.25) setConnQuality('poor');
      else if (ratioBad > 0 || ratioMid > 0.4) setConnQuality('medium');
      else setConnQuality('good');
    }, 4000);
    return () => clearInterval(t);
  }, [preStart]);

  // Codex root cause #9 — bound chat overlay state. LiveChatOverlay renders
  // only the last 6 messages, but parent kept the whole stream + every
  // Animated.Value, leaking memory + driving useless re-renders.
  const CHAT_MAX_MESSAGES = 50;
  const appendChatMessage = useCallback((item) => {
    setChatMessages(prev => {
      const next = [...prev, item];
      return next.length > CHAT_MAX_MESSAGES ? next.slice(-CHAT_MAX_MESSAGES) : next;
    });
  }, []);

  // Heart animation — accepts optional reactor identity so each heart can
  // float with a tiny avatar chip beside it (Instagram parity).
  const spawnHeart = useCallback((reactor = null) => {
    setTotalLikes(c => c + 1);
    const id = ++heartIdRef.current;
    const x = SCREEN_W - 60 + (Math.random() - 0.5) * 40;
    const y = SCREEN_H * 0.55;
    const anim = new Animated.Value(0);

    setHearts(prev => {
      const next = [...prev, { id, x, y, anim, reactor }];
      if (next.length > MAX_HEARTS) return next.slice(-MAX_HEARTS);
      return next;
    });

    Animated.timing(anim, {
      toValue: 1,
      duration: 2000,
      useNativeDriver: true,
    }).start(() => {
      setHearts(prev => prev.filter(h => h.id !== id));
    });
  }, []);

  // Handle viewer joining. If the local camera/mic stream isn't ready
  // yet (broadcaster just opened the screen, getUserMedia still in
  // flight) we used to silently drop the join — the viewer waited 15s
  // and saw "Stream indisponível". Now we BUFFER pending viewer ids in
  // pendingViewersRef and ensureCameraStream drains them once
  // localStreamRef.current resolves. Result: viewers who hit "Connect"
  // a fraction of a second after the broadcaster goes live still get
  // their offer.
  const _handleViewerJoined = useCallback(async (msg) => {
    const viewerId = msg.viewer_id;
    if (!viewerId) return;
    if (!localStreamRef.current) {
      pendingViewersRef.current.set(viewerId, msg);
      console.log('[Live] viewer ' + viewerId + ' joined before stream ready — buffering');
      return;
    }

    if (!RTC_PeerConnection) {
      console.warn('[Live] RTCPeerConnection not available');
      return;
    }
    const pc = new RTC_PeerConnection(iceConfig);
    peersRef.current.set(viewerId, pc);

    localStreamRef.current.getTracks().forEach(track => {
      pc.addTrack(track, localStreamRef.current);
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'live_ice',
          viewer_id: viewerId,
          session_id: sessionIdRef.current,
          candidate: event.candidate,
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        pc.close();
        peersRef.current.delete(viewerId);
        // Codex root cause #4 — do NOT overwrite server-authoritative count
        // with local peer size. Server emits `live_viewer_count` already, and
        // local size for HLS sessions is always 0.
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'live_offer',
          viewer_id: viewerId,
          session_id: sessionIdRef.current,
          sdp: offer.sdp,
        }));
      }
    } catch (err) {
      console.error('Failed to create offer for viewer:', err);
    }

    // Codex root cause #4 — server `live_viewer_count` is authoritative;
    // do not overwrite with local peer size (HLS sessions would always
    // report 0, hosts would think the live is empty).

    // Track unique viewers across the entire run — survives churn (viewer
    // leaves & rejoins still counts once). Feeds the end-card summary.
    const joinedEmail = (msg.viewer_email || '').toLowerCase();
    const joinedName = msg.viewer_name || msg.viewer_email?.split('@')[0] || '?';
    if (joinedEmail && !uniqueViewersRef.current.has(joinedEmail)) {
      uniqueViewersRef.current.add(joinedEmail);
      setUniqueViewers(uniqueViewersRef.current.size);
      setJoinFeed(prev => [{ email: joinedEmail, name: joinedName, ts: Date.now() }, ...prev].slice(0, 50));
    }

    // Show join message — animated entrance for the TikTok overlay.
    const entry = new Animated.Value(0);
    appendChatMessage({
      id: String(++chatIdRef.current),
      name: joinedName,
      email: msg.viewer_email,
      content: t('live.joined') || 'joined',
      text: t('live.joined') || 'joined',
      type: 'system',
      entry,
    });
    Animated.spring(entry, { toValue: 1, friction: 7, tension: 120, useNativeDriver: true }).start();
  }, [t, appendChatMessage]);
  // Public-name alias kept stable so the rest of the file (and the WS
  // onmessage switch) can call handleViewerJoined as before.
  const handleViewerJoined = _handleViewerJoined;
  // Wire the latest copy into the forward-ref so ensureCameraStream,
  // declared above this point in source order, can drain buffered
  // viewers without hitting a TDZ.
  useEffect(() => {
    handleViewerJoinedRef.current = handleViewerJoined;
  }, [handleViewerJoined]);

  const handleViewerAnswer = useCallback(async (msg) => {
    const viewerId = msg.viewer_id;
    const pc = peersRef.current.get(viewerId);
    if (!pc || !msg.sdp) return;

    try {
      await pc.setRemoteDescription(new RTC_SessionDescription({
        type: 'answer',
        sdp: msg.sdp,
      }));
    } catch (err) {
      console.error('Failed to set remote answer:', err);
    }
  }, []);

  const handleViewerIce = useCallback(async (msg) => {
    const viewerId = msg.viewer_id;
    const pc = peersRef.current.get(viewerId);
    if (!pc || !msg.candidate) return;

    try {
      await pc.addIceCandidate(new RTC_IceCandidate(msg.candidate));
    } catch {}
  }, []);

  const handleViewerLeft = useCallback((msg) => {
    const viewerId = msg.viewer_id;
    const pc = peersRef.current.get(viewerId);
    if (pc) {
      pc.close();
      peersRef.current.delete(viewerId);
    }
    // Server `live_viewer_count` is the authoritative source (Codex #4).
  }, []);

  // ─── Guest co-broadcast (#921 colab mode) ─────────────────────────────
  // When the host approves a join request, the approved viewer publishes
  // their camera/mic as a second WebRTC stream. We receive the offer here,
  // build an `RTCPeerConnection`, and render the remote track as a PiP card.
  // This is best-effort — full SFU support is still pending native rebuild,
  // but this minimal P2P path lights up "colab" UX (host sees guest video).
  const handleGuestOffer = useCallback(async (msg) => {
    if (!msg || !msg.sdp || !RTC_PeerConnection) return;
    // Codex root cause #7 — normalize a stable guest identity for ICE
    // routing. Falls back to guest_email if guest_id is missing (older
    // viewer clients).
    const guestId = String(msg.guest_id || msg.guest_email || '').toLowerCase();
    if (!guestId) {
      console.warn('[Live] live_guest_offer missing guest_id+guest_email — dropping');
      return;
    }
    // Reuse any previous guest peer (a re-offer from same guest).
    try { guestPeer?.pc?.close(); } catch {}
    const iceServers = msg.turn_credentials ? [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: msg.turn_credentials.urls, username: msg.turn_credentials.username, credential: msg.turn_credentials.credential },
    ] : [{ urls: 'stun:stun.l.google.com:19302' }];
    const pc = new RTC_PeerConnection({ iceServers });
    let streamUrl = null;
    pc.ontrack = (e) => {
      const remoteStream = e.streams?.[0];
      if (!remoteStream) return;
      if (Platform.OS !== 'web' && remoteStream.toURL) {
        streamUrl = remoteStream.toURL();
        setGuestPeer(prev => prev ? { ...prev, streamUrl } : prev);
      } else {
        setGuestPeer(prev => prev ? { ...prev, stream: remoteStream } : prev);
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({
            type: 'live_guest_ice',
            session_id: sessionIdRef.current,
            guest_id: guestId,
            guest_email: msg.guest_email,
            candidate: ev.candidate,
          }));
        } catch {}
      }
    };
    const guestRec = { email: msg.guest_email || guestId, name: msg.guest_name, pc, streamUrl: null };
    setGuestPeer(guestRec);
    guestPeerRef.current = guestRec;
    try {
      await pc.setRemoteDescription(new RTC_SessionDescription({ type: 'offer', sdp: msg.sdp }));
      // Codex root cause #7 — drain any ICE candidates that arrived before
      // setRemoteDescription resolved. Previously these were dropped, so the
      // guest's video tile never lit up.
      const queued = guestIceQueueRef.current.get(guestId) || [];
      guestIceQueueRef.current.delete(guestId);
      for (const c of queued) {
        try { await pc.addIceCandidate(new RTC_IceCandidate(c)); } catch {}
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'live_guest_answer',
          session_id: sessionIdRef.current,
          guest_id: guestId,
          guest_email: msg.guest_email,
          sdp: answer.sdp,
        }));
      }
    } catch (e) {
      console.warn('[Live] guest offer fail', e);
      try { pc.close(); } catch {}
      setGuestPeer(null);
      guestPeerRef.current = null;
    }
  }, [guestPeer]);

  const handleGuestIce = useCallback(async (msg) => {
    if (!msg?.candidate) return;
    const guestId = String(msg.guest_id || msg.guest_email || '').toLowerCase();
    const pc = guestPeerRef.current?.pc;
    // Codex root cause #7 — buffer ICE if the peer isn't ready (remoteDesc
    // not set yet, or state didn't commit). Cap at 100 candidates to bound
    // memory if a buggy viewer floods us.
    if (!pc || !pc.remoteDescription) {
      const q = guestIceQueueRef.current.get(guestId) || [];
      if (q.length < 100) q.push(msg.candidate);
      guestIceQueueRef.current.set(guestId, q);
      return;
    }
    try { await pc.addIceCandidate(new RTC_IceCandidate(msg.candidate)); } catch {}
  }, []);

  useEffect(() => { handleGuestOfferRef.current = handleGuestOffer; }, [handleGuestOffer]);
  useEffect(() => { handleGuestIceRef.current = handleGuestIce; }, [handleGuestIce]);
  // Mirror guestPeer state into a ref so handleGuestIce (closure-locked at
  // mount) can see the latest peer without subscribing to re-renders.
  useEffect(() => { guestPeerRef.current = guestPeer; }, [guestPeer]);

  // Host removes the guest from colab.
  const kickGuest = useCallback(() => {
    if (!guestPeer) return;
    try { guestPeer.pc?.close(); } catch {}
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({
          type: 'live_guest_remove',
          session_id: sessionIdRef.current,
          guest_email: guestPeer.email,
        }));
      } catch {}
    }
    setGuestPeer(null);
  }, [guestPeer]);

  const handleChatMessage = useCallback((msg) => {
    // WS server's live_chat broadcast does NOT exclude the sender. The host's
    // handleSendChat already inserts an optimistic local bubble, so without
    // this guard the host sees their own comment twice (echo from the server
    // arrives ~200ms later, looks like duplicate send).
    const myEmail = (user?.email || '').toLowerCase();
    const fromEmail = (msg.sender_email || '').toLowerCase();
    if (myEmail && fromEmail && myEmail === fromEmail) return;

    // Spring-up entrance for the TikTok overlay (LiveChatOverlay reads m.entry).
    const entry = new Animated.Value(0);
    appendChatMessage({
      id: String(++chatIdRef.current),
      name: msg.sender_name || msg.sender_email?.split('@')[0] || '?',
      email: msg.sender_email,
      content: msg.content,
      type: msg.msg_type || 'chat',
      tier: msg.tier || null, // gift / gifter set by gift relays, else default
      entry,
    });
    Animated.spring(entry, { toValue: 1, friction: 7, tension: 120, useNativeDriver: true }).start();
  }, [user, appendChatMessage]);

  // Host long-press a comment in the TikTok overlay → quick action sheet.
  // For now: pin (already wired via legacy long-press) + remove (sends
  // `live_chat_remove` so other viewers' overlays drop the message client-side).
  const onLongPressComment = useCallback((m) => {
    if (!m || !m.id) return;
    try { require('react-native').Vibration.vibrate(10); } catch {}
    Alert.alert(
      m.name || 'Comentário',
      m.content || '',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t('live.pinComment') || 'Fixar',
          onPress: () => {
            const pinContent = m.content || '';
            if (!pinContent) return;
            setPinnedComment({ name: m.name || '?', content: pinContent });
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              try {
                wsRef.current.send(JSON.stringify({
                  type: 'live_pin',
                  session_id: sessionIdRef.current,
                  content: pinContent,
                  sender_name: m.name || '',
                  sender_email: m.email || '',
                }));
              } catch {}
            }
          },
        },
        {
          text: t('live.removeComment') || 'Remover',
          style: 'destructive',
          onPress: () => {
            // Drop locally + tell viewers to drop too.
            setChatMessages(prev => prev.filter(x => x.id !== m.id));
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              try {
                wsRef.current.send(JSON.stringify({
                  type: 'live_chat_remove',
                  session_id: sessionIdRef.current,
                  msg_id: m.id,
                }));
              } catch {}
            }
          },
        },
      ],
    );
  }, [t]);

  // Countdown animation
  const animateCountdown = useCallback((num) => {
    return new Promise((resolve) => {
      setCountdown(num);
      countdownScale.setValue(0.3);
      countdownOpacity.setValue(1);

      Animated.parallel([
        Animated.spring(countdownScale, {
          toValue: 1,
          friction: 4,
          tension: 60,
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.delay(600),
          Animated.timing(countdownOpacity, {
            toValue: 0,
            duration: 300,
            useNativeDriver: true,
          }),
        ]),
      ]).start(() => resolve());
    });
  }, [countdownScale, countdownOpacity]);

  // Start the live broadcast
  const handleStartLive = useCallback(async () => {
    try {
      // Ask for camera + mic only now — the user actively tapped Go Live.
      const ok = await ensureCameraStream();
      if (!ok) return;
      const res = await api.liveStart(titleInput.trim() || t('live.title') || 'Live', { audience });
      const sid = res.data?.session_id || res.data?.session?.id;
      if (res.success && sid) {
        setSessionId(sid);
        sessionIdRef.current = sid;

        // Codex root cause #2 — warn if backend created a Cloudflare live input
        // but exposes no rtmp_url/stream_key. Without those, the host has no
        // way to publish RTMP and HLS viewers will sit on "Stream indisponível"
        // forever while WS counts viewers anyway. We don't have a native
        // publisher embedded, so this is a no-op surface — but logging the
        // condition gives ops a one-line probe for the failure mode.
        if (res.data?.cf_input_uid && !res.data?.rtmp_url && !res.data?.whip_url) {
          console.warn('[Live] backend returned cf_input_uid without rtmp_url/whip_url — viewers will see HLS warm-up forever');
          // Don't block — the WebRTC P2P path still works for in-app viewers.
          // Surface a soft toast so ops/devs see this in QA without blowing
          // up the host UX for the legacy flow.
        }

        // Codex root cause #3 — start WS signaling BEFORE countdown completes
        // so the `live_started` ack lands while the host watches "3,2,1".
        // Await BOTH the WS ack AND the countdown promise so the UI never
        // flips to "AO VIVO" while the channel subscribe is still pending.
        const wsReady = connectSignaling();
        const countdownRun = (async () => {
          await animateCountdown(3);
          await animateCountdown(2);
          await animateCountdown(1);
        })();
        try {
          await Promise.all([wsReady, countdownRun]);
        } catch (waitErr) {
          // live_started ack rejected — the watchdog already surfaced an
          // error string; don't double-message, just abort start.
          console.warn('[Live] start aborted — WS ack failed:', waitErr?.message);
          setCountdown(null);
          return;
        }
        setCountdown(null);

        setPreStart(false);

        // Start duration timer
        durationTimerRef.current = setInterval(() => {
          setLiveDuration(prev => prev + 1);
        }, 1000);

        // Update viewer count every 10s — Codex root cause #4: prefer the
        // server-authoritative WS count over local peer size; HLS sessions
        // have no peers at all so peersRef.size would always report 0.
        viewerCountTimerRef.current = setInterval(() => {
          const count = Math.max(viewerCountRef.current || 0, peersRef.current.size);
          api.liveUpdateViewers(sessionIdRef.current, count).catch(() => {});
        }, 10000);
      } else {
        setError(res?.message || t('live.connectionFailed') || 'Connection failed');
      }
    } catch (e) {
      // Was empty `catch {}` — masked real reason (e.g., auth expired,
      // CDN 502, parental block). Surface the message so the user knows
      // whether to retry / re-login / wait. Falls back to the generic
      // i18n string if the exception has no message.
      console.warn('[live] start failed:', e?.message || e);
      const detail = e?.message ? ` (${e.message})` : '';
      setError((t('live.connectionFailed') || 'Connection failed') + detail);
    }
  }, [titleInput, connectSignaling, t, animateCountdown, ensureCameraStream]);

  // End the live broadcast — shows the rich modal first; the actual teardown
  // runs only when the host confirms (and the chosen replay toggle is sent).
  const performEndLive = useCallback(() => {
    endedRef.current = true;
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    // Capture the just-ended session id BEFORE we null sessionIdRef.current
    // below — the end-card renders "Ver Lives Salvas" CTA gated on this.
    const endedSessionId = sessionIdRef.current;
    // Codex root cause #6 — FREEZE the replay-requested intent at this point.
    // saveReplay can flip after liveEnd is in-flight, so we capture once and
    // use the snapshot for both the API call AND the end-card UI.
    const replayRequested = !!saveReplay;
    setEndedReplayRequested(replayRequested);
    setEndedReplayStatus(replayRequested ? 'processing' : 'none');
    if (endedSessionId) {
      // Capture has_recording from the live_end response so the end-card
      // knows whether to surface "Ver Lives Salvas" (CF Stream pipeline)
      // vs a plain "Concluído" (legacy P2P — no VOD will materialize).
      // Memory-safe — fires after teardown.
      api.liveEnd(endedSessionId, { save_replay: replayRequested })
        .then((res) => {
          if (res?.success) {
            const has = !!res.data?.has_recording;
            setEndedHasRecording(has);
            setEndedReplayStatus(has ? 'processing' : 'none');
            // Best-effort poke at the recording_poll cron so the CF VOD URL
            // lands faster — without this the /lives-saved row shows
            // "Processing" for 1-2 extra minutes.
            if (has) {
              try { api.liveRecordingPoll(endedSessionId).catch(() => {}); } catch {}
            }
          }
        })
        .catch(() => setEndedReplayStatus(replayRequested ? 'error' : 'none'));
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'live_end',
        session_id: sessionIdRef.current,
      }));
    }
    // Codex race-condition cleanup — null WS handlers BEFORE close so the
    // old socket's reconnect timer doesn't schedule over a new connection.
    if (wsRef.current) {
      try {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }

    peersRef.current.forEach(pc => { try { pc.close(); } catch {} });
    peersRef.current.clear();
    try { guestPeerRef.current?.pc?.close(); } catch {}
    guestPeerRef.current = null;
    guestIceQueueRef.current.clear();
    setGuestPeer(null);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    if (viewerCountTimerRef.current) clearInterval(viewerCountTimerRef.current);
    if (durationTimerRef.current) clearInterval(durationTimerRef.current);

    setEnded(true);
    setEndModal(false);
    sessionIdRef.current = null;
    // Spring entrance for the rich end-card. We DON'T auto-route back here
    // anymore — the host can take their time on the summary and tap the
    // Share / Save replay CTAs. The "Concluído" button handles the back nav.
    Animated.parallel([
      Animated.spring(endCardScale, { toValue: 1, friction: 6, tension: 80, useNativeDriver: true }),
      Animated.timing(endCardOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
    ]).start();
  }, [saveReplay, endCardScale, endCardOpacity]);

  const handleEndLive = useCallback(() => {
    // Codex root cause #5 — proper keyboard hide cycle BEFORE mounting the
    // end modal. Without this, on Android the keyboard is mid-hide animation
    // while the modal mounts; the modal card jumps to sit above the keyboard
    // and action buttons fall offscreen.
    // Step 1: blur composer (forces willHide to fire immediately).
    try { composerInputRef.current?.blur?.(); } catch {}
    try { Keyboard.dismiss(); } catch {}
    setKbHeight(0);
    // Step 2: delay modal mount until keyboard hide animation finishes.
    // Android animation is ~160ms; iOS is ~80ms (~3 ticks).
    if (endModalTimerRef.current) clearTimeout(endModalTimerRef.current);
    endModalTimerRef.current = setTimeout(() => {
      endModalTimerRef.current = null;
      setEndModal(true);
    }, Platform.OS === 'android' ? 160 : 80);
  }, []);

  // Toggle audio
  const handleToggleMute = useCallback(() => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      audioTracks.forEach(track => { track.enabled = audioMuted; });
      setAudioMuted(!audioMuted);
    }
  }, [audioMuted]);

  // Toggle video
  const handleToggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      videoTracks.forEach(track => { track.enabled = videoOff; });
      setVideoOff(!videoOff);
    }
  }, [videoOff]);

  // Flip camera
  const handleFlipCamera = useCallback(async () => {
    if (!localStreamRef.current) return;

    const newFacing = facingRef.current === 'user' ? 'environment' : 'user';
    facingRef.current = newFacing;

    try {
      const oldVideoTrack = localStreamRef.current.getVideoTracks()[0];
      if (oldVideoTrack) oldVideoTrack.stop();

      const newStream = await getUserMediaFn({
        video: { facingMode: newFacing },
        audio: false,
      });
      const newVideoTrack = newStream.getVideoTracks()[0];

      localStreamRef.current.removeTrack(oldVideoTrack);
      localStreamRef.current.addTrack(newVideoTrack);

      peersRef.current.forEach(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(newVideoTrack);
      });

      if (Platform.OS === 'web' && localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      } else if (localStreamRef.current?.toURL) {
        setLocalStreamUrl(localStreamRef.current.toURL());
      }
    } catch (err) {
      console.error('Failed to flip camera:', err);
    }
  }, []);

  // Send chat message
  const handleSendChat = useCallback((text) => {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    const entry = new Animated.Value(0);
    const msg = {
      id: String(++chatIdRef.current),
      name: user?.name || user?.email?.split('@')[0] || 'You',
      email: user?.email,
      content: trimmed,
      type: 'chat',
      isHost: true,
      tier: 'host', // colored chip in LiveChatOverlay
      entry,
    };
    appendChatMessage(msg);
    Animated.spring(entry, { toValue: 1, friction: 7, tension: 120, useNativeDriver: true }).start();

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'live_chat',
        session_id: sessionIdRef.current,
        content: trimmed,
      }));
    }

    if (sessionIdRef.current) {
      api.liveSendChat(sessionIdRef.current, trimmed).catch(() => {});
    }
  }, [user]);

  // Composer submit — wraps handleSendChat and clears the local draft.
  const submitComposer = useCallback(() => {
    const trimmed = commentDraft.trim();
    if (!trimmed) return;
    // If the host prefixes "📌 " they pin the next message instead of sending.
    if (trimmed.startsWith('📌 ')) {
      const pinName = user?.name || user?.email?.split('@')[0] || 'You';
      const pinContent = trimmed.slice(2).trim();
      setPinnedComment({ name: pinName, content: pinContent });
      // Broadcast pin to viewers so the yellow TikTok-style pinned chip shows
      // up over the live chat overlay for everyone. Backend WS doesn't need
      // a special handler — the chan fan-out delivers any payload to subs.
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({
            type: 'live_pin',
            session_id: sessionIdRef.current,
            content: pinContent,
            sender_name: pinName,
            sender_email: user?.email,
          }));
        } catch {}
      }
      setCommentDraft('');
      return;
    }
    handleSendChat(trimmed);
    setCommentDraft('');
  }, [commentDraft, handleSendChat, user]);

  // Self-tap heart — instant feedback for the host without waiting for a viewer
  // reaction; also broadcasts so viewers see the heart float.
  const handleSelfHeart = useCallback(() => {
    spawnHeart();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'live_reaction',
        session_id: sessionIdRef.current,
      }));
    }
  }, [spawnHeart]);

  // Share invite — copies the live URL on web, native share sheet otherwise.
  const handleShare = useCallback(async () => {
    // Opens the invite-friends sheet (multi-select picker + search). Falls back
    // to the system share menu only via the explicit "Compartilhar link" row
    // inside the sheet, so the host always lands in the curated chat-invite
    // flow first (TikTok parity) instead of jumping straight to OS share.
    setInviteOpen(true);
  }, []);

  // Lazy-load the host's chat list the first time the invite sheet opens, so
  // we don't pay the network cost during the live start sequence.
  useEffect(() => {
    if (!inviteOpen || inviteLoaded) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.chatConversations?.();
        if (cancelled) return;
        const convs = r?.data?.conversations || r?.conversations || r?.data || [];
        // Flatten direct chats into a contact list. We keep `id`
        // (conversation_id) so chatSend can target it directly without a
        // chatCreate round-trip.
        const flat = [];
        const me = (user?.email || '').toLowerCase();
        for (const c of (Array.isArray(convs) ? convs : [])) {
          if ((c.type || 'direct') !== 'direct') continue;
          // Backend exposes direct peers via `members`, `peer_email`, or `email`.
          const peerEmail = (
            (c.members || []).map(m => typeof m === 'string' ? m : m?.email)
              .find(e => e && e.toLowerCase() !== me)
            || c.peer_email || c.email || ''
          );
          if (!peerEmail) continue;
          const peerName = c.name || c.peer_name || peerEmail.split('@')[0];
          flat.push({ id: c.id, name: peerName, email: peerEmail });
        }
        setInviteContacts(flat);
        setInviteLoaded(true);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [inviteOpen, inviteLoaded, user?.email]);

  const sendInvites = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || inviteSelected.size === 0) return;
    setInviteSending(true);
    const url = `https://chatyy.com.br/live/${sid}`;
    const text = `${titleInput || 'Live'}: ${url}`;
    const ids = Array.from(inviteSelected);
    try {
      await Promise.all(ids.map(convId => {
        try { return api.chatSend?.(convId, text, 'text'); } catch { return null; }
      }));
    } catch {}
    setInviteSending(false);
    setInviteOpen(false);
    setInviteSelected(new Set());
    setInviteSearch('');
    try { require('react-native').Vibration.vibrate(15); } catch {}
  }, [inviteSelected, titleInput]);

  // System share fallback — still useful for sharing to apps outside Chatyy.
  const handleSystemShare = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const url = `https://chatyy.com.br/live/${sid}`;
    if (Platform.OS === 'web') {
      try {
        if (navigator.share) {
          await navigator.share({ title: titleInput || 'Live', url });
        } else if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
        }
      } catch {}
    } else {
      try {
        const { Share } = require('react-native');
        await Share.share({ message: `${titleInput || 'Live'}: ${url}` });
      } catch {}
    }
    setInviteOpen(false);
  }, [titleInput]);

  // Approve / deny a viewer's join request. Approve sends a WS ack — the
  // viewer's `live_join_approved` handler kicks off a separate guest WebRTC
  // negotiation (deferred to native rebuild). For now, the approve path
  // surfaces the visual ack so the host has a working button and the viewer
  // gets a confirming toast.
  const approveJoinRequest = useCallback((email) => {
    try {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Codex root cause #7 — include host identity so the approved
        // viewer knows where to send its guest_offer. Without `host_email`
        // the viewer falls back to the unreliable display-host helper
        // (sometimes returns "" pre-auth → guest offer is misrouted).
        ws.send(JSON.stringify({
          type: 'live_join_approve',
          session_id: sessionIdRef.current,
          viewer_email: email,
          host_email: user?.email,
          host_name: user?.name || user?.email?.split('@')[0],
        }));
      }
    } catch {}
    // TikTok-style cohost path: also persist the approval in PG +
    // broadcast `live_cohost_approved` via WS so the viewer's client can
    // request a LiveKit publisher token and join the SFU room. The legacy
    // P2P path above stays in place for backwards-compat until viewers
    // upgrade past the cohost wire-up OTA.
    try {
      const api = require('../services/api');
      const sid = sessionIdRef.current;
      if (sid && api?.liveCohostApprove) {
        api.liveCohostApprove(sid, email).catch(() => {});
      }
    } catch {}
    setJoinRequests(prev => prev.filter(r => r.email !== email));
  }, [user]);
  const denyJoinRequest = useCallback((email) => {
    try {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'live_join_deny', session_id: sessionIdRef.current, viewer_email: email }));
      }
    } catch {}
    setJoinRequests(prev => prev.filter(r => r.email !== email));
  }, []);

  // Long-press a chat message to pin (host only). Wired through to LiveChat
  // via a callback prop, but we also expose a simple "pin latest" action on
  // the right action stack for users who don't discover the long-press.
  const pinLatestComment = useCallback(() => {
    const last = [...chatMessages].reverse().find(m => m.type !== 'system');
    if (last) setPinnedComment({ name: last.name, content: last.content });
  }, [chatMessages]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      endedRef.current = true; // Prevent reconnection attempts
      if (sessionIdRef.current) {
        api.liveEnd(sessionIdRef.current).catch(() => {});
      }
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
      }
      peersRef.current.forEach(pc => { try { pc.close(); } catch {} });
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (viewerCountTimerRef.current) clearInterval(viewerCountTimerRef.current);
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      // Codex cleanup paths (#10) — clear watchdog + modal timers, drop pending
      // waiter, and tear down guest peer state on unmount.
      if (liveStartedAckTimeoutRef.current) clearTimeout(liveStartedAckTimeoutRef.current);
      if (endModalTimerRef.current) clearTimeout(endModalTimerRef.current);
      liveStartedWaiterRef.current = null;
      pendingViewersRef.current?.clear?.();
      try { guestPeerRef.current?.pc?.close(); } catch {}
      guestPeerRef.current = null;
      guestIceQueueRef.current.clear();
    };
  }, []);

  // Helper: renders the local camera video for both web and native
  const renderLocalVideo = (style) => {
    if (Platform.OS === 'web') {
      return (
        <video
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          style={{
            position: 'absolute', top: 0, left: 0,
            width: '100%', height: '100%',
            objectFit: 'cover', transform: 'scaleX(-1)',
          }}
        />
      );
    }
    if (NativeRTCView && localStreamUrl) {
      return (
        <NativeRTCView
          streamURL={localStreamUrl}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
          mirror={facingRef.current === 'user'}
          zOrder={0}
        />
      );
    }
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />;
  };

  // Ended state — rich summary card with duration / unique viewers / likes
  // and two CTAs (share recap + save replay toggle). Spring entrance.
  if (ended) {
    const recapUrl = (typeof window !== 'undefined' && uniqueViewersRef.current.size >= 0)
      ? `https://chatyy.com.br/live/recap` : '';
    const onShareRecap = async () => {
      try {
        if (Platform.OS === 'web' && typeof navigator !== 'undefined') {
          if (navigator.share) { await navigator.share({ title: t('live.liveEnded') || 'Live encerrada', url: recapUrl }); }
          else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(recapUrl); }
        } else {
          const { Share } = require('react-native');
          await Share.share({ message: (titleInput || 'Live') + ' — ' + recapUrl });
        }
      } catch {}
    };
    return (
      <View style={styles.centered}>
        <Animated.View style={[styles.endCard, {
          transform: [{ scale: endCardScale }],
          opacity: endCardOpacity,
        }]}>
          <View style={styles.endCardHero}>
            <View style={styles.endCardIcon}>
              <IconVideo size={32} color="#fff" />
            </View>
            <Text style={styles.endCardTitle}>{t('live.liveEnded') || 'Live encerrada'}</Text>
            <Text style={styles.endCardSubtitle} numberOfLines={2}>
              {titleInput || (t('live.title') || 'Live')}
            </Text>
          </View>

          <View style={styles.endCardStatsRow}>
            <View style={styles.endCardStat}>
              <Text style={styles.endCardStatValue}>{formatDuration(liveDuration)}</Text>
              <Text style={styles.endCardStatLabel}>{t('live.duration') || 'Duração'}</Text>
            </View>
            <View style={styles.endCardStatSep} />
            <View style={styles.endCardStat}>
              <Text style={styles.endCardStatValue}>{formatViewerCount(uniqueViewers)}</Text>
              <Text style={styles.endCardStatLabel}>{t('live.uniqueViewers') || 'Únicos'}</Text>
            </View>
            <View style={styles.endCardStatSep} />
            <View style={styles.endCardStat}>
              <Text style={styles.endCardStatValue}>{formatViewerCount(totalLikes)}</Text>
              <Text style={styles.endCardStatLabel}>{t('live.likes') || 'Curtidas'}</Text>
            </View>
          </View>

          <View style={styles.endCardCtaRow}>
            <TouchableOpacity
              onPress={onShareRecap}
              style={styles.endCardCtaSecondary}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('live.share') || 'Compartilhar'}
            >
              <IconShare size={16} color="#fff" />
              <Text style={styles.endCardCtaSecondaryText}>{t('live.share') || 'Compartilhar'}</Text>
            </TouchableOpacity>
            {/* Codex root cause #6 — after liveEnd the toggle is read-only.
                Tapping it routes to /lives-saved when a recording exists, so
                the host doesn't have to hunt the menu for the replay. The
                label surfaces processing / saved / failed state explicitly
                instead of the old "Salvar replay" toggle that desynced. */}
            <TouchableOpacity
              onPress={() => endedHasRecording ? router.push('/lives-saved') : null}
              disabled={!endedHasRecording}
              style={[styles.endCardCtaPrimary, !endedReplayRequested && styles.endCardCtaPrimaryOff]}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('live.replayStatusLabel') || 'Status do replay'}
              accessibilityState={{ disabled: !endedHasRecording }}
            >
              {endedReplayRequested ? <IconStarFilled size={16} color="#000" /> : <IconBookmark size={16} color="#fff" />}
              <Text style={[styles.endCardCtaPrimaryText, !endedReplayRequested && { color: '#fff' }]}>
                {endedReplayStatus === 'processing'
                  ? (t('live.replayProcessing') || 'Processando em Lives salvas')
                  : endedReplayStatus === 'error'
                    ? (t('live.replayError') || 'Falha ao salvar replay')
                    : endedReplayRequested
                      ? (t('live.replaySavedInLives') || 'Salvo em Lives salvas')
                      : (t('live.replayNotSaved') || 'Replay não salvo')}
              </Text>
            </TouchableOpacity>
          </View>

          {/* "Ver Lives Salvas" — surfaces the replay landing page right
              after the host ends. Only shown when the backend confirms a
              recording is in flight (CF Stream pipeline + save_replay=true).
              Without this CTA the host had no idea WHERE the replay went
              (incident: user complaint "Replay onde tá?? Cadê?"). */}
          {endedHasRecording && saveReplay ? (
            <TouchableOpacity
              onPress={() => {
                try { router.replace('/lives-saved'); }
                catch { router.push('/lives-saved'); }
              }}
              style={styles.endCardSeeReplays}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('liveReplay.tab') || 'Lives salvas'}
            >
              <IconStarFilled size={16} color="#fff" />
              <Text style={styles.endCardSeeReplaysText}>
                {t('liveReplay.viewReplays') || 'Ver Lives Salvas'}
              </Text>
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity onPress={() => router.back()} style={styles.endCardDone} activeOpacity={0.7}>
            <Text style={styles.endCardDoneText}>{t('common.done') || 'Concluído'}</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    );
  }

  // Error state
  if (error && preStart) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Text style={styles.backBtnText}>{t('common.cancel') || 'Back'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Pre-start screen — Instagram Live setup: hero glass card, audience pill,
  // pre-camera flip, animated placeholder sparkle, gradient brand CTA.
  if (preStart) {
    const audOptions = [
      { key: 'public',  Icon: IconGlobe, label: t('live.audPublic')  || 'Público' },
      { key: 'friends', Icon: IconUsers, label: t('live.audFriends') || 'Amigos' },
      { key: 'private', Icon: IconLock,  label: t('live.audPrivate') || 'Privado' },
    ];
    return (
      <View style={styles.fullScreen}>
        {renderLocalVideo()}
        {/* Dark gradient overlay — radial brand purple bleed bottom + dim top.
            Plays nice on top of the camera preview (when granted) and reads
            beautifully even when the preview is black (no permission yet). */}
        <View style={styles.preOverlay}>
          {/* Brand purple radial glow at the bottom — pure View w/ huge
              borderRadius so it works on native (no expo-linear-gradient dep).
              Adds the "warm" Instagram-Live vibe under the card. */}
          <View pointerEvents="none" style={styles.preGlowPurple} />
          <View pointerEvents="none" style={styles.preGlowRed} />
          {/* Close X — wrapped in a glass circular backdrop for contrast. */}
          <TouchableOpacity
            onPress={() => router.back()}
            style={[styles.closeBtn, { top: insets.top + 16 }]}
            accessibilityLabel="Close"
            accessibilityRole="button"
          >
            <IconX size={22} color="#fff" />
          </TouchableOpacity>

          {/* Pre-live flip-camera — top-left, mirrors Instagram. Toggles the
              facing preference; the actual stream is opened with this value
              when the host taps "Começar". Uses IconCameraFlip (28px) to
              match the brand SVG language across call/live surfaces. */}
          <TouchableOpacity
            onPress={() => setPreFacing(f => f === 'user' ? 'environment' : 'user')}
            style={[styles.preFlipBtn, { top: insets.top + 16 }]}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('live.flipCamera') || 'Flip camera'}
          >
            <IconCameraFlip size={22} color="#fff" />
          </TouchableOpacity>

          {/* Hero glass card */}
          <View style={styles.preHero}>
            {/* Avatar with breathing red ring — telegraphs the "live" state
                before the host even taps Começar. NativeDriver opacity loop. */}
            <View style={styles.preAvatarWrap}>
              <Animated.View
                pointerEvents="none"
                style={[styles.preAvatarPulseRing, {
                  opacity: preRingPulse.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.6] }),
                  transform: [{ scale: preRingPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) }],
                }]}
              />
              <AvatarCircle
                name={user?.name || user?.email}
                email={user?.email}
                size={84}
                style={styles.preAvatar}
              />
            </View>
            <Text style={styles.preName} numberOfLines={1}>{user?.name || user?.email?.split('@')[0]}</Text>
            <Text style={styles.preHint}>{t('live.preHint') || 'Tudo pronto pra ir ao vivo'}</Text>

            <View style={styles.preTitleWrap}>
              <TextInput
                style={styles.titleInput}
                value={titleInput}
                onChangeText={setTitleInput}
                placeholder={t('live.enterTitle') || 'Adicione um título à sua live...'}
                placeholderTextColor="rgba(255,255,255,0.4)"
                returnKeyType="done"
                accessibilityLabel={t('live.enterTitle') || 'Live title'}
                maxLength={100}
              />
              {!titleInput ? (
                <Animated.View pointerEvents="none" style={[styles.preTitleSparkle, { opacity: placeholderFade }]}>
                  <IconSparkles size={14} color="rgba(168,85,247,0.9)" />
                </Animated.View>
              ) : (
                <TouchableOpacity
                  onPress={() => setTitleInput('')}
                  style={styles.preTitleClear}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.clear') || 'Clear'}
                >
                  <View style={styles.preTitleClearCircle}>
                    <IconX size={11} color="rgba(255,255,255,0.85)" />
                  </View>
                </TouchableOpacity>
              )}
            </View>

            {/* Audience selector — public/friends/private with brand-tinted
                active state. Sent as `audience` to liveStart so the backend
                can scope the announce push. Spring-scaled active pill. */}
            <View style={styles.preAudRow}>
              <Text style={styles.preAudLabel}>{t('live.whoCanSee') || 'Quem pode ver'}</Text>
              <View style={styles.preAudPills}>
                {audOptions.map(opt => {
                  const Icon = opt.Icon;
                  const active = audience === opt.key;
                  return (
                    <Animated.View
                      key={opt.key}
                      style={{ transform: [{ scale: preAudScale[opt.key] }] }}
                    >
                      <TouchableOpacity
                        onPress={() => setAudience(opt.key)}
                        style={[styles.preAudPill, active && styles.preAudPillActive]}
                        activeOpacity={0.85}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={opt.label}
                      >
                        <Icon size={14} color={active ? '#fff' : 'rgba(255,255,255,0.75)'} />
                        <Text style={[styles.preAudPillText, active && { color: '#fff', fontWeight: '800' }]}>
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    </Animated.View>
                  );
                })}
              </View>
            </View>

            {/* CTA — wrapped in an Animated.View so the red glow loops behind
                the button (web only via boxShadow). On native, the live dot
                pulses inside the button instead (same red-heartbeat rhythm). */}
            <Animated.View style={[styles.startBtnWrap, Platform.OS === 'web' ? {
              shadowOpacity: preBtnGlow.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.7] }),
            } : null]}>
              <TouchableOpacity
                onPress={handleStartLive}
                style={styles.startBtn}
                activeOpacity={0.9}
                accessibilityLabel={t('live.goLive') || 'Go Live'}
                accessibilityRole="button"
              >
                <Animated.View style={[styles.startBtnDot, {
                  transform: [{ scale: preBtnGlow.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.15] }) }],
                  opacity: preBtnGlow.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }),
                }]} />
                <Text style={styles.startBtnText}>{t('live.goLive') || 'Começar'}</Text>
              </TouchableOpacity>
            </Animated.View>

            <Text style={styles.preTip}>{t('live.preTip') || 'Sua câmera ficará visível pros viewers'}</Text>
          </View>

          {/* Countdown overlay */}
          {countdown !== null && (
            <View style={styles.countdownOverlay}>
              <Animated.Text style={[styles.countdownText, {
                transform: [{ scale: countdownScale }],
                opacity: countdownOpacity,
              }]}>
                {countdown}
              </Animated.Text>
            </View>
          )}
        </View>
      </View>
    );
  }

  // Live broadcasting screen
  return (
    <View style={styles.fullScreen}>
      {renderLocalVideo()}

      {/* Guest co-broadcast PiP card (#921 colab mode). Renders the approved
          viewer's camera in a draggable 110×150 card top-right of the host's
          frame — TikTok "Go LIVE Together" pattern. Tap × to kick the guest. */}
      {guestPeer ? (
        <View style={{
          position: 'absolute',
          top: (insets?.top || 0) + 110,
          right: 14,
          width: 110,
          height: 150,
          borderRadius: 14,
          backgroundColor: '#0b0b18',
          borderWidth: 2,
          borderColor: '#22d3ee',
          overflow: 'hidden',
          zIndex: 25,
          ...(Platform.OS === 'web' ? { boxShadow: '0 6px 18px rgba(34,211,238,0.4)' } : {}),
        }}>
          {Platform.OS === 'web' ? (
            <video
              autoPlay
              playsInline
              ref={(ref) => { if (ref && guestPeer.stream && ref.srcObject !== guestPeer.stream) ref.srcObject = guestPeer.stream; }}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (NativeRTCView && guestPeer.streamUrl ? (
            <NativeRTCView streamURL={guestPeer.streamUrl} style={StyleSheet.absoluteFill} objectFit="cover" zOrder={1} />
          ) : (
            <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
              <AvatarCircle name={guestPeer.name} email={guestPeer.email} size={48} />
            </View>
          ))}
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 6, paddingVertical: 3 }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }} numberOfLines={1}>
              {t('live.guestColab') || 'Colab'} · {guestPeer.name || (guestPeer.email || '').split('@')[0]}
            </Text>
          </View>
          <TouchableOpacity
            onPress={kickGuest}
            style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center' }}
            activeOpacity={0.7}
            accessibilityLabel={t('live.kickGuest') || 'Remove collab'}
          >
            <IconX size={12} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Video off overlay */}
      {videoOff && (
        <View style={styles.videoOffOverlay}>
          <AvatarCircle
            name={user?.name || user?.email}
            email={user?.email}
            size={80}
          />
          <Text style={styles.videoOffText}>{t('live.cameraOff') || 'Camera off'}</Text>
        </View>
      )}

      {/* Top bar — TikTok-grade: avatar + LIVE pulsing badge + viewer pill +
          duration timer + connection-quality bars + close. Glass background. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
        <View style={styles.topLeft}>
          {/* Host avatar with a red pulse ring — same red as the LIVE pill so
              the "we are live" rhythm reads as one beat. The ring sits behind
              the avatar (Animated.View at -3 inset) so the image itself stays
              crisp; only the halo scales. */}
          <View style={styles.hostAvatarWrap}>
            <Animated.View
              pointerEvents="none"
              style={[styles.hostAvatarPulseRing, {
                transform: [{ scale: livePulse }],
                opacity: livePulse.interpolate({ inputRange: [1, 1.5], outputRange: [0.7, 0] }),
              }]}
            />
            <View style={styles.hostAvatarRing} pointerEvents="none" />
            <AvatarCircle name={user?.name || user?.email} email={user?.email} size={36} />
          </View>
          <View style={styles.hostMeta}>
            <View style={styles.liveBadge}>
              <Animated.View style={[styles.liveBadgeDot, {
                transform: [{ scale: livePulse }],
                opacity: livePulse.interpolate({ inputRange: [1, 1.5], outputRange: [1, 0.6] }),
              }]} />
              <Text style={styles.liveBadgeText}>LIVE</Text>
            </View>
            <View style={styles.viewerPill}>
              <View style={styles.viewerDot} />
              <Animated.Text style={[styles.viewerCountText, { transform: [{ scale: viewerBounce }] }]}>
                {formatViewerCount(viewerCount)}
              </Animated.Text>
              <Text style={styles.viewerWatchText}>{t('live.watching') || 'assistindo'}</Text>
            </View>
          </View>
        </View>
        <View style={styles.topRight}>
          <ConnectionBars quality={connQuality} t={t} />
          <View style={styles.durationPill}>
            <View style={styles.durationDotWrap}>
              <Animated.View style={[styles.durationDotRing, {
                transform: [{ scale: livePulse }],
                opacity: livePulse.interpolate({ inputRange: [1, 1.5], outputRange: [0.55, 0] }),
              }]} />
              <View style={styles.durationDot} />
            </View>
            <Text style={styles.durationText}>{formatDuration(liveDuration)}</Text>
          </View>
          {/* Red end-live button — destaque visual (vs the cinza closeBtn2)
              so the host immediately knows where to tap to end. Uses IconStop
              (the stop square SVG) to communicate intent better than IconX. */}
          <TouchableOpacity
            onPress={handleEndLive}
            style={styles.endLiveBtn}
            accessibilityLabel={t('live.endLive') || 'End live'}
            accessibilityRole="button"
            activeOpacity={0.85}
          >
            <View style={styles.endLiveBtnInner} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Title */}
      {titleInput ? (
        <View style={styles.titleBar}>
          <Text style={styles.liveTitle} numberOfLines={1}>
            {titleInput}
          </Text>
        </View>
      ) : null}

      {/* Pinned comment — brand-purple accent + IconPin SVG (no emoji per
          design rule: components/Icons.js only for UI affordances). */}
      {pinnedComment ? (
        <View style={[styles.pinnedWrap, { top: titleInput ? 130 : 100 }]}>
          <View style={styles.pinnedCard}>
            <View style={styles.pinnedIconWrap}>
              <IconPin size={14} color="#fff" />
            </View>
            <View style={styles.pinnedBody}>
              <Text style={styles.pinnedName} numberOfLines={1}>{pinnedComment.name}</Text>
              <Text style={styles.pinnedContent} numberOfLines={2}>{pinnedComment.content}</Text>
            </View>
            <TouchableOpacity
              onPress={() => {
                setPinnedComment(null);
                // Broadcast empty content so viewers clear their pinned chip too.
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  try {
                    wsRef.current.send(JSON.stringify({
                      type: 'live_pin',
                      session_id: sessionIdRef.current,
                      content: '',
                      sender_email: user?.email,
                    }));
                  } catch {}
                }
              }}
              style={styles.pinnedClose}
              accessibilityLabel="Unpin"
              accessibilityRole="button"
            >
              <IconX size={14} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* Right-side vertical action stack — TikTok pattern: settings, effects,
          filter, timer, pin. Stacked above the bottom controls so they don't
          collide with the chat overlay. */}
      <View style={[styles.rightStack, { bottom: insets.bottom + 200 }]} pointerEvents="box-none">
        <TouchableOpacity
          onPress={() => setSettingsOpen(true)}
          style={styles.rightBtn}
          activeOpacity={0.7}
          accessibilityLabel={t('live.settings') || 'Settings'}
          accessibilityRole="button"
        >
          <IconSettings size={18} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { setEffectsOn(v => !v); setEffectsOpen(true); }}
          style={[styles.rightBtn, effectsOn && { backgroundColor: 'rgba(168,85,247,0.4)' }]}
          activeOpacity={0.7}
          accessibilityLabel={t('live.effects') || 'Effects'}
          accessibilityRole="button"
        >
          <IconSparkles size={18} color={effectsOn ? '#facc15' : '#fff'} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setFilterOpen(true)}
          style={[styles.rightBtn, activeFilter !== 'none' && { backgroundColor: 'rgba(124,58,237,0.4)' }]}
          activeOpacity={0.7}
          accessibilityLabel={t('live.filter') || 'Filter'}
          accessibilityRole="button"
        >
          <IconFilter size={18} color={activeFilter !== 'none' ? '#facc15' : '#fff'} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setSaveReplay(v => !v)}
          style={[styles.rightBtn, saveReplay && { backgroundColor: 'rgba(250,204,21,0.4)' }]}
          activeOpacity={0.7}
          accessibilityLabel={t('live.saveReplay') || 'Save replay'}
          accessibilityRole="button"
          accessibilityState={{ checked: saveReplay }}
        >
          {saveReplay
            ? <IconStarFilled size={20} color="#fbbf24" />
            : <IconStar size={20} color="#fff" />}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={pinLatestComment}
          style={styles.rightBtn}
          activeOpacity={0.7}
          accessibilityLabel={t('live.pinComment') || 'Pin latest'}
          accessibilityRole="button"
        >
          <IconPin size={18} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleFlipCamera}
          style={styles.rightBtn}
          activeOpacity={0.7}
          accessibilityLabel={t('live.flipCamera') || 'Flip camera'}
          accessibilityRole="button"
        >
          <IconCameraFlip size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Live insights pill — bottom-left chip with viewer+reaction snapshot.
          Tap opens the insights modal with the join feed. Backdrop blur on
          web; soft dark fill on native (no native blur lib loaded here). */}
      <TouchableOpacity
        onPress={() => setInsightsOpen(true)}
        activeOpacity={0.85}
        style={[styles.insightsPill, { bottom: insets.bottom + 270, left: 14 }]}
        accessibilityRole="button"
        accessibilityLabel={t('live.insights') || 'Insights'}
      >
        <IconEye size={14} color="#fff" />
        <Text style={styles.insightsPillText}>{formatViewerCount(viewerCount)}</Text>
        <View style={styles.insightsPillDot} />
        <IconHeart size={12} color="#fca5a5" />
        <Text style={styles.insightsPillText}>{formatViewerCount(totalLikes)}</Text>
      </TouchableOpacity>

      {/* Floating hearts — Instagram-Live style: heart pop + tiny reactor
          avatar (when known) drifts up with it so the host instantly sees
          "quem curtiu". Random drift on X axis keeps the trail organic. */}
      {hearts.map(h => {
        const translateY = h.anim.interpolate({ inputRange: [0, 1], outputRange: [0, -260] });
        const scale = h.anim.interpolate({ inputRange: [0, 0.2, 0.8, 1], outputRange: [0.3, 1.3, 1, 0.6] });
        const opacity = h.anim.interpolate({ inputRange: [0, 0.1, 0.8, 1], outputRange: [0, 1, 1, 0] });
        const translateX = h.anim.interpolate({ inputRange: [0, 1], outputRange: [0, (Math.random() - 0.5) * 80] });

        return (
          <Animated.View
            key={h.id}
            style={[styles.heart, {
              left: h.x - 14,
              top: h.y - 14,
              transform: [{ translateY }, { translateX }, { scale }],
              opacity,
            }]}
            pointerEvents="none"
          >
            <IconHeart size={28} color={LIVE_RED} />
            {h.reactor?.email ? (
              <View style={styles.heartAvatarChip}>
                <AvatarCircle name={h.reactor.name} email={h.reactor.email} size={18} />
              </View>
            ) : null}
          </Animated.View>
        );
      })}

      {/* Bottom: scrolling chat overlay (bottom→up, fades at top), composer
          row with invite pill + text input + heart + share + flip. */}
      <View style={styles.bottomArea} pointerEvents="box-none">
        <View style={styles.chatScrollWrap} pointerEvents="box-none">
          {/* TikTok-grade comments overlay (round 921). Same component the
              viewer uses, with host-side long-press → pin/remove and the
              colored-chip tier system (host=purple, gift=gold, guest=cyan).
              Older lines fade via gradient mask + per-row stack-alpha; new
              lines spring up from below. */}
          {hideChat ? null : (
            <LiveChatOverlay
              messages={chatMessages}
              onPressMessage={(m) => {
                // Tap a row → seed an @reply in the composer (commentDraft).
                if (!m) return;
                const handle = (m.name || (m.email || '').split('@')[0] || '').replace(/\s+/g, '');
                if (handle) setCommentDraft(prev => (prev ? prev + ' ' : '') + '@' + handle + ' ');
              }}
              onLongPressHost={onLongPressComment}
              onOpenSheet={() => {}}
              isHostView
              hasMore={chatMessages.length > 6}
              seeAllLabel={t('live.seeAllComments') || 'Ver todos os comentários'}
              hostEmail={user?.email}
            />
          )}
          <View style={styles.chatTopFade} pointerEvents="none" />
        </View>

        <View style={[styles.composerRow, { paddingBottom: (kbHeight > 0 ? kbHeight + 8 : insets.bottom + 12) }]}>
          {/* Primary purple "Convidar amigos" pill — TikTok places this at the
              bottom-left to drive viewer growth. */}
          <TouchableOpacity
            onPress={handleShare}
            style={styles.invitePill}
            activeOpacity={0.85}
            accessibilityLabel={t('live.inviteFriends') || 'Invite friends'}
            accessibilityRole="button"
          >
            <IconUserPlus size={14} color="#fff" />
            <Text style={styles.invitePillText} numberOfLines={1}>
              {t('live.inviteFriends') || 'Convidar amigos'}
            </Text>
          </TouchableOpacity>

          <View style={styles.composerInputWrap}>
            <TextInput
              ref={composerInputRef}
              style={styles.composerInput}
              value={commentDraft}
              onChangeText={setCommentDraft}
              placeholder={t('live.sayHello') || 'Diga oi...'}
              placeholderTextColor="rgba(255,255,255,0.55)"
              onSubmitEditing={submitComposer}
              returnKeyType="send"
              blurOnSubmit={false}
              accessibilityLabel={t('live.commentHint') || 'Add comment'}
              maxLength={300}
            />
            {commentDraft.trim().length > 0 ? (
              <TouchableOpacity
                onPress={submitComposer}
                style={styles.composerSendBtn}
                activeOpacity={0.7}
                accessibilityLabel={t('live.send') || 'Send'}
                accessibilityRole="button"
              >
                <IconSend size={16} color="#fff" />
              </TouchableOpacity>
            ) : null}
          </View>

          <TouchableOpacity
            onPress={handleSelfHeart}
            style={[styles.composerIconBtn, styles.heartBtn]}
            activeOpacity={0.7}
            accessibilityLabel={t('live.like') || 'Like'}
            accessibilityRole="button"
          >
            <IconHeart size={18} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleShare}
            style={styles.composerIconBtn}
            activeOpacity={0.7}
            accessibilityLabel={t('live.share') || 'Share'}
            accessibilityRole="button"
          >
            <IconShare size={18} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleToggleMute}
            style={[styles.composerIconBtn, audioMuted && styles.composerIconBtnActive]}
            activeOpacity={0.7}
            accessibilityLabel={audioMuted ? (t('live.unmute') || 'Unmute') : (t('live.mute') || 'Mute')}
            accessibilityRole="button"
          >
            {audioMuted ? <IconMicOff size={18} color="#fff" /> : <IconMic size={18} color="#fff" />}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleToggleVideo}
            style={[styles.composerIconBtn, videoOff && styles.composerIconBtnActive]}
            activeOpacity={0.7}
            accessibilityLabel={videoOff ? 'Turn on camera' : 'Turn off camera'}
            accessibilityRole="button"
          >
            {videoOff ? <IconVideoOff size={18} color="#fff" /> : <IconVideo size={18} color="#fff" />}
          </TouchableOpacity>
        </View>
      </View>

      {/* End-Live confirmation modal — shows the run summary (duration,
          viewers, likes) and the Save Replay toggle before tearing down. */}
      {endModal ? (
        <View style={styles.endModalBackdrop}>
          <View style={styles.endModalCard}>
            <View style={styles.endModalHeader}>
              <View style={styles.endModalLiveDot} />
              <Text style={styles.endModalTitle}>{t('live.endLive') || 'Encerrar Live?'}</Text>
            </View>
            <Text style={styles.endModalSubtitle}>
              {t('live.endConfirm') || 'Sua transmissão vai ser encerrada e os espectadores vão sair.'}
            </Text>
            <View style={styles.endModalStats}>
              <View style={styles.endModalStat}>
                <Text style={styles.endModalStatValue}>{formatDuration(liveDuration)}</Text>
                <Text style={styles.endModalStatLabel}>{t('live.duration') || 'Duração'}</Text>
              </View>
              <View style={styles.endModalStatDivider} />
              <View style={styles.endModalStat}>
                <Text style={styles.endModalStatValue}>{formatViewerCount(viewerCount)}</Text>
                <Text style={styles.endModalStatLabel}>{t('live.viewers') || 'Espectadores'}</Text>
              </View>
              <View style={styles.endModalStatDivider} />
              <View style={styles.endModalStat}>
                <Text style={styles.endModalStatValue}>{formatViewerCount(totalLikes)}</Text>
                <Text style={styles.endModalStatLabel}>{t('live.likes') || 'Curtidas'}</Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={() => setSaveReplay(v => !v)}
              activeOpacity={0.8}
              style={styles.endModalToggleRow}
              accessibilityRole="switch"
              accessibilityState={{ checked: saveReplay }}
              accessibilityLabel={t('live.saveReplay') || 'Save replay'}
            >
              <View style={styles.endModalToggleLabelWrap}>
                <Text style={styles.endModalToggleLabel}>
                  {t('live.saveReplay') || 'Salvar replay'}
                </Text>
                <Text style={styles.endModalToggleHint}>
                  {t('live.saveReplayHint') || 'Espectadores poderão assistir depois'}
                </Text>
              </View>
              <View style={[styles.endModalToggle, saveReplay && styles.endModalToggleOn]}>
                <View style={[styles.endModalToggleKnob, saveReplay && styles.endModalToggleKnobOn]} />
              </View>
            </TouchableOpacity>
            <View style={styles.endModalActions}>
              <TouchableOpacity
                onPress={() => setEndModal(false)}
                style={styles.endModalCancel}
                activeOpacity={0.7}
                accessibilityLabel={t('common.cancel') || 'Cancel'}
                accessibilityRole="button"
              >
                <Text style={styles.endModalCancelText}>{t('common.cancel') || 'Continuar live'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={performEndLive}
                style={styles.endModalConfirm}
                activeOpacity={0.85}
                accessibilityLabel={t('live.endLive') || 'End live'}
                accessibilityRole="button"
              >
                <Text style={styles.endModalConfirmText}>{t('live.endLive') || 'Encerrar'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

      {/* Filter overlay — semi-transparent tint over the camera so the host
          (and ultimately viewers, once we plumb the filter through the SDP
          insertable streams) can preview a "look". Doesn't affect viewer
          output yet — that's a follow-up — but does feel right on the host
          side and gives Effects/Filter buttons a real outcome. */}
      {activeFilter !== 'none' ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, {
          backgroundColor: activeFilter === 'bw' ? 'rgba(0,0,0,0.35)'
            : activeFilter === 'warm' ? 'rgba(255,140,0,0.18)'
            : activeFilter === 'cool' ? 'rgba(0,128,255,0.16)'
            : activeFilter === 'vivid' ? 'rgba(168,85,247,0.14)'
            : 'transparent',
          zIndex: 1,
        }]} />
      ) : null}

      {/* Settings sheet — wires every right-stack button that used to be a
          no-op into one place. Save Replay toggle moved here too so the host
          can flip it mid-stream (was only available in the end-modal before). */}
      {settingsOpen ? (
        <View style={liveSheetStyles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setSettingsOpen(false)} />
          <View style={[liveSheetStyles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={liveSheetStyles.grabber} />
            <Text style={liveSheetStyles.title}>{t('live.settings') || 'Configurações da live'}</Text>

            <TouchableOpacity onPress={() => setSaveReplay(v => !v)} style={liveSheetStyles.row} activeOpacity={0.7}>
              <Text style={liveSheetStyles.rowLabel}>{t('live.saveReplay') || 'Salvar replay'}</Text>
              <View style={[liveSheetStyles.toggle, saveReplay && liveSheetStyles.toggleOn]}>
                <View style={[liveSheetStyles.knob, saveReplay && liveSheetStyles.knobOn]} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setHideChat(v => !v)} style={liveSheetStyles.row} activeOpacity={0.7}>
              <Text style={liveSheetStyles.rowLabel}>{t('live.hideChat') || 'Ocultar chat'}</Text>
              <View style={[liveSheetStyles.toggle, hideChat && liveSheetStyles.toggleOn]}>
                <View style={[liveSheetStyles.knob, hideChat && liveSheetStyles.knobOn]} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setMuteReactions(v => !v)} style={liveSheetStyles.row} activeOpacity={0.7}>
              <Text style={liveSheetStyles.rowLabel}>{t('live.muteReactions') || 'Silenciar reações'}</Text>
              <View style={[liveSheetStyles.toggle, muteReactions && liveSheetStyles.toggleOn]}>
                <View style={[liveSheetStyles.knob, muteReactions && liveSheetStyles.knobOn]} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setSettingsOpen(false)} style={liveSheetStyles.closeBtn} activeOpacity={0.85}>
              <Text style={liveSheetStyles.closeText}>{t('common.done') || 'Concluído'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* Filter sheet — 5 looks. Tap applies live; tap "Nenhum" clears. */}
      {filterOpen ? (
        <View style={liveSheetStyles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setFilterOpen(false)} />
          <View style={[liveSheetStyles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={liveSheetStyles.grabber} />
            <Text style={liveSheetStyles.title}>{t('live.filter') || 'Filtros'}</Text>
            <View style={liveSheetStyles.filterRow}>
              {[
                { key: 'none', label: t('live.filterNone') || 'Nenhum', color: 'transparent' },
                { key: 'bw', label: 'P&B', color: '#000' },
                { key: 'warm', label: 'Quente', color: '#ff8c00' },
                { key: 'cool', label: 'Frio', color: '#3b82f6' },
                { key: 'vivid', label: 'Vivid', color: '#a855f7' },
              ].map(f => (
                <TouchableOpacity
                  key={f.key}
                  onPress={() => { setActiveFilter(f.key); setFilterOpen(false); }}
                  style={[liveSheetStyles.filterChip, activeFilter === f.key && liveSheetStyles.filterChipActive]}
                  activeOpacity={0.7}
                >
                  <View style={[liveSheetStyles.filterSwatch, { backgroundColor: f.color }]} />
                  <Text style={[liveSheetStyles.filterLabel, activeFilter === f.key && { color: '#fff', fontWeight: '700' }]}>{f.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      ) : null}

      {/* Join requests pill — Instagram-style "Pedidos" chip in the top-right
          stack, shown only when there's at least one pending request. Tap
          opens the requests sheet. */}
      {joinRequests.length > 0 ? (
        <TouchableOpacity
          onPress={() => setRequestsOpen(true)}
          activeOpacity={0.85}
          style={{
            position: 'absolute', top: insets.top + 64, right: 14,
            backgroundColor: '#7C3AED', borderRadius: 16,
            paddingHorizontal: 10, paddingVertical: 6,
            flexDirection: 'row', alignItems: 'center', gap: 6,
            zIndex: 30,
          }}
        >
          <Animated.View
            style={{
              width: 8, height: 8, borderRadius: 4, backgroundColor: '#facc15',
              transform: [{ scale: livePulse }],
              shadowColor: '#facc15', shadowOpacity: 0.8, shadowRadius: 6,
            }}
          />
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>
            {joinRequests.length} {t('live.colabRequest') || 'pra colab'}
          </Text>
        </TouchableOpacity>
      ) : null}

      {/* Requests sheet — list of viewers who tapped "Pedir pra entrar". Host
          approves (we send live_join_approve via WS — actual SFU guest join
          is a native-rebuild deliverable) or denies. */}
      {requestsOpen ? (
        <View style={liveSheetStyles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setRequestsOpen(false)} />
          <View style={[liveSheetStyles.sheet, { paddingBottom: insets.bottom + 16, maxHeight: '70%' }]}>
            <View style={liveSheetStyles.grabber} />
            <Text style={liveSheetStyles.title}>{t('live.colabRequests') || 'Pedidos pra colab'}</Text>
            <Text style={[liveSheetStyles.subtitle, { marginBottom: 8 }]}>
              {t('live.colabSubtitle') || 'Aceitar coloca a pessoa ao vivo com você (tipo TikTok colab).'}
            </Text>
            {joinRequests.length === 0 ? (
              <Text style={liveSheetStyles.subtitle}>{t('live.noRequests') || 'Sem pedidos no momento'}</Text>
            ) : (
              <FlatList
                data={joinRequests}
                keyExtractor={(item) => item.email}
                renderItem={({ item }) => (
                  <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' }}>
                    <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#7C3AED', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                      <Text style={{ color: '#fff', fontWeight: '700' }}>{(item.name || '?').slice(0, 1).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }} numberOfLines={1}>{item.name}</Text>
                      <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }} numberOfLines={1}>{item.email}</Text>
                    </View>
                    <TouchableOpacity onPress={() => denyJoinRequest(item.email)} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)', marginRight: 8 }} activeOpacity={0.7}>
                      <Text style={{ color: '#fff', fontWeight: '600' }}>{t('common.deny') || 'Recusar'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => approveJoinRequest(item.email)} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, backgroundColor: '#22c55e' }} activeOpacity={0.7}>
                      <Text style={{ color: '#fff', fontWeight: '700' }}>{t('common.approve') || 'Aceitar'}</Text>
                    </TouchableOpacity>
                  </View>
                )}
                style={{ maxHeight: 380 }}
              />
            )}
          </View>
        </View>
      ) : null}

      {/* Invite friends sheet — TikTok-style multi-select contact picker.
          Hits chat_list to pull the host's direct chats, supports live-search
          (case-insensitive), and DMs the live link to each selected contact
          via chatSend in parallel. */}
      {inviteOpen ? (
        <View style={liveSheetStyles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setInviteOpen(false)} />
          <View style={[liveSheetStyles.sheet, { paddingBottom: insets.bottom + 16, maxHeight: '85%' }]}>
            <View style={liveSheetStyles.grabber} />
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <Text style={[liveSheetStyles.title, { flex: 1, marginBottom: 0 }]}>{t('live.inviteFriends') || 'Convidar amigos'}</Text>
              <TouchableOpacity onPress={handleSystemShare} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.08)' }} activeOpacity={0.7}>
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{t('live.shareLink') || 'Compartilhar link'}</Text>
              </TouchableOpacity>
            </View>
            <View style={{ backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 10 }}>
              <TextInput
                value={inviteSearch}
                onChangeText={setInviteSearch}
                placeholder={t('live.searchFriends') || 'Buscar amigos...'}
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={{ color: '#fff', fontSize: 15, padding: 0 }}
                autoCorrect={false}
                autoCapitalize="none"
              />
            </View>
            <FlatList
              data={(() => {
                const q = inviteSearch.trim().toLowerCase();
                if (!q) return inviteContacts;
                return inviteContacts.filter(c => (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q));
              })()}
              keyExtractor={(item) => String(item.id)}
              ListEmptyComponent={(
                <Text style={[liveSheetStyles.subtitle, { textAlign: 'center', paddingVertical: 20 }]}>
                  {inviteLoaded ? (t('live.noContactsFound') || 'Nenhum contato encontrado') : (t('common.loading') || 'Carregando...')}
                </Text>
              )}
              renderItem={({ item }) => {
                const selected = inviteSelected.has(item.id);
                return (
                  <TouchableOpacity
                    onPress={() => setInviteSelected(prev => { const n = new Set(prev); if (n.has(item.id)) n.delete(item.id); else n.add(item.id); return n; })}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' }}
                    activeOpacity={0.7}
                  >
                    <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: '#7C3AED', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                      <Text style={{ color: '#fff', fontWeight: '700' }}>{(item.name || '?').slice(0, 1).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }} numberOfLines={1}>{item.name}</Text>
                      <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }} numberOfLines={1}>{item.email}</Text>
                    </View>
                    <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: selected ? '#7C3AED' : 'rgba(255,255,255,0.3)', backgroundColor: selected ? '#7C3AED' : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                      {selected ? <Text style={{ color: '#fff', fontWeight: '900', fontSize: 12 }}>✓</Text> : null}
                    </View>
                  </TouchableOpacity>
                );
              }}
              style={{ maxHeight: 360 }}
            />
            <TouchableOpacity
              onPress={sendInvites}
              disabled={inviteSelected.size === 0 || inviteSending}
              style={[liveSheetStyles.closeBtn, (inviteSelected.size === 0 || inviteSending) && { opacity: 0.5 }]}
              activeOpacity={0.85}
            >
              <Text style={liveSheetStyles.closeText}>
                {inviteSending ? (t('common.sending') || 'Enviando...') : `${t('live.sendInvite') || 'Enviar convite'}${inviteSelected.size > 0 ? ` (${inviteSelected.size})` : ''}`}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* Effects sheet — shows a status pill on the live confirming sparkles
          mode. Real AR effects require native bindings; this gives the user
          a working toggle while we plan the deeper pipeline. */}
      {effectsOpen ? (
        <View style={liveSheetStyles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setEffectsOpen(false)} />
          <View style={[liveSheetStyles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={liveSheetStyles.grabber} />
            <Text style={liveSheetStyles.title}>{t('live.effects') || 'Efeitos'}</Text>
            <Text style={liveSheetStyles.subtitle}>
              {effectsOn
                ? (t('live.effectsOn') || 'Brilho de partículas ativado — vai aparecer ao redor das suas curtidas')
                : (t('live.effectsOff') || 'Toque pra ativar o brilho de partículas em torno dos corações')}
            </Text>
            <TouchableOpacity
              onPress={() => { setEffectsOn(v => !v); }}
              style={[liveSheetStyles.closeBtn, effectsOn && { backgroundColor: '#facc15' }]}
              activeOpacity={0.85}
            >
              <Text style={[liveSheetStyles.closeText, effectsOn && { color: '#000' }]}>
                {effectsOn ? (t('live.effectsTurnOff') || 'Desativar') : (t('live.effectsTurnOn') || 'Ativar')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* Insights sheet — expanded view of the bottom-left pill. Shows total
          viewers (current + unique-during-run), reactions, and the join feed
          (who came in, in order). Read-only, host-only. */}
      {insightsOpen ? (
        <View style={liveSheetStyles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setInsightsOpen(false)} />
          <View style={[liveSheetStyles.sheet, { paddingBottom: insets.bottom + 16, maxHeight: '75%' }]}>
            <View style={liveSheetStyles.grabber} />
            <Text style={liveSheetStyles.title}>{t('live.insights') || 'Insights'}</Text>

            <View style={styles.insightsStatsRow}>
              <View style={styles.insightsStat}>
                <Text style={styles.insightsStatValue}>{formatViewerCount(viewerCount)}</Text>
                <Text style={styles.insightsStatLabel}>{t('live.watchingNow') || 'Assistindo agora'}</Text>
              </View>
              <View style={styles.insightsStat}>
                <Text style={styles.insightsStatValue}>{formatViewerCount(uniqueViewers)}</Text>
                <Text style={styles.insightsStatLabel}>{t('live.uniqueViewers') || 'Únicos'}</Text>
              </View>
              <View style={styles.insightsStat}>
                <Text style={styles.insightsStatValue}>{formatViewerCount(totalLikes)}</Text>
                <Text style={styles.insightsStatLabel}>{t('live.likes') || 'Curtidas'}</Text>
              </View>
            </View>

            <Text style={[liveSheetStyles.subtitle, { marginTop: 12 }]}>
              {t('live.joinFeedTitle') || 'Quem entrou'}
            </Text>
            {joinFeed.length === 0 ? (
              <Text style={[liveSheetStyles.subtitle, { textAlign: 'center', paddingVertical: 14 }]}>
                {t('live.noJoinsYet') || 'Ninguém entrou ainda'}
              </Text>
            ) : (
              <FlatList
                data={joinFeed}
                keyExtractor={(item, idx) => `${item.email}-${idx}`}
                renderItem={({ item }) => (
                  <View style={styles.insightsJoinRow}>
                    <AvatarCircle name={item.name} email={item.email} size={32} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={styles.insightsJoinName} numberOfLines={1}>{item.name}</Text>
                      <Text style={styles.insightsJoinEmail} numberOfLines={1}>{item.email}</Text>
                    </View>
                  </View>
                )}
                style={{ maxHeight: 320 }}
              />
            )}

            <TouchableOpacity onPress={() => setInsightsOpen(false)} style={liveSheetStyles.closeBtn} activeOpacity={0.85}>
              <Text style={liveSheetStyles.closeText}>{t('common.done') || 'Concluído'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// Bottom-sheet styles shared by the Settings/Filter/Effects sheets. Lifted out
// of the main `styles` object so this round's additions don't bloat the
// existing live-broadcast stylesheet.
const liveSheetStyles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end', zIndex: 60 },
  sheet: { backgroundColor: '#1a1a26', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 8, paddingHorizontal: 18 },
  grabber: { width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', alignSelf: 'center', marginBottom: 12 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 12 },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 14, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomColor: 'rgba(255,255,255,0.06)', borderBottomWidth: 1 },
  rowLabel: { color: '#fff', fontSize: 15, fontWeight: '500' },
  toggle: { width: 42, height: 24, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.18)', padding: 2 },
  toggleOn: { backgroundColor: '#7C3AED' },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  knobOn: { transform: [{ translateX: 18 }] },
  closeBtn: { marginTop: 16, backgroundColor: '#7C3AED', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  closeText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  filterChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'transparent' },
  filterChipActive: { backgroundColor: 'rgba(124,58,237,0.32)', borderColor: '#7C3AED' },
  filterSwatch: { width: 14, height: 14, borderRadius: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  filterLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 13 },
});

// Compact viewer-count formatter — 1234 → "1.2K", 1500000 → "1.5M".
// Mirrors TikTok's count style used in the top viewer pill.
function formatViewerCount(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num % 1_000_000 === 0 ? 0 : 1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(num % 1000 === 0 ? 0 : 1)}K`;
  return String(num);
}

// 4-bar connection-quality indicator. Renders four little bars; the active
// count is derived from quality, and the trailing label translates with i18n.
function ConnectionBars({ quality, t }) {
  const active = quality === 'good' ? 4 : quality === 'medium' ? 3 : 2;
  const label = quality === 'good' ? (t('live.connGood') || 'Boa')
    : quality === 'medium' ? (t('live.connMedium') || 'Média')
    : (t('live.connPoor') || 'Ruim');
  const tint = quality === 'good' ? '#22c55e' : quality === 'medium' ? '#f59e0b' : '#ef4444';
  return (
    <View style={connStyles.wrap}>
      <View style={connStyles.bars}>
        {[0, 1, 2, 3].map(i => (
          <View
            key={i}
            style={[
              connStyles.bar,
              { height: 5 + i * 3, backgroundColor: i < active ? tint : 'rgba(255,255,255,0.25)' },
            ]}
          />
        ))}
      </View>
      <Text style={[connStyles.label, { color: tint }]}>{label}</Text>
    </View>
  );
}

const connStyles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 14,
  },
  bar: {
    width: 3,
    borderRadius: 1.5,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
    backgroundColor: '#000',
  },
  centered: {
    flex: 1,
    backgroundColor: '#0f0f1a',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  nativeIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(220,38,38,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  nativeText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 12,
  },
  nativeSubtext: {
    color: '#6b7280',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 22,
  },
  endedIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  endedText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  endedStats: {
    color: '#6b7280',
    fontSize: 15,
  },
  errorText: {
    color: '#f87171',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 16,
  },
  backBtn: {
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  backBtnText: {
    color: '#94a3b8',
    fontSize: 16,
    fontWeight: '600',
  },

  // Pre-start
  preOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' } : {}),
  },
  preContent: {
    alignItems: 'center',
    width: '85%',
    maxWidth: 380,
  },
  preAvatarWrap: {
    width: 96, height: 96,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
    marginTop: 2,
  },
  preAvatarPulseRing: {
    position: 'absolute',
    width: 96, height: 96, borderRadius: 48,
    borderWidth: 3,
    borderColor: LIVE_RED,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 24px rgba(220,38,38,0.55)',
    } : {}),
  },
  preAvatar: {
    borderRadius: 999,
  },
  preName: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 4,
    letterSpacing: 0.2,
  },
  titleInput: {
    width: '100%',
    height: 54,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 38,
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  preTitleClear: {
    position: 'absolute',
    right: 10, top: 0, bottom: 0,
    justifyContent: 'center',
  },
  preTitleClearCircle: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  startBtnWrap: {
    width: '100%',
    alignItems: 'center',
    ...(Platform.OS === 'web' ? {
      shadowColor: LIVE_RED,
      shadowOffset: { width: 0, height: 0 },
      shadowRadius: 28,
    } : {}),
  },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 60,
    paddingHorizontal: 44,
    borderRadius: 30,
    backgroundColor: LIVE_RED,
    gap: 12,
    minWidth: 220,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 8px 26px rgba(220, 38, 38, 0.55), 0 0 48px rgba(220, 38, 38, 0.22)',
    } : {}),
  },
  startBtnDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#fff',
  },
  startBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  preTip: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 14,
    textAlign: 'center',
    letterSpacing: 0.1,
    maxWidth: 280,
  },
  closeBtn: {
    position: 'absolute',
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
    } : {}),
  },

  // Countdown
  countdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
  },
  countdownText: {
    color: '#fff',
    fontSize: 120,
    fontWeight: '900',
    textShadowColor: LIVE_RED,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 40,
  },

  // Live screen
  videoOffOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0f0f1a',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 2,
  },
  videoOffText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 16,
    marginTop: 16,
    fontWeight: '500',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.25)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' } : {}),
  },
  topLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  topCenter: {
    flex: 1,
    alignItems: 'center',
  },
  durationPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    gap: 6,
  },
  durationDotWrap: {
    width: 10, height: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  durationDotRing: {
    position: 'absolute',
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: LIVE_RED,
  },
  durationDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: LIVE_RED,
  },
  durationText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  titleBar: {
    position: 'absolute',
    top: 100,
    left: 16,
    right: 16,
    zIndex: 8,
  },
  liveTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  closeBtn2: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  // Red end-live CTA — TikTok pattern: a clear red orb with a white square
  // "stop" mark. Far more discoverable than a generic X.
  endLiveBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: LIVE_RED,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 14px rgba(220,38,38,0.65), 0 2px 8px rgba(0,0,0,0.35)',
    } : {}),
  },
  endLiveBtnInner: {
    width: 12, height: 12, borderRadius: 2,
    backgroundColor: '#fff',
  },
  // Host avatar with pulse ring — sits at top-left of the live header.
  hostAvatarWrap: {
    width: 44, height: 44,
    alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  },
  hostAvatarPulseRing: {
    position: 'absolute',
    width: 50, height: 50, borderRadius: 25,
    borderWidth: 2,
    borderColor: LIVE_RED,
  },
  hostAvatarRing: {
    position: 'absolute',
    width: 40, height: 40, borderRadius: 20,
    borderWidth: 2,
    borderColor: LIVE_RED,
  },
  bottomArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  chatOverlay: {
    backgroundColor: 'transparent',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 12,
    backgroundColor: 'rgba(0,0,0,0.25)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' } : {}),
  },
  controlBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  controlBtnActive: {
    backgroundColor: 'rgba(220, 38, 38, 0.6)',
    borderColor: 'rgba(220, 38, 38, 0.3)',
  },
  endBtn: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 24,
    backgroundColor: LIVE_RED,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 12px rgba(220, 38, 38, 0.4)',
    } : {}),
  },
  endBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  heart: {
    position: 'absolute',
    zIndex: 20,
  },
  heartAvatarChip: {
    position: 'absolute',
    right: -10,
    top: -8,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#fff',
    overflow: 'hidden',
    backgroundColor: '#0f0f1a',
  },

  // Top-bar layout polish
  hostMeta: {
    flexDirection: 'column',
    gap: 4,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: LIVE_RED,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: 'flex-start',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 12px rgba(220,38,38,0.55)',
    } : {}),
  },
  liveBadgeDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff',
  },
  liveBadgeText: {
    color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 0.8,
  },
  viewerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  viewerDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: LIVE_RED,
  },
  viewerCountText: {
    color: '#fff', fontSize: 11, fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  viewerWatchText: {
    color: 'rgba(255,255,255,0.75)', fontSize: 10, fontWeight: '600',
  },
  topRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  // Pinned comment
  pinnedWrap: {
    position: 'absolute',
    left: 16, right: 16,
    zIndex: 9,
  },
  pinnedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(124,58,237,0.85)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#fff',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 14px rgba(124,58,237,0.4)',
    } : {}),
  },
  pinnedIconWrap: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  pinnedBody: { flex: 1 },
  pinnedName: {
    color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.3, marginBottom: 1,
    opacity: 0.92,
  },
  pinnedContent: {
    color: '#fff', fontSize: 13, lineHeight: 17, fontWeight: '500',
  },
  pinnedClose: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Right action stack
  rightStack: {
    position: 'absolute',
    right: 12,
    gap: 12,
    alignItems: 'center',
    zIndex: 9,
  },
  rightBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  rightBtnIconEmoji: { fontSize: 18 },

  // Comments column (custom, replaces LiveChat in live screen)
  chatScrollWrap: {
    height: 240,
    position: 'relative',
  },
  commentListContent: {
    paddingHorizontal: 14,
    paddingTop: 24,
    paddingBottom: 6,
  },
  commentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 4,
  },
  commentBubble: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: '88%',
  },
  // Host-authored comment: subtle purple tint + 1px brand border so the
  // host's voice stands out in the rolling feed without screaming.
  commentBubbleHost: {
    backgroundColor: 'rgba(124,58,237,0.32)',
    borderWidth: 1,
    borderColor: 'rgba(168,85,247,0.55)',
  },
  commentNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 1,
  },
  commentName: {
    color: '#a78bfa', fontSize: 11, fontWeight: '800', letterSpacing: 0.3,
  },
  commentHostTag: {
    color: '#f59e0b', fontSize: 10, fontWeight: '700',
  },
  commentHostChip: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  commentHostChipText: {
    color: '#000', fontSize: 9, fontWeight: '900', letterSpacing: 0.5,
  },
  commentText: {
    color: '#fff', fontSize: 13, lineHeight: 17,
  },
  commentSystem: {
    paddingVertical: 4, alignItems: 'flex-start',
  },
  commentSystemText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    fontStyle: 'italic',
    letterSpacing: 0.2,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 8,
  },
  chatTopFade: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 60,
    ...(Platform.OS === 'web' ? {
      background: 'linear-gradient(to bottom, rgba(0,0,0,0.55), transparent)',
    } : {
      backgroundColor: 'transparent', // RN can't do gradients without lib; stays transparent on native
    }),
    pointerEvents: 'none',
  },

  // Composer row
  composerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  invitePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#7C3AED',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 22,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 12px rgba(124,58,237,0.45)',
    } : {}),
  },
  invitePillText: {
    color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 0.2,
    maxWidth: 120,
  },
  composerInputWrap: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingLeft: 14,
    paddingRight: 4,
  },
  composerInput: {
    flex: 1,
    height: 40,
    color: '#fff',
    fontSize: 14,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  composerSendBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#7C3AED',
    alignItems: 'center', justifyContent: 'center',
  },
  composerIconBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  composerIconBtnActive: {
    backgroundColor: 'rgba(220,38,38,0.7)',
    borderColor: 'rgba(220,38,38,0.4)',
  },
  heartBtn: {
    backgroundColor: 'rgba(220,38,38,0.65)',
    borderColor: 'rgba(220,38,38,0.4)',
  },

  // End-Live confirmation modal
  endModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 100,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' } : {}),
  },
  endModalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#1a1a26',
    borderRadius: 22,
    padding: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
    } : {}),
  },
  endModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 6,
  },
  endModalLiveDot: {
    width: 10, height: 10, borderRadius: 5, backgroundColor: LIVE_RED,
  },
  endModalTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
  },
  endModalSubtitle: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 18,
  },
  endModalStats: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(124,58,237,0.12)',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 8,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(124,58,237,0.25)',
  },
  endModalStat: {
    flex: 1,
    alignItems: 'center',
  },
  endModalStatValue: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    marginBottom: 2,
  },
  endModalStatLabel: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  endModalStatDivider: {
    width: 1,
    height: 30,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  endModalToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 18,
    gap: 12,
  },
  endModalToggleLabelWrap: { flex: 1 },
  endModalToggleLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  endModalToggleHint: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
  },
  endModalToggle: {
    width: 44, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.15)',
    padding: 3,
    justifyContent: 'center',
  },
  endModalToggleOn: {
    backgroundColor: '#7C3AED',
  },
  endModalToggleKnob: {
    width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff',
  },
  endModalToggleKnobOn: {
    transform: [{ translateX: 18 }],
  },
  endModalActions: {
    flexDirection: 'row',
    gap: 10,
  },
  endModalCancel: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  endModalCancelText: {
    color: '#fff', fontSize: 14, fontWeight: '700',
  },
  endModalConfirm: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 14,
    backgroundColor: LIVE_RED,
    alignItems: 'center',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 16px rgba(220,38,38,0.45)',
    } : {}),
  },
  endModalConfirmText: {
    color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 0.3,
  },

  // ----- Pre-live hero card -----
  // Glass card sitting on top of the brand-purple radial glow. The card hosts
  // avatar + hint + title input + audience pills + CTA + tip line — full
  // Instagram-Live grade pre-roll surface.
  preHero: {
    width: '88%',
    maxWidth: 400,
    alignItems: 'center',
    backgroundColor: 'rgba(20,20,30,0.62)',
    borderRadius: 26,
    paddingVertical: 24,
    paddingHorizontal: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(22px) saturate(140%)', WebkitBackdropFilter: 'blur(22px) saturate(140%)',
      boxShadow: '0 24px 60px rgba(0,0,0,0.6), 0 0 1px rgba(168,85,247,0.55)',
    } : {}),
  },
  preHint: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    fontWeight: '500',
    fontStyle: 'italic',
    letterSpacing: 0.1,
    marginTop: 0,
    marginBottom: 18,
  },
  // Radial brand glows sitting behind the card. We can't do a real radial
  // gradient w/o expo-linear-gradient, so we fake it with two huge circles —
  // purple bottom, red top-right — at very low alpha for that "live energy"
  // ambient lighting (Instagram Live signature).
  preGlowPurple: {
    position: 'absolute',
    width: 520, height: 520,
    borderRadius: 260,
    backgroundColor: 'rgba(124,58,237,0.35)',
    bottom: -200,
    alignSelf: 'center',
    ...(Platform.OS === 'web' ? {
      filter: 'blur(80px)', WebkitFilter: 'blur(80px)',
    } : { opacity: 0.5 }),
  },
  preGlowRed: {
    position: 'absolute',
    width: 320, height: 320,
    borderRadius: 160,
    backgroundColor: 'rgba(220,38,38,0.22)',
    top: -100, right: -80,
    ...(Platform.OS === 'web' ? {
      filter: 'blur(70px)', WebkitFilter: 'blur(70px)',
    } : { opacity: 0.45 }),
  },
  preTitleWrap: {
    width: '100%',
    position: 'relative',
    marginBottom: 16,
  },
  preTitleSparkle: {
    position: 'absolute',
    right: 14, top: 0, bottom: 0,
    justifyContent: 'center',
  },
  preAudRow: {
    width: '100%',
    marginBottom: 20,
    alignItems: 'center',
  },
  preAudLabel: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  preAudPills: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
  },
  preAudPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  preAudPillActive: {
    backgroundColor: 'rgba(124,58,237,0.55)',
    borderColor: 'rgba(168,85,247,0.85)',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 14px rgba(124,58,237,0.4)',
    } : {}),
  },
  preAudPillText: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  preFlipBtn: {
    position: 'absolute',
    left: 20,
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center',
    zIndex: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },

  // ----- Live insights pill (bottom-left compact stats chip) -----
  insightsPill: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    zIndex: 9,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' } : {}),
  },
  insightsPillText: {
    color: '#fff', fontSize: 12, fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  insightsPillDot: {
    width: 3, height: 3, borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.35)',
    marginHorizontal: 2,
  },
  insightsStatsRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(124,58,237,0.12)',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: 'rgba(124,58,237,0.25)',
    marginTop: 4,
  },
  insightsStat: { flex: 1, alignItems: 'center' },
  insightsStatValue: {
    color: '#fff', fontSize: 20, fontWeight: '800',
    fontVariant: ['tabular-nums'], marginBottom: 2,
  },
  insightsStatLabel: {
    color: 'rgba(255,255,255,0.55)', fontSize: 10,
    fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase',
  },
  insightsJoinRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10,
    borderBottomColor: 'rgba(255,255,255,0.06)', borderBottomWidth: 1,
  },
  insightsJoinName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  insightsJoinEmail: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 1 },

  // ----- End-state rich card -----
  endCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#1a1a26',
    borderRadius: 24,
    padding: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 24px 70px rgba(0,0,0,0.7), 0 0 1px rgba(168,85,247,0.5)',
    } : {}),
  },
  endCardHero: {
    alignItems: 'center',
    paddingVertical: 8,
    marginBottom: 18,
  },
  endCardIcon: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: LIVE_RED,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 12,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 6px 22px rgba(220,38,38,0.45)',
    } : {}),
  },
  endCardTitle: {
    color: '#fff', fontSize: 22, fontWeight: '800', letterSpacing: 0.2,
    marginBottom: 4,
  },
  endCardSubtitle: {
    color: 'rgba(255,255,255,0.55)', fontSize: 13, lineHeight: 17,
    textAlign: 'center',
    maxWidth: 280,
  },
  endCardStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(124,58,237,0.12)',
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 8,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: 'rgba(124,58,237,0.25)',
  },
  endCardStat: { flex: 1, alignItems: 'center' },
  endCardStatValue: {
    color: '#fff', fontSize: 20, fontWeight: '800',
    fontVariant: ['tabular-nums'], marginBottom: 2,
  },
  endCardStatLabel: {
    color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: '600',
    letterSpacing: 0.3, textTransform: 'uppercase',
  },
  endCardStatSep: { width: 1, height: 30, backgroundColor: 'rgba(255,255,255,0.12)' },
  endCardCtaRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  endCardCtaSecondary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
  },
  endCardCtaSecondaryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  endCardCtaPrimary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 14,
    backgroundColor: '#facc15',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 18px rgba(250,204,21,0.4)',
    } : {}),
  },
  endCardCtaPrimaryOff: {
    backgroundColor: 'rgba(124,58,237,0.85)',
  },
  endCardCtaPrimaryText: { color: '#000', fontSize: 14, fontWeight: '800', letterSpacing: 0.2 },
  endCardDone: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  endCardDoneText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    fontWeight: '600',
  },
  endCardSeeReplays: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(124,58,237,0.85)',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 14,
    marginTop: 10,
    marginHorizontal: 4,
  },
  endCardSeeReplaysText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});
