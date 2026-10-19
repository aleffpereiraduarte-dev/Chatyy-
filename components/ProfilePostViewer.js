/**
 * ProfilePostViewer — Instagram-style modal carousel for a user's posts.
 *
 * Opens when user taps a post in the Profile grid. Renders the selected post
 * first, swipe left/right to navigate through the other posts from the same
 * profile (same data we already loaded in profile_get, so no extra fetch).
 *
 * Keeps the user inside the profile flow instead of pushing to /feed/[id]
 * and losing scroll state.
 *
 * [perfil-publicar 2026-10-19] posts na vertical (deslizar p/ cima/baixo) e
 * carrossel horizontal com TODAS as mídias do post (pontos + 1/N); dono: menu
 * "..." (folha nativa) com Editar legenda (painel inline, sem Modal sobre Modal)
 * e Excluir publicação. Só o vídeo visível toca.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, Image, FlatList,
  Platform, Dimensions, StyleSheet, ActivityIndicator, Alert,
  TextInput, KeyboardAvoidingView, useWindowDimensions,
} from 'react-native';
import CachedImage from './CachedImage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX, IconHeart, IconMessageSquare, IconPlay, IconMoreHorizontal } from './Icons';
import { BASE_URL } from '../services/api';
import * as api from '../services/api';
import AvatarCircle from './AvatarCircle';
import LikersSheet from './LikersSheet';
import FeedComments from './FeedComments';
import { cachedVideoSource } from '../services/videoCacheSource'; // [2026-10-10 native-audit] native video disk cache

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
  const player = useVideoPlayer(cachedVideoSource(uri), (p) => {
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
  return api.getMediaUrl(url);
}

const VIDEO_RE = /\.(mp4|mov|webm|mkv|avi|m4v|3gp)(\?|$)/i;

// [perfil-publicar 2026-10-19] Carrossel do post (até 10 fotos/vídeos, misturados):
// deslizar entre os itens + pontos + contador. Só o item ATIVO do post ATIVO monta
// player de vídeo (antes todos os vídeos da lista tocavam com som ao mesmo tempo).
function MediaCarousel({ urls, postIsVideo, width, height, active }) {
  const [idx, setIdx] = useState(0);
  const onEnd = useCallback((e) => {
    const w = e.nativeEvent.layoutMeasurement.width || width || 1;
    setIdx(Math.max(0, Math.round(e.nativeEvent.contentOffset.x / w)));
  }, [width]);
  const isVid = (u, i) => VIDEO_RE.test(u) || (postIsVideo && i === 0 && !/\.(jpe?g|png|webp|gif|heic)(\?|$)/i.test(u));
  const renderOne = (u, i) => {
    const url = resolveMedia(u);
    if (!url) return <ActivityIndicator color="#fff" />;
    if (WEB) {
      return isVid(u, i)
        ? <video src={url} controls autoPlay={active && i === idx} playsInline style={{ width: '100%', maxHeight: '70vh', objectFit: 'contain' }} />
        : <img src={url} style={{ width: '100%', maxHeight: '70vh', objectFit: 'contain' }} alt="" />;
    }
    if (isVid(u, i)) {
      return active && i === idx
        ? <NativeVideoPlayer uri={url} style={{ width: '100%', height: '100%' }} />
        : <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}><IconPlay size={40} color="#fff" /></View>;
    }
    return <CachedImage source={{ uri: url }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />;
  };
  if (!urls.length) return <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color="#fff" /></View>;
  if (urls.length === 1) return <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>{renderOne(urls[0], 0)}</View>;
  return (
    <View style={{ width, height }}>
      <FlatList
        data={urls}
        horizontal
        pagingEnabled
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(u, i) => `${i}:${u}`}
        onMomentumScrollEnd={onEnd}
        extraData={`${idx}|${active}`}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        renderItem={({ item, index }) => (
          <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>{renderOne(item, index)}</View>
        )}
      />
      <View pointerEvents="none" style={{ position: 'absolute', top: 12, right: 12, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 11, paddingHorizontal: 9, paddingVertical: 3 }}>
        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{`${idx + 1}/${urls.length}`}</Text>
      </View>
      <View pointerEvents="none" style={{ position: 'absolute', bottom: 10, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 5 }}>
        {urls.map((_, i) => (
          <View key={i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: i === idx ? '#fff' : 'rgba(255,255,255,0.4)' }} />
        ))}
      </View>
    </View>
  );
}

// Full post item: carrossel + legenda + ações
function PostItem({ post, author, width, height, active, onClose, router, t, onOpenLikers, onOpenComments, captionOverride, bottomInset }) {
  const [full, setFull] = useState(null);

  // Fetch full post details (likes, comments, full caption, TODAS as mídias) — a
  // grade só tem a prévia.
  useEffect(() => {
    let cancelled = false;
    // Skip feed_get_post when the item is obviously a chat message (shared
    // media path) — these aren't feed posts and the API 404s.
    const looksLikeChatMedia = !!(post?.file_url || post?.url) && !post?.media_urls && !post?.caption;
    if (looksLikeChatMedia || !post?.id) return () => { cancelled = true; };
    (async () => {
      try {
        const r = await api.apiCall('feed_get_post', { id: post.id });
        // {success, data: {post: {...}}}
        if (!cancelled && r?.success) setFull(r.data?.post || r.data || null);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [post.id]);

  const p = full || post;
  const mediaUrls = Array.isArray(p.media_urls)
    ? p.media_urls
    : (typeof p.media_urls === 'string' ? (() => { try { return JSON.parse(p.media_urls) || []; } catch { return []; } })() : []);
  // Shared-media (chat) usa file_url/url; posts usam media_urls[].
  const _asArr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
  const urls = (mediaUrls.length
    ? mediaUrls
    : (p.file_url ? _asArr(p.file_url) : (p.url ? _asArr(p.url) : (p.thumbnail ? [p.thumbnail] : [])))).filter(Boolean);
  const postIsVideo = p.type === 'video' || p.media_type === 'video';
  const caption = captionOverride != null ? captionOverride : p.caption;
  const mediaH = Math.max(200, height - 190 - (bottomInset || 0));

  return (
    <View style={{ width, height, backgroundColor: '#000' }}>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <MediaCarousel urls={urls} postIsVideo={postIsVideo} width={width} height={mediaH} active={active} />
      </View>

      <View style={{ paddingHorizontal: 14, paddingBottom: 18 + (bottomInset || 0), paddingTop: 10, gap: 8, backgroundColor: 'rgba(0,0,0,0.85)' }}>
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
              onPress={() => { onClose?.(); require('../services/openConversation').openConversation(`/chat-conversation?id=${p.conversation_id}`); }}
              style={{ paddingHorizontal: 10, paddingVertical: 5, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 12 }}
            >
              <Text style={{ color: '#fff', fontSize: 12 }}>{t?.('profile.openChat') || 'Abrir conversa'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {!!caption && (
          <Text style={{ color: '#fff', fontSize: 13.5, lineHeight: 18 }} numberOfLines={4}>
            {caption}
          </Text>
        )}
        {!!p.id && (
          <View style={{ flexDirection: 'row', gap: 20, paddingTop: 4 }}>
            <TouchableOpacity onPress={() => onOpenLikers?.(p)} activeOpacity={0.7} hitSlop={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <IconHeart size={18} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 12 }}>{p.likes_count ?? 0}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onOpenComments?.(p)} activeOpacity={0.7} hitSlop={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <IconMessageSquare size={18} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 12 }}>{p.comments_count ?? 0}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

export default function ProfilePostViewer({
  visible, posts = [], startIndex = 0, author, onClose, colors, isDark, t, router, user, onDeleted,
}) {
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const W = winW || SCREEN_W;
  const H = winH || SCREEN_H;
  const topBarOffset = Math.max(insets.top, Platform.OS === 'android' ? 12 : 44) + 10;
  const [index, setIndex] = useState(startIndex);
  const listRef = useRef(null);
  const [likersPost, setLikersPost] = useState(null);
  const [commentsPost, setCommentsPost] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // [perfil-publicar 2026-10-19] editar legenda inline (sem Modal sobre Modal)
  const [editing, setEditing] = useState(null); // { id, draft }
  const [savingCaption, setSavingCaption] = useState(false);
  const [captions, setCaptions] = useState({}); // id → legenda editada nesta sessão

  // Dono = e-mail do viewer igual ao do autor do perfil.
  const isOwner = !!(
    user?.email && author?.email &&
    String(user.email).trim().toLowerCase() === String(author.email).trim().toLowerCase()
  );

  const PC = () => require('../services/profilePostComposer');

  const handleDelete = useCallback(async () => {
    const post = posts[index];
    if (!post || deleting || !post.id) return;
    setDeleting(true);
    let ok = false;
    try { ok = await PC().confirmDeletePost(post.id); } catch { ok = false; }
    setDeleting(false);
    if (ok) { onDeleted?.(post.id); onClose?.(); }
  }, [posts, index, deleting, onDeleted, onClose]);

  const startEdit = useCallback(() => {
    const post = posts[index];
    if (!post?.id) return;
    const cur = captions[post.id] != null ? captions[post.id] : (post.caption || '');
    setEditing({ id: post.id, draft: String(cur) });
  }, [posts, index, captions]);

  const saveCaption = useCallback(async () => {
    if (!editing || savingCaption) return;
    setSavingCaption(true);
    const r = await PC().editPostCaption(editing.id, editing.draft);
    setSavingCaption(false);
    if (r && r.success) {
      const c = r.data?.post?.caption ?? editing.draft;
      setCaptions((m) => ({ ...m, [editing.id]: c }));
      setEditing(null);
    } else {
      Alert.alert(PC().pcT('saveFailed'), (r && (r.message || r.error)) || '');
    }
  }, [editing, savingCaption]);

  const openOwnerMenu = useCallback(() => {
    const m = PC();
    m.showActionMenu({
      options: [
        { label: m.pcT('editCaption'), onPress: startEdit },
        { label: m.pcT('deletePost'), destructive: true, onPress: () => { setTimeout(handleDelete, Platform.OS === 'ios' ? 350 : 0); } },
      ],
    });
  }, [startEdit, handleDelete]);

  useEffect(() => {
    setIndex(startIndex);
    setEditing(null);
    if (visible && listRef.current) {
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

  const cur = posts[index];
  return (
    <Modal visible={!!visible} transparent={false} animationType="fade" onRequestClose={() => { if (editing) setEditing(null); else onClose?.(); }}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Top bar */}
        <View style={{
          position: 'absolute', top: topBarOffset, left: 0, right: 0, zIndex: 10,
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          paddingHorizontal: 14,
        }}>
          <TouchableOpacity onPress={onClose} style={{ padding: 8 }} accessibilityLabel={t ? t('common.close') : 'Fechar'}>
            <IconX size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
            {index + 1} / {posts.length}
          </Text>
          {isOwner && cur?.id ? (
            <TouchableOpacity
              onPress={openOwnerMenu}
              disabled={deleting}
              style={{ padding: 8, opacity: deleting ? 0.5 : 1 }}
              accessibilityLabel={PC().pcT('more')}
            >
              {deleting ? <ActivityIndicator size="small" color="#fff" /> : <IconMoreHorizontal size={24} color="#fff" />}
            </TouchableOpacity>
          ) : (
            <View style={{ width: 40 }} />
          )}
        </View>

        {/* Posts na VERTICAL (deslizar p/ cima/baixo); itens do post na horizontal. */}
        <FlatList
          ref={listRef}
          data={posts}
          keyExtractor={(it, i) => String(it.id ?? `i${i}`)}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          initialScrollIndex={startIndex}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          getItemLayout={(_, i) => ({ length: H, offset: H * i, index: i })}
          windowSize={3}
          initialNumToRender={2}
          maxToRenderPerBatch={2}
          extraData={`${index}|${JSON.stringify(captions)}`}
          scrollEnabled={!editing}
          renderItem={({ item, index: i }) => (
            <PostItem
              post={item}
              author={author}
              width={W}
              height={H}
              active={i === index}
              onClose={onClose}
              router={router}
              t={t}
              bottomInset={insets.bottom}
              captionOverride={item?.id != null && captions[item.id] != null ? captions[item.id] : null}
              onOpenLikers={(p) => setLikersPost(p)}
              onOpenComments={(p) => setCommentsPost(p)}
            />
          )}
        />

        {editing && (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={[StyleSheet.absoluteFill, { justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)', zIndex: 20 }]}
          >
            <View style={{ backgroundColor: isDark ? '#1c1c1e' : '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, paddingBottom: 16 + insets.bottom, gap: 12 }}>
              <Text style={{ color: isDark ? '#fff' : '#111', fontSize: 16, fontWeight: '700' }}>{PC().pcT('editCaption')}</Text>
              <TextInput
                value={editing.draft}
                onChangeText={(v) => setEditing((e) => (e ? { ...e, draft: v.slice(0, 2200) } : e))}
                multiline
                autoFocus
                placeholder={PC().pcT('captionPh')}
                placeholderTextColor={isDark ? '#8e8e93' : '#8e8e93'}
                style={{ minHeight: 80, maxHeight: 200, color: isDark ? '#fff' : '#111', fontSize: 15, textAlignVertical: 'top', padding: 12, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#F2F2F7' }}
              />
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
                <TouchableOpacity onPress={() => setEditing(null)} disabled={savingCaption} style={{ paddingHorizontal: 16, height: 38, borderRadius: 19, justifyContent: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#F1F3F5' }}>
                  <Text style={{ color: isDark ? '#fff' : '#111', fontWeight: '600' }}>{PC().pcT('cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={saveCaption} disabled={savingCaption} style={{ paddingHorizontal: 18, height: 38, borderRadius: 19, justifyContent: 'center', backgroundColor: isDark ? '#fff' : '#111', minWidth: 90, alignItems: 'center' }}>
                  {savingCaption ? <ActivityIndicator size="small" color={isDark ? '#000' : '#fff'} /> : <Text style={{ color: isDark ? '#000' : '#fff', fontWeight: '700' }}>{PC().pcT('save')}</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        )}

        <LikersSheet
          visible={!!likersPost}
          postId={likersPost?.id}
          totalCount={likersPost?.likes_count}
          colors={colors}
          isDark={isDark}
          t={t}
          router={router}
          onClose={() => setLikersPost(null)}
          native={false} /* [2026-10-09 native-sheets] dono é <Modal> RN */
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
