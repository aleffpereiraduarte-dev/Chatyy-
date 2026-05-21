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
import React, { useEffect, useState, useCallback } from 'react';
import { View, Platform, ActivityIndicator, TouchableOpacity, Text } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { getLocalUriSyncJs, cacheMedia, requestRedownload, formatBytesShort } from '../services/mediaCache';
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
  // R2-backed redownload — when the bubble passes its messageId, the
  // failure chip below offers "Baixar de novo" instead of "Tentar pra
  // tentar". On 410 the chip swaps to a disabled "Mensagem apagada".
  messageId,
  fileSize,
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
  // Failure state: ExpoImage reports onError when the source is broken.
  // We surface a tap-to-retry chip instead of the platform's "broken
  // image" icon — that icon is jarring inside a polished chat bubble
  // and gives the user no path forward when (e.g.) the file expired or
  // CDN is briefly down.
  const [failed, setFailed] = useState(false);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [redownloading, setRedownloading] = useState(false);
  const [redownloadDeleted, setRedownloadDeleted] = useState(false);
  // [WAVE 91 2026-05-21] Stale-file:// detection. When syncIndex points to
  // a file that iOS/Android evicted under storage pressure (or that was
  // never actually flushed to disk), ExpoImage paints transparent and
  // onError doesn't always fire reliably on Android (user sees "frame
  // só, foto não aparece, clica abre"). When this happens we want to
  // fall back to the absolute remote URL so the bubble paints SOMETHING.
  const [forceRemote, setForceRemote] = useState(false);
  // Reset failure when the URI changes (FlashList row recycling +
  // fresh cache hit).
  useEffect(() => {
    setFailed(false);
    setRedownloadDeleted(false);
    setForceRemote(false);
  }, [localUri]);
  const handleRetry = useCallback(async () => {
    // When the bubble passed a messageId we go through the server-side
    // redownload flow first — it can return a fresh CDN URL even when
    // the original URL was hard-evicted from cache. Pure client retry
    // would just hit the same dead URL again.
    if (messageId && Platform.OS !== 'web') {
      if (redownloading) return;
      setRedownloading(true);
      try {
        const r = await requestRedownload(messageId, resolveAbsolute(uri));
        if (r?.ok) {
          setFailed(false);
          setRetryEpoch(e => e + 1);
        } else if (r?.deleted) {
          setRedownloadDeleted(true);
        } else {
          // Network or server error — let the user retry again.
          setFailed(true);
        }
      } catch {
        setFailed(true);
      } finally {
        setRedownloading(false);
      }
      return;
    }
    setFailed(false);
    setRetryEpoch(e => e + 1);
    // Re-trigger background download — syncIndex was already evicted
    // by cacheMedia's failure path, so this kicks a fresh attempt.
    if (uri && Platform.OS !== 'web') {
      try { cacheMedia(resolveAbsolute(uri)).catch(() => {}); } catch {}
    }
  }, [uri, messageId, redownloading]);

  if (!localUri) {
    // [WAVE 77 2026-05-21] Transparent bg when localUri is missing so the
    // parent wrapper's HSL backdrop shines through. Previously the opaque
    // placeholderColor (rgba(0,0,0,0.06)) sat on TOP of the parent's HSL +
    // thumb layers, looking like "sem fundo" (washed-out empty box) on
    // Android during the brief sync-index miss window for fresh chats.
    // spinner only shows when there is literally no other layer painted.
    return (
      <View style={[{ backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' }, style]}>
        <ActivityIndicator size="small" color="rgba(255,255,255,0.85)" />
      </View>
    );
  }
  if (failed || redownloadDeleted) {
    const sizeLabel = (typeof fileSize === 'number' && fileSize > 0) ? formatBytesShort(fileSize) : '';
    const isDeleted = redownloadDeleted;
    return (
      <TouchableOpacity
        onPress={isDeleted ? undefined : handleRetry}
        disabled={isDeleted || redownloading}
        style={[{ backgroundColor: placeholderColor, alignItems: 'center', justifyContent: 'center', padding: 12 }, style]}
        accessibilityLabel={isDeleted ? 'Mensagem apagada' : 'Baixar de novo'}
        accessibilityRole="button"
      >
        {redownloading ? (
          <ActivityIndicator size="small" color="#999" />
        ) : (
          <Text style={{ fontSize: 11, color: 'rgba(0,0,0,0.55)', fontWeight: '600', textAlign: 'center' }}>
            {isDeleted
              ? 'Mensagem apagada'
              : (messageId
                  ? `Baixar de novo${sizeLabel ? ` (${sizeLabel})` : ''}`
                  : 'Falha ao carregar\nToque pra tentar')}
          </Text>
        )}
      </TouchableOpacity>
    );
  }
  // [WAVE 91 2026-05-21] If a previous render flipped forceRemote because
  // the file:// path painted blank, force the absolute remote URL so the
  // bubble actually paints. Without this fallback the user reported
  // "só o frame aparece" — bubble container + HSL backdrop visible,
  // main photo never paints because syncIndex pointed at an evicted file.
  const effectiveUri = (forceRemote && localUri && localUri.startsWith('file://'))
    ? resolveAbsolute(uri)
    : localUri;
  return (
    <ExpoImage
      key={retryEpoch}
      source={{ uri: effectiveUri }}
      style={style}
      contentFit={contentFit}
      // file:// never benefits from network cachePolicy; forcing 'memory'
      // here also avoids ExpoImage trying to re-download a remote URL
      // on the rare race where syncIndex flips back to URL.
      cachePolicy={effectiveUri.startsWith('file://') ? 'memory' : 'memory-disk'}
      recyclingKey={recyclingKey}
      transition={transition}
      onError={() => {
        // [WAVE 91 2026-05-21] If the failing source was a file:// path,
        // assume the cached file was evicted/corrupt and flip to remote
        // BEFORE rendering the retry chip. WhatsApp/Telegram both auto-
        // refetch silently on stale cache; only after a remote failure
        // do we surface the user-visible chip. This kills the "só
        // frame, clica abre" regression: the viewer fetched fresh,
        // bubble was stuck on dead file://.
        if (effectiveUri && effectiveUri.startsWith('file://') && !forceRemote) {
          setForceRemote(true);
          // Also kick a fresh cacheMedia to refill syncIndex with a valid path.
          try {
            const abs = resolveAbsolute(uri);
            if (abs) cacheMedia(abs).catch(() => {});
          } catch {}
          return;
        }
        setFailed(true);
      }}
      {...rest}
    />
  );
}
