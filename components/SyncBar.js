/**
 * SyncBar — WhatsApp-style connection status
 * Only shows when ACTUALLY disconnected (3s grace period)
 * Shows sync progress during initial sync
 */
import { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing } from '../constants/theme';
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}

export default function SyncBar() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [status, setStatus] = useState('hidden'); // hidden | connecting | syncing | offline
  const [progress, setProgress] = useState(0);
  const slideAnim = useRef(new Animated.Value(-36)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const dotAnim = useRef(new Animated.Value(0)).current;
  const graceTimer = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Dot pulse for connecting/offline
  useEffect(() => {
    if (status === 'connecting' || status === 'offline') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(dotAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
          Animated.timing(dotAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [status]);

  useEffect(() => {
    const show = (s) => {
      if (!mountedRef.current) return;
      setStatus(s);
      Animated.timing(slideAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    };
    const hide = () => {
      if (!mountedRef.current) return;
      Animated.timing(slideAnim, { toValue: -36, duration: 200, useNativeDriver: true }).start(() => {
        if (mountedRef.current) setStatus('hidden');
      });
    };

    const handleConnection = ({ status: s }) => {
      clearTimeout(graceTimer.current);
      if (s === 'authenticated' || s === 'connected') {
        // Connected — hide after tiny delay
        graceTimer.current = setTimeout(hide, 500);
      } else if (s === 'disconnected') {
        // Only show "Connecting..." after 3 seconds of being disconnected
        // This avoids flashing during quick reconnects
        graceTimer.current = setTimeout(() => {
          if (mountedRef.current && !mailWs?.authenticated) {
            show('connecting');
          }
        }, 3000);
      }
    };

    const handleSync = ({ phase, progress: p }) => {
      clearTimeout(graceTimer.current);
      if (phase === 'start') {
        show('syncing');
        setProgress(0);
      } else if (phase === 'progress') {
        setProgress(p || 0);
      } else if (phase === 'done') {
        setTimeout(hide, 800);
      }
    };

    mailWs?.on?.('connection', handleConnection);
    mailWs?.on?.('sync_progress', handleSync);

    // Network offline detection
    let netUnsub;
    if (Platform.OS === 'web') {
      const onOff = () => show('offline');
      const onOn = () => { if (mailWs?.authenticated) hide(); else show('connecting'); };
      window.addEventListener('offline', onOff);
      window.addEventListener('online', onOn);
      if (!navigator.onLine) show('offline');
      netUnsub = () => {
        window.removeEventListener('offline', onOff);
        window.removeEventListener('online', onOn);
      };
    } else {
      try {
        const NetInfo = require('@react-native-community/netinfo').default;
        netUnsub = NetInfo.addEventListener(s => {
          if (!s.isConnected) show('offline');
          else if (mailWs?.authenticated) hide();
        });
      } catch {}
    }

    return () => {
      clearTimeout(graceTimer.current);
      mailWs?.off?.('connection', handleConnection);
      mailWs?.off?.('sync_progress', handleSync);
      netUnsub?.();
    };
  }, []);

  // Progress bar
  useEffect(() => {
    Animated.timing(progressAnim, { toValue: progress / 100, duration: 200, useNativeDriver: true }).start();
  }, [progress]);

  if (status === 'hidden') return null;

  const isOffline = status === 'offline';
  const bgColor = isOffline ? (isDark ? '#7f1d1d' : '#fef2f2') : (isDark ? '#1e3a5f' : '#eff6ff');
  const textColor = isOffline ? (isDark ? '#fca5a5' : '#dc2626') : (isDark ? '#93c5fd' : '#2563eb');

  let label;
  if (status === 'offline') label = t('sync.offline') || 'No internet';
  else if (status === 'connecting') label = t('sync.connecting') || 'Connecting...';
  else if (progress < 15) label = t('sync.conversations') || 'Loading conversations...';
  else if (progress < 55) label = t('sync.messages') || 'Downloading messages...';
  else if (progress < 65) label = t('sync.contacts') || 'Syncing contacts...';
  else if (progress < 75) label = t('sync.emails') || 'Caching emails...';
  else if (progress < 85) label = t('sync.calendar') || 'Syncing calendar...';
  else label = t('sync.finishing') || 'Finishing...';

  const progressW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <Animated.View style={[s.bar, { backgroundColor: bgColor, transform: [{ translateY: slideAnim }] }]}>
      <View style={s.row}>
        <Animated.View style={[s.dot, { backgroundColor: textColor, opacity: dotAnim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }]} />
        <Text style={[s.text, { color: textColor }]}>{label}</Text>
      </View>
      {status === 'syncing' && (
        <View style={[s.track, { backgroundColor: textColor + '20' }]}>
          <Animated.View style={[s.fill, { backgroundColor: textColor, width: progressW }]} />
        </View>
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  bar: { paddingHorizontal: Spacing.lg, paddingVertical: 5, zIndex: 99 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { fontSize: FontSize.xs, fontWeight: '500' },
  track: { height: 2, borderRadius: 1, marginTop: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 1 },
});
