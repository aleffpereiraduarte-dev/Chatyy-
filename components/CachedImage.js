/**
 * CachedImage — drop-in replacement for RN's <Image> that uses expo-image
 * with memory+disk cache on native, and falls back to native <img> on web
 * (browser cache + Service Worker v6 handle persistence).
 *
 * Why: plain <Image source={{uri}}/> re-downloads on every mount — scrolling
 * back into a grid, re-opening a chat, switching tabs. This component makes
 * the SECOND render hit disk instead of network, usually < 5ms vs 200-800ms.
 *
 * API parity with Image:
 *   <CachedImage source={{uri}} style={} resizeMode="cover" />
 *
 * Extras:
 *   cachePolicy: "memory-disk" (default) | "memory" | "disk" | "none"
 *   transition: fade-in ms (default 80)
 *   priority: "low" | "normal" | "high" (hints expo-image worker queue)
 */
import React, { useState, useRef } from 'react';
import { Image, Platform, StyleSheet, View, ActivityIndicator } from 'react-native';

let _ExpoImage = null;
try { _ExpoImage = require('expo-image').Image; } catch {}

// Map RN resizeMode → expo-image contentFit
const MODE_TO_FIT = {
  cover: 'cover',
  contain: 'contain',
  stretch: 'fill',
  center: 'none',
  repeat: 'cover', // expo-image has no repeat; closest is cover
};

// Tiny deterministic LQIP placeholder: derives a soft color from the URL so
// an image that hasn't loaded yet is never a blank white box. Same URL always
// hashes to the same tint, so the user sees a stable shape not a flash.
function _colorPlaceholder(uri) {
  if (!uri) return '#e5e7eb';
  let h = 0;
  for (let i = 0; i < uri.length; i++) h = (h * 31 + uri.charCodeAt(i)) & 0xffffffff;
  const hue = Math.abs(h) % 360;
  // low saturation + high lightness = subtle pastel (WhatsApp look)
  return `hsl(${hue}, 28%, 82%)`;
}

export default function CachedImage({
  source, style, resizeMode = 'cover',
  cachePolicy = 'memory-disk', transition = 80, priority = 'normal',
  onLoad, onError, accessibilityLabel, placeholder, blurhash, ...rest
}) {
  const uri = source?.uri || source?.url || '';
  // No URI → render nothing. <img src=""> on web triggers a request to the
  // current page (and a console error), and an empty source on native shows
  // a blank box that masks legitimate placeholders.
  if (!uri) return null;
  // Build a placeholder: caller-supplied > blurhash > deterministic tint.
  const effectivePlaceholder = placeholder
    || (blurhash ? { blurhash } : undefined);
  const tintBg = effectivePlaceholder ? undefined : _colorPlaceholder(uri);

  // Web: use native <img> — HTTP cache + Service Worker v6 handle persistence.
  // Service Worker already does cache-first on same-origin images and
  // stale-while-revalidate on cross-origin (via browser's default HTTP cache).
  if (Platform.OS === 'web') {
    // react-native-web renders <img> for <Image>, but using <img> directly
    // skips the React Native shim and gives us <img> fetchpriority + decoding.
    const flat = StyleSheet.flatten(style) || {};
    const cssStyle = {
      width: flat.width,
      height: flat.height,
      objectFit: resizeMode === 'cover' ? 'cover'
        : resizeMode === 'contain' ? 'contain'
        : resizeMode === 'stretch' ? 'fill'
        : 'cover',
      borderRadius: flat.borderRadius,
      display: 'block',
      backgroundColor: tintBg || flat.backgroundColor,
    };
    return (
      <img
        src={uri}
        alt={accessibilityLabel || ''}
        style={cssStyle}
        loading="lazy"
        decoding="async"
        fetchpriority={priority === 'high' ? 'high' : priority === 'low' ? 'low' : 'auto'}
        onLoad={onLoad}
        onError={onError}
      />
    );
  }

  // Native: use expo-image with disk cache. Falls back to RN Image if
  // expo-image isn't installed (shouldn't happen in this project, but safe).
  if (_ExpoImage) {
    return (
      <_NativeCachedImage
        uri={uri}
        style={style}
        resizeMode={resizeMode}
        cachePolicy={cachePolicy}
        transition={transition}
        priority={priority}
        effectivePlaceholder={effectivePlaceholder}
        tintBg={tintBg}
        onLoad={onLoad}
        onError={onError}
        accessibilityLabel={accessibilityLabel}
        showSpinner={rest.showSpinner !== false}
        rest={rest}
      />
    );
  }

  // Fallback — plain RN Image
  return (
    <Image
      source={{ uri }}
      style={style}
      resizeMode={resizeMode}
      onLoad={onLoad}
      onError={onError}
      accessibilityLabel={accessibilityLabel}
      {...rest}
    />
  );
}

// Small inner component so we can track per-image load state on native.
// Shows a subtle ActivityIndicator during the first download (= "saving
// to phone"), then hands over to the cached disk copy which is instant.
function _NativeCachedImage({
  uri, style, resizeMode, cachePolicy, transition, priority,
  effectivePlaceholder, tintBg, onLoad, onError, accessibilityLabel,
  showSpinner, rest,
}) {
  const [loaded, setLoaded] = useState(false);
  const startRef = useRef(Date.now());
  const mergedStyle = tintBg ? [{ backgroundColor: tintBg }, style] : style;
  const handleLoad = (e) => {
    setLoaded(true);
    if (onLoad) onLoad(e);
  };
  // Flat out the style so we can size the overlay spinner.
  const flat = StyleSheet.flatten(style) || {};
  const spinnerSize = (flat.width || 0) >= 96 ? 'small' : 'small';
  return (
    <View style={[{ position: 'relative', overflow: 'hidden' }, mergedStyle]}>
      <_ExpoImage
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        contentFit={MODE_TO_FIT[resizeMode] || 'cover'}
        cachePolicy={cachePolicy}
        transition={transition}
        priority={priority}
        placeholder={effectivePlaceholder}
        placeholderContentFit="cover"
        onLoad={handleLoad}
        onError={onError}
        accessibilityLabel={accessibilityLabel}
        {...rest}
      />
      {showSpinner && !loaded && (flat.width || 0) >= 60 && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <View style={{ backgroundColor: 'rgba(0,0,0,0.25)', width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size={spinnerSize} color="#fff" />
          </View>
        </View>
      )}
    </View>
  );
}

/** Static helper: prefetch URLs into cache (pre-emptive load). */
CachedImage.prefetch = async function (urls) {
  if (!urls || urls.length === 0) return;
  const list = Array.isArray(urls) ? urls : [urls];
  if (Platform.OS === 'web') {
    // Hint the browser / service worker to fetch these now
    if (typeof document !== 'undefined') {
      list.forEach(u => {
        if (!u || typeof u !== 'string') return;
        try {
          const link = document.createElement('link');
          link.rel = 'preload';
          link.as = 'image';
          link.href = u;
          document.head.appendChild(link);
          setTimeout(() => { try { link.remove(); } catch {} }, 60000);
        } catch {}
      });
    }
    return;
  }
  if (_ExpoImage?.prefetch) {
    try { await _ExpoImage.prefetch(list); } catch {}
  }
};

/** Clear disk cache for a specific URL (native only). */
CachedImage.clearDiskCache = async function () {
  if (Platform.OS === 'web' || !_ExpoImage) return;
  try { await _ExpoImage.clearDiskCache(); } catch {}
};

/** Clear memory cache (native only). */
CachedImage.clearMemoryCache = function () {
  if (Platform.OS === 'web' || !_ExpoImage) return;
  try { _ExpoImage.clearMemoryCache(); } catch {}
};
