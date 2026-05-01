import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Dimensions, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconHash } from '../components/Icons';
import * as api from '../services/api';

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
        <View style={{ width: 30 }} />
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
