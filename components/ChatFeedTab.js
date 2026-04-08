import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, RefreshControl,
  ActivityIndicator, Platform, Dimensions, ScrollView, Animated, TextInput,
} from 'react-native';
// FlatList only (FlashList crashes iOS)
const ListComponent = FlatList;
import AvatarCircle from './AvatarCircle';
import FeedPost from './FeedPost';
import FeedComments from './FeedComments';
import CreatePostModal from './CreatePostModal';
import LiveIndicator from './LiveIndicator';
import ReelsViewer from './ReelsViewer';
import { IconPlus, IconVideo, IconSearch, IconX } from './Icons';
import Svg, { Circle, Rect, Path } from 'react-native-svg';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import mailWs from '../services/websocket';

const ACCENT = '#25D366';
const SCREEN_WIDTH = Dimensions.get('window').width;
const useNative = Platform.OS !== 'web';

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
  const [feedMode, setFeedMode] = useState('posts'); // 'posts' | 'reels'
  const [posts, setPosts] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [commentsPost, setCommentsPost] = useState(null);
  const [activeLives, setActiveLives] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [isSearchActive, setIsSearchActive] = useState(false);

  const pollRef = useRef(null);
  const livePollRef = useRef(null);
  const searchTimerRef = useRef(null);
  const searchRequestIdRef = useRef(0);

  const loadPosts = useCallback(async (pageNum = 1, isRefresh = false) => {
    // Show cached feed instantly on first load
    if (pageNum === 1 && !isRefresh) {
      const cached = await getCached('feed_posts');
      if (cached && cached.length > 0) {
        setPosts(cached);
        setLoading(false);
      }
    }
    try {
      const r = await api.feedList(pageNum, 20);
      if (r && r.success && r.data) {
        const rawPosts = r.data.posts || r.data;
        const newPosts = Array.isArray(rawPosts) ? rawPosts : [];
        if (pageNum === 1 || isRefresh) {
          setPosts(newPosts);
          if (pageNum === 1) setCache('feed_posts', newPosts, 7776000000).catch(() => {});
        } else {
          setPosts(prev => {
            const existingIds = new Set(prev.map(p => p.id));
            const unique = newPosts.filter(p => !existingIds.has(p.id));
            return [...prev, ...unique];
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
    const unsubFeed = mailWs.on('feed_new_post', (data) => {
      if (data && data.post) {
        setPosts(prev => {
          // Avoid duplicate if already present
          if (prev.some(p => p.id === data.post.id)) return prev;
          return [data.post, ...prev];
        });
      } else {
        // No inline post data — just refresh from server
        loadPosts(1, true);
      }
    });

    // WebSocket: live stream started/ended
    const unsubLiveStart = mailWs.on('live_started', () => {
      loadLives();
    });
    const unsubLiveEnd = mailWs.on('live_ended', () => {
      loadLives();
    });

    // Fallback polling at 60s (was 30s/15s) — only needed if WS misses an event
    pollRef.current = setInterval(() => {
      loadPosts(1, true);
    }, 60000);
    livePollRef.current = setInterval(loadLives, 60000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (livePollRef.current) clearInterval(livePollRef.current);
      unsubFeed();
      unsubLiveStart();
      unsubLiveEnd();
    };
  }, [loadPosts, loadLives]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    setPage(1);
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
      setPosts(prev => [newPost, ...prev]);
    } else {
      // Reload from server
      loadPosts(1, true);
    }
  }, [loadPosts]);

  const handleDeletePost = useCallback((postId) => {
    setPosts(prev => prev.filter(p => p.id !== postId));
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

  const handlePressUser = useCallback((email, name) => {
    router.push({ pathname: '/user-profile', params: { email, name: name || '' } });
  }, [router]);

  // ── Search bar ──
  const renderSearchBar = () => (
    <View style={[styles.searchBarContainer, {
      backgroundColor: isDark ? colors.background : '#f6f8fa',
      borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
    }]}>
      <View style={[styles.searchInputWrap, {
        backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
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
    <FeedPost
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
    if (!loadingMore) return null;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator size="small" color={ACCENT} />
      </View>
    );
  }, [loadingMore]);

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

  // ── Reels mode (full-screen immersive) ──
  if (feedMode === 'reels') {
    return (
      <View style={[styles.container, { backgroundColor: '#000' }]}>
        <ReelsViewer colors={colors} isDark={isDark} t={t} user={user} />
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
        data={posts}
        renderItem={renderPost}
        keyExtractor={(item) => String(item.id)}
        estimatedItemSize={450}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={ACCENT}
            colors={[ACCENT]}
          />
        }
        ListHeaderComponent={() => <>{renderSearchBar()}{renderTabBar()}{renderLiveHeader()}</>}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={renderFooter}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={posts.length === 0 && activeLives.length === 0 ? { flex: 1 } : undefined}
        keyboardShouldPersistTaps="handled"
      />

      {/* Go Live FAB */}
      <TouchableOpacity
        style={[styles.fabLive, {
          ...(isWeb ? { boxShadow: '0 4px 14px rgba(220,38,38,0.4), 0 2px 6px rgba(0,0,0,0.1)' } : {}),
        }]}
        onPress={() => router.push('/live-broadcast')}
        activeOpacity={0.8}
        accessibilityLabel={t('live.goLive')}
        accessibilityRole="button"
      >
        <IconVideo size={20} color="#fff" />
      </TouchableOpacity>

      {/* FAB to create post */}
      <TouchableOpacity
        style={[styles.fab, {
          ...(isWeb ? { boxShadow: '0 4px 14px rgba(37,211,102,0.4), 0 2px 6px rgba(0,0,0,0.1)' } : {}),
        }]}
        onPress={() => setCreateVisible(true)}
        activeOpacity={0.8}
        accessibilityLabel={t('feed.createPost')}
        accessibilityRole="button"
      >
        <IconPlus size={24} color="#fff" />
      </TouchableOpacity>

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
    backgroundColor: '#25D366',
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
    borderBottomColor: '#25D366',
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
    backgroundColor: '#25D366',
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
