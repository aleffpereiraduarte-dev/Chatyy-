import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, RefreshControl,
  ActivityIndicator, Platform, Dimensions, ScrollView, Animated, TextInput,
  Image, Modal,
} from 'react-native';
// FlatList only (FlashList crashes iOS)
const ListComponent = FlatList;
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AvatarCircle, { bumpAvatarCache } from './AvatarCircle';
import FeedPost from './FeedPost';
import FeedComments from './FeedComments';
import CreatePostModal from './CreatePostModal';
import LiveIndicator from './LiveIndicator';
import ReelsViewer from './ReelsViewer';
import UnifiedComposeFab from './UnifiedComposeFab';
import Profile from './Profile';
import { IconPlus, IconVideo, IconSearch, IconX, IconBell } from './Icons';
import Svg, { Circle, Rect, Path, Line, Polyline } from 'react-native-svg';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import useStatuses from '../hooks/useStatuses';
import StoryRingAvatar from './status/StoryRingAvatar';
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}

const ACCENT = '#7C3AED';
const SCREEN_WIDTH = Dimensions.get('window').width;
const useNative = Platform.OS !== 'web';

// ── MMKV synchronous preload (native only) for instant first paint ──
let _preloadedFeedPosts = null;
if (Platform.OS !== 'web') {
  try {
    const { getString: _gs } = require('../services/mmkv');
    const raw = _gs('chat_feed');
    if (raw) _preloadedFeedPosts = JSON.parse(raw);
  } catch {}
}
const _saveFeedToMMKV = (posts) => {
  if (Platform.OS === 'web') return;
  try {
    const { setString: _ss } = require('../services/mmkv');
    _ss('chat_feed', JSON.stringify(Array.isArray(posts) ? posts.slice(0, 100) : []));
  } catch {}
};

// Fingerprint of the feed list — id + likes_count + comments_count + updated_at.
// setState only when this changes, so unchanged polls don't cause re-renders.
const _feedFingerprint = (arr) => {
  if (!Array.isArray(arr)) return '';
  return arr.map(p =>
    `${p.id}:${p.likes_count ?? p.like_count ?? 0}:${p.comments_count ?? p.comment_count ?? 0}:${p.updated_at || p.created_at || ''}`
  ).join('|');
};

// Memoized row wrapper so prop-function-identity changes don't re-render every post.
const FeedPostRow = React.memo(function FeedPostRow(props) {
  return <FeedPost {...props} />;
}, (prev, next) => {
  if (prev.isDark !== next.isDark) return false;
  if (prev.colors !== next.colors) return false;
  if (prev.user?.email !== next.user?.email) return false;
  const a = prev.post, b = next.post;
  if (!a || !b) return a === b;
  if (a.id !== b.id) return false;
  if ((a.likes_count ?? a.like_count ?? 0) !== (b.likes_count ?? b.like_count ?? 0)) return false;
  if ((a.comments_count ?? a.comment_count ?? 0) !== (b.comments_count ?? b.comment_count ?? 0)) return false;
  if ((a.updated_at || '') !== (b.updated_at || '')) return false;
  if ((a.liked_by_me || false) !== (b.liked_by_me || false)) return false;
  if ((a.bookmarked_by_me || false) !== (b.bookmarked_by_me || false)) return false;
  if ((a.caption || '') !== (b.caption || '')) return false;
  // Ignore function reference changes (onOpenComments, onDeletePost, etc.)
  return true;
});

// ── Live broadcast FAB with pulsing ring ──
// Replaces the static red round button. The button itself doesn't move
// — a translucent red halo expands behind it on a 1.6 s loop so the
// user reads "this is live" without the icon visibly bouncing every
// frame. Subtle but signals tech-grade attention.
function LiveFab({ onPress, t, isWeb, styles }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1600, useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, []);
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.45, 0.18, 0] });
  return (
    <View pointerEvents="box-none" style={[styles.fabLive, { backgroundColor: 'transparent' }]}>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute', inset: 0, left: 0, top: 0, right: 0, bottom: 0,
          borderRadius: 23,
          backgroundColor: '#dc2626',
          opacity: ringOpacity,
          transform: [{ scale: ringScale }],
        }}
      />
      <TouchableOpacity
        style={{
          width: 46, height: 46, borderRadius: 23,
          backgroundColor: '#dc2626',
          alignItems: 'center', justifyContent: 'center',
          ...(isWeb ? { boxShadow: '0 4px 14px rgba(220,38,38,0.4), 0 2px 6px rgba(0,0,0,0.1)' } : {}),
        }}
        onPress={onPress}
        activeOpacity={0.8}
        accessibilityLabel={t('live.goLive')}
        accessibilityRole="button"
      >
        <IconVideo size={20} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

// ── Reels P0: Trending hashtags rail ──
// Lists the top hashtags parsed out of feed captions over the last 24h.
// Tapping a chip routes to the /hashtag/<tag> page which already exists.
function TrendingHashtagsRail({ colors, isDark, t, router }) {
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.chatFeedTrendingHashtags(20);
        if (!alive) return;
        if (r?.success && Array.isArray(r.data?.tags)) setTags(r.data.tags);
      } catch {}
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, []);
  if (loading) {
    return (
      <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
        <ActivityIndicator size="small" color={isDark ? '#888' : '#999'} />
      </View>
    );
  }
  if (tags.length === 0) return null;
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 18 }}>
      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700', marginBottom: 10 }}>
        {t?.('feed.trending') || 'Em alta'}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {tags.map((row) => (
          <TouchableOpacity
            key={row.hashtag}
            onPress={() => { try { router?.push(`/hashtag/${encodeURIComponent(row.hashtag)}`); } catch {} }}
            activeOpacity={0.7}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 14,
              backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.08)',
              borderWidth: 1,
              borderColor: 'rgba(124,58,237,0.32)',
            }}
          >
            <Text style={{ color: '#7C3AED', fontSize: 13, fontWeight: '600' }}>
              #{row.hashtag} <Text style={{ color: colors.textSecondary, fontWeight: '500' }}>· {row.uses}</Text>
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ── Skeleton loader for feed posts ──
function FeedSkeleton({ isDark }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);
  const bg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  return (
    <Animated.View style={{ opacity, padding: 16, gap: 12 }}>
      {[0, 1, 2].map(i => (
        <View key={i} style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff', borderRadius: 16, padding: 16, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: bg }} />
            <View style={{ gap: 6, flex: 1 }}>
              <View style={{ width: '50%', height: 12, borderRadius: 6, backgroundColor: bg }} />
              <View style={{ width: '30%', height: 10, borderRadius: 5, backgroundColor: bg }} />
            </View>
          </View>
          <View style={{ width: '100%', height: 200, borderRadius: 12, backgroundColor: bg }} />
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <View style={{ width: 60, height: 10, borderRadius: 5, backgroundColor: bg }} />
            <View style={{ width: 60, height: 10, borderRadius: 5, backgroundColor: bg }} />
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

function EmptyFeedIllustration({ isDark }) {
  return (
    <Svg width={100} height={100} viewBox="0 0 100 100" fill="none">
      <Rect x="20" y="15" width="60" height="70" rx="8" stroke={isDark ? '#374151' : '#e5e7eb'} strokeWidth="2" fill="none" />
      <Rect x="28" y="25" width="44" height="30" rx="4" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="1.5" fill="none" />
      <Circle cx="50" cy="37" r="6" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="1.5" fill="none" />
      <Path d="M28 50 L38 42 L45 48 L55 38 L72 50" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="1.5" fill="none" strokeLinejoin="round" />
      <Rect x="28" y="60" width="30" height="3" rx="1.5" fill={isDark ? '#374151' : '#e5e7eb'} />
      <Rect x="28" y="67" width="20" height="3" rx="1.5" fill={isDark ? '#374151' : '#e5e7eb'} />
      <Circle cx="70" cy="65" r="4" stroke={ACCENT} strokeWidth="1.5" fill="none" />
      <Path d="M68 65 L72 65" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" />
      <Path d="M70 63 L70 67" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" />
    </Svg>
  );
}


// ── Stories strip (Instagram-style ribbon at the top of the feed) ──
// Surfaces the same `useStatuses` data the chat tab uses, so a status
// posted from any surface appears here without a refetch. Tapping a ring
// jumps into the chat tab's status viewer (it owns the StoryViewer
// modal — duplicating that 300-line surface here would drift). The "Seu
// status" tile is always first; new content has the gradient ring.
function StoriesStrip({ user, colors, isDark, t, router }) {
  const { groups } = useStatuses(user?.email, { warmCacheVideos: false });
  const myEntry = (groups || []).find(g => String(g.email || '').toLowerCase() === String(user?.email || '').toLowerCase());
  const others = (groups || []).filter(g => String(g.email || '').toLowerCase() !== String(user?.email || '').toLowerCase());
  const myDisplay = user?.name || user?.email?.split('@')[0] || '';

  // Hide entirely when there's literally nothing to surface — no own status
  // and zero others. A lone "Seu status" with no rings reads as an empty
  // glitch on a fresh account, and the FAB already covers post creation.
  if (!myEntry && others.length === 0) return null;

  const open = () => {
    try { router?.push('/chat?tab=status'); } catch {}
  };

  return (
    <View style={{
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      backgroundColor: isDark ? colors.background : '#f6f8fa',
    }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, gap: 16 }}>
        {/* Your status — always first */}
        <TouchableOpacity onPress={open} activeOpacity={0.75} style={{ alignItems: 'center', width: 72 }}>
          <StoryRingAvatar
            name={myDisplay}
            email={user?.email}
            size={58}
            ringStyle={myEntry ? 'solid' : 'none'}
            badge="plus"
            isDark={isDark}
            colors={colors}
          />
          <Text style={{ fontSize: 11.5, color: colors.text, marginTop: 6, fontWeight: '600', letterSpacing: -0.1 }} numberOfLines={1}>
            {myEntry ? myDisplay : (t?.('status.yourStory') || 'Seu status')}
          </Text>
        </TouchableOpacity>
        {/* Others */}
        {others.map((g) => {
          const allViewed = (g.items || []).every(it => it.viewed);
          return (
            <TouchableOpacity key={`fs-${g.email}`} onPress={open} activeOpacity={0.75} style={{ alignItems: 'center', width: 72 }}>
              <StoryRingAvatar
                name={g.name || g.email}
                email={g.email}
                size={58}
                ringStyle="solid"
                allViewed={allViewed}
                isDark={isDark}
                colors={colors}
              />
              <Text style={{ fontSize: 11.5, color: colors.text, marginTop: 6, fontWeight: '600', letterSpacing: -0.1 }} numberOfLines={1}>
                {g.name || g.email?.split('@')[0]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

export default function ChatFeedTab({ colors, isDark, t, user, router, initialFeedMode, onFeedModeConsumed }) {
  // Safe-area top — the back-to-posts pill (reels mode) used a hardcoded
  // `top: 18` on Android, which was tucking under the system clock on
  // edge-to-edge windows. Use runtime insets with a small floor.
  const insets = useSafeAreaInsets();
  const safeTopPill = Math.max(insets.top, Platform.OS === 'android' ? 12 : 44) + 8;
  const [feedMode, setFeedMode] = useState(initialFeedMode === 'reels' ? 'reels' : 'posts'); // 'posts' | 'reels' | 'profile'
  // Note: the "Para você / Seguindo" sub-tab is already handled via the
  // existing `algorithm` state below — `algorithm='following'` routes to
  // the chronological follows-only feed (Reels P0). No duplicate state.
  // Algorithm selector for Posts mode — 'fyp' (Para você, default) or
  // 'following' (chronological feed from accounts you follow). Persists per
  // session via MMKV so navigating away + back keeps the chosen tab.
  const _initialAlgo = (() => {
    if (Platform.OS === 'web') {
      try { return localStorage.getItem('feed_algorithm') === 'following' ? 'following' : 'fyp'; } catch { return 'fyp'; }
    }
    try {
      const { getString: _gs } = require('../services/mmkv');
      return _gs('feed_algorithm') === 'following' ? 'following' : 'fyp';
    } catch { return 'fyp'; }
  })();
  const [algorithm, setAlgorithm] = useState(_initialAlgo);
  const persistAlgorithm = useCallback((a) => {
    try {
      if (Platform.OS === 'web') { try { localStorage.setItem('feed_algorithm', a); } catch {} }
      else {
        const { setString: _ss } = require('../services/mmkv');
        _ss('feed_algorithm', a);
      }
    } catch {}
  }, []);
  // Recommended creators rail — fetched once per mount.
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.followSuggestions(10);
        if (alive && r?.success && Array.isArray(r.data?.users)) {
          setSuggestions(r.data.users.slice(0, 10));
        }
      } catch {}
      if (alive) setSuggestionsLoaded(true);
    })();
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (initialFeedMode === 'reels' && feedMode !== 'reels') setFeedMode('reels');
    if (initialFeedMode && typeof onFeedModeConsumed === 'function') onFeedModeConsumed();
  }, [initialFeedMode]); // eslint-disable-line react-hooks/exhaustive-deps
  // Initial state reads from MMKV preload so the very first render already has data.
  const _initialPosts = Array.isArray(_preloadedFeedPosts) ? _preloadedFeedPosts : [];
  const [posts, setPosts] = useState(() => _initialPosts);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  // Skip the skeleton if we already painted from cache.
  const [loading, setLoading] = useState(_initialPosts.length === 0);
  const lastFeedFpRef = useRef(_feedFingerprint(_initialPosts));
  // Parallel Set<postId> for O(1) dedup on feed_new_post WS events.
  const feedIdSetRef = useRef(new Set(_initialPosts.map(p => p.id)));
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // [silent-fail-w3] Surface a feed load failure when nothing is on screen.
  // Before: catch() only logged to console and left the user staring at the
  // empty-state copy ("Seu feed está vazio"), which is misleading — the real
  // issue was a 5xx / network drop.
  const [feedError, setFeedError] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [commentsPost, setCommentsPost] = useState(null);
  const [activeLives, setActiveLives] = useState([]);
  // [#1161, 2026-05-18] Per-host end-stamp so an in-flight loadLives poll
  // landing AFTER a `live_ended` WS event can't resurrect the host card.
  // Mirrors the pattern in ChatListTab + Profile.js. 30s window.
  const liveEndedAtByHostRef = useRef({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [unreadNotifs, setUnreadNotifs] = useState(0);

  // Poll unread notification count every 45s (and once on mount)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.notificationsUnreadCount();
        if (alive && r?.success) setUnreadNotifs(Math.min(99, r.data?.count || 0));
      } catch {}
    };
    tick();
    const id = setInterval(tick, 45000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const pollRef = useRef(null);
  const livePollRef = useRef(null);
  const searchTimerRef = useRef(null);
  const searchRequestIdRef = useRef(0);
  const feedListRef = useRef(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const handleFeedScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y;
    const shouldShow = y > 800; // ~2 posts scrolled
    setShowScrollTop(prev => (prev !== shouldShow ? shouldShow : prev));
  }, []);
  const scrollFeedToTop = useCallback(() => {
    try { feedListRef.current?.scrollToOffset?.({ offset: 0, animated: true }); } catch {}
  }, []);

  const loadPosts = useCallback(async (pageNum = 1, isRefresh = false) => {
    // FAST PATH: if we already have posts on screen and this is a page-1 load,
    // skip the IndexedDB/async cache read entirely and go straight to silent
    // API delta sync — no flicker, no empty state.
    let alreadyHasVisible = false;
    if (pageNum === 1 && !isRefresh) {
      setPosts(prev => { alreadyHasVisible = (prev?.length || 0) > 0; return prev; });
    }

    // Only do the async cached read on a truly cold start.
    if (pageNum === 1 && !isRefresh && !alreadyHasVisible) {
      try {
        const cached = await getCached('feed_posts');
        if (cached && cached.length > 0) {
          const fp = _feedFingerprint(cached);
          if (fp !== lastFeedFpRef.current) {
            lastFeedFpRef.current = fp;
            setPosts(cached);
          }
          setLoading(false);
        }
      } catch {}
    }

    try {
      // Pass the active algorithm so the backend can switch between the
      // FYP ranker (algorithm=fyp) and the chronological following-only feed
      // (algorithm=following). Backend defaults to chronological when omitted.
      // Reels P0: also pass type=following so the backend short-circuits to
      // strict follows-only (no shared-conversation match). This is the actual
      // server-side semantic the user expects when they tap "Seguindo".
      const feedArgs = { page: pageNum, limit: 20, algorithm };
      if (algorithm === 'following') feedArgs.type = 'following';
      const r = await api.feedList(feedArgs);
      if (r && r.success && r.data) {
        const rawPosts = r.data.posts || r.data;
        const newPosts = Array.isArray(rawPosts) ? rawPosts : [];
        if (pageNum === 1 || isRefresh) {
          // Fingerprint compare — skip setState if nothing actually changed.
          const fp = _feedFingerprint(newPosts);
          if (fp !== lastFeedFpRef.current) {
            lastFeedFpRef.current = fp;
            setPosts(newPosts);
          }
          if (pageNum === 1) {
            setCache('feed_posts', newPosts, 7776000000).catch(() => {});
            _saveFeedToMMKV(newPosts);
          }
        } else {
          setPosts(prev => {
            const existingIds = new Set(prev.map(p => p.id));
            const unique = newPosts.filter(p => !existingIds.has(p.id));
            if (unique.length === 0) return prev; // nothing new, keep reference
            const merged = [...prev, ...unique];
            lastFeedFpRef.current = _feedFingerprint(merged);
            return merged;
          });
        }
        setHasMore(newPosts.length >= 20);
        setFeedError(false);
      } else if (pageNum === 1) {
        // [silent-fail-w3] Non-success on page 1 → flag error so the empty
        // state can show a retry pill instead of pretending the feed is empty.
        console.warn('[silent-fail-w3] feedList non-success', r?.message);
        setPosts(prev => {
          if ((prev?.length || 0) === 0) setFeedError(true);
          return prev;
        });
      }
    } catch (e) {
      console.warn('[silent-fail-w3] feedList threw', e?.message || e);
      if (pageNum === 1) {
        setPosts(prev => {
          if ((prev?.length || 0) === 0) setFeedError(true);
          return prev;
        });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [algorithm]);

  // Reload page 1 whenever the user flips the For You / Following tab.
  // We reset the page state, the fingerprint, and the dedup Set so the new
  // feed paints from scratch instead of merging with the previous list.
  useEffect(() => {
    setPage(1);
    setHasMore(true);
    lastFeedFpRef.current = '';
    feedIdSetRef.current = new Set();
    setLoading(true);
    loadPosts(1, true);
    persistAlgorithm(algorithm);
  }, [algorithm]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load active lives
  // [bug-shape] Backend `live_list` returns `data.lives` (NOT `sessions`); the
  // previous `r.data?.sessions` check was always falsy, so polling never
  // populated nor cleared the strip — the hero stayed parked on screen until
  // the user pulled to refresh. Fall back to legacy `sessions` for forward-compat.
  //
  // [bug-fix #lives-banner] Two extra client-side filters because the backend
  // can briefly return stale rows (5-min ghost auto-end window) and lives
  // hosted by ME shouldn't be advertised in MY feed:
  //   1. Drop lives where host_email matches the logged-in user (we don't
  //      tell people about their own broadcast — they're the one driving it).
  //   2. Drop rows where ended_at is set OR started_at is older than 90 min
  //      AND viewer_count is 0 (ghost session that backend hasn't auto-ended
  //      yet). The backend's 5-min ghost sweep handles most of these but the
  //      window is wide enough to miss some on the very next poll.
  const loadLives = useCallback(async () => {
    // [#1161] Capture poll-start time so we can rebase the response
    // against any WS `live_ended` events that arrived while in flight.
    const pollStartedAt = Date.now();
    try {
      const r = await api.liveList();
      if (r && r.success) {
        const raw = r.data?.lives || r.data?.sessions || [];
        const myEmail = String(user?.email || '').toLowerCase();
        const NINETY_MIN_MS = 90 * 60 * 1000;
        const now = Date.now();
        const list = (Array.isArray(raw) ? raw : []).filter((l) => {
          // 1) Hide own lives — host_email comparison is case-insensitive
          // because backend can echo the canonical mailbox in either case.
          const host = String(l?.host_email || '').toLowerCase();
          if (host && myEmail && host === myEmail) return false;
          // 2) Hide ended sessions explicitly flagged by the server.
          if (l?.ended_at || l?.status === 'ended') return false;
          // 3) Hide stale sessions (started >90min ago with 0 viewers).
          try {
            const startedAt = new Date(l?.started_at).getTime();
            if (Number.isFinite(startedAt) && (now - startedAt) > NINETY_MIN_MS) {
              const vc = Number(l?.viewer_count) || 0;
              if (vc <= 0) return false;
            }
          } catch {}
          // 4) [#1161] Per-host stale-tick guard — drop any host whose
          // `live_ended` WS event landed AFTER this poll left (within 30s
          // grace). Without this the LiveBar/feed hero re-paints AO VIVO
          // for friends right after the host ended their broadcast.
          if (host) {
            const endedAt = liveEndedAtByHostRef.current[host] || 0;
            if (endedAt >= pollStartedAt && Date.now() - endedAt < 30000) return false;
          }
          return true;
        });
        setActiveLives(list);
      }
    } catch (e) {
      console.warn('Live list error:', e);
    }
  }, [user?.email]);

  // ── User search with debounce ──
  const handleSearchChange = useCallback((text) => {
    setSearchQuery(text);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (text.trim().length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const reqId = ++searchRequestIdRef.current;
    searchTimerRef.current = setTimeout(async () => {
      try {
        const r = await api.searchUsers(text.trim());
        if (reqId !== searchRequestIdRef.current) return; // stale response
        if (r && r.success && r.data?.users) {
          setSearchResults(r.data.users);
        } else {
          setSearchResults([]);
        }
      } catch (e) {
        if (reqId !== searchRequestIdRef.current) return;
        console.warn('User search error:', e);
        setSearchResults([]);
      } finally {
        if (reqId === searchRequestIdRef.current) setSearchLoading(false);
      }
    }, 400);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults([]);
    setIsSearchActive(false);
    setSearchLoading(false);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  }, []);

  useEffect(() => {
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, []);

  // Initial load + WS real-time events with reduced polling fallback
  useEffect(() => {
    loadPosts(1);
    loadLives();

    // WebSocket: instant feed updates when someone posts
    let unsubFeed = null, unsubLiveStart = null, unsubLiveEnd = null;
    if (mailWs?.on) {
      unsubFeed = mailWs.on('feed_new_post', (data) => {
        if (data?.post) {
          setPosts(prev => {
            // O(1) dedup via ref-backed Set — prev.some() on 1k+ posts was
            // linear per broadcast; a Set scan stays flat as the feed grows.
            if (!feedIdSetRef.current) feedIdSetRef.current = new Set(prev.map(p => p.id));
            if (feedIdSetRef.current.has(data.post.id)) return prev;
            feedIdSetRef.current.add(data.post.id);
            const next = [data.post, ...prev];
            lastFeedFpRef.current = _feedFingerprint(next);
            _saveFeedToMMKV(next);
            return next;
          });
        }
        // No `else` reload: a malformed broadcast (no post payload) used to
        // trigger a full feed refresh, kicking the user back to the top
        // mid-scroll. Just drop the event — next valid broadcast or the 60s
        // poll will catch up.
      });

      // Subscribe defensively in case this tab is the only one mounted
      // (Feed-only deep link, web direct nav). ChatListTab subscribes too —
      // the WS hub dedupes per-channel so double-subscribe is a no-op.
      try { mailWs.subscribe?.('lives_global'); } catch {}

      // [realtime-live-remove] On live_ended, mutate activeLives DIRECTLY
      // instead of round-tripping through loadLives() — the API poll can race
      // with the WS event (host ends, WS arrives, then a fresh poll returns
      // the still-cached row, putting the hero back). Removing inline
      // guarantees the hero disappears the instant the broadcast ends. On
      // live_started we still re-fetch to pick up host_name/viewer_count
      // metadata not carried by the WS payload.
      unsubLiveStart = mailWs.on('live_started', () => loadLives());
      unsubLiveEnd = mailWs.on('live_ended', (payload) => {
        const data = payload?.data || payload || {};
        const sid = data.session_id || data.id;
        const host = String(data.host_email || '').toLowerCase();
        const stampedHosts = new Set();
        if (host) stampedHosts.add(host);
        setActiveLives(prev => {
          if (!Array.isArray(prev) || prev.length === 0) return prev;
          const next = prev.filter(l => {
            const lid = l?.id || l?.session_id;
            const lhost = String(l?.host_email || l?.email || '').toLowerCase();
            // Drop if EITHER session_id matches OR host_email matches (handles
            // payloads missing one or the other; auto-stale broadcast carries
            // both, regular live_end_cf carries both).
            if (sid && lid && String(lid) === String(sid)) {
              if (lhost) stampedHosts.add(lhost);
              return false;
            }
            if (host && lhost && lhost === host) return false;
            return true;
          });
          return next.length === prev.length ? prev : next;
        });
        // [#1161] Stamp the end-time per host so an in-flight loadLives
        // can't paint AO VIVO back on the same host card after this.
        const now = Date.now();
        try {
          stampedHosts.forEach((h) => {
            if (h) liveEndedAtByHostRef.current[h] = now;
          });
        } catch {}
      });
    }

    // Only poll when WebSocket is actually offline — redundant 60s polls on
    // top of live WS events just waste bandwidth + battery. The connection
    // listener below flips polling back on if WS ever drops.
    const startPolling = () => {
      if (pollRef.current || livePollRef.current) return;
      pollRef.current = setInterval(() => loadPosts(1, true), 60000);
      livePollRef.current = setInterval(loadLives, 60000);
    };
    const stopPolling = () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (livePollRef.current) { clearInterval(livePollRef.current); livePollRef.current = null; }
    };
    if (!mailWs.isConnected || !mailWs.authenticated) startPolling();
    const unsubConn = mailWs.on('connection', (data) => {
      if (data?.status === 'authenticated') stopPolling();
      else if (data?.status === 'disconnected') startPolling();
    });

    return () => {
      stopPolling();
      unsubFeed?.(); unsubLiveStart?.(); unsubLiveEnd?.();
      unsubConn?.();
    };
  }, [loadPosts, loadLives]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    setPage(1);
    // Reset hasMore so pagination re-arms — previously stuck at false after
    // reaching the end once, breaking scroll on subsequent sessions.
    setHasMore(true);
    loadPosts(1, true);
  }, [loadPosts]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    setPage(nextPage);
    loadPosts(nextPage);
  }, [loadingMore, hasMore, page, loadPosts]);

  const handlePostCreated = useCallback((newPost) => {
    if (newPost) {
      setPosts(prev => {
        const next = [newPost, ...prev];
        lastFeedFpRef.current = _feedFingerprint(next);
        _saveFeedToMMKV(next);
        return next;
      });
    } else {
      // Reload from server
      loadPosts(1, true);
    }
  }, [loadPosts]);

  const handleDeletePost = useCallback((postId) => {
    setPosts(prev => {
      const next = prev.filter(p => p.id !== postId);
      lastFeedFpRef.current = _feedFingerprint(next);
      _saveFeedToMMKV(next);
      return next;
    });
  }, []);

  const handleOpenComments = useCallback((post) => {
    setCommentsPost(post);
  }, []);

  const handleCommentCountChange = useCallback((newCount) => {
    if (!commentsPost) return;
    setPosts(prev => prev.map(p =>
      p.id === commentsPost.id ? { ...p, comment_count: newCount } : p
    ));
    setCommentsPost(prev => prev ? { ...prev, comment_count: newCount } : null);
  }, [commentsPost]);

  const isWeb = Platform.OS === 'web';

  const openLive = useCallback((live) => {
    router.push({
      pathname: '/live-viewer',
      params: {
        sessionId: live.id || live.session_id,
        hostEmail: live.host_email,
        hostName: live.host_name,
        title: live.title,
      },
    });
  }, [router]);

  const renderLiveHeader = useCallback(() => {
    if (activeLives.length === 0) return null;
    // First live → Instagram-style 16:9 hero card. Bigger avatar + blur-ish
    // gradient overlay + LIVE badge + viewer count chip. The remaining lives
    // fall back to the compact horizontal chip row so the feed isn't taken
    // over by a hero per host.
    const [hero, ...rest] = activeLives;
    const heroName = hero.host_name || hero.host_email?.split('@')[0] || '?';
    const heroViewers = hero.viewer_count || 0;
    return (
      <View style={[styles.liveSection, {
        backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      }]}>
        <View style={styles.liveSectionHeader}>
          <LiveIndicator size="small" />
          <Text style={[styles.liveSectionTitle, { color: colors.text }]}>
            {t('live.liveNow')}
          </Text>
        </View>

        {/* Hero card 16:9. Wraps the host avatar inside a red-tinted backdrop
            with a dark gradient under the text so the LIVE chip + viewer
            pill always read on any avatar art. */}
        <TouchableOpacity
          onPress={() => openLive(hero)}
          activeOpacity={0.88}
          accessibilityRole="button"
          accessibilityLabel={`${t('live.liveNow')}: ${heroName}`}
          style={[styles.liveHero, {
            backgroundColor: isDark ? '#1a0e10' : '#fff',
            ...(isWeb ? {
              boxShadow: isDark
                ? '0 6px 24px rgba(220,38,38,0.18), 0 2px 8px rgba(0,0,0,0.35)'
                : '0 6px 24px rgba(220,38,38,0.12), 0 2px 8px rgba(0,0,0,0.08)',
            } : {}),
          }]}
        >
          {/* Backdrop tint layered behind everything for an Instagram-grade
              red glow. AvatarCircle stays crisp on top. */}
          <View style={styles.liveHeroBackdrop} pointerEvents="none" />
          <View style={styles.liveHeroBackdropGradient} pointerEvents="none" />

          <View style={styles.liveHeroContent}>
            <View style={styles.liveHeroAvatarWrap}>
              <View style={styles.liveHeroAvatarRing}>
                <AvatarCircle
                  name={heroName}
                  email={hero.host_email}
                  size={84}
                />
              </View>
            </View>
            <View style={styles.liveHeroTextCol}>
              <View style={styles.liveHeroBadgeRow}>
                <LiveIndicator size="small" viewerCount={heroViewers} />
              </View>
              <Text style={[styles.liveHeroName, { color: isDark ? '#fff' : '#111' }]} numberOfLines={1}>
                {heroName}
              </Text>
              {!!hero.title && (
                <Text style={[styles.liveHeroTitle, { color: isDark ? 'rgba(255,255,255,0.78)' : 'rgba(0,0,0,0.68)' }]} numberOfLines={2}>
                  {hero.title}
                </Text>
              )}
              <View style={styles.liveHeroCtaPill}>
                <Text style={styles.liveHeroCtaText}>
                  {(t('live.enter') || 'Entrar').toUpperCase()}
                </Text>
              </View>
            </View>
          </View>
        </TouchableOpacity>

        {/* Remaining lives — horizontal chip row, same compact look as before. */}
        {rest.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={[styles.liveScroll, { marginTop: 10 }]}
          >
            {rest.map((live) => (
              <TouchableOpacity
                key={live.id || live.session_id}
                style={[styles.liveCard, {
                  backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#fff',
                  ...(isWeb ? {
                    boxShadow: isDark
                      ? '0 2px 8px rgba(0,0,0,0.3)'
                      : '0 2px 8px rgba(0,0,0,0.08)',
                  } : {}),
                }]}
                onPress={() => openLive(live)}
                activeOpacity={0.7}
                accessibilityLabel={`${t('live.liveNow')}: ${live.host_name || live.host_email}`}
                accessibilityRole="button"
              >
                <View style={styles.liveAvatarWrap}>
                  <View style={styles.liveAvatarRing}>
                    <AvatarCircle
                      name={live.host_name}
                      email={live.host_email}
                      size={50}
                    />
                  </View>
                  <View style={styles.liveBadgeSmall}>
                    <Text style={styles.liveBadgeText}>LIVE</Text>
                  </View>
                </View>
                <Text style={[styles.liveHostName, { color: colors.text }]} numberOfLines={1}>
                  {live.host_name || live.host_email?.split('@')[0] || '?'}
                </Text>
                {live.viewer_count != null && (
                  <Text style={[styles.liveViewers, { color: colors.textSecondary }]}>
                    {live.viewer_count} {live.viewer_count === 1 ? t('live.viewer') : t('live.viewers')}
                  </Text>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>
    );
  }, [activeLives, isDark, colors, t, openLive, isWeb]);

  const handlePressUser = useCallback((email) => {
    if (!email) return;
    router.push(`/u/${encodeURIComponent(email)}`);
  }, [router]);

  // ── Search bar ──
  const renderSearchBar = () => (
    <View style={[styles.searchBarContainer, {
      backgroundColor: isDark ? colors.background : '#f6f8fa',
      borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    }]}>
      <View style={[styles.searchInputWrap, {
        backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
        flex: 1,
      }]}>
        {/* Tapping the magnifying glass routes to the unified /search screen
            (Pessoas / Hashtags / Sons / Lives tabs). The inline TextInput is
            kept as a quick-search-in-feed surface for users who want to find
            an account without leaving the feed. */}
        <TouchableOpacity
          onPress={() => { try { router?.push('/search'); } catch {} }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel={t('feed.unifiedSearch') || 'Pesquisa'}
          accessibilityRole="button"
        >
          <IconSearch size={18} color={isDark ? '#888' : '#999'} />
        </TouchableOpacity>
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder={t('feed.searchPlaceholder')}
          placeholderTextColor={isDark ? '#666' : '#999'}
          value={searchQuery}
          onChangeText={(text) => {
            setIsSearchActive(true);
            handleSearchChange(text);
          }}
          onFocus={() => setIsSearchActive(true)}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityLabel={t('feed.searchPlaceholder') || 'Buscar feed'}
          accessibilityRole="search"
        />
        {(searchQuery.length > 0 || isSearchActive) && (
          <TouchableOpacity onPress={clearSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <IconX size={18} color={isDark ? '#888' : '#999'} />
          </TouchableOpacity>
        )}
      </View>
      <TouchableOpacity
        onPress={() => { setUnreadNotifs(0); try { router?.push('/notifications-feed'); } catch {} }}
        activeOpacity={0.7}
        accessibilityLabel={t('notifications.title') || 'Notificações'}
        accessibilityRole="button"
        style={{ padding: 6, position: 'relative' }}
      >
        <IconBell size={22} color={colors.text} />
        {unreadNotifs > 0 && (
          <View style={{
            position: 'absolute', top: 2, right: 2,
            minWidth: 16, height: 16, borderRadius: 8,
            paddingHorizontal: 4,
            backgroundColor: '#ef4444',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>
              {unreadNotifs > 9 ? '9+' : String(unreadNotifs)}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    </View>
  );

  // ── Search results list ──
  const renderUserCard = useCallback(({ item: usr }) => (
    <TouchableOpacity
      style={[styles.userCard, {
        backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff',
        ...(isWeb ? {
          boxShadow: isDark
            ? '0 1px 4px rgba(0,0,0,0.3)'
            : '0 1px 4px rgba(0,0,0,0.06)',
        } : {}),
      }]}
      onPress={() => {
        clearSearch();
        handlePressUser(usr.email, usr.name);
      }}
      activeOpacity={0.7}
      accessibilityLabel={usr.name || usr.email}
      accessibilityRole="button"
    >
      <AvatarCircle name={usr.name} email={usr.email} size={50} />
      <View style={styles.userCardInfo}>
        <Text style={[styles.userCardName, { color: colors.text }]} numberOfLines={1}>
          {usr.name || usr.email.split('@')[0]}
        </Text>
        <Text style={[styles.userCardEmail, { color: colors.textSecondary }]} numberOfLines={1}>
          {usr.email}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.followButton}
        onPress={() => {
          clearSearch();
          handlePressUser(usr.email, usr.name);
        }}
        activeOpacity={0.7}
      >
        <Text style={styles.followButtonText}>{t('profile.follow')}</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  ), [isDark, colors, isWeb, t, handlePressUser, clearSearch]);

  const renderSearchContent = () => {
    if (searchLoading) {
      return (
        <View style={styles.searchStatusContainer}>
          <ActivityIndicator size="small" color={ACCENT} />
        </View>
      );
    }
    if (searchQuery.trim().length >= 2 && searchResults.length === 0) {
      return (
        <View style={styles.searchStatusContainer}>
          <Text style={[styles.searchStatusText, { color: colors.textSecondary }]}>
            {t('feed.noResults')}
          </Text>
        </View>
      );
    }
    if (searchQuery.trim().length < 2 && isSearchActive) {
      return (
        <View style={{ flex: 1 }}>
          <View style={styles.searchStatusContainer}>
            <IconSearch size={40} color={isDark ? '#333' : '#ddd'} />
            <Text style={[styles.searchStatusText, { color: colors.textSecondary, marginTop: 12 }]}>
              {t('feed.searchHint')}
            </Text>
          </View>
          {/* Reels P0 — Trending hashtags from feed captions (last 24h).
              Surfaced as tappable chips so users can dive into hashtag pages. */}
          <TrendingHashtagsRail
            colors={colors}
            isDark={isDark}
            t={t}
            router={router}
          />
        </View>
      );
    }
    return (
      <FlatList
        data={searchResults}
        renderItem={renderUserCard}
        keyExtractor={(item) => item.email}
        contentContainerStyle={styles.searchResultsList}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />
    );
  };

  // Recommended creators rail — horizontal scroll of 10 suggested users
  // (friends-of-friends). Rendered between post #3 and #4 on the first page
  // and embedded again every 7 posts (via getItemLayout interleaving below).
  //
  // NOTE: this callback is defined BEFORE renderPost on purpose — renderPost's
  // dependency array references renderSuggestionsRail, and JS `const` bindings
  // are not hoisted. Declaring it after renderPost causes a TDZ
  // "Cannot access 'renderSuggestionsRail' before initialization" crash on
  // every web mount (minified as 'ut'). DO NOT reorder.
  const renderSuggestionsRail = useCallback(({ inlineKey = 'rec-rail' } = {}) => {
    if (!suggestionsLoaded || suggestions.length === 0) return null;
    return (
      <View style={[styles.suggestionsRail, {
        backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : '#fff',
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      }]} key={inlineKey}>
        <View style={styles.suggestionsHeader}>
          <Text style={[styles.suggestionsTitle, { color: colors.text }]}>
            {t('feed.suggestedForYou') || 'Sugestões para você'}
          </Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.suggestionsScroll}
        >
          {suggestions.map((u) => (
            <TouchableOpacity
              key={u.email}
              style={[styles.suggestionCard, {
                backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#f6f8fa',
                borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
              }]}
              onPress={() => handlePressUser(u.email)}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={u.name || u.email}
            >
              <AvatarCircle name={u.name || u.email} email={u.email} size={56} />
              <Text style={[styles.suggestionName, { color: colors.text }]} numberOfLines={1}>
                {u.name || u.email?.split('@')[0]}
              </Text>
              {typeof u.mutual_count === 'number' && u.mutual_count > 0 ? (
                <Text style={[styles.suggestionMutual, { color: colors.textSecondary }]} numberOfLines={1}>
                  {(t('feed.mutualCount') || '{n} em comum').replace('{n}', u.mutual_count)}
                </Text>
              ) : null}
              <TouchableOpacity
                style={styles.suggestionFollowBtn}
                onPress={async () => {
                  try { await api.followUser(u.email); } catch {}
                  setSuggestions(prev => prev.filter(s => s.email !== u.email));
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.suggestionFollowText}>
                  {t('profile.follow') || 'Seguir'}
                </Text>
              </TouchableOpacity>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  }, [suggestions, suggestionsLoaded, isDark, colors, t, handlePressUser]);

  const renderPost = useCallback(({ item }) => {
    // Sentinel rows carry an explicit __type marker. We use it to inject the
    // suggested-creators rail every N posts inline with the feed so the user
    // discovers new accounts without leaving the timeline. Any non-post type
    // we don't recognize is silently skipped.
    if (item && item.__type === 'suggestionsRail') {
      // renderSuggestionsRail is defined just above — useCallback identity stays
      // stable across renders. We pass the sentinel id as the React key so
      // multiple rails (after rows 3, 10, 17, ...) stay distinct.
      return renderSuggestionsRail({ inlineKey: item.__key || 'rec-rail' });
    }
    return (
      <FeedPostRow
        post={item}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onOpenComments={handleOpenComments}
        onPostUpdated={() => {}}
        onDeletePost={handleDeletePost}
        onPressUser={handlePressUser}
        onHidePost={handleDeletePost}
      />
    );
  }, [colors, isDark, t, user, handleOpenComments, handleDeletePost, handlePressUser, renderSuggestionsRail]);

  const renderFooter = useCallback(() => {
    // End-of-feed: when there's no more pages and we have at least 1 post,
    // surface a small "voce ja viu tudo" hint so users don't think the feed
    // is broken. Without this, the loader just disappears silently and the
    // user pulls-to-refresh thinking nothing loaded.
    if (!loadingMore && !hasMore && posts.length > 0) {
      return (
        <View style={{ paddingVertical: 28, alignItems: 'center', gap: 6 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
            {t?.('feed.allCaughtUp') || 'Você está em dia 🎉'}
          </Text>
          <Text style={{ color: colors.textTertiary, fontSize: 11 }}>
            {t?.('feed.pullToRefreshNew') || 'Puxe pra baixo pra ver novidades'}
          </Text>
        </View>
      );
    }
    if (!loadingMore) return null;
    return (
      <View>
        <View style={styles.footerLoader}>
          <ActivityIndicator size="small" color={colors?.primary || ACCENT} />
        </View>
        {/* Lightweight skeleton card beneath the spinner so the viewport
            reveals a hint of the next post instead of a blank gap. */}
        <View style={{ opacity: 0.55, paddingHorizontal: 16, paddingBottom: 16 }}>
          <View style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff', borderRadius: 16, padding: 14, gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }} />
              <View style={{ gap: 5, flex: 1 }}>
                <View style={{ width: '40%', height: 10, borderRadius: 5, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }} />
                <View style={{ width: '25%', height: 8, borderRadius: 4, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }} />
              </View>
            </View>
            <View style={{ width: '100%', height: 180, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }} />
          </View>
        </View>
      </View>
    );
  }, [loadingMore, hasMore, posts.length, isDark, colors, t]);

  const renderEmpty = useCallback(() => {
    if (loading) return null;
    // [silent-fail-w3] If the feed fetch failed with nothing cached, show a
    // distinct error state with a tap-to-retry pill instead of the misleading
    // "Seu feed está vazio" copy. Previously the catch only logged to console.
    if (feedError) {
      return (
        <View style={styles.emptyContainer}>
          <EmptyFeedIllustration isDark={isDark} />
          <Text style={[styles.emptyText, { color: colors.text }]}>
            {t('feed.loadError') || 'Erro ao carregar feed.'}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => { setFeedError(false); setLoading(true); loadPosts(1, true); }}
            activeOpacity={0.75}
            style={{
              marginTop: 12, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999,
              backgroundColor: isDark ? 'rgba(220,38,38,0.15)' : 'rgba(220,38,38,0.10)',
            }}>
            <Text style={{ color: '#dc2626', fontWeight: '700', fontSize: 13 }}>
              {t('chat.retry') || 'Tentar novamente'}
            </Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.emptyContainer}>
        <EmptyFeedIllustration isDark={isDark} />
        <Text style={[styles.emptyText, { color: colors.text }]}>
          {t('feed.empty')}
        </Text>
        <Text style={[styles.emptySubtext, { color: colors.textSecondary }]}>
          {t('feed.emptySubtext')}
        </Text>
      </View>
    );
  }, [loading, feedError, isDark, colors, t, loadPosts]);

  // ── Tab toggle bar — sliding pill (premium messenger style) ──
  const tabSlide = useRef(new Animated.Value(feedMode === 'reels' ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(tabSlide, {
      toValue: feedMode === 'reels' ? 1 : 0,
      tension: 240, friction: 22,
      useNativeDriver: false,
    }).start();
  }, [feedMode]);
  const pillLeft = tabSlide.interpolate({ inputRange: [0, 1], outputRange: ['1%', '51%'] });

  // Para você / Seguindo algorithm toggle — twin sliding pill above the
  // Posts/Reels bar. Only visible in Posts mode (Reels has its own surface).
  const algoSlide = useRef(new Animated.Value(algorithm === 'following' ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(algoSlide, {
      toValue: algorithm === 'following' ? 1 : 0,
      tension: 240, friction: 22,
      useNativeDriver: false,
    }).start();
  }, [algorithm]);
  const algoPillLeft = algoSlide.interpolate({ inputRange: [0, 1], outputRange: ['1%', '51%'] });

  const renderAlgorithmTabs = useCallback(() => (
    <View style={[styles.tabBar, {
      backgroundColor: isDark ? colors.background : '#f6f8fa',
      borderBottomColor: 'transparent',
      paddingVertical: 2,
    }]}>
      <Animated.View pointerEvents="none" style={{
        position: 'absolute',
        top: 4, bottom: 4, left: algoPillLeft,
        width: '48%',
        backgroundColor: isDark ? 'rgba(124,58,237,0.20)' : 'rgba(124,58,237,0.10)',
        borderRadius: 10,
      }} />
      <TouchableOpacity
        style={styles.tabItem}
        onPress={() => setAlgorithm('fyp')}
        activeOpacity={0.7}
        accessibilityLabel={t('feed.forYou') || 'Para você'}
        accessibilityRole="tab"
      >
        <Text style={[
          styles.tabItemText,
          { color: algorithm === 'fyp' ? ACCENT : (isDark ? '#aaa' : '#666') },
          algorithm === 'fyp' && styles.tabItemTextActive,
        ]}>
          {t('feed.forYou') || 'Para você'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.tabItem}
        onPress={() => setAlgorithm('following')}
        activeOpacity={0.7}
        accessibilityLabel={t('feed.following') || 'Seguindo'}
        accessibilityRole="tab"
      >
        <Text style={[
          styles.tabItemText,
          { color: algorithm === 'following' ? ACCENT : (isDark ? '#aaa' : '#666') },
          algorithm === 'following' && styles.tabItemTextActive,
        ]}>
          {t('feed.following') || 'Seguindo'}
        </Text>
      </TouchableOpacity>
    </View>
  ), [algorithm, algoPillLeft, isDark, colors, t]);

  const renderTabBar = () => (
    <View style={[styles.tabBar, {
      backgroundColor: isDark ? colors.background : '#f6f8fa',
      borderBottomColor: 'transparent',
    }]}>
      <Animated.View pointerEvents="none" style={{
        position: 'absolute',
        top: 6, bottom: 6, left: pillLeft,
        width: '48%',
        backgroundColor: isDark ? 'rgba(124,58,237,0.20)' : 'rgba(124,58,237,0.10)',
        borderRadius: 10,
      }} />
      <TouchableOpacity
        style={styles.tabItem}
        onPress={() => setFeedMode('posts')}
        activeOpacity={0.7}
        accessibilityLabel={t('feed.posts') || 'Posts'}
        accessibilityRole="tab"
      >
        <Text style={[
          styles.tabItemText,
          { color: feedMode === 'posts' ? ACCENT : (isDark ? '#aaa' : '#666') },
          feedMode === 'posts' && styles.tabItemTextActive,
        ]}>
          {t('feed.posts') || 'Posts'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.tabItem}
        onPress={() => setFeedMode('reels')}
        activeOpacity={0.7}
        accessibilityLabel={t('feed.reels') || 'Reels'}
        accessibilityRole="tab"
      >
        <Text style={[
          styles.tabItemText,
          { color: feedMode === 'reels' ? ACCENT : (isDark ? '#aaa' : '#666') },
          feedMode === 'reels' && styles.tabItemTextActive,
        ]}>
          {t('feed.reels') || 'Reels'}
        </Text>
      </TouchableOpacity>
      {/* Spotlight tab removed — was duplicating Reels (both = short-form
          vertical video feed). User reported the redundancy. The /spotlight
          route still exists for deep links / direct sharing.
          Profile tab removed 2026-05-02 — Profile is reachable via the
          dedicated `Config` tab + the avatar header; having it inside Feed
          duplicated the surface and made the tab bar feel cluttered. */}
    </View>
  );

  // ── Posts mode data — interleaved list ──
  // [hooks-order-fix] This useMemo MUST sit before any conditional `return`
  // below (search / profile / reels short-circuits). Hooks must run in the
  // same order every render — placing it after the early-returns caused
  // "Rendered more hooks than during the previous render" when the user
  // flipped feedMode or activated search. The memo itself short-circuits
  // when there are no suggestions or posts, so it stays cheap for the
  // non-Posts branches.
  const interleavedPosts = useMemo(() => {
    if (!suggestionsLoaded || suggestions.length === 0 || posts.length === 0) return posts;
    const out = [];
    const RAIL_OFFSETS = new Set([3, 10, 17, 24, 31, 38, 45, 52, 59, 66, 73, 80, 87, 94]);
    posts.forEach((p, idx) => {
      out.push(p);
      if (RAIL_OFFSETS.has(idx + 1)) {
        out.push({ __type: 'suggestionsRail', __key: `rec-rail-${idx + 1}`, id: `__rail_${idx + 1}` });
      }
    });
    return out;
  }, [posts, suggestionsLoaded, suggestions.length]);

  // ── Search mode ──
  if (isSearchActive && searchQuery.length > 0) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
        {renderSearchBar()}
        {renderSearchContent()}
      </View>
    );
  }

  // ── Profile mode — render THE unified <Profile> component inline. Was
  // previously a separate FeedProfileSection surface (Instagram-style
  // grid) that duplicated /u/[username]: tapping the avatar there pushed
  // into a *different* profile screen, which is the "abre um perfil e
  // dentro dele abre outro" duplication the user called out. Using the
  // unified Profile here means tapping Edit, Settings, posts, stories,
  // etc. all go through the same code path as /u/[username].
  if (feedMode === 'profile') {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
        {renderSearchBar()}
        {renderTabBar()}
        <Profile
          mode="full"
          email={user?.email}
          colors={colors}
          isDark={isDark}
          t={t}
          router={router}
          onOpenChat={(email) => email && router?.push(`/chat-conversation?email=${encodeURIComponent(email)}`)}
          onOpenCall={(email, isVideo) => email && router?.push(`/chat-conversation?email=${encodeURIComponent(email)}&startCall=${isVideo ? 'video' : 'audio'}`)}
          onOpenEmail={(email) => email && router?.push(`/compose?to=${encodeURIComponent(email)}`)}
        />
      </View>
    );
  }

  // ── Reels mode (full-screen immersive) ──
  if (feedMode === 'reels') {
    return (
      <View style={[styles.container, { backgroundColor: '#000' }]}>
        <ReelsViewer colors={colors} isDark={isDark} t={t} user={user} router={router} />
        {/* Small back-to-posts pill at top-left */}
        <TouchableOpacity
          style={[styles.backToPostsPill, { top: safeTopPill }]}
          onPress={() => setFeedMode('posts')}
          activeOpacity={0.7}
          accessibilityLabel={t('feed.posts') || 'Posts'}
          accessibilityRole="button"
        >
          <Text style={styles.backToPostsText}>{t('feed.posts') || 'Posts'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Posts mode (existing) ──
  // `interleavedPosts` is computed above (before early returns) so the hook
  // order stays stable when the user flips between search / profile / reels.
  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
        {renderSearchBar()}
        {renderTabBar()}
        {renderAlgorithmTabs()}
        <FeedSkeleton isDark={isDark} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
      <ListComponent
        ref={feedListRef}
        data={interleavedPosts}
        renderItem={renderPost}
        keyExtractor={(item) => String(item.id)}
        estimatedItemSize={450}
        onScroll={handleFeedScroll}
        scrollEventThrottle={32}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#7C3AED"
            colors={['#7C3AED', '#5B21B6']}
            progressBackgroundColor={isDark ? '#1f1b2e' : '#fff'}
          />
        }
        ListHeaderComponent={() => <>{renderSearchBar()}{renderTabBar()}{renderAlgorithmTabs()}<StoriesStrip user={user} colors={colors} isDark={isDark} t={t} router={router} />{renderLiveHeader()}</>}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={renderFooter}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={posts.length === 0 && activeLives.length === 0 ? { flex: 1 } : undefined}
        keyboardShouldPersistTaps="handled"
      />

      {/* Scroll-to-top FAB */}
      {showScrollTop && (
        <TouchableOpacity
          style={[styles.fabScrollTop, {
            backgroundColor: isDark ? 'rgba(30,30,30,0.95)' : 'rgba(255,255,255,0.95)',
            ...(isWeb ? { boxShadow: '0 4px 14px rgba(0,0,0,0.15)' } : {}),
          }]}
          onPress={scrollFeedToTop}
          activeOpacity={0.8}
          accessibilityLabel={t('feed.scrollTop') || 'Voltar ao topo'}
          accessibilityRole="button"
        >
          <Text style={{ fontSize: 20, color: isDark ? '#fff' : '#111', lineHeight: 20 }}>↑</Text>
        </TouchableOpacity>
      )}

      {/* Go Live FAB — pulse ring + scroll-top glass blur for a more
          "tech" feel. Pulse signals "ready to broadcast" without being
          distracting (1 cycle per 1.6s, max scale 1.45). */}
      <LiveFab onPress={() => router.push('/live-broadcast')} t={t} isWeb={isWeb} styles={styles} />

      {/* Unified compose FAB (replaces the old per-tab "new post" FAB) */}
      <UnifiedComposeFab
        router={router}
        colors={colors}
        isDark={isDark}
        t={t}
        userEmail={user?.email}
        bottom={24}
        right={16}
      />

      {/* Create post modal */}
      <CreatePostModal
        visible={createVisible}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setCreateVisible(false)}
        onPostCreated={handlePostCreated}
      />

      {/* Comments modal */}
      <FeedComments
        visible={!!commentsPost}
        post={commentsPost}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setCommentsPost(null)}
        onCommentCountChange={handleCommentCountChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // Empty state
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    paddingVertical: 60,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 22,
    letterSpacing: -0.2,
  },
  emptySubtext: {
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 280,
  },
  // FAB
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#7C3AED',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
      },
      android: { elevation: 6 },
      web: { boxShadow: '0 4px 12px rgba(0,0,0,0.15)' },
    }),
  },
  fabScrollTop: {
    position: 'absolute',
    bottom: 156,
    right: 21,
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.08)',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.15, shadowRadius: 6 },
      android: { elevation: 4 },
    }),
  },
  fabLive: {
    position: 'absolute',
    // Moved to bottom-LEFT so the unified compose FAB on the right can fan
    // out 4 action buttons (Email/Mensagem/Status/Publicação) without
    // colliding with this Live button. Previously both lived on the right
    // edge ~58px apart, and opening the + menu pushed Status/Publicação
    // buttons right on top of the red Live button.
    bottom: 24,
    left: 16,
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#dc2626',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
      },
      android: { elevation: 8 },
      default: {},
    }),
  },
  // Live section
  liveSection: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  liveSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 10,
  },
  liveSectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  // Live host name text
  // (sharper grade for premium feel)
  liveScroll: {
    paddingHorizontal: 12,
    gap: 10,
  },
  liveCard: {
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    width: 100,
  },
  liveAvatarWrap: {
    position: 'relative',
    marginBottom: 6,
  },
  liveAvatarRing: {
    borderWidth: 2.5,
    borderColor: '#dc2626',
    borderRadius: 28,
    padding: 2,
    ...Platform.select({
      ios: {
        shadowColor: '#dc2626',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.45,
        shadowRadius: 6,
      },
      android: { elevation: 3 },
      web: { boxShadow: '0 0 10px rgba(220,38,38,0.35)' },
    }),
  },
  liveBadgeSmall: {
    position: 'absolute',
    bottom: -2,
    left: '50%',
    marginLeft: -16,
    backgroundColor: '#dc2626',
    borderRadius: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  liveBadgeText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  liveHostName: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  liveViewers: {
    fontSize: 10,
    marginTop: 2,
  },
  // ─── Live hero card (Instagram parity 16:9-ish) ───
  liveHero: {
    marginHorizontal: 14,
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
    minHeight: 132,
  },
  liveHeroBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(220,38,38,0.10)',
  },
  liveHeroBackdropGradient: {
    position: 'absolute',
    top: 0, left: 0, right: 0, height: 64,
    backgroundColor: 'rgba(220,38,38,0.16)',
  },
  liveHeroContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 14,
  },
  liveHeroAvatarWrap: {
    position: 'relative',
  },
  liveHeroAvatarRing: {
    borderWidth: 3,
    borderColor: '#dc2626',
    borderRadius: 50,
    padding: 3,
    ...Platform.select({
      ios: {
        shadowColor: '#dc2626',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.55,
        shadowRadius: 12,
      },
      android: { elevation: 5 },
      web: { boxShadow: '0 0 16px rgba(220,38,38,0.55)' },
    }),
  },
  liveHeroTextCol: {
    flex: 1,
    gap: 4,
  },
  liveHeroBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  liveHeroName: {
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  liveHeroTitle: {
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
  },
  liveHeroCtaPill: {
    alignSelf: 'flex-start',
    marginTop: 8,
    backgroundColor: '#dc2626',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
  },
  liveHeroCtaText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  // Tab bar
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 6,
    paddingVertical: 4,
    position: 'relative',
  },
  tabItem: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    zIndex: 2,
  },
  tabItemActive: {},
  tabItemText: {
    fontSize: 14,
    fontWeight: '500',
    letterSpacing: 0.1,
  },
  tabItemTextActive: {
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  // Footer
  footerLoader: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  // Search bar
  searchBarContainer: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    paddingHorizontal: 12,
    height: 42,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(124,58,237,0.10)',
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
    ...Platform.select({
      web: { outlineStyle: 'none' },
      default: {},
    }),
  },
  // Search results
  searchResultsList: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 20,
  },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 14,
    marginBottom: 8,
    gap: 12,
  },
  userCardInfo: {
    flex: 1,
    gap: 2,
  },
  userCardName: {
    fontSize: 15,
    fontWeight: '600',
  },
  userCardEmail: {
    fontSize: 13,
  },
  followButton: {
    backgroundColor: '#7C3AED',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  followButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  searchStatusContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  searchStatusText: {
    fontSize: 15,
  },
  // Recommended creators rail (inline in feed)
  suggestionsRail: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  suggestionsHeader: {
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  suggestionsTitle: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  suggestionsScroll: {
    paddingHorizontal: 12,
    gap: 10,
  },
  suggestionCard: {
    width: 130,
    padding: 12,
    borderRadius: 14,
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 10,
  },
  suggestionName: {
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  suggestionMutual: {
    fontSize: 11,
    textAlign: 'center',
  },
  suggestionFollowBtn: {
    marginTop: 6,
    backgroundColor: ACCENT,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 8,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  suggestionFollowText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  // Back to posts pill (reels mode)
  backToPostsPill: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : 18,
    left: 14,
    backgroundColor: 'rgba(0,0,0,0.4)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    zIndex: 30,
  },
  backToPostsText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
