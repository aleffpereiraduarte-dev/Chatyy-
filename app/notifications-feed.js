import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator,
  RefreshControl, Platform, Animated, Easing,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions, nativeScrollInsetProps, NativeInsetView, nativeListLargeTitleOn } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { swr, getCachedEntrySync, userScopedKey } from '../services/cache';
import { filterSocialNotifications } from '../services/notificationFilter';
import AvatarCircle from '../components/AvatarCircle';
import ScreenEmptyState from '../components/ScreenEmptyState';
// [2026-10-15 native-search-notifs] Lista NATIVA (ChatyyResultList) agrupada por
// dia, "Seguir de volta" inline e swipe p/ apagar. Kill switch:
// globalThis.__chatyy_native_notifs = false → FlatList JS abaixo (igual antes).
import NativeResultList, { useNativeResults } from '../components/native/NativeResultList';
import { contactTile } from '../components/native/resultListAdapter';
import { setCache } from '../services/cache';

const FEED_GLYPH = { feed_like: 'heart', like: 'heart', feed_comment: 'message', comment: 'message', follow: 'user', mention: 'at', one_alert: 'bell', contact_joined: 'userPlus' };

// [2026-10-17 cj-feed] "Fulano entrou no Chatyy!" · "Dizer oi". Antes esta tela
// mostrava só "joao  Say hi and start chatting." (sem dizer que ele entrou), sem
// botão e o toque não fazia nada. Nome: agenda do usuário > data.name > e-mail.
function _cjData(item) {
  let d = item && item.data;
  if (typeof d === 'string') { try { d = JSON.parse(d || '{}'); } catch { d = {}; } }
  return d || {};
}
function _cjName(item, agendaNames) {
  const em = String(item?.author_email || _cjData(item).email || '').toLowerCase();
  const an = agendaNames && em ? agendaNames.get(em) : null;
  if (an) return an;
  const dn = String(_cjData(item).name || '').trim();
  if (dn) return dn;
  const local = em.split('@')[0] || '';
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : '';
}
function _cjTitle(t, name) {
  let v = '';
  try { v = t?.('notifications.contactJoined', { name }); } catch {}
  if (typeof v === 'string' && v && v !== 'notifications.contactJoined') return v.split('{name}').join(name);
  return `${name} entrou no Chatyy!`;
}
function _cjSayHi(t) {
  const v = t?.('notifications.sayHi');
  return (typeof v === 'string' && v && v !== 'notifications.sayHi') ? v : 'Dizer oi';
}
function _feedBucket(iso) {
  if (!iso) return 'older';
  const d = new Date(String(iso).endsWith('Z') || String(iso).includes('+') ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return 'older';
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return 'today';
  if (d.getTime() >= start - 7 * 86400000) return 'thisWeek';
  return 'older';
}
const FEED_BUCKETS = [
  ['today', 'notifications.bucketToday', 'Hoje'],
  ['thisWeek', 'notifications.bucketThisWeek', 'Esta semana'],
  ['older', 'notifications.bucketOlder', 'Mais antigas'],
];

// [WAVE 100] Module-scope live store — paints instant on re-mount.
const _liveStore = new Map();
const FEED_KEY = 'notifications_feed_list_v1';
// [2026-10-14 offline-first] disco (7 dias). swr grava a resposta inteira — antes lia `.notifications` na raiz (nunca pintava).
function _readDisk() {
  try { const e = getCachedEntrySync(FEED_KEY); const d = e && e.data; const l = d && (d.data?.notifications || d.notifications); return Array.isArray(l) ? l : null; } catch { return null; }
}
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

const ACCENT = '#111111';

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
  // [2026-10-11 polish-secondary] P&B: tipo pelo ícone (era vermelho/âmbar).
  if (type === 'feed_like') return <IconHeart size={22} color={colors.text} />;
  if (type === 'feed_comment') return <IconMessageCircle size={22} color={colors.text} />;
  if (type === 'follow') return <IconUser size={22} color={colors.text} />;
  if (type === 'one_alert') return <IconSparkles size={20} color={colors.text} />;
  if (type === 'contact_joined') return <IconUser size={22} color={colors.text} />;
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
    return _readDisk() || [];
  });
  const [loading, setLoading] = useState(() => !(_readLive() || _readDisk()));
  const [refreshing, setRefreshing] = useState(false);
  // [2026-10-17 cj-feed] nomes da agenda (cache do último sync de contatos).
  const [agendaNames, setAgendaNames] = useState(null);
  useEffect(() => {
    let alive = true;
    try { require('../services/contactSync').getAgendaNamesByEmail().then((m) => { if (alive && m && m.size) setAgendaNames(m); }).catch(() => {}); } catch {}
    return () => { alive = false; };
  }, []);
  const openSayHi = useCallback((item) => {
    const email = item?.author_email || _cjData(item).email;
    if (!email) return;
    const name = _cjName(item, agendaNames);
    try { api.notificationsMarkRead?.(item.id).catch(() => {}); } catch {}
    try {
      require('../services/openConversation').openConversation({ pathname: '/chat-conversation', params: { email, type: 'direct', ...(name ? { name } : {}) } });
    } catch {
      router.push({ pathname: '/chat-conversation', params: { email, type: 'direct', ...(name ? { name } : {}) } });
    }
  }, [agendaNames, router]);
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

  // ── [2026-10-15 native-search-notifs] lista nativa ─────────────────────────
  const [nativeOn, onNativeFailure] = useNativeResults('__chatyy_native_notifs');
  const tx = (k, fb) => { const v = t?.(k); return v && v !== k ? v : fb; };
  const handleDelete = useCallback(async (item) => {
    if (!item || item.id == null) return;
    setItems(prev => {
      const next = prev.filter(n => n.id !== item.id);
      try { _writeLive(next); setCache(FEED_KEY, { success: true, data: { notifications: next } }, 7 * 24 * 3600 * 1000); } catch {}
      return next;
    });
    try { await api.notificationsDelete(item.id); } catch {}
  }, []);
  const nativeMetaRef = useRef(new Map());
  const nativeRows = useMemo(() => {
    if (!nativeOn) return [];
    const list = filterSocialNotifications(items);
    const groups = { today: [], thisWeek: [], older: [] };
    for (const n of list) groups[_feedBucket(n.created_at)].push(n);
    const rows = [];
    const meta = new Map();
    const del = tx('common.delete', 'Apagar');
    const seen = new Set();
    for (const [key, lk, fb] of FEED_BUCKETS) {
      if (!groups[key].length) continue;
      rows.push({ id: `s:${key}`, k: 's', t: tx(lk, fb) });
      groups[key].forEach((item, i) => {
        let id = `f:${item.id}`;
        if (seen.has(id)) id = `${id}#${i}`;
        seen.add(id);
        const isCJ = item.type === 'contact_joined';
        const who = isCJ ? _cjName(item, agendaNames) : (item.author_email?.split('@')[0] || '');
        const countSuffix = item.count > 1 ? ` +${item.count - 1}` : '';
        const body = (item.body || '').replace(item.author_email + ' ', '');
        const row = isCJ
          ? { id, k: 'r', t: _cjTitle(t, who), tl: 2 }
          : { id, k: 'r', t: `${who}${countSuffix}${body ? `  ${body}` : ''}`.trim(), tl: 2 };
        const when = timeAgo(item.created_at, t);
        if (when) row.tm = when;
        if (item.author_email) { row.tiles = contactTile(item.author_email, who); row.bd = FEED_GLYPH[item.type] || 'bell'; }
        else row.gl = FEED_GLYPH[item.type] || 'bell';
        if (!item.read) row.un = 1;
        if (item.type === 'follow' && !item.action_taken) row.b1 = tx('notifications.followBack', 'Seguir de volta');
        else if (isCJ && item.author_email) row.b1 = _cjSayHi(t);
        if (item.id != null) row.sw = del;
        rows.push(row);
        meta.set(id, item);
      });
    }
    if (loading && page > 1) rows.push({ id: 'l:more', k: 'l' });
    nativeMetaRef.current = meta;
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeOn, items, loading, page, t, agendaNames]);
  const onNativePress = useCallback((id) => { const it = nativeMetaRef.current.get(id); if (it) handlePress(it); });
  const onNativeAction = useCallback((id, action) => {
    const it = nativeMetaRef.current.get(id);
    if (!it) return;
    if (action === 'delete') handleDelete(it);
    else if (action === 'b1') { if (it.type === 'contact_joined') openSayHi(it); else handleFollowBack(it); }
  }, [handleDelete, handleFollowBack, openSayHi]);
  const onEndReached = () => {
    if (!hasMore || loading) return;
    const next = page + 1;
    setPage(next);
    load(next);
  };

  const handlePress = (item) => {
    const data = item.data || {};
    if (item.type === 'contact_joined') {
      openSayHi(item);
    } else if (item.type === 'follow' && item.author_email) {
      router.push(`/u/${encodeURIComponent(item.author_email)}`);
    } else if ((item.type === 'feed_like' || item.type === 'feed_comment') && data.post_id) {
      // /feed-comments is not a registered route — open the public post page
      // instead, which renders the full post with likes + inline comments
      // and works for both logged-in and logged-out viewers.
      router.push(`/feed/${data.post_id}${item.type === 'feed_comment' ? '?comments=1' : ''}`); // [notif-audit 2026-10-17]
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
    const isCJ = item.type === 'contact_joined';
    const cjName = isCJ ? _cjName(item, agendaNames) : '';
    return (
      <TouchableOpacity
        onPress={() => handlePress(item)}
        activeOpacity={0.7}
        style={[styles.row, { backgroundColor: item.read ? 'transparent' : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17, 17, 17,0.05)') }]}
      >
        <View style={{ position: 'relative' }}>
          <AvatarCircle email={item.author_email} name={isCJ ? (cjName || item.author_email) : item.author_email} size={44} />
          <View style={[styles.iconBadge, { backgroundColor: colors.background }]}>
            <NotificationIcon type={item.type} colors={colors} />
          </View>
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          {isCJ ? (
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={2}>{_cjTitle(t, cjName)}</Text>
          ) : (
          <Text style={{ color: colors.text, fontSize: 14 }} numberOfLines={2}>
            <Text style={{ fontWeight: '700' }}>{item.author_email?.split('@')[0] || ''}</Text>
            {countSuffix ? <Text style={{ color: colors.textSecondary }}>{countSuffix}</Text> : null}
            {'  '}
            <Text style={{ color: colors.textSecondary }}>{(item.body || '').replace(item.author_email + ' ', '')}</Text>
          </Text>
          )}
          <Text style={{ color: colors.textTertiary, fontSize: 11.5, marginTop: 3 }}>
            {timeAgo(item.created_at, t)}
          </Text>
          {isCJ && !!item.author_email && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TouchableOpacity
                onPress={(e) => { e?.stopPropagation?.(); openSayHi(item); }}
                activeOpacity={0.85}
                style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: isDark ? '#ffffff' : ACCENT }}
                accessibilityRole="button"
                accessibilityLabel={_cjSayHi(t)}
              >
                <Text style={{ color: isDark ? '#000' : '#fff', fontSize: 13, fontWeight: '700' }}>{_cjSayHi(t)}</Text>
              </TouchableOpacity>
            </View>
          )}
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
            <Text style={{ marginTop: 6, fontSize: 12, color: colors.textSecondary, fontWeight: '600' }}>
              {t?.('notifications.followingNow') || 'Seguindo'}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: t('notifications.title'), largeTitle: nativeListLargeTitleOn(), headerLargeTitle: nativeListLargeTitleOn() })} /* [2026-10-17 freeze] large title + lista nativa = laço na main thread (nativeListLargeTitleOn) */ />
      ) : (
      <View style={[styles.header, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('notifications.title') || 'Atividade'}</Text>
        <View style={styles.headerBtn} />
      </View>
      )}

      {loading && items.length === 0 ? (
        <NativeInsetView>
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
        </NativeInsetView>
      ) : items.length === 0 ? (
        <NativeInsetView>
        <ScreenEmptyState
          kind="notifications"
          mascot="sleep"
          title={t('notifications.empty') || 'Sem notificações ainda'}
          subtitle={t('notifications.emptyHint') || 'Curtidas, comentários e novos seguidores aparecem aqui.'}
          tips={[
            { icon: 'star', label: t('notifications.emptyTipLikes') || 'Curtidas e comentários nos seus posts' },
            { icon: 'users', label: t('notifications.emptyTipFollows') || 'Quando alguém começa a seguir você' },
            { icon: 'bell', label: t('notifications.emptyTipMentions') || 'Menções, respostas e lembretes' },
          ]}
        />
        </NativeInsetView>
      ) : nativeOn ? (
        <NativeResultList
          rows={nativeRows}
          colors={colors}
          isDark={isDark}
          separators
          autoInset={USE_NATIVE_HEADER}
          refreshEnabled
          refreshing={refreshing}
          onRefresh={onRefresh}
          onEndReached={onEndReached}
          bottomInset={16}
          onPress={onNativePress}
          onAction={onNativeAction}
          onFailure={onNativeFailure}
        />
      ) : (
        <FlatList
          {...nativeScrollInsetProps()}
          data={filterSocialNotifications(items) /* [2026-10-14] sem e-mail na central */}
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
          <IconCheck size={16} color="#fff" />
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
