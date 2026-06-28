import { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Animated } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconWifiOff, IconRefresh } from './Icons';
import { useLanguage } from '../context/LanguageContext';

export default function OfflineNotice() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [isOffline, setIsOffline] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [slideAnim] = useState(new Animated.Value(-60));
  const wasOffline = useRef(false);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const handleOnline = () => setIsOffline(false);
      const handleOffline = () => setIsOffline(true);
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      setIsOffline(!navigator.onLine);
      return () => {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      };
    } else {
      // ⭐ Native NWPathMonitor (iOS) — instant, sub-100ms detection
      // (vs NetInfo polling which can take 1-2s). The toolkit module
      // also exposes isOnlineSync so we can prime the initial state
      // without waiting for the first event.
      let NativeToolkit = null;
      if (Platform.OS === 'ios') {
        try { NativeToolkit = require('../modules/expo-native-toolkit').Toolkit; } catch {}
      }
      if (NativeToolkit?.isOnlineSync) {
        setIsOffline(!NativeToolkit.isOnlineSync());
      }
      let NetInfo;
      try {
        NetInfo = require('@react-native-community/netinfo').default;
      } catch {
        return;
      }
      const unsub = NetInfo.addEventListener(state => {
        // Use the native value when available — more accurate than NetInfo's
        // event timing. NetInfo still drives the listener (event-based).
        if (NativeToolkit?.isOnlineSync) {
          setIsOffline(!NativeToolkit.isOnlineSync());
        } else {
          // [2026-06-28] Align with SyncBar: a radio that's "connected" to wifi
          // with no internet (isInternetReachable === false) IS offline. null
          // (unknown, right after connect) is treated as reachable to avoid a
          // false offline flash.
          const online = !!state.isConnected && state.isInternetReachable !== false;
          setIsOffline(!online);
        }
      });
      return () => unsub();
    }
  }, []);

  // Auto-replay offline queue when coming back online
  useEffect(() => {
    if (isOffline) {
      wasOffline.current = true;
      // Show pending actions count
      try {
        const { getOfflineQueue } = require('../services/offlineCache');
        getOfflineQueue().then(q => setQueueCount(q.length)).catch(() => {});
      } catch {}
    } else if (wasOffline.current) {
      wasOffline.current = false;
      // Back online — replay queued actions
      try {
        const { replayOfflineQueue } = require('../services/offlineCache');
        const api = require('../services/api');
        replayOfflineQueue(api).then(({ replayed }) => {
          if (replayed > 0) console.log(`[Offline] Replayed ${replayed} queued actions`);
          setQueueCount(0);
        }).catch(() => {});
      } catch {}
    }
  }, [isOffline]);

  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: isOffline ? 0 : -60,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [isOffline]);

  if (!isOffline) return null;

  // WhatsApp-style: slim, neutral-gray bar — NOT a loud yellow alert. The
  // user already knows they're offline (system status bar shows airplane /
  // wifi-off icon). Our job is a subtle reminder that pending actions are
  // queued. No retry button: auto-reconnect drains the outbox naturally.
  const bg = isDarkMode(colors) ? 'rgba(202,210,217,0.10)' : '#f0f2f5';
  const fg = isDarkMode(colors) ? 'rgba(202,210,217,0.92)' : '#3b4a54';
  return (
    <Animated.View style={[s.container, { backgroundColor: bg, transform: [{ translateY: slideAnim }] }]}>
      <IconWifiOff size={13} color={fg} />
      <Text style={[s.text, { color: fg }]} numberOfLines={1}>
        {t('offline.noConnection')}{queueCount > 0 ? ` · ${queueCount}` : ''}
      </Text>
    </Animated.View>
  );
}

// Cheap dark-mode detector — most ThemeContexts expose `isDark` but the
// shared ones pass only `colors`. Fall back to luminance of the background.
function isDarkMode(colors) {
  if (colors?.background) {
    const hex = (colors.background || '').replace('#', '');
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return lum < 0.5;
    }
  }
  return false;
}

const s = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 5,
    gap: 6,
    zIndex: 100,
  },
  text: { fontSize: 12, fontWeight: '500', letterSpacing: 0.1 },
});
