/**
 * NotificationBell — bell icon with red unread-count badge.
 *
 * Usage:
 *   <NotificationBell />                      // default size 24
 *   <NotificationBell size={28} color="#fff" />
 *
 * Tapping opens /notifications.
 * Badge count auto-refreshes every 30 s while mounted.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { IconBell } from './Icons';
import * as api from '../services/api';
import useIsMounted from '../hooks/useIsMounted';

export default function NotificationBell({ size = 24, color, style }) {
  const { colors } = useTheme();
  const router = useRouter();
  const [count, setCount] = useState(0);
  const timerRef = useRef(null);
  const mountedRef = useIsMounted();

  const fetch = useCallback(async () => {
    try {
      const r = await api.notificationsUnreadCount();
      if (mountedRef.current && r?.success) {
        setCount(r.data?.unread_count ?? 0);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetch();
    timerRef.current = setInterval(fetch, 30000);
    return () => {
      clearInterval(timerRef.current);
    };
  }, [fetch]);

  const iconColor = color || colors.text;
  const badgeCount = count > 99 ? '99+' : String(count);

  return (
    <TouchableOpacity
      onPress={() => router.push('/notifications')}
      style={[styles.wrap, style]}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityLabel={`Notificações${count > 0 ? `, ${count} não lidas` : ''}`}
      accessibilityRole="button"
    >
      <IconBell size={size} color={iconColor} />
      {count > 0 && (
        <View style={[styles.badge, count > 9 ? styles.badgeWide : null]}>
          <Text style={styles.badgeText}>{badgeCount}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: 40, height: 40,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  badge: {
    position: 'absolute', top: 4, right: 4,
    minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: '#ef4444',
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 3,
    borderWidth: 1.5, borderColor: '#fff',
    ...Platform.select({
      web: { animation: 'badgeBounce 0.3s ease' },
      default: {},
    }),
  },
  badgeWide: {
    minWidth: 20, borderRadius: 10,
  },
  badgeText: {
    color: '#fff', fontSize: 9, fontWeight: '800', lineHeight: 13,
  },
});
