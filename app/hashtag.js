import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Dimensions, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconHash } from '../components/Icons';
import * as api from '../services/api';

const ACCENT = '#7C3AED';

const SCREEN_WIDTH = Dimensions.get('window').width;
const COLS = 3;
const GAP = 2;
const CELL = (Math.min(SCREEN_WIDTH, 700) - GAP * (COLS - 1)) / COLS;
const BASE_URL = 'https://chatyy.com.br';

function resolveUrl(u) {
  if (!u) return '';
  if (u.startsWith('http')) return u;
  return BASE_URL + (u.startsWith('/') ? '' : '/') + u;
}

export default function HashtagScreen() {
  const { tag: rawTag } = useLocalSearchParams();
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const tag = String(rawTag || '').replace(/^#/, '').slice(0, 50);
  const [posts, setPosts] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(0);
  // Wave 15: hashtag follow state. Hydrated from hashtag_followed_list
  // on screen mount. Optimistic toggle on tap, reverts on API failure.
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);

  const load = useCallback(async (p) => {
    if (loading || !tag) return;
    setLoading(true);
    try {
      const r = await api.feedHashtagPosts(tag, p, 21);
      if (r?.success && r.data) {
        const list = Array.isArray(r.data.posts) ? r.data.posts : [];
        setPosts(prev => p === 1 ? list : [...prev, ...list]);
        setHasMore(!!r.data.has_more);
        setPage(p);
        if (r.data.total_count != null) setCount(r.data.total_count);
      }
    } catch {}
    setLoading(false);
  }, [tag, loading]);

  useEffect(() => { load(1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tag]);

  // Hydrate `following` from the user's followed-tag list. Cheap call,
  // fires once per tag.
  useEffect(() => {
    if (!tag) return;
    let alive = true;
    (async () => {
      try {
        const r = await api.hashtagFollowedList();
        if (!alive) return;
        const tags = (r?.success && r?.data?.tags) ? r.data.tags : [];
        setFollowing(tags.some(row => String(row.tag || '').toLowerCase() === tag.toLowerCase()));
      } catch {}
    })();
    return () => { alive = false; };
  }, [tag]);

  const toggleFollow = useCallback(async () => {
    if (!tag || followBusy) return;
    const wasFollowing = following;
    setFollowing(!wasFollowing);
    setFollowBusy(true);
    try {
      const r = wasFollowing ? await api.hashtagUnfollow(tag) : await api.hashtagFollow(tag);
      if (!r?.success) setFollowing(wasFollowing); // revert on failure
    } catch { setFollowing(wasFollowing); }
    finally { setFollowBusy(false); }
  }, [tag, following, followBusy]);

  const renderItem = useCallback(({ item, index }) => {
    const thumb = item.thumbnail_url || (Array.isArray(item.media_urls) ? item.media_urls[0] : '');
    const marginRight = (index + 1) % COLS === 0 ? 0 : GAP;
    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => { try { router.push(`/feed/${item.id}`); } catch {} }}
        style={{ width: CELL, height: CELL, marginRight, marginBottom: GAP, backgroundColor: '#000' }}
      >
        {thumb ? (
          <Image source={{ uri: resolveUrl(thumb) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        ) : null}
      </TouchableOpacity>
    );
  }, [router]);

  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      <View style={[s.header, { borderBottomColor: colors.borderLight, paddingTop: Platform.OS === 'ios' ? 50 : 20 }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ padding: 6 }}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <IconHash size={20} color={colors.text} />
            <Text style={[s.title, { color: colors.text }]} numberOfLines={1}>{tag}</Text>
          </View>
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
            {(t('feed.hashtagPosts') || 'Posts com #')}{tag} · {count}
          </Text>
        </View>
        {/* Wave 15: hashtag follow / unfollow CTA */}
        <TouchableOpacity
          onPress={toggleFollow}
          disabled={followBusy}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 14,
            borderWidth: 1,
            backgroundColor: following ? 'transparent' : ACCENT,
            borderColor: following ? colors.borderLight : ACCENT,
            opacity: followBusy ? 0.6 : 1,
          }}
          accessibilityRole="button"
          accessibilityLabel={following ? (t('hashtag.following') || 'Seguindo') : (t('hashtag.follow') || 'Seguir')}
        >
          <Text style={{ color: following ? colors.text : '#fff', fontWeight: '700', fontSize: 13 }}>
            {following ? (t('hashtag.following') || 'Seguindo') : (t('hashtag.follow') || 'Seguir')}
          </Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={posts}
        keyExtractor={(it) => String(it.id)}
        numColumns={COLS}
        renderItem={renderItem}
        onEndReachedThreshold={0.5}
        onEndReached={() => { if (hasMore && !loading) load(page + 1); }}
        ListFooterComponent={loading ? <ActivityIndicator color={colors.primary} style={{ paddingVertical: 20 }} /> : null}
        ListEmptyComponent={!loading ? (
          <View style={{ alignItems: 'center', paddingTop: 60 }}>
            <IconHash size={40} color={colors.textTertiary} />
            <Text style={{ color: colors.textSecondary, marginTop: 10 }}>{t('feed.noPosts') || 'Sem posts'}</Text>
          </View>
        ) : null}
        contentContainerStyle={{ paddingTop: 4 }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 18, fontWeight: '700', marginLeft: 4 },
});
