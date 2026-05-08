import ErrorBoundary from '../components/ErrorBoundary';
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
  Platform, RefreshControl, Animated, Easing,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconChevronLeft, IconCheck, IconBell, IconAtSign, IconHeart,
  IconUser, IconMessageSquare, IconMail, IconFilm,
} from '../components/Icons';
import EmptyStateCard from '../components/EmptyStateCard';
import * as api from '../services/api';

// ─── Tab filter config ────────────────────────────────────────────────────────
const TABS = [
  { key: 'all',       labelKey: 'notifications.tabAll',       types: null },
  { key: 'mentions',  labelKey: 'notifications.tabMentions',  types: ['mention'] },
  { key: 'likes',     labelKey: 'notifications.tabLikes',     types: ['like'] },
  { key: 'followers', labelKey: 'notifications.tabFollowers', types: ['follow'] },
];

// ─── Per-type icon & colour ───────────────────────────────────────────────────
function TypeBadge({ type, size = 18 }) {
  const map = {
    email:   { Icon: IconMail,          bg: '#7C3AED', color: '#fff' },
    chat:    { Icon: IconMessageSquare, bg: '#7C3AED', color: '#fff' },
    mention: { Icon: IconAtSign,        bg: '#0ea5e9', color: '#fff' },
    like:    { Icon: IconHeart,         bg: '#ef4444', color: '#fff' },
    comment: { Icon: IconMessageSquare, bg: '#f59e0b', color: '#fff' },
    follow:  { Icon: IconUser,          bg: '#10b981', color: '#fff' },
    live:    { Icon: IconFilm,          bg: '#ec4899', color: '#fff' },
  };
  const cfg = map[type] || { Icon: IconBell, bg: '#6b7280', color: '#fff' };
  return (
    <View style={[badge.wrap, { backgroundColor: cfg.bg }]}>
      <cfg.Icon size={size - 4} color={cfg.color} />
    </View>
  );
}
const badge = StyleSheet.create({
  wrap: {
    position: 'absolute', bottom: -3, right: -3,
    width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#fff',
  },
});

// ─── Relative time helper ─────────────────────────────────────────────────────
function timeAgo(dateStr, t) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60)     return t('time.now') || 'agora';
  if (diff < 3600)   return `${Math.floor(diff / 60)}min`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  {const _d = new Date(dateStr); return isNaN(_d.getTime()) ? "" : _d.toLocaleDateString();}
}

// ─── Single notification row ──────────────────────────────────────────────────
function NotifRow({ item, colors, isDark, onPress, t }) {
  // Build display text
  const grouped = item.grouped_body || null;
  const title   = grouped || item.title || '';
  const body    = grouped ? '' : (item.body || '');
  const ts      = timeAgo(item.created_at || item.latest_at, t);

  const unreadBg = isDark ? 'rgba(37,99,235,0.1)' : 'rgba(37,99,235,0.06)';

  return (
    <TouchableOpacity
      style={[styles.row, !item.read && { backgroundColor: unreadBg }]}
      onPress={() => onPress(item)}
      activeOpacity={0.7}
    >
      {/* Avatar with type badge */}
      <View style={styles.avatarWrap}>
        {item.author_email ? (
          <AvatarCircle email={item.author_email} size={46} />
        ) : (
          <View style={[styles.typeCircle, { backgroundColor: colors.primaryLight || colors.border }]}>
            <TypeBadge type={item.type} size={26} />
          </View>
        )}
        {item.author_email && <TypeBadge type={item.type} size={20} />}
      </View>

      {/* Text */}
      <View style={styles.rowContent}>
        <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={2}>
          {title}
        </Text>
        {!!body && (
          <Text style={[styles.rowBody, { color: colors.textSecondary }]} numberOfLines={1}>
            {body}
          </Text>
        )}
        <Text style={[styles.rowTime, { color: colors.textTertiary || colors.textSecondary }]}>
          {ts}
        </Text>
      </View>

      {/* Unread dot */}
      {!item.read && (
        <View style={[styles.unreadDot, { backgroundColor: colors.primary }]} />
      )}
    </TouchableOpacity>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ colors, isDark, t, tab }) {
  return (
    <EmptyStateCard
      Icon={IconBell}
      title={t('notifications.empty') || 'Nenhuma notificação'}
      subtitle={t('notifications.emptyDesc') || 'Quando você receber notificações, elas aparecerão aqui.'}
    />
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
function NotificationsScreenInner() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [activeTab, setActiveTab] = useState('all');
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Per-tab data: fetched lazily and cached in memory during session
  const cacheRef = useRef({});

  const fetchTab = useCallback(async (tabKey, force = false) => {
    if (!force && cacheRef.current[tabKey]) {
      setNotifications(cacheRef.current[tabKey]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const tabDef = TABS.find(t => t.key === tabKey);
      const params = { limit: 60 };
      if (tabDef?.types?.length === 1) params.type = tabDef.types[0];
      const r = await api.notificationsList(params);
      if (r.success) {
        let items = r.data?.notifications || [];
        // Client-side filter for multi-type tabs
        if (tabDef?.types && tabDef.types.length > 1) {
          items = items.filter(n => tabDef.types.includes(n.type));
        }
        cacheRef.current[tabKey] = items;
        setNotifications(items);
      }
    } catch (e) {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchTab(activeTab);
  }, [activeTab, fetchTab]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    // Invalidate all caches on manual refresh
    cacheRef.current = {};
    fetchTab(activeTab, true);
  }, [activeTab, fetchTab]);

  const markAllRead = useCallback(async () => {
    try {
      await api.notificationsRead({ all: true });
      // Update all cached tabs
      Object.keys(cacheRef.current).forEach(key => {
        cacheRef.current[key] = cacheRef.current[key].map(n => ({ ...n, read: true }));
      });
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch (e) {}
  }, []);

  const handleTap = useCallback(async (notif) => {
    if (!notif.read) {
      api.notificationsRead({ ids: [notif.id] }).catch(() => {});
      // Optimistic update across all caches
      Object.keys(cacheRef.current).forEach(key => {
        cacheRef.current[key] = cacheRef.current[key].map(n =>
          n.id === notif.id ? { ...n, read: true } : n
        );
      });
      setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, read: true } : n));
    }

    let data = notif.data || {};
    if (typeof data === 'string') {
      try { data = JSON.parse(data || '{}'); } catch { data = {}; }
    }

    switch (notif.type) {
      case 'email':
        router.push({ pathname: '/read', params: { uid: data.uid, folder: data.folder || 'INBOX' } });
        break;
      case 'chat':
      case 'mention':
        router.push({ pathname: '/chat-conversation', params: { id: data.conversation_id } });
        break;
      case 'like':
      case 'comment':
        router.push('/chat');
        break;
      case 'follow':
        router.push(`/u/${encodeURIComponent(notif.author_email)}`);
        break;
      case 'live':
        router.push({ pathname: '/live-viewer', params: { sessionId: data.session_id } });
        break;
      default:
        break;
    }
  }, [router]);

  const hasUnread = notifications.some(n => !n.read);

  // Pill grouping by type — when on the "all" tab, intercalate a soft pill
  // header before each contiguous block of the same type. Telegram-style: keeps
  // the eye anchored as it scrolls past 50+ items.
  const TYPE_PILL_LABELS = {
    email:   t('notifications.tabAll')      ? (t('toast.typeEmail')   || 'Email')    : 'Email',
    chat:    t('toast.typeChat')   || 'Chat',
    mention: t('notifications.tabMentions') || 'Menções',
    like:    t('notifications.tabLikes')    || 'Curtidas',
    comment: 'Comentários',
    follow:  t('notifications.tabFollowers')|| 'Seguidores',
    live:    'Live',
  };
  const TYPE_PILL_TINTS = {
    email:   { bg: 'rgba(124,58,237,0.10)', fg: '#7C3AED' },
    chat:    { bg: 'rgba(124,58,237,0.10)', fg: '#7C3AED' },
    mention: { bg: 'rgba(14,165,233,0.10)',  fg: '#0ea5e9' },
    like:    { bg: 'rgba(239,68,68,0.10)',   fg: '#ef4444' },
    comment: { bg: 'rgba(245,158,11,0.10)',  fg: '#f59e0b' },
    follow:  { bg: 'rgba(16,185,129,0.10)',  fg: '#10b981' },
    live:    { bg: 'rgba(236,72,153,0.10)',  fg: '#ec4899' },
  };

  const groupedData = (() => {
    if (activeTab !== 'all' || notifications.length === 0) return notifications;
    const out = [];
    let lastType = null;
    for (const n of notifications) {
      if (n.type !== lastType) {
        out.push({ __pill: true, type: n.type, id: `pill-${n.type}-${out.length}` });
        lastType = n.type;
      }
      out.push(n);
    }
    return out;
  })();

  const renderItem = useCallback(({ item }) => {
    if (item.__pill) {
      const tint = TYPE_PILL_TINTS[item.type] || { bg: 'rgba(107,114,128,0.10)', fg: '#6b7280' };
      const label = TYPE_PILL_LABELS[item.type] || item.type;
      return (
        <View style={styles.pillHeaderWrap}>
          <View style={[styles.pillHeader, { backgroundColor: tint.bg }]}>
            <Text style={[styles.pillHeaderText, { color: tint.fg }]}>{label}</Text>
          </View>
        </View>
      );
    }
    return <NotifRow item={item} colors={colors} isDark={isDark} onPress={handleTap} t={t} />;
  }, [colors, isDark, handleTap, t]);

  const keyExtractor = useCallback((item) => String(item.id || item.latest_at || Math.random()), []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface || colors.background }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <IconChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>

        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('notifications.title') || 'Notificações'}
        </Text>

        {hasUnread ? (
          <TouchableOpacity onPress={markAllRead} style={styles.markAllBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <IconCheck size={16} color={colors.primary} />
            <Text style={[styles.markAllText, { color: colors.primary }]}>
              {t('notifications.markAll') || 'Marcar todas'}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 90 }} />
        )}
      </View>

      {/* Tabs */}
      <View style={[styles.tabBar, { borderBottomColor: colors.border, backgroundColor: colors.surface || colors.background }]}>
        {TABS.map(tab => {
          const isActive = activeTab === tab.key;
          // Badge: count unread items relevant to this tab
          const tabTypes = tab.types;
          const unreadCount = tabTypes
            ? (cacheRef.current[tab.key] || []).filter(n => !n.read && tabTypes.includes(n.type)).length
            : (cacheRef.current['all'] || []).filter(n => !n.read).length;

          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, isActive && { borderBottomColor: colors.primary, borderBottomWidth: 2.5 }]}
              onPress={() => setActiveTab(tab.key)}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Text style={[styles.tabText, { color: isActive ? colors.primary : colors.textSecondary }]}>
                  {t(tab.labelKey) || tab.key}
                </Text>
                {unreadCount > 0 && (
                  <View style={[styles.tabBadge, { backgroundColor: colors.primary }]}>
                    <Text style={styles.tabBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* List */}
      <FlatList
        data={groupedData}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        ListEmptyComponent={
          !loading ? (
            <EmptyState colors={colors} isDark={isDark} t={t} tab={activeTab} />
          ) : null
        }
        contentContainerStyle={notifications.length === 0 ? styles.listEmpty : styles.listContent}
        ItemSeparatorComponent={({ leadingItem }) => (
          // No separator under a pill (and no separator above one either via flat list quirks).
          leadingItem?.__pill ? null
            : <View style={[styles.separator, { backgroundColor: colors.borderLight || colors.border }]} />
        )}
        removeClippedSubviews={Platform.OS !== 'web'}
        windowSize={10}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      web: { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
      default: {},
    }),
  },
  backBtn: { padding: 4, marginRight: 4 },
  headerTitle: {
    flex: 1, textAlign: 'center',
    fontSize: FontSize.lg, fontWeight: '700', letterSpacing: -0.2,
  },
  markAllBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, width: 90, justifyContent: 'flex-end',
  },
  markAllText: { fontSize: FontSize.xs, fontWeight: '600' },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1, paddingVertical: 11, alignItems: 'center',
    borderBottomWidth: 2.5, borderBottomColor: 'transparent',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  tabText: { fontSize: FontSize.sm, fontWeight: '600' },
  tabBadge: {
    minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  tabBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },

  // Notification row
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 13, gap: 12,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  avatarWrap: {
    width: 46, height: 46, flexShrink: 0,
  },
  typeCircle: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
  },
  rowContent: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: FontSize.md, fontWeight: '500', lineHeight: 20 },
  rowBody:  { fontSize: FontSize.sm, marginTop: 2, opacity: 0.8 },
  rowTime:  { fontSize: FontSize.xs, marginTop: 4 },
  unreadDot: { width: 9, height: 9, borderRadius: 5, flexShrink: 0 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 70 },

  // Type-group pill header
  pillHeaderWrap: {
    paddingHorizontal: Spacing.md,
    paddingTop: 12,
    paddingBottom: 4,
  },
  pillHeader: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  pillHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },

  // List
  listContent: { paddingBottom: 40 },
  listEmpty:   { flex: 1 },

  // Empty state
  empty: { flex: 1, alignItems: 'center', paddingTop: 64, paddingHorizontal: Spacing.xl },
  emptyIconContainer: {
    width: 160, height: 160,
    alignItems: 'center', justifyContent: 'center', marginBottom: 24,
  },
  emptyOuterRing: {
    position: 'absolute', width: 160, height: 160, borderRadius: 80, borderWidth: 1.5,
  },
  emptyMiddleRing: {
    position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 1.5,
  },
  emptyIconCircle: {
    width: 88, height: 88, borderRadius: 44,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptyDesc:  { fontSize: FontSize.sm, textAlign: 'center', lineHeight: 20, maxWidth: 280 },
});

export default function NotificationsScreen() {
  return <ErrorBoundary><NotificationsScreenInner /></ErrorBoundary>;
}
