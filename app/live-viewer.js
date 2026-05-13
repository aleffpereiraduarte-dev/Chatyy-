import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, Animated,
  Dimensions, ActivityIndicator, Share, Modal, Pressable, ScrollView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconX, IconHeart, IconShare, IconStar, IconSend,
  IconUserPlus, IconCheck, IconMoreVert, IconRotateCcw, IconCamera,
  IconEye,
} from '../components/Icons';

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
  const insets = useSafeAreaInsets();

  const [connected, setConnected] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [viewers, setViewers] = useState([]); // [{email, name, joinedAt}]
  const [showViewersList, setShowViewersList] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [liveEnded, setLiveEnded] = useState(false);
  const [hearts, setHearts] = useState([]);
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

  // Refs
  const remoteVideoRef = useRef(null);
  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const sessionIdRef = useRef(paramSessionId);
  const chatIdRef = useRef(0);
  const heartIdRef = useRef(0);
  const iceCandidateQueueRef = useRef([]);
  const endTimerRef = useRef(null);
  const reconnectTimerRef = useRef(null);
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
  // Viewer-count "+1" bump — small floating chip that pops above the eye pill
  // whenever a new viewer joins. Instagram/TikTok parity: subtle but lively.
  const viewerCountScale = useRef(new Animated.Value(1)).current;
  const viewerPlusOneAnim = useRef(new Animated.Value(0)).current;
  const [viewerPlusOneVisible, setViewerPlusOneVisible] = useState(false);
  const prevViewerCountRef = useRef(0);

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
  useEffect(() => {
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
  }, [connected]);

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
  useEffect(() => {
    if (connected || liveEnded) return undefined;
    if (!paramSessionId) return undefined;
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
  }, [connected, liveEnded, paramSessionId]);

  // Connect to signaling and WebRTC
  useEffect(() => {
    if (!RTC_PeerConnection || !RTC_SessionDescription || !RTC_IceCandidate) {
      setError(t('live.connectionFailed') || 'WebRTC not supported on this device');
      return;
    }
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
          ws.send(JSON.stringify({
            type: 'live_join',
            session_id: paramSessionId,
          }));
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
            // Also surface as a chat message so the user sees "X entrou"
            // inline with the live chat stream (Instagram parity).
            {
              const entry = new Animated.Value(0);
              setChatMessages(prev => [
                ...prev.slice(-49),
                {
                  id: 'sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                  isSystem: true,
                  email: msg.viewer_email,
                  name: msg.viewer_name || msg.viewer_email.split('@')[0],
                  text: (t?.('live.joined') || 'entrou'),
                  ts: Date.now(),
                  entry,
                },
              ]);
              Animated.timing(entry, { toValue: 1, duration: 260, useNativeDriver: true }).start();
            }
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
  }, []);

  const handleSendChat = useCallback((text) => {
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

    // Send reaction via WS
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
  const [joinRequested, setJoinRequested] = useState(false);
  const requestToJoin = useCallback(() => {
    if (joinRequested) return;
    try {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && paramSessionId) {
        ws.send(JSON.stringify({
          type: 'live_join_request',
          session_id: paramSessionId,
          viewer_email: user?.email,
          viewer_name: user?.name || (user?.email || '').split('@')[0],
        }));
        setJoinRequested(true);
        setTimeout(() => setJoinRequested(false), 60000); // allow re-request after 1 min
      }
    } catch {}
  }, [paramSessionId, user?.email, user?.name, joinRequested]);

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
  // mirrors Instagram Live (and gives the comment a clear target). We also
  // focus the input so the keyboard pops without an extra tap.
  const handleReplyToComment = useCallback((msg) => {
    if (!msg?.name) return;
    const handle = String(msg.name).replace(/\s+/g, '');
    setInputText((prev) => {
      // Avoid duplicating an @prefix if user already typed one for the same
      // person — just leave the field alone.
      const trimmed = (prev || '').trim();
      if (trimmed.startsWith(`@${handle}`)) return prev;
      return `@${handle} `;
    });
    setTimeout(() => { try { inputRef.current?.focus?.(); } catch {} }, 30);
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

  // Long-press the rail heart → fire a 5-heart spam burst, Instagram-style.
  // Each heart is spawned ~80ms apart so the column reads like a stream of
  // taps without the user actually spamming. Also pops the button each round.
  const handleHeartLongPress = useCallback(() => {
    let i = 0;
    const fire = () => {
      if (i++ >= 5) return;
      spawnHeart();
      popHeartButton();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
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
        </View>

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
        {Platform.OS === 'web' ? (
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

      {/* Connecting overlay */}
      {!connected && (
        <View style={styles.connectingOverlay}>
          <AvatarCircle
            name={displayHostName}
            email={displayHostEmail}
            size={80}
            style={styles.connectingAvatar}
          />
          <Animated.Text style={[styles.connectingName, { opacity: connectingPulse }]}>
            {displayHostName || '…'}
          </Animated.Text>
          {!!error && /unavail|connection failed|stream/i.test(error) ? (
            <>
              <Text style={[styles.connectingText, { color: '#ef4444', marginTop: 14 }]}>
                {error}
              </Text>
              <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 18, paddingHorizontal: 24, paddingVertical: 10, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 20 }}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>{t('common.back') || 'Voltar'}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <ActivityIndicator size="small" color="rgba(255,255,255,0.5)" style={{ marginTop: 16 }} />
              <Animated.Text style={[styles.connectingText, { opacity: connectingPulse }]}>
                {error || (t('live.connecting') || 'Connecting...')}
              </Animated.Text>
            </>
          )}
        </View>
      )}

      {/* Top bar — Instagram/TikTok-grade header. BIG host avatar (54px) with
          a pulsing red gradient ring + LIVE badge tucked under it. To the right:
          host name + title + Follow pill. Far right: viewer count (eye + 1.2K
          humanized) + quality dot + close. Single dense row, no duplicate LIVE
          badge floating below — keeps the stage clean.
          Why box-none: we want taps to pass through the empty padding regions
          so the double-tap love-bomb still fires from anywhere on the stage. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        {/* Big host avatar + pulsing red ring + integrated LIVE pill. The ring
            uses Animated.View opacity so it breathes; the avatar itself stays
            crisp (no scale animation — was distracting in QA). */}
        <View style={styles.hostAvatarBlock} pointerEvents="box-none">
          <Animated.View style={[styles.avatarRingPulse, { opacity: livePulse }]} pointerEvents="none" />
          <View style={styles.avatarRingStatic} pointerEvents="none" />
          <AvatarCircle
            name={displayHostName}
            email={displayHostEmail}
            size={54}
          />
          <View style={styles.liveBadgeInline} pointerEvents="none">
            <Text style={styles.liveBadgeText}>{t('live.aoVivo') || 'AO VIVO'}</Text>
          </View>
        </View>

        <View style={styles.hostInfo}>
          <Text style={styles.hostName} numberOfLines={1}>
            {displayHostName || '…'}
          </Text>
          {paramTitle ? (
            <Text style={styles.liveTitle} numberOfLines={1}>{paramTitle}</Text>
          ) : (
            <Text style={styles.liveTitle} numberOfLines={1}>{t('live.liveNow') || t('live.connected') || 'Ao vivo agora'}</Text>
          )}
        </View>

        {!following ? (
          <TouchableOpacity
            onPress={toggleFollow}
            style={styles.followPill}
            accessibilityLabel={t('live.follow') || 'Follow'}
            accessibilityRole="button"
            activeOpacity={0.85}
          >
            <Text style={styles.followPillText}>{t('live.follow') || 'Seguir'}</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.followingChip}>
            <IconCheck size={14} color="#fff" />
          </View>
        )}

        <Animated.View style={{ transform: [{ scale: viewerCountScale }] }}>
          <TouchableOpacity
            style={styles.viewerChip}
            activeOpacity={0.7}
            onPress={() => setShowViewersList(true)}
            accessibilityLabel={t('live.viewersList') || 'Ver espectadores'}
            accessibilityRole="button"
          >
            <IconEye size={13} color="#fff" />
            <Text style={styles.viewerChipText}>{humanizeCount(viewerCount)}</Text>
          </TouchableOpacity>
          {viewerPlusOneVisible ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.viewerPlusOne,
                {
                  opacity: viewerPlusOneAnim.interpolate({ inputRange: [0, 0.2, 0.9, 1], outputRange: [0, 1, 1, 0] }),
                  transform: [{
                    translateY: viewerPlusOneAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -18] }),
                  }, {
                    scale: viewerPlusOneAnim.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.6, 1.1, 0.9] }),
                  }],
                },
              ]}
            >
              <Text style={styles.viewerPlusOneText}>+1</Text>
            </Animated.View>
          ) : null}
        </Animated.View>

        <View style={[styles.qualityDot, { backgroundColor: qualityColor }]} />

        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.closeBtn}
          accessibilityLabel="Close"
          accessibilityRole="button"
        >
          <IconX size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* "Pedir pra entrar" pill — TikTok/Instagram parity. Sits in the
          left-bottom corner so it's discoverable on first launch (the right
          rail is muscle-memory for hearts/share). Becomes a "Pediu ✓" disabled
          chip for 60s after sending so spam is naturally rate-limited. */}
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 14, bottom: 200 + insets.bottom, zIndex: 5 }}>
        <TouchableOpacity
          onPress={requestToJoin}
          activeOpacity={0.85}
          disabled={joinRequested}
          accessibilityLabel={t('live.requestToJoin') || 'Pedir pra entrar'}
          accessibilityRole="button"
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 6,
            paddingHorizontal: 12, paddingVertical: 7,
            borderRadius: 18,
            backgroundColor: joinRequested ? 'rgba(255,255,255,0.18)' : 'rgba(124,58,237,0.95)',
            borderWidth: 1, borderColor: joinRequested ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.4)',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>
            {joinRequested ? (t('live.requestSent') || 'Pedido enviado ✓') : (t('live.requestToJoin') || 'Pedir pra entrar')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Right rail — host avatar (tap to view profile / follow), heart,
          gift, share, more. Mirrors the TikTok layout so muscle memory carries
          straight over from other live apps. */}
      <View style={[styles.sideActions, { bottom: 200 + insets.bottom }]} pointerEvents="box-none">
        <TouchableOpacity
          onPress={toggleFollow}
          activeOpacity={0.85}
          accessibilityLabel="Host profile"
          accessibilityRole="button"
          style={styles.railAvatarWrap}
        >
          <AvatarCircle
            name={displayHostName}
            email={displayHostEmail}
            size={48}
            style={styles.railAvatar}
          />
          {!following ? (
            <View style={styles.railAvatarPlus}>
              <Text style={styles.railAvatarPlusText}>+</Text>
            </View>
          ) : null}
        </TouchableOpacity>

        <Animated.View style={{ transform: [{ scale: heartScale }] }}>
          <TouchableOpacity
            style={styles.sideBtn}
            onPress={handleHeartTap}
            onLongPress={handleHeartLongPress}
            delayLongPress={220}
            activeOpacity={0.7}
            accessibilityLabel={t('live.reactBtn') || 'React'}
            accessibilityRole="button"
          >
            <IconHeart size={26} color={LIVE_RED} />
          </TouchableOpacity>
        </Animated.View>

        <TouchableOpacity
          style={styles.sideBtn}
          onPress={handleScreenshot}
          activeOpacity={0.7}
          accessibilityLabel={t('live.screenshotBtn') || 'Snap'}
          accessibilityRole="button"
        >
          <IconCamera size={22} color="#fff" />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.sideBtn}
          onPress={handleShare}
          activeOpacity={0.7}
          accessibilityLabel={t('live.share') || 'Share'}
          accessibilityRole="button"
        >
          <IconShare size={22} color="#fff" />
        </TouchableOpacity>

        {/* Gift button — placeholder slot in the rail. The actual picker is
            free for now; once IAP coins ship this opens the paid grid. */}
        <TouchableOpacity
          style={styles.sideBtn}
          onPress={() => setGiftPickerVisible(true)}
          activeOpacity={0.7}
          accessibilityLabel={t('live.sendGift') || 'Send gift'}
          accessibilityRole="button"
        >
          <IconStar size={24} color="#fbbf24" />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.sideBtn}
          onPress={handleShare}
          activeOpacity={0.7}
          accessibilityLabel="More"
          accessibilityRole="button"
        >
          <IconMoreVert size={22} color="#fff" />
        </TouchableOpacity>
      </View>

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

      {/* Bottom: comments overlay + pill input.
          Comments float over the video — last 5 visible. We use a fade mask
          (web) and stack-position alpha (all platforms) so the top of the
          column melts into the frame Instagram-style. */}
      <View style={[styles.bottomArea, { paddingBottom: insets.bottom + 10 }]} pointerEvents="box-none">
        {/* Soft gradient sheen above the input bar so the pill reads cleanly
            against bright frames — Instagram/TikTok use the same trick. On
            native we don't have linear-gradient, so we stack 3 dim layers
            with stepped alpha to fake the bottom-up dark blend. */}
        <View style={styles.bottomGradient} pointerEvents="none" />
        {Platform.OS !== 'web' ? (
          <>
            <View style={styles.bottomGradientStep1} pointerEvents="none" />
            <View style={styles.bottomGradientStep2} pointerEvents="none" />
            <View style={styles.bottomGradientStep3} pointerEvents="none" />
          </>
        ) : null}
        <TouchableOpacity
          onPress={() => setChatSheetOpen(true)}
          activeOpacity={0.85}
          style={styles.commentsOverlay}
          accessibilityLabel={t('live.chat') || 'Chat ao vivo'}
          accessibilityRole="button"
        >
          {chatMessages.length > 5 ? (
            <View style={styles.seeAllChip} pointerEvents="none">
              <Text style={styles.seeAllChipText}>
                {t('live.seeAllComments') || 'Ver todos os comentários'}
              </Text>
            </View>
          ) : null}
          {visibleComments.map((m, idx) => {
            // Older comments fade softer. Stack alpha runs 0.25 → 1 from top.
            // The system-join chip uses a different look (no avatar bubble).
            const stackAlpha = 0.25 + (idx / Math.max(visibleComments.length - 1, 1)) * 0.75;
            // Entrance animation — slide-up + fade-in. Older messages (loaded
            // from history) don't have `entry`, so we treat them as already
            // settled (no animation re-trigger on re-render).
            const entry = m.entry;
            const opacity = entry
              ? entry.interpolate({ inputRange: [0, 1], outputRange: [0, stackAlpha] })
              : stackAlpha;
            const translateY = entry
              ? entry.interpolate({ inputRange: [0, 1], outputRange: [12, 0] })
              : 0;
            if (m.isSystem) {
              return (
                <Animated.View
                  key={m.id}
                  style={[styles.systemJoinRow, { opacity, transform: [{ translateY }] }]}
                  pointerEvents="none"
                >
                  <View style={styles.systemJoinPill}>
                    <Text style={styles.systemJoinText} numberOfLines={1}>
                      <Text style={styles.systemJoinName}>{m.name}</Text>{' '}{m.text}
                    </Text>
                  </View>
                </Animated.View>
              );
            }
            // Tap a comment → @reply seed in input. Stop press from bubbling
            // up to the parent overlay (which would open the full chat sheet).
            return (
              <Animated.View
                key={m.id}
                style={{ opacity, transform: [{ translateY }] }}
              >
                <TouchableOpacity
                  onPress={(e) => { e.stopPropagation?.(); handleReplyToComment(m); }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Reply to ${m.name}`}
                  style={styles.commentRow}
                >
                  <AvatarCircle name={m.name} email={m.email} size={22} />
                  <View style={styles.commentBubble}>
                    <Text style={styles.commentName} numberOfLines={1}>{m.name}</Text>
                    <Text style={styles.commentText} numberOfLines={3}>{m.content}</Text>
                  </View>
                </TouchableOpacity>
              </Animated.View>
            );
          })}
        </TouchableOpacity>

        <View style={styles.inputBar}>
          <View style={[styles.inputPill, inputFocused && styles.inputPillFocused]}>
            <TextInput
              ref={inputRef}
              style={styles.inputText}
              value={inputText}
              onChangeText={setInputText}
              placeholder={t('live.commentHint') || t('live.commentPlaceholder') || 'Comentar...'}
              placeholderTextColor="rgba(255,255,255,0.65)"
              returnKeyType="send"
              onSubmitEditing={sendComment}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              blurOnSubmit={false}
              accessibilityLabel={t('live.commentHint') || 'Comment'}
            />
          </View>
          {/* Inline heart shortcut — same action as the right-rail heart, but
              within thumb reach of the input bar (Instagram parity). Tap to
              fire a single heart + WS reaction; long-press for the 5-spam
              burst. */}
          <Animated.View style={{ transform: [{ scale: heartScale }] }}>
            <TouchableOpacity
              onPress={handleHeartTap}
              onLongPress={handleHeartLongPress}
              delayLongPress={220}
              style={styles.inlineHeartBtn}
              activeOpacity={0.7}
              accessibilityLabel={t('live.reactBtn') || 'React'}
              accessibilityRole="button"
            >
              <IconHeart size={22} color={LIVE_RED} />
            </TouchableOpacity>
          </Animated.View>
          {inputText.trim() ? (
            <TouchableOpacity
              onPress={sendComment}
              style={[styles.sendBtn, styles.sendBtnActive]}
              activeOpacity={0.85}
              accessibilityLabel="Send comment"
              accessibilityRole="button"
            >
              <IconSend size={16} color="#fff" />
            </TouchableOpacity>
          ) : null}
        </View>
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
                {t('live.viewersList') || 'Espectadores'} · {viewerCount.toLocaleString()}
              </Text>
              <TouchableOpacity onPress={() => setShowViewersList(false)} style={styles.viewersListClose}>
                <IconX size={20} color="#fff" />
              </TouchableOpacity>
            </View>
            {viewers.length === 0 ? (
              <View style={styles.viewersListEmpty}>
                <Text style={styles.viewersListEmptyText}>
                  {t('live.viewersListEmpty') || 'Ninguém entrou ainda'}
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.viewersListScroll} keyboardShouldPersistTaps="handled">
                {viewers.map((v) => (
                  <View key={v.email} style={styles.viewerRow}>
                    <AvatarCircle name={v.name} email={v.email} size={40} />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={styles.viewerRowName} numberOfLines={1}>{v.name}</Text>
                      <Text style={styles.viewerRowEmail} numberOfLines={1}>{v.email}</Text>
                    </View>
                  </View>
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
});
