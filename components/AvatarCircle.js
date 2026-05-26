import React, { useState, useEffect, useRef, memo } from 'react';
import { View, Text, StyleSheet, Platform, TouchableOpacity } from 'react-native';
import { getAvatarUrlForEmail } from '../services/api';
import ChatyyOneAvatar from './ChatyyOneAvatar';
// Disk-persistent avatar cache (documentDirectory/avatar-saved). Survives
// OS cache evictions so a contact's profile photo paints from disk on
// cold-start / offline — even if expo-image's NSURLCache got purged.
// Web: no-ops (browser Cache API + Cache-Control headers already cover).
import { getCachedAvatarUriOrNull, cacheAvatar } from '../services/avatarCache';
let _networkInfo = null;
try { _networkInfo = require('../services/networkInfo'); } catch {}

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
  // ⚠️ Importante: NÃO chamar ExpoImage.clearDiskCache() aqui. Ele apaga
  // o disco INTEIRO do expo-image — todas as fotos do app (chat, feed,
  // status, profile, avatares de OUTROS users) somem por uma fração de
  // segundo enquanto recarregam do servidor. Como o WS dispara
  // `avatar_updated` pra cada user que troca a foto, em um chat ativo
  // isso acontece dezenas de vezes por sessão e o usuário vê "as fotos
  // do pessoal sumindo". O cache-buster `?v=<timestamp>` na URL já é
  // suficiente: expo-image keys o cache pela URL completa, então um
  // novo `?v=` é tratado como um recurso novo (miss → fetch → cache),
  // sem afetar todas as outras imagens. (Regression introduzida no
  // mega wave 2026-05-18 / OTA 406a396 — usuário reportou
  // "as fotos do pessoal do app sumiu".)
  // Mantemos só o clear do memory-cache porque é barato e o problema
  // de NSURLCache servindo a foto antiga só acontece no nível de
  // resolução da própria URL — uma URL diferente é cache miss.
  try {
    if (ExpoImage && typeof ExpoImage.clearMemoryCache === 'function') {
      ExpoImage.clearMemoryCache();
    }
  } catch {}
}
function getAvatarVersion(email) {
  if (!email) return 0;
  return _avatarVersions.get(String(email).toLowerCase()) || 0;
}

// ─── Defensive daily-bust for backend-supplied avatar URLs ────────
// Backend payloads (chat conversations, message lists, profile metadata,
// channels, family, etc.) frequently embed a pre-built URL like
//   `/api/email.php?action=get_avatar&email=X`
// without any `?v=` cache-bust. When AvatarCircle receives that URL via
// the `uri` prop, the explicit `member.avatar_url` field in _CollageTile,
// or the `imageUrl` prop it would render the stale image cached during the
// 2026-05-18 ACL outage (or any prior 404) and the user would see no photo
// for OTHER people — only their own (which renders via getAvatarUrlForEmail,
// which already appends the daily-bust).
//
// This helper normalizes ANY URL that points at our `get_avatar` endpoint:
// strip any existing `v=` param, then append the current `?v=YYYYMMDD`.
// External URLs (R2/CDN, https://, data:) and non-avatar paths pass through
// untouched so we don't accidentally cache-bust unrelated images.
function _todayBust() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
function normalizeAvatarUrl(url) {
  if (!url || typeof url !== 'string') return url;
  // Only target our own avatar endpoint — leave R2/CDN/data: URLs alone.
  if (url.indexOf('get_avatar') === -1) return url;
  // ⚠️ Do NOT strip an existing `v=`. That carries the WS-pushed
  // `avatar_version` which the backend uses for ETag/304 negotiation, and
  // stripping it caused friend photos to revert to whatever version was
  // cached during the 2026-05-18 ACL outage (the URL became identical to
  // the poisoned-cache entry once daily-bust matched the stored v=).
  //
  // Strategy: keep any existing `v=` untouched, but ALWAYS overlay a fresh
  // `&d=YYYYMMDD` so the URL rotates daily even if `v=` is sticky. New
  // `&d=` → new cache key → fresh fetch → friend's photo appears again.
  const bust = _todayBust();
  // Replace existing &d= if present (idempotent), otherwise append.
  if (/[?&]d=\d{8}(?:&|$)/.test(url)) {
    return url.replace(/([?&])d=\d{8}/, `$1d=${bust}`);
  }
  const sep = url.indexOf('?') === -1 ? '?' : '&';
  return `${url}${sep}d=${bust}`;
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

// ── Group collage tile ──────────────────────────────────────────
// A single tile of a 2×2 (or 1+2) collage. Renders the member's avatar
// when available, otherwise falls back to their initials on a colored
// background — mirrors AvatarCircle's main rendering path but without the
// online-ring, cache-bump subscription, or recycling key (the parent
// AvatarCircle owns those concerns and forwards the right cacheBust here).
function _CollageTile({ member, size, width, height }) {
  const [tileErr, setTileErr] = useState(false);
  const [tileCachedUri, setTileCachedUri] = useState(null);
  // Tracks mount status so async cacheAvatar() resolutions don't setState
  // after the tile unmounts (chat-list rapid scroll → React warning +
  // memory leak when 100 tiles fire downloads but only 8 stay mounted).
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);
  useEffect(() => { setTileErr(false); setTileCachedUri(null); }, [member?.email, member?.avatar_url]);
  const ImageComponent = ExpoImage || RNImage;
  const memberEmail = typeof member?.email === 'string' ? member.email : '';
  const memberName = member?.display_name || member?.name || memberEmail || '';
  const looksLikeEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(memberEmail);
  const baseUrl = looksLikeEmail ? getAvatarUrlForEmail(memberEmail) : null;
  // Prefer an explicit avatar_url passed in by the caller — saves a redirect
  // and lets the caller pin a specific version (e.g. WS-pushed update).
  let uri = '';
  if (typeof member?.avatar_url === 'string' && member.avatar_url) {
    uri = /^https?:\/\//i.test(member.avatar_url)
      ? member.avatar_url
      : `https://chatyy.com.br${member.avatar_url.startsWith('/') ? '' : '/'}${member.avatar_url}`;
  } else if (baseUrl) {
    uri = baseUrl;
  }
  // Defensive: backend-supplied avatar_url has no cache-bust → roll it
  // through normalizeAvatarUrl so the daily ?v= applies. baseUrl already
  // has the bust (it comes from getAvatarUrlForEmail), so this is a no-op
  // for that branch but it normalizes any stale `v=` from a prior day.
  uri = normalizeAvatarUrl(uri);
  // Disk-persistent avatar cache — same hook as the main AvatarCircle
  // render path. Lets a group-row collage paint instantly offline once
  // the tile's avatar has been fetched once.
  if (Platform.OS !== 'web' && uri && /^https?:/i.test(uri)) {
    const _diskHit = getCachedAvatarUriOrNull(uri);
    if (_diskHit) {
      uri = _diskHit;
    } else if (tileCachedUri) {
      uri = tileCachedUri;
    } else {
      try {
        cacheAvatar(uri).then((result) => {
          if (!isMountedRef.current) return;
          if (typeof result === 'string' && result.startsWith('file://')) {
            setTileCachedUri(result);
          }
        }).catch(() => {});
      } catch {}
      const _online = _networkInfo?.isConnected?.() !== false;
      if (!_online) uri = '';
    }
  }
  const initials = getInitials(memberName, memberEmail);
  const bg = hashColor((memberName || memberEmail || '').toLowerCase());
  // Allow non-square tiles (WhatsApp 1+2 layout has a full-height left tile).
  // Default to square when only `size` is passed.
  const w = typeof width === 'number' ? width : size;
  const h = typeof height === 'number' ? height : size;
  // Tiles paint flush against neighbors — overflow:hidden on the container
  // does the circular clipping for the whole collage.
  return (
    <View style={{ width: w, height: h, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text
        style={{ color: '#fff', fontWeight: '600', fontSize: Math.max(8, Math.min(w, h) * 0.4), position: 'absolute' }}
        allowFontScaling={false}
      >
        {initials}
      </Text>
      {uri && !tileErr ? (
        <ImageComponent
          source={{ uri }}
          style={{ width: w, height: h, position: 'absolute' }}
          onError={() => setTileErr(true)}
          {...(ExpoImage ? { cachePolicy: 'memory-disk', contentFit: 'cover' } : (Platform.OS === 'web' ? { loading: 'lazy' } : {}))}
        />
      ) : null}
    </View>
  );
}

// ── Group collage layout ────────────────────────────────────────
// 2 members → side-by-side halves.
// 3 members → big tile on the left, 2 stacked on the right (WhatsApp 1+2).
// 4+ members → 2×2 grid with the first 4 entries.
function _GroupCollage({ members, size, style }) {
  const radius = size / 2;
  const m = (members || []).slice(0, 4);
  const count = m.length;
  const halfH = size / 2;
  const halfW = size / 2;
  return (
    <View
      style={[{ width: size, height: size, borderRadius: radius, overflow: 'hidden', backgroundColor: '#000', flexDirection: 'row' }, style, { width: size, height: size, borderRadius: radius }]}
      accessibilityLabel="Group avatar"
      accessibilityRole="image"
    >
      {count === 2 && (
        <>
          <_CollageTile member={m[0]} size={halfW} />
          <_CollageTile member={m[1]} size={halfW} />
        </>
      )}
      {count === 3 && (
        <>
          {/* Left tile is full-height (halfW × size) to match the WhatsApp
              1+2 layout. The two right tiles share the right half stacked. */}
          <_CollageTile member={m[0]} width={halfW} height={size} size={halfW} />
          <View style={{ width: halfW, height: size, flexDirection: 'column' }}>
            <_CollageTile member={m[1]} size={halfW} />
            <_CollageTile member={m[2]} size={halfW} />
          </View>
        </>
      )}
      {count >= 4 && (
        <>
          <View style={{ width: halfW, height: size, flexDirection: 'column' }}>
            <_CollageTile member={m[0]} size={halfW} />
            <_CollageTile member={m[2]} size={halfW} />
          </View>
          <View style={{ width: halfW, height: size, flexDirection: 'column' }}>
            <_CollageTile member={m[1]} size={halfW} />
            <_CollageTile member={m[3]} size={halfW} />
          </View>
        </>
      )}
    </View>
  );
}

function AvatarCircle({ name, email, uri, size = 48, style, online = false, ringColor = '#7C3AED', showStatus = false, members, onPress }) {
  const [imgError, setImgError] = useState(false);
  const [version, setVersion] = useState(() => getAvatarVersion(email));
  // Holds the file:// URI from avatarCache once a background download
  // lands mid-session. Initial value comes from the sync index inside
  // the render below; this state only flips when the very FIRST fetch
  // for a brand-new URL completes (subsequent mounts get the file://
  // from the sync index on first paint, no setState needed).
  const [cachedFileUri, setCachedFileUri] = useState(null);
  // Tracks mount status so async cacheAvatar() resolutions don't setState
  // after unmount. Without this, scrolling a long chat list fires N
  // downloads then 90% of the rows unmount before the downloads land,
  // and each resolution triggers a setState-on-unmounted-component
  // warning (+ wasted re-render scheduling).
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);
  useEffect(() => { setImgError(false); setVersion(getAvatarVersion(email)); setCachedFileUri(null); }, [email, uri]);

  // Subscribe to global cache bumps so this avatar refreshes when the user uploads a new pic.
  // IMPORTANT: this useEffect MUST run UNCONDITIONALLY before ANY early return so the hook
  // call order stays stable across renders. It is declared here — ABOVE the `_hasCollage`
  // group-collage short-circuit below — because that short-circuit returns early for group
  // avatars (members[] + no uri). If this hook lived after that return, opening a GROUP
  // conversation would render one FEWER hook than a 1:1 chat, and React throws
  // "Rendered more/fewer hooks than during the previous render" (P0 crash #1343 / WAVE 127).
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

  // ── Group collage short-circuit ────────────────────────────────
  // When the caller passes `members` and there's no single image to show
  // (no explicit `uri` AND no email-derived avatar would apply), render
  // a 2-4 tile collage of the first members instead of an initials bubble.
  // Behaves like a normal circular avatar from the parent's perspective —
  // same size/style/online-ring contract.
  const _hasCollage = Array.isArray(members) && members.length >= 2 && !uri;
  if (_hasCollage) {
    // Online ring honored even on collages so group "active" state can still
    // show — same wrapper math as the regular path further down.
    const ringWidth = online && showStatus ? 2 : 0;
    const totalSize = size + (ringWidth * 2) + 2;
    if (online && showStatus) {
      const node = (
        <View style={[{ width: totalSize, height: totalSize, borderRadius: totalSize / 2, alignItems: 'center', justifyContent: 'center', borderWidth: ringWidth, borderColor: ringColor, overflow: 'hidden' }, style, { borderRadius: totalSize / 2 }]}>
          <_GroupCollage members={members} size={size} />
          <View style={{
            position: 'absolute', right: 0, bottom: 0,
            width: Math.max(10, size * 0.25), height: Math.max(10, size * 0.25),
            borderRadius: Math.max(5, size * 0.125),
            backgroundColor: ringColor, borderWidth: 2, borderColor: '#fff',
          }} />
        </View>
      );
      return onPress
        ? <TouchableOpacity activeOpacity={0.7} onPress={onPress} accessibilityRole="button">{node}</TouchableOpacity>
        : node;
    }
    const node = <_GroupCollage members={members} size={size} style={style} />;
    return onPress
      ? <TouchableOpacity activeOpacity={0.7} onPress={onPress} accessibilityRole="button">{node}</TouchableOpacity>
      : node;
  }

  // ChatyyAI bot — special-cased app icon avatar with a winking-eye animation
  // (WAVE 46 brand refresh, 2026-05-21). The bot has no real account so its
  // /get_avatar request would 400. Render the in-app icon + blink instead.
  if (typeof email === 'string' && email.toLowerCase() === 'ai@chatyy.com.br') {
    return <ChatyyOneAvatar size={size} style={style} />;
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
  // Defensive daily-bust: when callers pass a backend-built URL like
  //   /api/email.php?action=get_avatar&email=X
  // (e.g. chat-conversation's `conversationAvatar` or any consumer relaying
  // `conv.avatar_url`), it has no `?v=` and would otherwise serve whatever
  // expo-image cached during the 2026-05-18 ACL outage. Normalize so every
  // get_avatar URL carries today's bust, regardless of how it got here.
  const normalizedExplicit = normalizeAvatarUrl(explicitUri);
  const _remoteResolved = normalizedExplicit || nativeLocal || remoteAvatarUrl;

  // ── Disk-persistent avatar cache (other users) ──────────────────
  // Consult avatarCache's sync index FIRST: if the bytes are on disk
  // we hand a file:// URI to expo-image and the avatar paints on the
  // very first commit — no network round-trip, works offline.
  //
  // On cache miss we fire `cacheAvatar()` fire-and-forget; the next
  // mount of this row (after the download lands) will hit the sync
  // index. We ALSO setState the resolved file:// path so the CURRENT
  // mount picks it up without waiting for a re-mount (smoother for
  // contacts the user opens before backgrounding the app).
  //
  // Offline + cache miss → initials only. Without this gate
  // expo-image would attempt the fetch, fail silently, and the user
  // sees a flash of empty avatar before the onError fires.
  let avatarUrl = _remoteResolved;
  if (Platform.OS !== 'web' && _remoteResolved && /^https?:/i.test(_remoteResolved)) {
    const _diskHit = getCachedAvatarUriOrNull(_remoteResolved);
    if (_diskHit) {
      avatarUrl = _diskHit;
    } else if (cachedFileUri) {
      // Background download landed mid-session.
      avatarUrl = cachedFileUri;
    } else {
      // Miss — fire background download (idempotent + deduped inside).
      try {
        cacheAvatar(_remoteResolved).then((result) => {
          if (!isMountedRef.current) return;
          if (typeof result === 'string' && result.startsWith('file://')) {
            setCachedFileUri(result);
          }
        }).catch(() => {});
      } catch {}
      // If offline AND nothing on disk, drop the URL so we render
      // initials instead of letting expo-image flash an empty box
      // before its onError handler fires.
      const _online = _networkInfo?.isConnected?.() !== false;
      if (!_online) avatarUrl = null;
    }
  }
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
    const node = (
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
    return onPress
      ? <TouchableOpacity activeOpacity={0.7} onPress={onPress} accessibilityRole="button" accessibilityLabel={accessLabel}>{node}</TouchableOpacity>
      : node;
  }

  // ALWAYS force the wrapper to be round + clip overflow. Without this, a
  // caller passing `style={{ borderWidth: 3, borderColor: ... }}` (e.g.
  // live-viewer's endedAvatar) would paint a SQUARE ring around the circular
  // inner avatar, since `inner` is sized + radiused but the wrapper View
  // wasn't. Putting size/radius LAST guarantees they win even when the caller
  // passes a conflicting style. (Bug visible in IMG_6703 — square frame
  // behind the host's circular avatar on /live-viewer "Stream indisponível".)
  const node = (
    <View style={[{ width: size, height: size, overflow: 'hidden' }, style, { width: size, height: size, borderRadius: size / 2 }]}>
      {inner}
    </View>
  );
  return onPress
    ? <TouchableOpacity activeOpacity={0.7} onPress={onPress} accessibilityRole="button" accessibilityLabel={accessLabel}>{node}</TouchableOpacity>
    : node;
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
  // For group collages we need to know when the member list shape changes
  // — but a shallow array identity check is fine because callers either
  // pass a stable memoized array or recreate it intentionally when the
  // backing data changes.
  if (prev.members !== next.members) {
    const pm = prev.members, nm = next.members;
    // Both falsy → still equal on this dim.
    if (!pm && !nm) {
      // fall through to the other props
    } else if (!pm || !nm || pm.length !== nm.length) {
      return false;
    } else {
      // Compare the first 4 entries (only those are rendered) by email +
      // avatar_url. Cheap enough at 4 slots, avoids re-renders when the
      // parent rebuilds a logically identical members array each tick.
      const n = Math.min(4, pm.length);
      for (let i = 0; i < n; i++) {
        if ((pm[i]?.email || '') !== (nm[i]?.email || '')) return false;
        if ((pm[i]?.avatar_url || '') !== (nm[i]?.avatar_url || '')) return false;
      }
    }
  }
  return (
    prev.email === next.email &&
    prev.name === next.name &&
    prev.uri === next.uri &&
    prev.size === next.size &&
    prev.online === next.online &&
    prev.ringColor === next.ringColor &&
    prev.showStatus === next.showStatus &&
    // `onPress` swaps from undefined → fn when the caller wires tap-to-fullscreen
    // mid-mount (rare, but happens on Profile peek's avatar). Treating it as a
    // tracked dim means a freshly-passed callback re-wraps the avatar in a
    // TouchableOpacity instead of staying inert.
    (typeof prev.onPress === 'function') === (typeof next.onPress === 'function')
  );
}
export default memo(AvatarCircle, _avatarEqual);
