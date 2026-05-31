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
  IconMapPin, IconPlay, IconPause, IconPin, IconMusic,
} from './Icons';
import * as api from '../services/api';
import { useLanguage } from '../context/LanguageContext';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { MONETIZATION_ENABLED } from '../constants/featureFlags';

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

function timeAgo(dateStr, t, locale) {
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
  // Pass the app's selected language so pt-BR users see DD/MM/YYYY even on
  // devices whose system locale is en-US (e.g. test emulators).
  return new Date(str).toLocaleDateString(locale || undefined);
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
          accessibilityLabel={playing ? (t?.('feed.pause') || 'Pausar') : (t?.('feed.play') || 'Reproduzir')}
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
          accessibilityLabel={muted ? 'Ativar som' : 'Silenciar'}
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

// ── Animated carousel dot ──
// Smoothly fades + scales between the inactive (white, 6×6, 50% opacity) and
// active (purple, 8×8, full opacity) states so the indicator doesn't snap
// when the user swipes between images. Pure React Native Animated so it
// runs on both native + web.
const AnimatedCarouselDot = memo(function AnimatedCarouselDot({ active }) {
  const progress = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: active ? 1 : 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [active, progress]);
  const size = progress.interpolate({ inputRange: [0, 1], outputRange: [6, 8] });
  const opacity = progress.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        opacity,
        backgroundColor: active ? ACCENT : '#ffffff',
      }}
    />
  );
});

function FeedPost({ post, colors, isDark, t, user, onOpenComments, onPostUpdated, onDeletePost, onPressUser, profileMode, onHidePost }) {
  const [liked, setLiked] = useState(!!post.user_liked);
  const [likeCount, setLikeCount] = useState(Number(post.like_count) || 0);
  const [bookmarked, setBookmarked] = useState(!!post.user_bookmarked);
  const [pinned, setPinned] = useState(!!post.is_pinned);
  const [showMenu, setShowMenu] = useState(false);
  // Reels P2 — paid boost ("Impulsionar") modal. Budget tiers in cents
  // map to diamond costs in the backend (1000 diamonds ≈ $9.99).
  const [showPromoteModal, setShowPromoteModal] = useState(false);
  const [promoteSubmitting, setPromoteSubmitting] = useState(false);
  // Non-owner "more options" menu — hide / not interested / see less.
  // Separate state from showMenu (owner menu) so they don't overlap visually.
  const [showViewerMenu, setShowViewerMenu] = useState(false);
  // Hidden flag: once the user picks "not interested" we collapse this post
  // immediately so the rest of the feed doesn't jump. Parent re-fetch on
  // next refresh will drop it for good.
  const [hidden, setHidden] = useState(false);
  // Caption translation (long-press → translate). null = not translated,
  // string = translated copy, 'loading' = in flight, 'error' = AI failed.
  const [captionTranslation, setCaptionTranslation] = useState(null);
  const [captionTranslating, setCaptionTranslating] = useState(false);
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  // [#img-retry] Single-image load-error + retry. On an image error we flip
  // `imageError` true (renders a tappable retry overlay) and bumping
  // `imageRetry` forces the <Image>/<img> to remount via its key, so the
  // browser/native loader actually re-fetches the URL instead of staying
  // parked on the failed request. Without the key change RN/Expo Image keeps
  // the broken cached attempt and a plain re-render never re-tries.
  const [imageError, setImageError] = useState(false);
  const [imageRetry, setImageRetry] = useState(0);
  const retryImage = useCallback(() => {
    setImageError(false);
    setImageRetry(n => n + 1);
  }, []);
  const [likersOpen, setLikersOpen] = useState(false);
  const [likersList, setLikersList] = useState(null); // null = loading, [] = empty
  const [likersBusy, setLikersBusy] = useState(new Set());

  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [collections, setCollections] = useState(null); // null = loading
  const [newCollectionName, setNewCollectionName] = useState('');
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);

  // Owner-only analytics — fetched lazily on tap. Includes 7-day view
  // series and aggregate counts (views/likes/comments/shares/saves).
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analyticsData, setAnalyticsData] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const openAnalytics = useCallback(async () => {
    setAnalyticsOpen(true);
    setShowMenu(false);
    setAnalyticsLoading(true);
    setAnalyticsData(null);
    try {
      const r = await api.apiCall('feed_post_analytics', { post_id: post.id });
      if (r?.success && r?.data) setAnalyticsData(r.data);
    } catch {}
    setAnalyticsLoading(false);
  }, [post.id]);

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
  const { language: _appLang } = useLanguage();
  const _relTime = useMemo(() => timeAgo(post.created_at, t, _appLang), [post.created_at, t, _appLang]);

  const mediaUrls = parseMediaUrls(post.media_urls);
  const isOwner = user?.email === post.author_email;
  const isWeb = Platform.OS === 'web';
  const cardWidth = Math.min(SCREEN_WIDTH, MAX_CARD_WIDTH);

  // Translate the caption via the existing AI translate endpoint. Toggles:
  // not-translated → loading → translated. A second long-press collapses
  // back to the original. Stays inline (no modal) so it feels like Twitter's
  // "Show this thread" expand.
  const translateCaption = useCallback(async () => {
    if (!post.caption) return;
    if (captionTranslation) {
      setCaptionTranslation(null);
      return;
    }
    setCaptionTranslating(true);
    try {
      // Pick the user's UI language as the target. Backend expects lang code
      // (pt-BR | en | es); falls back to 'pt-BR' so a missing prop doesn't
      // 400 the request.
      const targetLang = (_appLang || 'pt-BR');
      const r = await api.apiCall('ai_translate', {
        text: post.caption,
        target_lang: targetLang,
      }, 'POST');
      if (r?.success && (r.data?.translated || r.data?.text)) {
        setCaptionTranslation(r.data.translated || r.data.text);
      } else {
        setCaptionTranslation('error');
      }
    } catch { setCaptionTranslation('error'); }
    finally { setCaptionTranslating(false); }
  }, [post.caption, captionTranslation, _appLang]);

  // [hooks-order-fix] Hidden-post early return was here, but it sat ABOVE
  // ~15 more hooks (togglePin, useEffect for like-count pop, toggleLike,
  // toggleBookmark, handleScroll, etc.). When the user hid a post, those
  // hooks stopped executing → "Rendered more hooks than during the previous
  // render". The hidden-banner branch now lives at the bottom of the
  // component, just before the main return — after every hook has run.

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
        // Backend returns the reconciled total as `likes_count`; older
        // servers used `like_count`. Read both so the count actually syncs.
        const serverCount = r.data.likes_count ?? r.data.like_count;
        if (serverCount !== undefined) setLikeCount(Number(serverCount));
      }
    } catch {
      // Network error — DON'T roll back the optimistic state. Instead,
      // queue the toggle so it lands on next reconnect, matching the
      // Instagram/TikTok pattern where likes "feel" applied while offline.
      // The previous rollback caused the heart to flicker red→empty mid-tap
      // when the WS pinged but HTTP was still down.
      try {
        const { queueOfflineAction } = require('../services/offlineCache');
        await queueOfflineAction({ type: 'feed_like', params: { id: post.id } });
      } catch {
        // Last resort — if even the queue write failed, rollback so the
        // UI doesn't lie to the user.
        setLiked(wasLiked);
        setLikeCount(prev => wasLiked ? prev + 1 : Math.max(0, prev - 1));
      }
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
        t('feed.deleteConfirm') || 'Excluir publicação?',
        t('feed.deleteConfirmMessage') || 'Delete this post?',
        [
          { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
          { text: t('feed.delete') || 'Excluir', style: 'destructive', onPress: doDelete },
        ]
      );
    }
  }, [post.id, t, onDeletePost, isWeb]);

  const handleShare = useCallback(() => {
    setShareMenuOpen(true);
  }, []);

  const handleExternalShare = useCallback(async () => {
    setShareMenuOpen(false);
    const url = `${BASE_URL}/feed/${post.id}`;
    const cap = String(post.caption || '').replace(/\s+/g, ' ').trim();
    const title = cap ? cap.slice(0, 60) + (cap.length > 60 ? '…' : '') : (t('feed.sharedPost') || 'Post no Chatyy');
    const message = cap ? `${cap}\n\n${url}` : url;
    if (isWeb && typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title, text: cap || undefined, url }); } catch {}
    } else if (!isWeb) {
      try { await Share.share({ title, message, url }); } catch {}
    }
  }, [post.id, post.caption, isWeb, t]);

  const handleRepost = useCallback(() => {
    setShareMenuOpen(false);
    // Defer to the parent feed screen — it owns CreatePostModal and knows how
    // to open it preloaded with `repostOf`. Falls back to a router push if no
    // handler is wired so the user still gets feedback.
    if (typeof onPostUpdated === 'function') {
      // The container can intercept the repost intent by checking the second arg.
      try { onPostUpdated(post, { repostOf: post.id, originalPost: post }); return; } catch {}
    }
    try {
      const { router } = require('expo-router');
      router.push(`/feed?repost_of=${post.id}`);
    } catch {}
  }, [post, onPostUpdated]);

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
  // Tolerate all backend shapes: feed_list emits comments_count/comments,
  // local optimistic patch uses comment_count. Reading only comment_count
  // made the count read 0 on fresh loads → "Ver todos os N comentários"
  // never appeared. Bug-hunt P2 (2026-05-30).
  const commentCount = Number(post.comments_count ?? post.comments ?? post.comment_count) || 0;

  // If the viewer hid this post, render a small collapsed banner with an
  // "Undo" affordance instead of yanking it out of the layout. Avoids the
  // jump-to-bottom scroll glitch RN's VirtualizedList does on data shrink.
  // NOTE: this conditional return MUST stay below every hook call above so
  // the hook order stays stable across renders (see hooks-order-fix comment).
  if (hidden) {
    return (
      <View style={[styles.container, {
        backgroundColor: isDark ? colors.surface : '#ffffff',
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        paddingVertical: 18,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }]}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, flex: 1 }} numberOfLines={2}>
          {t?.('feed.postHidden') || 'Este post foi ocultado.'}
        </Text>
        <TouchableOpacity
          onPress={() => setHidden(false)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={t?.('common.undo') || 'Desfazer'}
        >
          <Text style={{ color: ACCENT, fontWeight: '700', fontSize: 13 }}>
            {t?.('common.undo') || 'Desfazer'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

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
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
              <Text style={[styles.authorName, { color: colors.text, flexShrink: 1 }]} numberOfLines={1}>
                {authorDisplay}
              </Text>
              {/* Wave 15: "Patrocinado" badge for ads + paid boosts. Backend
                  sets sponsored=true when is_ad OR active is_promoted. */}
              {(post.is_ad || post.sponsored || post.is_promoted) ? (
                <View style={{
                  marginLeft: 6,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                  borderRadius: 4,
                  backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)',
                }}>
                  <Text style={{ color: ACCENT, fontSize: 10, fontWeight: '700' }}>
                    {t?.('feed.sponsored') || 'Patrocinado'}
                  </Text>
                </View>
              ) : null}
            </View>
            {(post.location_name || post.location) ? (
              <TouchableOpacity
                style={styles.locationRow}
                activeOpacity={0.7}
                onPress={(e) => {
                  // Wave 15: tappable location chip — opens map if we have
                  // coords, otherwise just falls back to a no-op.
                  e?.stopPropagation?.();
                  const lat = post.location_lat, lon = post.location_lon;
                  if (lat != null && lon != null) {
                    const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
                    try { Linking.openURL(url); } catch {}
                  }
                }}
                accessibilityRole="link"
                accessibilityLabel={post.location_name || post.location}
              >
                <IconMapPin size={10} color={colors.textSecondary} />
                <Text style={[styles.location, { color: colors.textSecondary }]} numberOfLines={1}>
                  {post.location_name || post.location}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </TouchableOpacity>

        <View style={styles.headerRight}>
          <Text style={[styles.headerTime, { color: colors.textTertiary }]}>
            {_relTime}
          </Text>
          {!isOwner && (
            <View>
              <TouchableOpacity
                onPress={() => setShowViewerMenu(!showViewerMenu)}
                onLongPress={() => setShowViewerMenu(true)}
                style={styles.menuBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={t('common.more') || 'More options'}
                accessibilityRole="button"
              >
                <IconMoreHorizontal size={20} color={colors.textSecondary} />
              </TouchableOpacity>
              {showViewerMenu && (
                <>
                  <Pressable
                    style={StyleSheet.absoluteFill}
                    onPress={() => setShowViewerMenu(false)}
                  />
                  <View style={[styles.menuDropdown, {
                    backgroundColor: isDark ? '#1e293b' : '#ffffff',
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
                    ...(isWeb ? { boxShadow: '0 8px 30px rgba(0,0,0,0.12)' } : {}),
                  }]}>
                    {/* Não tenho interesse — adds to chat_feed_negative_signals
                        so the ranker stops surfacing this exact post for this
                        viewer. Collapses the post immediately. */}
                    <TouchableOpacity
                      style={styles.menuItem}
                      onPress={async () => {
                        setShowViewerMenu(false);
                        setHidden(true);
                        try { await api.feedHidePost(post.id, 'not_interested'); } catch {}
                        try { onHidePost?.(post.id); } catch {}
                      }}
                      accessibilityLabel={t('feed.notInterested') || 'Não tenho interesse'}
                      accessibilityRole="button"
                    >
                      <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.text} strokeWidth="2">
                        <Path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                        <Path d="M12 2v10" />
                      </Svg>
                      <Text style={[styles.menuItemText, { color: colors.text }]}>
                        {t('feed.notInterested') || 'Não tenho interesse'}
                      </Text>
                    </TouchableOpacity>
                    {/* Ver menos posts assim — same hide signal + NLP keyword
                        extraction server-side that downweights related topics
                        in feed_user_topics (weight 0.7 = 30% penalty). */}
                    <TouchableOpacity
                      style={styles.menuItem}
                      onPress={async () => {
                        setShowViewerMenu(false);
                        setHidden(true);
                        try { await api.feedHidePost(post.id, 'see_less'); } catch {}
                        try { onHidePost?.(post.id); } catch {}
                      }}
                      accessibilityLabel={t('feed.seeLess') || 'Ver menos posts assim'}
                      accessibilityRole="button"
                    >
                      <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.text} strokeWidth="2">
                        <Path d="M5 12h14" />
                      </Svg>
                      <Text style={[styles.menuItemText, { color: colors.text }]}>
                        {t('feed.seeLess') || 'Ver menos posts assim'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.menuItem}
                      onPress={() => setShowViewerMenu(false)}
                      accessibilityLabel={t('common.cancel') || 'Cancelar'}
                      accessibilityRole="button"
                    >
                      <Text style={[styles.menuItemText, { color: colors.textSecondary }]}>
                        {t('common.cancel') || 'Cancelar'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          )}
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
                      onPress={openAnalytics}
                      accessibilityLabel={t('feed.analytics') || 'Analytics'}
                      accessibilityRole="button"
                    >
                      <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.text} strokeWidth="2">
                        <Path d="M3 3v18h18" />
                        <Path d="M7 14l4-4 4 4 5-5" />
                      </Svg>
                      <Text style={[styles.menuItemText, { color: colors.text }]}>
                        {t('feed.analytics') || 'Análises'}
                      </Text>
                    </TouchableOpacity>
                    {/* Reels P2 — paid boost ("Impulsionar"). Opens a modal with
                        budget tiers ($5/$10/$25/$50/$100) + duration picker.
                        Payment deducts from diamond wallet (1000 diamonds =
                        $9.99). Backend feed_post_promote inserts into
                        chat_feed_promotions and the FYP ranker boosts the
                        score by 1.5x for the active window. */}
                    {/* [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag —
                        "Impulsionar" paid boost flow debits diamonds. */}
                    {MONETIZATION_ENABLED && !post.is_promoted ? (
                      <TouchableOpacity
                        style={styles.menuItem}
                        onPress={() => { setShowMenu(false); setShowPromoteModal(true); }}
                        accessibilityLabel={t('feed.promote') || 'Impulsionar post'}
                        accessibilityRole="button"
                      >
                        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.text} strokeWidth="2">
                          <Path d="M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 20l2-7L2 9h7z" />
                        </Svg>
                        <Text style={[styles.menuItemText, { color: colors.text }]}>
                          {t('feed.promote') || 'Impulsionar'}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity
                      style={styles.menuItem}
                      onPress={handleDelete}
                      accessibilityLabel={t('feed.delete') || 'Delete post'}
                      accessibilityRole="button"
                    >
                      <IconTrash size={16} color={colors.error || '#dc2626'} />
                      <Text style={[styles.menuItemText, { color: colors.error || '#dc2626' }]}>
                        {t('feed.deletePost') || t('feed.delete') || 'Excluir'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.menuItem}
                      onPress={() => setShowMenu(false)}
                      accessibilityLabel={t('common.cancel') || 'Cancelar'}
                      accessibilityRole="button"
                    >
                      <Text style={[styles.menuItemText, { color: colors.textSecondary }]}>
                        {t('common.cancel') || 'Cancelar'}
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
            {post.duet_of ? `${t('feed.duetWith') || 'Dueto com'} @${post.original_author || ''}` : `${t('feed.stitchWith') || 'Stitch com'} @${post.original_author || ''}`}
          </Text>
        </View>
      )}

      {/* Sound info */}
      {post.sound_name && (
        <TouchableOpacity style={[styles.soundBar, { backgroundColor: isDark ? '#1a1a1a' : '#f5f5f5' }]}>
          <IconMusic size={12} color={colors.text} />
          <Text style={[styles.soundText, { color: colors.text, marginLeft: 6 }]} numberOfLines={1}>
            {post.sound_name}{post.sound_artist ? ` - ${post.sound_artist}` : ''}
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
                    // [#img-retry] key includes imageRetry so a retry tap
                    // remounts the <img> and re-fetches the failed URL.
                    key={`img-${resolveMediaUrl(mediaUrls[0])}-${imageRetry}`}
                    src={resolveMediaUrl(mediaUrls[0])}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      filter: getFilterCss(post.filter),
                    }}
                    alt={post.caption || t('feed.image') || 'Image'}
                    onError={() => setImageError(true)}
                    onLoad={() => { if (imageError) setImageError(false); }}
                  />
                  {imageError ? (
                    <Pressable
                      onPress={retryImage}
                      style={styles.imageRetryOverlay}
                      accessibilityRole="button"
                      accessibilityLabel={t?.('common.retry') || t?.('chat.retry') || 'Tentar novamente'}
                    >
                      <View style={styles.imageRetryPill}>
                        <Text style={styles.imageRetryText}>
                          {t?.('common.retry') || t?.('chat.retry') || 'Tentar novamente'}
                        </Text>
                      </View>
                    </Pressable>
                  ) : null}
                </View>
              ) : (
                <View style={styles.mediaFrame}>
                  <_CachedFeedImage
                    // [#img-retry] key forces a remount on retry so the native
                    // loader re-requests the URL instead of holding the failed
                    // attempt.
                    key={`img-${resolveMediaUrl(mediaUrls[0])}-${imageRetry}`}
                    source={{ uri: resolveMediaUrl(mediaUrls[0]) }}
                    style={[StyleSheet.absoluteFill, getNativeFilterStyle(post.filter)]}
                    resizeMode="cover"
                    accessibilityLabel={post.caption || t('feed.image') || 'Image'}
                    onError={() => setImageError(true)}
                    onLoad={() => { if (imageError) setImageError(false); }}
                  />
                  {imageError ? (
                    <Pressable
                      onPress={retryImage}
                      style={styles.imageRetryOverlay}
                      accessibilityRole="button"
                      accessibilityLabel={t?.('common.retry') || t?.('chat.retry') || 'Tentar novamente'}
                    >
                      <View style={styles.imageRetryPill}>
                        <Text style={styles.imageRetryText}>
                          {t?.('common.retry') || t?.('chat.retry') || 'Tentar novamente'}
                        </Text>
                      </View>
                    </Pressable>
                  ) : null}
                </View>
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
                          // [perf] Defer decode/fetch of off-screen carousel
                          // slides — only the first slide is in view on mount,
                          // so the rest load lazily as the user swipes. Pure
                          // browser hint; visuals unchanged.
                          loading={idx === 0 ? 'eager' : 'lazy'}
                          decoding="async"
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
              {/* Dot indicators — opacity is animated via AnimatedCarouselDot
                  so the transition between active/inactive states fades in
                  smoothly instead of snapping. */}
              {mediaUrls.length <= 10 && (
                <View style={styles.dotRow}>
                  <View style={styles.dotPill}>
                    {mediaUrls.map((_, idx) => (
                      <AnimatedCarouselDot
                        key={idx}
                        active={idx === activeMediaIndex}
                      />
                    ))}
                  </View>
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

      {/* Embedded original post (repost) — quoted card showing the original
          author + media thumbnail + caption preview. Tap routes into the
          original post viewer so the user can see the full thing. */}
      {post.original_post ? (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => {
            try {
              const { router } = require('expo-router');
              router.push(`/feed/${post.original_post.id}`);
            } catch {}
          }}
          style={[styles.repostCard, {
            borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)',
            backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)',
          }]}
        >
          {post.original_post.thumbnail_url ? (
            <Image
              source={{ uri: resolveMediaUrl(post.original_post.thumbnail_url) }}
              style={styles.repostThumb}
              resizeMode="cover"
            />
          ) : null}
          <View style={styles.repostBody}>
            <Text style={[styles.repostAuthor, { color: colors.text }]} numberOfLines={1}>
              {post.original_post.author_name || post.original_post.author_email?.split('@')[0]}
            </Text>
            {post.original_post.caption ? (
              <Text style={[styles.repostCaption, { color: colors.textSecondary }]} numberOfLines={2}>
                {post.original_post.caption}
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>
      ) : null}

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
            <IconMessageCircle size={26} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleShare}
            style={styles.actionBtn}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityLabel={t('feed.share') || 'Share'}
            accessibilityRole="button"
          >
            <IconShare size={24} color={colors.text} />
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
              <IconBookmarkFilled size={26} color={colors.text} />
            ) : (
              <IconBookmark size={26} color={colors.text} />
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
            // Long-press the caption surface to translate via AI. Same
            // gesture pattern as WhatsApp message "Traduzir". 350ms delay
            // matches the bookmark-collection long-press elsewhere.
            onLongPress={translateCaption}
            delayLongPress={350}
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
                            router.push(`/hashtag?tag=${encodeURIComponent(handle)}`);
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
          {/* Translation surface: shows when the AI call resolves. Tap the
              "Show original" pill to collapse back to the source text. */}
          {captionTranslating ? (
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 6 }}>
              {t?.('feed.translating') || 'Traduzindo…'}
            </Text>
          ) : null}
          {captionTranslation && captionTranslation !== 'error' ? (
            <View style={{ marginTop: 6 }}>
              <Text style={[styles.captionText, { color: colors.text }]}>
                {captionTranslation}
              </Text>
              <TouchableOpacity onPress={() => setCaptionTranslation(null)} hitSlop={{ top: 4, bottom: 4 }}>
                <Text style={[styles.moreText, { color: colors.textSecondary }]}>
                  {t?.('feed.showOriginal') || 'Ver original'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {captionTranslation === 'error' ? (
            <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 4 }}>
              {t?.('feed.translateError') || 'Não foi possível traduzir.'}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Wave 15: tagged-people chips. Each chip is a tappable shortcut to
          the user's profile. Hidden when tagged_users is empty. We strip
          the email domain so chips look like @handle (matches the
          @mention rendering in the caption). */}
      {Array.isArray(post.tagged_users) && post.tagged_users.length > 0 ? (
        <View style={styles.taggedRow}>
          <Text style={[styles.taggedLabel, { color: colors.textSecondary }]}>
            {t?.('feed.with') || 'com'}
          </Text>
          {post.tagged_users.slice(0, 4).map((em) => {
            const handle = String(em || '').split('@')[0];
            return (
              <TouchableOpacity
                key={em}
                onPress={() => onPressUser?.(em, handle)}
                style={[styles.taggedChip, { backgroundColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.08)' }]}
                accessibilityRole="link"
                accessibilityLabel={'@' + handle}
              >
                <Text style={{ color: ACCENT, fontSize: 12, fontWeight: '600' }}>@{handle}</Text>
              </TouchableOpacity>
            );
          })}
          {post.tagged_users.length > 4 ? (
            <Text style={[styles.taggedLabel, { color: colors.textSecondary }]}>
              +{post.tagged_users.length - 4}
            </Text>
          ) : null}
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
              ? (t('feed.viewOneComment') || 'Ver 1 comentário')
              : (t('feed.viewAllComments') || 'Ver todos os {count} comentários').replace('{count}', commentCount)
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
        const formatted = d.toLocaleDateString(_appLang || undefined, { month: 'long', day: 'numeric' });
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

      {/* Share menu — bottom sheet with Repostar / Compartilhar fora */}
      <Modal visible={shareMenuOpen} transparent animationType="slide" onRequestClose={() => setShareMenuOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={() => setShareMenuOpen(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{ backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 12, paddingBottom: 36 }}
          >
            <View style={{ alignItems: 'center', marginBottom: 6 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border }} />
            </View>
            <TouchableOpacity
              onPress={handleRepost}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, paddingVertical: 16, gap: 14 }}
            >
              <IconShare size={22} color={colors.text} />
              <Text style={{ flex: 1, fontSize: 16, fontWeight: '600', color: colors.text }}>
                {t('feed.repost') || 'Repostar'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleExternalShare}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, paddingVertical: 16, gap: 14 }}
            >
              <IconShare size={22} color={colors.text} />
              <Text style={{ flex: 1, fontSize: 16, fontWeight: '600', color: colors.text }}>
                {t('feed.shareOutside') || 'Compartilhar fora'}
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Analytics modal — owner-only post insights. Lazy-loaded on tap so
          the network only fires for posts the user actually inspects. */}
      <Modal visible={analyticsOpen} animationType="slide" transparent onRequestClose={() => setAnalyticsOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={() => setAnalyticsOpen(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation?.()}
            style={{ backgroundColor: isDark ? '#0f172a' : '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 12, paddingBottom: 24, maxHeight: '80%' }}
          >
            <View style={{ alignItems: 'center', marginBottom: 10 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: isDark ? '#334155' : '#e5e7eb' }} />
            </View>
            <Text style={{ fontSize: 17, fontWeight: '700', textAlign: 'center', color: colors.text, marginBottom: 16 }}>
              {t('feed.analytics') || 'Análises do post'}
            </Text>
            {analyticsLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: 30 }} />
            ) : analyticsData ? (
              <ScrollView style={{ paddingHorizontal: 20 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
                  {[
                    { k: 'views',       label: t('feed.views') || 'Views' },
                    { k: 'reach',       label: t('feed.reach') || 'Reach' },
                    { k: 'impressions', label: t('feed.impressions') || 'Impressions' },
                    { k: 'likes',       label: t('feed.likes') || 'Curtidas' },
                    { k: 'comments',    label: t('feed.comments') || 'Comentários' },
                    { k: 'shares',      label: t('feed.shares') || 'Shares' },
                    { k: 'saves',       label: t('feed.saves') || 'Saves' },
                  ].map(({ k, label }) => (
                    <View key={k} style={{ width: '47%', backgroundColor: isDark ? '#1e293b' : '#f8fafc', borderRadius: 12, padding: 12 }}>
                      <Text style={{ color: colors.textSecondary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' }}>{label}</Text>
                      <Text style={{ color: colors.text, fontSize: 22, fontWeight: '800', marginTop: 4 }}>
                        {Number(analyticsData[k] || 0).toLocaleString()}
                      </Text>
                    </View>
                  ))}
                </View>
                {/* 7-day SVG chart */}
                {Array.isArray(analyticsData.series) && analyticsData.series.length > 0 ? (
                  <View style={{ backgroundColor: isDark ? '#1e293b' : '#f8fafc', borderRadius: 12, padding: 14, marginBottom: 16 }}>
                    <Text style={{ color: colors.textSecondary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginBottom: 8 }}>
                      {t('feed.last7Days') || 'Últimos 7 dias'}
                    </Text>
                    {(() => {
                      const W = 280, H = 80;
                      const pts = analyticsData.series.map(p => Number(p.views || 0));
                      const max = Math.max(1, ...pts);
                      const path = pts.map((v, i) => {
                        const x = (i / (pts.length - 1 || 1)) * W;
                        const y = H - (v / max) * (H - 6) - 3;
                        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
                      }).join(' ');
                      return (
                        <Svg width={W} height={H}>
                          <Path d={path} stroke="#7C3AED" strokeWidth="2" fill="none" />
                        </Svg>
                      );
                    })()}
                  </View>
                ) : null}
                {/* Audience breakdown */}
                {Array.isArray(analyticsData.audience) && analyticsData.audience.length > 0 ? (
                  <View style={{ backgroundColor: isDark ? '#1e293b' : '#f8fafc', borderRadius: 12, padding: 14 }}>
                    <Text style={{ color: colors.textSecondary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginBottom: 6 }}>
                      {t('feed.audience') || 'Audiência'}
                    </Text>
                    {analyticsData.audience.map((a, i) => (
                      <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
                        <Text style={{ color: colors.text, fontSize: 13 }}>{a.dom || a.domain || '—'}</Text>
                        <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{Number(a.n || 0)}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </ScrollView>
            ) : (
              <Text style={{ textAlign: 'center', color: colors.textSecondary, padding: 30 }}>
                {t('feed.analyticsEmpty') || 'Sem dados'}
              </Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Reels P2 — Promote modal (budget tiers + duration).
          [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag. */}
      {MONETIZATION_ENABLED && <PromotePostModal
        visible={showPromoteModal}
        onClose={() => setShowPromoteModal(false)}
        post={post}
        onPromoted={(data) => {
          setShowPromoteModal(false);
          onPostUpdated?.({ ...post, is_promoted: true, sponsored: true, promotion: data });
          try { Alert.alert(t?.('feed.promoteDoneTitle') || 'Post impulsionado', t?.('feed.promoteDoneBody') || `Seu post ficará em destaque por ${data?.duration_days || 7} dias.`); } catch {}
        }}
        colors={colors}
        isDark={isDark}
        t={t}
        submitting={promoteSubmitting}
        setSubmitting={setPromoteSubmitting}
      />}
    </View>
  );
}

// ── Promote post modal ──
// Renders the budget tier picker + duration slider + diamond-cost preview.
// Wallet balance is fetched once when the modal opens; if it's below the
// required diamond cost we surface a soft warning (the backend will still
// reject with 402 on submit). The tip / diamond top-up flow is reused via
// LivePaidGiftSheet's existing buy-pack UI — but threading that here would
// add too much surface; for v1 we just show the shortfall.
function PromotePostModal({ visible, onClose, post, onPromoted, colors, isDark, t, submitting, setSubmitting }) {
  const [tier, setTier] = useState(1000); // cents
  const [days, setDays] = useState(7);
  const [balance, setBalance] = useState(0);

  // Same diamond cost formula as the backend: 1000 diamonds ≈ $9.99 →
  // diamondsCost = ceil((cents/100) * 100.1). Keep in lockstep with
  // feed_post_promote so the preview matches what's actually charged.
  const diamondsCost = Math.ceil((tier / 100) * 100.1);

  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const b = await api.walletBalance?.();
        if (b?.success && b.data) setBalance(Number(b.data.diamond_balance) || 0);
      } catch {}
    })();
  }, [visible]);

  const submit = useCallback(async () => {
    if (submitting || !post?.id) return;
    setSubmitting(true);
    try {
      const r = await api.feedPostPromote?.(post.id, tier, days);
      if (r?.success) {
        onPromoted?.(r.data);
      } else if (r?.data?.code === 'insufficient_diamonds') {
        try { Alert.alert(t?.('feed.promoteInsufficientTitle') || 'Diamantes insuficientes', t?.('feed.promoteInsufficientBody') || 'Compre mais diamantes para impulsionar este post.'); } catch {}
      } else {
        try { Alert.alert(t?.('common.error') || 'Erro', r?.message || 'Promote failed'); } catch {}
      }
    } catch {} finally {
      setSubmitting(false);
    }
  }, [post, tier, days, submitting, setSubmitting, onPromoted, t]);

  const TIERS = [
    { cents: 500,   label: '$5'   },
    { cents: 1000,  label: '$10'  },
    { cents: 2500,  label: '$25'  },
    { cents: 5000,  label: '$50'  },
    { cents: 10000, label: '$100' },
  ];
  const DAYS = [3, 7, 14, 30];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
        onPress={onClose}
      >
        <Pressable
          onPress={(e) => e.stopPropagation && e.stopPropagation()}
          style={{
            backgroundColor: isDark ? '#0F172A' : '#fff',
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            paddingHorizontal: 18, paddingTop: 14, paddingBottom: 28,
          }}
        >
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.18)', alignSelf: 'center', marginBottom: 12 }} />
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 6 }}>
            {t?.('feed.promoteTitle') || 'Impulsionar post'}
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 16 }}>
            {t?.('feed.promoteSubtitle') || 'Apareça para mais pessoas. Pague com diamantes.'}
          </Text>

          <Text style={{ color: colors.textTertiary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
            {t?.('feed.promoteBudget') || 'Orçamento'}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            {TIERS.map(tr => {
              const active = tier === tr.cents;
              return (
                <TouchableOpacity
                  key={tr.cents}
                  onPress={() => setTier(tr.cents)}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: active ? '#7C3AED' : (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)'),
                    backgroundColor: active ? (isDark ? 'rgba(124,58,237,0.22)' : 'rgba(124,58,237,0.10)') : 'transparent',
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={{ color: active ? '#7C3AED' : colors.text, fontWeight: active ? '800' : '600' }}>{tr.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={{ color: colors.textTertiary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
            {t?.('feed.promoteDuration') || 'Duração'}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            {DAYS.map(d => {
              const active = days === d;
              return (
                <TouchableOpacity
                  key={d}
                  onPress={() => setDays(d)}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: active ? '#7C3AED' : (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)'),
                    backgroundColor: active ? (isDark ? 'rgba(124,58,237,0.22)' : 'rgba(124,58,237,0.10)') : 'transparent',
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={{ color: active ? '#7C3AED' : colors.text, fontWeight: active ? '800' : '600' }}>
                    {(t?.('feed.daysN') || '{n} dias').replace('{n}', d)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: isDark ? 'rgba(124,58,237,0.10)' : 'rgba(124,58,237,0.06)', marginBottom: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              {t?.('feed.promoteCost') || 'Custo'}
            </Text>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '800' }}>
              {diamondsCost} ◆
            </Text>
          </View>
          <Text style={{ color: balance >= diamondsCost ? colors.textTertiary : '#ef4444', fontSize: 12, marginBottom: 14 }}>
            {(t?.('feed.promoteBalance') || 'Seu saldo: {n} ◆').replace('{n}', balance)}
          </Text>

          <TouchableOpacity
            onPress={submit}
            disabled={submitting}
            style={{ backgroundColor: '#7C3AED', paddingVertical: 14, borderRadius: 12, alignItems: 'center', opacity: submitting ? 0.6 : 1 }}
            accessibilityRole="button"
            accessibilityLabel={t?.('feed.promoteConfirm') || 'Confirmar impulsionamento'}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800' }}>
                {t?.('feed.promoteConfirm') || 'Impulsionar agora'}
              </Text>
            )}
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
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
    paddingVertical: 11,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  avatarRing: {
    padding: 2,
    borderRadius: 21,
    borderWidth: 1.5,
    borderColor: 'rgba(124,58,237,0.22)',
  },
  headerInfo: {
    flex: 1,
    marginLeft: 11,
  },
  authorName: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.1,
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
  // ⋯ kebab button — subtle circular hit target so it visually groups
  // with the headerTime pill on its left instead of floating as a stray
  // icon. The faint border + tighter padding mirrors the X/Threads kebab.
  menuBtn: {
    padding: 6,
    borderRadius: 14,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
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
  // [#img-retry] Full-frame tap target shown over a broken image. Centered
  // pill keeps the affordance obvious + easy to hit.
  imageRetryOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  imageRetryPill: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  imageRetryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  counterBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  counterText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  dotRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 10,
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  // Translucent backdrop so the inactive white dots stay visible over a
  // bright/white image (Instagram pins the dots inside a soft dark pill).
  dotPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.28)',
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
  repostCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginTop: 8,
    padding: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    // Subtle purple left accent so the quoted post reads as a "reply/quote"
    // block at a glance — mirrors how Threads + X surface reposts.
    borderLeftWidth: 3,
    borderLeftColor: 'rgba(124,58,237,0.4)',
    gap: 10,
  },
  repostThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: '#000',
  },
  repostBody: { flex: 1 },
  repostAuthor: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
  repostCaption: { fontSize: 12 },
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
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 4,
  },
  actionsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionBtn: {
    padding: 8,
  },
  // Content
  likeCountRow: {
    paddingHorizontal: 14,
    paddingTop: 4,
  },
  likeCount: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  captionRow: {
    paddingHorizontal: 14,
    paddingTop: 5,
  },
  captionText: {
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: -0.1,
  },
  captionAuthor: {
    fontWeight: '700',
  },
  moreText: {
    fontSize: 14,
    fontWeight: '500',
    marginTop: 2,
  },
  commentsPreview: {
    paddingHorizontal: 14,
    paddingTop: 6,
  },
  commentsPreviewText: {
    fontSize: 14,
    fontWeight: '500',
  },
  // Wave 15: tagged-people chip row below the caption.
  taggedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingHorizontal: 14,
    paddingTop: 6,
    gap: 6,
  },
  taggedLabel: {
    fontSize: 12,
    marginRight: 2,
  },
  taggedChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
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
