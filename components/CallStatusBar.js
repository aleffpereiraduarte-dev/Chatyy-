/**
 * CallStatusBar — WhatsApp-style green bar + floating PiP bubble
 * shown while call is minimized.
 *
 * Mode 1: Green bar at top (like WhatsApp/iPhone)
 * Mode 2: Floating draggable bubble (like FaceTime PiP) — for video calls
 */
import { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform, PanResponder, Dimensions } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { IconPhone, IconPhoneOff, IconVideo, IconMic, IconVolumeX } from './Icons';
import { useLanguage } from '../context/LanguageContext';
import { useCall } from '../context/CallContext';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export default function CallStatusBar() {
  const { isInCall, callData, callStartTime, endCall, getCallDuration } = useCall();
  const [duration, setDuration] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useLanguage();
  const timerRef = useRef(null);
  const slideAnim = useRef(new Animated.Value(-BAR_HEIGHT)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const wasInCallRef = useRef(false);

  // Pulsing dot animation
  useEffect(() => {
    if (!isInCall) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.3, duration: 800, useNativeDriver: false }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [isInCall]);

  // Timer
  useEffect(() => {
    if (!isInCall || !callStartTime) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setDuration(0);
      return;
    }
    setDuration(getCallDuration());
    timerRef.current = setInterval(() => setDuration(getCallDuration()), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isInCall, callStartTime, getCallDuration]);

  // Animate in/out
  useEffect(() => {
    const shouldShow = isInCall && pathname !== '/call';
    if (shouldShow && !wasInCallRef.current) {
      wasInCallRef.current = true;
      Animated.spring(slideAnim, { toValue: 0, friction: 8, tension: 80, useNativeDriver: false }).start();
    } else if (!shouldShow && wasInCallRef.current) {
      wasInCallRef.current = false;
      Animated.timing(slideAnim, { toValue: -BAR_HEIGHT, duration: 200, useNativeDriver: false }).start();
    } else if (shouldShow) {
      slideAnim.setValue(0);
    }
  }, [isInCall, pathname, slideAnim]);

  if (!isInCall && !wasInCallRef.current) return null;

  const m = Math.floor(duration / 60);
  const s = duration % 60;
  const timeStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  const isVideo = callData?.isVideo;
  const contactName = callData?.contactName || callData?.contactEmail?.split('@')[0] || '';
  const initial = (contactName || '?')[0].toUpperCase();

  const handlePress = () => {
    if (!callData) return;
    try {
      router.push({
        pathname: '/call',
        params: {
          callId: callData.callId || '',
          contactName: callData.contactName || '',
          contactEmail: callData.contactEmail || '',
          isVideo: callData.isVideo ? '1' : '0',
          conversationId: callData.conversationId || '',
          isCaller: callData.isCaller ? '1' : '0',
        },
      });
    } catch {
      try { router.push('/call'); } catch {}
    }
  };

  const handleHangUp = () => {
    try {
      const { getGlobalCall, clearGlobalCall } = require('../app/call');
      const gc = getGlobalCall();
      if (gc) {
        try { gc.pc?.close(); } catch {}
        try { gc.localStream?.getTracks().forEach(tk => tk.stop()); } catch {}
        try { gc.screenStream?.getTracks().forEach(tk => tk.stop()); } catch {}
        try { (gc.wsUnsubs || []).forEach(fn => fn()); } catch {}
        clearGlobalCall();
      }
    } catch {}
    try {
      const mailWs = require('../services/websocket').default;
      if (callData?.callId && mailWs.isConnected) {
        mailWs._send({ type: 'call_end', call_id: callData.callId, target_email: callData.contactEmail || '', reason: 'hangup' });
      }
    } catch {}
    try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}
    try { const { clearActiveCall } = require('./ActiveCallBar'); clearActiveCall(); } catch { endCall(); }
  };

  return (
    <Animated.View style={[styles.container, { transform: [{ translateY: slideAnim }] }]}>
      <TouchableOpacity style={styles.bar} onPress={handlePress} activeOpacity={0.8}>
        {/* Left: avatar + info */}
        <View style={styles.left}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initial}</Text>
            <Animated.View style={[styles.pulseDot, { opacity: pulseAnim }]} />
          </View>
          <View style={styles.info}>
            <Text style={styles.name} numberOfLines={1}>{contactName}</Text>
            <View style={styles.statusRow}>
              {isVideo ? <IconVideo size={10} color="rgba(255,255,255,0.8)" /> : <IconPhone size={10} color="rgba(255,255,255,0.8)" />}
              <Text style={styles.timer}>{timeStr}</Text>
              <Text style={styles.tapHint}>{t('call.tapToReturn') || 'Toque para voltar'}</Text>
            </View>
          </View>
        </View>

        {/* Right: hang up button */}
        <TouchableOpacity style={styles.hangUpBtn} onPress={handleHangUp} activeOpacity={0.7} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <IconPhoneOff size={16} color="#fff" />
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

const BAR_HEIGHT = 48;

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    overflow: 'hidden',
  },
  bar: {
    backgroundColor: '#1B5E20',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: BAR_HEIGHT,
    paddingHorizontal: 12,
    paddingTop: Platform.OS === 'ios' ? 4 : 0,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#4CAF50',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  avatarText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  pulseDot: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#76FF03',
    borderWidth: 2,
    borderColor: '#1B5E20',
  },
  info: {
    flex: 1,
  },
  name: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 1,
  },
  timer: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  tapHint: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 10,
    marginLeft: 6,
  },
  hangUpBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#D32F2F',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
});
