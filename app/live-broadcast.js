import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated,
  Alert, TextInput, Dimensions, StatusBar,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import LiveIndicator from '../components/LiveIndicator';
import LiveChat from '../components/LiveChat';
import AvatarCircle from '../components/AvatarCircle';
import { IconX, IconCameraFlip, IconMic, IconMicOff, IconVideo, IconVideoOff, IconHeart } from '../components/Icons';

// Cross-platform WebRTC — same pattern as call.js
let RTC_PeerConnection, RTC_SessionDescription, RTC_IceCandidate, getUserMediaFn, NativeRTCView;
if (Platform.OS === 'web') {
  RTC_PeerConnection = window.RTCPeerConnection;
  RTC_SessionDescription = window.RTCSessionDescription;
  RTC_IceCandidate = window.RTCIceCandidate;
  getUserMediaFn = (c) => navigator.mediaDevices.getUserMedia(c);
} else {
  try {
    const webrtc = require('@stream-io/react-native-webrtc');
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
const WS_URL = Platform.OS === 'web' ? 'wss://chatyy.com.br/ws' : 'wss://mail.onemundo.com.br/ws';
const LIVE_RED = '#dc2626';
const MAX_HEARTS = 20;

export default function LiveBroadcastScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const { user } = useAuth();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  // Pre-live state
  const [preStart, setPreStart] = useState(true);
  const [titleInput, setTitleInput] = useState(params.title || '');
  const [countdown, setCountdown] = useState(null);

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

  // Refs
  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const wsRef = useRef(null);
  const peersRef = useRef(new Map());
  const sessionIdRef = useRef(null);
  const viewerCountTimerRef = useRef(null);
  const durationTimerRef = useRef(null);
  const chatIdRef = useRef(0);
  const facingRef = useRef('user');
  const heartIdRef = useRef(0);
  const endedRef = useRef(false);
  const reconnectTimerRef = useRef(null);

  // Animations
  const countdownScale = useRef(new Animated.Value(0)).current;
  const countdownOpacity = useRef(new Animated.Value(0)).current;
  const prevViewerCount = useRef(0);
  const viewerBounce = useRef(new Animated.Value(1)).current;
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
      const stream = await getUserMediaFn({ video: true, audio: true });
      localStreamRef.current = stream;
      if (Platform.OS === 'web') {
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      } else {
        if (stream?.toURL) setLocalStreamUrl(stream.toURL());
      }
      return true;
    } catch (err) {
      console.warn('[Live] Camera error:', err);
      setError(t('live.connectionFailed') || 'Failed to access camera');
      return false;
    }
  }, [t]);

  // Connect to signaling WebSocket
  const connectSignaling = useCallback(() => {
    // Close previous WS to prevent orphan connections
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }

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
        case 'auth_success':
          // After auth, start live session
          ws.send(JSON.stringify({
            type: 'live_start',
            session_id: sessionIdRef.current,
          }));
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
          spawnHeart();
          break;
      }
    };

    ws.onclose = () => {
      if (sessionIdRef.current && !endedRef.current) {
        reconnectTimerRef.current = setTimeout(connectSignaling, 3000);
      }
    };

    ws.onerror = () => {};
  }, [user]);

  // Heart animation
  const spawnHeart = useCallback(() => {
    const id = ++heartIdRef.current;
    const x = SCREEN_W - 60 + (Math.random() - 0.5) * 40;
    const y = SCREEN_H * 0.55;
    const anim = new Animated.Value(0);

    setHearts(prev => {
      const next = [...prev, { id, x, y, anim }];
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

  // Handle viewer joining
  const handleViewerJoined = useCallback(async (msg) => {
    const viewerId = msg.viewer_id;
    if (!viewerId || !localStreamRef.current) return;

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
        setViewerCount(peersRef.current.size);
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

    setViewerCount(peersRef.current.size);

    // Show join message
    setChatMessages(prev => [...prev, {
      id: String(++chatIdRef.current),
      name: msg.viewer_name || msg.viewer_email?.split('@')[0] || '?',
      email: msg.viewer_email,
      content: t('live.joined') || 'joined',
      type: 'system',
    }]);
  }, [t]);

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
    setViewerCount(peersRef.current.size);
  }, []);

  const handleChatMessage = useCallback((msg) => {
    setChatMessages(prev => [...prev, {
      id: String(++chatIdRef.current),
      name: msg.sender_name || msg.sender_email?.split('@')[0] || '?',
      email: msg.sender_email,
      content: msg.content,
      type: msg.msg_type || 'chat',
    }]);
  }, []);

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
      const res = await api.liveStart(titleInput.trim() || t('live.title') || 'Live');
      const sid = res.data?.session_id || res.data?.session?.id;
      if (res.success && sid) {
        setSessionId(sid);
        sessionIdRef.current = sid;

        // Countdown 3, 2, 1
        await animateCountdown(3);
        await animateCountdown(2);
        await animateCountdown(1);
        setCountdown(null);

        setPreStart(false);
        connectSignaling();

        // Start duration timer
        durationTimerRef.current = setInterval(() => {
          setLiveDuration(prev => prev + 1);
        }, 1000);

        // Update viewer count every 10s
        viewerCountTimerRef.current = setInterval(() => {
          const count = peersRef.current.size;
          api.liveUpdateViewers(sessionIdRef.current, count).catch(() => {});
        }, 10000);
      } else {
        setError(res.message || t('live.connectionFailed') || 'Connection failed');
      }
    } catch {
      setError(t('live.connectionFailed') || 'Connection failed');
    }
  }, [titleInput, connectSignaling, t, animateCountdown, ensureCameraStream]);

  // End the live broadcast
  const handleEndLive = useCallback(() => {
    const doEnd = () => {
      endedRef.current = true;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (sessionIdRef.current) {
        api.liveEnd(sessionIdRef.current).catch(() => {});
      }

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'live_end',
          session_id: sessionIdRef.current,
        }));
        wsRef.current.close();
      }

      peersRef.current.forEach(pc => { try { pc.close(); } catch {} });
      peersRef.current.clear();

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
      }

      if (viewerCountTimerRef.current) clearInterval(viewerCountTimerRef.current);
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);

      setEnded(true);
      sessionIdRef.current = null;
      setTimeout(() => router.back(), 1500);
    };

    if (Platform.OS === 'web') {
      if (window.confirm(t('live.endConfirm') || 'End live broadcast?')) doEnd();
    } else {
      Alert.alert(t('live.endLive') || 'End Live', t('live.endConfirm') || 'End live broadcast?', [
        { text: t('common.cancel') || 'Cancel', style: 'cancel' },
        { text: t('live.endLive') || 'End', style: 'destructive', onPress: doEnd },
      ]);
    }
  }, [router, t]);

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
    const msg = {
      id: String(++chatIdRef.current),
      name: user?.name || user?.email?.split('@')[0] || 'You',
      email: user?.email,
      content: text,
      type: 'chat',
    };
    setChatMessages(prev => [...prev, msg]);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'live_chat',
        session_id: sessionIdRef.current,
        content: text,
      }));
    }

    if (sessionIdRef.current) {
      api.liveSendChat(sessionIdRef.current, text).catch(() => {});
    }
  }, [user]);

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

  // Ended state
  if (ended) {
    return (
      <View style={styles.centered}>
        <View style={styles.endedIcon}>
          <IconVideo size={48} color="rgba(255,255,255,0.3)" />
        </View>
        <Text style={styles.endedText}>{t('live.liveEnded') || 'Live ended'}</Text>
        <Text style={styles.endedStats}>
          {formatDuration(liveDuration)} - {viewerCount} {t('live.viewers') || 'viewers'}
        </Text>
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

  // Pre-start screen
  if (preStart) {
    return (
      <View style={styles.fullScreen}>
        {renderLocalVideo()}
        {/* Dark gradient overlay */}
        <View style={styles.preOverlay}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={[styles.closeBtn, { top: insets.top + 16 }]}
            accessibilityLabel="Close"
            accessibilityRole="button"
          >
            <IconX size={24} color="#fff" />
          </TouchableOpacity>

          {/* User preview */}
          <View style={styles.preContent}>
            <AvatarCircle
              name={user?.name || user?.email}
              email={user?.email}
              size={72}
              style={styles.preAvatar}
            />
            <Text style={styles.preName}>{user?.name || user?.email?.split('@')[0]}</Text>
            <TextInput
              style={styles.titleInput}
              value={titleInput}
              onChangeText={setTitleInput}
              placeholder={t('live.enterTitle') || 'Add a title for your live...'}
              placeholderTextColor="rgba(255,255,255,0.35)"
              returnKeyType="done"
              accessibilityLabel={t('live.enterTitle') || 'Live title'}
              maxLength={100}
            />
            <TouchableOpacity
              onPress={handleStartLive}
              style={styles.startBtn}
              activeOpacity={0.8}
              accessibilityLabel={t('live.goLive') || 'Go Live'}
              accessibilityRole="button"
            >
              <View style={styles.startBtnDot} />
              <Text style={styles.startBtnText}>{t('live.goLive') || 'Go Live'}</Text>
            </TouchableOpacity>
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

      {/* Top bar with glass effect */}
      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
        <View style={styles.topLeft}>
          <LiveIndicator size="large" viewerCount={viewerCount} />
        </View>
        <View style={styles.topCenter}>
          <View style={styles.durationPill}>
            <View style={styles.durationDotWrap}>
              {/* Concentric pulse ring radiating from the dot — outline of the
                  "live, transmitting now" status. Opacity fades as it grows so
                  it doesn't compete with the timer text. */}
              <Animated.View style={[styles.durationDotRing, {
                transform: [{ scale: livePulse }],
                opacity: livePulse.interpolate({ inputRange: [1, 1.5], outputRange: [0.55, 0] }),
              }]} />
              <View style={styles.durationDot} />
            </View>
            <Text style={styles.durationText}>{formatDuration(liveDuration)}</Text>
          </View>
        </View>
        <TouchableOpacity
          onPress={handleEndLive}
          style={styles.closeBtn2}
          accessibilityLabel={t('live.endLive') || 'End live'}
          accessibilityRole="button"
        >
          <IconX size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Title */}
      {titleInput ? (
        <View style={styles.titleBar}>
          <Text style={styles.liveTitle} numberOfLines={1}>
            {titleInput}
          </Text>
        </View>
      ) : null}

      {/* Floating hearts */}
      {hearts.map(h => {
        const translateY = h.anim.interpolate({ inputRange: [0, 1], outputRange: [0, -250] });
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
          </Animated.View>
        );
      })}

      {/* Bottom: chat + controls */}
      <View style={styles.bottomArea}>
        <LiveChat
          messages={chatMessages}
          onSend={handleSendChat}
          t={t}
          style={styles.chatOverlay}
        />

        <View style={[styles.controls, { paddingBottom: insets.bottom + 16 }]}>
          <TouchableOpacity
            onPress={handleFlipCamera}
            style={styles.controlBtn}
            activeOpacity={0.7}
            accessibilityLabel={t('live.flipCamera') || 'Flip camera'}
            accessibilityRole="button"
          >
            <IconCameraFlip size={20} color="#fff" />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleToggleVideo}
            style={[styles.controlBtn, videoOff && styles.controlBtnActive]}
            activeOpacity={0.7}
            accessibilityLabel={videoOff ? 'Turn on camera' : 'Turn off camera'}
            accessibilityRole="button"
          >
            {videoOff ? <IconVideoOff size={20} color="#fff" /> : <IconVideo size={20} color="#fff" />}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleToggleMute}
            style={[styles.controlBtn, audioMuted && styles.controlBtnActive]}
            activeOpacity={0.7}
            accessibilityLabel={audioMuted ? t('live.unmute') || 'Unmute' : t('live.mute') || 'Mute'}
            accessibilityRole="button"
          >
            {audioMuted ? <IconMicOff size={20} color="#fff" /> : <IconMic size={20} color="#fff" />}
          </TouchableOpacity>

          <View style={{ flex: 1 }} />

          <TouchableOpacity
            onPress={handleEndLive}
            style={styles.endBtn}
            activeOpacity={0.7}
            accessibilityLabel={t('live.endLive') || 'End live'}
            accessibilityRole="button"
          >
            <Text style={styles.endBtnText}>{t('live.endLive') || 'End'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

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
  preAvatar: {
    marginBottom: 16,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  preName: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 24,
    letterSpacing: 0.3,
  },
  titleInput: {
    width: '100%',
    height: 52,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 18,
    color: '#fff',
    fontSize: 16,
    marginBottom: 24,
    textAlign: 'center',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 40,
    borderRadius: 30,
    backgroundColor: LIVE_RED,
    gap: 10,
    ...(Platform.OS === 'web' ? {
      boxShadow: `0 4px 20px rgba(220, 38, 38, 0.4), 0 0 40px rgba(220, 38, 38, 0.15)`,
    } : {}),
  },
  startBtnDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#fff',
  },
  startBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  closeBtn: {
    position: 'absolute',
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
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
});
