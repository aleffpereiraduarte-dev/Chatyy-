import React, { useState, useEffect, memo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { getAvatarUrlForEmail } from '../services/api';
import { IconSparkles } from './Icons';

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

// Bug 2026-05-12: initials flipped after restart (JA→AU, ML→OF) because
// different screens pass `name` differently (full display name vs handle
// vs email local-part). With no avatar image, the rendered text changed
// every cold-start until the API hydrated the canonical name. Now we
// pick a STABLE source by always using the email when available — the
// part before `@` split on space/dot/dash gives a deterministic result
// regardless of which screen's display-name happened to populate first.
function getInitials(name, email) {
  // Prefer email's local-part when available — stable across cold starts.
  // Falls back to `name` only when there's no email (group convs without
  // an email backing).
  const src = (typeof email === 'string' && email.includes('@'))
    ? email.split('@')[0]
    : (name || '');
  if (!src) return '';
  const trimmed = String(src).trim();
  if (!trimmed) return '';
  // Split on whitespace + dots/dashes/underscores so "joao.almeida",
  // "joao-almeida", and "joao_almeida" all give "JA".
  const parts = trimmed.split(/[\s._\-]+/).filter(Boolean);
  if (parts.length >= 2) return ((parts[0][0] || '') + (parts[1][0] || '')).toUpperCase();
  // Single token — take first 2 letters so "ces" → "CE" (instead of just "C",
  // which is too generic and clashes with every other C-name).
  const first = parts[0] || '';
  return (first.slice(0, 2) || '').toUpperCase();
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

  // ChatyyAI bot — special-cased gradient + sparkle icon. The bot has no
  // real account so its /get_avatar request would 400. Render in-app instead.
  if (typeof email === 'string' && email.toLowerCase() === 'ai@chatyy.com.br') {
    return (
      <View
        style={[{
          width: size, height: size, borderRadius: size / 2,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: '#7C3AED',
          // Purple → indigo flat fill — close enough to a gradient without
          // pulling in react-native-svg's LinearGradient at this depth.
        }, style]}
        accessibilityLabel="Chatyy AI"
        accessibilityRole="image"
      >
        <IconSparkles size={Math.round(size * 0.55)} color="#fff" />
      </View>
    );
  }
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
  // Use email-first initials so the letters stay stable across cold
  // starts (see getInitials docstring). bgColor still hashes on the
  // display name so two different emails with the same initials get
  // different background colors — keeps the visual hierarchy intact.
  const initials = getInitials(name, email);
  const bgColor = hashColor((email || displayName).toLowerCase());
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
      {/* Initials are always rendered so they remain visible if the avatar
          URL returns 404, an empty/transparent placeholder, or hasn't loaded
          yet. A real avatar image (when it loads successfully) is absolutely
          positioned on top and fully covers them. Fixes the "solid colored
          blob with no initials" rendering for users without a profile photo
          (parental child cards, fresh signups, etc). */}
      <Text
        style={[styles.initials, { fontSize: size * 0.38, position: 'absolute' }]}
        allowFontScaling={false}
        accessibilityElementsHidden
      >
        {initials}
      </Text>
      {showImage ? (
        <ImageComponent
          source={{ uri: avatarUrl }}
          style={{ width: size, height: size, borderRadius: size / 2, position: 'absolute' }}
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
      ) : null}
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
