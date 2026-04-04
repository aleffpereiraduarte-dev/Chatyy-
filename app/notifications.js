import { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Platform, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import AvatarCircle from '../components/AvatarCircle';
import { IconChevronLeft, IconCheck } from '../components/Icons';

const API = require('../services/api');

export default function NotificationsScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await API.default.notificationsList({ limit: 50 });
      if (r.success) setNotifications(r.data?.notifications || []);
    } catch (e) {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const markAllRead = async () => {
    try {
      await API.default.notificationsRead({ all: true });
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch (e) {}
  };

  const handleTap = async (notif) => {
    // Mark as read
    if (!notif.read) {
      API.default.notificationsRead({ ids: [notif.id] }).catch(() => {});
      setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, read: true } : n));
    }
    // Navigate based on type
    let data = notif.data || {};
    if (typeof data === 'string') {
      try { data = JSON.parse(data || '{}'); } catch { data = {}; }
    }
    switch (notif.type) {
      case 'email':
        router.push({ pathname: '/read', params: { uid: data.uid, folder: data.folder || 'INBOX' } });
        break;
      case 'chat': case 'mention':
        router.push({ pathname: '/chat-conversation', params: { id: data.conversation_id } });
        break;
      case 'like': case 'comment':
        // Navigate to feed post
        router.push('/chat');
        break;
      case 'follow':
        router.push({ pathname: '/user-profile', params: { email: notif.author_email } });
        break;
      case 'live':
        router.push({ pathname: '/live-viewer', params: { sessionId: data.session_id } });
        break;
      default:
        break;
    }
  };

  const getTimeAgo = (dateStr) => {
    const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 60) return t('time.now') || 'agora';
    if (diff < 3600) return `${Math.floor(diff / 60)}min`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
    return new Date(dateStr).toLocaleDateString();
  };

  const typeIcons = {
    email: '✉️', chat: '💬', like: '❤️', comment: '💬',
    follow: '👤', mention: '@', live: '🔴',
  };

  const renderItem = ({ item }) => {
    // Handle grouped notifications
    const isGrouped = item.type === 'grouped';
    const title = isGrouped ? item.text : item.title;
    const body = isGrouped ? '' : item.body;

    return (
      <TouchableOpacity
        style={[styles.item, !item.read && { backgroundColor: isDark ? '#1a2733' : '#e8f0fe' }]}
        onPress={() => handleTap(item)}
        activeOpacity={0.7}
      >
        <View style={styles.iconWrap}>
          {item.author_email || item.image_url ? (
            <AvatarCircle email={item.author_email} size={44} />
          ) : (
            <View style={[styles.typeIcon, { backgroundColor: colors.primary + '20' }]}>
              <Text style={{ fontSize: 20 }}>{typeIcons[item.type] || '🔔'}</Text>
            </View>
          )}
        </View>
        <View style={styles.content}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
            {title}
          </Text>
          {body ? (
            <Text style={[styles.body, { color: colors.textSecondary }]} numberOfLines={1}>
              {body}
            </Text>
          ) : null}
          <Text style={[styles.time, { color: colors.textSecondary }]}>
            {getTimeAgo(item.created_at || item.latest_at)}
          </Text>
        </View>
        {!item.read && <View style={[styles.unreadDot, { backgroundColor: colors.primary }]} />}
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <IconChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('notifications.title') || 'Notificações'}
        </Text>
        <TouchableOpacity onPress={markAllRead} style={styles.markAllBtn}>
          <IconCheck size={18} color={colors.primary} />
          <Text style={[styles.markAllText, { color: colors.primary }]}>
            {t('notifications.markAll') || 'Marcar todas'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* List */}
      <FlatList
        data={notifications}
        renderItem={renderItem}
        keyExtractor={(item) => String(item.id || item.latest_at)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Text style={{ fontSize: 48, marginBottom: 12 }}>🔔</Text>
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                {t('notifications.empty') || 'Nenhuma notificação'}
              </Text>
            </View>
          ) : null
        }
        contentContainerStyle={notifications.length === 0 ? { flex: 1 } : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: 12, borderBottomWidth: 1,
  },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: FontSize.lg, fontWeight: '700', flex: 1, textAlign: 'center' },
  markAllBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  markAllText: { fontSize: FontSize.sm, fontWeight: '600' },
  item: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.md,
    paddingVertical: 12, gap: 12,
  },
  iconWrap: { width: 44, height: 44 },
  typeIcon: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  content: { flex: 1 },
  title: { fontSize: FontSize.md, fontWeight: '500', lineHeight: 20 },
  body: { fontSize: FontSize.sm, marginTop: 2 },
  time: { fontSize: FontSize.xs, marginTop: 4 },
  unreadDot: { width: 8, height: 8, borderRadius: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: FontSize.md },
});
