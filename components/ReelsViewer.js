import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, Dimensions,
  Animated, Platform, Share, TextInput, Modal, KeyboardAvoidingView,
  ActivityIndicator, Pressable, ScrollView, Image,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import {
  IconHeart, IconHeartOutline, IconMessageCircle, IconShare,
  IconBookmark, IconBookmarkFilled, IconMusic, IconPlay, IconPause,
  IconX, IconSend, IconChevronDown,
} from './Icons';
import * as api from '../services/api';

let useVideoPlayer = null;
let VideoView = null;
if (Platform.OS !== 'web') {
  try {
    const expoVideo = require('expo-video');
    useVideoPlayer = expoVideo.useVideoPlayer;
    VideoView = expoVideo.VideoView;
  } catch {}
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Native video player using expo-video (SDK 55+)
// Only rendered when VideoView is available (native only, never on web)
const NativeVideoPlayer = useVideoPlayer && VideoView ? function NativeVideoPlayerInner({ videoUrl, isActive, paused }) {
  const player = useVideoPlayer(videoUrl, p => {
    p.loop = true;
    p.muted = false;
  });

  useEffect(() => {
    if (!player) return;
    if (isActive && !paused) {
      player.play();
    } else {
      player.pause();
    }
  }, [isActive, paused, player]);

  return (
    <VideoView
      player={player}
      style={{ width: '100%', height: '100%' }}
      contentFit="cover"
      nativeControls={false}
    />
  );
} : () => null;
const ACCENT = '#25D366';
const DOUBLE_TAP_DELAY = 300;
const BASE_URL = 'https://chatyy.com.br';
const isWeb = Platform.OS === 'web';
const useNative = Platform.OS !== 'web';

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

function formatCount(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
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
  return new Date(str).toLocaleDateString();
}

// ── Comments Bottom Sheet ──
function CommentsSheet({ visible, post, colors, isDark, t, user, onClose }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible && post) {
      loadComments();
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: useNative,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: SCREEN_HEIGHT,
        duration: 250,
        useNativeDriver: useNative,
      }).start();
    }
  }, [visible, post]);

  const loadComments = async () => {
    if (!post) return;
    setLoading(true);
    try {
      const r = await api.feedComments(post.id);
      if (r.success && r.data) {
        setComments(Array.isArray(r.data.comments) ? r.data.comments : (Array.isArray(r.data) ? r.data : []));
      }
    } catch {} finally { setLoading(false); }
  };

  const sendComment = async () => {
    if (!text.trim() || sending || !post) return;
    setSending(true);
    try {
      const r = await api.feedComment(post.id, text.trim());
      if (r.success) {
        setText('');
        loadComments();
      }
    } catch {} finally { setSending(false); }
  };

  if (!visible) return null;

  const sheetBg = isDark ? '#1a1a2e' : '#ffffff';

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Animated.View
          style={[styles.sheetContainer, {
            backgroundColor: sheetBg,
            transform: [{ translateY: slideAnim }],
          }]}
        >
          <Pressable onPress={() => {}}>
            {/* Handle bar */}
            <View style={styles.sheetHandle}>
              <View style={[styles.sheetHandleBar, { backgroundColor: isDark ? '#444' : '#ccc' }]} />
            </View>
            <View style={[styles.sheetHeader, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }]}>
              <Text style={[styles.sheetTitle, { color: colors.text }]}>
                {t('feed.comments') || 'Comments'}
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <IconX size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {loading ? (
              <View style={styles.sheetLoading}>
                <ActivityIndicator size="small" color={ACCENT} />
              </View>
            ) : comments.length === 0 ? (
              <View style={styles.sheetEmpty}>
                <Text style={[styles.sheetEmptyText, { color: colors.textSecondary }]}>
                  {t('feed.noComments') || 'No comments yet'}
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.sheetList} showsVerticalScrollIndicator={false}>
                {comments.map((c, idx) => (
                  <View key={c.id || idx} style={styles.commentRow}>
                    <AvatarCircle email={c.author_email} name={c.author_name} size={32} />
                    <View style={styles.commentContent}>
                      <Text style={[styles.commentAuthor, { color: colors.text }]}>
                        {c.author_name || c.author_email?.split('@')[0] || '?'}
                        <Text style={[styles.commentText, { color: colors.text }]}>
                          {'  '}{c.content}
                        </Text>
                      </Text>
                      <Text style={[styles.commentTime, { color: colors.textTertiary }]}>
                        {timeAgo(c.created_at, t)}
                      </Text>
                    </View>
                  </View>
                ))}
                <View style={{ height: 20 }} />
              </ScrollView>
            )}

            {/* Input */}
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <View style={[styles.sheetInput, {
                borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                backgroundColor: sheetBg,
              }]}>
                <AvatarCircle email={user?.email} name={user?.name} size={30} />
                <TextInput
                  style={[styles.sheetTextInput, {
                    color: colors.text,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                  }]}
                  placeholder={t('feed.writeComment') || 'Add a comment...'}
                  placeholderTextColor={colors.textTertiary}
                  value={text}
                  onChangeText={setText}
                  returnKeyType="send"
                  onSubmitEditing={sendComment}
                />
                <TouchableOpacity
                  onPress={sendComment}
                  disabled={!text.trim() || sending}
                  style={{ opacity: text.trim() ? 1 : 0.4 }}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={ACCENT} />
                  ) : (
                    <IconSend size={22} color={ACCENT} />
                  )}
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// ── Single Reel Item ──
const ReelItem = memo(function ReelItem({ reel, isActive, colors, isDark, t, user, containerHeight, onOpenComments }) {
  const [paused, setPaused] = useState(false);
  const [liked, setLiked] = useState(!!reel.user_liked);
  const [likeCount, setLikeCount] = useState(Number(reel.like_count) || 0);
  const [bookmarked, setBookmarked] = useState(!!reel.user_bookmarked);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [progress, setProgress] = useState(0);

  const videoRef = useRef(null);
  const lastTapRef = useRef(0);
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;
  const likeScale = useRef(new Animated.Value(1)).current;
  const bookmarkAnim = useRef(new Animated.Value(1)).current;
  const progressIntervalRef = useRef(null);

  const mediaUrls = parseMediaUrls(reel.media_urls);
  const videoUrl = resolveMediaUrl(mediaUrls[0]);
  const authorDisplay = reel.author_name || reel.author_email?.split('@')[0] || '?';
  const commentCount = Number(reel.comment_count) || 0;

  // Sync with prop changes
  useEffect(() => {
    setLiked(!!reel.user_liked);
    setLikeCount(Number(reel.like_count) || 0);
    setBookmarked(!!reel.user_bookmarked);
  }, [reel.user_liked, reel.like_count, reel.user_bookmarked]);

  // Auto-play/pause based on active state (web)
  useEffect(() => {
    if (!isWeb || !videoRef.current) return;
    if (isActive && !paused) {
      videoRef.current.play().catch(() => {});
    } else {
      videoRef.current.pause();
    }
  }, [isActive, paused]);

  // Progress tracking (web)
  useEffect(() => {
    if (!isWeb) return;
    if (isActive) {
      progressIntervalRef.current = setInterval(() => {
        if (videoRef.current && videoRef.current.duration) {
          setProgress(videoRef.current.currentTime / videoRef.current.duration);
        }
      }, 200);
    } else {
      setProgress(0);
    }
    return () => {
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };
  }, [isActive]);

  // Reset paused state when becoming active
  useEffect(() => {
    if (isActive) setPaused(false);
  }, [isActive]);

  const togglePause = useCallback(() => {
    if (isWeb) {
      if (!videoRef.current) return;
      if (videoRef.current.paused) {
        videoRef.current.play().catch(() => {});
        setPaused(false);
      } else {
        videoRef.current.pause();
        setPaused(true);
      }
    } else {
      // Native: expo-av uses shouldPlay prop, just toggle paused state
      setPaused(p => !p);
    }
  }, []);

  const showHeartAnimation = useCallback(() => {
    heartScale.setValue(0);
    heartOpacity.setValue(1);
    Animated.sequence([
      Animated.spring(heartScale, {
        toValue: 1.15,
        tension: 250,
        friction: 6,
        useNativeDriver: useNative,
      }),
      Animated.parallel([
        Animated.spring(heartScale, {
          toValue: 1,
          tension: 200,
          friction: 10,
          useNativeDriver: useNative,
        }),
        Animated.timing(heartOpacity, {
          toValue: 0,
          duration: 500,
          delay: 300,
          useNativeDriver: useNative,
        }),
      ]),
    ]).start();
  }, [heartScale, heartOpacity]);

  const toggleLike = useCallback(async () => {
    const wasLiked = liked;
    setLiked(!wasLiked);
    setLikeCount(prev => wasLiked ? Math.max(0, prev - 1) : prev + 1);
    likeScale.setValue(0.6);
    Animated.spring(likeScale, {
      toValue: 1,
      tension: 300,
      friction: 10,
      useNativeDriver: useNative,
    }).start();
    try {
      const r = await api.feedLike(reel.id);
      if (r.success && r.data) {
        if (r.data.liked !== undefined) setLiked(!!r.data.liked);
        if (r.data.like_count !== undefined) setLikeCount(Number(r.data.like_count));
      }
    } catch {
      setLiked(wasLiked);
      setLikeCount(prev => wasLiked ? prev + 1 : Math.max(0, prev - 1));
    }
  }, [liked, reel.id, likeScale]);

  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      if (!liked) toggleLike();
      showHeartAnimation();
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
      // Single tap: toggle pause (with delay to differentiate)
      setTimeout(() => {
        if (lastTapRef.current !== 0) {
          togglePause();
        }
      }, DOUBLE_TAP_DELAY + 50);
    }
  }, [liked, toggleLike, showHeartAnimation, togglePause]);

  const toggleBookmark = useCallback(async () => {
    const was = bookmarked;
    setBookmarked(!was);
    bookmarkAnim.setValue(0.6);
    Animated.spring(bookmarkAnim, {
      toValue: 1,
      tension: 300,
      friction: 10,
      useNativeDriver: useNative,
    }).start();
    try {
      const r = await api.feedBookmark(reel.id);
      if (r.success && r.data) {
        if (r.data.bookmarked !== undefined) setBookmarked(!!r.data.bookmarked);
      }
    } catch {
      setBookmarked(was);
    }
  }, [bookmarked, reel.id, bookmarkAnim]);

  const handleShare = useCallback(async () => {
    const url = `${BASE_URL}/feed/${reel.id}`;
    if (isWeb && typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: reel.caption || '', url }); } catch {}
    } else if (!isWeb) {
      try { await Share.share({ message: url }); } catch {}
    }
  }, [reel.id, reel.caption]);

  const height = containerHeight || SCREEN_HEIGHT;

  return (
    <View style={[styles.reelContainer, { height, width: SCREEN_WIDTH }]}>
      {/* Video */}
      <TouchableOpacity
        activeOpacity={1}
        onPress={handleDoubleTap}
        style={StyleSheet.absoluteFill}
      >
        {isWeb ? (
          <video
            ref={videoRef}
            src={videoUrl}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              backgroundColor: '#000',
            }}
            loop
            playsInline
            muted={false}
            preload="auto"
            poster={reel.thumbnail_url ? resolveMediaUrl(reel.thumbnail_url) : undefined}
          />
        ) : VideoView ? (
          <NativeVideoPlayer videoUrl={videoUrl} isActive={isActive} paused={paused} />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }]}>
            <IconPlay size={48} color="#fff" />
          </View>
        )}
      </TouchableOpacity>

      {/* Pause icon overlay */}
      {paused && (
        <View pointerEvents="none" style={styles.pauseOverlay}>
          <View style={styles.pauseIcon}>
            <IconPause size={48} color="#fff" />
          </View>
        </View>
      )}

      {/* Heart animation (double-tap) */}
      <Animated.View
        pointerEvents="none"
        style={[styles.heartAnimOverlay, {
          opacity: heartOpacity,
          transform: [{ scale: heartScale }],
        }]}
      >
        <IconHeart size={100} color="#fff" />
      </Animated.View>

      {/* Right sidebar actions */}
      <View style={styles.sidebarActions}>
        {/* Avatar */}
        <TouchableOpacity style={styles.sidebarAvatar} activeOpacity={0.8}>
          <View style={styles.avatarBorder}>
            <AvatarCircle email={reel.author_email} name={reel.author_name} size={44} />
          </View>
        </TouchableOpacity>

        {/* Like */}
        <Animated.View style={{ transform: [{ scale: likeScale }] }}>
          <TouchableOpacity
            style={styles.sidebarBtn}
            onPress={toggleLike}
            activeOpacity={0.7}
            accessibilityLabel={liked ? (t('feed.unlike') || 'Unlike') : (t('feed.like') || 'Like')}
            accessibilityRole="button"
          >
            {liked ? (
              <IconHeart size={30} color="#ef4444" />
            ) : (
              <IconHeartOutline size={30} color="#fff" />
            )}
            <Text style={styles.sidebarCount}>{formatCount(likeCount)}</Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Comment */}
        <TouchableOpacity
          style={styles.sidebarBtn}
          onPress={() => onOpenComments?.(reel)}
          activeOpacity={0.7}
          accessibilityLabel={t('feed.comment') || 'Comment'}
          accessibilityRole="button"
        >
          <IconMessageCircle size={28} color="#fff" />
          <Text style={styles.sidebarCount}>{formatCount(commentCount)}</Text>
        </TouchableOpacity>

        {/* Share */}
        <TouchableOpacity
          style={styles.sidebarBtn}
          onPress={handleShare}
          activeOpacity={0.7}
          accessibilityLabel={t('feed.share') || 'Share'}
          accessibilityRole="button"
        >
          <IconShare size={26} color="#fff" />
        </TouchableOpacity>

        {/* Bookmark */}
        <Animated.View style={{ transform: [{ scale: bookmarkAnim }] }}>
          <TouchableOpacity
            style={styles.sidebarBtn}
            onPress={toggleBookmark}
            activeOpacity={0.7}
            accessibilityLabel={bookmarked ? (t('feed.removeBookmark') || 'Remove') : (t('feed.bookmark') || 'Save')}
            accessibilityRole="button"
          >
            {bookmarked ? (
              <IconBookmarkFilled size={26} color="#fff" />
            ) : (
              <IconBookmark size={26} color="#fff" />
            )}
          </TouchableOpacity>
        </Animated.View>

        {/* Music disc */}
        <View style={styles.musicDisc}>
          <View style={styles.musicDiscInner}>
            <IconMusic size={14} color="#fff" />
          </View>
        </View>
      </View>

      {/* Bottom overlay */}
      <View style={styles.bottomOverlay}>
        {/* Username */}
        <Text style={styles.bottomUsername}>@{authorDisplay}</Text>

        {/* Caption */}
        {reel.caption ? (
          <TouchableOpacity
            onPress={() => setCaptionExpanded(!captionExpanded)}
            activeOpacity={0.8}
          >
            <Text style={styles.bottomCaption} numberOfLines={captionExpanded ? undefined : 2}>
              {reel.caption}
            </Text>
            {!captionExpanded && reel.caption.length > 80 && (
              <Text style={styles.bottomMore}>{t('feed.more') || 'more'}</Text>
            )}
          </TouchableOpacity>
        ) : null}

        {/* Music bar */}
        <View style={styles.musicBar}>
          <IconMusic size={12} color="#fff" />
          <View style={styles.musicMarquee}>
            <Text style={styles.musicText} numberOfLines={1}>
              {reel.audio_name || `${authorDisplay} - ${t('feed.originalAudio') || 'Original audio'}`}
            </Text>
          </View>
        </View>
      </View>

      {/* Progress bar */}
      <View style={styles.progressBarContainer}>
        <View style={[styles.progressBarFill, { width: `${progress * 100}%` }]} />
      </View>
    </View>
  );
});

// ── Empty state ──
function EmptyReels({ colors, isDark, t }) {
  return (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIcon}>
        <IconPlay size={48} color="#666" />
      </View>
      <Text style={[styles.emptyTitle, { color: '#fff' }]}>
        {t('feed.noReels') || 'No reels yet'}
      </Text>
      <Text style={styles.emptySubtext}>
        {t('feed.noReelsHint') || 'Video posts will appear here'}
      </Text>
    </View>
  );
}

// ── Main ReelsViewer ──
export default function ReelsViewer({ colors, isDark, t, user }) {
  const [reels, setReels] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [commentsReel, setCommentsReel] = useState(null);
  const [containerHeight, setContainerHeight] = useState(SCREEN_HEIGHT);

  const viewConfigRef = useRef({ viewAreaCoveragePercentThreshold: 50 });
  const onViewableRef = useRef(({ viewableItems }) => {
    if (viewableItems && viewableItems[0]) {
      setCurrentIndex(viewableItems[0].index);
    }
  });

  useEffect(() => {
    loadReels();
  }, []);

  const loadReels = async () => {
    setLoading(true);
    try {
      const r = await api.feedList(1, 50);
      if (r && r.success && r.data) {
        const rawPosts = r.data.posts || r.data;
        const allPosts = Array.isArray(rawPosts) ? rawPosts : [];
        // Filter to video posts only
        const videos = allPosts.filter(p => {
          if (p.media_type === 'video') return true;
          const urls = parseMediaUrls(p.media_urls);
          return urls.some(u => typeof u === 'string' && (u.endsWith('.mp4') || u.endsWith('.mov') || u.endsWith('.webm')));
        });
        setReels(videos);
      }
    } catch (e) {
      console.warn('Reels load error:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenComments = useCallback((reel) => {
    setCommentsReel(reel);
  }, []);

  const onLayout = useCallback((e) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setContainerHeight(h);
  }, []);

  const renderItem = useCallback(({ item, index }) => (
    <ReelItem
      reel={item}
      isActive={index === currentIndex}
      colors={colors}
      isDark={isDark}
      t={t}
      user={user}
      containerHeight={containerHeight}
      onOpenComments={handleOpenComments}
    />
  ), [currentIndex, colors, isDark, t, user, containerHeight, handleOpenComments]);

  const keyExtractor = useCallback((item) => String(item.id), []);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={ACCENT} />
      </View>
    );
  }

  if (reels.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <EmptyReels colors={colors} isDark={isDark} t={t} />
      </View>
    );
  }

  return (
    <View style={styles.reelsRoot} onLayout={onLayout}>
      <FlatList
        data={reels}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        snapToInterval={containerHeight}
        snapToAlignment="start"
        decelerationRate="fast"
        onViewableItemsChanged={onViewableRef.current}
        viewabilityConfig={viewConfigRef.current}
        getItemLayout={(data, index) => ({
          length: containerHeight,
          offset: containerHeight * index,
          index,
        })}
        initialNumToRender={2}
        maxToRenderPerBatch={3}
        windowSize={3}
        removeClippedSubviews={Platform.OS !== 'web'}
      />

      {/* Comments bottom sheet */}
      <CommentsSheet
        visible={!!commentsReel}
        post={commentsReel}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setCommentsReel(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  reelsRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reelContainer: {
    backgroundColor: '#000',
    position: 'relative',
  },
  // Pause overlay
  pauseOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pauseIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Native play button fallback
  nativePlayBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 4,
  },
  // Heart animation
  heartAnimOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Right sidebar
  sidebarActions: {
    position: 'absolute',
    right: 10,
    bottom: 120,
    alignItems: 'center',
    gap: 16,
  },
  sidebarAvatar: {
    marginBottom: 8,
  },
  avatarBorder: {
    borderWidth: 2,
    borderColor: '#fff',
    borderRadius: 24,
    padding: 1,
  },
  sidebarBtn: {
    alignItems: 'center',
    gap: 2,
  },
  sidebarCount: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  musicDisc: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: '#555',
    backgroundColor: '#222',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  musicDiscInner: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Bottom overlay
  bottomOverlay: {
    position: 'absolute',
    bottom: 50,
    left: 14,
    right: 70,
    gap: 8,
  },
  bottomUsername: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  bottomCaption: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 20,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  bottomMore: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 2,
  },
  musicBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  musicMarquee: {
    flex: 1,
    overflow: 'hidden',
  },
  musicText: {
    color: '#fff',
    fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  // Progress bar
  progressBarContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#fff',
  },
  // Empty state
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: '#444',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  emptySubtext: {
    color: '#888',
    fontSize: 14,
  },
  // Comments sheet
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: SCREEN_HEIGHT * 0.6,
    minHeight: 300,
  },
  sheetHandle: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  sheetHandleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  sheetLoading: {
    padding: 40,
    alignItems: 'center',
  },
  sheetEmpty: {
    padding: 40,
    alignItems: 'center',
  },
  sheetEmptyText: {
    fontSize: 14,
  },
  sheetList: {
    maxHeight: SCREEN_HEIGHT * 0.35,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  commentRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  commentContent: {
    flex: 1,
  },
  commentAuthor: {
    fontSize: 14,
    fontWeight: '600',
  },
  commentText: {
    fontWeight: '400',
  },
  commentTime: {
    fontSize: 11,
    marginTop: 3,
  },
  sheetInput: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetTextInput: {
    flex: 1,
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
});
