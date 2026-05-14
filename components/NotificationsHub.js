/**
 * NotificationsHub — Unified notifications overlay (top-right modal).
 * Instagram Activity-grade polish: 4 tabs + date sections + Instagram item
 * layout (avatar 44 + text + thumbnail + relative time) + grouped likes
 * with avatar stack + inline action pills + unread highlight + mark-all-read.
 *
 * Single chronological stream of: emails, chat @mentions, follows,
 * post likes, post comments. Tap routes via the `route` field returned
 * by the backend (notifications_feed). Pull-to-refresh + empty state.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, Image,
  ScrollView, ActivityIndicator, Platform, StyleSheet, RefreshControl,
  Animated, Easing,
} from 'react-native';
import * as api from '../services/api';
import AvatarCircle from './AvatarCircle';
import {
  IconX, IconMail, IconAtSign, IconMessageSquare,
  IconUserPlus, IconHeart, IconBell, IconCheck,
} from './Icons';

// Brand color (Chatyy purple)
const BRAND = '#7C3AED';

// 4-segment Instagram-style tab bar
const TABS = [
  { key: 'all',       label: 'Todas',     types: null },
  { key: 'foryou',    label: 'Pra você',  types: ['like', 'comment', 'mention', 'follow'] },
  { key: 'following', label: 'Seguindo',  types: ['chat', 'live', 'email'] },
  { key: 'you',       label: 'Você',      types: ['mention', 'comment', 'like'] },
];

// Inline relative-time helper — no extra deps. Produces "agora",
// "5m", "2h", "3d", or a locale short date for >7d.
function relativeTime(iso, t) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (isNaN(ts)) return '';
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 45)   return t?.('time.now') || 'agora';
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7)    return `${d}d`;
  try {
    return (_d => isNaN(_d.getTime()) ? '' : _d.toLocaleDateString())(new Date(ts));
  } catch { return `${d}d`; }
}

// Date bucket: today / yesterday / thisWeek / older
function dateBucket(iso) {
  if (!iso) return 'older';
  const d = new Date(iso);
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

function iconForType(type) {
  switch (type) {
    case 'email':   return <IconMail        size={12} color="#fff" />;
    case 'mention': return <IconAtSign      size={12} color="#fff" />;
    case 'follow':  return <IconUserPlus    size={12} color="#fff" />;
    case 'like':    return <IconHeart       size={12} color="#fff" />;
    case 'comment': return <IconMessageSquare size={12} color="#fff" />;
    default:        return <IconBell        size={12} color="#fff" />;
  }
}
function bgForType(type) {
  switch (type) {
    case 'email':   return BRAND;
    case 'mention': return '#0ea5e9';
    case 'follow':  return '#10b981';
    case 'like':    return '#ef4444';
    case 'comment': return '#f59e0b';
    default:        return '#6b7280';
  }
}

// Avatar stack for grouped likes
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

function NotifRow({ item, colors, isDark, t, onPress, onAction }) {
  const when = relativeTime(item.created_at, t);
  const isLikeGroup =
    item.type === 'like' &&
    Array.isArray(item.actor_emails) &&
    item.actor_emails.length > 1;

  let title = item.title || '';
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
  }
  if (item.type === 'follow' && item.actor_name && !item.title?.includes(item.actor_name)) {
    title = `${item.actor_name} começou a seguir você`;
  }

  const showThumb =
    !!(item.thumbnail_url || item.post_thumbnail) &&
    (item.type === 'like' || item.type === 'comment' || item.type === 'mention');
  const thumbUri = item.thumbnail_url || item.post_thumbnail;

  const showActions = item.type === 'follow' && !item.action_taken;
  const unreadBg = isDark ? 'rgba(124,58,237,0.10)' : 'rgba(124,58,237,0.05)';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingLeft: 6, paddingRight: 16, paddingVertical: 11,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors?.border,
        backgroundColor: !item.read ? unreadBg : 'transparent',
      }}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      {/* Unread rail */}
      {!item.read ? (
        <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 1.5, backgroundColor: BRAND, marginVertical: 2 }} />
      ) : (
        <View style={{ width: 3 }} />
      )}

      {/* Avatar 44 with corner type-badge — or stack for grouped likes */}
      <View style={{ width: 44, height: 44, position: 'relative' }}>
        {isLikeGroup ? (
          <AvatarStack emails={item.actor_emails || []} size={36} />
        ) : item.type === 'email' ? (
          <View style={{
            width: 44, height: 44, borderRadius: 22,
            backgroundColor: BRAND + '20',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <IconMail size={20} color={BRAND} />
          </View>
        ) : (
          <>
            <AvatarCircle
              email={item.actor_email}
              name={item.actor_name || item.actor_email || '?'}
              size={44}
            />
            <View style={{
              position: 'absolute', right: -2, bottom: -2,
              width: 20, height: 20, borderRadius: 10,
              backgroundColor: bgForType(item.type),
              alignItems: 'center', justifyContent: 'center',
              borderWidth: 2, borderColor: colors?.background || '#fff',
            }}>
              {iconForType(item.type)}
            </View>
          </>
        )}
      </View>

      {/* Center text */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={2}
          style={{ fontSize: 14, fontWeight: '500', color: colors?.text, lineHeight: 19 }}
        >
          {title}
          {!!when && (
            <Text style={{ fontSize: 12, fontWeight: '400', color: colors?.textTertiary }}>
              {'  · ' + when}
            </Text>
          )}
        </Text>
        {!!item.preview && !isLikeGroup && (
          <Text
            numberOfLines={1}
            style={{ fontSize: 12.5, color: colors?.textSecondary, marginTop: 2 }}
          >
            {item.preview}
          </Text>
        )}

        {showActions && (
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 7 }}>
            <TouchableOpacity
              onPress={(e) => { e?.stopPropagation?.(); onAction?.(item, 'follow_back'); }}
              style={{
                paddingHorizontal: 12, paddingVertical: 5,
                borderRadius: 7, backgroundColor: BRAND,
              }}
              activeOpacity={0.85}
            >
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
                {t?.('notifications.followBack') || 'Seguir de volta'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={(e) => { e?.stopPropagation?.(); onAction?.(item, 'message'); }}
              style={{
                paddingHorizontal: 12, paddingVertical: 5,
                borderRadius: 7,
                borderWidth: 1, borderColor: colors?.border,
              }}
              activeOpacity={0.85}
            >
              <Text style={{ color: colors?.text, fontSize: 12, fontWeight: '600' }}>
                {t?.('notifications.message') || 'Mensagem'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Thumbnail 44 square */}
      {showThumb && (
        <View style={{
          width: 44, height: 44, borderRadius: 4,
          overflow: 'hidden',
          backgroundColor: colors?.borderLight || colors?.border,
          flexShrink: 0,
        }}>
          {Platform.OS === 'web' ? (
            <img src={thumbUri} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          ) : (
            <Image source={{ uri: thumbUri }} style={{ width: 44, height: 44 }} />
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

// Animated underline tabs
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
      style={{
        flexDirection: 'row',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors?.border,
        position: 'relative',
      }}
    >
      {TABS.map(tab => {
        const isActive = activeTab === tab.key;
        const unread = unreadCounts[tab.key] || 0;
        return (
          <TouchableOpacity
            key={tab.key}
            style={{ flex: 1, paddingVertical: 10, alignItems: 'center' }}
            onPress={() => onChange(tab.key)}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={{
                fontSize: 12.5,
                color: isActive ? colors?.text : colors?.textSecondary,
                fontWeight: isActive ? '700' : '500',
              }}>
                {tab.label}
              </Text>
              {unread > 0 && (
                <View style={{
                  minWidth: 14, height: 14, borderRadius: 7, paddingHorizontal: 3,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: BRAND,
                }}>
                  <Text style={{ color: '#fff', fontSize: 8.5, fontWeight: '800' }}>
                    {unread > 99 ? '99+' : unread}
                  </Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        );
      })}
      {tabWidth > 0 && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            bottom: 0,
            height: 2.5,
            borderRadius: 2,
            width: Math.max(0, tabWidth - 32),
            left: 16,
            backgroundColor: BRAND,
            transform: [{ translateX: indicatorX }],
          }}
        />
      )}
    </View>
  );
}

function SectionHeader({ label, colors }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 }}>
      <Text style={{ fontSize: 12.5, fontWeight: '700', color: colors?.text, letterSpacing: -0.1 }}>
        {label}
      </Text>
    </View>
  );
}

function EmptyState({ colors, t }) {
  return (
    <View style={{ padding: 40, alignItems: 'center' }}>
      <View style={{
        width: 80, height: 80, borderRadius: 40,
        backgroundColor: 'rgba(124,58,237,0.10)',
        alignItems: 'center', justifyContent: 'center',
        marginBottom: 14,
      }}>
        <IconCheck size={36} color={BRAND} />
      </View>
      <Text style={{ fontSize: 16, fontWeight: '700', color: colors?.text, marginBottom: 6 }}>
        {t?.('notifications.allCaughtUp') || 'Você está em dia'}
      </Text>
      <Text style={{
        color: colors?.textSecondary,
        fontSize: 13,
        textAlign: 'center',
        lineHeight: 18,
        maxWidth: 260,
      }}>
        {t?.('notifications.allCaughtUpDesc') || 'Quando rolar algo novo, aparece aqui.'}
      </Text>
    </View>
  );
}

export default function NotificationsHub({
  visible, onClose, colors, isDark, t, router,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('all');

  const load = useCallback(async () => {
    try {
      const r = await api.notificationsFeed();
      if (r?.success && r.data && Array.isArray(r.data.items)) {
        setItems(r.data.items);
      } else {
        setItems([]);
      }
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      await load();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [visible, load]);

  const close = useCallback(() => { onClose?.(); }, [onClose]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const go = (path) => {
    close();
    setTimeout(() => {
      try { router?.push(path); } catch {}
    }, 60);
  };

  const markAllRead = useCallback(async () => {
    try {
      await api.notificationsRead?.({ all: true });
      setItems(prev => prev.map(n => ({ ...n, read: true })));
    } catch {}
  }, []);

  const handleAction = useCallback((item, kind) => {
    if (kind === 'follow_back') {
      // followUser espera string `targetEmail`, não objeto. O bug original
      // passava `{ email }` → backend recebia `target_email = { email: ... }`
      // e silenciosamente não persistia o follow. UI ficava "marcada" mas
      // o servidor nunca registrava nada.
      if (item?.actor_email) {
        api.followUser?.(item.actor_email).catch((e) => {
          console.warn('[NotificationsHub] followUser failed:', e?.message || e);
        });
      }
      setItems(prev => prev.map(n =>
        n.id === item.id ? { ...n, action_taken: 'follow_back' } : n
      ));
    } else if (kind === 'message') {
      go(`/chat-conversation?peer=${encodeURIComponent(item.actor_email || '')}`);
    }
  }, []); // eslint-disable-line

  // Filter by tab + group by date
  const filtered = useMemo(() => {
    const tabDef = TABS.find(tt => tt.key === activeTab);
    if (!tabDef?.types) return items;
    return items.filter(n => tabDef.types.includes(n.type));
  }, [items, activeTab]);

  const sectioned = useMemo(() => {
    if (filtered.length === 0) return [];
    const buckets = { today: [], yesterday: [], thisWeek: [], older: [] };
    for (const n of filtered) {
      buckets[dateBucket(n.created_at)].push(n);
    }
    const out = [];
    for (const k of ['today', 'yesterday', 'thisWeek', 'older']) {
      if (buckets[k].length === 0) continue;
      out.push({
        __section: true,
        id: `section-${k}`,
        label: t?.(BUCKET_LABELS[k].key) || BUCKET_LABELS[k].fallback,
      });
      for (const n of buckets[k]) out.push(n);
    }
    return out;
  }, [filtered, t]);

  const unreadCounts = useMemo(() => {
    const c = { all: items.filter(n => !n.read).length };
    for (const tab of TABS) {
      if (!tab.types) continue;
      c[tab.key] = items.filter(n => !n.read && tab.types.includes(n.type)).length;
    }
    return c;
  }, [items]);

  const hasUnread = items.some(n => !n.read);

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}
        onPress={close}
      >
        <Pressable
          style={{
            position: 'absolute',
            top: Platform.OS === 'ios' ? 60 : 30,
            right: 12,
            left: Platform.OS === 'web' ? undefined : 12,
            width: Platform.OS === 'web' ? 440 : undefined,
            maxWidth: 540,
            borderRadius: 16,
            backgroundColor: colors?.background || '#fff',
            maxHeight: '85%',
            overflow: 'hidden',
            ...(Platform.OS === 'web'
              ? { boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }
              : { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.3, shadowRadius: 24, elevation: 10 }),
          }}
          onPress={(e) => e.stopPropagation?.()}
        >
          {/* Header */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingHorizontal: 16, paddingVertical: 12,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors?.border,
          }}>
            <IconBell size={18} color={BRAND} />
            <Text style={{
              flex: 1, fontSize: 15, fontWeight: '700', color: colors?.text,
            }}>
              {t?.('notifications.title') || 'Notificações'}
            </Text>
            {loading && !refreshing && (
              <ActivityIndicator size="small" color={BRAND} />
            )}
            {hasUnread && (
              <TouchableOpacity
                onPress={markAllRead}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 4,
                  paddingHorizontal: 10, paddingVertical: 5,
                  borderRadius: 999,
                  backgroundColor: 'rgba(124,58,237,0.10)',
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={t?.('notifications.markAll') || 'Marcar todas'}
              >
                <IconCheck size={12} color={BRAND} />
                <Text style={{ fontSize: 11, fontWeight: '700', color: BRAND }}>
                  {t?.('notifications.markAllShort') || 'Marcar todas'}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={close}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel={t?.('common.close') || 'Fechar'}
            >
              <IconX size={20} color={colors?.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Tabs */}
          <TabBar
            activeTab={activeTab}
            onChange={setActiveTab}
            colors={colors}
            t={t}
            unreadCounts={unreadCounts}
          />

          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            refreshControl={
              Platform.OS === 'web'
                ? undefined
                : (
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={BRAND}
                  />
                )
            }
          >
            {/* Web: manual refresh affordance */}
            {Platform.OS === 'web' && (
              <TouchableOpacity
                onPress={onRefresh}
                disabled={refreshing}
                style={{
                  paddingVertical: 8, alignItems: 'center',
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors?.border,
                }}
              >
                <Text style={{ fontSize: 12, color: BRAND }}>
                  {refreshing
                    ? (t?.('common.loading') || 'Carregando...')
                    : (t?.('common.refresh') || 'Atualizar')}
                </Text>
              </TouchableOpacity>
            )}

            {!loading && sectioned.length === 0 && (
              <EmptyState colors={colors} t={t} />
            )}

            {sectioned.map((it) =>
              it.__section ? (
                <SectionHeader key={it.id} label={it.label} colors={colors} />
              ) : (
                <NotifRow
                  key={it.id}
                  item={it}
                  colors={colors}
                  isDark={isDark}
                  t={t}
                  onPress={() => {
                    if (!it.read) {
                      try { api.notificationsRead?.({ ids: [it.id] }); } catch {}
                      setItems(prev => prev.map(n => n.id === it.id ? { ...n, read: true } : n));
                    }
                    if (it.route) go(it.route);
                  }}
                  onAction={handleAction}
                />
              )
            )}

            <View style={{ height: 12 }} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
