// [mural 2026-10-20] Perfil novo — estilo Telegram + Mural (mockup aprovado
// /var/www/mail/preview-2026/perfil.html, telas 1 e 4).
//
// UMA tela JS para:
//   • perfil do CONTATO (aberto da conversa: "Dados do contato"; ou /u/<email>)
//   • MEU perfil (/u/<eu>)
// Uma única FlatList (Animated) = cabeçalho + abas FIXAS (stickyHeaderIndices)
// + conteúdo da aba (linhas de 3 da grade / cartões / itens da conversa) +
// rodapé com as opções da conversa. Paginação por cursor (profile_posts /
// chat_shared_items) no onEndReached — 100+ posts sem engasgar (linhas memo).
//
// Visual: P&B premium, cantos 14, sombras leves (claro), escuro true black;
// ícones SVG (TgIcons), textos pt-BR/pt-PT/en/es (tgStrings).
// Posts/comentários/compositor = components/mural via services/muralNav.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated, Platform, Switch, ActivityIndicator,
  useWindowDimensions, Share, ScrollView,
} from 'react-native';
import { useLanguage } from '../../../context/LanguageContext';
import Svg, { Defs, LinearGradient, Stop, Circle } from 'react-native-svg';
import FastImage from '../../FastImage';
import { GridSkeleton, PostSkeleton } from '../../SkeletonLoader';
import { SkeletonRows } from '../../Skeleton';
import TgIcon from './TgIcons';
import { tgT, useTgLang, presenceLine, relTime } from './tgStrings';
import { useTgProfileData, normPost, likePost, deletePost, reportPost, absUrl } from './useTgProfileData';
import { GridRow, MediaRow, PostCard, fmtN } from './TgPostTiles';
import { useMuralTheme } from '../../mural/muralTheme';
import { THEME_V2, Grafite, cardShadow } from '../../../constants/theme';
import { useTheme } from '../../../context/ThemeContext';
import { useStatusRing, openStatusFor } from '../../status/statusRingStore';
import { usePendingProfilePosts, mergePendingPosts, openPendingPostMenu } from '../../ProfilePostProgress';
import ProfilePostProgress from '../../ProfilePostProgress';
import * as muralNav from '../../../services/muralNav';
import { getDefaultAudience, loadDefaultAudience, setDefaultAudience, subscribeDefaultAudience } from '../../../services/muralPrefs';

export function isTgProfileEnabled() {
  try { if (globalThis.__chatyy_profile_tg === false) return false; } catch {}
  return true;
}

const BAR_H = 52;
const AUD_ICON = { public: 'globe', contacts: 'users', private: 'lock' };
const AUD_KEY = { public: 'audEveryone', contacts: 'audContacts', private: 'audMe' };
// Linhas da conversa (descritores do chat-conversation) → seções do rodapé.
const CONSUMED = new Set(['about', 'media', 'starred', 'notif', 'profile', 'pp_posts_all', 'pp_posts']);
const CONV_IDS = ['customNotif', 'wallpaper', 'disappearing', 'chatLock'];
const PRIV_IDS = ['mediaVis', 'e2e', 'advPriv'];

function _menu(opts) {
  try { require('../../../services/profilePostComposer').showActionMenu(opts); } catch {}
}
function _alert(title, msg, buttons) {
  try { require('../../../services/alerts').safeAlert(title, msg, buttons); return; } catch {}
  try { require('react-native').Alert.alert(title, msg, buttons); } catch {}
}
function _initials(name, email) {
  const src = String(name || '').trim() || String(email || '').split('@')[0] || '';
  const parts = src.replace(/[._-]+/g, ' ').split(/\s+/).filter(Boolean);
  const a = Array.from(parts[0] || '')[0] || '';
  const b = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] || '') : '';
  return (a + b).toUpperCase();
}
function _avatarRef(email, name) {
  if (!email) return null;
  try { return require('../../chat/NativeProfileBridge').avatarRefForEmail(email, name, 'full'); } catch { return null; }
}
function _chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function _ts(d) {
  if (!d) return 0;
  try { const api = require('../../../services/api'); const x = api.parseServerDate ? api.parseServerDate(d) : new Date(d); const n = x && x.getTime ? x.getTime() : NaN; return Number.isFinite(n) ? n : 0; } catch { return 0; }
}
function _fmtSize(b) {
  const n = Number(b) || 0;
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
}
function _host(u) { const m = /^https?:\/\/([^/?#]+)/i.exec(String(u || '')); return m ? m[1].replace(/^www\./, '') : ''; }
function _firstUrl(s) { const m = /https?:\/\/[^\s<>"']+/i.exec(String(s || '')); return m ? m[0] : ''; }
const DOC_COLORS = { PDF: '#e5484d', XLS: '#2f9e44', XLSX: '#2f9e44', CSV: '#2f9e44', DOC: '#1c7ed6', DOCX: '#1c7ed6', PPT: '#e8590c', PPTX: '#e8590c', ZIP: '#6d6d72' };

// ── Avatar com anel de status ────────────────────────────────────────────────
function Avatar({ size, email, name, uri, headers, th, ring, onPress, label }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [uri]);
  const inner = (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: THEME_V2 ? (th.isDark ? Grafite.dark.avatarNone[0] : Grafite.light.avatarNone[1]) : (th.isDark ? '#3a3a3c' : '#2c2c2e'), alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <Text style={{ color: THEME_V2 ? (th.isDark ? Grafite.dark.text2 : '#FFFFFF') : '#fff', fontSize: size * 0.36, fontWeight: '600' }}>{_initials(name, email)}</Text>
      {uri && !failed ? <FastImage source={headers ? { uri, headers } : { uri }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(true)} /> : null}
    </View>
  );
  const outer = ring ? size + 12 : size;
  const body = ring ? (
    <View style={{ width: outer, height: outer, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={outer} height={outer} style={StyleSheet.absoluteFill}>
        <Defs>
          {THEME_V2 && ring !== 'seen' ? (
            // [2026-10-20 grafite] anel prateado (aproxima o gradiente cônico do mockup)
            <LinearGradient id="tgRing" x1="0.15" y1="0" x2="0.85" y2="1">
              {(th.isDark ? Grafite.dark.ring : Grafite.light.ring).map((c, i, a) => <Stop key={i} offset={String(i / (a.length - 1))} stopColor={c} />)}
            </LinearGradient>
          ) : (
            <LinearGradient id="tgRing" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={ring === 'seen' ? th.muted : th.text} />
              <Stop offset="0.5" stopColor={th.muted} />
              <Stop offset="1" stopColor={ring === 'seen' ? th.muted : th.text} />
            </LinearGradient>
          )}
        </Defs>
        <Circle cx={outer / 2} cy={outer / 2} r={outer / 2 - 1.5} stroke="url(#tgRing)" strokeWidth={3} fill="none" />
      </Svg>
      {inner}
    </View>
  ) : inner;
  if (!onPress) return body;
  return <Pressable onPress={onPress} accessibilityRole="imagebutton" accessibilityLabel={label}>{body}</Pressable>;
}

function SmallAvatar({ size, email, name, th }) {
  const ref = useMemo(() => _avatarRef(email, name), [email, name]);
  return <Avatar size={size} email={email} name={name} uri={ref && ref.uri} headers={ref && ref.headers} th={th} />;
}

// [2026-10-20 grafite] ícone em ladrilho grafite (raio 10, gradiente + reflexo de 1 px).
const _tileCache = {};
function _tileStyle(dark) {
  const k = dark ? 'd' : 'l';
  if (_tileCache[k]) return _tileCache[k];
  const g = dark ? Grafite.dark : Grafite.light;
  const grad = `linear-gradient(160deg, ${g.tile[0]} 0%, ${g.tile[1]} 100%)`;
  const sh = 'inset 0px 1px 0px rgba(255,255,255,0.18), 0px 2px 6px rgba(0,0,0,0.12)';
  _tileCache[k] = Platform.OS === 'web'
    ? { backgroundColor: g.tile[1], backgroundImage: grad, boxShadow: sh, borderRadius: Grafite.radius.tile }
    : { backgroundColor: g.tile[1], experimental_backgroundImage: grad, boxShadow: sh, borderRadius: Grafite.radius.tile };
  return _tileCache[k];
}

// ── Linha agrupada (cartão) ─────────────────────────────────────────────────
function Row({ th, icon, title, sub, value, dest, chevron = true, onPress, right, first, inset }) {
  const color = dest ? th.danger : th.text;
  return (
    <Pressable onPress={onPress} disabled={!onPress && !right} style={({ pressed }) => [s.row, pressed && onPress && { backgroundColor: th.chip }]} accessibilityRole={onPress ? 'button' : undefined}>
      {!first ? <View style={[s.sep, { left: icon ? 56 : 14, backgroundColor: th.line }]} /> : null}
      {icon ? (
        <View style={[s.icBox, { backgroundColor: dest ? 'rgba(229,72,77,0.12)' : th.chip }, THEME_V2 && !dest && _tileStyle(th.isDark)]}>
          <TgIcon name={icon} size={18} color={THEME_V2 && !dest ? Grafite.light.tileText : color} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.rowV, { color }]} numberOfLines={inset ? undefined : 2}>{title}</Text>
        {sub ? <Text style={[s.rowK, { color: th.muted }]} numberOfLines={2}>{sub}</Text> : null}
      </View>
      {right || null}
      {!right && (value || (onPress && chevron)) ? (
        <View style={s.rv}>
          {value ? <Text style={[s.rvTxt, { color: th.muted }]} numberOfLines={1}>{value}</Text> : null}
          {onPress && chevron && !dest ? <TgIcon name="chev" size={18} color={th.muted} /> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function Card({ th, shadow, children, style }) {
  return <View style={[s.grp, { backgroundColor: th.card }, shadow, style]}>{children}</View>;
}

/**
 * props:
 *   mode 'contact' | 'self'
 *   email, username, seed { name }
 *   contact { conversationId, presence, muted, onMute, onUnmute, actions{call,video,search,message},
 *             onFavorites, onAvatarPress(i), rows[], openGroup(g), moreMenu[] }
 *   self    { onEdit, onShare }
 *   onBack, backLabel, topInset, bottomInset, router, initialTab
 */
export default function TgProfileView(props) {
  const { mode = 'contact', email, username, seed = {}, contact = {}, self: selfCb = {}, onBack, topInset = 0, bottomInset = 0 } = props;
  const router = props.router || (() => { try { return require('expo-router').router; } catch { return null; } })();
  const isSelf = mode === 'self';
  const th = useMuralTheme();
  const { colors } = useTheme() || {};
  const { t } = useLanguage() || {};
  const lang = useTgLang();
  const tr = useCallback((k, v) => tgT(lang, k, v), [lang]);
  const { width } = useWindowDimensions();
  // data pronto (TgUserProfile já busca p/ decidir dono/visitante) → hook próprio fica parado.
  const ownData = useTgProfileData({ email, username, self: isSelf, conversationId: contact.conversationId || null, enabled: !props.data });
  const data = props.data || ownData;
  const ident = data.identity || {};
  const em = data.email || String(email || '').toLowerCase();
  const name = ident.name || seed.name || String(em).split('@')[0] || String(username || '');
  const handle = ident.username || '';
  const shadow = THEME_V2 ? cardShadow(th.isDark) : th.isDark ? null : (Platform.OS === 'web' ? { boxShadow: '0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06)' } : { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 1 });

  // ── estado da tela ──
  const [tab, setTab] = useState(props.initialTab === 'media' ? 'media' : 'posts');
  const [view, setView] = useState(isSelf ? 'list' : 'grid');
  const [bookmarks, setBookmarks] = useState({});
  const [viewer, setViewer] = useState(null);
  const [audience, setAud] = useState(getDefaultAudience());
  const [noteSheet, setNoteSheet] = useState(false);
  const [mutedLocal, setMutedLocal] = useState(null);
  useEffect(() => { setMutedLocal(null); }, [contact.muted]);
  useEffect(() => {
    if (!isSelf) return undefined;
    loadDefaultAudience().then(setAud).catch(() => {});
    return subscribeDefaultAudience(setAud);
  }, [isSelf]);

  // Minha nota (sheet de Ajustes) / nota do contato (profile_note_get).
  let myNote = null;
  try { myNote = require('../../../services/profileNote').useProfileNote(); } catch { myNote = null; }
  const note = isSelf ? (myNote || data.note) : data.note;

  const ringInfo = useStatusRing(em);
  const ring = ringInfo && ringInfo.count ? (ringInfo.allViewed ? 'seen' : 'unseen') : (data.stories.length ? 'unseen' : '');
  const avRef = useMemo(() => _avatarRef(em, name), [em, name, ident.avatar_version]); // eslint-disable-line react-hooks/exhaustive-deps

  // posts (+ otimistas da fila no MEU perfil)
  const pendingRaw = usePendingProfilePosts(isSelf ? em : '');
  const posts = useMemo(() => {
    const server = data.posts.items;
    if (!isSelf || !pendingRaw.length) return server;
    return mergePendingPosts(pendingRaw.map(normPost).filter(Boolean), server);
  }, [isSelf, pendingRaw, data.posts.items]);

  const muted = mutedLocal != null ? mutedLocal : !!contact.muted;
  const presence = isSelf ? tr('online') : (contact.presence || presenceLine(lang, data.presence));

  // ── rolagem / barra ──
  const listRef = useRef(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const yRef = useRef(0);
  const hdrH = useRef(0);
  const onScroll = useMemo(() => Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    { useNativeDriver: Platform.OS !== 'web', listener: (e) => { yRef.current = e.nativeEvent.contentOffset.y; } },
  ), [scrollY]);
  const barOp = scrollY.interpolate({ inputRange: [150, 200], outputRange: [0, 1], extrapolate: 'clamp' });
  const ttlY = scrollY.interpolate({ inputRange: [150, 200], outputRange: [6, 0], extrapolate: 'clamp' });

  const pinTabs = useCallback((animated) => {
    const h = hdrH.current;
    if (!h || !listRef.current) return;
    try { (listRef.current.scrollToOffset ? listRef.current : listRef.current.getNode?.())?.scrollToOffset({ offset: h, animated }); } catch {}
  }, []);

  const selectTab = useCallback((k) => {
    setTab(k);
    if (yRef.current > hdrH.current) requestAnimationFrame(() => pinTabs(false));
  }, [pinTabs]);

  // aba aberta → carrega
  useEffect(() => {
    if (tab === 'groups') { if (data.groups == null) data.loadGroups(); return; }
    if (!isSelf && (tab === 'media' || tab === 'links' || tab === 'docs' || tab === 'voice')) data.loadShared(tab, false);
  }, [tab, data.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ações de post ──
  const rawOf = useCallback((p) => ({ ...(p.raw || {}), id: p.id, like_count: p.like_count, liked_by_me: p.liked_by_me, comment_count: p.comment_count }), []);
  const openPost = useCallback((p) => {
    if (!p) return;
    if (p.__pending) { openPendingPostMenu(p.raw || p); return; }
    try { muralNav.openPost(rawOf(p), { router }); } catch {}
  }, [rawOf, router]);
  const onComments = useCallback((p) => { try { muralNav.openComments(rawOf(p), { router, post: rawOf(p) }); } catch {} }, [rawOf, router]);
  const onLike = useCallback(async (p) => {
    const like = !p.liked_by_me;
    data.patchPost(p.id, (q) => ({ liked_by_me: like, like_count: Math.max(0, (q.like_count || 0) + (like ? 1 : -1)) }));
    try { require('../../../services/haptics').hapticEvent?.('selection'); } catch {}
    const r = await likePost(p.id, like);
    if (!r.ok) data.patchPost(p.id, (q) => ({ liked_by_me: !like, like_count: Math.max(0, (q.like_count || 0) + (like ? -1 : 1)) }));
    else if (r.like_count != null && r.liked != null) data.patchPost(p.id, { liked_by_me: r.liked, like_count: r.like_count });
  }, [data]);
  const postUrl = (p) => `https://chatyy.com.br/feed/${encodeURIComponent(String(p.id))}`;
  const onShare = useCallback((p) => { try { Share.share(Platform.OS === 'ios' ? { url: postUrl(p) } : { message: postUrl(p) }); } catch {} }, []);
  const onBookmark = useCallback((p) => {
    setBookmarks((b) => ({ ...b, [p.id]: !b[p.id] }));
    try { require('../../../services/api').feedBookmark(p.id); } catch {}
  }, []);
  const onMore = useCallback((p) => {
    const copy = { label: tr('copyLink'), onPress: () => { try { require('expo-clipboard').setStringAsync(postUrl(p)); } catch {} } };
    if (isSelf) {
      _menu({
        options: [
          copy,
          { label: tr('deletePost'), destructive: true, onPress: () => _alert(tr('deletePost'), '', [
            { text: tr('cancel'), style: 'cancel' },
            { text: tr('deletePost'), style: 'destructive', onPress: async () => { data.removePost(p.id); const ok = await deletePost(p.id); if (!ok) data.reloadPosts(); } },
          ]) },
        ],
        cancelLabel: tr('cancel'),
      });
    } else {
      _menu({ options: [copy, { label: tr('reportPost'), destructive: true, onPress: () => { reportPost(p.id).then((ok) => { if (ok) _alert(tr('done'), ''); }); } }], cancelLabel: tr('cancel') });
    }
  }, [isSelf, tr, data]);

  // ── conversa: notificações ──
  const onToggleNotif = useCallback((on) => {
    // on = notificações ATIVADAS → reativar som; off → mesma folha/lógica de silenciar de hoje
    if (on) { setMutedLocal(false); try { contact.onUnmute && contact.onUnmute(); } catch {} return; }
    if (contact.onMuteFor) {
      const mk = (d, k) => ({ label: tr(k), onPress: () => { setMutedLocal(true); try { contact.onMuteFor(d); } catch {} } });
      _menu({ title: tr('notifications'), options: [mk('8h', 'mute8h'), mk('1w', 'mute1w'), mk('forever', 'muteAlways')], cancelLabel: tr('cancel') });
      return;
    }
    if (contact.onMute) { try { contact.onMute(); } catch {} }
  }, [contact, tr]);

  // ── mídia / docs / voz ──
  const openMediaItem = useCallback((it, list) => {
    if (!it || !it.file_url) return;
    const isVid = it.type === 'video' || it.type === 'video_note';
    let mediaList;
    let initialIndex = 0;
    if (Array.isArray(list) && list.length > 1) {
      mediaList = list.filter((x) => x && x.file_url).map((x) => ({ fileUrl: x.file_url, fileName: x.file_name || ((x.type === 'video' || x.type === 'video_note') ? 'video.mp4' : 'image.jpg'), fileSize: x.file_size || 0, type: (x.type === 'video' || x.type === 'video_note') ? 'video' : 'image', messageId: x.id, createdAt: x.created_at || null, senderEmail: x.sender_email || '' }));
      initialIndex = Math.max(0, mediaList.findIndex((x) => String(x.messageId) === String(it.id)));
    }
    setViewer({ fileUrl: it.file_url, fileName: it.file_name || 'media', fileSize: it.file_size || 0, type: isVid ? 'video' : (it.type === 'file' ? 'file' : (it.type || 'image')), messageId: it.id, senderEmail: it.sender_email || '', createdAt: it.created_at || null, mediaList, initialIndex });
  }, []);
  const playVoice = useCallback((it) => {
    if (!it || !it.file_url) return;
    try {
      const VN = require('../../../services/voiceNotePlayer');
      const st0 = VN.getVoiceState && VN.getVoiceState();
      if (st0 && st0.item && String(st0.item.messageId) === String(it.id)) { VN.toggleVoiceNote({ messageId: it.id }); return; }
      let uri = String(it.file_url);
      if (uri.startsWith('/')) uri = `${require('../../../services/api').BASE_URL}${uri}`;
      try { uri = require('../../../services/mediaCache').playableAudioUrl(uri) || uri; } catch {}
      VN.playVoiceNote({ messageId: it.id, url: it.file_url, uri, conversationId: data.conversationId, durationMs: Math.max(0, (Number(it.duration) || 0) * 1000) }).catch(() => {});
    } catch {}
  }, [data.conversationId]);
  const openLinkItem = useCallback((url) => {
    if (!url) return;
    try { require('../../../services/openLink').openLink(url, { colors }); } catch {}
  }, [colors]);
  const openGroup = useCallback((g) => {
    if (contact.openGroup) { contact.openGroup(g); return; }
    try { require('../../../services/openConversation').openConversation({ pathname: '/chat-conversation', params: { id: g.id, name: g.name || '', type: 'group' } }); } catch {}
  }, [contact]);

  // ── abas ──
  const counts = data.counts || {};
  const groupsList = data.groups || contact.commonGroups || null;
  const tabs = useMemo(() => {
    const postsN = counts.posts != null ? counts.posts : (data.posts.loaded && !data.posts.hasMore ? posts.length : null);
    if (isSelf) return [['posts', tr('tabPosts'), postsN], ['media', tr('tabMedia'), counts.photos != null ? counts.photos : null]];
    return [
      ['posts', tr('tabPosts'), postsN],
      ['media', tr('tabMedia'), counts.media],
      ['links', tr('tabLinks'), counts.links],
      ['docs', tr('tabDocs'), counts.docs],
      ['voice', tr('tabVoice'), counts.voice],
      ['groups', tr('tabGroups'), counts.groups != null ? counts.groups : (groupsList ? groupsList.length : null)],
    ];
  }, [isSelf, tr, counts, data.posts.loaded, data.posts.hasMore, posts.length, groupsList]);

  // ── itens da lista ──
  const items = useMemo(() => {
    const out = [{ k: 'hdr', key: 'hdr' }, { k: 'tabs', key: 'tabs' }];
    const state = (st, emptyKey, hint) => {
      if (st.loading && !st.items.length) out.push({ k: 'spin', key: 'spin' });
      else if (st.error && !st.items.length) out.push({ k: 'err', key: 'err' });
      else if (st.loaded && !st.items.length) out.push({ k: 'empty', key: 'empty', text: tr(emptyKey), hint });
    };
    if (tab === 'posts') {
      out.push({ k: 'tool', key: 'tool' });
      if (isSelf) out.push({ k: 'compose', key: 'compose' });
      if (view === 'grid') _chunk(posts, 3).forEach((row) => out.push({ k: 'g', key: `g${row[0].id}`, row }));
      else posts.forEach((p) => out.push({ k: 'c', key: `c${p.id}`, post: p }));
      if (!posts.length) state({ ...data.posts, items: posts }, 'noPosts', isSelf ? tr('noPostsSelf') : '');
      else if (data.posts.loading) out.push({ k: 'more', key: 'more' });
      return out;
    }
    if (tab === 'groups') {
      if (groupsList == null) out.push({ k: 'spin', key: 'spin' });
      else if (!groupsList.length) out.push({ k: 'empty', key: 'empty', text: tr('noGroups') });
      else groupsList.forEach((g) => out.push({ k: 'grp', key: `grp${g.id}`, g }));
      return out;
    }
    if (isSelf && tab === 'media') {
      const vis = [];
      posts.forEach((p) => { if (p.media.length && !p.__pending) vis.push({ key: `pm${p.id}`, thumb: p.media[0].thumb || p.media[0].url, video: p.media[0].type === 'video', post: p }); });
      if (!vis.length) out.push({ k: 'empty', key: 'empty', text: tr('noMedia'), hint: tr('myMediaHint') });
      else _chunk(vis, 3).forEach((row) => out.push({ k: 'm', key: `m${row[0].key}`, row }));
      return out;
    }
    if (!data.conversationId) { out.push({ k: 'empty', key: 'empty', text: tr(tab === 'media' ? 'noMedia' : tab === 'links' ? 'noLinks' : tab === 'docs' ? 'noDocs' : 'noVoice'), hint: tr('noConvMedia') }); return out; }
    const st = data.shared[tab];
    if (tab === 'media') {
      let curMonth = '';
      let bucket = [];
      const flush = () => { _chunk(bucket, 3).forEach((row) => out.push({ k: 'm', key: `m${row[0].key}`, row })); bucket = []; };
      for (const it of st.items) {
        if (!it || !it.file_url) continue;
        const ts = _ts(it.created_at);
        let mon = '';
        try { mon = ts ? new Date(ts).toLocaleDateString(lang, { month: 'long', year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : ''; } catch {}
        if (mon !== curMonth) { flush(); curMonth = mon; if (mon) out.push({ k: 'mg', key: `mg${mon}${it.id}`, label: mon.charAt(0).toUpperCase() + mon.slice(1) }); }
        const isVid = it.type === 'video' || it.type === 'video_note';
        const thumb = absUrl(it.thumb_url || (isVid ? '' : it.file_url));
        let headers = null;
        try { if (/\/api\//.test(thumb)) headers = require('../../../services/avatar').avatarSource(thumb)?.headers || null; } catch {}
        bucket.push({ key: `sm${it.id}`, thumb, headers, video: isVid, it });
      }
      flush();
    } else {
      st.items.forEach((it) => out.push({ k: tab, key: `${tab}${it.id}|${it.url || ''}`, it }));
    }
    state(st, tab === 'media' ? 'noMedia' : tab === 'links' ? 'noLinks' : tab === 'docs' ? 'noDocs' : 'noVoice');
    if (st.loading && st.items.length) out.push({ k: 'more', key: 'more' });
    return out;
  }, [tab, view, posts, data.posts, data.shared, data.conversationId, groupsList, isSelf, tr, lang]);

  const onEndReached = useCallback(() => {
    if (tab === 'posts' || (isSelf && tab === 'media')) { if (data.posts.hasMore && !data.posts.loading) data.loadMorePosts(); return; }
    if (tab !== 'groups') data.loadShared(tab, true);
  }, [tab, isSelf, data]);

  // ── cabeçalho ──
  const actions = contact.actions || {};
  const actBtn = ({ icon, label, onPress, pri, hl }) => (
    <Pressable key={icon} onPress={onPress} style={({ pressed }) => [s.act, { backgroundColor: pri ? th.accent : th.card, transform: [{ scale: pressed ? 0.96 : 1 }] }, !pri && shadow, hl && { borderWidth: 1.5, borderColor: th.text }]} accessibilityRole="button" accessibilityLabel={label}>
      <TgIcon name={icon} size={24} color={pri ? th.accentInk : th.text} />
      <Text style={[s.actTxt, { color: pri ? th.accentInk : th.text }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );

  const onAvatar = useCallback(() => {
    if (ring && em) {
      if (openStatusFor(em)) return;
      try { (router || require('expo-router').router).push(`/u/${encodeURIComponent(em)}?openStatus=1`); } catch {}
      return;
    }
    if (contact.onAvatarPress) { try { contact.onAvatarPress(0); } catch {} return; }
    try {
      const PP = require('../../../services/profilePhotos');
      PP.fetchProfilePhotos(em).then((r) => PP.openProfilePhotoGallery({ email: em, name, photos: (r && r.photos) || [], avatarUrl: avRef && avRef.uri, index: 0, isSelf })).catch(() => {});
    } catch {}
  }, [ring, em, contact, router, name, avRef, isSelf]);

  const header = (
    <View onLayout={(e) => { hdrH.current = e.nativeEvent.layout.height; }} style={{ backgroundColor: th.bg }}>
      <View style={s.hd}>
        <Avatar size={104} email={em} name={name} uri={avRef && avRef.uri} headers={avRef && avRef.headers} th={th} ring={ring} onPress={onAvatar} label={name} />
        <Text style={[s.h1, { color: th.text }]} numberOfLines={2}>{name}</Text>
        {handle ? <Text style={[s.un, { color: th.muted }]}>@{handle}</Text> : null}
        {presence ? <Text style={[s.seen, { color: th.muted }]} numberOfLines={1}>{presence}</Text> : null}
        {note && note.text ? (
          <Pressable onPress={() => setNoteSheet(true)} style={[s.note, { backgroundColor: th.card }, shadow]} accessibilityRole="button" testID="tg-profile-note">
            <View style={[s.noteDot, { backgroundColor: th.text }]} />
            <Text style={[s.noteTxt, { color: th.text }]} numberOfLines={2}>{note.text}</Text>
          </Pressable>
        ) : isSelf ? (
          <Pressable onPress={() => setNoteSheet(true)} style={[s.note, { backgroundColor: th.card }, shadow]} accessibilityRole="button">
            <TgIcon name="plus" size={14} color={th.muted} />
            <Text style={[s.noteTxt, { color: th.muted }]}>{tr('addNote')}</Text>
          </Pressable>
        ) : null}
      </View>
      {isSelf ? (
        <View style={s.acts}>
          {actBtn({ icon: "plus", label: tr('publish'), pri: true, onPress: () => muralNav.openComposer({ from: 'profile', audience, router }) })}
          {actBtn({ icon: "edit", label: tr('edit'), onPress: selfCb.onEdit || (() => { try { router.push('/edit-profile'); } catch {} }) })}
          {actBtn({ icon: "share", label: tr('share'), onPress: selfCb.onShare || (() => { try { Share.share({ url: `https://chatyy.com.br/u/${encodeURIComponent(handle || em)}`, message: Platform.OS === 'android' ? `https://chatyy.com.br/u/${encodeURIComponent(handle || em)}` : undefined }); } catch {} }) })}
        </View>
      ) : (
        <View style={s.acts}>
          {actions.call ? actBtn({ icon: "phone", label: tr('audio'), onPress: actions.call }) : null}
          {actions.video ? actBtn({ icon: "video", label: tr('video'), onPress: actions.video }) : null}
          {actBtn({ icon: "user", label: tr('profile'), hl: true, onPress: () => { setTab('posts'); requestAnimationFrame(() => pinTabs(true)); } })}
          {actions.search ? actBtn({ icon: "search", label: tr('search'), onPress: actions.search })
            : actions.message ? actBtn({ icon: "comment", label: tr('message'), onPress: actions.message }) : null}
        </View>
      )}
      {(() => {
          const rows = [];
          const bio = String(ident.bio || contact.bio || '').trim();
          if (bio) rows.push(<Row key="bio" th={th} title={bio} sub={tr('bio')} inset first={!rows.length} />);
          if (handle) rows.push(<Row key="un" th={th} title={`@${handle}`} sub={tr('username')} first={!rows.length} />);
          const phone = ident.phone || contact.phone || '';
          if (phone && !isSelf) rows.push(<Row key="ph" th={th} title={String(phone)} sub={tr('phone')} first={!rows.length} />);
          if (isSelf) {
            rows.push(<Row key="aud" th={th} title={tr('whoSees')} sub={tr('whoSeesSub')} value={tr(AUD_KEY[audience] || 'audEveryone')} first={!rows.length} onPress={() => _menu({
              title: tr('whoSees'),
              options: ['public', 'contacts', 'private'].map((a) => ({ label: tr(AUD_KEY[a]), onPress: () => setDefaultAudience(a) })),
              cancelLabel: tr('cancel'),
            })} />);
          } else if (contact.onMute || contact.onMuteFor) {
            rows.push(<Row key="nt" th={th} title={tr('notifications')} sub={muted ? tr('notifOff') : tr('notifOn')} first={!rows.length}
              right={<Switch value={!muted} onValueChange={onToggleNotif} trackColor={{ true: th.accent, false: th.chip }} thumbColor={Platform.OS === 'android' ? (!muted ? th.accentInk : '#fff') : undefined} ios_backgroundColor={th.chip} accessibilityLabel={tr('notifications')} />} />);
          }
          return rows.length ? <Card th={th} shadow={shadow}>{rows}</Card> : null;
        })()}
      {!isSelf && contact.onFavorites ? (
        <Card th={th} shadow={shadow}>
          <Row th={th} icon="star" title={tr('favorites')} value={contact.favoritesCount ? String(contact.favoritesCount) : ''} onPress={contact.onFavorites} first />
        </Card>
      ) : null}
      <View style={{ height: 18 }} />
    </View>
  );

  const tabsBar = (
    <View style={[s.tabs, { backgroundColor: th.bg, borderBottomColor: th.line }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 4 }}>
        {tabs.map(([k, label, n]) => {
          const on = tab === k;
          return (
            <Pressable key={k} onPress={() => selectTab(k)} style={s.tab} accessibilityRole="tab" accessibilityState={{ selected: on }}>
              <Text style={[s.tabTxt, { color: on ? th.text : th.muted }]}>{label}</Text>
              {n != null && n > 0 ? (
                <View style={[s.tabC, { backgroundColor: on ? th.text : th.chip }]}><Text style={[s.tabCTxt, { color: on ? th.bg : th.muted }]}>{fmtN(n, lang)}</Text></View>
              ) : null}
              {on ? <View style={[s.tabLine, { backgroundColor: th.text }]} /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );

  const postsTool = () => {
    const n = counts.posts != null ? counts.posts : posts.length;
    const ph = counts.photos != null ? counts.photos : posts.filter((p) => p.media.length).length;
    const tx = counts.texts != null ? counts.texts : posts.filter((p) => !p.media.length).length;
    return (
      <View style={s.tool}>
        <Text style={[s.toolLbl, { color: th.muted }]} numberOfLines={1}>{n ? tr('postsSummary', { n, p: ph, t: tx }) : ''}</Text>
        <View style={[s.seg, { backgroundColor: th.chip }]}>
          {[['grid', 'grid'], ['list', 'list']].map(([v, ic]) => (
            <Pressable key={v} onPress={() => setView(v)} style={[s.segBtn, view === v && [{ backgroundColor: th.card }, s.segOn]]} accessibilityRole="button" accessibilityLabel={tr(v)} accessibilityState={{ selected: view === v }}>
              <TgIcon name={ic} size={18} color={view === v ? th.text : th.muted} />
            </Pressable>
          ))}
        </View>
      </View>
    );
  };

  const meAuthor = useMemo(() => ({ name, username: handle, avatar: (sz) => <SmallAvatar size={sz} email={em} name={name} th={th} /> }), [name, handle, em, th]);

  const renderItem = ({ item }) => {
    switch (item.k) {
      case 'hdr': return header;
      case 'tabs': return tabsBar;
      case 'tool': return postsTool();
      case 'compose': return (
        <Pressable onPress={() => muralNav.openComposer({ mode: 'text', from: 'profile', audience, router })} style={[s.compose, { backgroundColor: th.card }, shadow]} accessibilityRole="button" accessibilityLabel={tr('whatsOnMind')}>
          <SmallAvatar size={36} email={em} name={name} th={th} />
          <View style={[s.composePh, { backgroundColor: th.chip }]}><Text style={{ color: th.muted, fontSize: 14.5 }} numberOfLines={1}>{tr('whatsOnMind')}</Text></View>
          <Pressable onPress={() => muralNav.openComposer({ mode: 'photo', pick: 'library', from: 'profile', audience, router })} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr('tabMedia')}>
            <TgIcon name="image" size={24} color={th.muted} />
          </Pressable>
        </Pressable>
      );
      case 'g': return <GridRow row={item.row} width={width} th={th} lang={lang} onPress={openPost} />;
      case 'c': return (
        <PostCard post={item.post} th={th} lang={lang} author={meAuthor} shadow={shadow}
          onOpen={openPost} onLike={onLike} onComments={onComments} onShare={onShare} onMore={onMore} onBookmark={onBookmark} bookmarked={!!bookmarks[item.post.id]} />
      );
      case 'm': return <MediaRow row={item.row} width={width} th={th} onPress={(x) => (x.post ? openPost(x.post) : openMediaItem(x.it, data.shared.media.items))} />;
      case 'mg': return <Text style={[s.mgroup, { color: th.muted }]}>{item.label}</Text>;
      case 'links': {
        const it = item.it;
        const url = it.url || _firstUrl(it.content);
        const title = String(it.title || '').trim() || String(it.content || '').replace(/\s+/g, ' ').trim() || url;
        const host = it.host || _host(url);
        return (
          <Pressable onPress={() => openLinkItem(url)} style={({ pressed }) => [s.lrow, pressed && { backgroundColor: th.chip }]} accessibilityRole="link">
            <View style={[s.th, { backgroundColor: th.ink }]}>
              {it.image ? <FastImage source={{ uri: absUrl(it.image) }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <TgIcon name="link" size={18} color={th.inkInk} />}
            </View>
            <View style={[s.lrowTb, { borderBottomColor: th.line }]}>
              <Text style={[s.lrowB, { color: th.text }]} numberOfLines={1}>{title}</Text>
              <Text style={[s.lrowS, { color: th.muted }]} numberOfLines={1}>{host || url}</Text>
            </View>
          </Pressable>
        );
      }
      case 'docs': {
        const it = item.it;
        const ext = (String(it.file_name || '').split('.').pop() || 'DOC').toUpperCase().slice(0, 4);
        const sub = [_fmtSize(it.file_size), relTime(lang, it.created_at)].filter(Boolean).join(' · ');
        return (
          <Pressable onPress={() => openMediaItem(it)} style={({ pressed }) => [s.lrow, pressed && { backgroundColor: th.chip }]} accessibilityRole="button">
            <View style={[s.th, { backgroundColor: DOC_COLORS[ext] || th.ink }]}><Text style={{ color: DOC_COLORS[ext] ? '#fff' : th.inkInk, fontSize: 11, fontWeight: '700' }}>{ext}</Text></View>
            <View style={[s.lrowTb, { borderBottomColor: th.line }]}>
              <Text style={[s.lrowB, { color: th.text }]} numberOfLines={1}>{it.file_name || 'Documento'}</Text>
              <Text style={[s.lrowS, { color: th.muted }]} numberOfLines={1}>{sub}</Text>
            </View>
          </Pressable>
        );
      }
      case 'voice': {
        const it = item.it;
        const d = Number(it.duration) || 0;
        const dur = d ? `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}` : '';
        const seedN = Number(String(it.id).replace(/\D/g, '').slice(-6)) || 7;
        return (
          <Pressable onPress={() => playVoice(it)} style={({ pressed }) => [s.lrow, pressed && { backgroundColor: th.chip }]} accessibilityRole="button">
            <View style={[s.play, { backgroundColor: th.accent }]}><TgIcon name="play" size={16} color={th.accentInk} fill={th.accentInk} strokeWidth={1} style={{ marginLeft: 2 }} /></View>
            <View style={[s.lrowTb, { borderBottomColor: th.line }]}>
              <View style={s.wave}>
                {Array.from({ length: 30 }, (_, i) => <View key={i} style={{ width: 3, borderRadius: 2, marginRight: 2, backgroundColor: th.muted, opacity: 0.7, height: 4 + Math.round(Math.abs(Math.sin(i * 1.7 + seedN)) * 16) }} />)}
              </View>
              <Text style={[s.lrowS, { color: th.muted }]} numberOfLines={1}>{[dur, relTime(lang, it.created_at)].filter(Boolean).join(' · ')}</Text>
            </View>
          </Pressable>
        );
      }
      case 'grp': {
        const g = item.g;
        let gRef = null;
        try { if (g.avatar_url || g.avatar) gRef = require('../../chat/NativeProfileBridge').avatarRefForUrl(absUrl(g.avatar_url || g.avatar)); } catch {}
        const n = Number(g.member_count || g.members_count || 0);
        return (
          <Pressable onPress={() => openGroup(g)} style={({ pressed }) => [s.lrow, pressed && { backgroundColor: th.chip }]} accessibilityRole="button">
            <Avatar size={44} email="" name={g.name || ''} uri={gRef && gRef.uri} headers={gRef && gRef.headers} th={th} />
            <View style={[s.lrowTb, { borderBottomColor: th.line }]}>
              <Text style={[s.lrowB, { color: th.text }]} numberOfLines={1}>{g.name || tr('group')}</Text>
              <Text style={[s.lrowS, { color: th.muted }]} numberOfLines={1}>{n ? tr('members', { n }) : tr('group')}</Text>
            </View>
          </Pressable>
        );
      }
      // [2026-10-20 ux] skeleton com a forma da aba (grade p/ mídia/posts em grade, cartão p/ posts, linhas p/ o resto)
      case 'spin':
        if (tab === 'media' || (tab === 'posts' && view === 'grid')) return <GridSkeleton count={9} columns={3} />;
        if (tab === 'posts') return <PostSkeleton count={1} />;
        return <SkeletonRows count={5} avatarSize={44} />;
      case 'more': return <View style={{ paddingVertical: 18 }}><ActivityIndicator color={th.muted} /></View>;
      case 'err': return (
        <Pressable onPress={() => (tab === 'posts' ? data.reloadPosts() : data.reloadShared(tab))} style={s.state}>
          <Text style={[s.emptyHint, { color: th.muted }]}>{tr('loadFailed')}</Text>
        </Pressable>
      );
      case 'empty': return (
        <View style={s.state}>
          <View style={[s.emptyBox, { borderColor: th.line }]}>
            <Text style={[s.emptyTxt, { color: th.text }]}>{item.text}</Text>
            {item.hint ? <Text style={[s.emptyHint, { color: th.muted }]}>{item.hint}</Text> : null}
          </View>
        </View>
      );
      default: return null;
    }
  };

  // ── rodapé: opções da conversa (MESMOS handlers de antes, reorganizados) ──
  const footer = useMemo(() => {
    if (isSelf) return <View style={{ height: bottomInset + 40 }} />;
    const rows = Array.isArray(contact.rows) ? contact.rows.filter((r) => r && r.id != null && !CONSUMED.has(String(r.id)) && !String(r.id).startsWith('grp:') && r.k !== 'grid' && r.k !== 'media' && r.k !== 'about') : [];
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const used = new Set();
    const take = (ids) => ids.map((id) => byId.get(id)).filter(Boolean).map((r) => { used.add(String(r.id)); return r; });
    const conv = take(CONV_IDS);
    const priv = take(PRIV_IDS);
    const danger = rows.filter((r) => !used.has(String(r.id)) && (r.sid === 'danger' || r.dest)).map((r) => { used.add(String(r.id)); return r; });
    const more = rows.filter((r) => !used.has(String(r.id)));
    const label = (r) => {
      const id = String(r.id);
      if (id === 'customNotif') return tr('customNotif');
      if (id === 'wallpaper') return tr('wallpaper');
      if (id === 'disappearing') return tr('disappearing');
      if (id === 'chatLock') return tr('chatLock');
      return r.title;
    };
    const section = (title, list, red) => (list.length ? (
      <View key={title || 'danger'}>
        {title ? <Text style={[s.secT, { color: th.muted }]}>{title}</Text> : <View style={{ height: 16 }} />}
        <Card th={th} shadow={shadow} style={{ marginTop: 0 }}>
          {list.map((r, i) => (
            <Row key={String(r.id)} th={th} icon={r.icon || (red ? 'block' : 'chev')} title={label(r)} value={r.val || (String(r.id) === 'disappearing' || String(r.id) === 'chatLock' ? (r.val || tr('off')) : '')}
              dest={red || !!r.dest} onPress={r.onPress} first={i === 0} chevron={!red} />
          ))}
        </Card>
      </View>
    ) : null);
    return (
      <View style={{ paddingBottom: bottomInset + 40, backgroundColor: th.bg }}>
        <View style={{ height: 10 }} />
        {section(tr('conversation'), conv)}
        {section(tr('privacy'), priv)}
        {section(tr('moreSection'), more)}
        {section('', danger, true)}
      </View>
    );
  }, [isSelf, contact.rows, th, shadow, tr, bottomInset]);

  const barTitle = (
    <Animated.View pointerEvents="none" style={[s.barTtl, { opacity: barOp, transform: [{ translateY: ttlY }] }]}>
      <Text style={[s.barTtlB, { color: th.text }]} numberOfLines={1}>{name}</Text>
      {presence ? <Text style={[s.barTtlS, { color: th.muted }]} numberOfLines={1}>{presence}</Text> : null}
    </Animated.View>
  );

  const moreMenu = Array.isArray(contact.moreMenu) ? contact.moreMenu.filter(Boolean).slice(0, 3) : [];

  let CommentsHost = null; // folha de comentários sobe nesta tela (components/mural)
  try { CommentsHost = require('../../mural/CommentsSheet').MuralCommentsHost || null; } catch { CommentsHost = null; }
  let Viewer = null;
  if (viewer) { try { Viewer = require('../../ChatMediaViewer').default; } catch { Viewer = null; } }
  let NoteSheet = null;
  if (isSelf && noteSheet) { try { NoteSheet = require('../../settings/ProfileNoteSheet').default; } catch { NoteSheet = null; } }
  // [2026-10-20 nota2] nota do CONTATO: toque abre a folha (Responder → mensagem citando a nota).
  let CNoteSheet = null;
  if (!isSelf && noteSheet && note && note.text) { try { CNoteSheet = require('../../chatlist/ContactNoteSheet').default; } catch { CNoteSheet = null; } }

  return (
    <View style={[s.fill, { backgroundColor: th.bg }]}>
      <View style={{ paddingTop: topInset, backgroundColor: th.bg, zIndex: 5 }}>
        <View style={s.bar}>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: barOp, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: th.line, backgroundColor: th.bg }]} />
          {onBack ? (
            <Pressable onPress={onBack} hitSlop={6} style={s.ib} accessibilityRole="button" accessibilityLabel={props.backLabel || tr('back')}>
              <TgIcon name="back" size={24} color={th.text} />
            </Pressable>
          ) : <View style={s.ib} />}
          {barTitle}
          <View style={{ flex: 1 }} />
          {isSelf ? (
            <Pressable onPress={selfCb.onEdit || (() => { try { router.push('/edit-profile'); } catch {} })} style={s.pill} accessibilityRole="button">
              <Text style={[s.pillTxt, { color: th.text }]}>{tr('edit')}</Text>
            </Pressable>
          ) : moreMenu.length ? (
            <Pressable onPress={() => _menu({ options: moreMenu.map((r) => ({ label: r.title, destructive: !!r.dest, onPress: r.onPress })), cancelLabel: tr('cancel') })} hitSlop={6} style={s.ib} accessibilityRole="button" accessibilityLabel={tr('more')}>
              <TgIcon name="more" size={24} color={th.text} />
            </Pressable>
          ) : <View style={s.ib} />}
        </View>
      </View>
      <Animated.FlatList
        ref={listRef}
        data={items}
        keyExtractor={(it) => it.key}
        renderItem={renderItem}
        stickyHeaderIndices={[1]}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.8}
        ListFooterComponent={footer}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={9}
        removeClippedSubviews={false}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={{ backgroundColor: th.bg }}
      />
      {isSelf ? <ProfilePostProgress email={em} top={topInset + BAR_H + 6} /> : null}
      {CommentsHost ? <CommentsHost /> : null}
      {Viewer && viewer ? (
        <Viewer
          visible={!!viewer}
          fileUrl={viewer.fileUrl}
          fileName={viewer.fileName}
          fileSize={viewer.fileSize}
          type={viewer.type}
          mediaList={viewer.mediaList || undefined}
          initialIndex={viewer.initialIndex || 0}
          senderEmail={viewer.senderEmail}
          createdAt={viewer.createdAt}
          onClose={() => setViewer(null)}
          colors={colors}
          t={t}
          conversationId={data.conversationId}
        />
      ) : null}
      {NoteSheet ? <NoteSheet visible={noteSheet} note={myNote} onClose={() => setNoteSheet(false)} t={t} /> : null}
      {CNoteSheet ? (
        <CNoteSheet
          visible
          note={{ email: em, name, content: note.text, created_at: note.created_at, conversation_id: null /* chatCreate direct (convId pode ser de grupo) */ }}
          onClose={() => setNoteSheet(false)}
          t={t}
          isDark={!!th.isDark}
          router={router}
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  bar: { height: BAR_H, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  ib: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  pillTxt: { fontSize: 15, fontWeight: '600' },
  barTtl: { position: 'absolute', left: 60, right: 60, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  barTtlB: { fontSize: 16, fontWeight: '700' },
  barTtlS: { fontSize: 12 },
  hd: { paddingTop: 8, paddingHorizontal: 16, alignItems: 'center' },
  h1: { fontSize: 24, fontWeight: '700', letterSpacing: -0.4, marginTop: 12, textAlign: 'center' },
  un: { fontSize: 15, marginTop: 1 },
  seen: { fontSize: 13, marginTop: 4 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingHorizontal: 12, paddingVertical: 7, borderRadius: THEME_V2 ? 999 : 16, maxWidth: '90%' },
  noteDot: { width: 6, height: 6, borderRadius: 3, opacity: 0.5 },
  noteTxt: { fontSize: 13.5, flexShrink: 1 },
  acts: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 18 },
  act: { flex: 1, height: 62, borderRadius: THEME_V2 ? 18 : 14, alignItems: 'center', justifyContent: 'center', gap: 4 },
  actTxt: { fontSize: 12.5, fontWeight: '500' },
  grp: { marginHorizontal: 16, marginTop: 16, borderRadius: THEME_V2 ? Grafite.radius.card : 14, overflow: Platform.OS === 'android' ? 'hidden' : 'visible' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11, minHeight: 48, borderRadius: THEME_V2 ? Grafite.radius.card : 14 },
  sep: { position: 'absolute', top: 0, right: 0, height: StyleSheet.hairlineWidth },
  icBox: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  rowV: { fontSize: 15.5 },
  rowK: { fontSize: 12.5, marginTop: 1 },
  rv: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto', maxWidth: '45%' },
  rvTxt: { fontSize: 15 },
  secT: { marginTop: 22, marginHorizontal: 30, marginBottom: 6, fontSize: 12.5, textTransform: 'uppercase', letterSpacing: 0.5 },
  tabs: { borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { paddingHorizontal: 10, paddingTop: 12, paddingBottom: 11, flexDirection: 'row', alignItems: 'center', gap: 5 },
  tabTxt: { fontSize: 15, fontWeight: '600' },
  tabC: { borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 },
  tabCTxt: { fontSize: 12, fontWeight: '600' },
  tabLine: { position: 'absolute', left: 8, right: 8, bottom: 0, height: 3, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  tool: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  toolLbl: { fontSize: 13, flex: 1, marginRight: 8 },
  seg: { flexDirection: 'row', borderRadius: 10, padding: 2 },
  segBtn: { width: 38, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  segOn: Platform.OS === 'web' ? { boxShadow: '0 1px 3px rgba(0,0,0,.12)' } : { shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  compose: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 10, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: THEME_V2 ? 22 : 18 },
  composePh: { flex: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  mgroup: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, fontSize: 13, fontWeight: '600' },
  lrow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  th: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  lrowTb: { flex: 1, minWidth: 0 },
  lrowB: { fontSize: 15, fontWeight: '600' },
  lrowS: { fontSize: 13, marginTop: 1 },
  play: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  wave: { flexDirection: 'row', alignItems: 'center', height: 22, marginTop: 2, overflow: 'hidden' },
  state: { paddingVertical: 28, paddingHorizontal: 10, alignItems: 'center' },
  emptyBox: { alignSelf: 'stretch', borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 18, padding: 20, alignItems: 'center' },
  emptyTxt: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
  emptyHint: { fontSize: 13.5, textAlign: 'center', marginTop: 4 },
});
