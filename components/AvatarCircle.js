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

// Bug 2026-05-12 v2: initials flipped after restart (JA→AU, ML→OF, N→NO).
// Previous attempt forced email-first, but the actual symptom is that the
// `email` prop arriving at this component is sometimes WRONG during cold
// start (ChatListTab can resolve the wrong "otherEmail" before currentEmail
// hydrates, ending up with the current user's address for a row that's
// really "João Alves"). Email-first then renders the current user's
// initials (AU) on the contact's row.
//
// The right invariant is: trust `name` whenever it's a real human name
// (callers ALWAYS pass `displayName = nickname || display_name ||
// emailToDisplayName(email)`, see services/displayName.js & nicknames.js).
// Only fall back to the email's local-part when `name` is empty or itself
// looks like an email/handle. That keeps initials locked to the row's
// visible text — if the row says "João Alves", the bubble says JA, even
// if the avatar URL request comes back 404 or `email` is temporarily off.
function getInitials(name, email) {
  const _looksLikeEmail = (s) => typeof s === 'string' && /@/.test(s);
  let src = '';
  if (name && typeof name === 'string' && name.trim() && !_looksLikeEmail(name)) {
    src = name.trim();
  } else if (typeof email === 'string' && email.includes('@')) {
    src = email.split('@')[0];
  } else if (name && typeof name === 'string' && name.trim()) {
    src = name.trim();
  }
  if (!src) return '';
  // Split on whitespace + dots/dashes/underscores so "joao.almeida",
  // "joao-almeida", and "joao_almeida" all give "JA".
  const parts = src.split(/[\s._\-]+/).filter(Boolean);
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

  // Subscribe to global cache bumps so this avatar refreshes when the user uploads a new pic.
  // IMPORTANT: this useEffect must run UNCONDITIONALLY before any early returns so the hook
  // call order stays stable across renders (otherwise React throws "Rendered fewer/more
  // hooks than expected" if the email prop ever flips to/from ai@chatyy.com.br).
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
  // Initials follow `name` (the caller's resolved displayName chain:
  // nickname > display_name > prettify(email)). See getInitials() above.
  // Hash color tracks the SAME source so the bubble's color stays bound
  // to the letters it shows — if a row's name flips for a moment, the
  // background flips with it (never a mismatch between AU letters and
  // a JA-colored circle, which used to flash on cold start).
  const initials = getInitials(name, email);
  const _colorSeed = (displayName || email || '').toLowerCase();
  const bgColor = hashColor(_colorSeed);
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
    // Wrapper has explicit width/height/borderRadius first so caller-provided
    // `style` can override (e.g. add tint), but it can never accidentally turn
    // the wrapper square: if a caller passes `borderWidth` without
    // `borderRadius`, the wrapper would otherwise paint a 4-pixel square ring
    // around a circular avatar (regression seen in IMG_6703 on /live-viewer).
    return (
      <View style={[{ width: totalSize, height: totalSize, borderRadius: totalSize / 2, alignItems: 'center', justifyContent: 'center', borderWidth: ringWidth, borderColor: ringColor, overflow: 'hidden' }, style, { borderRadius: totalSize / 2 }]}>
        {inner}
        {/* Bottom-right green dot — intentional SQUARE-with-rounded-corners
            (WhatsApp-style) so it reads as a "dot" but doesn't get cropped by
            the wrapper's overflow:hidden. */}
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

  // ALWAYS force the wrapper to be round + clip overflow. Without this, a
  // caller passing `style={{ borderWidth: 3, borderColor: ... }}` (e.g.
  // live-viewer's endedAvatar) would paint a SQUARE ring around the circular
  // inner avatar, since `inner` is sized + radiused but the wrapper View
  // wasn't. Putting size/radius LAST guarantees they win even when the caller
  // passes a conflicting style. (Bug visible in IMG_6703 — square frame
  // behind the host's circular avatar on /live-viewer "Stream indisponível".)
  return (
    <View style={[{ width: size, height: size, overflow: 'hidden' }, style, { width: size, height: size, borderRadius: size / 2 }]}>
      {inner}
    </View>
  );
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
    prev.name === next.name &&
    prev.uri === next.uri &&
    prev.size === next.size &&
    prev.online === next.online &&
    prev.ringColor === next.ringColor &&
    prev.showStatus === next.showStatus
  );
}
export default memo(AvatarCircle, _avatarEqual);
