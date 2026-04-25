/**
 * FollowersSheet — Instagram-style bottom sheet listing a user's followers
 * or the accounts they follow. Two tabs, persistent initial tab chosen by
 * the caller (Stat tap on "Seguidores" vs "Seguindo").
 *
 * Props:
 *   visible, email (target user), initialTab ('followers' | 'following'),
 *   colors, isDark, t, onClose, router
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Modal, Pressable, TouchableOpacity, FlatList, ActivityIndicator,
  StyleSheet, Platform, TextInput,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import { IconX, IconSearch } from './Icons';
import * as api from '../services/api';

const ACCENT = '#7C3AED';

export default function FollowersSheet({
  visible, email, initialTab = 'followers',
  colors, isDark, t, onClose, router,
}) {
  const [tab, setTab] = useState(initialTab);
  const [lists, setLists] = useState({ followers: [], following: [] });
  const [loading, setLoading] = useState({ followers: false, following: false });
  const [loaded, setLoaded] = useState({ followers: false, following: false });
  const [query, setQuery] = useState('');
  // Pagination state — previously we loaded the whole list in a single
  // request, which pegged the main thread when a verified user had 5k+
  // followers and caused onEndReached to never fire because `hasMore`
  // didn't exist. Now we page 50 at a time and load on scroll bottom.
  const [page, setPage] = useState({ followers: 1, following: 1 });
  const [hasMore, setHasMore] = useState({ followers: true, following: true });
  const [loadingMore, setLoadingMore] = useState({ followers: false, following: false });
  const PAGE_SIZE = 50;

  useEffect(() => { if (visible) setTab(initialTab); }, [visible, initialTab]);
  useEffect(() => { if (!visible) setQuery(''); }, [visible]);

  const load = useCallback(async (which, nextPage = 1, append = false) => {
    if (!email) return;
    if (append) setLoadingMore(prev => ({ ...prev, [which]: true }));
    else setLoading(prev => ({ ...prev, [which]: true }));
    try {
      const r = which === 'followers' ? await api.getFollowers(email, nextPage) : await api.getFollowing(email, nextPage);
      if (r?.success) {
        const users = r.data?.users || r.data || [];
        const arr = Array.isArray(users) ? users : [];
        setLists(prev => ({
          ...prev,
          [which]: append ? [...(prev[which] || []), ...arr] : arr,
        }));
        setLoaded(prev => ({ ...prev, [which]: true }));
        setHasMore(prev => ({ ...prev, [which]: arr.length >= PAGE_SIZE }));
        setPage(prev => ({ ...prev, [which]: nextPage }));
      }
    } catch {}
    finally {
      setLoading(prev => ({ ...prev, [which]: false }));
      setLoadingMore(prev => ({ ...prev, [which]: false }));
    }
  }, [email]);

  useEffect(() => {
    if (!visible) return;
    if (!loaded[tab] && !loading[tab]) load(tab, 1, false);
  }, [visible, tab, loaded, loading, load]);

  const handleEndReached = useCallback(() => {
    if (loading[tab] || loadingMore[tab]) return;
    if (!hasMore[tab]) return;
    if (query.trim()) return; // avoid paginating while user is searching
    load(tab, (page[tab] || 1) + 1, true);
  }, [tab, loading, loadingMore, hasMore, page, query, load]);

  const filtered = useMemo(() => {
    const raw = lists[tab] || [];
    if (!query.trim()) return raw;
    const q = query.toLowerCase();
    return raw.filter(u => {
      const name = (u.name || '').toLowerCase();
      const un = (u.username || u.email?.split('@')[0] || '').toLowerCase();
      return name.includes(q) || un.includes(q);
    });
  }, [lists, tab, query]);

  const openUser = useCallback((addr) => {
    if (!addr) return;
    onClose?.();
    setTimeout(() => router?.push(`/u/${encodeURIComponent(addr)}`), 80);
  }, [router, onClose]);

  // Per-user single-flight lock so rapid taps on the same Follow button
  // don't fire overlapping requests that leave the UI inconsistent.
  const followLocksRef = useRef(new Set());
  const handleToggleFollow = useCallback(async (user) => {
    if (!user?.email || user.is_self) return;
    if (followLocksRef.current.has(user.email)) return;
    followLocksRef.current.add(user.email);
    setLists(prev => ({
      ...prev,
      [tab]: prev[tab].map(u => u.email === user.email ? { ...u, is_following: !u.is_following } : u),
    }));
    try {
      if (user.is_following) await api.unfollowUser?.(user.email);
      else                    await api.followUser?.(user.email);
    } catch {
      setLists(prev => ({
        ...prev,
        [tab]: prev[tab].map(u => u.email === user.email ? { ...u, is_following: user.is_following } : u),
      }));
    } finally {
      followLocksRef.current.delete(user.email);
    }
  }, [tab]);

  const renderItem = useCallback(({ item }) => (
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
            paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8,
            backgroundColor: item.is_following ? (isDark ? '#222' : '#eee') : ACCENT,
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
  ), [colors, isDark, t, openUser, handleToggleFollow]);

  if (!visible) return null;

  const activeLoading = loading[tab];
  const activeEmpty = loaded[tab] && !activeLoading && filtered.length === 0;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
        <Pressable
          onPress={e => e.stopPropagation?.()}
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            backgroundColor: colors?.background || '#fff',
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            maxHeight: '85%', minHeight: 320,
            paddingBottom: Platform.OS === 'ios' ? 24 : 10,
          }}
        >
          {/* Drag handle */}
          <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>

          {/* Close */}
          <TouchableOpacity onPress={onClose} style={{ position: 'absolute', right: 10, top: 8, padding: 8, zIndex: 10 }}>
            <IconX size={22} color={colors?.textSecondary} />
          </TouchableOpacity>

          {/* Tabs */}
          <View style={{
            flexDirection: 'row',
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors?.border,
          }}>
            {['followers', 'following'].map(k => {
              const active = tab === k;
              const count = lists[k]?.length || 0;
              return (
                <TouchableOpacity
                  key={k}
                  onPress={() => setTab(k)}
                  style={{
                    flex: 1, paddingVertical: 13, alignItems: 'center',
                    borderBottomWidth: active ? 2 : 0,
                    borderBottomColor: ACCENT,
                  }}
                >
                  <Text style={{
                    fontSize: 14,
                    fontWeight: active ? '700' : '500',
                    color: active ? colors?.text : colors?.textSecondary,
                  }}>
                    {k === 'followers'
                      ? `${t?.('profile.followers') || 'Seguidores'}${count ? ` · ${count}` : ''}`
                      : `${t?.('profile.following') || 'Seguindo'}${count ? ` · ${count}` : ''}`}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Search */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 8,
            marginHorizontal: 14, marginTop: 10, marginBottom: 4,
            paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
            backgroundColor: colors?.surface || (isDark ? '#1b1b1b' : '#f2f2f4'),
          }}>
            <IconSearch size={16} color={colors?.textTertiary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t?.('common.search') || 'Buscar'}
              placeholderTextColor={colors?.textTertiary}
              style={{ flex: 1, fontSize: 14, color: colors?.text, padding: 0 }}
            />
          </View>

          {/* Body */}
          {activeLoading && (
            <View style={{ paddingVertical: 30, alignItems: 'center' }}>
              <ActivityIndicator color={ACCENT} />
            </View>
          )}
          {activeEmpty && (
            <View style={{ paddingVertical: 40, alignItems: 'center' }}>
              <Text style={{ color: colors?.textSecondary, fontSize: 14 }}>
                {tab === 'followers'
                  ? (t?.('profile.noFollowers') || 'Ninguem segue ainda')
                  : (t?.('profile.noFollowing') || 'Não está seguindo ninguem')}
              </Text>
            </View>
          )}
          <FlatList
            data={filtered}
            keyExtractor={(u, i) => u.email || String(i)}
            renderItem={renderItem}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.4}
            ListFooterComponent={loadingMore[tab] ? (
              <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={ACCENT} />
              </View>
            ) : null}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
