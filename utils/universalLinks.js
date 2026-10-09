// [2026-10-09 universal-links] Single source of truth for https://chatyy.com.br
// links that open INSIDE the app (iOS Universal Links / Android App Links).
//
// The server side lives in /var/www/mail/.well-known/apple-app-site-association
// (applinks components) and assetlinks.json; the Android intent-filter paths are
// in app.json. Keep the three lists in sync with UNIVERSAL_PATHS below.
//
// Pure JS (no native deps): app/+native-intent.js uses it to rewrite the system
// URL into an expo-router path, and app/_layout.js uses it to avoid pushing the
// same screen twice. Anything not listed here returns null and keeps the old
// behavior (custom scheme, share intents, notifications, etc.).

const HOSTS = new Set(['chatyy.com.br', 'www.chatyy.com.br']);

// Conservative token/handle shapes: never let an arbitrary string become a path.
const TOKEN_RE = /^[A-Za-z0-9_-]{4,128}$/;
const HANDLE_RE = /^[A-Za-z0-9._@+-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function _safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function _parse(url) {
  if (!url || typeof url !== 'string') return null;
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    if (!HOSTS.has(String(u.hostname || '').toLowerCase())) return null;
    return u;
  } catch {
    // Minimal fallback parser (URL polyfill missing on very old engines).
    const m = url.match(/^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i);
    if (!m || !HOSTS.has(m[1].toLowerCase())) return null;
    const params = {};
    String(m[3] || '').replace(/^\?/, '').split('&').forEach((kv) => {
      if (!kv) return;
      const i = kv.indexOf('=');
      const k = _safeDecode(i >= 0 ? kv.slice(0, i) : kv);
      params[k] = _safeDecode(i >= 0 ? kv.slice(i + 1) : '');
    });
    return {
      pathname: m[2] || '/',
      searchParams: { get: (k) => (Object.prototype.hasOwnProperty.call(params, k) ? params[k] : null) },
    };
  }
}

/**
 * Resolve an incoming https URL.
 * @returns {null | { href: string, owner: 'router' | 'layout' }}
 *   owner 'router' → expo-router navigates to href (via +native-intent);
 *   owner 'layout' → app/_layout.js handleUrl does the navigation (chat needs
 *   openConversation() so it replaces an open chat instead of stacking).
 */
export function resolveUniversalLink(url) {
  const u = _parse(url);
  if (!u) return null;
  const path = String(u.pathname || '/').replace(/\/+$/, '') || '/';
  const seg = path.split('/').filter(Boolean).map(_safeDecode);
  const first = seg[0] || '';

  // /@handle → profile
  if (first.startsWith('@') && seg.length === 1) {
    const h = first.slice(1);
    return HANDLE_RE.test(h) ? { href: '/u/' + encodeURIComponent(h), owner: 'router' } : null;
  }
  switch (first) {
    case 'call':
      return seg[1] && ID_RE.test(seg[1]) ? { href: '/call/' + seg[1], owner: 'router' } : null;
    case 'j':
    case 'g':
      // Backend mints chatyy.com.br/g/<token>; the app screen is /j/[token].
      return seg[1] && TOKEN_RE.test(seg[1]) ? { href: '/j/' + seg[1], owner: 'router' } : null;
    case 'u':
      return seg[1] && HANDLE_RE.test(seg[1]) ? { href: '/u/' + encodeURIComponent(seg[1]), owner: 'router' } : null;
    case 'ch':
      return seg[1] && HANDLE_RE.test(seg[1]) ? { href: '/ch/' + encodeURIComponent(seg[1]), owner: 'router' } : null;
    case 'live':
      if (!seg[1] || seg[1] === 'recap' || !ID_RE.test(seg[1])) return null;
      return { href: '/live/' + seg[1], owner: 'router' };
    case 'feed':
      return seg[1] && ID_RE.test(seg[1]) ? { href: '/feed/' + seg[1], owner: 'router' } : null;
    case 'meet': {
      if (seg[1] === 'room.html') {
        const id = u.searchParams.get('id') || '';
        return ID_RE.test(id) ? { href: '/meet/' + id, owner: 'router' } : { href: '/meetings', owner: 'router' };
      }
      if (seg.length === 2 && ID_RE.test(seg[1]) && seg[1] !== 'bg') return { href: '/meet/' + seg[1], owner: 'router' };
      return null;
    }
    case 'chat':
      return seg[1] && /^\d+$/.test(seg[1]) ? { href: '/chat-conversation?id=' + seg[1], owner: 'layout' } : null;
    case 'stickers': {
      if (seg[1] !== 'store') return null;
      const inst = u.searchParams.get('install') || '';
      return { href: inst ? '/stickers/store?install=' + encodeURIComponent(inst) : '/stickers/store', owner: 'router' };
    }
    default:
      return null;
  }
}

// Mirror of the app-claimed paths (documentation + tests).
export const UNIVERSAL_PATHS = ['/call/', '/j/', '/g/', '/u/', '/@', '/ch/', '/live/', '/feed/', '/meet/', '/chat/', '/stickers/store'];
