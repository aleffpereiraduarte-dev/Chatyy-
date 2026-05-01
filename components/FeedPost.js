import React, { useState, useRef, useCallback, useEffect, useMemo, memo } from 'react';
// expo-image (SDK 55+) renders with the same JSX surface as react-native Image
// but adds memory+disk caching and a smooth transition. Falls back to RN
// Image if the module isn't bundled (older binaries / web in some cases).
let _ExpoImage = null;
try { _ExpoImage = require('expo-image').Image; } catch {}
function _CachedFeedImage(props) {
  if (_ExpoImage) {
    return <_ExpoImage {...props} cachePolicy="memory-disk" transition={140} contentFit={props.resizeMode || 'cover'} />;
  }
  // Fallback: bare RN Image (no disk cache, but still renders).
  return <Image {...props} />;
}
import {
  View, Text, TouchableOpacity, StyleSheet, Image, ScrollView,
  Dimensions, Animated, Platform, Alert, Share, Pressable, Linking,
  Modal, ActivityIndicator, TextInput,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import {
  IconHeart, IconHeartOutline, IconMessageCircle, IconShare,
  IconBookmark, IconBookmarkFilled, IconMoreHorizontal, IconTrash,
  IconMapPin, IconPlay, IconPause, IconPin,
} from './Icons';
import * as api from '../services/api';

const ACCENT = '#7C3AED';
const SCREEN_WIDTH = Dimensions.get('window').width;
const MAX_CARD_WIDTH = 600;
const BASE_URL = 'https://chatyy.com.br';
const DOUBLE_TAP_DELAY = 300;
// Threshold for showing the "more" CTA. Bumped from 100 → 180 because
// a 100-char cap collapsed almost every Instagram-style caption (most
// real posts are 120–160 chars). 180 still fits in a 2-line preview on
// phones but doesn't truncate single-paragraph captions unnecessarily.
const CAPTION_TRUNCATE = 180;

function captionTruncateSafe(text, max) {
  if (!text || text.length <= max) return text || '';
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      let out = '', count = 0;
      for (const { segment } of seg.segment(text)) {
        if (count >= max) break;
        out += segment;
        count++;
      }
      return out;
    }
  } catch {}
  return Array.from(text).slice(0, max).join('');
}

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
  const then = new Date(str).getTime();
  // Guard NaN — without this, an unparseable dateStr would fall through to
  // `new Date(str).toLocaleDateString()` and render the literal "Invalid Date"
  // string in the feed (the bug we caught in the iOS sim review).
  if (!Number.isFinite(then)) return '';
  const now = Date.now();
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

function FeedPost({ post, colors, isDark, t, user, onOpenComments, onPostUpdated, onDeletePost, onPressUser, profileMode }) {
  const [liked, setLiked] = useState(!!post.user_liked);
  const [likeCount, setLikeCount] = useState(Number(post.like_count) || 0);
  const [bookmarked, setBookmarked] = useState(!!post.user_bookmarked);
  const [pinned, setPinned] = useState(!!post.is_pinned);
  const [showMenu, setShowMenu] = useState(false);
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [likersOpen, setLikersOpen] = useState(false);
  const [likersList, setLikersList] = useState(null); // null = loading, [] = empty
  const [likersBusy, setLikersBusy] = useState(new Set());

  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [collections, setCollections] = useState(null); // null = loading
  const [newCollectionName, setNewCollectionName] = useState('');
  const [creatingCollection, setCreatingCollection] = useState(false);

  const openCollectionPicker = useCallback(async () => {
    setCollectionsOpen(true);
    setCollections(null);
    try {
      const r = await api.feedCollectionList();
      setCollections((r?.success && r?.data?.collections) ? r.data.collections : []);
    } catch {
      setCollections([]);
    }
  }, []);

  const saveToCollection = useCallback(async (collectionId) => {
    try {
      const r = await api.feedCollectionAdd(collectionId, post.id);
      if (r?.success) {
        setBookmarked(true);
        setCollectionsOpen(false);
      }
    } catch {}
  }, [post.id]);

  const createCollection = useCallback(async () => {
    const name = newCollectionName.trim();
    if (!name || creatingCollection) return;
    setCreatingCollection(true);
    try {
      const r = await api.feedCollectionCreate(name);
      if (r?.success && r?.data?.collection) {
        setCollections(prev => [r.data.collection, ...(prev || [])]);
        setNewCollectionName('');
        // Auto-save the post to the freshly created collection.
        await saveToCollection(r.data.collection.id);
      }
    } catch {}
    finally { setCreatingCollection(false); }
  }, [newCollectionName, creatingCollection, saveToCollection]);

  const openLikers = useCallback(async () => {
    setLikersOpen(true);
    setLikersList(null);
    try {
      const r = await api.feedLikers(post.id);
      const users = (r?.success && r?.data?.users) ? r.data.users : [];
      setLikersList(users);
    } catch {
      setLikersList([]);
    }
  }, [post.id]);

  const toggleFollowLiker = useCallback(async (email, currentlyFollowing) => {
    if (likersBusy.has(email)) return;
    setLikersBusy(prev => new Set(prev).add(email));
    // optimistic flip
    setLikersList(prev => Array.isArray(prev)
      ? prev.map(u => u.email === email ? { ...u, is_following: !currentlyFollowing } : u)
      : prev);
    try {
      if (currentlyFollowing) await api.unfollowUser(email);
      else await api.followUser(email);
    } catch {
      // revert on error
      setLikersList(prev => Array.isArray(prev)
        ? prev.map(u => u.email === email ? { ...u, is_following: currentlyFollowing } : u)
        : prev);
    } finally {
      setLikersBusy(prev => { const n = new Set(prev); n.delete(email); return n; });
    }
  }, [likersBusy]);

  // Animations
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;
  const likeButtonScale = useRef(new Animated.Value(1)).current;
  const likeCountScale = useRef(new Animated.Value(1)).current;
  const bookmarkScale = useRef(new Animated.Value(1)).current;
  const lastTapRef = useRef(0);
  // Race guard for bookmark double-tap. likeInFlightRef already exists below
  // (created near toggleLike). Without this ref, rapid bookmark taps queue
  // multiple in-flight requests and the icon flickers filled/outline.
  const bookmarkInFlightRef = useRef(false);
  // Memoize the relative time string so it doesn't recompute on every parent
  // re-render (e.g. when feed receives a WS update). Stable for the lifetime
  // of the post unless the post id or locale changes.
  const _relTime = useMemo(() => timeAgo(post.created_at, t), [post.created_at, t]);

  const mediaUrls = parseMediaUrls(post.media_urls);
  const isOwner = user?.email === post.author_email;
  const isWeb = Platform.OS === 'web';
  const cardWidth = Math.min(SCREEN_WIDTH, MAX_CARD_WIDTH);

  // Sync with prop changes
  useEffect(() => {
    setLiked(!!post.user_liked);
    setLikeCount(Number(post.like_count) || 0);
    setBookmarked(!!post.user_bookmarked);
    setPinned(!!post.is_pinned);
  }, [post.user_liked, post.like_count, post.user_bookmarked, post.is_pinned]);

  const togglePin = useCallback(async () => {
    setShowMenu(false);
    if (!isOwner) return;
    const wasPinned = pinned;
    setPinned(!wasPinned);
    try {
      const r = wasPinned ? await api.feedUnpinPost(post.id) : await api.feedPinPost(post.id);
      if (r?.success) {
        if (typeof r.data?.is_pinned === 'boolean') setPinned(r.data.is_pinned);
        onPostUpdated?.({ ...post, is_pinned: !wasPinned });
      } else {
        setPinned(wasPinned);
        if (r?.data?.error === 'pin_limit') {
          try { Alert.alert(t?.('feed.pinLimitReached') || 'Limite de 3 posts fixados'); } catch {}
        }
      }
    } catch {
      setPinned(wasPinned);
    }
  }, [isOwner, pinned, post, onPostUpdated, t]);

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
    // Two-phase pop: squeeze to 0.6, spring to 1.35, settle to 1. Feels more
    // expressive than the old 0.7→1 spring. Matches Instagram's heart.
    likeButtonScale.setValue(0.6);
    Animated.sequence([
      Animated.spring(likeButtonScale, { toValue: 1.35, tension: 360, friction: 7, useNativeDriver: true }),
      Animated.spring(likeButtonScale, { toValue: 1, tension: 280, friction: 9, useNativeDriver: true }),
    ]).start();
    // Haptic: Success on new like, Light on unlike. Tactile confirmation
    // that the button actually registered — users said the like felt flat
    // without any feedback.
    try {
      if (Platform.OS !== 'web') {
        const Haptics = require('expo-haptics');
        if (liked) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        } else {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        }
      }
    } catch {}
  }, [likeButtonScale, liked]);

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
    // Race guard — rapid taps used to fire N parallel toggles, leaving the
    // bookmark icon out-of-sync with the server's final state.
    if (bookmarkInFlightRef.current) return;
    bookmarkInFlightRef.current = true;
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
    } finally {
      bookmarkInFlightRef.current = false;
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
    // Build a useful share title (first 60 chars of caption) and a message
    // body that lands as text on platforms that don't preview links. Without
    // this the share sheet showed only the bare URL — recipients had to tap
    // to find out what the post was about.
    const cap = String(post.caption || '').replace(/\s+/g, ' ').trim();
    const title = cap ? cap.slice(0, 60) + (cap.length > 60 ? '…' : '') : (t('feed.sharedPost') || 'Post no Chatyy');
    const message = cap ? `${cap}\n\n${url}` : url;
    if (isWeb && typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title, text: cap || undefined, url }); } catch {}
    } else if (!isWeb) {
      try { await Share.share({ title, message, url }); } catch {}
    }
  }, [post.id, post.caption, isWeb, t]);

  // Only update on momentum end (swipe settles) instead of mid-scroll. The
  // old throttled-onScroll path fired setState ~16x during a single swipe,
  // re-rendering the entire FeedPost (with all media frames) each time —
  // that was a real cause of jank on long carousels.
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
            {_relTime}
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
                      onPress={togglePin}
                      accessibilityLabel={pinned ? (t('feed.unpinPost') || 'Unpin from profile') : (t('feed.pinPost') || 'Pin to profile')}
                      accessibilityRole="button"
                    >
                      <IconPin size={16} color={colors.text} />
                      <Text style={[styles.menuItemText, { color: colors.text }]}>
                        {pinned ? (t('feed.unpinPost') || 'Desafixar do perfil') : (t('feed.pinPost') || 'Fixar no perfil')}
                      </Text>
                    </TouchableOpacity>
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
          {pinned && profileMode && (
            <View pointerEvents="none" style={{
              position: 'absolute', top: 8, left: 8, zIndex: 5,
              width: 24, height: 24, borderRadius: 12,
              backgroundColor: 'rgba(0,0,0,0.55)',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <IconPin size={14} color="#fff" />
            </View>
          )}
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
                <_CachedFeedImage
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
                onMomentumScrollEnd={handleScroll}
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
                      <_CachedFeedImage
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
            onLongPress={openCollectionPicker}
            delayLongPress={350}
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
        <TouchableOpacity activeOpacity={0.7} style={styles.likeCountRow} onPress={openLikers}>
          <Animated.Text style={[styles.likeCount, { color: colors.text, transform: [{ scale: likeCountScale }] }]}>
            {formatLikeCount(likeCount, t)}
          </Animated.Text>
        </TouchableOpacity>
      )}

      {/* Caption — linkify #hashtag and @mention so taps route into a
          search/profile lookup like Instagram. Tokens are colored with the
          accent and registered as TouchableOpacity around an inline Text. */}
      {post.caption ? (
        <View style={styles.captionRow}>
          <Text
            style={[styles.captionText, { color: colors.text }]}
            numberOfLines={captionExpanded ? undefined : 2}
          >
            <Text style={styles.captionAuthor}>{authorDisplay}</Text>
            {'  '}
            {(() => {
              // Split into [text, #tag, text, @mention, text, ...] preserving
              // surrounding whitespace. Regex matches start-of-string or non-
              // word boundary so words containing # in the middle (e.g.
              // "C#programming") are NOT linkified.
              const parts = String(post.caption).split(/(\s|^)([#@][A-Za-z0-9_.À-ſ]{1,30})\b/g);
              return parts.map((seg, i) => {
                if (!seg) return null;
                if (/^[#@]/.test(seg)) {
                  const isTag = seg[0] === '#';
                  const handle = seg.slice(1);
                  return (
                    <Text
                      key={i}
                      style={{ color: '#7C3AED', fontWeight: '600' }}
                      onPress={() => {
                        try {
                          const { router } = require('expo-router');
                          if (isTag) {
                            router.push(`/feed-search?hashtag=${encodeURIComponent(handle)}`);
                          } else {
                            router.push(`/profile?handle=${encodeURIComponent(handle)}`);
                          }
                        } catch {}
                      }}
                    >
                      {seg}
                    </Text>
                  );
                }
                return seg;
              });
            })()}
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

      {/* Timestamp — guarded so a missing/invalid created_at doesn't render
          the literal "Invalid Date" string in the user's feed (the bug we
          saw in iOS sim screenshots: smoketest post showed "Invalid Date"). */}
      {(() => {
        const ca = post.created_at || '';
        if (!ca) return null;
        const iso = (ca.endsWith('Z') || ca.includes('+')) ? ca : ca + 'Z';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return null;
        const formatted = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
        return (
          <Text style={[styles.timestamp, { color: colors.textTertiary }]}>
            {formatted}
          </Text>
        );
      })()}

      {/* Likers modal — Instagram-style sheet with avatar+name+follow button */}
      <Modal visible={likersOpen} transparent animationType="slide" onRequestClose={() => setLikersOpen(false)}>
        <Pressable style={styles.likersBackdrop} onPress={() => setLikersOpen(false)}>
          <Pressable style={[styles.likersSheet, { backgroundColor: colors.background, borderColor: colors.border }]} onPress={() => {}}>
            <View style={[styles.likersHandle, { backgroundColor: colors.border }]} />
            <Text style={[styles.likersTitle, { color: colors.text }]}>{t('feed.likesTitle') || 'Curtidas'}</Text>
            {likersList === null ? (
              <View style={{ paddingVertical: 32 }}>
                <ActivityIndicator color={colors.textTertiary} />
              </View>
            ) : likersList.length === 0 ? (
              <Text style={[styles.likersEmpty, { color: colors.textTertiary }]}>{t('feed.noLikesYet') || 'Ninguém curtiu ainda'}</Text>
            ) : (
              <ScrollView style={styles.likersScroll} showsVerticalScrollIndicator={false}>
                {likersList.map((u) => {
                  const display = u.display_name || u.name || (u.email ? u.email.split('@')[0] : '');
                  const isMe = user?.email && u.email && String(u.email).toLowerCase() === String(user.email).toLowerCase();
                  return (
                    <TouchableOpacity
                      key={u.email}
                      activeOpacity={0.7}
                      style={styles.likersRow}
                      onPress={() => {
                        setLikersOpen(false);
                        onPressUser?.(u.email, display);
                      }}
                    >
                      <AvatarCircle email={u.email} name={display} size={42} />
                      <View style={styles.likersInfo}>
                        <Text style={[styles.likersName, { color: colors.text }]} numberOfLines={1}>{display}</Text>
                        <Text style={[styles.likersHandle2, { color: colors.textTertiary }]} numberOfLines={1}>{u.email}</Text>
                      </View>
                      {!isMe && (
                        <TouchableOpacity
                          activeOpacity={0.7}
                          disabled={likersBusy.has(u.email)}
                          onPress={(e) => { e.stopPropagation?.(); toggleFollowLiker(u.email, !!u.is_following); }}
                          style={[
                            styles.likersFollowBtn,
                            u.is_following
                              ? { backgroundColor: 'transparent', borderColor: colors.border }
                              : { backgroundColor: ACCENT, borderColor: ACCENT },
                          ]}
                        >
                          <Text style={[styles.likersFollowText, { color: u.is_following ? colors.text : '#fff' }]}>
                            {u.is_following ? (t('profile.following') || 'Seguindo') : (t('profile.follow') || 'Seguir')}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Save-to-collection bottom sheet (long-press bookmark) */}
      <Modal visible={collectionsOpen} transparent animationType="slide" onRequestClose={() => setCollectionsOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={() => setCollectionsOpen(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{ backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 16, paddingBottom: 32, maxHeight: '70%' }}
          >
            <View style={{ alignItems: 'center', marginBottom: 8 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border }} />
            </View>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, textAlign: 'center', marginBottom: 14 }}>
              {t('feed.saveToCollection') || 'Salvar em...'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 12, gap: 10 }}>
              <TextInput
                value={newCollectionName}
                onChangeText={setNewCollectionName}
                placeholder={t('feed.newCollection') || '+ Nova coleção'}
                placeholderTextColor={colors.textTertiary}
                style={{ flex: 1, fontSize: 14, color: colors.text, backgroundColor: colors.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
                onSubmitEditing={createCollection}
              />
              <TouchableOpacity
                onPress={createCollection}
                disabled={!newCollectionName.trim() || creatingCollection}
                style={{ backgroundColor: newCollectionName.trim() ? ACCENT : colors.border, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 }}
              >
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>+</Text>
              </TouchableOpacity>
            </View>
            {collections === null ? (
              <ActivityIndicator color={colors.primary || ACCENT} style={{ marginVertical: 24 }} />
            ) : collections.length === 0 ? (
              <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center', paddingVertical: 16 }}>
                {t('feed.collections') || 'Coleções'}
              </Text>
            ) : (
              <ScrollView style={{ maxHeight: 320 }}>
                {collections.map(c => (
                  <TouchableOpacity
                    key={c.id}
                    onPress={() => saveToCollection(c.id)}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}
                  >
                    <IconBookmarkFilled size={20} color={ACCENT} />
                    <Text style={{ flex: 1, marginLeft: 12, fontSize: 15, fontWeight: '600', color: colors.text }} numberOfLines={1}>{c.name}</Text>
                    <Text style={{ fontSize: 12, color: colors.textTertiary }}>{c.post_count}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
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
  likersBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  likersSheet: {
    maxHeight: '75%',
    minHeight: 280,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingBottom: 24,
  },
  likersHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 12,
    opacity: 0.6,
  },
  likersTitle: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    paddingBottom: 12,
  },
  likersEmpty: {
    textAlign: 'center',
    paddingVertical: 32,
    fontSize: 14,
  },
  likersScroll: {
    paddingHorizontal: 16,
  },
  likersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 12,
  },
  likersInfo: {
    flex: 1,
    minWidth: 0,
  },
  likersName: {
    fontSize: 14,
    fontWeight: '600',
  },
  likersHandle2: {
    fontSize: 12,
    marginTop: 2,
  },
  likersFollowBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  likersFollowText: {
    fontSize: 13,
    fontWeight: '700',
  },
});

export default memo(FeedPost);
