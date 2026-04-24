/**
 * LikersSheet — Instagram-style bottom sheet that shows who liked a post.
 * Tap a row to open that user's profile. Each non-self row has a
 * Seguir/Seguindo toggle so the viewer can follow straight from the list.
 *
 * Props:
 *   visible, postId, colors, isDark, t, onClose, router
 *   totalCount (optional) — shown in the header while loading, saves a flash
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, Pressable, TouchableOpacity, FlatList, ActivityIndicator,
  StyleSheet, Platform,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import { IconX } from './Icons';
import * as api from '../services/api';

const ACCENT = '#7C3AED';

export default function LikersSheet({
  visible, postId, totalCount, colors, isDark, t, onClose, router,
}) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!visible || !postId) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const r = await api.feedLikers(postId);
        if (cancelled) return;
        if (r?.success) setUsers(r.data?.users || []);
        else setErr(r?.message || 'Erro');
      } catch (e) {
        if (!cancelled) setErr(e?.message || 'Erro');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, postId]);

  const header = useMemo(() => {
    const count = users.length || totalCount || 0;
    return (
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 16, paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors?.border,
      }}>
        <Text style={{ flex: 1, fontSize: 16, fontWeight: '700', color: colors?.text, textAlign: 'center' }}>
          {(t?.('feed.likesTitle') || 'Curtidas')}{count ? ` · ${count}` : ''}
        </Text>
        <TouchableOpacity onPress={onClose} style={{ padding: 6, position: 'absolute', right: 10, top: 8 }}>
          <IconX size={22} color={colors?.textSecondary} />
        </TouchableOpacity>
      </View>
    );
  }, [users.length, totalCount, colors, t, onClose]);

  const openUser = useCallback((email) => {
    if (!email) return;
    onClose?.();
    // Let the close animation start before pushing
    setTimeout(() => router?.push(`/u/${encodeURIComponent(email)}`), 80);
  }, [router, onClose]);

  const handleToggleFollow = useCallback(async (user) => {
    if (!user?.email || user.is_self) return;
    // Optimistic flip
    setUsers(prev => prev.map(u => u.email === user.email ? { ...u, is_following: !u.is_following } : u));
    try {
      if (user.is_following) await api.unfollowUser?.(user.email);
      else                    await api.followUser?.(user.email);
    } catch {
      // Revert on failure
      setUsers(prev => prev.map(u => u.email === user.email ? { ...u, is_following: user.is_following } : u));
    }
  }, []);

  const renderItem = useCallback(({ item }) => {
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => openUser(item.email)}
        style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 }}
      >
        <AvatarCircle name={item.name} email={item.email} size={44} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: colors?.text }} numberOfLines={1}>
            {item.name || item.username || item.email?.split('@')[0]}
          </Text>
          <Text style={{ fontSize: 12, color: colors?.textSecondary, marginTop: 1 }} numberOfLines={1}>
            @{item.username || item.email?.split('@')[0]}
          </Text>
        </View>
        {!item.is_self && (
          <TouchableOpacity
            onPress={() => handleToggleFollow(item)}
            activeOpacity={0.7}
            style={{
              paddingHorizontal: 16, paddingVertical: 7, borderRadius: 8,
              backgroundColor: item.is_following
                ? (isDark ? '#222' : '#eee')
                : ACCENT,
            }}
          >
            <Text style={{
              fontSize: 13, fontWeight: '700',
              color: item.is_following ? colors?.text : '#fff',
            }}>
              {item.is_following
                ? (t?.('profile.following') || 'Seguindo')
                : (t?.('profile.follow') || 'Seguir')}
            </Text>
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    );
  }, [colors, isDark, t, openUser, handleToggleFollow]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
        <Pressable
          onPress={e => e.stopPropagation?.()}
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            backgroundColor: colors?.background || '#fff',
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            maxHeight: '80%', minHeight: 220,
            paddingBottom: Platform.OS === 'ios' ? 24 : 10,
          }}
        >
          {/* Drag handle */}
          <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 2 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>
          {header}
          {loading && (
            <View style={{ paddingVertical: 30, alignItems: 'center' }}>
              <ActivityIndicator color={ACCENT} />
            </View>
          )}
          {!!err && !loading && (
            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
              <Text style={{ color: colors?.textSecondary }}>{err}</Text>
            </View>
          )}
          {!loading && !err && users.length === 0 && (
            <View style={{ paddingVertical: 30, alignItems: 'center' }}>
              <Text style={{ color: colors?.textSecondary, fontSize: 14 }}>
                {t?.('feed.noLikesYet') || 'Ainda não há curtidas'}
              </Text>
            </View>
          )}
          <FlatList
            data={users}
            keyExtractor={(u) => u.email}
            renderItem={renderItem}
            showsVerticalScrollIndicator={false}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
