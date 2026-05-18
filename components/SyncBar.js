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
try { mailWs = require('../services/websocket').default; } catch (e) { console.warn('[SyncBar] websocket module not available:', e.message); }
import useIsMounted from '../hooks/useIsMounted';

export default function SyncBar() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [status, setStatus] = useState('hidden'); // hidden | connecting | syncing | offline
  const [progress, setProgress] = useState(0);
  const slideAnim = useRef(new Animated.Value(-36)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const dotAnim = useRef(new Animated.Value(0)).current;
  const graceTimer = useRef(null);
  const connectingTimeout = useRef(null);
  const syncStallTimer = useRef(null);
  const mountedRef = useIsMounted();

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

  // Auto-hide "Connecting..." after 3s on web (was 7s) to avoid the bar
  // lingering past a brief WS reconnect — WhatsApp Web hides it after ~2s of
  // a flap. Native keeps the 7s ceiling because backgrounded reconnects on
  // mobile data can legitimately take that long.
  // 2026-05-18 (#1131): web auto-hide tightened.
  useEffect(() => {
    clearTimeout(connectingTimeout.current);
    if (status === 'connecting') {
      const ceiling = Platform.OS === 'web' ? 3000 : 7000;
      connectingTimeout.current = setTimeout(() => {
        if (!mountedRef.current) return;
        Animated.timing(slideAnim, { toValue: -36, duration: 300, useNativeDriver: true }).start(() => {
          if (mountedRef.current) setStatus('hidden');
        });
      }, ceiling);
    }
    return () => clearTimeout(connectingTimeout.current);
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
        // Only show "Connecting..." after a grace period of being disconnected
        // so brief reconnects don't flash a banner at the user. Web uses a
        // longer grace (5s) because reconnects there are sub-second in 95%
        // of cases (WS just resumes on next tick). Native keeps 3s because
        // backgrounded radios legitimately take a moment.
        // 2026-05-18 (#1131): bumped web grace to 5s.
        const grace = Platform.OS === 'web' ? 5000 : 3000;
        graceTimer.current = setTimeout(() => {
          if (mountedRef.current && !mailWs?.authenticated) {
            show('connecting');
          }
        }, grace);
      }
    };

    const armStallTimer = () => {
      clearTimeout(syncStallTimer.current);
      // If no progress event for 4s, assume sync silently completed and hide.
      // Without this, "Finishing..." stays forever if the WS never emits `done`.
      // 2026-05-18 (#1131): tightened 8s → 4s. Users were seeing the bar linger
      // for 5-8s on healthy networks where progress events trickled slowly
      // between phases — felt like the app was stuck.
      syncStallTimer.current = setTimeout(() => {
        if (mountedRef.current) hide();
      }, 4000);
    };
    const handleSync = ({ phase, progress: p }) => {
      clearTimeout(graceTimer.current);
      // WhatsApp-grade silent sync (2026-05-18, #1131): web NEVER shows the
      // syncing progress bar. Initial-sync on web is a no-op (see
      // services/initialSync.js web fast-path), and any future heavy delta
      // should happen invisibly in the background — the cached chat list
      // paints instantly while deltas trickle through WS. Mobile keeps the
      // full visual since the on-device DB warm-up legitimately takes time.
      if (Platform.OS === 'web') {
        return;
      }
      if (phase === 'start') {
        show('syncing');
        setProgress(0);
        armStallTimer();
      } else if (phase === 'progress') {
        setProgress(p || 0);
        if ((p || 0) >= 100) {
          clearTimeout(syncStallTimer.current);
          setTimeout(hide, 800);
        } else {
          armStallTimer();
        }
      } else if (phase === 'done' || phase === 'error') {
        // Treat error identically to done — the bar is informational, not
        // an error surface; a separate loadError banner handles retries.
        clearTimeout(syncStallTimer.current);
        setTimeout(hide, phase === 'error' ? 200 : 800);
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
      clearTimeout(connectingTimeout.current);
      clearTimeout(syncStallTimer.current);
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
  const bgColor = isOffline ? (isDark ? '#7f1d1d' : '#fef2f2') : (isDark ? '#1e3a5f' : '#F5F3FF');
  const textColor = isOffline ? (isDark ? '#fca5a5' : '#dc2626') : (isDark ? '#93c5fd' : '#7C3AED');

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
