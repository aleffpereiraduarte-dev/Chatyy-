// components/feed/NativePostFeed.js — [2026-10-15 native-feed]
//
// Lista de posts da aba FEED em NATIVO (view `ChatyyPostFeed` do módulo
// modules/expo-reels-feed — iOS UICollectionView + diffable, Android
// RecyclerView + DiffUtil; vídeo pelo pool de players dos Reels). O
// ChatFeedTab continua dono dos dados (posts, paginação, refresh, lives); aqui:
//   1. posts → linhas planas + PATCHES por id (createPatcher da home);
//   2. topo da aba (busca, abas, stories, lives, sugestões) = 1º filho RN,
//      rodapé (carregando / "você está em dia") = 2º filho;
//   3. ações nativas → mesma lógica do FeedPost (curtir com fila offline,
//      salvar, ocultar, traduzir, links) e as folhas JS do FeedPost
//      (curtidas, coleções, compartilhar, análises, impulsionar, presente,
//      excluir) via <FeedPost headless command>.
// Qualquer erro (render ou onNativeError) → onFailure() e a aba volta para a
// FlashList JS na hora. Desligar por OTA: globalThis.__chatyy_native_feed = false.

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNativeHeaderTouchGuard } from '../native/nativeHeaderTouchGuard'; // [2026-10-17 settings-scroll-tap]
import { Linking, Platform, StyleSheet, View } from 'react-native';
import { getNativePostFeedView } from '../../modules/expo-reels-feed';
import { createPatcher, initialsOf } from '../chatlist/nativeAdapter';
import FeedPost, { feedTimeAgo, feedResolveMediaUrl, feedIsVideoMedia, feedParseMediaUrls } from '../FeedPost';
import { MONETIZATION_ENABLED, DIAMONDS_ENABLED } from '../../constants/featureFlags';
import * as api from '../../services/api';
import { useLanguage } from '../../context/LanguageContext';

const KILL = '__chatyy_native_feed';

/** View nativa disponível e não desligada (kill switch / falha anterior). */
export function nativePostFeedEnabled() {
  if (Platform.OS === 'web') return false;
  try { if (globalThis[KILL] === false || globalThis.__chatyy_native_feed_failed) return false; } catch {}
  try { return !!getNativePostFeedView(); } catch { return false; }
}

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    try { this.props.onFailure?.(String(error?.message || error)); } catch {}
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function _lazy(fn) {
  let v; let done = false;
  return () => { if (!done) { done = true; try { v = fn(); } catch { v = null; } } return v; };
}
const _avatarSvc = _lazy(() => require('../../services/avatar'));
const _avatarCache = _lazy(() => require('../../services/avatarCache'));

const _EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function _tx(t, key, fb) {
  let r = fb;
  try {
    const v = t ? t(key) : null;
    if (typeof v === 'string' && v && v !== key) r = v;
  } catch {}
  return r;
}

function _avatarUrl(email, name) {
  const em = String(email || '');
  if (!em || !_EMAIL_RE.test(em)) return '';
  let u = '';
  try { u = _avatarSvc()?.buildAvatarUrl?.(em, { name }) || ''; } catch { u = ''; }
  if (!u) return '';
  try {
    const local = _avatarCache()?.getCachedAvatarUriOrNull?.(u);
    if (local) return local;
  } catch {}
  return u;
}

function _date(ca, lang) {
  if (!ca) return '';
  const iso = (ca.endsWith('Z') || ca.includes('+')) ? ca : ca + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString(lang || undefined, { month: 'long', day: 'numeric' }); } catch { return ''; }
}

export function buildFeedLabels(t) {
  return {
    oneLike: _tx(t, 'feed.oneLike', '1 curtida'),
    likes: _tx(t, 'feed.likes', 'curtidas'),
    viewOneComment: _tx(t, 'feed.viewOneComment', 'Ver 1 comentário'),
    viewAllComments: _tx(t, 'feed.viewAllComments', 'Ver todos os {count} comentários'),
    moreCaption: _tx(t, 'feed.more', 'mais'),
    less: _tx(t, 'feed.less', 'menos'),
    translating: _tx(t, 'feed.translating', 'Traduzindo…'),
    showOriginal: _tx(t, 'feed.showOriginal', 'Ver original'),
    translateError: _tx(t, 'feed.translateError', 'Não foi possível traduzir.'),
    with: _tx(t, 'feed.with', 'com'),
    sponsored: _tx(t, 'feed.sponsored', 'Patrocinado'),
    notInterested: _tx(t, 'feed.notInterested', 'Não tenho interesse'),
    seeLess: _tx(t, 'feed.seeLess', 'Ver menos posts assim'),
    pin: _tx(t, 'feed.pinPost', 'Fixar no perfil'),
    unpin: _tx(t, 'feed.unpinPost', 'Desafixar do perfil'),
    analytics: _tx(t, 'feed.analytics', 'Análises'),
    promote: _tx(t, 'feed.promote', 'Impulsionar'),
    delete: _tx(t, 'feed.deletePost', _tx(t, 'feed.delete', 'Excluir')),
    like: _tx(t, 'feed.like', 'Curtir'),
    unlike: _tx(t, 'feed.unlike', 'Descurtir'),
    comment: _tx(t, 'feed.comment', 'Comentar'),
    share: _tx(t, 'feed.share', 'Compartilhar'),
    save: _tx(t, 'feed.bookmark', 'Salvar'),
    unsave: _tx(t, 'feed.removeBookmark', 'Remover dos salvos'),
    gift: _tx(t, 'gifts.sendGift', 'Enviar presente'),
    more: _tx(t, 'common.more', 'Mais opções'),
    mute: _tx(t, 'feed.mute', 'Silenciar'),
    unmute: _tx(t, 'feed.unmute', 'Ativar som'),
  };
}

/** Post → linha plana (o patcher compara só o 1º nível). */
export function buildPostRow(post, ctx) {
  const id = String(post.id);
  const email = String(post.author_email || '');
  const name = String(post.author_name || email.split('@')[0] || '?');
  const urls = feedParseMediaUrls(post.media_urls);
  const media = urls.map((u, i) => {
    const url = feedResolveMediaUrl(String(u || ''));
    if (feedIsVideoMedia(post, u)) {
      const poster = i === 0 && post.thumbnail_url ? feedResolveMediaUrl(String(post.thumbnail_url)) : '';
      return `v\t${url}\t${poster}`;
    }
    return `i\t${url}`;
  }).join('\n');
  const own = !!ctx.myEmail && ctx.myEmail === email.toLowerCase();
  const tr = ctx.translations.get(id);
  const row = {
    id,
    an: name,
    ae: email,
    au: _avatarUrl(email, name),
    ai: initialsOf(name, email),
    own: own ? 1 : 0,
    sp: (post.is_ad || post.sponsored || post.is_promoted) ? 1 : 0,
    loc: String(post.location_name || post.location || ''),
    tm: feedTimeAgo(post.created_at || '', ctx.t, ctx.lang),
    m: media,
    cap: String(post.caption || ''),
    tr: tr && typeof tr.text === 'string' ? tr.text : '',
    trs: tr ? (tr.state || 0) : 0,
    liked: (post.user_liked ?? post.liked_by_me) ? 1 : 0,
    lk: Number(post.like_count ?? post.likes_count ?? post.likes) || 0,
    sv: (post.user_bookmarked ?? post.bookmarked_by_me) ? 1 : 0,
    cc: Number(post.comments_count ?? post.comments ?? post.comment_count) || 0,
    dt: _date(post.created_at || '', ctx.lang),
    gift: (DIAMONDS_ENABLED && !own) ? 1 : 0,
    pin: post.is_pinned ? 1 : 0,
    prm: (MONETIZATION_ENABLED && own && !post.is_promoted) ? 1 : 0,
  };
  if (post.duet_of || post.stitch_of) {
    row.dl = post.duet_of
      ? `${_tx(ctx.t, 'feed.duetWith', 'Dueto com')} @${post.original_author || ''}`
      : `${_tx(ctx.t, 'feed.stitchWith', 'Stitch com')} @${post.original_author || ''}`;
  }
  if (post.sound_name) row.snd = `${post.sound_name}${post.sound_artist ? ` - ${post.sound_artist}` : ''}`;
  const op = post.original_post;
  if (op) {
    row.rp = 1;
    row.rpa = String(op.author_name || String(op.author_email || '').split('@')[0] || '');
    row.rpc = String(op.caption || '');
    row.rpt = op.thumbnail_url ? feedResolveMediaUrl(String(op.thumbnail_url)) : '';
  }
  if (Array.isArray(post.tagged_users) && post.tagged_users.length) row.tg = post.tagged_users.map(String).join('\n');
  return row;
}

function NativePostFeedInner(props) {
  const {
    posts, user, t, isDark, colors, header, footer, refreshing,
    bottomInset = 0, paused, scrollToTopSeq = 0,
  } = props;
  const Native = getNativePostFeedView();
  const { language: lang } = useLanguage();
  const langRef = useRef(lang);
  langRef.current = lang;

  const patcherRef = useRef(null);
  const headerTouchGuard = useNativeHeaderTouchGuard();
  const footerTouchGuard = useNativeHeaderTouchGuard();
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);
  const [translations, setTranslations] = useState(() => new Map());
  const [sheet, setSheet] = useState(null); // { post, command: {kind, seq} }
  const sheetSeqRef = useRef(0);

  const labels = useMemo(() => buildFeedLabels(t), [t]);
  const myEmail = String(user?.email || '').toLowerCase();

  const postsRef = useRef(new Map());
  const built = useMemo(() => {
    const ctx = { t, lang, myEmail, translations };
    const rows = [];
    const map = new Map();
    for (const p of Array.isArray(posts) ? posts : []) {
      if (!p || p.id == null || p.__type) continue;
      try {
        rows.push(buildPostRow(p, ctx));
        map.set(String(p.id), p);
      } catch {}
    }
    return { rows, map };
  }, [posts, t, lang, myEmail, translations]);

  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(built.rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [built, resyncToken]
  );
  useLayoutEffect(() => {
    patcherRef.current.commit(snapshot);
    postsRef.current = built.map;
  }, [snapshot, built]);

  const [headerH, setHeaderH] = useState(0);
  const [footerH, setFooterH] = useState(0);
  const onHeaderLayout = useCallback((e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    setHeaderH(prev => (prev === h ? prev : h));
  }, []);
  const onFooterLayout = useCallback((e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    setFooterH(prev => (prev === h ? prev : h));
  }, []);

  const imageHeaders = useMemo(() => {
    try {
      const svc = _avatarSvc();
      const h = svc?.avatarAuthHeaders?.(svc?.buildAvatarUrl?.(user?.email || 'feed@chatyy.com.br'));
      return h?.Authorization ? { Authorization: h.Authorization } : null;
    } catch { return null; }
  }, [user?.email]);

  const palette = useMemo(() => ({
    bg: isDark ? (colors?.background || '#000000') : '#ffffff',
    card: isDark ? (colors?.surface || '#121212') : '#ffffff',
    text: colors?.text || (isDark ? '#F5F5F5' : '#111111'),
    text2: colors?.textSecondary || (isDark ? '#9E9E9E' : '#666666'),
    text3: colors?.textTertiary || colors?.textSecondary || (isDark ? '#737373' : '#8C8C8C'),
  }), [isDark, colors]);

  const propsRef = useRef(props);
  propsRef.current = props;
  const likeInFlight = useRef(new Set());
  const saveInFlight = useRef(new Set());

  const runTranslate = useCallback(async (post) => {
    const id = String(post.id);
    const cur = translations.get(id);
    if (cur && (cur.text || cur.state === 2)) {
      setTranslations(prev => { const m = new Map(prev); m.delete(id); return m; });
      return;
    }
    if (!post.caption || (cur && cur.state === 1)) return;
    setTranslations(prev => new Map(prev).set(id, { state: 1 }));
    let next = { state: 2 };
    try {
      const r = await api.apiCall('ai_translate', { text: post.caption, target_lang: langRef.current || 'pt-BR' }, 'POST');
      const txt = r?.success ? (r.data?.translated || r.data?.text) : '';
      if (txt) next = { state: 0, text: String(txt) };
    } catch {}
    setTranslations(prev => new Map(prev).set(id, next));
  }, [translations]);
  const runTranslateRef = useRef(runTranslate);
  runTranslateRef.current = runTranslate;

  const handlers = useMemo(() => {
    const patchPost = (id, patch) => { try { propsRef.current.onPatchPost?.(id, patch); } catch {} };
    const openSheet = (post, kind) => {
      sheetSeqRef.current += 1;
      setSheet({ post, command: { kind, seq: sheetSeqRef.current } });
    };
    const doLike = async (post, liked, likes) => {
      const id = String(post.id);
      patchPost(post.id, { user_liked: liked, liked_by_me: liked, like_count: likes, likes_count: likes });
      if (likeInFlight.current.has(id)) return;
      likeInFlight.current.add(id);
      try {
        const r = await api.feedLike(post.id);
        if (r?.success && r.data) {
          const p = {};
          if (r.data.liked !== undefined) { p.user_liked = !!r.data.liked; p.liked_by_me = !!r.data.liked; }
          const sc = r.data.likes_count ?? r.data.like_count;
          if (sc !== undefined) { p.like_count = Number(sc); p.likes_count = Number(sc); }
          if (Object.keys(p).length) patchPost(post.id, p);
        }
      } catch {
        try {
          const { queueOfflineAction } = require('../../services/offlineCache');
          await queueOfflineAction({ type: 'feed_like', params: { id: post.id } });
        } catch {
          const was = !liked;
          patchPost(post.id, { user_liked: was, liked_by_me: was, like_count: Math.max(0, likes + (was ? 1 : -1)), likes_count: Math.max(0, likes + (was ? 1 : -1)) });
        }
      } finally {
        likeInFlight.current.delete(id);
      }
    };
    const doSave = async (post, saved) => {
      const id = String(post.id);
      patchPost(post.id, { user_bookmarked: saved, bookmarked_by_me: saved });
      if (saveInFlight.current.has(id)) return;
      saveInFlight.current.add(id);
      try {
        const r = await api.feedBookmark(post.id);
        if (r?.success && r.data && r.data.bookmarked !== undefined) {
          patchPost(post.id, { user_bookmarked: !!r.data.bookmarked, bookmarked_by_me: !!r.data.bookmarked });
        }
      } catch {
        patchPost(post.id, { user_bookmarked: !saved, bookmarked_by_me: !saved });
      } finally {
        saveInFlight.current.delete(id);
      }
    };
    const openLocation = (post) => {
      const lat = post.location_lat, lon = post.location_lon;
      if (lat == null || lon == null) return;
      const label = encodeURIComponent(post.location_name || post.location || '');
      const url = Platform.OS === 'ios'
        ? `maps:?ll=${lat},${lon}&q=${label || `${lat},${lon}`}`
        : `geo:${lat},${lon}?q=${lat},${lon}${label ? `(${label})` : ''}`;
      Promise.resolve(Linking.openURL(url)).catch(() => {
        try { Linking.openURL(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`); } catch {}
      });
    };
    const push = (path) => {
      try {
        const r = propsRef.current.router || require('expo-router').router;
        r.push(path);
      } catch {}
    };
    return {
      onPostAction: (e) => {
        const ne = e?.nativeEvent ?? e ?? {};
        const id = String(ne.id ?? '');
        const post = postsRef.current.get(id);
        if (!post) return;
        const p = propsRef.current;
        const action = String(ne.action || '');
        const value = String(ne.value || '');
        try {
          switch (action) {
            case 'like': doLike(post, !!ne.liked, Number(ne.likes) || 0); break;
            case 'save': doSave(post, !!ne.saved); break;
            case 'comments': p.onOpenComments?.(post); break;
            case 'author': p.onPressUser?.(post.author_email, post.author_name); break;
            case 'tagged': p.onPressUser?.(value, value.split('@')[0]); break;
            case 'hashtag': push(`/hashtag?tag=${encodeURIComponent(value)}`); break;
            case 'mention': push(`/u/${encodeURIComponent(value)}`); break;
            case 'repost': if (post.original_post?.id) push(`/feed/${post.original_post.id}`); break;
            case 'location': openLocation(post); break;
            case 'translate': runTranslateRef.current(post); break;
            case 'not_interested':
            case 'see_less':
              Promise.resolve().then(() => api.feedHidePost(post.id, action)).catch(() => {});
              p.onDeletePost?.(post.id);
              break;
            case 'share': case 'likers': case 'collections': case 'gift':
            case 'pin': case 'analytics': case 'promote': case 'delete':
              openSheet(post, action);
              break;
            default: break;
          }
        } catch {}
      },
      onEndReached: () => { try { propsRef.current.onEndReached?.(); } catch {} },
      onRefresh: () => { try { propsRef.current.onRefresh?.(); } catch {} },
      onScrollState: (e) => {
        const ne = e?.nativeEvent ?? e ?? {};
        try { propsRef.current.onScrollState?.(!!ne.top, !!ne.hidden); } catch {}
      },
      onResync: () => {
        patcherRef.current.requestReset();
        setResyncToken(v => v + 1);
      },
      onFirstPaint: () => {},
      onNativeError: (e) => {
        const msg = String((e?.nativeEvent ?? e)?.message || 'native error');
        try { globalThis.__chatyyNativeFeedError = { at: Date.now(), msg }; } catch {}
        try { propsRef.current.onFailure?.(msg); } catch {}
      },
    };
  }, []);

  // Folha JS em uso: acompanha o post atualizado (curtidas, fixado…).
  const sheetPost = sheet ? (built.map.get(String(sheet.post.id)) || sheet.post) : null;

  if (!Native) return null;
  return (
    <View style={styles.fill}>
      <Native
        style={styles.fill}
        rowsPatch={patch}
        dark={!!isDark}
        labels={labels}
        palette={palette}
        imageHeaders={imageHeaders || undefined}
        headerHeight={headerH}
        footerHeight={footerH}
        bottomInset={bottomInset || 0}
        refreshing={!!refreshing}
        refreshTint={palette.text}
        paused={!!paused}
        scrollToTopSeq={scrollToTopSeq || 0}
        {...handlers}
      >
        <View collapsable={false} style={styles.slot} onLayout={onHeaderLayout} {...headerTouchGuard}>
          {header}
        </View>
        <View collapsable={false} style={styles.slot} onLayout={onFooterLayout} {...footerTouchGuard}>
          {footer}
        </View>
      </Native>
      {sheetPost ? (
        <FeedPost
          key={String(sheetPost.id)}
          headless
          command={sheet.command}
          post={sheetPost}
          colors={colors}
          isDark={isDark}
          t={t}
          user={user}
          onOpenComments={props.onOpenComments}
          onPostUpdated={props.onPostUpdated}
          onDeletePost={props.onDeletePost}
          onPressUser={props.onPressUser}
          onHidePost={props.onDeletePost}
          isActive={false}
        />
      ) : null}
    </View>
  );
}

export default function NativePostFeed(props) {
  return (
    <Boundary onFailure={props.onFailure}>
      <NativePostFeedInner {...props} />
    </Boundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  slot: { position: 'absolute', top: 0, left: 0, right: 0 },
});
