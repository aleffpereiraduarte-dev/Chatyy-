import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TouchableWithoutFeedback, StyleSheet, Modal, Image, Platform,
  Dimensions, Animated, PanResponder, ActivityIndicator, Linking, StatusBar, Alert, FlatList, Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX, IconDownload, IconPlay, IconPause, IconLock, IconCheck, IconShare, IconStar, IconStarFilled, IconMoreHorizontal, IconInfo } from './Icons';
// Wave 14: 3D / depth-photo parallax view. Lazy-loaded so web stays green
// (expo-sensors isn't available in the web bundle).
let ParallaxPortraitView = null;
if (Platform.OS !== 'web') {
  try { ParallaxPortraitView = require('./ParallaxPortraitView').default; } catch {}
}

// expo-screen-capture: prevent screenshots & screen recordings while a
// view-once media is on screen. Android sets FLAG_SECURE (black thumbnail
// in the screenshot, black frames in screen recordings); iOS only fires
// a `screenshotListener` event we react to (FLAG_SECURE has no iOS twin).
// Lazy-loaded so web stays green.
let ScreenCapture = null;
if (Platform.OS !== 'web') {
  try { ScreenCapture = require('expo-screen-capture'); } catch {}
}

// expo-video for native MOV/MP4 playback (SDK 55+)
let ExpoVideo = null;
let useVideoPlayer = null;
if (Platform.OS !== 'web') {
  try {
    const mod = require('expo-video');
    ExpoVideo = mod.VideoView;
    useVideoPlayer = mod.useVideoPlayer;
  } catch {}
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
// HEIC/HEIF are iOS-native captures. Server already transcodes for thumbnails
// (ImageMagick fallback in driveGenerateThumbnail). Listing them here lets the
// fullscreen viewer pick the image branch on iOS, where native ImageIO renders
// HEIC directly. Android falls through to <Image> which on RN 0.83+ also
// decodes HEIC via libheif.
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif'];
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v', '3gp'];
const PDF_EXTS = ['pdf'];
const DOCX_EXTS = ['docx', 'doc'];
const PREVIEWABLE_EXTS = [...PDF_EXTS, ...DOCX_EXTS];

function getExt(filename) {
  return (filename || '').split('.').pop().toLowerCase();
}

function getFullUrl(url) {
  if (!url) return '';
  // If the source is already a local file (e.g. just-recorded outbox audio),
  // hand it back untouched — no normalization, no remote prefix.
  if (typeof url === 'string' && (url.startsWith('file://') || url.startsWith('content://') || url.startsWith('blob:'))) {
    return url;
  }
  // CRITICAL (2026-05-19): route through api.getMediaUrl() so we produce the
  // SAME canonical URL that the chat bubble used at render time (CDN host:
  // media.chatyy.com.br for /data/chat-files/). Previously this hardcoded
  // `https://chatyy.com.br${url}` for relative paths AND left existing
  // chatyy.com.br absolute URLs untouched — but the bubble caches under the
  // CDN-rewritten URL (see app/chat-conversation.js#resolveMediaUri which
  // uses api.getMediaUrl). Result: tap-to-open computed a DIFFERENT
  // urlToKey() hash than the bubble's cache entry, getLocalUriIfCached
  // returned null, the viewer tried to fetch from the origin host (slower /
  // sometimes unreachable behind Cloudflare), and the user saw a blank
  // viewer or eternal spinner ("fotos não tá abrindo no celular"). Routing
  // through api.getMediaUrl unifies the cache lookup with the bubble path.
  let full;
  try {
    const _api = require('../services/api');
    if (_api?.getMediaUrl) {
      full = _api.getMediaUrl(url);
    } else {
      full = url.startsWith('http') ? url : `https://chatyy.com.br${url}`;
    }
  } catch {
    full = url.startsWith('http') ? url : `https://chatyy.com.br${url}`;
  }
  if (!full) full = url.startsWith('http') ? url : `https://chatyy.com.br${url}`;
  // OFFLINE-FIRST: if we already have the file on disk (mediaCache.syncIndex),
  // return that path instead of the CDN URL. ImageViewer / VideoPlayer /
  // PreviewViewer / GenericFileViewer all hand the result straight to native
  // surfaces (RN Image / expo-video / WKWebView / Linking) which accept
  // file:// URIs uniformly. This is the whole "tocando offline" guarantee —
  // when the radio drops mid-stream, native keeps reading from disk and
  // playback never pauses.
  if (Platform.OS !== 'web') {
    try {
      const { getLocalUriIfCached } = require('../services/mediaCache');
      const local = getLocalUriIfCached(full);
      if (local) return local;
      // Belt-and-suspenders: also try the original (non-CDN-rewritten) URL
      // in case the cache was populated by a code path that didn't go
      // through api.getMediaUrl (older sessions, manual saves, etc.).
      if (full !== url && url.startsWith('http')) {
        const alt = getLocalUriIfCached(url);
        if (alt) return alt;
      }
    } catch {}
  }
  // WKWebView (iOS) is strict about reserved-but-unencoded characters in URLs.
  // Filenames sometimes contain "$", spaces, or unicode (e.g. legacy uploads
  // where the filename was "$value.pdf") which makes the WebView refuse to
  // resolve the resource — user sees a blank dark screen. Re-encode anything
  // that isn't already percent-encoded so WKWebView accepts the URL.
  try {
    if (/[ $#?]|[^\x20-\x7E]/.test(full) && !/%[0-9A-Fa-f]{2}/.test(full)) {
      return encodeURI(full);
    }
  } catch {}
  return full;
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// WAVE 60: WhatsApp/IG-grade viewer chrome helpers.
// Initials from sender name or email → 1-2 uppercase chars for the avatar
// circle. Mirrors the chat list pattern.
function senderInitials(name, email) {
  const src = (name && name.trim()) || (email || '').split('@')[0] || '';
  if (!src) return '?';
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}

// Stable color from a string — used for the avatar bg when no photo is
// available. Matches the chat list palette so the same user shows the same
// color across screens.
function colorFromString(str) {
  const palette = ['#7C3AED', '#EC4899', '#F59E0B', '#10B981', '#3B82F6', '#EF4444', '#8B5CF6', '#06B6D4'];
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

// "agora", "5 min", "2 h", "ontem" or short date — IG-style compact label.
function viewerRelativeTime(ts, t) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
  if (!ms || isNaN(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return t?.('time.now') || 'agora';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' min';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' h';
  if (diff < 172800000) return t?.('viewer.yesterday') || 'ontem';
  try {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  } catch {
    return '';
  }
}

// ============================================================
// IMAGE VIEWER with pan/zoom
// ============================================================
// Native UIScrollView+UIImageView for iOS — pinch/zoom 60fps perfect.
// Falls back to the JS PanResponder implementation on Android/web.
let _NativeImageZoomView = null;
if (Platform.OS === 'ios') {
  try { _NativeImageZoomView = require('../modules/expo-native-toolkit').ImageZoomView; } catch {}
  // Try alternative export shape (native modules sometimes export differently)
  if (!_NativeImageZoomView) {
    try {
      const { requireNativeView } = require('expo');
      _NativeImageZoomView = requireNativeView('ExpoNativeImageZoomView');
    } catch {}
  }
}

function NativeImageViewerWithLoading({ url }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryEpoch, setRetryEpoch] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setLoading(false);
        setError('Timeout — a imagem demorou muito pra carregar');
      }
    }, 20000);
    Image.prefetch(url)
      .then(() => {
        if (cancelled) return;
        clearTimeout(timeout);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        clearTimeout(timeout);
        setLoading(false);
        setError('Não consegui carregar a imagem');
      });
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [url, retryEpoch]);

  return (
    <View style={s.mediaContainer}>
      {!loading && !error && (
        <_NativeImageZoomView key={retryEpoch} style={s.mediaContainer} uri={url} />
      )}
      {loading && (
        <View style={[s.mediaContainer, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: 'rgba(255,255,255,0.6)', marginTop: 12, fontSize: 13 }}>
            Carregando imagem...
          </Text>
        </View>
      )}
      {error && (
        <View style={[s.mediaContainer, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 6 }}>
            Ops!
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center', marginBottom: 16 }}>
            {error}
          </Text>
          <TouchableOpacity
            onPress={() => setRetryEpoch(e => e + 1)}
            style={{ backgroundColor: '#7C3AED', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 }}
            accessibilityLabel="Tentar novamente"
            accessibilityRole="button"
          >
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Tentar novamente</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function ImageViewer({ url, messageId, fileSize, createdAt, t, placeholderUri, blurhash, thumbUri }) {
  // We deliberately DO NOT use `_NativeImageZoomView` here even on iOS. The
  // native view downloads via raw URLSession which (a) lacks the loading
  // indicator the user expects and (b) silently fails for some CDN routes.
  // The JS PanResponder implementation below uses RN Image which has a
  // proper `onLoadEnd` event and honors the shared image cache (so the
  // image is already warm from the chat bubble). 60fps zoom still works
  // because scale/translate are driven via useNativeDriver where possible.

  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(null);
  // R2-backed redownload state. When the original URL 404s (cache evicted
  // or CDN purge propagation issue), tap "Baixar de novo" → server returns
  // a fresh CDN/origin/presigned URL → we render that. `freshUrl` overrides
  // `url` once set so the parent doesn't have to be aware.
  const [freshUrl, setFreshUrl] = useState(null);
  const [redownloading, setRedownloading] = useState(false);
  const [redownloadFailed, setRedownloadFailed] = useState(null); // { deleted? }
  // Bump on retry tap → forces RN <Image> to remount + re-fetch (changing
  // the `key` prop is the only reliable way; setting state alone won't
  // re-trigger the network request after onError fired).
  const [retryEpoch, setRetryEpoch] = useState(0);
  // Reset state whenever the URL changes so the spinner stops spinning on
  // the previous image when the modal is opened for a new one.
  useEffect(() => {
    setLoading(true);
    setImageError(null);
    setFreshUrl(null);
    setRedownloading(false);
    setRedownloadFailed(null);
  }, [url]);
  const handleRetry = useCallback(() => {
    setLoading(true);
    setImageError(null);
    setRetryEpoch(e => e + 1);
  }, []);
  const handleRedownload = useCallback(async () => {
    if (!messageId || redownloading) return;
    setRedownloading(true);
    setRedownloadFailed(null);
    try {
      const { requestRedownload } = require('../services/mediaCache');
      const r = await requestRedownload(messageId, url);
      if (r?.ok && (r.localUri || r.url)) {
        setFreshUrl(r.localUri || r.url);
        setImageError(null);
        setLoading(true);
        setRetryEpoch(e => e + 1);
      } else {
        setRedownloadFailed({ deleted: !!r?.deleted, error: r?.error || 'unknown' });
      }
    } catch (e) {
      setRedownloadFailed({ error: 'network' });
    } finally {
      setRedownloading(false);
    }
  }, [messageId, redownloading, url]);
  const effectiveUrl = freshUrl || url;
  const lastScale = useRef(1);
  const lastTranslateX = useRef(0);
  const lastTranslateY = useRef(0);
  const lastTap = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onPanResponderGrant: () => {
        // Double-tap to zoom
        const now = Date.now();
        if (now - lastTap.current < 300) {
          const target = lastScale.current > 1 ? 1 : 2.5;
          Animated.spring(scale, { toValue: target, useNativeDriver: false, friction: 7 }).start();
          if (target === 1) {
            Animated.spring(translateX, { toValue: 0, useNativeDriver: false }).start();
            Animated.spring(translateY, { toValue: 0, useNativeDriver: false }).start();
            lastTranslateX.current = 0;
            lastTranslateY.current = 0;
          }
          lastScale.current = target;
        }
        lastTap.current = now;
      },
      onPanResponderMove: (_, g) => {
        if (lastScale.current > 1) {
          translateX.setValue(lastTranslateX.current + g.dx);
          translateY.setValue(lastTranslateY.current + g.dy);
        }
      },
      onPanResponderRelease: (_, g) => {
        lastTranslateX.current += g.dx;
        lastTranslateY.current += g.dy;
      },
    })
  ).current;

  // Instant blurred placeholder backdrop. Painted BEHIND the high-res photo
  // (and behind the spinner) so the user sees "the right photo, just fuzzy"
  // the moment they tap — instead of staring at a black screen + spinner
  // for the 200-2000ms while the full-res streams in. Priority order
  // matches the bubble: blurhash > base64 LQIP > thumb URL. Falls through
  // to nothing if the message had none of these (older messages pre-LQIP).
  let _PlaceholderImage = Image;
  try { _PlaceholderImage = require('expo-image').Image || Image; } catch {}
  const _hasInstantPreview = !!(blurhash || placeholderUri || thumbUri);

  return (
    <View style={s.mediaContainer}>
      {/* WhatsApp-style blurred preview behind the spinner. blurRadius keeps
          the thumb readable but not "good enough" — encourages the eye to
          stay until the high-res lands. blurhash uses ExpoImage native
          decode (faster than RN Image); thumbUri is the server-side
          small variant; placeholderUri is the embedded base64 LQIP. */}
      {loading && !imageError && _hasInstantPreview && (
        <_PlaceholderImage
          source={blurhash ? { blurhash } : { uri: placeholderUri || thumbUri }}
          style={[s.fullImage, { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }]}
          contentFit="contain"
          resizeMode="contain"
          blurRadius={placeholderUri || thumbUri ? 20 : 0}
          pointerEvents="none"
        />
      )}
      {loading && !imageError && <ActivityIndicator size="large" color="#fff" style={s.loader} />}
      {imageError && (
        <View style={[s.loader, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
          {/* Header copy pivots on the failure type:
              - redownloadFailed.deleted (410)        → "Mensagem apagada"
              - imageError === offline cache-miss     → "Sem internet" (NOT
                "removida do cache" — the photo was never downloaded on this
                device; calling it "removed" misleads the user into thinking
                we deleted their photo).
              - everything else (transient / 404)     → "Mídia indisponível"
                (also more accurate than "removida do cache" — the message
                file may be gone from the server, not from our cache). */}
          {(() => {
            const offlineCopy = t?.('media.offlineCacheMiss') || 'Sem internet — esta mídia ainda não foi baixada.';
            const isOffline = imageError === offlineCopy;
            let header;
            if (redownloadFailed?.deleted) {
              header = t?.('media.messageDeleted') || 'Mensagem apagada';
            } else if (isOffline) {
              header = t?.('media.offlineTitle') || 'Sem internet';
            } else {
              header = t?.('media.fileUnavailable') || 'Mídia indisponível';
            }
            return (
              <>
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 8 }}>
                  {header}
                </Text>
                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center', marginBottom: 4 }} numberOfLines={3}>
                  {redownloadFailed?.deleted
                    ? (t?.('media.messageDeletedHint') || 'O remetente apagou essa mensagem.')
                    : (imageError || '')}
                </Text>
              </>
            );
          })()}
          {/* "Last downloaded X ago" — only shown when we know the createdAt */}
          {!!createdAt && (
            <Text style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, marginBottom: 16 }}>
              {(t?.('media.lastDownloaded') || 'Há {0}').replace('{0}', (() => {
                try { return require('../services/mediaCache').formatRelativeAge(createdAt); }
                catch { return ''; }
              })())}
            </Text>
          )}
          {messageId && !redownloadFailed?.deleted ? (
            <TouchableOpacity
              onPress={handleRedownload}
              disabled={redownloading}
              style={{
                backgroundColor: redownloading ? '#6D28D9' : '#7C3AED',
                paddingHorizontal: 20, paddingVertical: 10,
                borderRadius: 10, flexDirection: 'row', alignItems: 'center',
              }}
              accessibilityLabel={t?.('media.redownload') || 'Baixar de novo'}
              accessibilityRole="button"
            >
              {redownloading ? (
                <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
              ) : (
                <IconDownload size={16} color="#fff" />
              )}
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600', marginLeft: 6 }}>
                {redownloading
                  ? (t?.('media.redownloading') || 'Baixando...')
                  : (t?.('media.redownload') || 'Baixar de novo')}
                {!redownloading && fileSize > 0 ? ` (${formatSize(fileSize)})` : ''}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={handleRetry}
              style={{ backgroundColor: '#7C3AED', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 }}
              accessibilityLabel="Tentar novamente"
              accessibilityRole="button"
            >
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
                {t?.('chat.retry') || 'Tentar novamente'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      <Animated.View
        {...panResponder.panHandlers}
        style={[s.mediaContainer, {
          transform: [
            { scale },
            { translateX },
            { translateY },
          ],
        }]}
      >
        <Image
          key={retryEpoch}
          source={{ uri: effectiveUrl }}
          style={s.fullImage}
          resizeMode="contain"
          onLoadEnd={() => setLoading(false)}
          onError={(e) => {
            setLoading(false);
            // OFFLINE-FIRST: if the URL we tried IS a remote URL (i.e. cache
            // missed BEFORE getFullUrl), one more sync check — the syncIndex
            // may have been populated by a parallel cacheMedia that finished
            // between mount and the Image fetch. Same for retry storms.
            try {
              const { getLocalUriIfCached } = require('../services/mediaCache');
              if (effectiveUrl && !effectiveUrl.startsWith('file://')) {
                const local = getLocalUriIfCached(effectiveUrl);
                if (local && local !== effectiveUrl) {
                  // We have it on disk — switch source and clear error.
                  setFreshUrl(local);
                  setImageError(null);
                  setLoading(true);
                  setRetryEpoch(epc => epc + 1);
                  return;
                }
              }
            } catch {}
            const raw = e?.nativeEvent?.error || '';
            // iOS WKWebView/NSURLSession surfaces NSURLErrorNotConnectedToInternet
            // as the English string "The Internet connection appears to be
            // offline." We catch known offline phrasings (also Android's "Unable
            // to resolve host" etc.) and substitute the localized cache-miss
            // copy. Anything else falls through to the original native message.
            const lower = String(raw).toLowerCase();
            const offlineLike = !raw
              || lower.includes('offline')
              || lower.includes('internet connection')
              || lower.includes('not connected')
              || lower.includes('unable to resolve')
              || lower.includes('no address associated')
              || lower.includes('failed to connect')
              || lower.includes('network connection was lost')
              || lower.includes('-1009')
              || lower.includes('econnreset');
            if (offlineLike) {
              setImageError(t?.('media.offlineCacheMiss') || 'Sem internet — esta mídia ainda não foi baixada.');
            } else {
              setImageError(String(raw));
            }
          }}
        />
      </Animated.View>
    </View>
  );
}

// ============================================================
// NATIVE VIDEO PLAYER
// First tries the AVPlayerLayer-wrapped Expo View from
// expo-native-toolkit (instant + hardware accelerated). Falls back to
// expo-video on Android/web or if the native module isn't loaded.
// ============================================================
let _NativeVideoPlayerView = null;
if (Platform.OS === 'ios') {
  try { _NativeVideoPlayerView = require('../modules/expo-native-toolkit').VideoPlayer; } catch {}
}

function NativeVideoPlayer({ url }) {
  // Prefer expo-video — has native AVPlayerViewController controls,
  // PiP, fullscreen, scrubbing, captions. Custom AVPlayerLayer view
  // exists for perf-sensitive inline playback but has no UI chrome
  // (was leaving the viewer black on first open because props ordering
  // could land uri before autoplay, so no play() ever fired).
  if (useVideoPlayer && ExpoVideo) {
    const player = useVideoPlayer(url, (p) => {
      try { p.loop = false; p.muted = false; p.play(); } catch {}
    });

    // Wave 14 — pinch-to-scrub. Uses react-native-gesture-handler's
    // PinchGestureHandler so the gesture composes cleanly with the
    // existing horizontal swipe-between-photos paging gesture; the
    // pinch's velocity * duration gives us a delta seek per frame.
    // Two-finger spread = scrub forward, pinch = scrub back. Falls back
    // to native controls when RNGH isn't on the path.
    let PinchHandler = null;
    let GH = null;
    try { GH = require('react-native-gesture-handler'); PinchHandler = GH?.PinchGestureHandler; } catch {}

    const pinchState = useRef({ baseTime: 0 });
    const onPinchEvent = useCallback((ev) => {
      try {
        const dur = player?.duration || 0;
        if (!dur || dur < 1) return;
        if (pinchState.current.baseTime <= 0) pinchState.current.baseTime = player.currentTime || 0;
        // scale ranges roughly 0.5..3 — map to delta of ±0.5 * duration
        const delta = (ev.nativeEvent.scale - 1) * dur * 0.5;
        const next = Math.max(0, Math.min(dur, pinchState.current.baseTime + delta));
        try { player.currentTime = next; } catch {}
      } catch {}
    }, [player]);
    const onPinchStateChange = useCallback((ev) => {
      if (ev.nativeEvent.state === GH?.State?.END || ev.nativeEvent.state === GH?.State?.CANCELLED) {
        pinchState.current.baseTime = 0;
      } else if (ev.nativeEvent.state === GH?.State?.BEGAN) {
        pinchState.current.baseTime = player?.currentTime || 0;
      }
    }, [player]);

    const videoNode = (
      <ExpoVideo
        player={player}
        style={s.fullVideo}
        allowsFullscreen
        allowsPictureInPicture
        nativeControls
        contentFit="contain"
      />
    );

    return (
      <View style={s.mediaContainer}>
        {PinchHandler ? (
          <PinchHandler onGestureEvent={onPinchEvent} onHandlerStateChange={onPinchStateChange}>
            {videoNode}
          </PinchHandler>
        ) : videoNode}
      </View>
    );
  }
  if (_NativeVideoPlayerView) {
    return (
      <View style={s.mediaContainer}>
        <_NativeVideoPlayerView
          style={s.fullVideo}
          uri={url}
          autoplay={true}
          loop={false}
          muted={false}
        />
      </View>
    );
  }
  return null;
}

// VIDEO PLAYER (web fallback + native fallback)
// ============================================================
// Modern web video player — custom controls (no <video controls>),
// auto-hide overlay, big center play button, sleek bottom bar with
// progress + time + volume + fullscreen. Click anywhere on video
// toggles play/pause. Spacebar/arrow shortcuts.
// ============================================================
function fmtT(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ModernWebVideoPlayer({ url, videoRef }) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [showCtl, setShowCtl] = useState(true);
  const [buffered, setBuffered] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef(null);
  const hideTimer = useRef(null);
  const progRef = useRef(null);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowCtl(false), 2400);
  }, []);

  useEffect(() => {
    scheduleHide();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [scheduleHide]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener?.('fullscreenchange', onFs);
    return () => document.removeEventListener?.('fullscreenchange', onFs);
  }, []);

  const showAndSchedule = useCallback(() => {
    setShowCtl(true);
    scheduleHide();
  }, [scheduleHide]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); } else { v.pause(); }
  }, [videoRef]);

  const seek = useCallback((pct) => {
    const v = videoRef.current;
    if (!v || !isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.duration * pct));
  }, [videoRef]);

  const seekFromEvent = useCallback((e) => {
    if (!progRef.current) return;
    const rect = progRef.current.getBoundingClientRect();
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    seek(pct);
  }, [seek]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => { setPlaying(true); scheduleHide(); };
    const onPause = () => { setPlaying(false); setShowCtl(true); if (hideTimer.current) clearTimeout(hideTimer.current); };
    const onTime = () => { if (!scrubbing) setPos(v.currentTime || 0); };
    const onMeta = () => { setDur(v.duration || 0); setLoading(false); };
    const onWait = () => setLoading(true);
    const onCanPlay = () => setLoading(false);
    const onProg = () => {
      try {
        if (v.buffered.length && isFinite(v.duration) && v.duration > 0) {
          setBuffered(v.buffered.end(v.buffered.length - 1) / v.duration);
        }
      } catch {}
    };
    const onVol = () => { setMuted(v.muted); setVolume(v.volume); };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('waiting', onWait);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('progress', onProg);
    v.addEventListener('volumechange', onVol);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('waiting', onWait);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('progress', onProg);
      v.removeEventListener('volumechange', onVol);
    };
  }, [videoRef, scrubbing, scheduleHide]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { const v = videoRef.current; if (v) v.currentTime = Math.min(v.duration || 0, (v.currentTime || 0) + 5); showAndSchedule(); }
      else if (e.key === 'ArrowLeft') { const v = videoRef.current; if (v) v.currentTime = Math.max(0, (v.currentTime || 0) - 5); showAndSchedule(); }
      else if (e.key === 'm' || e.key === 'M') { const v = videoRef.current; if (v) v.muted = !v.muted; }
      else if (e.key === 'f' || e.key === 'F') { toggleFs(); }
    };
    document.addEventListener?.('keydown', onKey);
    return () => document.removeEventListener?.('keydown', onKey);
  }, [togglePlay, videoRef, showAndSchedule]);

  const toggleFs = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  }, [videoRef]);

  const pct = dur > 0 ? (pos / dur) * 100 : 0;
  const bufPct = (buffered * 100) || 0;

  return (
    <View style={s.mediaContainer}>
      <div
        ref={containerRef}
        onMouseMove={showAndSchedule}
        onMouseLeave={() => playing && setShowCtl(false)}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          maxWidth: '100%',
          maxHeight: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#000',
          borderRadius: fullscreen ? 0 : 12,
          overflow: 'hidden',
          cursor: showCtl ? 'default' : 'none',
        }}
      >
        <video
          ref={videoRef}
          src={url}
          playsInline
          onClick={togglePlay}
          onDoubleClick={toggleFs}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            width: 'auto',
            height: 'auto',
            objectFit: 'contain',
            cursor: 'pointer',
          }}
        />

        {/* Loading spinner */}
        {loading && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
          }}>
            <div style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              border: '3px solid rgba(255,255,255,0.2)',
              borderTopColor: '#fff',
              animation: 'mvSpin 0.9s linear infinite',
            }} />
          </div>
        )}

        {/* Big center play button (only when paused, not loading) */}
        {!playing && !loading && (
          <button
            onClick={togglePlay}
            aria-label="Reproduzir"
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 84,
              height: 84,
              borderRadius: 42,
              border: 'none',
              background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
              transition: 'transform 0.15s ease, background 0.15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translate(-50%, -50%) scale(1.06)'; e.currentTarget.style.background = 'rgba(0,0,0,0.7)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'translate(-50%, -50%) scale(1)'; e.currentTarget.style.background = 'rgba(0,0,0,0.55)'; }}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="#fff">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        )}

        {/* Bottom controls bar */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: '40px 16px 12px',
            background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.85) 100%)',
            opacity: showCtl ? 1 : 0,
            transition: 'opacity 0.25s ease',
            pointerEvents: showCtl ? 'auto' : 'none',
          }}
        >
          {/* Progress bar */}
          <div
            ref={progRef}
            onMouseDown={(e) => { setScrubbing(true); seekFromEvent(e); }}
            onMouseMove={(e) => { if (e.buttons === 1) seekFromEvent(e); }}
            onMouseUp={() => setScrubbing(false)}
            onMouseLeave={() => setScrubbing(false)}
            onTouchStart={(e) => { setScrubbing(true); seekFromEvent(e); }}
            onTouchMove={seekFromEvent}
            onTouchEnd={() => setScrubbing(false)}
            style={{
              position: 'relative',
              height: 18,
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              marginBottom: 6,
            }}
          >
            <div style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: 4,
              borderRadius: 2,
              background: 'rgba(255,255,255,0.25)',
              overflow: 'hidden',
            }}>
              <div style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${bufPct}%`,
                background: 'rgba(255,255,255,0.35)',
              }} />
              <div style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${pct}%`,
                background: '#7C3AED',
                borderRadius: 2,
                transition: scrubbing ? 'none' : 'width 0.1s linear',
              }} />
            </div>
            <div style={{
              position: 'absolute',
              left: `calc(${pct}% - 7px)`,
              width: 14,
              height: 14,
              borderRadius: 7,
              background: '#fff',
              boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
              transition: scrubbing ? 'none' : 'left 0.1s linear',
              pointerEvents: 'none',
            }} />
          </div>

          {/* Bottom row: play, time, volume, fullscreen */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={togglePlay} aria-label={playing ? 'Pausar' : 'Reproduzir'} style={ctlBtn}>
              {playing ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
              )}
            </button>
            <span style={{ color: '#fff', fontSize: 13, fontWeight: 500, fontVariantNumeric: 'tabular-nums', minWidth: 90 }}>
              {fmtT(pos)} <span style={{ color: 'rgba(255,255,255,0.55)' }}>/ {fmtT(dur)}</span>
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={toggleMute} aria-label={muted ? 'Ativar som' : 'Silenciar'} style={ctlBtn}>
              {muted || volume === 0 ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M3.63 3.63a1 1 0 0 0 0 1.41L7.29 8.7 7 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71v-4.17l4.18 4.18c-.49.37-1.02.68-1.6.91a1 1 0 0 0 .76 1.85c.86-.35 1.66-.83 2.36-1.42l1.27 1.27a1 1 0 0 0 1.41 0 1 1 0 0 0 0-1.41L5.05 3.63a1 1 0 0 0-1.42 0zM19 12a7 7 0 0 0-1.16-3.86l-1.45 1.45A5 5 0 0 1 17 12c0 .67-.13 1.31-.37 1.9l1.51 1.51A7 7 0 0 0 19 12zm-2.5 0a4.5 4.5 0 0 0-.16-1.18l-1.71 1.71v.04l1.6 1.6a4.4 4.4 0 0 0 .27-2.17zM12 4l-1.65 1.65L12 7.3z"/></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M3 10v4a1 1 0 0 0 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71V6.41c0-.89-1.08-1.34-1.71-.71L7 9H4a1 1 0 0 0-1 1zm13.5 2A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v.41a1 1 0 0 0 .68.95A8.01 8.01 0 0 1 20 12a8 8 0 0 1-5.32 7.41A1 1 0 0 0 14 20.36v.41a1 1 0 0 0 1.32.95C19.21 20.4 22 16.52 22 12s-2.79-8.4-6.68-9.72A1 1 0 0 0 14 3.23z"/></svg>
              )}
            </button>
            <button onClick={toggleFs} aria-label={fullscreen ? 'Sair de tela cheia' : 'Tela cheia'} style={ctlBtn}>
              {fullscreen ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
              )}
            </button>
          </div>
        </div>

        {/* Inline keyframes */}
        <style>{`
          @keyframes mvSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        `}</style>
      </div>
    </View>
  );
}

const ctlBtn = {
  width: 36,
  height: 36,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  borderRadius: 18,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 0.15s ease',
};

// ============================================================
function VideoPlayer({ url }) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const videoRef = useRef(null);
  const webVideoRef = useRef(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    return () => {
      if (Platform.OS === 'web') {
        try { webVideoRef.current?.pause(); } catch {}
      } else {
        videoRef.current?.unloadAsync?.().catch(() => {});
      }
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  if (Platform.OS === 'web') {
    return <ModernWebVideoPlayer url={url} videoRef={webVideoRef} />;
  }

  // Native: try expo-video first (best MOV support)
  if (useVideoPlayer && ExpoVideo) {
    return <NativeVideoPlayer url={url} />;
  }

  // Fallback: WebView with video tag. Escape the URL for HTML attribute
  // context — without escaping, a sender-supplied URL containing `"`
  // would close the src attribute and let arbitrary markup/JS execute
  // inside the WebView.
  const safeUrl = String(url || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const { WebView } = require('react-native-webview');
  return (
    <View style={s.mediaContainer}>
      <WebView
        source={{ html: `<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><video controls autoplay playsinline style="max-width:100%;max-height:100%;object-fit:contain"><source src="${safeUrl}" type="video/mp4" /><source src="${safeUrl}" type="video/quicktime" /></video></body></html>` }}
        style={s.fullVideo}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        onLoad={() => setLoading(false)}
      />
      {loading && <ActivityIndicator size="large" color="#fff" style={s.loader} />}
    </View>
  );
}

// ============================================================
// Build preview.html URL for PDF/DOCX files
// ============================================================
function buildPreviewUrl(fileUrl, fileName) {
  const ext = getExt(fileName);
  const typeMap = { pdf: 'pdf', docx: 'docx', doc: 'docx' };
  const type = typeMap[ext] || '';
  return `/preview.html?url=${encodeURIComponent(fileUrl)}&type=${encodeURIComponent(type)}&name=${encodeURIComponent(fileName || 'file')}`;
}

// ============================================================
// PREVIEW VIEWER (PDF/DOCX)
// iOS WKWebView bug: PDFs inside <iframe> show blank. Workaround: load the
// PDF URL DIRECTLY as the WebView source — WKWebView has native PDF rendering
// when the PDF is the document root (not embedded).
// Android / web: iframe via preview.html works fine.
// Office docs (doc/xlsx): google viewer iframe works on Android + web; on iOS
// WKWebView handles the iframe OK because the inner content is HTML (not PDF).
// ============================================================
function PreviewViewer({ url, filename, messageId, fileSize, t }) {
  const ext = getExt(filename);
  const isPdf = ext === 'pdf';
  const fullFileUrl = getFullUrl(url);
  const previewUrl = buildPreviewUrl(url, filename);

  if (Platform.OS === 'web') {
    return (
      <View style={[s.mediaContainer, { alignItems: 'stretch', justifyContent: 'flex-start', width: '100%' }]}>
        <iframe
          src={previewUrl}
          style={{ width: '100%', height: SCREEN_H - 100, minHeight: 400, border: 'none', borderRadius: 8 }}
          title={filename}
        />
      </View>
    );
  }

  // Native
  try {
    const { WebView } = require('react-native-webview');
    // iOS: load the PDF URL directly so WKWebView uses its built-in PDF reader.
    // Any other platform/ext: use preview.html wrapper (gives us the Baixar header).
    const source = isPdf && Platform.OS === 'ios'
      ? { uri: fullFileUrl }
      : { uri: getFullUrl(previewUrl) };
    return <WebViewWithErrorFallback source={source} url={url} filename={filename} messageId={messageId} fileSize={fileSize} t={t} />;
  } catch {
    // Fallback if WebView not available
    return (
      <GenericFileViewer url={url} filename={filename} fileSize={fileSize || 0} messageId={messageId} t={t} />
    );
  }
}

// Wrapper around WebView that shows a friendly "file unavailable" state when
// the HTTP response is 4xx/5xx. Before this guard, iOS would show a blank
// black screen (WKWebView's default for failed PDF loads) and the user had
// no idea whether the file was gone, their network was down, or the app
// was broken.
function WebViewWithErrorFallback({ source, url, filename, messageId, fileSize, t }) {
  const { WebView } = require('react-native-webview');
  const [errored, setErrored] = useState(null); // { code, description } | null
  const [redownloading, setRedownloading] = useState(false);
  const [redownloadedSource, setRedownloadedSource] = useState(null);
  const [redownloadFailed, setRedownloadFailed] = useState(null);
  const handleRedownload = useCallback(async () => {
    if (!messageId || redownloading) return;
    setRedownloading(true);
    setRedownloadFailed(null);
    try {
      const { requestRedownload } = require('../services/mediaCache');
      const r = await requestRedownload(messageId, url);
      if (r?.ok && (r.localUri || r.url)) {
        setRedownloadedSource({ uri: r.localUri || r.url });
        setErrored(null);
      } else {
        setRedownloadFailed({ deleted: !!r?.deleted, error: r?.error || 'unknown' });
      }
    } catch {
      setRedownloadFailed({ error: 'network' });
    } finally {
      setRedownloading(false);
    }
  }, [messageId, redownloading, url]);
  if (errored) {
    return (
      <View style={[s.mediaContainer, { justifyContent: 'center', alignItems: 'center', padding: 24 }]}>
        <View style={[s.fileIcon, { backgroundColor: '#EF4444' + '22' }]}>
          <Text style={[s.fileExtText, { color: '#EF4444' }]}>!</Text>
        </View>
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 16, textAlign: 'center' }}>
          {redownloadFailed?.deleted
            ? (t?.('media.messageDeleted') || 'Mensagem apagada')
            : (errored.code === 404
                ? (t?.('media.cacheEvicted') || 'Mídia removida do cache')
                : (t?.('media.fileUnavailable') || 'Arquivo indisponível'))}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 6, textAlign: 'center' }}>
          {redownloadFailed?.deleted
            ? (t?.('media.messageDeletedHint') || 'O remetente apagou essa mensagem.')
            : (errored.code === 404
                ? (t?.('media.cacheEvictedHint') || 'Toque em "Baixar de novo" para recuperar do servidor.')
                : (errored.code === 0
                    // code 0 = native onError (network/offline) — surface
                    // localized copy, NOT the raw English NSURLError message.
                    ? (t?.('media.offlineCacheMiss') || 'Sem internet — esta mídia ainda não foi baixada.')
                    : (t?.('media.fileUnavailableHint') || 'Não foi possível carregar. Tente novamente em alguns segundos.')))}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 12, textAlign: 'center' }} numberOfLines={2}>
          {filename}
        </Text>
        {messageId && !redownloadFailed?.deleted && (
          <TouchableOpacity
            onPress={handleRedownload}
            disabled={redownloading}
            style={{
              marginTop: 16,
              backgroundColor: redownloading ? '#6D28D9' : '#7C3AED',
              paddingHorizontal: 20, paddingVertical: 10,
              borderRadius: 10, flexDirection: 'row', alignItems: 'center',
            }}
            accessibilityLabel={t?.('media.redownload') || 'Baixar de novo'}
            accessibilityRole="button"
          >
            {redownloading ? (
              <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
            ) : (
              <IconDownload size={16} color="#fff" />
            )}
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600', marginLeft: 6 }}>
              {redownloading
                ? (t?.('media.redownloading') || 'Baixando...')
                : (t?.('media.redownload') || 'Baixar de novo')}
              {!redownloading && fileSize > 0 ? ` (${formatSize(fileSize)})` : ''}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }
  const effectiveSource = redownloadedSource || source;
  // Use a stretched container — `s.mediaContainer` has `alignItems:'center'`
  // which collapses the WebView to its intrinsic width (0px) on iOS,
  // producing the dark/blank PDF screen the user reported. Override the
  // alignment so the WebView fills the modal.
  return (
    <View style={[s.mediaContainer, { alignItems: 'stretch', justifyContent: 'flex-start', width: '100%' }]}>
      <WebView
        source={effectiveSource}
        style={{ flex: 1, width: '100%', backgroundColor: '#fff' }}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        allowsInlineMediaPlayback
        bounces={false}
        originWhitelist={['*']}
        renderLoading={() => <ActivityIndicator size="large" color="#fff" style={s.loader} />}
        onHttpError={(e) => {
          const code = e?.nativeEvent?.statusCode;
          if (code && code >= 400) setErrored({ code, description: e?.nativeEvent?.description });
        }}
        onError={(e) => {
          setErrored({ code: 0, description: e?.nativeEvent?.description || 'load error' });
        }}
      />
    </View>
  );
}

// ============================================================
// GENERIC FILE VIEWER (download-only fallback)
// ============================================================
function GenericFileViewer({ url, filename, fileSize, messageId, t }) {
  const ext = getExt(filename);
  const [resolvedUrl, setResolvedUrl] = useState(url);
  const [redownloading, setRedownloading] = useState(false);
  const [redownloadDone, setRedownloadDone] = useState(false);
  const [redownloadFailed, setRedownloadFailed] = useState(null);
  // Fire a redownload when the user taps the secondary button — useful when
  // the file_url is stale and the original Linking.openURL would 404 in
  // Safari/Chrome. After it resolves, swap the download button's target URL.
  const handleRedownload = useCallback(async () => {
    if (!messageId || redownloading) return;
    setRedownloading(true);
    setRedownloadFailed(null);
    try {
      const { requestRedownload } = require('../services/mediaCache');
      const r = await requestRedownload(messageId, url);
      if (r?.ok && (r.localUri || r.url)) {
        setResolvedUrl(r.localUri || r.url);
        setRedownloadDone(true);
      } else {
        setRedownloadFailed({ deleted: !!r?.deleted, error: r?.error || 'unknown' });
      }
    } catch {
      setRedownloadFailed({ error: 'network' });
    } finally {
      setRedownloading(false);
    }
  }, [messageId, redownloading, url]);

  return (
    <View style={[s.mediaContainer, { justifyContent: 'center', alignItems: 'center' }]}>
      <View style={s.fileIcon}>
        <Text style={s.fileExtText}>{ext.toUpperCase()}</Text>
      </View>
      <Text style={s.fileNameText} numberOfLines={2}>{filename}</Text>
      {fileSize > 0 && <Text style={s.fileSizeText}>{formatSize(fileSize)}</Text>}
      <TouchableOpacity
        style={s.openExternalBtn}
        onPress={() => Linking.openURL(resolvedUrl).catch(() => {})}
        accessibilityLabel="Download"
        accessibilityRole="button"
      >
        <IconDownload size={18} color="#fff" />
        <Text style={s.openExternalText}>
          {t?.('chat.openOrDownload') || 'Abrir / Baixar'}
        </Text>
      </TouchableOpacity>
      {messageId ? (
        <TouchableOpacity
          onPress={handleRedownload}
          disabled={redownloading || redownloadFailed?.deleted}
          style={{
            marginTop: 12,
            paddingHorizontal: 14, paddingVertical: 8,
            borderRadius: 8, flexDirection: 'row', alignItems: 'center',
            opacity: redownloading ? 0.7 : 1,
          }}
          accessibilityLabel={t?.('media.redownload') || 'Baixar de novo'}
          accessibilityRole="button"
        >
          {redownloading && <ActivityIndicator size="small" color="#7C3AED" style={{ marginRight: 8 }} />}
          <Text style={{ color: '#A78BFA', fontSize: 13, fontWeight: '500' }}>
            {redownloadFailed?.deleted
              ? (t?.('media.messageDeleted') || 'Mensagem apagada')
              : redownloadDone
                ? (t?.('media.redownloaded') || 'Atualizado a partir do servidor')
                : redownloading
                  ? (t?.('media.redownloading') || 'Baixando...')
                  : (t?.('media.redownload') || 'Baixar de novo')}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// ============================================================
// MAIN MODAL
// ============================================================
export default function ChatMediaViewer({ visible, onClose, fileUrl, hlsUrl, fileName, fileSize, type, viewOnce, mediaList, initialIndex, conversationId, messageId, senderName, senderEmail, createdAt, t, colors }) {
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // WAVE 60: WhatsApp/IG-grade viewer chrome. The ugly "IMG_1234.jpg 299KB"
  // header is gone — we now show sender avatar + name + relative time, and
  // tap on the photo toggles bars (parity with IG). The filename + bytes
  // moved into the info sheet (long-press More menu) so power users still
  // have access without the cellphone-camera-file-name being the first
  // thing the user sees.
  const [_chromeVisible, _setChromeVisible] = useState(true);
  const [_infoSheetOpen, _setInfoSheetOpen] = useState(false);
  const [_starred, _setStarred] = useState(false);
  const _chromeOpacity = useRef(new Animated.Value(1)).current;
  const _toggleChrome = useCallback(() => {
    _setChromeVisible(v => {
      const next = !v;
      Animated.timing(_chromeOpacity, {
        toValue: next ? 1 : 0,
        duration: 220,
        useNativeDriver: true,
      }).start();
      return next;
    });
  }, [_chromeOpacity]);
  // Reset chrome to visible whenever a new media is opened so the user
  // doesn't open a fresh image and find a bare black screen.
  useEffect(() => {
    if (!visible) return;
    _setChromeVisible(true);
    _setInfoSheetOpen(false);
    _chromeOpacity.setValue(1);
  }, [visible, _chromeOpacity]);

  // Build the effective array. When the caller passes mediaList we render
  // FlatList horizontal with paging + neighbor preload (Instagram pattern).
  // Otherwise fall back to the single-item view (existing behavior preserved).
  const _list = (Array.isArray(mediaList) && mediaList.length > 0)
    ? mediaList
    : (visible ? [{ fileUrl, hlsUrl, fileName, fileSize, type }] : []);
  const _initial = Math.max(0, Math.min(_list.length - 1, Number(initialIndex) || 0));
  const [_currentIdx, _setCurrentIdx] = useState(_initial);
  // Reset on every open so reopening from a different index doesn't restore
  // the previous viewer position.
  useEffect(() => { if (visible) _setCurrentIdx(_initial); }, [visible, _initial]);

  // Block screenshots / screen recording while a view-once media is on
  // screen. Android: FLAG_SECURE makes thumbnails + screen recordings show
  // black frames. iOS: prevent-flag is a no-op (Apple won't expose it),
  // but we still register a screenshot listener so we can render a
  // watermark overlay (user email + timestamp) — anyone who screenshots
  // captures the overlay and is identifiable. Cleanup releases the flag
  // on unmount so other screens (gallery, etc.) stay screenshottable.
  const [_watermarkVisible, _setWatermarkVisible] = useState(false);
  const [_currentUserEmail, _setCurrentUserEmail] = useState('');
  useEffect(() => {
    if (!visible || !viewOnce || !ScreenCapture) return;
    // Resolve current user email lazily so the import stays optional.
    try {
      const auth = require('../context/AuthContext');
      // Hooks can't run here — we read straight from SecureStore mirror.
      const SecureStore = require('expo-secure-store');
      SecureStore.getItemAsync?.('current_user_email').then((e) => {
        if (e) _setCurrentUserEmail(String(e));
      }).catch(() => {});
    } catch {}
    let sub;
    (async () => {
      try { await ScreenCapture.preventScreenCaptureAsync('chatyy-view-once'); } catch {}
      try {
        sub = ScreenCapture.addScreenshotListener?.(() => {
          // Make the watermark immediately visible so the *next* attempt
          // (or a screen recording running in parallel) captures it. We
          // also keep it on for a few seconds in case the user tries
          // again. The watermark is the recipient's own email — the
          // sender doesn't see it on their side because they're never
          // marked as "viewing" their own view-once media.
          _setWatermarkVisible(true);
          setTimeout(() => _setWatermarkVisible(false), 6000);
          // Notify the peer that this user just took a screenshot. Backend
          // (chat.php case 'chat_screenshot_event') inserts a system msg
          // with subtype='screenshot' and emits a WS event so both sides
          // see the system bubble in real time. Fire-and-forget — if the
          // backend hasn't shipped yet this 400s silently and the local
          // watermark UX still works.
          if (conversationId) {
            try {
              const api = require('../services/api');
              api.apiCall?.('chat_screenshot_event', {
                conversation_id: conversationId,
                message_id: messageId || 0,
              }, 'POST').catch(() => {});
            } catch {}
          }
        });
      } catch {}
    })();
    return () => {
      try { sub?.remove?.(); } catch {}
      try { ScreenCapture.allowScreenCaptureAsync?.('chatyy-view-once'); } catch {}
      _setWatermarkVisible(false);
    };
  }, [visible, viewOnce]);

  // Preload neighbors so swipe between is instant. Image.prefetch on RN +
  // ExpoImage.prefetch when available.
  useEffect(() => {
    if (!visible || _list.length < 2) return;
    const neighbors = [];
    if (_currentIdx + 1 < _list.length) neighbors.push(_list[_currentIdx + 1]);
    if (_currentIdx - 1 >= 0) neighbors.push(_list[_currentIdx - 1]);
    for (const n of neighbors) {
      if (!n?.fileUrl) continue;
      const u = getFullUrl(n.fileUrl);
      const isImg = n.type === 'image' || IMAGE_EXTS.includes(getExt(n.fileName));
      if (!isImg) continue;
      try { Image.prefetch?.(u); } catch {}
      try { require('expo-image').Image.prefetch?.(u); } catch {}
    }
  }, [visible, _currentIdx, _list]);

  // HLS offline manifest resolution. When the active item is a video AND we
  // have a previously-downloaded m3u8 sitting at
  // `documentDirectory/video-offline/<messageId>/index.m3u8`, swap the player
  // source to that local file:// URI. Without this, an offline user sees
  // VideoPlayer spin forever because expo-video can't fetch the manifest
  // tree off the network. _hlsLocalUri === '' means "no cache available";
  // null means "haven't checked yet" (player keeps streaming URL).
  // _hlsOffline = true when device is offline AND no cache exists → render
  // the "Vídeo não disponível offline" message instead of mounting the
  // player at all.
  const [_hlsLocalUri, _setHlsLocalUri] = useState(null);
  const [_hlsOfflineUnavailable, _setHlsOfflineUnavailable] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web' || !visible) {
      _setHlsLocalUri(null);
      _setHlsOfflineUnavailable(false);
      return;
    }
    const it = _list[_currentIdx];
    if (!it) return;
    const itType = it.type;
    const itHls = it.hlsUrl;
    const itFileUrl = it.fileUrl;
    if (itType !== 'video') {
      _setHlsLocalUri(null);
      _setHlsOfflineUnavailable(false);
      return;
    }
    // Pick a stable video id — the message id is what cacheHlsVideo uses.
    const vidId = it.messageId || it.id || messageId;
    if (!vidId) {
      _setHlsLocalUri('');
      _setHlsOfflineUnavailable(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const hlsMod = require('../services/hlsOffline');
        const local = await hlsMod.getLocalManifest?.(String(vidId));
        if (cancelled) return;
        if (local) {
          // Normalize to a file:// URI — expo-video wants the scheme.
          _setHlsLocalUri(local.startsWith('file://') ? local : 'file://' + local);
          _setHlsOfflineUnavailable(false);
          return;
        }
        _setHlsLocalUri('');
        // No cache. If we're also offline, surface "not available offline"
        // rather than letting the player spin on a dead URL. HLS manifests
        // resolved via .m3u8 will never paint without the network.
        const isHlsSource = (itHls && String(itHls).toLowerCase().includes('.m3u8'))
          || (itFileUrl && String(itFileUrl).toLowerCase().includes('.m3u8'));
        if (!isHlsSource) {
          // mp4 path — VideoPlayer + getFullUrl already handle file:// cache.
          _setHlsOfflineUnavailable(false);
          return;
        }
        try {
          const ni = require('../services/networkInfo');
          const t = ni.getNetworkType?.();
          _setHlsOfflineUnavailable(t === 'none');
        } catch {
          _setHlsOfflineUnavailable(false);
        }
      } catch {
        if (!cancelled) {
          _setHlsLocalUri('');
          _setHlsOfflineUnavailable(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [visible, _currentIdx, _list, messageId]);

  // OFFLINE-FIRST: when the viewer opens, force a disk cache for the active
  // item. The user's tap = explicit intent → bypass the cellular gate so
  // video/document downloads happen even when policy says wifi-only. Once
  // cached, future opens read from disk and survive network drops.
  useEffect(() => {
    if (!visible || Platform.OS === 'web') return;
    const it = _list[_currentIdx];
    if (!it?.fileUrl) return;
    // Skip if already a local URI (outbox / just-saved).
    if (it.fileUrl.startsWith('file://') || it.fileUrl.startsWith('content://')) return;
    // CRITICAL (2026-05-19 #2): use api.getMediaUrl so the cache-write key
    // matches the cache-read key in getFullUrl(). Previously hardcoded
    // `https://chatyy.com.br${url}` which hashed under a DIFFERENT key
    // (different hostname) than the Image source above (which is
    // media.chatyy.com.br via getMediaUrl). Result: this useEffect was
    // downloading a SECOND copy of every photo under a key that nobody else
    // ever looks up, while the cache lookup in getFullUrl kept missing → user
    // saw "Mídia removida do cache" even though we technically had the file
    // on disk under the wrong key.
    let absolute;
    try {
      const _api = require('../services/api');
      absolute = _api?.getMediaUrl ? _api.getMediaUrl(it.fileUrl)
        : (it.fileUrl.startsWith('http') ? it.fileUrl : `https://chatyy.com.br${it.fileUrl}`);
    } catch {
      absolute = it.fileUrl.startsWith('http') ? it.fileUrl : `https://chatyy.com.br${it.fileUrl}`;
    }
    try {
      const { getLocalUriIfCached, cacheMedia } = require('../services/mediaCache');
      if (getLocalUriIfCached(absolute)) return; // already cached
      cacheMedia(absolute, {
        force: true,
        conversationId: conversationId != null ? conversationId : undefined,
      }).catch(() => {});
    } catch {}
  }, [visible, _currentIdx, _list, conversationId]);

  if (!visible) return null;

  const _active = _list[_currentIdx] || _list[0];
  // Privacy belt-and-suspenders: when the active item has no fileUrl (most
  // common shape for a deleted msg after the per-bubble strip), the viewer
  // has nothing to display. Auto-close instead of rendering a blank/
  // last-frame placeholder that could surface a still-cached image. The
  // viewOnce flow still opens with an empty URL intentionally (the pill
  // owns its own loading state) so we leave that path untouched.
  if (!viewOnce && (!_active || !_active.fileUrl)) {
    // useEffect can't be added below an early return — invoke onClose via
    // microtask so React unwinds cleanly without dropping a "setState in
    // render" warning.
    try { Promise.resolve().then(() => onClose && onClose()); } catch {}
    return null;
  }

  // Prefer HLS playlist for videos when available (chunk-streamed, <500ms
  // first frame). Falls back to the progressive mp4 fileUrl when HLS isn't
  // generated yet (transcode is async during chat_send).
  //
  // OFFLINE WIN: when hlsOffline.getLocalManifest() returned a file:// URI
  // (resolved in the effect above), substitute it for the streaming URL so
  // expo-video reads the rewritten manifest + .ts segments off disk. This is
  // the user-visible fix for "video bubble spins forever on a dropped wifi".
  let url = (_active?.type === 'video' && _active?.hlsUrl)
    ? getFullUrl(_active.hlsUrl)
    : getFullUrl(_active?.fileUrl);
  if (_active?.type === 'video' && _hlsLocalUri && typeof _hlsLocalUri === 'string'
      && _hlsLocalUri.startsWith('file://')) {
    url = _hlsLocalUri;
  }
  const ext = getExt(_active?.fileName);
  const isImage = _active?.type === 'image' || IMAGE_EXTS.includes(ext);
  const isVideo = _active?.type === 'video' || VIDEO_EXTS.includes(ext);
  const isPreviewable = PREVIEWABLE_EXTS.includes(ext);
  const _activeFileName = _active?.fileName;
  const _activeFileSize = _active?.fileSize;
  // media_kind tagging (set by the backup pipeline via photos_set_media_kind).
  // Used to surface a small "LIVE" / "BURST" / "SLO-MO" / "RAW" badge so
  // recipients know the format up front. Falls back to no badge when unset.
  const _activeMediaKind = _active?.mediaKind || _active?.media_kind || null;
  const _multi = _list.length > 1;

  const handleDownload = async () => {
    if (viewOnce) return;
    if (Platform.OS === 'web') {
      // Stream as blob to avoid opening media.chatyy in a new tab
      try {
        setSaving(true);
        const res = await fetch(url, { credentials: 'include' });
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = fileName || 'download';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch {
        // Fallback (still in same tab)
        window.location.href = url;
      } finally {
        setSaving(false);
      }
    } else {
      // Save to device gallery (like WhatsApp)
      try {
        setSaving(true);
        const ML = require('expo-media-library');
        const perm = await ML.requestPermissionsAsync(true); // true = write access
        if (perm.status !== 'granted' && perm.accessPrivileges !== 'all') {
          Alert.alert('Permissão necessária', 'Vá em Ajustes > Chatyy > Fotos e selecione "Todas as fotos".');
          setSaving(false);
          return;
        }
        // SDK 55 moved the download API; the legacy shim still exposes
        // downloadAsync + copyAsync + deleteAsync which is all we need here.
        let FS;
        try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }

        let sourceUri = url;

        // If the URL is already a local file:// (from mediaCache), skip the
        // download step entirely — FS.downloadAsync of a file:// URL fails
        // with "unsupported scheme" on iOS.
        if (!sourceUri.startsWith('file://')) {
          // Download remote URL to a temp file so MediaLibrary can ingest it.
          const ext = (fileName || sourceUri.split('/').pop() || 'file').split('?')[0].split('.').pop() || 'jpg';
          const tempPath = FS.cacheDirectory + 'chatyy_save_' + Date.now() + '.' + ext;
          const download = await FS.downloadAsync(sourceUri, tempPath);
          if (!download?.uri || (download.status && download.status >= 400)) {
            Alert.alert('Erro', `Download falhou (status ${download?.status || '?'}).`);
            setSaving(false);
            return;
          }
          sourceUri = download.uri;
        }

        // Save to gallery — try createAssetAsync first (creates a proper
        // PHAsset with full EXIF). Fallback to saveToLibraryAsync which
        // works even in restricted-access mode.
        let ok = false;
        try {
          const asset = await ML.createAssetAsync(sourceUri);
          if (asset) ok = true;
        } catch (saveErr) {
          try {
            await ML.saveToLibraryAsync(sourceUri);
            ok = true;
          } catch (saveErr2) {
            Alert.alert('Erro ao salvar', String(saveErr2?.message || saveErr?.message || 'Verifique as permissões de Fotos em Ajustes > Chatyy'));
          }
        }
        if (ok) {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        }
        // Cleanup temp file if we created one
        if (sourceUri !== url && sourceUri.startsWith(FS.cacheDirectory)) {
          FS.deleteAsync(sourceUri, { idempotent: true }).catch(() => {});
        }
      } catch (e) {
        Alert.alert('Erro ao salvar', String(e?.message || 'Verifique a permissão de fotos nas configurações.'));
      } finally {
        setSaving(false);
      }
    }
  };

  // View-once: block context menu and screenshots on web
  const viewOnceStyle = viewOnce && Platform.OS === 'web' ? {
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTouchCallout: 'none',
    pointerEvents: 'auto',
  } : {};

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View
        style={[s.backdrop, viewOnceStyle]}
        onContextMenu={viewOnce ? (e) => e.preventDefault?.() : undefined}
      >
        {/* View-once watermark — appears after a screenshot is detected
            (iOS) so the captured image carries the viewer's email +
            timestamp. The overlay is intentionally semi-transparent so
            it doesn't ruin the legitimate viewing experience, but is
            still readable in any saved capture or screen recording. */}
        {viewOnce && _watermarkVisible && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              alignItems: 'center', justifyContent: 'center', zIndex: 9999,
            }}
          >
            <Text style={{
              color: 'rgba(255,255,255,0.55)', fontSize: 22, fontWeight: '700',
              transform: [{ rotate: '-22deg' }], textAlign: 'center',
              textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4,
            }}>
              {(_currentUserEmail || 'chatyy.com.br') + '\n' + new Date().toLocaleString()}
            </Text>
          </View>
        )}
        {/* WAVE 60: Header modernizado WhatsApp/IG-grade. Antes: nome
            "IMG_xxx.jpg" + "299 KB" feio. Agora: avatar do sender + nome
            + tempo relativo no centro, X à esquerda, More à direita.
            Filename + bytes movidos pro InfoSheet (toque em More) — info
            técnica continua acessível pra power users sem poluir a UI.
            Bars (top + bottom) fazem fade via _chromeOpacity quando o user
            toca na foto (parity Instagram). */}
        <Animated.View
          pointerEvents={_chromeVisible ? 'auto' : 'none'}
          style={[
            s.headerBar,
            {
              paddingTop: Math.max(insets.top, 12) + 6,
              opacity: _chromeOpacity,
            },
          ]}
        >
          <TouchableOpacity
            onPress={onClose}
            style={s.headerIconBtn}
            hitSlop={14}
            accessibilityLabel={(typeof t === 'function' && t('common.close')) || 'Fechar'}
            accessibilityRole="button"
          >
            <IconX size={24} color="#fff" />
          </TouchableOpacity>

          <View style={s.headerCenter}>
            {/* Sender row — avatar circle (initials, stable color) + name +
                relative time. Falls back to "Mídia" header when there's no
                sender (rare; happens for outbox previews where sender
                wasn't piped through yet). */}
            {(senderName || senderEmail) ? (
              <View style={s.senderRow}>
                <View style={[s.avatar, { backgroundColor: colorFromString(senderEmail || senderName || '') }]}>
                  <Text style={s.avatarText}>{senderInitials(senderName, senderEmail)}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {viewOnce && <IconLock size={12} color="#fff" />}
                    <Text style={s.senderName} numberOfLines={1}>
                      {senderName || (senderEmail || '').split('@')[0]}
                    </Text>
                  </View>
                  <Text style={s.senderMeta} numberOfLines={1}>
                    {viewOnce
                      ? ((typeof t === 'function' && t('chat.viewOnceLabel')) || 'Visualização única')
                      : viewerRelativeTime(createdAt || _active?.createdAt || _active?.created_at, t)}
                  </Text>
                </View>
              </View>
            ) : (
              <View style={s.senderRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {viewOnce && <IconLock size={14} color="#fff" />}
                    <Text style={s.senderName} numberOfLines={1}>
                      {isImage ? ((typeof t === 'function' && t('viewer.imageLabel')) || 'Foto')
                        : isVideo ? ((typeof t === 'function' && t('viewer.videoLabel')) || 'Vídeo')
                        : ((typeof t === 'function' && t('viewer.fileLabel')) || 'Arquivo')}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Pills row — page count "3/12" + media_kind LIVE/BURST/etc.
                Sit under the sender so the title line stays clean. */}
            {(_multi || (_activeMediaKind && _activeMediaKind !== 'regular')) && (
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, marginLeft: 40 }}>
                {_multi && (
                  <View style={s.pill}>
                    <Text style={s.pillText}>{`${_currentIdx + 1} / ${_list.length}`}</Text>
                  </View>
                )}
                {_activeMediaKind && _activeMediaKind !== 'regular' && (() => {
                  const LABELS = {
                    live_photo: 'LIVE', burst: 'BURST', slowmo: 'SLO-MO',
                    timelapse: 'TIME-LAPSE', raw: 'RAW',
                  };
                  const label = LABELS[_activeMediaKind] || _activeMediaKind.toUpperCase();
                  return (
                    <View style={[s.pill, { backgroundColor: 'rgba(255,255,255,0.92)' }]}>
                      <Text style={[s.pillText, { color: '#111', fontWeight: '800', letterSpacing: 0.5 }]}>{label}</Text>
                    </View>
                  );
                })()}
              </View>
            )}
          </View>

          <TouchableOpacity
            onPress={() => _setInfoSheetOpen(o => !o)}
            style={s.headerIconBtn}
            hitSlop={14}
            accessibilityLabel={(typeof t === 'function' && t('viewer.info')) || 'Mais'}
            accessibilityRole="button"
          >
            <IconMoreHorizontal size={22} color="#fff" />
          </TouchableOpacity>
        </Animated.View>

        {/* Content — single-item path renders inline; multi-item path uses
            a paging FlatList so swipe between feels native.
            WAVE 60: wrapped in a transparent tap-zone so a single tap on the
            backdrop toggles top/bottom chrome (Instagram parity). Pan/zoom
            gestures inside ImageViewer still win because PanResponder
            captures movement; only the unmodified tap reaches us here. */}
        <TouchableWithoutFeedback onPress={_toggleChrome} accessible={false}>
        <View style={{ flex: 1 }}>
        {_multi ? (
          <FlatList
            data={_list}
            keyExtractor={(it, i) => `${it?.fileUrl || ''}_${i}`}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={_initial}
            getItemLayout={(_, i) => ({ length: SCREEN_W, offset: SCREEN_W * i, index: i })}
            onScrollToIndexFailed={() => {}}
            onMomentumScrollEnd={(e) => {
              const i = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
              if (i !== _currentIdx) _setCurrentIdx(i);
            }}
            renderItem={({ item }) => {
              const u = getFullUrl(item?.fileUrl);
              const e = getExt(item?.fileName);
              const isImg = item?.type === 'image' || IMAGE_EXTS.includes(e);
              const isVid = item?.type === 'video' || VIDEO_EXTS.includes(e);
              const isPrv = PREVIEWABLE_EXTS.includes(e);
              return (
                <View style={{ width: SCREEN_W, flex: 1 }}>
                  {isImg ? <ImageViewer url={u} messageId={item?.messageId || item?.id || 0} fileSize={item?.fileSize} createdAt={item?.createdAt || item?.created_at} t={t} placeholderUri={item?.placeholderUri || item?.thumbB64Uri} blurhash={item?.blurhash} thumbUri={item?.thumbUri} /> :
                   isVid ? <VideoPlayer url={u} /> :
                   isPrv ? <PreviewViewer url={u} filename={item?.fileName} messageId={item?.messageId || item?.id || 0} fileSize={item?.fileSize} t={t} /> :
                   <GenericFileViewer url={u} filename={item?.fileName} fileSize={item?.fileSize} messageId={item?.messageId || item?.id || 0} t={t} />}
                </View>
              );
            }}
          />
        ) : (
          isImage ? (
            // Wave 14: iOS portrait photos render with 3D parallax. Backend
            // tags `media_kind: 'portrait'` when the iOS backup pipeline
            // detects the depth aux channel; `depthUrl` is the masked
            // foreground subject (generated server-side from the AVDepthData
            // map). When either is missing we fall back to the regular pan-
            // and-zoom image viewer.
            (_activeMediaKind === 'portrait' && ParallaxPortraitView) ? (
              <View style={s.mediaContainer}>
                <ParallaxPortraitView
                  fileUrl={url}
                  depthUrl={_active?.depthUrl || _active?.depth_url || url}
                  width={SCREEN_W}
                  height={SCREEN_H * 0.75}
                />
              </View>
            ) : (
              <ImageViewer
                url={url}
                messageId={_active?.messageId || _active?.id || messageId || 0}
                fileSize={_activeFileSize}
                createdAt={_active?.createdAt || _active?.created_at}
                t={typeof t === 'function' ? t : undefined}
                placeholderUri={_active?.placeholderUri || _active?.thumbB64Uri}
                blurhash={_active?.blurhash}
                thumbUri={_active?.thumbUri}
              />
            )
          ) : isVideo ? (
            // Offline + no HLS cache → don't mount the player (it'd spin
            // forever on a dead manifest URL). Show a friendly message
            // instead. The mp4 progressive path falls through to VideoPlayer
            // because _hlsOfflineUnavailable only flips true for .m3u8 sources.
            _hlsOfflineUnavailable ? (
              <View style={s.mediaContainer}>
                <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16, textAlign: 'center', paddingHorizontal: 32 }}>
                  {(typeof t === 'function' && t('chat.video.offlineUnavailable')) || 'Vídeo não disponível offline'}
                </Text>
              </View>
            ) : (
              <VideoPlayer url={url} />
            )
          ) : isPreviewable ? (
            <PreviewViewer
              url={url}
              filename={_activeFileName}
              messageId={_active?.messageId || _active?.id || messageId || 0}
              fileSize={_activeFileSize}
              t={typeof t === 'function' ? t : undefined}
            />
          ) : (
            <GenericFileViewer
              url={url}
              filename={_activeFileName}
              fileSize={_activeFileSize}
              messageId={_active?.messageId || _active?.id || messageId || 0}
              t={typeof t === 'function' ? t : undefined}
            />
          )
        )}
        </View>
        </TouchableWithoutFeedback>

        {/* WAVE 60: Bottom action bar — Share / Download / Star (WhatsApp/IG
            grade). Lives in its own row at the bottom, fades with the top
            chrome on tap. View-once hides Download + Share (download path
            already blocked) but keeps Star (lets the user remember the
            moment without saving the file itself). */}
        <Animated.View
          pointerEvents={_chromeVisible ? 'auto' : 'none'}
          style={[
            s.actionBar,
            {
              paddingBottom: Math.max(insets.bottom, 12) + 6,
              opacity: _chromeOpacity,
            },
          ]}
        >
          {!viewOnce && (
            <TouchableOpacity
              onPress={async () => {
                try {
                  if (Platform.OS === 'web') {
                    if (navigator.share) {
                      await navigator.share({ url }).catch(() => {});
                    } else {
                      await navigator.clipboard?.writeText?.(url);
                    }
                  } else {
                    await Share.share({ url, message: url });
                  }
                } catch {}
              }}
              style={s.actionBtn}
              hitSlop={10}
              accessibilityLabel={(typeof t === 'function' && t('viewer.share')) || 'Compartilhar'}
              accessibilityRole="button"
            >
              <IconShare size={22} color="#fff" />
            </TouchableOpacity>
          )}
          {!viewOnce && (
            <TouchableOpacity
              onPress={handleDownload}
              disabled={saving}
              style={s.actionBtn}
              hitSlop={10}
              accessibilityLabel={(typeof t === 'function' && t('viewer.download')) || 'Baixar'}
              accessibilityRole="button"
            >
              {saving ? <ActivityIndicator size="small" color="#fff" />
                : saved ? <IconCheck size={22} color="#22c55e" strokeWidth={3} />
                : <IconDownload size={22} color="#fff" />}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => _setStarred(s => !s)}
            style={s.actionBtn}
            hitSlop={10}
            accessibilityLabel={(typeof t === 'function' && t('viewer.star')) || 'Favorito'}
            accessibilityRole="button"
          >
            {_starred
              ? <IconStarFilled size={22} color="#facc15" />
              : <IconStar size={22} color="#fff" />}
          </TouchableOpacity>
        </Animated.View>

        {/* WAVE 60: Info sheet — opens on More tap. Surfaces the technical
            details (filename, file size, sender email, date) that used to
            pollute the main header. Power users still have access; new
            users get a clean fullscreen photo experience. */}
        {_infoSheetOpen && (
          <TouchableWithoutFeedback onPress={() => _setInfoSheetOpen(false)}>
            <View style={s.infoOverlay}>
              <TouchableWithoutFeedback>
                <View style={[s.infoSheet, { paddingBottom: Math.max(insets.bottom, 16) + 12 }]}>
                  <View style={s.infoHandle} />
                  <Text style={s.infoTitle}>
                    {(typeof t === 'function' && t('viewer.imageInfo')) || 'Detalhes'}
                  </Text>
                  {!!(senderName || senderEmail) && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.sentBy')) || 'Enviado por'}</Text>
                      <Text style={s.infoVal} numberOfLines={1}>{senderName || senderEmail}</Text>
                    </View>
                  )}
                  {!!(createdAt || _active?.createdAt || _active?.created_at) && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.date')) || 'Data'}</Text>
                      <Text style={s.infoVal}>
                        {(() => {
                          try {
                            const tsRaw = createdAt || _active?.createdAt || _active?.created_at;
                            const ms = typeof tsRaw === 'number' ? (tsRaw < 1e12 ? tsRaw * 1000 : tsRaw) : Date.parse(tsRaw);
                            return new Date(ms).toLocaleString();
                          } catch { return ''; }
                        })()}
                      </Text>
                    </View>
                  )}
                  {!!_activeFileName && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.fileName')) || 'Arquivo'}</Text>
                      <Text style={s.infoVal} numberOfLines={1}>{_activeFileName}</Text>
                    </View>
                  )}
                  {_activeFileSize > 0 && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.fileSize')) || 'Tamanho'}</Text>
                      <Text style={s.infoVal}>{formatSize(_activeFileSize)}</Text>
                    </View>
                  )}
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 12,
  },
  headerInfo: { flex: 1 },
  headerTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerSize: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 1 },
  headerBtn: { padding: 8 },
  // WAVE 60 — WhatsApp/IG-grade viewer chrome
  headerBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 8, paddingBottom: 12,
    zIndex: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  headerIconBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 2,
  },
  headerCenter: { flex: 1, paddingHorizontal: 4, justifyContent: 'center' },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  senderName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  senderMeta: { color: 'rgba(255,255,255,0.65)', fontSize: 11, marginTop: 1 },
  pill: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  pillText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  actionBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
    paddingTop: 12, paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.45)',
    zIndex: 20,
  },
  actionBtn: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  infoOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
    zIndex: 50,
  },
  infoSheet: {
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 10,
  },
  infoHandle: {
    alignSelf: 'center',
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    marginBottom: 14,
  },
  infoTitle: { color: '#fff', fontSize: 17, fontWeight: '700', marginBottom: 14 },
  infoRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  infoKey: { color: 'rgba(255,255,255,0.6)', fontSize: 13, flexShrink: 0, marginRight: 12 },
  infoVal: { color: '#fff', fontSize: 13, fontWeight: '500', flex: 1, textAlign: 'right' },
  mediaContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loader: {
    position: 'absolute',
    zIndex: 10,
  },
  fullImage: {
    width: SCREEN_W,
    height: SCREEN_H * 0.75,
  },
  fullVideo: {
    width: SCREEN_W,
    height: SCREEN_H * 0.65,
  },
  fileIcon: {
    width: 80,
    height: 80,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  fileExtText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  fileNameText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
    paddingHorizontal: 40,
    marginBottom: 6,
  },
  fileSizeText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    marginBottom: 24,
  },
  openExternalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#7C3AED',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  openExternalText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
