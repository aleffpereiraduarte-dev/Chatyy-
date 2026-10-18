import React, { useEffect, useState, useCallback, useRef } from 'react';
import FastImage from '../components/FastImage'; // [2026-10-09 expo-image]
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, Platform, ScrollView, Image,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../context/LanguageContext';
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
import { contactTile } from '../components/native/resultListAdapter';


// Unified search screen — Pessoas / Hashtags / Sons / Lives. Each tab calls
// the matching backend endpoint (search_users, trending_hashtags + feed
// captions, chat_status_music_search, live_list). The tab bar is a sliding
// pill consistent with the rest of the app (ChatFeedTab + ChatListTab).
const TABS = [
  { key: 'people',   labelKey: 'search.people',   fallback: 'Pessoas' },
  // [2026-10-14 busca-global] mensagens de todas as conversas por texto/tipo/data (chat_search_advanced).
  { key: 'messages', labelKey: 'gsearch.tab',     fallback: 'Mensagens' },
  { key: 'hashtags', labelKey: 'search.hashtags', fallback: 'Hashtags' },
  { key: 'sounds',   labelKey: 'search.sounds',   fallback: 'Sons' },
  { key: 'lives',    labelKey: 'search.lives',    fallback: 'Lives' },
];

export default function SearchScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets(); // [2026-10-18 safe-area] topo real (era 50 fixo no iOS)

  // [2026-10-14 busca-global] /search?tab=messages abre direto na aba Mensagens.
  const _params = useLocalSearchParams();
  const [tab, setTab] = useState(() => (TABS.some((x) => x.key === _params?.tab) ? String(_params.tab) : 'people'));
  const [query, setQuery] = useState('');
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
    if (activeTab === 'messages') return; // [2026-10-14 busca-global] a aba Mensagens busca sozinha (GlobalMessageSearch)
    const trimmed = String(q || '').trim();
    if (trimmed.length < 2) {
      setLoading(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      if (activeTab === 'people') {
        const r = await api.searchUsers(trimmed);
        if (reqId !== reqIdRef.current) return;
        const users = (r?.success && Array.isArray(r.data?.users)) ? r.data.users : [];
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
    debounceRef.current = setTimeout(() => { runSearch(query, tab); }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, tab, runSearch]);

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
            <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
              {u.name || u.email?.split('@')[0]}
            </Text>
            <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
              {u.email}
            </Text>
          </View>
        </TouchableOpacity>
      )}
      ListEmptyComponent={!loading && query.trim().length >= 2 ? (
        <View style={{ alignItems: 'center', paddingTop: 40 }}>{/* [2026-10-16 mascote] procurando com a lupa */}
          <ChatyyMascot pose="search" size={124} dark={!!isDark} />
          <Text style={[styles.emptyText, { color: colors.textSecondary, paddingTop: 6 }]}>{t('feed.noResults') || 'Sem resultados'}</Text>
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
  const nativeMeta = useRef(new Map());
  const nativeRows = React.useMemo(() => {
    if (!nativeOn || tab === 'messages') return [];
    const q = query.trim();
    const typed = q.length >= 2;
    const rows = [];
    const meta = new Map();
    const note = (txt, gl) => rows.push({ id: `n:${tab}`, k: 'n', t: txt, gl: gl || 'search', tap: 0 });
    if (tab === 'people') {
      for (const u of results.people || []) {
        if (!u?.email) continue;
        const name = u.name || u.email.split('@')[0];
        const id = `u:${u.email}`;
        rows.push({ id, k: 'r', t: name, sb: u.email, tiles: contactTile(u.email, name), hl: 1 });
        meta.set(id, () => router.push(`/u/${encodeURIComponent(u.email)}`));
      }
      if (!rows.length && !loading) note(typed ? tt('feed.noResults', 'Sem resultados') : tt('search.peopleHint', 'Busque pessoas pelo nome ou @usuário'));
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
  }, [nativeOn, tab, query, results, trendingTags, trendingSounds, loading, t]);
  const onNativePress = useCallback((id) => { const fn = nativeMeta.current.get(id); if (fn) fn(); }, []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header — back chevron + search input. Auto-focuses the input on
          mount so the user can start typing immediately. */}
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
            placeholder={tab === 'messages' ? (t('gsearch.placeholder') || 'Pesquisar mensagens…') : (t('search.placeholder') || 'Pesquisar pessoas, hashtags, sons…')}
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
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <IconX size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

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
              onPress={() => setTab(tb.key)}
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

      {loading && !(nativeOn && tab !== 'messages') && (
        <View style={{ paddingVertical: 10 }}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      )}

      {nativeOn && tab !== 'messages' ? (
        <NativeResultList
          rows={nativeRows}
          highlight={query.trim().length >= 2 ? query.trim().replace(/^#/, '') : ''}
          colors={colors}
          isDark={isDark}
          onPress={onNativePress}
          onFailure={onNativeFailure}
        />
      ) : (
      <FadeSlideIn>
        {tab === 'people' && renderPeople()}
        {tab === 'messages' && (
          <GlobalMessageSearch query={query} colors={colors} isDark={isDark} t={t} router={router} pillStyle={styles.tabPill} />
        )}
        {tab === 'hashtags' && renderHashtags()}
        {tab === 'sounds' && renderSounds()}
        {tab === 'lives' && renderLives()}
      </FadeSlideIn>
      )}
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
