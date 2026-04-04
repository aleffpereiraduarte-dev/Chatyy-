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
      let NetInfo;
      try {
        NetInfo = require('@react-native-community/netinfo').default;
      } catch {
        return;
      }
      const unsub = NetInfo.addEventListener(state => {
        setIsOffline(!state.isConnected);
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
      useNativeDriver: Platform.OS !== 'web',
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
          if (Platform.OS === 'web') window.location.reload();
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
