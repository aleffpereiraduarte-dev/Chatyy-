/**
 * SyncBar — WhatsApp-style connection/sync status bar
 * Shows: "Connecting...", "Syncing...", "Updating messages..." with progress
 * Appears at top of chat screens when not fully synced
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, Animated, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing } from '../constants/theme';
import mailWs from '../services/websocket';

const STATES = {
  CONNECTED: 'connected',
  CONNECTING: 'connecting',
  SYNCING: 'syncing',
  OFFLINE: 'offline',
};

export default function SyncBar() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [state, setState] = useState(STATES.CONNECTED);
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const slideAnim = useRef(new Animated.Value(-40)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const dotAnim = useRef(new Animated.Value(0)).current;

  // Dot animation loop for "Connecting..."
  useEffect(() => {
    if (state === STATES.CONNECTING || state === STATES.OFFLINE) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(dotAnim, { toValue: 1, duration: 600, useNativeDriver: false }),
          Animated.timing(dotAnim, { toValue: 0, duration: 600, useNativeDriver: false }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [state]);

  // Listen to WebSocket connection state
  useEffect(() => {
    const handleConnection = ({ status }) => {
      if (status === 'connected' || status === 'authenticated') {
        setState(STATES.CONNECTED);
      } else if (status === 'disconnected') {
        setState(STATES.CONNECTING);
      }
    };

    const handleSync = ({ phase, progress: p }) => {
      if (phase === 'start') {
        setState(STATES.SYNCING);
        setProgress(0);
      } else if (phase === 'progress') {
        setProgress(p || 0);
      } else if (phase === 'done') {
        setState(STATES.CONNECTED);
        setProgress(100);
      }
    };

    mailWs.on('connection', handleConnection);
    mailWs.on('sync_progress', handleSync);

    // Check initial state
    if (!mailWs.connected) {
      setState(STATES.CONNECTING);
    }

    // Network offline detection
    let netUnsub;
    if (Platform.OS === 'web') {
      const onOff = () => setState(STATES.OFFLINE);
      const onOn = () => setState(mailWs.connected ? STATES.CONNECTED : STATES.CONNECTING);
      window.addEventListener('offline', onOff);
      window.addEventListener('online', onOn);
      if (!navigator.onLine) setState(STATES.OFFLINE);
      netUnsub = () => {
        window.removeEventListener('offline', onOff);
        window.removeEventListener('online', onOn);
      };
    } else {
      try {
        const NetInfo = require('@react-native-community/netinfo').default;
        const unsub = NetInfo.addEventListener(s => {
          if (!s.isConnected) setState(STATES.OFFLINE);
          else setState(mailWs.connected ? STATES.CONNECTED : STATES.CONNECTING);
        });
        netUnsub = unsub;
      } catch {}
    }

    return () => {
      mailWs.off('connection', handleConnection);
      mailWs.off('sync_progress', handleSync);
      netUnsub?.();
    };
  }, []);

  // Show/hide animation
  useEffect(() => {
    const show = state !== STATES.CONNECTED;
    setVisible(show);
    Animated.timing(slideAnim, {
      toValue: show ? 0 : -40,
      duration: 250,
      useNativeDriver: false,
    }).start();
  }, [state]);

  // Progress bar animation
  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: progress / 100,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [progress]);

  if (state === STATES.CONNECTED && !visible) return null;

  const bgColor = state === STATES.OFFLINE
    ? (isDark ? '#7f1d1d' : '#fef2f2')
    : (isDark ? '#1e3a5f' : '#eff6ff');

  const textColor = state === STATES.OFFLINE
    ? (isDark ? '#fca5a5' : '#dc2626')
    : (isDark ? '#93c5fd' : '#2563eb');

  const label = state === STATES.OFFLINE
    ? (t('sync.offline') || 'No internet')
    : state === STATES.CONNECTING
    ? (t('sync.connecting') || 'Connecting...')
    : (t('sync.syncing') || 'Syncing messages...');

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <Animated.View style={[s.container, { backgroundColor: bgColor, transform: [{ translateY: slideAnim }] }]}>
      <View style={s.row}>
        {/* Pulsing dot */}
        <Animated.View style={[s.dot, { backgroundColor: textColor, opacity: dotAnim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }]} />
        <Text style={[s.text, { color: textColor }]}>{label}</Text>
      </View>
      {/* Progress bar (only during sync) */}
      {state === STATES.SYNCING && (
        <View style={[s.progressTrack, { backgroundColor: textColor + '20' }]}>
          <Animated.View style={[s.progressFill, { backgroundColor: textColor, width: progressWidth }]} />
        </View>
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 6,
    zIndex: 99,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  text: {
    fontSize: FontSize.xs,
    fontWeight: '500',
  },
  progressTrack: {
    height: 2,
    borderRadius: 1,
    marginTop: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 1,
  },
});
