import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, RefreshControl,
  ActivityIndicator, Platform, Dimensions, ScrollView, Animated, TextInput,
  Image, Modal,
} from 'react-native';
// FlatList only (FlashList crashes iOS)
const ListComponent = FlatList;
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


export default function ChatFeedTab({ colors, isDark, t, user, router }) {
  const [feedMode, setFeedMode] = useState('posts'); // 'posts' | 'reels' | 'profile'
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
  const [createVisible, setCreateVisible] = useState(false);
  const [commentsPost, setCommentsPost] = useState(null);
  const [activeLives, setActiveLives] = useState([]);
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
      const r = await api.feedList(pageNum, 20);
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
      }
    } catch (e) {
      console.warn('Feed load error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, []);

  // Load active lives
  const loadLives = useCallback(async () => {
    try {
      const r = await api.liveList();
      if (r && r.success && r.data?.sessions) {
        setActiveLives(Array.isArray(r.data.sessions) ? r.data.sessions : []);
      }
    } catch (e) {
      console.warn('Live list error:', e);
    }
  }, []);

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
      unsubLiveStart = mailWs.on('live_started', () => loadLives());
      unsubLiveEnd = mailWs.on('live_ended', () => loadLives());
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

  const renderLiveHeader = useCallback(() => {
    if (activeLives.length === 0) return null;
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
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.liveScroll}
        >
          {activeLives.map((live) => (
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
              onPress={() => router.push({
                pathname: '/live-viewer',
                params: {
                  sessionId: live.id || live.session_id,
                  hostEmail: live.host_email,
                  hostName: live.host_name,
                  title: live.title,
                },
              })}
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
      </View>
    );
  }, [activeLives, isDark, colors, t, router, isWeb]);

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
        <IconSearch size={18} color={isDark ? '#888' : '#999'} />
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
        <View style={styles.searchStatusContainer}>
          <IconSearch size={40} color={isDark ? '#333' : '#ddd'} />
          <Text style={[styles.searchStatusText, { color: colors.textSecondary, marginTop: 12 }]}>
            {t('feed.searchHint')}
          </Text>
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

  const renderPost = useCallback(({ item }) => (
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
    />
  ), [colors, isDark, t, user, handleOpenComments, handleDeletePost, handlePressUser]);

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
  }, [loading, isDark, colors, t]);

  // ── Tab toggle bar ──
  const renderTabBar = () => (
    <View style={[styles.tabBar, {
      backgroundColor: isDark ? colors.background : '#f6f8fa',
      borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
    }]}>
      <TouchableOpacity
        style={[styles.tabItem, feedMode === 'posts' && styles.tabItemActive]}
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
        style={[styles.tabItem, feedMode === 'reels' && styles.tabItemActive]}
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
      <TouchableOpacity
        style={styles.tabItem}
        onPress={() => router.push('/spotlight')}
        activeOpacity={0.7}
        accessibilityLabel={t('spotlight.title') || 'Spotlight'}
        accessibilityRole="tab"
      >
        <Text style={[styles.tabItemText, { color: isDark ? '#aaa' : '#666' }]}>
          {t('spotlight.title') || 'Spotlight'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.tabItem, feedMode === 'profile' && styles.tabItemActive]}
        onPress={() => setFeedMode('profile')}
        activeOpacity={0.7}
        accessibilityLabel={t('feed.profile') || 'Perfil'}
        accessibilityRole="tab"
      >
        <Text style={[
          styles.tabItemText,
          { color: feedMode === 'profile' ? ACCENT : (isDark ? '#aaa' : '#666') },
          feedMode === 'profile' && styles.tabItemTextActive,
        ]}>
          {t('feed.profile') || 'Perfil'}
        </Text>
      </TouchableOpacity>
    </View>
  );

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
          style={styles.backToPostsPill}
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
  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
        {renderSearchBar()}
        {renderTabBar()}
        <FeedSkeleton isDark={isDark} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
      <ListComponent
        ref={feedListRef}
        data={posts}
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
            tintColor={colors?.primary || ACCENT}
            colors={[colors?.primary || ACCENT]}
          />
        }
        ListHeaderComponent={() => <>{renderSearchBar()}{renderTabBar()}{renderLiveHeader()}</>}
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
  },
  emptyText: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 20,
  },
  emptySubtext: {
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 18,
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
    bottom: 92,
    right: 21,
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
  },
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
  // Tab bar
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabItem: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  tabItemActive: {
    borderBottomColor: '#7C3AED',
  },
  tabItemText: {
    fontSize: 14,
    fontWeight: '500',
  },
  tabItemTextActive: {
    fontWeight: '600',
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
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 40,
    gap: 8,
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
