import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated,
  Alert, TextInput, Dimensions, StatusBar, FlatList, Keyboard,
  ActionSheetIOS, Modal, ScrollView, DeviceEventEmitter,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import LiveChat from '../components/LiveChat'; // eslint-disable-line no-unused-vars -- kept for fallback
import LiveChatOverlay from '../components/live/LiveChatOverlay';
import AvatarCircle from '../components/AvatarCircle';
import { IconX, IconCameraFlip, IconMic, IconMicOff, IconVideo, IconVideoOff, IconHeart, IconShare, IconSend, IconSettings, IconUserPlus, IconSparkles, IconFilter, IconPin, IconStar, IconStarFilled, IconGlobe, IconLock, IconUsers, IconEye, IconStop, IconCheck, IconBookmark, IconChevronRight, IconChevronDown, IconBarChart, IconBrush, IconBookmarkFilled } from '../components/Icons';
import { useTheme } from '../context/ThemeContext';
import AnimatedViewerCount from '../components/AnimatedViewerCount';
import LiveTopGifters from '../components/LiveTopGifters';
import LiveGiftAnimation from '../components/LiveGiftAnimation';
import LivePollOverlay from '../components/live/LivePollOverlay';
import * as liveBroadcastNotification from '../services/liveBroadcastNotification';
import { publishToCfStream } from '../services/cfStreamPublisher';
import * as Haptics from 'expo-haptics';
// Round 67 #1158 (2026-05-18) — user: "a tela ainda desliga mesmo
// rolando a live". expo-keep-awake holds the OS display awake while
// the host is broadcasting. Module is JS-side autolinked; the native
// counterpart was already in build 442 (transitive expo dep) so no
// rebuild needed for OTA delivery. The tag scopes the activation to
// the live-broadcast screen — unmounting auto-releases.
import { useKeepAwake } from 'expo-keep-awake';

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
// Brand-tinted heart palette — must mirror live-viewer's HEART_COLORS so the
// color the viewer picks at tap-time renders identically on the host screen.
// Brand spec: hot pinks + magentas + danger red (no orange/gold — gold is
// reserved for the gift chip).
const HEART_COLORS = ['#ff4d6d', '#ff7eb9', '#ff006e', '#c70039', '#ef4444'];

export default function LiveBroadcastScreen() {
  // Round 67 #1158 (2026-05-18) — keep the display on for the entire
  // host session. Tag scopes the lock so multi-screen mounts don't
  // collide. Unmount auto-releases via expo-keep-awake's effect.
  useKeepAwake('live-broadcast');

  const params = useLocalSearchParams();
  const router = useRouter();
  // Round 69 #1166 (2026-05-19) — Gate the local NativeRTCView mount on
  // route focus. Expo Router's `presentation: 'fullScreenModal'` in
  // _layout.js:1273 keeps the previous screen mounted underneath the live
  // broadcast. If that screen also has an active NativeRTCView bound to
  // the same local camera (chat-conversation call preview, /call route,
  // IncomingCallListener), iOS mounts TWO RTCMTLVideoView instances —
  // each with its own crop of the same RTCVideoTrack at different
  // container heights → two-faces-with-dark-gap (the "barra preta" bug).
  // useIsFocused() returns false while another screen owns focus, so we
  // skip the RTCView mount entirely until live-broadcast is the active
  // route — guarantees only one RTCView for the local camera, ever.
  const isFocused = useIsFocused();
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
  // Category — 1 of 8 server-defined categories (gaming/music/chat/food/travel
  // /tech/sports/learning). Sent to liveStart so the discover page can filter
  // on it. Empty string = unspecified ("Geral").
  const [liveCategory, setLiveCategory] = useState('');
  // Subscriber-only gate — when true, only viewers with an active subscription
  // to the host can join. Backend enforces in live_discover + live_join.
  const [subscribersOnly, setSubscribersOnly] = useState(false);
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
  // Right rail collapsed by default — user feedback 2026-05-18: "painel de
  // efeitos do lado direito aparece feio e bagunçado". Now the rail shows
  // only the heart counter + a single chevron; tap chevron to expand the
  // full action stack (settings/effects/filter/AR/replay/pin/poll/flip).
  const [rightStackOpen, setRightStackOpen] = useState(false);

  // ─── AR / Beauty / Greenscreen filter carousel (wave 16, 2026-05-17) ───
  // The native LiveHostViewController (iOS) and LiveHostActivity (Android)
  // own the actual MediaPipe pipeline; JS just owns the carousel UI and the
  // selected preset key, which gets handed to the native module on entry.
  // Presets (8): none | dog | sunglasses | hearts | beauty | slim | blur |
  // greenscreen (with sub-pick `wallpaperId` 1..6 for greenscreen backgrounds).
  // `activeARFilter` is the currently-applied preset key.
  const [activeARFilter, setActiveARFilter] = useState('none');
  const [arWallpaper, setArWallpaper] = useState(1); // greenscreen background 1..6
  const [arCarouselOpen, setArCarouselOpen] = useState(false);

  // ─── Multistream destinations (wave 16, 2026-05-17) ───
  // Host configures RTMP fan-out targets (YouTube/Twitch/Facebook). Persisted
  // in chat_live_multistream_destinations. Active list shown as "🔴 Transmitindo
  // para N destinos" pill once the live is hot.
  const [multistreamOpen, setMultistreamOpen] = useState(false);
  const [multistreamDests, setMultistreamDests] = useState([]); // [{id, rtmp_url, label, status}]
  const [multistreamForm, setMultistreamForm] = useState({ rtmpUrl: '', streamKey: '', label: '' });
  const [multistreamSaving, setMultistreamSaving] = useState(false);

  // ─── Schedule live (wave 16, 2026-05-17) ───
  // Pre-screen modal — pick date/time, persists to chat_live_scheduled.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState(() => {
    // Default to "tomorrow 19:00 local" — same default Instagram uses.
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(19, 0, 0, 0);
    return d;
  });
  const [scheduleSaving, setScheduleSaving] = useState(false);

  const [hideChat, setHideChat] = useState(false);
  const [muteReactions, setMuteReactions] = useState(false);
  // Slow-mode (host moderation). 0 = disabled, otherwise N seconds the
  // viewers must wait between comments. Mirror to ref so the WS+API
  // success handlers can read it without re-renders.
  const [slowModeSeconds, setSlowModeSeconds] = useState(0);
  const [slowModeOpenAndroid, setSlowModeOpenAndroid] = useState(false);
  // Live poll state (host creates from bottom bar). `activePoll` is the
  // current poll being displayed to host + viewers; `pollDraft` is the
  // in-progress creation form. Backend pushes WS `live_poll_*` events.
  const [activePoll, setActivePoll] = useState(null); // { id, question, options:[{text, votes}], total_votes, closed }
  const [pollDraftOpen, setPollDraftOpen] = useState(false);
  const [pollDraftQuestion, setPollDraftQuestion] = useState('');
  const [pollDraftOptions, setPollDraftOptions] = useState(['', '']);
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

  // ─── Cloudflare Stream WHIP publisher (2026-05-18) ───
  // When the host enables "Salvar live", we route the broadcast through
  // CF Stream instead of the legacy P2P path so the recording lands as a
  // managed VOD (HLS + MP4). `cfPublisherRef` holds the negotiated
  // RTCPeerConnection so `performEndLive` can close it cleanly. `cfModeRef`
  // is a boolean mirror of "did we publish to CF this session" so the end
  // path can decide between live_end (legacy) and live_end_cf (CF) without
  // re-reading saveReplay (which could have changed mid-session).
  const cfPublisherRef = useRef(null);
  const cfModeRef = useRef(false);
  const cfIngestRef = useRef(null); // { cf_input_uid, hls_url, rtmps_url, rtmps_key }
  // Single-flight gate for handleStartLive — without this a double-tap
  // (or a re-render that immediately re-fires the press) calls live_start
  // twice in <1s, creating TWO chat_live_sessions rows. The host's UI only
  // tracks the SECOND session id; the FIRST sits stuck on status='live'
  // until the 5-min/6-h auto-end heuristic kills it. During that window
  // live_list returns the ghost session, lighting AO VIVO on the host's
  // profile long after the host thinks they're done (bug #1133).
  const startingRef = useRef(false);

  // Stage 3 of #929 — host subscribes to LK room `live_{sessionId}` so
  // any approved cohort publishing into it can be rendered alongside the
  // host's primary stream. We don't republish here (host's own camera
  // stays on raw WebRTC for back-compat with viewers that aren't on the
  // LK path yet). Subscribe-only token from `chat_live_host_lk_token`.
  const cohostRoomRef = useRef(null); // livekit-client Room
  const [cohostParticipants, setCohostParticipants] = useState([]); // [{ identity, name, videoTrack }]
  const cohostConnectingRef = useRef(false);

  // Animations
  const countdownScale = useRef(new Animated.Value(0)).current;
  const countdownOpacity = useRef(new Animated.Value(0)).current;
  const prevViewerCount = useRef(0);
  const viewerBounce = useRef(new Animated.Value(1)).current;
  // Top-gifters refresh trigger — bump on every live_gift event so the
  // LiveTopGifters component refetches (also has 30s self-poll fallback).
  const [giftRefreshKey, setGiftRefreshKey] = useState(0);
  // Active gift animation overlay (center-screen card). One at a time —
  // overlapping animations would clutter; subsequent gifts queue via
  // pendingGiftsRef and drain after the current one completes.
  const [activeGiftAnim, setActiveGiftAnim] = useState(null);
  const pendingGiftsRef = useRef([]);
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
  // Round 68 #1157 (2026-05-18) — bumped on every stream URL change and on
  // every camera-flip so the underlying RTCMTLVideoView (iOS) /
  // SurfaceView (Android) is recreated cleanly. The previous `key={localStreamUrl}`
  // wasn't enough: `stream.toURL()` returns the SAME URL after _switchCamera
  // (and even sometimes across re-acquires), so React reused the native view
  // and the iOS GPU texture cache exhibited a half-frame split (top half:
  // stale buffered frame, bottom half: current frame — exactly the "barra
  // preta horizontal" complaint, 4 reports running). Combined with the
  // state-backed `mirror` below + fully numeric absoluteFill below, this
  // resets the native renderer surface every time the source mutates.
  const [videoEpoch, setVideoEpoch] = useState(0);
  // Mirror prop must be STATE (not just ref) so the `mirror={...}` prop on
  // NativeRTCView changes trigger a re-render. Before, the ref-only path
  // left the underlying view with a stale transform flag even after camera
  // flip, which on some iOS bridges also contributes to the half/half
  // ghost stack.
  const [mirrorOn, setMirrorOn] = useState(true);

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
      setMirrorOn(preFacing === 'user');
      // [#1205 live muting fix, 2026-05-19] Wipe any leaked voice-call
      // audio mode/session left by a previous call before opening the mic.
      // Without this, Android stuck in MODE_IN_COMMUNICATION / iOS pinned
      // to `.voiceChat` routes the mic through voice-call AEC which assumes
      // a far-end reference exists. Live broadcast is one-way, so AEC
      // adaptive gain converges to near-silence within ~5s → "ficando muda".
      // Best-effort: no-op if the module isn't loaded (web), or if the call
      // returns false (which just means audio state was already clean).
      if (Platform.OS !== 'web') {
        try {
          const callkit = require('../modules/expo-callkit');
          if (typeof callkit.prepareAudioForLive === 'function') {
            callkit.prepareAudioForLive();
          }
        } catch (e) {
          console.warn('[Live] prepareAudioForLive failed:', e?.message || e);
        }
      }
      // Explicit audio constraints so we don't inherit voice-call DSP. AEC
      // is OFF (live is one-way send — there's no far-end to cancel). NS
      // stays ON (kills room noise without harming voice). AGC stays ON
      // (matches IG/TikTok live). Web honors these as MediaTrackConstraints.
      const audioConstraints = {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      };
      const stream = await getUserMediaFn({ video: { facingMode: preFacing }, audio: audioConstraints });
      localStreamRef.current = stream;
      if (Platform.OS === 'web') {
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      } else {
        if (stream?.toURL) setLocalStreamUrl(stream.toURL());
        // Round 68 #1157 — bump the epoch on initial stream acquisition so
        // the very first NativeRTCView mount is keyed to a unique value
        // (some iOS bridges hold onto a recycled surface from a previous
        // mount of /live-broadcast that left a stale buffer in the GPU
        // texture cache — split-face on first frame).
        setVideoEpoch(e => e + 1);
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
          // Ack watchdog — if WS server doesn't echo live_started, the
          // subscribe never happened. Surface the error instead of waiting forever.
          //
          // [WAVE 36 2026-05-20] User print 3: full-screen "Sem resposta do
          // servidor" 5s after Go Live. Root cause: 5s is WAY too tight for
          // live boot — backend live_start PG insert + WS channel subscribe
          // + LiveKit publish can easily take 10-15s on cellular. WhatsApp/
          // Instagram both give live-start ~30s. Bumped to 30s + we already
          // race liveStart/liveStartCf inside handleStartLive (see Wave 34),
          // so the user only sees this error when BOTH paths timed out AND
          // the channel subscribe never landed — meaning the WS is genuinely
          // dead. Also surface a more helpful message if NetInfo says we're
          // online (it's a backend issue, not their wifi).
          if (liveStartedAckTimeoutRef.current) clearTimeout(liveStartedAckTimeoutRef.current);
          liveStartedAckTimeoutRef.current = setTimeout(async () => {
            if (!liveStartedAckRef.current && !endedRef.current) {
              console.error('[Live] live_started ack timeout (30s) — WS subscribe failed');
              // NetInfo probe — if user has wifi/data, the backend is busy.
              // Otherwise generic "no response" is fine. Soft-import so a
              // missing dep on web doesn't crash the watchdog.
              let isConnected = true;
              try {
                const NetInfoMod = require('@react-native-community/netinfo');
                const NI = NetInfoMod?.default || NetInfoMod;
                if (NI?.fetch) {
                  const s = await NI.fetch();
                  isConnected = !!s?.isConnected;
                }
              } catch {}
              if (isConnected) {
                setError(t('live.serverBusy') || 'Servidor ocupado. Tente novamente em alguns segundos.');
              } else {
                setError(t('live.startTimeout') || 'Sem resposta do servidor');
              }
              // Reject the waiter so handleStartLive can bail out instead of
              // staring at a black countdown screen (Codex #3).
              try { liveStartedWaiterRef.current?.reject?.(new Error('live_started timeout')); } catch {}
              liveStartedWaiterRef.current = null;
            }
          }, 30000);
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
            // Tap-spam adds: msg.x (normalized 0..1) for column placement,
            // msg.color (hex) for per-viewer brand tint. Falls back to the
            // legacy right-rail spawn when the sender didn't include them.
            spawnHeart({
              name: msg.reactor_name || msg.name || msg.reactor_email?.split('@')[0] || msg.email?.split('@')[0],
              email: msg.reactor_email || msg.email,
              x: (typeof msg.x === 'number' && isFinite(msg.x)) ? msg.x : null,
              color: (typeof msg.color === 'string') ? msg.color : null,
            });
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
            // Tick the ongoing broadcast notification body so the system
            // shade always reflects the current audience size. No-op when
            // notification was never started (no session id).
            if (sessionIdRef.current) {
              try { liveBroadcastNotification.updateViewers(sessionIdRef.current, msg.count); } catch {}
            }
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
          // Render a golden gift chip inline in the comment overlay AND
          // trigger the center-screen LiveGiftAnimation overlay. Bump the
          // top-gifters refresh key so the leaderboard rolls up in near-
          // real-time (component will refetch /chat_live_top_gifters).
          {
            const entry = new Animated.Value(0);
            appendChatMessage({
              id: 'gift_' + String(++chatIdRef.current),
              name: msg.sender_name || (msg.sender_email || '').split('@')[0] || '?',
              email: msg.sender_email,
              type: 'gift',
              gift: msg.gift_type || msg.gift,
              amount: msg.diamonds || msg.amount || 1,
              giftLabel: (msg.gift_type || msg.gift) ? ((t('live.sentGift') || 'enviou') + ' ' + (msg.gift_type || msg.gift)) : (t('live.sentGift') || 'enviou um presente'),
              entry,
            });
            Animated.spring(entry, { toValue: 1, friction: 6, tension: 120, useNativeDriver: true }).start();

            const giftEvent = {
              key: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
              sender_email: msg.sender_email,
              sender_name: msg.sender_name,
              sender_avatar: msg.sender_avatar,
              gift_type: msg.gift_type || msg.gift,
              diamonds: msg.diamonds || msg.amount || 1,
            };
            // Queue if another animation is running so they don't overlap.
            setActiveGiftAnim(prev => {
              if (prev) {
                pendingGiftsRef.current.push(giftEvent);
                return prev;
              }
              return giftEvent;
            });
            setGiftRefreshKey(k => k + 1);
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
        case 'live_join_request': {
          // Viewer wants to come on as a guest (TikTok-style colab — host
          // accepts, both go split-screen). Stack the request and surface
          // a prominent prompt: auto-open the requests sheet so the host
          // can't miss it while filming. Without the auto-open the chip
          // top-right was easy to ignore and user complained the system
          // "didn't work" — they never noticed the chip.
          //
          // Round 67 #1158 (2026-05-18) — payload shape depends on the
          // delivery path. Legacy raw-WS Node path delivered flat
          // (`msg.viewer_email`) but that path is now dead. The active
          // delivery is REST `chat_live_cohost_request` → /broadcast
          // which wraps as `{type, data:{viewer_email,...}}` (see Go
          // main.go handleBroadcast at line ~2985). Read from both
          // shapes so the host UI works regardless of which transport
          // wins the race.
          const reqData = msg.data || msg;
          const viewerEmail = msg.viewer_email || reqData?.viewer_email;
          const viewerName = msg.viewer_name || reqData?.viewer_name;
          if (viewerEmail) {
            setJoinRequests(prev => {
              if (prev.some(r => r.email === viewerEmail)) return prev;
              return [{ email: viewerEmail, name: viewerName || viewerEmail.split('@')[0], ts: Date.now() }, ...prev].slice(0, 30);
            });
            // Strong buzz so host feels it on cheek/hand mid-stream.
            try { require('react-native').Vibration.vibrate([0, 80, 60, 80]); } catch {}
            // Auto-open the sheet so accept/deny is one tap away.
            setRequestsOpen(true);
          }
          break;
        }
        case 'live_pin_comment':
          // Backend persisted-pin WS echo. Keep local pinnedComment in sync
          // so the host UI matches what viewers see. Empty content = unpin.
          if (msg.comment_text) {
            setPinnedComment({
              name: msg.comment_author_name || '?',
              content: String(msg.comment_text),
            });
          } else {
            setPinnedComment(null);
          }
          break;
        case 'live_viewer_kicked':
          // Server echo of our own ban call — drop the email from local
          // viewer feeds so the insights list doesn't re-show them.
          if (msg.viewer_email) {
            try { setJoinFeed(prev => prev.filter(j => j.email !== msg.viewer_email)); } catch {}
          }
          break;
        case 'live_poll_created':
          if (msg.poll || msg.poll_id) {
            const poll = msg.poll || {
              id: msg.poll_id,
              question: msg.question,
              options: (msg.options || []).map(o => typeof o === 'string'
                ? { text: o, votes: 0 }
                : { text: o.text || '', votes: Number(o.votes) || 0 }),
              total_votes: Number(msg.total_votes) || 0,
              closed: false,
            };
            setActivePoll(poll);
          }
          break;
        case 'live_poll_voted':
          if (msg.poll_id) {
            setActivePoll(prev => {
              if (!prev || String(prev.id) !== String(msg.poll_id)) return prev;
              const incoming = Array.isArray(msg.options) ? msg.options : null;
              if (!incoming) return prev;
              const next = prev.options.map((o, i) => ({
                ...o,
                votes: typeof incoming[i] === 'object'
                  ? (Number(incoming[i].votes) || 0)
                  : (Number(incoming[i]) || 0),
              }));
              const total = typeof msg.total_votes === 'number'
                ? msg.total_votes
                : next.reduce((s, o) => s + (o.votes || 0), 0);
              return { ...prev, options: next, total_votes: total };
            });
          }
          break;
        case 'live_poll_closed':
          if (msg.poll_id) {
            setActivePoll(prev => (prev && String(prev.id) === String(msg.poll_id))
              ? { ...prev, closed: true }
              : prev);
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
  // float with a tiny avatar chip beside it (Instagram parity). Tap-spam
  // path additionally carries `x` (0..1 normalized to viewer's screen) and
  // `color` (hex) so the host sees hearts in the same horizontal column +
  // brand tint the viewer chose.
  const spawnHeart = useCallback((reactor = null) => {
    setTotalLikes(c => c + 1);
    const id = ++heartIdRef.current;
    // Map remote normalized X back to local pixels. Fallback: legacy
    // right-rail spawn so hearts from clients that don't pass x still land
    // somewhere visible.
    const hasX = reactor && typeof reactor.x === 'number' && isFinite(reactor.x);
    const x = hasX
      ? Math.max(8, Math.min(SCREEN_W - 8, reactor.x * SCREEN_W))
      : (SCREEN_W - 60 + (Math.random() - 0.5) * 40);
    const y = SCREEN_H * 0.55;
    const anim = new Animated.Value(0);
    // Per-heart color — viewer's choice if they sent one, otherwise pick
    // randomly from the brand palette so consecutive taps from the host's
    // own self-tap don't all clone-stamp the same red.
    const color = (reactor && typeof reactor.color === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(reactor.color))
      ? reactor.color
      : HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)];
    // Random horizontal drift cached on the heart object so the render
    // reads a stable value (instead of re-randomizing every frame via
    // `Math.random()` inside the interpolation, which is what the old
    // code did and produced jittery non-deterministic trails).
    const drift = (Math.random() - 0.5) * 80;

    setHearts(prev => {
      const next = [...prev, { id, x, y, anim, reactor, color, drift }];
      if (next.length > MAX_HEARTS) return next.slice(-MAX_HEARTS);
      return next;
    });

    Animated.timing(anim, {
      toValue: 1,
      duration: 1800 + Math.floor(Math.random() * 400),
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
    //
    // Bug #978-2 fix — bump the displayed count immediately on every viewer
    // join so the host UI never sticks at 0 waiting for the (sometimes
    // dropped) `live_viewer_count` packet. We take the MAX of (current WS
    // count, peers map size) so the bump never under-reports.
    {
      const localCount = Math.max(viewerCountRef.current || 0, peersRef.current?.size || 0);
      if (localCount !== viewerCountRef.current) {
        viewerCountRef.current = localCount;
        setViewerCount(localCount);
      }
    }

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
            // Persist via API so late-joining viewers can read the pin on
            // their live_join response. Fail-graceful — WS broadcast above
            // already covers the in-session viewers.
            if (sessionIdRef.current) {
              api.chatLivePinComment(sessionIdRef.current, pinContent, m.name || '').catch(() => {});
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
    // Single-flight guard — see startingRef declaration for the ghost-session
    // bug this prevents. The flag is released on success (in the catch +
    // success terminus below) so the host can retry after a failed start.
    if (startingRef.current) return;
    if (sessionIdRef.current) return; // already live
    startingRef.current = true;
    try {
      // [WAVE 37 2026-05-20] NetInfo gate BEFORE any backend call — if the
      // device has no connectivity, surface that clearly instead of letting
      // fetch hang for 25s and reporting "Connection failed". Many of the
      // "erro ao iniciar" reports came from emulators / lab phones where
      // NetInfo briefly reports offline; without this gate the user saw a
      // generic timeout message after waiting 30+ seconds.
      try {
        const NetInfoMod = require('@react-native-community/netinfo');
        const NI = NetInfoMod?.default || NetInfoMod;
        const st = await Promise.race([
          (NI?.fetch ? NI.fetch() : Promise.resolve({ isConnected: true })),
          new Promise((res) => setTimeout(() => res({ isConnected: true }), 1500)),
        ]);
        if (st && st.isConnected === false) {
          setError(t('live.noConnection') || t('errors.noConnection') || 'Sem conexão com a internet');
          startingRef.current = false;
          return;
        }
      } catch {}
      // Ask for camera + mic only now — the user actively tapped Go Live.
      const ok = await ensureCameraStream();
      if (!ok) { startingRef.current = false; return; }
      // When the host opted into "Salvar live" we go through the Cloudflare
      // Stream pipeline (live_start_cf → WHIP publish → live_end_cf) so the
      // recording lands as a managed VOD. Otherwise we keep the legacy P2P
      // path (no recording) for full back-compat with the existing viewer
      // join flow. cfModeRef is the single source of truth for the rest of
      // the lifecycle (end path picks live_end vs live_end_cf accordingly).
      const wantsCf = !!saveReplay;
      cfModeRef.current = wantsCf;
      const liveTitle = titleInput.trim() || t('live.title') || 'Live';
      // [WAVE 34 2026-05-20] User report: "erro ao conectar ao servidor".
      // Backend's live_start returns 200 with session_id; live_start_cf is
      // the Cloudflare path. The old code committed to one or the other up
      // front based on `saveReplay`. When liveStart succeeded `{success:1}`
      // but didn't surface a session_id (rare edge: PG insert race, stale
      // cache hit), the host saw the generic "Connection failed" with no
      // hint to retry. Fix: try the chosen endpoint; if it returns success
      // without session_id OR returns success:false with a transient
      // message, fall back to the other endpoint before surfacing the
      // error. This kept legacy P2P working as a safety net for the CF
      // pipeline rollout, and now does the symmetric job in the other
      // direction too.
      // [WAVE 36 2026-05-20] When the user picked P2P (default — wantsCf=false),
      // race the legacy live_start against the CF fallback after a 7s head-
      // start. Backend's live_start CAN hang on PG hot-row lock or rate-limit
      // checks for 10-20s, which used to dump the user into the "Sem resposta
      // do servidor" screen with no recovery. By starting live_start_cf in
      // parallel after 7s and racing, we cover the slow-backend case while
      // keeping live_start as the preferred (cheaper, faster) path.
      let res;
      let sid;
      if (wantsCf) {
        res = await api.liveStartCf(liveTitle, { audience, category: liveCategory, subscribersOnly });
        sid = res.data?.session_id || res.data?.session?.id;
      } else {
        // [WAVE 37 2026-05-20] User report: "live ta dando erro ao iniciar".
        // Previously we gave live_start a 7s head start before kicking off
        // live_start_cf, which still left users staring at a spinner when
        // P2P backend was slow but not dead. Now both endpoints race from
        // t=0 — the FIRST one to return a valid session_id wins. CF costs
        // a little more (creates a CF input that may be dropped) but
        // recovers instantly from any P2P-only stall.
        const primary = api.liveStart(liveTitle, { audience, category: liveCategory, subscribersOnly });
        const cf = api.liveStartCf(liveTitle, { audience, category: liveCategory, subscribersOnly });
        const wrapWithMode = (p, mode) => p.then((r) => ({ r, mode })).catch((e) => ({ r: null, mode, err: e }));
        const primaryWrapped = wrapWithMode(primary, 'p2p');
        const cfWrapped = wrapWithMode(cf, 'cf');
        const pickIfSuccess = (x) => (x?.r?.success && (x.r.data?.session_id || x.r.data?.session?.id)) ? x : null;
        try {
          // Each promise resolves with the wrapped result IF successful, else
          // hangs forever — Promise.race picks the first WINNER, not the
          // first SETTLER. 25s ceiling guards against both endpoints hanging
          // past the WS ack window (30s) so we don't deadlock.
          const primaryRace = primaryWrapped.then(x => pickIfSuccess(x) || new Promise(() => {}));
          const cfRace = cfWrapped.then(x => pickIfSuccess(x) || new Promise(() => {}));
          const ceiling = new Promise((_, rej) => setTimeout(() => rej(new Error('race ceiling 25s')), 25000));
          const winner = await Promise.race([primaryRace, cfRace, ceiling]);
          res = winner.r;
          sid = res.data?.session_id || res.data?.session?.id;
          if (winner.mode === 'cf') {
            cfModeRef.current = true;
            console.warn('[Live] race winner: live_start_cf (P2P slow or failed)');
          } else {
            console.log('[Live] race winner: live_start (P2P)');
          }
        } catch {
          // Race timed out — try awaiting whichever has settled (or fallback
          // to settled-or-null). Symmetric: never hang past 25s.
          try {
            const settled = await Promise.race([primaryWrapped, cfWrapped]);
            res = settled?.r;
            sid = res?.data?.session_id || res?.data?.session?.id;
            if (settled?.mode === 'cf') cfModeRef.current = true;
          } catch {}
        }
      }
      if ((!res?.success || !sid) && !wantsCf) {
        // P2P path failed — try CF as a fallback before giving up. This
        // catches the case where live_start regressed (backend deploy mid-
        // request, parental gate transient, etc) but live_start_cf works.
        console.warn('[live] live_start failed, falling back to live_start_cf:', res?.message, 'status:', res?.status);
        try {
          const cfRes = await api.liveStartCf(liveTitle, { audience, category: liveCategory, subscribersOnly });
          const cfSid = cfRes?.data?.session_id || cfRes?.data?.session?.id;
          if (cfRes?.success && cfSid) {
            res = cfRes;
            sid = cfSid;
            cfModeRef.current = true; // flip to CF lifecycle so live_end picks the right endpoint
            console.warn('[live] fallback to live_start_cf succeeded — session', cfSid);
          }
        } catch (cfErr) {
          console.warn('[live] live_start_cf fallback also failed:', cfErr?.message);
        }
      }
      if (res.success && sid) {
        setSessionId(sid);
        sessionIdRef.current = sid;

        // ── CF Stream WHIP publish ──
        // If we asked the backend for the CF pipeline, kick off the WHIP
        // publish in parallel with the countdown/WS subscribe. We DON'T
        // await it — a slow ICE negotiation shouldn't block the host UI
        // from flipping to "AO VIVO" (the recording starts the moment CF
        // sees frames; if WHIP setup takes 2s the VOD just trims that).
        // Failure here is non-fatal: viewers on the in-app HLS get a
        // warm-up screen, and the legacy P2P viewer path still works.
        if (wantsCf) {
          const ingestUrl = res.data?.webrtc_url;
          cfIngestRef.current = {
            cf_input_uid: res.data?.cf_input_uid,
            hls_url: res.data?.hls_url,
            rtmps_url: res.data?.rtmps_url,
            rtmps_key: res.data?.rtmps_key,
          };
          // [LIVE-VOD-TRACE] Wave 44 — surface the full ingest payload so we
          // can tell from logs whether a host's empty VOD was caused by
          // (a) backend not returning webrtc_url, (b) WHIP publish failing,
          // (c) localStreamRef being null when we tried to publish, or
          // (d) something else upstream. User report: "aonde ta ficando
          // salvo as lives? não tá funcionando" — DB shows save_replay=true
          // on every recent session but recording_mp4=null forever because
          // CF Stream's /videos endpoint returns []: no frames ever reached
          // CF, so no VOD was ever produced.
          try {
            console.log('[LIVE-VOD-TRACE] live_start_cf response', {
              session_id: sid,
              cf_input_uid: res.data?.cf_input_uid,
              has_webrtc_url: !!ingestUrl,
              has_rtmps_url: !!res.data?.rtmps_url,
              has_hls_url: !!res.data?.hls_url,
              has_local_stream: !!localStreamRef.current,
              local_tracks: localStreamRef.current
                ? localStreamRef.current.getTracks().map(t => `${t.kind}:${t.readyState}`)
                : null,
            });
          } catch {}
          if (ingestUrl && localStreamRef.current) {
            console.log('[LIVE-VOD-TRACE] starting WHIP publish to CF Stream');
            publishToCfStream(localStreamRef.current, ingestUrl)
              .then((pub) => {
                cfPublisherRef.current = pub;
                console.log('[LIVE-VOD-TRACE] WHIP publish OK — CF should record VOD');
              })
              .catch((e) => {
                console.warn('[LIVE-VOD-TRACE] CF Stream WHIP publish failed:', e?.message || e);
                // Soft-warn the host so they know the replay won't materialize.
                // Without this, host taps end-live, sees "Processing", and
                // /lives-saved never shows the row (a 2-week+ silent bug for
                // every CF live since the pipeline shipped).
                try {
                  const msg = t('live.replayPublishFailed') || 'Replay não será salvo (falha de conexão com servidor de mídia)';
                  if (Platform.OS === 'android' && Platform.constants?.ToastAndroid !== undefined) {
                    const { ToastAndroid } = require('react-native');
                    ToastAndroid?.show?.(msg, ToastAndroid.LONG);
                  }
                } catch {}
                // No teardown — viewers fall back to the WebRTC P2P path
                // (host -> viewer pcs created via the WS signaling below).
              });
          } else if (!ingestUrl) {
            console.warn('[LIVE-VOD-TRACE] live_start_cf returned no webrtc_url — VOD will be empty');
          } else if (!localStreamRef.current) {
            console.warn('[LIVE-VOD-TRACE] no localStream when WHIP would have started — VOD will be empty');
          }
        }

        // Surface the ongoing-broadcast pill (sticky on Android, passive on
        // iOS). Tapping returns to /live-broadcast via the deep_link the
        // notification handler in services/pushNotifications.js routes on
        // type=live_broadcast_self. Viewer-count ticks land below in the WS
        // live_viewer_count handler.
        try {
          liveBroadcastNotification.start({
            sessionId: sid,
            title: titleInput.trim() || (t('live.title') || 'Live'),
          });
        } catch {}

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

        // [WAVE 37 2026-05-20] WS signaling kicks off in parallel but does
        // NOT block the UI from going live. The backend already accepted
        // live_start (we have sid in hand), so the host should see "AO VIVO"
        // as soon as the countdown finishes. WS subscribe runs in background
        // so viewers can connect when ready. Previously Promise.all() with
        // the 30s WS watchdog meant a slow ack froze the user on the count-
        // down screen for half a minute before bailing — exactly the
        // "erro ao iniciar" report users have been hitting.
        const wsReady = connectSignaling();
        wsReady.catch((waitErr) => {
          console.warn('[Live] WS subscribe failed (non-fatal, UI continues):', waitErr?.message);
        });
        await animateCountdown(3);
        await animateCountdown(2);
        await animateCountdown(1);
        setCountdown(null);

        // Round 69 #1166 (2026-05-19) — bump videoEpoch BEFORE flipping
        // preStart → false so the NativeRTCView mounted in the live
        // broadcasting tree gets a fresh React key, forcing iOS to allocate
        // a brand-new RTCMTLVideoView instead of recycling the one that
        // had been painting inside the preStart tree during the 3s
        // countdown. Without this bump, iOS view-recycle pool reuses the
        // same Metal layer + its stale texture buffer → first live frame
        // paints over only part of the surface → horizontal "barra preta"
        // through the host's face at second ~3 of the broadcast (5th
        // regression — rounds 52/64/66/67 each missed this code path).
        setVideoEpoch(e => e + 1);
        setPreStart(false);

        // Start duration timer
        durationTimerRef.current = setInterval(() => {
          setLiveDuration(prev => prev + 1);
        }, 1000);

        // Bug #978-2 fix — viewer count shows 0 even with active viewers.
        //
        // Root cause: count display was driven SOLELY by the server's
        // `live_viewer_count` WS event. That event is fired on viewer
        // join/leave only — so if (a) the host's WS reconnected after a
        // viewer was already there, (b) the live_viewer_count packet was
        // dropped, or (c) the host's WS subscribe race ran AFTER the viewer
        // joined, the host UI sticks at 0 even though peersRef.current.size
        // and uniqueViewersRef.current.size both know better.
        //
        // Fix: every 5s reconcile the displayed count from the MAX of
        //   1) WS-driven count (viewerCountRef)
        //   2) Active WebRTC peers (peersRef.current.size)
        //   3) Approved guest peers (1 if guestPeer set, otherwise 0)
        // Display never under-reports the real-time signal we already have
        // locally. Also bumped the cadence from 10s to 5s so the count
        // catches up quickly after a WS hiccup.
        viewerCountTimerRef.current = setInterval(() => {
          const sid = sessionIdRef.current;
          if (!sid) return;
          // Reconcile display count from the strongest local signal.
          const wsCount = viewerCountRef.current || 0;
          const peerCount = peersRef.current?.size || 0;
          const display = Math.max(wsCount, peerCount);
          if (display !== wsCount) {
            // Local signal is ahead of the WS — surface it so user
            // doesn't see a stale "0 assistindo".
            viewerCountRef.current = display;
            setViewerCount(display);
          }
          // Push our best estimate to the backend so /lives_global +
          // home strip surface a non-zero badge.
          api.liveUpdateViewers(sid, display).catch(() => {});
        }, 5000);
      } else {
        // [WAVE 34 2026-05-20] More-actionable error. The previous text
        // was just "Connection failed" — useless for triage. Now we
        // append:
        //   1. HTTP status (401/403/500/502 etc) — tells the user
        //      whether they need to re-login, are blocked by parental,
        //      or backend is genuinely down.
        //   2. Backend error_code (auth_expired, parental_blocked,
        //      livekit_unreachable, etc) so we can correlate user
        //      reports to one specific backend code path.
        //   3. First 80 chars of `data.message` (truncated) — for
        //      transient errors we get a human-readable string.
        // User report: "erro ao conectar ao servidor". With the detail
        // appended the next report will tell us WHICH server (LiveKit /
        // PG / Cloudflare / Telnyx) actually failed.
        const status = res?.status ? `HTTP ${res.status}` : '';
        const code = res?.data?.error_code || res?.error_code || '';
        const msg = (res?.message || res?.data?.message || '').toString().slice(0, 80).trim();
        const sidMissing = res?.success && !sid ? 'no session_id' : '';
        const parts = [status, code, sidMissing, msg].filter(Boolean);
        const detail = parts.length ? ` (${parts.join(' · ')})` : '';
        setError((t('live.connectionFailed') || 'Connection failed') + detail);
      }
    } catch (e) {
      // Was empty `catch {}` — masked real reason (e.g., auth expired,
      // CDN 502, parental block). Surface the message so the user knows
      // whether to retry / re-login / wait. Falls back to the generic
      // i18n string if the exception has no message.
      console.warn('[live] start failed:', e?.message || e);
      // [WAVE 34 2026-05-20] Include the exception name (e.g.
      // "TypeError", "AbortError") in addition to message — sometimes
      // the message is empty for fetch failures and the name is the
      // only useful clue.
      const errName = e?.name && e.name !== 'Error' ? e.name : '';
      const errMsg = e?.message || '';
      const parts = [errName, errMsg].filter(Boolean);
      const detail = parts.length ? ` (${parts.join(': ')})` : '';
      setError((t('live.connectionFailed') || 'Connection failed') + detail);
    } finally {
      // Release the single-flight gate. If the start succeeded sessionIdRef
      // is now set so the early-return at the top still blocks re-entry.
      startingRef.current = false;
    }
  }, [titleInput, connectSignaling, t, animateCountdown, ensureCameraStream, saveReplay, audience, liveCategory, subscribersOnly]);

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
      // Dismiss the ongoing-broadcast pill — broadcast is over.
      try { liveBroadcastNotification.stop(endedSessionId); } catch {}
      // Local fast-path: clear the AO VIVO badge on the host's own Profile
      // (and any other surface listening) BEFORE the backend round-trip.
      // Without this the badge could linger for up to 20s (Profile poll
      // window) or indefinitely if the WS `live_ended` event got dropped.
      // See Profile.js useEffect with `liveSessionId` for the listener.
      try {
        DeviceEventEmitter.emit('profile:live_ended', {
          session_id: endedSessionId,
          host_email: (user?.email || '').toLowerCase(),
        });
      } catch {}
      // Close the CF Stream WHIP publisher (if we went through that path)
      // BEFORE telling the backend to finalize the recording. CF stops
      // ingest the moment we close the PC; if we did it after live_end_cf
      // we'd race the recording finalizer and risk a 0-byte VOD.
      if (cfPublisherRef.current) {
        try { cfPublisherRef.current.stop(); } catch {}
        cfPublisherRef.current = null;
      }
      // Capture has_recording from the response so the end-card knows
      // whether to surface "Ver Lives Salvas" (CF Stream pipeline) vs a
      // plain "Concluído" (legacy P2P — no VOD will materialize). The
      // endpoint pick mirrors the start path: CF sessions go through
      // live_end_cf so the cron-live-recordings finalizer picks them up,
      // legacy sessions stay on live_end. Memory-safe — fires after teardown.
      const endFn = cfModeRef.current ? api.liveEndCf : api.liveEnd;
      // [LIVE-VOD-TRACE] Wave 44 — show a tangible "Replay sendo processado"
      // toast the moment the host taps end-live. The previous UX let users
      // walk away thinking nothing was happening (the end-card just said
      // "Live encerrada"), then they'd open /lives-saved later, see an empty
      // list, and assume the feature was broken — matching the actual user
      // report. Toast surfaces ONLY when replay was requested AND we went
      // through the CF pipeline (replayRequested gate).
      if (replayRequested && cfModeRef.current) {
        try {
          const msg = t('live.replayProcessingToast') || 'Seu replay está sendo processado (pode levar 1-2 min)';
          if (Platform.OS === 'android') {
            const { ToastAndroid } = require('react-native');
            ToastAndroid?.show?.(msg, ToastAndroid.LONG);
          } else if (Platform.OS === 'web') {
            // Web: no native toast — append to the end-card state which
            // already surfaces "Processing" copy.
          } else {
            // iOS: end-card already renders the "Processando..." chip via
            // endedReplayStatus, so no extra toast needed (avoids stacking
            // alerts on top of the modal animation).
          }
        } catch {}
      }
      try { console.log('[LIVE-VOD-TRACE] live_end fired', { session_id: endedSessionId, cf_mode: cfModeRef.current, save_replay: replayRequested }); } catch {}
      endFn(endedSessionId, { save_replay: replayRequested })
        .then((res) => {
          try { console.log('[LIVE-VOD-TRACE] live_end response', { ok: !!res?.success, has_recording: res?.data?.has_recording, message: res?.message }); } catch {}
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
        .catch((e) => {
          try { console.warn('[LIVE-VOD-TRACE] live_end network error', e?.message); } catch {}
          setEndedReplayStatus(replayRequested ? 'error' : 'none');
        });
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
    // Step 0: warning haptic so the host physically feels the gravity of
    // tapping the red orb before the modal opens (TikTok/IG parity).
    try {
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      }
    } catch {}
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
  //
  // Bug #978-5 root cause: the previous handler stopped/removed the old video
  // track BEFORE awaiting `getUserMedia`. On native, if the second
  // `getUserMedia` rejected (permission, hardware busy, double-tap race), we
  // were left with a half-mutated localStreamRef (track stopped, removed) and
  // peer senders pointing at a dead track — host's preview froze AND viewers
  // saw a frozen frame. On native with @livekit/react-native-webrtc, the
  // safer/idiomatic path is `videoTrack._switchCamera()` (toggles front/back
  // in-place without re-running getUserMedia, no track replacement needed —
  // so peer senders + preview keep working). Web has no `_switchCamera`, so
  // we keep the getUserMedia path but: (1) await the new stream BEFORE
  // touching the old track, (2) double-tap guard via in-flight ref,
  // (3) try/catch every mutation step + revert facingRef on failure,
  // (4) surface a toast so user knows the flip failed instead of staring
  // at the same view.
  const flipInFlightRef = useRef(false);
  const handleFlipCamera = useCallback(async () => {
    // Guard against double-taps + missing stream (pre-live or after end).
    if (flipInFlightRef.current) return;
    const stream = localStreamRef.current;
    if (!stream) return;
    flipInFlightRef.current = true;

    const prevFacing = facingRef.current;
    const newFacing = prevFacing === 'user' ? 'environment' : 'user';

    try {
      // Native fast-path: `_switchCamera` toggles the existing track's
      // hardware source without dropping/replacing the MediaStreamTrack.
      // Peer senders + local preview keep their reference, so there's no
      // tear-down race. Skip this path on web (function doesn't exist).
      if (Platform.OS !== 'web') {
        let oldVideoTrack = null;
        try { oldVideoTrack = stream.getVideoTracks?.()[0] || null; } catch {}
        if (oldVideoTrack && typeof oldVideoTrack._switchCamera === 'function') {
          try {
            oldVideoTrack._switchCamera();
            facingRef.current = newFacing;
            setMirrorOn(newFacing === 'user');
            // Refresh local preview URL so the mirror flag picks up. Some
            // platforms keep the same toURL — that's fine, mirror is the
            // only visible change there.
            try {
              if (stream.toURL) setLocalStreamUrl(stream.toURL());
            } catch {}
            // Round 68 #1157 — also bump videoEpoch so the React `key`
            // changes and React mounts a brand-new RTCMTLVideoView. Without
            // this, _switchCamera left the iOS view holding the previous
            // camera's last frame in half the texture surface while the
            // new camera filled the other half → reported as a horizontal
            // black/grey split through the face (4 user reports).
            setVideoEpoch(e => e + 1);
            return; // success — done.
          } catch (errSwitch) {
            // Fall through to the getUserMedia path below.
            console.warn('[Live] _switchCamera failed, fallback to gUM:', errSwitch?.message);
          }
        }
      }

      // Web (or native fallback) path: acquire NEW track first, only then
      // touch the old one. This is the critical ordering — if `getUserMedia`
      // rejects we still have a working stream.
      if (!getUserMediaFn) {
        throw new Error('getUserMedia unavailable');
      }
      const newStream = await getUserMediaFn({
        video: { facingMode: newFacing },
        audio: false,
      });
      const newVideoTrack = newStream?.getVideoTracks?.()[0] || null;
      if (!newVideoTrack) {
        // No track produced — bail out (revert facing). Don't touch old.
        try { newStream?.getTracks?.().forEach(t => t.stop()); } catch {}
        throw new Error('no video track from getUserMedia');
      }

      // Now safe to commit. Stop + remove old, add new, replace on peers.
      let oldVideoTrack = null;
      try { oldVideoTrack = stream.getVideoTracks?.()[0] || null; } catch {}
      try { if (oldVideoTrack) oldVideoTrack.stop(); } catch {}
      try { if (oldVideoTrack) stream.removeTrack(oldVideoTrack); } catch {}
      try { stream.addTrack(newVideoTrack); } catch (e) {
        console.warn('[Live] addTrack failed:', e?.message);
      }

      // Replace on every active peer connection. Wrap each in try so one
      // failing peer doesn't abort the others.
      try {
        peersRef.current.forEach(pc => {
          try {
            const sender = pc.getSenders?.().find(s => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(newVideoTrack).catch(() => {});
          } catch {}
        });
      } catch {}

      // Commit facing ref AFTER the swap so the mirror flag flips with the
      // visible change.
      facingRef.current = newFacing;
      setMirrorOn(newFacing === 'user');

      // Refresh preview surface.
      try {
        if (Platform.OS === 'web' && localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        } else if (stream?.toURL) {
          setLocalStreamUrl(stream.toURL());
          // Round 68 #1157 — bump epoch so React keys a fresh native view,
          // releasing the previous RTCMTLVideoView texture buffer.
          setVideoEpoch(e => e + 1);
        }
      } catch {}
    } catch (err) {
      console.error('[Live] Failed to flip camera:', err?.message || err);
      // Revert facing ref so the next tap retries the SAME direction (instead
      // of skipping to the opposite — would confuse the user).
      facingRef.current = prevFacing;
      try {
        const { ToastAndroid, Alert } = require('react-native');
        const message = (t && t('live.flipCameraFailed')) || 'Não foi possível trocar a câmera';
        if (Platform.OS === 'android' && ToastAndroid?.show) {
          ToastAndroid.show(message, ToastAndroid.SHORT);
        } else if (Platform.OS === 'ios' && Alert?.alert) {
          Alert.alert(message);
        }
      } catch {}
    } finally {
      flipInFlightRef.current = false;
    }
  }, [t]);

  // ─── AR Filter handler ───
  // Picks a preset, persists in state, and pokes the native module so the
  // MediaPipe pipeline (FaceLandmarker + SelfieSegmentation) swaps the
  // active overlay. Native bridge (modules/expo-live-native) accepts the
  // preset key + wallpaper sub-id.
  const applyArFilter = useCallback((presetKey, wallpaperId = arWallpaper) => {
    setActiveARFilter(presetKey);
    if (presetKey === 'greenscreen') setArWallpaper(wallpaperId);
    // Hand to native — best-effort; the native host owns the actual pipeline.
    try {
      const liveNative = require('../modules/expo-live-native/src').default;
      if (liveNative && typeof liveNative.setArFilter === 'function') {
        liveNative.setArFilter(presetKey, presetKey === 'greenscreen' ? wallpaperId : 0);
      }
    } catch {
      // Native module not loaded (web / Expo Go) — JS-only overlay path
      // handles the visual hint via the styles.arFilterOverlay tint.
    }
  }, [arWallpaper]);

  // ─── Multistream handlers ───
  // Loads previously-saved RTMP destinations into state. Called when the
  // multistream sheet first opens.
  const loadMultistreamDests = useCallback(async () => {
    try {
      const sid = sessionIdRef.current || '';
      const r = await api.liveMultistreamList(sid);
      if (r?.success && Array.isArray(r.data?.items)) {
        setMultistreamDests(r.data.items);
      }
    } catch (e) {
      console.warn('[Live] liveMultistreamList failed:', e?.message);
    }
  }, []);

  const addMultistreamDest = useCallback(async () => {
    const { rtmpUrl, streamKey, label } = multistreamForm;
    if (!rtmpUrl || !streamKey) {
      try { Alert.alert(t('common.error') || 'Erro', t('live.multistreamMissing') || 'URL e chave são obrigatórios'); } catch {}
      return;
    }
    if (!/^rtmps?:\/\//i.test(rtmpUrl)) {
      try { Alert.alert(t('common.error') || 'Erro', t('live.multistreamInvalidUrl') || 'URL deve começar com rtmp:// ou rtmps://'); } catch {}
      return;
    }
    setMultistreamSaving(true);
    try {
      const sid = sessionIdRef.current || '';
      const r = await api.liveMultistreamAdd(rtmpUrl, streamKey, {
        broadcastId: sid,
        label: label || rtmpUrl.replace(/^rtmps?:\/\//i, '').split('/')[0],
      });
      if (r?.success) {
        setMultistreamForm({ rtmpUrl: '', streamKey: '', label: '' });
        await loadMultistreamDests();
        try {
          const { ToastAndroid } = require('react-native');
          if (Platform.OS === 'android' && ToastAndroid?.show) {
            ToastAndroid.show(
              r.data?.started
                ? (t('live.multistreamStarted') || 'Transmitindo')
                : (t('live.multistreamSaved') || 'Destino salvo'),
              ToastAndroid.SHORT
            );
          }
        } catch {}
      } else {
        try { Alert.alert(t('common.error') || 'Erro', r?.message || 'Falha'); } catch {}
      }
    } catch (e) {
      console.warn('[Live] liveMultistreamAdd failed:', e?.message);
    } finally {
      setMultistreamSaving(false);
    }
  }, [multistreamForm, loadMultistreamDests, t]);

  const removeMultistreamDest = useCallback(async (id) => {
    try {
      await api.liveMultistreamRemove(id);
      setMultistreamDests(prev => prev.filter(d => d.id !== id));
    } catch (e) {
      console.warn('[Live] liveMultistreamRemove failed:', e?.message);
    }
  }, []);

  // ─── Schedule live handler ───
  const saveScheduledLive = useCallback(async () => {
    const titleVal = titleInput.trim() || (t('live.untitled') || 'Live');
    if (scheduleDate.getTime() < Date.now() + 5 * 60 * 1000) {
      try { Alert.alert(t('common.error') || 'Erro', t('live.scheduleTooSoon') || 'Escolha um horário pelo menos 5 minutos no futuro'); } catch {}
      return;
    }
    setScheduleSaving(true);
    try {
      const r = await api.liveSchedule(scheduleDate, titleVal, {
        audience,
        category: liveCategory,
      });
      if (r?.success) {
        setScheduleOpen(false);
        try {
          Alert.alert(
            t('live.scheduled') || 'Agendada',
            t('live.scheduledOk') || 'Seguidores receberão um lembrete 15 min antes e no início.'
          );
        } catch {}
      } else {
        try { Alert.alert(t('common.error') || 'Erro', r?.message || 'Falha'); } catch {}
      }
    } catch (e) {
      console.warn('[Live] liveSchedule failed:', e?.message);
    } finally {
      setScheduleSaving(false);
    }
  }, [titleInput, scheduleDate, audience, liveCategory, t]);

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
      // [bug 2026-05-15 #980 silent-fail-wave-4] Previously swallowed errors
      // entirely — viewer typed a message, composer cleared, but if the API
      // failed (5xx, network blip) only this device saw it and other viewers
      // got nothing. Retry once after 800ms, then if still failing flag the
      // local bubble with `_failed` so the user knows to try again.
      const sid = sessionIdRef.current;
      const msgId = msg.id;
      api.liveSendChat(sid, trimmed).catch(() => {
        setTimeout(() => {
          api.liveSendChat(sid, trimmed).catch(() => {
            try {
              const { ToastAndroid, Platform: P } = require('react-native');
              if (P.OS === 'android' && ToastAndroid?.show) {
                ToastAndroid.show(t('live.chatFailed') || 'Mensagem não enviada', ToastAndroid.SHORT);
              }
            } catch {}
            // Mark the optimistic bubble as failed so a faded styling is
            // possible (LiveChatOverlay can read msg._failed). Future tap-to-
            // retry can dispatch the same payload again.
            try {
              setChatMessages(prev => prev.map(m => (m.id === msgId ? { ...m, _failed: true } : m)));
            } catch {}
          });
        }, 800);
      });
    }
  }, [user, t]);

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
      // Persist via API so viewers joining after this point still see the pin.
      if (sessionIdRef.current) {
        api.chatLivePinComment(sessionIdRef.current, pinContent, pinName).catch(() => {});
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
    const color = HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)];
    spawnHeart({ color });
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Spawn anchor on the host's right rail — viewers see the heart on
      // their right edge too because we send a normalized x near 1.0.
      const xNorm = Math.max(0, Math.min(1, (SCREEN_W - 60) / SCREEN_W));
      wsRef.current.send(JSON.stringify({
        type: 'live_reaction',
        session_id: sessionIdRef.current,
        emoji: '❤️',
        x: xNorm,
        color,
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

  // Lazy-load LiveKit only when the cohost subscriber actually needs to
  // connect — same pattern as live-viewer.js. Keeps the cold-start path
  // free of livekit-client cost for hosts who never approve a cohost.
  const _loadLK = useCallback(() => {
    try {
      const lkc = require('livekit-client');
      let VideoView = null;
      if (Platform.OS !== 'web') {
        try {
          const lkrn = require('@livekit/react-native');
          lkrn.registerGlobals?.();
          VideoView = lkrn.VideoView;
        } catch (e) {
          console.warn('[Live] @livekit/react-native load failed:', e?.message);
        }
      }
      return { Room: lkc.Room, RoomEvent: lkc.RoomEvent, VideoView };
    } catch (e) {
      console.warn('[Live] livekit-client load failed:', e?.message);
      return null;
    }
  }, []);

  // Host-side LK subscribe to render cohost video/audio published into
  // `live_{sessionId}`. Called the first time a cohost gets approved.
  // Idempotent: if already connecting/connected, no-op.
  const ensureCohostSubscriber = useCallback(async () => {
    // [#1174 fix, 2026-05-18] Removed `__chatyy_cohost_lk` gate. Both the
    // viewer's joinCohost (live-viewer.js) and this host-side subscriber
    // are wired; the gate was a Stage 2 safety valve that prevented
    // approvals from ever causing a camera publish in the wild.
    if (cohostRoomRef.current) return;
    if (cohostConnectingRef.current) return;
    cohostConnectingRef.current = true;
    try {
      const lk = _loadLK();
      if (!lk?.Room) return;
      const sid = sessionIdRef.current;
      if (!sid) return;
      let info;
      try {
        info = await api.liveHostLkToken(sid);
      } catch (e) {
        console.warn('[Live] host LK token fetch failed:', e?.message);
      }
      const tokenInfo = info?.data || info;
      if (!tokenInfo?.token || !tokenInfo?.url) {
        console.warn('[Live] host LK token returned empty payload');
        return;
      }
      const room = new lk.Room({ adaptiveStream: true, dynacast: true });
      cohostRoomRef.current = room;

      // Track participants and their video tracks so we can render a PiP
      // for each cohost. Stage 4 will replace this list-based render with
      // a proper multi-cam grid component.
      const upsert = (participant, videoTrack) => {
        setCohostParticipants(prev => {
          const idx = prev.findIndex(p => p.identity === participant.identity);
          const entry = {
            identity: participant.identity,
            name: participant.name || participant.identity,
            videoTrack: videoTrack || null,
          };
          if (idx === -1) return [...prev, entry];
          const copy = prev.slice();
          copy[idx] = { ...copy[idx], ...entry };
          return copy;
        });
      };
      const remove = (identity) => {
        setCohostParticipants(prev => prev.filter(p => p.identity !== identity));
      };

      room.on(lk.RoomEvent.ParticipantConnected, (p) => upsert(p, null));
      room.on(lk.RoomEvent.ParticipantDisconnected, (p) => remove(p.identity));
      room.on(lk.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind === 'video') upsert(participant, track);
      });
      room.on(lk.RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
        if (track.kind === 'video') upsert(participant, null);
      });
      room.on(lk.RoomEvent.Disconnected, () => {
        cohostRoomRef.current = null;
        setCohostParticipants([]);
      });

      await room.connect(tokenInfo.url, tokenInfo.token);

      // Snapshot existing participants in case we connected after they
      // were already publishing.
      try {
        const others = Array.from(room.remoteParticipants?.values?.() || []);
        for (const p of others) {
          const pubs = Array.from(p.videoTrackPublications?.values?.() || []);
          const sub = pubs.find(pp => pp.track) || pubs[0];
          upsert(p, sub?.track || null);
        }
      } catch {}
    } catch (e) {
      console.warn('[Live] cohost subscriber connect failed:', e?.message);
      try { cohostRoomRef.current?.disconnect(); } catch {}
      cohostRoomRef.current = null;
    } finally {
      cohostConnectingRef.current = false;
    }
  }, [_loadLK]);

  // Teardown cohort subscriber when the broadcast ends (the broadcast's
  // unmount/end-of-life effect calls this).
  const teardownCohostSubscriber = useCallback(() => {
    const room = cohostRoomRef.current;
    cohostRoomRef.current = null;
    setCohostParticipants([]);
    if (room) { try { room.disconnect(); } catch {} }
  }, []);

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
        // [bug 2026-05-15 #980] Previously swallowed silently — host thought
        // peer was approved (UI moved on), backend never recorded the change,
        // peer never got the cohost token and ringed forever. Alert + restore
        // the join request so host can retry.
        api.liveCohostApprove(sid, email).catch((err) => {
          console.warn('[Live] liveCohostApprove failed:', err?.message || err);
          try {
            const { Alert: A, ToastAndroid: TA, Platform: P } = require('react-native');
            const msg = t('live.cohostApproveFailed') || 'Não foi possível aprovar agora. Tente novamente.';
            if (P.OS === 'android' && TA?.show) TA.show(msg, TA.SHORT);
            else if (A?.alert) A.alert(msg);
          } catch {}
          // Re-add to join-requests so the host can re-tap Approve.
          setJoinRequests(prev => (prev.some(r => r.email === email) ? prev : [...prev, { email, ts: Date.now() }]));
        });
      }
    } catch {}
    // Stage 3 of #929 — also kick off host's LK subscriber so the cohost's
    // video (published via Stage 2 viewer path) can be rendered. Gated.
    ensureCohostSubscriber().catch(() => {});
    setJoinRequests(prev => prev.filter(r => r.email !== email));
  }, [user, ensureCohostSubscriber, t]);
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

  // Reusable toast — Android ToastAndroid + iOS Alert fallback. Used by the
  // moderation flows (slow mode, ban) so the host gets confirmation without
  // a noisy modal interrupting the broadcast.
  const hostToast = useCallback((text) => {
    if (!text) return;
    try {
      const { ToastAndroid } = require('react-native');
      if (Platform.OS === 'android' && ToastAndroid?.show) {
        ToastAndroid.show(text, ToastAndroid.SHORT);
        return;
      }
    } catch {}
    try { Alert.alert(text); } catch {}
  }, []);

  // Slow-mode setter — calls the API + WS broadcast so viewers' clients
  // know the cooldown. Fail-graceful when the endpoint isn't shipped yet:
  // we still keep the host UI state in sync, just toast "Em breve".
  const applySlowMode = useCallback(async (seconds) => {
    const sec = Number(seconds) || 0;
    setSlowModeSeconds(sec);
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const res = await api.chatLiveSetSlowMode(sid, sec);
      if (res && res.success === false) {
        // Backend explicit rejection (e.g. unknown action 404'd) — surface
        // a "coming soon" toast so the host doesn't think they broke it.
        hostToast(t('live.featureSoon') || 'Em breve');
        return;
      }
      hostToast(
        sec > 0
          ? (t('live.slowModeOnToast') || `Modo lento: ${sec}s`).replace('{n}', String(sec))
          : (t('live.slowModeOffToast') || 'Modo lento desligado')
      );
    } catch {
      hostToast(t('live.featureSoon') || 'Em breve');
    }
  }, [hostToast, t]);

  // Open the slow-mode picker — ActionSheetIOS on iOS, custom Modal on
  // Android (Android doesn't ship ActionSheet natively).
  const openSlowModePicker = useCallback(() => {
    const options = [
      { sec: 0, label: t('live.slowModeOff') || 'Desligado' },
      { sec: 5, label: '5s' },
      { sec: 15, label: '15s' },
      { sec: 30, label: '30s' },
      { sec: 60, label: t('live.slowMode1min') || '1 min' },
    ];
    if (Platform.OS === 'ios' && ActionSheetIOS?.showActionSheetWithOptions) {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: t('live.slowModeTitle') || 'Modo lento',
          options: [...options.map(o => o.label), t('common.cancel') || 'Cancelar'],
          cancelButtonIndex: options.length,
        },
        (idx) => {
          if (idx == null || idx === options.length) return;
          const choice = options[idx];
          if (choice) applySlowMode(choice.sec);
        }
      );
    } else {
      setSlowModeOpenAndroid(true);
    }
  }, [applySlowMode, t]);

  // Open the moderation ActionSheet for a viewer row — kick from this live
  // and/or ban permanently. Long-press handler in the insights/viewer list.
  const openViewerActions = useCallback((viewer) => {
    if (!viewer?.email) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const handleKick = async (permanent) => {
      try {
        const res = await api.chatLiveBanViewer(sid, viewer.email, permanent);
        if (res && res.success === false) {
          hostToast(t('live.featureSoon') || 'Em breve');
          return;
        }
        // Optimistic — drop the viewer from local lists if present.
        try { setJoinFeed(prev => prev.filter(j => j.email !== viewer.email)); } catch {}
        // Notify viewers' clients to hangup via WS (server should also push
        // `live_viewer_kicked` after the REST call resolved; this is a belt-
        // and-suspenders broadcast for fast feedback).
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          try {
            wsRef.current.send(JSON.stringify({
              type: 'live_viewer_kicked',
              session_id: sid,
              viewer_email: viewer.email,
              permanent: permanent ? 1 : 0,
            }));
          } catch {}
        }
        hostToast(
          permanent
            ? (t('live.viewerBanned') || 'Bloqueado de futuros lives')
            : (t('live.viewerKicked') || 'Removido deste live')
        );
      } catch {
        hostToast(t('live.featureSoon') || 'Em breve');
      }
    };
    const options = [
      { label: t('live.kickViewer') || 'Remover deste live', destructive: true, run: () => handleKick(false) },
      { label: t('live.banViewer') || 'Bloquear de futuros', destructive: true, run: () => handleKick(true) },
    ];
    if (Platform.OS === 'ios' && ActionSheetIOS?.showActionSheetWithOptions) {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: viewer.name || viewer.email,
          options: [...options.map(o => o.label), t('common.cancel') || 'Cancelar'],
          destructiveButtonIndex: [0, 1],
          cancelButtonIndex: options.length,
        },
        (idx) => {
          if (idx == null || idx === options.length) return;
          options[idx]?.run?.();
        }
      );
    } else {
      // Android: lean on Alert with destructive buttons (closer to platform
      // ActionSheet UX than a bespoke Modal here, which would require
      // additional sheet styling for a single rare path).
      Alert.alert(
        viewer.name || viewer.email,
        viewer.email,
        [
          { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
          { text: options[0].label, style: 'destructive', onPress: options[0].run },
          { text: options[1].label, style: 'destructive', onPress: options[1].run },
        ],
      );
    }
  }, [hostToast, t]);

  // ─── Live polls (host) ─────────────────────────────────────────────
  // Open the create-poll modal. Reset draft state so the host doesn't see
  // stale text from a previous open.
  const openPollDraft = useCallback(() => {
    setPollDraftQuestion('');
    setPollDraftOptions(['', '']);
    setPollDraftOpen(true);
  }, []);

  const submitPollDraft = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const q = pollDraftQuestion.trim();
    const opts = pollDraftOptions.map(o => o.trim()).filter(Boolean);
    if (!q || opts.length < 2) {
      hostToast(t('live.pollInvalid') || 'Pergunta + pelo menos 2 opções');
      return;
    }
    try {
      const res = await api.chatLivePollCreate(sid, q, opts);
      if (res && res.success === false) {
        hostToast(t('live.featureSoon') || 'Em breve');
        return;
      }
      // Backend echoes back the created poll via `live_poll_created` WS;
      // the handler below will set activePoll. Optimistically close draft.
      setPollDraftOpen(false);
      // Optimistically seed activePoll so the host overlay shows up even if
      // WS round-trip is slow.
      const seeded = res?.data?.poll || {
        id: res?.data?.poll_id || ('local_' + Date.now()),
        question: q,
        options: opts.map(text => ({ text, votes: 0 })),
        total_votes: 0,
        closed: false,
      };
      setActivePoll(seeded);
    } catch {
      hostToast(t('live.featureSoon') || 'Em breve');
    }
  }, [pollDraftQuestion, pollDraftOptions, hostToast, t]);

  const closeActivePoll = useCallback(async () => {
    const sid = sessionIdRef.current;
    const pid = activePoll?.id;
    if (!sid || !pid) { setActivePoll(null); return; }
    try {
      const res = await api.chatLivePollClose(sid, pid);
      if (res && res.success === false) {
        // Even on backend miss we should clear the local overlay so it
        // doesn't get stuck.
        setActivePoll(prev => prev ? { ...prev, closed: true } : null);
        hostToast(t('live.featureSoon') || 'Em breve');
        return;
      }
      setActivePoll(prev => prev ? { ...prev, closed: true } : null);
    } catch {
      setActivePoll(prev => prev ? { ...prev, closed: true } : null);
    }
  }, [activePoll, hostToast, t]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      endedRef.current = true; // Prevent reconnection attempts
      if (sessionIdRef.current) {
        // [bug 2026-05-15 #980 zombie-session] Single-shot fire-and-forget
        // left the session marked 'live' on backend if the network blipped at
        // the exact unmount moment. Viewers kept seeing the broadcast in
        // their story strip for hours. Retry up to 3× with backoff — the
        // closure survives unmount since it doesn't read any unmounted
        // refs after this point.
        const sid = sessionIdRef.current;
        // Dismiss ongoing-broadcast pill on unmount too (covers crash /
        // back-press paths where performEndLive didn't run).
        try { liveBroadcastNotification.stop(sid); } catch {}
        // Local fast-path: clear the AO VIVO badge instantly on unmount paths
        // too (back-press / crash) — performEndLive may not have run.
        try {
          DeviceEventEmitter.emit('profile:live_ended', {
            session_id: sid,
            host_email: (user?.email || '').toLowerCase(),
          });
        } catch {}
        const endFn = cfModeRef.current ? api.liveEndCf : api.liveEnd;
        const tryEnd = (attempt) => {
          endFn(sid).catch((err) => {
            console.warn('[Live] liveEnd attempt ' + attempt + ' failed:', err?.message || err);
            if (attempt < 3) {
              setTimeout(() => tryEnd(attempt + 1), 1000 * attempt);
            }
          });
        };
        tryEnd(1);
      }
      // Close the CF Stream WHIP publisher on unmount too — covers
      // back-press / crash paths where performEndLive didn't run.
      if (cfPublisherRef.current) {
        try { cfPublisherRef.current.stop(); } catch {}
        cfPublisherRef.current = null;
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
      // Stage 3 cohort LK teardown — disconnect subscriber Room if active.
      try { cohostRoomRef.current?.disconnect(); } catch {}
      cohostRoomRef.current = null;
    };
  }, []);

  // Helper: renders the local camera video for both web and native
  //
  // Round 52 polish (2026-05-18) — "mancha preta" host stage fix. The bug
  // was that the host saw their face rendered as two split halves with a
  // dark horizontal gap in the middle. Root cause: on Android the
  // NativeRTCView is backed by a SurfaceView that punches a window-hole
  // straight through the view hierarchy. If the parent has no explicit
  // `overflow: 'hidden'` + `backgroundColor: '#000'`, OR the SurfaceView
  // is recycled across stream restarts without a fresh React key, the
  // hardware layer can paint a partial frame (top of last frame on top,
  // current frame on bottom — looks exactly like a face split in two).
  //
  // Fixes:
  //  1. Wrap the video in an absoluteFill <View> with overflow:hidden +
  //     bg #000 so any SurfaceView mis-paint reveals only black, never a
  //     ghost previous frame leaking through.
  //  2. Bind a React key to the stream URL so a reconnect mounts a NEW
  //     SurfaceView instead of recycling the old one (the recycle is what
  //     produced the half/half ghost stack).
  //  3. Force width:'100%' + height:'100%' on the inner view (not just
  //     absoluteFill) so the native SurfaceView gets explicit dimensions
  //     instead of inheriting a zero-height calc during layout thrash.
  const renderLocalVideo = (style) => {
    if (Platform.OS === 'web') {
      return (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', overflow: 'hidden' }]}>
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
        </View>
      );
    }
    if (NativeRTCView && localStreamUrl) {
      // Round 66 (2026-05-18) — collapsable={false} on the wrapper so RN
      // doesn't flatten this view out (which on Android re-parents the
      // underlying SurfaceView and exposes a black square = mancha preta).
      //
      // Round 68 #1157 (2026-05-18) — STRUCTURAL fix for the "barra preta
      // horizontal" complaint (4 reports). User screenshot showed the host's
      // face split horizontally with a dark band crossing the middle and a
      // duplicate camera frame below — classic iOS RTCMTLVideoView texture-
      // buffer tear: the native view holds a stale frame in part of its
      // surface while the GPU renders new frames over only part of the
      // texture (single-buffer race on first-render and on camera-flip).
      //
      // Fix is three-layered:
      //   1. `key` now includes `videoEpoch` — every stream acquire / camera
      //      flip bumps the epoch, so React mounts a BRAND-NEW native view
      //      instance instead of recycling the old one. The previous key
      //      (`localStreamUrl` alone) wasn't enough because `stream.toURL()`
      //      often returns the same URL after _switchCamera → same key →
      //      view recycle → torn texture stays put.
      //   2. `mirror` is now state-backed (`mirrorOn`) so the prop change
      //      actually triggers a re-render (the previous `facingRef.current`
      //      ref-read was stale — RN doesn't subscribe to ref mutations).
      //   3. style is now pure `StyleSheet.absoluteFillObject` (concrete
      //      `top:0,bottom:0,left:0,right:0`) instead of `width:'100%',
      //      height:'100%'`. iOS bridge sometimes leaves percentage-sized
      //      WebRTC views ambiguous during initial layout pass → the view
      //      mounts at zero height, the GPU pre-allocates a half-screen
      //      texture, and the first frame paints into half before the
      //      layout pass corrects to full screen.
      // [#1166 round 5 — H1 fix] Don't mount the RTCView when route isn't
      // focused. fullScreenModal keeps the previous screen mounted; if
      // that screen owns an RTCView on the same camera, we'd have two
      // mounts → split face. Soft black until focus arrives.
      if (!isFocused) {
        return (
          <View
            collapsable={false}
            style={[StyleSheet.absoluteFill, { backgroundColor: '#000', overflow: 'hidden' }]}
          />
        );
      }
      return (
        <View
          collapsable={false}
          style={[StyleSheet.absoluteFill, { backgroundColor: '#000', overflow: 'hidden' }]}
        >
          <NativeRTCView
            key={`local:${preStart ? 'pre' : 'live'}:${videoEpoch}:${localStreamUrl}`}
            streamURL={localStreamUrl}
            style={StyleSheet.absoluteFillObject}
            objectFit="cover"
            mirror={mirrorOn}
            zOrder={0}
          />
        </View>
      );
    }
    // Pre-stream fallback — soft purple gradient + centered host avatar so
    // the camera-warm-up moment isn't a flat black void (issue #1).
    return (
      <View style={[StyleSheet.absoluteFill, {
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0a0a14',
        ...(Platform.OS === 'web' ? {
          background: 'radial-gradient(circle at 50% 40%, rgba(124,58,237,0.28), rgba(10,10,20,0.92) 60%, #050510 100%)',
        } : {}),
      }]}>
        <View pointerEvents="none" style={{
          position: 'absolute',
          width: 320, height: 320, borderRadius: 160,
          backgroundColor: 'rgba(124,58,237,0.18)',
          ...(Platform.OS === 'web' ? { display: 'none' } : {}),
        }} />
        <AvatarCircle
          name={user?.name || user?.email}
          email={user?.email}
          size={88}
          style={{ borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)' }}
        />
      </View>
    );
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
              <Text style={styles.endCardCtaSecondaryText} numberOfLines={1}>{t('live.share') || 'Compartilhar'}</Text>
            </TouchableOpacity>
            {/* Codex root cause #6 — after liveEnd the toggle is read-only.
                Tapping it routes to /lives-saved when a recording exists, so
                the host doesn't have to hunt the menu for the replay. The
                label surfaces processing / saved / failed state explicitly
                instead of the old "Salvar replay" toggle that desynced.

                Round 52 polish (2026-05-18) — "Salvo em Lives salvas" pill
                was overflowing the right edge of the modal card because the
                Text had no width constraint and the row's two flex:1 children
                couldn't shrink. Now: icon is wrapped (flexShrink:0), the Text
                takes flexShrink:1 with numberOfLines={1} + ellipsize, and
                the saved label is shortened to "Salvo em Lives" so it fits
                cleanly inside half of a 380px card at fontSize 14. */}
            <TouchableOpacity
              onPress={() => endedHasRecording ? router.push('/lives-saved') : null}
              disabled={!endedHasRecording}
              style={[styles.endCardCtaPrimary, !endedReplayRequested && styles.endCardCtaPrimaryOff]}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('live.replayStatusLabel') || 'Status do replay'}
              accessibilityState={{ disabled: !endedHasRecording }}
            >
              <View style={{ flexShrink: 0 }}>
                {endedReplayRequested ? <IconStarFilled size={16} color="#000" /> : <IconBookmark size={16} color="#fff" />}
              </View>
              <Text
                style={[styles.endCardCtaPrimaryText, !endedReplayRequested && { color: '#fff' }]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {endedReplayStatus === 'processing'
                  ? (t('live.replayProcessing') || 'Processando…')
                  : endedReplayStatus === 'error'
                    ? (t('live.replayError') || 'Falha ao salvar')
                    : endedReplayRequested
                      ? (t('live.replaySavedInLives') || 'Salvo em Lives')
                      : (t('live.replayNotSaved') || 'Não salvo')}
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

            {/* Category picker — 1 of 8 backend-known keys (gaming, music,
                chat, food, travel, tech, sports, learning) + a "Geral"
                opt-out. Renders as a horizontal pill rail. Used by the
                discover page filter. Empty selection ships no category to
                the backend (column stays NULL). */}
            <View style={styles.preCatRow}>
              <Text style={styles.preAudLabel}>{t('live.category') || 'Categoria'}</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8, paddingRight: 8 }}
              >
                {[
                  { key: '',         label: t('live.catGeneral')  || 'Geral',       color: '#6B7280' },
                  { key: 'gaming',   label: t('live.catGaming')   || 'Gaming',      color: '#A855F7' },
                  { key: 'music',    label: t('live.catMusic')    || 'Música',      color: '#EC4899' },
                  { key: 'chat',     label: t('live.catChat')     || 'Bate-papo',   color: '#22D3EE' },
                  { key: 'food',     label: t('live.catFood')     || 'Comida',      color: '#FBBF24' },
                  { key: 'travel',   label: t('live.catTravel')   || 'Viagens',     color: '#34D399' },
                  { key: 'tech',     label: t('live.catTech')     || 'Tecnologia',  color: '#60A5FA' },
                  { key: 'sports',   label: t('live.catSports')   || 'Esportes',    color: '#F97316' },
                  { key: 'learning', label: t('live.catLearning') || 'Aprendizado', color: '#10B981' },
                ].map(c => {
                  const active = liveCategory === c.key;
                  return (
                    <TouchableOpacity
                      key={c.key || 'general'}
                      onPress={() => setLiveCategory(c.key)}
                      style={[
                        styles.preCatPill,
                        active && { backgroundColor: c.color, borderColor: c.color },
                      ]}
                      activeOpacity={0.85}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={c.label}
                    >
                      <Text style={[styles.preCatPillText, active && { color: '#fff', fontWeight: '800' }]}>
                        {c.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            {/* Subscriber-only toggle — gates the live so only viewers with
                an active subscription to this host can join. Backend
                enforces in live_discover + the host could also call
                live_set_category to flip mid-stream. */}
            <TouchableOpacity
              onPress={() => setSubscribersOnly(s => !s)}
              style={styles.preSubRow}
              activeOpacity={0.85}
              accessibilityRole="switch"
              accessibilityState={{ checked: subscribersOnly }}
              accessibilityLabel={t('live.subscribersOnly') || 'Só assinantes'}
            >
              <View style={styles.preSubLabel}>
                <Text style={styles.preSubLabelText}>{t('live.subscribersOnly') || 'Só assinantes'}</Text>
                <Text style={styles.preSubHint}>{t('live.subscribersOnlyHint') || 'Bloqueia entrada de quem não te assina'}</Text>
              </View>
              <View style={[styles.preSubSwitch, subscribersOnly && styles.preSubSwitchOn]}>
                <View style={[styles.preSubKnob, subscribersOnly && styles.preSubKnobOn]} />
              </View>
            </TouchableOpacity>

            {/* Multistream + Schedule row — wave 16 (2026-05-17). Twin
                actions to configure RTMP fan-out and pre-announce the live. */}
            <View style={styles.preExtrasRow}>
              <TouchableOpacity
                onPress={() => { setMultistreamOpen(true); loadMultistreamDests(); }}
                style={styles.preExtraBtn}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={t('live.multistream') || 'Multistream'}
              >
                <Text style={styles.preExtraBtnIcon}>🔁</Text>
                <Text style={styles.preExtraBtnText} numberOfLines={1}>
                  {t('live.multistream') || 'Multistream'}
                </Text>
                {multistreamDests.length > 0 ? (
                  <View style={styles.preExtraBtnBadge}>
                    <Text style={styles.preExtraBtnBadgeText}>{multistreamDests.length}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setScheduleOpen(true)}
                style={styles.preExtraBtn}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={t('live.scheduleTitle') || 'Agendar live'}
              >
                <Text style={styles.preExtraBtnIcon}>📅</Text>
                <Text style={styles.preExtraBtnText} numberOfLines={1}>
                  {t('live.scheduleLive') || 'Agendar'}
                </Text>
              </TouchableOpacity>
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
      {/* Round 64 (2026-05-18) — translucent status bar so the host's video
          fills the notch area instead of being capped by a system-painted
          black status bar (the "mancha preta" reported on the host stage). */}
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
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
          // Android: pair with the inner SurfaceView's zOrder=1 so the
          // rounded PiP card sits cleanly ABOVE the host's full-screen
          // preview SurfaceView. Without elevation the parent's rounded
          // mask wins on the JS side but the SurfaceView punches a
          // black-square hole on the native side.
          ...(Platform.OS === 'android' ? { elevation: 6 } : null),
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
            // Round 66 — keyed remount + collapsable wrapper so the PiP card
            // doesn't paint a black hole on Android when the guest reconnects
            // (single-hole-per-window rule means the recycled SurfaceView
            // loses its overlay flag and renders solid black underneath).
            <View collapsable={false} style={StyleSheet.absoluteFill}>
              <NativeRTCView key={guestPeer.streamUrl} streamURL={guestPeer.streamUrl} style={StyleSheet.absoluteFill} objectFit="cover" zOrder={1} />
            </View>
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
            <AvatarCircle name={user?.name || user?.email} email={user?.email} size={48} />
          </View>
          <View style={styles.hostMeta}>
            <View style={styles.liveBadge}>
              {/* Two expanding halo rings — pulse rhythm matches livePulse.
                  Halo 1 starts at scale 1, halo 2 lags via livePulse2 so the
                  outward expansion reads as a continuous wave (TikTok parity). */}
              <Animated.View
                pointerEvents="none"
                style={[styles.liveBadgeHalo, {
                  transform: [{ scale: livePulse.interpolate({ inputRange: [1, 1.5], outputRange: [1, 1.8] }) }],
                  opacity: livePulse.interpolate({ inputRange: [1, 1.5], outputRange: [0.5, 0] }),
                }]}
              />
              <Animated.View
                pointerEvents="none"
                style={[styles.liveBadgeHalo, {
                  transform: [{ scale: livePulse.interpolate({ inputRange: [1, 1.5], outputRange: [1.2, 2.2] }) }],
                  opacity: livePulse.interpolate({ inputRange: [1, 1.5], outputRange: [0.35, 0] }),
                }]}
              />
              <Animated.View style={[styles.liveBadgeDot, {
                transform: [{ scale: livePulse }],
                opacity: livePulse.interpolate({ inputRange: [1, 1.5], outputRange: [1, 0.6] }),
              }]} />
              <Text style={styles.liveBadgeText}>LIVE</Text>
            </View>
            {/* Round 66 (2026-05-18) issue #5 — tap the "N assistindo" pill
                to open the Insights/viewers BottomSheet. Before this, the pill
                was a plain <View> (no tap surface) and the only way to see who
                joined was the bottom-left insights pill. Now both surfaces open
                the same sheet — TikTok/Instagram parity. */}
            <TouchableOpacity
              onPress={() => setInsightsOpen(true)}
              activeOpacity={0.7}
              style={styles.viewerPill}
              accessibilityRole="button"
              accessibilityLabel={t('live.openViewersList') || 'Abrir lista de espectadores'}
            >
              <View style={styles.viewerDot} />
              {/* AnimatedViewerCount drives the smooth 0→N tween + small
                  pulse on increase. Replaces the static Animated.Text that
                  was only bouncing via viewerBounce; formatCount inside
                  the component handles the "k"/"M" formatting. */}
              <AnimatedViewerCount count={viewerCount} style={styles.viewerCountText} />
              <Text style={styles.viewerWatchText}>{t('live.watching') || 'assistindo'}</Text>
            </TouchableOpacity>
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

      {/* Top gifters — stacked avatars top-right under the topbar. Sits
          below the close/end-live button + above the chat overlay. Bumps
          its internal refreshKey whenever a live_gift WS event lands so
          the leaderboard stays current without polling-only lag. */}
      {sessionId ? (
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            top: insets.top + 64,
            right: 12,
            zIndex: 25,
          }}
        >
          <LiveTopGifters
            sessionId={sessionId}
            refreshKey={giftRefreshKey}
            i18n={{
              topGifters: t('live.topGifters') || 'Top gifters',
              noGiftersYet: t('live.noGiftersYet') || 'Ninguém enviou presentes ainda',
              noGiftersHint: t('live.noGiftersHint') || 'Os apoiadores aparecem aqui',
            }}
          />
        </View>
      ) : null}

      {/* Gift animation overlay — center-screen card that pops in when
          a `live_gift` WS event arrives. Uses a key derived from the
          incoming event so React mounts a fresh animation each time. */}
      {activeGiftAnim ? (
        <LiveGiftAnimation
          key={activeGiftAnim.key}
          gift={activeGiftAnim}
          onComplete={() => {
            // Drain queue: if more gifts arrived during the last animation,
            // play the oldest next; otherwise clear the overlay.
            const next = pendingGiftsRef.current.shift();
            setActiveGiftAnim(next || null);
          }}
          i18n={{
            sentGift: t('live.sentGift') || 'enviou',
            gift_rose: t('live.gift_rose') || 'Rosa',
            gift_heart: t('live.gift_heart') || 'Coração',
            gift_star: t('live.gift_star') || 'Estrela',
            gift_crown: t('live.gift_crown') || 'Coroa',
            gift_fire: t('live.gift_fire') || 'Fogo',
            gift_rocket: t('live.gift_rocket') || 'Foguete',
          }}
        />
      ) : null}

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
                // Clear the persisted pin so re-joiners don't re-see it.
                if (sessionIdRef.current) {
                  api.chatLiveUnpinComment(sessionIdRef.current).catch(() => {});
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
          collide with the chat overlay.
          Round 2026-05-18 polish — collapsed by default (single chevron pill).
          Host taps chevron to expand; tap again to collapse. Keeps the stage
          clean so the camera reads as the hero. The cumulative heart counter
          + chevron stay visible at all times. */}
      <View style={[styles.rightStack, { bottom: insets.bottom + 200 }]} pointerEvents="box-none">
        {/* Cumulative heart counter — TikTok pattern: tiny heart + formatted
            total ("❤️ 4.2K") sits above the action buttons so the host sees
            love accumulate in real time. Reads from totalLikes (kept in sync
            via WS live_heart events). */}
        <View style={styles.heartCounterPill} pointerEvents="none">
          <IconHeart size={12} color={LIVE_RED} />
          <Text style={styles.heartCounterTextV2} numberOfLines={1}>
            {formatViewerCount(totalLikes)}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => {
            try { Haptics.selectionAsync().catch(() => {}); } catch {}
            setRightStackOpen(v => !v);
          }}
          style={[styles.rightBtn, styles.rightStackToggle]}
          activeOpacity={0.7}
          accessibilityLabel={rightStackOpen
            ? (t('live.collapseActions') || 'Recolher ações')
            : (t('live.expandActions') || 'Expandir ações')}
          accessibilityRole="button"
          accessibilityState={{ expanded: rightStackOpen }}
        >
          {rightStackOpen
            ? <IconChevronRight size={18} color="#fff" />
            : <IconChevronDown size={18} color="#fff" />}
        </TouchableOpacity>
        {rightStackOpen ? (
        <TouchableOpacity
          onPress={() => setSettingsOpen(true)}
          style={styles.rightBtn}
          activeOpacity={0.7}
          accessibilityLabel={t('live.settings') || 'Settings'}
          accessibilityRole="button"
        >
          <IconSettings size={18} color="#fff" />
        </TouchableOpacity>
        ) : null}
        {rightStackOpen ? (
        <TouchableOpacity
          onPress={() => { setEffectsOn(v => !v); setEffectsOpen(true); }}
          style={[styles.rightBtn, effectsOn && styles.rightBtnActiveEffects]}
          activeOpacity={0.7}
          accessibilityLabel={t('live.effects') || 'Effects'}
          accessibilityRole="button"
        >
          <IconSparkles size={18} color={effectsOn ? '#facc15' : '#fff'} />
        </TouchableOpacity>
        ) : null}
        {rightStackOpen ? (
        <TouchableOpacity
          onPress={() => setFilterOpen(true)}
          style={[styles.rightBtn, activeFilter !== 'none' && styles.rightBtnActiveFilter]}
          activeOpacity={0.7}
          accessibilityLabel={t('live.filter') || 'Filter'}
          accessibilityRole="button"
        >
          <IconFilter size={18} color={activeFilter !== 'none' ? '#facc15' : '#fff'} />
        </TouchableOpacity>
        ) : null}
        {/* AR/Beauty/Greenscreen carousel — wave 16 (2026-05-17). 8 presets
            (dog ears, sunglasses, hearts, beauty smooth, slim face, blur bg,
            greenscreen 6 wallpapers). Native MediaPipe pipeline owns the
            actual effect; this button just toggles the carousel sheet.
            Round 2026-05-18 — switched the raw "AR" text label for IconBrush
            so the button stays consistent with the rest of the SVG iconography
            (design rule: no raw text in icon buttons). */}
        {rightStackOpen ? (
        <TouchableOpacity
          onPress={() => setArCarouselOpen(v => !v)}
          style={[styles.rightBtn, activeARFilter !== 'none' && styles.rightBtnActiveAr]}
          activeOpacity={0.7}
          accessibilityLabel={t('live.arFilters') || 'AR Filters'}
          accessibilityRole="button"
        >
          <IconBrush size={18} color={activeARFilter !== 'none' ? '#facc15' : '#fff'} />
        </TouchableOpacity>
        ) : null}
        {rightStackOpen ? (
        <TouchableOpacity
          // Bug #978-6 — surface a clear confirmation when toggling. Before
          // the only feedback was the icon swap (Star ↔ StarFilled) which the
          // host often missed if they were watching the video. Now we fire a
          // ToastAndroid / Alert with the new state so the choice registers,
          // and we note the 7-day TTL so the host knows what to expect.
          onPress={() => {
            setSaveReplay(v => {
              const next = !v;
              try {
                const { ToastAndroid, Alert } = require('react-native');
                const msg = next
                  ? (t('live.saveReplayOn') || 'Replay será salvo por 7 dias')
                  : (t('live.saveReplayOff') || 'Replay não será salvo');
                if (Platform.OS === 'android' && ToastAndroid?.show) {
                  ToastAndroid.show(msg, ToastAndroid.SHORT);
                } else if (Platform.OS === 'ios' && Alert?.alert) {
                  // iOS gets a tiny non-blocking note via the existing system
                  // chip stack? Fall back to Alert for now — at least it's
                  // unambiguous.
                  Alert.alert(t('live.saveReplay') || 'Salvar replay', msg);
                }
              } catch {}
              return next;
            });
          }}
          style={[styles.rightBtn, saveReplay && styles.rightBtnActiveSave]}
          activeOpacity={0.7}
          accessibilityLabel={t('live.saveReplay') || 'Save replay'}
          accessibilityRole="button"
          accessibilityState={{ checked: saveReplay }}
        >
          {saveReplay
            ? <IconBookmarkFilled size={20} color="#fbbf24" />
            : <IconBookmark size={20} color="#fff" />}
        </TouchableOpacity>
        ) : null}
        {rightStackOpen ? (
        <TouchableOpacity
          onPress={pinLatestComment}
          style={styles.rightBtn}
          activeOpacity={0.7}
          accessibilityLabel={t('live.pinComment') || 'Pin latest'}
          accessibilityRole="button"
        >
          <IconPin size={18} color="#fff" />
        </TouchableOpacity>
        ) : null}
        {/* Poll button — opens the create-poll modal. Highlighted when an
            active poll is on-screen (host can tap to jump to its overlay /
            close it from there). Round 2026-05-18 — swapped the raw
            "POLL"/"FIM" text for IconBarChart so the rail stays consistent
            with the rest of the SVG iconography. The closed/active state
            is now signaled via background tint instead of label swap. */}
        {rightStackOpen ? (
        <TouchableOpacity
          onPress={() => { if (activePoll && !activePoll.closed) { closeActivePoll(); } else { openPollDraft(); } }}
          style={[styles.rightBtn, activePoll && !activePoll.closed && styles.rightBtnActivePoll]}
          activeOpacity={0.7}
          accessibilityLabel={t('live.poll') || 'Enquete'}
          accessibilityRole="button"
        >
          <IconBarChart size={18} color={activePoll && !activePoll.closed ? '#facc15' : '#fff'} />
        </TouchableOpacity>
        ) : null}
        {rightStackOpen ? (
        <TouchableOpacity
          onPress={handleFlipCamera}
          style={styles.rightBtn}
          activeOpacity={0.7}
          accessibilityLabel={t('live.flipCamera') || 'Flip camera'}
          accessibilityRole="button"
        >
          <IconCameraFlip size={18} color="#fff" />
        </TouchableOpacity>
        ) : null}
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
        // Reuse stable drift cached on the heart object (set at spawn). The
        // old code re-randomized inside interpolate, which produced jitter
        // on every render frame the parent re-rendered.
        const translateY = h.anim.interpolate({ inputRange: [0, 1], outputRange: [0, -260] });
        const scale = h.anim.interpolate({ inputRange: [0, 0.15, 0.5, 0.85, 1], outputRange: [0.5, 1.2, 1.05, 0.95, 0.8] });
        const opacity = h.anim.interpolate({ inputRange: [0, 0.1, 0.8, 1], outputRange: [0, 1, 1, 0] });
        const translateX = h.anim.interpolate({ inputRange: [0, 1], outputRange: [0, h.drift || 0] });
        const rotate = h.anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['0deg', '12deg', '-8deg'] });

        return (
          <Animated.View
            key={h.id}
            style={[styles.heart, {
              left: h.x - 14,
              top: h.y - 14,
              transform: [{ translateY }, { translateX }, { scale }, { rotate }],
              opacity,
            }]}
            pointerEvents="none"
          >
            <IconHeart size={28} color={h.color || LIVE_RED} />
            {h.reactor?.email ? (
              <View style={styles.heartAvatarChip}>
                <AvatarCircle name={h.reactor.name} email={h.reactor.email} size={18} />
              </View>
            ) : null}
          </Animated.View>
        );
      })}

      {/* AR filter carousel — wave 16 (2026-05-17). Horizontal scroll of 8
          preset chips. Bottom row, above mic/cam controls. Tap to apply; the
          native MediaPipe pipeline (modules/expo-live-native) renders the
          effect onto the LK publish track. Greenscreen has 6 sub-wallpapers
          which appear as a 2nd row when greenscreen is the active preset. */}
      {arCarouselOpen ? (
        <View style={[styles.arCarouselWrap, { bottom: insets.bottom + 280 }]} pointerEvents="box-none">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}
          >
            {/* Round 2026-05-18 — replaced emoji icons with SVG-based glyphs
                (design rule from MEMORY: "NUNCA emoji em UI"). The carousel
                now reads as a curated brand surface instead of an Android
                emoji palette dump. Each preset gets a tinted gradient bubble
                + a single-letter monogram (or an SVG when available). */}
            {[
              { key: 'none',        glyph: '✕',  tint: 'rgba(148,163,184,0.35)', label: t('live.arNone')        || 'Nenhum' },
              { key: 'dog',         glyph: 'D',  tint: 'rgba(251,146,60,0.45)',  label: t('live.arDogEars')     || 'Cachorro' },
              { key: 'sunglasses',  glyph: 'S',  tint: 'rgba(56,189,248,0.45)',  label: t('live.arSunglasses')  || 'Óculos' },
              { key: 'hearts',      glyph: '♥',  tint: 'rgba(244,114,182,0.55)', label: t('live.arHearts')      || 'Corações' },
              { key: 'beauty',      svg: 'sparkles', tint: 'rgba(250,204,21,0.45)', label: t('live.arBeauty')   || 'Suavizar' },
              { key: 'slim',        glyph: '◊',  tint: 'rgba(168,85,247,0.45)',  label: t('live.arSlimFace')    || 'Afinar' },
              { key: 'blur',        glyph: '◐',  tint: 'rgba(99,102,241,0.45)',  label: t('live.arBlurBg')      || 'Desfocar' },
              { key: 'greenscreen', glyph: '▣',  tint: 'rgba(34,197,94,0.45)',   label: t('live.arGreenscreen') || 'Cenário' },
            ].map(p => {
              const active = activeARFilter === p.key;
              return (
                <TouchableOpacity
                  key={p.key}
                  onPress={() => {
                    try { Haptics.selectionAsync().catch(() => {}); } catch {}
                    applyArFilter(p.key);
                  }}
                  style={[styles.arChip, active && styles.arChipActive]}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel={p.label}
                  accessibilityState={{ selected: active }}
                >
                  <View style={[styles.arChipGlyphBubble, { backgroundColor: p.tint }, active && styles.arChipGlyphBubbleActive]}>
                    {p.svg === 'sparkles'
                      ? <IconSparkles size={18} color="#fff" />
                      : <Text style={styles.arChipGlyph}>{p.glyph}</Text>}
                  </View>
                  <Text style={[styles.arChipLabel, active && { color: '#fff', fontWeight: '800' }]} numberOfLines={1}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          {activeARFilter === 'greenscreen' ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 12, gap: 6, paddingTop: 6 }}
            >
              {[1, 2, 3, 4, 5, 6].map(wid => {
                const active = arWallpaper === wid;
                return (
                  <TouchableOpacity
                    key={wid}
                    onPress={() => applyArFilter('greenscreen', wid)}
                    style={[styles.arWallpaperChip, active && { borderColor: '#ec4899', borderWidth: 2 }]}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={(t('live.arWallpaper') || 'Cenário') + ' ' + wid}
                  >
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{wid}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          ) : null}
        </View>
      ) : null}

      {/* Multistream "Transmitindo para N" pill — bottom-left of top bar.
          Only renders when at least one destination is in `live` status. */}
      {multistreamDests.filter(d => d.status === 'live').length > 0 ? (
        <View style={[styles.multistreamPill, { top: insets.top + 64 }]} pointerEvents="none">
          <View style={styles.multistreamPillDot} />
          <Text style={styles.multistreamPillText}>
            {(t('live.multistreamingTo') || 'Transmitindo para').replace('{n}', String(multistreamDests.filter(d => d.status === 'live').length))}
            {' '}
            {multistreamDests.filter(d => d.status === 'live').length}
            {' '}
            {(t('live.destinations') || 'destinos')}
          </Text>
        </View>
      ) : null}

      {/* Bottom: scrolling chat overlay (bottom→up, fades at top), composer
          row with invite pill + text input + heart + share + flip. */}
      <View style={styles.bottomArea} pointerEvents="box-none">
        {/* Round 69 (2026-05-19) — Don't reserve the 200-tall chat strip
            (and don't render the TopFadeGradient #000 @85% SVG inside it)
            when chat is empty. The empty area + the gradient was painting
            an opaque black band ~50% of screen height across the host's
            face when broadcasting solo. THIS was the recurring "barra
            preta" bug — not the camera surface, not cohost grid. */}
        <View style={[styles.chatScrollWrap, chatMessages.length === 0 && { height: 0 }]} pointerEvents="box-none">
          {/* TikTok-grade comments overlay (round 921). Same component the
              viewer uses, with host-side long-press → pin/remove and the
              colored-chip tier system (host=purple, gift=gold, guest=cyan).
              Older lines fade via gradient mask + per-row stack-alpha; new
              lines spring up from below. */}
          {hideChat || chatMessages.length === 0 ? null : (
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
            onPress={() => {
              try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); } catch {}
              handleSelfHeart();
            }}
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
            onPress={() => {
              try { Haptics.selectionAsync().catch(() => {}); } catch {}
              handleToggleMute();
            }}
            style={[styles.composerIconBtn, audioMuted && styles.composerIconBtnActive, !audioMuted && styles.composerIconBtnMicLive]}
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
          viewers, likes) and the Save Replay toggle before tearing down.
          Confetti particles drift behind the card so the host gets a small
          "good job" payoff for the broadcast they just wrapped (TikTok parity).
       */}
      {endModal ? (
        <View style={styles.endModalBackdrop}>
          <EndLiveConfetti />
          <View style={styles.endModalCard}>
            <View style={styles.endModalHeader}>
              <View style={styles.endModalLiveDot} />
              <Text style={styles.endModalTitle}>{t('live.endLiveQ') || 'Encerrar transmissão?'}</Text>
            </View>
            <Text style={styles.endModalSubtitle}>
              {t('live.endConfirm2') || 'Os espectadores serão desconectados.'}
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
                <Text style={styles.endModalCancelText}>{t('common.cancel') || 'Cancelar'}</Text>
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

            {/* Slow-mode picker — opens an ActionSheet (iOS) or sub-Modal
                (Android). Subtitle reflects the current cooldown so the
                host can verify it's on without re-opening the picker. */}
            <TouchableOpacity onPress={() => { setSettingsOpen(false); setTimeout(openSlowModePicker, Platform.OS === 'ios' ? 250 : 0); }} style={liveSheetStyles.row} activeOpacity={0.7}>
              <View style={{ flex: 1 }}>
                <Text style={liveSheetStyles.rowLabel}>{t('live.slowMode') || 'Modo lento'}</Text>
                <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 2 }}>
                  {slowModeSeconds > 0
                    ? ((t('live.slowModeEvery') || 'Comentário a cada {n}s').replace('{n}', String(slowModeSeconds)))
                    : (t('live.slowModeOff') || 'Desligado')}
                </Text>
              </View>
              <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 18 }}>›</Text>
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

      {/* Join requests pill — Instagram-style "Pedidos" chip pinned at right:16
          top:100 (relative to insets) with a small red badge bubble showing
          the pending count. Brand-purple body keeps it as the dominant CTA
          without screaming red — the count badge handles urgency. */}
      {joinRequests.length > 0 ? (
        <TouchableOpacity
          onPress={() => setRequestsOpen(true)}
          activeOpacity={0.85}
          style={{
            position: 'absolute', top: insets.top + 100, right: 16,
            backgroundColor: '#7C3AED', borderRadius: 16,
            paddingHorizontal: 12, paddingVertical: 8,
            flexDirection: 'row', alignItems: 'center', gap: 6,
            zIndex: 30,
            ...(Platform.OS === 'web' ? {
              boxShadow: '0 4px 14px rgba(124,58,237,0.5)',
            } : {}),
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
            {t('live.colabRequest') || 'pra colab'}
          </Text>
          {/* Red count badge — TikTok pattern: small bubble in the top-right
              corner of the chip so the host immediately sees "how many waiting". */}
          <View style={{
            position: 'absolute',
            top: -4, right: -4,
            minWidth: 18, height: 18,
            paddingHorizontal: 5,
            borderRadius: 9,
            backgroundColor: LIVE_RED,
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 1.5, borderColor: '#fff',
          }}>
            <Text style={{
              color: '#fff', fontWeight: '900', fontSize: 10,
              fontVariant: ['tabular-nums'],
            }}>
              {joinRequests.length > 99 ? '99+' : joinRequests.length}
            </Text>
          </View>
        </TouchableOpacity>
      ) : null}

      {/* Stage 3 of #929 — cohost PiP grid. Up to 4 approved cohosts publishing
          into the LK room render as a 2×2 grid (TikTok parity for multi-guest
          colab). flexWrap + row direction = items reflow to a new line every
          two cards. gap:8 between rows AND columns. Stage 4 will replace this
          with a proper compositor that re-layouts host + cohorts together.

          Round 66 (2026-05-18) issue #2 — dedup against guestPeer. When a
          viewer is approved, BOTH the legacy P2P path (renders as the small
          PiP card above with `guestPeer`) AND the LK SFU path
          (renders here in cohostParticipants) fire — so the same person
          appears twice on the host's stage ("aparece a mesma duplicada na
          grid"). Filter out any LK participant whose identity matches the
          current guestPeer.email; the P2P PiP wins because it's already
          on-screen and has the kick (×) affordance. */}
      {(() => {
        const guestEmailNorm = String(guestPeer?.email || '').toLowerCase();
        const dedupedCohosts = guestEmailNorm
          ? cohostParticipants.filter(p => String(p.identity || '').toLowerCase() !== guestEmailNorm)
          : cohostParticipants;
        if (dedupedCohosts.length === 0) return null;
        return (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            right: 8,
            top: insets.top + 110,
            width: 200, // 2 × 96 + gap 8 → wraps after 2 cards
            zIndex: 25,
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
            justifyContent: 'flex-end',
          }}
        >
          {dedupedCohosts.slice(0, 4).map((p) => {
            // Lazy resolve VideoView from livekit react-native at render
            // time so the import is gated to the actually-attached track.
            let VV = null;
            try {
              if (Platform.OS !== 'web') {
                VV = require('@livekit/react-native').VideoView;
              }
            } catch {}
            // Bind the native mount lifecycle to the underlying track sid so
            // a reconnecting cohost (new SID) gets a fresh SurfaceView. The
            // old SurfaceView would otherwise stick around half-detached and
            // paint as a black square ("mancha preta") on Android.
            const vvKey = `${p.identity}:${p.videoTrack?.sid || 'notrack'}`;
            return (
              <View
                key={p.identity}
                style={{
                  width: 96,
                  height: 128,
                  borderRadius: 12,
                  overflow: 'hidden',
                  backgroundColor: '#000',
                  borderWidth: 2,
                  borderColor: LIVE_RED,
                  // Android: elevation lifts this card above the host's
                  // full-screen SurfaceView so the rounded card mask renders
                  // without a black square punch-through. zIndex alone is
                  // ignored when a SurfaceView is involved.
                  ...(Platform.OS === 'android' ? { elevation: 6 } : null),
                }}
              >
                {VV && p.videoTrack ? (
                  // zOrder=1 → setZOrderMediaOverlay(true) on the underlying
                  // SurfaceView. Required because the host's own camera
                  // preview already owns the default window hole at zOrder=0.
                  // Two SurfaceViews at the same z-order = the second paints
                  // black on Android (single-hole-per-window rule).
                  <VV
                    key={vvKey}
                    style={StyleSheet.absoluteFill}
                    videoTrack={p.videoTrack}
                    zOrder={1}
                  />
                ) : (
                  <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
                    <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }} numberOfLines={1}>
                      {p.name || (t('live.connecting') || 'Conectando…')}
                    </Text>
                  </View>
                )}
                <View style={{
                  position: 'absolute', bottom: 4, left: 4, right: 4,
                  backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 4,
                  paddingHorizontal: 4, paddingVertical: 2,
                }}>
                  <Text style={{ color: '#fff', fontSize: 9, fontWeight: '700' }} numberOfLines={1}>
                    {p.name?.split('@')[0] || p.identity?.split('@')[0]}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
        );
      })()}

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

      {/* Multistream sheet — host adds RTMP destinations (YouTube/Twitch/FB).
          Backend persists in chat_live_multistream_destinations and calls
          LK StartRoomCompositeEgress if the broadcast is live. */}
      {multistreamOpen ? (
        <View style={liveSheetStyles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setMultistreamOpen(false)} />
          <View style={[liveSheetStyles.sheet, { paddingBottom: insets.bottom + 16, maxHeight: '85%' }]}>
            <View style={liveSheetStyles.grabber} />
            <Text style={liveSheetStyles.title}>{t('live.multistream') || 'Multistream'}</Text>
            <Text style={liveSheetStyles.subtitle}>
              {t('live.multistreamHint') || 'Transmita simultaneamente para YouTube, Twitch e Facebook'}
            </Text>
            {multistreamDests.length > 0 ? (
              <View style={{ marginTop: 8, marginBottom: 12 }}>
                {multistreamDests.map(d => (
                  <View key={d.id} style={styles.multistreamDestRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.multistreamDestLabel} numberOfLines={1}>
                        {d.label || d.rtmp_url}
                      </Text>
                      <Text style={styles.multistreamDestStatus}>
                        {d.status === 'live'
                          ? (t('live.multistreamLive') || 'Transmitindo')
                          : (t('live.multistreamReady') || 'Pronto')}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => removeMultistreamDest(d.id)}
                      style={styles.multistreamDestRemove}
                      activeOpacity={0.7}
                      accessibilityLabel={t('common.remove') || 'Remover'}
                    >
                      <IconX size={14} color="rgba(255,255,255,0.8)" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : null}
            <Text style={[liveSheetStyles.subtitle, { marginTop: 8 }]}>
              {t('live.multistreamAddTitle') || 'Adicionar destino'}
            </Text>
            <TextInput
              value={multistreamForm.label}
              onChangeText={(v) => setMultistreamForm(f => ({ ...f, label: v }))}
              placeholder={t('live.multistreamLabel') || 'Nome (ex: YouTube)'}
              placeholderTextColor="rgba(255,255,255,0.45)"
              style={styles.multistreamInput}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextInput
              value={multistreamForm.rtmpUrl}
              onChangeText={(v) => setMultistreamForm(f => ({ ...f, rtmpUrl: v }))}
              placeholder="rtmp://a.rtmp.youtube.com/live2"
              placeholderTextColor="rgba(255,255,255,0.45)"
              style={styles.multistreamInput}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <TextInput
              value={multistreamForm.streamKey}
              onChangeText={(v) => setMultistreamForm(f => ({ ...f, streamKey: v }))}
              placeholder={t('live.multistreamKey') || 'Chave de transmissão'}
              placeholderTextColor="rgba(255,255,255,0.45)"
              style={styles.multistreamInput}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <TouchableOpacity
              onPress={addMultistreamDest}
              disabled={multistreamSaving || !multistreamForm.rtmpUrl || !multistreamForm.streamKey}
              style={[liveSheetStyles.closeBtn, (multistreamSaving || !multistreamForm.rtmpUrl || !multistreamForm.streamKey) && { opacity: 0.5 }]}
              activeOpacity={0.85}
            >
              <Text style={liveSheetStyles.closeText}>
                {multistreamSaving ? (t('common.saving') || 'Salvando...') : (t('live.multistreamAddBtn') || 'Adicionar destino')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* Schedule live sheet — pre-screen modal. Date+time picker + button. */}
      {scheduleOpen ? (
        <View style={liveSheetStyles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setScheduleOpen(false)} />
          <View style={[liveSheetStyles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={liveSheetStyles.grabber} />
            <Text style={liveSheetStyles.title}>{t('live.scheduleTitle') || 'Agendar live'}</Text>
            <Text style={liveSheetStyles.subtitle}>
              {t('live.scheduleHint') || 'Seguidores recebem lembrete 15 min antes e no início.'}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              <TextInput
                value={scheduleDate.toISOString().slice(0, 10)}
                onChangeText={(v) => {
                  const parts = v.split('-').map(p => parseInt(p, 10));
                  if (parts.length === 3 && parts.every(n => !isNaN(n))) {
                    const d = new Date(scheduleDate);
                    d.setFullYear(parts[0], parts[1] - 1, parts[2]);
                    setScheduleDate(d);
                  }
                }}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={[styles.multistreamInput, { flex: 1 }]}
                autoCapitalize="none"
              />
              <TextInput
                value={scheduleDate.toTimeString().slice(0, 5)}
                onChangeText={(v) => {
                  const parts = v.split(':').map(p => parseInt(p, 10));
                  if (parts.length === 2 && parts.every(n => !isNaN(n))) {
                    const d = new Date(scheduleDate);
                    d.setHours(parts[0], parts[1], 0, 0);
                    setScheduleDate(d);
                  }
                }}
                placeholder="HH:MM"
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={[styles.multistreamInput, { flex: 1 }]}
                autoCapitalize="none"
              />
            </View>
            <Text style={[liveSheetStyles.subtitle, { marginTop: 8 }]}>
              {scheduleDate.toLocaleString()}
            </Text>
            <TouchableOpacity
              onPress={saveScheduledLive}
              disabled={scheduleSaving}
              style={[liveSheetStyles.closeBtn, scheduleSaving && { opacity: 0.5 }]}
              activeOpacity={0.85}
            >
              <Text style={liveSheetStyles.closeText}>
                {scheduleSaving ? (t('common.saving') || 'Salvando...') : (t('live.scheduleSave') || 'Agendar')}
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
        // Bug #978-1 fix — "quem tá assistindo" view shouldn't block the live.
        // The shared liveSheetStyles.backdrop uses rgba(0,0,0,0.5) which fully
        // darkens the broadcast underneath. For the Insights/viewers sheet the
        // host wants to keep filming while glancing at the list — so we drop
        // the alpha to 0.18 (just enough to make sheet copy readable). The
        // sheet itself stays opaque so text is sharp.
        <View style={[liveSheetStyles.backdrop, { backgroundColor: 'rgba(0,0,0,0.18)' }]}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setInsightsOpen(false)} />
          <View style={[liveSheetStyles.sheet, { paddingBottom: insets.bottom + 16, maxHeight: '55%' }]}>
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
                  <TouchableOpacity
                    onLongPress={() => openViewerActions(item)}
                    delayLongPress={350}
                    activeOpacity={0.7}
                    style={styles.insightsJoinRow}
                    accessibilityHint={t('live.longPressModerate') || 'Pressione para moderar'}
                  >
                    <AvatarCircle name={item.name} email={item.email} size={32} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={styles.insightsJoinName} numberOfLines={1}>{item.name}</Text>
                      <Text style={styles.insightsJoinEmail} numberOfLines={1}>{item.email}</Text>
                    </View>
                  </TouchableOpacity>
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

      {/* Active poll overlay — host always sees results + close button.
          Positioned just below the top bar / pinned chip area so it doesn't
          collide with the chat overlay along the bottom. */}
      {activePoll ? (
        <View
          pointerEvents="box-none"
          style={{ position: 'absolute', top: insets.top + 110, left: 0, right: 0, zIndex: 50 }}
        >
          <LivePollOverlay
            poll={activePoll}
            isHost
            onClose={closeActivePoll}
            i18n={{
              closeLabel: t('live.pollEnd') || 'Encerrar enquete',
              closedLabel: t('live.pollClosedLabel') || 'Enquete encerrada',
              votes: t('live.pollVotes') || 'votos',
              poll: t('live.poll') || 'Enquete',
              votedLabel: t('live.pollVoted') || 'Você votou',
              dismiss: t('common.dismiss') || 'Dispensar',
            }}
          />
        </View>
      ) : null}

      {/* Poll create modal — minimal: question + 2-4 options. */}
      <Modal visible={pollDraftOpen} transparent animationType="slide" onRequestClose={() => setPollDraftOpen(false)}>
        <View style={liveSheetStyles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setPollDraftOpen(false)} />
          <View style={[liveSheetStyles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={liveSheetStyles.grabber} />
            <Text style={liveSheetStyles.title}>{t('live.pollCreate') || 'Criar enquete'}</Text>

            <View style={{ backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 }}>
              <TextInput
                value={pollDraftQuestion}
                onChangeText={setPollDraftQuestion}
                placeholder={t('live.pollQuestionHint') || 'Pergunta...'}
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={{ color: '#fff', fontSize: 15, padding: 0 }}
                maxLength={200}
              />
            </View>

            {pollDraftOptions.map((opt, idx) => (
              <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 }}>
                  <TextInput
                    value={opt}
                    onChangeText={(txt) => {
                      setPollDraftOptions(prev => prev.map((o, i) => i === idx ? txt : o));
                    }}
                    placeholder={(t('live.pollOptionN') || 'Opção {n}').replace('{n}', String(idx + 1))}
                    placeholderTextColor="rgba(255,255,255,0.45)"
                    style={{ color: '#fff', fontSize: 14, padding: 0 }}
                    maxLength={80}
                  />
                </View>
                {pollDraftOptions.length > 2 ? (
                  <TouchableOpacity
                    onPress={() => setPollDraftOptions(prev => prev.filter((_, i) => i !== idx))}
                    style={{ marginLeft: 8, padding: 8 }}
                  >
                    <IconX size={16} color="rgba(255,255,255,0.6)" />
                  </TouchableOpacity>
                ) : null}
              </View>
            ))}

            {pollDraftOptions.length < 4 ? (
              <TouchableOpacity
                onPress={() => setPollDraftOptions(prev => [...prev, ''])}
                style={{ paddingVertical: 10, marginBottom: 8 }}
              >
                <Text style={{ color: '#a78bfa', fontWeight: '700', fontSize: 13 }}>
                  + {t('live.pollAddOption') || 'Adicionar opção'}
                </Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity onPress={submitPollDraft} style={liveSheetStyles.closeBtn} activeOpacity={0.85}>
              <Text style={liveSheetStyles.closeText}>{t('live.pollStart') || 'Iniciar enquete'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Android slow-mode picker — ActionSheetIOS is iOS-only so we render
          a custom Modal on Android for parity. iOS path skips this entirely. */}
      <Modal visible={slowModeOpenAndroid} transparent animationType="slide" onRequestClose={() => setSlowModeOpenAndroid(false)}>
        <View style={liveSheetStyles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setSlowModeOpenAndroid(false)} />
          <View style={[liveSheetStyles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={liveSheetStyles.grabber} />
            <Text style={liveSheetStyles.title}>{t('live.slowModeTitle') || 'Modo lento'}</Text>
            {[
              { sec: 0, label: t('live.slowModeOff') || 'Desligado' },
              { sec: 5, label: '5s' },
              { sec: 15, label: '15s' },
              { sec: 30, label: '30s' },
              { sec: 60, label: t('live.slowMode1min') || '1 min' },
            ].map(o => (
              <TouchableOpacity
                key={o.sec}
                onPress={() => { setSlowModeOpenAndroid(false); applySlowMode(o.sec); }}
                style={liveSheetStyles.row}
                activeOpacity={0.7}
              >
                <Text style={liveSheetStyles.rowLabel}>{o.label}</Text>
                {slowModeSeconds === o.sec ? <Text style={{ color: '#a78bfa', fontWeight: '800' }}>✓</Text> : null}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>
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

// End-live confetti — 24 colored particles drift down + sideways behind the
// summary card, each with its own randomized x/y/rotation animation. Tiny
// payoff moment for the host wrapping a broadcast (TikTok parity). No
// external dep — pure Animated.Value loops. Particles share four brand-
// adjacent colors so the burst reads as celebratory without being chaotic.
const CONFETTI_COLORS = ['#a855f7', '#fbbf24', '#ef4444', '#22c55e', '#3b82f6'];
const CONFETTI_COUNT = 24;
function EndLiveConfetti() {
  // Build particles once on mount — each has a random start x, fall distance,
  // delay, rotation direction, and color.
  const particlesRef = useRef(
    Array.from({ length: CONFETTI_COUNT }).map((_, i) => ({
      key: `c_${i}`,
      x: Math.random() * SCREEN_W,
      delay: Math.random() * 600,
      duration: 2200 + Math.random() * 1400,
      fall: SCREEN_H * 0.6 + Math.random() * SCREEN_H * 0.3,
      drift: (Math.random() - 0.5) * 80,
      rotateDir: Math.random() > 0.5 ? 1 : -1,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      size: 6 + Math.random() * 6,
      anim: new Animated.Value(0),
    }))
  ).current;

  useEffect(() => {
    particlesRef.forEach((p) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(p.delay),
          Animated.timing(p.anim, {
            toValue: 1,
            duration: p.duration,
            useNativeDriver: true,
          }),
          Animated.timing(p.anim, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ])
      ).start();
    });
    return () => {
      particlesRef.forEach((p) => p.anim.stopAnimation());
    };
  }, [particlesRef]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {particlesRef.map((p) => {
        const translateY = p.anim.interpolate({
          inputRange: [0, 1],
          outputRange: [-20, p.fall],
        });
        const translateX = p.anim.interpolate({
          inputRange: [0, 1],
          outputRange: [0, p.drift],
        });
        const rotate = p.anim.interpolate({
          inputRange: [0, 1],
          outputRange: ['0deg', `${p.rotateDir * 540}deg`],
        });
        const opacity = p.anim.interpolate({
          inputRange: [0, 0.05, 0.85, 1],
          outputRange: [0, 1, 1, 0],
        });
        return (
          <Animated.View
            key={p.key}
            style={{
              position: 'absolute',
              left: p.x,
              top: 0,
              width: p.size,
              height: p.size * 1.6,
              borderRadius: 2,
              backgroundColor: p.color,
              opacity,
              transform: [{ translateY }, { translateX }, { rotate }],
            }}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
    // Round 67 #1158 (2026-05-18) — user still sees "barra preta" after
    // rounds #1135 + #1152. Root container was hard-pinned to '#000', so
    // anywhere the SurfaceView's punched hole didn't quite fill (notch
    // band, navigation gesture area, brief layout thrash on rotate) the
    // pure black bled through and the user read it as a literal black
    // bar. Brand off-black '#0f0f1a' (matches live-viewer's fullScreen)
    // keeps the anti-ghost backstop logic but loses the "vamp slab"
    // pure-black bands. The inner NativeRTCView wrappers still carry
    // '#000' so ghost-frame protection is unchanged where it matters
    // (clipped to the camera surface, never visible to the user).
    backgroundColor: '#0f0f1a',
    // Round 52 polish — Android SurfaceView (NativeRTCView for the host
    // camera) punches a window-hole through the view tree. overflow:hidden
    // here ensures any partial-paint glitches stay clipped to the screen
    // bounds.
    overflow: 'hidden',
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
    // Android: regular Views don't stack above a SurfaceView via zIndex.
    // `elevation` is the only knob that lifts this scrim above the live
    // camera SurfaceView when the host toggles their camera off — without
    // it the user saw the live feed flicker through ("mancha preta").
    elevation: 8,
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
    paddingBottom: 14,
    zIndex: 10,
    // Round 65 #1135 (2026-05-18) — KILLED the full-width black strip on
    // native. User screenshot showed an edge-to-edge dark band at the top
    // capping the live frame ("mancha preta amigo"). Previous attempt only
    // softened opacity (0.32) but the band was still solid full-width. Now
    // the bar is fully transparent on native — each chip (LIVE badge, viewer
    // pill, duration timer, close btn) carries its own dark backdrop, so the
    // header reads as a row of floating chips over the live video instead
    // of a horizontal band. Web keeps the subtle blur gradient (looks fine
    // in browsers where backdrop-filter actually renders glass).
    backgroundColor: 'transparent',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
      background: 'linear-gradient(to bottom, rgba(0,0,0,0.32), rgba(0,0,0,0.04))',
    } : {}),
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
  // Bumped from 44 to 56 to match TikTok's prominent host avatar — easier to
  // tap and reads as the focal point of the top bar. Pulse ring scales to 64.
  hostAvatarWrap: {
    width: 56, height: 56,
    alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  },
  hostAvatarPulseRing: {
    position: 'absolute',
    width: 64, height: 64, borderRadius: 32,
    borderWidth: 2,
    borderColor: LIVE_RED,
  },
  hostAvatarRing: {
    position: 'absolute',
    width: 52, height: 52, borderRadius: 26,
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
    gap: 16,
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
    position: 'relative',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 12px rgba(220,38,38,0.55)',
    } : {}),
  },
  // Concentric expanding halo behind the LIVE badge — sized to the badge's
  // intrinsic box (matches dot start) so it reads as the badge itself
  // pulsing outward. Two are stacked at different scales for layered wave.
  liveBadgeHalo: {
    position: 'absolute',
    left: -2, right: -2, top: -2, bottom: -2,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: LIVE_RED,
    backgroundColor: 'transparent',
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
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    alignSelf: 'flex-start',
  },
  viewerDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: LIVE_RED,
  },
  viewerCountText: {
    color: '#fff', fontSize: 13, fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  viewerWatchText: {
    color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '600',
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
    gap: 16,
    alignItems: 'center',
    zIndex: 9,
  },
  rightBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
      boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
    } : {}),
  },
  // Chevron toggle that collapses / expands the right action stack. Slightly
  // larger backdrop so it reads as the "open me" handle vs the action chips.
  rightStackToggle: {
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderColor: 'rgba(255,255,255,0.22)',
  },
  // Active-state tints — one for each surface so the host gets a clear "this
  // mode is on" cue without losing the underlying glass aesthetic. All
  // colors are taken from the brand palette (no off-brand reds/blues).
  rightBtnActiveEffects: {
    backgroundColor: 'rgba(168,85,247,0.55)',
    borderColor: 'rgba(168,85,247,0.7)',
  },
  rightBtnActiveFilter: {
    backgroundColor: 'rgba(124,58,237,0.55)',
    borderColor: 'rgba(124,58,237,0.7)',
  },
  rightBtnActiveAr: {
    backgroundColor: 'rgba(236,72,153,0.55)',
    borderColor: 'rgba(236,72,153,0.7)',
  },
  rightBtnActiveSave: {
    backgroundColor: 'rgba(250,204,21,0.4)',
    borderColor: 'rgba(250,204,21,0.6)',
  },
  rightBtnActivePoll: {
    backgroundColor: 'rgba(124,58,237,0.55)',
    borderColor: 'rgba(124,58,237,0.7)',
  },
  rightBtnIconEmoji: { fontSize: 18 },
  // Cumulative heart total above the action stack — TikTok aesthetic.
  heartCounterText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
    fontVariant: ['tabular-nums'],
  },
  // Round 2026-05-18 — heart counter now lives in a tiny glass pill with the
  // SVG IconHeart instead of a raw "♥" + text. Reads as a unit instead of two
  // floating glyphs, and the pill backdrop lifts the digits over the video.
  heartCounterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' } : {}),
  },
  heartCounterTextV2: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.2,
  },

  // Comments column (custom, replaces LiveChat in live screen)
  // Round 2026-05-18 — trimmed from 240 → 200 so the chat overlay stops
  // eating ~25% of the host's video frame. Combined with the (now collapsed)
  // right rail the stage reads as the hero again instead of a chat box.
  chatScrollWrap: {
    height: 200,
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
    maxWidth: 280,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
    } : {}),
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
    paddingHorizontal: 16,
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
  // Mic-live cue — subtle green halo + tint when the mic is hot. Mirrors the
  // "you are being heard" feedback Instagram/TikTok use so the host doesn't
  // accidentally talk on mute (or vice versa).
  composerIconBtnMicLive: {
    backgroundColor: 'rgba(34,197,94,0.22)',
    borderColor: 'rgba(34,197,94,0.55)',
  },
  heartBtn: {
    backgroundColor: 'rgba(220,38,38,0.65)',
    borderColor: 'rgba(220,38,38,0.4)',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 14px rgba(220,38,38,0.35)',
    } : {}),
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
  // ----- Pre-live category pill rail -----
  preCatRow: {
    width: '100%',
    marginTop: 14,
  },
  preCatPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  preCatPillText: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  // ----- Pre-live subscriber-only toggle row -----
  preSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: 14,
    paddingHorizontal: 4,
  },
  preSubLabel: { flexShrink: 1, paddingRight: 12 },
  preSubLabelText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  preSubHint: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 2 },
  preSubSwitch: {
    width: 44, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.18)',
    padding: 3,
  },
  preSubSwitchOn: { backgroundColor: '#F59E0B' },
  preSubKnob: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: '#fff',
  },
  preSubKnobOn: { transform: [{ translateX: 18 }] },

  // ----- Pre-screen extras row (Multistream + Schedule) -----
  preExtrasRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
    paddingHorizontal: 2,
  },
  preExtraBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  preExtraBtnIcon: { fontSize: 16 },
  preExtraBtnText: { color: '#fff', fontSize: 13, fontWeight: '700', flex: 1 },
  preExtraBtnBadge: {
    minWidth: 18, height: 18, borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: '#F59E0B',
    alignItems: 'center', justifyContent: 'center',
  },
  preExtraBtnBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  // ----- AR filter carousel -----
  arCarouselWrap: {
    position: 'absolute',
    left: 0, right: 0,
    zIndex: 9,
  },
  arChip: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1.5,
    borderColor: 'transparent',
    minWidth: 64,
  },
  // Purple gradient ring around the active filter thumbnail — TikTok's
  // signature pink→purple glow. We can't drop a real LinearGradient inline
  // without a SVG/gradient import on this hot path, so we lean on a
  // multi-color border + boxShadow (web) + a brand-purple drop shadow
  // (native) for the same visual read.
  arChipActive: {
    borderColor: '#a855f7',
    backgroundColor: 'rgba(168,85,247,0.22)',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 0 1px #ec4899, 0 0 12px rgba(168,85,247,0.6), 0 0 18px rgba(236,72,153,0.35)',
    } : {
      shadowColor: '#a855f7',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.7,
      shadowRadius: 8,
      elevation: 6,
    }),
  },
  arChipLabel: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 10,
    marginTop: 4,
    fontWeight: '600',
  },
  // Round 2026-05-18 — circular glyph bubble that replaces the raw emoji on
  // each AR preset chip. Renders an SVG icon (sparkles) or a monogram glyph.
  // Tint comes from the preset descriptor so each effect reads as its own
  // brand swatch instead of system emoji.
  arChipGlyphBubble: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  arChipGlyphBubbleActive: {
    borderColor: '#fff',
    borderWidth: 2,
  },
  arChipGlyph: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    lineHeight: 22,
    textAlign: 'center',
  },
  arWallpaperChip: {
    width: 40, height: 40, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },

  // ----- Multistream pill + sheet -----
  multistreamPill: {
    position: 'absolute',
    left: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: 'rgba(220,38,38,0.85)',
    zIndex: 30,
  },
  multistreamPillDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: '#fff',
  },
  multistreamPillText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  multistreamDestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    marginBottom: 6,
  },
  multistreamDestLabel: { color: '#fff', fontSize: 14, fontWeight: '700' },
  multistreamDestStatus: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 2 },
  multistreamDestRemove: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginLeft: 8,
  },
  multistreamInput: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    color: '#fff',
    fontSize: 14,
    marginTop: 8,
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
    // Round 52 polish — overflow:hidden as belt-and-suspenders so children
    // cannot paint outside the row width even if a flex calc rounds funny.
    overflow: 'hidden',
  },
  endCardCtaSecondary: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 13,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
  },
  endCardCtaSecondaryText: { color: '#fff', fontSize: 13, fontWeight: '700', flexShrink: 1 },
  endCardCtaPrimary: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 10,
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
  endCardCtaPrimaryText: { color: '#000', fontSize: 13, fontWeight: '800', letterSpacing: 0.2, flexShrink: 1, textAlign: 'center' },
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
