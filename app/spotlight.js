// Spotlight — TikTok/Snap-style vertical public video feed
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, FlatList, Dimensions, TouchableOpacity, StyleSheet,
  Platform, Image, Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconArrowLeft, IconHeart, IconHeartOutline, IconMessageCircle,
  IconShare, IconBookmark, IconBookmarkFilled,
} from '../components/Icons';

const { width: SW, height: SH } = Dimensions.get('window');

function VideoPane({ uri, poster, active }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (Platform.OS === 'web' && videoRef.current) {
      if (active) {
        videoRef.current.play?.().catch(() => {});
      } else {
        videoRef.current.pause?.();
        videoRef.current.currentTime = 0;
      }
    }
  }, [active]);

  if (Platform.OS === 'web') {
    return (
      <video
        ref={videoRef}
        src={uri}
        poster={poster || undefined}
        muted={false}
        loop
        playsInline
        style={{ width: SW, height: SH, objectFit: 'cover', backgroundColor: '#000' }}
      />
    );
  }
  // Native: use expo-av if available (lazy)
  let Video = null;
  try { Video = require('expo-av').Video; } catch {}
  if (!Video) {
    return <Image source={{ uri: poster || uri }} style={{ width: SW, height: SH }} resizeMode="cover" />;
  }
  return (
    <Video
      source={{ uri }}
      rate={1.0}
      volume={1.0}
      isMuted={false}
      resizeMode="cover"
      shouldPlay={active}
      isLooping
      style={{ width: SW, height: SH, backgroundColor: '#000' }}
    />
  );
}

function SpotlightItem({ post, active, onLike, onBookmark, onOpenComments, router }) {
  const videoUrl = post.video_hls_url || (Array.isArray(post.media_urls) ? post.media_urls[0] : '');
  const poster = post.thumbnail_url;

  return (
    <View style={{ width: SW, height: SH, backgroundColor: '#000' }}>
      <VideoPane uri={videoUrl} poster={poster} active={active} />

      {/* Gradient overlay */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, {
          ...(Platform.OS === 'web'
            ? { background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 40%, rgba(0,0,0,0) 70%, rgba(0,0,0,0.4) 100%)' }
            : {}),
        }]}
      />

      {/* Right-side action column */}
      <View style={{ position: 'absolute', right: 10, bottom: 120, alignItems: 'center', gap: 20 }}>
        <Pressable onPress={() => onLike(post)} style={{ alignItems: 'center' }}>
          {post.liked_by_me
            ? <IconHeart size={34} color="#FF3366" />
            : <IconHeartOutline size={34} color="#fff" />}
          <Text style={{ color: '#fff', fontSize: 11, fontWeight: '600', marginTop: 2 }}>{post.likes_count || 0}</Text>
        </Pressable>
        <Pressable onPress={() => onOpenComments(post)} style={{ alignItems: 'center' }}>
          <IconMessageCircle size={32} color="#fff" />
          <Text style={{ color: '#fff', fontSize: 11, fontWeight: '600', marginTop: 2 }}>{post.comments_count || 0}</Text>
        </Pressable>
        <Pressable onPress={() => onBookmark(post)} style={{ alignItems: 'center' }}>
          {post.bookmarked_by_me
            ? <IconBookmarkFilled size={30} color="#F59E0B" />
            : <IconBookmark size={30} color="#fff" />}
        </Pressable>
      </View>

      {/* Bottom metadata */}
      <View style={{ position: 'absolute', left: 16, right: 80, bottom: 80 }}>
        <Pressable
          onPress={() => router.push(`/profile-view?email=${encodeURIComponent(post.author_email)}`)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}
        >
          <AvatarCircle name={post.author_name || post.author_email} email={post.author_email} size={36} />
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
            @{(post.author_email || '').split('@')[0]}
          </Text>
        </Pressable>
        {!!post.caption && (
          <Text style={{ color: '#fff', fontSize: 14, lineHeight: 20 }} numberOfLines={3}>
            {post.caption}
          </Text>
        )}
      </View>
    </View>
  );
}

export default function SpotlightScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [activeIdx, setActiveIdx] = useState(0);

  const load = useCallback(async (p = 1) => {
    try {
      const r = await api.spotlightList(p, 10);
      if (r?.success) {
        const newPosts = r.data?.posts || [];
        setPosts(prev => p === 1 ? newPosts : [...prev, ...newPosts]);
        setHasMore(!!r.data?.has_more);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(1); }, [load]);

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) {
      setActiveIdx(viewableItems[0].index || 0);
    }
  }).current;

  const viewConfig = useRef({ itemVisiblePercentThreshold: 75 }).current;

  const handleLike = useCallback(async (post) => {
    setPosts(prev => prev.map(p => p.id === post.id ? {
      ...p,
      liked_by_me: !p.liked_by_me,
      likes_count: (p.likes_count || 0) + (p.liked_by_me ? -1 : 1),
    } : p));
    try { await api.feedLike?.(post.id); } catch {}
  }, []);

  const handleBookmark = useCallback(async (post) => {
    setPosts(prev => prev.map(p => p.id === post.id ? { ...p, bookmarked_by_me: !p.bookmarked_by_me } : p));
    try { await api.feedBookmark?.(post.id); } catch {}
  }, []);

  const handleOpenComments = useCallback((post) => {
    router.push(`/feed-comments?post_id=${post.id}`);
  }, [router]);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <FlatList
        data={posts}
        keyExtractor={(item, i) => String(item.id || i)}
        renderItem={({ item, index }) => (
          <SpotlightItem
            post={item}
            active={index === activeIdx}
            onLike={handleLike}
            onBookmark={handleBookmark}
            onOpenComments={handleOpenComments}
            router={router}
          />
        )}
        pagingEnabled
        snapToInterval={SH}
        snapToAlignment="start"
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewConfig}
        onEndReached={() => { if (hasMore && !loading) { const next = page + 1; setPage(next); load(next); } }}
        onEndReachedThreshold={0.6}
        windowSize={3}
        maxToRenderPerBatch={2}
        initialNumToRender={1}
        removeClippedSubviews
        ListEmptyComponent={
          !loading ? (
            <View style={{ width: SW, height: SH, justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 16 }}>
                {t?.('spotlight.empty') || 'Nenhum vídeo no momento'}
              </Text>
            </View>
          ) : null
        }
      />

      {/* Header */}
      <View style={{ position: 'absolute', top: Platform.OS === 'ios' ? 50 : 16, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 }}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
          <IconArrowLeft size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={{ flex: 1, textAlign: 'center', color: '#fff', fontSize: 17, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 }}>
          {t?.('spotlight.title') || 'Spotlight'}
        </Text>
        <View style={{ width: 40 }} />
      </View>
    </View>
  );
}
