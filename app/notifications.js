import ErrorBoundary from '../components/ErrorBoundary';
import { canNavigateNow } from '../services/navGuard';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import FastImage from '../components/FastImage'; // [2026-10-09 expo-image]
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
  Platform, RefreshControl, Animated, Easing, Image,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, haptic } from '../constants/theme';
import PressableRow from '../components/PressableRow'; // [2026-10-08 apps-native]
import PressableScale from '../components/PressableScale';
import { USE_NATIVE_HEADER, nativeHeaderOptions, nativeScrollInsetProps } from '../components/nativeHeader';
import { ListSkeleton } from '../components/SkeletonLoader';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconArrowLeft, IconCheck, IconBell, IconAtSign, IconHeart,
  IconUser, IconMessageSquare, IconFilm,
} from '../components/Icons';
import EmptyStateCard from '../components/EmptyStateCard';
import ScreenEmptyState from '../components/ScreenEmptyState';
import * as api from '../services/api';
import { swr, getCachedEntrySync, setCache, userScopedKey } from '../services/cache';
import { cachedKey } from '../hooks/useCachedAction';
import { NOTIF_SCREEN } from '../services/screenData';
import { filterSocialNotifications } from '../services/notificationFilter';
import FadeSlideIn from '../components/FadeSlideIn';
// [2026-10-15 native-search-notifs] Lista NATIVA (ChatyyResultList): agrupada por
// dia, avatar + selo da ação, miniatura, "Seguir de volta"/"Mensagem" inline,
// swipe p/ apagar, ponto de não lida. Kill switch:
// globalThis.__chatyy_native_notifs = false → FlatList JS abaixo (igual antes).
import NativeResultList, { useNativeResults } from '../components/native/NativeResultList';
import { contactTile } from '../components/native/resultListAdapter';

// Tipo → glifo (selo no avatar / círculo quando não há autor).
const NOTIF_GLYPH = {
  chat: 'message', mention: 'at', like: 'heart', feed_like: 'heart',
  comment: 'message', feed_comment: 'message', follow: 'user',
  contact_joined: 'userPlus', live: 'live',
};


// [WAVE 100] Module-scope live store — survives unmount/remount in the same
// JS runtime (e.g. user opens /notifications, navigates to /inbox, comes
// back: <1ms paint instead of waiting for MMKV/network). MMKV layer below
// still persists across cold starts. Keyed by user-scoped cache key so two
// accounts on the same device never share state.
const _liveStore = new Map();
// [2026-10-14 offline-first] mesma chave do aquecimento em 2º plano (screenData).
const LIVE_KEY = cachedKey(NOTIF_SCREEN.key);
// Cópia em disco (7 dias, ignora o TTL curto do swr). O swr grava a RESPOSTA
// inteira ({ success, data: { notifications } }) — antes lia `.notifications`
// na raiz e o cache de disco nunca pintava.
function _readDisk() {
  try { const e = getCachedEntrySync(LIVE_KEY); const d = e && e.data; const l = d && (d.data?.notifications || d.notifications); return Array.isArray(l) ? l : null; } catch { return null; }
}

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

// [2026-10-08 apps-native] t() returns the RAW KEY when missing (never
// falsy), so `t(k) || 'fallback'` never fell back — missing keys (e.g.
// notifications.emptyTip*) rendered as "notifications.emptyTipLikes".
// tl(): real key first, then a per-language inline fallback.
let _lang = 'pt';
function tl(t, key, fb, params) {
  const v = t(key, params);
  if (typeof v === 'string' && v && v !== key) return v;
  let out = (typeof fb === 'string' ? fb : (fb[_lang] || fb.en || fb.pt)) || '';
  if (params) Object.keys(params).forEach((k) => { out = out.split(`{${k}}`).join(String(params[k])); });
  return out;
}

// ─── Tab filter config ─ Instagram Activity 4-segment layout ──────────────────
// "Todas" / "Pra você" / "Seguindo" / "Você"
//   - Todas:    everything
//   - Pra você: things relevant to me (likes, comments, mentions, follows on me)
//   - Seguindo: activity from accounts I follow (placeholder: chat/live/email)
//   - Você:     direct interactions on my content (mentions + comments + likes)
const TABS = [
  { key: 'all',       labelKey: 'notifications.tabAll',       label: 'Todas',     types: null },
  // [2026-10-14 notif-no-email] só chat/social — e-mail saiu da central
  // (filterSocialNotifications); feed_like/feed_comment são os tipos reais
  // gravados pelo servidor p/ curtidas/comentários em posts.
  { key: 'foryou',    labelKey: 'notifications.tabForYou',    label: 'Pra você',  types: ['like', 'comment', 'feed_like', 'feed_comment', 'mention', 'follow', 'contact_joined'] },
  { key: 'following', labelKey: 'notifications.tabFollowing', label: 'Seguindo',  types: ['chat', 'live'] },
  { key: 'you',       labelKey: 'notifications.tabYou',       label: 'Você',      types: ['mention', 'comment', 'like', 'feed_like', 'feed_comment'] },
];

// ─── Per-type icon & colour ───────────────────────────────────────────────────
// [2026-10-14] badge = tinta do tema (preto no claro / branco no escuro) —
// '#111' fixo sumia sobre o fundo preto do modo escuro.
const TYPE_ICONS = {
  chat:    IconMessageSquare,
  // [2026-10-11 polish-secondary] P&B: tipos diferenciados pelo ÍCONE, não pela cor.
  mention: IconAtSign,
  like:    IconHeart,
  feed_like: IconHeart,
  comment: IconMessageSquare,
  feed_comment: IconMessageSquare,
  follow:  IconUser,
  contact_joined: IconUser, // [2026-10-08 contact-joined-push]
  live:    IconFilm,
};
function TypeBadge({ type, size = 18, ringColor, ink, onInk }) {
  const Icon = TYPE_ICONS[type] || IconBell;
  return (
    <View style={[badge.wrap, { backgroundColor: ink, borderColor: ringColor }]}>
      <Icon size={size - 8} color={onInk} />
    </View>
  );
}
const badge = StyleSheet.create({
  wrap: {
    position: 'absolute', bottom: -3, right: -3,
    width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
  },
});

// ─── Avatar stack (for grouped likes) ─────────────────────────────────────────
function AvatarStack({ emails = [], size = 28, ringColor }) {
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
            borderColor: ringColor,
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
  // [2026-10-14] seções enxutas: Hoje · Esta semana · Mais antigas
  if (ts >= startOfToday - 7 * 86400000) return 'thisWeek';
  return 'older';
}

const BUCKET_LABELS = {
  today:     { key: 'notifications.bucketToday',     fallback: 'Hoje' },
  yesterday: { key: 'notifications.bucketYesterday', fallback: 'Ontem' },
  thisWeek:  { key: 'notifications.bucketThisWeek',  fallback: 'Esta semana' },
  older:     { key: 'notifications.bucketOlder',     fallback: 'Mais antigas' },
};

// ─── Texto/estado da linha — o MESMO para a linha JS e a lista nativa ─────────
// [2026-10-15 native-search-notifs] extraído do NotifRow.
function notifDisplay(item, t) {
  const grouped = item.grouped_body || null;
  const ts      = timeAgo(item.created_at || item.latest_at, t);

  // Like aggregation: build a "User1, User2 e mais 12 curtiram seu post"
  const isLikeGroup =
    (item.type === 'like' || item.type === 'feed_like') &&
    Array.isArray(item.actor_emails) &&
    item.actor_emails.length > 1;

  let title = grouped || item.title || '';
  let body  = grouped ? '' : (item.body || '');

  if (isLikeGroup) {
    const names = (item.actor_names || item.actor_emails).filter(Boolean);
    const first = names[0] || '';
    const second = names[1] || '';
    const rest = names.length - 2;
    // [2026-10-08 apps-native] era PT hardcoded p/ todos os idiomas.
    if (rest > 0) {
      title = tl(t, 'notifications.likedMany', { pt: '{a}, {b} e mais {n} curtiram seu post', en: '{a}, {b} and {n} others liked your post', es: 'A {a}, {b} y {n} más les gustó tu publicación' }, { a: first, b: second, n: rest });
    } else if (second) {
      title = tl(t, 'notifications.likedTwo', { pt: '{a} e {b} curtiram seu post', en: '{a} and {b} liked your post', es: 'A {a} y {b} les gustó tu publicación' }, { a: first, b: second });
    } else {
      title = tl(t, 'notifications.likedOne', { pt: '{a} curtiu seu post', en: '{a} liked your post', es: 'A {a} le gustó tu publicación' }, { a: first });
    }
    body = '';
  }

  // Inline body verb for follow type — Instagram says "X seguiu você"
  if (item.type === 'follow' && !grouped) {
    const name = item.author_name || item.author_email || '';
    title = name ? tl(t, 'notifications.startedFollowing', { pt: '{name} começou a seguir você', en: '{name} started following you', es: '{name} comenzó a seguirte' }, { name }) : title;
  }

  // [2026-10-08 contact-joined-push] "Fulano entrou no Chatyy!" · botão "Dizer oi".
  const isContactJoined = item.type === 'contact_joined';
  if (isContactJoined) {
    let cjData = item.data || {};
    if (typeof cjData === 'string') { try { cjData = JSON.parse(cjData || '{}'); } catch { cjData = {}; } }
    const name = cjData.name || item.author_name || (item.author_email || '').split('@')[0];
    if (name) title = tl(t, 'notifications.contactJoined', { pt: '{name} entrou no Chatyy!', en: '{name} joined Chatyy!', es: '{name} se unió a Chatyy!' }, { name });
    body = '';
  }

  // Right-side thumbnail (post preview) for likes/comments referencing a post
  const thumbUri = item.thumbnail_url || item.post_thumbnail || null;
  const showThumb = !!thumbUri && ['like', 'comment', 'feed_like', 'feed_comment', 'mention'].includes(item.type);

  // Inline action pills — only for follow notifications
  const showActions = item.type === 'follow' && !item.action_taken;
  return { ts, title, body, isLikeGroup, isContactJoined, thumbUri, showThumb, showActions };
}

// ─── Single notification row (Instagram-style) ────────────────────────────────
function NotifRow({ item, colors, isDark, onPress, onAction, t }) {
  const { ts, title, body, isLikeGroup, isContactJoined, thumbUri, showThumb, showActions } = notifDisplay(item, t);

  const unreadBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17, 17, 17,0.04)'; // [2026-10-11] escuro: #111 a 10% sobre preto era invisível
  const ink = colors.text;
  const onInk = colors.background;

  return (
    <PressableRow
      style={[styles.row, !item.read && { backgroundColor: unreadBg }]}
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      {/* Left unread dot rail */}
      {/* [2026-10-14] ponto de não-lido (estado), no lugar do trilho */}
      <View style={styles.unreadDotSlot}>
        {!item.read ? <View style={[styles.unreadDot, { backgroundColor: colors.text }]} /> : null}
      </View>

      {/* Avatar (44) — stack for like-groups, single for others */}
      <View style={styles.avatarWrap}>
        {isLikeGroup ? (
          <AvatarStack emails={item.actor_emails || []} size={36} ringColor={colors.background} />
        ) : item.author_email ? (
          <>
            <AvatarCircle email={item.author_email} size={44} />
            <TypeBadge type={item.type} size={20} ringColor={colors.background} ink={ink} onInk={onInk} />
          </>
        ) : (
          <View style={[styles.typeCircle, { backgroundColor: colors.surfaceVariant || colors.border, borderColor: colors.border }]}>
            {(() => { const I = TYPE_ICONS[item.type] || IconBell; return <I size={20} color={colors.text} />; })()}
          </View>
        )}
      </View>

      {/* Center content: text + inline actions */}
      <View style={styles.rowContent}>
        <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={2}>
          {title}
          {!!ts && (
            <Text style={[styles.rowTimeInline, { color: colors.textSecondary }]}>
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
            <PressableScale
              onPress={(e) => { e?.stopPropagation?.(); onAction?.(item, 'follow_back'); }}
              style={[styles.pillPrimary, { backgroundColor: colors.primary }]}
              haptic="medium"
              accessibilityRole="button"
              accessibilityLabel={t('notifications.followBack')}
            >
              <Text style={[styles.pillPrimaryText, { color: colors.onPrimary || '#fff' }]}>
                {t('notifications.followBack')}
              </Text>
            </PressableScale>
            <PressableScale
              onPress={(e) => { e?.stopPropagation?.(); onAction?.(item, 'message'); }}
              style={[styles.pillSecondary, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel={t('notifications.message')}
            >
              <Text style={[styles.pillSecondaryText, { color: colors.text }]}>
                {t('notifications.message')}
              </Text>
            </PressableScale>
          </View>
        )}

        {isContactJoined && !!item.author_email && (
          <View style={styles.actionRow}>
            <PressableScale
              onPress={(e) => { e?.stopPropagation?.(); onAction?.(item, 'say_hi'); }}
              style={[styles.pillPrimary, { backgroundColor: colors.primary }]}
              haptic="medium"
              accessibilityRole="button"
              accessibilityLabel={tl(t, 'notifications.sayHi', { pt: 'Dizer oi', en: 'Say hi', es: 'Saludar' })}
            >
              <Text style={[styles.pillPrimaryText, { color: colors.onPrimary || '#fff' }]}>
                {tl(t, 'notifications.sayHi', { pt: 'Dizer oi', en: 'Say hi', es: 'Saludar' })}
              </Text>
            </PressableScale>
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
            <FastImage source={{ uri: thumbUri }} style={{ width: 44, height: 44 }} recyclingKey={thumbUri} />
          )}
        </View>
      )}
    </PressableRow>
  );
}

// ─── Section header (date bucket) ─────────────────────────────────────────────
function SectionHeader({ label, colors }) {
  return (
    <View style={styles.sectionHeaderWrap}>
      <Text style={[styles.sectionHeaderText, { color: colors.textSecondary }]} accessibilityRole="header">
        {String(label || '').toUpperCase()}
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
            onPress={() => { if (!isActive) haptic.select(); onChange(tab.key); }}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Text style={[styles.tabText, {
                color: isActive ? colors.text : colors.textSecondary,
                fontWeight: isActive ? '700' : '500',
              }]}>
                {t(tab.labelKey) || tab.label}
              </Text>
              {unread > 0 && (
                <View style={[styles.tabBadge, { backgroundColor: colors.primary }]}>
                  <Text style={[styles.tabBadgeText, { color: colors.onPrimary || '#fff' }]}>{unread > 99 ? '99+' : unread}</Text>
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
              backgroundColor: colors.text,
              transform: [{ translateX: indicatorX }],
            },
          ]}
        />
      )}
    </View>
  );
}

// ─── Empty state — premium canonical ScreenEmptyState ─────────────────────────
function EmptyState({ colors, isDark, t, tab, onOpenSettings }) {
  // [2026-10-14] subtítulo por aba (Seguindo = chats/lives de quem você segue)
  const sub = tab === 'following'
    ? tl(t, 'notifications.emptyFollowingDesc', { pt: 'Lives e conversas de quem você segue aparecem aqui.', en: 'Lives and chats from people you follow show up here.', es: 'Los directos y chats de quienes sigues aparecen aquí.' })
    : tl(t, 'notifications.allCaughtUpDesc', { pt: 'Quando rolar algo novo, aparece aqui.', en: 'New activity will show up here.', es: 'La actividad nueva aparecerá aquí.' });
  return (
    <ScreenEmptyState
      kind="notifications"
      title={tl(t, 'notifications.allCaughtUp', { pt: 'Você está em dia', en: "You're all caught up", es: 'Estás al día' })}
      subtitle={sub}
      secondary={onOpenSettings ? {
        label: tl(t, 'notifications.emptyManage', { pt: 'Gerenciar notificações', en: 'Manage notifications', es: 'Gestionar notificaciones' }),
        onPress: onOpenSettings,
      } : undefined}
      tips={[
        { icon: 'star', label: tl(t, 'notifications.emptyTipLikes', { pt: 'Curtidas e comentários nos seus posts', en: 'Likes and comments on your posts', es: 'Me gusta y comentarios en tus publicaciones' }) },
        { icon: 'users', label: tl(t, 'notifications.emptyTipFollows', { pt: 'Quando alguém começa a seguir você', en: 'When someone starts following you', es: 'Cuando alguien empieza a seguirte' }) },
        { icon: 'bell', label: tl(t, 'notifications.emptyTipMentions', { pt: 'Menções, respostas e lembretes', en: 'Mentions, replies and reminders', es: 'Menciones, respuestas y recordatorios' }) },
      ]}
    />
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
function NotificationsScreenInner() {
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  _lang = String(language || 'pt').slice(0, 2);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [activeTab, setActiveTab] = useState('all');
  // [WAVE 100] Lazy init: live store → MMKV → []. Paint instantly on every
  // mount (cold-start + re-mount). SWR below replaces with fresh data.
  const [notifications, setNotifications] = useState(() => {
    const live = _readLive();
    if (live) return filterSocialNotifications(live);
    const disk = _readDisk();
    if (disk) return filterSocialNotifications(disk);
    return [];
  });
  const [loading, setLoading] = useState(() => !(_readLive() || _readDisk()));
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
  const [nativeOn, onNativeFailure] = useNativeResults('__chatyy_native_notifs');

  const _applyTab = useCallback((tabKey, rawItems) => {
    const tabDef = TABS.find(tt => tt.key === tabKey);
    // [2026-10-14 notif-no-email] e-mail nunca entra na central
    let items = filterSocialNotifications(rawItems || []);
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
      const disk = _readDisk();
      if (disk) {
        _applyTab(tabKey, disk);
        setLoading(false);
      }
    }
    // Background revalidation — shared SWR helper writes to MMKV + dedupes
    // concurrent calls (bell modal + screen mounting at the same time hit
    // backend once). 30min TTL, skip network if last fetch <15s ago.
    try {
      const fresh = await swr(
        LIVE_KEY,
        () => NOTIF_SCREEN.fetch(),
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
    haptic.success(); // [2026-10-08 apps-native]
    Object.keys(cacheRef.current).forEach(key => {
      cacheRef.current[key] = (cacheRef.current[key] || []).map(n => ({ ...n, read: true }));
    });
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    // [WAVE 100] Mirror into live store + MMKV so the next mount paints
    // already-read state instead of flashing unread tint for ~300ms.
    try {
      const live = _readLive() || _readDisk() || [];
      const next = live.map(n => ({ ...n, read: true }));
      _writeLive(next);
      setCache(LIVE_KEY, { success: true, data: { notifications: next } }, 7 * 24 * 3600 * 1000);
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
    } else if (kind === 'message' || kind === 'say_hi') {
      // [2026-10-08 contact-joined-push] chat-conversation lê params.email (+type)
      // p/ criar/abrir o direct — `peer` não era lido (abria conversa vazia).
      let d = notif.data || {};
      if (typeof d === 'string') { try { d = JSON.parse(d || '{}'); } catch { d = {}; } }
      if (kind === 'say_hi' && !notif.read) { api.notificationsMarkRead(notif.id).catch(() => {}); }
      require('../services/openConversation').openConversation({ pathname: '/chat-conversation', params: { email: notif.author_email, type: 'direct', ...(d.name ? { name: d.name } : {}) } });
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

    // [2026-06-04] Trava anti-empilhamento: tocar várias notificações rápido
    // abria várias telas uma atrás da outra. O markRead acima já rodou; só a
    // navegação é gateada.
    if (!canNavigateNow()) return;
    switch (notif.type) {
      case 'chat':
      case 'mention':
        require('../services/openConversation').openConversation({ pathname: '/chat-conversation', params: { id: data.conversation_id, ...(data.conversation_type || data.is_group != null ? { type: data.conversation_type || ((data.is_group === true || String(data.is_group) === '1' || data.is_group === 'true') ? 'group' : 'direct') } : {}) } });
        break;
      case 'like':
      case 'comment':
      case 'feed_like':
      case 'feed_comment':
        if (data.post_id) router.push(`/feed/${data.post_id}`);
        else router.push('/chat');
        break;
      case 'follow':
        router.push(`/u/${encodeURIComponent(notif.author_email)}`);
        break;
      case 'contact_joined':
        require('../services/openConversation').openConversation({ pathname: '/chat-conversation', params: { email: notif.author_email, type: 'direct', ...(data.name ? { name: data.name } : {}) } });
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

  // [2026-10-15 native-search-notifs] swipe "Apagar": some na hora (todas as
  // abas + cache vivo/disco) e o servidor apaga em 2º plano.
  const handleDelete = useCallback(async (notif) => {
    if (!notif || notif.id == null) return;
    const drop = (arr) => (arr || []).filter(n => n.id !== notif.id);
    Object.keys(cacheRef.current).forEach(k => { cacheRef.current[k] = drop(cacheRef.current[k]); });
    setNotifications(prev => drop(prev));
    try {
      const live = _readLive() || _readDisk() || [];
      const next = drop(live);
      _writeLive(next);
      setCache(LIVE_KEY, { success: true, data: { notifications: next } }, 7 * 24 * 3600 * 1000);
    } catch {}
    try { await api.notificationsDelete(notif.id); } catch (e) { console.warn('[notifications] delete failed:', e?.message || e); }
  }, []);

  const hasUnread = notifications.some(n => !n.read);

  // Build sectioned list with date-bucket headers
  const groupedData = useMemo(() => {
    if (notifications.length === 0) return [];
    const buckets = { today: [], thisWeek: [], older: [] };
    for (const n of notifications) {
      buckets[dateBucket(n.created_at || n.latest_at)].push(n);
    }
    const out = [];
    for (const k of ['today', 'thisWeek', 'older']) {
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

  const nativeMetaRef = useRef(new Map());
  const nativeRows = useMemo(() => {
    if (!nativeOn) return [];
    const rows = [];
    const meta = new Map();
    const delLabel = tl(t, 'common.delete', { pt: 'Apagar', en: 'Delete', es: 'Eliminar' });
    for (const item of groupedData) {
      if (item.__section) { rows.push({ id: item.id, k: 's', t: item.label }); continue; }
      const d = notifDisplay(item, t);
      const id = `n:${item.id ?? item.latest_at}`;
      const row = { id, k: 'r', t: d.title || '', tl: 2, sl: 1 };
      if (d.ts) row.tm = d.ts;
      if (d.body) row.sb = d.body;
      const glyph = NOTIF_GLYPH[item.type] || 'bell';
      if (d.isLikeGroup) {
        const first = (item.actor_emails || [])[0] || '';
        const nm = (item.actor_names || [])[0] || '';
        row.tiles = contactTile(first, nm);
        row.bd = glyph;
      } else if (item.author_email) {
        row.tiles = contactTile(item.author_email, item.author_name || '');
        row.bd = glyph;
      } else {
        row.gl = glyph;
      }
      if (d.showThumb && d.thumbUri) row.rt = d.thumbUri;
      if (!item.read) row.un = 1;
      if (d.showActions) {
        row.b1 = t('notifications.followBack');
        row.b2 = t('notifications.message');
      } else if (d.isContactJoined && item.author_email) {
        row.b1 = tl(t, 'notifications.sayHi', { pt: 'Dizer oi', en: 'Say hi', es: 'Saludar' });
      }
      if (item.id != null) row.sw = delLabel;
      rows.push(row);
      meta.set(id, item);
    }
    nativeMetaRef.current = meta;
    return rows;
  }, [nativeOn, groupedData, t]);

  const onNativePress = useCallback((id) => {
    const item = nativeMetaRef.current.get(id);
    if (item) handleTap(item);
  }, [handleTap]);

  const onNativeAction = useCallback((id, action) => {
    const item = nativeMetaRef.current.get(id);
    if (!item) return;
    if (action === 'delete') { haptic.light?.(); handleDelete(item); return; }
    if (action === 'b1') { handleAction(item, item.type === 'contact_joined' ? 'say_hi' : 'follow_back'); return; }
    if (action === 'b2') handleAction(item, 'message');
  }, [handleAction, handleDelete]);

  const unreadCounts = useMemo(() => {
    const c = {};
    for (const tab of TABS) {
      const cache = cacheRef.current[tab.key];
      if (!cache) { c[tab.key] = 0; continue; }
      c[tab.key] = cache.filter(n => !n.read).length;
    }
    return c;
  }, [notifications]);

  const renderItem = useCallback(({ item, index }) => {
    if (item.__section) {
      return <SectionHeader label={item.label} colors={colors} />;
    }
    const row = (
      <NotifRow
        item={item}
        colors={colors}
        isDark={isDark}
        onPress={handleTap}
        onAction={handleAction}
        t={t}
      />
    );
    // [2026-10-14] entrada suave só nas primeiras linhas (sem custo no scroll)
    return index < 10 ? <FadeSlideIn delay={Math.min(index, 8) * 24}>{row}</FadeSlideIn> : row;
  }, [colors, isDark, handleTap, handleAction, t]);

  const keyExtractor = useCallback((item, idx) => String(item.id || item.latest_at || `n-${idx}`), []);
  // [2026-10-08 apps-native] stable separator (inline arrow = new component
  // type every render → every separator remounted on each list update).
  const Separator = useCallback(({ leadingItem }) => (
    leadingItem?.__section ? null
      : <View style={[styles.separator, { backgroundColor: colors.borderLight || colors.border }]} />
  ), [colors]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {/* [2026-10-08 apps-native] Header nativo (UINavigationBar / Toolbar);
          "Marcar todas" vira botão de texto no headerRight. Web mantém o custom. */}
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          isDark,
          title: t('notifications.title'),
          headerRight: hasUnread ? () => (
            <PressableScale
              onPress={markAllRead}
              haptic={false}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('notifications.markAllShort')}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 6 }}
            >
              <IconCheck size={15} color={colors.text} />
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{t('notifications.markAllShort')}</Text>
            </PressableScale>
          ) : () => null,
        })} />
      ) : (
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface || colors.background }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>

        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('notifications.title') || 'Notificações'}
        </Text>

        {hasUnread ? (
          <TouchableOpacity
            onPress={markAllRead}
            style={[styles.markAllPill, { backgroundColor: colors.surfaceVariant }]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('notifications.markAll') || 'Marcar todas'}
          >
            <IconCheck size={13} color={colors.text} />
            <Text style={[styles.markAllPillText, { color: colors.text }]}>
              {t('notifications.markAllShort') || 'Marcar todas'}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 110 }} />
        )}
      </View>
      )}

      {/* Tabs (animated underline) */}
      <TabBar
        activeTab={activeTab}
        onChange={setActiveTab}
        colors={colors}
        t={t}
        unreadCounts={unreadCounts}
      />

      {/* List — [2026-10-08 apps-native] skeleton no 1º load (antes: tela em branco) */}
      {loading && notifications.length === 0 ? <ListSkeleton count={8} /> : (nativeOn && notifications.length > 0) ? (
        <NativeResultList
          rows={nativeRows}
          colors={colors}
          isDark={isDark}
          separators
          refreshEnabled
          refreshing={refreshing}
          onRefresh={onRefresh}
          bottomInset={(insets.bottom || 0) + 24}
          onPress={onNativePress}
          onAction={onNativeAction}
          onFailure={onNativeFailure}
        />
      ) : (
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
            <EmptyState colors={colors} isDark={isDark} t={t} tab={activeTab} onOpenSettings={() => router.push('/notification-preferences')} />
          ) : null
        }
        contentContainerStyle={notifications.length === 0 ? styles.listEmpty : styles.listContent}
        ItemSeparatorComponent={Separator}
        {...nativeScrollInsetProps() /* [2026-10-08 header-inset-all] */}
        initialNumToRender={14}
        maxToRenderPerBatch={10}
        removeClippedSubviews={Platform.OS === 'android'}
        windowSize={10}
      />
      )}

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
              backgroundColor: isDark ? 'rgba(44,44,46,0.96)' : 'rgba(17,17,17,0.92)',
            },
          ]}
        >
          <IconCheck size={16} color="#34C759" />
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
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 8,
  },
  sectionHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.8,
  },

  // Notification row
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingLeft: 4,
    paddingRight: 16,
    paddingVertical: 12,
    gap: 12,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  unreadDotSlot: {
    width: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  unreadDot: {
    width: 6, height: 6, borderRadius: 3,
  },
  avatarWrap: {
    width: 44, height: 44, flexShrink: 0,
  },
  typeCircle: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowContent: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 15, fontWeight: '500', lineHeight: 20, letterSpacing: -0.2 },
  rowTimeInline: { fontSize: FontSize.xs, fontWeight: '400' },
  rowBody:  { fontSize: 14, marginTop: 2, lineHeight: 19 },
  thumb: {
    width: 44, height: 44, borderRadius: 8,
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

  separator: { height: StyleSheet.hairlineWidth, marginLeft: 72 },

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
