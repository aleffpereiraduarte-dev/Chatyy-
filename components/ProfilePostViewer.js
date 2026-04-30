/**
 * ProfilePostViewer — Instagram-style modal carousel for a user's posts.
 *
 * Opens when user taps a post in the Profile grid. Renders the selected post
 * first, swipe left/right to navigate through the other posts from the same
 * profile (same data we already loaded in profile_get, so no extra fetch).
 *
 * Keeps the user inside the profile flow instead of pushing to /feed/[id]
 * and losing scroll state.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, Image, FlatList,
  Platform, Dimensions, StyleSheet, ActivityIndicator,
} from 'react-native';
import CachedImage from './CachedImage';
import { IconX, IconHeart, IconMessageSquare } from './Icons';
import { BASE_URL } from '../services/api';
import * as api from '../services/api';
import AvatarCircle from './AvatarCircle';
import LikersSheet from './LikersSheet';
import FeedComments from './FeedComments';

// expo-video native player. Carrega lazy pra evitar custo no web.
let _ExpoVideo = null;
function _loadExpoVideo() {
  if (_ExpoVideo !== null) return _ExpoVideo;
  if (Platform.OS === 'web') { _ExpoVideo = false; return false; }
  try { _ExpoVideo = require('expo-video'); return _ExpoVideo; } catch { _ExpoVideo = false; return false; }
}

function NativeVideoPlayer({ uri, style }) {
  const mod = _loadExpoVideo();
  if (!mod || !mod.useVideoPlayer || !mod.VideoView) {
    return <View style={[style, { backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator color="#fff" /></View>;
  }
  const { useVideoPlayer, VideoView } = mod;
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = false;
    try { p.play(); } catch {}
  });
  return (
    <VideoView
      player={player}
      style={style}
      contentFit="contain"
      nativeControls
      allowsFullscreen
    />
  );
}

const WEB = Platform.OS === 'web';
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

function resolveMedia(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${BASE_URL}${url}`;
}

// Full post item: image/video + caption + actions
function PostItem({ post, author, colors, width, onClose, router, t, onOpenLikers, onOpenComments }) {
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(true);

  // Fetch full post details (likes, comments, full caption) — the grid
  // thumbnail only has the preview data.
  useEffect(() => {
    let cancelled = false;
    // Skip feed_get_post when the item is obviously a chat message (shared
    // media path) — these aren't feed posts and the API 404s with "post not
    // found" modal. Heuristic: feed posts have media_urls OR caption; chat
    // media items have file_url and/or `url` + a type like image/video.
    const looksLikeChatMedia = !!(post?.file_url || post?.url) && !post?.media_urls && !post?.caption;
    if (looksLikeChatMedia) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    // Timeout de 8s — antes a chamada podia ficar pendurada e o usuário
    // via spinner pra sempre ("fica carregando, não abre"). Renderizamos
    // com o post original se a API demorar.
    const tFallback = setTimeout(() => { if (!cancelled) setLoading(false); }, 8000);
    (async () => {
      try {
        const r = await api.apiCall('feed_get_post', { id: post.id });
        // O backend devolve {success, data: {post: {...}}} — antes o código
        // lia r.data direto e setFull recebia {post:{...}}, deixando
        // p.media_urls=undefined → viewer ficava em branco eternamente.
        if (!cancelled && r?.success) setFull(r.data?.post || r.data || null);
      } catch {} finally {
        clearTimeout(tFallback);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; clearTimeout(tFallback); };
  }, [post.id]);

  const p = full || post;
  const mediaUrls = Array.isArray(p.media_urls)
    ? p.media_urls
    : (typeof p.media_urls === 'string' ? (() => { try { return JSON.parse(p.media_urls) || []; } catch { return []; } })() : []);
  // Shared-media items from Profile come from chat_messages (file_url), not
  // feed posts (media_urls). Without this fallback the viewer got an empty
  // URL → `<ActivityIndicator>` spinner forever (user's "fica carregando,
  // não abre" report). file_url is also accepted as a string or array.
  // Shared-media items from Profile's profile_get API use `url` (line 2131
  // of email.php), while chat_messages use `file_url`. Feed posts use
  // `media_urls[]`. Try all three so the viewer actually renders instead
  // of spinning forever on an empty URL.
  const _asArr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
  const mediaUrlsFallback = mediaUrls.length
    ? mediaUrls
    : (p.file_url ? _asArr(p.file_url) : (p.url ? _asArr(p.url) : []));
  const firstMedia = mediaUrlsFallback[0] || p.thumbnail || '';
  const url = resolveMedia(firstMedia);
  const isVideo = p.type === 'video' || p.media_type === 'video'
    || (typeof url === 'string' && /\.(mp4|mov|webm|mkv|avi|m4v|3gp)(\?|$)/i.test(url));

  return (
    <View style={{ width, flex: 1, backgroundColor: '#000' }}>
      {/* Media pane */}
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        {url ? (
          WEB ? (
            isVideo
              ? <video src={url} controls autoPlay playsInline style={{ width: '100%', maxHeight: '70vh', objectFit: 'contain' }} />
              : <img src={url} style={{ width: '100%', maxHeight: '70vh', objectFit: 'contain' }} alt="" />
          ) : isVideo ? (
            // Native: usa expo-video pra reels/vídeos. Antes caía em
            // CachedImage que só renderiza estático → vídeo "não abria".
            <NativeVideoPlayer uri={url} style={{ width: '100%', height: '70%' }} />
          ) : (
            <CachedImage source={{ uri: url }} style={{ width: '100%', height: '70%' }} resizeMode="contain" />
          )
        ) : (
          <ActivityIndicator color="#fff" />
        )}
      </View>

      {/* Caption + actions */}
      <View style={{ paddingHorizontal: 14, paddingBottom: 30, paddingTop: 10, gap: 8, backgroundColor: 'rgba(0,0,0,0.85)' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <AvatarCircle name={author?.name} email={author?.email} size={32} />
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600', flex: 1 }} numberOfLines={1}>
            {author?.name || author?.email}
          </Text>
          {p.id ? (
            <TouchableOpacity
              onPress={() => { onClose?.(); router?.push(`/feed/${p.id}`); }}
              style={{ paddingHorizontal: 10, paddingVertical: 5, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 12 }}
            >
              <Text style={{ color: '#fff', fontSize: 12 }}>{t?.('profile.viewFull') || 'Ver completo'}</Text>
            </TouchableOpacity>
          ) : p.conversation_id ? (
            <TouchableOpacity
              onPress={() => { onClose?.(); router?.push(`/chat-conversation?id=${p.conversation_id}`); }}
              style={{ paddingHorizontal: 10, paddingVertical: 5, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 12 }}
            >
              <Text style={{ color: '#fff', fontSize: 12 }}>{t?.('profile.openChat') || 'Abrir conversa'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {!!p.caption && (
          <Text style={{ color: '#fff', fontSize: 13.5, lineHeight: 18 }} numberOfLines={3}>
            {p.caption}
          </Text>
        )}
        <View style={{ flexDirection: 'row', gap: 20, paddingTop: 4 }}>
          <TouchableOpacity
            onPress={() => onOpenLikers?.(p)}
            activeOpacity={0.7}
            hitSlop={6}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
          >
            <IconHeart size={18} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12 }}>{p.likes_count ?? 0}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onOpenComments?.(p)}
            activeOpacity={0.7}
            hitSlop={6}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
          >
            <IconMessageSquare size={18} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12 }}>{p.comments_count ?? 0}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

export default function ProfilePostViewer({
  visible, posts = [], startIndex = 0, author, onClose, colors, isDark, t, router, user,
}) {
  const [index, setIndex] = useState(startIndex);
  const listRef = useRef(null);
  const [likersPost, setLikersPost] = useState(null);
  const [commentsPost, setCommentsPost] = useState(null);

  useEffect(() => {
    setIndex(startIndex);
    if (visible && listRef.current) {
      // scrollToIndex is racy right after mount; delay one tick
      const h = setTimeout(() => {
        try { listRef.current?.scrollToIndex({ index: startIndex, animated: false }); } catch {}
      }, 50);
      return () => clearTimeout(h);
    }
  }, [visible, startIndex]);

  const onViewable = useCallback(({ viewableItems }) => {
    if (viewableItems?.length) setIndex(viewableItems[0].index ?? 0);
  }, []);

  if (!visible || posts.length === 0) return null;

  return (
    <Modal visible={!!visible} transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Top bar */}
        <View style={{
          position: 'absolute', top: Platform.OS === 'ios' ? 54 : 20, left: 0, right: 0, zIndex: 10,
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          paddingHorizontal: 14,
        }}>
          <TouchableOpacity onPress={onClose} style={{ padding: 8 }} accessibilityLabel="Close">
            <IconX size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
            {index + 1} / {posts.length}
          </Text>
          <View style={{ width: 40 }} />
        </View>

        <FlatList
          ref={listRef}
          data={posts}
          keyExtractor={(it) => String(it.id)}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={startIndex}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          getItemLayout={(_, i) => ({ length: SCREEN_W, offset: SCREEN_W * i, index: i })}
          renderItem={({ item }) => (
            <PostItem
              post={item}
              author={author}
              colors={colors}
              width={SCREEN_W}
              onClose={onClose}
              router={router}
              t={t}
              onOpenLikers={(p) => setLikersPost(p)}
              onOpenComments={(p) => setCommentsPost(p)}
            />
          )}
        />

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

        <FeedComments
          visible={!!commentsPost}
          post={commentsPost}
          colors={colors}
          isDark={isDark}
          t={t}
          user={user}
          onClose={() => setCommentsPost(null)}
        />
      </View>
    </Modal>
  );
}
