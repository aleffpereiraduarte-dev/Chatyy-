// [mural 2026-10-20] Tela 2 do mockup: post de FOTO aberto.
// Fundo preto; topo com autor, data, público e "…"; carrossel paginado com
// pontos e "1/3"; toque duplo curte com coração grande (Reanimated); pinça para
// ampliar (volta sozinha ao soltar, como no Instagram); curtir/comentar/
// compartilhar/salvar; "Curtido por X e outras N"; legenda; "Ver os N
// comentários"; 1 comentário em destaque; visualizações e tempo; campo
// "Adicione um comentário". Dono: "…" → Editar / Apagar.
import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { View, Text, Pressable, ScrollView, FlatList, Platform, StatusBar, useWindowDimensions, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from 'react-native-reanimated';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import MIcon from './MuralIcons';
import { LIKE } from './muralTheme';
import { Avatar, AnimatedHeart, BurstHeart, ActBtn, shortAgo, fullWhen, audienceLabel, count, displayName, handle, likersText, sharePost } from './parts';
import * as store from '../../services/muralStore';

let _GH = null;
if (Platform.OS !== 'web') { try { _GH = require('react-native-gesture-handler'); } catch { _GH = null; } }
const GH_OK = !!(_GH && _GH.Gesture && _GH.GestureDetector);

let _ExpoVideo = null;
function _video() {
  if (_ExpoVideo !== null) return _ExpoVideo;
  if (Platform.OS === 'web') { _ExpoVideo = false; return false; }
  try { _ExpoVideo = require('expo-video'); } catch { _ExpoVideo = false; }
  return _ExpoVideo;
}
function VideoSlide({ uri, active }) {
  const mod = _video();
  if (!mod || !mod.useVideoPlayer || !mod.VideoView) return null;
  return <VideoInner mod={mod} uri={uri} active={active} />;
}
function VideoInner({ mod, uri, active }) {
  let src = uri;
  try { src = require('../../services/videoCacheSource').cachedVideoSource(uri); } catch {}
  const player = mod.useVideoPlayer(src, (p) => { try { p.loop = true; p.muted = false; } catch {} });
  useEffect(() => { try { if (active) player.play(); else player.pause(); } catch {} }, [active, player]);
  return <mod.VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />;
}

/** Uma página do carrossel: pinça (volta ao soltar) + toque duplo. */
const Slide = memo(function Slide({ item, width, height, active, onDouble, onZoom }) {
  const sc = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const fx = useSharedValue(0);
  const fy = useSharedValue(0);
  const lastTap = useRef(0);
  const st = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: sc.value }] }));
  const media = item.type === 'video'
    ? (
      <View style={{ width, height, backgroundColor: '#111' }}>
        {item.thumb ? <ExpoImage source={{ uri: item.thumb }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
        <VideoSlide uri={item.url} active={active} />
      </View>
    )
    : (
      <ExpoImage source={{ uri: item.url }} placeholder={item.blurhash ? { blurhash: item.blurhash } : (item.thumb && item.thumb !== item.url ? { uri: item.thumb } : undefined)}
        style={{ width, height, backgroundColor: '#1c1c1e' }} contentFit="cover" transition={120} recyclingKey={item.url} />
    );
  if (!GH_OK) {
    // web: toque duplo por tempo, sem pinça
    return (
      <Pressable onPress={() => { const n = Date.now(); if (n - lastTap.current < 280) { lastTap.current = 0; onDouble(); } else lastTap.current = n; }} style={{ width, height }}>
        {media}
      </Pressable>
    );
  }
  const G = _GH.Gesture;
  const pinch = G.Pinch()
    .onStart((e) => { 'worklet'; fx.value = e.focalX - width / 2; fy.value = e.focalY - height / 2; if (onZoom) runOnJS(onZoom)(true); })
    .onUpdate((e) => {
      'worklet';
      const s = Math.max(1, Math.min(4, e.scale));
      sc.value = s;
      tx.value = fx.value * (1 - s) + (e.focalX - width / 2 - fx.value);
      ty.value = fy.value * (1 - s) + (e.focalY - height / 2 - fy.value);
    })
    .onEnd(() => {
      'worklet';
      sc.value = withSpring(1, { damping: 18, stiffness: 220 });
      tx.value = withSpring(0, { damping: 18, stiffness: 220 });
      ty.value = withSpring(0, { damping: 18, stiffness: 220 });
      if (onZoom) runOnJS(onZoom)(false);
    });
  const dbl = G.Tap().numberOfTaps(2).maxDelay(260).onEnd((_e, ok) => { 'worklet'; if (ok) runOnJS(onDouble)(); });
  const gesture = G.Simultaneous(pinch, dbl);
  return (
    <_GH.GestureDetector gesture={gesture}>
      <Animated.View style={[{ width, height, zIndex: 2 }, st]} collapsable={false}>
        {media}
      </Animated.View>
    </_GH.GestureDetector>
  );
});

function Carousel({ post, width, initialIndex = 0, onDouble }) {
  const media = post.media || [];
  const first = media[0] || {};
  // formato: 4:5 (mockup) ou o do 1º item (entre 4:5 e 1,91:1)
  let ratio = 0.8;
  if (first.w > 0 && first.h > 0) ratio = Math.max(0.8, Math.min(1.91, first.w / first.h));
  else if (post.aspect === '1:1') ratio = 1;
  const height = Math.round(width / ratio);
  const [idx, setIdx] = useState(Math.max(0, Math.min(media.length - 1, initialIndex)));
  const [burst, setBurst] = useState(0);
  const [zooming, setZooming] = useState(false);
  const listRef = useRef(null);
  const onScroll = useCallback((e) => {
    const x = e.nativeEvent.contentOffset.x;
    const i = Math.max(0, Math.min(media.length - 1, Math.round(x / Math.max(1, width))));
    setIdx((cur) => (cur === i ? cur : i));
  }, [media.length, width]);
  const dbl = useCallback(() => { setBurst((b) => b + 1); onDouble(); }, [onDouble]);
  return (
    <View>
      <View style={{ width, height, overflow: zooming ? 'visible' : 'hidden', zIndex: zooming ? 20 : 1 }}>
        <FlatList
          ref={listRef}
          data={media}
          horizontal
          pagingEnabled
          scrollEnabled={!zooming && media.length > 1}
          showsHorizontalScrollIndicator={false}
          keyExtractor={(m, i) => `${m.url}_${i}`}
          initialScrollIndex={idx > 0 ? idx : undefined}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          onScroll={onScroll}
          scrollEventThrottle={32}
          removeClippedSubviews={false}
          style={{ overflow: 'visible' }}
          renderItem={({ item, index }) => <Slide item={item} width={width} height={height} active={index === idx} onDouble={dbl} onZoom={setZooming} />}
        />
        {media.length > 1 ? (
          <View pointerEvents="none" style={{ position: 'absolute', right: 12, top: 12, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999 }}>
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{`${idx + 1}/${media.length}`}</Text>
          </View>
        ) : null}
        <BurstHeart trigger={burst} />
      </View>
      {media.length > 1 ? (
        <View style={{ flexDirection: 'row', gap: 5, justifyContent: 'center', paddingTop: 10 }}>
          {media.map((_, i) => <View key={i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: i === idx ? '#fff' : '#555' }} />)}
        </View>
      ) : null}
    </View>
  );
}

/** Menu "…": dono = Editar / Apagar; outros = Copiar link / Denunciar. */
export function usePostMenu(post, { onEdit, onDeleted, onReport } = {}) {
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const mine = !!(post && (post.is_mine || (user?.email && String(post.author_email).toLowerCase() === String(user.email).toLowerCase())));
  const open = useCallback(() => {
    if (!post) return;
    let pc = null;
    try { pc = require('../../services/profilePostComposer'); } catch { pc = null; }
    const opts = [];
    if (mine) {
      opts.push({ label: t('mural.edit', 'Editar'), onPress: () => onEdit?.(post) });
      opts.push({
        label: t('mural.delete', 'Apagar'), destructive: true,
        onPress: () => {
          const go = async () => {
            const ok = await store.deletePost(post.id);
            if (ok) { try { require('../ui/Toast').showToast({ message: t('mural.deleted', 'Publicação apagada'), kind: 'success' }); } catch {} onDeleted?.(); }
            else { try { require('../ui/Toast').showToast({ message: t('mural.err.delete', 'Não foi possível apagar'), kind: 'error' }); } catch {} }
          };
          if (Platform.OS === 'web') { if (typeof window === 'undefined' || !window.confirm || window.confirm(t('mural.deleteMsg', 'Ela some do seu perfil para todo mundo. Não dá para desfazer.'))) go(); return; }
          const { Alert } = require('react-native');
          setTimeout(() => Alert.alert(t('mural.deleteTitle', 'Apagar publicação?'), t('mural.deleteMsg', 'Ela some do seu perfil para todo mundo. Não dá para desfazer.'), [
            { text: t('common.cancel', 'Cancelar'), style: 'cancel' },
            { text: t('mural.delete', 'Apagar'), style: 'destructive', onPress: go },
          ]), Platform.OS === 'ios' ? 350 : 0);
        },
      });
    } else {
      opts.push({ label: t('mural.share', 'Compartilhar'), onPress: () => sharePost(post, t) });
      if (onReport) opts.push({ label: t('mural.report', 'Denunciar'), destructive: true, onPress: () => onReport({ content_type: 'post', content_id: post.id }) });
    }
    pc?.showActionMenu({ options: opts, cancelLabel: t('common.cancel', 'Cancelar') });
  }, [post, mine, onEdit, onDeleted, onReport, t]);
  return { openMenu: open, mine };
}

/**
 * <PostViewer postId onBack onOpenComments(focus) onEdit onReport initialIndex />
 * A tela dona (app/mural/post/[id].js) cuida de rota, folha e denúncia.
 */
export default function PostViewer({ postId, onBack, onOpenComments, onOpenLikers, onEdit, onReport, onDeleted, initialIndex = 0 }) {
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const width = Math.min(winW, 640);
  const post = store.usePost(postId);
  const cms = store.useComments(postId);
  const { openMenu } = usePostMenu(post, { onEdit, onDeleted, onReport });
  const like = useCallback(() => store.toggleLike(postId), [postId]);
  const dblLike = useCallback(() => store.toggleLike(postId, true), [postId]);
  if (!post) return null;
  const name = displayName(post);
  const highlight = post.top_comment || (cms?.items || []).find((c) => !c.pending && !c.failed) || null;
  const lt = likersText(post, t, user?.email);
  const fg = '#fff';
  const sub = '#a1a1a6';
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <StatusBar barStyle="light-content" />
      <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 8, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#000', zIndex: 5 }}>
        <Pressable onPress={onBack} hitSlop={8} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={t('common.back', 'Voltar')}>
          <MIcon name="back" size={24} color={fg} />
        </Pressable>
        <Avatar email={post.author_email} name={name} uri={post.author_avatar} size={34} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: fg, fontSize: 15, fontWeight: '700' }} numberOfLines={1}>{name}</Text>
          <Text style={{ color: sub, fontSize: 12.5 }} numberOfLines={1}>{`${fullWhen(post.created_at, t)} · ${audienceLabel(post.audience, t)}`}</Text>
        </View>
        <Pressable onPress={openMenu} hitSlop={8} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={t('mural.more', 'Mais opções')}>
          <MIcon name="more" size={24} color={fg} />
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12, alignItems: winW > width ? 'center' : undefined }} showsVerticalScrollIndicator={false}>
        <View style={{ width }}>
          {post.media && post.media.length ? <Carousel post={post} width={width} initialIndex={initialIndex} onDouble={dblLike} /> : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 6, paddingTop: 6 }}>
            <ActBtn onPress={like} a11y={post.liked ? t('mural.unlike', 'Descurtir') : t('mural.like', 'Curtir')}>
              <AnimatedHeart liked={post.liked} size={27} color={fg} />
              {post.likes > 0 ? <Text style={{ color: post.liked ? LIKE : fg, fontSize: 15, fontWeight: '600' }}>{count(post.likes, t)}</Text> : null}
            </ActBtn>
            <ActBtn onPress={() => onOpenComments?.(false)} a11y={t('mural.comment', 'Comentar')} disabled={post.allow_comments === false && !post.comments}>
              <MIcon name="comment" size={27} color={fg} />
              {post.comments > 0 ? <Text style={{ color: fg, fontSize: 15, fontWeight: '600' }}>{count(post.comments, t)}</Text> : null}
            </ActBtn>
            <ActBtn onPress={() => sharePost(post, t)} a11y={t('mural.share', 'Compartilhar')}>
              <MIcon name="share" size={27} color={fg} />
            </ActBtn>
            <View style={{ flex: 1 }} />
            <ActBtn onPress={() => store.toggleSave(postId)} a11y={post.saved ? t('mural.unsave', 'Remover dos salvos') : t('mural.save', 'Salvar')}>
              <MIcon name="bookmark" size={27} color={fg} fill={post.saved ? fg : 'none'} />
            </ActBtn>
          </View>
          <View style={{ paddingHorizontal: 16, paddingTop: 2 }}>
            {lt ? (
              <Pressable onPress={onOpenLikers} disabled={!onOpenLikers} hitSlop={4}>
                <Text style={{ color: fg, fontWeight: '600', fontSize: 14.5 }}>{lt}</Text>
              </Pressable>
            ) : null}
            {post.caption ? (
              <Text style={{ color: fg, marginTop: 5, fontSize: 14.5, lineHeight: 20 }}>
                <Text style={{ fontWeight: '700' }}>{handle(post)}</Text>{'  '}{post.caption}
              </Text>
            ) : null}
            {post.comments > 0 ? (
              <Pressable onPress={() => onOpenComments?.(false)} hitSlop={4} style={{ marginTop: 7 }}>
                <Text style={{ color: sub, fontSize: 14.5 }}>
                  {post.comments === 1 ? t('mural.viewOneComment', 'Ver 1 comentário') : t('mural.viewComments', { n: count(post.comments, t), defaultValue: `Ver os ${count(post.comments, t)} comentários` })}
                </Text>
              </Pressable>
            ) : null}
            {highlight ? (
              <Pressable onPress={() => onOpenComments?.(false)} style={{ paddingTop: 6 }}>
                <Text style={{ color: fg, fontSize: 14, lineHeight: 19 }} numberOfLines={2}>
                  <Text style={{ fontWeight: '700' }}>{highlight.username || String(highlight.email || '').split('@')[0] || highlight.name}</Text>{'  '}{highlight.content}
                </Text>
              </Pressable>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 }}>
              {post.views > 0 ? <MIcon name="eye" size={14} color="#8e8e93" /> : null}
              <Text style={{ color: '#8e8e93', fontSize: 12 }}>
                {post.views > 0 ? `${post.views === 1 ? t('mural.oneView', '1 visualização') : t('mural.views', { n: count(post.views, t), defaultValue: `${count(post.views, t)} visualizações` })} · ${shortAgo(post.created_at, t)}` : shortAgo(post.created_at, t)}
                {post.edited_at ? ` · ${t('mural.edited', 'editado')}` : ''}
              </Text>
            </View>
          </View>
          {post.allow_comments !== false ? (
            <Pressable onPress={() => onOpenComments?.(true)} style={{ marginTop: 18, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10 + Math.max(insets.bottom, 8), flexDirection: 'row', alignItems: 'center', gap: 10 }}
              accessibilityRole="button" accessibilityLabel={t('mural.addComment', 'Adicione um comentário...')}>
              <Avatar email={user?.email} name={user?.name || user?.email} size={32} />
              <View style={{ flex: 1, borderWidth: 1, borderColor: '#3a3a3c', borderRadius: 999, paddingVertical: 9, paddingHorizontal: 14 }}>
                <Text style={{ color: '#8e8e93', fontSize: 14.5 }}>{t('mural.addComment', 'Adicione um comentário...')}</Text>
              </View>
            </Pressable>
          ) : <View style={{ height: 18 + insets.bottom }} />}
        </View>
      </ScrollView>
    </View>
  );
}
