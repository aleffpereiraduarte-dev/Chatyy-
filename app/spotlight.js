// Spotlight — TikTok/Snap-style vertical public video feed
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, FlatList, Dimensions, TouchableOpacity, StyleSheet,
  Platform, Image, Pressable,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import CreatePostModal from '../components/CreatePostModal';
import UnifiedComposeFab from '../components/UnifiedComposeFab';
import LikersSheet from '../components/LikersSheet';
import FeedComments from '../components/FeedComments';

function resolveMediaUrl(u) {
  if (!u) return '';
  if (u.startsWith('http')) return u;
  // /data/ assets live on R2 and are only served via the CDN host — the
  // origin (chatyy.com.br) 404s for them. Route relative media paths to the
  // CDN so a path that escaped backend CDN-ification still resolves.
  if (u.startsWith('/data/')) return 'https://media.chatyy.com.br' + u;
  return BASE_URL + (u.startsWith('/') ? '' : '/') + u;
}
import {
  IconArrowLeft, IconHeart, IconHeartOutline, IconMessageCircle,
  IconShare, IconBookmark, IconBookmarkFilled, IconPlus, IconPlay,
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

function SpotlightItem({ post, active, onLike, onBookmark, onOpenComments, onOpenLikers, router }) {
  // Source preference: the raw MP4 (media_urls[0]) is always present and lives
  // on the CDN, so it's the reliable default. We only use video_hls_url when
  // the backend actually emits one — it now nulls it out when the .m3u8 doesn't
  // exist on disk (the /data/videos/ HLS pipeline never ran for most posts, so
  // the old relative path 404'd on both origin AND cdn → poster stuck =
  // "blurred content"). On web, plain MP4 also plays more reliably than HLS in
  // a bare <video> tag without hls.js. Belt-and-suspenders: even if a stale
  // relative HLS path slips through, we fall back to the MP4.
  const mp4Url = Array.isArray(post.media_urls) ? (post.media_urls[0] || '') : '';
  const hlsUrl = post.video_hls_url || '';
  const rawUrl = (Platform.OS === 'web' ? (mp4Url || hlsUrl) : (hlsUrl || mp4Url));
  const videoUrl = resolveMediaUrl(rawUrl);
  const poster = post.thumbnail_url ? resolveMediaUrl(post.thumbnail_url) : null;

  return (
    <View style={{ width: SW, height: SH, backgroundColor: '#000' }}>
      <VideoPane uri={videoUrl} poster={poster} active={active} />

      {/* Gradient overlay — slightly deeper at the bottom so the author +
          caption + action column stay legible over bright footage. */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, {
          ...(Platform.OS === 'web'
            ? { background: 'linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.12) 34%, rgba(0,0,0,0) 62%, rgba(0,0,0,0.45) 100%)' }
            : {}),
        }]}
      />
      {/* Native fallback: solid translucent scrim pinned to the bottom third
          (RN can't render a CSS gradient string). Keeps text readable. */}
      {Platform.OS !== 'web' && (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: SH * 0.34, backgroundColor: 'rgba(0,0,0,0.30)' }}
        />
      )}

      {/* Right-side action column — heart icon toggles like, count below it
          opens the likers list (Instagram/TikTok convention). Comment icon
          + count both open the comments sheet. Each icon wears a soft drop
          shadow so it reads over any frame. */}
      <View style={{ position: 'absolute', right: 12, bottom: 132, alignItems: 'center', gap: 24 }}>
        <View style={{ alignItems: 'center' }}>
          <Pressable onPress={() => onLike(post)} hitSlop={10} style={SPOT_ICON_SHADOW}>
            {post.liked_by_me
              ? <IconHeart size={34} color="#FF3366" />
              : <IconHeartOutline size={34} color="#fff" />}
          </Pressable>
          <Pressable onPress={() => onOpenLikers(post)} hitSlop={8}>
            <Text style={SPOT_COUNT}>{post.likes_count || 0}</Text>
          </Pressable>
        </View>
        <Pressable onPress={() => onOpenComments(post)} style={{ alignItems: 'center' }}>
          <View style={SPOT_ICON_SHADOW}><IconMessageCircle size={32} color="#fff" /></View>
          <Text style={SPOT_COUNT}>{post.comments_count || 0}</Text>
        </Pressable>
        <Pressable onPress={() => onBookmark(post)} style={[{ alignItems: 'center' }, SPOT_ICON_SHADOW]}>
          {post.bookmarked_by_me
            ? <IconBookmarkFilled size={30} color="#F59E0B" />
            : <IconBookmark size={30} color="#fff" />}
        </Pressable>
      </View>

      {/* Bottom metadata */}
      <View style={{ position: 'absolute', left: 16, right: 84, bottom: 84 }}>
        <Pressable
          onPress={() => router.push(`/u/${encodeURIComponent(post.author_email)}`)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10 }}
        >
          <View style={{ borderWidth: 1.5, borderColor: '#fff', borderRadius: 19, padding: 1 }}>
            <AvatarCircle name={post.author_name || post.author_email} email={post.author_email} size={34} />
          </View>
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: -0.2, ...SPOT_TEXT_SHADOW }}>
            @{(post.author_email || '').split('@')[0]}
          </Text>
        </Pressable>
        {!!post.caption && (
          <Text style={{ color: '#fff', fontSize: 14, lineHeight: 20, ...SPOT_TEXT_SHADOW }} numberOfLines={3}>
            {post.caption}
          </Text>
        )}
      </View>
    </View>
  );
}

// Shared text/icon shadows so overlay content stays legible over any frame.
const SPOT_TEXT_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.6)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 4,
};
const SPOT_ICON_SHADOW = Platform.OS === 'web'
  ? {}
  : { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.45, shadowRadius: 4 };
const SPOT_COUNT = {
  color: '#fff',
  fontSize: 11.5,
  fontWeight: '700',
  marginTop: 4,
  textShadowColor: 'rgba(0,0,0,0.7)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3,
};

export default function SpotlightScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [activeIdx, setActiveIdx] = useState(0);
  const [createVisible, setCreateVisible] = useState(() => params?.createPost === '1');
  const [likersPost, setLikersPost] = useState(null);
  const [commentsPost, setCommentsPost] = useState(null);

  // If routed here via UnifiedComposeFab with ?createPost=1, auto-open the composer.
  useEffect(() => {
    if (params?.createPost === '1') {
      setCreateVisible(true);
    }
  }, [params?.createPost]);

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

  // Record a view for the currently-active reel, once per id per session.
  // Spotlight never called feedView so view_count was dead for the
  // TikTok-style feed. Bug-hunt P3 (2026-05-30).
  const viewedRef = useRef(new Set());
  useEffect(() => {
    const p = posts[activeIdx];
    if (!p?.id) return;
    if (viewedRef.current.has(p.id)) return;
    viewedRef.current.add(p.id);
    try { api.feedView?.(p.id)?.catch?.(() => {}); } catch {}
  }, [activeIdx, posts]);

  const handleLike = useCallback(async (post) => {
    const wasLiked = !!post.liked_by_me;
    // optimistic
    setPosts(prev => prev.map(p => p.id === post.id ? {
      ...p,
      liked_by_me: !p.liked_by_me,
      likes_count: Math.max(0, (p.likes_count || 0) + (p.liked_by_me ? -1 : 1)),
    } : p));
    try {
      const r = await api.feedLike?.(post.id);
      // Reconcile with the authoritative server count/state instead of
      // discarding it — prevents permanently-wrong/double counts on
      // divergence. Bug-hunt P3 (2026-05-30).
      const d = r?.data || r;
      if (d && (d.likes_count != null || d.liked_by_me != null)) {
        setPosts(prev => prev.map(p => p.id === post.id ? {
          ...p,
          ...(d.liked_by_me != null ? { liked_by_me: !!d.liked_by_me } : {}),
          ...(d.likes_count != null ? { likes_count: Number(d.likes_count) || 0 } : {}),
        } : p));
      } else if (r && r.success === false) {
        throw new Error('like failed');
      }
    } catch {
      // roll back the optimistic toggle
      setPosts(prev => prev.map(p => p.id === post.id ? {
        ...p,
        liked_by_me: wasLiked,
        likes_count: Math.max(0, (p.likes_count || 0) + (wasLiked ? 1 : -1)),
      } : p));
    }
  }, []);

  const handleBookmark = useCallback(async (post) => {
    setPosts(prev => prev.map(p => p.id === post.id ? { ...p, bookmarked_by_me: !p.bookmarked_by_me } : p));
    try { await api.feedBookmark?.(post.id); } catch {}
  }, []);

  const handleOpenComments = useCallback((post) => {
    setCommentsPost(post);
  }, []);

  const handleOpenLikers = useCallback((post) => {
    if (!post?.id) return;
    setLikersPost(post);
  }, []);

  const handleCommentCountChange = useCallback((postId, delta) => {
    setPosts(prev => prev.map(p => p.id === postId
      ? { ...p, comments_count: Math.max(0, (p.comments_count || 0) + delta) }
      : p));
  }, []);

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
            onOpenLikers={handleOpenLikers}
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
            <View style={{ width: SW, height: SH, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40, gap: 14 }}>
              <View style={{ width: 76, height: 76, borderRadius: 38, borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                <IconPlay size={34} color="rgba(255,255,255,0.7)" />
              </View>
              <Text style={{ color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: -0.2, textAlign: 'center' }}>
                {t?.('spotlight.empty') || 'Nenhum vídeo no momento'}
              </Text>
              <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13.5, textAlign: 'center', lineHeight: 19 }}>
                {t?.('spotlight.emptyHint') || t?.('feed.noReelsHint') || 'Vídeos aparecerão aqui'}
              </Text>
            </View>
          ) : null
        }
      />

      {/* Header — just back button + title, no "+" (UnifiedComposeFab
          at bottom-right handles creation now). Stops the user seeing
          two plus buttons at once. */}
      <View style={{ position: 'absolute', top: (insets.top || (Platform.OS === 'ios' ? 50 : 16)) + 4, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 }}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
          <IconArrowLeft size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={{ flex: 1, textAlign: 'center', color: '#fff', fontSize: 18, fontWeight: '800', letterSpacing: 0.2, textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 }}>
          {t?.('spotlight.title') || 'Spotlight'}
        </Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Unified compose FAB (replaces old TikTok-style create FAB) */}
      <UnifiedComposeFab
        router={router}
        colors={colors}
        isDark={isDark}
        t={t}
        userEmail={user?.email}
        bottom={insets.bottom + 20}
        right={14}
      />

      <CreatePostModal
        visible={createVisible}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setCreateVisible(false)}
        onPostCreated={() => { setCreateVisible(false); load(1); setPage(1); }}
        initialFiles={(params?._shared_uri ? [{
          uri: String(params._shared_uri),
          file: { uri: String(params._shared_uri), name: String(params._shared_name || 'shared'), type: String(params._shared_type || 'image') === 'video' ? 'video/mp4' : 'image/jpeg' },
          type: String(params._shared_type || 'image'),
          id: 'shared_' + Date.now(),
          name: String(params._shared_name || ''),
        }] : null)}
      />

      {/* Likers — tapping the like count in the action column opens this */}
      <LikersSheet
        visible={!!likersPost}
        postId={likersPost?.id}
        totalCount={likersPost?.likes_count}
        colors={colors}
        isDark={isDark}
        t={t}
        router={router}
        onClose={() => setLikersPost(null)}
      />

      {/* Comments — inline sheet instead of routing to /feed-comments
          which doesn't exist as a screen. Also bumps the local
          comments_count so the badge stays in sync on close. */}
      <FeedComments
        visible={!!commentsPost}
        post={commentsPost}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setCommentsPost(null)}
        onCommentCountChange={(delta) => commentsPost && handleCommentCountChange(commentsPost.id, delta)}
      />
    </View>
  );
}
