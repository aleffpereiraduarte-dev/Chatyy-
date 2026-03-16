import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, RefreshControl,
  ActivityIndicator, Platform, Dimensions, ScrollView, Animated,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import FeedPost from './FeedPost';
import FeedComments from './FeedComments';
import CreatePostModal from './CreatePostModal';
import LiveIndicator from './LiveIndicator';
import ReelsViewer from './ReelsViewer';
import { IconPlus, IconVideo } from './Icons';
import * as api from '../services/api';

const ACCENT = '#25D366';
const SCREEN_WIDTH = Dimensions.get('window').width;
const useNative = Platform.OS !== 'web';

// ── Skeleton loader for feed posts ──
function FeedSkeleton({ isDark }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: useNative }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: useNative }),
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
  const Svg = require('react-native-svg').default;
  const { Circle, Rect, Path } = require('react-native-svg');
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

  const pollRef = useRef(null);
  const livePollRef = useRef(null);

  const loadPosts = useCallback(async (pageNum = 1, isRefresh = false) => {
    try {
      const r = await api.feedList(pageNum, 20);
      if (r && r.success && r.data) {
        const rawPosts = r.data.posts || r.data;
        const newPosts = Array.isArray(rawPosts) ? rawPosts : [];
        if (pageNum === 1 || isRefresh) {
          setPosts(newPosts);
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

  // Initial load + polling
  useEffect(() => {
    loadPosts(1);
    loadLives();
    pollRef.current = setInterval(() => {
      loadPosts(1, true);
    }, 30000);
    livePollRef.current = setInterval(loadLives, 15000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (livePollRef.current) clearInterval(livePollRef.current);
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
    />
  ), [colors, isDark, t, user, handleOpenComments, handleDeletePost]);

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

  // ── Reels mode ──
  if (feedMode === 'reels') {
    return (
      <View style={[styles.container, { backgroundColor: '#000' }]}>
        {renderTabBar()}
        <ReelsViewer colors={colors} isDark={isDark} t={t} user={user} />
      </View>
    );
  }

  // ── Posts mode (existing) ──
  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
        {renderTabBar()}
        <FeedSkeleton isDark={isDark} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
      <FlatList
        data={posts}
        renderItem={renderPost}
        keyExtractor={(item) => String(item.id)}
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
        ListHeaderComponent={() => <>{renderTabBar()}{renderLiveHeader()}</>}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={renderFooter}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={posts.length === 0 && activeLives.length === 0 ? { flex: 1 } : undefined}
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
    bottom: 28,
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: ACCENT,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
      },
      android: { elevation: 8 },
      default: {},
    }),
  },
  fabLive: {
    position: 'absolute',
    bottom: 96,
    right: 24,
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
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
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabItemActive: {
    borderBottomColor: ACCENT,
  },
  tabItemText: {
    fontSize: 15,
    fontWeight: '500',
  },
  tabItemTextActive: {
    fontWeight: '700',
  },
  // Footer
  footerLoader: {
    paddingVertical: 20,
    alignItems: 'center',
  },
});
