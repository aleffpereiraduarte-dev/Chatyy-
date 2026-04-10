import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated,
  Dimensions, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import LiveIndicator from '../components/LiveIndicator';
import LiveChat from '../components/LiveChat';
import { IconX, IconHeart, IconShare, IconStar } from '../components/Icons';

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
  const [showGiftPlaceholder, setShowGiftPlaceholder] = useState(false);

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
    const token = api.getAuthToken();
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!alive) return;
      ws.send(JSON.stringify({ type: 'auth', token }));
    };

    ws.onmessage = (event) => {
      if (!alive) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
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
          spawnHeart(msg.x);
          break;
        case 'live_ended':
          setLiveEnded(true);
          endTimerRef.current = setTimeout(() => { if (alive) router.back(); }, 4000);
          break;
      }
    };

    ws.onclose = () => {
      if (!alive) return;
      if (!liveEnded) {
        reconnectTimerRef.current = setTimeout(() => {
          if (!alive) return;
          reconnectTimerRef.current = null;
          // Reconnect logic intentionally left empty - viewer will see error state
        }, 3000);
      }
    };

    ws.onerror = () => {
      if (alive) setError(t('live.connectionFailed') || 'Connection failed');
    };

    return () => {
      alive = false;
      ws.close();
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
  const spawnHeart = useCallback((baseX) => {
    const id = ++heartIdRef.current;
    const x = baseX || (SCREEN_W - 50 + (Math.random() - 0.5) * 60);
    const y = SCREEN_H * 0.6;
    const anim = new Animated.Value(0);
    const color = HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)];

    setHearts(prev => {
      const next = [...prev, { id, x, y, anim, color }];
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

  const handleHeartTap = useCallback(() => {
    spawnHeart();

    // Send reaction via WS
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'live_reaction',
        session_id: paramSessionId,
        emoji: '❤️',
      }));
    }
  }, [paramSessionId, user, spawnHeart]);

  // Ended overlay
  if (liveEnded) {
    return (
      <Animated.View style={[styles.centered, { opacity: endedFade }]}>
        <View style={styles.endedIcon}>
          <View style={styles.endedDot} />
        </View>
        <Text style={styles.endedText}>{t('live.hostEnded') || 'Host ended the live'}</Text>
        <Text style={styles.endedSub}>{t('live.liveEnded') || 'Thanks for watching!'}</Text>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Text style={styles.backBtnText}>{t('common.cancel') || 'Leave'}</Text>
        </TouchableOpacity>
      </Animated.View>
    );
  }

  return (
    <View style={styles.fullScreen}>
      {/* Remote video */}
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

      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
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
        </View>
        <LiveIndicator size="small" viewerCount={viewerCount} />
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.closeBtn}
          accessibilityLabel="Close"
          accessibilityRole="button"
        >
          <IconX size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Right side action buttons */}
      <View style={[styles.sideActions, { bottom: 340 + insets.bottom }]}>
        <TouchableOpacity
          style={styles.sideBtn}
          onPress={handleHeartTap}
          activeOpacity={0.7}
          accessibilityLabel="Send heart"
          accessibilityRole="button"
        >
          <IconHeart size={26} color={LIVE_RED} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.sideBtn}
          onPress={() => setShowGiftPlaceholder(true)}
          activeOpacity={0.7}
          accessibilityLabel="Send gift"
          accessibilityRole="button"
        >
          <IconStar size={24} color="#fbbf24" />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.sideBtn}
          activeOpacity={0.7}
          accessibilityLabel="Share"
          accessibilityRole="button"
        >
          <IconShare size={22} color="#fff" />
        </TouchableOpacity>
      </View>

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
            <IconHeart size={28} color={h.color} />
          </Animated.View>
        );
      })}

      {/* Bottom: chat overlay */}
      <View style={styles.bottomArea}>
        <LiveChat
          messages={chatMessages}
          onSend={handleSendChat}
          t={t}
          style={styles.chatOverlay}
        />
      </View>

      {/* Gift placeholder modal */}
      {showGiftPlaceholder && (
        <TouchableOpacity
          style={styles.giftOverlay}
          activeOpacity={1}
          onPress={() => setShowGiftPlaceholder(false)}
        >
          <View style={styles.giftModal}>
            <Text style={styles.giftTitle}>{t('live.gifts') || 'Gifts'}</Text>
            <Text style={styles.giftSubtext}>{t('live.giftsComing') || 'Coming soon!'}</Text>
            <TouchableOpacity
              style={styles.giftCloseBtn}
              onPress={() => setShowGiftPlaceholder(false)}
            >
              <Text style={styles.giftCloseBtnText}>OK</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      )}
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
  },
  chatOverlay: {
    backgroundColor: 'transparent',
  },
  heart: {
    position: 'absolute',
    zIndex: 20,
  },

  // Gift placeholder
  giftOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
    zIndex: 30,
  },
  giftModal: {
    backgroundColor: '#1a1a2e',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 28,
    alignItems: 'center',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 -4px 24px rgba(0,0,0,0.4)',
    } : {}),
  },
  giftTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
  },
  giftSubtext: {
    color: '#6b7280',
    fontSize: 15,
    marginBottom: 20,
  },
  giftCloseBtn: {
    paddingVertical: 10,
    paddingHorizontal: 32,
    borderRadius: 12,
    backgroundColor: ACCENT,
  },
  giftCloseBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
