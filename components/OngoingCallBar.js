/**
 * OngoingCallBar — Green bar at top of screen during active calls
 * Shows: "Chamada em andamento • 02:35" with tap to return to call
 * Like WhatsApp/iPhone ongoing call indicator
 */
import { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { isCallActive } from '../services/sipCall';

// Global call state (shared across screens)
let _globalOngoingCall = null;
let _listeners = new Set();

export function setOngoingCall(data) {
  _globalOngoingCall = data; // { number, contactName, duration, type } or null
  _listeners.forEach(fn => fn(data));
}

export function getOngoingCall() {
  return _globalOngoingCall;
}

function useOngoingCall() {
  const [call, setCall] = useState(_globalOngoingCall);
  useEffect(() => {
    const listener = (data) => setCall(data ? { ...data } : null);
    _listeners.add(listener);
    return () => _listeners.delete(listener);
  }, []);
  return call;
}

export default function OngoingCallBar() {
  const call = useOngoingCall();
  const router = useRouter();
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (call) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.7, duration: 800, useNativeDriver: false }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: false }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [!!call]);

  if (!call) return null;

  const formatDuration = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <TouchableOpacity
      style={styles.bar}
      onPress={() => {
        // If a custom resume handler was set (e.g. by ChatCallsTab for SIP calls), use it
        if (typeof call.onResume === 'function') {
          try { call.onResume(); return; } catch {}
        }
        // [hybrid 2026-05-16] /call.js owns the call UI on mobile.
        if (false) {
          try {
            const ExpoCallKit = require('../modules/expo-callkit');
            ExpoCallKit.openNativeCall({
              callId: call.callId || '',
              callerName: call.contactName || call.number || '',
              callerEmail: call.contactEmail || '',
              hasVideo: !!call.isVideo,
              lkUrl: null,
              lkToken: null,
            }).catch((e) => console.warn('[OngoingCallBar] openNativeCall failed:', e));
          } catch (e) { console.warn('[OngoingCallBar] openNativeCall import failed:', e); }
          return;
        }
        router.push('/call');
      }}
      activeOpacity={0.8}
    >
      <Animated.View style={[styles.dot, { opacity: pulseAnim }]} />
      <Text style={styles.text}>
        {call.contactName || call.number || 'Chamada em andamento'}
      </Text>
      <Text style={styles.duration}>
        {formatDuration(call.duration || 0)}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: '#34c759',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 16,
    gap: 8,
    zIndex: 999,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#fff',
  },
  text: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  duration: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '500',
  },
});
