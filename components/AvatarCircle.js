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
// Persistido em MMKV pra sobreviver cold-start — antes era só Map em memória,
// e na re-abertura do app a version voltava pra 0, fazendo nativeLocal apontar
// pro arquivo cacheado antigo (foto velha aparecia de novo).
const _avatarVersions = new Map(); // email → version number
const _versionListeners = new Set();
const AVATAR_VER_KEY = 'avatar_versions_v1';
let _mmkv = null;
try { _mmkv = require('../services/mmkv'); } catch {}
// Hidrata o Map com o que ficou persistido na sessão anterior (sync read)
try {
  const raw = _mmkv?.getString?.(AVATAR_VER_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' && v > 0) _avatarVersions.set(String(k).toLowerCase(), v);
      }
    }
  }
} catch {}
function _persistVersions() {
  try {
    const obj = {};
    for (const [k, v] of _avatarVersions) obj[k] = v;
    _mmkv?.setString?.(AVATAR_VER_KEY, JSON.stringify(obj));
  } catch {}
}
export function bumpAvatarCache(email) {
  if (!email) return;
  const e = String(email).toLowerCase();
  _avatarVersions.set(e, Date.now());
  _persistVersions();
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

function AvatarCircle({ name, email, uri, size = 48, style, online = false, ringColor = '#7C3AED', showStatus = false }) {
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
  // Only fetch when `email` looks like a real address. Handles/usernames like
  // "@itsneres" or plain names sometimes leak through from feed posts and
  // would otherwise trigger a 400 loop against /get_avatar.
  const looksLikeEmail = typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const baseAvatarUrl = looksLikeEmail ? getAvatarUrlForEmail(email) : null;
  // Stable cache key — only busts when `bumpAvatarCache(email)` is called
  // (happens on explicit avatar upload OR WS avatar_updated event). When
  // it does bust, expo-image's disk cache is also cleared globally so
  // even iOS's NSURLCache drops the stale image.
  const cacheBust = version > 0 ? version : 0;
  const remoteAvatarUrl = baseAvatarUrl
    ? (cacheBust > 0 ? `${baseAvatarUrl}${baseAvatarUrl.includes('?') ? '&' : '?'}v=${cacheBust}` : baseAvatarUrl)
    : null;
  // Skip the native synchronous cache — ele retorna sempre o ÚLTIMO arquivo
  // baixado pra esse email (sem considerar a version), então quando o user
  // troca a foto e a version está em 0 (cold-start, MMKV ainda não populada)
  // o avatar antigo aparece. expo-image já faz cache memory+disk keyed pela
  // URL completa (incluindo ?v=), então perda de perf é mínima e o bug de
  // foto antiga sumindo no iOS desaparece.
  const nativeLocal = null;
  // Schedule background download so next time native cache is fresh.
  // Pass cacheBust as version → expo-chat-cache native side stores the
  // file under a versioned filename, so the next render reads the fresh
  // cached file instead of the old one. (User reported avatar cache
  // sticking on mobile after desktop upload.)
  if (email && remoteAvatarUrl && _NativeCache?.prefetchAvatar) {
    try { _NativeCache.prefetchAvatar(email, remoteAvatarUrl, cacheBust); } catch {}
  }
  // Explicit `uri` prop wins over the email-derived avatar (used for groups
  // where there's no email to look up, and the conversation carries its own
  // avatar_url). Resolve relative /data/... paths against the API origin.
  const explicitUri = uri
    ? (/^https?:\/\//i.test(uri) ? uri : `https://chatyy.com.br${uri.startsWith('/') ? '' : '/'}${uri}`)
    : null;
  const avatarUrl = explicitUri || nativeLocal || remoteAvatarUrl;
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
            // recyclingKey precisa mudar quando o avatar é atualizado, senão
            // o expo-image reutiliza a célula visual com a foto antiga mesmo
            // depois que o URL mudou. Incluir version no key força remount
            // da imagem quando bumpAvatarCache(email) for chamado.
            recyclingKey: `${email || ''}#${version}`,
          } : {
            // Web fallback: lazy-load off-screen avatars
            ...(Platform.OS === 'web' ? { loading: 'lazy' } : {}),
          })}
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

// Custom equality: skip the re-render when only `name` or `style` changed
// (those don't affect the rendered avatar pixels — name only feeds the
// hashColor fallback shown when the image fails to load). Without this the
// 100-message scroll re-renders every avatar 60×/sec because parent rows
// pass freshly-spread style objects on every frame.
function _avatarEqual(prev, next) {
  return (
    prev.email === next.email &&
    prev.uri === next.uri &&
    prev.size === next.size &&
    prev.online === next.online &&
    prev.ringColor === next.ringColor &&
    prev.showStatus === next.showStatus
  );
}
export default memo(AvatarCircle, _avatarEqual);
