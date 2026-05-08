import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, Animated,
  Dimensions, ActivityIndicator, Share, Modal, Pressable,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconX, IconHeart, IconShare, IconStar, IconSend,
  IconUserPlus, IconCheck, IconMoreVert, IconRotateCcw,
} from '../components/Icons';

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
const WS_URL = Platform.OS === 'web' ? 'wss://chatyy.com.br/ws' : 'wss://mail.onemundo.com.br/ws';
const MAX_HEARTS = 20;
const LIVE_RED = '#dc2626';
const ACCENT = '#7C3AED';

const HEART_COLORS = ['#ef4444', '#f43f5e', '#ec4899', '#a855f7', '#f97316'];

export default function LiveViewerScreen() {
  const params = useLocalSearchParams();
  const {
    sessionId: paramSessionId,
    hostEmail, hostName, title: paramTitle,
  } = params;
  const router = useRouter();
  const { user } = useAuth();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const [connected, setConnected] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
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

  // Animations
  const connectingPulse = useRef(new Animated.Value(0.4)).current;
  const endedFade = useRef(new Animated.Value(0)).current;
  const livePulse = useRef(new Animated.Value(1)).current;
  const heartScale = useRef(new Animated.Value(1)).current;

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
        case 'live_reaction':
          // Prefer emoji (from gift picker). Heart button also sends
          // emoji:'❤️' which we treat as the default heart animation
          // (no emoji text) for visual consistency with taps.
          if (msg.emoji && msg.emoji !== '❤️') spawnHeart(msg.emoji);
          else spawnHeart(msg.x);
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
    setChatMessages(prev => [...prev, {
      id: String(++chatIdRef.current),
      name: msg.sender_name || msg.sender_email?.split('@')[0] || '?',
      email: msg.sender_email,
      content: msg.content,
      type: msg.msg_type || 'chat',
    }]);
  }, []);

  const handleSendChat = useCallback((text) => {
    const senderName = user?.name || user?.email?.split('@')[0] || 'You';

    setChatMessages(prev => [...prev, {
      id: String(++chatIdRef.current),
      name: senderName,
      email: user?.email,
      content: text,
      type: 'chat',
    }]);

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

  // Heart animation
  // Spawns a floating animation. If an emoji is passed we render that
  // instead of the heart icon — the gift picker uses this to fire
  // rose/diamond/fireworks etc. across the screen for everyone.
  const spawnHeart = useCallback((emojiOrX) => {
    const id = ++heartIdRef.current;
    const isEmoji = typeof emojiOrX === 'string';
    const x = (isEmoji ? null : emojiOrX) || (SCREEN_W - 50 + (Math.random() - 0.5) * 60);
    const y = SCREEN_H * 0.6;
    const anim = new Animated.Value(0);
    const color = HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)];
    const emoji = isEmoji ? emojiOrX : null;

    setHearts(prev => {
      const next = [...prev, { id, x, y, anim, color, emoji }];
      if (next.length > MAX_HEARTS) return next.slice(-MAX_HEARTS);
      return next;
    });

    Animated.timing(anim, {
      toValue: 1,
      duration: 2000 + Math.random() * 500,
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

  // Share the live broadcast link. Uses the native share sheet on iOS/Android
  // and navigator.share (or clipboard fallback) on web. The URL resolves to
  // the public live-viewer route for the session so anyone can join.
  const handleShare = useCallback(async () => {
    const url = `https://chatyy.com.br/live-viewer?sessionId=${encodeURIComponent(paramSessionId || '')}`;
    const title = hostName ? `${hostName} está ao vivo no Chatyy` : 'Live no Chatyy';
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
  // Three primary actions match the TikTok/IG flow: replay (just back to feed
  // for now), follow the host, and share the broadcast link with friends.
  if (liveEnded) {
    return (
      <Animated.View style={[styles.centered, { opacity: endedFade }]}>
        <View style={styles.endedIcon}>
          <View style={styles.endedDot} />
        </View>
        <AvatarCircle
          name={hostName}
          email={hostEmail}
          size={72}
          style={styles.endedAvatar}
        />
        <Text style={styles.endedText}>{t('live.hostEnded') || 'Saiu da live'}</Text>
        <Text style={styles.endedSub}>
          {hostName ? `${hostName} ${t('live.liveEnded') || 'encerrou a transmissão'}` : (t('live.liveEnded') || 'Thanks for watching!')}
        </Text>

        <View style={styles.endedActions}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={[styles.endedBtn, styles.endedBtnGhost]}
            accessibilityLabel="Replay"
            accessibilityRole="button"
          >
            <IconRotateCcw size={18} color="#fff" />
            <Text style={styles.endedBtnText}>{t('live.replay') || 'Voltar'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={toggleFollow}
            style={[styles.endedBtn, following ? styles.endedBtnGhost : styles.endedBtnPrimary]}
            accessibilityLabel="Follow"
            accessibilityRole="button"
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
            accessibilityLabel="Share"
            accessibilityRole="button"
          >
            <IconShare size={18} color="#fff" />
            <Text style={styles.endedBtnText}>{t('live.share') || 'Compartilhar'}</Text>
          </TouchableOpacity>
        </View>
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
    <View style={styles.fullScreen}>
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
            name={hostName}
            email={hostEmail}
            size={80}
            style={styles.connectingAvatar}
          />
          <Animated.Text style={[styles.connectingName, { opacity: connectingPulse }]}>
            {hostName || hostEmail?.split('@')[0] || '?'}
          </Animated.Text>
          <ActivityIndicator size="small" color="rgba(255,255,255,0.5)" style={{ marginTop: 16 }} />
          <Animated.Text style={[styles.connectingText, { opacity: connectingPulse }]}>
            {t('live.connecting') || 'Connecting...'}
          </Animated.Text>
        </View>
      )}

      {/* Top bar — left: avatar+name+Follow pill, center: viewer count, right: quality dot + close.
          The Follow pill collapses to a check when the user already follows
          so first-time viewers get a strong call to action without nagging
          returning fans. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]} pointerEvents="box-none">
        <View style={styles.hostPill}>
          <AvatarCircle
            name={hostName}
            email={hostEmail}
            size={34}
          />
          <View style={styles.hostInfo}>
            <Text style={styles.hostName} numberOfLines={1}>
              {hostName || hostEmail?.split('@')[0] || '?'}
            </Text>
            {paramTitle ? (
              <Text style={styles.liveTitle} numberOfLines={1}>{paramTitle}</Text>
            ) : null}
          </View>
          {!following ? (
            <TouchableOpacity
              onPress={toggleFollow}
              style={styles.followPill}
              accessibilityLabel="Follow host"
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
        </View>

        <View style={styles.viewerChip}>
          <View style={styles.viewerDot} />
          <Text style={styles.viewerChipText}>{viewerCount.toLocaleString()}</Text>
        </View>

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

      {/* LIVE badge — pulsing red top-left under the host pill row. */}
      <View style={[styles.liveBadgeWrap, { top: insets.top + 70 }]} pointerEvents="none">
        <Animated.View style={[styles.liveBadge, { opacity: livePulse }]}>
          <View style={styles.liveBadgeDot} />
          <Text style={styles.liveBadgeText}>LIVE</Text>
        </Animated.View>
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
            name={hostName}
            email={hostEmail}
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
            activeOpacity={0.7}
            accessibilityLabel="Send heart"
            accessibilityRole="button"
          >
            <IconHeart size={26} color={LIVE_RED} />
          </TouchableOpacity>
        </Animated.View>

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

      {/* Floating hearts */}
      {hearts.map(h => {
        const translateY = h.anim.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -280],
        });
        const scale = h.anim.interpolate({
          inputRange: [0, 0.15, 0.5, 0.85, 1],
          outputRange: [0.2, 1.3, 1, 0.9, 0.5],
        });
        const opacity = h.anim.interpolate({
          inputRange: [0, 0.1, 0.8, 1],
          outputRange: [0, 1, 0.8, 0],
        });
        const rotate = h.anim.interpolate({
          inputRange: [0, 0.5, 1],
          outputRange: ['0deg', `${(Math.random() - 0.5) * 30}deg`, `${(Math.random() - 0.5) * 20}deg`],
        });
        const translateX = h.anim.interpolate({
          inputRange: [0, 0.3, 0.7, 1],
          outputRange: [0, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 80],
        });

        return (
          <Animated.View
            key={h.id}
            style={[
              styles.heart,
              {
                left: h.x - 14,
                top: h.y - 14,
                transform: [{ translateY }, { translateX }, { scale }, { rotate }],
                opacity,
              },
            ]}
            pointerEvents="none"
          >
            {h.emoji
              ? <Text style={{ fontSize: 34 }}>{h.emoji}</Text>
              : <IconHeart size={28} color={h.color} />}
          </Animated.View>
        );
      })}

      {/* Bottom: comments overlay + pill input.
          Comments float over the video — last 5 visible, oldest fades softer
          via a stack-position alpha so the overlay never blocks more than the
          lower-left third of the stage. The pill input sits below with the
          purple accent send button — disabled tone until there's text. */}
      <View style={[styles.bottomArea, { paddingBottom: insets.bottom + 10 }]} pointerEvents="box-none">
        <View style={styles.commentsOverlay} pointerEvents="none">
          {visibleComments.map((m, idx) => {
            // Older comments fade softer. Stack alpha runs 0.35 → 1 from top.
            const stackAlpha = 0.35 + (idx / Math.max(visibleComments.length - 1, 1)) * 0.65;
            return (
              <View key={m.id} style={[styles.commentRow, { opacity: stackAlpha }]}>
                <AvatarCircle name={m.name} email={m.email} size={26} />
                <View style={styles.commentBubble}>
                  <Text style={styles.commentName} numberOfLines={1}>{m.name}</Text>
                  <Text style={styles.commentText} numberOfLines={3}>{m.content}</Text>
                </View>
              </View>
            );
          })}
        </View>

        <View style={styles.inputBar}>
          <View style={[styles.inputPill, inputFocused && styles.inputPillFocused]}>
            <TextInput
              style={styles.inputText}
              value={inputText}
              onChangeText={setInputText}
              placeholder={t('live.commentPlaceholder') || 'Comentar...'}
              placeholderTextColor="rgba(255,255,255,0.55)"
              returnKeyType="send"
              onSubmitEditing={sendComment}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              blurOnSubmit={false}
              accessibilityLabel="Comment"
            />
          </View>
          <TouchableOpacity
            onPress={sendComment}
            disabled={!inputText.trim()}
            style={[styles.sendBtn, inputText.trim() && styles.sendBtnActive]}
            activeOpacity={0.85}
            accessibilityLabel="Send comment"
            accessibilityRole="button"
          >
            <IconSend size={16} color={inputText.trim() ? '#fff' : 'rgba(255,255,255,0.4)'} />
          </TouchableOpacity>
        </View>
      </View>

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
  endedIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(220,38,38,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 2,
    borderColor: 'rgba(220,38,38,0.2)',
  },
  endedDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(220,38,38,0.5)',
  },
  endedText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  endedSub: {
    color: '#6b7280',
    fontSize: 15,
    textAlign: 'center',
  },
  endedAvatar: {
    marginBottom: 14,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.15)',
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
    paddingHorizontal: 18,
    borderRadius: 24,
  },
  endedBtnPrimary: {
    backgroundColor: ACCENT,
    ...(Platform.OS === 'web' ? { boxShadow: '0 4px 14px rgba(124,58,237,0.5)' } : {}),
  },
  endedBtnGhost: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  endedBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
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

  // Top bar
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 12,
    zIndex: 10,
    gap: 10,
    backgroundColor: 'rgba(0,0,0,0.2)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' } : {}),
  },
  hostPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 24,
    paddingRight: 12,
    paddingVertical: 4,
    paddingLeft: 4,
    gap: 8,
  },
  hostInfo: {
    flex: 1,
  },
  hostName: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  liveTitle: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 11,
    marginTop: 1,
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

  // Connection quality dot — small bola top-right next to the close X.
  qualityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    ...(Platform.OS === 'web' ? { boxShadow: '0 0 6px currentColor' } : {}),
  },

  // LIVE badge — pulsing red just under the top bar, top-left.
  liveBadgeWrap: {
    position: 'absolute',
    left: 14,
    zIndex: 11,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: LIVE_RED,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  liveBadgeDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: '#fff',
  },
  liveBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
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
  commentsOverlay: {
    paddingRight: 76, // leave room for the right rail
    marginBottom: 8,
    gap: 4,
  },
  commentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: '85%',
  },
  commentBubble: {
    flexShrink: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderTopLeftRadius: 4,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' } : {}),
  },
  commentName: {
    color: ACCENT,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  commentText: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 17,
  },

  // Bottom comment bar — pill input + purple send.
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 8,
  },
  inputPill: {
    flex: 1,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  inputPillFocused: {
    borderColor: ACCENT,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  inputText: {
    paddingHorizontal: 16,
    color: '#fff',
    fontSize: 14,
    height: 42,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnActive: {
    backgroundColor: ACCENT,
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 8px rgba(124,58,237,0.45)' } : {}),
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
