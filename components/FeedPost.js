import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image, ScrollView,
  Dimensions, Animated, Platform, Alert, Share, Pressable, Linking,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import {
  IconHeart, IconHeartOutline, IconMessageCircle, IconShare,
  IconBookmark, IconBookmarkFilled, IconMoreHorizontal, IconTrash,
  IconMapPin, IconPlay, IconPause,
} from './Icons';
import * as api from '../services/api';

const ACCENT = '#7C3AED';
const SCREEN_WIDTH = Dimensions.get('window').width;
const MAX_CARD_WIDTH = 600;
const BASE_URL = 'https://chatyy.com.br';
const DOUBLE_TAP_DELAY = 300;
const CAPTION_TRUNCATE = 100;

// Instagram-style CSS filters (must match CreatePostModal.js)
const FILTER_CSS = {
  Clarendon: 'contrast(1.2) saturate(1.35)',
  Gingham: 'brightness(1.05) hue-rotate(-10deg)',
  Moon: 'grayscale(1) contrast(1.1) brightness(1.1)',
  Lark: 'contrast(0.9) brightness(1.1) saturate(1.2)',
  Reyes: 'sepia(0.22) brightness(1.1) contrast(0.85) saturate(0.75)',
  Juno: 'contrast(1.1) brightness(1.05) saturate(1.3)',
  Slumber: 'saturate(0.66) brightness(1.05) sepia(0.1)',
  Aden: 'hue-rotate(20deg) contrast(0.9) saturate(0.85) brightness(1.2)',
  Perpetua: 'brightness(1.05) contrast(1.1) saturate(1.1)',
};

function getNativeFilterStyle(filterName) {
  switch (filterName) {
    case 'Moon': return { opacity: 0.85 };
    case 'Reyes': return { opacity: 0.88 };
    case 'Slumber': return { opacity: 0.9 };
    default: return {};
  }
}

function getFilterCss(filterName) {
  if (!filterName || filterName === 'Normal') return undefined;
  return FILTER_CSS[filterName] || undefined;
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

function formatLikeCount(count, t) {
  if (count <= 0) return '';
  if (count === 1) return t?.('feed.oneLike') || '1 like';
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1).replace(/\.0$/, '')}M ${t?.('feed.likes') || 'likes'}`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}K ${t?.('feed.likes') || 'likes'}`;
  }
  return `${count} ${t?.('feed.likes') || 'likes'}`;
}

// Video player component with play/pause overlay, mute toggle, progress bar
function VideoPlayer({ uri, poster, colors, isDark, t, filterName }) {
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [inView, setInView] = useState(false);
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const progressRef = useRef(null);
  const lastTapRef = useRef(0);
  const isWeb = Platform.OS === 'web';

  // Viewport-based playback: only autoplay when the video is on screen.
  // Previously every VideoPlayer in the feed fired `autoPlay + preload=auto`
  // immediately on mount — scrolling through 10 posts meant 10 simultaneous
  // downloads and the initial ones stalled for seconds. IntersectionObserver
  // pauses off-screen videos so only the visible one uses bandwidth.
  useEffect(() => {
    if (!isWeb || typeof window === 'undefined') return;
    const el = containerRef.current;
    if (!el || !('IntersectionObserver' in window)) { setInView(true); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) setInView(e.isIntersecting && e.intersectionRatio > 0.4);
    }, { threshold: [0, 0.4, 1] });
    io.observe(el);
    return () => { try { io.disconnect(); } catch {} };
  }, [isWeb]);

  // Pause / resume based on viewport visibility. The autoPlay attribute is
  // removed in favor of imperative play/pause so tabs/scroll transitions
  // don't fight with the browser's default autoplay heuristic.
  useEffect(() => {
    if (!isWeb || !videoRef.current) return;
    if (inView) {
      videoRef.current.play?.().catch(() => {});
    } else {
      try { videoRef.current.pause?.(); } catch {}
    }
  }, [inView, isWeb]);

  const togglePlay = useCallback(() => {
    if (!isWeb || !videoRef.current) return;
    if (playing) {
      videoRef.current.pause();
    } else {
      videoRef.current.muted = muted;
      videoRef.current.play().catch(() => {
        videoRef.current.muted = true;
        setMuted(true);
        videoRef.current.play().catch(() => {});
      });
    }
    setPlaying(!playing);
  }, [playing, isWeb, muted]);

  const toggleMute = useCallback(() => {
    if (isWeb && videoRef.current) {
      videoRef.current.muted = !muted;
    }
    setMuted(!muted);
  }, [muted, isWeb]);

  // Progress tracking for web
  const startProgress = useCallback(() => {
    if (progressRef.current) clearInterval(progressRef.current);
    progressRef.current = setInterval(() => {
      if (videoRef.current && videoRef.current.duration) {
        setProgress(videoRef.current.currentTime / videoRef.current.duration);
      }
    }, 200);
  }, []);

  const stopProgress = useCallback(() => {
    if (progressRef.current) { clearInterval(progressRef.current); progressRef.current = null; }
  }, []);

  if (isWeb) {
    return (
      <View ref={containerRef} style={styles.mediaFrame}>
        <video
          ref={videoRef}
          src={resolveMediaUrl(uri)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            backgroundColor: '#000',
            filter: getFilterCss(filterName),
          }}
          muted
          playsInline
          loop
          // Metadata-only preload until the video is in viewport — saves
          // ~5-15MB per off-screen video in long feed scrolls and keeps
          // the currently-visible one snappy.
          preload={inView ? 'auto' : 'metadata'}
          poster={poster ? resolveMediaUrl(poster) : undefined}
          onPlay={() => { setPlaying(true); startProgress(); }}
          onPause={() => { setPlaying(false); stopProgress(); }}
          onLoadedData={() => {
            if (videoRef.current && videoRef.current.paused && inView) {
              videoRef.current.muted = true;
              setMuted(true);
              videoRef.current.play().catch(() => {});
            }
          }}
        />
        {/* Tap overlay for play/pause */}
        <TouchableOpacity
          style={styles.videoOverlay}
          onPress={togglePlay}
          activeOpacity={1}
          accessibilityLabel={playing ? (t?.('feed.pause') || 'Pause') : (t?.('feed.play') || 'Play')}
          accessibilityRole="button"
        >
          {!playing && (
            <View style={styles.playButton}>
              <IconPlay size={28} color="#fff" />
            </View>
          )}
        </TouchableOpacity>
        {/* Mute toggle button */}
        <TouchableOpacity
          style={styles.muteButton}
          onPress={toggleMute}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel={muted ? 'Unmute' : 'Mute'}
          accessibilityRole="button"
        >
          <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M11 5L6 9H2v6h4l5 4V5z" />
            {muted ? (
              <><Path d="M23 9l-6 6" /><Path d="M17 9l6 6" /></>
            ) : (
              <><Path d="M19.07 4.93a10 10 0 010 14.14" /><Path d="M15.54 8.46a5 5 0 010 7.07" /></>
            )}
          </Svg>
        </TouchableOpacity>
        {/* Progress bar at bottom */}
        <View style={styles.videoProgressBar}>
          <View style={[styles.videoProgressFill, { width: `${Math.min(progress * 100, 100)}%` }]} />
        </View>
      </View>
    );
  }

  // Native: use WebView to play video inline with JS-controlled play/pause/mute
  const [nativePlaying, setNativePlaying] = useState(false);
  const [nativeMuted, setNativeMuted] = useState(false);
  const webViewRef = useRef(null);
  const handleNativeTogglePlay = useCallback(() => {
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`var v=document.getElementById("v");if(v.paused)v.play().catch(function(){});else v.pause();true;`);
    }
  }, []);
  const handleNativeToggleMute = useCallback(() => {
    setNativeMuted(prev => {
      const next = !prev;
      if (webViewRef.current) {
        webViewRef.current.injectJavaScript(`document.getElementById("v").muted=${next};true;`);
      }
      return next;
    });
  }, []);
  const handleNativeClose = useCallback(() => setNativePlaying(false), []);
  const handleNativeOpen = useCallback(() => setNativePlaying(true), []);
  const videoUrl = resolveMediaUrl(uri);

  if (nativePlaying) {
    const WebView = require('react-native-webview').WebView;
    const videoHtml = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden}video{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain}</style></head><body><video id="v" autoplay playsinline webkit-playsinline loop preload="auto"></video><script>var v=document.getElementById("v");v.src="${videoUrl}";v.muted=false;v.play().catch(function(){v.muted=true;v.play().catch(function(){})});window.addEventListener("message",function(e){try{var d=JSON.parse(e.data);if(d.cmd==="pause")v.pause();if(d.cmd==="play"){v.play().catch(function(){});}if(d.cmd==="mute")v.muted=true;if(d.cmd==="unmute"){v.muted=false;}}catch(ex){}});</script></body></html>`;
    return (
      <View style={styles.mediaFrame}>
        <WebView
          ref={webViewRef}
          source={{ html: videoHtml, baseUrl: BASE_URL }}
          style={{ flex: 1, backgroundColor: '#000' }}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          javaScriptEnabled={true}
          originWhitelist={['*']}
          setSupportMultipleWindows={false}
          allowsFullscreenVideo={true}
          onShouldStartLoadWithRequest={(req) => {
            if (req.url === 'about:blank' || req.url.startsWith(BASE_URL)) return true;
            return false;
          }}
        />
        {/* Play/Pause overlay */}
        <TouchableOpacity
          style={styles.nativeVideoOverlay}
          onPress={handleNativeTogglePlay}
          activeOpacity={1}
          accessibilityLabel={t('feed.togglePlay') || 'Play or pause video'}
        />
        {/* Mute toggle */}
        <TouchableOpacity
          style={styles.muteButton}
          onPress={handleNativeToggleMute}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel={nativeMuted ? (t('feed.unmute') || 'Unmute') : (t('feed.mute') || 'Mute')}
        >
          <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M11 5L6 9H2v6h4l5 4V5z" />
            {nativeMuted ? (
              <><Path d="M23 9l-6 6" /><Path d="M17 9l6 6" /></>
            ) : (
              <><Path d="M19.07 4.93a10 10 0 010 14.14" /><Path d="M15.54 8.46a5 5 0 010 7.07" /></>
            )}
          </Svg>
        </TouchableOpacity>
        {/* Close button */}
        <TouchableOpacity
          style={{ position: 'absolute', top: 10, right: 10, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 16, width: 32, height: 32, alignItems: 'center', justifyContent: 'center', zIndex: 10 }}
          onPress={handleNativeClose}
          accessibilityLabel={t('common.close') || 'Close'}
          accessibilityRole="button"
        >
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>X</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <TouchableOpacity style={styles.mediaFrame} onPress={handleNativeOpen} activeOpacity={0.8} accessibilityLabel={t('feed.playVideo') || 'Play video'}>
      <Image
        source={{ uri: resolveMediaUrl(poster || uri) }}
        style={[StyleSheet.absoluteFill, getNativeFilterStyle(filterName)]}
        resizeMode="cover"
        accessibilityLabel={t?.('feed.video') || 'Video'}
      />
      <View style={styles.videoOverlay}>
        <View style={styles.playButton}>
          <IconPlay size={28} color="#fff" />
        </View>
      </View>
    </TouchableOpacity>
  );
}

function FeedPost({ post, colors, isDark, t, user, onOpenComments, onPostUpdated, onDeletePost, onPressUser }) {
  const [liked, setLiked] = useState(!!post.user_liked);
  const [likeCount, setLikeCount] = useState(Number(post.like_count) || 0);
  const [bookmarked, setBookmarked] = useState(!!post.user_bookmarked);
  const [showMenu, setShowMenu] = useState(false);
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);
  const [captionExpanded, setCaptionExpanded] = useState(false);

  // Animations
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;
  const likeButtonScale = useRef(new Animated.Value(1)).current;
  const likeCountScale = useRef(new Animated.Value(1)).current;
  const bookmarkScale = useRef(new Animated.Value(1)).current;
  const lastTapRef = useRef(0);

  const mediaUrls = parseMediaUrls(post.media_urls);
  const isOwner = user?.email === post.author_email;
  const isWeb = Platform.OS === 'web';
  const cardWidth = Math.min(SCREEN_WIDTH, MAX_CARD_WIDTH);

  // Sync with prop changes
  useEffect(() => {
    setLiked(!!post.user_liked);
    setLikeCount(Number(post.like_count) || 0);
    setBookmarked(!!post.user_bookmarked);
  }, [post.user_liked, post.like_count, post.user_bookmarked]);

  // TikTok-style pop on like-count change
  const prevLikeCountRef = useRef(likeCount);
  useEffect(() => {
    if (prevLikeCountRef.current !== likeCount) {
      likeCountScale.setValue(0.8);
      Animated.spring(likeCountScale, {
        toValue: 1, tension: 280, friction: 9, useNativeDriver: true,
      }).start();
      prevLikeCountRef.current = likeCount;
    }
  }, [likeCount, likeCountScale]);

  const animateLikeButton = useCallback(() => {
    likeButtonScale.setValue(0.7);
    Animated.spring(likeButtonScale, {
      toValue: 1,
      tension: 300,
      friction: 10,
      useNativeDriver: true,
    }).start();
  }, [likeButtonScale]);

  // Single-flight: prevents double-tap on slow networks from firing two
  // toggle requests that race and leave the state inconsistent.
  const likeInFlightRef = useRef(false);
  const toggleLike = useCallback(async () => {
    if (likeInFlightRef.current) return;
    likeInFlightRef.current = true;
    const wasLiked = liked;
    setLiked(!wasLiked);
    setLikeCount(prev => wasLiked ? Math.max(0, prev - 1) : prev + 1);
    animateLikeButton();
    try {
      const r = await api.feedLike(post.id);
      if (r.success && r.data) {
        if (r.data.liked !== undefined) setLiked(!!r.data.liked);
        if (r.data.like_count !== undefined) setLikeCount(Number(r.data.like_count));
      }
    } catch {
      setLiked(wasLiked);
      setLikeCount(prev => wasLiked ? prev + 1 : Math.max(0, prev - 1));
    } finally {
      likeInFlightRef.current = false;
    }
  }, [liked, post.id, animateLikeButton]);

  const showHeartAnimation = useCallback(() => {
    heartScale.setValue(0);
    heartOpacity.setValue(1);
    Animated.sequence([
      Animated.spring(heartScale, {
        toValue: 1.15,
        tension: 250,
        friction: 6,
        useNativeDriver: true,
      }),
      Animated.parallel([
        Animated.spring(heartScale, {
          toValue: 1,
          tension: 200,
          friction: 10,
          useNativeDriver: true,
        }),
        Animated.timing(heartOpacity, {
          toValue: 0,
          duration: 500,
          delay: 300,
          useNativeDriver: true,
        }),
      ]),
    ]).start();
  }, [heartScale, heartOpacity]);

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
    const was = bookmarked;
    setBookmarked(!was);
    bookmarkScale.setValue(0.7);
    Animated.spring(bookmarkScale, {
      toValue: 1,
      tension: 300,
      friction: 10,
      useNativeDriver: true,
    }).start();
    try {
      const r = await api.feedBookmark(post.id);
      if (r.success && r.data) {
        if (r.data.bookmarked !== undefined) setBookmarked(!!r.data.bookmarked);
      }
    } catch {
      setBookmarked(was);
    }
  }, [bookmarked, post.id, bookmarkScale]);

  const handleDelete = useCallback(() => {
    setShowMenu(false);
    const doDelete = async () => {
      try {
        const r = await api.feedDeletePost(post.id);
        if (r.success && onDeletePost) onDeletePost(post.id);
      } catch {}
    };
    if (isWeb) {
      if (window.confirm(t('feed.deleteConfirmMessage') || 'Delete this post?')) doDelete();
    } else {
      Alert.alert(
        t('feed.deleteConfirm') || 'Delete',
        t('feed.deleteConfirmMessage') || 'Delete this post?',
        [
          { text: t('common.cancel') || 'Cancel', style: 'cancel' },
          { text: t('feed.delete') || 'Delete', style: 'destructive', onPress: doDelete },
        ]
      );
    }
  }, [post.id, t, onDeletePost, isWeb]);

  const handleShare = useCallback(async () => {
    const url = `${BASE_URL}/feed/${post.id}`;
    if (isWeb && typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: post.caption || '', url }); } catch {}
    } else if (!isWeb) {
      try { await Share.share({ message: url }); } catch {}
    }
  }, [post.id, post.caption, isWeb]);

  const handleScroll = useCallback((e) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / cardWidth);
    setActiveMediaIndex(idx);
  }, [cardWidth]);

  const authorDisplay = post.author_name || post.author_email?.split('@')[0] || '?';
  const cardBg = isDark ? colors.surface : '#ffffff';
  const needsTruncation = post.caption && post.caption.length > CAPTION_TRUNCATE;
  const commentCount = Number(post.comment_count) || 0;

  return (
    <View style={[styles.container, {
      backgroundColor: cardBg,
      borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
    }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerLeft} activeOpacity={0.7} onPress={() => onPressUser?.(post.author_email, post.author_name)}>
          <View style={styles.avatarRing}>
            <AvatarCircle email={post.author_email} name={post.author_name} size={34} />
          </View>
          <View style={styles.headerInfo}>
            <Text style={[styles.authorName, { color: colors.text }]} numberOfLines={1}>
              {authorDisplay}
            </Text>
            {post.location ? (
              <View style={styles.locationRow}>
                <IconMapPin size={10} color={colors.textSecondary} />
                <Text style={[styles.location, { color: colors.textSecondary }]} numberOfLines={1}>
                  {post.location}
                </Text>
              </View>
            ) : null}
          </View>
        </TouchableOpacity>

        <View style={styles.headerRight}>
          <Text style={[styles.headerTime, { color: colors.textTertiary }]}>
            {timeAgo(post.created_at, t)}
          </Text>
          {isOwner && (
            <View>
              <TouchableOpacity
                onPress={() => setShowMenu(!showMenu)}
                style={styles.menuBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={t('common.more') || 'More options'}
                accessibilityRole="button"
              >
                <IconMoreHorizontal size={20} color={colors.textSecondary} />
              </TouchableOpacity>
              {showMenu && (
                <>
                  <Pressable
                    style={StyleSheet.absoluteFill}
                    onPress={() => setShowMenu(false)}
                  />
                  <View style={[styles.menuDropdown, {
                    backgroundColor: isDark ? '#1e293b' : '#ffffff',
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
                    ...(isWeb ? { boxShadow: '0 8px 30px rgba(0,0,0,0.12)' } : {}),
                  }]}>
                    <TouchableOpacity
                      style={styles.menuItem}
                      onPress={handleDelete}
                      accessibilityLabel={t('feed.delete') || 'Delete post'}
                      accessibilityRole="button"
                    >
                      <IconTrash size={16} color={colors.error || '#dc2626'} />
                      <Text style={[styles.menuItemText, { color: colors.error || '#dc2626' }]}>
                        {t('feed.deletePost') || t('feed.delete') || 'Delete'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.menuItem}
                      onPress={() => setShowMenu(false)}
                      accessibilityLabel={t('common.cancel') || 'Cancel'}
                      accessibilityRole="button"
                    >
                      <Text style={[styles.menuItemText, { color: colors.textSecondary }]}>
                        {t('common.cancel') || 'Cancel'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          )}
        </View>
      </View>

      {/* Duet/Stitch label */}
      {(post.duet_of || post.stitch_of) && (
        <View style={[styles.derivativeLabel, { backgroundColor: colors.primary + '15' }]}>
          <Text style={[styles.derivativeLabelText, { color: colors.primary }]}>
            {post.duet_of ? `🎭 ${t('feed.duetWith') || 'Dueto com'} @${post.original_author || ''}` : `✂️ ${t('feed.stitchWith') || 'Stitch com'} @${post.original_author || ''}`}
          </Text>
        </View>
      )}

      {/* Sound info */}
      {post.sound_name && (
        <TouchableOpacity style={[styles.soundBar, { backgroundColor: isDark ? '#1a1a1a' : '#f5f5f5' }]}>
          <Text style={[styles.soundText, { color: colors.text }]} numberOfLines={1}>
            {'♫ '}{post.sound_name}{post.sound_artist ? ` - ${post.sound_artist}` : ''}
          </Text>
        </TouchableOpacity>
      )}

      {/* Media */}
      {mediaUrls.length > 0 && (
        <TouchableOpacity
          activeOpacity={1}
          onPress={handleDoubleTap}
          style={styles.mediaContainer}
          accessibilityLabel={t('feed.doubleTapLike') || 'Double tap to like'}
          accessibilityRole="image"
        >
          {mediaUrls.length === 1 ? (
            post.media_type === 'video' ? (
              <VideoPlayer
                uri={mediaUrls[0]}
                poster={post.thumbnail_url}
                colors={colors}
                isDark={isDark}
                t={t}
                filterName={post.filter}
              />
            ) : (
              isWeb ? (
                <View style={styles.mediaFrame}>
                  <img
                    src={resolveMediaUrl(mediaUrls[0])}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      filter: getFilterCss(post.filter),
                    }}
                    alt={post.caption || t('feed.image') || 'Image'}
                  />
                </View>
              ) : (
                <Image
                  source={{ uri: resolveMediaUrl(mediaUrls[0]) }}
                  style={[styles.mediaFrame, getNativeFilterStyle(post.filter)]}
                  resizeMode="cover"
                  accessibilityLabel={post.caption || t('feed.image') || 'Image'}
                />
              )
            )
          ) : (
            <View>
              <ScrollView
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                decelerationRate="fast"
                snapToInterval={cardWidth}
              >
                {mediaUrls.map((url, idx) => {
                  const isVideoUrl = post.media_type === 'video' || (typeof url === 'string' && /\.(mp4|mov|webm|avi)$/i.test(url));
                  return isVideoUrl ? (
                    <View key={idx} style={[styles.mediaFrame, { width: cardWidth }]}>
                      <VideoPlayer
                        uri={url}
                        poster={idx === 0 ? post.thumbnail_url : null}
                        colors={colors}
                        isDark={isDark}
                        t={t}
                        filterName={post.filter}
                      />
                    </View>
                  ) : (
                    isWeb ? (
                      <View key={idx} style={[styles.mediaFrame, { width: cardWidth }]}>
                        <img
                          src={resolveMediaUrl(url)}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            filter: getFilterCss(post.filter),
                          }}
                          alt={`${t('feed.image') || 'Image'} ${idx + 1}/${mediaUrls.length}`}
                        />
                      </View>
                    ) : (
                      <Image
                        key={idx}
                        source={{ uri: resolveMediaUrl(url) }}
                        style={[styles.mediaFrame, { width: cardWidth }, getNativeFilterStyle(post.filter)]}
                        resizeMode="cover"
                        accessibilityLabel={`${t('feed.image') || 'Image'} ${idx + 1}/${mediaUrls.length}`}
                      />
                    )
                  );
                })}
              </ScrollView>
              {/* Image counter badge */}
              <View style={styles.counterBadge}>
                <Text style={styles.counterText}>
                  {activeMediaIndex + 1}/{mediaUrls.length}
                </Text>
              </View>
              {/* Dot indicators */}
              {mediaUrls.length <= 10 && (
                <View style={styles.dotRow}>
                  {mediaUrls.map((_, idx) => (
                    <View
                      key={idx}
                      style={[
                        styles.dot,
                        {
                          width: idx === activeMediaIndex ? 8 : 6,
                          height: idx === activeMediaIndex ? 8 : 6,
                          borderRadius: idx === activeMediaIndex ? 4 : 3,
                          opacity: idx === activeMediaIndex ? 1 : 0.5,
                          backgroundColor: idx === activeMediaIndex
                            ? ACCENT
                            : '#ffffff',
                        },
                      ]}
                    />
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Heart animation overlay */}
          <Animated.View
            pointerEvents="none"
            style={[styles.heartOverlay, {
              opacity: heartOpacity,
              transform: [{ scale: heartScale }],
            }]}
          >
            <View style={styles.heartShadow}>
              <IconHeart size={90} color="#fff" />
            </View>
          </Animated.View>
        </TouchableOpacity>
      )}

      {/* Action bar */}
      <View style={styles.actionBar}>
        <View style={styles.actionsLeft}>
          <Animated.View style={{ transform: [{ scale: likeButtonScale }] }}>
            <TouchableOpacity
              onPress={toggleLike}
              style={styles.actionBtn}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              accessibilityLabel={liked ? (t('feed.unlike') || 'Unlike') : (t('feed.like') || 'Like')}
              accessibilityRole="button"
            >
              {liked ? (
                <IconHeart size={26} color="#ef4444" />
              ) : (
                <IconHeartOutline size={26} color={colors.text} />
              )}
            </TouchableOpacity>
          </Animated.View>
          <TouchableOpacity
            onPress={() => onOpenComments?.(post)}
            style={styles.actionBtn}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityLabel={t('feed.comment') || 'Comment'}
            accessibilityRole="button"
          >
            <IconMessageCircle size={25} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleShare}
            style={styles.actionBtn}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityLabel={t('feed.share') || 'Share'}
            accessibilityRole="button"
          >
            <IconShare size={23} color={colors.text} />
          </TouchableOpacity>
        </View>
        <Animated.View style={{ transform: [{ scale: bookmarkScale }] }}>
          <TouchableOpacity
            onPress={toggleBookmark}
            style={styles.actionBtn}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityLabel={bookmarked ? (t('feed.removeBookmark') || 'Remove bookmark') : (t('feed.bookmark') || 'Bookmark')}
            accessibilityRole="button"
          >
            {bookmarked ? (
              <IconBookmarkFilled size={25} color={colors.text} />
            ) : (
              <IconBookmark size={25} color={colors.text} />
            )}
          </TouchableOpacity>
        </Animated.View>
      </View>

      {/* Like count */}
      {likeCount > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.likeCountRow}>
          <Animated.Text style={[styles.likeCount, { color: colors.text, transform: [{ scale: likeCountScale }] }]}>
            {formatLikeCount(likeCount, t)}
          </Animated.Text>
        </TouchableOpacity>
      )}

      {/* Caption */}
      {post.caption ? (
        <View style={styles.captionRow}>
          <Text
            style={[styles.captionText, { color: colors.text }]}
            numberOfLines={captionExpanded ? undefined : 2}
          >
            <Text style={styles.captionAuthor}>{authorDisplay}</Text>
            {'  '}
            {captionExpanded ? post.caption : post.caption}
          </Text>
          {!captionExpanded && needsTruncation && (
            <TouchableOpacity
              onPress={() => setCaptionExpanded(true)}
              hitSlop={{ top: 4, bottom: 4 }}
              accessibilityLabel={t('feed.showMore') || 'Show more'}
              accessibilityRole="button"
            >
              <Text style={[styles.moreText, { color: colors.textSecondary }]}>
                {t('feed.more') || 'more'}
              </Text>
            </TouchableOpacity>
          )}
          {captionExpanded && needsTruncation && (
            <TouchableOpacity
              onPress={() => setCaptionExpanded(false)}
              hitSlop={{ top: 4, bottom: 4 }}
              accessibilityLabel={t('feed.showLess') || 'Show less'}
              accessibilityRole="button"
            >
              <Text style={[styles.moreText, { color: colors.textSecondary }]}>
                {t('feed.less') || 'less'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      ) : null}

      {/* Comments link */}
      {commentCount > 0 && (
        <TouchableOpacity
          onPress={() => onOpenComments?.(post)}
          style={styles.commentsPreview}
          hitSlop={{ top: 2, bottom: 2 }}
          accessibilityLabel={`${commentCount} ${t('feed.comments') || 'comments'}`}
          accessibilityRole="button"
        >
          <Text style={[styles.commentsPreviewText, { color: colors.textSecondary }]}>
            {commentCount === 1
              ? (t('feed.viewOneComment') || 'View 1 comment')
              : (t('feed.viewAllComments') || 'View all {count} comments').replace('{count}', commentCount)
            }
          </Text>
        </TouchableOpacity>
      )}

      {/* Timestamp */}
      <Text style={[styles.timestamp, { color: colors.textTertiary }]}>
        {new Date(
          (post.created_at || '').endsWith('Z') || (post.created_at || '').includes('+')
            ? post.created_at
            : (post.created_at || '') + 'Z'
        ).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 2,
    // Cap width on wide viewports (desktop web) so a feed post doesn't stretch
    // edge-to-edge across 1440px and feel like a billboard. Instagram-style
    // single-column, centered. Native phones ignore the cap since SCREEN_WIDTH
    // is already ≤ MAX_CARD_WIDTH.
    alignSelf: 'center',
    width: '100%',
    maxWidth: MAX_CARD_WIDTH,
  },
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  avatarRing: {
    padding: 2,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: 'rgba(150,150,150,0.15)',
  },
  headerInfo: {
    flex: 1,
    marginLeft: 10,
  },
  authorName: {
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 1,
  },
  location: {
    fontSize: 11,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerTime: {
    fontSize: 12,
  },
  menuBtn: {
    padding: 8,
  },
  // Menu
  menuDropdown: {
    position: 'absolute',
    top: 40,
    right: 0,
    borderRadius: 14,
    borderWidth: 1,
    zIndex: 100,
    overflow: 'hidden',
    minWidth: 160,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 12 },
      android: { elevation: 8 },
      default: {},
    }),
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 10,
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '500',
  },
  // Media
  mediaContainer: {
    position: 'relative',
    backgroundColor: '#000',
  },
  mediaFrame: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: '#111',
  },
  counterBadge: {
    position: 'absolute',
    top: 14,
    right: 14,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  counterText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  dotRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 4,
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  dot: {
    // Dimensions set dynamically
  },
  heartOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heartShadow: {
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 8 },
      android: { elevation: 10 },
      default: {},
    }),
  },
  // Video
  videoOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 3,
  },
  muteButton: {
    position: 'absolute',
    bottom: 14,
    right: 14,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  nativeVideoOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 50,
    bottom: 0,
    zIndex: 3,
  },
  videoProgressBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.2)',
    zIndex: 5,
  },
  videoProgressFill: {
    height: '100%',
    backgroundColor: '#7C3AED',
  },
  // Actions
  derivativeLabel: {
    paddingHorizontal: 14, paddingVertical: 6,
  },
  derivativeLabelText: { fontSize: 12, fontWeight: '500' },
  soundBar: {
    paddingHorizontal: 14, paddingVertical: 8,
    flexDirection: 'row', alignItems: 'center',
  },
  soundText: { fontSize: 12, fontWeight: '500', flex: 1 },
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 4,
  },
  actionsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  actionBtn: {
    padding: 7,
  },
  // Content
  likeCountRow: {
    paddingHorizontal: 14,
    paddingTop: 2,
  },
  likeCount: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  captionRow: {
    paddingHorizontal: 14,
    paddingTop: 4,
  },
  captionText: {
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: -0.1,
  },
  captionAuthor: {
    fontWeight: '600',
  },
  moreText: {
    fontSize: 14,
    marginTop: 1,
  },
  commentsPreview: {
    paddingHorizontal: 14,
    paddingTop: 5,
  },
  commentsPreviewText: {
    fontSize: 14,
  },
  timestamp: {
    fontSize: 10,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 14,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
});

export default memo(FeedPost);
