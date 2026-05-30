import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, RefreshControl,
  ActivityIndicator, Platform, Dimensions, TextInput, Modal, ScrollView, Alert,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import { IconSearch, IconPlus, IconArrowLeft } from './Icons';
import Svg, { Path, Circle as SvgCircle, Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import * as api from '../services/api';

const ACCENT = '#7C3AED';
const ACCENT_DARK = '#5B21B6';
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
    ['#7C3AED', '#5B21B6'],
    ['#9333EA', '#6D28D9'],
    ['#A855F7', '#7E22CE'],
    ['#8B5CF6', '#4C1D95'],
    ['#C084FC', '#7C3AED'],
    ['#A78BFA', '#5B21B6'],
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

// ── Quick emoji reaction bar ──
const QUICK_REACTIONS = ['\uD83D\uDC4D', '\u2764\uFE0F', '\uD83D\uDD25', '\uD83D\uDE02', '\uD83D\uDE2E', '\uD83D\uDE22'];

// ── Following Tab: channels user follows ──
function FollowingList({ colors, isDark, t, onOpenChannel }) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.channelMyChannels();
      if (api.apiOk(res)) setChannels(api.apiList(res, 'channels', 'conversations'));
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  if (loading) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator color={ACCENT} size="large" /></View>;

  if (channels.length === 0) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 }}>
        <IconMegaphone size={48} color={isDark ? '#444' : '#ccc'} />
        <Text style={{ color: colors.textSecondary, fontSize: 15, marginTop: 16, textAlign: 'center' }}>
          {t('channel.noFollowing') || 'You are not following any channels yet'}
        </Text>
        <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 8, textAlign: 'center' }}>
          {t('channel.discoverDesc') || 'Discover channels to follow'}
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={channels}
      keyExtractor={(item) => String(item.id)}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
      renderItem={({ item }) => (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => onOpenChannel(item)}
          style={[styles.channelRow, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}
        >
          <View style={[styles.channelAvatar, { backgroundColor: isDark ? '#1a1a24' : '#f0f0f5' }]}>
            {item.photo_url ? (
              <AvatarCircle name={item.name} email={item.created_by} size={50} />
            ) : (
              <IconMegaphone size={24} color={ACCENT} />
            )}
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>{item.name}</Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 2 }} numberOfLines={1}>
              {item.latest_post || item.description || ''}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
              {relativeTime(item.latest_post_at || item.created_at, t)}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 4 }}>
              {item.follower_count || 0} {t('channel.followers') || 'followers'}
            </Text>
          </View>
        </TouchableOpacity>
      )}
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

  const load = useCallback(async (cat, q) => {
    try {
      const res = await api.channelDiscover(cat === 'all' ? '' : cat, q);
      if (api.apiOk(res)) setChannels(api.apiList(res, 'channels', 'conversations', 'items'));
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => {
    load(category, search);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [category, load]);

  const onSearchChange = useCallback((text) => {
    setSearch(text);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => load(category, text), 400);
  }, [category, load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(category, search); }, [category, search, load]);

  const handleFollow = useCallback(async (ch) => {
    try {
      if (ch.is_member) {
        await api.channelUnfollow(ch.id);
      } else {
        await api.channelFollow(ch.id);
      }
      // Refresh list
      load(category, search);
    } catch {}
  }, [category, search, load]);

  // Apply top-level filter (client-side; backend doesn't yet split by these keys)
  const displayed = React.useMemo(() => {
    if (!Array.isArray(channels)) return [];
    if (filter === 'subscribed') return channels.filter(c => c.is_member);
    if (filter === 'suggested') return channels.filter(c => !c.is_member);
    if (filter === 'recent') {
      return [...channels].sort((a, b) => {
        const ta = new Date(a.latest_post_at || a.created_at || 0).getTime();
        const tb = new Date(b.latest_post_at || b.created_at || 0).getTime();
        return tb - ta;
      });
    }
    return channels; // 'discover' shows all
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
            <TouchableOpacity
              key={f.key}
              onPress={() => setFilter(f.key)}
              activeOpacity={0.85}
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
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Category pills (secondary) */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: 10 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}>
        {CATEGORIES.map((cat) => (
          <TouchableOpacity
            key={cat.key}
            onPress={() => setCategory(cat.key)}
            style={[styles.categoryPill, {
              backgroundColor: category === cat.key ? ACCENT : (isDark ? '#1a1a24' : '#f0f0f5'),
            }]}
          >
            <Text style={{ fontSize: 14 }}>{cat.emoji}</Text>
            <Text style={{
              fontSize: 12, fontWeight: '600', marginLeft: 4,
              color: category === cat.key ? '#fff' : colors.text,
            }}>
              {t(`channel.cat.${cat.key}`) || cat.key.charAt(0).toUpperCase() + cat.key.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator color={ACCENT} size="large" /></View>
      ) : displayed.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 14 }}>{t('channel.noChannels') || 'Nenhum canal encontrado'}</Text>
        </View>
      ) : (
        <FlatList
          data={displayed}
          keyExtractor={(item) => String(item.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 20, gap: 12 }}
          renderItem={({ item }) => {
            const subCountNum = parseInt(item.subscriber_count) || 0;
            const subText = formatCount(subCountNum) + (subCountNum === 1 ? ' membro' : ' membros');
            const catLabel = item.category && item.category !== 'general'
              ? (t(`channel.cat.${item.category}`) || item.category)
              : null;
            return (
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => onOpenChannel(item)}
                style={styles.coverCard}
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
                    <TouchableOpacity
                      onPress={() => handleFollow(item)}
                      activeOpacity={0.85}
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
                    </TouchableOpacity>
                  </View>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

// ── Channel View: scrollable feed of posts ──
function ChannelView({ channel, colors, isDark, t, onBack }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [newPost, setNewPost] = useState('');
  const [posting, setPosting] = useState(false);

  const loadPosts = useCallback(async () => {
    try {
      const [feedRes, infoRes] = await Promise.all([
        api.channelFeed(channel.id),
        api.channelInfo(channel.id),
      ]);
      if (api.apiOk(feedRes)) setPosts(api.apiList(feedRes, 'posts', 'items'));
      if (api.apiOk(infoRes)) setInfo(api.apiPayload(infoRes) || null);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [channel.id]);

  useEffect(() => { loadPosts(); }, [loadPosts]);

  const onRefresh = useCallback(() => { setRefreshing(true); loadPosts(); }, [loadPosts]);

  const handlePost = useCallback(async () => {
    if (!newPost.trim() || posting) return;
    setPosting(true);
    try {
      const res = await api.channelPost(channel.id, newPost.trim());
      if (api.apiOk(res)) {
        setNewPost('');
        loadPosts();
      }
    } catch {} finally { setPosting(false); }
  }, [newPost, posting, channel.id, loadPosts]);

  const handleReact = useCallback(async (postId, emoji) => {
    try {
      await api.channelReact(postId, emoji);
      // Optimistic: reload
      loadPosts();
    } catch {}
  }, [loadPosts]);

  const isAdmin = info?.is_admin || false;

  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View style={[styles.channelHeader, {
        backgroundColor: isDark ? '#0a0a0f' : '#fff',
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <IconArrowLeft size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={[styles.channelAvatar, { backgroundColor: isDark ? '#1a1a24' : '#f0f0f5', marginLeft: 12, width: 36, height: 36 }]}>
          <IconMegaphone size={18} color={ACCENT} />
        </View>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>{channel.name}</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
            {info?.subscriber_count || channel.follower_count || 0} {t('channel.followers') || 'followers'}
          </Text>
        </View>
        {info && !info.is_member ? (
          <TouchableOpacity
            onPress={async () => {
              await api.channelFollow(channel.id);
              loadPosts();
            }}
            style={[styles.followBtn, { backgroundColor: ACCENT }]}
          >
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>{t('channel.join') || 'Join'}</Text>
          </TouchableOpacity>
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
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator color={ACCENT} size="large" /></View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(item) => String(item.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
          ListEmptyComponent={() => (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <Text style={{ color: colors.textSecondary, fontSize: 14 }}>{t('channel.noPosts') || 'No posts yet'}</Text>
            </View>
          )}
          renderItem={({ item }) => (
            <View style={[styles.postCard, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
              {/* Post content */}
              <Text style={{ color: colors.text, fontSize: 15, lineHeight: 22 }}>{item.content}</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 8 }}>
                {relativeTime(item.created_at, t)}
              </Text>

              {/* Reactions */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, gap: 6 }}>
                {(item.reactions || []).map((r) => (
                  <TouchableOpacity
                    key={r.emoji}
                    onPress={() => handleReact(item.id, r.emoji)}
                    style={[styles.reactionChip, {
                      backgroundColor: item.my_reaction === r.emoji ? (isDark ? 'rgba(124,58,237,0.2)' : 'rgba(124,58,237,0.1)') : (isDark ? '#1a1a24' : '#f0f0f5'),
                      borderColor: item.my_reaction === r.emoji ? ACCENT : 'transparent',
                    }]}
                  >
                    <Text style={{ fontSize: 14 }}>{r.emoji}</Text>
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginLeft: 4 }}>{r.cnt}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Quick react bar */}
              <View style={{ flexDirection: 'row', marginTop: 8, gap: 12 }}>
                {QUICK_REACTIONS.map((emoji) => (
                  <TouchableOpacity key={emoji} onPress={() => handleReact(item.id, emoji)} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                    <Text style={{ fontSize: 18, opacity: item.my_reaction === emoji ? 1 : 0.5 }}>{emoji}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
        />
      )}

      {/* Admin post input */}
      {isAdmin && (
        <View style={[styles.postInput, {
          backgroundColor: isDark ? '#0a0a0f' : '#fff',
          borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        }]}>
          <TextInput
            value={newPost}
            onChangeText={setNewPost}
            placeholder={t('channel.writeSomething') || 'Write something...'}
            placeholderTextColor={isDark ? '#555' : '#9ca3af'}
            style={[styles.postTextInput, { color: colors.text, backgroundColor: isDark ? '#1a1a24' : '#f3f4f6' }]}
            multiline
            maxLength={5000}
          />
          <TouchableOpacity
            onPress={handlePost}
            disabled={!newPost.trim() || posting}
            style={[styles.sendBtn, { opacity: newPost.trim() && !posting ? 1 : 0.4 }]}
          >
            {posting ? <ActivityIndicator size="small" color="#fff" /> : (
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>{t('channel.post') || 'Post'}</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
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
        Alert.alert('Erro', api.apiMsg(res) || 'Não foi possível criar o canal');
      }
    } catch {} finally { setCreating(false); }
  }, [name, description, category, creating, onClose, onCreated]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
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
              <TouchableOpacity
                key={cat.key}
                onPress={() => setCategory(cat.key)}
                style={[styles.categoryPill, {
                  backgroundColor: category === cat.key ? ACCENT : (isDark ? '#1a1a24' : '#f0f0f5'),
                }]}
              >
                <Text style={{ fontSize: 14 }}>{cat.emoji}</Text>
                <Text style={{
                  fontSize: 12, fontWeight: '600', marginLeft: 4,
                  color: category === cat.key ? '#fff' : colors.text,
                }}>
                  {t(`channel.cat.${cat.key}`) || cat.key.charAt(0).toUpperCase() + cat.key.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <TouchableOpacity
            onPress={handleCreate}
            disabled={!name.trim() || creating}
            style={[styles.createBtn, { opacity: name.trim() && !creating ? 1 : 0.5 }]}
          >
            {creating ? <ActivityIndicator color="#fff" /> : (
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>{t('channel.createBtn') || 'Create'}</Text>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
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
      <View style={[styles.tabBar, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
        <TouchableOpacity
          onPress={() => setTab('following')}
          style={[styles.tab, tab === 'following' && styles.tabActive]}
        >
          <Text style={[styles.tabText, { color: tab === 'following' ? ACCENT : colors.textSecondary }]}>
            {t('channel.following') || 'Following'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setTab('discover')}
          style={[styles.tab, tab === 'discover' && styles.tabActive]}
        >
          <Text style={[styles.tabText, { color: tab === 'discover' ? ACCENT : colors.textSecondary }]}>
            {t('channel.discover') || 'Discover'}
          </Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={() => setShowCreate(true)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <IconPlus size={20} color={ACCENT} />
        </TouchableOpacity>
      </View>

      {/* Content */}
      {tab === 'following' ? (
        <FollowingList colors={colors} isDark={isDark} t={t} onOpenChannel={setSelectedChannel} />
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
