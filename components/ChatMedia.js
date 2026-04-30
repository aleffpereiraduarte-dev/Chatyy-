/**
 * ChatMedia — WhatsApp-style media renderer for chat bubbles.
 *
 * Why this exists:
 * `<ExpoImage source={{ uri: REMOTE_URL }} cachePolicy="memory-disk" />`
 * stores the downloaded image in iOS `cachesDirectory`, which iOS purges
 * under storage pressure / between app launches. Result: every cold start
 * re-downloads every photo, gif, sticker, etc.
 *
 * WhatsApp solves this with native code that ALWAYS reads from
 * `Documents/WhatsApp/Media/...` (permanent) and never lets the system
 * cache touch the file. We replicate that in JS:
 *
 *   1. On every render, look up `syncIndex` (URL → file:// path)
 *      synchronously. `mediaCache.js` populates this from MMKV at boot
 *      and disk scan post-splash.
 *   2. If hit → render `<ExpoImage>` with the file:// URI immediately.
 *      ExpoImage with a file:// URI never hits the network cache.
 *   3. If miss → render a placeholder + kick off `cacheMedia(url)` which
 *      downloads to `documentDirectory + chat-media-saved/` and registers
 *      the URL→path mapping. forceUpdate counter triggers a re-render
 *      after the download completes — synchronous lookup then returns
 *      the new file:// path.
 *   4. Once a file is in `documentDirectory`, it survives every iOS
 *      eviction policy (only user-uninstall clears it).
 *
 * No state holds the URI — it's recomputed every render. This avoids the
 * "piscadinha" (1-frame flash of stale content) that happened when
 * FlashList recycled a row: the lazy-init useState would still hold the
 * previous item's file:// for one frame before the useEffect updated it.
 *
 * Drop-in replacement for `<ExpoImage source={{ uri }} />` in chat
 * bubbles where the URL is a chat-media asset (image, gif, sticker,
 * video thumbnail).
 */
import React, { useEffect } from 'react';
import { View, Platform, ActivityIndicator } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { getLocalUriSyncJs, cacheMedia } from '../services/mediaCache';
import * as api from '../services/api';

function resolveAbsolute(url) {
  if (!url) return '';
  try { return api.getMediaUrl(url); } catch {}
  return url.startsWith('http') ? url : `https://chatyy.com.br${url}`;
}

/**
 * Hook: takes a remote URL, returns the best available URI (file:// if
 * cached, remote URL only as last resort if download fails). Triggers
 * background download on first miss; re-renders with file:// when ready.
 *
 * Web: passes through unchanged — browsers cache by Cache-Control headers
 * which already give us 1-year persistence on chatyy.com.br assets.
 */
export function useChatMediaUri(url, { allowRemoteFallback = true } = {}) {
  const absolute = resolveAbsolute(url);
  // Compute synchronously every render — never store in state. With
  // FlashList row recycling, useState's lazy initializer only fires on
  // the FIRST mount; recycled rows would carry stale file:// paths from
  // the previous item until useEffect overwrote them, producing a
  // 1-frame flash. Reading getLocalUriSyncJs directly here means each
  // render reflects the current URL's actual cache state.
  const sync = (!absolute || Platform.OS === 'web') ? null : getLocalUriSyncJs(absolute);

  useEffect(() => {
    if (Platform.OS === 'web' || !absolute) return;
    if (sync) return; // already cached → no need to download
    // Fire-and-forget: download to documentDirectory + register in
    // syncIndex. INTENTIONALLY no forceUpdate here — swapping the URI
    // mid-session from remote→file:// causes a visible flicker as
    // ExpoImage tears down the network-loaded view and remounts on the
    // file path. We just let ExpoImage finish showing the remote URL it
    // already started loading; the side-effect of `cacheMedia` is that
    // on the NEXT entry to this chat (or after kill+reopen), the sync
    // lookup at the top of this hook returns file:// instantly with no
    // transition — that's where the WhatsApp-parity benefit lands.
    cacheMedia(absolute).catch(() => {});
  }, [absolute, sync]);

  if (Platform.OS === 'web') return absolute;
  if (sync) return sync;
  return allowRemoteFallback ? absolute : null;
}

/**
 * <ChatMedia> — replacement for `<ExpoImage source={{ uri }} />` in chat
 * bubbles. Renders the local file when cached, a soft placeholder while
 * downloading. Forwards every other ExpoImage prop (style, contentFit,
 * recyclingKey, transition, etc.) untouched.
 */
export default function ChatMedia({
  uri,
  style,
  contentFit = 'cover',
  recyclingKey,
  transition,
  placeholderColor = 'rgba(0,0,0,0.06)',
  ...rest
}) {
  // Allow remote fallback: ChatMedia is used in render closures (FlashList
  // rows). If `getLocalUriSyncJs` misses on first paint (e.g. syncIndex
  // hadn't yet absorbed the file from a fresh disk write, or a fresh
  // chat with new media), the remote URL still gives the user something
  // to look at while cacheMedia downloads. Once it lands, the sync
  // re-check + bump swap us to file://. Without the fallback, a single
  // miss leaves the bubble stuck on the spinner indefinitely.
  const localUri = useChatMediaUri(uri, { allowRemoteFallback: true });
  if (!localUri) {
    return (
      <View style={[{ backgroundColor: placeholderColor, alignItems: 'center', justifyContent: 'center' }, style]}>
        <ActivityIndicator size="small" color="#999" />
      </View>
    );
  }
  return (
    <ExpoImage
      source={{ uri: localUri }}
      style={style}
      contentFit={contentFit}
      // file:// never benefits from network cachePolicy; forcing 'memory'
      // here also avoids ExpoImage trying to re-download a remote URL
      // on the rare race where syncIndex flips back to URL.
      cachePolicy={localUri.startsWith('file://') ? 'memory' : 'memory-disk'}
      recyclingKey={recyclingKey}
      transition={transition}
      {...rest}
    />
  );
}
