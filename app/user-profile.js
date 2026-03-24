import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Image,
  Dimensions, Platform, ActivityIndicator, RefreshControl, Modal,
  Animated, Share,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import AvatarCircle from '../components/AvatarCircle';
import FeedComments from '../components/FeedComments';
import {
  IconArrowLeft, IconMessageSquare, IconPhone, IconSettings, IconGrid, IconLock,
  IconHeart, IconHeartOutline, IconMessageCircle, IconShare, IconBookmark,
  IconBookmarkFilled, IconX, IconChevronLeft, IconChevronRight,
  IconPlay, IconMenu,
} from '../components/Icons';
import * as api from '../services/api';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const GRID_GAP = 2;
const GRID_COLS = 3;
const GRID_SIZE = (SCREEN_W - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
const ACCENT = '#25D366';
const BASE_URL = 'https://chatyy.com.br';
const DOUBLE_TAP_DELAY = 300;

function resolveMediaUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return BASE_URL + (url.startsWith('/') ? '' : '/') + url;
}

function parseMediaUrls(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

function timeAgo(dateStr, t) {
  if (!dateStr) return '';
  const str = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const now = Date.now();
  const then = new Date(str).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t?.('time.now') || 'now';
  if (mins < 60) return (t?.('time.min') || '{n}m').replace('{n}', mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return (t?.('time.hours') || '{n}h').replace('{n}', hrs);
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return new Date(str).toLocaleDateString();
}

function formatLikeCount(count, t) {
  if (count <= 0) return '';
  if (count === 1) return t?.('feed.oneLike') || '1 like';
  if (count >= 1000000) return `${(count / 1000000).toFixed(1).replace(/\.0$/, '')}M ${t?.('feed.likes') || 'likes'}`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}K ${t?.('feed.likes') || 'likes'}`;
  return `${count} ${t?.('feed.likes') || 'likes'}`;
}

// ─── Post Viewer Modal ───────────────────────────────────────────────
function PostViewerModal({ visible, posts, initialIndex, colors, isDark, t, user, onClose, onPostUpdated }) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex || 0);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [bookmarked, setBookmarked] = useState(false);
  const [activeMediaIdx, setActiveMediaIdx] = useState(0);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [commentsVisible, setCommentsVisible] = useState(false);

  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;
  const likeButtonScale = useRef(new Animated.Value(1)).current;
  const bookmarkScale = useRef(new Animated.Value(1)).current;
  const lastTapRef = useRef(0);
  const mediaScrollRef = useRef(null);
  const isWeb = Platform.OS === 'web';

  const post = posts[currentIndex];

  // Sync state when post changes
  useEffect(() => {
    if (!post) return;
    setLiked(!!post.user_liked);
    setLikeCount(Number(post.like_count) || 0);
    setBookmarked(!!post.user_bookmarked);
    setActiveMediaIdx(0);
    setCaptionExpanded(false);
  }, [currentIndex, post?.id]);

  useEffect(() => {
    if (visible) setCurrentIndex(initialIndex || 0);
  }, [visible, initialIndex]);

  // Keyboard navigation (web)
  useEffect(() => {
    if (!visible || !isWeb) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && currentIndex > 0) setCurrentIndex(i => i - 1);
      else if (e.key === 'ArrowRight' && currentIndex < posts.length - 1) setCurrentIndex(i => i + 1);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [visible, isWeb, currentIndex, posts.length, onClose]);

  const navigatePrev = useCallback(() => {
    if (currentIndex > 0) setCurrentIndex(i => i - 1);
  }, [currentIndex]);

  const navigateNext = useCallback(() => {
    if (currentIndex < posts.length - 1) setCurrentIndex(i => i + 1);
  }, [currentIndex, posts.length]);

  const animateLikeButton = useCallback(() => {
    likeButtonScale.setValue(0.7);
    Animated.spring(likeButtonScale, { toValue: 1, tension: 300, friction: 10, useNativeDriver: false }).start();
  }, [likeButtonScale]);

  const showHeartAnimation = useCallback(() => {
    heartScale.setValue(0);
    heartOpacity.setValue(1);
    Animated.sequence([
      Animated.spring(heartScale, { toValue: 1.15, tension: 250, friction: 6, useNativeDriver: false }),
      Animated.parallel([
        Animated.spring(heartScale, { toValue: 1, tension: 200, friction: 10, useNativeDriver: false }),
        Animated.timing(heartOpacity, { toValue: 0, duration: 500, delay: 300, useNativeDriver: false }),
      ]),
    ]).start();
  }, [heartScale, heartOpacity]);

  const toggleLike = useCallback(async () => {
    if (!post) return;
    const wasLiked = liked;
    setLiked(!wasLiked);
    setLikeCount(prev => wasLiked ? Math.max(0, prev - 1) : prev + 1);
    animateLikeButton();
    try {
      const r = await api.feedLike(post.id);
      if (r.success && r.data) {
        const newLiked = r.data.liked !== undefined ? !!r.data.liked : !wasLiked;
        const newCount = r.data.like_count !== undefined ? Number(r.data.like_count) : (wasLiked ? likeCount - 1 : likeCount + 1);
        setLiked(newLiked);
        setLikeCount(newCount);
        // Update parent posts array
        if (onPostUpdated) onPostUpdated(post.id, { user_liked: newLiked, like_count: newCount });
      }
    } catch {
      setLiked(wasLiked);
      setLikeCount(prev => wasLiked ? prev + 1 : Math.max(0, prev - 1));
    }
  }, [liked, post, likeCount, animateLikeButton, onPostUpdated]);

  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      if (!liked) toggleLike();
      showHeartAnimation();
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  }, [liked, toggleLike, showHeartAnimation]);

  const toggleBookmark = useCallback(async () => {
    if (!post) return;
    const was = bookmarked;
    setBookmarked(!was);
    bookmarkScale.setValue(0.7);
    Animated.spring(bookmarkScale, { toValue: 1, tension: 300, friction: 10, useNativeDriver: false }).start();
    try {
      const r = await api.feedBookmark(post.id);
      if (r.success && r.data) {
        const newVal = r.data.bookmarked !== undefined ? !!r.data.bookmarked : !was;
        setBookmarked(newVal);
        if (onPostUpdated) onPostUpdated(post.id, { user_bookmarked: newVal });
      }
    } catch {
      setBookmarked(was);
    }
  }, [bookmarked, post, bookmarkScale, onPostUpdated]);

  const handleShare = useCallback(async () => {
    if (!post) return;
    const url = `${BASE_URL}/feed/${post.id}`;
    if (isWeb && typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: post.caption || '', url }); } catch {}
    } else if (!isWeb) {
      try { await Share.share({ message: url }); } catch {}
    }
  }, [post, isWeb]);

  const handleCommentCountChange = useCallback((newCount) => {
    if (post && onPostUpdated) {
      onPostUpdated(post.id, { comment_count: newCount });
    }
  }, [post, onPostUpdated]);

  if (!visible || !post) return null;

  const mediaUrls = parseMediaUrls(post.media_urls);
  const authorDisplay = post.author_name || post.author_email?.split('@')[0] || '?';
  const commentCount = Number(post.comment_count) || 0;
  const needsTruncation = post.caption && post.caption.length > 150;
  const cardWidth = Math.min(SCREEN_W, 600);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose} statusBarTranslucent>
      <View style={[ms.overlay, { backgroundColor: isDark ? 'rgba(0,0,0,0.95)' : 'rgba(0,0,0,0.92)' }]}>
        {/* Close button */}
        <TouchableOpacity
          style={ms.closeBtn}
          onPress={onClose}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel={t('common.close') || 'Close'}
          accessibilityRole="button"
        >
          <IconX size={26} color="#fff" />
        </TouchableOpacity>

        {/* Post counter */}
        <View style={ms.counterBadge}>
          <Text style={ms.counterText}>{currentIndex + 1} / {posts.length}</Text>
        </View>

        {/* Navigation arrows */}
        {currentIndex > 0 && (
          <TouchableOpacity
            style={[ms.navArrow, ms.navLeft]}
            onPress={navigatePrev}
            accessibilityLabel={t('common.previous') || 'Previous'}
            accessibilityRole="button"
          >
            <IconChevronLeft size={32} color="#fff" />
          </TouchableOpacity>
        )}
        {currentIndex < posts.length - 1 && (
          <TouchableOpacity
            style={[ms.navArrow, ms.navRight]}
            onPress={navigateNext}
            accessibilityLabel={t('common.next') || 'Next'}
            accessibilityRole="button"
          >
            <IconChevronRight size={32} color="#fff" />
          </TouchableOpacity>
        )}

        <ScrollView
          style={ms.scrollWrap}
          contentContainerStyle={ms.scrollContent}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {/* Header */}
          <View style={ms.header}>
            <AvatarCircle email={post.author_email} name={post.author_name} size={34} />
            <View style={ms.headerInfo}>
              <Text style={ms.authorName} numberOfLines={1}>{authorDisplay}</Text>
              {post.location ? (
                <Text style={ms.location} numberOfLines={1}>{post.location}</Text>
              ) : null}
            </View>
            <Text style={ms.headerTime}>{timeAgo(post.created_at, t)}</Text>
          </View>

          {/* Media */}
          {mediaUrls.length > 0 && (
            <TouchableOpacity activeOpacity={1} onPress={handleDoubleTap} style={ms.mediaContainer}>
              {mediaUrls.length === 1 ? (
                post.media_type === 'video' ? (
                  <View style={[ms.mediaFrame, { width: cardWidth, maxWidth: '100%' }]}>
                    {isWeb ? (
                      <video
                        src={resolveMediaUrl(mediaUrls[0])}
                        style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }}
                        controls
                        playsInline
                        preload="auto"
                        poster={post.thumbnail_url ? resolveMediaUrl(post.thumbnail_url) : undefined}
                      />
                    ) : (
                      <View style={[ms.mediaFrame, { alignItems: 'center', justifyContent: 'center' }]}>
                        <Image
                          source={{ uri: resolveMediaUrl(post.thumbnail_url || mediaUrls[0]) }}
                          style={StyleSheet.absoluteFill}
                          resizeMode="contain"
                        />
                        <View style={ms.playButton}>
                          <IconPlay size={32} color="#fff" />
                        </View>
                      </View>
                    )}
                  </View>
                ) : (
                  <Image
                    source={{ uri: resolveMediaUrl(mediaUrls[0]) }}
                    style={[ms.mediaFrame, { width: cardWidth, maxWidth: '100%' }]}
                    resizeMode="contain"
                  />
                )
              ) : (
                <View>
                  <ScrollView
                    ref={mediaScrollRef}
                    horizontal
                    pagingEnabled
                    showsHorizontalScrollIndicator={false}
                    onScroll={(e) => {
                      const idx = Math.round(e.nativeEvent.contentOffset.x / cardWidth);
                      setActiveMediaIdx(idx);
                    }}
                    scrollEventThrottle={16}
                    decelerationRate="fast"
                    snapToInterval={cardWidth}
                  >
                    {mediaUrls.map((url, idx) => (
                      <Image
                        key={idx}
                        source={{ uri: resolveMediaUrl(url) }}
                        style={[ms.mediaFrame, { width: cardWidth }]}
                        resizeMode="contain"
                      />
                    ))}
                  </ScrollView>
                  <View style={ms.mediaDots}>
                    {mediaUrls.map((_, idx) => (
                      <View
                        key={idx}
                        style={[ms.dot, {
                          width: idx === activeMediaIdx ? 8 : 6,
                          height: idx === activeMediaIdx ? 8 : 6,
                          borderRadius: idx === activeMediaIdx ? 4 : 3,
                          opacity: idx === activeMediaIdx ? 1 : 0.5,
                          backgroundColor: idx === activeMediaIdx ? ACCENT : '#fff',
                        }]}
                      />
                    ))}
                  </View>
                  <View style={ms.mediaCounterBadge}>
                    <Text style={ms.mediaCounterText}>{activeMediaIdx + 1}/{mediaUrls.length}</Text>
                  </View>
                </View>
              )}

              {/* Heart animation overlay */}
              <Animated.View
                pointerEvents="none"
                style={[ms.heartOverlay, { opacity: heartOpacity, transform: [{ scale: heartScale }] }]}
              >
                <IconHeart size={90} color="#fff" />
              </Animated.View>
            </TouchableOpacity>
          )}

          {/* Action bar */}
          <View style={ms.actionBar}>
            <View style={ms.actionsLeft}>
              <Animated.View style={{ transform: [{ scale: likeButtonScale }] }}>
                <TouchableOpacity onPress={toggleLike} style={ms.actionBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                  {liked ? <IconHeart size={26} color="#ef4444" /> : <IconHeartOutline size={26} color="#fff" />}
                </TouchableOpacity>
              </Animated.View>
              <TouchableOpacity onPress={() => setCommentsVisible(true)} style={ms.actionBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <IconMessageCircle size={25} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleShare} style={ms.actionBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <IconShare size={23} color="#fff" />
              </TouchableOpacity>
            </View>
            <Animated.View style={{ transform: [{ scale: bookmarkScale }] }}>
              <TouchableOpacity onPress={toggleBookmark} style={ms.actionBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                {bookmarked ? <IconBookmarkFilled size={25} color="#fff" /> : <IconBookmark size={25} color="#fff" />}
              </TouchableOpacity>
            </Animated.View>
          </View>

          {/* Like count */}
          {likeCount > 0 && (
            <View style={ms.likeRow}>
              <Text style={ms.likeText}>{formatLikeCount(likeCount, t)}</Text>
            </View>
          )}

          {/* Caption */}
          {post.caption ? (
            <View style={ms.captionRow}>
              <Text style={ms.captionText} numberOfLines={captionExpanded ? undefined : 3}>
                <Text style={ms.captionAuthor}>{authorDisplay}</Text>
                {'  '}{post.caption}
              </Text>
              {!captionExpanded && needsTruncation && (
                <TouchableOpacity onPress={() => setCaptionExpanded(true)}>
                  <Text style={ms.moreText}>{t('feed.more') || 'more'}</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : null}

          {/* Comments count link */}
          {commentCount > 0 && (
            <TouchableOpacity onPress={() => setCommentsVisible(true)} style={ms.commentsLink}>
              <Text style={ms.commentsLinkText}>
                {commentCount === 1
                  ? (t('feed.viewOneComment') || 'View 1 comment')
                  : (t('feed.viewAllComments') || 'View all {count} comments').replace('{count}', commentCount)
                }
              </Text>
            </TouchableOpacity>
          )}

          {/* Timestamp */}
          <Text style={ms.timestamp}>
            {new Date(
              (post.created_at || '').endsWith('Z') || (post.created_at || '').includes('+')
                ? post.created_at
                : (post.created_at || '') + 'Z'
            ).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
          </Text>
        </ScrollView>
      </View>

      {/* Comments bottom sheet */}
      <FeedComments
        visible={commentsVisible}
        post={post}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setCommentsVisible(false)}
        onCommentCountChange={handleCommentCountChange}
      />
    </Modal>
  );
}

// ─── Modal styles ────────────────────────────────────────────────────
const ms = StyleSheet.create({
  overlay: { flex: 1 },
  closeBtn: {
    position: 'absolute', top: Platform.OS === 'ios' ? 54 : 16, right: 16, zIndex: 20,
    width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  counterBadge: {
    position: 'absolute', top: Platform.OS === 'ios' ? 60 : 22, left: 0, right: 0, zIndex: 10,
    alignItems: 'center',
  },
  counterText: { color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' },
  navArrow: {
    position: 'absolute', top: '50%', zIndex: 15, width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center',
    marginTop: -22,
  },
  navLeft: { left: 8 },
  navRight: { right: 8 },
  scrollWrap: { flex: 1, marginTop: Platform.OS === 'ios' ? 90 : 50 },
  scrollContent: { paddingBottom: 40 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10,
  },
  headerInfo: { flex: 1, marginLeft: 10 },
  authorName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  location: { color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 1 },
  headerTime: { color: 'rgba(255,255,255,0.5)', fontSize: 12 },
  mediaContainer: { position: 'relative', backgroundColor: '#000', alignItems: 'center' },
  mediaFrame: { aspectRatio: 1, backgroundColor: '#000' },
  playButton: {
    width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center', paddingLeft: 3,
  },
  mediaDots: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    paddingVertical: 10, gap: 4, position: 'absolute', bottom: 0, left: 0, right: 0,
  },
  dot: {},
  mediaCounterBadge: {
    position: 'absolute', top: 14, right: 14, backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4,
  },
  mediaCounterText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  heartOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  actionBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4,
  },
  actionsLeft: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  actionBtn: { padding: 7 },
  likeRow: { paddingHorizontal: 14, paddingTop: 2 },
  likeText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  captionRow: { paddingHorizontal: 14, paddingTop: 4 },
  captionText: { color: '#fff', fontSize: 14, lineHeight: 20 },
  captionAuthor: { fontWeight: '600' },
  moreText: { color: 'rgba(255,255,255,0.5)', fontSize: 14, marginTop: 1 },
  commentsLink: { paddingHorizontal: 14, paddingTop: 5 },
  commentsLinkText: { color: 'rgba(255,255,255,0.5)', fontSize: 14 },
  timestamp: {
    color: 'rgba(255,255,255,0.4)', fontSize: 10, paddingHorizontal: 14,
    paddingTop: 6, paddingBottom: 14, textTransform: 'uppercase', letterSpacing: 0.3,
  },
});

// ─── List View Post Row ──────────────────────────────────────────────
function ListPostRow({ post, colors, isDark, t, onPress }) {
  const mediaUrls = parseMediaUrls(post.media_urls);
  const thumbUrl = post.thumbnail_url || mediaUrls[0];
  const fullUrl = thumbUrl ? resolveMediaUrl(thumbUrl) : null;
  const authorDisplay = post.author_name || post.author_email?.split('@')[0] || '?';
  const commentCount = Number(post.comment_count) || 0;
  const lCount = Number(post.like_count) || 0;

  return (
    <TouchableOpacity
      style={[ls.row, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      {fullUrl && (
        <Image source={{ uri: fullUrl }} style={ls.thumb} resizeMode="cover" />
      )}
      <View style={ls.info}>
        {post.caption ? (
          <Text style={[ls.caption, { color: colors.text }]} numberOfLines={2}>{post.caption}</Text>
        ) : (
          <Text style={[ls.caption, { color: colors.textSecondary }]} numberOfLines={1}>
            {post.media_type === 'video' ? (t('feed.video') || 'Video') : (t('feed.image') || 'Image')}
          </Text>
        )}
        <View style={ls.metaRow}>
          <Text style={[ls.metaText, { color: colors.textTertiary }]}>{timeAgo(post.created_at, t)}</Text>
          {lCount > 0 && (
            <View style={ls.metaItem}>
              <IconHeartOutline size={12} color={colors.textTertiary} />
              <Text style={[ls.metaText, { color: colors.textTertiary }]}>{lCount}</Text>
            </View>
          )}
          {commentCount > 0 && (
            <View style={ls.metaItem}>
              <IconMessageCircle size={12} color={colors.textTertiary} />
              <Text style={[ls.metaText, { color: colors.textTertiary }]}>{commentCount}</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const ls = StyleSheet.create({
  row: { flexDirection: 'row', padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  thumb: { width: 64, height: 64, borderRadius: 8, backgroundColor: '#222' },
  info: { flex: 1, marginLeft: 12, justifyContent: 'center' },
  caption: { fontSize: 14, lineHeight: 19, fontWeight: '500' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaText: { fontSize: 12 },
});


// ─── Main Screen ─────────────────────────────────────────────────────
export default function UserProfileScreen() {
  const router = useRouter();
  const { email, name } = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const isOwnProfile = user?.email === email;

  const [profileData, setProfileData] = useState(null);
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ posts: 0, followers: 0, following: 0 });
  const [isFollowing, setIsFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [tab, setTab] = useState('posts'); // posts | reels | tagged
  const [viewMode, setViewMode] = useState('grid'); // grid | list
  const [hasActiveStatus, setHasActiveStatus] = useState(false);
  const [isOnline, setIsOnline] = useState(false);
  const [mutualFollowers, setMutualFollowers] = useState([]);
  const [viewerPostIdx, setViewerPostIdx] = useState(-1);
  const viewerVisible = viewerPostIdx >= 0;

  const displayName = profileData?.display_name || profileData?.name || name || email?.split('@')[0] || '?';
  const bio = profileData?.bio || profileData?.about || '';
  const filteredPosts = useMemo(() => {
    if (tab === 'reels') return posts.filter(p => p.media_type === 'video' || (p.media_urls && JSON.stringify(p.media_urls).match(/\.(mp4|mov|webm)/i)));
    return posts;
  }, [posts, tab]);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    try {
      const [profileRes, postsRes, followRes, statusRes, mutualRes] = await Promise.all([
        api.apiCall('get_public_profile', { email }, 'GET').catch(() => null),
        api.feedUserPosts(email).catch(() => ({ data: [] })),
        api.apiCall('follow_status', { target_email: email }, 'GET').catch(() => null),
        api.statusList().catch(() => null),
        !isOwnProfile ? api.apiCall('mutual_followers', { target_email: email }, 'GET').catch(() => null) : Promise.resolve(null),
      ]);

      if (profileRes?.success && profileRes.data) {
        setProfileData(profileRes.data);
        setStats({
          posts: profileRes.data.post_count || 0,
          followers: profileRes.data.followers_count || 0,
          following: profileRes.data.following_count || 0,
        });
        setIsOnline(!!profileRes.data.is_online || !!profileRes.data.online);
      }

      if (postsRes?.data) {
        const postList = Array.isArray(postsRes.data) ? postsRes.data : (postsRes.data.posts || []);
        setPosts(postList);
        if (!profileRes?.data?.post_count) {
          setStats(prev => ({ ...prev, posts: postList.length }));
        }
      }

      if (followRes?.success) {
        setIsFollowing(followRes.data?.is_following || false);
      }

      // Check if user has active status
      if (statusRes?.success && statusRes.data) {
        const statuses = Array.isArray(statusRes.data) ? statusRes.data : (statusRes.data.statuses || []);
        const userHasStatus = statuses.some(s => s.author_email === email || s.email === email);
        setHasActiveStatus(userHasStatus);
      }

      // Mutual followers
      if (mutualRes?.success && mutualRes.data) {
        const mutuals = Array.isArray(mutualRes.data) ? mutualRes.data : (mutualRes.data.followers || mutualRes.data.mutuals || []);
        setMutualFollowers(mutuals);
      }
    } catch {}
    setLoading(false);
  }, [email, isOwnProfile]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  const handleFollow = useCallback(async () => {
    setFollowLoading(true);
    try {
      const action = isFollowing ? 'unfollow_user' : 'follow_user';
      const r = await api.apiCall(action, { target_email: email }, 'POST');
      if (r?.success) {
        setIsFollowing(!isFollowing);
        setStats(prev => ({
          ...prev,
          followers: prev.followers + (isFollowing ? -1 : 1),
        }));
      }
    } catch {}
    setFollowLoading(false);
  }, [isFollowing, email]);

  const handleMessage = useCallback(async () => {
    try {
      const r = await api.chatCreate([email], '', 'direct');
      const convId = r.data?.conversation_id || r.data?.id;
      if (r.success && convId) {
        router.push({ pathname: '/chat-conversation', params: { id: convId, email, name: displayName, type: 'direct' } });
      } else {
        router.push({ pathname: '/chat-conversation', params: { email, name: displayName } });
      }
    } catch {
      router.push({ pathname: '/chat-conversation', params: { email, name: displayName } });
    }
  }, [email, displayName]);

  const handleCall = useCallback(() => {
    router.push({ pathname: '/call', params: { email, name: displayName, video: 'false' } });
  }, [email, displayName]);

  const handlePostUpdated = useCallback((postId, updates) => {
    setPosts(prev => prev.map(p => p.id === postId ? { ...p, ...updates } : p));
  }, []);

  const openPostViewer = useCallback((index) => {
    setViewerPostIdx(index);
  }, []);

  const formatCount = (n) => {
    if (!n) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  };

  const mutualFollowersText = useMemo(() => {
    if (mutualFollowers.length === 0 || isOwnProfile) return null;
    const names = mutualFollowers.map(f => f.name || f.display_name || f.email?.split('@')[0] || '?');
    if (names.length === 1) {
      return (t('profile.followedByOne') || 'Seguido por {name}').replace('{name}', names[0]);
    }
    if (names.length === 2) {
      return (t('profile.followedByTwo') || 'Seguido por {name1} e {name2}')
        .replace('{name1}', names[0]).replace('{name2}', names[1]);
    }
    const others = mutualFollowers.length - 2;
    return (t('profile.followedByMany') || 'Seguido por {name1}, {name2} e mais {count}')
      .replace('{name1}', names[0]).replace('{name2}', names[1]).replace('{count}', others);
  }, [mutualFollowers, isOwnProfile, t]);

  const renderGridPost = useCallback(({ item, index }) => {
    const mediaUrls = parseMediaUrls(item.media_urls);
    const mediaUrl = mediaUrls[0] || item.thumbnail_url;
    if (!mediaUrl) return null;
    const fullUrl = resolveMediaUrl(mediaUrl);
    return (
      <TouchableOpacity
        style={{ width: GRID_SIZE, height: GRID_SIZE, marginRight: GRID_GAP, marginBottom: GRID_GAP }}
        activeOpacity={0.8}
        onPress={() => openPostViewer(index)}
      >
        <Image source={{ uri: fullUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        {item.media_type === 'video' && (
          <View style={{ position: 'absolute', top: 6, right: 6 }}>
            <IconPlay size={14} color="#fff" style={{ textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 2 }} />
          </View>
        )}
        {(mediaUrls.length || 0) > 1 && (
          <View style={{ position: 'absolute', top: 6, right: 6 }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 2 }}>
              {mediaUrls.length > 1 ? '\u229E' : ''}
            </Text>
          </View>
        )}
        {/* Like/comment counts badge (bottom-left) */}
        {(Number(item.like_count) > 0 || Number(item.comment_count) > 0) && (
          <View style={s.gridBadgeRow}>
            {Number(item.like_count) > 0 && (
              <View style={s.gridBadgeItem}>
                <IconHeart size={10} color="#fff" />
                <Text style={s.gridBadgeText}>{formatCount(Number(item.like_count))}</Text>
              </View>
            )}
            {Number(item.comment_count) > 0 && (
              <View style={s.gridBadgeItem}>
                <IconMessageCircle size={10} color="#fff" />
                <Text style={s.gridBadgeText}>{formatCount(Number(item.comment_count))}</Text>
              </View>
            )}
          </View>
        )}
      </TouchableOpacity>
    );
  }, [openPostViewer]);

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {displayName}
        </Text>
        {isOwnProfile && (
          <TouchableOpacity onPress={() => router.push('/settings')} style={s.backBtn}>
            <IconSettings size={20} color={colors.text} />
          </TouchableOpacity>
        )}
        {!isOwnProfile && <View style={{ width: 40 }} />}
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadProfile} tintColor={ACCENT} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile Info */}
        <View style={s.profileSection}>
          <View style={s.avatarRow}>
            <View style={s.avatarWrap}>
              {/* Story ring */}
              <View style={[
                s.storyRing,
                hasActiveStatus && s.storyRingActive,
                !hasActiveStatus && { borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' },
              ]}>
                <AvatarCircle email={email} name={displayName} size={82} />
              </View>
              {/* Online indicator */}
              <View style={[
                s.onlineDot,
                {
                  backgroundColor: isOnline ? '#44b700' : (isDark ? '#555' : '#bbb'),
                  borderColor: colors.background,
                },
              ]} />
            </View>
            <View style={s.statsRow}>
              <View style={s.statItem}>
                <Text style={[s.statNum, { color: colors.text }]}>{formatCount(stats.posts)}</Text>
                <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('profile.posts')}</Text>
              </View>
              <TouchableOpacity style={s.statItem}>
                <Text style={[s.statNum, { color: colors.text }]}>{formatCount(stats.followers)}</Text>
                <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('profile.followers')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.statItem}>
                <Text style={[s.statNum, { color: colors.text }]}>{formatCount(stats.following)}</Text>
                <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('profile.following')}</Text>
              </TouchableOpacity>
            </View>
          </View>

          <Text style={[s.displayName, { color: colors.text }]}>{displayName}</Text>
          {profileData?.category && (
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{profileData.category}</Text>
          )}
          {bio ? <Text style={[s.bio, { color: colors.textSecondary }]}>{bio}</Text> : null}
          {profileData?.website && (
            <TouchableOpacity onPress={() => { try { require('react-native').Linking.openURL(profileData.website.startsWith('http') ? profileData.website : 'https://' + profileData.website); } catch {} }}>
              <Text style={{ fontSize: 14, color: '#3b82f6', fontWeight: '500', marginTop: 4 }}>{profileData.website.replace(/^https?:\/\//, '')}</Text>
            </TouchableOpacity>
          )}

          {/* Mutual followers */}
          {mutualFollowersText && (
            <Text style={[s.mutualText, { color: colors.textSecondary }]} numberOfLines={2}>
              {mutualFollowersText}
            </Text>
          )}

          {/* Action buttons */}
          <View style={s.actionRow}>
            {isOwnProfile ? (
              <TouchableOpacity style={[s.actionBtn, { backgroundColor: isDark ? '#333' : '#f0f0f0' }]} onPress={() => router.push('/profile')}>
                <Text style={[s.actionBtnText, { color: colors.text }]}>{t('profile.editProfile')}</Text>
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity
                  style={[s.actionBtn, { backgroundColor: isFollowing ? (isDark ? '#333' : '#f0f0f0') : ACCENT }]}
                  onPress={handleFollow}
                  disabled={followLoading}
                >
                  {followLoading ? (
                    <ActivityIndicator size="small" color={isFollowing ? colors.text : '#fff'} />
                  ) : (
                    <Text style={[s.actionBtnText, { color: isFollowing ? colors.text : '#fff', fontWeight: '700' }]}>
                      {isFollowing ? t('profile.following') : t('profile.follow')}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={[s.actionBtnSmall, { backgroundColor: isDark ? '#333' : '#f0f0f0' }]} onPress={handleMessage}>
                  <IconMessageSquare size={18} color={colors.text} />
                </TouchableOpacity>
                <TouchableOpacity style={[s.actionBtnSmall, { backgroundColor: isDark ? '#333' : '#f0f0f0' }]} onPress={handleCall}>
                  <IconPhone size={18} color={colors.text} />
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        {/* Tab bar with view mode toggle */}
        <View style={[s.tabBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity style={[s.tab, tab === 'posts' && { borderBottomColor: colors.text, borderBottomWidth: 1.5 }]} onPress={() => setTab('posts')}>
            <IconGrid size={22} color={tab === 'posts' ? colors.text : colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity style={[s.tab, tab === 'reels' && { borderBottomColor: colors.text, borderBottomWidth: 1.5 }]} onPress={() => setTab('reels')}>
            <IconPlay size={22} color={tab === 'reels' ? colors.text : colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity style={[s.tab, tab === 'tagged' && { borderBottomColor: colors.text, borderBottomWidth: 1.5 }]} onPress={() => setTab('tagged')}>
            <IconLock size={22} color={tab === 'tagged' ? colors.text : colors.textSecondary} />
          </TouchableOpacity>
          {/* View mode toggle */}
          <View style={s.viewModeToggle}>
            <TouchableOpacity
              onPress={() => setViewMode('grid')}
              style={[s.viewModeBtn, viewMode === 'grid' && { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)' }]}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <IconGrid size={16} color={viewMode === 'grid' ? colors.text : colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setViewMode('list')}
              style={[s.viewModeBtn, viewMode === 'list' && { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)' }]}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <IconMenu size={16} color={viewMode === 'list' ? colors.text : colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Posts */}
        {filteredPosts.length === 0 && !loading ? (
          <View style={s.emptyState}>
            <Text style={{ color: colors.textSecondary, fontSize: 14 }}>
              {isOwnProfile ? t('feed.noPosts') : t('feed.noUserPosts')}
            </Text>
          </View>
        ) : viewMode === 'grid' ? (
          <View style={s.grid}>
            {filteredPosts.map((post, i) => (
              <React.Fragment key={post.id || i}>
                {renderGridPost({ item: post, index: i })}
              </React.Fragment>
            ))}
          </View>
        ) : (
          <View>
            {filteredPosts.map((post, i) => (
              <ListPostRow
                key={post.id || i}
                post={post}
                colors={colors}
                isDark={isDark}
                t={t}
                onPress={() => openPostViewer(i)}
              />
            ))}
          </View>
        )}
      </ScrollView>

      {/* Post Viewer Modal */}
      <PostViewerModal
        visible={viewerVisible}
        posts={posts}
        initialIndex={viewerPostIdx}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setViewerPostIdx(-1)}
        onPostUpdated={handlePostUpdated}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { width: 40, alignItems: 'center', justifyContent: 'center', padding: 8 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  profileSection: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12 },
  avatarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  avatarWrap: { marginRight: 24, position: 'relative' },
  storyRing: {
    padding: 3,
    borderRadius: 48,
    borderWidth: 2.5,
    borderColor: 'transparent',
  },
  storyRingActive: {
    borderColor: ACCENT,
    // Gradient-like effect for story ring
    ...Platform.select({
      web: {
        backgroundImage: 'linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)',
        borderColor: 'transparent',
        // Use box-shadow to fake gradient border on web
        boxShadow: 'inset 0 0 0 2px #fff',
      },
      default: {},
    }),
  },
  onlineDot: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2.5,
    zIndex: 5,
  },
  statsRow: { flex: 1, flexDirection: 'row', justifyContent: 'space-around' },
  statItem: { alignItems: 'center' },
  statNum: { fontSize: 18, fontWeight: '700' },
  statLabel: { fontSize: 12, marginTop: 2 },
  displayName: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  bio: { fontSize: 14, lineHeight: 19, marginBottom: 4 },
  mutualText: { fontSize: 12, lineHeight: 17, marginBottom: 6 },
  actionRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  actionBtn: { flex: 1, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  actionBtnText: { fontSize: 14, fontWeight: '600' },
  actionBtnSmall: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  tabBar: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, marginTop: 4, alignItems: 'center' },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  viewModeToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'absolute',
    right: 8,
    gap: 2,
  },
  viewModeBtn: {
    padding: 6,
    borderRadius: 6,
  },
  emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  // Grid badge (bottom-left counts on each grid cell)
  gridBadgeRow: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    flexDirection: 'row',
    gap: 6,
  },
  gridBadgeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  gridBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
});
