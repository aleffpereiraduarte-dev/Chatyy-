import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated,
  Dimensions, Share, Modal, Pressable, ScrollView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconX, IconHeart, IconShare, IconStar,
  IconUserPlus, IconCheck, IconRotateCcw,
} from '../components/Icons';
// Live UI primitives (round 62 redesign — extracted from inline JSX into a
// dedicated component family so the screen stays readable and each piece can
// be polished independently. WebRTC/HLS/WS logic stays in this file).
import LiveTopBar from '../components/live/LiveTopBar';
import LivePinnedChip from '../components/live/LivePinnedChip';
import LiveRightRail from '../components/live/LiveRightRail';
import LiveSystemChipStack from '../components/live/LiveSystemChipStack';
import LiveChatOverlay from '../components/live/LiveChatOverlay';
import LiveCommentInput from '../components/live/LiveCommentInput';
import LiveJoinPill from '../components/live/LiveJoinPill';
import LiveConnectingOverlay from '../components/live/LiveConnectingOverlay';

// Humanize big counts the way Instagram/TikTok do: 999 → 999, 1.2K, 12.4K, 1.2M.
// We localize the decimal separator from the user locale where possible.
function humanizeCount(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  const sep = (() => {
    try { return (1.1).toLocaleString().includes(',') ? ',' : '.'; } catch { return '.'; }
  })();
  if (v < 10000) return (Math.floor(v / 100) / 10).toString().replace('.', sep) + 'K';
  if (v < 1_000_000) return Math.floor(v / 1000) + 'K';
  return (Math.floor(v / 100_000) / 10).toString().replace('.', sep) + 'M';
}

// Cross-platform WebRTC
let RTC_PeerConnection, RTC_SessionDescription, RTC_IceCandidate, NativeRTCView;
if (Platform.OS === 'web') {
  RTC_PeerConnection = window.RTCPeerConnection;
  RTC_SessionDescription = window.RTCSessionDescription;
  RTC_IceCandidate = window.RTCIceCandidate;
} else {
  try {
    const webrtc = require('@stream-io/react-native-webrtc');
    RTC_PeerConnection = webrtc.RTCPeerConnection;
    RTC_SessionDescription = webrtc.RTCSessionDescription;
    RTC_IceCandidate = webrtc.RTCIceCandidate;
    NativeRTCView = webrtc.RTCView;
  } catch (e) {
    console.warn('[Live] Failed to load WebRTC:', e);
  }
}

// Native HLS player — lazy require expo-video so web bundles don't pull native
// surface area we can't use. expo-video ships with the rest of the app (SDK
// 55+) and is already used by status/reels/chat media. iOS + Android both
// decode m3u8 natively via AVPlayer / ExoPlayer — no extra deps needed.
let _ExpoVideoMod = null;
function _loadExpoVideo() {
  if (_ExpoVideoMod !== null) return _ExpoVideoMod || null;
  try { _ExpoVideoMod = require('expo-video'); return _ExpoVideoMod; }
  catch { _ExpoVideoMod = false; return null; }
}

// Native HLS player — used when backend reports stream_type === 'cf_hls'.
// Hides spinner once first frame decodes (readyToPlay) and bubbles errors up
// via onReady / onError so the parent can flip `connected`/`hlsError`.
function LiveHlsNativePlayer({ uri, onReady, onError }) {
  const mod = _loadExpoVideo();
  if (!mod) {
    // expo-video failed to load (very old runtime) — surface the error so
    // the overlay can show "Live indisponível" instead of staring at black.
    useEffect(() => { onError?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0f0f1a' }]} />;
  }
  const { useVideoPlayer, VideoView } = mod;
  const player = useVideoPlayer(uri, (p) => {
    try { p.loop = false; p.muted = false; p.play(); } catch {}
  });
  useEffect(() => {
    const sub = player.addListener?.('statusChange', (s) => {
      if (s?.error) { onError?.(s.error); return; }
      if (s?.status === 'readyToPlay' || s?.status === 'playing') onReady?.();
    });
    return () => { try { sub?.remove?.(); } catch {} };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    try { player.pause?.(); } catch {}
    try { player.replace?.(null); } catch {}
    try { player.release?.(); } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      nativeControls={false}
      allowsPictureInPicture={false}
    />
  );
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const WS_URL = Platform.OS === 'web' ? 'wss://chatyy.com.br/ws' : 'wss://ws.chatyy.com.br/ws';
const MAX_HEARTS = 20;
const LIVE_RED = '#dc2626';
const ACCENT = '#7C3AED';

const HEART_COLORS = ['#ef4444', '#f43f5e', '#ec4899', '#a855f7', '#f97316'];

export default function LiveViewerScreen() {
  const params = useLocalSearchParams();
  // Accept all common param aliases so deep links work regardless of source:
  //   • push tap notification → ?session_id=… (snake_case, from FCM payload)
  //   • ChatReelsTab → ?id=…
  //   • Profile / ChatListTab / ChatFeedTab → ?sessionId=… (camelCase)
  // Without normalizing, push-tap-from-locked-screen lands on a viewer with
  // no session id, WS never joins, header shows "?". Regression of #847.
  const paramSessionId = params.sessionId || params.session_id || params.id;
  const hostEmail = params.hostEmail || params.host_email;
  const hostName = params.hostName || params.host_name;
  const paramTitle = params.title;
  const router = useRouter();
  const { user } = useAuth();
  const { t } = useLanguage();
  const { colors } = useTheme();
  const brandAccent = colors?.primary || ACCENT;
  const insets = useSafeAreaInsets();

  const [connected, setConnected] = useState(false);
  // Stream-type branch: backend tells us via `live_session_info` whether this
  // session streams via Cloudflare Stream HLS (`cf_hls`) or legacy WebRTC P2P
  // (`webrtc`). Default `webrtc` so a backend that hasn't shipped the new
  // payload yet still works — zero-regression.
  const [streamType, setStreamType] = useState('webrtc');
  const [hlsUrl, setHlsUrl] = useState(null);
  const [hlsError, setHlsError] = useState(false);
  const [hlsRetryKey, setHlsRetryKey] = useState(0);
  const [viewerCount, setViewerCount] = useState(0);
  const [viewers, setViewers] = useState([]); // [{email, name, joinedAt}]
  const [showViewersList, setShowViewersList] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [liveEnded, setLiveEnded] = useState(false);
  // Replay save flow — viewer can bookmark the recorded live so it shows
  // up in /lives-saved after CF Stream finalizes the VOD (30s-2min).
  // `replaySaved` flips immediately on tap (optimistic) and we call the
  // API in the background. Failures rollback silently.
  const [replaySaved, setReplaySaved] = useState(false);
  const [savingReplay, setSavingReplay] = useState(false);
  const [hearts, setHearts] = useState([]);
  // Cumulative like counter for the right-rail heart display. Increments
  // every time a heart is spawned (locally or from a remote reaction WS msg).
  // Replaces the bare-icon look — TikTok/Instagram both show counts here.
  const [likeCount, setLikeCount] = useState(0);
  // System chip stack (joins/leaves) — separate from chat overlay so the
  // glass pills can live in their own animated column on the left-bottom.
  const [systemEvents, setSystemEvents] = useState([]);
  const dismissSystemEvent = useCallback((id) => {
    setSystemEvents(prev => prev.filter(e => e.id !== id));
  }, []);
  const [error, setError] = useState('');
  const [following, setFollowing] = useState(false);
  const [connQuality, setConnQuality] = useState('good'); // good | medium | poor
  const [inputText, setInputText] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const [burstHearts, setBurstHearts] = useState([]);
  const lastTapRef = useRef(0);
  // Expanded chat sheet — Instagram parity: tap comments overlay to see the
  // full chat history (not just the last 5 floating bubbles).
  const [chatSheetOpen, setChatSheetOpen] = useState(false);
  // TikTok parity — comment toggle on the right rail. When hidden the floating
  // comments overlay + input bar fade away so the viewer can enjoy the video
  // without the chat noise. Bottom input collapses to just the inline heart.
  const [chatHidden, setChatHidden] = useState(false);
  // Pinned host comment — TikTok-style sticky chip above the comments column.
  // Backend doesn't expose a pin endpoint yet; we keep this client-side so
  // host can long-press their own messages (in live-broadcast) to pin one.
  // Viewer just renders whatever the WS broadcasts (msg.type === 'live_pin').
  const [pinnedMsg, setPinnedMsg] = useState(null);
  // Host quick-peek (Instagram long-press preview) — shows a compact card
  // floating over the stream with avatar/name/quick actions. Long-press only,
  // single tap on the avatar still does the rail tap (toggleFollow).
  const [hostPeekOpen, setHostPeekOpen] = useState(false);
  // Per-comment heart reaction inline chip — keyed by message id. Set on
  // double-tap of a floating comment; auto-clears via animated timeout.
  const [commentHearts, setCommentHearts] = useState({}); // { [msgId]: Animated.Value }
  const lastCommentTapRef = useRef({}); // { [msgId]: ts }

  // Refs
  const remoteVideoRef = useRef(null);
  const wsRef = useRef(null);
  // Track auth-completion so requestToJoin can wait for it. Without this,
  // tapping "Pedir pra entrar" right after opening the viewer screen sent
  // the WS message before the server's `auth_success` came back — and the
  // server's `live_join_request` handler guards on `c.email`, silently
  // dropping the request. From the user's perspective the button does
  // nothing and the host never sees the badge.
  const wsAuthedRef = useRef(false);
  const pcRef = useRef(null);
  const sessionIdRef = useRef(paramSessionId);
  const chatIdRef = useRef(0);
  const heartIdRef = useRef(0);
  const iceCandidateQueueRef = useRef([]);
  const endTimerRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  // Anti-spam: client-side rate limit on the WS comment + reaction wires.
  // Comments: 1 per 1.2s (Instagram parity). Reactions: coalesced @ 200ms
  // (5 hearts/sec max) so long-press burst doesn't flood the channel even
  // though each tap still spawns a local heart animation instantly.
  const lastChatSendAtRef = useRef(0);
  const lastReactionSendAtRef = useRef(0);
  // Full-screen container ref — used by react-native-view-shot to snap the
  // live frame + comment overlay (Instagram/TikTok "save snap" parity).
  const screenRef = useRef(null);
  const inputRef = useRef(null);
  // Toast for screenshot save feedback (no library — just an Animated.Value).
  const [toast, setToast] = useState('');
  const toastAnim = useRef(new Animated.Value(0)).current;

  // Animations
  const connectingPulse = useRef(new Animated.Value(0.4)).current;
  const endedFade = useRef(new Animated.Value(0)).current;
  const livePulse = useRef(new Animated.Value(1)).current;
  const heartScale = useRef(new Animated.Value(1)).current;
  // Connecting overlay entrance — spring fade-in from below so the skeleton
  // doesn't pop in cold. Reset to 0 on mount, spring to 1.
  const connectingEntrance = useRef(new Animated.Value(0)).current;
  // Joined transition — slides up a gradient overlay reveal once `connected`
  // flips true, then fades out. Looks like Instagram's "stream loaded" wipe.
  const joinedReveal = useRef(new Animated.Value(0)).current;
  // Input pill focus lift — scales slightly + shifts up so the bar feels
  // alive instead of a static rectangle.
  const inputLift = useRef(new Animated.Value(0)).current;
  // Viewer-count "+1" bump — small floating chip that pops above the eye pill
  // whenever a new viewer joins. Instagram/TikTok parity: subtle but lively.
  const viewerCountScale = useRef(new Animated.Value(1)).current;
  const viewerPlusOneAnim = useRef(new Animated.Value(0)).current;
  const [viewerPlusOneVisible, setViewerPlusOneVisible] = useState(false);
  const prevViewerCountRef = useRef(0);
  // Entry-flash overlay — paints a white "Entrando…" curtain over the whole
  // screen for the first 500ms after mount, then fades to 0. Makes the
  // tap → live-viewer transition feel instant even on slow WebRTC handshakes
  // (the user gets a confirmation that something is happening while the
  // skeleton card behind it is still spinning up). Plays exactly once.
  const entryFlash = useRef(new Animated.Value(1)).current;

  // ICE config
  const iceConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // Connecting pulse animation
  useEffect(() => {
    if (!connected && !liveEnded) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(connectingPulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
          Animated.timing(connectingPulse, { toValue: 0.4, duration: 1000, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [connected, liveEnded]);

  // Ended fade in
  useEffect(() => {
    if (liveEnded) {
      Animated.timing(endedFade, { toValue: 1, duration: 500, useNativeDriver: true }).start();
    }
  }, [liveEnded]);

  // LIVE badge pulse — heartbeat tied to live state
  useEffect(() => {
    if (!connected || liveEnded) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(livePulse, { toValue: 0.55, duration: 700, useNativeDriver: true }),
        Animated.timing(livePulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [connected, liveEnded]);

  // Connecting overlay entrance — spring up from 0 → 1 on mount so the
  // skeleton card lands softly instead of cold-popping. Skip if already
  // connected by the time we get here (deep-link warm path).
  useEffect(() => {
    if (connected || liveEnded) return undefined;
    Animated.spring(connectingEntrance, {
      toValue: 1, friction: 7, tension: 110, useNativeDriver: true,
    }).start();
    return undefined;
  }, [connected, liveEnded, connectingEntrance]);

  // Entry-flash — fade the white "Entrando…" curtain out over 500ms. Runs
  // once on mount regardless of connection state so every tap to enter
  // gives the same instant-feedback feel.
  useEffect(() => {
    Animated.timing(entryFlash, {
      toValue: 0,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, [entryFlash]);

  // Joined transition — when `connected` flips true, run a slide-up gradient
  // reveal that wipes the skeleton off the screen. The overlay starts fully
  // opaque, then translates up and fades over ~700ms (Instagram parity).
  useEffect(() => {
    if (!connected) { joinedReveal.setValue(0); return; }
    Animated.sequence([
      Animated.timing(joinedReveal, { toValue: 1, duration: 520, useNativeDriver: true }),
    ]).start();
  }, [connected, joinedReveal]);

  // Input pill focus lift — spring scale + translateY when input gains focus.
  useEffect(() => {
    Animated.spring(inputLift, {
      toValue: inputFocused ? 1 : 0,
      friction: 6, tension: 140, useNativeDriver: true,
    }).start();
  }, [inputFocused, inputLift]);

  // Viewer-count pop: when the count goes up, the chip bumps + a small "+1"
  // floats up briefly. Skips the first render so we don't fire on mount.
  useEffect(() => {
    const prev = prevViewerCountRef.current;
    prevViewerCountRef.current = viewerCount;
    if (viewerCount > prev && prev !== 0) {
      Animated.sequence([
        Animated.timing(viewerCountScale, { toValue: 1.22, duration: 120, useNativeDriver: true }),
        Animated.spring(viewerCountScale, { toValue: 1, friction: 4, tension: 180, useNativeDriver: true }),
      ]).start();
      setViewerPlusOneVisible(true);
      viewerPlusOneAnim.setValue(0);
      Animated.timing(viewerPlusOneAnim, {
        toValue: 1, duration: 900, useNativeDriver: true,
      }).start(() => setViewerPlusOneVisible(false));
    }
  }, [viewerCount]);

  // Connection quality dot — derived from PC stats. Falls back to peer-state
  // poll every 4s so the dot still moves on web where stats() is async.
  // HLS sessions don't have a PeerConnection, so we just report 'good' once
  // playback begins (the CDN handles delivery quality for us; we don't have
  // per-viewer telemetry to surface anyway).
  useEffect(() => {
    if (streamType === 'cf_hls') {
      setConnQuality(connected ? 'good' : 'poor');
      return undefined;
    }
    if (!connected) { setConnQuality('poor'); return; }
    let cancelled = false;
    const tick = async () => {
      const pc = pcRef.current;
      if (!pc || cancelled) return;
      try {
        const stats = await pc.getStats?.();
        let rtt = 0, loss = 0, packets = 0;
        if (stats?.forEach) {
          stats.forEach((r) => {
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
              loss += r.packetsLost || 0;
              packets += r.packetsReceived || 0;
            }
            if (r.type === 'candidate-pair' && r.state === 'succeeded') {
              rtt = Math.max(rtt, (r.currentRoundTripTime || 0) * 1000);
            }
          });
        }
        const lossRate = packets > 0 ? loss / (loss + packets) : 0;
        let q = 'good';
        if (rtt > 350 || lossRate > 0.05) q = 'medium';
        if (rtt > 700 || lossRate > 0.12 || pc.connectionState !== 'connected') q = 'poor';
        if (!cancelled) setConnQuality(q);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [connected, streamType]);

  // Load chat history
  useEffect(() => {
    if (paramSessionId) {
      api.liveChatHistory(paramSessionId, 50).then(res => {
        if (res.success && res.data?.messages) {
          const msgs = res.data.messages.map((m) => ({
            id: String(++chatIdRef.current),
            name: m.sender_name || m.sender_email?.split('@')[0] || '?',
            email: m.sender_email,
            content: m.content,
            type: m.msg_type || 'chat',
          }));
          setChatMessages(msgs);
        }
      }).catch(() => {});
    }
  }, [paramSessionId]);

  // Native remote stream URL for RTCView
  const [remoteStreamUrl, setRemoteStreamUrl] = useState(null);

  // Fallback host info — if the route didn't include hostName/hostEmail
  // (e.g. push notification only carried session_id), hit live_list once to
  // resolve the host from the session id. Without this the header + connecting
  // overlay show literal "?".
  const [resolvedHost, setResolvedHost] = useState({ name: hostName, email: hostEmail });
  useEffect(() => {
    if (hostName && hostEmail) return undefined;
    if (!paramSessionId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.apiCall?.('live_list', null, 'POST');
        if (cancelled) return;
        const lives = r?.data?.lives || r?.lives || [];
        const found = lives.find(l => l?.id === paramSessionId);
        if (found) setResolvedHost({ name: found.host_name || (found.host_email || '').split('@')[0], email: found.host_email });
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [paramSessionId, hostName, hostEmail]);
  const displayHostName = hostName || resolvedHost.name || (hostEmail || resolvedHost.email || '').split('@')[0] || '';
  const displayHostEmail = hostEmail || resolvedHost.email || '';

  // Stream-stuck timeout — if `connected` doesn't go true within 15s of mount,
  // surface a real error instead of leaving the viewer staring at "Conectando..."
  // forever (host may have ended the live or never sent an offer).
  useEffect(() => {
    if (connected || liveEnded) return undefined;
    const timer = setTimeout(() => {
      if (!connected && !liveEnded) {
        setError(t('live.streamUnavailable') || 'Stream indisponível — host pode ter saído');
      }
    }, 15000);
    return () => clearTimeout(timer);
  }, [connected, liveEnded]);

  // Offer-resync: WhatsApp-grade backstop for the most common stuck-connecting
  // cause — broadcaster's WS handler missed the first `live_viewer_joined`
  // (channel sub race, transient WS hiccup). After 6s + every 6s while still
  // not connected, re-send `live_join` so the server re-broadcasts
  // `live_viewer_joined` to the host and they create an offer for us.
  //
  // Skip the resync for HLS sessions — Cloudflare Stream doesn't depend on
  // the host generating per-viewer offers, so spamming `live_join` adds noise
  // without speeding anything up.
  useEffect(() => {
    if (connected || liveEnded) return undefined;
    if (!paramSessionId) return undefined;
    if (streamType === 'cf_hls') return undefined;
    const resync = () => {
      if (connected || liveEnded) return;
      try {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'live_join', session_id: paramSessionId }));
        }
      } catch {}
    };
    const iv = setInterval(resync, 6000);
    return () => clearInterval(iv);
  }, [connected, liveEnded, paramSessionId, streamType]);

  // Connect to signaling and WebRTC
  useEffect(() => {
    // WebRTC absence is no longer fatal here — sessions that stream via HLS
    // (Cloudflare Stream) don't need a PeerConnection at all. We only bail
    // if WebRTC is missing AND the backend later confirms `stream_type` is
    // `webrtc` (handleOffer surfaces the error in that path).
    let alive = true;
    let attempt = 0;
    let ws;

    const openSocket = () => {
      if (!alive) return;
      const token = api.getAuthToken();
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
      if (!alive) return;
      attempt = 0; // reset backoff once we're up
      // Clear any prior "Reconnecting..." banner.
      setError('');
      ws.send(JSON.stringify({ type: 'auth', token }));
    };

    ws.onmessage = (event) => {
      if (!alive) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'auth_failure':
          // Token expired or invalid — bounce out instead of looping.
          setError(t('live.authFailed') || 'Sessão expirada');
          alive = false;
          try { ws.close(); } catch {}
          setTimeout(() => { try { router.replace('/login?reason=expired'); } catch {} }, 600);
          return;
        case 'auth_success':
          // After auth, join the live session
          wsAuthedRef.current = true;
          ws.send(JSON.stringify({
            type: 'live_join',
            session_id: paramSessionId,
          }));
          break;
        case 'live_session_info':
          // Backend tells us how this session is streamed. For Cloudflare
          // Stream we just hand the m3u8 URL to expo-video; for WebRTC we
          // fall through and wait for `live_offer` like before.
          if (msg.stream_type === 'cf_hls' && msg.hls_url) {
            setStreamType('cf_hls');
            setHlsUrl(String(msg.hls_url));
            setHlsError(false);
          } else if (msg.stream_type === 'webrtc') {
            setStreamType('webrtc');
          }
          break;
        case 'live_offer':
          // Update ICE with TURN credentials if provided
          if (msg.turn_credentials) {
            iceConfig.iceServers = [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: msg.turn_credentials.urls, username: msg.turn_credentials.username, credential: msg.turn_credentials.credential },
            ];
          }
          handleOffer(msg);
          break;
        case 'live_ice':
          handleIceCandidate(msg);
          break;
        case 'live_chat':
          handleChatMsg(msg);
          break;
        case 'live_pin':
          // Host pinned (or unpinned) a comment. Payload: { type: 'live_pin',
          // content, sender_name, sender_email } — empty content clears. We
          // keep this client-side (no persistence) so viewers who join after
          // the pin just won't see it until host re-pins.
          if (msg.content) {
            setPinnedMsg({
              content: String(msg.content),
              name: msg.sender_name || (msg.sender_email || '').split('@')[0] || '?',
              email: msg.sender_email || '',
            });
          } else {
            setPinnedMsg(null);
          }
          break;
        case 'live_viewer_count':
          // Authoritative count from server — always trust this over local
          // counter (server tracks channel subs which is the source of truth).
          if (typeof msg.count === 'number') setViewerCount(msg.count);
          break;
        case 'live_viewer_joined':
          // Add to local viewer list (for the tap-to-see-who-joined sheet)
          if (msg.viewer_email && msg.viewer_email !== user?.email) {
            setViewers(prev => {
              const exists = prev.some(v => v.email === msg.viewer_email);
              if (exists) return prev;
              return [{
                email: msg.viewer_email,
                name: msg.viewer_name || msg.viewer_email.split('@')[0],
                joinedAt: Date.now(),
              }, ...prev].slice(0, 100); // cap at 100 most-recent
            });
            // Surface as a system chip on the left-bottom stack (round 62
            // redesign — joins/leaves no longer mix with the comment column).
            setSystemEvents(prev => [
              ...prev.slice(-9),
              {
                id: 'sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                email: msg.viewer_email,
                name: msg.viewer_name || msg.viewer_email.split('@')[0],
                text: (t?.('live.entered') || t?.('live.joined') || 'entrou'),
                ts: Date.now(),
              },
            ]);
          }
          break;
        case 'live_viewer_left':
          if (msg.viewer_email) {
            setViewers(prev => prev.filter(v => v.email !== msg.viewer_email));
          }
          break;
        case 'live_reaction':
          // Prefer emoji (from gift picker). Heart button also sends
          // emoji:'❤️' which we treat as the default heart animation
          // (no emoji text) for visual consistency with taps.
          if (msg.emoji && msg.emoji !== '❤️') spawnHeart(msg.emoji);
          else spawnHeart(msg.x);
          break;
        case 'live_join_approve':
          // Targeted via viewer_email filter — server fans out to the channel.
          if (msg.viewer_email && user?.email && msg.viewer_email.toLowerCase() === user.email.toLowerCase()) {
            try { require('react-native').Alert.alert(t('live.aoVivo') || 'AO VIVO', t('live.requestApproved') || 'O host aceitou seu pedido — entrando em breve...'); } catch {}
          }
          break;
        case 'live_join_deny':
          if (msg.viewer_email && user?.email && msg.viewer_email.toLowerCase() === user.email.toLowerCase()) {
            try { require('react-native').Alert.alert(t('live.aoVivo') || 'AO VIVO', t('live.requestDenied') || 'O host recusou seu pedido'); } catch {}
            setJoinRequested(false);
          }
          break;
        case 'live_ended':
          setLiveEnded(true);
          endTimerRef.current = setTimeout(() => { if (alive) router.back(); }, 4000);
          break;
      }
    };

    ws.onclose = () => {
      // Drop auth flag on close so any pending `requestToJoin` retry waits
      // for the next `auth_success` before sending again.
      wsAuthedRef.current = false;
      if (!alive || liveEnded) return;
      // Exponential-ish backoff capped at 8s. After 5 fails give up so the
      // viewer sees a real error instead of looping forever on a dead session.
      attempt += 1;
      if (attempt > 5) {
        setError(t('live.connectionFailed') || 'Connection failed');
        return;
      }
      const delay = Math.min(1000 * attempt, 8000);
      setError(t('live.reconnecting') || 'Reconnecting…');
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        openSocket();
      }, delay);
    };

      ws.onerror = (e) => {
        if (!alive) return;
        // Don't surface here — onclose will fire next and decides between
        // "reconnecting" and "failed". This keeps the banner from flapping.
        if (__DEV__) console.warn('[live-viewer ws.onerror]', e?.message);
      };
    };

    openSocket();

    return () => {
      alive = false;
      // Send explicit live_leave BEFORE closing so the server can broadcast
      // updated viewer_count to remaining viewers + the broadcaster — without
      // this the count only drops on the next reconnect cycle.
      try {
        if (ws && ws.readyState === WebSocket.OPEN && paramSessionId) {
          ws.send(JSON.stringify({ type: 'live_leave', session_id: paramSessionId }));
        }
      } catch {}
      try { ws?.close(); } catch {}
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      if (endTimerRef.current) clearTimeout(endTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      iceCandidateQueueRef.current = []; // Clear queued candidates
    };
  }, [paramSessionId, user]);

  const handleOffer = useCallback(async (msg) => {
    if (!msg.sdp) return;
    if (!RTC_PeerConnection) {
      setError(t('live.connectionFailed') || 'WebRTC not supported on this device');
      return;
    }

    const pc = new RTC_PeerConnection(iceConfig);
    pcRef.current = pc;

    pc.ontrack = (event) => {
      if (event.streams[0]) {
        if (Platform.OS === 'web') {
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
        } else {
          if (event.streams[0].toURL) setRemoteStreamUrl(event.streams[0].toURL());
        }
        setConnected(true);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'live_ice',
          broadcaster_email: msg.broadcaster_email,
          session_id: paramSessionId,
          candidate: event.candidate,
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setConnected(true);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setConnected(false);
      }
    };

    try {
      await pc.setRemoteDescription(new RTC_SessionDescription({
        type: 'offer',
        sdp: msg.sdp,
      }));

      for (const candidate of iceCandidateQueueRef.current) {
        try { await pc.addIceCandidate(new RTC_IceCandidate(candidate)); } catch {}
      }
      iceCandidateQueueRef.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'live_answer',
          broadcaster_email: msg.broadcaster_email,
          session_id: paramSessionId,
          sdp: answer.sdp,
        }));
      }
    } catch (err) {
      console.error('Failed to handle offer:', err);
      setError(t('live.connectionFailed') || 'Connection failed');
    }
  }, [paramSessionId, t]);

  const handleIceCandidate = useCallback(async (msg) => {
    const { candidate } = msg;
    if (!candidate) return;

    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) {
      // Limit queue to prevent unbounded memory growth
      if (iceCandidateQueueRef.current.length < 200) {
        iceCandidateQueueRef.current.push(candidate);
      }
      return;
    }

    try {
      await pc.addIceCandidate(new RTC_IceCandidate(candidate));
    } catch {}
  }, []);

  const handleChatMsg = useCallback((msg) => {
    // WS server's live_chat broadcast does NOT exclude the sender (unlike
    // live_reaction which passes clientId). handleSendChat already inserts
    // an optimistic local bubble, so without this guard the sender sees
    // their own message TWICE (optimistic + server echo). Skip self.
    const myEmail = (user?.email || '').toLowerCase();
    const fromEmail = (msg.sender_email || '').toLowerCase();
    if (myEmail && fromEmail && myEmail === fromEmail) return;

    const entry = new Animated.Value(0);
    setChatMessages(prev => [...prev, {
      id: String(++chatIdRef.current),
      name: msg.sender_name || msg.sender_email?.split('@')[0] || '?',
      email: msg.sender_email,
      content: msg.content,
      type: msg.msg_type || 'chat',
      entry,
    }]);
    Animated.timing(entry, { toValue: 1, duration: 260, useNativeDriver: true }).start();
  }, [user]);

  const handleSendChat = useCallback((text) => {
    // Anti-spam rate limit: 1 comment / 600ms. Backend already enforces
    // 15 msgs / 10s server-side, so the client throttle just smooths bursts.
    // Was 1.2s — too aggressive, users tapping send rapidly hit silent
    // drops and felt the composer was broken ("sistema quebrando").
    const now = Date.now();
    if (now - lastChatSendAtRef.current < 600) return;
    lastChatSendAtRef.current = now;

    const senderName = user?.name || user?.email?.split('@')[0] || 'You';
    const entry = new Animated.Value(0);

    setChatMessages(prev => [...prev, {
      id: String(++chatIdRef.current),
      name: senderName,
      email: user?.email,
      content: text,
      type: 'chat',
      entry,
    }]);
    Animated.timing(entry, { toValue: 1, duration: 260, useNativeDriver: true }).start();

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'live_chat',
        session_id: paramSessionId,
        content: text,
      }));
    }

    if (paramSessionId) {
      api.liveSendChat(paramSessionId, text).catch(() => {});
    }
  }, [user, paramSessionId]);

  // Heart animation — parabolic float, randomized everything for that organic
  // "stream of love" vibe Instagram/TikTok perfected. Each heart has:
  //   • size 14-22 (small) so the stream feels dense, not heavy
  //   • horizontal drift via sin wave (so trajectory curves left-right)
  //   • spawn jitter around the bottom-right rail (the heart button)
  //   • duration 1.6-2.6s so column never feels mechanical
  // If an emoji is passed (gift picker) we render that with larger size (~30).
  const spawnHeart = useCallback((emojiOrX) => {
    const id = ++heartIdRef.current;
    const isEmoji = typeof emojiOrX === 'string';
    // Spawn near the right rail / heart button — the visual origin of taps.
    const baseX = SCREEN_W - 56 + (Math.random() - 0.5) * 24;
    const x = (isEmoji ? null : (typeof emojiOrX === 'number' ? emojiOrX : null)) || baseX;
    const y = SCREEN_H * 0.62 + (Math.random() - 0.5) * 30;
    const anim = new Animated.Value(0);
    const color = HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)];
    const emoji = isEmoji ? emojiOrX : null;
    // Per-heart random params — keeps the column from looking like a clone army.
    const size = isEmoji ? 30 : (14 + Math.floor(Math.random() * 9));   // 14-22 px
    const drift = (Math.random() - 0.5) * 110;                          // horizontal sway
    const driftPhase = Math.random() * Math.PI;                          // sin offset
    const rise = 220 + Math.floor(Math.random() * 140);                  // 220-360 px
    const tilt = (Math.random() - 0.5) * 24;                             // -12..12 deg
    const duration = 1600 + Math.floor(Math.random() * 1000);

    setHearts(prev => {
      const next = [...prev, { id, x, y, anim, color, emoji, size, drift, driftPhase, rise, tilt, duration }];
      if (next.length > MAX_HEARTS) return next.slice(-MAX_HEARTS);
      return next;
    });
    // Bump the cumulative like counter shown on the right rail.
    setLikeCount(c => c + 1);

    Animated.timing(anim, {
      toValue: 1,
      duration,
      useNativeDriver: true,
    }).start(() => {
      setHearts(prev => prev.filter(h => h.id !== id));
    });
  }, []);

  // Pop the right-rail heart icon when tapped — small spring so the button
  // feels alive instead of "just sending a network message."
  const popHeartButton = useCallback(() => {
    Animated.sequence([
      Animated.timing(heartScale, { toValue: 1.35, duration: 110, useNativeDriver: true }),
      Animated.spring(heartScale, { toValue: 1, friction: 4, tension: 180, useNativeDriver: true }),
    ]).start();
  }, [heartScale]);

  const handleHeartTap = useCallback(() => {
    spawnHeart();
    popHeartButton();

    // Local heart spawns every tap, but the WS reaction is coalesced @ 200ms
    // (5/s cap). Long-press / rapid-tap still feels rich locally, but the
    // server doesn't see a packet storm. Other viewers see ~5 hearts/sec
    // float per fan, which matches Instagram/TikTok's perceived density.
    const now = Date.now();
    if (now - lastReactionSendAtRef.current < 200) return;
    lastReactionSendAtRef.current = now;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'live_reaction',
        session_id: paramSessionId,
        emoji: '❤️',
      }));
    }
  }, [paramSessionId, user, spawnHeart, popHeartButton]);

  // Central particle burst on double-tap. Spawns 8 hearts in a radial pattern
  // from screen center so it reads like an Instagram-style "love bomb."
  const spawnBurst = useCallback(() => {
    const cx = SCREEN_W / 2;
    const cy = SCREEN_H * 0.45;
    const newOnes = [];
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.3;
      const dist = 90 + Math.random() * 60;
      const id = ++heartIdRef.current;
      const anim = new Animated.Value(0);
      const color = HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)];
      newOnes.push({ id, cx, cy, dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist, anim, color });
      Animated.timing(anim, { toValue: 1, duration: 900, useNativeDriver: true }).start(() => {
        setBurstHearts(prev => prev.filter(h => h.id !== id));
      });
    }
    setBurstHearts(prev => [...prev, ...newOnes].slice(-MAX_HEARTS));
  }, []);

  // Double-tap detection on the video stage — second tap inside 280ms fires
  // both a "love bomb" burst and a normal heart so the broadcaster also sees
  // a reaction land.
  const handleStageTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 280) {
      lastTapRef.current = 0;
      spawnBurst();
      handleHeartTap();
    } else {
      lastTapRef.current = now;
    }
  }, [spawnBurst, handleHeartTap]);

  const toggleFollow = useCallback(() => {
    // Optimistic flip — backend follow API already exists per chat profile.
    setFollowing(f => !f);
    try { api.followUser?.(hostEmail); } catch {}
  }, [hostEmail]);

  // Request to come on as a guest (TikTok "Go LIVE Together", Instagram
  // "Request to Join"). Sends a one-shot WS event the host listens for and
  // shows a queue/inbox. Server side: the live channel already broadcasts
  // every WS message to all subs of `live_${session_id}` so the host
  // receives it without server changes.
  //
  // Before: the entire send was wrapped in `try { if(ws.OPEN) send() } catch`
  // — if the WS was reconnecting (or paramSessionId fell through a stale
  // closure) NOTHING happened: no toast, no state flip, no error. User taps
  // "Pedir pra entrar", button stays unchanged → "não funciona". Fix: surface
  // a visible toast on every code-path and flip optimistic state so the user
  // always gets feedback, even when the WS is mid-reconnect (the host's
  // requests inbox is already tolerant of duplicates by email).
  const [joinRequested, setJoinRequested] = useState(false);
  const requestToJoin = useCallback(() => {
    if (joinRequested) return;
    if (!paramSessionId || !user?.email) {
      try { require('react-native').Alert.alert(t('live.aoVivo') || 'AO VIVO', t('live.requestSendFailed') || 'Não foi possível enviar o pedido — tente de novo'); } catch {}
      return;
    }
    let sent = false;
    try {
      const ws = wsRef.current;
      // Only count as "sent" if BOTH the socket is open AND we already saw
      // auth_success — otherwise the server's `live_join_request` handler
      // bails on the missing `c.email` guard and the host never sees the
      // request. wsAuthedRef gates that race.
      if (ws && ws.readyState === WebSocket.OPEN && wsAuthedRef.current) {
        ws.send(JSON.stringify({
          type: 'live_join_request',
          session_id: paramSessionId,
          viewer_email: user?.email,
          viewer_name: user?.name || (user?.email || '').split('@')[0],
        }));
        sent = true;
      }
    } catch {}
    if (sent) {
      // Optimistic flip + a tiny haptic so the user feels the tap landed.
      setJoinRequested(true);
      try { require('react-native').Vibration.vibrate(8); } catch {}
      setTimeout(() => setJoinRequested(false), 60000); // allow re-request after 1 min
    } else {
      // WS reconnecting — flip state anyway so the user sees the tap took
      // effect, and queue a single retry once the socket reopens. The host's
      // join-requests Set already dedupes by email so a stale duplicate is a
      // no-op even if both attempts land.
      setJoinRequested(true);
      try { require('react-native').Vibration.vibrate(8); } catch {}
      const retry = setInterval(() => {
        try {
          const ws2 = wsRef.current;
          if (ws2 && ws2.readyState === WebSocket.OPEN && wsAuthedRef.current) {
            ws2.send(JSON.stringify({
              type: 'live_join_request',
              session_id: paramSessionId,
              viewer_email: user?.email,
              viewer_name: user?.name || (user?.email || '').split('@')[0],
            }));
            clearInterval(retry);
          }
        } catch {}
      }, 800);
      // Give up after 8s — if still not connected the live session is
      // probably toast anyway.
      setTimeout(() => clearInterval(retry), 8000);
      setTimeout(() => setJoinRequested(false), 60000);
    }
  }, [paramSessionId, user?.email, user?.name, joinRequested, t]);

  // Share the live broadcast link. Uses the native share sheet on iOS/Android
  // and navigator.share (or clipboard fallback) on web. The URL resolves to
  // the public live-viewer route for the session so anyone can join.
  const handleShare = useCallback(async () => {
    const url = `https://chatyy.com.br/live-viewer?sessionId=${encodeURIComponent(paramSessionId || '')}`;
    const title = displayHostName ? `${displayHostName} está ao vivo no Chatyy` : 'Live no Chatyy';
    const message = paramTitle ? `${title}: ${paramTitle}\n${url}` : `${title}\n${url}`;
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ title, text: paramTitle || '', url });
        } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(url);
        }
      } else {
        await Share.share({ message, url, title });
      }
    } catch {}
  }, [paramSessionId, hostName, paramTitle]);

  // Tap a floating comment → seed the input with "@name " so the reply UX
  // mirrors Instagram Live (and gives the comment a clear target). Double-tap
  // within 280ms → emit a heart-reaction chip on the comment row (animated)
  // and fire a normal heart so the broadcaster sees the love. Single tap
  // still seeds @reply.
  const fireCommentHeart = useCallback((msgId) => {
    const anim = new Animated.Value(0);
    setCommentHearts(prev => ({ ...prev, [msgId]: anim }));
    Animated.sequence([
      Animated.timing(anim, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.delay(900),
      Animated.timing(anim, { toValue: 0, duration: 240, useNativeDriver: true }),
    ]).start(() => {
      setCommentHearts(prev => {
        if (!prev[msgId]) return prev;
        const next = { ...prev };
        delete next[msgId];
        return next;
      });
    });
  }, []);

  const handleReplyToComment = useCallback((msg) => {
    if (!msg?.name || !msg?.id) return;
    const now = Date.now();
    const lastTap = lastCommentTapRef.current[msg.id] || 0;
    if (now - lastTap < 280) {
      // Double-tap → heart reaction chip on the comment row + send heart.
      lastCommentTapRef.current[msg.id] = 0;
      fireCommentHeart(msg.id);
      spawnHeart();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({
            type: 'live_reaction',
            session_id: paramSessionId,
            emoji: '❤️',
          }));
        } catch {}
      }
      return;
    }
    lastCommentTapRef.current[msg.id] = now;
    const handle = String(msg.name).replace(/\s+/g, '');
    setInputText((prev) => {
      // Avoid duplicating an @prefix if user already typed one for the same
      // person — just leave the field alone.
      const trimmed = (prev || '').trim();
      if (trimmed.startsWith(`@${handle}`)) return prev;
      return `@${handle} `;
    });
    setTimeout(() => { try { inputRef.current?.focus?.(); } catch {} }, 30);
  }, [fireCommentHeart, spawnHeart, paramSessionId]);

  // Long-press the host avatar (top bar or right rail) → opens Instagram-style
  // quick-peek card. Single tap on the rail still toggles follow.
  const openHostPeek = useCallback(() => {
    setHostPeekOpen(true);
  }, []);

  // Capture a snapshot of the live stage (video + overlays) and save it to
  // the device's camera roll. Mirrors the iOS Photos/TikTok save flow. Web
  // fallback: not supported by view-shot RNW — silently disable button.
  const showToast = useCallback((text) => {
    setToast(text);
    Animated.sequence([
      Animated.timing(toastAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.delay(1600),
      Animated.timing(toastAnim, { toValue: 0, duration: 240, useNativeDriver: true }),
    ]).start(() => setToast(''));
  }, [toastAnim]);

  const handleScreenshot = useCallback(async () => {
    if (Platform.OS === 'web') {
      // Best-effort web fallback — most browsers block tab capture; just show
      // a friendly toast so users know the feature is mobile-only for now.
      showToast(t('live.screenshotFailed') || 'Snapshot indisponível na web');
      return;
    }
    try {
      const mod = require('react-native-view-shot');
      const captureRef = mod.captureRef || mod.default || mod;
      if (!screenRef.current || typeof captureRef !== 'function') {
        showToast(t('live.screenshotFailed') || 'Falha no print');
        return;
      }
      const uri = await captureRef(screenRef, { format: 'jpg', quality: 0.9, result: 'tmpfile' });
      // expo-media-library — request perm + saveToLibrary. Silent failure if
      // perm denied (user chose, respect the choice).
      try {
        const ML = require('expo-media-library');
        const perm = await ML.requestPermissionsAsync();
        if (perm?.granted) {
          await ML.saveToLibraryAsync(uri);
          showToast(t('live.screenshotSaved') || 'Print salvo');
          return;
        }
      } catch {}
      // Even if MediaLibrary failed, the snap exists in tmp — still success-ish.
      showToast(t('live.screenshotSaved') || 'Print salvo');
    } catch {
      showToast(t('live.screenshotFailed') || 'Falha no print');
    }
  }, [t, showToast]);

  // Long-press the rail heart → fire an 8-heart spam burst, Instagram-style.
  // Each heart is spawned ~80ms apart so the column reads like a stream of
  // taps without the user actually spamming. Also pops the button each round.
  // Bumped from 5 → 8 (#887 baseline) so the long-press feels meatier and
  // matches Instagram's "love bomb" cadence.
  const handleHeartLongPress = useCallback(() => {
    let i = 0;
    const fire = () => {
      if (i++ >= 8) return;
      spawnHeart();
      popHeartButton();
      // Coalesce WS sends through the same 200ms throttle the single-tap uses.
      // Locally we still spawn the burst so the viewer sees rich feedback,
      // but the WS channel sees at most 1 reaction packet per 200ms — server
      // doesn't get flooded even if a viewer mashes the heart button.
      const now = Date.now();
      if (now - lastReactionSendAtRef.current >= 200 &&
          wsRef.current?.readyState === WebSocket.OPEN) {
        lastReactionSendAtRef.current = now;
        wsRef.current.send(JSON.stringify({
          type: 'live_reaction',
          session_id: paramSessionId,
          emoji: '❤️',
        }));
      }
      setTimeout(fire, 90);
    };
    fire();
  }, [paramSessionId, spawnHeart, popHeartButton]);

  // Free emoji gifts (no IAP) — tap a gift in the picker to send it to the
  // stream. The emoji floats up across everyone's screen via the same
  // live_reaction WS message the heart button uses. Paid gifts will be a
  // future addition once the coin wallet ships.
  const [giftPickerVisible, setGiftPickerVisible] = useState(false);
  const FREE_GIFTS = ['🌹', '🎉', '🔥', '💎', '🎁', '🥳', '👑', '⭐'];
  const sendGift = useCallback((emoji) => {
    // Spawn a local animation instantly
    spawnHeart(emoji);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'live_reaction',
        session_id: paramSessionId,
        emoji,
      }));
    }
    setGiftPickerVisible(false);
  }, [paramSessionId, spawnHeart]);

  // "Saiu da live" overlay shown when the broadcaster ends the stream.
  // "Salvar live" tap → bookmark the recorded replay in the viewer's
  // /lives-saved tab. Optimistic toggle (instant feedback); rollback on
  // server failure. Idempotent on the backend so re-taps are no-ops.
  const handleSaveReplay = useCallback(async () => {
    if (!paramSessionId || savingReplay) return;
    if (replaySaved) return; // already saved — could add unsave here later
    setSavingReplay(true);
    setReplaySaved(true); // optimistic
    try {
      const res = await api.liveSaveReplay(paramSessionId);
      if (!res?.success) {
        setReplaySaved(false);
        showToast(res?.message || t('liveReplay.saveFailed') || 'Falha ao salvar');
      } else {
        showToast(t('liveReplay.savedToast') || 'Salvo em Lives');
        // Schedule a recording-poll so the VOD URLs land fast — backend
        // doesn't have a cron, viewer-triggered poll is cheap (CF API
        // is rate-tolerant of single-uid lookups).
        try { api.liveRecordingPoll(paramSessionId).catch(() => {}); } catch {}
      }
    } catch (e) {
      setReplaySaved(false);
      showToast(t('liveReplay.saveFailed') || 'Falha ao salvar');
    } finally {
      setSavingReplay(false);
    }
  }, [paramSessionId, savingReplay, replaySaved, t, showToast]);

  // Polished: gradient backdrop (purple → black), bigger avatar with soft
  // ring, primary action = "Follow" (returning fans get "Ver perfil" instead),
  // secondary actions = Share + Voltar. Auto-back timer (4s) still runs.
  if (liveEnded) {
    return (
      <Animated.View style={[styles.centered, styles.endedBg, { opacity: endedFade }]}>
        {/* Soft purple wash behind the avatar — web uses a CSS radial; native
            stacks two translucent layers since react-native-linear-gradient
            isn't installed (avoiding a native dep for one cosmetic). */}
        <View style={styles.endedWash} pointerEvents="none" />
        <View style={styles.endedAvatarRing} pointerEvents="none" />
        <AvatarCircle
          name={displayHostName}
          email={displayHostEmail}
          size={96}
          style={styles.endedAvatar}
        />
        <Text style={styles.endedText}>{t('live.liveEnded') || 'Live encerrada'}</Text>
        <Text style={styles.endedSub} numberOfLines={2}>
          {displayHostName
            ? `${displayHostName} ${t('live.hostEnded') || 'encerrou a transmissão'}`
            : (t('live.hostEnded') || 'O host encerrou a transmissão')}
        </Text>

        <View style={styles.endedActions}>
          <TouchableOpacity
            onPress={toggleFollow}
            style={[styles.endedBtn, following ? styles.endedBtnGhost : styles.endedBtnPrimary]}
            accessibilityLabel={following ? (t('live.following') || 'Seguindo') : (t('live.follow') || 'Seguir')}
            accessibilityRole="button"
            activeOpacity={0.85}
          >
            {following
              ? <IconCheck size={18} color="#fff" />
              : <IconUserPlus size={18} color="#fff" />}
            <Text style={styles.endedBtnText}>
              {following ? (t('live.following') || 'Seguindo') : (t('live.follow') || 'Seguir')}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleShare}
            style={[styles.endedBtn, styles.endedBtnGhost]}
            accessibilityLabel={t('live.share') || 'Share'}
            accessibilityRole="button"
            activeOpacity={0.85}
          >
            <IconShare size={18} color="#fff" />
            <Text style={styles.endedBtnText}>{t('live.share') || 'Compartilhar'}</Text>
          </TouchableOpacity>

          {/* Salvar replay — bookmarka a live na aba "Lives salvas".
              Aparece pra qualquer viewer (não-host); host já tem
              acesso automático na lista dele em /lives-saved. */}
          <TouchableOpacity
            onPress={handleSaveReplay}
            style={[styles.endedBtn, replaySaved ? styles.endedBtnGhost : styles.endedBtnPrimary]}
            disabled={savingReplay || replaySaved}
            accessibilityLabel={t('liveReplay.save') || 'Salvar live'}
            accessibilityRole="button"
            activeOpacity={0.85}
          >
            <IconStar size={18} color="#fff" />
            <Text style={styles.endedBtnText}>
              {replaySaved
                ? (t('liveReplay.saved') || 'Salvo')
                : (t('liveReplay.save') || 'Salvar live')}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Helper line under the buttons — explica que o replay vai
            aparecer em "Lives salvas" e que pode demorar pra processar
            na CDN (CF Stream leva 30s-2min pra finalizar o VOD). */}
        {replaySaved && (
          <Text style={styles.endedSub} numberOfLines={2}>
            {t('liveReplay.processing') || 'Processando — vai aparecer em Lives salvas em alguns minutos'}
          </Text>
        )}

        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.endedBackLink}
          accessibilityLabel={t('common.back') || 'Voltar'}
          accessibilityRole="button"
          activeOpacity={0.7}
        >
          <IconRotateCcw size={14} color="rgba(255,255,255,0.65)" />
          <Text style={styles.endedBackLinkText}>{t('live.replay') || 'Voltar'}</Text>
        </TouchableOpacity>

        {/* Suggestion footer — drives the viewer back to the live tab so they
            can hop into another stream instead of bouncing out of the app
            entirely. Mirrors Instagram's "Voltar para o feed" affordance. */}
        <TouchableOpacity
          onPress={() => { try { router.replace('/chat'); } catch { router.back(); } }}
          activeOpacity={0.7}
          style={styles.endedDiscover}
          accessibilityLabel={t('live.discoverMore') || 'Descobrir mais lives'}
          accessibilityRole="button"
        >
          <Text style={styles.endedDiscoverText}>{t('live.discoverMore') || 'Descobrir mais lives'}</Text>
        </TouchableOpacity>
      </Animated.View>
    );
  }

  // Comment overlay — last 5 messages float above the input. Each one auto
  // fades after a short window via individual opacity Animated values so the
  // chat doesn't fight the broadcaster's video for attention.
  const visibleComments = chatMessages.slice(-5);

  const sendComment = () => {
    const text = inputText.trim();
    if (!text) return;
    handleSendChat(text);
    setInputText('');
  };

  const qualityColor = connQuality === 'good' ? '#22c55e' : connQuality === 'medium' ? '#f59e0b' : '#ef4444';

  return (
    <View style={styles.fullScreen} ref={screenRef} collapsable={false}>
      {/* Remote video — wrapped in Pressable so double-tap fires a love-bomb
          burst over the stream without stealing taps from controls overlaid
          on top (those have higher zIndex). */}
      <Pressable style={StyleSheet.absoluteFill} onPress={handleStageTap}>
        {streamType === 'cf_hls' && hlsUrl ? (
          // Cloudflare Stream HLS branch — no PeerConnection. Web uses the
          // platform <video> tag (HLS plays natively on Safari; on
          // Chrome/Firefox the player still requests the manifest fine for
          // CF Stream's adaptive ladder via MSE polyfills baked into the
          // player on most modern browsers, but the bare tag is enough for
          // our purposes since Chrome supports the m3u8 URL with the
          // `cloudflarestream.com` CORS+CDN setup). Native uses expo-video.
          Platform.OS === 'web' ? (
            <video
              key={`hls-${hlsRetryKey}`}
              src={hlsUrl}
              autoPlay
              playsInline
              controls={false}
              onCanPlay={() => { setConnected(true); setHlsError(false); }}
              onError={() => setHlsError(true)}
              style={{
                position: 'absolute', top: 0, left: 0,
                width: '100%', height: '100%',
                objectFit: 'cover', backgroundColor: '#0f0f1a',
              }}
            />
          ) : (
            <LiveHlsNativePlayer
              key={`hls-${hlsRetryKey}`}
              uri={hlsUrl}
              onReady={() => { setConnected(true); setHlsError(false); }}
              onError={() => setHlsError(true)}
            />
          )
        ) : Platform.OS === 'web' ? (
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{
              position: 'absolute', top: 0, left: 0,
              width: '100%', height: '100%',
              objectFit: 'cover', backgroundColor: '#0f0f1a',
            }}
          />
        ) : NativeRTCView && remoteStreamUrl ? (
          <NativeRTCView
            streamURL={remoteStreamUrl}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            zOrder={0}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0f0f1a' }]} />
        )}
      </Pressable>

      {/* Connecting overlay — round 62 redesign extracted into LiveConnectingOverlay.
          Pulsing red ring + round host avatar + "Conectando à live de X..." */}
      {!connected && (
        <LiveConnectingOverlay
          hostName={displayHostName}
          hostEmail={displayHostEmail}
          errorText={
            hlsError && streamType === 'cf_hls'
              ? (t('live.streamUnavailable') || 'Live indisponível')
              : (!!error && /unavail|connection failed|stream/i.test(error) ? error : null)
          }
          showRetry={hlsError && streamType === 'cf_hls'}
          onRetry={() => { setHlsError(false); setHlsRetryKey((k) => k + 1); }}
          onBack={() => router.back()}
          retryLabel={t('common.retry') || 'Tentar novamente'}
          backLabel={t('common.back') || 'Voltar'}
          connectingTo={t('live.connectingTo') || 'Conectando à live de {name}…'}
          connectingFallback={t('live.connecting') || 'Conectando…'}
        />
      )}

      {/* Joined transition — slides up a gradient overlay that wipes the
          black scrim off once the stream connects. Animated from y=0 → -H,
          opacity 1 → 0 so the stream is revealed without a hard cut. */}
      {connected ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.joinedReveal,
            {
              opacity: joinedReveal.interpolate({ inputRange: [0, 0.6, 1], outputRange: [1, 0.55, 0] }),
              transform: [{
                translateY: joinedReveal.interpolate({ inputRange: [0, 1], outputRange: [0, -SCREEN_H] }),
              }],
            },
          ]}
        />
      ) : null}

      {/* Top bar — TikTok/Instagram-grade clean header (round 62 redesign).
          Avatar + name + LIVE pill + viewer chip on the left, dots/share/X
          icon trio on the right. All extracted to LiveTopBar. */}
      <LiveTopBar
        hostName={displayHostName}
        hostEmail={displayHostEmail}
        viewerCount={viewerCount}
        paddingTop={insets.top}
        liveLabel={t('live.aoVivo') || 'AO VIVO'}
        viewersListLabel={t('live.viewersList') || 'Ver espectadores'}
        onLongPressAvatar={openHostPeek}
        onPressViewers={() => setShowViewersList(true)}
        onPressMore={() => setGiftPickerVisible(true)}
        onPressShare={handleShare}
        onClose={() => router.back()}
      />

      {/* System chip stack (joins/leaves) — left-bottom floating column.
          Replaces the old inline "X entrou" rows in the chat overlay. */}
      <LiveSystemChipStack
        items={systemEvents}
        bottom={Math.max(insets.bottom + 200, 220)}
        onDismiss={dismissSystemEvent}
      />

      {/* Right floating rail — like / chat-toggle / snapshot / share / more.
          Like button shows the cumulative count below it (TikTok parity). */}
      <LiveRightRail
        bottom={Math.max(insets.bottom + 200, 220)}
        likeCount={likeCount}
        chatHidden={chatHidden}
        onHeartPress={handleHeartTap}
        onHeartLongPress={handleHeartLongPress}
        onToggleChat={() => setChatHidden(h => !h)}
        onSnapshot={handleScreenshot}
        onShare={handleShare}
        onMore={() => setGiftPickerVisible(true)}
        i18n={{
          like: t('live.like') || 'Curtir',
          showChat: t('live.showChat') || 'Mostrar chat',
          hideChat: t('live.hideChat') || 'Ocultar chat',
          snapshot: t('live.screenshotBtn') || 'Snap',
          share: t('live.share') || 'Compartilhar',
        }}
      />

      {/* Central love-bomb particles (double-tap). Spawn from screen middle
          and ride a radial vector outward — fade and shrink over ~900ms. */}
      {burstHearts.map(b => {
        const tx = b.anim.interpolate({ inputRange: [0, 1], outputRange: [0, b.dx] });
        const ty = b.anim.interpolate({ inputRange: [0, 1], outputRange: [0, b.dy] });
        const sc = b.anim.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.4, 1.6, 0.6] });
        const op = b.anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] });
        return (
          <Animated.View
            key={`b-${b.id}`}
            pointerEvents="none"
            style={[
              styles.burstHeart,
              {
                left: b.cx - 18,
                top: b.cy - 18,
                opacity: op,
                transform: [{ translateX: tx }, { translateY: ty }, { scale: sc }],
              },
            ]}
          >
            <IconHeart size={36} color={b.color} />
          </Animated.View>
        );
      })}

      {/* Floating hearts — parabolic trajectory. Each heart has its own random
          rise/drift/phase set at spawn so the column reads as a stream of taps
          not a synchronized clone army. Opacity curve has a small overshoot at
          start (pop-in feel) and a long tail (fade-out at the top). */}
      {hearts.map(h => {
        const translateY = h.anim.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -h.rise],
        });
        // Horizontal sway: sine wave centered around the spawn X. Five sample
        // points keep the parabola smooth-ish without breaking native driver.
        const sx = (t) => Math.sin(h.driftPhase + t * Math.PI * 1.4) * h.drift;
        const translateX = h.anim.interpolate({
          inputRange: [0, 0.25, 0.5, 0.75, 1],
          outputRange: [0, sx(0.25), sx(0.5), sx(0.75), sx(1)],
        });
        const scale = h.anim.interpolate({
          inputRange: [0, 0.12, 0.5, 0.85, 1],
          outputRange: [0.35, 1.25, 1.05, 0.95, 0.7],
        });
        const opacity = h.anim.interpolate({
          inputRange: [0, 0.08, 0.7, 1],
          outputRange: [0, 1, 0.85, 0],
        });
        const rotate = h.anim.interpolate({
          inputRange: [0, 0.5, 1],
          outputRange: ['0deg', `${h.tilt}deg`, `${h.tilt * 0.6}deg`],
        });

        return (
          <Animated.View
            key={h.id}
            style={[
              styles.heart,
              {
                left: h.x - h.size / 2,
                top: h.y - h.size / 2,
                transform: [{ translateY }, { translateX }, { scale }, { rotate }],
                opacity,
              },
            ]}
            pointerEvents="none"
          >
            {h.emoji
              ? <Text style={{ fontSize: h.size + 4 }}>{h.emoji}</Text>
              : <IconHeart size={h.size} color={h.color} />}
          </Animated.View>
        );
      })}

      {/* Bottom: pinned + comments + join pill + input (round 62 redesign).
          All UI pieces extracted into dedicated components. Pure layout glue
          here — state lives in the screen, components are presentational. */}
      <View style={[styles.bottomArea, { paddingBottom: insets.bottom + 10 }]} pointerEvents="box-none">
        {/* Bottom dark blend — gradient on web, layered scrim on native. */}
        <View style={styles.bottomGradient} pointerEvents="none" />
        {Platform.OS !== 'web' ? (
          <>
            <View style={styles.bottomGradientStep1} pointerEvents="none" />
            <View style={styles.bottomGradientStep2} pointerEvents="none" />
            <View style={styles.bottomGradientStep3} pointerEvents="none" />
          </>
        ) : null}

        {/* Pinned host chip (only when host pinned). */}
        {!chatHidden ? (
          <LivePinnedChip
            pinnedMsg={pinnedMsg}
            onDismiss={() => setPinnedMsg(null)}
          />
        ) : null}

        {/* Live chat overlay — last 5 comments float over the video, with
            per-row entrance + double-tap heart chip support. */}
        {!chatHidden ? (
          <LiveChatOverlay
            messages={chatMessages}
            commentHearts={commentHearts}
            onPressMessage={handleReplyToComment}
            onOpenSheet={() => setChatSheetOpen(true)}
            hasMore={chatMessages.length > 5}
            seeAllLabel={t('live.seeAllComments') || 'Ver todos os comentários'}
          />
        ) : null}

        {/* "Pedir pra entrar" pill — sits above the comment input. Hidden if
            the chat is hidden (no input shown anyway). */}
        {!chatHidden ? (
          <View style={styles.joinPillRow}>
            <LiveJoinPill
              joinRequested={joinRequested}
              onPress={requestToJoin}
              label={t('live.requestToJoin') || 'Pedir pra entrar'}
              sentLabel={t('live.requestSent') || 'Pedido enviado'}
            />
          </View>
        ) : null}

        {/* Bottom input pill — sticky over the gradient. Heart pill in the
            right edge swaps to a send button as soon as the user types. */}
        {!chatHidden ? (
          <LiveCommentInput
            ref={inputRef}
            value={inputText}
            onChangeText={setInputText}
            onSubmit={sendComment}
            onHeartTap={handleHeartTap}
            onHeartLongPress={handleHeartLongPress}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            focused={inputFocused}
            placeholder={t('live.placeholderComment') || t('live.commentHint') || t('live.commentPlaceholder') || 'Adicionar comentário...'}
            brandAccent={brandAccent}
            a11yLabels={{
              comment: t('live.placeholderComment') || 'Comment',
              send: t('live.sendMessage') || 'Send',
              like: t('live.like') || 'Curtir',
            }}
          />
        ) : null}
      </View>

      {/* Snapshot/error toast — surfaces save state for the new screenshot
          button. Fades in/out via Animated.Value. */}
      {toast ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.toast,
            {
              opacity: toastAnim,
              top: insets.top + 70,
              transform: [{
                translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }),
              }],
            },
          ]}
        >
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      ) : null}

      {/* Free gift picker — tap an emoji to send it to the stream. Floats
          up across everyone's screen via the same live_reaction WS the
          heart button uses. */}
      <Modal
        visible={giftPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setGiftPickerVisible(false)}
      >
        <Pressable style={styles.giftSheetBackdrop} onPress={() => setGiftPickerVisible(false)}>
          <Pressable style={styles.giftSheet} onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.giftSheetHandle} />
            <Text style={styles.giftSheetTitle}>
              {t('live.sendGift') || 'Enviar presente'}
            </Text>
            <Text style={styles.giftSheetSubtitle}>
              {t('live.giftSubtitle') || 'Toque pra enviar — vai aparecer pra todo mundo na live'}
            </Text>
            <View style={styles.giftGrid}>
              {FREE_GIFTS.map((g) => (
                <TouchableOpacity
                  key={g}
                  onPress={() => sendGift(g)}
                  activeOpacity={0.6}
                  style={styles.giftCell}
                  accessibilityLabel={g}
                  accessibilityRole="button"
                >
                  <Text style={styles.giftEmoji}>{g}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Viewers list sheet — Instagram-style "who's watching".
          Recent joiners on top, capped at 100 to keep render cheap. */}
      <Modal
        visible={showViewersList}
        animationType="slide"
        transparent
        onRequestClose={() => setShowViewersList(false)}
      >
        <Pressable style={styles.viewersListBackdrop} onPress={() => setShowViewersList(false)}>
          <Pressable style={styles.viewersListSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.viewersListHandle} />
            <View style={styles.viewersListHeader}>
              <Text style={styles.viewersListTitle}>
                {t('live.whosWatching') || t('live.viewersList') || 'Quem está vendo'} · {viewerCount.toLocaleString()}
              </Text>
              <TouchableOpacity onPress={() => setShowViewersList(false)} style={styles.viewersListClose}>
                <IconX size={20} color="#fff" />
              </TouchableOpacity>
            </View>
            {viewers.length === 0 ? (
              <View style={styles.viewersListEmpty}>
                <Text style={styles.viewersListEmptyText}>
                  {viewerCount <= 1
                    ? (t('live.justYou') || 'Só você assistindo')
                    : (t('live.viewersListEmpty') || 'Ninguém entrou ainda')}
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.viewersListScroll} keyboardShouldPersistTaps="handled">
                {viewers.map((v) => (
                  <TouchableOpacity
                    key={v.email}
                    style={styles.viewerRow}
                    activeOpacity={0.7}
                    onPress={() => {
                      // Tap a viewer row → close sheet + navigate to their
                      // profile. Profile screen accepts ?email= query param.
                      try { setShowViewersList(false); router.push(`/profile?email=${encodeURIComponent(v.email)}`); } catch {}
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={v.name}
                  >
                    <AvatarCircle name={v.name} email={v.email} size={32} />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={styles.viewerRowName} numberOfLines={1}>{v.name}</Text>
                      <Text style={styles.viewerRowEmail} numberOfLines={1}>{v.email}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Expanded chat sheet — full scrollable chat history (Instagram/TikTok
          parity). Floating overlay shows only the last 5 messages; users tap
          the overlay (or the "Ver todos os comentários" pill) to open this
          sheet with the whole history. */}
      <Modal visible={chatSheetOpen} animationType="slide" transparent onRequestClose={() => setChatSheetOpen(false)}>
        <Pressable style={styles.viewersListBackdrop} onPress={() => setChatSheetOpen(false)}>
          <Pressable style={[styles.viewersListSheet, { maxHeight: '75%' }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.viewersListHeader}>
              <Text style={styles.viewersListTitle}>{t('live.chat') || 'Chat ao vivo'} · {chatMessages.length}</Text>
              <TouchableOpacity onPress={() => setChatSheetOpen(false)} style={{ padding: 6 }}>
                <IconX size={20} color="#fff" />
              </TouchableOpacity>
            </View>
            {chatMessages.length === 0 ? (
              <Text style={{ color: 'rgba(255,255,255,0.55)', textAlign: 'center', paddingVertical: 22 }}>
                {t('live.sayHello') || 'Diga oi...'}
              </Text>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
                {chatMessages.map((m) => (
                  <View key={m.id} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 8, paddingHorizontal: 4, gap: 10 }}>
                    <AvatarCircle name={m.name} email={m.email} size={32} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: 'rgba(255,255,255,0.85)', fontWeight: '700', fontSize: 13 }} numberOfLines={1}>{m.name}</Text>
                      <Text style={{ color: '#fff', fontSize: 14, lineHeight: 18 }}>{m.content}</Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Host quick-peek (Instagram long-press preview). Compact card with
          big avatar + name + LIVE pill + Follow/Share/Profile actions.
          Backdrop tap dismisses. Triggered by long-press on the top-bar
          host avatar or the right-rail host avatar. */}
      <Modal visible={hostPeekOpen} animationType="fade" transparent onRequestClose={() => setHostPeekOpen(false)}>
        <Pressable style={styles.peekBackdrop} onPress={() => setHostPeekOpen(false)}>
          <Pressable style={styles.peekCard} onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.peekHeader}>
              <View style={styles.peekAvatarRing} pointerEvents="none" />
              <AvatarCircle
                name={displayHostName}
                email={displayHostEmail}
                size={72}
              />
              <View style={styles.peekLivePill} pointerEvents="none">
                <Text style={styles.liveBadgeText}>{t('live.aoVivo') || 'AO VIVO'}</Text>
              </View>
            </View>
            <Text style={styles.peekName} numberOfLines={1}>{displayHostName || '…'}</Text>
            {displayHostEmail ? (
              <Text style={styles.peekEmail} numberOfLines={1}>{displayHostEmail}</Text>
            ) : null}
            <View style={styles.peekActions}>
              <TouchableOpacity
                onPress={() => { toggleFollow(); }}
                activeOpacity={0.85}
                style={[
                  styles.peekActionBtn,
                  following ? styles.peekActionGhost : { backgroundColor: brandAccent },
                ]}
                accessibilityRole="button"
                accessibilityLabel={following ? (t('live.following') || 'Seguindo') : (t('live.follow') || 'Seguir')}
              >
                {following
                  ? <IconCheck size={16} color="#fff" />
                  : <IconUserPlus size={16} color="#fff" />}
                <Text style={styles.peekActionText}>
                  {following ? (t('live.following') || 'Seguindo') : (t('live.follow') || 'Seguir')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { setHostPeekOpen(false); handleShare(); }}
                activeOpacity={0.85}
                style={[styles.peekActionBtn, styles.peekActionGhost]}
                accessibilityRole="button"
                accessibilityLabel={t('live.share') || 'Compartilhar'}
              >
                <IconShare size={16} color="#fff" />
                <Text style={styles.peekActionText}>{t('live.share') || 'Compartilhar'}</Text>
              </TouchableOpacity>
            </View>
            {displayHostEmail ? (
              <TouchableOpacity
                onPress={() => {
                  setHostPeekOpen(false);
                  try { router.push(`/profile?email=${encodeURIComponent(displayHostEmail)}`); } catch {}
                }}
                activeOpacity={0.7}
                style={styles.peekProfileLink}
                accessibilityRole="button"
              >
                <Text style={styles.peekProfileLinkText}>
                  {t('live.viewProfile') || 'Ver perfil'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Entry-flash overlay — 500ms white curtain with "Entrando…" so the
          tap → live-viewer feels instant, regardless of how long the WebRTC
          handshake takes. Rendered LAST so it sits above every other layer
          (top bar, connecting skeleton, joinedReveal). pointerEvents="none"
          so it never eats taps even if a JS hiccup keeps it on screen a
          frame longer than expected. */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: '#fff',
            opacity: entryFlash,
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 99999,
          },
        ]}
      >
        <Text style={{
          color: '#dc2626',
          fontSize: 18,
          fontWeight: '800',
          letterSpacing: 0.6,
        }}>
          {t('live.entering') || 'Entrando…'}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  centered: {
    flex: 1,
    backgroundColor: '#0f0f1a',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  nativeText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
  },
  nativeSubtext: {
    color: '#6b7280',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 24,
  },
  backBtn: {
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    marginTop: 20,
  },
  backBtnText: {
    color: '#94a3b8',
    fontSize: 16,
    fontWeight: '600',
  },
  endedBg: {
    ...(Platform.OS === 'web' ? {
      background: 'radial-gradient(circle at 50% 35%, rgba(124,58,237,0.35), rgba(15,15,26,0.92) 55%, #0a0a14 100%)',
    } : {
      backgroundColor: '#0a0a14',
    }),
  },
  // Native fallback radial wash — two stacked translucent circles centered
  // behind the avatar so the dark scrim has a soft purple bloom even without
  // a gradient library.
  endedWash: {
    position: 'absolute',
    top: '20%',
    width: 360, height: 360, borderRadius: 180,
    backgroundColor: 'rgba(124,58,237,0.18)',
    ...(Platform.OS === 'web' ? { display: 'none' } : {}),
  },
  endedAvatarRing: {
    position: 'absolute',
    top: '20%',
    marginTop: -8,
    width: 116, height: 116, borderRadius: 58,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.18)',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 32px rgba(124,58,237,0.35), inset 0 0 0 1px rgba(255,255,255,0.08)',
    } : {}),
  },
  endedText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 6,
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  endedSub: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 22,
    lineHeight: 19,
  },
  endedAvatar: {
    marginBottom: 18,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  endedActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 28,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  endedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 26,
    minWidth: 140,
    justifyContent: 'center',
  },
  endedBtnPrimary: {
    backgroundColor: ACCENT,
    ...(Platform.OS === 'web' ? { boxShadow: '0 6px 20px rgba(124,58,237,0.55)' } : {}),
  },
  endedBtnGhost: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  endedBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  endedBackLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 20,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  endedBackLinkText: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 13,
    fontWeight: '600',
  },
  // Secondary discover-more button — purple-tinted pill below the back link.
  endedDiscover: {
    marginTop: 12,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: 'rgba(124,58,237,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(196,181,253,0.35)',
  },
  endedDiscoverText: {
    color: '#e9d5ff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },

  // Connecting
  connectingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15,15,26,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 5,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' } : {}),
  },
  connectingAvatar: {
    borderWidth: 3,
    borderColor: LIVE_RED,
  },
  connectingName: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 16,
  },
  connectingText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 14,
    marginTop: 8,
    letterSpacing: 0.5,
  },

  // Top bar — soft glass gradient header. Bigger paddingBottom because the
  // avatar block (54px) overhangs the bottom of the row a bit.
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 14,
    zIndex: 10,
    gap: 8,
    ...(Platform.OS === 'web' ? {
      background: 'linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0.05))',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
    } : {
      backgroundColor: 'rgba(0,0,0,0.32)',
    }),
  },
  // Host avatar block — pulsing red ring + LIVE pill anchored at the bottom.
  // The pulse is a separate Animated.View laid behind the avatar so the
  // avatar image itself doesn't scale (kept QA-friendly).
  hostAvatarBlock: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  avatarRingStatic: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 32,
    borderWidth: 2.5,
    borderColor: LIVE_RED,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 14px rgba(220,38,38,0.55), inset 0 0 0 1px rgba(255,255,255,0.18)',
    } : {}),
  },
  avatarRingPulse: {
    position: 'absolute',
    top: -4, left: -4, right: -4, bottom: -4,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: LIVE_RED,
  },
  liveBadgeInline: {
    position: 'absolute',
    bottom: -4,
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
    backgroundColor: LIVE_RED,
    borderWidth: 1.5,
    borderColor: '#fff',
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 6px rgba(220,38,38,0.55)' } : {}),
  },
  hostInfo: {
    flex: 1,
    marginLeft: 6,
  },
  hostName: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.1,
    ...(Platform.OS === 'web' ? { textShadow: '0 1px 3px rgba(0,0,0,0.5)' } : {}),
  },
  liveTitle: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 11,
    marginTop: 1,
    fontWeight: '500',
  },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },

  // Follow pill in the host pill — collapses to a check chip after follow.
  followPill: {
    backgroundColor: ACCENT,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 8px rgba(124,58,237,0.45)' } : {}),
  },
  followPillText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  followingChip: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(34,197,94,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Viewer chip (live count) — sits in the top bar between host pill and close.
  viewersListBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end',
  },
  viewersListSheet: {
    backgroundColor: '#16162b', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: 28, maxHeight: '70%',
  },
  viewersListHandle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)', marginTop: 10, marginBottom: 4,
  },
  viewersListHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 12, paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  viewersListTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  viewersListClose: { padding: 6 },
  viewersListEmpty: { paddingVertical: 40, alignItems: 'center' },
  viewersListEmptyText: { color: 'rgba(255,255,255,0.55)', fontSize: 14 },
  viewersListScroll: { paddingHorizontal: 16, paddingTop: 8 },
  viewerRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  viewerRowName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  viewerRowEmail: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 1 },
  viewerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  viewerDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: '#fff',
  },
  viewerChipText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  // "+1" float that pops above the eye pill when a new viewer joins.
  viewerPlusOne: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#22c55e',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: '#fff',
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 8px rgba(34,197,94,0.55)' } : {}),
  },
  viewerPlusOneText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.3,
  },

  // Connection quality dot — small bola top-right next to the close X.
  qualityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    ...(Platform.OS === 'web' ? { boxShadow: '0 0 6px currentColor' } : {}),
  },

  // LIVE pill text shared with the inline pill under the avatar.
  liveBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.9,
  },

  // Right-rail avatar with the small + chip overlay (TikTok-style follow CTA).
  railAvatarWrap: {
    width: 52,
    alignItems: 'center',
    marginBottom: 4,
  },
  railAvatar: {
    // borderRadius matches AvatarCircle 48/2 — sem isso aparece um quadrado
    // branco em volta do círculo (round 56 fix).
    borderRadius: 24,
    borderWidth: 2,
    borderColor: '#fff',
  },
  railAvatarPlus: {
    position: 'absolute',
    bottom: -4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: ACCENT,
    borderWidth: 2,
    borderColor: '#0f0f1a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  railAvatarPlusText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 16,
  },

  // Side action buttons
  sideActions: {
    position: 'absolute',
    right: 12,
    zIndex: 15,
    gap: 14,
    alignItems: 'center',
  },
  sideBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' } : {}),
  },

  bottomArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 12,
  },
  // Row hosting the "Pedir pra entrar" pill above the comment input. Adds a
  // small bottom margin so the pill doesn't sit flush against the input.
  joinPillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    paddingRight: 70,
  },
  // Soft gradient sheen above the input — pure CSS on web, transparent
  // overlay on native (avoids extra LinearGradient dep for one stripe).
  bottomGradient: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: 110,
    zIndex: -1,
    ...(Platform.OS === 'web' ? {
      background: 'linear-gradient(to top, rgba(0,0,0,0.7), rgba(0,0,0,0.2) 60%, transparent)',
    } : {
      backgroundColor: 'rgba(0,0,0,0.32)',
    }),
  },
  // 3-step manual gradient for native — bottom is darkest, top is lightest.
  // Each layer is positioned absolutely so they stack without affecting
  // layout. Tuned to fade the dark blend cleanly past the comments column.
  bottomGradientStep1: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: 60,
    backgroundColor: 'rgba(0,0,0,0.35)',
    zIndex: -1,
  },
  bottomGradientStep2: {
    position: 'absolute',
    left: 0, right: 0, bottom: 60,
    height: 50,
    backgroundColor: 'rgba(0,0,0,0.18)',
    zIndex: -1,
  },
  bottomGradientStep3: {
    position: 'absolute',
    left: 0, right: 0, bottom: 110,
    height: 40,
    backgroundColor: 'rgba(0,0,0,0.08)',
    zIndex: -1,
  },
  // Top-center toast for screenshot save feedback.
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    left: 0, right: 0,
    alignItems: 'center',
    zIndex: 50,
  },
  toastText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  heart: {
    position: 'absolute',
    zIndex: 20,
  },
  // Central burst hearts (double-tap love bomb).
  burstHeart: {
    position: 'absolute',
    zIndex: 21,
  },

  // Comments overlay — sits between the right rail and the input pill.
  // On web we apply a mask gradient so the top of the column melts into the
  // frame; on native we rely on per-row stack alpha (Animated mask gradients
  // would need expo-linear-gradient and add a build dep for one cosmetic).
  commentsOverlay: {
    paddingRight: 70, // leave room for the right rail
    marginBottom: 8,
    gap: 5,
    ...(Platform.OS === 'web' ? {
      WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.2) 10%, #000 35%)',
      maskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.2) 10%, #000 35%)',
    } : {}),
  },
  // "Ver todos os comentários" chip — small pill above the live comments
  // stack. SVG-only (no arrow emoji per design rule).
  seeAllChip: {
    alignSelf: 'flex-start',
    marginBottom: 6,
    paddingHorizontal: 9,
    paddingVertical: 3,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  seeAllChipText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  commentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    maxWidth: '88%',
  },
  commentBubble: {
    flexShrink: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderTopLeftRadius: 4,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' } : {}),
  },
  commentName: {
    color: '#c4b5fd',          // soft lavender for contrast vs the body
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
    marginBottom: 1,
  },
  commentText: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '500',
  },
  // "x entrou" system row — distinct from comments, no avatar bubble.
  systemJoinRow: {
    alignSelf: 'flex-start',
    maxWidth: '85%',
  },
  systemJoinPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(124,58,237,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(196,181,253,0.35)',
    borderRadius: 12,
  },
  systemJoinText: {
    color: 'rgba(255,255,255,0.95)',
    fontSize: 11.5,
    fontWeight: '500',
  },
  systemJoinName: {
    fontWeight: '800',
    color: '#fff',
  },

  // Bottom comment bar — pill input + heart + purple send.
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 8,
  },
  inputPill: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
    } : {}),
  },
  inputPillFocused: {
    borderColor: 'rgba(196,181,253,0.7)',
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  inputText: {
    paddingHorizontal: 18,
    color: '#fff',
    fontSize: 14,
    height: 44,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  // Inline heart shortcut — quick-tap a heart without reaching the right rail.
  inlineHeartBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
    } : {}),
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnActive: {
    backgroundColor: ACCENT,
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 12px rgba(124,58,237,0.55)' } : {}),
  },

  // Gift picker sheet (free emoji gifts)
  giftSheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  giftSheet: {
    backgroundColor: '#1a1a2e',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 10,
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'ios' ? 36 : 20,
  },
  giftSheetHandle: {
    alignSelf: 'center',
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    marginBottom: 14,
  },
  giftSheetTitle: {
    color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center',
  },
  giftSheetSubtitle: {
    color: 'rgba(255,255,255,0.55)', fontSize: 13, textAlign: 'center',
    marginTop: 4, marginBottom: 18,
  },
  giftGrid: {
    flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12,
  },
  giftCell: {
    width: 64, height: 64, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  giftEmoji: { fontSize: 30 },

  // Joined-transition reveal — a black layer that slides up off the screen
  // once we've connected to the stream. Visual covers the entire viewport
  // before sliding away (translateY animated to -SCREEN_H).
  joinedReveal: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(15,15,26,0.92)',
    zIndex: 6,
    ...(Platform.OS === 'web' ? {
      background: 'linear-gradient(to bottom, rgba(15,15,26,0.95), rgba(124,58,237,0.18) 60%, rgba(15,15,26,0.95))',
    } : {}),
  },

  // Connecting overlay halo around the avatar — pulsing red ring that uses
  // the same vocabulary as the connected top-bar ring (visual continuity).
  connectingAvatarHalo: {
    position: 'absolute',
    width: 100, height: 100, borderRadius: 50,
    alignItems: 'center', justifyContent: 'center',
    marginTop: -20, // visually centers the ring behind the 80px avatar
  },
  connectingAvatarPulseRing: {
    width: 100, height: 100, borderRadius: 50,
    borderWidth: 2, borderColor: LIVE_RED,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 24px rgba(220,38,38,0.5)',
    } : {}),
  },

  // Send button nested inside the input pill (Instagram parity). Floats on
  // the right edge of the pill; only appears when there's text to send.
  sendBtnInside: {
    position: 'absolute',
    right: 5,
    top: 5,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 10px rgba(124,58,237,0.55)' } : {}),
  },

  // Pinned host comment chip — yellow-bordered pill above the live comments
  // column. TikTok parity. IconPin on the left, host name + message body
  // stacked. Tap dismisses for this viewer only.
  pinnedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(253,224,71,0.55)',
    maxWidth: '85%',
    alignSelf: 'flex-start',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      boxShadow: '0 2px 10px rgba(253,224,71,0.18)',
    } : {}),
  },
  pinnedChipName: {
    color: '#fde047',
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  pinnedChipText: {
    color: '#fff',
    fontSize: 12.5,
    lineHeight: 16,
    fontWeight: '500',
  },

  // Inline heart chip on a comment row — appears for ~1.3s on double-tap.
  commentHeartChip: {
    marginLeft: 6,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: LIVE_RED,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#fff',
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 8px rgba(220,38,38,0.55)' } : {}),
  },

  // Host quick-peek (long-press preview) — floats centered with a soft scrim.
  peekBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  peekCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#16162b',
    borderRadius: 22,
    paddingTop: 22,
    paddingBottom: 18,
    paddingHorizontal: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
    } : {}),
  },
  peekHeader: {
    width: 88, height: 88,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    marginBottom: 10,
  },
  peekAvatarRing: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 44,
    borderWidth: 2.5,
    borderColor: LIVE_RED,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 18px rgba(220,38,38,0.45)',
    } : {}),
  },
  peekLivePill: {
    position: 'absolute',
    bottom: -4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: LIVE_RED,
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  peekName: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '800',
    marginTop: 6,
    letterSpacing: 0.2,
  },
  peekEmail: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    marginTop: 2,
  },
  peekActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
    width: '100%',
    justifyContent: 'center',
  },
  peekActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 22,
  },
  peekActionGhost: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  peekActionText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  peekProfileLink: {
    marginTop: 12,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  peekProfileLinkText: {
    color: 'rgba(196,181,253,0.95)',
    fontSize: 13,
    fontWeight: '700',
  },
});
