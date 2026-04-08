import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Image,
  Dimensions, Platform, ActivityIndicator, RefreshControl, Modal,
  Animated, Share, FlatList, Pressable, Linking, TextInput,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import AvatarCircle from '../components/AvatarCircle';
import FeedComments from '../components/FeedComments';
import {
  IconArrowLeft, IconMessageSquare, IconPhone, IconSettings, IconGrid,
  IconHeart, IconHeartOutline, IconMessageCircle, IconShare, IconBookmark,
  IconBookmarkFilled, IconX, IconChevronLeft, IconChevronRight,
  IconPlay, IconMenu, IconTag, IconCopy, IconVideo, IconCamera, IconLink, IconImage,
} from '../components/Icons';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import { BASE_URL } from '../services/api';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const GRID_GAP = 1;
const GRID_COLS = 3;
const GRID_SIZE = (SCREEN_W - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
const ACCENT = '#0095f6'; // Instagram blue
const ACCENT_GREEN = '#25D366';
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

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 10000) return (n / 1000).toFixed(0) + 'K';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// ──────────────────────────────────────────────────────────────
// Followers / Following List Modal
// ──────────────────────────────────────────────────────────────
function FollowListModal({ visible, onClose, title, email, mode, colors, isDark, t, myEmail }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [followStates, setFollowStates] = useState({});
  const router = useRouter();

  useEffect(() => {
    if (!visible) return;
    setUsers([]);
    setPage(1);
    setLoading(true);
    loadPage(1);
  }, [visible, email, mode]);

  const loadPage = async (p) => {
    try {
      const fn = mode === 'followers' ? api.getFollowers : api.getFollowing;
      const r = await fn(email, p);
      if (r?.success && r.data) {
        const list = r.data.followers || r.data.following || [];
        setUsers(prev => p === 1 ? list : [...prev, ...list]);
        setTotal(r.data.total || 0);
        const states = {};
        list.forEach(u => { states[u.email] = !!u.is_following; });
        setFollowStates(prev => ({ ...prev, ...states }));
      }
    } catch {}
    setLoading(false);
  };

  const toggleFollow = async (targetEmail) => {
    const wasFollowing = followStates[targetEmail];
    setFollowStates(prev => ({ ...prev, [targetEmail]: !wasFollowing }));
    try {
      if (wasFollowing) {
        await api.unfollowUser(targetEmail);
      } else {
        await api.followUser(targetEmail);
      }
    } catch {
      setFollowStates(prev => ({ ...prev, [targetEmail]: wasFollowing }));
    }
  };

  const openProfile = (userEmail, userName) => {
    onClose();
    setTimeout(() => {
      router.push({ pathname: '/user-profile', params: { email: userEmail, name: userName || '' } });
    }, 200);
  };

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[flm.container, { backgroundColor: colors.background }]}>
        <View style={[flm.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={onClose} style={flm.closeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <IconX size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[flm.title, { color: colors.text }]}>{title}</Text>
          <View style={{ width: 40 }} />
        </View>
        {loading && users.length === 0 ? (
          <View style={flm.loadingWrap}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : (
          <FlatList
            data={users}
            keyExtractor={(item, i) => item.email || String(i)}
            renderItem={({ item }) => {
              const isMe = item.email === myEmail;
              const amFollowing = followStates[item.email];
              return (
                <TouchableOpacity style={flm.row} onPress={() => openProfile(item.email, item.name)} activeOpacity={0.7}>
                  <AvatarCircle email={item.email} name={item.name} size={44} />
                  <View style={flm.rowInfo}>
                    <Text style={[flm.rowName, { color: colors.text }]} numberOfLines={1}>{item.name || item.email?.split('@')[0]}</Text>
                    <Text style={[flm.rowEmail, { color: colors.textSecondary }]} numberOfLines={1}>{item.email}</Text>
                  </View>
                  {!isMe && (
                    <TouchableOpacity
                      style={[flm.followBtn, {
                        backgroundColor: amFollowing ? (isDark ? '#333' : '#efefef') : ACCENT,
                        borderWidth: amFollowing ? 1 : 0,
                        borderColor: isDark ? '#555' : '#dbdbdb',
                      }]}
                      onPress={() => toggleFollow(item.email)}
                    >
                      <Text style={[flm.followBtnText, { color: amFollowing ? colors.text : '#fff' }]}>
                        {amFollowing ? t('profile.following') : t('profile.follow')}
                      </Text>
                    </TouchableOpacity>
                  )}
                </TouchableOpacity>
              );
            }}
            onEndReached={() => {
              if (users.length < total && !loading) {
                const nextPage = page + 1;
                setPage(nextPage);
                loadPage(nextPage);
              }
            }}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={
              <View style={flm.emptyWrap}>
                <Text style={{ color: colors.textSecondary, fontSize: 15 }}>
                  {mode === 'followers' ? t('profile.noFollowersYet') || 'No followers yet' : t('profile.noFollowingYet') || 'Not following anyone'}
                </Text>
              </View>
            }
          />
        )}
      </View>
    </Modal>
  );
}

const flm = StyleSheet.create({
  container: { flex: 1, paddingTop: Platform.OS === 'ios' ? 50 : 0 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  closeBtn: { width: 40, alignItems: 'flex-start' },
  title: { fontSize: 16, fontWeight: '700', textAlign: 'center', flex: 1 },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  rowInfo: { flex: 1, marginLeft: 12 },
  rowName: { fontSize: 14, fontWeight: '600' },
  rowEmail: { fontSize: 12, marginTop: 1 },
  followBtn: { paddingHorizontal: 20, paddingVertical: 7, borderRadius: 8, minWidth: 90, alignItems: 'center' },
  followBtnText: { fontSize: 13, fontWeight: '600' },
  emptyWrap: { alignItems: 'center', paddingTop: 60 },
});


// ──────────────────────────────────────────────────────────────
// Post Viewer Modal (Full-screen post view)
// ──────────────────────────────────────────────────────────────
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
    Animated.spring(likeButtonScale, { toValue: 1, tension: 300, friction: 10, useNativeDriver: true }).start();
  }, [likeButtonScale]);

  const showHeartAnimation = useCallback(() => {
    heartScale.setValue(0);
    heartOpacity.setValue(1);
    Animated.sequence([
      Animated.spring(heartScale, { toValue: 1.15, tension: 250, friction: 6, useNativeDriver: true }),
      Animated.parallel([
        Animated.spring(heartScale, { toValue: 1, tension: 200, friction: 10, useNativeDriver: true }),
        Animated.timing(heartOpacity, { toValue: 0, duration: 500, delay: 300, useNativeDriver: true }),
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
    Animated.spring(bookmarkScale, { toValue: 1, tension: 300, friction: 10, useNativeDriver: true }).start();
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
        <TouchableOpacity style={ms.closeBtn} onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <IconX size={26} color="#fff" />
        </TouchableOpacity>
        <View style={ms.counterBadge}>
          <Text style={ms.counterText}>{currentIndex + 1} / {posts.length}</Text>
        </View>

        {currentIndex > 0 && (
          <TouchableOpacity style={[ms.navArrow, ms.navLeft]} onPress={navigatePrev}>
            <IconChevronLeft size={32} color="#fff" />
          </TouchableOpacity>
        )}
        {currentIndex < posts.length - 1 && (
          <TouchableOpacity style={[ms.navArrow, ms.navRight]} onPress={navigateNext}>
            <IconChevronRight size={32} color="#fff" />
          </TouchableOpacity>
        )}

        <ScrollView style={ms.scrollWrap} contentContainerStyle={ms.scrollContent} showsVerticalScrollIndicator={false} bounces={false}>
          <View style={ms.header}>
            <AvatarCircle email={post.author_email} name={post.author_name} size={34} />
            <View style={ms.headerInfo}>
              <Text style={ms.authorName} numberOfLines={1}>{authorDisplay}</Text>
              {post.location ? <Text style={ms.location} numberOfLines={1}>{post.location}</Text> : null}
            </View>
            <Text style={ms.headerTime}>{timeAgo(post.created_at, t)}</Text>
          </View>

          {mediaUrls.length > 0 && (
            <TouchableOpacity activeOpacity={1} onPress={handleDoubleTap} style={ms.mediaContainer}>
              {mediaUrls.length === 1 ? (
                post.media_type === 'video' ? (
                  <View style={[ms.mediaFrame, { width: cardWidth, maxWidth: '100%' }]}>
                    {isWeb ? (
                      <video
                        src={resolveMediaUrl(mediaUrls[0])}
                        style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }}
                        controls playsInline preload="auto"
                        poster={post.thumbnail_url ? resolveMediaUrl(post.thumbnail_url) : undefined}
                      />
                    ) : (
                      <View style={[ms.mediaFrame, { alignItems: 'center', justifyContent: 'center' }]}>
                        <Image source={{ uri: resolveMediaUrl(post.thumbnail_url || mediaUrls[0]) }} style={StyleSheet.absoluteFill} resizeMode="contain" />
                        <View style={ms.playButton}><IconPlay size={32} color="#fff" /></View>
                      </View>
                    )}
                  </View>
                ) : (
                  <Image source={{ uri: resolveMediaUrl(mediaUrls[0]) }} style={[ms.mediaFrame, { width: cardWidth, maxWidth: '100%' }]} resizeMode="contain" />
                )
              ) : (
                <View>
                  <ScrollView
                    ref={mediaScrollRef} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
                    onScroll={(e) => { setActiveMediaIdx(Math.round(e.nativeEvent.contentOffset.x / cardWidth)); }}
                    scrollEventThrottle={16} decelerationRate="fast" snapToInterval={cardWidth}
                  >
                    {mediaUrls.map((url, idx) => (
                      <Image key={idx} source={{ uri: resolveMediaUrl(url) }} style={[ms.mediaFrame, { width: cardWidth }]} resizeMode="contain" />
                    ))}
                  </ScrollView>
                  <View style={ms.mediaDots}>
                    {mediaUrls.map((_, idx) => (
                      <View key={idx} style={[ms.dot, {
                        width: idx === activeMediaIdx ? 8 : 6, height: idx === activeMediaIdx ? 8 : 6,
                        borderRadius: idx === activeMediaIdx ? 4 : 3, opacity: idx === activeMediaIdx ? 1 : 0.5,
                        backgroundColor: idx === activeMediaIdx ? ACCENT : '#fff',
                      }]} />
                    ))}
                  </View>
                </View>
              )}
              <Animated.View pointerEvents="none" style={[ms.heartOverlay, { opacity: heartOpacity, transform: [{ scale: heartScale }] }]}>
                <IconHeart size={90} color="#fff" />
              </Animated.View>
            </TouchableOpacity>
          )}

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

          {likeCount > 0 && (
            <View style={ms.likeRow}><Text style={ms.likeText}>{formatLikeCount(likeCount, t)}</Text></View>
          )}
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
          <Text style={ms.timestamp}>
            {new Date(
              (post.created_at || '').endsWith('Z') || (post.created_at || '').includes('+')
                ? post.created_at : (post.created_at || '') + 'Z'
            ).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
          </Text>
        </ScrollView>
      </View>
      <FeedComments
        visible={commentsVisible} post={post} colors={colors} isDark={isDark} t={t} user={user}
        onClose={() => setCommentsVisible(false)} onCommentCountChange={handleCommentCountChange}
      />
    </Modal>
  );
}

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
    backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', marginTop: -22,
  },
  navLeft: { left: 8 },
  navRight: { right: 8 },
  scrollWrap: { flex: 1, marginTop: Platform.OS === 'ios' ? 90 : 50 },
  scrollContent: { paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10 },
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


// ──────────────────────────────────────────────────────────────
// Edit Profile Modal (Instagram-style)
// ──────────────────────────────────────────────────────────────
function EditProfileModal({ visible, onClose, profileData, colors, isDark, t, onSaved }) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [website, setWebsite] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState('');
  const [birthday, setBirthday] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible && profileData) {
      setName(profileData.display_name || profileData.name || '');
      setUsername(profileData.username || '');
      setBio(profileData.bio || profileData.about || '');
      setWebsite(profileData.website || '');
      setPhone(profileData.phone || '');
      setGender(profileData.gender || '');
      setBirthday(profileData.birthday || '');
    }
  }, [visible, profileData]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = { display_name: name, name, bio, website, phone, gender, birthday };
      if (username) data.username = username;
      const r = await api.updateProfile(data);
      if (r?.success) {
        onSaved?.(data);
        onClose();
      }
    } catch {}
    setSaving(false);
  };

  const fields = [
    { label: t('profile.name') || 'Name', value: name, onChange: setName, placeholder: t('profile.namePlaceholder') || 'Your name' },
    { label: t('profile.username') || 'Username', value: username, onChange: setUsername, placeholder: 'username' },
    { label: t('profile.bioLabel') || 'Bio', value: bio, onChange: setBio, placeholder: t('profile.bioPlaceholder') || 'Tell about yourself...', multiline: true, maxLength: 150 },
    { label: t('profile.websiteLabel') || 'Website', value: website, onChange: setWebsite, placeholder: 'www.example.com', keyboardType: 'url' },
    { label: t('profile.phone') || 'Phone', value: phone, onChange: setPhone, placeholder: t('profile.phonePlaceholder') || '+1 (555) 123-4567', keyboardType: 'phone-pad' },
    { label: t('profile.genderLabel') || 'Gender', value: gender, onChange: setGender, placeholder: t('profile.genderPlaceholder') || 'Prefer not to say' },
    { label: t('profile.birthday') || 'Birthday', value: birthday, onChange: setBirthday, placeholder: t('profile.birthdayPlaceholder') || 'MM/DD/YYYY' },
  ];

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[epm.container, { backgroundColor: colors.background }]}>
        <View style={[epm.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={{ color: colors.text, fontSize: 16 }}>{t('common.cancel') || 'Cancel'}</Text>
          </TouchableOpacity>
          <Text style={[epm.title, { color: colors.text }]}>{t('profile.editProfile') || 'Edit profile'}</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving}>
            {saving ? (
              <ActivityIndicator size="small" color={ACCENT} />
            ) : (
              <Text style={{ color: ACCENT, fontSize: 16, fontWeight: '600' }}>{t('profile.save') || 'Done'}</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView style={epm.body} contentContainerStyle={epm.bodyContent} keyboardShouldPersistTaps="handled">
          {/* Profile photo change button */}
          <TouchableOpacity style={epm.avatarChange} activeOpacity={0.7}>
            <AvatarCircle email={profileData?.email} name={name} size={76} />
            <Text style={[epm.changePhotoText, { color: ACCENT }]}>{t('profile.changePhoto') || 'Change profile photo'}</Text>
          </TouchableOpacity>

          {/* Form fields */}
          {fields.map((f, i) => (
            <View key={i} style={[epm.fieldRow, { borderBottomColor: colors.border }]}>
              <Text style={[epm.fieldLabel, { color: colors.textSecondary }]}>{f.label}</Text>
              <TextInput
                style={[epm.fieldInput, { color: colors.text }, f.multiline && { minHeight: 60, textAlignVertical: 'top' }]}
                value={f.value}
                onChangeText={f.onChange}
                placeholder={f.placeholder}
                placeholderTextColor={colors.textSecondary + '80'}
                multiline={f.multiline}
                maxLength={f.maxLength}
                keyboardType={f.keyboardType || 'default'}
                autoCapitalize={f.label === 'Username' ? 'none' : 'sentences'}
              />
            </View>
          ))}
          {bio ? (
            <Text style={[epm.charCount, { color: colors.textSecondary }]}>{bio.length}/150</Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const epm = StyleSheet.create({
  container: { flex: 1, paddingTop: Platform.OS === 'ios' ? 50 : 0 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 16, fontWeight: '700' },
  body: { flex: 1 },
  bodyContent: { paddingBottom: 40 },
  avatarChange: { alignItems: 'center', paddingVertical: 20 },
  changePhotoText: { fontSize: 14, fontWeight: '600', marginTop: 10 },
  fieldRow: {
    flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16,
    paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fieldLabel: { width: 100, fontSize: 14, fontWeight: '400', paddingTop: 4 },
  fieldInput: {
    flex: 1, fontSize: 15, paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  charCount: { textAlign: 'right', paddingRight: 16, paddingTop: 4, fontSize: 12 },
});

// ──────────────────────────────────────────────────────────────
// Story Highlights Row
// ──────────────────────────────────────────────────────────────
function HighlightsRow({ highlights, colors, isDark, isOwnProfile, t }) {
  // For now use status stories as highlights. Show placeholder circles.
  const items = highlights && highlights.length > 0 ? highlights : (isOwnProfile ? [{ id: 'new', isNew: true }] : []);
  if (items.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={hlStyles.container}
      style={hlStyles.scroll}
    >
      {items.map((item, i) => (
        <TouchableOpacity key={item.id || i} style={hlStyles.item} activeOpacity={0.7}>
          <View style={[hlStyles.circle, {
            borderColor: item.isNew ? (isDark ? '#555' : '#c7c7cc') : '#e6683c',
            backgroundColor: isDark ? '#222' : '#f7f7f7',
          }]}>
            {item.isNew ? (
              <Text style={{ fontSize: 28, color: isDark ? '#777' : '#c7c7cc', fontWeight: '200' }}>+</Text>
            ) : item.cover ? (
              <Image source={{ uri: resolveMediaUrl(item.cover) }} style={hlStyles.coverImg} />
            ) : (
              <View style={[hlStyles.placeholder, { backgroundColor: isDark ? '#333' : '#e5e5ea' }]} />
            )}
          </View>
          <Text style={[hlStyles.label, { color: colors.text }]} numberOfLines={1}>
            {item.isNew ? (t('profile.new') || 'New') : (item.title || '')}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const hlStyles = StyleSheet.create({
  scroll: { marginTop: 4, marginBottom: 8 },
  container: { paddingHorizontal: 12, gap: 12 },
  item: { alignItems: 'center', width: 68 },
  circle: {
    width: 64, height: 64, borderRadius: 32, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  coverImg: { width: 58, height: 58, borderRadius: 29 },
  placeholder: { width: 58, height: 58, borderRadius: 29 },
  label: { fontSize: 11, marginTop: 4, textAlign: 'center' },
});

// ──────────────────────────────────────────────────────────────
// Cover Photo Component
// ──────────────────────────────────────────────────────────────
function CoverPhoto({ profileData, colors, isDark, isOwnProfile }) {
  const coverUrl = profileData?.cover_photo;
  const COVER_H = 180;

  return (
    <View style={{ height: COVER_H, backgroundColor: isDark ? '#1a1a2e' : '#e3f2fd', overflow: 'hidden' }}>
      {coverUrl ? (
        <Image source={{ uri: resolveMediaUrl(coverUrl) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
      ) : (
        <View style={{
          width: '100%', height: '100%',
          ...Platform.select({
            web: { backgroundImage: isDark
              ? 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)'
              : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
            default: { backgroundColor: isDark ? '#1a1a2e' : '#667eea' },
          }),
        }} />
      )}
      {isOwnProfile && (
        <TouchableOpacity style={{
          position: 'absolute', bottom: 10, right: 10, width: 32, height: 32, borderRadius: 16,
          backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
        }} activeOpacity={0.7}>
          <IconCamera size={16} color="#fff" />
        </TouchableOpacity>
      )}
    </View>
  );
}


// ──────────────────────────────────────────────────────────────
// Main Profile Screen
// ──────────────────────────────────────────────────────────────
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
  const [hasActiveStatus, setHasActiveStatus] = useState(false);
  const [isOnline, setIsOnline] = useState(false);
  const [mutualFollowers, setMutualFollowers] = useState([]);
  const [viewerPostIdx, setViewerPostIdx] = useState(-1);
  const [followListMode, setFollowListMode] = useState(null); // 'followers' | 'following' | null
  const [editProfileVisible, setEditProfileVisible] = useState(false);
  const [highlights, setHighlights] = useState([]);
  const viewerVisible = viewerPostIdx >= 0;

  // Animated header opacity for scroll
  const scrollY = useRef(new Animated.Value(0)).current;

  const displayName = profileData?.display_name || profileData?.name || name || email?.split('@')[0] || '?';
  const username = email?.split('@')[0] || '';
  const bio = profileData?.bio || profileData?.about || '';

  const filteredPosts = useMemo(() => {
    if (tab === 'reels') return posts.filter(p => p.media_type === 'video' || (p.media_urls && JSON.stringify(p.media_urls).match(/\.(mp4|mov|webm)/i)));
    if (tab === 'tagged') return []; // Placeholder - no tagged posts API yet
    return posts;
  }, [posts, tab]);

  const aliveRef = useRef(true);
  useEffect(() => { return () => { aliveRef.current = false; }; }, []);

  const loadProfile = useCallback(async () => {
    // Show cached profile instantly
    try { const c = await getCached('user_profile_' + email); if (c && aliveRef.current) { setProfileData(c.profile); setStats(c.stats || {}); setLoading(false); } } catch {}
    if (aliveRef.current) setLoading(true);
    try {
      const [profileRes, postsRes, mutualRes] = await Promise.all([
        api.getPublicProfile(email).catch(() => null),
        api.feedUserPosts(email).catch(() => ({ data: [] })),
        !isOwnProfile ? api.getMutualFollowers(email).catch(() => null) : Promise.resolve(null),
      ]);

      if (!aliveRef.current) return;

      if (profileRes?.success && profileRes.data) {
        setProfileData(profileRes.data);
        setStats({
          posts: profileRes.data.post_count || 0,
          followers: profileRes.data.followers_count || 0,
          following: profileRes.data.following_count || 0,
        });
        setIsOnline(!!profileRes.data.is_online);
        setIsFollowing(!!profileRes.data.is_following);
      }

      if (postsRes?.data) {
        const postList = Array.isArray(postsRes.data) ? postsRes.data : (postsRes.data.posts || []);
        setPosts(postList);
        if (!profileRes?.data?.post_count) {
          setStats(prev => ({ ...prev, posts: postList.length }));
        }
      }

      if (mutualRes?.success && mutualRes.data) {
        const mutuals = Array.isArray(mutualRes.data) ? mutualRes.data : (mutualRes.data.mutuals || []);
        setMutualFollowers(mutuals);
      }
      // Save to cache
      try { setCache('user_profile_' + email, { profile: profileRes?.data, stats: { posts: profileRes?.data?.post_count || 0, followers: profileRes?.data?.followers_count || 0, following: profileRes?.data?.following_count || 0 } }, 2592000000); } catch {}
    } catch {}
    if (aliveRef.current) setLoading(false);
  }, [email, isOwnProfile]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  const handleFollow = useCallback(async () => {
    setFollowLoading(true);
    try {
      if (isFollowing) {
        const r = await api.unfollowUser(email);
        if (r?.success) {
          setIsFollowing(false);
          setStats(prev => ({ ...prev, followers: Math.max(0, prev.followers - 1) }));
        }
      } else {
        const r = await api.followUser(email);
        if (r?.success) {
          setIsFollowing(true);
          setStats(prev => ({ ...prev, followers: prev.followers + 1 }));
        }
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

  const handleShareProfile = useCallback(async () => {
    const url = `${BASE_URL}/profile/${username}`;
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: displayName, url }); } catch {}
    } else if (Platform.OS !== 'web') {
      try { await Share.share({ message: url }); } catch {}
    }
  }, [username, displayName]);

  const handleProfileSaved = useCallback((data) => {
    setProfileData(prev => ({ ...prev, ...data }));
  }, []);

  const handlePostUpdated = useCallback((postId, updates) => {
    setPosts(prev => prev.map(p => p.id === postId ? { ...p, ...updates } : p));
  }, []);

  const openPostViewer = useCallback((index) => {
    setViewerPostIdx(index);
  }, []);

  const mutualFollowersText = useMemo(() => {
    if (mutualFollowers.length === 0 || isOwnProfile) return null;
    const names = mutualFollowers.map(f => f.name || f.display_name || f.email?.split('@')[0] || '?');
    if (names.length === 1) {
      return (t('profile.followedByOne') || 'Followed by {name}').replace('{name}', names[0]);
    }
    if (names.length === 2) {
      return (t('profile.followedByTwo') || 'Followed by {name1} and {name2}')
        .replace('{name1}', names[0]).replace('{name2}', names[1]);
    }
    const others = mutualFollowers.length - 2;
    return (t('profile.followedByMany') || 'Followed by {name1}, {name2} and {count} others')
      .replace('{name1}', names[0]).replace('{name2}', names[1]).replace('{count}', others);
  }, [mutualFollowers, isOwnProfile, t]);

  // ─── Render ────────────────────────────────────────────────
  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* ─── Top Navigation Bar ─── */}
      <View style={[s.navBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.navBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={s.navTitleWrap}>
          <Text style={[s.navUsername, { color: colors.text }]} numberOfLines={1}>{username}</Text>
          {profileData?.is_private && (
            <View style={s.verifiedBadge}>
              <Text style={{ fontSize: 12 }}>&#10003;</Text>
            </View>
          )}
        </View>
        <View style={s.navRight}>
          {isOwnProfile ? (
            <TouchableOpacity onPress={() => router.push('/settings')} style={s.navBtn}>
              <IconSettings size={22} color={colors.text} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={handleShareProfile} style={s.navBtn}>
              <IconMenu size={22} color={colors.text} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadProfile} tintColor={ACCENT} />}
        showsVerticalScrollIndicator={false}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        scrollEventThrottle={16}
      >
        {/* ─── Cover Photo ─── */}
        <CoverPhoto profileData={profileData} colors={colors} isDark={isDark} isOwnProfile={isOwnProfile} />

        {/* ─── Profile Header ─── */}
        <View style={s.profileHeader}>
          {/* Avatar + Stats Row */}
          <View style={[s.avatarStatsRow, { marginTop: -40 }]}>
            <View style={s.avatarWrap}>
              <View style={[
                s.storyRing,
                hasActiveStatus && s.storyRingActive,
                !hasActiveStatus && { borderColor: 'transparent' },
                { backgroundColor: colors.background, borderRadius: 50 },
              ]}>
                <AvatarCircle email={email} name={displayName} size={86} />
              </View>
              {/* Online indicator */}
              <View style={[
                s.onlineDot,
                {
                  backgroundColor: isOnline ? '#44b700' : 'transparent',
                  borderColor: isOnline ? colors.background : 'transparent',
                },
              ]} />
            </View>

            {/* Stats */}
            <View style={s.statsContainer}>
              <TouchableOpacity style={s.statItem} activeOpacity={0.6}>
                <Text style={[s.statNum, { color: colors.text }]}>{formatCount(stats.posts)}</Text>
                <Text style={[s.statLabel, { color: colors.text }]}>{t('profile.posts') || 'Posts'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.statItem} activeOpacity={0.6} onPress={() => setFollowListMode('followers')}>
                <Text style={[s.statNum, { color: colors.text }]}>{formatCount(stats.followers)}</Text>
                <Text style={[s.statLabel, { color: colors.text }]}>{t('profile.followers') || 'Followers'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.statItem} activeOpacity={0.6} onPress={() => setFollowListMode('following')}>
                <Text style={[s.statNum, { color: colors.text }]}>{formatCount(stats.following)}</Text>
                <Text style={[s.statLabel, { color: colors.text }]}>{t('profile.following') || 'Following'}</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Name + Bio */}
          <View style={s.bioSection}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[s.displayName, { color: colors.text }]}>{displayName}</Text>
              {profileData?.is_private && (
                <View style={s.verifiedInline}>
                  <Text style={{ fontSize: 10, color: '#fff', fontWeight: '700' }}>&#10003;</Text>
                </View>
              )}
            </View>
            {profileData?.category ? (
              <Text style={[s.categoryText, { color: colors.textSecondary }]}>{profileData.category}</Text>
            ) : null}
            {bio ? <Text style={[s.bioText, { color: colors.text }]}>{bio}</Text> : null}
            {profileData?.website ? (
              <TouchableOpacity onPress={() => {
                try { Linking.openURL(profileData.website.startsWith('http') ? profileData.website : 'https://' + profileData.website); } catch {}
              }} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <IconLink size={13} color="#3b82f6" />
                <Text style={s.websiteText}>{profileData.website.replace(/^https?:\/\//, '')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Mutual followers */}
          {mutualFollowersText && (
            <TouchableOpacity style={s.mutualRow} onPress={() => setFollowListMode('followers')}>
              <View style={s.mutualAvatars}>
                {mutualFollowers.slice(0, 3).map((f, i) => (
                  <View key={f.email} style={[s.mutualAvatarWrap, { marginLeft: i > 0 ? -8 : 0, zIndex: 3 - i }]}>
                    <AvatarCircle email={f.email} name={f.name} size={18} />
                  </View>
                ))}
              </View>
              <Text style={[s.mutualText, { color: colors.textSecondary }]} numberOfLines={2}>
                {mutualFollowersText}
              </Text>
            </TouchableOpacity>
          )}

          {/* ─── Action Buttons ─── */}
          <View style={s.actionRow}>
            {isOwnProfile ? (
              <>
                <TouchableOpacity
                  style={[s.actionBtnPrimary, { backgroundColor: isDark ? '#363636' : '#efefef' }]}
                  onPress={() => setEditProfileVisible(true)}
                  activeOpacity={0.7}
                >
                  <Text style={[s.actionBtnPrimaryText, { color: colors.text }]}>{t('profile.editProfile') || 'Edit profile'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.actionBtnPrimary, { backgroundColor: isDark ? '#363636' : '#efefef' }]}
                  onPress={handleShareProfile}
                  activeOpacity={0.7}
                >
                  <Text style={[s.actionBtnPrimaryText, { color: colors.text }]}>{t('profile.shareProfile') || 'Share profile'}</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity
                  style={[
                    s.actionBtnPrimary,
                    {
                      backgroundColor: isFollowing ? (isDark ? '#363636' : '#efefef') : ACCENT,
                      borderWidth: isFollowing ? 1 : 0,
                      borderColor: isDark ? '#555' : '#dbdbdb',
                    },
                  ]}
                  onPress={handleFollow}
                  disabled={followLoading}
                  activeOpacity={0.7}
                >
                  {followLoading ? (
                    <ActivityIndicator size="small" color={isFollowing ? colors.text : '#fff'} />
                  ) : (
                    <Text style={[s.actionBtnPrimaryText, { color: isFollowing ? colors.text : '#fff', fontWeight: '600' }]}>
                      {isFollowing ? (t('profile.following') || 'Following') : (t('profile.follow') || 'Follow')}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.actionBtnSecondary, { backgroundColor: isDark ? '#363636' : '#efefef' }]}
                  onPress={handleMessage}
                  activeOpacity={0.7}
                >
                  <Text style={[s.actionBtnPrimaryText, { color: colors.text }]}>{t('profile.message') || 'Message'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.actionBtnIcon, { backgroundColor: isDark ? '#363636' : '#efefef' }]}
                  onPress={handleCall}
                  activeOpacity={0.7}
                >
                  <IconPhone size={16} color={colors.text} />
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        {/* ─── Story Highlights ─── */}
        <HighlightsRow highlights={highlights} colors={colors} isDark={isDark} isOwnProfile={isOwnProfile} t={t} />

        {/* ─── Tab Bar ─── */}
        <View style={[s.tabBar, { borderTopColor: colors.border, borderBottomColor: colors.border }]}>
          <TouchableOpacity
            style={[s.tab, tab === 'posts' && { borderBottomColor: colors.text, borderBottomWidth: 1 }]}
            onPress={() => setTab('posts')}
            accessibilityLabel={t('profile.grid') || 'Grid'}
          >
            <IconGrid size={24} color={tab === 'posts' ? colors.text : (isDark ? '#8e8e8e' : '#8e8e8e')} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tab, tab === 'reels' && { borderBottomColor: colors.text, borderBottomWidth: 1 }]}
            onPress={() => setTab('reels')}
            accessibilityLabel={t('profile.videos') || 'Videos'}
          >
            <IconVideo size={24} color={tab === 'reels' ? colors.text : '#8e8e8e'} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tab, tab === 'tagged' && { borderBottomColor: colors.text, borderBottomWidth: 1 }]}
            onPress={() => setTab('tagged')}
            accessibilityLabel={t('profile.tagged') || 'Tagged'}
          >
            <IconTag size={24} color={tab === 'tagged' ? colors.text : '#8e8e8e'} />
          </TouchableOpacity>
        </View>

        {/* ─── Posts Grid ─── */}
        {loading && posts.length === 0 ? (
          <View style={s.loadingWrap}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : filteredPosts.length === 0 ? (
          <View style={s.emptyState}>
            {tab === 'posts' && (
              <>
                <View style={[s.emptyIcon, { borderColor: colors.textSecondary }]}>
                  <IconGrid size={44} color={colors.textSecondary} />
                </View>
                <Text style={[s.emptyTitle, { color: colors.text }]}>
                  {isOwnProfile ? (t('profile.noPostsYet') || 'No posts yet') : (t('feed.noUserPosts') || 'No posts yet')}
                </Text>
              </>
            )}
            {tab === 'reels' && (
              <>
                <View style={[s.emptyIcon, { borderColor: colors.textSecondary }]}>
                  <IconVideo size={44} color={colors.textSecondary} />
                </View>
                <Text style={[s.emptyTitle, { color: colors.text }]}>{t('profile.noVideosYet') || 'No videos yet'}</Text>
              </>
            )}
            {tab === 'tagged' && (
              <>
                <View style={[s.emptyIcon, { borderColor: colors.textSecondary }]}>
                  <IconTag size={44} color={colors.textSecondary} />
                </View>
                <Text style={[s.emptyTitle, { color: colors.text }]}>{t('profile.noTaggedYet') || 'No tagged posts'}</Text>
              </>
            )}
          </View>
        ) : (
          <View style={s.grid}>
            {filteredPosts.map((post, i) => {
              const mediaUrls = parseMediaUrls(post.media_urls);
              const mediaUrl = post.thumbnail_url || mediaUrls[0];
              if (!mediaUrl && !post.caption) return null;
              const fullUrl = mediaUrl ? resolveMediaUrl(mediaUrl) : null;
              const isVideo = post.media_type === 'video';
              const isMulti = mediaUrls.length > 1;

              return (
                <TouchableOpacity
                  key={post.id || i}
                  style={[s.gridItem, {
                    width: GRID_SIZE, height: GRID_SIZE,
                    marginRight: (i % GRID_COLS) < (GRID_COLS - 1) ? GRID_GAP : 0,
                    marginBottom: GRID_GAP,
                  }]}
                  activeOpacity={0.85}
                  onPress={() => openPostViewer(i)}
                >
                  {fullUrl ? (
                    <Image source={{ uri: fullUrl }} style={s.gridImage} resizeMode="cover" />
                  ) : (
                    <View style={[s.gridImage, { backgroundColor: isDark ? '#222' : '#f0f0f0', alignItems: 'center', justifyContent: 'center' }]}>
                      <Text style={{ color: colors.textSecondary, fontSize: 12, padding: 6, textAlign: 'center' }} numberOfLines={3}>
                        {post.caption}
                      </Text>
                    </View>
                  )}
                  {/* Video play icon overlay */}
                  {isVideo && (
                    <View style={s.gridOverlayIcon}>
                      <IconPlay size={18} color="#fff" />
                    </View>
                  )}
                  {/* Multi-image layers icon overlay */}
                  {isMulti && !isVideo && (
                    <View style={s.gridOverlayIcon}>
                      <IconCopy size={16} color="#fff" />
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Bottom spacing */}
        <View style={{ height: 40 + insets.bottom }} />
      </ScrollView>

      {/* Post Viewer Modal */}
      <PostViewerModal
        visible={viewerVisible}
        posts={filteredPosts}
        initialIndex={viewerPostIdx}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setViewerPostIdx(-1)}
        onPostUpdated={handlePostUpdated}
      />

      {/* Followers / Following List Modal */}
      <FollowListModal
        visible={followListMode !== null}
        onClose={() => setFollowListMode(null)}
        title={followListMode === 'followers'
          ? (t('profile.followersTitle') || 'Followers')
          : (t('profile.followingTitle') || 'Following')
        }
        email={email}
        mode={followListMode || 'followers'}
        colors={colors}
        isDark={isDark}
        t={t}
        myEmail={user?.email}
      />

      {/* Edit Profile Modal */}
      <EditProfileModal
        visible={editProfileVisible}
        onClose={() => setEditProfileVisible(false)}
        profileData={{ ...profileData, email }}
        colors={colors}
        isDark={isDark}
        t={t}
        onSaved={handleProfileSaved}
      />
    </View>
  );
}


// ──────────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  container: {
    flex: 1,
  },

  // ─── Nav Bar ───
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    height: 44,
    borderBottomWidth: 0,
  },
  navBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navTitleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  navUsername: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  verifiedBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navRight: {
    width: 44,
    alignItems: 'center',
  },

  // ─── Profile Header ───
  profileHeader: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
  },
  avatarStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  avatarWrap: {
    marginRight: 28,
    position: 'relative',
  },
  storyRing: {
    padding: 3,
    borderRadius: 50,
    borderWidth: 2.5,
    borderColor: 'transparent',
  },
  storyRingActive: {
    ...Platform.select({
      web: {
        backgroundImage: 'linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)',
        borderColor: 'transparent',
        boxShadow: 'inset 0 0 0 2px #fff',
      },
      default: {
        borderColor: '#e6683c',
      },
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
  statsContainer: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
    minWidth: 60,
  },
  statNum: {
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 21,
  },
  statLabel: {
    fontSize: 13,
    fontWeight: '400',
    marginTop: 1,
  },

  // ─── Bio ───
  bioSection: {
    marginBottom: 8,
  },
  displayName: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  verifiedInline: {
    width: 16, height: 16, borderRadius: 8, backgroundColor: '#3b82f6',
    alignItems: 'center', justifyContent: 'center',
  },
  categoryText: {
    fontSize: 13,
    marginTop: 1,
  },
  bioText: {
    fontSize: 14,
    lineHeight: 19,
    marginTop: 3,
  },
  websiteText: {
    fontSize: 14,
    color: '#3b82f6',
    fontWeight: '500',
    marginTop: 2,
  },

  // ─── Mutual ───
  mutualRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    marginTop: 4,
  },
  mutualAvatars: {
    flexDirection: 'row',
    marginRight: 6,
  },
  mutualAvatarWrap: {
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#fff',
    overflow: 'hidden',
  },
  mutualText: {
    fontSize: 12,
    lineHeight: 16,
    flex: 1,
  },

  // ─── Action Buttons ───
  actionRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 10,
    marginBottom: 4,
  },
  actionBtnPrimary: {
    flex: 1,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnPrimaryText: {
    fontSize: 13,
    fontWeight: '600',
  },
  actionBtnSecondary: {
    flex: 1,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnIcon: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ─── Tab Bar ───
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'transparent',
  },

  // ─── Grid ───
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  gridItem: {
    position: 'relative',
    overflow: 'hidden',
  },
  gridImage: {
    width: '100%',
    height: '100%',
  },
  gridOverlayIcon: {
    position: 'absolute',
    top: 6,
    right: 6,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.8, shadowRadius: 2 },
      android: { elevation: 3 },
      web: { textShadow: '0 1px 4px rgba(0,0,0,0.7)' },
    }),
  },

  // ─── Empty State ───
  loadingWrap: {
    paddingVertical: 60,
    alignItems: 'center',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 40,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 8,
  },
});
