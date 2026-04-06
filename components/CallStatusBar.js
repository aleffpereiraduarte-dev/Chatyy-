/**
 * CallStatusBar — Ongoing call indicator.
 * ZERO external context imports (avoids circular dependency crash).
 * All state comes from CallContext via lazy require.
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { IconPhone, IconPhoneOff, IconVideo } from './Icons';

// Safe area top padding (no hook import to avoid circular dep)
const SAFE_TOP = Platform.OS === 'ios' ? 50 : 24;

export default function CallStatusBar() {
  // Lazy import to avoid circular dependency
  let isInCall = false, callData = null, callStartTime = null, endCall = () => {}, getCallDuration = () => 0;
  try {
    const ctx = require('../context/CallContext');
    const callState = ctx.useCall();
    isInCall = callState.isInCall;
    callData = callState.callData;
    callStartTime = callState.callStartTime;
    endCall = callState.endCall;
    getCallDuration = callState.getCallDuration;
  } catch {}

  const [duration, setDuration] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const timerRef = useRef(null);
  const slideAnim = useRef(new Animated.Value(-100)).current;

  // Timer
  useEffect(() => {
    if (!isInCall || !callStartTime) {
      if (timerRef.current) clearInterval(timerRef.current);
      setDuration(0);
      return;
    }
    setDuration(getCallDuration());
    timerRef.current = setInterval(() => setDuration(getCallDuration()), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isInCall, callStartTime]);

  // Show/hide animation
  const shouldShow = isInCall && pathname !== '/call';
  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: shouldShow ? 0 : -100,
      friction: 10, tension: 60,
      useNativeDriver: true,
    }).start();
  }, [shouldShow]);

  // GUARANTEED hang up
  const handleHangUp = useCallback(() => {
    // 1. Close WebRTC
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
    // 2. Send call_end via WS
    try {
      const mailWs = require('../services/websocket').default;
      if (callData?.callId && mailWs?.isConnected) {
        mailWs._send({ type: 'call_end', call_id: callData.callId, target_email: callData.contactEmail || '', reason: 'hangup' });
      }
    } catch {}
    // 3. Stop ringtone
    try { require('../services/ringtone').stopRingtone(); } catch {}
    // 4. Clear state
    try { require('./ActiveCallBar').clearActiveCall(); } catch {}
    try { endCall(); } catch {}
  }, [callData, endCall]);

  // Return to call
  const handlePress = useCallback(() => {
    if (!callData) return;
    try {
      router.push({ pathname: '/call', params: {
        callId: callData.callId || '', contactName: callData.contactName || '',
        contactEmail: callData.contactEmail || '', isVideo: callData.isVideo ? '1' : '0',
        conversationId: callData.conversationId || '', isCaller: callData.isCaller ? '1' : '0',
      }});
    } catch { try { router.push('/call'); } catch {} }
  }, [callData, router]);

  if (!isInCall && !shouldShow) return null;

  const m = Math.floor(duration / 60);
  const s = duration % 60;
  const timeStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  const contactName = callData?.contactName || callData?.contactEmail?.split('@')[0] || '';

  return (
    <Animated.View style={[styles.container, { paddingTop: SAFE_TOP, transform: [{ translateY: slideAnim }] }]}>
      <TouchableOpacity style={styles.bar} onPress={handlePress} activeOpacity={0.8}>
        <View style={styles.left}>
          <View style={styles.dot} />
          {callData?.isVideo ? <IconVideo size={14} color="#fff" /> : <IconPhone size={14} color="#fff" />}
          <Text style={styles.name} numberOfLines={1}>{contactName}</Text>
          <Text style={styles.timer}>{timeStr}</Text>
        </View>
        <TouchableOpacity
          style={styles.hangUpBtn}
          onPress={(e) => { e.stopPropagation?.(); handleHangUp(); }}
          activeOpacity={0.6}
          hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
        >
          <IconPhoneOff size={14} color="#fff" />
          <Text style={styles.hangUpText}>Desligar</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 99999, backgroundColor: '#2E7D32' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 40, paddingHorizontal: 16 },
  left: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#76FF03' },
  name: { color: '#fff', fontSize: 14, fontWeight: '600', flex: 1 },
  timer: { color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'], marginRight: 12 },
  hangUpBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#C62828', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  hangUpText: { color: '#fff', fontSize: 12, fontWeight: '600' },
});
