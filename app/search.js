import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, Platform, ScrollView, Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconSearch, IconX, IconHash, IconVideo, IconMusic } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import * as api from '../services/api';

const ACCENT = '#7C3AED';

// Unified search screen — Pessoas / Hashtags / Sons / Lives. Each tab calls
// the matching backend endpoint (search_users, trending_hashtags + feed
// captions, chat_status_music_search, live_list). The tab bar is a sliding
// pill consistent with the rest of the app (ChatFeedTab + ChatListTab).
const TABS = [
  { key: 'people',   labelKey: 'search.people',   fallback: 'Pessoas' },
  { key: 'hashtags', labelKey: 'search.hashtags', fallback: 'Hashtags' },
  { key: 'sounds',   labelKey: 'search.sounds',   fallback: 'Sons' },
  { key: 'lives',    labelKey: 'search.lives',    fallback: 'Lives' },
];

export default function SearchScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [tab, setTab] = useState('people');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState({ people: [], hashtags: [], sounds: [], lives: [] });
  const [trendingTags, setTrendingTags] = useState([]);
  // Reels P1 — trending sounds (last 7d). Shown on the Sons tab empty
  // state, mirroring how Hashtags surfaces trending hashtags. Backed by
  // reels_trending_sounds which aggregates chat_feed_posts.sound_id.
  const [trendingSounds, setTrendingSounds] = useState([]);
  const debounceRef = useRef(null);
  const reqIdRef = useRef(0);

  // Initial trending hashtag list shown on the empty-state of the Hashtags tab.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.trendingHashtags(30);
        if (alive && r?.success && Array.isArray(r.data?.tags)) {
          setTrendingTags(r.data.tags);
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
      setResults(prev => ({ ...prev, people: [], sounds: [] }));
      return;
    }
    debounceRef.current = setTimeout(() => { runSearch(query, tab); }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, tab, runSearch]);

  // Renderers per tab.
  const renderPeople = () => (
    <FlatList
      data={results.people}
      keyExtractor={(u) => u.email}
      contentContainerStyle={{ padding: 12 }}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item: u }) => (
        <TouchableOpacity
          style={[styles.row, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff' }]}
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
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{t('feed.noResults') || 'Sem resultados'}</Text>
      ) : null}
    />
  );

  const renderHashtags = () => {
    const showList = query.trim().length >= 2 ? results.hashtags : trendingTags;
    return (
      <FlatList
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
            style={[styles.row, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff' }]}
            activeOpacity={0.75}
            onPress={() => router.push(`/hashtag?tag=${encodeURIComponent(h.tag)}`)}
            accessibilityRole="button"
            accessibilityLabel={'#' + h.tag}
          >
            <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)' }]}>
              <IconHash size={22} color={ACCENT} />
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
      <FlatList
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
              style={[styles.row, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff' }]}
              activeOpacity={0.75}
              onPress={() => {
                if (!sid) return;
                try { router.push(`/reels-sound?sound_id=${encodeURIComponent(sid)}&label=${encodeURIComponent(label)}`); } catch {}
              }}
              accessibilityRole="button"
              accessibilityLabel={label}
            >
              {s.image_url || s.artwork_url ? (
                <Image source={{ uri: s.image_url || s.artwork_url }} style={{ width: 46, height: 46, borderRadius: 8 }} />
              ) : (
                <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)', borderRadius: 8 }]}>
                  <IconMusic size={20} color="#7C3AED" />
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
    <FlatList
      data={results.lives}
      keyExtractor={(l) => String(l.id || l.session_id)}
      contentContainerStyle={{ padding: 12 }}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item: l }) => (
        <TouchableOpacity
          style={[styles.row, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff' }]}
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
              <Text style={styles.liveDotText}>LIVE</Text>
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

  return (
    <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
      {/* Header — back chevron + search input. Auto-focuses the input on
          mount so the user can start typing immediately. */}
      <View style={[styles.header, {
        backgroundColor: isDark ? colors.background : '#f6f8fa',
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
          <IconSearch size={18} color={isDark ? '#888' : '#999'} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder={t('search.placeholder') || 'Pesquisar pessoas, hashtags, sons…'}
            placeholderTextColor={isDark ? '#666' : '#999'}
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
              <IconX size={18} color={isDark ? '#888' : '#999'} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Tab bar — 4 tabs (Pessoas / Hashtags / Sons / Lives). */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabBar}
      >
        {TABS.map((tb) => {
          const active = tab === tb.key;
          return (
            <TouchableOpacity
              key={tb.key}
              onPress={() => setTab(tb.key)}
              style={[styles.tabPill, {
                backgroundColor: active
                  ? (isDark ? 'rgba(124,58,237,0.22)' : 'rgba(124,58,237,0.12)')
                  : 'transparent',
                borderColor: active ? ACCENT : (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)'),
              }]}
              activeOpacity={0.75}
              accessibilityRole="tab"
              accessibilityLabel={t(tb.labelKey) || tb.fallback}
              accessibilityState={{ selected: active }}
            >
              <Text numberOfLines={1} style={{ color: active ? ACCENT : colors.text, fontWeight: active ? '700' : '500', fontSize: 13 }}>
                {t(tb.labelKey) || tb.fallback}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading && (
        <View style={{ paddingVertical: 10 }}>
          <ActivityIndicator size="small" color={ACCENT} />
        </View>
      )}

      {tab === 'people' && renderPeople()}
      {tab === 'hashtags' && renderHashtags()}
      {tab === 'sounds' && renderSounds()}
      {tab === 'lives' && renderLives()}
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
    ...(Platform.OS === 'ios' ? { paddingTop: 50 } : {}),
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
