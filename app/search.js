import React, { useEffect, useState, useCallback, useRef } from 'react';
import VerifiedBadge from '../components/VerifiedBadge'; // [verificado 2026-10-24]
import FastImage from '../components/FastImage'; // [2026-10-09 expo-image]
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, Platform, ScrollView, Image,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { IconArrowLeft, IconSearch, IconX, IconHash, IconVideo, IconMusic } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import FadeSlideIn from '../components/FadeSlideIn';
import ChatyyMascot from '../components/mascot/ChatyyMascot'; // [2026-10-16 mascote]
import * as api from '../services/api';
import { peekCached, putCached } from '../hooks/useCachedAction'; // [2026-10-14 offline-first]
import GlobalMessageSearch from '../components/GlobalMessageSearch'; // [2026-10-14 busca-global]
// [2026-10-15 native-search-notifs] Resultados das abas em lista NATIVA
// (ChatyyResultList) quando o binário tem a view; kill switch
// globalThis.__chatyy_native_search = false → FlashList JS abaixo (igual antes).
import NativeResultList, { useNativeResults } from '../components/native/NativeResultList';
import { contactTile, photoTile, queryTokens, matchesAll, snippetAround } from '../components/native/resultListAdapter';
// [2026-10-18 search-tabs] barra de busca NATIVA no header (UISearchController /
// SearchView) + abas estilo Telegram. Kill switch: __chatyy_native_search_header = false.
import { USE_NATIVE_HEADER, nativeHeaderOptions, NativeHeaderSafeArea } from '../components/nativeHeader';
import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
import { SkeletonRows } from '../components/Skeleton'; // [2026-10-20 ux]


// Unified search screen — Pessoas / Hashtags / Sons / Lives. Each tab calls
// the matching backend endpoint (search_users, trending_hashtags + feed
// captions, chat_status_music_search, live_list). The tab bar is a sliding
// pill consistent with the rest of the app (ChatFeedTab + ChatListTab).
// [2026-10-18 search-tabs] abas estilo Telegram: Conversas (local, na hora),
// Mensagens, Pessoas, Mídia / Links / Arquivos / Voz (chat_search_advanced com
// tipo fixo) e, por último, as abas sociais (Hashtags / Sons / Lives).
const TABS = [
  { key: 'chats',    labelKey: 'search.tabChats', fallback: 'Conversas' },
  // [2026-10-14 busca-global] mensagens de todas as conversas por texto/tipo/data (chat_search_advanced).
  { key: 'messages', labelKey: 'gsearch.tab',     fallback: 'Mensagens' },
  { key: 'people',   labelKey: 'search.people',   fallback: 'Pessoas' },
  { key: 'media',    labelKey: 'search.tabMedia', fallback: 'Mídia' },
  { key: 'links',    labelKey: 'gsearch.links',   fallback: 'Links' },
  { key: 'files',    labelKey: 'search.tabFiles', fallback: 'Arquivos' },
  { key: 'voice',    labelKey: 'search.tabVoice', fallback: 'Voz' },
  { key: 'hashtags', labelKey: 'search.hashtags', fallback: 'Hashtags' },
  { key: 'sounds',   labelKey: 'search.sounds',   fallback: 'Sons' },
  { key: 'lives',    labelKey: 'search.lives',    fallback: 'Lives' },
];
// Abas de mensagens com tipo fixo → GlobalMessageSearch (servidor; arrays estáveis).
const MSG_TABS = {
  messages: null,
  media: { types: ['photo', 'video'], layout: 'grid', emptyKey: 'search.emptyMedia', emptyFb: 'Nenhuma foto ou vídeo encontrado' },
  links: { types: ['link'], emptyKey: 'search.emptyLinks', emptyFb: 'Nenhum link encontrado' },
  files: { types: ['doc'], emptyKey: 'search.emptyFiles', emptyFb: 'Nenhum arquivo encontrado' },
  voice: { types: ['audio'], emptyKey: 'search.emptyVoice', emptyFb: 'Nenhuma mensagem de voz encontrada' },
};
const isMsgTab = (k) => Object.prototype.hasOwnProperty.call(MSG_TABS, k);
const LOCAL_DEBOUNCE_MS = 60;
const SERVER_DEBOUNCE_MS = 250;

function nativeSearchHeaderOn() {
  if (!USE_NATIVE_HEADER) return false;
  try { if (globalThis.__chatyy_native_search_header === false) return false; } catch {}
  return true;
}

/** Conversa → nome exibido (apelido, "Mensagens salvas", handle bonito). */
function convDisplay(c, me, t) {
  const type = c.type || (c.is_group ? 'group' : 'direct');
  const peer = type === 'direct' ? String(c.other_email || c.contact_email || c.peer_email || '') : '';
  const saved = type === 'saved' || (!!peer && !!me && peer.toLowerCase() === me);
  if (saved) return { type, peer, name: (t('chat.savedMessages') || 'Mensagens salvas'), saved: true };
  let nick = '';
  if (peer) { try { nick = require('../services/nicknames').getNickname?.(peer) || ''; } catch {} }
  let name = nick || c.display_name || c.name || '';
  if (!name && peer) { try { name = api.emailToDisplayName(peer) || peer.split('@')[0]; } catch { name = peer.split('@')[0]; } }
  return { type, peer, name: name || '?', saved: false };
}

export default function SearchScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets(); // [2026-10-18 safe-area] topo real (era 50 fixo no iOS)

  // [2026-10-14 busca-global] /search?tab=messages abre direto na aba Mensagens.
  const _params = useLocalSearchParams();
  const [tab, setTab] = useState(() => (TABS.some((x) => x.key === _params?.tab) ? String(_params.tab) : 'chats'));
  const [query, setQuery] = useState(() => String(_params?.q || '').slice(0, 200)); // [2026-10-20 tg1] /search?tab=messages&q=… (vem da busca da lista)
  const [loading, setLoading] = useState(false);
  // [2026-10-14 offline-first] listas iniciais (em alta / sons / lives) pintam
  // do último valor salvo no aparelho; a rede só atualiza em 2º plano.
  const [results, setResults] = useState(() => { const l = peekCached(['search', 'lives']); return { people: [], hashtags: [], sounds: [], lives: Array.isArray(l) ? l : [] }; });
  const [trendingTags, setTrendingTags] = useState(() => { const c = peekCached(['search', 'trending_tags']); return Array.isArray(c) ? c : []; });
  // Reels P1 — trending sounds (last 7d). Shown on the Sons tab empty
  // state, mirroring how Hashtags surfaces trending hashtags. Backed by
  // reels_trending_sounds which aggregates chat_feed_posts.sound_id.
  const [trendingSounds, setTrendingSounds] = useState(() => { const c = peekCached(['search', 'trending_sounds']); return Array.isArray(c) ? c : []; });
  const debounceRef = useRef(null);
  const reqIdRef = useRef(0);
  const [nativeOn, onNativeFailure] = useNativeResults('__chatyy_native_search');

  // Initial trending hashtag list shown on the empty-state of the Hashtags tab.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.trendingHashtags(30);
        if (alive && r?.success && Array.isArray(r.data?.tags)) {
          setTrendingTags(r.data.tags);
          putCached(['search', 'trending_tags'], r.data.tags);
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  // Initial trending sounds — surfaced on the Sons tab empty-state, same
  // shape as the Hashtags trending list.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.reelsTrendingSounds?.(20);
        if (alive && r?.success && Array.isArray(r.data?.sounds)) {
          setTrendingSounds(r.data.sounds);
          putCached(['search', 'trending_sounds'], r.data.sounds);
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  // Initial live list (no query needed — just show what's on right now).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.liveList();
        if (alive && r?.success && Array.isArray(r.data?.lives)) {
          setResults(prev => ({ ...prev, lives: r.data.lives }));
          putCached(['search', 'lives'], r.data.lives);
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  // Debounced multi-endpoint search. We fire the request matching the active
  // tab + the people tab in parallel so switching tabs after typing surfaces
  // results immediately for the most common case (Pessoas). Other tabs are
  // lazy-loaded on demand to keep mobile bandwidth low.
  const runSearch = useCallback(async (q, activeTab) => {
    if (isMsgTab(activeTab) || activeTab === 'chats') return; // [2026-10-14 busca-global] abas de mensagens buscam sozinhas (GlobalMessageSearch); Conversas é local
    const trimmed = String(q || '').trim();
    if (trimmed.length < 2) {
      setLoading(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      if (activeTab === 'people') {
        // [2026-10-21 tg4] mesmo people_search da "Nova conversa": nome, @usuário, e-mail e telefone
        // em qualquer formato (+55, DDD, hífen Unicode, marcas invisíveis do WhatsApp/iOS).
        // Ordem: acertos exatos (score ≥ 950) → seus contatos → no Chatyy. Falha → search_users antigo.
        const clean = trimmed.replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '').trim();
        let users = null;
        try {
          let homeDial = '';
          try { homeDial = require('../services/contactSync').getHomeDialDigits() || ''; } catch {}
          const r = await api.peopleSearch(clean, homeDial);
          if (reqId !== reqIdRef.current) return;
          if (r?.success) {
            const d = r.data || {};
            const all = [...(d.contacts || []), ...(d.global || []), ...(Array.isArray(d.users) ? d.users : [])];
            const meL = String(me || '').toLowerCase();
            const seen = new Set();
            const exact = []; const rest = [];
            for (const u of all) {
              const k = String(u?.email || '').toLowerCase();
              if (!k || seen.has(k) || k === meL) continue;
              seen.add(k);
              ((u.score || 0) >= 950 ? exact : rest).push(u);
            }
            users = [...exact, ...rest];
          }
        } catch {}
        if (users === null) {
          const r = await api.searchUsers(clean);
          if (reqId !== reqIdRef.current) return;
          users = (r?.success && Array.isArray(r.data?.users)) ? r.data.users : [];
        }
        setResults(prev => ({ ...prev, people: users }));
      } else if (activeTab === 'hashtags') {
        const r = await api.trendingHashtags(100);
        if (reqId !== reqIdRef.current) return;
        const tags = (r?.success && Array.isArray(r.data?.tags)) ? r.data.tags : [];
        // Local filter — backend doesn't accept a query arg, so we filter the
        // top 100 trending tags by case-insensitive prefix match.
        const needle = trimmed.toLowerCase().replace(/^#/, '');
        setResults(prev => ({ ...prev, hashtags: tags.filter(tg => String(tg.tag || '').toLowerCase().includes(needle)) }));
      } else if (activeTab === 'sounds') {
        const r = await api.chatStatusMusicSearch(trimmed, 'search', 30);
        if (reqId !== reqIdRef.current) return;
        const tracks = (r?.success && Array.isArray(r.data?.tracks)) ? r.data.tracks : [];
        setResults(prev => ({ ...prev, sounds: tracks }));
      } else if (activeTab === 'lives') {
        const r = await api.liveList();
        if (reqId !== reqIdRef.current) return;
        const lives = (r?.success && Array.isArray(r.data?.lives)) ? r.data.lives : [];
        // Local filter — match against host_name, host_email, and title.
        const needle = trimmed.toLowerCase();
        setResults(prev => ({
          ...prev,
          lives: lives.filter(l => {
            const blob = `${l.host_name || ''} ${l.host_email || ''} ${l.title || ''}`.toLowerCase();
            return blob.includes(needle);
          }),
        }));
      }
    } catch (e) {
      // soft-fail — keep stale results on screen so a flaky network doesn't
      // wipe what the user already had.
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, []);

  // Debounce input by 350ms — the same window the chat search uses. Avoids
  // hammering /search_users on every keystroke while still feeling instant.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query || query.trim().length < 2) {
      reqIdRef.current++; // resposta antiga não pinta depois de limpar
      setLoading(false);
      setResults(prev => ({ ...prev, people: [], sounds: [] }));
      return;
    }
    if (tab === 'chats' || isMsgTab(tab)) { setLoading(false); return undefined; }
    // [2026-10-18 search-tabs] filtro LOCAL na hora (listas já carregadas), servidor em 250 ms.
    const needle = query.trim().toLowerCase();
    if (tab === 'hashtags') {
      const n = needle.replace(/^#/, '');
      setResults(prev => ({ ...prev, hashtags: (trendingTags || []).filter(tg => String(tg.tag || '').toLowerCase().includes(n)) }));
    }
    debounceRef.current = setTimeout(() => { runSearch(query, tab); }, SERVER_DEBOUNCE_MS);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tab, runSearch]);

  // ── [2026-10-18 search-tabs] Conversas: lista local (0 ms) + mensagens do
  // SQLite FTS5 (60 ms). Sem rede; "Ver todas" leva à aba Mensagens (servidor).
  const { user } = useAuth();
  const me = String(user?.email || '').toLowerCase();
  const [convIndex, setConvIndex] = useState([]);
  useEffect(() => {
    if (tab !== 'chats') return;
    try {
      const list = require('../services/chatStore').getConversationsSync() || [];
      setConvIndex(list.filter(c => c && c.id != null && !c.locked).map((c) => {
        const d = convDisplay(c, me, t);
        const hay = [d.name, d.peer, c.name, c.display_name, c.username].filter(Boolean).join(' ');
        return { c, d, hay };
      }));
    } catch { setConvIndex([]); }
  }, [tab, me, t]);
  const chatHits = React.useMemo(() => {
    if (tab !== 'chats') return [];
    const toks = queryTokens(query);
    if (!toks.length) return convIndex.slice(0, 30);
    const out = [];
    for (const e of convIndex) { if (matchesAll(toks, e.hay)) { out.push(e); if (out.length >= 60) break; } }
    return out;
  }, [tab, query, convIndex]);
  const [localMsgs, setLocalMsgs] = useState({ q: '', list: [] });
  useEffect(() => {
    if (tab !== 'chats') return undefined;
    const q = query.trim();
    if (q.length < 2) { setLocalMsgs({ q: '', list: [] }); return undefined; }
    let alive = true;
    const tm = setTimeout(async () => {
      try {
        const { dbSearchMessages } = require('../services/db');
        const rows0 = await dbSearchMessages(q, 12, null, { prefix: true });
        if (!alive) return;
        const list = (rows0 || []).map(m0 => (m0 && m0._row ? { ...m0, id: m0.id ?? m0._row.id, conversation_id: m0.conversation_id ?? m0._row.conversation_id, created_at: m0.created_at ?? m0._row.created_at } : m0))
          .filter(m => m && m.id != null && m.conversation_id != null);
        setLocalMsgs({ q, list });
      } catch { if (alive) setLocalMsgs({ q, list: [] }); }
    }, LOCAL_DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(tm); };
  }, [tab, query]);
  const openConv = useCallback((c, d, extra) => {
    try {
      require('../services/openConversation').openConversation({
        pathname: '/chat-conversation',
        params: { id: String(c.id), name: d.name || '', type: d.type, ...(d.type === 'direct' && d.peer ? { email: d.peer } : {}), ...(extra || {}) },
      }, { router });
    } catch {}
  }, [router]);
  const convById = React.useMemo(() => {
    const m = new Map();
    for (const e of convIndex) m.set(String(e.c.id), e);
    return m;
  }, [convIndex]);

  // [grupos 2026-10-21] Busca de pessoas sem resultado → convite com o link pessoal.
  const inviteToChatyy = useCallback(() => {
    try { require('../services/inviteContact').shareInvite(t, '').catch(() => {}); } catch {}
  }, [t]);

  // Renderers per tab.
  const renderPeople = () => (
    <FlashList
      data={results.people}
      keyExtractor={(u) => u.email}
      contentContainerStyle={{ padding: 12 }}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item: u }) => (
        <TouchableOpacity
          style={[styles.row, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : colors.surface }]}
          activeOpacity={0.75}
          onPress={() => router.push(`/u/${encodeURIComponent(u.email)}`)}
          accessibilityRole="button"
          accessibilityLabel={u.name || u.email}
        >
          <AvatarCircle name={u.name || u.email} email={u.email} size={46} />
          <View style={styles.rowText}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>{/* [verificado 2026-10-24] */}
              <Text style={[styles.rowTitle, { color: colors.text, flexShrink: 1 }]} numberOfLines={1}>
                {u.name || u.email?.split('@')[0]}
              </Text>
              <VerifiedBadge email={u.email} size={14} />
            </View>
            <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
              {u.username ? `@${u.username}` : u.email /* [2026-10-21 tg4] */}
            </Text>
          </View>
        </TouchableOpacity>
      )}
      ListEmptyComponent={!loading && query.trim().length >= 2 ? (
        <View style={{ alignItems: 'center', paddingTop: 40 }}>{/* [2026-10-16 mascote] procurando com a lupa */}
          <ChatyyMascot pose="search" size={124} dark={!!isDark} />
          <Text style={[styles.emptyText, { color: colors.textSecondary, paddingTop: 6 }]}>{t('feed.noResults') || 'Sem resultados'}</Text>
          {/* [grupos 2026-10-21] ninguém encontrado → convidar para o Chatyy */}
          <TouchableOpacity
            onPress={inviteToChatyy}
            style={{ marginTop: 16, paddingHorizontal: 20, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }}
            accessibilityRole="button"
            accessibilityLabel={t('search.inviteToChatyy', 'Convidar para o Chatyy')}
          >
            <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: '600' }}>{t('search.inviteToChatyy', 'Convidar para o Chatyy')}</Text>
          </TouchableOpacity>
        </View>
      ) : (!loading ? (
        // [2026-10-14 vis3] estado vazio inicial — antes a tela ficava em branco.
        <View style={{ alignItems: 'center', paddingTop: 72, paddingHorizontal: 32, gap: 12 }}>
          <View style={{ width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }}>
            <IconSearch size={26} color={colors.textSecondary} />
          </View>
          <Text style={{ color: colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
            {t('search.peopleHint') || 'Busque pessoas pelo nome ou @usuário'}
          </Text>
        </View>
      ) : null)}
    />
  );

  const renderHashtags = () => {
    const showList = query.trim().length >= 2 ? results.hashtags : trendingTags;
    return (
      <FlashList
        data={showList}
        keyExtractor={(h) => String(h.tag)}
        contentContainerStyle={{ padding: 12 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={query.trim().length < 2 ? (
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
            {t('search.trending') || 'Em alta'}
          </Text>
        ) : null}
        renderItem={({ item: h }) => (
          <TouchableOpacity
            style={[styles.row, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : colors.surface }]}
            activeOpacity={0.75}
            onPress={() => router.push(`/hashtag?tag=${encodeURIComponent(h.tag)}`)}
            accessibilityRole="button"
            accessibilityLabel={'#' + h.tag}
          >
            <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.05)' }]}>
              <IconHash size={22} color={colors.text} />
            </View>
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                #{h.tag}
              </Text>
              <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
                {(t('search.mentions') || '{n} menções').replace('{n}', h.mentions || 0)}
              </Text>
            </View>
          </TouchableOpacity>
        )}
      />
    );
  };

  const renderSounds = () => {
    // When there's no query, fall back to "Trending sons" (top sounds from
    // the last 7d), mirroring how Hashtags surfaces #trending on empty.
    const useTrending = query.trim().length < 2;
    const showList = useTrending ? trendingSounds : results.sounds;
    return (
      <FlashList
        data={showList}
        keyExtractor={(s, i) => String(s.id || s.sound_id || s.track_id || s.title || i)}
        contentContainerStyle={{ padding: 12 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={useTrending ? (
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
            {t('search.trendingSounds') || 'Sons em alta'}
          </Text>
        ) : null}
        renderItem={({ item: s }) => {
          const sid = String(s.id || s.sound_id || s.track_id || '');
          const label = s.sound_label || `${s.title || s.name || '?'} — ${s.artist || ''}`.replace(/^ — /, '').replace(/ — $/, '');
          return (
            <TouchableOpacity
              style={[styles.row, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : colors.surface }]}
              activeOpacity={0.75}
              onPress={() => {
                if (!sid) return;
                try { router.push(`/reels-sound?sound_id=${encodeURIComponent(sid)}&label=${encodeURIComponent(label)}`); } catch {}
              }}
              accessibilityRole="button"
              accessibilityLabel={label}
            >
              {s.image_url || s.artwork_url ? (
                <FastImage source={{ uri: s.image_url || s.artwork_url }} style={{ width: 46, height: 46, borderRadius: 8 }} recyclingKey={s.image_url || s.artwork_url} />
              ) : (
                <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.05)', borderRadius: 8 }]}>
                  <IconMusic size={20} color={colors.primary} />
                </View>
              )}
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                  {s.title || s.name || (label || '?')}
                </Text>
                <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
                  {s.artist || ''}
                  {typeof s.post_count === 'number' ? ` · ${(t('search.posts') || '{n} posts').replace('{n}', s.post_count)}` : ''}
                </Text>
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={!loading ? (
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {useTrending
              ? (t('search.noTrendingSounds') || 'Sem sons em alta no momento.')
              : (t('feed.noResults') || 'Sem resultados')}
          </Text>
        ) : null}
      />
    );
  };

  const renderLives = () => (
    <FlashList
      data={results.lives}
      keyExtractor={(l) => String(l.id || l.session_id)}
      contentContainerStyle={{ padding: 12 }}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item: l }) => (
        <TouchableOpacity
          style={[styles.row, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : colors.surface }]}
          activeOpacity={0.75}
          onPress={() => router.push({
            pathname: '/live-viewer',
            params: { sessionId: l.id || l.session_id, hostEmail: l.host_email, hostName: l.host_name, title: l.title },
          })}
          accessibilityRole="button"
          accessibilityLabel={`${t('live.liveNow') || 'Ao vivo'}: ${l.host_name || l.host_email}`}
        >
          <View style={{ position: 'relative' }}>
            <AvatarCircle name={l.host_name} email={l.host_email} size={46} />
            <View style={styles.liveDot}>
              <Text style={styles.liveDotText}>{t('chatConv.liveBadge')}</Text>
            </View>
          </View>
          <View style={styles.rowText}>
            <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
              {l.host_name || l.host_email?.split('@')[0]}
            </Text>
            <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
              {l.title || ''}
            </Text>
          </View>
          {typeof l.viewer_count === 'number' ? (
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginLeft: 8 }}>
              {l.viewer_count}
            </Text>
          ) : null}
        </TouchableOpacity>
      )}
      ListEmptyComponent={!loading ? (
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
          {t('search.noLives') || 'Nenhuma transmissão agora.'}
        </Text>
      ) : null}
    />
  );

  // ── [2026-10-15 native-search-notifs] linhas da lista nativa por aba ──────
  const tt = (k, fb) => { const v = t(k); return v && v !== k ? v : fb; };
  // [2026-10-18 search-tabs] seções da aba Conversas (mesmo modelo p/ nativo e JS).
  const chatSections = React.useMemo(() => {
    if (tab !== 'chats') return [];
    const q = query.trim();
    const out = [];
    const convRows = chatHits.map(({ c, d }) => {
      const url = c.avatar_url || c.group_avatar || '';
      const tiles = (!d.peer && url) ? photoTile(api.getMediaUrl ? api.getMediaUrl(url) : url, d.name, String(c.id)) : contactTile(d.peer || (d.saved ? me : ''), d.name);
      const sub = d.type === 'group' ? `${c.member_count || c.members?.length || ''} ${tt('chat.members', 'membros')}`.trim() : (d.peer && !d.saved ? d.peer : '');
      const row = { id: `c:${c.id}`, k: 'r', t: d.name, tiles, hl: 1 };
      if (sub) row.sb = sub;
      return { row, c, d, open: () => openConv(c, d) };
    });
    if (convRows.length) out.push({ key: 'convs', title: q ? tt('search.tabChats', 'Conversas') : tt('chatConv.recents', 'Recentes'), rows: convRows });
    const lm = localMsgs.q === q ? localMsgs.list : [];
    if (q.length >= 2 && lm.length) {
      const msgRows = lm.slice(0, 8).map((m) => {
        const e = convById.get(String(m.conversation_id));
        const d = e ? e.d : { type: 'direct', peer: '', name: '' };
        const own = String(m.sender_email || '').toLowerCase() === me;
        const who = own ? tt('gsearch.you', 'Você') : (d.type === 'direct' ? d.name : (m.sender_name || d.name));
        const row = { id: `m:${m.id}`, k: 'r', t: d.name || who || '', sb: snippetAround(`${d.type !== 'direct' && who ? who + ': ' : ''}${String(m.content || m.file_name || '')}`, q), sl: 2, hl: 1, gl: 'message', gs: 'r' };
        return { row, m, d, open: () => (e ? openConv(e.c, d, { scrollToMessageId: String(m.id), highlightMessageId: String(m.id) }) : setTab('messages')) };
      });
      out.push({ key: 'msgs', title: tt('gsearch.tab', 'Mensagens'), more: tt('search.seeAll', 'Ver todas'), rows: msgRows });
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, query, chatHits, localMsgs, convById, me, t, openConv]);

  const renderChats = () => {
    const flat = [];
    for (const s0 of chatSections) {
      flat.push({ _h: true, key: `s:${s0.key}`, title: s0.title, more: s0.more });
      for (const r of s0.rows) flat.push({ key: r.row.id, r });
    }
    return (
      <FlashList
        data={flat}
        keyExtractor={(it) => it.key}
        getItemType={(it) => (it._h ? 'h' : 'r')}
        contentContainerStyle={{ padding: 12 }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => item._h ? (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary, flex: 1 }]}>{item.title}</Text>
            {item.more ? (
              <TouchableOpacity onPress={() => setTab('messages')} accessibilityRole="button" hitSlop={8}>
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600', marginBottom: 8 }}>{item.more}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.row, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : colors.surface }]}
            activeOpacity={0.75}
            onPress={item.r.open}
            accessibilityRole="button"
            accessibilityLabel={item.r.row.t}
          >
            <AvatarCircle name={item.r.d?.name || item.r.row.t} email={item.r.d?.peer || undefined} size={46} />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>{item.r.row.t}</Text>
              {item.r.row.sb ? <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={2}>{item.r.row.sb}</Text> : null}
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={(
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {query.trim().length >= 2 ? (t('feed.noResults') || 'Sem resultados') : tt('search.chatsHint', 'Busque conversas, grupos e mensagens')}
          </Text>
        )}
      />
    );
  };

  const nativeMeta = useRef(new Map());
  const nativeRows = React.useMemo(() => {
    if (!nativeOn || isMsgTab(tab)) return [];
    const q = query.trim();
    const typed = q.length >= 2;
    const rows = [];
    const meta = new Map();
    const note = (txt, gl) => rows.push({ id: `n:${tab}`, k: 'n', t: txt, gl: gl || 'search', tap: 0 });
    if (tab === 'chats') {
      for (const s0 of chatSections) {
        rows.push({ id: `s:${s0.key}`, k: 's', t: s0.title, ...(s0.more ? { ac: s0.more } : {}) });
        if (s0.more) meta.set(`s:${s0.key}`, () => setTab('messages'));
        for (const r of s0.rows) { rows.push(r.row); meta.set(r.row.id, r.open); }
      }
      if (!rows.length) note(typed ? tt('feed.noResults', 'Sem resultados') : tt('search.chatsHint', 'Busque conversas, grupos e mensagens'), 'search');
      nativeMeta.current = meta;
      return rows;
    }
    if (tab === 'people') {
      for (const u of results.people || []) {
        if (!u?.email) continue;
        const name = u.name || u.email.split('@')[0];
        const id = `u:${u.email}`;
        rows.push({ id, k: 'r', t: name, sb: u.username ? `@${u.username}` : u.email /* [2026-10-21 tg4] */, tiles: contactTile(u.email, name), hl: 1 });
        meta.set(id, () => router.push(`/u/${encodeURIComponent(u.email)}`));
      }
      if (!rows.length && !loading) {
        note(typed ? tt('feed.noResults', 'Sem resultados') : tt('search.peopleHint', 'Busque pessoas pelo nome ou @usuário'));
        // [grupos 2026-10-21] ninguém com esse nome/número → convidar (WhatsApp/Telegram).
        if (typed) {
          rows.push({ id: 'a:invite', k: 'r', t: tt('search.inviteToChatyy', 'Convidar para o Chatyy'), sb: tt('search.inviteToChatyyDesc', 'Mande o link para quem ainda não usa o Chatyy'), sl: 2, gl: 'userPlus', gs: 'r' });
          meta.set('a:invite', inviteToChatyy);
        }
      }
    } else if (tab === 'hashtags') {
      const list = typed ? results.hashtags : trendingTags;
      if (!typed && list.length) rows.push({ id: 's:trending', k: 's', t: tt('search.trending', 'Em alta') });
      for (const h of list || []) {
        if (!h?.tag) continue;
        const id = `h:${h.tag}`;
        rows.push({ id, k: 'r', t: `#${h.tag}`, sb: tt('search.mentions', '{n} menções').replace('{n}', h.mentions || 0), gl: 'hash', hl: 1 });
        meta.set(id, () => router.push(`/hashtag?tag=${encodeURIComponent(h.tag)}`));
      }
      if (!list?.length && !loading && typed) note(tt('feed.noResults', 'Sem resultados'), 'hash');
    } else if (tab === 'sounds') {
      const list = typed ? results.sounds : trendingSounds;
      if (!typed && list.length) rows.push({ id: 's:trendingSounds', k: 's', t: tt('search.trendingSounds', 'Sons em alta') });
      (list || []).forEach((s0, i) => {
        const sid = String(s0.id || s0.sound_id || s0.track_id || '');
        const label = s0.sound_label || `${s0.title || s0.name || '?'} — ${s0.artist || ''}`.replace(/^ — /, '').replace(/ — $/, '');
        const id = `snd:${sid || i}`;
        const sub = `${s0.artist || ''}${typeof s0.post_count === 'number' ? ` · ${tt('search.posts', '{n} posts').replace('{n}', s0.post_count)}` : ''}`;
        const row = { id, k: 'r', t: s0.title || s0.name || label || '?', hl: 1 };
        if (sub) row.sb = sub;
        const art = s0.image_url || s0.artwork_url;
        if (art) row.th = art; else { row.gl = 'music'; row.gs = 'r'; }
        rows.push(row);
        meta.set(id, () => { if (sid) { try { router.push(`/reels-sound?sound_id=${encodeURIComponent(sid)}&label=${encodeURIComponent(label)}`); } catch {} } });
      });
      if (!list?.length && !loading) note(typed ? tt('feed.noResults', 'Sem resultados') : tt('search.noTrendingSounds', 'Sem sons em alta no momento.'), 'music');
    } else if (tab === 'lives') {
      for (const l of results.lives || []) {
        const sidv = l.id || l.session_id;
        if (!sidv) continue;
        const id = `live:${sidv}`;
        const name = l.host_name || (l.host_email || '').split('@')[0];
        const row = { id, k: 'r', t: name, tiles: contactTile(l.host_email, name), bd: 'live', hl: 1 };
        if (l.title) row.sb = l.title;
        if (typeof l.viewer_count === 'number') row.tm = String(l.viewer_count);
        row.a11y = `${tt('live.liveNow', 'Ao vivo')}: ${name}${l.title ? `, ${l.title}` : ''}`;
        rows.push(row);
        meta.set(id, () => router.push({
          pathname: '/live-viewer',
          params: { sessionId: sidv, hostEmail: l.host_email, hostName: l.host_name, title: l.title },
        }));
      }
      if (!rows.length && !loading) note(tt('search.noLives', 'Nenhuma transmissão agora.'), 'live');
    }
    if (loading) rows.push({ id: 'l:loading', k: 'l' });
    nativeMeta.current = meta;
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeOn, tab, query, results, trendingTags, trendingSounds, loading, t, chatSections, inviteToChatyy]);
  const onNativePress = useCallback((id) => { const fn = nativeMeta.current.get(id); if (fn) fn(); }, []);
  // Seção com "Ver todas" (Mensagens locais → aba Mensagens).
  const onNativeAction = useCallback((id, action) => { if (action === 'section') { const fn = nativeMeta.current.get(id); if (fn) fn(); } }, []);

  // [2026-10-18 search-tabs] barra de busca nativa: foco ao abrir (iOS precisa do ref).
  const nativeHdr = nativeSearchHeaderOn();
  const searchBarRef = useRef(null);
  useEffect(() => {
    if (!nativeHdr) return undefined;
    const tm = setTimeout(() => { try { searchBarRef.current?.focus?.(); } catch {} }, Platform.OS === 'ios' ? 450 : 250);
    return () => clearTimeout(tm);
  }, [nativeHdr]);
  const placeholder = isMsgTab(tab) ? (t('gsearch.placeholder') || 'Pesquisar mensagens…')
    : tab === 'chats' ? tt('search.chatsPlaceholder', 'Pesquisar conversas e mensagens')
    : (t('search.placeholder') || 'Pesquisar pessoas, hashtags, sons…');
  const msgCfg = isMsgTab(tab) ? MSG_TABS[tab] : null;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {nativeHdr ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          isDark,
          title: tt('search.title', 'Pesquisar'),
          search: {
            ref: searchBarRef,
            placeholder,
            autoFocus: true,
            obscureBackground: false,
            hideNavigationBar: false,
            onChangeText: (e) => setQuery(e?.nativeEvent?.text ?? ''),
            onCancelButtonPress: () => setQuery(''),
          },
        })} />
      ) : null}
      <NativeHeaderSafeArea enabled={nativeHdr}>
      {/* Header — back chevron + search input. Auto-focuses the input on
          mount so the user can start typing immediately. */}
      {!nativeHdr && (
      <View style={[styles.header, {
        ...(Platform.OS === 'ios' ? { paddingTop: insets.top + 6 } : null),
        backgroundColor: colors.background,
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={t('common.back') || 'Voltar'}
        >
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={[styles.searchWrap, {
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
        }]}>
          <IconSearch size={18} color={colors.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder={placeholder}
            placeholderTextColor={colors.textSecondary}
            value={query}
            onChangeText={setQuery}
            autoFocus
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel={t('search.placeholder') || 'Pesquisar'}
          />
          {query.length > 0 && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.clear', 'Limpar')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <IconX size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>
      )}

      {/* Tab bar — 4 tabs (Pessoas / Hashtags / Sons / Lives). */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabBar}
        /* RN-Web: a horizontal ScrollView is a flex child of this column
           container and, without a height cap, STRETCHES to fill the leftover
           vertical space — then tabBar's alignItems:'center' parked the pills
           in the middle of the screen with a huge gap under the search bar
           (QA 2026-05-29). flexGrow:0 + maxHeight keeps it a thin tab row. */
        style={{ flexGrow: 0, flexShrink: 0, maxHeight: 52 }}
      >
        {TABS.map((tb) => {
          const active = tab === tb.key;
          return (
            <TouchableOpacity
              key={tb.key}
              onPress={() => { if (tab !== tb.key) { try { require('../constants/theme').haptic?.select?.(); } catch {} } setTab(tb.key); }}
              style={[styles.tabPill, {
                // [2026-10-14 vis3] ativo = pílula sólida (primary/onPrimary), igual aos filtros da home.
                // Antes: texto #111 sobre #111 translúcido → "Pessoas" invisível no escuro.
                backgroundColor: active ? colors.primary : 'transparent',
                borderColor: active ? colors.primary : (isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)'),
              }]}
              activeOpacity={0.75}
              accessibilityRole="tab"
              accessibilityLabel={t(tb.labelKey) || tb.fallback}
              accessibilityState={{ selected: active }}
            >
              <Text numberOfLines={1} style={{ color: active ? colors.onPrimary : colors.text, fontWeight: active ? '600' : '500', fontSize: 13 }}>
                {t(tb.labelKey) || tb.fallback}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading && !(nativeOn && !isMsgTab(tab)) && !isMsgTab(tab) && tab !== 'chats' && (
        // [2026-10-20 ux] skeleton das linhas em vez de spinner solto
        <View style={{ paddingTop: 4 }}>
          <SkeletonRows count={5} avatarSize={40} />
        </View>
      )}

      {isMsgTab(tab) ? (
        <GlobalMessageSearch
          key={tab}
          query={query} colors={colors} isDark={isDark} t={t} router={router} pillStyle={styles.tabPill}
          lockedTypes={msgCfg ? msgCfg.types : undefined}
          layout={msgCfg ? msgCfg.layout : undefined}
          emptyText={msgCfg ? tt(msgCfg.emptyKey, msgCfg.emptyFb) : undefined}
        />
      ) : nativeOn ? (
        <NativeResultList
          rows={nativeRows}
          highlight={query.trim().length >= 2 ? query.trim().replace(/^#/, '') : ''}
          colors={colors}
          isDark={isDark}
          onPress={onNativePress}
          onAction={onNativeAction}
          onFailure={onNativeFailure}
        />
      ) : (
      <FadeSlideIn>
        {tab === 'chats' && renderChats()}
        {tab === 'people' && renderPeople()}
        {tab === 'hashtags' && renderHashtags()}
        {tab === 'sounds' && renderSounds()}
        {tab === 'lives' && renderLives()}
      </FadeSlideIn>
      )}
      </NativeHeaderSafeArea>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    paddingHorizontal: 12,
    gap: 8,
    borderRadius: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  tabPill: {
    // flexShrink:0 keeps every pill at its label width inside the horizontal
    // ScrollView. On RN-Web a horizontal ScrollView lays its children in a
    // flex row, and without this the 4 pills get squeezed at narrow widths,
    // wrapping/overlapping the tab labels. flexShrink:0 forces horizontal
    // scroll instead. Keep the row from wrapping for the same reason.
    flexShrink: 0,
    flexGrow: 0,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: 12,
    marginBottom: 8,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 12 },
  iconCircle: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyText: {
    textAlign: 'center',
    paddingVertical: 40,
    fontSize: 14,
  },
  liveDot: {
    position: 'absolute',
    bottom: -4,
    right: -6,
    backgroundColor: '#dc2626',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  liveDotText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
});
