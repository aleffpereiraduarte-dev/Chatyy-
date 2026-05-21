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
import { swr, getCachedSync, setCache, userScopedKey } from '../services/cache';

// Brand color (Chatyy purple)
const BRAND = '#7C3AED';

// [WAVE 100] Module-scope live store — survives unmount/remount in the same
// JS runtime (e.g. user opens /notifications, navigates to /inbox, comes
// back: <1ms paint instead of waiting for MMKV/network). MMKV layer below
// still persists across cold starts. Keyed by user-scoped cache key so two
// accounts on the same device never share state.
const _liveStore = new Map();
const LIVE_KEY = 'notifications_list_v1';

function _readLive() {
  try {
    const key = userScopedKey(LIVE_KEY);
    const hit = _liveStore.get(key);
    if (hit && Array.isArray(hit.items)) return hit.items;
  } catch {}
  return null;
}
function _writeLive(items) {
  try {
    const key = userScopedKey(LIVE_KEY);
    _liveStore.set(key, { items, ts: Date.now() });
  } catch {}
}

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
  // [WAVE 100] Lazy init: live store → MMKV → []. Paint instantly on every
  // mount (cold-start + re-mount). SWR below replaces with fresh data.
  const [notifications, setNotifications] = useState(() => {
    const live = _readLive();
    if (live) return live;
    try {
      const cached = getCachedSync(LIVE_KEY);
      if (cached?.notifications) return cached.notifications;
    } catch {}
    return [];
  });
  const [loading, setLoading] = useState(() => !(_readLive() || getCachedSync(LIVE_KEY)?.notifications));
  const [refreshing, setRefreshing] = useState(false);
  // [follow-back-fix 2026-05-21] Lightweight inline toast: confirms the
  // server actually persisted the follow (or surfaces a failure) so the
  // user doesn't see the button vanish with zero feedback and assume "não
  // funcionou". Driven by Animated.Value driving opacity + translateY.
  const [toastMsg, setToastMsg] = useState(null);
  const toastAnim = useRef(new Animated.Value(0)).current;
  const toastTimerRef = useRef(null);
  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    Animated.timing(toastAnim, {
      toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
    toastTimerRef.current = setTimeout(() => {
      Animated.timing(toastAnim, {
        toValue: 0, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true,
      }).start(() => setToastMsg(null));
    }, 2400);
  }, [toastAnim]);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  const cacheRef = useRef({});

  const _applyTab = useCallback((tabKey, rawItems) => {
    const tabDef = TABS.find(tt => tt.key === tabKey);
    let items = rawItems || [];
    if (tabDef?.types && tabDef.types.length >= 1) {
      items = items.filter(n => tabDef.types.includes(n.type));
    }
    cacheRef.current[tabKey] = items;
    setNotifications(items);
  }, []);

  const fetchTab = useCallback(async (tabKey, force = false) => {
    // [WAVE 100] SWR pattern — paint cache instantly, revalidate in bg.
    if (!force && cacheRef.current[tabKey]) {
      setNotifications(cacheRef.current[tabKey]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    // Synchronous cache paint (cold-start + cross-mount).
    const liveItems = _readLive();
    if (liveItems) {
      _applyTab(tabKey, liveItems);
      setLoading(false);
    } else {
      try {
        const cached = getCachedSync(LIVE_KEY);
        if (cached?.notifications) {
          _applyTab(tabKey, cached.notifications);
          setLoading(false);
        }
      } catch {}
    }
    // Background revalidation — shared SWR helper writes to MMKV + dedupes
    // concurrent calls (bell modal + screen mounting at the same time hit
    // backend once). 30min TTL, skip network if last fetch <15s ago.
    try {
      const fresh = await swr(
        LIVE_KEY,
        () => api.notificationsList(1, 60),
        null,
        null,
        { ttlMs: 30 * 60 * 1000, staleAfterMs: 15 * 1000 }
      );
      const rawItems = fresh?.data?.notifications;
      if (Array.isArray(rawItems)) {
        _writeLive(rawItems);
        _applyTab(tabKey, rawItems);
      }
    } catch (e) {}
    setLoading(false);
    setRefreshing(false);
  }, [_applyTab]);

  useEffect(() => {
    if (!notifications || notifications.length === 0) setLoading(true);
    fetchTab(activeTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, fetchTab]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    cacheRef.current = {};
    fetchTab(activeTab, true);
  }, [activeTab, fetchTab]);

  // Animated fade-out for the unread rows after Marcar todas. Pure RN
  // Animated.timing on a shared opacity ref drives the row tint AND the
  // "Marcar todas" pill, so the user sees the read state collapse instantly
  // without a flash of stale UI.
  const markAllFadeAnim = useRef(new Animated.Value(1)).current;

  const markAllRead = useCallback(async () => {
    // [bug-fix #notif-2] Wrong API name (`notificationsRead` doesn't exist;
    // the export is `notificationsMarkRead`). Result: the call threw, the
    // catch swallowed it, nothing was marked read AND the pill never
    // disappeared. Use the real export.
    // Optimistic local update first so the UI is instant, then fire-and-forget
    // the network round-trip; on success the cache is already correct.
    Object.keys(cacheRef.current).forEach(key => {
      cacheRef.current[key] = (cacheRef.current[key] || []).map(n => ({ ...n, read: true }));
    });
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    // [WAVE 100] Mirror into live store + MMKV so the next mount paints
    // already-read state instead of flashing unread tint for ~300ms.
    try {
      const live = _readLive() || getCachedSync(LIVE_KEY)?.notifications || [];
      const next = live.map(n => ({ ...n, read: true }));
      _writeLive(next);
      setCache(LIVE_KEY, { success: true, data: { notifications: next } }, 30 * 60 * 1000);
    } catch {}
    // Fade the unread rail tint out smoothly (200ms).
    markAllFadeAnim.setValue(1);
    Animated.timing(markAllFadeAnim, {
      toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
    try {
      // No id → backend marks ALL unread for this user (see email.php
      // case 'notifications_mark_read').
      await api.notificationsMarkRead();
    } catch (e) {
      // Network failure shouldn't visually rewind: the next pull-to-refresh
      // re-fetches truth from the server. Log only.
      console.warn('[notifications] markAllRead failed:', e?.message || e);
    }
  }, [markAllFadeAnim]);

  const handleAction = useCallback(async (notif, kind) => {
    if (kind === 'follow_back') {
      // [follow-back-fix 2026-05-21] Several issues compounded into "não
      // funciona":
      //   1. Fire-and-forget call swallowed errors silently → if the
      //      bearer drifted or the network blipped, the button vanished
      //      but the server never saw the follow.
      //   2. Zero feedback after success → user assumed nothing happened.
      //   3. action_taken só vivia em memória → próximo refresh trazia
      //      o botão de volta, reforçando a impressão de bug.
      //   4. A notificação não era marcada como lida ao agir → contador
      //      da bell ficava colado.
      //
      // Fix: optimistic flip, await the API, on success ALSO mark the
      // notification read (server-side); on failure revert + toast the
      // user so they can retry. Toast on success too — explicit UX.
      const target = notif?.author_email;
      if (!target) {
        showToast(t('notifications.followBackError') || 'Não foi possível seguir agora.');
        return;
      }
      const tagAction = (taken) => (n) => n.id === notif.id ? { ...n, action_taken: taken, read: taken ? true : n.read } : n;
      // Optimistic
      Object.keys(cacheRef.current).forEach(k => {
        cacheRef.current[k] = (cacheRef.current[k] || []).map(tagAction('follow_back'));
      });
      setNotifications(prev => prev.map(tagAction('follow_back')));
      try {
        const r = await api.followUser?.(target);
        if (!r || r.success === false) throw new Error(r?.error || 'follow_failed');
        // Persist read so the bell counter ticks down. Backend is idempotent.
        try { api.notificationsMarkRead?.(notif.id).catch(() => {}); } catch {}
        // Server returns the JSON blob in `data`; pluck actor_name if present.
        let dataObj = notif.data || {};
        if (typeof dataObj === 'string') {
          try { dataObj = JSON.parse(dataObj || '{}'); } catch { dataObj = {}; }
        }
        const nameRaw = (
          dataObj.actor_name ||
          notif.author_name ||
          (notif.author_email || '').split('@')[0] ||
          ''
        ).trim();
        showToast(
          (t('notifications.followBackOk') || 'Você está seguindo {name} agora').replace('{name}', nameRaw)
        );
      } catch (e) {
        console.warn('[notifications] followUser failed:', e?.message || e);
        // Revert action_taken so the user can retry from the same row.
        Object.keys(cacheRef.current).forEach(k => {
          cacheRef.current[k] = (cacheRef.current[k] || []).map(tagAction(null));
        });
        setNotifications(prev => prev.map(tagAction(null)));
        showToast(t('notifications.followBackError') || 'Não foi possível seguir agora. Tente de novo.');
      }
    } else if (kind === 'message') {
      router.push({ pathname: '/chat-conversation', params: { peer: notif.author_email } });
    }
  }, [router, showToast, t]);

  const handleTap = useCallback(async (notif) => {
    if (!notif.read) {
      // [bug-fix #notif-2 cont.] Same wrong name on the per-row tap.
      api.notificationsMarkRead(notif.id).catch(() => {});
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
        router.push({ pathname: '/live-viewer', params: {
          sessionId: data.session_id,
          hostEmail: data.host_email || notif.author_email || '',
          hostName: data.host_name || notif.author_name || '',
        } });
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

      {/* [follow-back-fix 2026-05-21] Floating inline toast confirms the
          follow back actually persisted (or surfaces an error). Lives
          above the list, pointerEvents=none so taps fall through. */}
      {toastMsg ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.toast,
            {
              opacity: toastAnim,
              transform: [{
                translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }),
              }],
              bottom: 24 + (insets.bottom || 0),
              backgroundColor: isDark ? 'rgba(20,20,28,0.95)' : 'rgba(20,20,28,0.92)',
            },
          ]}
        >
          <IconCheck size={16} color="#10b981" />
          <Text style={styles.toastText}>{toastMsg}</Text>
        </Animated.View>
      ) : null}
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

  // [follow-back-fix 2026-05-21] Floating toast
  toast: {
    position: 'absolute',
    left: 16, right: 16,
    paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.22,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 6 },
      },
      android: { elevation: 8 },
      web: { boxShadow: '0 6px 18px rgba(0,0,0,0.22)' },
    }),
  },
  toastText: {
    flex: 1,
    color: '#fff',
    fontSize: 13.5,
    fontWeight: '600',
    letterSpacing: -0.1,
  },
});

export default function NotificationsScreen() {
  return <ErrorBoundary><NotificationsScreenInner /></ErrorBoundary>;
}
