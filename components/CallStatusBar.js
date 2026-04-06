/**
 * CallStatusBar — WhatsApp/iPhone-style green bar shown at the top of
 * every screen while a call is active.
 *
 * Features:
 *  - Green (#4CAF50) background
 *  - Live timer: "Call in progress . 00:32"
 *  - Tap bar → navigate back to /call
 *  - Red hang-up button on the right
 *  - Animated slide-in / slide-out
 *  - Hidden when already on the /call screen
 */
import { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { IconPhone, IconPhoneOff } from './Icons';
import { useLanguage } from '../context/LanguageContext';
import { useCall } from '../context/CallContext';

export default function CallStatusBar() {
  const { isInCall, callData, callStartTime, endCall, getCallDuration } = useCall();
  const [duration, setDuration] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useLanguage();
  const timerRef = useRef(null);
  const slideAnim = useRef(new Animated.Value(-BAR_HEIGHT)).current;
  const wasInCallRef = useRef(false);

  // Update timer every second
  useEffect(() => {
    if (!isInCall || !callStartTime) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setDuration(0);
      return;
    }
    // Set initial duration immediately (handles returning to already-running call)
    setDuration(getCallDuration());
    timerRef.current = setInterval(() => {
      setDuration(getCallDuration());
    }, 1000);
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [isInCall, callStartTime, getCallDuration]);

  // Animate in/out
  useEffect(() => {
    const shouldShow = isInCall && pathname !== '/call';
    if (shouldShow && !wasInCallRef.current) {
      wasInCallRef.current = true;
      Animated.spring(slideAnim, {
        toValue: 0,
        friction: 8,
        tension: 80,
        useNativeDriver: false,
      }).start();
    } else if (!shouldShow && wasInCallRef.current) {
      wasInCallRef.current = false;
      Animated.timing(slideAnim, {
        toValue: -BAR_HEIGHT,
        duration: 200,
        useNativeDriver: false,
      }).start();
    } else if (shouldShow) {
      // Already showing — make sure position is correct
      slideAnim.setValue(0);
    }
  }, [isInCall, pathname, slideAnim]);

  // Don't render at all if never been in a call
  if (!isInCall && !wasInCallRef.current) return null;

  const m = Math.floor(duration / 60);
  const s = duration % 60;
  const timeStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

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
    } catch (e) {
      // Fallback: try simple navigation
      try { router.push('/call'); } catch {}
    }
  };

  const handleHangUp = () => {
    // Import the end-call logic from call.js global state
    try {
      const { getGlobalCall, clearGlobalCall } = require('../app/call');
      const gc = getGlobalCall();
      if (gc) {
        // Close peer connection and streams
        try { gc.pc?.close(); } catch {}
        try { gc.localStream?.getTracks().forEach(tk => tk.stop()); } catch {}
        try { gc.screenStream?.getTracks().forEach(tk => tk.stop()); } catch {}
        try { (gc.wsUnsubs || []).forEach(fn => fn()); } catch {}
        clearGlobalCall();
      }
    } catch {}

    // Send call_end via WebSocket
    try {
      const mailWs = require('../services/websocket').default;
      if (callData?.callId && mailWs.isConnected) {
        mailWs._send({
          type: 'call_end',
          call_id: callData.callId,
          target_email: callData.contactEmail || '',
          reason: 'hangup',
        });
      }
    } catch {}

    // Stop ringtone if still playing
    try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}

    // Clear via the bridge (which syncs both module-level state and CallContext)
    try {
      const { clearActiveCall } = require('./ActiveCallBar');
      clearActiveCall();
    } catch {
      // Fallback: clear CallContext directly
      endCall();
    }
  };

  return (
    <Animated.View
      style={[
        styles.container,
        { transform: [{ translateY: slideAnim }] },
      ]}
    >
      <TouchableOpacity
        style={styles.bar}
        onPress={handlePress}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={t('call.tapToReturn') || 'Tap to return to call'}
      >
        <View style={styles.left}>
          <IconPhone size={14} color="#fff" />
          <Text style={styles.text}>
            {t('call.inProgress') || 'On call'} {'\u00B7'} {timeStr}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.hangUpBtn}
          onPress={handleHangUp}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={t('call.hangUp') || 'Hang up'}
        >
          <IconPhoneOff size={14} color="#fff" />
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

const BAR_HEIGHT = 36;

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
    backgroundColor: '#4CAF50',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: BAR_HEIGHT,
    paddingHorizontal: 16,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  text: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  hangUpBtn: {
    backgroundColor: '#E53935',
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
