// [tabs-v2 2026-10-20] Aba "Mural" da barra de baixo (Opção A aprovada pelo founder:
// Conversas | Mural | Ligações | Perfil). Mockup: scratchpad navegacao/index.html.
//
//   topo: título "Mural" + segmento  Para você | Seguindo | Reels
//   Para você / Seguindo → feed estilo X/Facebook (texto e fotos misturados):
//       faixa de status (StoriesStrip do ChatFeedTab), caixa "No que você está
//       pensando?" (muralNav.openComposer), posts pendentes da fila
//       (profilePostQueue) e os do servidor (`mural_feed {tab, cursor}`, formato
//       Post do /root/mural-2026-10-20/API.md) em PostCard (TgPostTiles).
//       "Para você" ganha a faixa "Reels para você" (reels_rec_feed) depois do 2º post.
//   Reels → a MESMA tela da antiga aba Reels (ReelsHomeTab/ReelsViewer), tela cheia;
//       o segmento vira texto branco por cima do vídeo (voltar | Para você | Seguindo | Reels).
//
// Curtir/salvar/comentar/abrir = services/muralStore + services/muralNav (mesma cópia
// do post que PostViewer/TextPostView/folha de comentários usam → contadores ao vivo).
// Kill switch da barra nova inteira: globalThis.__chatyy_tabs_v2 = false (app/chat.js).
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, FlatList, RefreshControl, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Rect, Path } from 'react-native-svg';
import FastImage from '../FastImage';
import { PostSkeleton } from '../SkeletonLoader';
import { useMuralTheme } from './muralTheme';
import { THEME_V2, cardShadow } from '../../constants/theme';
import MIcon from './MuralIcons';
import { Avatar, sharePost } from './parts';
import { MuralCommentsHost } from './CommentsSheet';
import { PostCard, fmtN } from '../profile/tg/TgPostTiles';
import { normPost, absUrl, reportPost } from '../profile/tg/useTgProfileData';
import { usePendingProfilePosts, openPendingPostMenu } from '../ProfilePostProgress';
import * as store from '../../services/muralStore';
import * as muralNav from '../../services/muralNav';
import * as signals from '../../services/muralSignals'; // [mural-cerebro 2026-10-20]
import { useLanguage } from '../../context/LanguageContext';

const ReelsHomeTab = React.lazy(() => import('../ReelsHomeTab'));

export const MURAL_SEGMENTS = ['foryou', 'following', 'reels'];
const PAGE = 15;
const FIRST_PAGE = 8; // [muralperf 2026-10-21] 1ª página pequena (≈2 telas) → resposta menor/mais rápida; o resto vem rolando
const CACHE_KEY = (tab) => `mural_feed_v1_${tab}`;

// [muralperf 2026-10-21] baixa para o cache do expo-image a versão de tela (cartão) dos próximos posts e a
// miniatura dos demais assim que a página chega → rolar não mostra cartão cinza esperando a foto.
function _prefetchMedia(posts, from = 0) {
  try {
    const Img = require('expo-image').Image;
    if (!Img || !Img.prefetch) return;
    const urls = [];
    posts.slice(from, from + PAGE).forEach((p) => {
      const ms = Array.isArray(p && p.media) ? p.media.slice(0, 3) : [];
      ms.forEach((m) => {
        if (!m || m.type === 'video') return;
        const u = absUrl(m.display || m.thumb || m.url);
        if (/^https?:/i.test(u)) urls.push(u);
      });
    });
    if (urls.length) Img.prefetch(Array.from(new Set(urls)).slice(0, 30), 'memory-disk').catch(() => {});
  } catch {}
}

function _api() { return require('../../services/api'); }

// ─── dados do feed (1 estado por aba; cache em disco p/ pintar na hora) ──────
function _readCache(tab) {
  try {
    const d = require('../../services/cache').getCachedSync(CACHE_KEY(tab));
    if (d && Array.isArray(d.posts)) return d.posts;
  } catch {}
  return null;
}
function _writeCache(tab, posts) {
  try { require('../../services/cache').setCache(CACHE_KEY(tab), { posts: posts.slice(0, PAGE) }, 3 * 86400000).catch(() => {}); } catch {}
}
function _prime(posts) {
  for (const p of posts) { try { store.primePost(p); } catch {} }
}

function useMuralFeed(tab, enabled, t) {
  const [st, setSt] = useState(() => {
    const cached = _readCache(tab);
    if (cached) _prime(cached);
    return { posts: cached || [], cursor: null, hasMore: true, loading: false, refreshing: false, error: false, loaded: false, fromCache: !!cached, fs: null, railAt: 1 };
  });
  const busy = useRef(false);
  const pendingRefresh = useRef(false); // [2026-10-21 fix] refresh pedido com carga em voo (ex.: post publicado) não se perde
  const stRef = useRef(st);
  stRef.current = st;

  const load = useCallback(async (mode) => { // 'first' | 'refresh' | 'more'
    if (busy.current) { if (mode === 'refresh') pendingRefresh.current = true; return; }
    const cur = stRef.current;
    if (mode === 'more' && (!cur.hasMore || !cur.cursor)) return;
    busy.current = true;
    // [muralperf 2026-10-21] 1ª carga com a cópia do disco na tela = revalida calado (sem spinner no rodapé)
    const silent = mode === 'first' && cur.posts.length > 0;
    setSt((s) => ({ ...s, loading: mode !== 'refresh' && !silent, refreshing: mode === 'refresh', error: false }));
    let r = null;
    try {
      r = await _api().apiCall('mural_feed', { tab, limit: mode === 'more' ? PAGE : FIRST_PAGE, tz: -new Date().getTimezoneOffset(), ...(mode === 'more' ? { cursor: cur.cursor } : null) }, 'POST');
    } catch { r = null; }
    busy.current = false;
    if (pendingRefresh.current) { pendingRefresh.current = false; setTimeout(() => { try { load('refresh'); } catch {} }, 0); }
    const d = r && r.success && r.data ? r.data : null;
    if (!d || !Array.isArray(d.posts)) {
      // [2026-10-21 polish] puxar p/ atualizar sem rede com posts na tela: avisa em vez de calar
      if (mode === 'refresh' && cur.posts.length) { try { require('../ui/Toast').showToast({ message: t ? t('mural.feed.refreshFail', 'Sem conexão. Mostrando o que já estava salvo.') : 'Sem conexão. Mostrando o que já estava salvo.', kind: 'error' }); } catch {} }
      setSt((s) => ({ ...s, loading: false, refreshing: false, error: true, loaded: true }));
      return;
    }
    _prime(d.posts);
    _prefetchMedia(d.posts, mode === 'more' ? 0 : 2); // os 2 primeiros já estão sendo pintados
    setSt((s) => {
      const posts = mode === 'more' ? [...s.posts, ...d.posts.filter((p) => !s.posts.some((q) => String(q.id) === String(p.id)))] : d.posts;
      if (mode !== 'more') _writeCache(tab, posts);
      // [mural-cerebro 2026-10-20] fs = sessão ranqueada do servidor (sinais/A-B); rail_at = onde entra a faixa de Reels
      const fs = d.fs || (mode === 'more' ? s.fs : null) || null;
      const railAt = Number.isFinite(Number(d.rail_at)) ? Math.max(0, Math.min(6, Number(d.rail_at))) : (mode === 'more' ? s.railAt : 1);
      return { posts, cursor: d.next_cursor || null, hasMore: !!d.has_more, loading: false, refreshing: false, error: false, loaded: true, fromCache: false, fs, railAt };
    });
  }, [tab, t]);

  useEffect(() => {
    if (enabled && !st.loaded && !busy.current) load('first');
  }, [enabled, st.loaded, load]);

  // post apagado (aqui, no visualizador ou no perfil) → some da lista
  useEffect(() => store.onAnyPostChange((p) => {
    if (p && p.deleted) setSt((s) => {
      if (!s.posts.some((q) => String(q.id) === String(p.id))) return s;
      const posts = s.posts.filter((q) => String(q.id) !== String(p.id));
      _writeCache(tab, posts); // [2026-10-21 fix] apagado não volta ao abrir sem rede
      return { ...s, posts };
    });
  }), [tab]);

  return { ...st, load };
}

// ─── faixa "Reels para você" ─────────────────────────────────────────────────
const ReelsRail = memo(function ReelsRail({ th, t, lang, onOpen, enabled }) {
  const [items, setItems] = useState(() => {
    try { const d = require('../../services/cache').getCachedSync('mural_reels_rail_v1'); return Array.isArray(d) ? d : []; } catch { return []; }
  });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    (async () => {
      try {
        const api = _api();
        const r = api.reelsRecFeed ? await api.reelsRecFeed({ limit: 8 }) : null;
        const list = r && r.success && r.data ? (r.data.posts || r.data.items || []) : [];
        const clean = list.filter((p) => p && p.id && (p.thumbnail_url || p.thumbnail)).slice(0, 8)
          .map((p) => ({ id: String(p.id), thumb: absUrl(p.thumbnail_url || p.thumbnail), views: Number(p.view_count || p.views || 0) || 0 }));
        if (alive && clean.length) {
          setItems(clean);
          try { require('../../services/cache').setCache('mural_reels_rail_v1', clean, 86400000).catch(() => {}); } catch {}
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, [enabled]);
  if (!items.length) return null;
  return (
    <View style={[s.rail, { backgroundColor: th.card }, THEME_V2 && cardShadow(th.isDark)]}>
      <View style={s.railHead}>
        <ReelGlyph size={17} color={th.text} />
        <Text style={[s.railTitle, { color: th.text }]} accessibilityRole="header">{t('mural.feed.reelsForYou', 'Reels para você')}</Text>
        <Pressable onPress={onOpen} hitSlop={8} accessibilityRole="button">
          <Text style={[s.railMore, { color: th.muted }]}>{t('mural.feed.seeAll', 'Ver todos')}</Text>
        </Pressable>
      </View>
      <FlatList
        horizontal
        data={items}
        keyExtractor={(it) => `rr${it.id}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}
        renderItem={({ item }) => (
          <Pressable onPress={onOpen} style={[s.railTile, { backgroundColor: th.chip }]} accessibilityRole="button" accessibilityLabel={t('mural.feed.reels', 'Reels')}>
            <FastImage source={{ uri: item.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" recyclingKey={`rr${item.id}`} />
            <View style={s.railMeta} pointerEvents="none">
              <MIcon name="play" size={12} color="#fff" fill="#fff" strokeWidth={1} />
              <Text style={s.railMetaTxt}>{fmtN(item.views, lang)}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
});

function ReelGlyph({ size = 16, color = '#000' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="3" width="18" height="18" rx="5" />
      <Path d="M3 8.5h18M9 3.2l2.5 5.3M14.5 3.2L17 8.5" />
      <Path d="M10.5 12.2v5.1l4.2-2.55z" fill={color} />
    </Svg>
  );
}

// ─── um post do feed (cópia viva do muralStore por cima do objeto do servidor) ──
const FeedRow = memo(function FeedRow({ raw, th, lang, shadow, onMore, ctx }) {
  const sp = store.usePost(raw.id);
  const post = useMemo(() => {
    const base = normPost(raw);
    if (!base || !sp) return base;
    if (sp.deleted) return null;
    return { ...base, text: sp.caption != null ? sp.caption : base.text, like_count: sp.likes, liked_by_me: !!sp.liked, comment_count: sp.comments, allow_comments: sp.allow_comments !== false };
  }, [raw, sp]);
  const au = raw.author || {};
  const author = useMemo(() => ({
    name: au.name || '', username: au.username || '', email: au.email || '', // [verificado 2026-10-24] selo
    avatar: (sz) => <Avatar email={au.email} name={au.name || au.email} size={sz} />,
  }), [au.email, au.name, au.username]); // eslint-disable-line react-hooks/exhaustive-deps
  const onOpen = useCallback(() => { signals.trackMural(raw.id, 'open', ctx); try { muralNav.openPost(raw); } catch {} }, [raw, ctx]);
  const onLike = useCallback(() => { signals.trackMural(raw.id, (sp ? sp.liked : raw.liked_by_me) ? 'unlike' : 'like', ctx); try { store.toggleLike(raw.id); } catch {} }, [raw.id, sp, ctx]);
  const onComments = useCallback(() => { signals.trackMural(raw.id, 'comment', ctx); try { muralNav.openComments(raw, { post: raw }); } catch {} }, [raw, ctx]);
  const onShare = useCallback(() => { signals.trackMural(raw.id, 'share', ctx); sharePost({ id: raw.id, caption: (sp && sp.caption) || raw.text || '' }, (k, f) => f); }, [raw, sp, ctx]);
  const onBookmark = useCallback(() => { signals.trackMural(raw.id, sp && sp.saved ? 'unsave' : 'save', ctx); try { store.toggleSave(raw.id); } catch {} }, [raw.id, sp, ctx]);
  const more = useCallback(() => onMore(raw), [onMore, raw]);
  if (!post) return null;
  return (
    <PostCard post={post} th={th} lang={lang} author={author} shadow={shadow}
      onOpen={onOpen} onLike={onLike} onComments={onComments} onShare={onShare} onMore={more}
      onBookmark={onBookmark} bookmarked={!!(sp && sp.saved)} />
  );
});

const PendingRow = memo(function PendingRow({ post, th, lang, shadow, me }) {
  const author = useMemo(() => ({ name: me.name, username: '', avatar: (sz) => <Avatar email={me.email} name={me.name} size={sz} /> }), [me.email, me.name]);
  const open = useCallback(() => { try { openPendingPostMenu(post.raw || post); } catch {} }, [post]);
  return <PostCard post={post} th={th} lang={lang} author={author} shadow={shadow} onOpen={open} onLike={open} onComments={open} onShare={open} onMore={open} onBookmark={open} bookmarked={false} />;
});

// ─── segmento ────────────────────────────────────────────────────────────────
function Segmented({ value, onChange, th, t }) {
  const labels = { foryou: t('mural.feed.forYou', 'Para você'), following: t('mural.feed.following', 'Seguindo'), reels: t('mural.feed.reels', 'Reels') };
  return (
    <View style={[s.seg, { backgroundColor: th.chip }]} accessibilityRole="tablist">
      {MURAL_SEGMENTS.map((k) => {
        const on = value === k;
        return (
          <Pressable key={k} onPress={() => onChange(k)} style={[s.segBtn, on && [{ backgroundColor: th.card }, th.isDark ? null : s.segOnShadow]]}
            accessibilityRole="tab" accessibilityState={{ selected: on }}>
            {k === 'reels' ? <ReelGlyph size={15} color={on ? th.text : th.muted} /> : null}
            <Text style={[s.segTxt, { color: on ? th.text : th.muted }]} numberOfLines={1}>{labels[k]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// Por cima do vídeo (segmento Reels): voltar | Para você | Seguindo | Reels — a câmera
// (criar reel) continua à direita, desenhada pelo próprio ReelsViewer.
function ReelsTopBar({ top, onChange, t }) {
  const tab = (k, label, on) => (
    <Pressable key={k} onPress={() => onChange(k)} hitSlop={8} accessibilityRole="tab" accessibilityState={{ selected: on }} style={s.rtTab}>
      <Text style={[s.rtTxt, on && s.rtTxtOn]} numberOfLines={1}>{label}</Text>
      <View style={[s.rtInd, !on && { backgroundColor: 'transparent' }]} />
    </Pressable>
  );
  return (
    <View style={[s.rtWrap, { top }]} pointerEvents="box-none">
      <Pressable onPress={() => onChange('foryou')} hitSlop={8} style={s.rtBack} accessibilityRole="button" accessibilityLabel={t('mural.feed.backToFeed', 'Voltar ao feed')}>
        <MIcon name="back" size={24} color="#fff" strokeWidth={2.2} />
      </Pressable>
      <View style={s.rtTabs} pointerEvents="box-none" accessibilityRole="tablist">
        {tab('foryou', t('mural.feed.forYou', 'Para você'), false)}
        {tab('following', t('mural.feed.following', 'Seguindo'), false)}
        {tab('reels', t('mural.feed.reels', 'Reels'), true)}
      </View>
    </View>
  );
}

// ─── a aba ───────────────────────────────────────────────────────────────────
function MuralHomeTab(props) {
  const { colors, isDark, t, user, router, tabActive, segment = 'foryou', onSegmentChange, requestOpenStatus, requestNewStatus } = props;
  const th = useMuralTheme();
  const insets = useSafeAreaInsets();
  const { language } = useLanguage() || {};
  const lang = language || 'pt-BR';
  const active = tabActive === 'mural';
  const seg = MURAL_SEGMENTS.includes(segment) ? segment : 'foryou';
  const setSeg = useCallback((k) => { try { require('../../constants/theme').haptic.select(); } catch {} onSegmentChange && onSegmentChange(k); }, [onSegmentChange]);

  const forYou = useMuralFeed('foryou', active && seg === 'foryou', t);
  const following = useMuralFeed('following', active && seg === 'following', t);
  const feed = seg === 'following' ? following : forYou;

  const [reelsMounted, setReelsMounted] = useState(seg === 'reels');
  useEffect(() => { if (seg === 'reels' && active) setReelsMounted(true); }, [seg, active]);

  // post publicado pela fila → recarrega a 1ª página das duas abas
  const loadFy = forYou.load; const loadFo = following.load;
  useEffect(() => {
    let off = null;
    try { off = require('../../services/profilePostQueue').onProfilePostPublished(() => { loadFy('refresh'); loadFo('refresh'); }); } catch {}
    return () => { try { off && off(); } catch {} };
  }, [loadFy, loadFo]);
  // voltou para a aba depois de um tempo → atualiza em 2º plano
  const lastActive = useRef(0);
  useEffect(() => {
    if (!active || seg === 'reels') return;
    const now = Date.now();
    if (lastActive.current && now - lastActive.current > 120000) feed.load('refresh');
    lastActive.current = now;
  }, [active, seg]); // eslint-disable-line react-hooks/exhaustive-deps

  const me = useMemo(() => ({ email: user?.email || '', name: user?.name || String(user?.email || '').split('@')[0] }), [user?.email, user?.name]);
  const pendingRaw = usePendingProfilePosts(me.email);
  const pending = useMemo(() => {
    const ids = new Set(feed.posts.map((p) => String(p.id)));
    return (pendingRaw || []).map(normPost).filter((p) => p && !ids.has(String(p.id)));
  }, [pendingRaw, feed.posts]);

  // [2026-10-20 grafite] sombra de cartão do tema v2 (0 1 2 /3,5% + 0 8 24 /4,5%; escuro = reflexo interno)
  const shadow = THEME_V2 ? cardShadow(th.isDark) : th.isDark ? null : (Platform.OS === 'web' ? { boxShadow: '0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06)' } : { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 1 });

  // [mural-cerebro 2026-10-20] "Não tenho interesse" / ocultar autor somem na hora (o servidor tira da sessão também)
  const [hidden, setHidden] = useState(() => ({ ids: new Set(), authors: new Set() }));
  const hide = useCallback((id, author, on) => setHidden((h) => {
    const ids = new Set(h.ids); const authors = new Set(h.authors);
    if (id) { if (on) ids.add(String(id)); else ids.delete(String(id)); }
    if (author) { if (on) authors.add(String(author).toLowerCase()); else authors.delete(String(author).toLowerCase()); }
    return { ids, authors };
  }), []);
  const ctxFor = useMemo(() => ({ fs: feed.fs, tab: seg }), [feed.fs, seg]);
  const onMore = useCallback((raw) => {
    let pc = null;
    try { pc = require('../../services/profilePostComposer'); } catch { pc = null; }
    if (!pc || !pc.showActionMenu) return;
    const toast = (o) => { try { require('../ui/Toast').showToast(o); } catch {} };
    const mine = !!(raw.is_mine || String(raw.author?.email || '').toLowerCase() === me.email.toLowerCase());
    const share = { label: t('mural.share', 'Compartilhar'), onPress: () => { signals.trackMural(raw.id, 'share', ctxFor); sharePost({ id: raw.id, caption: raw.text || '' }, t); } };
    const opts = [];
    if (mine) {
      opts.push(share);
      opts.push({ label: t('mural.delete', 'Apagar'), destructive: true, onPress: () => {
        const go = async () => {
          const ok = await store.deletePost(raw.id);
          toast({ message: ok ? t('mural.deleted', 'Publicação apagada') : t('mural.err.delete', 'Não foi possível apagar'), kind: ok ? 'success' : 'error' });
        };
        // [2026-10-21 fix] confirma antes de apagar (igual ao visualizador)
        const msg = t('mural.deleteMsg', 'Ela some do seu perfil para todo mundo. Não dá para desfazer.');
        if (Platform.OS === 'web') { if (typeof window === 'undefined' || !window.confirm || window.confirm(msg)) go(); return; }
        const { Alert } = require('react-native');
        setTimeout(() => Alert.alert(t('mural.deleteTitle', 'Apagar publicação?'), msg, [
          { text: t('common.cancel', 'Cancelar'), style: 'cancel' },
          { text: t('mural.delete', 'Apagar'), style: 'destructive', onPress: go },
        ]), Platform.OS === 'ios' ? 350 : 0);
      } });
    } else {
      const au = raw.author || {};
      const auName = au.name || String(au.email || '').split('@')[0];
      opts.push({ label: t('mural.why.menu', 'Por que estou vendo isto?'), onPress: async () => {
        let text = raw.rec ? signals.whyText(raw.rec, t) : '';
        if (!text) { const d = await signals.muralWhy(raw.id, ctxFor); text = signals.whyText(d && d.why, t); }
        const foot = t('mural.why.foot', 'O Mural aprende com o que você vê, curte e comenta aqui no Chatyy. Você pode desligar isso em Ajustes > Privacidade.');
        try { require('../../utils/confirm').alertAsync(t('mural.why.title', 'Por que estou vendo isto?'), `${text}\n\n${foot}`); } catch {}
      } });
      opts.push({ label: t('mural.notInterested', 'Não tenho interesse'), onPress: () => {
        hide(raw.id, null, true);
        signals.muralFeedback(raw.id, 'not_interested', ctxFor);
        toast({ message: t('mural.notInterestedDone', 'Ok, você verá menos publicações assim'), kind: 'success',
          action: { label: t('mural.undo', 'Desfazer'), onPress: () => { hide(raw.id, null, false); signals.muralFeedback(raw.id, 'undo_not_interested', ctxFor); } } });
      } });
      opts.push({ label: t('mural.hideAuthor', 'Ocultar publicações de {name}').replace('{name}', auName), onPress: () => {
        hide(null, au.email, true);
        signals.muralFeedback(raw.id, 'hide_author', { ...ctxFor, author: au.email });
        toast({ message: t('mural.hideAuthorDone', 'Você não verá mais publicações de {name} no Mural').replace('{name}', auName), kind: 'success',
          action: { label: t('mural.undo', 'Desfazer'), onPress: () => { hide(null, au.email, false); signals.muralFeedback(raw.id, 'undo_hide_author', { ...ctxFor, author: au.email }); } } });
      } });
      opts.push(share);
      opts.push({ label: t('mural.report', 'Denunciar'), destructive: true, onPress: () => { reportPost(raw.id).then((ok) => { if (ok) { hide(raw.id, null, true); toast({ message: t('mural.feed.reported', 'Obrigado. Vamos analisar.'), kind: 'success' }); } }); } });
    }
    // Android: o Alert só mostra 3 botões → as 2 primeiras + "Mais opções"
    if (Platform.OS === 'android' && opts.length > 3) {
      const rest = opts.slice(2);
      pc.showActionMenu({ options: [opts[0], opts[1], { label: t('mural.moreOptions', 'Mais opções'), onPress: () => setTimeout(() => pc.showActionMenu({ options: rest, cancelLabel: t('common.cancel', 'Cancelar') }), 250) }], cancelLabel: t('common.cancel', 'Cancelar') });
      return;
    }
    pc.showActionMenu({ options: opts, cancelLabel: t('common.cancel', 'Cancelar') });
  }, [me.email, t, ctxFor, hide]);

  const openComposer = useCallback((mode) => {
    try { muralNav.openComposer({ router, mode, from: 'mural', ...(mode === 'photo' ? { pick: 'library' } : null) }); } catch {}
  }, [router]);

  // linhas: pendentes → posts (faixa de Reels depois do 2º no "Para você")
  const rows = useMemo(() => {
    const out = pending.map((p) => ({ k: 'pend', key: `pend${p.id}`, post: p }));
    const railAt = Number.isFinite(feed.railAt) ? feed.railAt : 1; // [mural-cerebro 2026-10-20] quem gosta de vídeo vê a faixa antes
    const vis = feed.posts.filter((p) => !hidden.ids.has(String(p.id)) && !hidden.authors.has(String((p.author && p.author.email) || '').toLowerCase()));
    vis.forEach((p, i) => {
      out.push({ k: 'post', key: `p${p.id}`, raw: p });
      if (seg === 'foryou' && i === railAt) out.push({ k: 'rail', key: 'rail' });
    });
    if (seg === 'foryou' && vis.length > 0 && vis.length <= railAt) out.push({ k: 'rail', key: 'rail' });
    return out;
  }, [pending, feed.posts, feed.railAt, seg, hidden]);

  const renderItem = useCallback(({ item }) => {
    if (item.k === 'rail') return <ReelsRail th={th} t={t} lang={lang} onOpen={() => setSeg('reels')} enabled={active} />;
    if (item.k === 'pend') return <PendingRow post={item.post} th={th} lang={lang} shadow={shadow} me={me} />;
    return <FeedRow raw={item.raw} th={th} lang={lang} shadow={shadow} onMore={onMore} ctx={ctxFor} />;
  }, [th, t, lang, shadow, me, onMore, setSeg, active, ctxFor]);

  // [mural-cerebro 2026-10-20] impressão = ≥50% na tela; o tempo visível vira dwell (services/muralSignals)
  const viewCtx = useRef(ctxFor);
  viewCtx.current = ctxFor;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50, minimumViewTime: 0 }).current;
  const viewing = useRef(new Set());
  const feedVisible = active && seg !== 'reels';
  const feedVisibleRef = useRef(feedVisible);
  feedVisibleRef.current = feedVisible;
  // [mural-rt 2026-10-22] curtidas/comentários ao vivo SÓ dos posts na tela (≥50%) com a aba visível
  const live = useRef(new Map()); // id -> desassinar
  const liveOn = (id) => { if (!id || live.current.has(id)) return; try { live.current.set(id, store.watchPost(id)); } catch {} };
  const liveOff = (id) => { const un = live.current.get(id); if (un) { live.current.delete(id); try { un(); } catch {} } };
  const liveOffAll = () => { for (const id of Array.from(live.current.keys())) liveOff(id); };
  const onViewableItemsChanged = useRef(({ changed }) => {
    for (const c of changed || []) {
      const it = c && c.item;
      if (!it || it.k !== 'post' || !it.raw) continue;
      if (c.isViewable) { viewing.current.add(it.raw.id); if (feedVisibleRef.current) { signals.muralViewStart(it.raw.id, viewCtx.current); liveOn(it.raw.id); } }
      else { viewing.current.delete(it.raw.id); signals.muralViewEnd(it.raw.id); liveOff(it.raw.id); }
    }
  }).current;
  useEffect(() => {
    if (!feedVisible) { signals.endAllViews(); signals.flushMuralSignals(); liveOffAll(); return; }
    for (const id of viewing.current) { signals.muralViewStart(id, viewCtx.current); liveOn(id); } // voltou p/ a aba: o que está na tela conta de novo
  }, [feedVisible]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { signals.endAllViews(); signals.flushMuralSignals(); liveOffAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  let StoriesStrip = null;
  try { StoriesStrip = require('../ChatFeedTab').StoriesStrip || null; } catch { StoriesStrip = null; }

  const header = (
    <View>
      {StoriesStrip ? (
        <View style={s.stories}>
          <StoriesStrip user={user} colors={colors} background={th.bg} isDark={isDark} t={t} requestOpenStatus={requestOpenStatus} requestNewStatus={requestNewStatus} />
        </View>
      ) : null}
      <Pressable onPress={() => openComposer('text')} style={[s.compose, { backgroundColor: th.card }, shadow]} accessibilityRole="button" accessibilityLabel={t('mural.feed.whatsOnMind', 'No que você está pensando?')}>
        <Avatar email={me.email} name={me.name} size={38} />
        <View style={[s.composePh, { backgroundColor: th.chip }]}>
          <Text style={{ color: th.muted, fontSize: 14.5 }} numberOfLines={1}>{t('mural.feed.whatsOnMind', 'No que você está pensando?')}</Text>
        </View>
        <Pressable onPress={() => openComposer('photo')} hitSlop={6} style={s.composeIb} accessibilityRole="button" accessibilityLabel={t('mural.feed.photo', 'Foto')}>
          <MIcon name="image" size={22} color={th.text} />
        </Pressable>
      </Pressable>
      {seg === 'following' ? (
        <View style={s.note}>
          <MIcon name="users" size={14} color={th.muted} />
          <Text style={{ color: th.muted, fontSize: 13 }}>{t('mural.feed.followingNote', 'Só de quem você segue e dos seus contatos, em ordem de tempo')}</Text>
        </View>
      ) : null}
    </View>
  );

  const empty = feed.loaded && !feed.loading && !rows.length ? (
    <View style={s.empty}>
      <View style={[s.emptyIc, { backgroundColor: th.chip }]}>
        <MIcon name={feed.error ? 'globe' : seg === 'following' ? 'users' : 'edit'} size={30} color={th.muted} />
      </View>
      <Text style={[s.emptyTitle, { color: th.text }]}>{feed.error ? t('mural.feed.error', 'Não foi possível carregar o Mural') : t('mural.feed.empty', 'Nada por aqui ainda')}</Text>
      <Text style={[s.emptySub, { color: th.muted }]}>
        {feed.error ? t('mural.feed.errorSub', 'Verifique sua conexão e tente de novo.') : (seg === 'following' ? t('mural.feed.emptyFollowing', 'Siga pessoas ou converse com amigos para ver as publicações delas aqui.') : t('mural.feed.emptyForYou', 'Ainda não há publicações. Que tal fazer a primeira?'))}
      </Text>
      <Pressable onPress={() => (feed.error ? feed.load('first') : openComposer('text'))} style={[s.emptyBtn, { backgroundColor: th.accent }]} accessibilityRole="button">
        <Text style={{ color: th.accentInk, fontWeight: '700', fontSize: 15 }}>{feed.error ? t('mural.feed.retry', 'Tentar de novo') : t('mural.publish', 'Publicar')}</Text>
      </Pressable>
    </View>
  ) : (!feed.loaded && !feed.posts.length ? <PostSkeleton count={2} /> /* [2026-10-20 ux] skeleton em vez de spinner */ : null);

  // [2026-10-21 polish] pouco conteúdo (1-3 posts, fim da lista) → convite p/ publicar, no lugar do rodapé vazio
  const fewPosts = feed.loaded && !feed.loading && !feed.hasMore && rows.length > 0 && feed.posts.length > 0 && feed.posts.length <= 3;
  const invite = fewPosts ? (
    <View style={[s.invite, { backgroundColor: th.card }, shadow]}>
      <View style={[s.inviteIc, { backgroundColor: th.chip }]}>
        <MIcon name="edit" size={22} color={th.text} />
      </View>
      <Text style={[s.inviteTitle, { color: th.text }]}>{t('mural.feed.inviteTitle', 'Comece o seu mural')}</Text>
      <Text style={[s.emptySub, { color: th.muted, marginTop: 4 }]}>{t('mural.feed.inviteSub', 'Conte uma novidade ou compartilhe uma foto. Seus amigos veem aqui.')}</Text>
      <View style={s.inviteRow}>
        <Pressable onPress={() => openComposer('text')} style={[s.emptyBtn, { marginTop: 0, backgroundColor: th.accent }]} accessibilityRole="button">
          <Text style={{ color: th.accentInk, fontWeight: '700', fontSize: 15 }}>{t('mural.publish', 'Publicar')}</Text>
        </Pressable>
        <Pressable onPress={() => openComposer('photo')} style={[s.emptyBtn, s.inviteBtn2, { marginTop: 0, backgroundColor: th.chip }]} accessibilityRole="button" accessibilityLabel={t('mural.feed.photo', 'Foto')}>
          <MIcon name="image" size={18} color={th.text} />
          <Text style={{ color: th.text, fontWeight: '700', fontSize: 15 }}>{t('mural.feed.photo', 'Foto')}</Text>
        </Pressable>
      </View>
    </View>
  ) : null;
  const footer = feed.loading && feed.posts.length ? <ActivityIndicator style={{ marginVertical: 18 }} color={th.muted} />
    : invite || (feed.loaded && !feed.hasMore && feed.posts.length > 3 ? <Text style={[s.end, { color: th.muted }]}>{t('mural.feed.end', 'Você viu tudo')}</Text> : null);

  const reelsOn = seg === 'reels';
  const rtTop = Platform.OS === 'web' ? 10 : Math.max(insets.top || 0, Platform.OS === 'android' ? 24 : 44) + 2;

  return (
    <View style={[s.root, { backgroundColor: reelsOn ? '#000' : th.bg }]}>
      {/* Para você / Seguindo */}
      <View style={{ flex: 1, display: reelsOn ? 'none' : 'flex', paddingTop: insets.top }}>
        <View style={[s.head, { backgroundColor: th.bg }]}>
          <Text style={[s.title, { color: th.text }]} accessibilityRole="header">{t('chat.tabMural', 'Mural')}</Text>
        </View>
        <View style={{ backgroundColor: th.bg, paddingBottom: 6 }}>
          <Segmented value={seg} onChange={setSeg} th={th} t={t} />
        </View>
        <FlatList
          data={rows}
          keyExtractor={(it) => it.key}
          renderItem={renderItem}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          ListFooterComponent={footer}
          contentContainerStyle={{ paddingBottom: 24 }}
          onEndReachedThreshold={0.6}
          onEndReached={() => { if (feed.loaded && feed.hasMore && !feed.loading) feed.load('more'); }}
          refreshControl={<RefreshControl refreshing={!!feed.refreshing} onRefresh={() => feed.load('refresh')} tintColor={th.muted} />}
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
          initialNumToRender={5}
          maxToRenderPerBatch={5}
          windowSize={7}
          removeClippedSubviews={Platform.OS === 'android'}
          keyboardShouldPersistTaps="handled"
        />
      </View>
      {/* Reels — a mesma tela da antiga aba, tela cheia */}
      {reelsMounted ? (
        <View style={[StyleSheet.absoluteFill, { display: reelsOn ? 'flex' : 'none', backgroundColor: '#000' }]}>
          <React.Suspense fallback={<View style={{ flex: 1, backgroundColor: '#000' }} />}>
            <ReelsHomeTab colors={colors} isDark={isDark} t={t} user={user} router={router} tabActive={active && reelsOn ? 'reels' : 'mural'} hideHeaderTabs />
          </React.Suspense>
          {reelsOn ? <ReelsTopBar top={rtTop} onChange={setSeg} t={t} /> : null}
        </View>
      ) : null}
      <MuralCommentsHost enabled={active && !reelsOn} />
    </View>
  );
}

export default memo(MuralHomeTab);

const s = StyleSheet.create({
  root: { flex: 1 },
  head: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 2 },
  title: { fontSize: 34, fontWeight: '800', letterSpacing: -1.19 }, // [2026-10-21 polish] = título grande Grafite (Conversas)
  seg: { flexDirection: 'row', gap: 4, marginHorizontal: 16, marginTop: 8, borderRadius: THEME_V2 ? 999 : 12, padding: 3 },
  segBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 7, borderRadius: THEME_V2 ? 999 : 9 },
  segOnShadow: Platform.OS === 'web' ? { boxShadow: '0 1px 3px rgba(0,0,0,.12)' } : { shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segTxt: { fontSize: 14, fontWeight: '600' },
  stories: { marginBottom: 2 },
  compose: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 10, marginTop: 6, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: THEME_V2 ? 22 : 18 },
  composePh: { flex: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  composeIb: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  note: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, paddingBottom: 8 },
  rail: { marginHorizontal: 10, marginBottom: 8, borderRadius: THEME_V2 ? 22 : 18, paddingTop: 12, paddingBottom: 12 },
  railHead: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, marginBottom: 10 },
  railTitle: { flex: 1, fontSize: 15, fontWeight: '700' },
  railMore: { fontSize: 13.5, fontWeight: '600' },
  railTile: { width: 104, height: 168, borderRadius: THEME_V2 ? 14 : 12, overflow: 'hidden' },
  railMeta: { position: 'absolute', left: 7, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 3 },
  railMetaTxt: { color: '#fff', fontSize: 12, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 } },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 40 },
  emptyIc: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  invite: { alignItems: 'center', marginHorizontal: 10, marginTop: 4, marginBottom: 16, paddingHorizontal: 20, paddingVertical: 22, borderRadius: THEME_V2 ? 22 : 18 },
  inviteIc: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  inviteTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  inviteRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  inviteBtn2: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  emptyTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  emptySub: { fontSize: 14.5, textAlign: 'center', marginTop: 6, lineHeight: 20 },
  emptyBtn: { marginTop: 18, borderRadius: 999, paddingHorizontal: 22, paddingVertical: 11 },
  end: { textAlign: 'center', fontSize: 13, marginVertical: 18 },
  rtWrap: { position: 'absolute', left: 0, right: 92, height: 44, flexDirection: 'row', alignItems: 'center', zIndex: 30 },
  rtBack: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: 2 },
  rtTabs: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18 },
  rtTab: { alignItems: 'center' },
  rtTxt: { color: 'rgba(255,255,255,0.62)', fontSize: 15.5, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  rtTxtOn: { color: '#fff', fontWeight: '800' },
  rtInd: { width: 20, height: 2.5, borderRadius: 2, backgroundColor: '#fff', marginTop: 6 },
});
