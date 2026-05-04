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
          setIsOffline(!state.isConnected);
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

  return (
    <Animated.View style={[s.container, { backgroundColor: colors.warningBg || '#fef3c7', transform: [{ translateY: slideAnim }] }]}>
      <IconWifiOff size={16} color={colors.warning || '#f59e0b'} />
      <Text style={[s.text, { color: colors.warning || '#f59e0b' }]}>
        {t('offline.noConnection')}{queueCount > 0 ? ` · ${queueCount} ${t('offline.pendingActions') || 'pending'}` : ''}
      </Text>
      <TouchableOpacity
        style={[s.retryBtn, { backgroundColor: (colors.warning || '#f59e0b') + '20' }]}
        onPress={() => {
          // Try to drain the outbox + invalidate stale SWR rather than
          // reloading the page — `window.location.reload()` blows away
          // unsaved compose drafts, in-flight uploads and component state.
          // The drain hook is best-effort: if it can't import, fall back
          // to a soft network probe that wakes the browser online state.
          try {
            const { drainOutbox } = require('../services/outboxDrainer');
            drainOutbox?.();
          } catch {}
          try {
            const { swrInvalidate } = require('../services/api');
            swrInvalidate?.();
          } catch {}
          if (Platform.OS === 'web' && navigator.onLine === false) {
            // Browser still thinks it's offline — fire a no-op fetch to
            // give the OS a nudge to re-check connectivity, then let the
            // 'online' event clear the banner naturally.
            try { fetch('/?_probe=' + Date.now(), { method: 'HEAD', cache: 'no-store' }).catch(() => {}); } catch {}
          }
        }}
      >
        <IconRefresh size={14} color={colors.warning || '#f59e0b'} />
        <Text style={[s.retryText, { color: colors.warning || '#f59e0b' }]}>{t('offline.retry')}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
    zIndex: 100,
  },
  text: { flex: 1, fontSize: FontSize.sm, fontWeight: '500' },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 4,
    borderRadius: BorderRadius.md,
    gap: 4,
  },
  retryText: { fontSize: FontSize.sm, fontWeight: '600' },
});
