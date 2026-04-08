import React, { useState, useEffect, memo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { getAvatarUrlForEmail } from '../services/api';

let ExpoImage = null;
let RNImage = null;

// Use expo-image on native for built-in disk caching, RN Image on web
if (Platform.OS !== 'web') {
  try { ExpoImage = require('expo-image').Image; } catch {}
}
if (!ExpoImage) {
  RNImage = require('react-native').Image;
}

// Native cache for synchronous avatar lookup (iOS only).
// If a cached file exists on disk for this email, we use file:// directly,
// which means the avatar paints on the very first render with no flicker
// and no network request. New uploads still go through prefetchAvatar.
const _NativeCache = (() => {
  if (Platform.OS !== 'ios') return null;
  try { return require('../modules/expo-chat-cache').default; } catch { return null; }
})();

// ─── Avatar cache version registry ─────────────────────────────
// Bumping the version for an email forces all <AvatarCircle> showing it to refetch.
// Used after the user uploads a new profile photo so the new image appears immediately.
const _avatarVersions = new Map(); // email → version number
const _versionListeners = new Set();
export function bumpAvatarCache(email) {
  if (!email) return;
  const e = String(email).toLowerCase();
  _avatarVersions.set(e, Date.now());
  _versionListeners.forEach(fn => { try { fn(e); } catch {} });
  // Also clear expo-image cache if available so the new image shows immediately
  try {
    if (ExpoImage && typeof ExpoImage.clearMemoryCache === 'function') {
      ExpoImage.clearMemoryCache();
    }
    if (ExpoImage && typeof ExpoImage.clearDiskCache === 'function') {
      ExpoImage.clearDiskCache();
    }
  } catch {}
}
function getAvatarVersion(email) {
  if (!email) return 0;
  return _avatarVersions.get(String(email).toLowerCase()) || 0;
}

function getInitials(name) {
  if (!name) return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/[\s@]+/).filter(Boolean);
  if (parts.length >= 2) return ((parts[0][0] || '') + (parts[1][0] || '')).toUpperCase();
  return parts[0]?.[0]?.toUpperCase() || '';
}

function hashColor(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

function AvatarCircle({ name, email, size = 48, style, online = false, ringColor = '#25D366', showStatus = false }) {
  const [imgError, setImgError] = useState(false);
  const [version, setVersion] = useState(() => getAvatarVersion(email));
  useEffect(() => { setImgError(false); setVersion(getAvatarVersion(email)); }, [email]);
  // Subscribe to global cache bumps so this avatar refreshes when the user uploads a new pic
  useEffect(() => {
    const listener = (changedEmail) => {
      if (!email) return;
      if (String(changedEmail).toLowerCase() === String(email).toLowerCase()) {
        setVersion(getAvatarVersion(email));
        setImgError(false);
      }
    };
    _versionListeners.add(listener);
    return () => { _versionListeners.delete(listener); };
  }, [email]);
  const baseAvatarUrl = email ? getAvatarUrlForEmail(email) : null;
  const remoteAvatarUrl = baseAvatarUrl ? `${baseAvatarUrl}${baseAvatarUrl.includes('?') ? '&' : '?'}v=${version}` : null;
  // Try the native synchronous cache first — returns file:// path if we already have it
  const nativeLocal = (email && _NativeCache?.getAvatarLocalUriSync && version === 0)
    ? (() => { try { return _NativeCache.getAvatarLocalUriSync(email); } catch { return null; } })()
    : null;
  // Schedule background download for next time if we don't have it yet
  if (email && !nativeLocal && remoteAvatarUrl && _NativeCache?.prefetchAvatar) {
    try { _NativeCache.prefetchAvatar(email, baseAvatarUrl); } catch {}
  }
  const avatarUrl = nativeLocal || remoteAvatarUrl;
  const showImage = avatarUrl && !imgError;

  const displayName = name || email || '';
  const initials = getInitials(displayName);
  const bgColor = hashColor(displayName);
  const accessLabel = displayName ? `Avatar of ${displayName}` : 'User avatar';

  const ImageComponent = ExpoImage || RNImage;

  // Online ring: 2px ring around avatar with 1px gap
  const ringWidth = online && showStatus ? 2 : 0;
  const totalSize = size + (ringWidth * 2) + 2;

  const inner = (
    <View
      style={[styles.container, { width: size, height: size, borderRadius: size / 2, backgroundColor: bgColor }]}
      accessibilityLabel={accessLabel}
      accessibilityRole="image"
    >
      {showImage ? (
        <ImageComponent
          source={{ uri: avatarUrl }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          onError={() => setImgError(true)}
          accessibilityLabel={accessLabel}
          {...(ExpoImage ? {
            cachePolicy: 'memory-disk',
            contentFit: 'cover',
            transition: 200,
            recyclingKey: email,
          } : {})}
        />
      ) : (
        <Text
          style={[styles.initials, { fontSize: size * 0.38 }]}
          allowFontScaling={false}
          accessibilityElementsHidden
        >
          {initials}
        </Text>
      )}
    </View>
  );

  if (online && showStatus) {
    return (
      <View style={[{ width: totalSize, height: totalSize, borderRadius: totalSize / 2, alignItems: 'center', justifyContent: 'center', borderWidth: ringWidth, borderColor: ringColor }, style]}>
        {inner}
        {/* Bottom-right green dot */}
        <View style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: Math.max(10, size * 0.25),
          height: Math.max(10, size * 0.25),
          borderRadius: Math.max(5, size * 0.125),
          backgroundColor: ringColor,
          borderWidth: 2,
          borderColor: '#fff',
        }} />
      </View>
    );
  }

  return <View style={style}>{inner}</View>;
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initials: {
    color: '#fff',
    fontWeight: '600',
  },
});

export default memo(AvatarCircle);
