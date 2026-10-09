import React, { useState, useEffect, useCallback, useRef } from 'react';
import FastImage from './FastImage'; // [2026-10-09 expo-image]
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, RefreshControl,
  ActivityIndicator, Platform, Dimensions, TextInput, Modal, ScrollView, Alert,
  Image, Linking, BackHandler, KeyboardAvoidingView,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import { IconSearch, IconPlus, IconArrowLeft, IconPlay } from './Icons';
// [2026-10-08 apps-native] feedback nativo (célula iOS/ripple Android), empty
// state canônico e haptics — antes tudo era TouchableOpacity (fade de site).
import PressableRow from './PressableRow';
import PressableScale from './PressableScale';
import ScreenEmptyState from './ScreenEmptyState';
import { haptic } from '../constants/theme';
import Svg, { Path, Circle as SvgCircle, Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';

function IconPaperclip({ size = 22, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
    </Svg>
  );
}

const ACCENT = '#111111';
const ACCENT_DARK = '#111111';
const SCREEN_WIDTH = Dimensions.get('window').width;

// Filter chips on Discover (top-level filters: subscribed/discover/suggested/recent)
const FILTER_CHIPS = [
  { key: 'subscribed', label: 'Inscritos' },
  { key: 'discover', label: 'Descobrir' },
  { key: 'suggested', label: 'Sugeridos' },
  { key: 'recent', label: 'Recentes' },
];

// Format follower counts ("12.4K" / "1.2M") for badge display
function formatCount(n) {
  const num = parseInt(n) || 0;
  if (num < 1000) return String(num);
  if (num < 1_000_000) {
    const k = num / 1000;
    return (k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')) + 'K';
  }
  const m = num / 1_000_000;
  return (m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')) + 'M';
}

// Card cover gradient (placeholder when no cover_url available)
function CardCoverFallback({ seed = 0 }) {
  // Six brand-harmonized gradients seeded by channel id parity
  const palettes = [
    ['#111111', '#111111'],
    ['#111111', '#111111'],
    ['#111111', '#111111'],
    ['#111111', '#111111'],
    ['#111111', '#111111'],
    ['#111111', '#111111'],
  ];
  const [a, b] = palettes[Math.abs(seed) % palettes.length];
  const id = `cardCover-${Math.abs(seed) % palettes.length}`;
  return (
    <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={a} stopOpacity="1" />
          <Stop offset="1" stopColor={b} stopOpacity="1" />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

// Dark fade overlay for card text legibility
function CardDarkFade() {
  return (
    <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient id="cardFade" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#000" stopOpacity="0.05" />
          <Stop offset="0.55" stopColor="#000" stopOpacity="0.35" />
          <Stop offset="1" stopColor="#000" stopOpacity="0.78" />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#cardFade)" />
    </Svg>
  );
}

function IconUsersSmall({ size = 11, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <Path d="M9 11a4 4 0 100-8 4 4 0 000 8z" />
    </Svg>
  );
}

const CATEGORIES = [
  { key: 'all', emoji: '\uD83D\uDD25' },
  { key: 'news', emoji: '\uD83D\uDCF0' },
  { key: 'sports', emoji: '\u26BD' },
  { key: 'tech', emoji: '\uD83D\uDCBB' },
  { key: 'entertainment', emoji: '\uD83C\uDFAC' },
  { key: 'education', emoji: '\uD83D\uDCDA' },
  { key: 'business', emoji: '\uD83D\uDCBC' },
  { key: 'lifestyle', emoji: '\u2728' },
  { key: 'gaming', emoji: '\uD83C\uDFAE' },
  { key: 'music', emoji: '\uD83C\uDFB5' },
  { key: 'health', emoji: '\uD83C\uDFCB' },
  { key: 'general', emoji: '\uD83D\uDCAC' },
];

function IconMegaphone({ size = 20, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 11l18-5v12L3 13v-2z" />
      <Path d="M11.6 16.8a3 3 0 11-5.8-1.6" />
    </Svg>
  );
}

function relativeTime(dateStr, t) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return t('time.now') || 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  {const _d = new Date(dateStr); return isNaN(_d.getTime()) ? "" : _d.toLocaleDateString();}
}

// [2026-10-08 apps-native] O backend mapeia canais p/ conversas (chat.php
// $qrAlias): channel_my_channels→chat_list, channel_feed→chat_messages,
// chat_channel_info→chat_group_info. Os campos que a UI lia (latest_post,
// follower_count, posts/items, r.cnt, my_reaction, info.is_admin/is_member)
// NÃO existem nessas respostas → feed sempre "Sem posts", admin nunca via o
// campo de postar, contadores 0. Normaliza aqui os dois formatos.
function channelPreview(item) {
  return item?.latest_post || item?.last_message?.content || item?.description || '';
}
function channelTime(item) {
  return item?.latest_post_at || item?.last_message_at || item?.last_message?.created_at || item?.created_at;
}
function channelCount(item) {
  return parseInt(item?.follower_count ?? item?.subscriber_count ?? item?.member_count, 10) || 0;
}
function normalizeReactions(post, myEmail) {
  const me = String(myEmail || '').toLowerCase();
  let mine = post?.my_reaction || null;
  const list = (Array.isArray(post?.reactions) ? post.reactions : []).map((r) => {
    const users = Array.isArray(r?.users) ? r.users : [];
    if (!mine && me && users.some(u => String(u || '').toLowerCase() === me)) mine = r.emoji;
    return { emoji: r?.emoji, cnt: parseInt(r?.cnt ?? r?.count, 10) || 0 };
  }).filter(r => r.emoji && r.cnt > 0);
  return { list, mine };
}

// ── Quick emoji reaction bar ──
const QUICK_REACTIONS = ['\uD83D\uDC4D', '\u2764\uFE0F', '\uD83D\uDD25', '\uD83D\uDE02', '\uD83D\uDE2E', '\uD83D\uDE22'];

// ── Following Tab: channels user follows ──
function FollowingList({ colors, isDark, t, onOpenChannel, onDiscover, onCreate }) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false); // [2026-10-08 apps-native] erro ≠ vazio

  const load = useCallback(async () => {
    try {
      const res = await api.channelMyChannels();
      if (api.apiOk(res)) { setChannels(api.apiList(res, 'channels', 'conversations')); setFailed(false); }
      else setFailed(true);
    } catch { setFailed(true); } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const renderItem = useCallback(({ item }) => (
    <PressableRow
      onPress={() => { haptic.light(); onOpenChannel(item); }}
      style={[styles.channelRow, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}
      accessibilityRole="button"
      accessibilityLabel={item.name}
    >
      <View style={[styles.channelAvatar, { backgroundColor: isDark ? '#1a1a24' : '#f0f0f5' }]}>
        {(item.photo_url || item.avatar) ? (
          <AvatarCircle name={item.name} uri={item.photo_url || item.avatar} size={50} />
        ) : (
          <IconMegaphone size={24} color={colors.text} />
        )}
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>{item.name}</Text>
        <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 2 }} numberOfLines={1}>
          {channelPreview(item)}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
          {relativeTime(channelTime(item), t)}
        </Text>
        <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 4 }}>
          {formatCount(channelCount(item))} {t('channel.followers') || 'followers'}
        </Text>
      </View>
    </PressableRow>
  ), [colors, isDark, t, onOpenChannel]);

  if (loading) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator color={colors.text} size="large" /></View>;

  if (channels.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
      >
        {failed ? (
          <ScreenEmptyState
            kind="search"
            title={t('common.error') || 'Erro'}
            subtitle={t('common.tryAgain') || 'Tentar novamente'}
            cta={{ label: t('common.retry') || 'Tentar novamente', onPress: () => { setLoading(true); load(); } }}
          />
        ) : (
          <ScreenEmptyState
            kind="notifications"
            title={t('channel.noFollowing') || 'You are not following any channels yet'}
            subtitle={t('channel.discoverDesc') || 'Discover channels to follow'}
            cta={onDiscover ? { label: t('channel.discover') || 'Discover', onPress: onDiscover } : undefined}
            secondary={onCreate ? { label: t('channel.create') || 'New Channel', onPress: onCreate } : undefined}
          />
        )}
      </ScrollView>
    );
  }

  return (
    <FlatList
      data={channels}
      keyExtractor={(item) => String(item.id)}
      renderItem={renderItem}
      initialNumToRender={12}
      windowSize={7}
      removeClippedSubviews={Platform.OS === 'android'}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
    />
  );
}

// ── Discover Tab: browse/search all public channels ──
function DiscoverList({ colors, isDark, t, onOpenChannel }) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [filter, setFilter] = useState('discover'); // top-level: subscribed/discover/suggested/recent
  const [refreshing, setRefreshing] = useState(false);
  const searchTimeout = useRef(null);

  // [2026-10-08 trust-channels] Backend chat_discover_channels now really
  // lists public channels (paginated). Top-level filter maps to the server:
  // subscribed → include_following (then keep only is_member), recent →
  // sort=recent, discover/suggested → default (excludes channels I follow).
  const PAGE = 30;
  const reqSeq = useRef(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const nextOffsetRef = useRef(0);

  const load = useCallback(async (cat, q, flt, append = false) => {
    const seq = ++reqSeq.current;
    const offset = append ? nextOffsetRef.current : 0;
    try {
      const res = await api.channelDiscover(cat === 'all' ? '' : cat, q, PAGE, offset, {
        includeFollowing: flt === 'subscribed',
        sort: flt === 'recent' ? 'recent' : 'members',
      });
      if (seq !== reqSeq.current) return; // stale (filter/search changed meanwhile)
      if (api.apiOk(res)) {
        const rows = api.apiList(res, 'channels', 'conversations', 'items') || [];
        const payload = api.apiPayload(res) || {};
        nextOffsetRef.current = typeof payload.next_offset === 'number' ? payload.next_offset : offset + rows.length;
        setHasMore(!!payload.has_more);
        setChannels(prev => {
          if (!append) return rows;
          const seen = new Set(prev.map(c => c.id));
          return prev.concat(rows.filter(c => !seen.has(c.id)));
        });
      }
    } catch {} finally {
      if (seq === reqSeq.current) { setLoading(false); setRefreshing(false); setLoadingMore(false); }
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load(category, search, filter);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [category, filter, load]);

  const onSearchChange = useCallback((text) => {
    setSearch(text);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => load(category, text, filter), 400);
  }, [category, filter, load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(category, search, filter); }, [category, search, filter, load]);

  const onEndReached = useCallback(() => {
    if (!hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    load(category, search, filter, true);
  }, [hasMore, loadingMore, loading, category, search, filter, load]);

  // [2026-10-08 apps-native] otimista + haptic (antes: espera rede + reload
  // inteiro, e erro engolido sem reverter).
  const handleFollow = useCallback(async (ch) => {
    const wasMember = !!ch.is_member;
    haptic.select();
    setChannels(prev => prev.map(c => (c.id === ch.id ? { ...c, is_member: !wasMember } : c)));
    try {
      const res = wasMember ? await api.channelUnfollow(ch.id) : await api.channelFollow(ch.id);
      if (!api.apiOk(res)) throw new Error(api.apiMsg(res) || 'follow failed');
    } catch {
      setChannels(prev => prev.map(c => (c.id === ch.id ? { ...c, is_member: wasMember } : c)));
      haptic.error();
    }
  }, []);

  // Server already filters/sorts per top-level filter; 'subscribed' asks for
  // include_following, so keep only the ones I follow. Channels followed from
  // this list stay visible (optimistic is_member) until the next reload.
  const displayed = React.useMemo(() => {
    if (!Array.isArray(channels)) return [];
    if (filter === 'subscribed') return channels.filter(c => c.is_member);
    return channels;
  }, [channels, filter]);

  return (
    <View style={{ flex: 1 }}>
      {/* Search */}
      <View style={[styles.searchBar, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6' }]}>
        <IconSearch size={16} color={isDark ? '#666' : '#999'} />
        <TextInput
          value={search}
          onChangeText={onSearchChange}
          placeholder={t('channel.searchPlaceholder') || 'Buscar canais...'}
          placeholderTextColor={isDark ? '#555' : '#9ca3af'}
          style={[styles.searchInput, { color: colors.text }]}
          autoCorrect={false}
        />
      </View>

      {/* Top-level filter chips: Inscritos / Descobrir / Sugeridos / Recentes */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, marginBottom: 6 }}
        contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}
      >
        {FILTER_CHIPS.map((f) => {
          const active = filter === f.key;
          return (
            <PressableScale
              key={f.key}
              onPress={() => setFilter(f.key)}
              haptic="select"
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[
                styles.filterChip,
                active
                  ? { backgroundColor: ACCENT, borderColor: ACCENT }
                  : { backgroundColor: 'transparent', borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)' },
              ]}
            >
              <Text style={{
                fontSize: 13,
                fontWeight: '700',
                color: active ? '#fff' : colors.text,
                letterSpacing: 0.1,
              }}>
                {t(`channel.filter.${f.key}`) || f.label}
              </Text>
            </PressableScale>
          );
        })}
      </ScrollView>

      {/* Category pills (secondary) */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: 10 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}>
        {CATEGORIES.map((cat) => (
          <PressableScale
            key={cat.key}
            onPress={() => setCategory(cat.key)}
            haptic="select"
            accessibilityRole="button"
            accessibilityState={{ selected: category === cat.key }}
            style={[styles.categoryPill, {
              backgroundColor: category === cat.key ? ACCENT : (isDark ? '#1a1a24' : '#f0f0f5'),
            }]}
          >
            {/* [2026-10-08 apps-native] emoji removido (regra: UI sem emoji) */}
            <Text style={{
              fontSize: 12, fontWeight: '600',
              color: category === cat.key ? '#fff' : colors.text,
            }}>
              {t(`channel.cat.${cat.key}`) || cat.key.charAt(0).toUpperCase() + cat.key.slice(1)}
            </Text>
          </PressableScale>
        ))}
      </ScrollView>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator color={colors.text} size="large" /></View>
      ) : displayed.length === 0 ? (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
        >
          <ScreenEmptyState
            kind="search"
            compact
            title={t('channel.noChannels') || 'Nenhum canal encontrado'}
            subtitle={t('channel.discoverDesc') || 'Find public channels to follow'}
          />
        </ScrollView>
      ) : (
        <FlatList
          data={displayed}
          keyExtractor={(item) => String(item.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 20, gap: 12 }}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          initialNumToRender={6}
          windowSize={7}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.5}
          ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.text} style={{ marginVertical: 12 }} /> : null}
          renderItem={({ item }) => {
            const subCountNum = channelCount(item);
            // [2026-10-08 apps-native] era ' membro'/' membros' fixo em PT
            const subText = formatCount(subCountNum) + ' ' + (t('channel.subscribers') || 'subscribers');
            const catLabel = item.category && item.category !== 'general'
              ? (t(`channel.cat.${item.category}`) || item.category)
              : null;
            return (
              <PressableScale
                onPress={() => onOpenChannel(item)}
                style={styles.coverCard}
                accessibilityRole="button"
                accessibilityLabel={item.name}
              >
                {/* Cover background \u2014 placeholder gradient until cover_url wired */}
                <CardCoverFallback seed={item.id || 0} />
                <CardDarkFade />

                {/* Members badge top-right (12.4K format) */}
                <View style={styles.coverMembersBadge}>
                  <IconUsersSmall size={11} color="#fff" />
                  <Text style={styles.coverMembersBadgeText}>{formatCount(subCountNum)}</Text>
                </View>

                {/* Content overlay (bottom) \u2014 name + desc + meta + Subscribe pill */}
                <View style={styles.coverContent}>
                  <Text style={styles.coverTitle} numberOfLines={1}>{item.name}</Text>
                  {item.description ? (
                    <Text style={styles.coverDesc} numberOfLines={2}>{item.description}</Text>
                  ) : null}
                  <View style={styles.coverFooterRow}>
                    <Text style={styles.coverFooterMeta} numberOfLines={1}>
                      {subText}{catLabel ? `   ${catLabel}` : ''}
                    </Text>
                    <PressableScale
                      onPress={() => handleFollow(item)}
                      haptic={false}
                      hitSlop={8}
                      accessibilityRole="button"
                      style={[
                        styles.coverJoinBtn,
                        item.is_member
                          ? { backgroundColor: 'transparent', borderColor: 'rgba(255,255,255,0.7)' }
                          : { backgroundColor: ACCENT, borderColor: ACCENT },
                      ]}
                    >
                      <Text style={styles.coverJoinBtnText}>
                        {item.is_member ? (t('channel.joined') || 'Inscrito') : (t('channel.join') || 'Inscrever')}
                      </Text>
                    </PressableScale>
                  </View>
                </View>
              </PressableScale>
            );
          }}
        />
      )}
    </View>
  );
}

// ── Channel View: scrollable feed of posts ──
// [2026-10-08 apps-native] Reescrito sobre o formato REAL do backend
// (chat_messages/chat_group_info): posts em `messages` (asc → invertido p/
// mais novo no topo), reações {emoji,count,users}, admin = role do membro ou
// criador, não-membro (preview de canal descoberto) = CTA Entrar. Mídia
// (image/video) agora aparece; back do Android volta p/ lista; haptics.
function ChannelView({ channel, colors, isDark, t, onBack }) {
  const { user } = useAuth();
  const myEmail = String(user?.email || '').toLowerCase();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null);
  const [isMember, setIsMember] = useState(channel.is_member !== false);
  const [joining, setJoining] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newPost, setNewPost] = useState('');
  const [posting, setPosting] = useState(false);
  const [attaching, setAttaching] = useState(false);

  // Android: botão voltar do sistema fecha o canal (antes saía da aba inteira).
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack?.(); return true; });
    return () => sub.remove();
  }, [onBack]);

  const loadPosts = useCallback(async () => {
    try {
      // Independentes: não-membro recebe 403 no info/feed — um não derruba o outro.
      const [feedRes, infoRes] = await Promise.all([
        api.channelFeed(channel.id).catch(e => ({ success: false, _err: e })),
        api.channelInfo(channel.id).catch(e => ({ success: false, _err: e })),
      ]);
      if (api.apiOk(feedRes)) {
        const rows = api.apiList(feedRes, 'messages', 'posts', 'items')
          .filter(m => m && m.type !== 'system' && !m.deleted_at);
        // chat_messages devolve ascendente; canal mostra o mais novo primeiro.
        const asc = rows.length > 1 && new Date(rows[0].created_at) < new Date(rows[rows.length - 1].created_at);
        setPosts(asc ? rows.slice().reverse() : rows);
      }
      if (api.apiOk(infoRes)) {
        setInfo(api.apiPayload(infoRes) || null);
        setIsMember(true); // chat_group_info exige membership → ok ⇒ membro
      } else if (infoRes && (infoRes.status === 403 || infoRes._err?.status === 403 || /member/i.test(api.apiMsg(infoRes) || String(infoRes._err?.message || '')))) {
        setIsMember(false);
      }
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [channel.id]);

  useEffect(() => { loadPosts(); }, [loadPosts]);

  const onRefresh = useCallback(() => { setRefreshing(true); loadPosts(); }, [loadPosts]);

  const handleJoin = useCallback(async () => {
    if (joining) return;
    setJoining(true);
    haptic.select();
    try {
      const res = await api.channelFollow(channel.id);
      if (!api.apiOk(res)) throw new Error(api.apiMsg(res) || 'join failed');
      setIsMember(true);
      haptic.success();
      loadPosts();
    } catch {
      haptic.error();
      Alert.alert(t('common.error') || 'Erro', t('common.tryAgain') || 'Tentar novamente');
    } finally { setJoining(false); }
  }, [joining, channel.id, loadPosts, t]);

  const handlePost = useCallback(async () => {
    if (!newPost.trim() || posting) return;
    setPosting(true);
    try {
      const res = await api.channelPost(channel.id, newPost.trim());
      if (api.apiOk(res)) {
        haptic.success();
        setNewPost('');
        loadPosts();
      } else {
        Alert.alert(t('common.error') || 'Erro', api.apiMsg(res) || (t('channel.postFailed') || 'Não foi possível publicar'));
      }
    } catch {
      Alert.alert(t('common.error') || 'Erro', t('channel.postFailed') || 'Não foi possível publicar');
    } finally { setPosting(false); }
  }, [newPost, posting, channel.id, loadPosts, t]);

  const handleAttach = useCallback(async () => {
    if (attaching || posting) return;
    try {
      const ImagePicker = require('expo-image-picker');
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(t('common.error') || 'Erro', t('channel.mediaPermission') || 'Permita o acesso à galeria para anexar mídia');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.8,
      });
      if (result.canceled || !result.assets || !result.assets[0]) return;
      const asset = result.assets[0];
      const isVideo = asset.type === 'video' || /\.(mp4|mov|m4v|webm)$/i.test(asset.uri || '');
      const postType = isVideo ? 'video' : 'image';
      const file = {
        uri: asset.uri,
        name: asset.fileName || (isVideo ? 'video.mp4' : 'image.jpg'),
        type: asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
      };
      setAttaching(true);
      const up = await api.rustUpload(file, user?.email, 'channel');
      const fileUrl = up?.cdn_url || up?.data?.cdn_url;
      if (!up?.success || !fileUrl) {
        Alert.alert(t('common.error') || 'Erro', t('channel.uploadFailed') || 'Não foi possível enviar a mídia');
        return;
      }
      const res = await api.channelPost(channel.id, newPost.trim(), postType, fileUrl);
      if (api.apiOk(res)) {
        haptic.success();
        setNewPost('');
        loadPosts();
      } else {
        Alert.alert(t('common.error') || 'Erro', api.apiMsg(res) || (t('channel.postFailed') || 'Não foi possível publicar'));
      }
    } catch {
      Alert.alert(t('common.error') || 'Erro', t('channel.uploadFailed') || 'Não foi possível enviar a mídia');
    } finally {
      setAttaching(false);
    }
  }, [attaching, posting, channel.id, newPost, user, loadPosts, t]);

  // Otimista: aplica local na hora (toggle como o chat), servidor em seguida.
  const handleReact = useCallback(async (postId, emoji) => {
    haptic.light();
    setPosts(prev => prev.map((p) => {
      if (p.id !== postId) return p;
      const { mine } = normalizeReactions(p, myEmail);
      const base = (Array.isArray(p.reactions) ? p.reactions : []).map((r) => {
        const users = (Array.isArray(r.users) ? r.users : []).filter(u => String(u || '').toLowerCase() !== myEmail);
        return { ...r, users, count: users.length || Math.max(0, (parseInt(r.count ?? r.cnt, 10) || 0) - (r.emoji === mine ? 1 : 0)), cnt: undefined };
      });
      if (mine !== emoji) {
        const i = base.findIndex(r => r.emoji === emoji);
        if (i >= 0) base[i] = { ...base[i], users: [...base[i].users, myEmail], count: (base[i].count || 0) + 1 };
        else base.push({ emoji, users: [myEmail], count: 1 });
      }
      return { ...p, reactions: base, my_reaction: mine === emoji ? null : emoji };
    }));
    try { await api.channelReact(postId, emoji); } catch { loadPosts(); }
  }, [myEmail, loadPosts]);

  const isAdmin = !!(info?.is_admin
    || (Array.isArray(info?.members) && info.members.some(m => String(m?.email || '').toLowerCase() === myEmail && m?.role === 'admin'))
    || (myEmail && String(info?.created_by || channel.created_by || '').toLowerCase() === myEmail));
  const followerCount = channelCount(info) || channelCount(channel);

  const renderPost = useCallback(({ item }) => {
    const { list: reactions, mine } = normalizeReactions(item, myEmail);
    const media = item.file_url || item.media_url || '';
    const isImage = media && (item.type === 'image' || /\.(jpe?g|png|gif|webp|heic)(\?|$)/i.test(media));
    const isVideo = media && !isImage && (item.type === 'video' || /\.(mp4|mov|m4v|webm)(\?|$)/i.test(media));
    return (
      <View style={[styles.postCard, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
        {isImage ? (
          <FastImage source={{ uri: media }} style={[styles.postMedia, { backgroundColor: isDark ? '#1a1a24' : '#f0f0f5' }]} resizeMode="cover" recyclingKey={media} />
        ) : isVideo ? (
          <PressableScale
            onPress={() => { Linking.openURL(media).catch(() => {}); }}
            style={[styles.postMedia, { backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }]}
            accessibilityRole="button"
          >
            <View style={styles.playBadge}><IconPlay size={22} color="#fff" /></View>
          </PressableScale>
        ) : null}
        {item.content ? (
          <Text style={{ color: colors.text, fontSize: 15, lineHeight: 22 }} selectable>{item.content}</Text>
        ) : null}
        <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 8 }}>
          {relativeTime(item.created_at, t)}
        </Text>

        {reactions.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, gap: 6 }}>
            {reactions.map((r) => (
              <PressableScale
                key={r.emoji}
                onPress={() => handleReact(item.id, r.emoji)}
                haptic={false}
                style={[styles.reactionChip, {
                  backgroundColor: mine === r.emoji ? (isDark ? 'rgba(255,255,255,0.14)' : 'rgba(17,17,17,0.08)') : (isDark ? '#1a1a24' : '#f0f0f5'),
                  borderColor: mine === r.emoji ? colors.text : 'transparent',
                }]}
              >
                <Text style={{ fontSize: 14 }}>{r.emoji}</Text>
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginLeft: 4 }}>{r.cnt}</Text>
              </PressableScale>
            ))}
          </View>
        ) : null}

        {/* Barra rápida de reação (emoji aqui é CONTEÚDO de reação, como no
            WhatsApp Canais — não chrome de UI). */}
        {isMember ? (
          <View style={{ flexDirection: 'row', marginTop: 8, gap: 12 }}>
            {QUICK_REACTIONS.map((emoji) => (
              <PressableScale key={emoji} onPress={() => handleReact(item.id, emoji)} haptic={false} scaleTo={0.85} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                <Text style={{ fontSize: 18, opacity: mine === emoji ? 1 : 0.5 }}>{emoji}</Text>
              </PressableScale>
            ))}
          </View>
        ) : null}
      </View>
    );
  }, [colors, isDark, t, myEmail, isMember, handleReact]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Header */}
      <View style={[styles.channelHeader, {
        backgroundColor: isDark ? '#0a0a0f' : '#fff',
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      }]}>
        <PressableScale onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.text} />
        </PressableScale>
        <View style={[styles.channelAvatar, { backgroundColor: isDark ? '#1a1a24' : '#f0f0f5', marginLeft: 12, width: 36, height: 36 }]}>
          {(channel.photo_url || channel.avatar || info?.avatar) ? (
            <AvatarCircle name={channel.name} uri={channel.photo_url || channel.avatar || info?.avatar} size={36} />
          ) : (
            <IconMegaphone size={18} color={colors.text} />
          )}
        </View>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>{info?.name || channel.name}</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
            {formatCount(followerCount)} {t('channel.followers') || 'followers'}
          </Text>
        </View>
        {!isMember ? (
          <PressableScale
            onPress={handleJoin}
            haptic={false}
            disabled={joining}
            style={[styles.followBtn, { backgroundColor: ACCENT }]}
            accessibilityRole="button"
          >
            {joining ? <ActivityIndicator size="small" color="#fff" /> : (
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>{t('channel.join') || 'Join'}</Text>
            )}
          </PressableScale>
        ) : null}
      </View>

      {/* Channel description */}
      {channel.description ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)' }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{channel.description}</Text>
        </View>
      ) : null}

      {/* Posts feed */}
      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator color={colors.text} size="large" /></View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderPost}
          initialNumToRender={6}
          windowSize={7}
          contentContainerStyle={posts.length === 0 ? { flexGrow: 1 } : undefined}
          keyboardDismissMode="on-drag"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
          ListEmptyComponent={
            <ScreenEmptyState
              kind="feed"
              compact
              title={t('channel.noPosts') || 'No posts yet'}
              subtitle={isAdmin ? (t('channel.firstPost') || 'Write your first post below') : (!isMember ? (t('channel.discoverDesc') || '') : undefined)}
              cta={!isMember ? { label: t('channel.join') || 'Join', onPress: handleJoin } : undefined}
            />
          }
        />
      )}

      {/* Admin post input */}
      {isAdmin && (
        <View style={[styles.postInput, {
          backgroundColor: isDark ? '#0a0a0f' : '#fff',
          borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        }]}>
          <PressableScale
            onPress={handleAttach}
            disabled={attaching || posting}
            style={[styles.attachBtn, { opacity: attaching || posting ? 0.4 : 1 }]}
            accessibilityLabel={t('channel.attach') || 'Anexar mídia'}
            accessibilityRole="button"
          >
            {attaching ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <IconPaperclip size={22} color={isDark ? '#8b8b96' : '#6b7280'} />
            )}
          </PressableScale>
          <TextInput
            value={newPost}
            onChangeText={setNewPost}
            placeholder={t('channel.writeSomething') || 'Write something...'}
            placeholderTextColor={isDark ? '#555' : '#9ca3af'}
            style={[styles.postTextInput, { color: colors.text, backgroundColor: isDark ? '#1a1a24' : '#f3f4f6' }]}
            multiline
            maxLength={5000}
          />
          <PressableScale
            onPress={handlePost}
            disabled={!newPost.trim() || posting}
            haptic={false}
            style={[styles.sendBtn, { opacity: newPost.trim() && !posting ? 1 : 0.4 }]}
            accessibilityRole="button"
          >
            {posting ? <ActivityIndicator size="small" color="#fff" /> : (
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>{t('channel.post') || 'Post'}</Text>
            )}
          </PressableScale>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

// ── Create Channel Modal ──
function CreateChannelModal({ visible, onClose, onCreated, colors, isDark, t }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const res = await api.channelCreate(name.trim(), description.trim(), category, true);
      if (api.apiOk(res)) {
        onCreated(api.apiPayload(res));
        setName('');
        setDescription('');
        setCategory('general');
        onClose();
      } else {
        Alert.alert(t('common.error') || 'Erro', api.apiMsg(res) || (t('channel.postFailed') || 'Não foi possível criar o canal'));
      }
    } catch {
      Alert.alert(t('common.error') || 'Erro', t('common.tryAgain') || 'Tentar novamente');
    } finally { setCreating(false); }
  }, [name, description, category, creating, onClose, onCreated, t]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* [2026-10-08 apps-native] KeyboardAvoidingView: o teclado cobria o sheet */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{
          backgroundColor: isDark ? '#0f0f14' : '#fff',
          borderTopLeftRadius: 24, borderTopRightRadius: 24,
          padding: 20, paddingBottom: 40,
        }}>
          {/* Grabber */}
          <View style={{ alignItems: 'center', marginBottom: 16 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>

          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '800', marginBottom: 20 }}>
            {t('channel.create') || 'Create Channel'}
          </Text>

          <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 6 }}>{t('channel.name') || 'Channel name'}</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t('channel.namePlaceholder') || 'e.g. Tech News'}
            placeholderTextColor={isDark ? '#555' : '#9ca3af'}
            style={[styles.modalInput, { color: colors.text, backgroundColor: isDark ? '#1a1a24' : '#f3f4f6' }]}
            maxLength={100}
          />

          <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 6, marginTop: 14 }}>{t('channel.description') || 'Description'}</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder={t('channel.descPlaceholder') || 'What is this channel about?'}
            placeholderTextColor={isDark ? '#555' : '#9ca3af'}
            style={[styles.modalInput, { color: colors.text, backgroundColor: isDark ? '#1a1a24' : '#f3f4f6', height: 80 }]}
            multiline
            maxLength={1000}
          />

          <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 8, marginTop: 14 }}>{t('channel.categoryLabel') || 'Category'}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }} contentContainerStyle={{ gap: 8 }}>
            {CATEGORIES.filter(c => c.key !== 'all').map((cat) => (
              <PressableScale
                key={cat.key}
                onPress={() => setCategory(cat.key)}
                haptic="select"
                style={[styles.categoryPill, {
                  backgroundColor: category === cat.key ? ACCENT : (isDark ? '#1a1a24' : '#f0f0f5'),
                }]}
              >
                <Text style={{
                  fontSize: 12, fontWeight: '600',
                  color: category === cat.key ? '#fff' : colors.text,
                }}>
                  {t(`channel.cat.${cat.key}`) || cat.key.charAt(0).toUpperCase() + cat.key.slice(1)}
                </Text>
              </PressableScale>
            ))}
          </ScrollView>

          <PressableScale
            onPress={handleCreate}
            disabled={!name.trim() || creating}
            haptic="medium"
            style={[styles.createBtn, { opacity: name.trim() && !creating ? 1 : 0.5 }]}
            accessibilityRole="button"
          >
            {creating ? <ActivityIndicator color="#fff" /> : (
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>{t('channel.createBtn') || 'Create'}</Text>
            )}
          </PressableScale>
        </TouchableOpacity>
      </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Main ChannelsTab ──
export default function ChannelsTab({ colors, isDark, t }) {
  const [tab, setTab] = useState('following'); // 'following' | 'discover'
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  if (selectedChannel) {
    return (
      <ChannelView
        channel={selectedChannel}
        colors={colors}
        isDark={isDark}
        t={t}
        onBack={() => setSelectedChannel(null)}
      />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Tab switcher */}
      {/* [2026-10-08 apps-native] tabs/+ com haptic e cor do tema (ACCENT
          fixo #111 sumia no dark mode). */}
      <View style={[styles.tabBar, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
        <PressableScale
          onPress={() => setTab('following')}
          haptic="select"
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === 'following' }}
          style={[styles.tab, tab === 'following' && [styles.tabActive, { borderBottomColor: colors.text }]]}
        >
          <Text style={[styles.tabText, { color: tab === 'following' ? colors.text : colors.textSecondary }]}>
            {t('channel.following') || 'Following'}
          </Text>
        </PressableScale>
        <PressableScale
          onPress={() => setTab('discover')}
          haptic="select"
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === 'discover' }}
          style={[styles.tab, tab === 'discover' && [styles.tabActive, { borderBottomColor: colors.text }]]}
        >
          <Text style={[styles.tabText, { color: tab === 'discover' ? colors.text : colors.textSecondary }]}>
            {t('channel.discover') || 'Discover'}
          </Text>
        </PressableScale>
        <View style={{ flex: 1 }} />
        <PressableScale
          onPress={() => setShowCreate(true)}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={t('channel.create') || 'New Channel'}
        >
          <IconPlus size={22} color={colors.text} />
        </PressableScale>
      </View>

      {/* Content */}
      {tab === 'following' ? (
        <FollowingList
          colors={colors}
          isDark={isDark}
          t={t}
          onOpenChannel={setSelectedChannel}
          onDiscover={() => setTab('discover')}
          onCreate={() => setShowCreate(true)}
        />
      ) : (
        <DiscoverList colors={colors} isDark={isDark} t={t} onOpenChannel={setSelectedChannel} />
      )}

      {/* Create channel modal */}
      <CreateChannelModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(ch) => { setSelectedChannel(ch); }}
        colors={colors}
        isDark={isDark}
        t={t}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    paddingVertical: 4,
  },
  tab: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginRight: 4,
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: ACCENT,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '700',
  },
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  channelAvatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 12,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    fontSize: 14,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  categoryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Cover card (Telegram Communities-grade)
  coverCard: {
    height: 180,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#1a1a24',
    position: 'relative',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.18,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
      },
      android: { elevation: 3 },
      default: {},
    }),
  },
  coverMembersBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 14,
  },
  coverMembersBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  coverContent: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 12,
    gap: 4,
  },
  coverTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.2,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  coverDesc: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 17,
  },
  coverFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
    gap: 8,
  },
  coverFooterMeta: {
    flex: 1,
    color: 'rgba(255,255,255,0.78)',
    fontSize: 11,
    fontWeight: '600',
  },
  coverJoinBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1.5,
  },
  coverJoinBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  followBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginLeft: 12,
  },
  channelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  postCard: {
    padding: 16,
    borderBottomWidth: 1,
  },
  postMedia: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 10,
  },
  playBadge: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  postInput: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    borderTopWidth: 1,
    gap: 8,
  },
  attachBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  postTextInput: {
    flex: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    maxHeight: 120,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  sendBtn: {
    backgroundColor: ACCENT,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalInput: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  createBtn: {
    backgroundColor: ACCENT,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
});
