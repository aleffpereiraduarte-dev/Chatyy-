import { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { IconPhone } from './Icons';
import { useLanguage } from '../context/LanguageContext';

// Global call state — set by call.js, read by ActiveCallBar
let _activeCall = null;
let _listeners = new Set();

export function setActiveCall(data) {
  _activeCall = data;
  _listeners.forEach(cb => { try { cb(data); } catch {} });
}

export function getActiveCall() {
  return _activeCall;
}

export function clearActiveCall() {
  _activeCall = null;
  _listeners.forEach(cb => { try { cb(null); } catch {} });
}

export default function ActiveCallBar() {
  const [call, setCall] = useState(_activeCall);
  const [duration, setDuration] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useLanguage();
  const timerRef = useRef(null);

  useEffect(() => {
    const listener = (data) => {
      setCall(data);
      if (data) {
        setDuration(0);
      }
    };
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
  }, []);

  // Timer
  useEffect(() => {
    if (!call) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      setDuration(d => d + 1);
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [call]);

  // Don't show on the call screen itself
  if (!call || pathname === '/call') return null;

  const m = Math.floor(duration / 60);
  const s = duration % 60;
  const timeStr = `${m}:${s.toString().padStart(2, '0')}`;

  const handlePress = () => {
    router.navigate(`/call?callId=${encodeURIComponent(call.callId || '')}&contactName=${encodeURIComponent(call.contactName || '')}&contactEmail=${encodeURIComponent(call.contactEmail || '')}&isVideo=${call.isVideo ? '1' : '0'}&conversationId=${encodeURIComponent(call.conversationId || '')}&isCaller=${call.isCaller ? '1' : '0'}`);
  };

  return (
    <TouchableOpacity
      style={styles.bar}
      onPress={handlePress}
      activeOpacity={0.8}
    >
      <IconPhone size={14} color="#fff" />
      <Text style={styles.text}>
        {t('call.inProgress') || 'Em ligação'} · {timeStr}
      </Text>
      <Text style={styles.tapHint}>
        {t('call.tapToReturn') || 'Toque para voltar'}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: '#22c55e',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    gap: 8,
    zIndex: 9999,
  },
  text: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  tapHint: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 11,
    fontWeight: '500',
  },
});
