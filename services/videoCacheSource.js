// [2026-10-10 native-audit] Native DISK cache for expo-video playback.
//
// Before: every expo-video player (chat viewer, round video notes, feed,
// stories, profile posts, spotlight, reels fallback) streamed the file from
// the network EVERY time it was opened — reopen the same chat video = full
// re-download, no offline replay. expo-video ships a native LRU disk cache
// (iOS AVAssetResourceLoader-backed, Android media3 SimpleCache, default
// 1 GB, persisted) that is OFF unless the source opts in with
// `useCaching: true`. This helper turns it on for plain progressive remote
// files only:
//   - http(s) only (file:// / content:// / ph:// are already local);
//   - never HLS/DASH (iOS cannot cache HLS; live streams must not be cached);
//   - never for view-once media (callers simply don't use this helper there).
// The `useCaching` field is ignored by expo-video builds that don't know it,
// and `useVideoPlayer` keys the player on JSON.stringify(source), so passing
// a fresh object each render does NOT recreate the player.
//
// Kill switches (OTA / console): globalThis.__chatyy_video_cache = false
// (all), globalThis.__chatyy_video_cache_ios = false (iOS only).
import { Platform } from 'react-native';

function _enabled() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__chatyy_video_cache === false) return false;
    if (Platform.OS === 'ios' && globalThis.__chatyy_video_cache_ios === false) return false;
  } catch {}
  return true;
}

export function isCacheableVideoUrl(uri) {
  if (typeof uri !== 'string' || uri.length < 8) return false;
  const lower = uri.toLowerCase();
  if (!(lower.startsWith('https://') || lower.startsWith('http://'))) return false;
  const noHash = lower.split('#')[0];
  const path = noHash.split('?')[0];
  if (path.endsWith('.m3u8') || path.endsWith('.mpd') || path.endsWith('.ism') || path.includes('/manifest')) return false;
  const query = noHash.includes('?') ? noHash.slice(noHash.indexOf('?') + 1) : '';
  if (query.includes('type=hls') || query.includes('format=m3u8')) return false;
  // LiveKit egress / live replay paths stream segments — leave them alone.
  if (path.includes('/live/') || path.includes('/hls/')) return false;
  // iOS: expo-video's caching resource loader FAILS the item (no fallback)
  // when the response Content-Type is not video/* (e.g. an object stored as
  // application/octet-stream, or an extension-less API URL). Our CDN/origin
  // serve video/mp4|quicktime for real video extensions (checked 2026-10-10),
  // so iOS only caches those. Android (media3 CacheDataSource) is MIME-agnostic.
  if (Platform.OS === 'ios' && !/\.(mp4|m4v|mov)$/.test(path)) return false;
  return true;
}

/**
 * Returns a value to pass straight to expo-video's `useVideoPlayer` /
 * `createVideoPlayer` / `replaceAsync`. Keeps the input untouched (string,
 * null, object) when caching does not apply.
 */
export function cachedVideoSource(src) {
  if (src == null) return src;
  if (!_enabled()) return src;
  if (typeof src === 'string') {
    return isCacheableVideoUrl(src) ? { uri: src, useCaching: true } : src;
  }
  if (typeof src === 'object' && typeof src.uri === 'string' && src.useCaching === undefined && !src.drm) {
    return isCacheableVideoUrl(src.uri) ? { ...src, useCaching: true } : src;
  }
  return src;
}

/**
 * Logout / account switch: wipe the shared video disk cache so the next
 * account never replays the previous one's media from disk. expo-video only
 * allows this with no live player — on logout the screens are gone; any
 * rejection is ignored (the cache is LRU-bounded anyway).
 */
export async function clearVideoDiskCache() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  try {
    // eslint-disable-next-line global-require
    const ev = require('expo-video');
    if (ev && typeof ev.clearVideoCacheAsync === 'function') await ev.clearVideoCacheAsync();
  } catch {}
  // expo-shorts (reels + chat short videos) keeps its own ExoPlayer disk
  // cache on Android (binaries after 2026-10-10). Optional lookup: older
  // binaries / iOS simply don't have `clearMediaCache`.
  try {
    // eslint-disable-next-line global-require
    const { requireOptionalNativeModule } = require('expo');
    const shorts = requireOptionalNativeModule ? requireOptionalNativeModule('ExpoShorts') : null;
    if (shorts && typeof shorts.clearMediaCache === 'function') await shorts.clearMediaCache();
  } catch {}
}
