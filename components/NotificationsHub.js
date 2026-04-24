/**
 * NotificationsHub — Unified notifications overlay (top-right modal).
 * Single chronological stream of: emails, chat @mentions, follows,
 * post likes, post comments. Tap routes via the `route` field returned
 * by the backend (notifications_feed). Pull-to-refresh + empty state.
 * Style/structure mirrors GlobalSearch so the app has consistent UX.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable,
  ScrollView, ActivityIndicator, Platform, StyleSheet, RefreshControl,
} from 'react-native';
import * as api from '../services/api';
import AvatarCircle from './AvatarCircle';
import {
  IconX, IconMail, IconAtSign, IconMessageSquare,
  IconUserPlus, IconHeart, IconChevronRight, IconBell,
} from './Icons';

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
    return new Date(ts).toLocaleDateString();
  } catch { return `${d}d`; }
}

function iconForType(type, colors) {
  const c = colors?.primary || '#7C3AED';
  switch (type) {
    case 'email':   return <IconMail        size={18} color={c} />;
    case 'mention': return <IconAtSign      size={18} color="#3B82F6" />;
    case 'follow':  return <IconUserPlus    size={18} color="#22C55E" />;
    case 'like':    return <IconHeart       size={18} color="#EF4444" />;
    case 'comment': return <IconMessageSquare size={18} color="#F59E0B" />;
    default:        return <IconBell        size={18} color={c} />;
  }
}

function NotifRow({ item, colors, t, onPress }) {
  const when = relativeTime(item.created_at, t);
  const hasActor = !!item.actor_email && item.type !== 'email';
  // For emails we show an envelope tile (more recognizable than a fake avatar).
  // For everything else: actor avatar + a small type badge on top-right corner.
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingHorizontal: 16, paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors?.border,
      }}
      accessibilityRole="button"
      accessibilityLabel={item.title}
    >
      <View style={{ width: 42, height: 42, position: 'relative' }}>
        {item.type === 'email' ? (
          <View style={{
            width: 42, height: 42, borderRadius: 21,
            backgroundColor: (colors?.primary || '#7C3AED') + '20',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <IconMail size={20} color={colors?.primary || '#7C3AED'} />
          </View>
        ) : (
          <AvatarCircle
            email={item.actor_email}
            name={item.actor_name || item.actor_email || '?'}
            size={42}
          />
        )}
        {hasActor && (
          <View style={{
            position: 'absolute', right: -2, bottom: -2,
            width: 20, height: 20, borderRadius: 10,
            backgroundColor: colors?.background || '#fff',
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 1.5, borderColor: colors?.background || '#fff',
          }}>
            {iconForType(item.type, colors)}
          </View>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ fontSize: 14.5, fontWeight: '600', color: colors?.text }}
        >
          {item.title}
        </Text>
        {!!item.preview && (
          <Text
            numberOfLines={1}
            style={{ fontSize: 12.5, color: colors?.textSecondary, marginTop: 2 }}
          >
            {item.preview}
          </Text>
        )}
        {!!when && (
          <Text style={{ fontSize: 11, color: colors?.textTertiary, marginTop: 2 }}>
            {when}
          </Text>
        )}
      </View>
      <IconChevronRight size={16} color={colors?.textTertiary} />
    </TouchableOpacity>
  );
}

export default function NotificationsHub({
  visible, onClose, colors, isDark, t, router,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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

  // Fetch on open
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
            width: Platform.OS === 'web' ? 420 : undefined,
            maxWidth: 520,
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
            <IconBell size={18} color={colors?.primary || '#7C3AED'} />
            <Text style={{
              flex: 1, fontSize: 15, fontWeight: '700', color: colors?.text,
            }}>
              {t?.('notifications.title') || 'Notificações'}
            </Text>
            {loading && !refreshing && (
              <ActivityIndicator size="small" color={colors?.primary || '#7C3AED'} />
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
                    tintColor={colors?.primary || '#7C3AED'}
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
                <Text style={{ fontSize: 12, color: colors?.primary || '#7C3AED' }}>
                  {refreshing
                    ? (t?.('common.loading') || 'Carregando...')
                    : (t?.('common.refresh') || 'Atualizar')}
                </Text>
              </TouchableOpacity>
            )}

            {!loading && items.length === 0 && (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <IconBell size={40} color={colors?.textTertiary} />
                <Text style={{
                  marginTop: 12,
                  color: colors?.textSecondary,
                  fontSize: 13,
                  textAlign: 'center',
                }}>
                  {t?.('notifications.empty') || 'Nada de novo por aqui'}
                </Text>
              </View>
            )}

            {items.map((it) => (
              <NotifRow
                key={it.id}
                item={it}
                colors={colors}
                t={t}
                onPress={() => it.route && go(it.route)}
              />
            ))}

            <View style={{ height: 12 }} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
