import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator,
  RefreshControl, Platform, Animated, Easing,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { swr, getCachedSync, userScopedKey } from '../services/cache';
import AvatarCircle from '../components/AvatarCircle';
import ScreenEmptyState from '../components/ScreenEmptyState';

// [WAVE 100] Module-scope live store — paints instant on re-mount.
const _liveStore = new Map();
const FEED_KEY = 'notifications_feed_list_v1';
function _readLive() {
  try {
    const key = userScopedKey(FEED_KEY);
    const hit = _liveStore.get(key);
    if (hit && Array.isArray(hit.items)) return hit.items;
  } catch {}
  return null;
}
function _writeLive(items) {
  try {
    const key = userScopedKey(FEED_KEY);
    _liveStore.set(key, { items, ts: Date.now() });
  } catch {}
}
import {
  IconArrowLeft, IconHeart, IconMessageCircle, IconUser,
  IconSparkles, IconBell, IconCheck,
} from '../components/Icons';

const ACCENT = '#7C3AED';

function timeAgo(iso, t) {
  if (!iso) return '';
  const then = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z').getTime();
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return t?.('time.now') || 'agora';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d`;
  {const _d = new Date(iso); return isNaN(_d.getTime()) ? "" : _d.toLocaleDateString();}
}

function NotificationIcon({ type, colors }) {
  if (type === 'feed_like') return <IconHeart size={22} color="#ef4444" />;
  if (type === 'feed_comment') return <IconMessageCircle size={22} color="#A78BFA" />;
  if (type === 'follow') return <IconUser size={22} color={ACCENT} />;
  if (type === 'one_alert') return <IconSparkles size={20} color="#f59e0b" />;
  return <IconMessageCircle size={22} color={colors.textSecondary} />;
}

export default function NotificationsFeedScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  // [WAVE 100] Lazy init: live store → MMKV → empty. Paints instant.
  const [items, setItems] = useState(() => {
    const live = _readLive();
    if (live) return live;
    try {
      const cached = getCachedSync(FEED_KEY);
      if (cached?.notifications) return cached.notifications;
    } catch {}
    return [];
  });
  const [loading, setLoading] = useState(() => !(_readLive() || getCachedSync(FEED_KEY)?.notifications));
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  // [follow-back-fix 2026-05-21] Inline toast — confirms the follow back
  // actually persisted. Same UX as the main /notifications screen and the
  // NotificationsHub modal so behaviour matches wherever the user lands.
  const [toastMsg, setToastMsg] = useState(null);
  const toastAnim = useRef(new Animated.Value(0)).current;
  const toastTimerRef = useRef(null);
  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    Animated.timing(toastAnim, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    toastTimerRef.current = setTimeout(() => {
      Animated.timing(toastAnim, { toValue: 0, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => setToastMsg(null));
    }, 2400);
  }, [toastAnim]);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  // [follow-back-fix 2026-05-21] Inline "Seguir de volta" action on follow
  // notifications. Previously this screen had no follow-back button at all;
  // the user had to deep-tap into the profile route to follow back. Now we
  // surface the same primary CTA WhatsApp/Instagram users expect from the
  // notification row itself.
  const handleFollowBack = useCallback(async (item) => {
    const target = item?.author_email;
    if (!target) {
      showToast(t?.('notifications.followBackError') || 'Não foi possível seguir agora.');
      return;
    }
    setItems(prev => prev.map(n =>
      n.id === item.id ? { ...n, action_taken: 'follow_back', read: true } : n
    ));
    try {
      const r = await api.followUser?.(target);
      if (!r || r.success === false) throw new Error(r?.error || 'follow_failed');
      try { api.notificationsMarkRead?.(item.id).catch(() => {}); } catch {}
      const nameRaw = (item.author_email || '').split('@')[0] || '';
      showToast(
        (t?.('notifications.followBackOk') || 'Você está seguindo {name} agora').replace('{name}', nameRaw)
      );
    } catch (e) {
      console.warn('[notifications-feed] followUser failed:', e?.message || e);
      setItems(prev => prev.map(n =>
        n.id === item.id ? { ...n, action_taken: null } : n
      ));
      showToast(t?.('notifications.followBackError') || 'Não foi possível seguir agora. Tente de novo.');
    }
  }, [showToast, t]);

  const load = useCallback(async (p = 1) => {
    // [WAVE 100] First page via SWR — paints cache instantly via lazy init,
    // then revalidates network. Pagination always hits network.
    if (p === 1) {
      try {
        const fresh = await swr(
          FEED_KEY,
          () => api.notificationsList(1, 30),
          null,
          null,
          { ttlMs: 30 * 60 * 1000, staleAfterMs: 15 * 1000 }
        );
        const list = fresh?.data?.notifications;
        if (Array.isArray(list)) {
          _writeLive(list);
          setItems(list);
          setHasMore(!!fresh?.data?.has_more);
        }
      } catch {}
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setLoading(true);
    try {
      const r = await api.notificationsList(p, 30);
      if (r?.success) {
        const list = r.data?.notifications || [];
        setItems(prev => [...prev, ...list]);
        setHasMore(!!r.data?.has_more);
      }
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load(1);
    // Mark all as read when the screen opens
    api.notificationsMarkRead().catch(() => {});
  }, [load]);

  const onRefresh = () => { setRefreshing(true); setPage(1); load(1); };
  const onEndReached = () => {
    if (!hasMore || loading) return;
    const next = page + 1;
    setPage(next);
    load(next);
  };

  const handlePress = (item) => {
    const data = item.data || {};
    if (item.type === 'follow' && item.author_email) {
      router.push(`/u/${encodeURIComponent(item.author_email)}`);
    } else if ((item.type === 'feed_like' || item.type === 'feed_comment') && data.post_id) {
      // /feed-comments is not a registered route — open the public post page
      // instead, which renders the full post with likes + inline comments
      // and works for both logged-in and logged-out viewers.
      router.push(`/feed/${data.post_id}`);
    } else if (item.type === 'one_alert') {
      // One flagged an urgent email — open inbox
      router.push('/inbox');
    }
  };

  const renderItem = ({ item }) => {
    const countSuffix = item.count > 1 ? ` +${item.count - 1}` : '';
    // [follow-back-fix 2026-05-21] Show the inline CTA only for follow
    // notifications and only when the user hasn't already pressed it in
    // this session (action_taken survives until the next refresh).
    const showFollowBack = item.type === 'follow' && !item.action_taken;
    return (
      <TouchableOpacity
        onPress={() => handlePress(item)}
        activeOpacity={0.7}
        style={[styles.row, { backgroundColor: item.read ? 'transparent' : (isDark ? 'rgba(124,58,237,0.08)' : 'rgba(124,58,237,0.05)') }]}
      >
        <View style={{ position: 'relative' }}>
          <AvatarCircle email={item.author_email} name={item.author_email} size={44} />
          <View style={[styles.iconBadge, { backgroundColor: colors.background }]}>
            <NotificationIcon type={item.type} colors={colors} />
          </View>
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={{ color: colors.text, fontSize: 14 }} numberOfLines={2}>
            <Text style={{ fontWeight: '700' }}>{item.author_email?.split('@')[0] || ''}</Text>
            {countSuffix ? <Text style={{ color: colors.textSecondary }}>{countSuffix}</Text> : null}
            {'  '}
            <Text style={{ color: colors.textSecondary }}>{(item.body || '').replace(item.author_email + ' ', '')}</Text>
          </Text>
          <Text style={{ color: colors.textTertiary, fontSize: 11.5, marginTop: 3 }}>
            {timeAgo(item.created_at, t)}
          </Text>
          {showFollowBack && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TouchableOpacity
                onPress={(e) => { e?.stopPropagation?.(); handleFollowBack(item); }}
                activeOpacity={0.85}
                style={{
                  paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8,
                  backgroundColor: ACCENT,
                }}
                accessibilityRole="button"
                accessibilityLabel={t?.('notifications.followBack') || 'Seguir de volta'}
              >
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>
                  {t?.('notifications.followBack') || 'Seguir de volta'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
          {item.type === 'follow' && item.action_taken === 'follow_back' && (
            <Text style={{ marginTop: 6, fontSize: 12, color: '#10b981', fontWeight: '600' }}>
              {t?.('notifications.followingNow') || 'Seguindo'}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('notifications.title') || 'Atividade'}</Text>
        <View style={styles.headerBtn} />
      </View>

      {loading && items.length === 0 ? (
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : items.length === 0 ? (
        <ScreenEmptyState
          kind="notifications"
          title={t('notifications.empty') || 'Sem notificações ainda'}
          subtitle={t('notifications.emptyHint') || 'Curtidas, comentários e novos seguidores aparecem aqui.'}
          tips={[
            { icon: 'star', label: t('notifications.emptyTipLikes') || 'Curtidas e comentários nos seus posts' },
            { icon: 'users', label: t('notifications.emptyTipFollows') || 'Quando alguém começa a seguir você' },
            { icon: 'bell', label: t('notifications.emptyTipMentions') || 'Menções, respostas e lembretes' },
          ]}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item, i) => String(item.id) + '_' + i}
          renderItem={renderItem}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.6}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
          contentContainerStyle={{ paddingVertical: 4 }}
        />
      )}

      {/* [follow-back-fix 2026-05-21] Toast confirming the follow back */}
      {toastMsg ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 16, right: 16,
            bottom: 24 + (insets.bottom || 0),
            paddingHorizontal: 14, paddingVertical: 12,
            borderRadius: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            backgroundColor: isDark ? 'rgba(20,20,28,0.95)' : 'rgba(20,20,28,0.92)',
            opacity: toastAnim,
            transform: [{
              translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }),
            }],
            ...(Platform.OS === 'web'
              ? { boxShadow: '0 6px 18px rgba(0,0,0,0.22)' }
              : Platform.OS === 'ios'
                ? { shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } }
                : { elevation: 8 }),
          }}
        >
          <IconCheck size={16} color="#10b981" />
          <Text style={{ flex: 1, color: '#fff', fontSize: 13.5, fontWeight: '600', letterSpacing: -0.1 }}>
            {toastMsg}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '800' },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 11,
  },
  iconBadge: {
    position: 'absolute', right: -4, bottom: -4,
    borderRadius: 14, padding: 2,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
});
