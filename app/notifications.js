import ErrorBoundary from '../components/ErrorBoundary';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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

// Brand color (Chatyy purple)
const BRAND = '#7C3AED';

// ─── Tab filter config ─ Instagram Activity 4-segment layout ──────────────────
// "Todas" / "Pra você" / "Seguindo" / "Você"
//   - Todas:    everything
//   - Pra você: things relevant to me (likes, comments, mentions, follows on me)
//   - Seguindo: activity from accounts I follow (placeholder: chat/live/email)
//   - Você:     direct interactions on my content (mentions + comments + likes)
const TABS = [
  { key: 'all',       labelKey: 'notifications.tabAll',       label: 'Todas',     types: null },
  { key: 'foryou',    labelKey: 'notifications.tabForYou',    label: 'Pra você',  types: ['like', 'comment', 'mention', 'follow'] },
  { key: 'following', labelKey: 'notifications.tabFollowing', label: 'Seguindo',  types: ['chat', 'live', 'email'] },
  { key: 'you',       labelKey: 'notifications.tabYou',       label: 'Você',      types: ['mention', 'comment', 'like'] },
];

// ─── Per-type icon & colour ───────────────────────────────────────────────────
function TypeBadge({ type, size = 18 }) {
  const map = {
    email:   { Icon: IconMail,          bg: BRAND,    color: '#fff' },
    chat:    { Icon: IconMessageSquare, bg: BRAND,    color: '#fff' },
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

// ─── Avatar stack (for grouped likes) ─────────────────────────────────────────
function AvatarStack({ emails = [], size = 28 }) {
  const list = emails.slice(0, 3);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', height: size }}>
      {list.map((e, idx) => (
        <View
          key={e || idx}
          style={{
            marginLeft: idx === 0 ? 0 : -10,
            borderRadius: size / 2,
            borderWidth: 2,
            borderColor: '#fff',
            zIndex: list.length - idx,
          }}
        >
          <AvatarCircle email={e} size={size} />
        </View>
      ))}
    </View>
  );
}

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

// ─── Date bucket: Hoje / Ontem / Esta semana / Mais antigas ───────────────────
function dateBucket(dateStr) {
  if (!dateStr) return 'older';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'older';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ts = d.getTime();
  if (ts >= startOfToday) return 'today';
  if (ts >= startOfToday - 86400000) return 'yesterday';
  if (ts >= startOfToday - 7 * 86400000) return 'thisWeek';
  return 'older';
}

const BUCKET_LABELS = {
  today:     { key: 'notifications.bucketToday',     fallback: 'Hoje' },
  yesterday: { key: 'notifications.bucketYesterday', fallback: 'Ontem' },
  thisWeek:  { key: 'notifications.bucketThisWeek',  fallback: 'Esta semana' },
  older:     { key: 'notifications.bucketOlder',     fallback: 'Mais antigas' },
};

// ─── Single notification row (Instagram-style) ────────────────────────────────
function NotifRow({ item, colors, isDark, onPress, onAction, t }) {
  const grouped = item.grouped_body || null;
  const ts      = timeAgo(item.created_at || item.latest_at, t);

  // Like aggregation: build a "User1, User2 e mais 12 curtiram seu post"
  const isLikeGroup =
    item.type === 'like' &&
    Array.isArray(item.actor_emails) &&
    item.actor_emails.length > 1;

  let title = grouped || item.title || '';
  let body  = grouped ? '' : (item.body || '');

  if (isLikeGroup) {
    const names = (item.actor_names || item.actor_emails).filter(Boolean);
    const first = names[0] || '';
    const second = names[1] || '';
    const rest = names.length - 2;
    if (rest > 0) {
      title = `${first}, ${second} e mais ${rest} curtiram seu post`;
    } else if (second) {
      title = `${first} e ${second} curtiram seu post`;
    } else {
      title = `${first} curtiu seu post`;
    }
    body = '';
  }

  // Inline body verb for follow type — Instagram says "X seguiu você"
  if (item.type === 'follow' && !grouped) {
    const name = item.author_name || item.author_email || '';
    title = name ? `${name} começou a seguir você` : title;
  }

  const unreadBg = isDark ? 'rgba(124,58,237,0.10)' : 'rgba(124,58,237,0.05)';

  // Right-side thumbnail (post preview) for likes/comments referencing a post
  const thumbUri = item.thumbnail_url || item.post_thumbnail || null;
  const showThumb = !!thumbUri && (item.type === 'like' || item.type === 'comment' || item.type === 'mention');

  // Inline action pills — only for follow notifications
  const showActions = item.type === 'follow' && !item.action_taken;

  return (
    <TouchableOpacity
      style={[styles.row, !item.read && { backgroundColor: unreadBg }]}
      onPress={() => onPress(item)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      {/* Left unread dot rail */}
      {!item.read ? (
        <View style={[styles.unreadRail, { backgroundColor: BRAND }]} />
      ) : (
        <View style={styles.unreadRailSpacer} />
      )}

      {/* Avatar (44) — stack for like-groups, single for others */}
      <View style={styles.avatarWrap}>
        {isLikeGroup ? (
          <AvatarStack emails={item.actor_emails || []} size={36} />
        ) : item.author_email ? (
          <>
            <AvatarCircle email={item.author_email} size={44} />
            <TypeBadge type={item.type} size={20} />
          </>
        ) : (
          <View style={[styles.typeCircle, { backgroundColor: colors.primaryLight || colors.border }]}>
            <TypeBadge type={item.type} size={26} />
          </View>
        )}
      </View>

      {/* Center content: text + inline actions */}
      <View style={styles.rowContent}>
        <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={2}>
          {title}
          {!!ts && (
            <Text style={[styles.rowTimeInline, { color: colors.textTertiary || colors.textSecondary }]}>
              {'  · ' + ts}
            </Text>
          )}
        </Text>
        {!!body && (
          <Text style={[styles.rowBody, { color: colors.textSecondary }]} numberOfLines={1}>
            {body}
          </Text>
        )}

        {showActions && (
          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={(e) => { e?.stopPropagation?.(); onAction?.(item, 'follow_back'); }}
              style={[styles.pillPrimary, { backgroundColor: BRAND }]}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('notifications.followBack') || 'Seguir de volta'}
            >
              <Text style={styles.pillPrimaryText}>
                {t('notifications.followBack') || 'Seguir de volta'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={(e) => { e?.stopPropagation?.(); onAction?.(item, 'message'); }}
              style={[styles.pillSecondary, { borderColor: colors.border }]}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('notifications.message') || 'Mensagem'}
            >
              <Text style={[styles.pillSecondaryText, { color: colors.text }]}>
                {t('notifications.message') || 'Mensagem'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Right post thumbnail (44 square) */}
      {showThumb && (
        <View style={[styles.thumb, { backgroundColor: colors.borderLight || colors.border }]}>
          {/* Native Image lazy import not needed — we use a styled View as placeholder fallback */}
          {Platform.OS === 'web' ? (
            <img
              src={thumbUri}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : (
            // RN-side: minimal Image without an extra import — we rely on a runtime require
            // to avoid touching imports. If unsupported, the placeholder bg shows through.
            (() => {
              try {
                const { Image } = require('react-native');
                return <Image source={{ uri: thumbUri }} style={{ width: 44, height: 44 }} />;
              } catch { return null; }
            })()
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ─── Section header (date bucket) ─────────────────────────────────────────────
function SectionHeader({ label, colors }) {
  return (
    <View style={styles.sectionHeaderWrap}>
      <Text style={[styles.sectionHeaderText, { color: colors.text }]}>
        {label}
      </Text>
    </View>
  );
}

// ─── Animated underline tabs ──────────────────────────────────────────────────
function TabBar({ activeTab, onChange, colors, t, unreadCounts = {} }) {
  const indicatorX = useRef(new Animated.Value(0)).current;
  const [tabWidth, setTabWidth] = useState(0);
  const activeIdx = TABS.findIndex(tt => tt.key === activeTab);

  useEffect(() => {
    Animated.timing(indicatorX, {
      toValue: activeIdx * tabWidth,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [activeIdx, tabWidth, indicatorX]);

  return (
    <View
      onLayout={(e) => setTabWidth(e.nativeEvent.layout.width / TABS.length)}
      style={[styles.tabBar, { borderBottomColor: colors.border, backgroundColor: colors.surface || colors.background }]}
    >
      {TABS.map(tab => {
        const isActive = activeTab === tab.key;
        const unread = unreadCounts[tab.key] || 0;
        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.tab}
            onPress={() => onChange(tab.key)}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Text style={[styles.tabText, {
                color: isActive ? colors.text : colors.textSecondary,
                fontWeight: isActive ? '700' : '500',
              }]}>
                {t(tab.labelKey) || tab.label}
              </Text>
              {unread > 0 && (
                <View style={[styles.tabBadge, { backgroundColor: BRAND }]}>
                  <Text style={styles.tabBadgeText}>{unread > 99 ? '99+' : unread}</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        );
      })}
      {/* Animated underline */}
      {tabWidth > 0 && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.tabIndicator,
            {
              width: tabWidth - 32,
              left: 16,
              backgroundColor: BRAND,
              transform: [{ translateX: indicatorX }],
            },
          ]}
        />
      )}
    </View>
  );
}

// ─── Empty state — Instagram "Você está em dia ✓" ─────────────────────────────
function EmptyState({ colors, isDark, t }) {
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIconCircle, { backgroundColor: 'rgba(124,58,237,0.10)' }]}>
        {/* Inline SVG-ish: bell with a check mark — using existing Icons */}
        <View style={{ alignItems: 'center', justifyContent: 'center' }}>
          <IconCheck size={44} color={BRAND} />
        </View>
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>
        {t('notifications.allCaughtUp') || 'Você está em dia'}
      </Text>
      <Text style={[styles.emptyDesc, { color: colors.textSecondary }]}>
        {t('notifications.allCaughtUpDesc') || 'Quando rolar algo novo, aparece aqui.'}
      </Text>
    </View>
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

  const cacheRef = useRef({});

  const fetchTab = useCallback(async (tabKey, force = false) => {
    if (!force && cacheRef.current[tabKey]) {
      setNotifications(cacheRef.current[tabKey]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const tabDef = TABS.find(tt => tt.key === tabKey);
      const params = { limit: 60 };
      if (tabDef?.types?.length === 1) params.type = tabDef.types[0];
      const r = await api.notificationsList(params);
      if (r.success) {
        let items = r.data?.notifications || [];
        if (tabDef?.types && tabDef.types.length >= 1) {
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
    cacheRef.current = {};
    fetchTab(activeTab, true);
  }, [activeTab, fetchTab]);

  const markAllRead = useCallback(async () => {
    try {
      await api.notificationsRead({ all: true });
      Object.keys(cacheRef.current).forEach(key => {
        cacheRef.current[key] = cacheRef.current[key].map(n => ({ ...n, read: true }));
      });
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch (e) {}
  }, []);

  const handleAction = useCallback((notif, kind) => {
    if (kind === 'follow_back') {
      // Optimistic — placeholder API hook
      try { api.followUser?.({ email: notif.author_email }); } catch {}
      const tag = (n) => n.id === notif.id ? { ...n, action_taken: 'follow_back' } : n;
      Object.keys(cacheRef.current).forEach(k => {
        cacheRef.current[k] = cacheRef.current[k].map(tag);
      });
      setNotifications(prev => prev.map(tag));
    } else if (kind === 'message') {
      router.push({ pathname: '/chat-conversation', params: { peer: notif.author_email } });
    }
  }, [router]);

  const handleTap = useCallback(async (notif) => {
    if (!notif.read) {
      api.notificationsRead({ ids: [notif.id] }).catch(() => {});
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

  // Build sectioned list with date-bucket headers
  const groupedData = useMemo(() => {
    if (notifications.length === 0) return [];
    const buckets = { today: [], yesterday: [], thisWeek: [], older: [] };
    for (const n of notifications) {
      buckets[dateBucket(n.created_at || n.latest_at)].push(n);
    }
    const out = [];
    for (const k of ['today', 'yesterday', 'thisWeek', 'older']) {
      if (buckets[k].length === 0) continue;
      out.push({
        __section: true,
        id: `section-${k}`,
        label: t(BUCKET_LABELS[k].key) || BUCKET_LABELS[k].fallback,
      });
      for (const n of buckets[k]) out.push(n);
    }
    return out;
  }, [notifications, t]);

  const unreadCounts = useMemo(() => {
    const c = {};
    for (const tab of TABS) {
      const cache = cacheRef.current[tab.key];
      if (!cache) { c[tab.key] = 0; continue; }
      c[tab.key] = cache.filter(n => !n.read).length;
    }
    return c;
  }, [notifications]);

  const renderItem = useCallback(({ item }) => {
    if (item.__section) {
      return <SectionHeader label={item.label} colors={colors} />;
    }
    return (
      <NotifRow
        item={item}
        colors={colors}
        isDark={isDark}
        onPress={handleTap}
        onAction={handleAction}
        t={t}
      />
    );
  }, [colors, isDark, handleTap, handleAction, t]);

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
          <TouchableOpacity
            onPress={markAllRead}
            style={[styles.markAllPill, { backgroundColor: 'rgba(124,58,237,0.10)' }]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('notifications.markAll') || 'Marcar todas'}
          >
            <IconCheck size={13} color={BRAND} />
            <Text style={[styles.markAllPillText, { color: BRAND }]}>
              {t('notifications.markAllShort') || 'Marcar todas'}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 110 }} />
        )}
      </View>

      {/* Tabs (animated underline) */}
      <TabBar
        activeTab={activeTab}
        onChange={setActiveTab}
        colors={colors}
        t={t}
        unreadCounts={unreadCounts}
      />

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
          leadingItem?.__section ? null
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
  markAllPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 999,
  },
  markAllPillText: { fontSize: 12, fontWeight: '700' },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    position: 'relative',
  },
  tab: {
    flex: 1, paddingVertical: 12, alignItems: 'center',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  tabText: { fontSize: FontSize.sm },
  tabBadge: {
    minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  tabBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    height: 2.5,
    borderRadius: 2,
  },

  // Section header (date bucket)
  sectionHeaderWrap: {
    paddingHorizontal: Spacing.md,
    paddingTop: 18,
    paddingBottom: 8,
  },
  sectionHeaderText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.1,
  },

  // Notification row
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingLeft: 4,
    paddingRight: Spacing.md,
    paddingVertical: 11,
    gap: 12,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  unreadRail: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 1.5,
    marginRight: 8,
    marginVertical: 4,
  },
  unreadRailSpacer: {
    width: 3,
    marginRight: 8,
  },
  avatarWrap: {
    width: 44, height: 44, flexShrink: 0,
  },
  typeCircle: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  rowContent: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: FontSize.md, fontWeight: '500', lineHeight: 20 },
  rowTimeInline: { fontSize: FontSize.xs, fontWeight: '400' },
  rowBody:  { fontSize: FontSize.sm, marginTop: 2, opacity: 0.8 },
  thumb: {
    width: 44, height: 44, borderRadius: 4,
    overflow: 'hidden',
    flexShrink: 0,
    marginLeft: 8,
  },

  // Inline action pills
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  pillPrimary: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
  },
  pillPrimaryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  pillSecondary: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  pillSecondaryText: {
    fontSize: 13,
    fontWeight: '600',
  },

  separator: { height: StyleSheet.hairlineWidth, marginLeft: 70 },

  // List
  listContent: { paddingBottom: 40 },
  listEmpty:   { flex: 1 },

  // Empty state — Instagram "all caught up"
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 64,
    paddingHorizontal: Spacing.xl,
  },
  emptyIconCircle: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  emptyDesc: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
});

export default function NotificationsScreen() {
  return <ErrorBoundary><NotificationsScreenInner /></ErrorBoundary>;
}
