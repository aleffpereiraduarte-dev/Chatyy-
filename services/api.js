import { Platform } from 'react-native';
import { DEFAULT_E2EE } from '../constants/featureFlags';

// ─── Edge Network — auto-detect fastest server ───
// Tests all edge servers in parallel, picks the one with lowest latency.
// Remembers the best server in MMKV so next app open is instant.

const EDGE_SERVERS = [
  { url: 'https://chatyy.com.br', region: 'br', base: 'https://chatyy.com.br' },
];

let _bestServer = null;
let _detecting = false;

// Migration: clear any stale cached edge server. Users upgrading from old
// builds may have cached a dead edge (api-us/api-eu/api-asia), which causes
// every request to silently fail and show the "offline" wifi-off icon.
// Force-clear unconditionally — detection runs again on app open anyway.
try {
  const _mig = (() => { try { return require('./mmkv'); } catch { return null; } })();
  if (_mig && typeof _mig.getString === 'function') {
    const cached = _mig.getString('edge_best_server');
    if (cached) {
      let shouldClear = true;
      try {
        const parsed = JSON.parse(cached);
        // Only keep cache if it points to the 'br' region (chatyy.com.br origin)
        // AND has the latest version. Any other cached value is purged.
        if (parsed.region === 'br' && parsed.v === 10) shouldClear = false;
      } catch {}
      if (shouldClear && typeof _mig.setString === 'function') {
        _mig.setString('edge_best_server', '');
      }
    }
  }
} catch {}
try {
  if (typeof localStorage !== 'undefined') {
    const cached = localStorage.getItem('edge_best_server');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (!(parsed.region === 'br' && parsed.v === 10)) {
          localStorage.removeItem('edge_best_server');
        }
      } catch { localStorage.removeItem('edge_best_server'); }
    }
  }
} catch {}

// Declare API_URL and BASE_URL BEFORE _restoreCachedServer() which assigns them.
// They were previously declared after the call site, causing a Temporal Dead Zone
// (TDZ) ReferenceError on web when MMKV had a cached edge server.
let API_URL = 'https://chatyy.com.br/api/email.php';
export function getApiUrl() { return API_URL; }
export let BASE_URL = 'https://chatyy.com.br';
// [2026-05-30] media.chatyy.com.br is a Cloudflare CNAME → public.r2.dev (R2)
// that was NEVER bound to a bucket → it 404s EVERY /data/ path (verified: even
// `/` 404s). The actual chat/status/sticker/reel files live on the origin disk,
// served 200 by chatyy.com.br/data/ (which is also Cloudflare-proxied, so still
// edge-cached). Pointing CDN_URL at the dead R2 host meant every photo/sticker
// 404'd then fell back to a slow origin retry = "fotos demorando carregar".
// Until media.chatyy.com.br is repointed/bound at the DNS layer, serve from the
// origin host that works. getMediaUrl() below also rewrites any baked-in
// media.chatyy.com.br URL (in already-sent messages) to this host.
export const CDN_URL = 'https://chatyy.com.br';
// Android cellular (Brazil 4G in particular) often takes >15s for the first
// round-trip through Cloudflare proxy + PHP-FPM. 15s was producing
// "timeout" aborts that left messages stuck in the offline queue while the
// server had ALREADY persisted the row — user saw infinite clock icon and
// thought send was broken. 25s aligns with WhatsApp/Telegram's tolerance.
const TIMEOUT_MS = 25000;

// Restore last known best server from MMKV (instant, <1ms)
function _restoreCachedServer() {
  try {
    const mmkv = require('./mmkv');
    const cached = mmkv.getString('edge_best_server');
    if (cached) {
      const parsed = JSON.parse(cached);
      // Invalidate cache if edge list changed (version 10 = single 'br' edge: chatyy.com.br)
      if (parsed.v !== 10) { mmkv.delete('edge_best_server'); return; }
      const match = EDGE_SERVERS.find(s => s.region === parsed.region);
      if (match) {
        _bestServer = { ...match, latency: parsed.latency };
        API_URL = match.url + '/api/email.php';
        BASE_URL = match.base;
        if (__DEV__) console.log('[API] Restored edge: ' + match.region + ' (' + parsed.latency + 'ms cached)');
      }
    }
  } catch {}
}
_restoreCachedServer();

async function detectFastestServer() {
  if (_detecting) return;
  _detecting = true;
  try {
    const results = await Promise.allSettled(
      EDGE_SERVERS.map(async (s) => {
        const start = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        try {
          await fetch(s.url + '/health', { signal: controller.signal, cache: 'no-store' });
          clearTimeout(timeout);
          return { ...s, latency: Date.now() - start };
        } catch { clearTimeout(timeout); return { ...s, latency: 99999 }; }
      })
    );
    const sorted = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => a.latency - b.latency);
    if (sorted.length > 0 && sorted[0].latency < 4000) {
      _bestServer = sorted[0];
      API_URL = _bestServer.url + '/api/email.php';
      BASE_URL = _bestServer.base;
      if (__DEV__) console.log(`[API] Best server: ${_bestServer.region} (${_bestServer.latency}ms)`);
      // Save to MMKV for instant restore on next app open
      try {
        const mmkv = require('./mmkv');
        mmkv.setString('edge_best_server', JSON.stringify({ region: _bestServer.region, latency: _bestServer.latency, v: 10 }));
      } catch {}
    }
  } catch {} finally { _detecting = false; }
}

// Detect immediately (don't wait 2s)
detectFastestServer();

// Re-detect every 5 min in case network changes. Stored so we can cancel
// on logout / app background to avoid battery drain.
let _edgeDetectInterval = setInterval(detectFastestServer, 300000);
export function stopEdgeDetection() {
  if (_edgeDetectInterval) { clearInterval(_edgeDetectInterval); _edgeDetectInterval = null; }
}
export function startEdgeDetection() {
  if (!_edgeDetectInterval) _edgeDetectInterval = setInterval(detectFastestServer, 300000);
}

// Export for components that need to know the current edge
export function getEdgeInfo() {
  return _bestServer ? { region: _bestServer.region, latency: _bestServer.latency, url: _bestServer.url } : null;
}

// Always returns the current BASE_URL (not a stale captured value from import time)
export function getBaseUrl() {
  return BASE_URL;
}

// API_URL, BASE_URL, CDN_URL, TIMEOUT_MS declared above (before _restoreCachedServer)

/**
 * Convert a file URL to the best available URL.
 * New messages already have CDN URLs (https://media.chatyy.com.br/...).
 * Legacy messages with /data/... paths get routed through the main server.
 */
export function getMediaUrl(fileUrl) {
  if (!fileUrl) return '';
  if (typeof fileUrl !== 'string') return '';
  // [2026-05-26] CRITICAL: pass LOCAL / already-resolved URIs through
  // untouched. Callers like ChatMedia (and the chat image bubble's `fullUri`)
  // can hand us a value that resolveMediaUri/syncIndex already turned into a
  // `file://` (cached photo on disk), or a picker `content://`/`ph://`, or a
  // web `blob:`/`data:` preview. None of these start with `http` nor `/data/`,
  // so the BASE_URL fallback at the bottom would glue the origin host in front
  // of them → `https://chatyy.com.brfile:///var/...` = a broken URL that
  // ExpoImage can't load. On iOS that failed load painted transparent and
  // never reliably fired onError, leaving the chat photo bubble as an empty
  // gray skeleton box (timestamp + ✓✓ overlaid). Stickers/GIFs were fine
  // because they pass a raw http/CDN URL straight through. Guard it here so
  // the function is idempotent on local/absolute inputs.
  if (/^(file|content|ph|asset|assets-library|blob|data):/i.test(fileUrl)) {
    return fileUrl;
  }
  // Already a full URL — rewrite self-hosted paths to the CDN so feed/reels
  // load from Cloudflare edge instead of the origin (60-80% faster TTFB on
  // mobile). External third-party URLs pass through untouched.
  if (fileUrl.startsWith('http')) {
    try {
      const u = new URL(fileUrl);
      // [2026-05-31] media.chatyy.com.br is BACK to serving R2 objects (verified:
      // /chat/*.mp4 → 200 video/mp4, /status/*.mp4 → 200). So the host split now
      // matters and a blanket rewrite-to-origin BREAKS R2-native media:
      //  • `/data/*`  → physical files on the ORIGIN disk. R2 lacks these keys, so
      //    media.* 404s them → rewrite to chatyy.com.br (origin serves 200).
      //  • everything else (`/chat/`, `/status/`, `/reels/`, `/stickers/`, …) is
      //    R2-NATIVE — media.* serves it 200, but the ORIGIN has no such path and
      //    returns the SPA index.html shell (HTTP 200, ~1KB text/html). A video/
      //    image decoder handed that HTML can't open it → "o vídeo não carrega/
      //    não abre". So KEEP those on media.*. (Root cause of the received-video
      //    bug, 2026-05-31.)
      if (u.hostname === 'media.chatyy.com.br') {
        if (u.pathname.startsWith('/data/')) {
          return 'https://chatyy.com.br' + u.pathname + (u.search || '');
        }
        return fileUrl; // R2-native path — media.chatyy.com.br serves it directly
      }
      if (u.hostname === 'chatyy.com.br' || u.hostname === 'www.chatyy.com.br' || u.hostname === 'mail.onemundo.com.br') {
        const p = u.pathname;
        // /data/status/ added so status fotos/videos + reels/feed bytes
        // route through the Cloudflare edge globally (was hitting US origin
        // ~2-4s pre-fix). Mirrors the relative-path branch below.
        if (p.startsWith('/data/feed-files/')
            || p.startsWith('/data/chat-files/')
            || p.startsWith('/data/drive-files/')
            || p.startsWith('/data/status/')
            || p.startsWith('/data/reels/')
            || p.startsWith('/data/highlights/')) {
          return CDN_URL + p + (u.search || '');
        }
      }
    } catch {}
    return fileUrl;
  }
  // Relative path — always go CDN for media dirs.
  if (fileUrl.startsWith('/data/feed-files/')
      || fileUrl.startsWith('/data/chat-files/')
      || fileUrl.startsWith('/data/drive-files/')
      || fileUrl.startsWith('/data/status/')
      || fileUrl.startsWith('/data/reels/')
      || fileUrl.startsWith('/data/highlights/')) {
    return CDN_URL + fileUrl;
  }
  return BASE_URL + fileUrl;
}

let sessionCookie = '';
let authToken = '';
let csrfToken = ''; // CSRF protection token from server
let savedCredentials = null; // For auto-relogin on session expiry
// Refresh token (180d, rotated on each use). Exchanges for fresh access token
// without requiring password. Persisted in SecureStore via storeRefreshToken.
let refreshToken = '';
let refreshDeviceId = '';
let _authRefreshInFlight = null; // single-flight promise for /auth_refresh endpoint
export function getSavedEmail() { return savedCredentials?.email || ''; }
export function getSavedPassword() { return savedCredentials?.password || ''; }
export function hasRefreshToken() { return !!refreshToken; }

// Go Fast Auth endpoints (100x faster than PHP)
function goAuthUrl(path) {
  return (BASE_URL || 'https://chatyy.com.br') + '/api/go-auth/' + path;
}
let deviceTrustToken = ''; // Device trust token — persists across sessions to prevent re-verification

// Token readiness promise — resolves when authToken is loaded from storage
let _tokenReadyResolve = null;
const _tokenReadyPromise = new Promise((resolve) => { _tokenReadyResolve = resolve; });

// App-wide user language (pt | en | es | fr | de | it). Set from the
// LanguageContext on boot / language change so every API call tells the
// backend which language to respond in. Falls back to device locale.
let _userLanguage = '';
export function setUserLanguage(lang) {
  if (typeof lang === 'string') _userLanguage = lang.toLowerCase().slice(0, 2);
}
export function getUserLanguage() { return _userLanguage; }

export function getAuthHeaders() {
  const h = {};
  if (authToken) h['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) h['X-CSRF-Token'] = csrfToken;
  if (_userLanguage) h['X-User-Language'] = _userLanguage;
  return h;
}

// Token & credential persistence — works on BOTH web and mobile.
//
// WhatsApp-grade redundancy (2026-05-15): the token is mirrored to
// BOTH SecureStore (canonical) AND AsyncStorage (fallback). On hydrate
// we read both — whichever has a value wins, and we re-sync the other
// so they reconverge. Reason: Carol-style "logged out after a week"
// almost always traces to SecureStore returning null on cold boot
// (keychain ACL mismatch, OS reset of keychain after passcode change,
// iCloud Keychain conflict on Restore From iCloud Backup, ...). A
// duplicate AsyncStorage copy means the user keeps their session even
// when keychain forgets. Auto-logout never fires while EITHER copy is
// present and fresh (≤90 days). Also persists a `mail_token_meta` blob
// with `last_auth_ok_at` + `created_at` so the 401 handler can refuse
// logout when the token is demonstrably alive.
const TOKEN_META_KEY = 'mail_token_meta';     // AsyncStorage
const TOKEN_FALLBACK_KEY = 'mail_token_fb';   // AsyncStorage redundant copy
const TOKEN_GRACE_DAYS = 90;                   // WhatsApp parity: refuse logout for fresh tokens
const TOKEN_GRACE_MS = TOKEN_GRACE_DAYS * 24 * 60 * 60 * 1000;

let _tokenMeta = { last_auth_ok_at: 0, created_at: 0, email: '' };

async function _readAsyncStorage(key) {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    return await AsyncStorage.getItem(key);
  } catch { return null; }
}
async function _writeAsyncStorage(key, value) {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    if (value == null) await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, value);
  } catch {}
}

async function _loadTokenMeta() {
  try {
    let raw = null;
    if (Platform.OS === 'web') {
      raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(TOKEN_META_KEY) : null;
    } else {
      raw = await _readAsyncStorage(TOKEN_META_KEY);
    }
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        _tokenMeta = {
          last_auth_ok_at: Number(parsed.last_auth_ok_at || 0),
          created_at: Number(parsed.created_at || 0),
          email: String(parsed.email || ''),
        };
      }
    }
  } catch {}
}
async function _saveTokenMeta() {
  try {
    const raw = JSON.stringify(_tokenMeta);
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') localStorage.setItem(TOKEN_META_KEY, raw);
    } else {
      await _writeAsyncStorage(TOKEN_META_KEY, raw);
    }
  } catch {}
}

// Read the token's age (ms since last server-confirmed auth-OK). Used by
// the 401 handler / WS auth_error path to refuse logout when the token
// has been working recently. Returns Infinity when no meta has been
// recorded yet (treat as old → don't refuse).
function _tokenLastOkAgeMs() {
  const ts = _tokenMeta.last_auth_ok_at || _tokenMeta.created_at || 0;
  if (!ts) return Infinity;
  return Date.now() - ts;
}

// Public: refuse logout if token is fresh? Exposed so AuthContext and
// websocket.js can both consult the same WhatsApp-grade gate.
export function isTokenWithinGracePeriod() {
  if (!authToken) return false;
  return _tokenLastOkAgeMs() < TOKEN_GRACE_MS;
}
export function getTokenMeta() { return { ..._tokenMeta }; }

// Bump the success timestamp. Called from _apiCallImpl on any non-401
// response — proves the network + token are alive. Cheap (in-memory),
// throttled disk write (max once per 5 min).
let _lastMetaPersist = 0;
function _noteAuthOk() {
  _tokenMeta.last_auth_ok_at = Date.now();
  // A confirmed-alive token must clear the ghost-login streak, otherwise an
  // old streak could survive a recovery and trip a false logout later.
  _consecutive401NoError = 0;
  const now = Date.now();
  if (now - _lastMetaPersist > 5 * 60 * 1000) {
    _lastMetaPersist = now;
    _saveTokenMeta().catch(() => {});
  }
}

// Audit trail: every logout path (explicit, auto, token-rejected) records
// {ts, reason, source} into AsyncStorage so we can post-mortem why Carol
// got kicked. Capped at 20 entries, oldest first.
const LOGOUT_AUDIT_KEY = 'mail_logout_audit_v1';
export async function recordLogoutAttempt(reason, extra = {}) {
  try {
    const entry = {
      ts: Date.now(),
      reason: String(reason || 'unknown'),
      email: String(_tokenMeta.email || ''),
      had_token: !!authToken,
      last_ok_age_ms: _tokenLastOkAgeMs() === Infinity ? null : _tokenLastOkAgeMs(),
      ...extra,
    };
    let prior = [];
    if (Platform.OS === 'web') {
      try { prior = JSON.parse(localStorage.getItem(LOGOUT_AUDIT_KEY) || '[]') || []; } catch {}
    } else {
      const raw = await _readAsyncStorage(LOGOUT_AUDIT_KEY);
      try { prior = raw ? JSON.parse(raw) : []; } catch {}
    }
    if (!Array.isArray(prior)) prior = [];
    prior.push(entry);
    if (prior.length > 20) prior = prior.slice(-20);
    const out = JSON.stringify(prior);
    if (Platform.OS === 'web') {
      try { localStorage.setItem(LOGOUT_AUDIT_KEY, out); } catch {}
    } else {
      await _writeAsyncStorage(LOGOUT_AUDIT_KEY, out);
    }
    try { console.warn('[auth] logout audit:', entry.reason, JSON.stringify(entry)); } catch {}
  } catch {}
}
export async function getLogoutAudit() {
  try {
    let raw = null;
    if (Platform.OS === 'web') {
      raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(LOGOUT_AUDIT_KEY) : null;
    } else {
      raw = await _readAsyncStorage(LOGOUT_AUDIT_KEY);
    }
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function getStoredToken() {
  // Read from BOTH stores. Prefer the canonical store, but fall back to
  // the AsyncStorage mirror if it's missing. Whoever wins re-writes the
  // loser so they reconverge — WhatsApp-grade redundancy.
  let primary = null;
  let fallback = null;
  try {
    if (Platform.OS === 'web') {
      primary = typeof localStorage !== 'undefined' ? localStorage.getItem('mail_token') : null;
      // Web has no AsyncStorage; we use sessionStorage as the secondary.
      try { fallback = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem(TOKEN_FALLBACK_KEY) : null; } catch {}
    } else {
      try {
        const SecureStore = require('expo-secure-store');
        primary = await SecureStore.getItemAsync('mail_token');
        // One-time migration: existing tokens were stored with the default
        // accessibility (WHEN_UNLOCKED) so they can't be read on a locked
        // device — which is exactly when CallKit needs the token to wake
        // the WS for an incoming call. Re-write with
        // AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY so the next locked-screen
        // answer can actually hydrate auth. Idempotent: the write is cheap
        // and the keychain ACL just updates in place.
        if (primary && Platform.OS === 'ios' && !_tokenAccessMigrated) {
          _tokenAccessMigrated = true;
          try {
            await SecureStore.setItemAsync('mail_token', primary, {
              keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
            });
          } catch {}
        }
      } catch { primary = null; }
      fallback = await _readAsyncStorage(TOKEN_FALLBACK_KEY);
    }
  } catch {}

  const token = primary || fallback || null;
  // Reconverge: if one store lost the token but the other has it, copy back.
  if (token) {
    try {
      if (Platform.OS === 'web') {
        if (!primary && typeof localStorage !== 'undefined') localStorage.setItem('mail_token', token);
        if (!fallback && typeof sessionStorage !== 'undefined') sessionStorage.setItem(TOKEN_FALLBACK_KEY, token);
      } else {
        if (!primary) {
          try {
            const SecureStore = require('expo-secure-store');
            await SecureStore.setItemAsync('mail_token', token, {
              keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
            });
          } catch {}
        }
        if (!fallback) await _writeAsyncStorage(TOKEN_FALLBACK_KEY, token);
      }
    } catch {}
  }

  // Hydrate meta as well so the 90-day grace check works on cold start.
  await _loadTokenMeta();

  return token;
}
let _tokenAccessMigrated = false;

async function storeToken(token) {
  // Write to BOTH stores so a future keychain hiccup can't lose the
  // session. This is the WhatsApp-grade fix for "Carol logged out after
  // a week" — even if SecureStore returns null on cold boot (keychain
  // ACL mismatch, OS-level reset, iCloud Restore conflict), the
  // AsyncStorage mirror keeps the user signed in.
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') {
        if (token) localStorage.setItem('mail_token', token);
        else localStorage.removeItem('mail_token');
      }
      try {
        if (typeof sessionStorage !== 'undefined') {
          if (token) sessionStorage.setItem(TOKEN_FALLBACK_KEY, token);
          else sessionStorage.removeItem(TOKEN_FALLBACK_KEY);
        }
      } catch {}
    } else {
      try {
        const SecureStore = require('expo-secure-store');
        if (token) {
          // iOS: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY lets the keychain entry
          // be read while the screen is locked (provided the device was
          // unlocked at least once since boot). Without this the default
          // accessibility is WHEN_UNLOCKED and SecureStore.getItemAsync
          // returns null on a locked phone — which is exactly the state
          // we're in when CallKit wakes the app from a VoIP push and the
          // user accepts the call from the lock screen. Result: no token,
          // no WS reconnect, the call screen lands without an SDP offer
          // and the user sees the "answer failed" black screen.
          await SecureStore.setItemAsync('mail_token', token, {
            keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
          });
        } else {
          await SecureStore.deleteItemAsync('mail_token');
        }
      } catch {}
      // Redundant AsyncStorage mirror — survives SecureStore loss.
      try { await _writeAsyncStorage(TOKEN_FALLBACK_KEY, token || null); } catch {}
    }
  } catch {}

  // Bump meta: a freshly-stored token means we just did a successful
  // login/refresh/restore. Mark `created_at` once, refresh `last_auth_ok_at`.
  if (token) {
    if (!_tokenMeta.created_at) _tokenMeta.created_at = Date.now();
    _tokenMeta.last_auth_ok_at = Date.now();
    _saveTokenMeta().catch(() => {});
  }

  // Mirror the new token into UserDefaults so the iOS BGTaskScheduler photo
  // backup handler — which runs without JS — has a fresh token waiting.
  try {
    if (Platform.OS === 'ios' && token) {
      const { persistBackupCreds } = require('./autoBackup');
      persistBackupCreds?.();
    }
  } catch {}

  // Mirror the new token into the Android/iOS native-call SharedPrefs/App-Group
  // so LkTokenFetcher (which runs from a Service without JS) sees the rotated
  // bearer. Without this the native call activity uses a stale snapshot from
  // login and falls into "Sessão expirada" the moment the JS bearer rotates
  // (header `x-auth-token`, response.body.token, or auto-relogin).
  if (token) {
    try { _persistAuthForNative(token).catch(() => {}); } catch {}
  }
}

function getStoredCredentials() {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const c = localStorage.getItem('mail_creds');
      return c ? JSON.parse(c) : null;
    }
  } catch {}
  return null;
}

function storeCredentials(email, password) {
  // Only store in memory — never persist plaintext passwords to localStorage
  // The server session handles persistence; auto-relogin uses in-memory creds only
}

// --- Device trust token storage (persists to survive app restarts) ---
async function getStoredTrustToken() {
  try {
    if (Platform.OS === 'web') {
      return typeof localStorage !== 'undefined' ? localStorage.getItem('device_trust_token') : null;
    }
    const SecureStore = require('expo-secure-store');
    return await SecureStore.getItemAsync('device_trust_token');
  } catch { return null; }
}

async function storeTrustToken(token) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') {
        if (token) localStorage.setItem('device_trust_token', token);
        else localStorage.removeItem('device_trust_token');
      }
      return;
    }
    const SecureStore = require('expo-secure-store');
    if (token) await SecureStore.setItemAsync('device_trust_token', token);
    else await SecureStore.deleteItemAsync('device_trust_token');
  } catch {}
}

// Load trust token on startup
(async () => {
  try {
    const stored = await getStoredTrustToken();
    if (stored) deviceTrustToken = stored;
  } catch {}
})();

// --- Refresh token persistence (SecureStore on native, localStorage on web) ---
// Refresh token (180d, rotated on use) is the *only* path to silent re-auth
// when the access token (bearer) goes 401. Stored encrypted at rest on iOS/Android
// via expo-secure-store. On web, localStorage (which is per-origin sandboxed).
async function storeRefreshToken(token, deviceId) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') {
        if (token) {
          localStorage.setItem('refresh_token', token);
          if (deviceId) localStorage.setItem('refresh_device_id', deviceId);
        } else {
          localStorage.removeItem('refresh_token');
          localStorage.removeItem('refresh_device_id');
        }
      }
      return;
    }
    const SecureStore = require('expo-secure-store');
    if (token) {
      await SecureStore.setItemAsync('refresh_token', token);
      if (deviceId) await SecureStore.setItemAsync('refresh_device_id', deviceId);
    } else {
      await SecureStore.deleteItemAsync('refresh_token').catch(() => {});
      await SecureStore.deleteItemAsync('refresh_device_id').catch(() => {});
    }
  } catch (e) {
    try { console.warn('[refresh] storeRefreshToken err:', e?.message); } catch {}
  }
}

async function getStoredRefreshToken() {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return null;
      const t = localStorage.getItem('refresh_token');
      const d = localStorage.getItem('refresh_device_id');
      return t ? { token: t, deviceId: d || '' } : null;
    }
    const SecureStore = require('expo-secure-store');
    const t = await SecureStore.getItemAsync('refresh_token');
    const d = await SecureStore.getItemAsync('refresh_device_id');
    return t ? { token: t, deviceId: d || '' } : null;
  } catch { return null; }
}

// Load refresh token on startup so on cold-start we can silently refresh if
// the in-memory bearer (also loaded from storage) turns out to be 401.
(async () => {
  try {
    const stored = await getStoredRefreshToken();
    if (stored?.token) {
      refreshToken = stored.token;
      refreshDeviceId = stored.deviceId || '';
    }
  } catch {}
})();

// --- Multi-account storage (works on web + mobile) ---
let _cachedAccounts = null;

function getStoredAccounts() {
  if (_cachedAccounts) return _cachedAccounts;
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const a = localStorage.getItem('mail_accounts');
      const parsed = a ? JSON.parse(a) : [];
      // Defensive: legacy clients (or sloppy bearer injection paths) may
      // have written an object map { "email": {...} } instead of the
      // canonical array [{...}, {...}] — crashed inbox.js with
      // "accounts.filter is not a function". Coerce to array shape.
      if (Array.isArray(parsed)) {
        _cachedAccounts = parsed;
      } else if (parsed && typeof parsed === 'object') {
        _cachedAccounts = Object.entries(parsed).map(([email, v]) => ({
          email,
          ...(v && typeof v === 'object' ? v : {}),
        }));
      } else {
        _cachedAccounts = [];
      }
      return _cachedAccounts;
    }
  } catch {}
  return _cachedAccounts || [];
}

function storeAccounts(accounts) {
  _cachedAccounts = accounts;
  try {
    const json = JSON.stringify(accounts);
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      localStorage.setItem('mail_accounts', json);
    } else {
      const SecureStore = require('expo-secure-store');
      SecureStore.setItemAsync('mail_accounts', json).catch(() => {});
    }
  } catch {}
}

// Load accounts from SecureStore on mobile at startup
(async () => {
  if (Platform.OS !== 'web') {
    try {
      const SecureStore = require('expo-secure-store');
      const a = await SecureStore.getItemAsync('mail_accounts');
      if (a) _cachedAccounts = JSON.parse(a);
    } catch {}
  }
})();

let _cachedActiveAccount = '';

function getActiveAccountEmail() {
  if (_cachedActiveAccount) return _cachedActiveAccount;
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      _cachedActiveAccount = localStorage.getItem('mail_active_account') || '';
    }
  } catch {}
  return _cachedActiveAccount;
}

function setActiveAccountEmail(email) {
  _cachedActiveAccount = email || '';
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      if (email) localStorage.setItem('mail_active_account', email);
      else localStorage.removeItem('mail_active_account');
    } else {
      const SecureStore = require('expo-secure-store');
      if (email) SecureStore.setItemAsync('mail_active_account', email).catch(() => {});
      else SecureStore.deleteItemAsync('mail_active_account').catch(() => {});
    }
  } catch {}
}

// Load active account from SecureStore on mobile at startup
(async () => {
  if (Platform.OS !== 'web') {
    try {
      const SecureStore = require('expo-secure-store');
      const a = await SecureStore.getItemAsync('mail_active_account');
      if (a) _cachedActiveAccount = a;
    } catch {}
  }
})();

// Add or update account in stored accounts list (never store passwords)
function upsertAccount(email, password, name) {
  const accounts = getStoredAccounts();
  const idx = accounts.findIndex(a => a.email === email);
  // Store token for account switching (NOT plaintext password)
  const token = authToken || '';
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], email, name: name || accounts[idx].name, token };
  } else {
    accounts.push({ email, name: name || '', token });
  }
  storeAccounts(accounts);
}

export { getStoredAccounts, storeAccounts, getActiveAccountEmail, setActiveAccountEmail, upsertAccount };

function removeStoredAccount(email) {
  // Best-effort: revoke the stored bearer token server-side so a leaked
  // copy can't be reused. Fire-and-forget — if the network call fails we
  // still want to drop the local credentials.
  try {
    const acct = getStoredAccounts().find(a => a.email === email);
    if (acct?.token) {
      fetch(`${API_URL}?action=logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${acct.token}`,
        },
        body: '{}',
        credentials: 'omit',
      }).catch(() => {});
    }
  } catch {}
  const accounts = getStoredAccounts().filter(a => a.email !== email);
  storeAccounts(accounts);
  if (getActiveAccountEmail() === email) setActiveAccountEmail('');
}

export { removeStoredAccount };

export function getToken() { return authToken; }

// Initialize token from storage SYNCHRONOUSLY on web to prevent race conditions
// (checkAuth may fire before async init completes, causing false logout)
if (Platform.OS === 'web') {
  try {
    if (typeof localStorage !== 'undefined') {
      let stored = localStorage.getItem('mail_token');
      // Web fallback: sessionStorage mirror. If the primary lost the token
      // (e.g. user cleared site data on one origin), the sessionStorage
      // copy can keep them logged in for the current tab.
      if (!stored && typeof sessionStorage !== 'undefined') {
        try { stored = sessionStorage.getItem(TOKEN_FALLBACK_KEY); } catch {}
        if (stored) { try { localStorage.setItem('mail_token', stored); } catch {} }
      }
      if (stored) authToken = stored;
      localStorage.removeItem('mail_creds');
      const accts = getStoredAccounts();
      if (accts.some(a => a.password)) {
        storeAccounts(accts.map(({ password, ...rest }) => rest));
      }
      // Load meta synchronously on web so isTokenWithinGracePeriod() works
      // immediately for any caller that lands before the async tick.
      try {
        const raw = localStorage.getItem(TOKEN_META_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            _tokenMeta = {
              last_auth_ok_at: Number(parsed.last_auth_ok_at || 0),
              created_at: Number(parsed.created_at || 0),
              email: String(parsed.email || ''),
            };
          }
        }
      } catch {}
    }
  } catch {}
  _tokenReadyResolve();
} else {
  // Native: async init is ok since SecureStore requires await
  (async () => {
    try {
      const stored = await getStoredToken();
      if (stored) authToken = stored;
      // getStoredToken already loaded meta; nothing else to do here.
    } finally {
      _tokenReadyResolve();
      // [#1175 2026-05-18] Defensive: push hydrated bearer into native
      // SharedPreferences (Android) / App Group UserDefaults (iOS) so the
      // LkTokenFetcher cold-path can mint a LiveKit token even on a cold
      // start where the user never re-logged in this process. Without this
      // the SharedPreferences "auth_token" can be empty for a freshly
      // installed/cleared Android app whose JS already restored the bearer
      // via SecureStore — the call accept then shows "sem token".
      try {
        if (authToken) _persistAuthForNative(authToken).catch(() => {});
      } catch {}
    }
  })();

  // [#1175 2026-05-18] AppState 'active' re-persist. The Android system
  // can wipe SharedPreferences on "Clear cache" without nuking
  // EncryptedSharedPreferences (where expo-secure-store lives). Re-syncing
  // on every foreground guarantees the native side stays in sync with the
  // JS bearer even if SharedPreferences was cleared out-of-band.
  try {
    const { AppState } = require('react-native');
    AppState.addEventListener('change', (next) => {
      if (next === 'active' && authToken) {
        _persistAuthForNative(authToken).catch(() => {});
      }
    });
  } catch {}
}

let _reloginPromise = null;

async function _rawApiCall(action, params = {}, method = 'GET') {
  // CRITICAL: On native iOS, authToken is read from SecureStore asynchronously.
  // Without awaiting this, the first few requests (chat_send, check_auth, etc.)
  // fire with empty Authorization header, get 401, and the auto-logout logic
  // at chat-conversation.js:5408 kicks the user out.
  // Skip the wait for login itself so it doesn't deadlock.
  const SKIP_HYDRATE = (action === 'login' || action === 'check_username' || action === 'signup');
  if (!SKIP_HYDRATE) {
    try {
      await Promise.race([
        _tokenReadyPromise,
        new Promise(r => setTimeout(r, 2000)), // max 2s wait — don't hang forever
      ]);
    } catch {}
    // [#1167 2026-05-18] Defensive re-hydrate on EVERY authed request.
    // Root cause of "do nada para de mandar mensagem":
    // The in-memory `authToken` can drift to empty even though storage
    // still has a valid token. Known drift paths:
    //   - 401 streak >=100 nukes `authToken` (line ~1086) but storage
    //     may not have been wiped yet because the nuke fires synchronously
    //     before the storage delete promises resolve. Subsequent calls
    //     hit this with empty in-memory + non-empty storage.
    //   - Account-switch races where `setAuthTokenDirect('')` ran but the
    //     stored account row still has a bearer.
    //   - AuthContext remount during foreground (e.g. push wake) re-runs
    //     the cold-hydrate path; if SecureStore is briefly slow the IIFE
    //     finishes but the assignment `authToken = stored` was skipped on
    //     a transient null. _tokenReadyPromise still resolved, so the wait
    //     above does nothing — we keep firing anonymous requests.
    // The fix: when in-memory is empty, peek storage SYNCHRONOUSLY on web
    // and via the cheap refreshAuthToken() helper on native. Costs ~0ms
    // when in-memory has a token (the !authToken guard short-circuits).
    if (!authToken) {
      try {
        if (Platform.OS === 'web') {
          if (typeof localStorage !== 'undefined') {
            const tk = localStorage.getItem('mail_token');
            if (tk && tk.length > 0) authToken = tk;
          }
          if (!authToken && typeof sessionStorage !== 'undefined') {
            try {
              const tk2 = sessionStorage.getItem(TOKEN_FALLBACK_KEY);
              if (tk2 && tk2.length > 0) authToken = tk2;
            } catch {}
          }
        } else {
          // Native: refreshAuthToken reads SecureStore + AsyncStorage and
          // updates the in-memory variable. Guarded by an internal in-flight
          // promise so concurrent callers share the same read.
          await refreshAuthToken();
        }
      } catch {}
    }
  }
  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (method === 'POST' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (deviceTrustToken) headers['X-Device-Trust-Token'] = deviceTrustToken;

  let url = `${API_URL}?action=${action}`;
  const options = { method, headers, credentials: 'include' };

  if (method === 'GET') {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url += `&${k}=${encodeURIComponent(v)}`;
    });
  } else {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify({ action, ...params });
  }

  const controller = new AbortController();
  options.signal = controller.signal;
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, options);
    clearTimeout(timeout);

    const cookie = res.headers.get('set-cookie');
    if (cookie) sessionCookie = cookie.split(';')[0];

    const newToken = res.headers.get('x-auth-token');
    if (newToken) {
      authToken = newToken;
      storeToken(newToken);
    }

    const text = await res.text();
    try {
      const data = JSON.parse(text);
      const respToken = data?.data?.token;
      if (respToken && respToken !== authToken) {
        authToken = respToken;
        storeToken(respToken);
      }
      // Store CSRF token from login/check_auth responses
      const respCsrf = data?.data?.csrf_token;
      if (respCsrf) csrfToken = respCsrf;
      return { data, status: res.status };
    } catch {
      return { data: { success: false, message: 'Servidor indisponivel' }, status: res.status };
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { data: { success: false, message: 'Tempo limite excedido' }, status: 0 };
    }
    return { data: { success: false, message: 'Connection error' }, status: 0 };
  }
}

// In-flight deduplication: if a second caller fires the same (action+params)
// GET while the first is pending, they share the same promise instead of
// spawning a duplicate network request. Mutations (POST) never dedup.
const _inflight = new Map();
function _inflightKey(action, params) {
  try { return action + '|' + JSON.stringify(params || {}); } catch { return action; }
}

// Stale-While-Revalidate memory cache for GETs. Returns cached payload
// immediately when present (≤ TTL) while firing a fresh fetch in the
// background so the next call gets the newer copy. Dramatically smooths
// perceived latency on repeat navigations. Only applied to safe GETs
// whose caller opts in via { swr: true } or the `allowSwr` allowlist.
const _swrCache = new Map();
const _SWR_MAX = 400;
const _SWR_TTL_DEFAULT = 60_000; // 60s — was 15s; the tight TTL was why
                                  // navigating back to a screen triggered a
                                  // round-trip even though nothing changed.
// Actions worth caching aggressively — stable-ish lookups that dominate hot
// paths. Keep the set broad; specific mutations still invalidate precise keys.
const SWR_ALLOW = new Set([
  'chat_list', 'chat_conversations', 'get_folders', 'get_profile',
  'get_public_profile', 'get_settings', 'chat_get_settings', 'chat_privacy_get',
  'chat_get_wallpaper', 'chat_get_auto_reply', 'chat_starred_messages',
  'chat_folders_list', 'chat_blocked_list', 'chat_pinned_messages',
  'get_contacts', 'contacts_list', 'get_labels', 'get_filters',
  'get_templates', 'get_snoozed', 'get_scheduled',
  'feed_list', 'feed_following', 'get_followers', 'get_following',
  'follow_suggestions', 'mutual_followers',
  'status_list', 'chat_pending_members',
  'status_archive_list', 'chat_dnd_get',
  'meet_list', 'calendar_events', 'files_list',
]);

// Persist SWR cache to sessionStorage on web so navigating back to the app
// after a page reload still paints from memory instantly. sessionStorage
// (not localStorage) scopes to the tab — avoids showing one user's cached
// API responses after another logs in.
const _SWR_PERSIST_KEY = 'chatyy_swr_v1';
if (typeof window !== 'undefined' && typeof sessionStorage !== 'undefined') {
  try {
    const raw = sessionStorage.getItem(_SWR_PERSIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const now = Date.now();
      // Only restore entries fresher than the default TTL — anything older
      // is unlikely to be right, and the SWR revalidate will catch up anyway.
      for (const [k, v] of Object.entries(parsed)) {
        if (v && v.at && (now - v.at) < _SWR_TTL_DEFAULT * 2) {
          _swrCache.set(k, v);
        }
      }
    }
  } catch {}
  // Flush in-memory cache to sessionStorage every 10s and on pagehide.
  const _persist = () => {
    try {
      const obj = {};
      let i = 0;
      for (const [k, v] of _swrCache.entries()) {
        if (i++ > _SWR_MAX) break;
        obj[k] = { data: v.data, at: v.at };
      }
      sessionStorage.setItem(_SWR_PERSIST_KEY, JSON.stringify(obj));
    } catch {}
  };
  // 30s instead of 10s — JSON.stringify + setItem on a 100-query cache
  // blocks the main thread ~50–100ms each tick, which was a periodic
  // scroll stutter every 10s. pagehide still fires immediately so we
  // don't lose data on navigation.
  setInterval(_persist, 30_000);
  window.addEventListener('pagehide', _persist);
}

export function swrInvalidate(action, params) {
  if (!action) { _swrCache.clear(); return; }
  if (params === undefined) {
    for (const k of _swrCache.keys()) if (k.startsWith(action + '|')) _swrCache.delete(k);
    return;
  }
  _swrCache.delete(_inflightKey(action, params));
}

// ─────────────────────────────────────────────────────────────────────────
// Response-shape normalizers.
// apiCall() returns the PARSED BODY: { success, data, message }. Several older
// call sites (Channels/Communities tabs) were written assuming the raw shape
// { data: { success, data } } and read res.data.success / res.data.data — one
// level too deep. That silently turned every success into a false failure
// ("Não foi possível criar o canal" even though the channel WAS created) and
// left lists empty. These helpers tolerate BOTH shapes so the mismatch can
// never resurface, regardless of which layer a wrapper returns.
export function apiOk(r) { return !!(r && (r.success ?? r.data?.success)); }
export function apiMsg(r) { return (r && (r.message ?? r.data?.message)) || ''; }
export function apiPayload(r) {
  if (!r) return null;
  const d = r.data;
  // Wrong/raw shape: d itself is the body { success, data, ... } → unwrap once.
  if (d && typeof d === 'object' && !Array.isArray(d) && ('success' in d)) return d.data;
  return d; // correct shape: d is already the payload
}
// Pull an array payload whether it's bare (chat_list) or nested under a key
// (community_list → { communities }, feed → { posts }, etc.).
export function apiList(r, ...keys) {
  const p = apiPayload(r);
  if (Array.isArray(p)) return p;
  if (p && typeof p === 'object') {
    for (const k of keys) if (Array.isArray(p[k])) return p[k];
  }
  return [];
}

export async function apiCall(action, params = {}, method = 'GET', opts = {}) {
  if (method === 'GET') {
    const key = _inflightKey(action, params);
    // In-flight dedup
    const existing = _inflight.get(key);
    if (existing) return existing;

    const swrEnabled = opts.swr === true || SWR_ALLOW.has(action);
    const ttl = opts.swrTtl || _SWR_TTL_DEFAULT;
    if (swrEnabled) {
      const cached = _swrCache.get(key);
      const fresh = cached && (Date.now() - cached.at < ttl);
      if (fresh) {
        // Background revalidate so next call is even fresher.
        if (!cached.revalidating) {
          cached.revalidating = true;
          _apiCallImpl(action, params, method).then((r) => {
            _swrCache.set(key, { data: r, at: Date.now(), revalidating: false });
          }).catch(() => { cached.revalidating = false; });
        }
        return cached.data;
      }
    }

    const promise = (async () => {
      try {
        const r = await _apiCallImpl(action, params, method);
        if (swrEnabled) {
          _swrCache.set(key, { data: r, at: Date.now(), revalidating: false });
          if (_swrCache.size > _SWR_MAX) {
            // Evict oldest half when the map grows past the cap.
            const entries = Array.from(_swrCache.entries()).sort((a, b) => a[1].at - b[1].at);
            entries.slice(0, Math.floor(_SWR_MAX / 2)).forEach(([k]) => _swrCache.delete(k));
          }
        }
        return r;
      } finally { _inflight.delete(key); }
    })();
    _inflight.set(key, promise);
    return promise;
  }
  // Mutation — invalidate any cached reads that look related so the next
  // GET fetches fresh data.
  if (action.startsWith('chat_')) swrInvalidate('chat_list');
  return _apiCallImpl(action, params, method);
}

async function _apiCallImpl(action, params = {}, method = 'GET') {
  const result = await _rawApiCall(action, params, method);

  // Reset the consecutive-401 counter on any non-401 response — even errors
  // count, since they prove the network/host is alive. This way only a
  // *streak* of true 401s (token actually invalid) trips the logout signal.
  if (result.status !== 401) {
    _consecutive401 = 0;
    // 2xx with a bearer attached → token is demonstrably alive. Bump the
    // "last auth OK" timestamp so the 90-day grace check (used by the 401
    // refusal path) sees a fresh value. Throttled disk write inside.
    if (authToken && result.status >= 200 && result.status < 300) {
      try { _noteAuthOk(); } catch {}
    }
  }

  // ---- WhatsApp-parity explicit-revoke fast path ----
  // The backend distinguishes "token explicitly revoked" (user tapped Sair on
  // some device, password changed, admin kicked, linked-device kicked) from
  // "session simply empty" (cold start, edge transient, PG hiccup) by
  // returning `{ error: 'logged_out' }` or `{ error: 'revoked' }` on 401.
  // When we see that, the bearer IS dead and the client MUST clear it +
  // redirect to /login. For any other 401 (no explicit error code), we
  // preserve the bearer and let the normal streak/grace logic decide —
  // typical case is a transient backend bug, edge timeout, or sliding-token
  // race, and WhatsApp never logs out for those.
  if (result.status === 401) {
    try {
      const explicitErr = (result.data && (result.data.error || result.data.data?.error)) || '';
      if ((explicitErr === 'logged_out' || explicitErr === 'revoked') &&
          action !== 'login' && action !== 'check_auth' && action !== 'signup') {
        try { recordLogoutAttempt('explicit_revoke', { source: 'api_401_logged_out', action, server_error: explicitErr }); } catch {}
        _authFailureSignaled = true;
        authToken = '';
        try { if (Platform.OS === 'web' && typeof localStorage !== 'undefined') localStorage.removeItem('mail_token'); } catch {}
        try { if (Platform.OS === 'web' && typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TOKEN_FALLBACK_KEY); } catch {}
        try { _writeAsyncStorage(TOKEN_FALLBACK_KEY, null); } catch {}
        try {
          const SecureStore = require('expo-secure-store');
          SecureStore.deleteItemAsync('bio_token').catch(() => {});
        } catch {}
        try {
          if (typeof globalThis !== 'undefined') {
            globalThis.__chatyy_authFailure = Date.now();
            globalThis.__chatyy_authFailureReason = 'explicit_revoke';
            if (globalThis.dispatchEvent) globalThis.dispatchEvent(new Event('chatyy:authFailure'));
          }
        } catch {}
        try {
          if (Platform.OS === 'web' && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
            setTimeout(() => {
              if (!window.location.pathname.startsWith('/login')) {
                window.location.href = '/login?reason=logged_out';
              }
            }, 500);
          }
        } catch {}
        try {
          if (Platform.OS !== 'web') {
            const { router } = require('expo-router');
            setTimeout(() => { try { router?.replace?.('/login'); } catch {} }, 500);
          }
        } catch {}
        console.warn('[api] Server returned error:logged_out — bearer revoked, redirecting to /login');
        return result.data;
      }
    } catch {}
  }

  // Auto-relogin: if server returns 401 and we have in-memory credentials, try to re-authenticate
  // BUT don't block - if relogin takes too long, return the 401 result
  if (result.status === 401 && action !== 'login' && action !== 'check_auth' && action !== 'signup') {
    // [#1167 2026-05-18] Defensive token re-hydrate + single silent retry.
    // Root cause of "do nada para de mandar mensagem": the in-memory
    // `authToken` drifts to empty (or stale) while storage still has a
    // valid bearer. Before this fix, the request fired anonymously, the
    // server returned 401, and the user was forced to logout + login to
    // refill in-memory from the login response. Now we attempt a cheap
    // storage re-read once; if it surfaces a token that differs from
    // what we just sent, retry the request silently before falling
    // through to the savedCredentials / streak path below.
    let _retriedFromStorage = false;
    try {
      const tokenBefore = authToken;
      await refreshAuthToken();
      if (authToken && authToken !== tokenBefore) {
        _retriedFromStorage = true;
        const retry = await _rawApiCall(action, params, method);
        if (retry.status !== 401) {
          _consecutive401 = 0;
          if (retry.status >= 200 && retry.status < 300) {
            try { _noteAuthOk(); } catch {}
          }
          return retry.data;
        }
        // Retry also 401 → fall through to creds / streak path below.
      } else if (!tokenBefore && authToken) {
        // We had NO in-memory token at all; refresh just filled it.
        // Retry once because the original request went out anonymous.
        _retriedFromStorage = true;
        const retry = await _rawApiCall(action, params, method);
        if (retry.status !== 401) {
          _consecutive401 = 0;
          if (retry.status >= 200 && retry.status < 300) {
            try { _noteAuthOk(); } catch {}
          }
          return retry.data;
        }
      }
    } catch {}

    // [refresh token, 2026-05-24] Silent refresh BEFORE password fallback.
    // This is the WhatsApp/Telegram pattern: a long-lived refresh token in
    // SecureStore exchanges for a fresh access bearer without the user typing
    // a password. No more "ghost logged-in" 401 spirals — the app self-heals.
    // Single-flight: if multiple 401s come in concurrently, all wait on one
    // refresh attempt instead of stampeding the endpoint.
    if (refreshToken && refreshDeviceId) {
      try {
        if (!_authRefreshInFlight) {
          _authRefreshInFlight = (async () => {
            try {
              const r = await _rawApiCall('auth_refresh', {
                refresh_token: refreshToken,
                device_id: refreshDeviceId,
              }, 'POST');
              const newAccess = r?.data?.data?.token || r?.data?.token;
              const newRefresh = r?.data?.data?.refresh_token || r?.data?.refresh_token;
              if (newAccess && r.status >= 200 && r.status < 300) {
                authToken = newAccess;
                await storeToken(newAccess).catch(() => {});
                if (newRefresh) {
                  refreshToken = newRefresh;
                  await storeRefreshToken(newRefresh, refreshDeviceId).catch(() => {});
                }
                return true;
              }
              // Server says refresh is invalid/revoked → nuke it so we don't
              // keep retrying. Fall through to password path or user-prompt.
              if (r?.data?.data?.error === 'revoked' || r?.data?.data?.error === 'expired') {
                refreshToken = '';
                await storeRefreshToken(null).catch(() => {});
              }
              return false;
            } catch { return false; }
          })().finally(() => { _authRefreshInFlight = null; });
        }
        const refreshed = await _authRefreshInFlight;
        if (refreshed) {
          const retry = await _rawApiCall(action, params, method);
          if (retry.status !== 401) {
            _consecutive401 = 0;
            if (retry.status >= 200 && retry.status < 300) {
              try { _noteAuthOk(); } catch {}
            }
            return retry.data;
          }
        }
      } catch {}
    }

    const creds = savedCredentials;
    if (creds?.email && creds?.password) {
      if (!_reloginPromise) {
        const reloginTimeout = new Promise(r => setTimeout(() => r({ data: { success: false } }), 15000));
        _reloginPromise = Promise.race([
          _rawApiCall('login', { email: creds.email, password: creds.password }, 'POST').catch(() => ({ data: { success: false } })),
          reloginTimeout,
        ]).finally(() => { _reloginPromise = null; });
      }
      const loginResult = await _reloginPromise;
      if (loginResult.data?.success) {
        await new Promise(r => setTimeout(r, 2000)); // Wait for PG replication
        const retry = await _rawApiCall(action, params, method);
        return retry.data;
      }
    }

    // iOS native cold-start: no password in memory, but we have a stored Bearer
    // token. If the server rejected it (token expired or Redis crashed), the user
    // needs to login with password again. Signal the auth layer to redirect to
    // login — otherwise iOS just sits with wifi-off icon forever.
    //
    // Don't trip auth-failure for known-flaky endpoints (AI summarization can
    // return 401 transiently when the upstream Anthropic API rate-limits or the
    // proxy hiccups, and the user should not be logged out for that). We also
    // require two consecutive 401s — a single transient blip used to log
    // people out the moment a sidecar service blipped.
    // call_notify added 2026-05-04: WS auth flapping during call signaling was
    // accumulating 401s on the call_notify HTTP endpoint and tripping the
    // 8-strike auto-logout. Calls are inherently flaky on cellular cold-start;
    // a 401 here is almost always transient (sliding renewal in flight, edge
    // server timeout, etc.), not a revoked token. Same logic as voip_minutes.
    // 2026-05-04 round 2: bumpado pra incluir todos os endpoints alto-volume
    // que NAO precisam de IMAP password mas ainda podem retornar 401 transient
    // (sliding token renewal, edge timeout, opcache miss). Backend ja foi
    // migrado pra requireAuthLite (email.php) — esse guard frontend e a
    // ultima rede contra apps com bundle antigo / cache stale acumularem
    // strikes e deslogarem o usuario sem motivo. WhatsApp parity: token
    // valido nunca expulsa.
    const NOISY_ACTIONS_401 = new Set([
      'ai_summarize', 'ai_compose', 'ai_recap', 'transcribe_audio',
      'voip_minutes_remaining', 'call_notify',
      'profile_get', 'profile_insights', 'get_profile',
      'register_voip_token', 'unregister_voip_token', 'callkit_diag',
      'register_push_token', 'unregister_push_token',
      'parental_my_status',
      'meet_list', 'meet_info',
      'follow_user', 'unfollow_user', 'get_followers', 'get_following',
      'find_by_phone', 'check_contacts', 'search_users', 'follow_suggestions',
      'chatyy_users', 'close_friends_list', 'close_friends_set',
      'get_settings', 'update_settings',
      'contacts_list', 'contacts_save', 'contacts_delete',
      'notes_list', 'notes_create', 'notes_update', 'notes_delete',
      // 2026-05-15 round 3 — user complained "ta me deslogando, whatsapp
      // nunca desloga". Adding high-volume chat/live/status endpoints that
      // can return transient 401 during sliding-token renewal, pgbouncer
      // hiccups, or WS auth flapping. WhatsApp parity: ONLY a truly revoked
      // token should logout, never edge timeouts on read-paths.
      'chat_list_conversations', 'chat_get_messages', 'chat_messages',
      'chat_typing_set', 'chat_typing', 'chat_read_receipt',
      'chat_unread_count', 'chat_starred_list', 'chat_pinned_list',
      'chat_user_privacy', 'chat_user_conv_settings',
      'live_session_info', 'live_session_list', 'live_status',
      'status_list', 'status_view',
      'feed_list', 'feed_likes', 'feed_comments',
      'feed_explore', 'feed_explore_nearby', 'feed_set_topics', 'feed_get_topics',
      'feed_analytics', 'trending_hashtags', 'feed_ads_list',
      'chat_feed_hide_post', 'feed_hide_post',
      'feed_muted_words_list', 'feed_muted_words_add', 'feed_muted_words_remove',
      'hashtag_followed_list',
      'reels_list', 'reels_view',
      'get_avatar', 'get_avatar_initials',
      'send_health', 'send_ping',
    ]);
    try {
      const tokenHasValue = typeof authToken === 'string' && authToken.length > 0;
      const isNoisy = NOISY_ACTIONS_401.has(action);
      if (isNoisy) {
        _consecutive401 = 0; // noisy action 401s don't accumulate toward logout
      } else if (tokenHasValue) {
        _consecutive401 = (_consecutive401 || 0) + 1;
      }

      // [2026-05-26] Per-token ghost-login streak. Count ONLY 401s that carried
      // no explicit server `error` field (explicit logged_out/revoked already
      // exited via the fast-path above). Reset the streak whenever the in-memory
      // bearer changes (login / refresh / account switch) so a fresh token is
      // never punished for the previous one's failures. Noisy actions never feed
      // this streak.
      const _hadErrField = !!(result.data && (result.data.error || result.data.data?.error));
      const _fp = _tokenFingerprint();
      if (_fp && _fp !== _ghost401TokenFp) {
        _ghost401TokenFp = _fp;
        _consecutive401NoError = 0;
      }
      if (!tokenHasValue || isNoisy || _hadErrField) {
        // No token, noisy endpoint, or an explicit (but non-revoke) error code
        // — don't let it accumulate toward the ghost-login signal.
        if (isNoisy || _hadErrField) _consecutive401NoError = 0;
      } else {
        _consecutive401NoError = (_consecutive401NoError || 0) + 1;
      }
      // 15 consecutive 401s antes de disparar logout — era 8, mas sob
      // teste prolongado de chamadas (call_notify + voip_register + WS
      // re-auth) o streak chegava a 8 e expulsava o user mesmo com token
      // válido. Com token de 10 anos no backend, qualquer 401 é
      // praticamente sempre transient. Streak de 15 garante que só token
      // de fato revogado dispara logout.
      // Bumpado 15→30 (2026-05-04 round 2). Backend ja migrou alto-volume
      // pra requireAuthLite, e NOISY_ACTIONS_401 cobre o resto. 30 strikes
      // legitimos sao quase impossiveis em uso normal — so token revogado
      // de fato chega ai. WhatsApp parity: nao desloga sem motivo real.
      // 2026-05-15 round 3 — bumpado 30→100. User reportou "ta me deslogando,
      // whatsapp nunca desloga". Streak de 30 ainda foi atingido em uso real
      // por endpoints fora do NOISY_ACTIONS_401 (cada user é diferente). Com
      // 100 strikes, só um token de fato revogado/expirado dispara logout —
      // qualquer ruído transient se dilui antes. WhatsApp parity sustentável.
      // [2026-05-26] Conservative ghost-login re-enable. The old code hard-pinned
      // `shouldSignal = false`, so a genuinely dead token never forced logout
      // unless the server emitted the exact logged_out/revoked marker — leaving
      // users stuck in a "ghost logged-in" 401 loop. We now allow a logout
      // signal, but only under a HIGH-confidence two-factor condition:
      //   (a) the SAME bearer has returned >= GHOST_401_THRESHOLD 401s that
      //       carried NO server error field (transient blips reset the streak
      //       via _noteAuthOk / noteApiSuccess), AND
      //   (b) an explicit check_auth probe against the backend ALSO comes back
      //       401 (i.e. the bearer is confirmed dead, not just a flapping
      //       sidecar endpoint).
      // Both must hold. The downstream grace-window + in-call guards still get
      // the final say below, so a recently-alive token is never nuked. This
      // keeps WhatsApp-parity (no false logouts on blips) while finally healing
      // the truly-dead-token case.
      let shouldSignal = false;
      void tokenHasValue; void isNoisy; // referenced for ESLint no-unused
      if (
        !_authFailureSignaled &&
        tokenHasValue &&
        !isNoisy &&
        !_hadErrField &&
        action !== 'check_auth' &&
        _consecutive401NoError >= GHOST_401_THRESHOLD
      ) {
        try {
          // Confirm the bearer is actually dead before signalling. check_auth
          // extends the sliding token on success; a 2xx here means the streak
          // was noise, so we clear it and keep the session.
          const probe = await _rawApiCall('check_auth', {}, 'GET');
          if (probe && probe.status >= 200 && probe.status < 300) {
            _consecutive401NoError = 0;
            try { _noteAuthOk(); } catch {}
          } else if (probe && probe.status === 401) {
            shouldSignal = true;
          }
        } catch {
          // Probe failed (network/timeout) — DON'T logout on an inconclusive
          // probe; treat as transient and wait for the next 401 to re-evaluate.
          shouldSignal = false;
        }
      }

      // WhatsApp-grade refusal: even after 100 strikes, if this token has
      // been confirmed alive (any 2xx) within the last 90 days, REFUSE to
      // logout. Truly revoked tokens never come back successful, so this
      // grace window can only protect a token that has been recently used.
      // Carol-style "logged out for no reason" almost always traces to a
      // brief edge auth glitch that ran the strike counter up — we now
      // simply ignore it instead of nuking her session.
      if (shouldSignal) {
        const ageMs = _tokenLastOkAgeMs();
        if (ageMs !== Infinity && ageMs < TOKEN_GRACE_MS) {
          shouldSignal = false;
          // Reset the counter so the grace window has effect — otherwise
          // every subsequent 401 keeps re-evaluating against the same
          // (now disregarded) 100-strike threshold.
          _consecutive401 = 0;
          _consecutive401NoError = 0;
          try {
            recordLogoutAttempt('refused_within_grace', {
              source: 'api_401_streak',
              age_ms: ageMs,
              action,
              grace_days: TOKEN_GRACE_DAYS,
            });
          } catch {}
          try { console.warn('[auth] 401 streak hit but token <90d old — refusing logout'); } catch {}
        }
      }
      // [#1165 2026-05-18] In-call gate. Same reasoning as the WS auth
      // path: during a call the bearer may transiently fail because the
      // CallSignalWs + JS WS race a brief edge-hub state mismatch, and we
      // never want to nuke the session mid-call. We reset the counter so
      // any post-call recovery doesn't immediately re-trip the threshold.
      if (shouldSignal) {
        try {
          if (typeof globalThis !== 'undefined' && globalThis.__chatyyCallActive) {
            shouldSignal = false;
            _consecutive401 = 0;
            _consecutive401NoError = 0;
            try {
              recordLogoutAttempt('refused_during_call', {
                source: 'api_401_streak',
                action,
              });
            } catch {}
            try { console.warn('[auth] 401 streak during active call — refusing logout (#1165)'); } catch {}
          }
        } catch {}
      }

      if (shouldSignal) {
        _authFailureSignaled = true;
        try {
          recordLogoutAttempt('api_401_streak', {
            source: 'api',
            consecutive: _consecutive401,
            action,
          });
        } catch {}
        // Clear the bad token so subsequent requests don't spam
        authToken = '';
        try { if (Platform.OS === 'web' && typeof localStorage !== 'undefined') localStorage.removeItem('mail_token'); } catch {}
        try { if (Platform.OS === 'web' && typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TOKEN_FALLBACK_KEY); } catch {}
        try { _writeAsyncStorage(TOKEN_FALLBACK_KEY, null); } catch {}
        try {
          const SecureStore = require('expo-secure-store');
          SecureStore.deleteItemAsync('bio_token').catch(() => {});
        } catch {}
        // Emit event so AuthContext can route to /login
        try {
          if (typeof globalThis !== 'undefined') {
            globalThis.__chatyy_authFailure = Date.now();
            if (globalThis.dispatchEvent) globalThis.dispatchEvent(new Event('chatyy:authFailure'));
          }
        } catch {}
        // Web fallback: force redirect immediately if globalThis events don't work
        try {
          if (Platform.OS === 'web' && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
            setTimeout(() => {
              if (!window.location.pathname.startsWith('/login')) {
                window.location.href = '/login?reason=token_expired';
              }
            }, 500);
          }
        } catch {}
        // Native fallback: use expo-router if globalThis event listener failed
        try {
          if (Platform.OS !== 'web') {
            const { router } = require('expo-router');
            setTimeout(() => { try { router?.replace?.('/login'); } catch {} }, 500);
          }
        } catch {}
        console.warn('[api] Auth token rejected by server (401). Redirecting to /login');
      }
    } catch {}
  }

  return result.data;
}

let _authFailureSignaled = false;
let _consecutive401 = 0;
// [2026-05-26] Conservative ghost-login signal. We track 401s that arrive
// WITHOUT any explicit server `error` field (logged_out/revoked go through the
// fast-path above and never reach here). Counted per-token: if the in-memory
// bearer fingerprint changes (login / refresh / account switch) we reset, so a
// healthy new token always starts clean. Only when the SAME dead bearer racks
// up >= GHOST_401_THRESHOLD such 401s do we escalate to an explicit check_auth
// probe; logout is signalled only if that probe ALSO 401s. This is the only
// non-explicit path that can ever sign out, and it stays well clear of the
// transient blips the grace/in-call guards already cover.
let _consecutive401NoError = 0;
let _ghost401TokenFp = '';
const GHOST_401_THRESHOLD = 5;
function _tokenFingerprint() {
  const t = typeof authToken === 'string' ? authToken : '';
  if (!t) return '';
  // Cheap, non-reversible-enough fingerprint (length + head/tail) so we don't
  // hold the raw bearer in another module variable.
  return `${t.length}:${t.slice(0, 4)}:${t.slice(-4)}`;
}
export function resetAuthFailureSignal() {
  _authFailureSignaled = false;
  _consecutive401 = 0;
  _consecutive401NoError = 0;
  _ghost401TokenFp = '';
}
// Reset consecutive counter on any successful response so transient 401s
// across long sessions don't accumulate forever.
export function noteApiSuccess() { _consecutive401 = 0; _consecutive401NoError = 0; }

// Soft-refresh the in-memory bearer from persistent storage. Used by the
// WebSocket auth_error path so the next reconnect picks up a fresh bearer
// after a parallel API call updated SecureStore / AsyncStorage. We do NOT
// hit the network here — there's no separate refresh endpoint; bearers are
// long-lived (10y). The point is to recover from in-memory token loss
// (cold start hydrate race, AuthContext remount, native CallActivity
// paused the JS thread mid-hydrate). Returns true if a token is in memory
// after the refresh attempt.
let _refreshInFlight = null;
// [#1189 2026-05-19] refreshAuthToken used to ONLY re-read the existing
// bearer from local storage — never asked the server for a new one. When
// the JWT expired (Go WS rejects exp), it returned the SAME dead token
// back to websocket.js, which immediately reconnected with it → auth_error
// loop forever (97% auth fail observed in production logs). Fix: also hit
// `check_auth` against the backend which extends the sliding token (PHP
// rotates expires_at on every authenticated call). The Go WS reads the
// updated expires_at from the same /var/www/mail/data/tokens/<hash>.json
// file via httpFallback, so a successful check_auth makes the next WS
// reconnect succeed.
let _lastRenewAt = 0;
export async function refreshAuthToken() {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    try {
      // Step 1: re-hydrate from local storage (covers cases where the
      // in-memory `authToken` got cleared but storage still has it).
      if (Platform.OS === 'web') {
        try {
          if (typeof localStorage !== 'undefined') {
            const tk = localStorage.getItem('mail_token');
            if (tk && tk.length > 0 && tk !== authToken) authToken = tk;
          }
          if (!authToken && typeof sessionStorage !== 'undefined') {
            const tk2 = sessionStorage.getItem(TOKEN_FALLBACK_KEY);
            if (tk2 && tk2.length > 0) authToken = tk2;
          }
        } catch {}
      } else {
        try {
          const SecureStore = require('expo-secure-store');
          const tk = await SecureStore.getItemAsync('mail_token');
          if (tk && tk.length > 0 && tk !== authToken) {
            authToken = tk;
            _persistAuthForNative(authToken).catch(() => {});
          }
        } catch {}
        if (!authToken) {
          try {
            const tk2 = await _readAsyncStorage(TOKEN_FALLBACK_KEY);
            if (tk2 && tk2.length > 0) {
              authToken = tk2;
              _persistAuthForNative(authToken).catch(() => {});
            }
          } catch {}
        }
      }
      if (!authToken) return false;

      // Step 2: real sliding renewal. Hit check_auth — backend bumps
      // expires_at if token is valid. Throttle to once per 60s so the WS
      // auth_error storm can't hammer the server.
      const now = Date.now();
      if (now - _lastRenewAt > 60000) {
        _lastRenewAt = now;
        try {
          const r = await _rawApiCall('check_auth', {}, 'GET');
          if (r?.status === 401) {
            // Server says the bearer is dead. Don't pretend it's valid —
            // let websocket.js give up reconnecting and let api.js's normal
            // 401 streak handle the logout/redirect.
            return false;
          }
          if (r?.status >= 200 && r?.status < 300) {
            try { _noteAuthOk(); } catch {}
            return true;
          }
        } catch {
          // Network error — treat as transient, return optimistic true so
          // the WS reconnects on the next backoff tick. If the token IS
          // dead, next reconnect will get auth_error and we'll retry the
          // HTTP renewal then.
          return true;
        }
      }
      return true;
    } finally {
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}

export async function checkEmailExists(email) {
  return apiCall('check_email_exists', { email });
}

export async function login(email, password) {
  // Go Fast Auth for token (< 50ms) + PHP login in background for full session
  let r;
  try {
    // Pass device_id so PHP can mint a refresh_token bound to this device.
    // _getDeviceIdSafe is defined later in this file but is hoisted (async function).
    const _devIdForLogin = await _getDeviceIdSafe().catch(() => null);
    const _loginPayload = _devIdForLogin ? { email, password, device_id: _devIdForLogin } : { email, password };
    const [goRes, phpRes] = await Promise.all([
      fetch(goAuthUrl('login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }).then(res => res.json()).catch(() => null),
      apiCall('login', _loginPayload, 'POST').catch(() => null),
    ]);
    // Use Go response (faster) but PHP runs in parallel to create full session.
    // When BOTH fail, prefer the real error message over generic
    // "Servidor indisponivel" / "Connection error" that only means transport
    // failure — otherwise a wrong password shows up as "servidor indisponível",
    // which is confusing and wrong.
    const GENERIC = new Set([
      'Servidor indisponivel', 'Servidor indisponível', 'Server unavailable',
      'Connection error', 'Login failed', 'Tempo limite excedido',
    ]);
    const pickRealMessage = (...candidates) => {
      for (const c of candidates) {
        const msg = c?.message || c?.error;
        if (msg && !GENERIC.has(msg)) return { success: false, message: msg };
      }
      return null;
    };
    if (goRes?.success) {
      r = goRes;
      // [refresh token] Go auth doesn't issue refresh tokens — graft the
      // refresh fields from the parallel PHP login if it succeeded too.
      // Both paths share the same auth backend so the PHP refresh works
      // with the Go-issued access bearer (validation goes through PG).
      const phpRefresh = phpRes?.data?.refresh_token;
      const phpDev = phpRes?.data?.refresh_device_id;
      if (phpRefresh && phpDev) {
        r.data = r.data || {};
        if (!r.data.refresh_token) r.data.refresh_token = phpRefresh;
        if (!r.data.refresh_device_id) r.data.refresh_device_id = phpDev;
      }
    } else if (phpRes?.success) {
      r = phpRes;
    } else {
      // Both failed — prefer whichever has a specific (non-generic) message.
      r = pickRealMessage(goRes, phpRes)
        || phpRes
        || goRes
        || { success: false, message: 'Login failed' };
    }
  } catch {
    r = await apiCall('login', { email, password }, 'POST');
  }
  if (r.success) {
    // Save credentials for auto-relogin when session expires
    savedCredentials = { email, password };
    storeCredentials(email, password);
    // Capture refresh_token (180d, persisted in SecureStore).
    // Server returns it in login response when device_id was passed.
    // Without refresh_token the app falls back to password-based relogin (legacy).
    const newRefresh = r?.data?.refresh_token || r?.refresh_token;
    const newRefreshDev = r?.data?.refresh_device_id || r?.refresh_device_id;
    if (newRefresh && newRefreshDev) {
      refreshToken = newRefresh;
      refreshDeviceId = newRefreshDev;
      storeRefreshToken(newRefresh, newRefreshDev).catch(() => {});
    }
    const token = r?.data?.token || r?.token;
    if (token) {
      authToken = token;
      // Stamp the meta with the freshly-issued token's owner so the
      // 90-day grace check in the 401 handler always has a known email.
      _tokenMeta = {
        last_auth_ok_at: Date.now(),
        created_at: Date.now(),
        email: (r.data?.email || email || '').toLowerCase(),
      };
      _saveTokenMeta().catch(() => {});
      await storeToken(token);
    }
    // Save device trust token (prevents re-verification on same device)
    const trustTk = r?.data?.device_trust_token;
    if (trustTk) {
      deviceTrustToken = trustTk;
      storeTrustToken(trustTk);
    }
    // Multi-account: store this account
    const name = r.data?.name || r.data?.email || email;
    upsertAccount(email, password, name);
    setActiveAccountEmail(email);

    // Cache login response data for instant screen loads
    try {
      const { setString, setJSON } = require('./mmkv');
      if (r.data?.conversations?.length) {
        // Cache for chatCache.js (getCachedConversations reads 'chat_conversations')
        setString('chat_conversations', JSON.stringify(r.data.conversations));
      }
      if (r.data?.profile) setJSON('omc_profile', { data: r.data.profile, ts: Date.now() });
      if (r.data?.call_history) setJSON('omc_call_history', { data: r.data.call_history, ts: Date.now() });
      if (r.data?.folders) {
        // Cache for offlineCache.js (getEmailsFromCache reads 'omc_list_INBOX')
        const { setCache } = require('./cache');
        setCache('email_folders', r.data.folders, 600000).catch(() => {});
      }
    } catch {}
  }
  return r;
}

export async function signup(username, password, name, domain = 'chatyy.com.br', extra = {}) {
  const r = await apiCall('signup', { username, password, name, domain, ...extra }, 'POST');
  if (r.success) {
    const email = `${username}@${domain}`;
    savedCredentials = { email, password };
    storeCredentials(email, password);
    const token = r?.data?.token || r?.token;
    if (token) {
      authToken = token;
      await storeToken(token);
    }
  }
  return r;
}

export async function checkUsername(username, domain = 'chatyy.com.br') {
  return apiCall('check_username', { username, domain });
}

// --- Login Challenge (new device verification) ---
export async function checkLoginChallenge(challengeId, email) {
  return apiCall('check_login_challenge', { challenge_id: challengeId, email }, 'POST');
}

export async function verifyLoginChallenge(challengeId, action) {
  return apiCall('verify_login_challenge', { challenge_id: challengeId, action }, 'POST');
}

export function clearAuthToken() {
  authToken = '';
  sessionCookie = '';
  csrfToken = '';
  savedCredentials = null;
  refreshToken = '';
  refreshDeviceId = '';
  storeRefreshToken(null).catch(() => {});
  // Reset meta so the next account starts with a clean slate. Audit
  // entry is written by AuthContext / 401 handler before this call.
  _tokenMeta = { last_auth_ok_at: 0, created_at: 0, email: '' };
  _saveTokenMeta().catch(() => {});
  storeToken(null).catch(() => {});
  // Belt-and-suspenders: also nuke the AsyncStorage fallback explicitly.
  try { _writeAsyncStorage(TOKEN_FALLBACK_KEY, null); } catch {}
  // Drop the SWR persistence so the next user doesn't see cached API
  // responses from the account that just logged out.
  try { _swrCache.clear(); } catch {}
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(_SWR_PERSIST_KEY); } catch {}
}

// Awaitable variant: doLogout MUST await this on native so SecureStore
// finishes deleting `mail_token` before the user kills the app. Without
// the await, the delete is fire-and-forget and a fast app-kill leaves
// the token in keychain — next cold-start re-hydrates authToken on line
// 422 IIFE, checkAuth() succeeds with the still-valid bearer, and the
// user is auto-logged-in even though they explicitly logged out
// (reported 2026-05-07: "fecho o all e abre denovo ele ja loga
// automaticamente").
export async function clearAuthTokenAsync() {
  authToken = '';
  sessionCookie = '';
  csrfToken = '';
  savedCredentials = null;
  _tokenMeta = { last_auth_ok_at: 0, created_at: 0, email: '' };
  try { await _saveTokenMeta(); } catch {}
  try { await storeToken(null); } catch {}
  try { await _writeAsyncStorage(TOKEN_FALLBACK_KEY, null); } catch {}
  try { _swrCache.clear(); } catch {}
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(_SWR_PERSIST_KEY); } catch {}
}

// Awaitable variant of setActiveAccountEmail — same race-window fix as
// clearAuthTokenAsync above. doLogout awaits this so SecureStore finishes
// deleting the active marker before the user kills the app, otherwise the
// stale marker is read on next cold-start and hydrateOffline last-resort
// resurrects the session.
export async function setActiveAccountEmailAsync(email) {
  _cachedActiveAccount = email || '';
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      if (email) localStorage.setItem('mail_active_account', email);
      else localStorage.removeItem('mail_active_account');
      return;
    }
    const SecureStore = require('expo-secure-store');
    if (email) await SecureStore.setItemAsync('mail_active_account', email);
    else await SecureStore.deleteItemAsync('mail_active_account');
  } catch {}
}

// Wipe the bearer token from a stored account row WITHOUT removing the
// account itself — keeps the email + name in the multi-account list so
// the user can quickly log back in (Face ID / handle suggestion / etc.)
// but kills the auto-relogin path. Awaits the SecureStore write on native.
export async function clearStoredAccountTokenAsync(email) {
  try {
    const lower = String(email || '').toLowerCase();
    if (!lower) return;
    const accounts = getStoredAccounts();
    let changed = false;
    const next = accounts.map(a => {
      if (String(a.email || '').toLowerCase() === lower && a.token) {
        changed = true;
        return { ...a, token: '' };
      }
      return a;
    });
    if (!changed) return;
    _cachedAccounts = next;
    const json = JSON.stringify(next);
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      localStorage.setItem('mail_accounts', json);
      return;
    }
    const SecureStore = require('expo-secure-store');
    await SecureStore.setItemAsync('mail_accounts', json);
  } catch {}
}

export async function logout() {
  // Call the server-side logout first, but ALWAYS clear local state even
  // if the network call fails — otherwise a flaky logout leaves stale
  // credentials in memory + storage.
  let r;
  try {
    r = await apiCall('logout', {}, 'POST');
  } catch (e) {
    r = { success: false, error: e?.message };
  }
  sessionCookie = '';
  authToken = '';
  csrfToken = '';
  savedCredentials = null;
  try { await storeToken(null); } catch {}
  return r;
}

export async function checkAuth() {
  return apiCall('check_auth');
}

// [2026-05-19] Once Rust returns 401 for the current bearer, mark it dead so
// we stop hitting Rust on every getInbox/getFolders/getMessage call — that
// spammed the network panel + console with "401" lines the user complained
// about. Same bearer keeps working on PHP, but Rust's IDLE-IMAP auth had
// silently failed (observed on Chrome desktop).
//
// [2026-05-26] Don't LATCH the dead state for the whole session on a single
// 401 — that was often a transient IMAP/edge blip, after which Rust would have
// recovered but we'd never probe it again (stuck on the slower PHP path for
// the rest of the session). Instead mark it dead with a timestamp and allow a
// re-probe after a cooldown. Call sites use `_isRustDead()` instead of the
// old `_rustDead` boolean.
const _RUST_DEAD_COOLDOWN_MS = 60 * 1000; // re-probe Rust ~1min after a 401
let _rustDeadAt = 0;
function _markRustDead() { _rustDeadAt = Date.now(); }
function _isRustDead() {
  return _rustDeadAt > 0 && (Date.now() - _rustDeadAt) < _RUST_DEAD_COOLDOWN_MS;
}
// Public reset hook — called by login() when the bearer changes so a fresh
// token gets a fair shot at Rust again.
export function _resetRustHealth() { _rustDeadAt = 0; }

export async function getInbox(folder = 'INBOX', page = 1, perPage = 20, search = '', category = '', label = '', filter = '') {
  // Rust-first for everything except label/category (Rust 501 → PHP fallback).
  // Search operators (from/to/subject/is:/before/after/larger/smaller) are now
  // handled natively; label KEYWORD maps and category bucketing stay on PHP.
  const needsPHP = !!label || (!!category && category !== 'all');
  if (!needsPHP) {
    if (authToken && !_isRustDead()) {
      try {
        const qs = new URLSearchParams({ folder, page: String(page), per_page: String(perPage) });
        if (search) qs.set('search', search);
        if (filter) qs.set('filter', filter);
        const url = `${BASE_URL}/api/rust/email/inbox?${qs.toString()}`;
        const r = await fetch(url, { headers: getAuthHeaders() });
        if (r.status === 401) _markRustDead();
        if (r.ok) {
          const j = await r.json();
          // Rust returns success:true with empty list when its IDLE IMAP
          // connection silently auth-failed (observed on Chrome desktop
          // where users would see an empty inbox while Safari/Firefox hit
          // the PHP path and showed real emails). If the FIRST page of the
          // default INBOX comes back empty AND there's no search/filter,
          // fall through to PHP for a second opinion before trusting the
          // "no emails" answer.
          if (j?.success) {
            const list = j?.data?.emails || [];
            const total = j?.data?.total ?? list.length;
            const suspiciouslyEmpty = list.length === 0 && total === 0 && page === 1 && !search && !filter;
            if (!suspiciouslyEmpty) return j;
          }
        }
      } catch (_) {}
    }
  }
  const params = { folder, page, per_page: perPage, search };
  if (category && category !== 'all') params.category = category;
  if (label) params.label = label;
  if (filter) params.filter = filter;
  return apiCall('inbox', params);
}

export async function getMessage(uid, folder = 'INBOX') {
  // Rust email-api first, PHP fallback. Rust returns the exact same shape the app expects
  // plus extras (html/text/attachments) — we wrap into the legacy response shape.
  if (!authToken || _isRustDead()) return apiCall('message', { uid, folder });
  try {
    const url = `${BASE_URL}/api/rust/email/message/${encodeURIComponent(uid)}?folder=${encodeURIComponent(folder)}&mark_seen=true`;
    const r = await fetch(url, { headers: getAuthHeaders() });
    if (r.status === 401) _markRustDead();
    if (r.ok) {
      const j = await r.json();
      if (j && j.success && j.data) {
        // Map Rust response → legacy PHP shape used by EmailReader/read.js
        const d = j.data;
        return {
          success: true,
          data: {
            uid: d.uid,
            subject: d.subject,
            from: d.from_email ? (d.from_name ? `"${d.from_name}" <${d.from_email}>` : d.from_email) : '',
            from_name: d.from_name,
            from_email: d.from_email,
            to: (d.to || []).join(', '),
            cc: (d.cc || []).join(', '),
            date: d.date,
            date_ts: d.date_ts,
            body_html: d.html || '',
            body_plain: d.text || '',
            attachments: (d.attachments || []).map(a => ({
              filename: a.filename, mime: a.mime, size: a.size,
              part_id: a.part_id, inline: a.inline, content_id: a.content_id,
            })),
            headers: d.headers,
            seen: d.seen, flagged: d.flagged, size: d.size,
          },
        };
      }
    }
  } catch (_) {}
  return apiCall('message', { uid, folder });
}

export async function getFolders() {
  // Rust first — much faster (no PHP bootstrap, persistent IMAP LIST).
  // Skip the Rust call entirely when we have no bearer token: the service
  // has no PHP session fallback and would just return 401, spamming logs
  // and the browser's network tab on cold boots without auth.
  // Also skip when Rust recently 401'd (see _isRustDead cooldown comment).
  if (authToken && !_isRustDead()) {
    try {
      const r = await fetch(`${BASE_URL}/api/rust/email/folders`, { headers: getAuthHeaders() });
      if (r.status === 401) _markRustDead();
      if (r.ok) {
        const j = await r.json();
        // Only trust Rust if it actually returned folders. An empty array is a
        // red flag — every real mailbox has at least INBOX. Fall through to
        // PHP in that case (same-origin session cookie works where the Rust
        // bearer path silently auth-failed).
        if (j && j.success && j.data && Array.isArray(j.data.folders) && j.data.folders.length > 0) {
          return { success: true, data: { folders: j.data.folders } };
        }
      }
    } catch (_) {}
  }
  return apiCall('folders');
}

export async function sendEmail(to, subject, body, cc = '', bcc = '', replyToUid = null, folder = 'INBOX', attachments = [], opts = {}) {
  // opts.trackOpens — inject 1×1 read-receipt pixel; backend logs to email_opens.
  // opts.fromAlias — verified send-as alias to use for the From: header.
  const trackOpens = !!opts.trackOpens;
  const fromAlias = (opts.fromAlias || '').trim();
  // If attachments provided, use FormData instead of JSON
  if (attachments && attachments.length > 0) {
    const formData = new FormData();
    formData.append('action', 'send');
    formData.append('to', to);
    formData.append('subject', subject);
    formData.append('body', body);
    if (cc) formData.append('cc', cc);
    if (bcc) formData.append('bcc', bcc);
    if (replyToUid) formData.append('reply_to_uid', replyToUid);
    if (folder) formData.append('folder', folder);
    formData.append('undo_delay', '0');
    if (trackOpens) formData.append('track_opens', '1');
    if (fromAlias) formData.append('from_alias', fromAlias);
    attachments.forEach((att, i) => {
      if (att._raw) {
        formData.append(`attachment_${i}`, att._raw, att.name);
      } else if (att.uri) {
        formData.append(`attachment_${i}`, { uri: att.uri, type: att.type || 'application/octet-stream', name: att.name });
      }
    });

    const headers = {};
    if (sessionCookie) headers['Cookie'] = sessionCookie;
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    // Do NOT set Content-Type — browser/RN will set multipart boundary automatically

    const controller = new AbortController();
    const uploadTimeout = 120000; // 2 min for attachments
    const timeout = setTimeout(() => controller.abort(), uploadTimeout);

    try {
      const res = await fetch(`${API_URL}?action=send`, {
        method: 'POST',
        headers,
        body: formData,
        credentials: 'include',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { success: false, message: 'Servidor indisponivel' };
      }
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        return { success: false, message: 'Tempo limite excedido' };
      }
      return { success: false, message: 'Connection error' };
    }
  }

  const sendBody = { to, subject, body, cc, bcc, reply_to_uid: replyToUid, folder, undo_delay: 0, track_opens: trackOpens ? 1 : 0 };
  if (fromAlias) sendBody.from_alias = fromAlias;
  return apiCall('send', sendBody, 'POST');
}

// Send-as aliases (Gmail multi-from). The user's login email is implicitly
// included as a verified primary alias by the server.
export async function aliasesList() {
  return apiCall('aliases_list', {}, 'GET');
}
export async function aliasAdd(aliasEmail, displayName = '') {
  return apiCall('alias_add', { alias_email: aliasEmail, display_name: displayName }, 'POST');
}
export async function aliasRemove(aliasEmail) {
  return apiCall('alias_remove', { alias_email: aliasEmail }, 'POST');
}

export async function deleteEmail(uid, folder = 'INBOX') {
  return apiCall('delete', { uid, folder }, 'POST');
}

export async function markRead(uid, folder = 'INBOX') {
  // Use keepalive fetch so the request completes even if the user closes the tab
  let result;
  if (Platform.OS === 'web' && typeof navigator !== 'undefined') {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      const res = await fetch(`${API_URL}?action=mark_read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'mark_read', uid, folder }),
        credentials: 'include',
        keepalive: true,
      });
      result = await res.json();
    } catch {
      result = await apiCall('mark_read', { uid, folder }, 'POST');
    }
  } else {
    result = await apiCall('mark_read', { uid, folder }, 'POST');
  }
  // Refresh the app-icon badge so the unread count drops immediately on
  // iOS/Android lockscreens — without this the badge lags until the next
  // foreground sync.
  try { require('./pushNotifications').refreshBadgeCount?.(); } catch {}
  return result;
}

export async function markUnread(uid, folder = 'INBOX') {
  return apiCall('mark_unread', { uid, folder }, 'POST');
}

export async function moveEmail(uid, toFolder, fromFolder = 'INBOX') {
  return apiCall('move', { uid, folder: fromFolder, to_folder: toFolder }, 'POST');
}

export async function verifySend(phone, channel = 'sms') {
  return apiCall('verify_send', { phone, channel }, 'POST');
}

export async function verifyCheck(phone, code) {
  return apiCall('verify_check', { phone, code }, 'POST');
}

// ── Phone-first auth (WhatsApp-style) ──
// Three-call dance:
//   phoneLoginRequest — phone exists? send OTP
//   phoneLoginVerify  — OTP correct? returns bearer token (30d) — no password
//   phoneSignup       — verify_token + chosen handle → create account
export async function phoneLoginRequest(phone) {
  return apiCall('phone_login_request', { phone }, 'POST');
}
export async function phoneLoginVerify(phone, code) {
  return apiCall('phone_login_verify', { phone, code }, 'POST');
}
export async function phoneSignup({ verify_token, username, name, domain = 'chatyy.com.br', password = '' }) {
  return apiCall('phone_signup', { verify_token, username, name, domain, password }, 'POST');
}

// Username-only signup (Telegram-style — no SIM/SMS). Mirror of phoneSignup
// without the verify_token. Backend skips phone uniqueness + verification.
// User can add a phone later via verifyPhoneSend/verifyPhoneCheck.
export async function usernameSignup({ username, name, password, domain = 'chatyy.com.br' }) {
  return apiCall('username_signup', { username, name, password, domain }, 'POST');
}

// Variant of phoneLoginVerify that also passes a registration-lock PIN.
// Backend returns { requires_lock: true } on the first verify if the account
// has a PIN configured; client re-calls with the PIN to complete the login.
export async function phoneLoginVerifyWithPin(phone, code, pin) {
  return apiCall('phone_login_verify', { phone, code, pin }, 'POST');
}

// Registration Lock (anti-SIM-swap). Authenticated user sets a 4-6 digit PIN
// that becomes a second factor on the next phone_login_verify for this
// account. Pass empty string to clear the lock.
export async function setRegistrationLock(pin) {
  return apiCall('set_registration_lock', { pin: pin || '' }, 'POST');
}

// Star / Unstar
export async function starEmail(uid, folder = 'INBOX') {
  return apiCall('star', { uid, folder }, 'POST');
}

export async function unstarEmail(uid, folder = 'INBOX') {
  return apiCall('unstar', { uid, folder }, 'POST');
}

// Archive
export async function archiveEmail(uid, folder = 'INBOX') {
  return apiCall('move', { uid, folder, to_folder: 'Archive' }, 'POST');
}

// Bulk operations
export async function bulkMarkRead(uids, folder = 'INBOX') {
  return apiCall('bulk_mark_read', { uids, folder }, 'POST');
}

export async function bulkMarkUnread(uids, folder = 'INBOX') {
  return apiCall('bulk_mark_unread', { uids, folder }, 'POST');
}

export async function bulkDelete(uids, folder = 'INBOX') {
  return apiCall('bulk_delete', { uids, folder }, 'POST');
}

export async function bulkArchive(uids, folder = 'INBOX') {
  return apiCall('bulk_archive', { uids, folder }, 'POST');
}

// Snooze
export async function snoozeEmail(uid, snoozeUntil, folder = 'INBOX') {
  return apiCall('snooze', { uid, snooze_until: snoozeUntil, folder }, 'POST');
}

// Labels
export async function addLabel(uid, label, folder = 'INBOX') {
  return apiCall('add_label', { uid, label, folder }, 'POST');
}

export async function removeLabel(uid, label, folder = 'INBOX') {
  return apiCall('remove_label', { uid, label, folder }, 'POST');
}

export async function getLabels() {
  return apiCall('get_labels');
}

// AI
export async function aiAssist(type, context = {}) {
  return apiCall('ai_assist', { type, context }, 'POST');
}

// Profile
export async function getProfile() {
  return apiCall('get_profile');
}

export async function updateProfile(data) {
  return apiCall('update_profile', data, 'POST');
}

// Cover photo (profile-upgrade combo). Mirrors uploadAvatar plumbing —
// multipart with the `cover` field. Backend resizes to 1500×500 and ships
// to R2 (chatyy-media bucket, profile-covers/<email>/<ts>.jpg) so the
// CDN serves it directly without round-tripping through PHP every render.
export async function uploadCover(file) {
  const formData = new FormData();
  formData.append('action', 'upload_cover');
  if (typeof File !== 'undefined' && file instanceof File) {
    formData.append('cover', file, file.name || 'cover.jpg');
  } else if (typeof Blob !== 'undefined' && file instanceof Blob) {
    formData.append('cover', file, 'cover.jpg');
  } else if (file?._raw) {
    formData.append('cover', file._raw, file.name || 'cover.jpg');
  } else if (file?.blob) {
    formData.append('cover', file.blob, file.name || 'cover.jpg');
  } else if (file?.uri) {
    if (Platform.OS !== 'web') {
      formData.append('cover', { uri: file.uri, type: file.type || 'image/jpeg', name: file.name || 'cover.jpg' });
    } else {
      try {
        const blob = await fetch(file.uri).then(r => r.blob());
        formData.append('cover', blob, file.name || 'cover.jpg');
      } catch { return { success: false, message: 'Failed to read file' }; }
    }
  } else {
    return { success: false, message: 'Invalid file' };
  }
  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${API_URL}?action=upload_cover`, { method: 'POST', headers, body: formData, credentials: 'include', signal: controller.signal });
    clearTimeout(timeout);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { return { success: false, message: 'Servidor indisponivel' }; }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { success: false, message: 'Tempo limite excedido' };
    return { success: false, message: 'Connection error' };
  }
}

// Settings
export async function getSettings() {
  return apiCall('get_settings');
}

export async function updateSettings(data) {
  return apiCall('update_settings', data, 'POST');
}

// Spam / Ham reporting
export async function reportSpam(uid, folder = 'INBOX') {
  return apiCall('report_spam', { uid, folder }, 'POST');
}

export async function reportHam(uid, folder = 'INBOX') {
  return apiCall('report_ham', { uid, folder }, 'POST');
}

// Alias used by Não-é-spam UX — same backend handler, also adds sender to whitelist
export async function markNotSpam(uid, folder = 'Spam') {
  return apiCall('mark_not_spam', { uid, folder }, 'POST');
}

// Contacts autocomplete
export async function searchContacts(query) {
  return apiCall('contacts', { q: query });
}

// Find Chatyy user by phone number (returns email + name)
export async function findByPhone(phone) {
  return apiCall('find_by_phone', { phone }, 'POST');
}

// Chatyy user directory - list all registered users
export async function chatyyUsers(query = '', limit = 50, offset = 0) {
  const params = { limit, offset };
  if (query) params.q = query;
  return apiCall('chatyy_users', params);
}

// Send invite email
export async function sendInvite(email, name = '') {
  return apiCall('send_invite', { email, name }, 'POST');
}

// Drafts
export async function saveDraft(data) {
  return apiCall('draft_save', data, 'POST');
}

export async function listDrafts() {
  return apiCall('draft_list');
}

export async function deleteDraft(uid) {
  return apiCall('draft_delete', { uid }, 'POST');
}

// Templates
export async function listTemplates() {
  return apiCall('template_list');
}

export async function saveTemplate(data) {
  return apiCall('template_save', data, 'POST');
}

export async function deleteTemplate(id) {
  return apiCall('template_delete', { id }, 'POST');
}

// Scheduled send
export async function scheduleSend(data) {
  return apiCall('schedule_send', data, 'POST');
}

// Folder management
export async function createFolder(name) {
  return apiCall('create_folder', { name }, 'POST');
}

export async function renameFolder(oldName, newName) {
  return apiCall('rename_folder', { old_name: oldName, new_name: newName }, 'POST');
}

export async function deleteFolder(name) {
  return apiCall('delete_folder', { name }, 'POST');
}

export async function emptyTrash() {
  return apiCall('empty_trash', {}, 'POST');
}

export async function emptySpam() {
  return apiCall('empty_spam', {}, 'POST');
}

// Thread view
// Backend get_thread returns data = { thread_id, subject, message_count, messages:[...] }.
// read.js / ThreadView consume `data` as an array of messages, so flatten the
// envelope: expose the messages array as `data` while keeping the metadata
// fields (thread_id/subject/message_count) reachable for any caller that wants
// them. Without this remap `data.length` is undefined and ThreadView never
// renders (P0). Degrades safely if the backend ever returns a bare array.
export async function getThread(uid, folder = 'INBOX') {
  const r = await apiCall('get_thread', { uid, folder });
  if (r && r.success && r.data && !Array.isArray(r.data)) {
    const meta = r.data;
    return {
      ...r,
      data: Array.isArray(meta.messages) ? meta.messages : [],
      thread_id: meta.thread_id,
      subject: meta.subject,
      message_count: meta.message_count,
    };
  }
  return r;
}

// Attachment download URL.
//
// Security (P1): the raw bearer used to be embedded in the URL (visible in
// browser history, server logs, Referer headers). We now prefer a short-lived
// download token (`dt=`) minted by the backend `attachment_dl_token` endpoint.
// Because the only consumers (EmailReader) build the URL synchronously at
// render time, getAttachmentUrl stays sync: it serves a cached `dt` when one
// is available+fresh, otherwise it falls back to the legacy bearer URL AND
// fires a background prefetch so the next render self-upgrades to `dt`. If the
// backend endpoint isn't deployed yet the prefetch fails quietly and we keep
// degrading to the bearer — never breaking downloads.
const _dlTokenCache = new Map(); // key -> { token, exp }
const _dlTokenInflight = new Set();
const _DL_TOKEN_TTL_MS = 4 * 60 * 1000; // assume ~5min server TTL, refresh early

function _dlTokenKey(uid, folder, part) {
  return `${uid}:${folder}:${part}`;
}

async function _prefetchAttachmentDlToken(uid, folder, part) {
  const key = _dlTokenKey(uid, folder, part);
  if (_dlTokenInflight.has(key)) return;
  _dlTokenInflight.add(key);
  try {
    const r = await apiCall('attachment_dl_token', { uid, folder, part });
    const tok = r && r.success ? (r.data?.dt || r.data?.token || r.dt) : null;
    if (tok) {
      const ttl = (r.data?.expires_in ? r.data.expires_in * 1000 : _DL_TOKEN_TTL_MS);
      _dlTokenCache.set(key, { token: tok, exp: Date.now() + Math.min(ttl, _DL_TOKEN_TTL_MS) });
    }
  } catch {
    // Endpoint not deployed / transient — stay on bearer fallback.
  } finally {
    _dlTokenInflight.delete(key);
  }
}

export function getAttachmentUrl(uid, folder, part) {
  const base = `${API_URL}?action=attachment_download&uid=${uid}&folder=${encodeURIComponent(folder)}&part=${part}`;
  const key = _dlTokenKey(uid, folder, part);
  const cached = _dlTokenCache.get(key);
  if (cached && cached.exp > Date.now()) {
    return `${base}&dt=${encodeURIComponent(cached.token)}`;
  }
  // No fresh dt — kick off a background mint for the next render, and fall
  // back to the bearer for this one so the download still works today.
  try { _prefetchAttachmentDlToken(uid, folder, part); } catch {}
  return `${base}&token=${authToken || ''}`;
}

// ---- Forgot Password ----
export async function forgotPasswordOptions(email) {
  return apiCall('forgot_password_options', { email }, 'POST');
}

export async function forgotPasswordInitiate(email, method = 'email') {
  return apiCall('forgot_password_initiate', { email, method }, 'POST');
}

export async function forgotPasswordVerify(email, code) {
  return apiCall('forgot_password_verify', { email, code }, 'POST');
}

export async function resetPassword(email, resetToken, newPassword) {
  return apiCall('reset_password', { email, reset_token: resetToken, new_password: newPassword }, 'POST');
}

// Change password
export async function changePassword(currentPassword, newPassword) {
  return apiCall('change_password', { current_password: currentPassword, new_password: newPassword }, 'POST');
}

// Custom labels
export async function createLabel(name, color) {
  return apiCall('create_label', { name, color }, 'POST');
}

export async function deleteLabel(name) {
  return apiCall('delete_label', { name }, 'POST');
}

// Contacts management
export async function getContactsList() {
  return apiCall('contacts_list');
}

export async function saveContact(data) {
  return apiCall('contact_save', data, 'POST');
}

export async function deleteContact(email) {
  return apiCall('contact_delete', { email }, 'POST');
}

export async function discoverContacts() {
  return apiCall('contacts_discover');
}

export async function listOneMundoUsers() {
  return apiCall('list_onemundo_users');
}

export async function searchOneMundoUsers(query) {
  return apiCall('search_onemundo_users', { query });
}

// Avatar
export async function uploadAvatar(file) {
  const formData = new FormData();
  formData.append('action', 'upload_avatar');
  // Web: file may be a raw File/Blob OR wrapped { _raw, name }
  if (typeof File !== 'undefined' && file instanceof File) {
    formData.append('avatar', file, file.name || 'avatar.jpg');
  } else if (typeof Blob !== 'undefined' && file instanceof Blob) {
    formData.append('avatar', file, 'avatar.jpg');
  } else if (file?._raw) {
    formData.append('avatar', file._raw, file.name || 'avatar.jpg');
  } else if (file?.blob) {
    formData.append('avatar', file.blob, file.name || 'avatar.jpg');
  } else if (file?.uri) {
    // Native: { uri, name, type } object
    if (Platform.OS !== 'web') {
      formData.append('avatar', { uri: file.uri, type: file.type || 'image/jpeg', name: file.name || 'avatar.jpg' });
    } else {
      // Web with blob URL: fetch into a real Blob
      try {
        const blob = await fetch(file.uri).then(r => r.blob());
        formData.append('avatar', blob, file.name || 'avatar.jpg');
      } catch { return { success: false, message: 'Failed to read file' }; }
    }
  } else {
    return { success: false, message: 'Invalid file' };
  }
  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${API_URL}?action=upload_avatar`, { method: 'POST', headers, body: formData, credentials: 'include', signal: controller.signal });
    clearTimeout(timeout);
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { success: false, message: 'Servidor indisponivel' }; }
    // Bust the avatar cache so every <img>/<CachedImage> sourced from
    // getAvatarUrlForEmail() renders the new photo without needing the
    // app to fully restart (HTTP cache was pinning the old image). Use
    // the server-issued avatar_version when available so all devices
    // converge on the same cache-buster (and so other users hitting
    // profile_get also bust their CDN copy on the same v=).
    if (parsed?.success) {
      try {
        const v = parsed?.data?.avatar_version;
        // savedCredentials is in-memory only — empty after a page reload on
        // web until the user re-logs. Fall back to the persisted active
        // account so the cache buster fires there too.
        const targetEmail = savedCredentials?.email
          || getActiveAccountEmail()
          || parsed?.data?.email
          || null;
        if (targetEmail) bustAvatarCache(targetEmail, typeof v === 'number' ? v : undefined);
      } catch {}
    }
    return parsed;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { success: false, message: 'Tempo limite excedido' };
    return { success: false, message: 'Connection error' };
  }
}

// Per-email cache-bust token. Bumped via bustAvatarCache() after the user
// updates their profile photo so every <img> / expo-image target sees a
// fresh URL instead of the HTTP-cached old one.
//
// Persisted to AsyncStorage as `avatar_v_map` so the bust survives full
// app restarts (without this, after killing+reopening the app, the
// browser/CDN still served the old cached avatar — the user reported
// "atualizei a foto mas n atualizou em todo lugar").
const _avatarCacheBust = new Map();
let _avatarMapHydrated = false;
let _avatarMapWriteTimer = null;
async function _hydrateAvatarMap() {
  if (_avatarMapHydrated) return;
  _avatarMapHydrated = true;
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const raw = await AsyncStorage.getItem('avatar_v_map');
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const k of Object.keys(obj)) _avatarCacheBust.set(k, obj[k]);
      }
    }
  } catch {}
}
// Fire hydrate at module load (no await — UI doesn't block on this).
try { _hydrateAvatarMap(); } catch {}
function _scheduleAvatarMapWrite() {
  if (_avatarMapWriteTimer) clearTimeout(_avatarMapWriteTimer);
  _avatarMapWriteTimer = setTimeout(async () => {
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      const obj = {};
      for (const [k, v] of _avatarCacheBust.entries()) obj[k] = v;
      await AsyncStorage.setItem('avatar_v_map', JSON.stringify(obj));
    } catch {}
  }, 250);
}
export function bustAvatarCache(email, version) {
  if (!email) return;
  const v = (typeof version === 'number' && version > 0) ? version : Date.now();
  _avatarCacheBust.set(String(email).toLowerCase(), v);
  _scheduleAvatarMapWrite();
  // Bump AvatarCircle's local version registry too — its <AvatarCircle>
  // listeners subscribe to that map to know when to re-render. Without this
  // call, the URL has the new ?v=… but no component knows to rebind to it,
  // so the photo only changes after a manual refresh / app reopen. (User
  // reported: "atualizo a foto e n atualiza automaticamente instantaneamente").
  try {
    const ac = require('../components/AvatarCircle');
    ac?.bumpAvatarCache?.(String(email).toLowerCase());
  } catch {}
}
function _avatarV(email) {
  return _avatarCacheBust.get(String(email || '').toLowerCase()) || '';
}

// Daily-rotating cache-bust fallback. When `bumpAvatarCache(email)` hasn't
// been called for this email (cold app open, viewing someone you've never
// chatted with), the URL still varies once per day so any stale placeholder
// PNGs that got cached during the 2026-05-18 backend ACL outage roll off
// within 24h instead of being held forever by expo-image's disk cache.
function _avatarDailyBust() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// IMPORTANT: chain `?v=<storedV>&d=<dailyBust>` ALWAYS.
//
// Earlier this used `_avatarV(email) || _avatarDailyBust()` — a fallback.
// That broke for FRIENDS during the 2026-05-18 ACL outage:
//
//   1. Pre-outage, a friend's WS `avatar_updated` event stored e.g.
//      `_avatarCacheBust[friend@x]` = 1747200000000 → URL `?v=1747200000000`.
//   2. Outage hit. expo-image fetched that URL, got 403, cached the FAILURE
//      keyed by the URL. (No HTTP error invalidation in expo-image's disk cache.)
//   3. Outage ended. `_avatarV(friend)` still returns 1747200000000 (sticky in
//      AsyncStorage `avatar_v_map`). Daily-bust never applies because the
//      fallback short-circuits on the truthy stored value. URL identical → same
//      poisoned cache entry → friend's photo never appears.
//
// The user's OWN avatar worked because uploading a new photo calls
// `bustAvatarCache(ownEmail, freshTimestamp)` which produces a new URL post-outage.
// Friends have no upload event to trigger a fresh timestamp.
//
// Fix: ALWAYS append today's `&d=YYYYMMDD` as a second param so the URL
// rotates daily regardless of stored version state. New URL = new cache key =
// fresh fetch. Cost is exactly 1 cache miss per friend per UTC day. Backend
// already serves long max-age=86400 so the next 23h59m are still cached on
// disk by expo-image.
export function getAvatarUrl(email) {
  const e = email || savedCredentials?.email || '';
  const v = _avatarV(e);
  const d = _avatarDailyBust();
  const vPart = v ? `&v=${v}` : '';
  return `${API_URL}?action=get_avatar&email=${encodeURIComponent(e)}${vPart}&d=${d}`;
}

export function getAvatarUrlForEmail(email) {
  if (!email) return null;
  const v = _avatarV(email);
  const d = _avatarDailyBust();
  const vPart = v ? `&v=${v}` : '';
  return `${API_URL}?action=get_avatar&email=${encodeURIComponent(email)}${vPart}&d=${d}`;
}

/**
 * Convert email username to readable display name.
 * e.g. "anacarla.pereiraramos@x.com" → "Ana Carla Pereira Ramos"
 *      "joao.marcelo@x.com" → "Joao Marcelo"
 *      "Already A Name" → "Already A Name" (unchanged)
 */
const _commonNames = new Set([
  // First names
  'ana','bia','bea','carlos','carla','carolina','clara','daniel','daniela',
  'eduardo','fernanda','fernando','flavia','gabriel','gabriela','guilherme',
  'gustavo','helena','henrique','igor','isabela','jessica','joao','jose',
  'julia','juliana','larissa','leticia','luana','lucas','luiz','luiza',
  'marcelo','marcos','maria','mariana','matheus','mateus','miguel','nathalia',
  'natalia','nicolas','patricia','paula','paulo','pedro','rafael','raquel',
  'renata','renato','ricardo','roberta','roberto','rodrigo','rosa','sandra',
  'sara','sergio','silvia','thiago','tiago','vanessa','vinicius','vitoria',
  'victor','victoria','wallace','walfredo','wesley','william','agata','kerolly',
  'jamily','nicoly','felipe','beatriz','rene','mauricio','leticya','alice',
  'amanda','bruna','bruno','camila','celia','cristina','diego','elisa',
  'fabio','fabiana','giovanna','heloisa','isabelle','jorge','karen','leonardo',
  'livia','lorena','lara','manuela','marina','melissa','nadia','otavio',
  'priscila','rebeca','simone','tatiana','valentina','yasmin',
  // Common surnames (for splitting compound surnames)
  'almeida','alves','araujo','barbosa','barros','batista','borges','braga',
  'campos','cardoso','carvalho','castro','correia','costa','cruz','cunha',
  'dias','duarte','farias','ferreira','fonseca','freitas','garcia','gomes',
  'lima','lopes','machado','martins','medeiros','melo','mendes','miranda',
  'monteiro','moreira','moura','nascimento','neves','nogueira','noronha',
  'nunes','oliveira','pereira','pinto','ramos','reis','ribeiro','rocha',
  'rodrigues','rosa','santos','silva','souza','sousa','teixeira','vieira',
]);

function _splitCompoundName(part) {
  const lower = part.toLowerCase();
  // If the whole part is a known name, return it as-is
  if (_commonNames.has(lower)) return [part];
  if (part.length <= 5) return [part];
  // Try longest prefix first (prefer "beatriz" over "bea")
  for (let len = Math.min(lower.length - 2, 9); len >= 3; len--) {
    const prefix = lower.substring(0, len);
    const rest = lower.substring(len);
    if (_commonNames.has(prefix) && rest.length >= 2) {
      return [prefix, ..._splitCompoundName(rest)];
    }
  }
  return [part];
}

export function emailToDisplayName(nameOrEmail) {
  if (!nameOrEmail) return '';
  let str = nameOrEmail;
  // If it already has spaces and looks like a proper name, return as-is
  if (str.includes(' ') && !str.includes('@')) return str;
  if (str.includes('@')) str = str.split('@')[0];
  // Split by dots, underscores, dashes
  const parts = str.split(/[._-]/);
  const expanded = parts.flatMap(p => _splitCompoundName(p));
  return expanded
    .filter(p => p && typeof p === "string" && p.length > 0).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

// Block / Mute
export async function blockSender(email) {
  return apiCall('block_sender', { email }, 'POST');
}

export async function unblockSender(email) {
  return apiCall('unblock_sender', { email }, 'POST');
}

export async function muteThread(uid, folder = 'INBOX') {
  return apiCall('mute_thread', { uid, folder }, 'POST');
}

export async function unmuteThread(uid, folder = 'INBOX') {
  return apiCall('unmute_thread', { uid, folder }, 'POST');
}

// Export email as EML
// TODO: Security concern — bearer token embedded in URL (see getAttachmentUrl comment)
export function getExportUrl(uid, folder) {
  return `${API_URL}?action=export_email&uid=${uid}&folder=${encodeURIComponent(folder)}&token=${authToken || ''}`;
}

// Active sessions
export async function getSessionsList() {
  return apiCall('sessions_list');
}

export async function revokeSession(tokenHash) {
  return apiCall('revoke_session', { session_id: tokenHash, token_hash: tokenHash }, 'POST');
}

export async function revokeAllSessions() {
  return apiCall('revoke_all_sessions', {}, 'POST');
}

// Delete account (Apple requirement)
export async function deleteAccount(password) {
  return apiCall('delete_account', { password }, 'POST');
}

// Token accessor for WebSocket auth
export function getAuthToken() {
  return authToken || null;
}

export function setAuthTokenDirect(token) {
  authToken = token;
  // Reset meta so the 90-day grace clock starts fresh from this point.
  // The next successful 2xx will refresh last_auth_ok_at.
  if (token) {
    _tokenMeta = {
      last_auth_ok_at: Date.now(),
      created_at: _tokenMeta.created_at || Date.now(),
      email: _tokenMeta.email || '',
    };
    _saveTokenMeta().catch(() => {});
  }
  storeToken(token);
  // [#992 Stage 1] Persist token+base into native SharedPreferences (Android)
  // / App Group UserDefaults (iOS) so the call-accept cold-start path can
  // fetch a LiveKit token without waiting for the JS bridge. Best-effort.
  if (token) {
    _persistAuthForNative(token).catch(() => {});
  }
}

let _ExpoCallKitNative = null;
async function _persistAuthForNative(token) {
  try {
    if (!_ExpoCallKitNative) {
      _ExpoCallKitNative = await import('../modules/expo-callkit');
    }
    if (_ExpoCallKitNative?.persistAuthForNativeCall) {
      await _ExpoCallKitNative.persistAuthForNativeCall(token, BASE_URL);
    }
  } catch {
    // Module may not be linked on web. Silent fail.
  }
}

export function saveTrustToken(token) {
  if (token) {
    deviceTrustToken = token;
    storeTrustToken(token);
  }
}

// ============================================================
// MEETINGS API
// ============================================================
export async function meetCreate(title = 'Meeting', lobbyEnabled = false) {
  return apiCall('meet_create', { title, lobby_enabled: lobbyEnabled }, 'POST');
}

export async function meetSchedule({ title, description, scheduled_at, duration_minutes, lobby_enabled, invitees, recurrence, password }) {
  return apiCall('meet_schedule', { title, description, scheduled_at, duration_minutes, lobby_enabled, invitees, recurrence, password }, 'POST');
}

export async function meetUpdate(roomId, updates) {
  return apiCall('meet_update', { room_id: roomId, ...updates }, 'POST');
}

export async function meetCancel(roomId) {
  return apiCall('meet_cancel', { room_id: roomId }, 'POST');
}

export async function meetDelete(roomId) {
  return apiCall('meet_delete', { room_id: roomId }, 'POST');
}

export async function meetJoin(roomId, password = null) {
  const params = { room_id: roomId };
  if (password) params.password = password;
  return apiCall('meet_join', params, 'POST');
}

export async function meetLeave(roomId) {
  return apiCall('meet_leave', { room_id: roomId }, 'POST');
}

export async function meetEnd(roomId) {
  return apiCall('meet_end', { room_id: roomId }, 'POST');
}

export async function meetInfo(roomId) {
  return apiCall('meet_info', { room_id: roomId });
}

export async function meetList(filter = 'upcoming', limit = 50, offset = 0) {
  return apiCall('meet_list', { filter, limit, offset });
}

export async function meetRsvp(roomId, status) {
  return apiCall('meet_rsvp', { room_id: roomId, status }, 'POST');
}

export async function meetKick(roomId, targetEmail) {
  return apiCall('meet_kick', { room_id: roomId, email: targetEmail }, 'POST');
}

export async function meetMuteAll(roomId) {
  return apiCall('meet_mute_all', { room_id: roomId }, 'POST');
}

export async function meetLock(roomId) {
  return apiCall('meet_lock', { room_id: roomId }, 'POST');
}

export async function meetUnlock(roomId) {
  return apiCall('meet_unlock', { room_id: roomId }, 'POST');
}

export async function meetLobbyAdmit(roomId, targetEmail) {
  return apiCall('meet_lobby_admit', { room_id: roomId, email: targetEmail }, 'POST');
}

export async function meetLobbyDeny(roomId, targetEmail) {
  return apiCall('meet_lobby_deny', { room_id: roomId, email: targetEmail }, 'POST');
}

export async function meetChatHistory(roomId, limit = 200) {
  return apiCall('meet_chat_history', { room_id: roomId, limit });
}

export async function meetSendInvites(roomId, invitees) {
  return apiCall('meet_send_invites', { room_id: roomId, invitees }, 'POST');
}

export async function meetRecap(roomId) {
  return apiCall('meet_recap', { room_id: roomId });
}

export async function meetAiSummary(roomId) {
  return apiCall('meet_ai_summary', { room_id: roomId }, 'POST');
}

// Fetch Whisper transcript + AI recap for a finished meeting recording.
// Returns { transcript, ai_summary, finalized_at, status } where status is
// 'processing' | 'ready' | 'none'. UI should poll every ~5s when processing.
export async function meetTranscript(roomId) {
  return apiCall('meet_transcript', { room_id: roomId });
}

export async function meetStartRecording(roomId) {
  return apiCall('meet_start_recording', { room_id: roomId }, 'POST');
}

export async function meetStopRecording(roomId) {
  return apiCall('meet_stop_recording', { room_id: roomId }, 'POST');
}

export async function meetPromote(roomId, targetEmail) {
  return apiCall('meet_promote', { room_id: roomId, email: targetEmail }, 'POST');
}

export async function meetDemote(roomId, targetEmail) {
  return apiCall('meet_demote', { room_id: roomId, email: targetEmail }, 'POST');
}

// ============================================================
// CHAT API
// ============================================================
export async function chatConversations(search = '', includeArchived = false) {
  const params = {};
  if (search) params.search = search;
  if (includeArchived) params.include_archived = 1;

  // Stage 6 — WhatsApp-Web read transport switch.
  // On web with a paired phone available, fetch the conversation list via
  // WS relay (phone reads SQLite, replies over WS) instead of REST. The
  // server doesn't even need to touch PG — the phone is the source of
  // truth. On phone-offline, fall back to IndexedDB cache + surface the
  // banner via globalThis.__chatyy_phone_offline.
  // Search/archived filters skip relay since relayResponder.get_conversations
  // returns the unfiltered list (filtering is server-side in PHP path).
  if (Platform.OS === 'web' && !search && !includeArchived) {
    try {
      const relay = require('./relayClient');
      if (await relay.isAvailable()) {
        try {
          const r = await relay.getConversationsViaRelay();
          try { globalThis.__chatyy_phone_offline = false; } catch {}
          return r;
        } catch (e) {
          const code = e?.code || '';
          if (code === 'phone_offline' || code === 'relay_timeout' || code === 'no_paired_device' || code === 'request_timeout') {
            // [STAGE-D 2026-05-20] Auto-wake the phone via silent FCM/APNs BEFORE
            // surfacing the offline banner. WhatsApp Web does this transparently:
            // user clicks chat, server pings phone, phone wakes, replies, user
            // never sees an offline state for the common "phone in pocket / Doze"
            // case. We rate-limit ourselves once per 60s so a truly dead phone
            // doesn't burn FCM quota. The relay request itself was already up
            // to ~10s timeout; the wake push usually lands within 1-2s, so we
            // do one more relay round-trip after wake before giving up.
            let attemptedWake = false;
            try {
              const lastWake = Number(globalThis.__chatyy_last_auto_wake || 0);
              if (Date.now() - lastWake > 60000) {
                globalThis.__chatyy_last_auto_wake = Date.now();
                attemptedWake = true;
                // Fire-and-forget; we don't await the wake itself.
                fetch('/api/chat.php', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'chat_wake_my_phone' }),
                }).catch(() => {});
                // Give the phone up to 2.5s to receive + reconnect WS.
                await new Promise(res => setTimeout(res, 2500));
                if (await relay.isAvailable()) {
                  try {
                    const r2 = await relay.getConversationsViaRelay();
                    try { globalThis.__chatyy_phone_offline = false; } catch {}
                    return r2;
                  } catch {}
                }
              }
            } catch {}
            // [#1220 2026-05-20] WhatsApp parity fix — DON'T short-circuit to
            // IndexedDB cache when relay fails. PG is the canonical source on
            // Chatyy (server-authoritative, unlike WhatsApp's phone-first
            // model). REST below reads PG directly and returns fresh data,
            // so falling through avoids showing the misleading "celular
            // offline" banner while the user can in fact see all conversations
            // live. The banner is suppressed here — only the navigator.onLine
            // OfflineNotice should fire when the BROWSER itself is offline.
            try { globalThis.__chatyy_phone_offline = false; } catch {}
            // Intentional fall-through: relay was a perf optimization, not
            // a hard requirement. REST/Rust block below handles the request.
          }
          // Unknown relay error — silently degrade to REST.
        }
      }
    } catch {}
  }

  // Try Rust first — reads from PG, returns in ~10ms vs 100ms on PHP.
  // Rust handles the unfiltered conversation list; fall back to PHP for search/archived filters.
  if (!search && !includeArchived && (await _probeRustChat())) {
    try {
      const headers = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`${BASE_URL}/api/rust/chat/list`, {
        method: 'GET',
        headers,
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.ok) {
        const data = await r.json();
        return data;
      }
      // Rust returned non-2xx. Fast-auth on the edge has been known to throw
      // transient 401s (PG pool blip, token cache cold-start, etc.), and on
      // 500 we want to degrade to PHP. Fall through to PHP in every non-OK
      // case so the user never sees a 401 just because the Rust path
      // flickered.
      if (r.status >= 500) _rustChatAvailable = false;
    } catch {
      _rustChatAvailable = false;
    }
  }
  return apiCall('chat_list', params);
}

export async function chatCreate(members, name = '', type = 'direct') {
  return apiCall('chat_create', { members, name, type }, 'POST');
}

// Rust chat-api endpoint availability (probed once, cached).
// /api/rust/chat/messages is 5-10x faster than PHP (reads from PG, no FPM overhead).
// Falls back to PHP when Rust is unavailable (old tokens, PG lag, etc).
// Rust chat fast-path disabled: the Rust /messages endpoint doesn't return
// `_read` on each message row, so ticks on cold-loaded threads stay at 2
// gray forever even when the peer read weeks ago (audit bug #7). Keep the
// probe function for backwards compat but always return false so the
// client uses the PHP path which fills `_read` correctly.
let _rustChatAvailable = false;
async function _probeRustChat() {
  return false;
}

export async function chatMessages(conversationId, limit = 20, beforeId = null, sinceId = 0, topicId = undefined) {
  const params = { conversation_id: conversationId, limit };
  if (beforeId) params.before_id = beforeId;
  else if (sinceId > 0) params.since_id = sinceId;
  if (topicId !== undefined && topicId !== null) params.topic_id = topicId;

  // Stage 6 — read via WS relay when web companion is paired + phone online.
  // Skip relay when sinceId/topicId are set: relayResponder.get_messages only
  // implements limit + before_id; sinceId (delta) and topicId (threads) need
  // the PHP path until the phone-side handler grows those filters.
  if (Platform.OS === 'web' && !sinceId && topicId === undefined) {
    try {
      const relay = require('./relayClient');
      if (await relay.isAvailable()) {
        try {
          const r = await relay.getMessagesViaRelay(conversationId, beforeId, limit);
          try { globalThis.__chatyy_phone_offline = false; } catch {}
          return r;
        } catch (e) {
          const code = e?.code || '';
          if (code === 'phone_offline' || code === 'relay_timeout' || code === 'no_paired_device' || code === 'request_timeout') {
            // [#1220 2026-05-20] Don't surface banner — PHP/Rust path below
            // reads PG directly and returns fresh data. The relay was a perf
            // optimization, not a hard dep. Falling through avoids the
            // misleading "celular offline" banner.
            try { globalThis.__chatyy_phone_offline = false; } catch {}
            // Intentional fall-through to PHP/Rust path.
          }
          // Other errors — silently fall through.
        }
      }
    } catch {}
  }

  // FORCED PHP until Rust handler is updated to include forwarded_from,
  // forward_count, thumb_b64, client_message_id, conv_pts, mentions, and
  // viewed_by in its SELECT. Users reported forwarded messages appearing
  // in the chat list (PHP path) but not in the open conversation (Rust
  // path) — confirmed: Rust SELECT omits those fields, causing the row
  // to render without the "Encaminhada" badge or drop silently when
  // the client expects certain keys.
  const USE_RUST_CHAT_MESSAGES = false;
  if (USE_RUST_CHAT_MESSAGES && topicId === undefined && (await _probeRustChat())) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`${BASE_URL}/api/rust/chat/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.ok) return await r.json();
      // Non-2xx — disable Rust for this session and fall back
      if (r.status >= 500) _rustChatAvailable = false;
    } catch {
      _rustChatAvailable = false;
    }
  }
  return apiCall('chat_messages', params);
}

// Generate a UUID v4-ish for client_message_id (idempotency key)
function _genClientMsgId() {
  // Use crypto.randomUUID when available (web + RN 0.74+), fallback to manual
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
      return 'cli_' + globalThis.crypto.randomUUID().replace(/-/g, '');
    }
  } catch {}
  return 'cli_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
}

// Lazy-load localDb so we don't pay the SQLite init cost at module-eval time
// AND avoid any circular-import edge cases (api.js is imported from many
// callers; localDb has no deps on api.js but we keep the require inside the
// helper anyway for safety). All helpers no-op on web — the local store is
// IDB-backed there, the optimistic UI write already lives in chatCache.
//
// Stage 1 invariant: every state-mutating chat call writes to local SQLite
// BEFORE hitting the server. The server is a delivery target, not the truth.
let _localDb = null;
function _ld() {
  if (_localDb !== null) return _localDb;
  try { _localDb = require('./localDb'); }
  catch { _localDb = false; }
  return _localDb;
}
async function _localOptimisticSend({ tempId, conversationId, content, type, replyToId, fileUrl, clientMessageId, senderEmail }) {
  // Native-only path: best-effort write to SQLite *before* the network call.
  // Failures are non-fatal — the caller still fires the POST and the offline
  // queue path covers retries. We don't await this with a strict guarantee
  // because the UI's own optimistic state is already up; SQLite just needs
  // to catch up *before* the network round-trip completes, not before render.
  const ld = _ld();
  if (!ld || typeof ld.saveLocalMessage !== 'function') return null;
  try {
    return await ld.saveLocalMessage({
      id: tempId,
      conversation_id: conversationId,
      sender_email: senderEmail || null,
      content,
      type: type || 'text',
      file_url: fileUrl || null,
      reply_to_id: replyToId || null,
      client_temp_id: clientMessageId || tempId,
      created_at: new Date().toISOString(),
    }, 'pending');
  } catch { return null; }
}
async function _localFinalizeSend(tempId, serverRow) {
  // After a successful POST: insert the confirmed row into `messages` keyed
  // by the durable server id, then drop the offline_queue entry for the
  // optimistic intent so retries stop. saveMessage handles the client_temp_id
  // dedup link so the local_seq survives the temp → server-id transition.
  const ld = _ld();
  if (!ld) return;
  try {
    if (serverRow && typeof ld.saveMessage === 'function') {
      const ctid = serverRow.client_temp_id || serverRow.client_message_id || tempId || null;
      await ld.saveMessage({ ...serverRow, client_temp_id: ctid, pending_state: 'sent' });
    }
    if (typeof ld.clearPendingSend === 'function') {
      await ld.clearPendingSend(tempId);
    }
  } catch {}
}
async function _localMarkFailed(tempId, err) {
  const ld = _ld();
  if (!ld || typeof ld.markMessageFailed !== 'function' || !tempId) return;
  try { await ld.markMessageFailed(tempId, err?.message || err); } catch {}
}
async function _localUpdateMessage(messageId, updates) {
  const ld = _ld();
  if (!ld || typeof ld.updateMessage !== 'function' || !messageId) return;
  try { await ld.updateMessage(messageId, updates); } catch {}
}

// ─── Stage 7 envelope-mode feature flag (2026-05-16) ────────────────────────
// `globalThis.__chatyy_envelope_mode === true` flips chatSend to the
// per-recipient-device ciphertext path (see chatSend body below). Default is
// OFF — Stage 6/7 will roll the flag default-ON per account via remote
// config + a debug menu. These helpers give ops a runtime switch and a
// persistent cross-session toggle (AsyncStorage `@chatyy_envelope_mode`).
const _ENVELOPE_MODE_KEY = '@chatyy_envelope_mode';

export function setEnvelopeMode(enabled) {
  const flag = enabled === true;
  try {
    if (typeof globalThis !== 'undefined') {
      globalThis.__chatyy_envelope_mode = flag;
    }
  } catch {}
  // Persist for next bundle load. Stage 7 (E2E default-ON):
  //  - flag=true  → persist '1'  (loadEnvelopeMode → ON via raw!=='0')
  //  - flag=false → persist '0'  (explicit opt-out; loadEnvelopeMode → OFF)
  // We do NOT remove the key on opt-out because empty/null now means ON.
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      localStorage.setItem(_ENVELOPE_MODE_KEY, flag ? '1' : '0');
    } else {
      _writeAsyncStorage(_ENVELOPE_MODE_KEY, flag ? '1' : '0');
    }
  } catch {}
  return flag;
}

export async function loadEnvelopeMode() {
  // [2026-05-29 staged re-enable groundwork] The single source of truth is the
  // DEFAULT_E2EE build flag (constants/featureFlags.js). When it's false this
  // is a hard kill-switch: no persisted opt-in can enable envelope mode, so
  // flipping the build flag OFF reliably reverts even devices that previously
  // opted in (raw === '1'). This is intentional — re-enabling blindly broke
  // delivery before, and the flag must be the only lever.
  //
  // When DEFAULT_E2EE is later flipped true (after dual-device QA), this falls
  // back to the WhatsApp-style default-ON semantics: encrypted unless the user
  // explicitly opted out (persisted '0').
  if (DEFAULT_E2EE !== true) {
    try {
      if (typeof globalThis !== 'undefined') {
        globalThis.__chatyy_envelope_mode = false;
      }
    } catch {}
    return false;
  }
  let raw = null;
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      raw = localStorage.getItem(_ENVELOPE_MODE_KEY);
    } else {
      raw = await _readAsyncStorage(_ENVELOPE_MODE_KEY);
    }
  } catch {}
  // Default ON (flag is true): only an explicit '0' opt-out turns it off.
  const flag = raw !== '0';
  try {
    if (typeof globalThis !== 'undefined') {
      globalThis.__chatyy_envelope_mode = flag;
    }
  } catch {}
  return flag;
}

// [#1188 2026-05-19] KILL-SWITCH: E2EE envelope mode default OFF.
// Reason: receiver-side decrypt has been failing silently for days. Even
// after the getDeviceKeyPair fix, users still report messages not arriving
// in real-time on Android+iOS. Until we can reproduce + verify decrypt
// success end-to-end, default to plaintext PHP send (the path that ALWAYS
// worked) — every chat message goes through chat_messages table +
// `chat_message` WS broadcast, receiver renders instantly. Power users
// can flip back via setEnvelopeMode(true). When the decrypt path is
// proven stable in a future round, flip this back to default-ON.
// [2026-05-29] Boot default derives from the DEFAULT_E2EE build flag (which is
// false today → plaintext). loadEnvelopeMode() below re-resolves once storage
// is readable, but it ALSO honors DEFAULT_E2EE so the kill-switch holds.
try {
  if (typeof globalThis !== 'undefined' && globalThis.__chatyy_envelope_mode === undefined) {
    globalThis.__chatyy_envelope_mode = (DEFAULT_E2EE === true);
  }
} catch {}
try { loadEnvelopeMode().catch(() => {}); } catch {}

export async function chatSend(conversationId, content, type = 'text', replyToId = null, mentions = null, fileUrl = null, tempId = null, clientMessageId = null, topicId = null, opts = null) {
  // Guard: server raises an unhelpful 400 when conversation_id is empty/0,
  // and the client bubble sticks as "pending" because the error message
  // isn't surfaced. Reject here with a clear error so the caller can handle.
  if (!conversationId) {
    return { success: false, message: 'invalid_conversation_id', error: 'invalid_conversation_id' };
  }
  // Stable client_message_id — generated once per logical send. Re-used as
  // the dedup key when the server bounces the row back via WS new_message.
  const stableCMI = clientMessageId || _genClientMsgId();
  // Stable temp id — if the caller didn't pass one we synthesize. Caller MAY
  // have already inserted an optimistic bubble using a different temp id; in
  // that case the SQLite write here lands as a sibling row keyed by the
  // local temp id we pick. saveMessage() folds them via client_temp_id on
  // server echo, so they collapse to one row eventually.
  const localTempId = tempId || ('tmp_' + stableCMI);

  // ── 1. WRITE TO LOCAL SQLITE FIRST (Stage 1 invariant) ────────────────
  // The local row is now the source of truth. Server is a delivery target.
  // Failures here are logged but never block the POST; absolute worst case
  // is the optimistic row is missing from cache but the server has it.
  // [#1188 fix 2026-05-19] Pass senderEmail so SQLite row has correct
  // owner — without this, cold-start cache read shows the user's own
  // messages as incoming (sender_email NULL !== currentEmail).
  await _localOptimisticSend({
    tempId: localTempId,
    conversationId,
    content,
    type,
    replyToId,
    fileUrl,
    clientMessageId: stableCMI,
    senderEmail: _tokenMeta.email || null,
  });

  const payload = {
    conversation_id: conversationId,
    content,
    type,
    reply_to_id: replyToId,
    // CRITICAL: always send a stable client_message_id so retries don't duplicate.
    client_message_id: stableCMI,
  };
  if (tempId) payload.temp_id = tempId;
  if (mentions && Array.isArray(mentions) && mentions.length > 0) {
    // Defensive stringify — mention arrays with circular refs or BigInts
    // would otherwise throw and kill the whole send.
    try { payload.mentions = JSON.stringify(mentions); } catch { /* skip */ }
  }
  if (fileUrl) payload.file_url = fileUrl;
  if (topicId) payload.topic_id = topicId;
  // iMessage-style effect ("slam", "loud", "balloons", etc.). Server
  // whitelists; client passes raw — invalid values are silently dropped.
  if (opts?.effect) payload.effect = String(opts.effect).toLowerCase();
  // Silent mode (Telegram parity): recipient receives the message in-thread
  // but with no notification banner/sound. Callers opt in via opts.silent.
  if (opts?.silent) payload.silent = true;
  // Partial-text quote (Telegram premium): user replied to a snippet of a
  // longer parent message. Sent as a separate field so the parent body and
  // the quoted excerpt can both live in cache without one overwriting the
  // other. Server clamps to 240 chars regardless.
  if (opts?.replyQuoteText && replyToId) {
    payload.reply_quote_text = String(opts.replyQuoteText).slice(0, 240);
  }
  // Sealed-sender (Signal-mode): when the user has the privacy toggle on,
  // we ask the server NOT to log/return who-sent-what to peers. Sender's
  // own clients still see their messages normally; recipients get the
  // bubble without sender_email/sender_name. Ambient global flag set by
  // ProfileSettingsSheet → AsyncStorage, read by chat-conversation when
  // dispatching the send (passed as opts.sealed) — kept opt-in to avoid
  // breaking spam control unless the user explicitly wants it.
  if (opts?.sealed) payload.sealed = true;
  // 2026-05-18: structured meta blob (short_video / video_note subtypes).
  // Server whitelists keys server-side — see chat.php meta parse block.
  // We JSON-stringify because PHP's input parser accepts both raw arrays
  // (when content-type is JSON) and strings (when posted as form). String
  // form is safest across both Rust and PHP paths.
  if (opts?.meta && typeof opts.meta === 'object') {
    try { payload.meta = JSON.stringify(opts.meta); } catch { /* skip on circular */ }
  }
  // Try Rust — inserts in PG, broadcasts to WS hub, returns ~5ms vs 30-50ms PHP.
  // topic_id still goes through PHP (threaded replies not yet in Rust).
  //
  // `opts.skipRust` — offline replay sets this because the Rust path has
  // a UNIQUE on temp_id in PG with no catch, so a retry with a stable
  // temp_id 500s. PHP dedups on (sender_email, client_message_id) and
  // returns the existing row cleanly, so retries go straight there.
  // Skip Rust when an effect is set — the Rust signal-server insert path
  // doesn't know about the `effect` column and silently drops it. Force
  // the PHP path so the persisted row carries the effect for replay.
  // ── 2. Send to server ──
  //
  // Stage 7 (2026-05-18) — E2E default-ON, WhatsApp-style. The
  // chat_envelope_send path encrypts the body per-recipient-device with
  // nacl.box and uploads only the ciphertexts. The plaintext chat_send /
  // Rust path is *fully skipped* so the server never sees the body — no
  // chat_messages row gets created. The optimistic SQLite row is the only
  // plaintext copy until the receiver pulls + acks.
  //
  // Users can still opt out via setEnvelopeMode(false), which persists a
  // '0' marker and downgrades subsequent sends to the plaintext branch.
  let result = null;
  const envelopeMode = (typeof globalThis !== 'undefined') && globalThis.__chatyy_envelope_mode === true;
  if (envelopeMode) {
    try {
      // Lazy import — avoid loading nacl + envelope code in apps that have
      // the flag off (most of them, during rollout). Pulls both legacy and
      // sender-keys builders so the second-level flag below can pick one.
      const [envMod, deviceListResp] = await Promise.all([
        import('./envelope.js'),
        getRecipientDeviceKeys(conversationId),
      ]);
      const { buildEnvelopes, buildSenderKeysEnvelope, isSenderKeysEnabled } = envMod;
      const targets = deviceListResp || [];
      // Second-level flag: `globalThis.__chatyy_envelope_sender_keys === true`
      // switches from N full-message encryptions to (1 body secretbox + N
      // 32-byte key wraps). Default OFF; the helper centralises the global
      // read so we don't open-code it.
      let envelopePayload;
      if (typeof isSenderKeysEnabled === 'function' && isSenderKeysEnabled()) {
        const senderEnv = buildSenderKeysEnvelope(
          content || '',
          conversationId,
          stableCMI,
          targets,
        );
        envelopePayload = {
          conversation_id: conversationId,
          client_message_id: stableCMI,
          body: senderEnv.body,
          keys: senderEnv.keys,
        };
      } else {
        const envelopes = buildEnvelopes(content || '', conversationId, targets);
        envelopePayload = {
          conversation_id: conversationId,
          client_message_id: stableCMI,
          envelopes,
        };
      }
      const envResp = await chatEnvelopeSend(envelopePayload);
      if (envResp && (envResp.success || envResp.data)) {
        // [#1177 2026-05-18] Envelope mode has no server message_id (there
        // is no chat_messages row in this mode — only chat_pending_envelopes
        // shards). BUT every downstream consumer in this codebase checks
        // `r.data?.id` to decide if the send succeeded:
        //   - chat-conversation.js:11147 (text), :11385 (gif), :11443 (sticker), :12619 (loc), :13025 (contact), :18840 (retry)
        //   - services/offlineCache.js:612 — throws 'chat_send_failed' when missing
        //   - services/outboxDrainer.js:108 — soft-fails and bumps backoff
        // Before this fix, every envelope-mode send returned { success: true,
        // envelope_mode: true } with NO data.id. Each consumer treated it
        // as failure → optimistic bubble stuck at _queued: true → user sees
        // "Enviando..." for a "tempão" → offline replay fires again →
        // server dedups (idempotent) → still no data.id → loop. After ~5
        // attempts the bubble flips to red ❗ even though the envelope rows
        // were persisted in PG on the very first call. That's the
        // "mensagens só fica enviando" user report.
        // Fix: synthesize a `data` object with a stable string id using the
        // CMI. Downstream code's setMessages(m => m.id === tempId ? {...r.data, _pending:false} : m)
        // happily swaps the temp bubble for one keyed by CMI, the bubble
        // loses the spinner, and the queued retry is removed. The recipient's
        // envelopePuller delivers + acks independently; the sender's
        // delivered/read marker still arrives via chat_message_receipts.
        // Synthetic id uses the CMI as-is (no prefix) so that when a paired
        // device pulls the same envelope via envelopePuller and runs
        // saveMessage({ id: env.client_message_id, client_temp_id: env.client_message_id }),
        // the two rows collapse cleanly on client_temp_id rather than
        // duplicating with a separate "env_" prefix.
        const syntheticId = stableCMI;
        result = {
          success: true,
          envelope_mode: true,
          inserted: envResp?.data?.inserted ?? 0,
          client_message_id: stableCMI,
          // Downstream contract: r.data.id must exist for the UI to flip
          // the optimistic bubble out of _pending state.
          data: {
            id: syntheticId,
            envelope_id: syntheticId,
            conversation_id: conversationId,
            content,
            type: type || 'text',
            file_url: fileUrl || null,
            reply_to_id: replyToId || null,
            client_message_id: stableCMI,
            client_temp_id: localTempId,
            // [#1188 fix 2026-05-19] CRITICAL: sender_email MUST be the
            // authenticated user, NOT null. Downstream code spreads r.data
            // onto the optimistic message row (chat-conversation.js:11369
            // and ~6 other sites: `{ ...r.data, _pending: false }`). If
            // sender_email is null here, that spread overwrites the
            // optimistic row's correct sender_email → MessageRow's
            // `isOwn = msg.sender_email === currentEmail` evaluates false
            // → the user's OWN bubble flips from outgoing (right) to
            // incoming (left) ~200ms after send. Worse: in envelope mode
            // the keptEnvelope reducer (chat-conversation.js:8725) keeps
            // this row alive across loadMessages refreshes, so the flip
            // is sticky until the user force-quits and re-opens (cold
            // start re-fetches from server which DOES have sender_email).
            sender_email: _tokenMeta.email || null,
            created_at: new Date().toISOString(),
            _envelope_mode: true,
            inserted: envResp?.data?.inserted ?? 0,
          },
          // Also surface message_id at top level so paths checking either
          // shape (`r.message_id || r.data?.message_id`) see envelope mode
          // as a real send.
          message_id: syntheticId,
        };
      } else {
        // Server rejected — surface as failure but DO NOT fall back to
        // plaintext chat_send (that would defeat envelope mode's privacy
        // guarantee).
        await _localMarkFailed(localTempId, envResp?.message || 'envelope_send_failed');
        return envResp;
      }

      // [#1188 Agent B+H 2026-05-19] Plaintext fallback when envelope mode
      // sent to recipients with ZERO published device keys. envResp returns
      // {success:true, inserted:0} when no peer has chat_device_keys row.
      // Without this fallback, sender's bubble shows ✓ but recipient gets
      // NOTHING (silent black hole). Privacy degradation < message loss.
      // After Patch A (publish key on every auth) lands, this fallback
      // becomes rare-fire — but it covers the legacy users still missing
      // keys in the chat_device_keys table.
      const _insertedCount = Number(result?.inserted ?? result?.data?.inserted ?? 0);
      if (result?.success && _insertedCount === 0) {
        console.warn('[chatSend] envelope mode inserted=0 (no peer device keys) — falling back to plaintext');
        result = null; // force the plaintext branch below to fire
      }
    } catch (e) {
      // Network / crypto error in envelope mode — mark failed, surface.
      // No fallback to plaintext: in envelope mode the sender chose
      // ciphertext-only and we honor that contract.
      await _localMarkFailed(localTempId, e);
      throw e;
    }
  } else {
    try {
      // opts.meta also forces PHP — the Rust signal-server INSERT path
      // doesn't know about the meta JSONB column yet and would silently
      // drop the structured payload (same problem as effect / sealed).
      if (!topicId && !opts?.skipRust && !opts?.effect && !opts?.sealed && !opts?.meta) {
        const rust = await _rustChatPost('send', payload);
        if (rust?.success) { result = rust; }
      }
      if (!result) {
        result = await apiCall('chat_send', payload, 'POST');
      }
    } catch (e) {
      // Network error / abort. Mark the optimistic row failed so the outbox
      // drainer can pick it up. Re-throw so the caller's catch keeps running.
      await _localMarkFailed(localTempId, e);
      throw e;
    }
  }

  // ── 3. Finalize SQLite — swap temp id → server id, flip pending_state ──
  if (result && (result.success || result.message_id || result.data?.message_id)) {
    if (result.envelope_mode) {
      // Stage 5 envelope mode — there is no server message_id, but the
      // ciphertext was accepted. Flip the optimistic row to 'sent' so
      // the bubble loses the spinner. Receiver acks will drive the
      // double-check delivered indicator via chat_message_receipts.
      try { await _localUpdateMessage(localTempId, { pending_state: 'sent' }); } catch {}
    } else {
      const serverRow = result.message || result.data?.message || (
        (result.message_id || result.data?.message_id) ? {
          id: result.message_id || result.data?.message_id,
          conversation_id: conversationId,
          content,
          type: type || 'text',
          file_url: fileUrl || null,
          reply_to_id: replyToId || null,
          client_message_id: stableCMI,
          created_at: result.created_at || new Date().toISOString(),
        } : null
      );
      if (serverRow) await _localFinalizeSend(localTempId, serverRow);
    }
  } else if (result && result.success === false) {
    await _localMarkFailed(localTempId, result.message);
  }
  return result;
}

// Telegram-style features
export async function chatSaveMessage(messageId) {
  return apiCall('chat_save_message', { message_id: messageId }, 'POST');
}
export async function chatFoldersList() {
  return apiCall('chat_folders_list');
}
export async function chatFoldersCreate(name, icon, filterType, filterValue) {
  return apiCall('chat_folders_create', { name, icon, filter_type: filterType, filter_value: filterValue }, 'POST');
}
export async function chatFoldersUpdate(id, data) {
  return apiCall('chat_folders_update', { id, ...data }, 'POST');
}
export async function chatFoldersDelete(id) {
  return apiCall('chat_folders_delete', { id }, 'POST');
}
export async function chatTranslateMessage(messageId, targetLang = 'pt') {
  return apiCall('chat_translate_message', { message_id: messageId, target_lang: targetLang }, 'POST');
}
export async function chatSetSlowMode(conversationId, seconds) {
  return apiCall('chat_set_slow_mode', { conversation_id: conversationId, seconds }, 'POST');
}

// Real all-time conversation statistics, aggregated server-side over the
// full chat_messages history (not the client's loaded window). Returns
// totals, per-participant share, media-type breakdown, busiest day/hour,
// a 14-day daily series, average reply gap, and the first message.
export async function chatConversationStats(conversationId) {
  return apiCall('chat_conversation_stats', { conversation_id: conversationId }, 'POST');
}

// Ask the server for a fresh URL for a chat-media message whose local cache
// was evicted and whose original file_url returned 404. R2 retention is
// indefinite, so this should almost always resolve to a valid URL (CDN >
// local origin > presigned S3 GET). 410 = message was hard-deleted (user
// "Delete for everyone"); 404 = no media on that message id (text-only row).
export async function chatRedownloadMedia(messageId) {
  return apiCall('chat_redownload_media', { message_id: messageId }, 'POST');
}

// Group Topics
// Two call shapes (back-compat):
//   1) chatTopicCreate(convId, name, icon)                        — legacy positional
//   2) chatTopicCreate(convId, { name, color, emoji|icon })       — new object form
// TODO: backend `chat_topic_create` doesn't parse `color` yet — included optimistically
// so the UI can persist the picked color without a separate round-trip later.
export async function chatTopicCreate(conversationId, nameOrOpts, iconArg = '💬') {
  if (nameOrOpts && typeof nameOrOpts === 'object') {
    const { name, color, emoji, icon } = nameOrOpts;
    return apiCall('chat_topic_create', {
      conversation_id: conversationId,
      name,
      icon: emoji || icon || '💬',
      color: color || null,
    }, 'POST');
  }
  return apiCall('chat_topic_create', { conversation_id: conversationId, name: nameOrOpts, icon: iconArg }, 'POST');
}
export async function chatTopicList(conversationId) {
  return apiCall('chat_topic_list', { conversation_id: conversationId });
}
export async function chatTopicDelete(topicId) {
  return apiCall('chat_topic_delete', { topic_id: topicId }, 'POST');
}
export async function chatTopicPin(topicId) {
  return apiCall('chat_topic_pin', { topic_id: topicId }, 'POST');
}
// Voice transcription
export async function chatTranscribeAudio(messageId) {
  return apiCall('chat_transcribe_audio', { message_id: messageId }, 'POST');
}

// Voice pre-upload session (Telegram-style) — start a session as soon as the
// user begins recording, stream chunks to the server while still recording,
// then finalize on stop. By the time the user releases, most bytes are
// already on disk.
export async function chatVoiceSessionStart(conversationId) {
  return apiCall('chat_voice_session_start', { conversation_id: conversationId }, 'POST');
}

// Append a chunk. `chunk` must be a Blob (web) — chunk_index is 0-based and
// strictly monotonic. We deliberately use a fresh fetch+FormData here rather
// than apiCall so we can pass binary without forcing JSON serialization.
export async function chatVoiceSessionChunk(sessionId, chunkIndex, chunkBlob) {
  const fd = new FormData();
  fd.append('action', 'chat_voice_session_chunk');
  fd.append('session_id', sessionId);
  fd.append('chunk_index', String(chunkIndex));
  fd.append('chunk', chunkBlob, 'chunk.bin');
  const headers = getAuthHeaders();
  // Don't let FormData carry a fake Content-Type; the browser sets the
  // correct multipart boundary.
  delete headers['Content-Type'];
  const url = `${getApiUrl()}?action=chat_voice_session_chunk`;
  const resp = await fetch(url, { method: 'POST', body: fd, credentials: 'include', headers });
  try { return await resp.json(); } catch { return { success: false, message: 'parse_failed' }; }
}

export async function chatVoiceSessionFinalize(sessionId, { duration = 0, mime = 'audio/webm', waveform = null } = {}) {
  return apiCall('chat_voice_session_finalize', {
    session_id: sessionId,
    duration: Math.max(0, Math.round(duration || 0)),
    mime,
    waveform,
  }, 'POST');
}

// WhatsApp-style "played" receipt for voice notes. Fires once per voice
// message the FIRST time playback reaches didJustFinish on the recipient
// device. Server (chat_voice_played action) sets `played_at` on the row
// and broadcasts a WS receipt so the sender's bubble flips its blue check
// to the music-note glyph. Idempotent server-side — duplicate calls are
// dropped silently. Batched at 250ms to coalesce queue-auto-play bursts.
const _voicePlayedQueue = new Map(); // conversationId → Set<messageId>
const _voicePlayedTimers = new Map();
export async function chatVoicePlayed(messageId, conversationId) {
  if (messageId == null) return { success: false, message: 'missing_id' };
  const convKey = conversationId || '_';
  let q = _voicePlayedQueue.get(convKey);
  if (!q) { q = new Set(); _voicePlayedQueue.set(convKey, q); }
  q.add(messageId);
  if (_voicePlayedTimers.has(convKey)) return { success: true, queued: true };
  return new Promise((resolve) => {
    const h = setTimeout(async () => {
      _voicePlayedTimers.delete(convKey);
      const ids = Array.from(_voicePlayedQueue.get(convKey) || []);
      _voicePlayedQueue.delete(convKey);
      if (ids.length === 0) { resolve({ success: true, ids: [] }); return; }
      try {
        // Single id (most common case) → singular payload. Batched
        // payload (message_ids array) works too on the server, so we
        // forward whatever we have.
        const payload = ids.length === 1
          ? { message_id: ids[0], conversation_id: conversationId }
          : { message_ids: ids, conversation_id: conversationId };
        const r = await apiCall('chat_voice_played', payload, 'POST');
        resolve(r);
      } catch (e) { resolve({ success: false, message: e?.message || 'failed' }); }
    }, 250);
    _voicePlayedTimers.set(convKey, h);
  });
}
// Forward protection
export async function chatSetForwardProtection(conversationId, enabled) {
  return apiCall('chat_set_forward_protection', { conversation_id: conversationId, enabled }, 'POST');
}

export async function callNotify(conversationId, callId, video) {
  return apiCall('call_notify', { conversation_id: conversationId, room_id: callId, call_id: callId, video }, 'POST');
}

// Update the call_card bubble + chat_call_history row when a call ends.
// Backend (chat.php call_status) flips the in-thread call_card to completed/
// missed/declined and writes the final duration. The client only needs to
// fire this once on hangup — the WS broadcast pushes the updated bubble to
// every member so everybody sees "Call · 3m 12s" even if the call screen
// was on a different device.
//   status   — 'completed' | 'missed' | 'declined' | 'cancelled'
//   duration — seconds (0 for missed/declined/cancelled)
export async function callStatus(callId, status, duration = 0) {
  return apiCall('call_status', {
    call_id: callId,
    status,
    duration: Math.max(0, Math.round(duration || 0)),
  }, 'POST');
}

// Post-call quality rating (1-5 stars) shipped from the end-of-call screen.
// Backend stores anonymized rating + ttfc/duration/quality flags for QoS
// analytics. Optional `meta` carries TTFC (ms), final connection_quality
// label, and whether the user experienced a reconnect during the call.
// Fire-and-forget on the client — UI doesn't block on the response.
//   rating   — integer 1..5 (lower is worse)
//   meta     — { ttfc_ms?, duration_sec?, quality?, reconnects?, was_video? }
export async function callRate(callId, rating, meta = {}) {
  const r = Math.max(1, Math.min(5, Math.round(Number(rating) || 0)));
  return apiCall('call_rate', {
    call_id: callId,
    rating: r,
    ttfc_ms: Number(meta.ttfc_ms) || 0,
    duration_sec: Math.max(0, Math.round(Number(meta.duration_sec) || 0)),
    quality: typeof meta.quality === 'string' ? meta.quality : '',
    reconnects: Math.max(0, Math.round(Number(meta.reconnects) || 0)),
    was_video: !!meta.was_video,
  }, 'POST');
}

// ─── Voicemail ────────────────────────────────────────────────────────
// Caller leaves a voice message after a missed/declined call. Audio is
// uploaded directly to R2 (Google-Photos-style) — backend issues a
// presigned PUT, client PUTs the blob, then voicemail_send commits the
// row + posts a `kind:voicemail` chat message in the conversation.
//
// 60s max duration is enforced both client-side (UI cap) and server-side
// (so a tampered client can't bypass).
export async function voicemailInitUpload(conversationId, mimeType = 'audio/m4a') {
  return apiCall('voicemail_init_upload', {
    conversation_id: conversationId,
    mime_type: mimeType,
  }, 'POST');
}

export async function voicemailSend(toEmail, audioR2Key, durationSec, conversationId = null) {
  return apiCall('voicemail_send', {
    to_email: toEmail,
    audio_r2_key: audioR2Key,
    duration_sec: Math.max(1, Math.min(60, Math.round(durationSec || 0))),
    conversation_id: conversationId || 0,
  }, 'POST');
}

export async function voicemailGet(voicemailId) {
  return apiCall('voicemail_get', { voicemail_id: voicemailId }, 'POST');
}

export async function voicemailMarkListened(voicemailId) {
  return apiCall('voicemail_mark_listened', { voicemail_id: voicemailId }, 'POST');
}

// Manually trigger transcription. Normally voicemail_send fires it
// inline so the recipient sees a transcript on first open — this is the
// fallback when the inline call timed out (slow whisper response).
export async function voicemailTranscribe(voicemailId) {
  return apiCall('voicemail_transcribe', { voicemail_id: voicemailId }, 'POST');
}

export async function chatUpdateLiveLocation(messageId, latitude, longitude, address, opts) {
  // opts.unlimited / opts.duration_seconds let the snap-map "sempre ativo"
  // share keep the right sentinel on every tick. Older callers (no opts)
  // still get the legacy 1h-default behavior on the backend.
  // [WAVE 62 2026-05-21] opts.conversation_id is a belt-and-suspenders
  // fallback when message_id resolution might fail (legacy deleted parent,
  // schema drift). Backend prefers conversation_id when both are sent.
  const payload = { message_id: messageId, latitude, longitude };
  // Only include address when it's a real string — earlier callers passed
  // `{ address }` (an object) by mistake, which serialized to noise.
  if (typeof address === 'string' && address) payload.address = address;
  if (opts && opts.unlimited) {
    payload.unlimited = true;
    payload.duration_seconds = -1;
  } else if (opts && typeof opts.duration_seconds === 'number') {
    payload.duration_seconds = opts.duration_seconds;
  }
  if (opts && opts.conversation_id) payload.conversation_id = opts.conversation_id;
  return apiCall('chat_update_live_location', payload, 'POST');
}

export async function chatStopLiveLocation(messageId, opts) {
  // [WAVE 49 2026-05-21] `force=true` opts in to the destructive backend
  // path (delete chat_live_locations row + global share + auto_chat grants).
  // Without it the backend soft-no-ops and the share continues until its
  // natural expires_at TTL elapses.
  //
  // Callers that REALLY want to stop (explicit "Parar" tap, auto-expiry
  // setTimeout firing, bubble Stop action) must pass `{ force: true }`.
  // Lifecycle cleanups like screen-unmount should call WITHOUT force so
  // they don't accidentally kill an active session.
  const payload = { message_id: messageId };
  if (opts && opts.force) payload.force = true;
  return apiCall('chat_stop_live_location', payload, 'POST');
}

// Idempotency token used by chat_edit/chat_delete/chat_react so the server
// can drop a duplicate retry (network blip, app backgrounded mid-request).
// Telegram-style: every state-mutating action carries a client-generated id
// the server stores transiently; a second call with the same id is a no-op.
function _chatActionId() {
  return 'a_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Best-effort read of the current local content/edited_at for a message so
// chatEdit can do a FULL revert (content + edited_at) on server rejection.
// No single-message getter is guaranteed across db modules, so we probe a
// couple of conventional names and the conversation-scoped getMessages as a
// fallback. Returns null when nothing is recoverable — caller then degrades
// gracefully to the legacy edited_at-only revert.
async function _readLocalMessageSnapshot(messageId, conversationId) {
  if (!messageId) return null;
  const ld = _ld();
  try {
    if (ld && typeof ld.getMessageById === 'function') {
      const m = await ld.getMessageById(messageId);
      if (m) return { content: m.content, edited_at: m.edited_at ?? null };
    }
  } catch {}
  try {
    const _db = require('./db');
    if (_db && typeof _db.dbGetMessageById === 'function') {
      const m = await _db.dbGetMessageById(messageId);
      if (m) return { content: m.content, edited_at: m.edited_at ?? null };
    }
  } catch {}
  // Fallback: scan the conversation's recent messages if we know the conv id.
  try {
    if (conversationId && ld && typeof ld.getMessages === 'function') {
      const rows = await ld.getMessages(conversationId, 200, null);
      const m = Array.isArray(rows) ? rows.find(r => String(r.id) === String(messageId)) : null;
      if (m) return { content: m.content, edited_at: m.edited_at ?? null };
    }
  } catch {}
  return null;
}

export async function chatEdit(messageId, content, conversationId = null) {
  // Stage 1: write the edit to local SQLite FIRST, then POST. The optimistic
  // row update is what the UI rebinds to on reload — server confirmation
  // arrives later via WS message_edited.
  // [P1 2026-05-26] Capture the prior content+edited_at BEFORE the optimistic
  // write so a hard server rejection can fully revert. The old code reverted
  // only edited_at; the edited content stayed in SQLite, so on the next sync
  // the user's typed-then-rejected text visibly persisted/replaced the
  // original. Snapshot is best-effort — if unavailable we degrade to the
  // legacy edited_at-only revert (no regression).
  const prior = await _readLocalMessageSnapshot(messageId, conversationId);
  const editedAt = new Date().toISOString();
  await _localUpdateMessage(messageId, { content, edited_at: editedAt });
  const _revert = async () => {
    if (prior && typeof prior.content === 'string') {
      // Full revert: restore both the original content and the original
      // edited_at (which may itself be a real prior-edit timestamp, so we
      // restore the captured value rather than blindly nulling it).
      await _localUpdateMessage(messageId, { content: prior.content, edited_at: prior.edited_at ?? null });
    } else {
      // Snapshot unavailable — fall back to legacy behavior.
      await _localUpdateMessage(messageId, { edited_at: null });
    }
  };
  try {
    const r = await apiCall('chat_edit', { message_id: messageId, content, client_action_id: _chatActionId() }, 'POST');
    if (r && r.success === false) {
      await _revert();
    }
    return r;
  } catch (e) {
    await _revert();
    throw e;
  }
}

export async function chatDelete(messageId, mode = 'for_all') {
  // Soft-delete local row first (sets deleted_at). Survives a failed POST —
  // we deliberately do NOT revert on server error because the user's intent
  // was clear; the outbox drainer will retry the network side.
  const deletedAt = new Date().toISOString();
  await _localUpdateMessage(messageId, { deleted_at: deletedAt });
  return apiCall('chat_delete_message', { message_id: messageId, mode, client_action_id: _chatActionId() }, 'POST');
}

export async function chatDeleteBulk(messageIds, mode = 'for_me') {
  const deletedAt = new Date().toISOString();
  if (Array.isArray(messageIds)) {
    for (const id of messageIds) await _localUpdateMessage(id, { deleted_at: deletedAt });
  }
  return apiCall('chat_delete_message', { message_ids: messageIds, mode, client_action_id: _chatActionId() }, 'POST');
}

// Small helper: call a Rust chat endpoint, fall back to PHP on any issue.
async function _rustChatPost(path, payload) {
  if (!(await _probeRustChat())) return null;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const ctrl = new AbortController();
    // 5s was too long on weak cellular — every send burned 5s waiting for
    // Rust to time out before PHP fallback kicked in. 2s is enough to know
    // if Rust is alive on a healthy network; on flaky links we fall through
    // to PHP fast instead of stalling the user.
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`${BASE_URL}/api/rust/chat/${path}`, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal,
    });
    clearTimeout(t);
    if (r.ok) return await r.json();
    if (r.status >= 500) _rustChatAvailable = false;
  } catch {
    _rustChatAvailable = false;
  }
  return null;
}

export async function chatReact(messageId, emoji, stickerUrl) {
  if (!messageId) return { success: false, message: 'invalid_message' };
  const actionId = _chatActionId();

  // Stage 1: reactions live on the `chat_message_reactions` PG table, not on
  // the message row itself. Local SQLite doesn't have a reactions table yet
  // (Stage 1 scope is messages only). We queue the action through the
  // offline_queue so a retry replays it; the actual reaction payload still
  // round-trips through the server before any UI update. WS broadcast will
  // refresh the bubble.
  const ld = _ld();
  if (ld && typeof ld.queueOfflineAction === 'function') {
    try {
      await ld.queueOfflineAction('chat_react', {
        message_id: messageId,
        emoji: emoji || null,
        sticker_url: stickerUrl || null,
        client_action_id: actionId,
      });
    } catch {}
  }

  // Sticker reaction (premium): URL up to 512 chars. Server gates by plan.
  if (typeof stickerUrl === 'string' && stickerUrl.length > 0) {
    if (stickerUrl.length > 512) return { success: false, message: 'sticker_url_too_long' };
    return _normalizeReactResult(await apiCall('chat_react', { message_id: messageId, sticker_url: stickerUrl, client_action_id: actionId }, 'POST'));
  }

  // Emoji reaction. Reject silly payloads — sanity guard before hitting network.
  if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 20) {
    return { success: false, message: 'invalid_emoji' };
  }
  const rust = await _rustChatPost('react', { message_id: messageId, emoji, client_action_id: actionId });
  if (rust) return _normalizeReactResult(rust);
  return _normalizeReactResult(await apiCall('chat_react', { message_id: messageId, emoji, client_action_id: actionId }, 'POST'));
}

// [P2 2026-05-26] Treat a server "reaction already exists" / idempotent
// replay as a SUCCESS no-op. The backend chat_react is a toggle with an
// idempotency guard (returns success + idempotent_replay) and swallows a
// duplicate INSERT, but an offline-queue retry or a Rust/PHP edge can surface
// a `success:false` payload whose message signals the reaction was already
// applied. Returning that as an error makes the UI flip the optimistic chip
// OFF — the reaction visibly disappears even though it landed. Coerce those
// shapes to success so the chip stays on (idempotent add).
function _normalizeReactResult(res) {
  if (!res || typeof res !== 'object') return res;
  // apiCall wraps as { data, status }; the rust path returns the body directly.
  const body = (res.data && typeof res.data === 'object') ? res.data : res;
  const isFailure = body && body.success === false;
  if (!isFailure) return res;
  const msg = String(body.message || body.error || body.code || '').toLowerCase();
  const alreadyApplied =
    msg.includes('already') ||
    msg.includes('duplicate') ||
    msg.includes('exists') ||
    msg.includes('idempotent') ||
    msg.includes('replay');
  if (alreadyApplied) {
    body.success = true;
    if (!body.message) body.message = 'idempotent';
  }
  return res;
}

export async function chatRead(conversationId, messageId) {
  // Stage 1: stamp read_at on the local row BEFORE the POST so reload after
  // a network blip still shows the correct read state. Stamp covers the
  // single message that was acked; conversation-wide unread counts get
  // refreshed from server on next sync.
  if (messageId) {
    await _localUpdateMessage(messageId, { read_at: new Date().toISOString() });
  }
  // [P0 2026-05-26] Persist the conversation-level read watermark too.
  // Stamping read_at on the single message alone is NOT enough: on cold
  // start the unread count is recomputed from conversation.last_read_message_id,
  // not from per-message read_at. Without persisting the watermark the unread
  // badge re-inflates after an app restart. Call db.js defensively — the
  // function is being added there concurrently; optional-chain + try/catch
  // means we no-op cleanly if it isn't present yet.
  if (conversationId && messageId) {
    try {
      const _db = require('./db');
      await _db?.dbUpdateConversationLastReadMessageId?.(conversationId, messageId);
    } catch {}
  }
  const rust = await _rustChatPost('mark_read', { conversation_id: conversationId, message_id: messageId });
  // Bump the app-icon badge down right after the read POST lands. Without
  // this, the badge keeps the stale unread count until the next foreground
  // sync — visible on iOS/Android lockscreens.
  try { require('./pushNotifications').refreshBadgeCount?.(); } catch {}
  if (rust) return rust;
  return apiCall('chat_mark_read', { conversation_id: conversationId, message_id: messageId }, 'POST');
}

// Send delivery acknowledgment for messages (WhatsApp-style double check).
// Direct path — exposed in case caller needs to flush immediately. Most
// callers should use chatDeliveryAckBatched below which coalesces multiple
// per-message acks into a single POST per 250ms window.
export async function chatDeliveryAck(conversationId, messageIds) {
  return apiCall('chat_delivery_ack', { conversation_id: conversationId, message_ids: messageIds }, 'POST');
}

// Coalesced delivery-ack batcher. In an active group, 20 messages can land
// in a 1s burst — each used to fire its own POST, hammering the server and
// burning radio battery. Now we collect ids per conversation, wait 250ms
// for the burst to settle, then send ONE POST. Caller fire-and-forget;
// dedup is handled internally so calling N times for the same id is cheap.
const _ackQueues = new Map(); // conversationId → Set<messageId>
const _ackTimers = new Map(); // conversationId → timeoutHandle
export function chatDeliveryAckBatched(conversationId, messageIds) {
  if (!conversationId || !messageIds?.length) return;
  let q = _ackQueues.get(conversationId);
  if (!q) { q = new Set(); _ackQueues.set(conversationId, q); }
  for (const id of messageIds) if (id != null) q.add(id);
  if (_ackTimers.has(conversationId)) return; // already scheduled
  const handle = setTimeout(() => {
    _ackTimers.delete(conversationId);
    const ids = Array.from(_ackQueues.get(conversationId) || []);
    _ackQueues.delete(conversationId);
    if (ids.length === 0) return;
    chatDeliveryAck(conversationId, ids).catch(() => {});
  }, 250);
  _ackTimers.set(conversationId, handle);
}
// Force-flush all pending acks (call on AppState background so server is
// up-to-date when phone goes to sleep, otherwise the 250ms window can eat
// the batch).
export function chatDeliveryAckFlush() {
  for (const [convId, handle] of _ackTimers.entries()) {
    clearTimeout(handle);
    const ids = Array.from(_ackQueues.get(convId) || []);
    _ackQueues.delete(convId);
    if (ids.length > 0) chatDeliveryAck(convId, ids).catch(() => {});
  }
  _ackTimers.clear();
}

// Send read acknowledgment for a conversation (WhatsApp-style blue double check)
export async function chatReadAck(conversationId) {
  // Stage 1: zero out unread_count locally first. Server WS event
  // conversation_updated will overwrite this if the server count differs;
  // but the optimistic write means a reload right after marking as read
  // doesn't show a stale unread badge. We can't use saveConversations()
  // here because INSERT OR REPLACE would null out name/avatar/members —
  // queue the action through the offline_queue so the next replay picks
  // up the explicit "I read this conv" intent.
  const ld = _ld();
  if (ld && typeof ld.queueOfflineAction === 'function' && conversationId) {
    try { await ld.queueOfflineAction('chat_read', { conversation_id: conversationId }); } catch {}
  }
  const res = await apiCall('chat_read', { conversation_id: conversationId }, 'POST');
  // Mirror the chat-list "read" intent into the app-icon badge so the
  // counter drops immediately after the conversation is acked.
  try { require('./pushNotifications').refreshBadgeCount?.(); } catch {}
  return res;
}

export async function chatMarkUnread(conversationId) {
  return apiCall('chat_mark_unread', { conversation_id: conversationId }, 'POST');
}

// chat_mark_message_unread — per-message variant: rolls the user's
// last_read_message_id back to (message_id - 1) so the thread reappears with
// unread dots starting at the chosen message. Mirrors WhatsApp's per-bubble
// "Mark as unread" long-press action.
export async function chatMarkMessageUnread(conversationId, messageId) {
  return apiCall('chat_mark_message_unread', { conversation_id: conversationId, message_id: messageId }, 'POST');
}

export async function chatMessageInfo(messageId) {
  return apiCall('chat_message_info', { message_id: messageId });
}

export async function chatMembers(conversationId) {
  return apiCall('chat_info', { conversation_id: conversationId });
}

export async function chatAddMember(conversationId, email) {
  return apiCall('chat_add_member', { conversation_id: conversationId, email }, 'POST');
}

export async function chatLeave(conversationId) {
  return apiCall('chat_leave', { conversation_id: conversationId }, 'POST');
}

export async function chatDeleteConversation(conversationId) {
  return apiCall('chat_delete', { conversation_id: conversationId }, 'POST');
}

export async function chatUpdate(conversationId, updates) {
  return apiCall('chat_update', { conversation_id: conversationId, ...updates }, 'POST');
}

export async function chatSearch(query) {
  return apiCall('chat_search', { query });
}

// Sync phonebook: upload SHA-256 hashes of E.164 phones, get matches.
// Hash happens on the client — we never send plaintext numbers.
export async function chatSyncContacts(hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0) return { success: true, data: { matches: [] } };
  return apiCall('chat_sync_contacts', { hashes }, 'POST');
}

// Idempotent: tells the server "my phone is X" so I become discoverable.
// Client hashes the E.164 number and sends the hex digest.
export async function chatRegisterPhone(phoneHash) {
  return apiCall('chat_register_phone', { phone_hash: phoneHash }, 'POST');
}

// Pessoas que você pode conhecer. Pass phone_hashes as a hint so the server
// can weigh phonebook matches (they score higher than follow-graph overlap).
export async function chatFriendSuggestions({ phoneHashes = [], limit = 20 } = {}) {
  return apiCall('chat_friend_suggestions', { phone_hashes: phoneHashes, limit }, 'POST');
}

export async function chatArchive(conversationId, archive = true) {
  return apiCall('chat_archive', { conversation_id: conversationId, archive: archive ? 1 : 0 }, 'POST');
}

export async function chatMute(conversationId, muteUntil = null) {
  return apiCall('chat_mute', { conversation_id: conversationId, mute_until: muteUntil }, 'POST');
}

export async function chatPin(conversationId, messageId) {
  // chat_pin is a TOGGLE on the server (flips chat_messages.pinned_at). Same
  // hazard as chatPinMessage: pre-queuing an offline replay AND POSTing online
  // makes the offline_queue drain re-fire the toggle → unpins it after an app
  // restart. POST first; only queue on failure so the toggle applies once.
  const ld = _ld();
  const payload = { conversation_id: conversationId, message_id: messageId };
  let r;
  try {
    r = await apiCall('chat_pin', payload, 'POST');
  } catch (e) {
    r = { success: false, error: e?.message || 'pin_failed' };
  }
  if (!r?.success && ld && typeof ld.queueOfflineAction === 'function') {
    try { await ld.queueOfflineAction('chat_pin', payload); } catch {}
  }
  return r;
}

// Saved Messages (Telegram-style self-chat). Lazy-creates on first call.
export async function chatSavedConv() {
  return apiCall('chat_saved_conv', {}, 'POST');
}

// Import a WhatsApp-style .txt chat export. Pass peerEmail to merge into
// an existing direct conversation, or leave null to create a fresh group-
// type archive conv.
export async function chatImport(text, { convName = 'Imported chat', peerEmail = null, format = 'whatsapp' } = {}) {
  return apiCall('chat_import', { text, conv_name: convName, peer_email: peerEmail, format }, 'POST');
}

// Chat theme / wallpaper — per-user, per-conversation
export async function chatSetTheme(conversationId, theme) {
  return apiCall('chat_set_theme', { conversation_id: conversationId, theme }, 'POST');
}
export async function chatGetTheme(conversationId) {
  return apiCall('chat_get_theme', { conversation_id: conversationId }, 'POST');
}

// Smart reply — 3 AI-generated reply suggestions for the latest message.
// Server uses Claude Haiku via one-api; heuristic fallback when AI down.
export async function chatSmartReply(conversationId, lastMessage = '') {
  return apiCall('chat_smart_reply', { conversation_id: conversationId, last_message: lastMessage }, 'POST');
}

// chat_ai_suggest_replies — newer Gmail/iMessage-style 3-chip suggestions.
// Backend uses OpenAI gpt-4o-mini directly + caches the result for 60s per
// (conversation_id, last_msg_id) so the chip bar can re-render without
// re-charging the OpenAI bill on typing/presence WS noise.
export async function chatAiSuggestReplies(conversationId) {
  // [2026-05-19] Guard: backend 400s when called without an active bearer
  // (no auth context, can't load conversation). Skip silently — the smart-
  // replies UI is purely cosmetic, no point spamming the network panel on
  // logged-out/cold-boot windows.
  if (!authToken || !conversationId) return { success: false };
  return apiCall('chat_ai_suggest_replies', { conversation_id: conversationId }, 'POST');
}

// chat_ai_summarize — summarize the last N unread messages via gpt-4o-mini.
// since_message_id=0 means "use server-side unread count". Returns:
//   { summary_text, message_count, participants[] }
export async function chatAiSummarize(conversationId, sinceMessageId = 0) {
  return apiCall('chat_ai_summarize', {
    conversation_id: conversationId,
    since_message_id: sinceMessageId,
  }, 'POST');
}

// Jump-to-date: find the first message in the conversation at/after the
// given ISO date, so the client can scrollToItem on that id.
export async function chatMessagesByDate(conversationId, date) {
  return apiCall('chat_messages_by_date', { conversation_id: conversationId, date }, 'POST');
}

// chat_load_around — fetch a window of messages centered on a target id.
// Used when the user taps a pinned banner / reply-jump and the target is
// outside the currently rendered window: backend returns N before + M after
// the anchor so the client can splice them into state and scrollToIndex.
export async function chatLoadAround(conversationId, messageId, before = 30, after = 10) {
  return apiCall('chat_load_around', {
    conversation_id: conversationId,
    message_id: messageId,
    before,
    after,
  }, 'POST');
}

// Mute/unmute a specific member in a group. Minutes=0 means permanent.
export async function chatMuteMember(conversationId, email, minutes = 0) {
  return apiCall('chat_mute_member', { conversation_id: conversationId, email, minutes }, 'POST');
}
export async function chatUnmuteMember(conversationId, email) {
  return apiCall('chat_unmute_member', { conversation_id: conversationId, email }, 'POST');
}

// Per-chat notification sound (sound = 'default' | 'silent' | '<filename>')
export async function chatSetSound(conversationId, sound) {
  return apiCall('chat_set_sound', { conversation_id: conversationId, sound }, 'POST');
}

// Device-synced drafts
export async function chatDraftGet(conversationId) {
  return apiCall('chat_draft_get', { conversation_id: conversationId }, 'POST');
}
export async function chatDraftSet(conversationId, text) {
  return apiCall('chat_draft_set', { conversation_id: conversationId, text }, 'POST');
}

// Saved Messages (Telegram-style chat-with-self)
export async function chatSaved() {
  return apiCall('chat_saved', {}, 'POST');
}

// Export conversation history as ZIP (server-side build, signed download URL).
// Optional { from, to } ISO date strings filter the message range server-side.
export async function chatExportZip(conversationId, opts = {}) {
  const body = { conversation_id: conversationId };
  if (opts && opts.from) body.from = opts.from;
  if (opts && opts.to) body.to = opts.to;
  return apiCall('chat_export_zip', body, 'POST');
}

// Secret chat: create direct conv + auto-enable E2EE via existing e2ee orchestrator
export async function chatCreateSecret(peerEmail) {
  return apiCall('chat_create_secret', { peer_email: peerEmail }, 'POST');
}

// Contact nicknames (per-user override of display name)
export async function chatNicknameSet(email, nickname) {
  return apiCall('chat_nickname_set', { email, nickname }, 'POST');
}
export async function chatNicknameList() {
  return apiCall('chat_nickname_list', {}, 'POST');
}

// Group invite links
export async function chatGroupInviteCreate(conversationId) {
  return apiCall('chat_group_invite_create', { conversation_id: conversationId }, 'POST');
}
export async function chatGroupInviteRevoke(conversationId) {
  return apiCall('chat_group_invite_revoke', { conversation_id: conversationId }, 'POST');
}
export async function chatGroupInviteJoin(token) {
  return apiCall('chat_group_invite_join', { token }, 'POST');
}

export async function chatForward(messageId, targetConversationId, opts = null) {
  const payload = { message_id: messageId, conversation_id: targetConversationId };
  // Hide origin: forwarded message appears as if the sender wrote it.
  // Telegram parity — "Forward without attribution" option.
  if (opts?.hideOrigin) payload.hide_origin = true;
  return apiCall('chat_forward', payload, 'POST');
}

// WhatsApp-style multi-target forward: one server round-trip clones the
// message into N conversations. Backend reports per-target success/fail
// so the UI can surface partial results without re-sending.
export async function chatForwardMulti(messageId, targetConversationIds, opts = null) {
  const payload = {
    message_id: messageId,
    conversation_ids: Array.isArray(targetConversationIds) ? targetConversationIds : [],
  };
  if (opts?.hideOrigin) payload.hide_origin = true;
  return apiCall('chat_forward_multi', payload, 'POST');
}

// Long-press → "Salvar": clone a message verbatim into the user's Saved
// Messages conv (lazy-creates it). Returns { conversation_id, message_id }.
export async function chatCloneToSaved(messageId) {
  return apiCall('chat_clone_to_saved', { message_id: messageId }, 'POST');
}

// AI-classify the importance of an email for the "Importantes" inbox tab.
// Result is cached server-side per message_id so re-classifying is free.
export async function emailClassifyImportance({ message_id, subject, from, snippet }) {
  return apiCall('email_classify_importance', {
    message_id: message_id || '',
    subject: subject || '',
    from: from || '',
    snippet: snippet || '',
  }, 'POST');
}

export async function chatPresence(status = 'online') {
  return apiCall('user_presence', { status }, 'POST');
}

export async function chatAiAssist(conversationId, action, text = '') {
  return apiCall('chat_ai_assist', { conversation_id: conversationId, action, text }, 'POST');
}

export async function chatSetNotifSound(conversationId, sound) {
  return apiCall('chat_set_notif_sound', { conversation_id: conversationId, sound }, 'POST');
}

// Per-conversation notification settings — persisted in chat_user_conv_settings.
// Settings shape: {
//   notify_messages: boolean,
//   sound: 'default' | 'custom' | 'silent',
//   vibration: 'default' | 'short' | 'long' | 'off',
//   preview: boolean,
//   mention_exception: boolean,  // even if muted, still notify on @everyone / @currentEmail
//   mute_until: ISO string | null,
// }
// TODO(backend): chat_user_conv_settings_get/set actions live in chat.php and
// must read/write the chat_user_conv_settings PG table.
export async function chatGetConvSettings(conversationId) {
  return apiCall('chat_user_conv_settings_get', { conversation_id: conversationId }, 'POST');
}

export async function chatSetConvSettings(conversationId, settings = {}) {
  return apiCall('chat_user_conv_settings_set', {
    conversation_id: conversationId,
    ...settings,
  }, 'POST');
}

// Per-conversation custom ringtone picker (gap_notifications #4).
// Stored as filename string in chat_user_conv_settings.ringtone and
// propagated through the push payload as `ringtone`.
export async function chatSetConvRingtone(conversationId, ringtone = 'default') {
  return apiCall('chat_user_conv_ringtone_set', {
    conversation_id: conversationId,
    ringtone,
  }, 'POST');
}

// Global notification preferences (DND schedule, preview privacy,
// lockscreen visibility, respect-system-DND, snooze, mention_only).
// Closes gap_notifications #7 + #10.
export async function chatGetNotifPrefs() {
  return apiCall('chat_user_notif_prefs_get', {}, 'POST');
}
export async function chatSetNotifPrefs(prefs = {}) {
  return apiCall('chat_user_notif_prefs_set', prefs, 'POST');
}

export async function chatTyping(conversationId, recording = false) {
  const params = { conversation_id: conversationId };
  if (recording) params.recording = true;
  // Fire-and-forget — typing is ephemeral, don't block UI on server ack
  const rust = await _rustChatPost('typing', { conversation_id: conversationId, typing: true });
  if (rust) return rust;
  return apiCall('chat_typing', params, 'POST');
}

export async function chatStarMessage(messageId, star = true) {
  // Stage 1: queue the star intent locally first. No local starred table yet
  // (Stage 2 scope); the offline_queue ensures intent survives a crash mid-POST.
  const ld = _ld();
  if (ld && typeof ld.queueOfflineAction === 'function') {
    try { await ld.queueOfflineAction('chat_star_message', { message_id: messageId, star: star ? 1 : 0 }); } catch {}
  }
  return apiCall('chat_star_message', { message_id: messageId, star: star ? 1 : 0 }, 'POST');
}

export async function chatStarredMessages() {
  // Stage 6 — read via WS relay on web when phone paired + online.
  if (Platform.OS === 'web') {
    try {
      const relay = require('./relayClient');
      if (await relay.isAvailable()) {
        try {
          const r = await relay.getStarredViaRelay();
          try { globalThis.__chatyy_phone_offline = false; } catch {}
          return r;
        } catch (e) {
          const code = e?.code || '';
          if (code === 'phone_offline' || code === 'relay_timeout' || code === 'no_paired_device' || code === 'request_timeout') {
            // [#1220 2026-05-20] No banner — REST below serves fresh PG data.
            try { globalThis.__chatyy_phone_offline = false; } catch {}
          }
        }
      }
    } catch {}
  }
  return apiCall('chat_starred_messages', {}, 'POST');
}

// Keep message (disappearing chats - WhatsApp style)
export async function chatKeepMessage(messageId, keep = true) {
  return apiCall('chat_keep_message', { message_id: messageId, keep }, 'POST');
}

// Admin review: pending members
export async function chatPendingMembers(conversationId) {
  return apiCall('chat_pending_members', { conversation_id: conversationId }, 'POST');
}

export async function chatApproveMember(conversationId, email, approve = true) {
  // Backend reads `approve` boolean (1=approve, 0=reject). Older callers
  // passed action='approve'/'reject' strings — accept that for backwards
  // compat by mapping them to the boolean before sending.
  let approveBool;
  if (typeof approve === 'string') approveBool = approve === 'approve' || approve === 'true';
  else approveBool = !!approve;
  return apiCall('chat_approve_member', { conversation_id: conversationId, email, approve: approveBool ? 1 : 0 }, 'POST');
}

// Channels (WhatsApp-style broadcast channels)
export async function channelCreate(name, description = '', category = 'general', isPublic = true) {
  return apiCall('chat_create_channel', { name, description, category, is_public: isPublic }, 'POST');
}
export async function channelMyChannels() {
  return apiCall('channel_my_channels', {});
}
export async function channelDiscover(category = '', search = '', limit = 50, offset = 0) {
  return apiCall('chat_discover_channels', { category, search, limit, offset });
}
export async function channelFollow(channelId) {
  return apiCall('chat_join_channel', { conversation_id: channelId }, 'POST');
}
export async function channelUnfollow(channelId) {
  return apiCall('chat_leave_channel', { conversation_id: channelId }, 'POST');
}
export async function channelFeed(channelId, limit = 30, offset = 0) {
  return apiCall('channel_feed', { channel_id: channelId, limit, offset });
}
export async function channelPost(channelId, content, type = 'text', fileUrl = '') {
  return apiCall('channel_post', { channel_id: channelId, content, type, file_url: fileUrl }, 'POST');
}
export async function channelReact(postId, emoji) {
  return apiCall('channel_react', { post_id: postId, emoji }, 'POST');
}
export async function channelDeletePost(postId) {
  return apiCall('channel_delete_post', { post_id: postId }, 'POST');
}
export async function channelInfo(channelId) {
  return apiCall('chat_channel_info', { conversation_id: channelId });
}

// AI text-to-sticker + channel summaries
export async function aiTextToSticker(text) {
  return apiCall('ai_text_to_sticker', { text }, 'POST');
}
export async function aiSummarizeChannel(posts) {
  return apiCall('ai_summarize_channel', { posts }, 'POST');
}

// Feed algorithms
export async function feedExplore(page = 1, limit = 20) {
  return apiCall('feed_explore', { page, limit }, 'POST');
}
export async function feedSetTopics(topics) {
  return apiCall('feed_set_topics', { topics }, 'POST');
}
export async function feedGetTopics() {
  return apiCall('feed_get_topics', {});
}
export async function aiSummarizeFeed(emails, limit = 10) {
  return apiCall('ai_summarize_feed', { emails, limit }, 'POST');
}
// Member tags
export async function chatSetMemberTag(conversationId, email, tag) {
  return apiCall('chat_set_member_tag', { conversation_id: conversationId, email, tag }, 'POST');
}

// Edit history
export async function chatEditHistory(messageId) {
  return apiCall('chat_edit_history', { message_id: messageId }, 'POST');
}

// Streaks
export async function chatGetStreaks() { return apiCall('chat_get_streaks', {}); }
// Call links
export async function chatCreateCallLink(callType = 'video') { return apiCall('chat_create_call_link', { call_type: callType }, 'POST'); }
export async function chatJoinCallLink(linkId) { return apiCall('chat_join_call_link', { link_id: linkId }); }
// Status stickers
export async function statusPollVote(statusId, optionIndex) { return apiCall('status_poll_vote', { status_id: statusId, option_index: optionIndex }, 'POST'); }
export async function statusQuestionAnswer(statusId, answer, stickerId = '') { return apiCall('status_question_answer', { status_id: statusId, answer, sticker_id: stickerId }, 'POST'); }
// Slider sticker — value is normalized 0-100. Returns running avg.
export async function statusSliderVote(statusId, value, stickerId = '') {
  return apiCall('status_slider_vote', { status_id: statusId, value: Math.max(0, Math.min(100, Math.round(value))), sticker_id: stickerId }, 'POST');
}
// Owner-only: list answers to question stickers on a status.
export async function statusQuestionList(statusId) {
  return apiCall('status_question_list', { status_id: statusId }, 'POST');
}
// Music sticker library — tab: 'foryou' | 'search' | 'saved'.
// On 'search' the server hits Deezer; falls back to curated list.
export async function chatStatusMusicSearch(query = '', tab = 'foryou', limit = 25) {
  return apiCall('chat_status_music_search', { q: query, tab, limit }, 'POST');
}
export async function chatStatusMusicSave(track) {
  return apiCall('chat_status_music_save', {
    track_id: track.id,
    title: track.title || '',
    artist: track.artist || '',
    artwork_url: track.artwork_url || track.coverUrl || '',
    preview_url: track.preview_url || track.previewUrl || '',
    duration: track.duration || 30,
  }, 'POST');
}
export async function chatStatusMusicUnsave(trackId) {
  return apiCall('chat_status_music_unsave', { track_id: trackId }, 'POST');
}
// Snap Map (legacy stubs — kept so callers built against the older
// `update_location` / `get_friends_locations` shape don't 500. They map onto
// the new Friend-Tracking API below.)
export async function updateLocation(latitude, longitude) {
  // No-op without an active conversation — the new pipeline stores location
  // via chat_update_live_location inside a chat. Use friendLocationShareGlobal
  // for the Map-tab fire-and-forget case.
  return apiCall('update_location', { latitude, longitude }, 'POST').catch(() => ({ success: false }));
}
export async function getFriendsLocations() {
  // Forward to new endpoint, preserving the legacy shape {data:{locations:[]}}.
  const r = await apiCall('chat_friends_map_shares', {}).catch(() => null);
  if (r && r.success && r.data) {
    return { success: true, data: { locations: r.data.shares || [] } };
  }
  return { success: false, data: { locations: [] } };
}

// ──────────────────────────────────────────────────────────────────────
// Friend-Tracking (Snap-Map / Find-My-Friends) — added 2026-05-18
// ──────────────────────────────────────────────────────────────────────
//
// Two-tier permission model:
//   1. Sharer (B) must explicitly accept a request before A sees their pin.
//   2. Either side can revoke at any time (instant via revoke endpoint).
//
// Privacy invariant: chat_friends_map_shares only returns pins from users
// who currently have a chat_location_grants row with me as receiver. There
// is no "silent" mode — see backend chat.php BEGIN FRIEND_LOCATION_TRACKING.

/**
 * A asks B "can I see your location?". Triggers a push + WS event on B's
 * side; B answers via friendLocationAccept / friendLocationDecline.
 */
export async function friendLocationRequest(targetEmail, message = '') {
  return apiCall('chat_friend_location_request', { target_email: targetEmail, message }, 'POST');
}

/**
 * B accepts A's request. `durationSeconds = -1` means unlimited (until B
 * manually revokes). Otherwise bounded to [15min..7d].
 */
export async function friendLocationAccept(requesterEmail, durationSeconds = 3600) {
  return apiCall('chat_friend_location_accept', {
    requester_email: requesterEmail,
    duration_seconds: durationSeconds,
    unlimited: durationSeconds === -1,
  }, 'POST');
}

export async function friendLocationDecline(requesterEmail) {
  return apiCall('chat_friend_location_decline', { requester_email: requesterEmail }, 'POST');
}

// [7181 fix 2026-05-22] Wake a stale sharer. Snap-map fires this when a
// friend's pin has been silent >5min — backend dispatches a silent push
// (iOS apns-push-type=background + Android FCM data-only) so the sharer's
// app wakes, re-runs getCurrentPosition, and posts a fresh location. 60s
// server-side throttle + 90s client-side throttle protect APNs quota.
export async function friendLocationPing(sharerEmail) {
  return apiCall('chat_friend_location_ping', { sharer_email: sharerEmail }, 'POST');
}

/**
 * Either side ends an active grant. `peerEmail` = the other party.
 */
export async function friendLocationRevoke(peerEmail) {
  return apiCall('chat_friend_location_revoke', { peer_email: peerEmail }, 'POST');
}

/**
 * Privacy dashboard data: who I'm sharing with, who I'm receiving from,
 * pending requests both directions.
 */
export async function friendLocationGrants() {
  return apiCall('chat_friend_location_grants', {});
}

/**
 * Map-tab feed: every active live-share from users who granted me access.
 * Poll this every 30s + listen to WS 'location_update' for live patches.
 */
export async function friendsMapShares() {
  return apiCall('chat_friends_map_shares', {});
}

/**
 * WAVE 69 2026-05-21 — Zero-permission IP geolocation fallback for snap-map.
 *
 * Why: even with last-known cache + Brazil centroid (WAVE 65/66), brand-new
 * cold-installs still saw Cuiabá on first open. User feedback:
 *   "amigos no mapa quando abre o mapa a loc que deve carregar e da onde eu to ne"
 *
 * The backend (chat.php case `geo_locate_ip`) tries Cloudflare geo headers
 * first (Pro+ plan returns lat/lng) then falls back to ipapi.co free tier
 * (1000/day). Both have ~5-10km city-level accuracy — more than enough to
 * pan the map to the right region while expo-location warms up.
 *
 * Result is cached in AsyncStorage under `snap_map_ip_loc:v1` so we only
 * hit the backend once per cold-install. IPs change ~rarely.
 *
 * Returns `{success, data: { lat, lng, city, country, source }}`.
 */
export async function geoLocateIp() {
  return apiCall('geo_locate_ip', {});
}
// Saved collections
export async function feedCollectionCreate(name) { return apiCall('feed_collection_create', { name }, 'POST'); }
export async function feedCollectionList() { return apiCall('feed_collection_list', {}); }
export async function feedCollectionAdd(collectionId, postId) { return apiCall('feed_collection_add', { collection_id: collectionId, post_id: postId }, 'POST'); }
// Wave 15: remove an item from a collection + list a collection's items.
export async function feedCollectionRemoveItem(collectionId, postId) {
  return apiCall('feed_collection_remove_item', { collection_id: collectionId, post_id: postId }, 'POST');
}
export async function feedCollectionItems(collectionId) {
  return apiCall('feed_collection_items', { collection_id: collectionId }, 'POST');
}

// ── Wave 15: ads (placeholder for future ad SDK) ───────────────────────
// Returns active ad posts. `topic` / `region` are optional filters that
// the backend matches against the caption and free-text location.
export async function feedAdsList({ topic, region, limit = 6 } = {}) {
  return apiCall('feed_ads_list', { topic: topic || '', region: region || '', limit }, 'POST');
}

// ── Wave 15: hashtag follow / unfollow / list ──────────────────────────
// Posts whose caption matches a followed hashtag get a 1.3× ranking
// boost in feed_explore_nearby.
export async function hashtagFollow(tag) {
  return apiCall('hashtag_follow', { tag: String(tag || '').replace(/^#/, '') }, 'POST');
}
export async function hashtagUnfollow(tag) {
  return apiCall('hashtag_unfollow', { tag: String(tag || '').replace(/^#/, '') }, 'POST');
}
export async function hashtagFollowedList() {
  return apiCall('hashtag_followed_list', {}, 'POST');
}

// ── Wave 15: feed_explore_nearby — Discover "Próximos" tab ─────────────
// City-match (chat_user_profile.city) + followed-hashtag boost ranker.
export async function feedExploreNearby(page = 1, limit = 20) {
  return apiCall('feed_explore_nearby', { page, limit }, 'POST');
}

// ── Wave 15: promote post (paid boost stub) ────────────────────────────
// Marks an owned post as is_promoted = TRUE for `hours` (default 24,
// cap 168). Ranker applies a 1.4× score boost while active.
export async function feedPromotePost(postId, hours = 24) {
  return apiCall('feed_promote_post', { post_id: postId, hours }, 'POST');
}
// Creator analytics. If postId is provided, returns per-post stats (views,
// likes, comments, shares + 7-day view series). Otherwise returns the
// creator-wide rollup.
export async function feedAnalytics(postId = 0) {
  return apiCall('feed_analytics', postId ? { post_id: postId } : {}, 'POST');
}

// Instagram Notes (24h text status)
export async function chatSetNote(content) {
  return apiCall('chat_set_note', { content }, 'POST');
}
export async function chatGetNotes() {
  return apiCall('chat_get_notes', {});
}

// Vanish mode — backend (chat.php case 'chat_set_vanish_mode') reads
// `enabled`, not `vanish`. Previously the toggle silently no-op'd
// because the param name didn't match. Send both to stay compatible
// with any older handler that may still read `vanish`.
export async function chatSetVanishMode(conversationId, enabled) {
  const on = !!enabled;
  return apiCall('chat_set_vanish_mode', { conversation_id: conversationId, enabled: on, vanish: on }, 'POST');
}

// Username system
export async function setUsername(username) {
  return apiCall('set_username', { username }, 'POST');
}
export async function checkUsernameHandle(username) {
  return apiCall('check_username', { username });
}
export async function searchByUsername(query) {
  return apiCall('search_by_username', { query });
}

// E2E Encryption
export async function e2eUploadKey(publicKey, deviceId = 'default') {
  return apiCall('e2e_upload_key', { public_key: publicKey, device_id: deviceId }, 'POST');
}

export async function e2eGetKeys(emails) {
  return apiCall('e2e_get_keys', { emails }, 'POST');
}

export async function e2eStatus(conversationId) {
  return apiCall('e2e_status', { conversation_id: conversationId });
}

export async function e2eeEnableConversation(conversationId) {
  return apiCall('chat_enable_e2ee', { conversation_id: conversationId }, 'POST');
}

export async function e2eeDisableConversation(conversationId) {
  return apiCall('chat_disable_e2ee', { conversation_id: conversationId }, 'POST');
}

export async function e2eeRegisterKeys(deviceId, identityKey, prekeys) {
  return apiCall('e2ee_register_keys', { device_id: deviceId, identity_key: identityKey, prekeys }, 'POST');
}

export async function e2eeGetKeyBundle(emails) {
  return apiCall('e2ee_get_key_bundle', { emails }, 'POST');
}

export async function e2eePreKeyCount() {
  return apiCall('e2ee_prekey_count', {});
}

// Status (WhatsApp-style stories)
export async function statusPublish(content, type = 'text', bgColor = '#7C3AED', musicData = null, extraMeta = {}) {
  // Historical callers pass the uploaded media URL as `content` for image/
  // video types. Backend has a dedicated `media_url` column — sending the
  // URL as `content` left media_url empty and the profile/chat viewers
  // fell back to rendering the URL as text ("status/status_69..."). Route
  // URL to the right column; caption (if any) rides along in `content`.
  const params = { type, background: bgColor };
  if (type === 'image' || type === 'video') {
    params.media_url = content || '';
    params.content = extraMeta?.caption || '';
  } else if (type === 'poll') {
    // Wave 4: poll status. `content` carries the poll question (the
    // backend also stashes it in chat_user_status.content so chat-list
    // previews show "📊 Que cor?" without decoding meta). The poll
    // object travels in extraMeta.poll = { question, options[] }.
    params.content = (extraMeta?.poll?.question) || content || '';
    params.poll = extraMeta?.poll || null;
  } else {
    params.content = content;
  }
  if (musicData) {
    params.music_title = musicData.title || '';
    params.music_artist = musicData.artist || '';
    params.music_preview_url = musicData.previewUrl || '';
    params.music_cover_url = musicData.coverUrl || '';
    // music_start_ms — offset (in ms) into the track where playback should
    // begin (the user-picked "trecho" via the trim scrubber). WhatsApp/IG
    // store a start offset; StoryViewer seeks the player to it on load.
    if (musicData.startMs != null && Number.isFinite(Number(musicData.startMs))) {
      params.music_start_ms = Math.max(0, Math.round(Number(musicData.startMs)));
    }
  }
  // Forward whitelisted meta keys (caption, stickers, draws, poll already
  // separated above) so the backend persists them. Skip ones already
  // sent above or that don't belong in status_create.
  if (extraMeta && typeof extraMeta === 'object') {
    for (const k of ['caption_locale', 'caption_translations', 'privacy', 'filter', 'stickers', 'text_overlays', 'draw_paths', 'font_style', 'is_boomerang']) {
      if (extraMeta[k] !== undefined && params[k] === undefined) params[k] = extraMeta[k];
    }
    // cross_post_feed — server creates a feed_posts row with same media when true.
    if (extraMeta.cross_post_feed === true) params.cross_post_feed = true;
    // highlight_only — Instagram-model Destaques. Server inserts the row but
    // immediately archives it so it NEVER appears in the 24h ephemeral status
    // feed (status_list/manifest gate on archived_at IS NULL); the highlight
    // still resolves it via status_highlight_items by id. Use this when adding
    // photos to a profile highlight so they don't pollute the status strip.
    if (extraMeta.highlight_only === true) params.highlight_only = true;
    // except_emails — author-side hide list when privacy === 'except'. The
    // backend persists it under meta and filters status_list per viewer.
    if (Array.isArray(extraMeta.except_emails) && extraMeta.except_emails.length > 0) {
      params.except_emails = extraMeta.except_emails
        .map(e => String(e || '').trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return apiCall('status_create', params, 'POST');
}

export async function statusUpload(file, onProgress) {
  // Prefer Rust chunked upload (gives onProgress callback for the UI overlay).
  // Falls back to PHP /data/status/ only if Rust is unavailable.
  try {
    const userEmail = (_cachedActiveAccount && typeof _cachedActiveAccount === 'string') ? _cachedActiveAccount : '';
    const rustRes = typeof onProgress === 'function'
      ? await rustChunkedUpload(file, userEmail, 'status', onProgress)
      : await rustUpload(file, userEmail, 'status');
    if (rustRes?.success && (rustRes.cdn_url || rustRes.data?.cdn_url)) {
      const url = rustRes.cdn_url || rustRes.data?.cdn_url;
      return { success: true, data: { url, cdn_url: url, filename: file?.name || 'status' } };
    }
    // Rust returned { success: false, error: 'unavailable' } → fall through
  } catch {}

  // ── Legacy PHP fallback ──
  const formData = new FormData();
  if (Platform.OS === 'web') {
    if (file instanceof Blob || file instanceof File) {
      formData.append('file', file, file.name || 'status.jpg');
    } else if (file?.blob instanceof Blob) {
      formData.append('file', file.blob, file.name || 'status.jpg');
    } else if (file?._raw instanceof Blob || file?._raw instanceof File) {
      formData.append('file', file._raw, file.name || 'status.jpg');
    } else if (file?.uri && typeof file.uri === 'string') {
      try {
        const blob = await fetch(file.uri).then(r => r.blob());
        formData.append('file', blob, file.name || 'status.jpg');
      } catch { return { success: false, message: 'Could not read image blob' }; }
    } else {
      return { success: false, message: 'Invalid image format' };
    }
  } else {
    formData.append('file', file);
  }
  formData.append('action', 'status_upload');
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    const controller = new AbortController();
    // 30s was too tight for video uploads — a 50MB iPhone clip on 4G needs ~90-120s.
    // Bump to 180s so videos actually finish through the PHP fallback when Rust→R2
    // is unavailable.
    const isVideo = (file?.type || '').startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file?.name || '');
    const timeoutMs = isVideo ? 180000 : 45000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(`${API_URL}?action=status_upload`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.json();
  } catch (e) {
    return { success: false, message: e.message };
  }
}

export async function statusList() {
  return apiCall('status_list');
}

// [WAVE 54 2026-05-21] Ultra-light strip payload — per-owner aggregates only
// (latest_id, count, unviewed, latest_at, has_video). Target <5KB for 50
// contacts so the home Status row paints subsecond on 3G even when the JS
// SWR + MMKV caches are cold. The full per-item payload comes from
// `statusList()` on first tab focus or when the user taps a bubble.
//
// Response shape: { users: [{ email, name, is_own, latest_id, count,
//                              unviewed, latest_at, has_video }, ...] }
export async function statusManifest() {
  return apiCall('status_manifest');
}

// Fire-and-forget prefetch helper — call from bootstrap() / cold-start so the
// manifest is warm in HTTP cache (Cache-Control SWR) by the time the user
// taps the Chat tab. Never throws, never returns data (drop it on the floor).
export function statusManifestPrefetch() {
  try {
    statusManifest().catch(() => {});
  } catch {}
}

export async function statusView(statusId) {
  return apiCall('status_view', { status_id: statusId }, 'POST');
}

// Cheap existence check — verifies the status row is still in
// chat_user_status AND not past expires_at. Used pelo bubble status_reply
// no chat antes de navegar pro profile, pra mostrar "Status nao disponivel"
// caso o owner tenha apagado o status (ou tenha expirado).
export async function statusCheck(statusId) {
  return apiCall('status_check', { status_id: statusId }, 'POST');
}

export async function statusDelete(statusId) {
  return apiCall('status_delete', { status_id: statusId }, 'POST');
}

export async function statusViewers(statusId) {
  return apiCall('status_viewers', { status_id: statusId }, 'POST');
}

// statusAnalytics — per-status creator analytics. Owner-only.
// Returns: impressions, exit_rate, completion_rate, reactions, replies,
// completed. Surfaced in the own-status long-press menu under
// "Estatisticas". Backend lives in api/chat.php case 'status_analytics'.
export async function statusAnalytics(statusId) {
  return apiCall('status_analytics', { status_id: statusId }, 'POST');
}

// statusRepost — repost an existing status (archived or live) as a NEW
// status. Server-side this is just status_create with the same media_url
// + caption and a fresh expires_at. Mirrors Instagram's "Compartilhar
// como story" flow. Returns the new status row payload.
export async function statusRepost(statusId, { caption = '', privacy = 'all' } = {}) {
  return apiCall('status_repost', {
    status_id: statusId,
    caption,
    privacy,
  }, 'POST');
}

// Wave 4: Archive own status — hides it from the home strip + chat list
// preview but keeps the row in PG so the owner can browse a personal
// archive later. Mirrors Instagram Archive. `status_unarchive` reverts.
export async function statusArchive(statusId) {
  return apiCall('status_archive', { status_id: statusId }, 'POST');
}
export async function statusUnarchive(statusId) {
  return apiCall('status_unarchive', { status_id: statusId }, 'POST');
}
export async function statusArchiveList() {
  return apiCall('status_archive_list', {}, 'POST');
}

// Wave 4: Do-Not-Disturb schedule. Mutes ALL chat push notifications
// during a HH:MM..HH:MM window in the user's local timezone. Backend
// persists per-user; firebase_push.php / push-notify.php read this table
// before fanning out so the schedule applies system-wide.
export async function chatDndGet() {
  return apiCall('chat_dnd_get', {}, 'POST');
}
export async function chatDndSet({ enabled, start_time, end_time, tz_offset }) {
  return apiCall('chat_dnd_set', {
    enabled: !!enabled,
    start_time: String(start_time || '22:00'),
    end_time: String(end_time || '07:00'),
    tz_offset: Number.isFinite(+tz_offset) ? (+tz_offset | 0) : 0,
  }, 'POST');
}

// Status mute/unmute — silenciar status de um contato. Hidden from the
// home top row across all platforms once muted. WhatsApp parity.
export async function statusMute(email) {
  return apiCall('status_mute', { email }, 'POST');
}
export async function statusUnmute(email) {
  return apiCall('status_unmute', { email }, 'POST');
}
export async function statusMutedList() {
  return apiCall('status_muted_list', {}, 'POST');
}

// ─── Instagram-level status (v2) ─────────────────────────────────────────
// statusCarouselPublish — bundle N already-uploaded media items into one
// multi-slide story. Items must be { type, media_url, content?, caption?,
// filter?, stickers?, text_overlays?, text_animation?, font_style? }.
export async function statusCarouselPublish(items, { privacy = 'all' } = {}) {
  return apiCall('status_carousel_publish', { items, privacy }, 'POST');
}

// statusReact — private emoji reaction on a story. The author is the only
// one who sees who reacted; viewers get an optimistic UI bump only.
export async function statusReact(statusId, emoji) {
  return apiCall('status_react', { status_id: statusId, emoji }, 'POST');
}

// statusReplyDM — Instagram-style DM reply. Server resolves the author,
// opens or reuses the direct conversation, and drops a "status_reply"
// card with a preview of the story + the reply text.
export async function statusReplyDM(statusId, text) {
  return apiCall('status_reply_dm', { status_id: statusId, content: text }, 'POST');
}

// statusNotifyToggle — Subscribe / unsubscribe to FCM pings for a specific
// author's new statuses. The profile sheet exposes this as a toggle row
// (\"Notificar sobre stories de X\"). Idempotent on the server.
export async function statusNotifyToggle(targetEmail, enabled) {
  return apiCall('status_notify_toggle', {
    target_email: String(targetEmail || '').toLowerCase(),
    enabled: !!enabled,
  }, 'POST');
}

// statusNotifyList — Return the set of author emails the current viewer
// has opted-in for. Frontend caches this so the profile sheet can paint
// the toggle correctly without an extra round-trip per profile open.
export async function statusNotifyList() {
  return apiCall('status_notify_list', {}, 'POST');
}

// Group management
export async function chatLeaveGroup(conversationId) {
  return apiCall('chat_leave_group', { conversation_id: conversationId }, 'POST');
}

export async function chatGroupAdmin(conversationId, targetEmailOrFlags, action) {
  // Two call shapes:
  //  1) chatGroupAdmin(convId, email, 'promote'|'demote') — legacy
  //     promote/demote a specific user
  //  2) chatGroupAdmin(convId, { admin_only_post, hide_members, ... }) — new
  //     persist group-wide flags (server may grow support over time)
  if (targetEmailOrFlags && typeof targetEmailOrFlags === 'object') {
    return apiCall('chat_group_admin', { conversation_id: conversationId, ...targetEmailOrFlags }, 'POST');
  }
  return apiCall('chat_group_admin', { conversation_id: conversationId, target_email: targetEmailOrFlags, action }, 'POST');
}

export async function chatRemoveMember(conversationId, targetEmail) {
  return apiCall('chat_remove_member', { conversation_id: conversationId, target_email: targetEmail }, 'POST');
}

// Scheduled calls — pre-arrange a call. The cron-scheduled-calls.php
// worker fires push reminders 15min and 1min before the slot. Joining is
// gated to ±5min around scheduled_at.
export async function callSchedule({ participants, title, scheduledAt, durationMin = 30 }) {
  return apiCall('call_schedule', {
    participants,
    title,
    scheduled_at: scheduledAt,
    duration_min: durationMin,
  }, 'POST');
}
export async function callScheduleList() {
  return apiCall('call_schedule_list', {}, 'POST');
}
export async function callScheduleCancel(id) {
  return apiCall('call_schedule_cancel', { id }, 'POST');
}
export async function callScheduleJoin(id) {
  return apiCall('call_schedule_join', { id }, 'POST');
}

export async function chatGroupInfo(conversationId) {
  return apiCall('chat_group_info', { conversation_id: conversationId });
}

export async function chatUpdateGroup(conversationId, updates) {
  return apiCall('chat_update_group', { conversation_id: conversationId, ...updates }, 'POST');
}

export async function chatSetDisappearing(conversationId, timer) {
  return apiCall('chat_set_disappearing', { conversation_id: conversationId, timer }, 'POST');
}

// chat_user_defaults_* — unified user-level chat defaults bag.
// Holds: default_disappearing (int seconds), media_auto_dl_photos|audio|videos|docs
// (each 'wifi'|'mobile'|'never'). Reads/writes the chat_user_defaults PG table.
export async function chatUserDefaultsGet() {
  return apiCall('chat_user_defaults_get', {}, 'POST');
}
export async function chatUserDefaultsSet(patch = {}) {
  return apiCall('chat_user_defaults_set', patch, 'POST');
}

export async function chatLock(conversationId, locked) {
  return apiCall('chat_lock', { conversation_id: conversationId, locked: locked ? 1 : 0 }, 'POST');
}

export async function chatGetLocked() {
  return apiCall('chat_get_locked', {}, 'POST');
}

// Chat PIN lock (2FA)
export async function chatSetPin(pin) {
  return apiCall('chat_set_pin', { pin }, 'POST');
}
export async function chatVerifyPin(pin) {
  return apiCall('chat_verify_pin', { pin }, 'POST');
}
export async function chatCheckPin() {
  return apiCall('chat_check_pin', {}, 'POST');
}

// Scheduled messages
export async function chatScheduleMessage(conversationId, content, scheduledAt) {
  return apiCall('chat_schedule_message', { conversation_id: conversationId, content, scheduled_at: scheduledAt }, 'POST');
}

export async function chatScheduledList() {
  return apiCall('chat_scheduled_list', {}, 'POST');
}

export async function chatScheduleCancel(scheduledId) {
  return apiCall('chat_schedule_cancel', { scheduled_id: scheduledId }, 'POST');
}

// @ChatyyAI inline mention — fires after the user's message is persisted.
// Returns the AI bot's reply as a normal chat_messages row that the WS
// broadcast also delivers to peers.
export async function chatAiMention(conversationId, prompt) {
  return apiCall('chat_ai_mention', { conversation_id: conversationId, prompt }, 'POST');
}

export async function markViewOnce(messageId) {
  return apiCall('mark_view_once', { message_id: messageId }, 'POST');
}

export async function chatSearchGifs(query = '', limit = 20) {
  return apiCall('chat_search_gifs', { query, limit }, 'POST');
}

// Block / Unblock / Report
// Phone OTP login
export async function requestPhoneOtp(phone) {
  return apiCall('request_phone_otp', { phone }, 'POST');
}

export async function verifyPhoneOtp(phone, code) {
  return apiCall('verify_phone_otp', { phone, code }, 'POST');
}

// Authenticated phone verification (associate a NEW phone with an existing
// account). Different from request/verify_phone_otp which are for phone-first
// LOGIN flow. These require an active session and update profile data.json
// + chat_phone_registry so the user becomes discoverable by phone hash.
export async function verifyPhoneSend(phone) {
  return apiCall('verify_phone_send', { phone }, 'POST');
}

export async function verifyPhoneCheck(phone, code) {
  return apiCall('verify_phone_check', { phone, code }, 'POST');
}

// Phone NUMBER CHANGE (SIM swap recovery, WhatsApp pattern). Authenticated
// flow that swaps an active account's phone while keeping every chat /
// contact / handle. Three-call dance:
//   phoneChangeRequest — sends OTP to the NEW phone, persists pending flag
//   phoneChangeVerify  — confirms OTP, swaps verified_phone +
//                        chat_phone_registry, fan-outs a system DM
//   phoneChangeCancel  — drops the pending flag if user backs out
export async function phoneChangeRequest(newPhone) {
  return apiCall('phone_change_request', { new_phone: newPhone }, 'POST');
}
export async function phoneChangeVerify(newPhone, code) {
  return apiCall('phone_change_verify', { new_phone: newPhone, code }, 'POST');
}
export async function phoneChangeCancel() {
  return apiCall('phone_change_cancel', {}, 'POST');
}

export async function chatBlockUser(email) {
  return apiCall('chat_block_user', { email }, 'POST');
}

export async function chatUnblockUser(email) {
  return apiCall('chat_unblock_user', { email }, 'POST');
}

// chat_report_thread — WhatsApp "Report and leave" combo: snapshot last 50
// messages of the thread, then optionally block + archive in a single call.
// `action` ∈ 'report' | 'block' | 'leave' | 'block_and_leave' (default).
export async function chatReportThread(conversationId, reason = '', action = 'block_and_leave') {
  return apiCall('chat_report_thread', {
    conversation_id: conversationId,
    reason: reason || '',
    action,
  }, 'POST');
}

export async function chatReportUser(email, reason, messageId) {
  const params = { email, reason };
  if (messageId) params.message_id = messageId;
  return apiCall('chat_report_user', params, 'POST');
}

export async function chatBlockedList() {
  return apiCall('chat_blocked_list', {}, 'POST');
}

export async function chatCheckBlocked(email) {
  return apiCall('chat_check_blocked', { email }, 'POST');
}

export async function chatGetSettings() {
  return apiCall('chat_get_settings');
}

export async function chatUpdateSettings(data) {
  return apiCall('chat_update_settings', data, 'POST');
}

// chat_get_user_defaults — pulls the JSONB user defaults row including
// auto_download_policy (4×3 matrix). Used by ChatProfileTab on mount to
// hydrate mediaCache.setAutoDownloadPolicy.
export async function chatGetUserDefaults() {
  return apiCall('chat_get_user_defaults', {}, 'POST');
}

// chat_set_auto_download_policy — accepts either the full matrix in `policy`
// or a single-cell patch via {bucket, column, value}.
export async function chatSetAutoDownloadPolicy(payload) {
  return apiCall('chat_set_auto_download_policy', payload, 'POST');
}

// Top N active conversations (last 30d, excluding manual pins). Used by
// smart-pin (auto-fixar conversas mais ativas) when enabled in settings.
export async function chatTopActive(limit = 3) {
  return apiCall('chat_top_active', { limit }, 'GET');
}

/**
 * Upload file via Rust media service (direct to R2, 10x faster, no PHP workers).
 * Falls back gracefully if Rust service is unavailable.
 */
// Probe /api/rust/upload with OPTIONS (CORS preflight returns 204 if alive, 404 if not).
// GET was wrong — the endpoint is POST-only, so a GET always 404s even when the service is up.
//
// Re-probe every 2 minutes so a transient Rust service restart (OOM, deploy)
// doesn't poison the flag for the rest of the session. Before this, one
// failed probe locked the client into the PHP fallback permanently and
// photos stayed "loading" silently.
let _rustUploadAvailable = null;
let _rustUploadProbedAt = 0;
// Force a fresh probe on next call — used when the user taps "Start backup"
// so a stale "unavailable" from an earlier session doesn't block them.
export function _resetRustUploadProbe() {
  _rustUploadAvailable = null;
  _rustUploadProbedAt = 0;
}
async function _probeRustUpload() {
  const now = Date.now();
  if (_rustUploadAvailable !== null && (now - _rustUploadProbedAt) < 120000) {
    return _rustUploadAvailable;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`${BASE_URL}/api/rust/upload`, { method: 'OPTIONS', signal: ctrl.signal });
    clearTimeout(t);
    _rustUploadAvailable = r.status >= 200 && r.status < 300;
  } catch { _rustUploadAvailable = false; }
  _rustUploadProbedAt = now;
  return _rustUploadAvailable;
}

export async function rustUpload(file, userEmail, context = 'chat', externalSignal = null, onProgress = null) {
  if ((await _probeRustUpload()) === false) return { success: false, error: 'unavailable' };
  try {
    const formData = new FormData();
    // CRITICAL: web check FIRST. On web `file` is wrapped as { uri: blobUrl, blob, name }.
    // Plain objects with `uri` get stringified to "[object Object]" by FormData → corrupted upload.
    if (Platform.OS === 'web') {
      if (file._raw instanceof Blob || file._raw instanceof File) {
        formData.append('file', file._raw, file.name || 'upload');
      } else if (file.blob instanceof Blob || file.blob instanceof File) {
        formData.append('file', file.blob, file.name || 'upload');
      } else if (file instanceof Blob || file instanceof File) {
        formData.append('file', file, file.name || 'upload');
      } else if (file.uri && typeof file.uri === 'string') {
        // Last resort: fetch the blob URL
        const blob = await fetch(file.uri).then(r => r.blob());
        formData.append('file', blob, file.name || 'upload');
      } else {
        return null;
      }
    } else {
      // Native: { uri, name, type }
      if (file.uri) {
        formData.append('file', { uri: file.uri, name: file.name || 'upload', type: file.type || 'application/octet-stream' });
      } else {
        return null;
      }
    }
    formData.append('user_email', userEmail || '');
    formData.append('context', context);
    if (file.name) formData.append('filename', file.name);

    // XHR path — fetch() on React Native does NOT emit upload-progress events,
    // so any caller that passed `onProgress` would see a frozen 0% bar until
    // the whole upload finished. XMLHttpRequest exposes xhr.upload.onprogress
    // which fires every ~50ms during the body transfer — same plumbing we
    // already use in chatUploadFile. Use this branch whenever onProgress is
    // wired (chat photo path: ~500KB compressed JPEG took the rustUpload
    // branch since it falls under the 1MB chunked threshold, so the bar was
    // stuck at 0% the whole upload).
    if (onProgress && typeof XMLHttpRequest !== 'undefined') {
      return await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${BASE_URL}/api/rust/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
        if (Platform.OS === 'web') xhr.withCredentials = true;
        xhr.timeout = 90000;
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            try { onProgress(e.loaded / e.total); } catch {}
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch { resolve({ success: false, error: `parse_${xhr.status}` }); }
          } else {
            resolve({ success: false, error: `http_${xhr.status}` });
          }
        };
        xhr.onerror = () => resolve({ success: false, error: 'network' });
        xhr.ontimeout = () => resolve({ success: false, error: 'timeout' });
        xhr.onabort = () => resolve({ success: false, error: 'aborted', aborted: true });
        if (externalSignal) {
          if (externalSignal.aborted) { try { xhr.abort(); } catch {} }
          else externalSignal.addEventListener('abort', () => { try { xhr.abort(); } catch {} }, { once: true });
        }
        xhr.send(formData);
      });
    }

    // 90s timeout — if Rust doesn't respond, abort so the worker can move on.
    // Also wire the external signal (from the upload bubble X button) so user
    // cancels stop the fetch immediately instead of letting it run to timeout.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    const onExternalAbort = () => ctrl.abort();
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const resp = await fetch(`${BASE_URL}/api/rust/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` },
        body: formData,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        return { success: false, error: `http_${resp.status}` };
      }
      return await resp.json();
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener?.('abort', onExternalAbort);
    }
  } catch (e) {
    console.warn('[RustUpload] Failed:', e.message);
    return { success: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'unknown') };
  }
}

/**
 * Chunked upload via Rust — for large files (videos, big photos).
 * Splits file into 5MB chunks, uploads each separately.
 * If connection drops, resumes from last chunk.
 * Returns same format as rustUpload.
 */
export async function rustChunkedUpload(file, userEmail, context = 'chat', onProgress = null, _externalSignal = null) {
  if ((await _probeRustUpload()) === false) return { success: false, error: 'unavailable' };
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
  try {
    // Get file as blob
    let blob;
    if (file._raw instanceof Blob || file._raw instanceof File) {
      blob = file._raw;
    } else if (file.blob instanceof Blob || file.blob instanceof File) {
      blob = file.blob;
    } else if (file instanceof Blob || file instanceof File) {
      blob = file;
    } else if (Platform.OS === 'web' && file.uri && typeof file.uri === 'string') {
      // Web fallback: fetch the blob URL into a real Blob
      try { blob = await fetch(file.uri).then(r => r.blob()); } catch { return rustUpload(file, userEmail, context); }
    } else if (file.uri && Platform.OS !== 'web') {
      // Native — read the file via expo-file-system in chunks (no blob support).
      return await rustChunkedUploadNative(file, userEmail, context, onProgress);
    } else {
      return rustUpload(file, userEmail, context);
    }

    const totalSize = blob.size || file.size || 0;
    if (totalSize < CHUNK_SIZE * 2) {
      // Small file — use direct upload instead
      return rustUpload(file, userEmail, context);
    }

    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
    const filename = file.name || 'upload';
    const contentType = file.type || blob.type || 'application/octet-stream';

    // 1. Init
    const initResp = await fetch(`${BASE_URL}/api/rust/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ filename, total_size: totalSize, total_chunks: totalChunks, content_type: contentType, user_email: userEmail, context }),
    });
    const initData = await initResp.json();
    if (!initData.upload_id) return null;
    const uploadId = initData.upload_id;

    // 2. Check which chunks already uploaded (resume support)
    let startChunk = 0;
    try {
      const statusResp = await fetch(`${BASE_URL}/api/rust/upload/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ upload_id: uploadId }),
      });
      const statusData = await statusResp.json();
      startChunk = statusData.received_count || 0;
    } catch {}

    // 3. Upload chunks
    for (let i = startChunk; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize);
      const chunk = blob.slice(start, end);

      const formData = new FormData();
      formData.append('upload_id', uploadId);
      formData.append('chunk_index', String(i));
      formData.append('chunk', chunk, `chunk_${i}`);

      const resp = await fetch(`${BASE_URL}/api/rust/upload/chunk`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` },
        body: formData,
      });
      if (!resp.ok) throw new Error(`Chunk ${i} failed: ${resp.status}`);

      if (onProgress) onProgress((i + 1) / totalChunks);
    }

    // 4. Complete
    const completeResp = await fetch(`${BASE_URL}/api/rust/upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ upload_id: uploadId, filename, content_type: contentType, user_email: userEmail, context }),
    });
    return await completeResp.json();
  } catch (e) {
    console.warn('[ChunkedUpload] Failed:', e.message);
    return null;
  }
}

/**
 * Native chunked upload — reads the file via expo-file-system in 1 MB byte slices.
 * Each chunk is a separate small POST, so iOS NSURLSession's idle-timeout doesn't
 * kill big uploads. Used by photo backup for files > 3 MB.
 */
async function rustChunkedUploadNative(file, userEmail, context, onProgress) {
  const CHUNK_SIZE = 1 * 1024 * 1024; // 1 MB chunks — small enough to finish in <14s on 3 Mbps wifi
  try {
    // BUG fix: expo-file-system/legacy is the only one that exposes cacheDirectory
    // at the top level. The new modular API moved it to FileSystem.Paths.cache.
    // We were doing `FSnew.cacheDirectory` which returned undefined → "/undefinedbk_chunks/" file write fail.
    const FS = require('expo-file-system/legacy');
    // Resolve file size via legacy getInfoAsync (always available)
    let totalSize = file.size || 0;
    if (!totalSize) {
      try {
        const info = await FS.getInfoAsync(file.uri);
        totalSize = info?.size || 0;
      } catch {}
    }
    if (!totalSize) return { success: false, error: 'no_file_size' };

    // If small enough, use direct upload
    if (totalSize <= CHUNK_SIZE * 2) {
      return rustUpload(file, userEmail, context);
    }

    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
    const filename = file.name || 'upload';
    const contentType = file.type || 'application/octet-stream';

    // 1. Init the upload
    const initCtrl = new AbortController();
    const initTimer = setTimeout(() => initCtrl.abort(), 15000);
    const initResp = await fetch(`${BASE_URL}/api/rust/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ filename, total_size: totalSize, total_chunks: totalChunks, content_type: contentType, user_email: userEmail, context }),
      signal: initCtrl.signal,
    }).catch(e => null);
    clearTimeout(initTimer);
    if (!initResp || !initResp.ok) return { success: false, error: 'init_failed' };
    const initData = await initResp.json().catch(() => null);
    const uploadId = initData?.upload_id;
    if (!uploadId) return { success: false, error: 'no_upload_id' };

    // 2. Upload each 1 MB chunk as multipart/form-data — Rust expects that format.
    //    Write the slice to a temp file then FormData with { uri } so React Native
    //    streams it natively (no base64, no JSON conversion).
    const tmpDir = FS.cacheDirectory + 'bk_chunks/';
    try { await FS.makeDirectoryAsync(tmpDir, { intermediates: true }); } catch {}

    // Concurrent chunk upload — 3 in-flight at a time. Sequential was the
    // bottleneck: a 30MB video on 5Mbps wifi (~4-5s per chunk) took 30+s end
    // to end. Three parallel chunks saturate the uplink (3× the throughput)
    // bringing the same upload to ~10-12s. Cap at 3 because Cloudflare/Rust
    // limits concurrent connections per origin, and more in-flight buys
    // diminishing returns vs. memory cost.
    const CONCURRENCY = 3;
    let completed = 0;
    let aborted = false;
    let firstError = null;

    const uploadChunk = async (i) => {
      if (aborted) return;
      if (file._abortRef && file._abortRef.aborted) { aborted = true; return; }
      const start = i * CHUNK_SIZE;
      const len = Math.min(CHUNK_SIZE, totalSize - start);
      const tmpPath = tmpDir + `c_${uploadId}_${i}.bin`;

      // Read slice → temp file (with retry on iOS cache eviction).
      let readWriteOk = false;
      let lastErr = '';
      for (let attempt = 0; attempt < 2 && !readWriteOk; attempt++) {
        try {
          const b64 = await FS.readAsStringAsync(file.uri, {
            encoding: FS.EncodingType.Base64,
            length: len,
            position: start,
          });
          if (attempt > 0) {
            try { await FS.makeDirectoryAsync(tmpDir, { intermediates: true }); } catch {}
          }
          await FS.writeAsStringAsync(tmpPath, b64, { encoding: FS.EncodingType.Base64 });
          readWriteOk = true;
        } catch (e) {
          lastErr = e?.message || '';
          if (attempt === 0) await new Promise(r => setTimeout(r, 150));
        }
      }
      if (!readWriteOk) {
        firstError = firstError || `read_chunk_${i}_failed:${lastErr}`;
        aborted = true;
        return;
      }

      // 60s per chunk + 5 retries with exponential backoff. The previous 30s
      // was too tight on slow/roaming cellular — user reported timeouts while
      // traveling. A 1MB chunk at 200 kbps takes 40s; 60s gives headroom.
      // Per-attempt AbortController so retries get a fresh timeout window
      // (the old code reused the same `ctrl`, so retry 2 had 0s left after
      // the first attempt timed out).
      const MAX_CHUNK_ATTEMPTS = 5;
      let chunkOk = false;
      let attempts = 0;
      while (attempts < MAX_CHUNK_ATTEMPTS && !chunkOk && !aborted) {
        attempts++;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        try {
          const fd = new FormData();
          fd.append('upload_id', uploadId);
          fd.append('chunk_index', String(i));
          fd.append('chunk', { uri: tmpPath, name: `chunk_${i}.bin`, type: 'application/octet-stream' });
          const resp = await fetch(`${BASE_URL}/api/rust/upload/chunk`, {
            method: 'POST',
            body: fd,
            signal: ctrl.signal,
          });
          chunkOk = resp.ok;
        } catch (e) {
          // network error or timeout — fall through to backoff
        }
        clearTimeout(timer);
        if (!chunkOk && attempts < MAX_CHUNK_ATTEMPTS) {
          await new Promise(r => setTimeout(r, Math.min(5000, 800 * Math.pow(2, attempts - 1))));
        }
      }
      try { await FS.deleteAsync(tmpPath, { idempotent: true }); } catch {}
      if (!chunkOk) {
        firstError = firstError || `chunk_${i}_failed_after_retries`;
        aborted = true;
        return;
      }
      completed++;
      if (onProgress) onProgress(completed / totalChunks);
    };

    // Worker pool: each worker pulls the next chunk index from a shared
    // counter so we never have idle workers while there's still work.
    let nextChunkIdx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, totalChunks) }, async () => {
      while (!aborted) {
        const idx = nextChunkIdx++;
        if (idx >= totalChunks) return;
        await uploadChunk(idx);
      }
    });
    await Promise.all(workers);
    if (aborted) return { success: false, error: firstError || 'aborted' };

    // 3. Complete
    const completeCtrl = new AbortController();
    const completeTimer = setTimeout(() => completeCtrl.abort(), 30000);
    const completeResp = await fetch(`${BASE_URL}/api/rust/upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ upload_id: uploadId, filename, content_type: contentType, user_email: userEmail, context }),
      signal: completeCtrl.signal,
    }).catch(() => null);
    clearTimeout(completeTimer);
    if (!completeResp || !completeResp.ok) return { success: false, error: 'complete_failed' };
    return await completeResp.json().catch(() => ({ success: false, error: 'complete_parse_failed' }));
  } catch (e) {
    return { success: false, error: e?.message || 'native_chunked_unknown' };
  }
}

export async function chatUploadFile(conversationId, file, content = '', viewOnce = false, onProgress = null, msgType = null, externalSignal = null, silent = false) {
  const formData = new FormData();
  formData.append('action', 'chat_upload');
  formData.append('conversation_id', String(conversationId));
  if (content) formData.append('content', content);
  if (viewOnce) formData.append('view_once', '1');
  // Forward the message type (image/video/audio/file) so the backend doesn't
  // have to re-guess from extension and downgrade videos/audio to "file".
  if (msgType) formData.append('type', msgType);
  // silent=1 uploads the file and returns only the URL, no chat message
  // is created and no broadcast/push is fired. Used for group avatar changes.
  if (silent) formData.append('silent', '1');
  if (Platform.OS === 'web' && file.blob) {
    // Web: use Blob directly
    formData.append('file', file.blob, file.name || 'file');
  } else {
    formData.append('file', {
      uri: file.uri,
      name: file.name || 'file',
      type: file.type || 'application/octet-stream',
    });
  }
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  // Use XMLHttpRequest for upload progress tracking. fetch() on React
  // Native does NOT report upload progress (only download), so the UI
  // would freeze at 0% until done. XHR works on both web and native and
  // emits real progress events through xhr.upload.onprogress — needed
  // for WhatsApp-style upload bars.
  if (onProgress && typeof XMLHttpRequest !== 'undefined') {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}?action=chat_upload`);
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      if (Platform.OS === 'web') xhr.withCredentials = true;
      xhr.timeout = 300000;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(e.loaded / e.total);
        }
      };
      xhr.onload = () => {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (err) {
          // Surface the HTTP status + first 200 chars of response so we can
          // tell a 413 (too big), 502 (gateway), 401 (auth) etc. apart from
          // a generic network failure. The bare "Upload failed" alert was
          // hiding all of these.
          const snippet = (xhr.responseText || '').slice(0, 200).replace(/\s+/g, ' ').trim();
          resolve({ success: false, message: `Upload failed (HTTP ${xhr.status}${snippet ? ': ' + snippet : ''})` });
        }
      };
      xhr.onerror = () => resolve({ success: false, message: `Upload failed (network: HTTP ${xhr.status || 0})` });
      xhr.ontimeout = () => resolve({ success: false, message: 'Upload timed out' });
      xhr.onabort = () => resolve({ success: false, message: 'aborted', aborted: true });
      // Tie the caller's AbortSignal to xhr.abort() so the X-cancel button
      // kills the upload instantly.
      if (externalSignal) {
        if (externalSignal.aborted) { try { xhr.abort(); } catch {} }
        else externalSignal.addEventListener('abort', () => { try { xhr.abort(); } catch {} }, { once: true });
      }
      xhr.send(formData);
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(`${API_URL}?action=chat_upload`, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    try {
      return await res.json();
    } catch {
      // Non-JSON response (HTML error page, gateway timeout, etc.). Surface
      // HTTP status so the caller can show "File too large (413)" instead of
      // a generic toast that hides the real cause.
      const txt = await res.text().catch(() => '');
      const snippet = (txt || '').slice(0, 200).replace(/\s+/g, ' ').trim();
      return { success: false, message: `Upload failed (HTTP ${res.status}${snippet ? ': ' + snippet : ''})`, status: res.status };
    }
  } catch (e) {
    clearTimeout(timeout);
    if (e?.name === 'AbortError') throw e;
    return { success: false, message: `Upload failed (${e?.message || 'network'})` };
  } finally {
    if (externalSignal) externalSignal.removeEventListener?.('abort', onExternalAbort);
  }
}

export async function chatUnreadCount() {
  // Use chat_list and sum up unread counts client-side
  const r = await apiCall('chat_list');
  if (r.success && r.data?.conversations) {
    const total = r.data.conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    return { success: true, data: { unread_count: total } };
  }
  return r;
}

export async function chatCreatePoll(conversationId, question, options, multipleChoice = false, quiz = null) {
  const payload = { conversation_id: conversationId, question, options, multiple_choice: multipleChoice };
  // Quiz mode (Telegram parity): pass `quiz = { correctOption: N, explanation: '...' }`
  // to render the poll as a quiz with a single correct answer + optional
  // explanation shown after voting.
  if (quiz && typeof quiz.correctOption === 'number') {
    payload.is_quiz = true;
    payload.correct_option = quiz.correctOption;
    if (quiz.explanation) payload.explanation = quiz.explanation;
  }
  return apiCall('chat_create_poll', payload, 'POST');
}

export async function chatVotePoll(pollId, optionIndex) {
  return apiCall('chat_vote_poll', { poll_id: pollId, option_index: optionIndex }, 'POST');
}

export async function chatLinkPreview(url) {
  return apiCall('chat_link_preview', { url }, 'POST');
}

// Chat contacts (for broadcast, etc.)
export async function chatContacts() {
  return apiCall('chat_contacts');
}

// Broadcast lists
export async function chatBroadcastCreate(name, members) {
  return apiCall('chat_broadcast_create', { name, members }, 'POST');
}
export async function chatBroadcastList() {
  return apiCall('chat_broadcast_list', {});
}
export async function chatBroadcastUpdate(broadcastId, name, members) {
  return apiCall('chat_broadcast_update', { broadcast_id: broadcastId, name, members }, 'POST');
}
export async function chatBroadcastDelete(broadcastId) {
  return apiCall('chat_broadcast_delete', { broadcast_id: broadcastId }, 'POST');
}
export async function chatBroadcastSend(broadcastId, content, type = 'text') {
  return apiCall('chat_broadcast_send', { broadcast_id: broadcastId, content, type }, 'POST');
}

// Channels
export async function chatCreateChannel(name, description = '', isPublic = false) {
  // [2026-05-28] 3rd arg `isPublic` was dropped → CreateGroupFlow channels
  // were always created private regardless of the toggle. Forward is_public.
  return apiCall('chat_create_channel', { name, description, is_public: isPublic ? 1 : 0 }, 'POST');
}
export async function chatDiscoverChannels() {
  return apiCall('chat_discover_channels', {});
}
export async function chatJoinChannel(conversationId) {
  return apiCall('chat_join_channel', { conversation_id: conversationId }, 'POST');
}
export async function chatLeaveChannel(conversationId) {
  return apiCall('chat_leave_channel', { conversation_id: conversationId }, 'POST');
}
export async function chatChannelInfo(conversationId) {
  return apiCall('chat_channel_info', { conversation_id: conversationId });
}

// Public channel discovery (Telegram-style)
export async function chatChannelCreatePublic(conversationId, handle, opts = {}) {
  return apiCall('chat_channel_create_public', {
    conversation_id: conversationId,
    handle,
    category: opts.category || '',
    description: opts.description || '',
  }, 'POST');
}
export async function chatDiscoverPublic(opts = {}) {
  const params = {};
  if (opts.category) params.category = opts.category;
  if (opts.q) params.q = opts.q;
  if (opts.sort) params.sort = opts.sort;
  return apiCall('chat_discover_public', params);
}
export async function chatChannelJoin(conversationIdOrHandle) {
  // Accepts either a numeric conv id or an @handle string.
  const params = (typeof conversationIdOrHandle === 'number')
    ? { conversation_id: conversationIdOrHandle }
    : { handle: String(conversationIdOrHandle || '').replace(/^@/, '') };
  return apiCall('chat_channel_join', params, 'POST');
}

// Media gallery
export async function chatMediaGallery(conversationId, type = null, limit = 50, offset = 0) {
  const params = { conversation_id: conversationId, limit, offset };
  if (type) params.type = type;
  return apiCall('chat_media_gallery', params, 'POST');
}

// Chat export (single-format text/json/html). Optional { from, to } ISO date
// strings filter the message range server-side.
export async function chatExport(conversationId, format = 'txt', opts = {}) {
  const body = { conversation_id: conversationId, format };
  if (opts && opts.from) body.from = opts.from;
  if (opts && opts.to) body.to = opts.to;
  return apiCall('chat_export', body, 'POST');
}

// Group invite link
export async function chatGroupInviteLink(conversationId, regenerate = false) {
  // [2026-05-28] Backend reads `mode` ('get'|'create'|'rotate'|'revoke'), not
  // `regenerate` — so a regenerate request was silently treated as 'get'.
  // Map regenerate→'rotate' and keep sending `regenerate` for back-compat.
  return apiCall('chat_group_invite_link', {
    conversation_id: conversationId,
    regenerate,
    mode: regenerate ? 'rotate' : 'get',
  }, 'POST');
}

// Join group via invite link
export async function chatJoinViaLink(code) {
  return apiCall('chat_join_via_link', { code }, 'POST');
}


// View-once
export async function chatViewOnceOpen(messageId) {
  return apiCall('chat_view_once_open', { message_id: messageId }, 'POST');
}

// Clear chat history (per-user, WhatsApp-style)
export async function chatClearHistory(conversationId) {
  return apiCall('chat_clear_history', { conversation_id: conversationId }, 'POST');
}

// Check whether a contact (email and/or phone) is registered on Chatyy.
// Returns { has_chatyy, email, name }.
export async function chatCheckChatyy({ email, phone } = {}) {
  return apiCall('chat_check_chatyy', { email: email || '', phone: phone || '' }, 'POST');
}

// Live availability check for @username (debounced from the editor).
// Returns { available, reason? } — reasons: too_short, too_long, reserved, taken
export async function usernameCheck(username) {
  return apiCall('username_check', { username: String(username || '') }, 'POST');
}

// @username canonical claim — persists to chat_usernames PG table.
// Use this from ProfileEditSheet save instead of update_profile so the handle
// becomes resolvable via profile_get?username=xxx for any user.
export async function usernameSet(username) {
  return apiCall('username_set', { username: String(username || '').trim().replace(/^@/, '') }, 'POST');
}

// Group @handle (Telegram parity). Admins claim, anyone can lookup.
export async function groupUsernameSet(conversationId, username) {
  return apiCall('group_username_set', {
    conversation_id: Number(conversationId),
    username: String(username || '').trim().replace(/^[@+]/, ''),
  }, 'POST');
}
export async function groupUsernameLookup(username) {
  return apiCall('group_username_lookup', {
    username: String(username || '').trim().replace(/^[@+]/, ''),
  }, 'POST');
}

// Per-conversation auto-translate (locale = '' or null disables).
export async function chatSetAutoTranslate(conversationId, locale) {
  return apiCall('chat_set_auto_translate', { conversation_id: Number(conversationId), locale: locale || '' }, 'POST');
}
export async function chatGetAutoTranslate(conversationId) {
  return apiCall('chat_get_auto_translate', { conversation_id: Number(conversationId) }, 'POST');
}

// Bot platform (Telegram /BotFather parity).
export async function chatBotRegister(botUsername, name, description = '') {
  return apiCall('chat_bot_register', {
    bot_username: String(botUsername || '').toLowerCase().replace(/[^a-z0-9_]/g, ''),
    name, description,
  }, 'POST');
}
export async function chatBotList() {
  return apiCall('chat_bot_list', {}, 'POST');
}
export async function chatBotInfo(botUsername) {
  return apiCall('chat_bot_info', { bot_username: String(botUsername || '').replace(/^@/, '') }, 'POST');
}
export async function chatBotSetCommands(botUsername, commands) {
  return apiCall('chat_bot_set_commands', { bot_username: botUsername, commands }, 'POST');
}
export async function chatBotLookup(botUsername) {
  return apiCall('chat_bot_lookup', { bot_username: String(botUsername || '').replace(/^@/, '') }, 'POST');
}

// Resolve @handle → email (public endpoint, no auth — used to open peer
// profile from a shared chatyy.com.br/@handle link).
export async function usernameLookup(username) {
  return apiCall('username_lookup', { username: String(username || '').trim().replace(/^@/, '') }, 'POST');
}

// Group call
export async function chatGroupCall(conversationId, callType = 'video') {
  return apiCall('chat_group_call', { conversation_id: conversationId, call_type: callType }, 'POST');
}

// Add participant(s) to an already-running group call. The new invitees get
// VoIP push (CallKit ring) using the existing call_id, joining the same
// LiveKit room. Pass the full list of emails to invite (caller is filtered
// out server-side).
export async function chatCallInvite(conversationId, callId, emails, video = true) {
  return apiCall('chat_call_invite', {
    conversation_id: conversationId,
    call_id: callId,
    video: video ? 1 : 0,
    emails: Array.isArray(emails) ? emails : [emails],
  }, 'POST');
}

// ============================================================
// CALL E2EE — Signal-style master-key envelopes (Phase 1, 2026-05-22)
// ------------------------------------------------------------
// Companion of services/e2e-call.js. The caller mints the 32-byte master
// locally, wraps it once per callee device with tweetnacl Box (X25519 +
// XSalsa20-Poly1305), and ships the envelopes here. Server stores them as
// opaque BYTEA and pushes a `call_e2ee_envelope_ready` WS event to each
// callee device. Master plaintext NEVER leaves the caller's process.
//
// Feature flag: backend requires CALL_E2EE_ENABLED=1 (default OFF). The
// kill-switch CALL_E2EE_KILLSWITCH=1 returns 503 — clients fall back to
// legacy SRTP-only (DTLS-protected, still safe but server-recordable).
// ============================================================

/**
 * Upload per-device encrypted master-key envelopes for a brand-new call.
 *
 * @param {object} args
 * @param {string} args.callId             — server call_id (same as call_invite)
 * @param {string} args.callerDeviceId     — sender's device_id (from getDeviceId())
 * @param {string} [args.sdpFingerprint]   — hex SHA-256 of local DTLS cert
 * @param {Array}  args.envelopes          — output of buildEnvelopesForBundles()
 * @param {number} [args.wireVersion=1]    — envelope wire format version
 */
export async function chatCallInviteE2ee({
  callId,
  callerDeviceId,
  sdpFingerprint = '',
  envelopes,
  wireVersion = 1,
} = {}) {
  return apiCall('chat_call_invite_e2ee', {
    call_id:           String(callId || ''),
    caller_device_id:  String(callerDeviceId || ''),
    sdp_fingerprint:   String(sdpFingerprint || ''),
    envelopes:         Array.isArray(envelopes) ? envelopes : [],
    wire_version:      wireVersion | 0,
  }, 'POST');
}

/**
 * Acknowledge successful decrypt — server deletes the row (replay defense).
 */
export async function chatCallKeyAck({ callId, deviceId, rotationCounter = 0 } = {}) {
  return apiCall('chat_call_key_ack', {
    call_id:          String(callId || ''),
    device_id:        String(deviceId || ''),
    rotation_counter: rotationCounter | 0,
  }, 'POST');
}

/**
 * Push a fresh master to every callee device during a long call. Same
 * envelope shape as the initial invite; rotation_counter must be ≥ 1 and
 * monotonically increasing per call.
 */
export async function chatCallKeyRotate({
  callId,
  callerDeviceId,
  rotationCounter,
  envelopes,
  wireVersion = 1,
} = {}) {
  return apiCall('chat_call_key_rotate', {
    call_id:           String(callId || ''),
    caller_device_id:  String(callerDeviceId || ''),
    rotation_counter:  rotationCounter | 0,
    envelopes:         Array.isArray(envelopes) ? envelopes : [],
    wire_version:      wireVersion | 0,
  }, 'POST');
}

// Host-issued mute of a remote participant in a group call. Backend validates
// the caller has admin role on the conversation, then relays a WS
// `call_mute_request` event to the target's `chat_user_{email}` channel.
// The target /call.js picks up the event and locally calls
// `room.localParticipant.setMicrophoneEnabled(false)`.
// Avoids `kick`/`ban` wording per product preference — only mute/restrict.
export async function chatCallMuteParticipant(conversationId, callId, targetEmail) {
  return apiCall('chat_call_mute_participant', {
    conversation_id: conversationId,
    call_id: callId,
    target_email: targetEmail,
  }, 'POST');
}

// Decline-with-message: post-CallKit / IncomingCallActivity quick-reply.
// Backend fans the standard WS `call_end` event AND drops a chat message
// into the DM from the declining user so the caller sees "Te ligo já" /
// "Estou ocupado" / custom text in chat. See chat.php
// `chat_call_decline_with_message`.
export async function chatCallDeclineWithMessage(callId, conversationId, toEmail, message) {
  return apiCall('chat_call_decline_with_message', {
    call_id: callId,
    conversation_id: conversationId,
    to_email: toEmail,
    message: (message || '').slice(0, 240),
  }, 'POST');
}

// Generate a post-call recap (transcript + AI summary) for a 1:1 or group
// call. Reuses the voicemail Whisper pipeline — see `_voicemailTranscribeAsync`
// in chat.php for the model. Recording must have been uploaded via
// `uploadCallRecording` first. Returns
// `{ transcript, summary, duration }` or `{ pending: true }` if still
// processing.
export async function chatCallRecap(callId) {
  return apiCall('chat_call_recap', { call_id: callId }, 'POST');
}

// Chat backup
export async function chatBackupCreate() {
  return apiCall('chat_backup_create', {}, 'POST');
}
export async function chatBackupList() {
  return apiCall('chat_backup_list', {});
}
export async function chatBackupDownload(backupId) {
  return apiCall('chat_backup_download', { backup_id: backupId });
}
export async function chatBackupDelete(backupId) {
  return apiCall('chat_backup_delete', { backup_id: backupId }, 'POST');
}
export async function chatBackupRestore(backupId) {
  return apiCall('chat_backup_restore', { backup_id: backupId }, 'POST');
}

// chat_restore_from_blob — cross-provider cloud restore. Called by
// services/chatBackupCloud.js after the client decrypts a backup from
// iCloud/Drive. Server-side: re-inserts rows into chat_messages skipping
// duplicates by (conversation_id, client_msg_id). Idempotent.
export async function chatRestoreFromBlob({ manifest, conversations, messages, chunkIndex = 0, totalChunks = 1 }) {
  return apiCall('chat_restore_from_blob', {
    manifest: manifest || {},
    conversations: conversations || [],
    messages: messages || [],
    chunk_index: chunkIndex,
    total_chunks: totalChunks,
  }, 'POST');
}

// E2E backup escrow — fatter ciphertext envelope (master key + chat keys +
// device fingerprints) encrypted client-side with the user's passphrase.
// The server never sees the passphrase or the encryption key; it stores
// only the ciphertext + a sha256(passphrase) gate so we can refuse to
// hand the blob back when the user types a different passphrase. See
// /var/www/mail/api/e2ee.php → e2ee_backup_escrow_put/get for the schema.
export async function e2eeBackupEscrowPut({ ciphertext, salt, nonce, kdfIters = 100000, passphraseHash, deviceLabel = '' }) {
  return apiCall('e2ee_backup_escrow_put', {
    ciphertext, salt, nonce,
    kdf_iters: kdfIters,
    passphrase_hash: passphraseHash,
    device_label: deviceLabel,
  }, 'POST');
}
export async function e2eeBackupEscrowGet(passphraseHash = '') {
  return apiCall('e2ee_backup_escrow_get', { passphrase_hash: passphraseHash || '' }, 'POST');
}

// Group join approval queue. The require_approval flag is admin-set
// (chatGroupSetRequireApproval); when ON, every link join fans into
// chat_group_join_requests (pending) and an admin must approve / deny
// via the *RequestApprove / *RequestDeny endpoints.
export async function chatGroupSetRequireApproval(conversationId, requireApproval) {
  return apiCall('chat_group_set_require_approval', {
    conversation_id: conversationId, require_approval: requireApproval,
  }, 'POST');
}
// Friendly alias — UI surface (group info toggle) reads better as
// "approval required" than "require approval". Both call the same
// backend endpoint; this name is what new call sites should use.
export async function chatGroupSetApprovalRequired(conversationId, approvalRequired) {
  return chatGroupSetRequireApproval(conversationId, !!approvalRequired);
}
export async function chatGroupRequestList(conversationId) {
  return apiCall('chat_group_request_list', { conversation_id: conversationId });
}
export async function chatGroupRequestApprove(requestId) {
  return apiCall('chat_group_request_approve', { request_id: requestId }, 'POST');
}
export async function chatGroupRequestDeny(requestId) {
  return apiCall('chat_group_request_deny', { request_id: requestId }, 'POST');
}

// Photo sync from cloud
export async function drivePhotoSyncList(page = 1, limit = 50, month = null) {
  return apiCall('drive_photo_sync_list', { page, limit, ...(month ? { month } : {}) });
}

// Meetup / Hangout
export async function chatCreateMeetup(conversationId, title, datetime, location = '', description = '') {
  return apiCall('chat_create_meetup', { conversation_id: conversationId, title, datetime, location, description }, 'POST');
}

export async function chatMeetupRsvp(messageId, status) {
  return apiCall('chat_meetup_rsvp', { message_id: messageId, status }, 'POST');
}

// Shared Playlist
export async function chatCreatePlaylist(conversationId, name) {
  return apiCall('chat_create_playlist', { conversation_id: conversationId, name }, 'POST');
}

export async function chatPlaylistAddSong(messageId, song) {
  // Accept either a song object or legacy positional args
  if (typeof song === 'string') {
    return apiCall('chat_playlist_add_song', { message_id: messageId, title: song, artist: arguments[2] || '', url: arguments[3] || '' }, 'POST');
  }
  return apiCall('chat_playlist_add_song', {
    message_id: messageId,
    title: song?.title || '',
    artist: song?.artist || '',
    url: song?.url || '',
    cover: song?.cover || song?.coverUrl || '',
    preview_url: song?.preview_url || song?.previewUrl || '',
    duration: song?.duration || 30,
  }, 'POST');
}

export async function chatPlaylistRemoveSong(messageId, songIndex) {
  return apiCall('chat_playlist_remove_song', { message_id: messageId, song_index: songIndex }, 'POST');
}

export async function chatSearchMessages(conversationId, query) {
  // Stage 6 — search via WS relay (phone runs FTS5 on its SQLite copy and
  // returns matches). Skip on native — search is the phone's REST direct.
  if (Platform.OS === 'web') {
    try {
      const relay = require('./relayClient');
      if (await relay.isAvailable()) {
        try {
          const r = await relay.searchMessagesViaRelay(query, conversationId);
          try { globalThis.__chatyy_phone_offline = false; } catch {}
          return r;
        } catch (e) {
          const code = e?.code || '';
          if (code === 'phone_offline' || code === 'relay_timeout' || code === 'no_paired_device' || code === 'request_timeout') {
            // [#1220 2026-05-20] No banner — REST below serves fresh results.
            try { globalThis.__chatyy_phone_offline = false; } catch {}
          }
        }
      }
    } catch {}
  }
  return apiCall('chat_search_messages', { conversation_id: conversationId, query }, 'POST');
}

// chatPinMessage — duration in seconds (WhatsApp parity).
//   86400  = 24h
//   604800 = 7d (default — matches WhatsApp pre-selected option)
//   2592000 = 30d
// Backend clamps anything else to 7d, so passing nothing is safe. Toggling an
// already-pinned message ignores duration (unpins it).
export async function chatPinMessage(messageId, durationSeconds) {
  const payload = { message_id: messageId };
  if (durationSeconds && Number.isFinite(durationSeconds)) {
    payload.duration_seconds = durationSeconds;
  }
  // chat_pin_message is a TOGGLE on the server (pin if absent, unpin if present).
  // We must NOT both POST online AND pre-queue an offline replay: the localDb
  // offline_queue drains by re-firing apiCall(action, payload), so a queued
  // chat_pin_message replays the SAME toggle a second time → UNPINS the message
  // → the pin "disappears after closing + reopening the app" (Lester QA #12,
  // 2026-05-27). Correct pattern for a toggle: POST first; only fall back to the
  // offline queue if the request actually failed (offline / network error), so
  // the toggle is applied exactly once.
  const ld = _ld();
  let r;
  try {
    r = await apiCall('chat_pin_message', payload, 'POST');
  } catch (e) {
    r = { success: false, error: e?.message || 'pin_failed' };
  }
  if (!r?.success) {
    if (ld && typeof ld.queueOfflineAction === 'function') {
      try { await ld.queueOfflineAction('chat_pin_message', payload); } catch {}
    }
    return r;
  }
  // [pin persistence] chat_pinned_messages is an SWR-cached read. The generic
  // chat_* mutation hook in apiCall only busts `chat_list`, so without an
  // explicit invalidation here the next conversation open could serve a stale
  // (pre-pin / empty) pinned list straight from _swrCache within its TTL —
  // making the pin "disappear" after closing + reopening the chat even though
  // it persisted server-side. Bust the cache so the mount-time rehydrate
  // re-fetches the fresh pinned list.
  if (r?.success) { try { swrInvalidate('chat_pinned_messages'); } catch {} }
  return r;
}

export async function chatPinnedMessages(conversationId) {
  // Stage 6 — read pinned messages via WS relay on web when phone is paired.
  if (Platform.OS === 'web') {
    try {
      const relay = require('./relayClient');
      if (await relay.isAvailable()) {
        try {
          const r = await relay.getPinnedViaRelay(conversationId);
          try { globalThis.__chatyy_phone_offline = false; } catch {}
          return r;
        } catch (e) {
          const code = e?.code || '';
          if (code === 'phone_offline' || code === 'relay_timeout' || code === 'no_paired_device' || code === 'request_timeout') {
            // [#1227 2026-05-20] No banner — PG via REST handles pinned list.
            // The relay path was a perf optimization; falling through is the
            // correct behavior. Wave 3 killed 4 spots; this was the 5th.
            try { globalThis.__chatyy_phone_offline = false; } catch {}
          }
        }
      }
    } catch {}
  }
  return apiCall('chat_pinned_messages', { conversation_id: conversationId });
}

export async function chatSetWallpaper(conversationId, wallpaper) {
  return apiCall('chat_set_wallpaper', { conversation_id: conversationId, wallpaper }, 'POST');
}

export async function chatGetWallpaper(conversationId) {
  return apiCall('chat_get_wallpaper', { conversation_id: conversationId });
}

// Business auto-reply
export async function chatGetAutoReply() {
  return apiCall('chat_get_auto_reply', {});
}
export async function chatSetAutoReply(data) {
  return apiCall('chat_set_auto_reply', data, 'POST');
}

// Reels
export async function reelsFeed(page = 1, limit = 20) {
  return apiCall('reels_feed', { page, limit }, 'POST');
}

// ============================================================
// CALENDAR API
// ============================================================
export async function calCalendars() {
  return apiCall('cal_list_calendars');
}

export async function calCreateCalendar(name, color) {
  return apiCall('cal_create_calendar', { name, color }, 'POST');
}

export async function calEvents(start, end) {
  return apiCall('cal_list_events', { start, end });
}

export async function calEvent(eventId) {
  return apiCall('cal_get_event', { event_id: eventId });
}

export async function calCreateEvent(data) {
  return apiCall('cal_create_event', data, 'POST');
}

export async function calUpdateEvent(eventId, data) {
  return apiCall('cal_update_event', { event_id: eventId, ...data }, 'POST');
}

export async function calDeleteEvent(eventId) {
  return apiCall('cal_delete_event', { event_id: eventId }, 'POST');
}

export async function calRsvp(eventId, status) {
  return apiCall('cal_rsvp_event', { event_id: eventId, status }, 'POST');
}

export async function calMyEvents(limit = 10) {
  return apiCall('cal_today');
}

export async function calSearch(query) {
  return apiCall('cal_search', { query });
}

// TODO: Security concern — bearer token embedded in URL (see getAttachmentUrl comment)
export function calExportICSUrl(token) {
  // Returns the URL for the ICS feed subscription (token-authenticated)
  return `${API_URL}?action=cal_export_ics&token=${encodeURIComponent(token)}`;
}

// ============================================================
// FILES/DRIVE API (Chatyy Drive)
// ============================================================
export async function fileList(folderId = null) {
  return apiCall('drive_list', { parent_id: folderId });
}

export async function fileListAll() {
  return apiCall('drive_list_all');
}

export async function fileUpload(file, folderId = null) {
  const formData = new FormData();
  formData.append('action', 'drive_upload');
  if (file._raw) {
    formData.append('file', file._raw, file.name);
  } else if (file.uri) {
    formData.append('file', { uri: file.uri, type: file.mimeType || file.type || 'application/octet-stream', name: file.name || 'file' });
  } else {
    formData.append('file', file);
  }
  if (folderId) formData.append('parent_id', String(folderId));

  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000); // 300s for uploads

  try {
    const res = await fetch(`${API_URL}?action=drive_upload`, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { success: false, message: 'Servidor indisponivel' }; }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { success: false, message: 'Tempo limite excedido' };
    return { success: false, message: 'Connection error' };
  }
}

// SECURITY TODO: this embeds the full bearer token in the query string, which
// leaks into browser history, server access logs, and Referer headers. The
// attachment path solved this with a short-lived `dt` token minted by
// `attachment_token` (see getAttachmentUrl + mintAttachmentDownloadToken on the
// backend), but that token is bound to (uid, folder, part) for IMAP
// attachments and does NOT cover drive file ids — there is no
// drive-download-token mint endpoint yet. Until the backend exposes a
// `drive_dl_token` (short-lived, bound to the drive file id) we keep the bearer
// here so downloads don't break. When that endpoint lands, mirror the
// getAttachmentUrl pattern: serve a cached `dt`, prefetch in the background,
// and fall back to the bearer only if the mint isn't deployed.
export function fileDownloadUrl(fileId) {
  return `${API_URL}?action=drive_download&id=${fileId}&token=${encodeURIComponent(authToken || '')}`;
}

export async function fileDelete(fileId) {
  return apiCall('drive_delete', { id: fileId }, 'POST');
}

export async function fileRestore(fileId) {
  return apiCall('drive_restore', { id: fileId }, 'POST');
}

export async function filePermanentDelete(fileId) {
  return apiCall('drive_permanent_delete', { id: fileId }, 'POST');
}

export async function fileCreateFolder(name, parentId = null) {
  return apiCall('drive_create_folder', { name, parent_id: parentId }, 'POST');
}

export async function fileRename(id, type, name) {
  return apiCall('drive_rename', { id, name }, 'POST');
}

export async function fileMove(fileId, folderId) {
  return apiCall('drive_move', { id: fileId, target_parent_id: folderId }, 'POST');
}

export async function fileStar(fileId) {
  return apiCall('drive_starred', { id: fileId, toggle: 1 }, 'POST');
}

export async function fileTrash() {
  return apiCall('drive_trash');
}

export async function fileStorageInfo() {
  return apiCall('drive_storage_info');
}

// Get presigned S3 URL for direct upload (bypasses server — celular → R2 direto)
export async function getPresignedUpload(filename, mimeType = 'image/jpeg', parentId = null) {
  const params = { filename, mime_type: mimeType };
  if (parentId) params.parent_id = parentId;
  return apiCall('drive_presigned_upload', params, 'POST');
}

// Upload file directly to R2 via presigned URL (Cloud/Drive)
// onProgress: optional (pct: 0..100) => void — fires during R2 PUT
export async function fileUploadDirect(file, folderId = null, onProgress = null) {
  const filename = file.name || 'file';
  const mimeType = file.mimeType || file.type || 'application/octet-stream';
  const size = file.size || file.fileSize || 0;

  // 1. Get presigned URL
  const init = await getPresignedUpload(filename, mimeType, folderId);
  if (!init.success || !init.data?.upload_url) {
    // Fallback to legacy upload via server
    return fileUpload(file, folderId);
  }

  // 2. Upload directly to R2
  try {
    // BUG FIX: previous code was `file._raw || file.uri ? fetch(file.uri) : file`
    // which on web evaluated as `(_raw || uri) ? fetch(undefined) : file` and uploaded the
    // page HTML instead of the actual file. Use explicit branches.
    let body;
    if (file._raw) body = file._raw;
    else if (file.uri) body = await fetch(file.uri).then(r => r.blob());
    else body = file;

    // Use XHR when an onProgress callback is provided AND XHR is available
    // (web + native). xhr.upload.onprogress gives real byte-level progress;
    // fetch() has no native progress on uploads.
    const useXhr = typeof onProgress === 'function' && typeof XMLHttpRequest !== 'undefined';
    if (useXhr) {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', init.data.upload_url, true);
        xhr.setRequestHeader('Content-Type', mimeType);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            try { onProgress(Math.min(100, Math.max(0, Math.round((e.loaded / e.total) * 100)))); } catch {}
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { onProgress(100); } catch {}
            resolve();
          } else {
            reject(new Error(`R2 PUT failed: ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('R2 PUT network error'));
        xhr.onabort = () => reject(new Error('R2 PUT aborted'));
        xhr.send(body);
      });
    } else {
      const putRes = await fetch(init.data.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body,
      });
      if (!putRes.ok) throw new Error(`R2 PUT failed: ${putRes.status}`);
      if (typeof onProgress === 'function') { try { onProgress(100); } catch {} }
    }

    // 3. Confirm upload
    if (init.data.file_id) {
      await confirmUpload(init.data.file_id);
    }
    return { success: true, data: { file_id: init.data.file_id, url: init.data.upload_url } };
  } catch (e) {
    // Fallback to legacy
    return fileUpload(file, folderId);
  }
}

export async function confirmUpload(fileId) {
  return apiCall('drive_confirm_upload', { file_id: fileId }, 'POST');
}

// Batch confirm multiple S3 uploads at once (for background upload queue)
export async function confirmUploadBatch(fileIds) {
  return apiCall('drive_confirm_batch', { file_ids: JSON.stringify(fileIds) }, 'POST');
}

// Batch presigned S3 URLs — up to 50 files in one call (40x faster backup)
export async function getPresignedBatch(files) {
  return apiCall('drive_presigned_batch', { files: JSON.stringify(files) }, 'POST');
}

// Upload photo/video directly to Photo Backup folder (bypasses S3)
export async function uploadPhotoBackup(file) {
  const formData = new FormData();
  formData.append('action', 'drive_upload_photo_backup');
  if (file.uri) {
    formData.append('file', { uri: file.uri, type: file.mimeType || file.type || 'image/jpeg', name: file.name || 'photo.jpg' });
  } else {
    formData.append('file', file);
  }
  if (file.deviceName) formData.append('device_name', file.deviceName);

  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);

  try {
    const res = await fetch(`${API_URL}?action=drive_upload_photo_backup`, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { success: false, message: 'Server unavailable' }; }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { success: false, message: 'Timeout' };
    return { success: false, message: 'Connection error' };
  }
}

// Resumable upload: init session → returns upload_url + session_id
export async function driveInitUpload(filename, mimeType, totalSize, contentHash = null) {
  // Go Fast Auth for upload init (< 50ms)
  if (authToken) {
    try {
      const goRes = await fetch(goAuthUrl('drive-init-upload'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ filename, mime_type: mimeType, total_size: totalSize, content_hash: contentHash }),
      });
      const goData = await goRes.json();
      if (goData.success) return goData;
    } catch {}
  }
  return apiCall('drive_init_upload', {
    filename, mime_type: mimeType, total_size: totalSize, content_hash: contentHash
  }, 'POST');
}

// Batch presigned upload — N files in 1 round-trip
// items: [{ filename, mime_type, size }]
// Returns { success, data: { results: [{success, upload_url, object_key, file_id}, ...] } }
export async function driveInitUploadBatch(items) {
  return apiCall('drive_init_upload_batch', { items }, 'POST');
}

// Resumable upload: confirm completion
export async function driveCompleteUpload(fileId, contentHash = null) {
  return apiCall('drive_complete_upload', { file_id: fileId, content_hash: contentHash }, 'POST');
}

// Resumable upload: get resume info (bytes_uploaded + new upload_url)
export async function driveResumeUpload(sessionId) {
  return apiCall('drive_resume_upload', { session_id: sessionId }, 'POST');
}

// Content deduplication: check which hashes already exist on server
export async function driveCheckDuplicates(items) {
  return apiCall('drive_check_duplicates', { items }, 'POST');
}

// ML Photo Analysis (Google Photos style)
export async function photoAnalyze(fileId) {
  return apiCall('photo_analyze', { file_id: fileId }, 'POST');
}

export async function photoAnalyzeBatch(limit = 20) {
  return apiCall('photo_analyze_batch', { limit }, 'POST');
}

export async function photoSearchML(query, page = 1, limit = 50) {
  return apiCall('photo_search_ml', { query, page, limit }, 'POST');
}

// Extract EXIF GPS coordinates from up to `limit` photos that don't yet have
// gps_lat populated. Backend streams just the first 256 KB from R2 so a 50-
// photo batch costs ~12 MB of bandwidth and ~1s of wall time.
export async function photosExtractGps(limit = 50) {
  return apiCall('photos_extract_gps', { limit }, 'POST');
}

// Return geo-tagged photos clustered by ~1km grid for the Map view.
export async function photosWithGps() {
  return apiCall('photos_with_gps', {}, 'POST');
}

// Tag the iOS PHAsset.mediaSubtypes / Android equivalent onto a backed-up
// photo so the viewer knows to render it as live/burst/slowmo/timelapse/raw.
export async function photosSetMediaKind(fileId, mediaKind) {
  return apiCall('photos_set_media_kind', { file_id: fileId, media_kind: mediaKind }, 'POST');
}

// Build the export ZIP URL — used directly with WebBrowser.openBrowserAsync
// or Linking.openURL so the browser handles the download stream. apiCall is
// inappropriate here (response is octet-stream, not JSON).
export function photosExportZipUrl(ids) {
  // Compact CSV — keeps the URL short for moderate batches; large batches
  // (>500 ids) are rejected server-side so this stays well under HTTP limits.
  const csv = (Array.isArray(ids) ? ids : []).join(',');
  return `${BASE_URL}/api/email.php?action=photos_export_zip&ids=${encodeURIComponent(csv)}`;
}

// POST form of the ZIP export (used when ids[] is too long for a GET URL,
// or from environments where opening a browser URL is awkward).
export async function photosExportZip(ids) {
  return apiCall('photos_export_zip', { ids }, 'POST');
}

// Photo Memories (Google Photos-style "On this day" — DOY ±3 days vs prev years,
// plus a "this week" bucket of last 7 days). Backend groups by years-ago so the
// frontend can render "1 ano atrás" / "X anos atrás" cards directly.
export async function driveMemories() {
  return apiCall('drive_memories', {}, 'POST');
}

// WAVE 80 (2026-05-21): persistence helpers for photo memories.
//   - mute: long-press a card → backend sets chat_user_memories.muted=1 so
//     the card never re-appears (even from another device).
//   - regenerate: force-rebuild the cache (manual "refresh" or after large
//     photo import).
export async function photoMemoryMute(memoryKey, muted = 1) {
  return apiCall('photo_memories_mute', { memory_key: memoryKey, muted: muted ? 1 : 0 }, 'POST');
}
export async function photoMemoriesRegenerate() {
  return apiCall('photo_memories_regenerate', {}, 'POST');
}

export async function unifiedSearch(query, limit = 5) {
  return apiCall('unified_search', { query, limit }, 'POST');
}

// AI Features
export async function aiCategorize(subject, from, snippet) {
  return apiCall('ai_categorize', { subject, from, snippet }, 'POST');
}

export async function aiSmartReply(subject, body) {
  return apiCall('ai_smart_reply', { subject, body }, 'POST');
}

export async function aiSummarize(messages) {
  return apiCall('ai_summarize', { messages }, 'POST');
}

export async function translate(text, target = 'pt-BR') {
  return apiCall('translate', { text, target }, 'POST');
}

// ──────────────────────────────────────────────────────────────
// New AI Features (Groq Llama via ai-router)
// ──────────────────────────────────────────────────────────────

// 1. Detect bill/boleto from email body
export async function aiDetectBoleto(body) {
  return apiCall('ai_detect_boleto', { body }, 'POST');
}

// 2. Detect package tracking codes
export async function aiDetectTracking(body, subject = '') {
  return apiCall('ai_detect_tracking', { body, subject }, 'POST');
}

// 3. Detect meeting → suggest calendar event
export async function aiDetectMeeting(text) {
  return apiCall('ai_detect_meeting', { text }, 'POST');
}

// 4. Translate text (universal, replaces old translate)
export async function aiTranslate(text, target = 'pt-BR') {
  return apiCall('ai_translate', { text, target }, 'POST');
}

// 5. Tone check before sending (warn if hostile)
export async function aiToneCheck(text) {
  return apiCall('ai_tone_check', { text }, 'POST');
}

// 6. Smart categorize (work/personal/financial/travel/...)
export async function aiSmartCategorize(subject, body, from = '') {
  return apiCall('ai_smart_categorize', { subject, body, from }, 'POST');
}

// 7. Detect newsletter unsubscribe link
export async function aiDetectUnsubscribe(body, headers = '') {
  return apiCall('ai_detect_unsubscribe', { body, headers }, 'POST');
}

// 8. Follow-up reminder (sent emails awaiting reply)
export async function aiFollowupReminder(sentEmails) {
  return apiCall('ai_followup_reminder', { sent_emails: sentEmails }, 'POST');
}

// 9. Quick replies (3 short button suggestions for chat)
// Now accepts an array of messages for FULL conversation context
// Old signature still works: aiQuickReplies("just last msg")
export async function aiQuickReplies(messageOrArray, myName = null) {
  if (Array.isArray(messageOrArray)) {
    return apiCall('ai_quick_replies', {
      messages: messageOrArray,
      my_name: myName || 'EU',
    }, 'POST');
  }
  return apiCall('ai_quick_replies', { message: messageOrArray }, 'POST');
}

// 10. Extract event from natural text ("amanhã 15h café Pedro")
export async function aiExtractEvent(text) {
  return apiCall('ai_extract_event', { text }, 'POST');
}

// 11. Weekly calendar summary
export async function aiWeeklySummary(events) {
  return apiCall('ai_weekly_summary', { events }, 'POST');
}

// 12. Action items from meeting transcript
export async function aiActionItems(transcript) {
  return apiCall('ai_action_items', { transcript }, 'POST');
}

// 13. Semantic file search by description
export async function aiFileSearch(query, files) {
  return apiCall('ai_file_search', { query, files }, 'POST');
}

// 14. Detect leaked secrets (password, token, card) before sending
export async function aiDetectLeak(text) {
  return apiCall('ai_detect_leak', { text }, 'POST');
}

// 15. Extract financial amounts from text
export async function aiExtractAmount(text) {
  return apiCall('ai_extract_amount', { text }, 'POST');
}

// 16. Universal natural-language search (cross-source)
export async function aiUniversalSearch(query, items) {
  return apiCall('ai_universal_search', { query, items }, 'POST');
}

// 17. Voice command parser
export async function aiVoiceCommand(text, { language } = {}) {
  const body = { text };
  if (language) body.language = language;
  return apiCall('ai_voice_command', body, 'POST');
}

// 18. Transcribe audio file (Whisper Groq) — uses multipart upload.
// AbortController + 45s timeout prevents the React Native `fetch` from hanging
// forever on stalled cellular connections (the "mic stays listening" bug).
// On Android we copy content:// URIs to a file:// path so RN's FormData
// serializer can read them (it can't read ContentProvider URIs directly).
export async function aiTranscribeAudio(audioUri, { timeoutMs = 45000 } = {}) {
  if (!audioUri) throw new Error('no audio uri');
  let uri = audioUri;
  if (Platform.OS === 'android' && typeof uri === 'string' && uri.startsWith('content://')) {
    try {
      let FileSystem; try { FileSystem = require('expo-file-system/legacy'); } catch { FileSystem = require('expo-file-system'); }
      const dest = FileSystem.cacheDirectory + `whisper-${Date.now()}.m4a`;
      await FileSystem.copyAsync({ from: uri, to: dest });
      uri = dest;
    } catch {}
  }
  const form = new FormData();
  form.append('audio', { uri, name: 'audio.m4a', type: 'audio/m4a' });
  const url = `${BASE_URL || 'https://chatyy.com.br'}/api/email.php?action=ai_transcribe_audio`;
  // NEVER set Content-Type manually — RN must append the multipart boundary itself.
  const headers = { Accept: 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'POST', body: form, headers, signal: ctl.signal });
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch { throw new Error(`bad json (${resp.status}): ${text.slice(0, 200)}`); }
  } finally {
    clearTimeout(tid);
  }
}

// 19. Summarize already-transcribed audio
export async function aiSummarizeAudio(transcription) {
  return apiCall('ai_summarize_audio', { transcription }, 'POST');
}

// 20. Photo caption generator
export async function aiPhotoCaption(description, location = '', date = '') {
  return apiCall('ai_photo_caption', { description, location, date }, 'POST');
}

// 21. Sentiment analysis
export async function aiSentiment(text) {
  return apiCall('ai_sentiment', { text }, 'POST');
}

// 22. Suspicious link analysis
export async function aiLinkAnalysis(url) {
  return apiCall('ai_link_analysis', { url }, 'POST');
}

// 23. Chat spam detection
export async function aiChatSpamDetect(message, senderHistory = 0) {
  return apiCall('ai_chat_spam_detect', { message, sender_history: senderHistory }, 'POST');
}

// 24. Inbox Zero AI (group emails by urgency/action)
export async function aiInboxZero(emails) {
  return apiCall('ai_inbox_zero', { emails }, 'POST');
}

// 25. Sticker / emoji suggestion based on chat context
export async function aiStickerSuggest(context) {
  return apiCall('ai_sticker_suggest', { context }, 'POST');
}

// ──────────────────────────────────────────────────────────────
// Username @ system (Telegram-style handles)
// ──────────────────────────────────────────────────────────────
export async function chatUsernameCheck(username) {
  return apiCall('chat_username_check', { username }, 'POST');
}
export async function chatUsernameClaim(username) {
  return apiCall('chat_username_claim', { username }, 'POST');
}
export async function chatUsernameLookup(username) {
  return apiCall('chat_username_lookup', { username }, 'POST');
}

export async function photoFaces() {
  return apiCall('photo_faces', {}, 'POST');
}

export async function photoSuggestTags() {
  return apiCall('photo_suggest_tags', {}, 'POST');
}

// ============================================================
// Wave 14 — real face recognition (FaceNet embeddings + clustering)
// ============================================================

// Upsert per-file face boxes + 128-dim embeddings. The on-device pipeline
// (MediaPipe FaceLandmarker -> FaceNet ONNX) computes these locally and
// posts them after each photo finishes backing up. Server clusters via cosine.
export async function photosFaceEmbed(fileId, faces) {
  return apiCall('photos_face_embed', { file_id: fileId, faces }, 'POST');
}

// "Pessoas" tab: list every cluster the user has built up.
export async function photosFaceClusters() {
  return apiCall('photos_face_clusters', {}, 'POST');
}

// Tap a cluster -> all photos containing that face.
export async function photosFaceClusterPhotos(clusterId) {
  return apiCall('photos_face_cluster_photos', { cluster_id: clusterId }, 'POST');
}

// Long-press "Nomear pessoa" -> label the cluster.
export async function photosFaceClusterName(clusterId, personName) {
  return apiCall('photos_face_cluster_name', { cluster_id: clusterId, person_name: personName }, 'POST');
}

// ============================================================
// Wave 14 — photobook PDF generator
// ============================================================
export async function photosPhotobookCreate(ids, layout = 'grid', title = '') {
  return apiCall('photos_photobook_create', { ids, layout, title }, 'POST');
}

// ============================================================
// Wave 14 — AI enhancement / inpaint / sky / bokeh (Replicate-backed)
// ============================================================
export async function photosAiEnhance(photoId, mode = 'upscale') {
  return apiCall('photos_ai_enhance', { photo_id: photoId, mode }, 'POST');
}

export async function photosInpaint(photoId, maskBase64) {
  return apiCall('photos_inpaint', { photo_id: photoId, mask_base64: maskBase64 }, 'POST');
}

export async function photosSkyReplace(photoId, preset = 'sunset') {
  return apiCall('photos_sky_replace', { photo_id: photoId, preset }, 'POST');
}

export async function photosBokeh(photoId, strength = 0.7) {
  return apiCall('photos_bokeh', { photo_id: photoId, strength }, 'POST');
}

export async function fileSearch(query) {
  return apiCall('drive_search', { q: query });
}

export async function fileRecent() {
  return apiCall('drive_recent');
}

export async function fileShare(fileId, email, permission = 'view') {
  return apiCall('drive_share', { id: fileId, type: email ? 'email' : 'public', email, permission }, 'POST');
}

export async function fileSharedWithMe() {
  return apiCall('drive_shared_with_me');
}

export async function fileSharedByMe() {
  return apiCall('drive_shared_by_me');
}

export async function fileGetShared(fileId) {
  return apiCall('drive_get_shared', { id: fileId });
}

export async function fileUnshare(fileId, email) {
  return apiCall('drive_unshare', { id: fileId, email }, 'POST');
}

// ─── PUBLIC LINK SHARE (Dropbox / Drive style) ───
// /d/{token} resolves to /api/email.php?action=file_resolve_link on the public SPA.
// Backend: handlePublicFileLink + file_create_link/file_list_links/file_revoke_link in files.php.
export async function fileCreateLink(fileId, opts = {}) {
  const payload = { file_id: fileId };
  if (opts.password) payload.password = opts.password;
  if (opts.expiresInDays) payload.expires_in_days = opts.expiresInDays;
  if (opts.maxDownloads) payload.max_downloads = opts.maxDownloads;
  return apiCall('file_create_link', payload, 'POST');
}

export async function fileListLinks(fileId) {
  return apiCall('file_list_links', { file_id: fileId });
}

export async function fileRevokeLink(token) {
  return apiCall('file_revoke_link', { token }, 'POST');
}

export async function filePhotos(type = 'all', page = 1, limit = 50) {
  return apiCall('drive_photos', { type, page, limit });
}

export async function filePhotosTimeline(type = 'all', page = 1, limit = 100) {
  return apiCall('drive_photos_timeline', { type, page, limit });
}

export async function fileEmptyTrash() {
  return apiCall('drive_empty_trash', {}, 'POST');
}

export async function fileVersions(fileId) {
  return apiCall('drive_file_versions', { file_id: fileId });
}

export async function fileRestoreVersion(fileId, versionId) {
  return apiCall('drive_restore_version', { file_id: fileId, version_id: versionId }, 'POST');
}

// ─── ONE AI Assistant ───
// Ambient screen context the UI records so One knows where the user is
// when they ask it something — e.g. "liga pra quem ta ligando" works because
// the client tells One the current chat / active call.
let _oneScreenContext = {};
export function setOneScreenContext(ctx) { _oneScreenContext = { ...ctx, updated_at: Date.now() }; }
export function getOneScreenContext() { return _oneScreenContext; }

/**
 * Stream a One AI chat response via SSE.
 *
 * `callbacks` object:
 *   onDelta(text)          — called for each text chunk (string)
 *   onToolCall(name, args) — called when a tool is invoked server-side
 *   onToolResult(name, result) — called when a tool result arrives
 *   onMeta(meta)           — called with {conversation_id, actions?, message_id?, is_premium_prompt?}
 *   onDone()               — called when the stream finishes normally
 *   onError(msg)           — called on stream/network error
 *
 * Returns an AbortController so the caller can cancel the stream.
 * Falls back to null if ReadableStream is not available (very old environments).
 */
export function oneChatStream(message, conversationId = null, callbacks = {}, imageBase64 = null, imageMimeType = null, driveFileId = null) {
  const { onDelta, onToolCall, onToolResult, onMeta, onDone, onError } = callbacks;
  const tz = Intl?.DateTimeFormat?.()?.resolvedOptions?.()?.timeZone || 'America/Sao_Paulo';
  const locale = Intl?.DateTimeFormat?.()?.resolvedOptions?.()?.locale || '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  const body = {
    action: 'one_chat_stream',
    message,
    conversation_id: conversationId,
    timezone: tz,
    locale,
    screen_context: _oneScreenContext,
    // [WAVE 43A 2026-05-21] Hint that we want the fast model (gpt-4o-mini).
    // Backend already defaults to mini per memory openai_only_migration; we
    // pass the hint so future routing logic can read it without app churn.
    model: 'fast',
    prefer_fast: true,
  };
  if (imageBase64) { body.image_data = imageBase64; body.image_mime_type = imageMimeType || 'image/jpeg'; }
  if (driveFileId) { body.drive_file_id = driveFileId; }

  const headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', ...getAuthHeaders() };

  // Start the fetch — do not await, parse stream asynchronously.
  // Straight to PHP SSE (OpenAI-backed). The Rust/Anthropic shortcut was disabled
  // while the Anthropic billing is sorted out — OpenAI is the only path for now.
  (async () => {
    try {
      // [WAVE 43A 2026-05-21] Native React Native (iOS+Android) fetch
      // does NOT expose a streaming body by default — needs the RN-specific
      // `reactNative.textStreaming: true` flag. Without this, RN buffers the
      // whole SSE response → user waits 6-10s for first byte. With it, RN
      // exposes `res.body` as a ReadableStream we can consume chunk-by-chunk.
      const res = await fetch(`${API_URL}?action=one_chat_stream`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(body),
        signal: controller.signal,
        reactNative: { textStreaming: true },
      });

      clearTimeout(timeout);

      if (!res.ok) {
        if (onError) onError(`HTTP ${res.status}`);
        return;
      }

      // Check we actually got an event-stream (server might have returned JSON error)
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/event-stream')) {
        // Non-streaming fallback: parse as JSON
        try {
          const data = await res.json();
          if (data?.data?.response && onDelta) onDelta(data.data.response);
          if (data?.data?.conversation_id && onMeta) onMeta({ conversation_id: data.data.conversation_id, actions: data.data.actions || [] });
          if (onDone) onDone();
        } catch { if (onError) onError('Invalid response'); }
        return;
      }

      if (!res.body) { if (onError) onError('ReadableStream not supported'); return; }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      const processLine = (line) => {
        if (!line.startsWith('data: ')) return;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { if (onDone) onDone(); return; }
        try {
          const event = JSON.parse(raw);
          if (event.delta !== undefined && onDelta) onDelta(event.delta);
          else if (event.tool_call && onToolCall) onToolCall(event.tool_call.name, event.tool_call.args);
          else if (event.tool_result && onToolResult) onToolResult(event.tool_result.name, event.tool_result.result);
          else if (event.meta && onMeta) onMeta(event.meta);
          else if (event.error && onError) onError(event.error);
        } catch { /* ignore malformed SSE lines */ }
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by double newline
        const parts = buffer.split('\n\n');
        buffer = parts.pop(); // keep incomplete last chunk
        for (const part of parts) {
          for (const line of part.split('\n')) {
            processLine(line.trim());
          }
        }
      }
      // Process any remaining buffered data
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) processLine(line.trim());
      }
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') return; // intentional cancel — no error
      if (onError) onError(err.message || 'Stream error');
    }
  })();

  return controller; // caller can call controller.abort() to cancel
}

// Rust One availability probe (cached).
// Force-disabled 2026-04-20 — the chatyy-one-api Rust service still calls
// Claude Haiku directly (Anthropic credits exhausted), so every request hits
// "AI unavailable" → frontend shows one.errorProcess. Route everything through
// PHP one.php which was already migrated to OpenAI. Re-enable when the Rust
// binary is rebuilt against OpenAI.
let _rustOneAvailable = false;
async function _probeRustOne() {
  return false;
}

export async function oneChat(message, conversationId = null, imageBase64 = null, imageMimeType = null, driveFileId = null) {
  const tz = Intl?.DateTimeFormat?.()?.resolvedOptions?.()?.timeZone || 'America/Sao_Paulo';
  const locale = Intl?.DateTimeFormat?.()?.resolvedOptions?.()?.locale || '';

  // Rust path — Claude Haiku 4.5 + tools + persistent memory. Fast (~2s).
  // Vision and drive-file inputs still need PHP for now (complex to port).
  if (!imageBase64 && !driveFileId && (await _probeRustOne())) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 120000);
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const res = await fetch(`${BASE_URL}/api/rust/one/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message, locale, history: [] }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        // Frontend reads r.data.response (legacy key). Rust returns r.data.reply.
        // Normalize both so existing code works without changes.
        if (data?.success && data?.data) {
          if (data.data.reply && !data.data.response) data.data.response = data.data.reply;
          return data;
        }
      }
      if (res.status >= 500) _rustOneAvailable = false;
    } catch {
      _rustOneAvailable = false;
    }
  }

  // Fallback: PHP one.php
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const headers = { 'Content-Type': 'application/json', ...getAuthHeaders() };
    // [WAVE 43A 2026-05-21] same fast hint as streaming path so fallback
    // doesn't accidentally hit the smart/slow model.
    const body = { action: 'one_chat', message, conversation_id: conversationId, timezone: tz, locale, screen_context: _oneScreenContext, model: 'fast', prefer_fast: true };
    if (imageBase64) {
      body.image_data = imageBase64;
      body.image_mime_type = imageMimeType || 'image/jpeg';
    }
    if (driveFileId) {
      body.drive_file_id = driveFileId;
    }
    const res = await fetch(`${API_URL}?action=one_chat`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // [bug-fix 2026-05-18] Surface the actual HTTP error instead of falling
    // through to a generic "Erro de conexao". Before, anything non-2xx that
    // still parsed as JSON (401/429/503/etc.) just returned the body — which
    // is OK — but a non-JSON body (HTML 502 from nginx, FPM worker timeout
    // SSE half-stream, etc.) threw at .json() and the catch returned the
    // generic message, hiding the real cause from the user.
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch {}
      // Try JSON first (server-shaped error)
      try {
        const j = JSON.parse(body);
        if (j && typeof j === 'object') return j;
      } catch {}
      // Friendly hints per status — keeps the message actionable.
      const hint = res.status === 502 || res.status === 503 || res.status === 504
        ? 'Servidor sobrecarregado. Tente em alguns segundos.'
        : res.status === 401 ? 'Sessão expirada. Faça login novamente.'
        : res.status === 429 ? 'Limite de uso atingido. Tente mais tarde.'
        : `Erro do servidor (HTTP ${res.status}).`;
      return { success: false, message: hint, _http_status: res.status };
    }
    const data = await res.json();
    return data;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { success: false, message: 'A IA demorou demais para responder. Tente uma pergunta mais curta.' };
    }
    // [bug-fix 2026-05-18] Include the real error message so it shows up in
    // the chat bubble instead of the generic "Erro de conexao". Helps QA + the
    // user actually understand whether it's network, DNS, CORS, or backend.
    const detail = (err && (err.message || err.toString())) || 'desconhecido';
    return { success: false, message: 'Erro de rede: ' + detail };
  }
}

export async function oneHistory(conversationId = null) {
  return conversationId
    ? apiCall('one_history', { conversation_id: conversationId })
    : apiCall('one_history');
}

export async function oneStatus() {
  return apiCall('one_status');
}

// Delete uma conversa do histórico ONE (passe id) ou TUDO (clearAll=true).
export async function oneHistoryDelete({ conversationId, clearAll } = {}) {
  return apiCall('one_history_delete', {
    conversation_id: conversationId || 0,
    clear_all: !!clearAll,
  }, 'POST');
}

// ElevenLabs TTS — returns blob URL (web) or null on failure
export async function oneTTS(text) {
  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  try {
    const res = await fetch(`${API_URL}?action=one_tts`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      credentials: 'include',
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch (e) {
    if (__DEV__) console.warn('[api] oneTTS error:', e?.message);
    return null;
  }
}

// ElevenLabs TTS — returns direct URL for native playback (expo-av / Audio)
export function oneTTSUrl(text) {
  const token = authToken || '';
  return `${API_URL}?action=one_tts&text=${encodeURIComponent(text)}&token=${token}`;
}

// ============================================================
// FEED API
// ============================================================
export async function feedCreatePost(formData) {
  formData.append('action', 'feed_create_post');
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    const resp = await fetch(`${API_URL}?action=feed_create_post`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.json();
  } catch (e) {
    return { success: false, message: e.message };
  }
}

export async function feedList(pageOrOpts = 1, limit = 20) {
  if (typeof pageOrOpts === 'object') {
    return apiCall('feed_list', pageOrOpts, 'POST');
  }
  return apiCall('feed_list', { page: pageOrOpts, limit }, 'POST');
}

// Suggestion rail in the feed (follows people the viewer doesn't already
// follow, ranked by mutual_count). Thin wrapper over the existing
// `follow_suggestions` backend so callers don't have to know the action name.
export async function followSuggestions(limit = 10) {
  return apiCall('follow_suggestions', { limit }, 'POST');
}

// ─── Feed P0 / FYP support ───
// hide a post + send a negative signal so the FYP ranker stops surfacing it.
// `signal` is one of 'not_interested' | 'hide' | 'see_less'. 'see_less' also
// triggers a topic-extraction downweight server-side.
export async function feedHidePost(postId, signal = 'not_interested') {
  return apiCall('chat_feed_hide_post', { post_id: postId, signal }, 'POST');
}
// Muted-words CRUD. List, add, remove.
export async function feedMutedWordsList() {
  return apiCall('feed_muted_words_list', {}, 'POST');
}
export async function feedMutedWordsAdd(word) {
  return apiCall('feed_muted_words_add', { word: String(word || '') }, 'POST');
}
export async function feedMutedWordsRemove(word) {
  return apiCall('feed_muted_words_remove', { word: String(word || '') }, 'POST');
}

export async function feedUserPosts(email, page = 1) {
  return apiCall('feed_user_posts', { email, page }, 'POST');
}

export async function feedHashtagPosts(tag, page = 1, limit = 20) {
  return apiCall('feed_hashtag_posts', { tag, page, limit });
}

// ─── Reels P0 ───
// chat_reels_by_sound — list reels using the same audio. sound_id is TEXT
// (numeric track id from the picker, or "<creator_email>/<post_id>" for an
// original sound). Returns { posts, sound_id, sound_label, page, has_more }.
export async function chatReelsBySound(soundId, page = 1, limit = 20) {
  return apiCall('chat_reels_by_sound', { sound_id: String(soundId || ''), page, limit }, 'POST');
}
// chat_reels_duet_init / chat_reels_stitch_init — fetch the parent video URL +
// flags so the client can capture a side-by-side companion clip (duet) or
// trim + append (stitch). Both honour the per-post allow_duet / allow_stitch
// toggles.
export async function chatReelsDuetInit(postId) {
  return apiCall('chat_reels_duet_init', { post_id: postId }, 'POST');
}
export async function chatReelsStitchInit(postId) {
  return apiCall('chat_reels_stitch_init', { post_id: postId }, 'POST');
}
// chat_feed_trending_hashtags — top hashtags parsed out of feed captions over
// the last 24h. Surfaced in Discover.
export async function chatFeedTrendingHashtags(limit = 20) {
  return apiCall('chat_feed_trending_hashtags', { limit }, 'POST');
}
// duet-compose.php endpoint — server-side ffmpeg composite. Returns
// { media_url, thumbnail_url, duet_type, parent_post_id } that feedCreatePost
// can publish via the media_url= path. multipart/form-data.
export async function duetCompose(formData) {
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240000);
    const resp = await fetch(`${API_URL.replace(/email\.php.*$/, 'duet-compose.php')}`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.json();
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Chat hashtag trending + search (Telegram-style) ───
// chat_hashtag_trending returns { tags: [{hashtag, mentions, last_used}, ...] }
// scoped to PUBLIC channels (discoverable=true) over the last 7 days.
// chat_hashtag_search returns recent messages tagged with `tag` from public
// channels (limit 50 server-side).
export async function chatHashtagTrending(limit = 20) {
  return apiCall('chat_hashtag_trending', { limit }, 'POST');
}
export async function chatHashtagSearch(tag) {
  return apiCall('chat_hashtag_search', { tag: String(tag || '').replace(/^#/, '') }, 'POST');
}

export async function vacationGet() {
  return apiCall('vacation_get');
}

export async function vacationSet({ enabled, start_date = null, end_date = null, subject = '', body = '', only_contacts = false }) {
  return apiCall('vacation_set', { enabled, start_date, end_date, subject, body, only_contacts }, 'POST');
}

export async function confidentialCreate({ recipient, subject = '', body, expiry_days = 7, passcode = '', sms_phone = '' }) {
  return apiCall('confidential_create', { recipient, subject, body, expiry_days, passcode, sms_phone }, 'POST');
}

export async function confidentialView(id, passcode = '') {
  return apiCall('confidential_view', { id, passcode }, 'POST');
}

export async function feedLike(postId) {
  return apiCall('feed_like', { post_id: postId }, 'POST');
}

export async function feedLikers(postId) {
  return apiCall('feed_likers', { post_id: postId }, 'POST');
}
export async function feedView(postId) {
  return apiCall('feed_view', { post_id: postId }, 'POST');
}

export async function feedComment(postId, content, replyToId, opts = {}) {
  // Reels P1 — sticker / video / image comment reply. When the user
  // taps the GIF icon or compact-camera icon in FeedComments, we pass
  // { attachmentUrl|mediaUrl, mediaType } so the backend stores it on
  // chat_feed_comments.media_url + media_type. Text content can be
  // empty when a media reply is sent.
  const body = { post_id: postId, content: content || '', reply_to_id: replyToId };
  const m = opts.mediaUrl || opts.attachmentUrl || '';
  if (m) {
    body.media_url = m;
    body.attachment_url = m; // legacy alias older clients read
    body.media_type = opts.mediaType || 'sticker';
  }
  return apiCall('feed_comment', body, 'POST');
}

export async function feedComments(postId, page = 1) {
  return apiCall('feed_comments', { post_id: postId, page }, 'POST');
}

export async function feedDeleteComment(commentId) {
  return apiCall('feed_delete_comment', { comment_id: commentId }, 'POST');
}

export async function feedCommentLikeToggle(commentId) {
  return apiCall('feed_comment_like_toggle', { comment_id: commentId }, 'POST');
}

// ── Captions / read receipts / highlights / voice comments ──

// Save Whisper-derived caption segments on a feed/reel post (owner only).
export async function feedPostSetSubtitles(postId, subtitles) {
  return apiCall('feed_post_set_subtitles', { post_id: postId, subtitles }, 'POST');
}

// Same shape, but for status (24h stories).
export async function statusSetSubtitles(statusId, subtitles) {
  return apiCall('status_set_subtitles', { status_id: statusId, subtitles }, 'POST');
}

// List read-receipts for the logged-in sender. Used by EmailReader to show
// "Lido em ..." badges on outgoing messages.
export async function trackOpenList() {
  return apiCall('track_open_list');
}

// Highlights — Stories permanentes salvos no perfil.
export async function statusHighlightCreate(name, statusIds = [], coverUrl = '') {
  return apiCall('status_highlight_create', { name, status_ids: statusIds, cover_url: coverUrl }, 'POST');
}
export async function statusHighlightList(email) {
  return apiCall('status_highlight_list', { email: email || '' }, 'POST');
}
export async function statusHighlightAddStatus(highlightId, statusId) {
  return apiCall('status_highlight_add_status', { highlight_id: highlightId, status_id: statusId }, 'POST');
}
export async function statusHighlightDelete(highlightId) {
  return apiCall('status_highlight_delete', { highlight_id: highlightId }, 'POST');
}
// Resolve a highlight's curated status ids → full status rows (media_url, type,
// bg_color, meta, ...). Skips the 24h expires_at filter so highlights persist
// after the source statuses age out. See chat.php case 'status_highlight_items'.
export async function statusHighlightItems(highlightId) {
  return apiCall('status_highlight_items', { highlight_id: highlightId }, 'POST');
}

// [2026-05-18 IG-Pro] Update the cover image of a highlight. Pass either a
// raw cover_url (from a custom upload) OR a status_id whose media_url will
// be used (Instagram's "choose from current stories" picker).
export async function statusHighlightUpdateCover(highlightId, { coverUrl = '', statusId = 0 } = {}) {
  const body = { highlight_id: highlightId };
  if (statusId) body.status_id = statusId;
  if (coverUrl) body.cover_url = coverUrl;
  return apiCall('status_highlight_update_cover', body, 'POST');
}
// [2026-05-18 IG-Pro] Rename a highlight (title only; cover/contents unchanged).
export async function statusHighlightRename(highlightId, title) {
  return apiCall('status_highlight_rename', { highlight_id: highlightId, title }, 'POST');
}
// [2026-05-18 IG-Pro] Persist the user-chosen order. positions is an array of
// highlight ids in the order they should display. Backend writes an INT
// `position` column and list endpoint sorts by it.
export async function statusHighlightReorder(positions) {
  return apiCall('status_highlight_reorder', { positions }, 'POST');
}
// [2026-05-18 IG-Pro] Remove a single status from a highlight without
// touching the underlying chat_user_status row.
export async function statusHighlightRemoveStatus(highlightId, statusId) {
  return apiCall('status_highlight_remove_status', { highlight_id: highlightId, status_id: statusId }, 'POST');
}
// [2026-05-18 IG-Pro] Owner-only aggregate viewer count across all clips.
export async function statusHighlightStats(highlightId) {
  return apiCall('status_highlight_stats', { highlight_id: highlightId }, 'POST');
}

// Voice comment on a feed post — multipart upload of an audio blob/uri.
// Returns { success, data: { id, audio_url, ... } } same shape as feedComment.
export async function feedVoiceComment(postId, audio, replyToId = null) {
  const formData = new FormData();
  formData.append('action', 'feed_voice_comment');
  formData.append('post_id', String(postId));
  if (replyToId) formData.append('reply_to_id', String(replyToId));
  if (Platform.OS === 'web' && audio?.blob) {
    formData.append('audio', audio.blob, audio.name || 'voice.m4a');
  } else if (audio?.uri) {
    formData.append('audio', { uri: audio.uri, name: audio.name || 'voice.m4a', type: audio.type || 'audio/m4a' });
  } else if (audio instanceof Blob || audio instanceof File) {
    formData.append('audio', audio, audio.name || 'voice.m4a');
  } else {
    return { success: false, message: 'invalid audio' };
  }
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    const res = await fetch(`${API_URL}?action=feed_voice_comment`, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
    });
    return await res.json();
  } catch (e) {
    return { success: false, message: 'Upload failed' };
  }
}

export async function accountDataExport() {
  return apiCall('account_data_export', {}, 'POST');
}

export async function feedDeletePost(postId) {
  return apiCall('feed_delete_post', { post_id: postId }, 'POST');
}

export async function feedBookmark(postId) {
  return apiCall('feed_bookmark', { post_id: postId }, 'POST');
}

export async function feedPinPost(postId) {
  return apiCall('feed_pin_post', { post_id: postId }, 'POST');
}

export async function feedUnpinPost(postId) {
  return apiCall('feed_unpin_post', { post_id: postId }, 'POST');
}

export async function feedBookmarks(page = 1) {
  return apiCall('feed_bookmarks', { page }, 'POST');
}

// ============================================================
// IN-APP NOTIFICATIONS (feed likes, comments, follows)
// ============================================================
export async function notificationsList(page = 1, limit = 30) {
  return apiCall('notifications_list', { page, limit }, 'POST');
}
// [WAVE 100] Compact manifest — id/type/actor/read/created_at only, ~5KB for
// 50 rows. Use to detect "nothing changed" before triggering heavy list.
export async function notificationsManifest(limit = 50) {
  return apiCall('notifications_manifest', { limit }, 'POST');
}
export async function notificationsMarkRead(id) {
  return apiCall('notifications_mark_read', id ? { id } : {}, 'POST');
}
export async function notificationsUnreadCount() {
  return apiCall('notifications_unread_count', {}, 'POST');
}
export async function notificationsDelete(id) {
  return apiCall('notifications_delete', { id }, 'POST');
}
// Mark notifications read. Accepts { all:true } (mark every unread),
// { ids:[...] } (mark a list — backend takes one id per call, so fan out),
// or { id } / bare id. Previously this fn didn't exist → NotificationsHub's
// mark-as-read silently no-op'd and the unread badge never cleared.
export async function notificationsRead(opts = {}) {
  if (opts && opts.all) return apiCall('notifications_mark_read', {}, 'POST');
  if (opts && Array.isArray(opts.ids)) {
    const results = await Promise.all(
      opts.ids.map((id) => apiCall('notifications_mark_read', { id }, 'POST').catch(() => null))
    );
    return { success: true, data: { results } };
  }
  const id = (opts && typeof opts === 'object') ? opts.id : opts;
  return apiCall('notifications_mark_read', id ? { id } : {}, 'POST');
}
// Upcoming scheduled lives. scope 'followed' = lives from hosts you follow,
// 'mine' = your own. Returns { items:[...] }. live-discover.js fell back to
// skeletons because this fn was missing; now it surfaces real upcoming lives.
export async function liveScheduled(scope = 'followed') {
  return apiCall('live_schedule_list', { scope }, 'POST');
}
// Report a status (story). Delegates to chat_report_user (confirmed handler).
// ChatStatusTab's report option silently no-op'd before this existed.
export async function statusReport(targetEmail, reason = 'inappropriate_status') {
  return apiCall('chat_report_user', { email: targetEmail, reason }, 'POST');
}

// ============================================================
// FOLLOW / PROFILE API
// ============================================================
export async function followUser(targetEmail) {
  return apiCall('follow_user', { target_email: targetEmail }, 'POST');
}
export async function unfollowUser(targetEmail) {
  return apiCall('unfollow_user', { target_email: targetEmail }, 'POST');
}
export async function getFollowers(email, page = 1) {
  return apiCall('get_followers', { email, page });
}
export async function getFollowing(email, page = 1) {
  return apiCall('get_following', { email, page });
}
export async function getPublicProfile(email) {
  return apiCall('get_public_profile', { email });
}
// Unified profile: identity + presence + social + posts + reels + shared
// media + common chats + actions + self_only in one call.
export async function profileGet(emailOrUsername) {
  const isEmail = typeof emailOrUsername === 'string' && emailOrUsername.includes('@');
  return apiCall('profile_get', isEmail ? { email: emailOrUsername } : { username: emailOrUsername });
}
export async function getMutualFollowers(email) {
  return apiCall('mutual_followers', { target_email: email });
}

// ============================================================
// LIVE STREAMING API
// ============================================================
export async function liveStart(title, opts = {}) {
  // Optional extras: audience (public/friends/private), category (1 of 8
  // backend-known keys), subscribersOnly (creator-sub gating). Forward only
  // truthy values so old callers stay byte-compatible.
  const payload = { title };
  if (opts && opts.audience) payload.audience = opts.audience;
  if (opts && opts.category) payload.category = opts.category;
  if (opts && opts.subscribersOnly) payload.subscribers_only = 1;
  return apiCall('live_start', payload, 'POST');
}
export async function liveEnd(sessionId, opts = {}) {
  // `save_replay` lets the host opt-out of the CF Stream VOD being kept
  // around as a replay. Backend default = true (most hosts want it).
  const payload = { session_id: sessionId };
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'save_replay')) {
    payload.save_replay = opts.save_replay ? 1 : 0;
  }
  return apiCall('live_end', payload, 'POST');
}
export async function liveEndCf(sessionId, opts = {}) {
  const payload = { session_id: sessionId };
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'save_replay')) {
    payload.save_replay = opts.save_replay ? 1 : 0;
  }
  return apiCall('live_end_cf', payload, 'POST');
}
// LiveKit live end — closes the chat_live_sessions row + stops LK Egress.
// Without this, the legacy `liveEnd` action returns 400 and rows stay
// status='live' forever (incident 2026-05-21: profile "AO VIVO" eterno).
export async function liveEndLk(sessionId, opts = {}) {
  const payload = { session_id: sessionId };
  if (opts && 'save_replay' in opts) payload.save_replay = opts.save_replay ? 1 : 0;
  return apiCall('live_end_lk', payload, 'POST');
}
// Cloudflare Stream pipeline (managed ingest + HLS/DASH + automatic VOD).
// Returns { sessionId, cf_input_uid, rtmps_url, rtmps_key, srt_url,
// srt_passphrase, srt_stream_id, webrtc_url (WHIP), hls_url, dash_url }.
// Host publishes via one of the ingest URLs (WHIP from browser, RTMPS from
// OBS, SRT from pro encoders). Viewers consume hls_url. Recording is
// automatic — `cron-live-recordings.php` finalizes the VOD URLs onto
// chat_live_sessions within ~30-120s after `liveEndCf`.
export async function liveStartCf(title, opts = {}) {
  const payload = { title: title || 'Live' };
  if (opts && opts.audience) payload.audience = opts.audience;
  if (opts && opts.category) payload.category = opts.category;
  if (opts && opts.subscribersOnly) payload.subscribers_only = 1;
  // [LIVE-VOD-TRACE] Wave 44 — be explicit. Backend default is true but
  // passing save_replay=1 here removes any ambiguity for ops digging into
  // logs when a host opens a CF live (the broadcast UI always sets the
  // toggle ON by default, so wantsCf path here always wants the VOD).
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'save_replay')) {
    payload.save_replay = opts.save_replay ? 1 : 0;
  } else {
    payload.save_replay = 1;
  }
  try { console.log('[LIVE-VOD-TRACE] liveStartCf payload', payload); } catch {}
  return apiCall('live_start_cf', payload, 'POST');
}
// Status probe — checks CF Stream for a session (live_input_status, viewers,
// connected, etc.). Used by the broadcaster UI to flip "AO VIVO" only after
// CF confirms the input is receiving frames.
export async function liveStatusCf(sessionId) {
  return apiCall('live_status_cf', { session_id: sessionId }, 'POST');
}
// ─── LiveKit SFU pipeline — WAVE 110 ───
// Host: create LK room + mint publish token. Viewer: subscribe-only token.
// Both resolve to { session_id, lk_room, lk_url, lk_token, pipeline:'livekit' }.
//
// [2026-05-21 device_id propagation] Backend Agent A adds an identity suffix
// derived from device_id so multi-device sessions don't collide in LK. Without
// device_id in the payload, backend falls back to a random per-request value
// and the dedup logic on identity breaks. Lazy require avoids circular deps
// (services/e2e.js itself requires('./api')).
async function _getDeviceIdSafe() {
  try {
    const _e2e = require('./e2e');
    if (_e2e && typeof _e2e.getDeviceId === 'function') {
      const _id = await _e2e.getDeviceId();
      if (_id && typeof _id === 'string') return _id;
    }
  } catch {}
  return null;
}
export async function liveStartLk(title, opts = {}) {
  const payload = { title: title || 'Live' };
  if (opts && opts.audience) payload.audience = opts.audience;
  if (opts && opts.category) payload.category = opts.category;
  if (opts && opts.subscribersOnly) payload.subscribers_only = 1;
  const _did = await _getDeviceIdSafe();
  if (_did) payload.device_id = _did;
  return apiCall('live_start_lk', payload, 'POST');
}
export async function liveJoinLk(sessionId) {
  const payload = { session_id: sessionId };
  const _did = await _getDeviceIdSafe();
  if (_did) payload.device_id = _did;
  return apiCall('live_join_lk', payload, 'POST');
}
export async function liveStatusLk(sessionId) {
  return apiCall('live_status_lk', { session_id: sessionId }, 'POST');
}
// List CF Stream live sessions (host-only — own sessions).
export async function liveListCf() { return apiCall('live_list_cf', {}, 'POST'); }
export async function liveList() { return apiCall('live_list', {}, 'POST'); }
export async function liveUpdateViewers(sessionId, count) { return apiCall('live_update_viewers', { session_id: sessionId, viewer_count: count }, 'POST'); }
export async function liveSendChat(sessionId, content) { return apiCall('live_send_chat', { session_id: sessionId, content }, 'POST'); }
// Floating-heart reaction. Frontend prefers WebSocket (sub-100ms latency) so
// this REST fallback is only hit when the socket is closed/auth-pending —
// keeps tap-spam reactions landing on other viewers even during reconnects.
// Server clamps to 5/sec per-user-per-live independent of the client throttle.
export async function liveReaction(sessionId, x = null, color = null, emoji = null) {
  const payload = { session_id: sessionId };
  if (typeof x === 'number') payload.x = Math.max(0, Math.min(1, x));
  if (typeof color === 'string') payload.color = color;
  if (typeof emoji === 'string' && emoji) payload.emoji = emoji;
  return apiCall('chat_live_reaction', payload, 'POST');
}
export async function liveChatHistory(sessionId, limit = 50) { return apiCall('live_chat_history', { session_id: sessionId, limit }, 'POST'); }

// Top gifters leaderboard for a live session. Returns up to `limit` gifters
// ordered by total_diamonds desc. Used by LiveTopGifters (top-right stacked
// avatars + full leaderboard modal on tap).
export async function liveTopGifters(sessionId, limit = 50) {
  return apiCall('chat_live_top_gifters', { session_id: sessionId, limit }, 'POST');
}

// Send a virtual gift to a live session. Backend writes to chat_live_gifts +
// broadcasts a `live_gift` WS event so all viewers + host see the animation.
// No real money — diamonds are virtual / ungated at this stage. `giftType`
// must match a row in the server-side GIFT_CATALOG (rose, heart, star, crown,
// fire, rocket).
export async function liveSendGift(sessionId, giftType) {
  return apiCall('chat_live_send_gift', { session_id: sessionId, gift_type: giftType }, 'POST');
}

// ─── Live discovery + categories (P0 monetization parity, 2026-05-17) ───
// 8 fixed categories — backend returns label_en/label_pt + icon + accent color.
// Cached in-memory by callers (rarely changes).
export async function liveCategories() {
  return apiCall('live_categories', {}, 'POST');
}
// Top-50 active lives ordered by current_viewers DESC, started_at DESC.
// `category` optional — pass '' or null for "all categories" rail.
// Backend hides subscriber-only lives the viewer doesn't have access to.
export async function liveDiscover(category = '', opts = {}) {
  const payload = {};
  // `for_you` is a client-side pseudo-category — it maps to the
  // personalized feed flag, not a backend category key.
  if (category && category !== 'for_you') payload.category = category;
  if (category === 'for_you' || opts.personalized) payload.personalized = 1;
  return apiCall('live_discover', payload, 'POST');
}
// Host updates the category / subscriber-gate of their active live. The
// pre-live screen calls this right after liveStart succeeds so the rail
// can filter immediately.
export async function liveSetCategory(sessionId, category, subscribersOnly = false) {
  return apiCall('live_set_category', {
    session_id: sessionId,
    category: category || '',
    subscribers_only: subscribersOnly ? 1 : 0,
  }, 'POST');
}

// ─── Live quizzes (P1 — extends the polls infrastructure) ───
// Host opens a 1-question quiz. `correctIdx` is the 0-based index of the
// correct option in `options[]`. Backend hides correct_idx from viewers
// until liveQuizClose broadcasts `live_quiz_result`.
export async function liveQuizStart(sessionId, question, options, correctIdx) {
  return apiCall('live_quiz_start', {
    session_id: sessionId,
    question: String(question || '').slice(0, 280),
    options: (Array.isArray(options) ? options : []).slice(0, 6).map(o => String(o || '').slice(0, 120)),
    correct_idx: Number(correctIdx) || 0,
  }, 'POST');
}
// Viewer answers — INSERT-only, dedup by (quiz_id, voter_email).
export async function liveQuizAnswer(quizId, answerIdx) {
  return apiCall('live_quiz_answer', { quiz_id: quizId, answer_idx: Number(answerIdx) }, 'POST');
}
// Host closes the quiz — backend broadcasts `live_quiz_result` with per-option
// tallies + total + correct_idx so viewers can finally render correctness.
export async function liveQuizClose(quizId) {
  return apiCall('live_quiz_close', { quiz_id: quizId }, 'POST');
}

// ─── Diamond wallet + paid gifts (P1 monetization scaffolding) ───
// Read the signed-in user's diamond balance + pending creator payout.
export async function walletBalance() {
  return apiCall('wallet_balance', {}, 'POST');
}
// IAP purchase callback — credits the wallet with the diamond pack for the
// given SKU. On iOS we pass `transaction_id` + `receipt` so the backend can
// re-verify with App Store Server API (same code path as iap_verify_receipt).
// On Android we pass the receipt blob (Google Play Developer API verification
// is on the roadmap; for now we credit and rely on Apple-style server
// reconciliation for refunds).
export async function walletBuyDiamonds(sku, { transactionId = '', receipt = '', platform = 'ios' } = {}) {
  return apiCall('wallet_buy_diamonds', {
    sku,
    platform,
    transaction_id: transactionId,
    receipt,
  }, 'POST');
}
// 2026-05-18 alias — preferred name for the new BRL diamond ladder. Backend
// case is set up so both action names hit the same handler; we expose this
// one to keep the iap.js → wallet flow self-documenting.
export async function walletTopupVerify(sku, { transactionId = '', receipt = '', platform = 'ios' } = {}) {
  return apiCall('wallet_topup_verify', {
    sku,
    platform,
    transaction_id: transactionId,
    receipt,
  }, 'POST');
}
// Peer-to-peer diamond send. Debits sender, credits receiver, emits
// `diamond_received` WS event on receiver's user channel + push notif.
// Returns { transfer_id, to_email, amount, diamond_balance } or
// { code: 'insufficient_diamonds', diamond_balance } on 402.
export async function walletSend(toEmail, amount, message = '') {
  return apiCall('wallet_send', {
    to_email: String(toEmail || '').toLowerCase(),
    amount: Number(amount) || 0,
    message: String(message || '').slice(0, 200),
  }, 'POST');
}
// Paginated ledger feed. items[] sorted newest first. Also returns the
// header balance so the screen renders without a second round-trip.
export async function walletHistory({ limit = 50, offset = 0 } = {}) {
  return apiCall('wallet_history', { limit, offset }, 'POST');
}
// Creator cashout — convert pending_payout_cents into a PIX request.
// Minimum R$ 50 (5000 cents). amountCents is the requested net payout.
// Backend creates a row in chat_wallet_payouts (status='pending') and a
// back-office worker actually settles the PIX. Returns the new pending
// balance + the payout id so the UI can append it to the history.
export async function walletCashoutRequest({
  amountCents, pixKey, pixKeyType = 'auto', fullName, cpf,
} = {}) {
  return apiCall('wallet_cashout_request', {
    amount_cents: Number(amountCents) || 0,
    pix_key: String(pixKey || '').trim(),
    pix_key_type: String(pixKeyType || 'auto').toLowerCase(),
    full_name: String(fullName || '').trim(),
    cpf: String(cpf || '').replace(/[^0-9]/g, ''),
  }, 'POST');
}
// List of past cashout requests for the signed-in user (newest first, max 50).
// Used by /wallet-cashout history table — status renders as pending/paid/rejected.
export async function walletCashoutList() {
  return apiCall('wallet_cashout_list', {}, 'POST');
}
// Single cashout detail — used by the detail modal in /wallet-cashout to
// show full PIX key + admin_note (when status='rejected'). 2026-05-20.
export async function walletCashoutDetail(payoutId) {
  return apiCall('wallet_cashout_detail', { payout_id: payoutId }, 'POST');
}
// [WAVE 51 2026-05-21] Aggregator endpoint for the /wallet hub. Returns
// EVERYTHING the wallet screen needs in one round-trip: balance, pending
// payout, ledger items, recent cashouts, saved Stripe cards, creator
// insights (month/lifetime, top fans). Falls back gracefully if the
// endpoint isn't deployed yet — caller should branch on response.success
// and fan out to legacy endpoints if needed. Supports pagination via
// limit/offset; with offset>0 only the ledger items panel is returned.
export async function walletOverview({ limit = 50, offset = 0 } = {}) {
  return apiCall('wallet_overview', { limit, offset }, 'POST');
}
// Daily login bonus — credits diamonds once per UTC day. Idempotent on
// the backend, so cheap to fire on every cold-start. Returns
// { granted: bool, amount, streak_days, diamond_balance }. 2026-05-20.
export async function walletDailyBonus() {
  return apiCall('wallet_daily_bonus', {}, 'POST');
}
// Creator-focused earnings dashboard. Single round-trip pull for
// /creator-earnings: pending_payout_cents, lifetime/month totals,
// gift counts, top fans (last 30d), and a paginated timeline of
// received gifts (newest first). `limit` controls timeline length.
export async function creatorEarningsSummary({ limit = 50 } = {}) {
  return apiCall('creator_earnings_summary', { limit }, 'POST');
}
// Paid gift send — debits diamond balance, credits 70% to creator as
// pending_payout_cents (30% platform retain). Returns the new balance.
export async function liveGiftSend(sessionId, giftSku) {
  return apiCall('live_gift_send', { session_id: sessionId, gift_sku: giftSku }, 'POST');
}
// Static catalog (6 paid gifts + 6 diamond packs). Mirrors backend so the
// gift sheet renders without hardcoding prices client-side.
export async function liveGiftCatalog() {
  return apiCall('live_gift_catalog', {}, 'POST');
}
// Toggle a (currently soft) subscription bond to a creator — months 1..12.
// Future: gate behind a creator-sub IAP SKU.
export async function liveSubscribeCreator(creator, months = 1) {
  return apiCall('live_subscribe_creator', { creator, months: Number(months) || 1 }, 'POST');
}

// ─── Reels — Rights-cleared music catalog (Pixabay-backed) ───
// Backend proxies https://pixabay.com/api/?category=music with a 1h cache.
// Each track returned has { id, title, artist, preview_url, duration_sec,
// image_url }. id is "pixabay/<numeric_id>".
//
// `mode` selects the popular catalog vs. a search query:
//   - 'catalog'  → reels_music_catalog (order=popular)
//   - 'search'   → reels_music_search  (q=…)
// Alternative (free): YouTube Audio Library — no machine-readable feed,
// requires manual download/ingest, not wired here.
export async function reelsMusicCatalog({ page = 1, perPage = 24 } = {}) {
  return apiCall('reels_music_catalog', { page, per_page: perPage }, 'POST');
}
export async function reelsMusicSearch(q, { page = 1, perPage = 24 } = {}) {
  return apiCall('reels_music_search', { q, page, per_page: perPage }, 'POST');
}

// ─── Reels — Tip a creator directly on a reel post (outside Live) ───
// Debits sender wallet, credits 70% to creator's pending_payout_cents.
// Same diamond catalog as Live gifts (gift_rose..gift_legend).
export async function feedPostTip(postId, giftSku) {
  return apiCall('feed_post_tip', { post_id: postId, gift_sku: giftSku }, 'POST');
}

// ─── Reels — Promote a post (paid boost via diamond wallet) ───
// Budget tiers: 500/1000/2500/5000/10000 cents ($5/$10/$25/$50/$100).
// Duration: 1..30 days. Inserts chat_feed_promotions row; the FYP ranker
// boosts the post score by 1.5x while is_active=1 and ends_at > now().
export async function feedPostPromote(postId, budgetCents, durationDays) {
  return apiCall('feed_post_promote', {
    post_id: postId,
    budget_cents: Number(budgetCents) || 0,
    duration_days: Number(durationDays) || 7,
  }, 'POST');
}

// ─── Reels — Save / unsave / list favorite sounds ───
// Powers the "Meus salvos" tab in CreatePostModal music picker and the
// 💾 button on the music marquee inside ReelsViewer.
export async function reelsSoundFavoriteSave(soundId, soundLabel, opts = {}) {
  return apiCall('reels_sound_favorite_save', {
    sound_id: soundId,
    sound_label: soundLabel,
    preview_url: opts.previewUrl || '',
    image_url: opts.imageUrl || '',
    duration_sec: Number(opts.durationSec) || 30,
  }, 'POST');
}
export async function reelsSoundFavoriteUnsave(soundId) {
  return apiCall('reels_sound_favorite_unsave', { sound_id: soundId }, 'POST');
}
export async function reelsSoundFavoriteList() {
  return apiCall('reels_sound_favorite_list', {}, 'POST');
}

// ─── Reels — Trending sounds (last 7d) ───
// Surfaces a "Trending sons" list on /search Sons tab + Discover page.
export async function reelsTrendingSounds(limit = 20) {
  return apiCall('reels_trending_sounds', { limit }, 'POST');
}

// ─── Creator dashboard (Pro tier) ───
// Aggregates subscriber_count + monthly_revenue_cents (subscriptions) +
// weekly/monthly tip revenue + top tippers + 7-day sparkline series for
// the logged-in creator. Surfaced as "Painel de criador" on /profile.
export async function creatorDashboard() {
  return apiCall('creator_dashboard', {}, 'POST');
}

// ─── Live shopping product cards (P1) ───
// Host adds a card to their active live. Up to 5 active per session.
export async function liveProductAdd(sessionId, { title, priceCents = 0, imageUrl = '', linkUrl }) {
  return apiCall('live_product_add', {
    session_id: sessionId,
    title,
    price_cents: Number(priceCents) || 0,
    image_url: imageUrl || '',
    link_url: linkUrl,
  }, 'POST');
}
export async function liveProductRemove(productId) {
  return apiCall('live_product_remove', { product_id: Number(productId) }, 'POST');
}
export async function liveProductsList(sessionId) {
  return apiCall('live_products_list', { session_id: sessionId }, 'POST');
}

// Live replay / recording endpoints. CF Stream auto-records every push
// session as a VOD; the backend polls live_inputs/{uid}/videos and stamps
// recording_url + recording_mp4 on chat_live_sessions. Frontend uses these
// wrappers to surface the replays in /lives-saved + the live-viewer
// end-card "Salvar live" tap.
export async function liveRecordingPoll(sessionId = null) {
  // Pass session_id for a focused single-session poll (used by host after
  // ending) or omit for a rolling 20-session sweep (used by /lives-saved).
  return apiCall('live_recording_poll', sessionId ? { session_id: sessionId } : {}, 'POST');
}
// Backwards-compatible. Old callers (`liveRecordingsList(50, 0)`) keep
// working; new callers can pass an options object — `liveRecordingsList({
// user_email: 'foo@bar' })` filters the result set to a specific host
// (used by Profile.js → Lives tab to surface a user's saved replays).
export async function liveRecordingsList(limitOrOpts = 50, offset = 0) {
  // Object form: { limit, offset, user_email }
  if (limitOrOpts && typeof limitOrOpts === 'object') {
    const o = limitOrOpts;
    const payload = {
      limit: typeof o.limit === 'number' ? o.limit : 50,
      offset: typeof o.offset === 'number' ? o.offset : 0,
    };
    if (o.user_email) payload.user_email = o.user_email;
    return apiCall('live_recordings_list', payload, 'POST');
  }
  // Legacy positional form.
  return apiCall('live_recordings_list', { limit: limitOrOpts, offset }, 'POST');
}
export async function liveSaveReplay(sessionId) {
  return apiCall('live_save_replay', { session_id: sessionId }, 'POST');
}
export async function liveUnsaveReplay(sessionId) {
  return apiCall('live_unsave_replay', { session_id: sessionId }, 'POST');
}
export async function liveRecordingGet(sessionId) {
  return apiCall('live_recording_get', { session_id: sessionId }, 'POST');
}
export async function liveRecordingDelete(sessionId) {
  return apiCall('live_recording_delete', { session_id: sessionId }, 'POST');
}

// ─── Live moderation + engagement endpoints ───
// Host pins a comment so it sticks above the live chat overlay. Backend
// persists it on chat_live_sessions and broadcasts WS `live_pin_comment` to
// every subscribed viewer. Empty `comment_text` unpins.
export async function chatLivePinComment(sessionId, commentText, commentAuthorName) {
  return apiCall('chat_live_pin_comment', {
    session_id: sessionId,
    comment_text: commentText || '',
    comment_author_name: commentAuthorName || '',
  }, 'POST');
}
export async function chatLiveUnpinComment(sessionId) {
  return apiCall('chat_live_pin_comment', {
    session_id: sessionId,
    comment_text: '',
    comment_author_name: '',
  }, 'POST');
}
// Host sets slow-mode (seconds between comments per viewer). 0 = disabled.
// Backend rejects subsequent live_chat from viewers under the cooldown and
// returns { code: 'slow_mode', wait_seconds } so the client can toast a hint.
export async function chatLiveSetSlowMode(sessionId, seconds) {
  return apiCall('chat_live_set_slow_mode', {
    session_id: sessionId,
    seconds: Number(seconds) || 0,
  }, 'POST');
}
// Host bans/kicks a viewer from the current live (and future ones if perm).
// Backend pushes WS `live_viewer_kicked` with viewer_email so the target's
// client can hang up immediately.
export async function chatLiveBanViewer(sessionId, viewerEmail, permanent = false) {
  return apiCall('chat_live_ban_viewer', {
    session_id: sessionId,
    viewer_email: viewerEmail,
    permanent: permanent ? 1 : 0,
  }, 'POST');
}
// Create a live poll (question + 2-4 options). Backend inserts row +
// broadcasts WS `live_poll_created` so both host + viewers paint the overlay.
export async function chatLivePollCreate(sessionId, question, options) {
  return apiCall('chat_live_poll_create', {
    session_id: sessionId,
    question: String(question || '').slice(0, 200),
    options: (Array.isArray(options) ? options : []).slice(0, 4).map(o => String(o || '').slice(0, 80)),
  }, 'POST');
}
// Viewer casts a single vote. Backend rejects duplicate votes by user/email
// and broadcasts WS `live_poll_voted` with the new tallies.
export async function chatLivePollVote(sessionId, pollId, optionIndex) {
  return apiCall('chat_live_poll_vote', {
    session_id: sessionId,
    poll_id: pollId,
    option_index: Number(optionIndex),
  }, 'POST');
}
// Host closes the active poll. Backend stamps closed_at + broadcasts
// `live_poll_closed`. Final tallies stay in the message so late viewers see
// the outcome via session info.
export async function chatLivePollClose(sessionId, pollId) {
  return apiCall('chat_live_poll_close', {
    session_id: sessionId,
    poll_id: pollId,
  }, 'POST');
}

// ─── Live scheduling (Calendar parity, 2026-05-17) ───
// Host pre-announces a live broadcast. Backend inserts chat_live_scheduled +
// the cron tick fans push to followers at start-15min and start+0.
export async function liveSchedule(startAt, title, opts = {}) {
  const payload = {
    start_at: typeof startAt === 'string' ? startAt : new Date(startAt).toISOString(),
    title: String(title || '').slice(0, 200),
  };
  if (opts.description) payload.description = String(opts.description).slice(0, 1000);
  if (opts.audience) payload.audience = opts.audience;
  if (opts.category) payload.category = opts.category;
  return apiCall('live_schedule', payload, 'POST');
}
export async function liveScheduleList(scope = 'mine') {
  return apiCall('live_schedule_list', { scope }, 'POST');
}
export async function liveScheduleCancel(id) {
  return apiCall('live_schedule_cancel', { id: Number(id) }, 'POST');
}

// ─── Multistream (RTMP fan-out to YouTube/Twitch/FB, 2026-05-17) ───
// Host adds an RTMP destination. Backend persists + calls LK Egress
// StartRoomCompositeEgress if broadcastId is set (live is hot). Returns
// { id, started, egress_id }.
export async function liveMultistreamAdd(rtmpUrl, streamKey, opts = {}) {
  return apiCall('live_multistream_add', {
    rtmp_url: String(rtmpUrl || '').trim(),
    stream_key: String(streamKey || '').trim(),
    broadcast_id: opts.broadcastId || '',
    label: opts.label || '',
  }, 'POST');
}
export async function liveMultistreamList(broadcastId = '') {
  return apiCall('live_multistream_list', { broadcast_id: broadcastId }, 'POST');
}
export async function liveMultistreamRemove(id) {
  return apiCall('live_multistream_remove', { id: Number(id) }, 'POST');
}

// ─── Diamond reaction (1 diamond = 1 paid floating heart, 2026-05-17) ───
// Debits caller's wallet, credits creator, broadcasts a gold heart particle.
// Returns { code: 'insufficient_diamonds' } on empty wallet — frontend opens
// the diamond top-up sheet.
export async function liveDiamondReaction(sessionId) {
  return apiCall('chat_live_diamond_reaction', { session_id: sessionId }, 'POST');
}

// ============================================================
// CALL HISTORY
// ============================================================
export async function callHistoryList(limit = 100, offset = 0) {
  return apiCall('chat_call_history_list', { limit, offset }, 'POST');
}
export async function callHistoryAdd(callData) {
  return apiCall('chat_call_history_add', {
    contact_email: callData.contactEmail,
    contact_name: callData.contactName || callData.contactEmail,
    call_id: callData.callId || '',
    type: callData.type || 'outgoing',
    video: callData.video ? 1 : 0,
    timestamp: callData.timestamp || Date.now(),
    duration: callData.duration || 0,
    is_group: callData.isGroup ? 1 : 0,
    participants: callData.participants || [],
  }, 'POST');
}
export async function callHistoryDelete(id) {
  return apiCall('chat_call_history_delete', { id }, 'POST');
}
export async function callHistoryClear() {
  return apiCall('chat_call_history_clear', {}, 'POST');
}
export async function uploadCallRecording(file, callHistoryId, callId) {
  const formData = new FormData();
  formData.append('action', 'call_recording_upload');
  if (callHistoryId) formData.append('call_history_id', String(callHistoryId));
  if (callId) formData.append('call_id', String(callId));
  if (Platform.OS === 'web' && file.blob) {
    formData.append('file', file.blob, file.name || 'recording.webm');
  } else {
    formData.append('file', {
      uri: file.uri,
      name: file.name || 'recording.m4a',
      type: file.type || 'audio/mp4',
    });
  }
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  try {
    const res = await fetch(`${API_URL}?action=call_recording_upload`, {
      method: 'POST', headers, body: formData,
      credentials: 'include', signal: controller.signal,
    });
    clearTimeout(timeout);
    return await res.json();
  } catch {
    clearTimeout(timeout);
    return { success: false, message: 'Recording upload failed' };
  }
}

// ============================================================
// VoIP DIALER
// ============================================================
export async function voipCall(toNumber, contactName = '', useCallback = false) {
  return apiCall('voip_call', { to_number: toNumber, contact_name: contactName, use_callback: useCallback ? '1' : '' }, 'POST');
}
export async function voipToken() {
  return apiCall('voip_token', {}, 'POST');
}
export async function voipMinutesRemaining() {
  return apiCall('voip_minutes_remaining', {}, 'POST');
}
export async function voipUpdateDuration(callId, durationSeconds, status = 'completed') {
  return apiCall('voip_update_duration', { call_id: callId, duration_seconds: durationSeconds, status }, 'POST');
}

// ============================================================
// DEEZER MUSIC SEARCH (for status music)
// ============================================================
export async function searchDeezerMusic(query) {
  if (!query || query.trim().length < 2) return [];

  // On web, Deezer API blocks CORS (no Access-Control-Allow-Origin header),
  // so always use our backend proxy. On native, try direct first.
  if (Platform.OS !== 'web') {
    try {
      const response = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=20&output=json`);
      if (response.ok) {
        const data = await response.json();
        if (!data.error && data.data && data.data.length > 0) {
          return data.data.map(track => ({
            id: track.id,
            title: track.title,
            artist: track.artist?.name || '',
            previewUrl: track.preview || '',
            coverUrl: track.album?.cover_medium || track.album?.cover || '',
            duration: track.duration || 30,
          }));
        }
      }
    } catch (err) {
      if (__DEV__) console.warn('[Deezer] Direct API failed, using proxy:', err.message);
    }
  }

  // Backend proxy (works on all platforms, avoids CORS on web)
  try {
    const r = await apiCall('deezer_search', { q: query }, 'POST');
    if (r?.success && Array.isArray(r.data?.tracks)) return r.data.tracks;
    // If API returned success but no tracks array, return empty
    if (r?.success) return [];
    if (__DEV__) console.warn('[Deezer] Backend proxy returned error:', r?.message, JSON.stringify(r));
  } catch (err) {
    if (__DEV__) console.warn('[Deezer] Backend proxy failed:', err.message);
  }
  return [];
}

// ============================================================
// USER SEARCH (Chatyy)
// ============================================================
export async function searchUsers(query) { return apiCall('search_users', { q: query }); }
export async function searchGlobal(query) { return apiCall('search_global', { q: query }); }

// Unified notifications hub (emails + chat mentions + follows + likes + comments)
export async function notificationsFeed() { return apiCall('notifications_feed'); }

// ============================================================
// PLANS API
// ============================================================
export async function planInfo() { return apiCall('plan_info'); }

// WAVE 75 (2026-05-21) — Storage system endpoints.
export async function storageUsage() { return apiCall('chat_storage_usage'); }
export async function storageTiers() { return apiCall('chat_storage_tiers'); }
export async function iapValidateStorage(payload) {
  return apiCall('iap_validate_storage', payload, 'POST');
}
export async function spotlightList(page = 1, limit = 10) {
  return apiCall('spotlight_list', { page, limit }, 'POST');
}

// Bots API
export async function botCreate(name, username, webhookUrl = '', description = '') {
  // Backend accepts `handle` (spec) or `username` (legacy) — send both for
  // forward compat with the spec'd schema.
  return apiCall('bot_create', {
    name,
    username,
    handle: username,
    webhook_url: webhookUrl,
    description,
  }, 'POST');
}
export async function botList() { return apiCall('bot_list', {}, 'POST'); }
// Spec'd alias — `botListMine` mirrors the documented bot_list_mine action.
export async function botListMine() { return apiCall('bot_list_mine', {}, 'POST'); }
// Public bot search by handle/name. Returns up to 50 matches.
export async function botSearch(query) { return apiCall('bot_search', { q: String(query || '') }, 'POST'); }
// Update the slash-command list for an owned bot. `commands` is an array of
// `{ name, description }` objects (description optional).
export async function botSetCommands(botId, commands) {
  return apiCall('bot_set_commands', { bot_id: botId, commands: Array.isArray(commands) ? commands : [] }, 'POST');
}
// Run a slash command on behalf of a bot in a conversation. Currently a
// stub on the backend — drops a system message to confirm the flow works.
export async function botInvokeCommand(botHandle, conversationId, command, args = '') {
  return apiCall('bot_invoke_command', {
    bot_handle: String(botHandle || '').replace(/^@/, ''),
    conversation_id: Number(conversationId),
    command: String(command || '').replace(/^\//, ''),
    args: String(args || ''),
  }, 'POST');
}
export async function botUpdate(botId, fields) { return apiCall('bot_update', { bot_id: botId, ...fields }, 'POST'); }
export async function botDelete(botId) { return apiCall('bot_delete', { bot_id: botId }, 'POST'); }
export async function botRegenerateToken(botId) { return apiCall('bot_regenerate_token', { bot_id: botId }, 'POST'); }
export async function planUpgrade(plan) { return apiCall('plan_upgrade', { plan }, 'POST'); }
export async function planCancel() { return apiCall('plan_cancel', {}, 'POST'); }
export async function planFamilyAdd(email) { return apiCall('plan_family_add', { email }, 'POST'); }
export async function planFamilyRemove(email) { return apiCall('plan_family_remove', { email }, 'POST'); }
export async function planFamilyList() { return apiCall('plan_family_list'); }
export async function planBackupList(conversationId = null) { return apiCall('plan_backup_list', { conversation_id: conversationId }); }
export async function planBackupRestore(backupId) { return apiCall('plan_backup_restore', { backup_id: backupId }, 'POST'); }
export async function planBackupDelete(backupId) { return apiCall('plan_backup_delete', { backup_id: backupId }, 'POST'); }
// Chat history snapshot — single-snapshot-per-user, scheduled or manual.
// Each `historySnapshotRun` call REPLACES the previous snapshot.
export async function historySnapshotStatus() { return apiCall('history_snapshot_status'); }
export async function historySnapshotSetSchedule(schedule) { return apiCall('history_snapshot_set_schedule', { schedule }, 'POST'); }
export async function historySnapshotRun() { return apiCall('history_snapshot_run', {}, 'POST'); }
export async function historySnapshotDelete() { return apiCall('history_snapshot_delete', {}, 'POST'); }
export async function historySnapshotRestore() { return apiCall('history_snapshot_restore', {}, 'POST'); }

// ============================================================
// STRIPE API
// ============================================================
export async function stripeCheckout(plan) { return apiCall('stripe_checkout', { plan }, 'POST'); }
export async function stripePortal() { return apiCall('stripe_portal', {}, 'POST'); }
export async function stripeStatus() { return apiCall('stripe_status'); }
export async function stripeSubscribe(plan, paymentMethodId, storageOpts, billingPeriod) { return apiCall('stripe_subscribe', { plan, payment_method_id: paymentMethodId, billing_period: billingPeriod || 'monthly', ...(storageOpts || {}) }, 'POST'); }
export async function stripeSubscriptionInfo() { return apiCall('stripe_subscription_info'); }
export async function stripeUpdateCard(paymentMethodId) { return apiCall('stripe_update_card', { payment_method_id: paymentMethodId }, 'POST'); }
export async function stripeCancelSubscription() { return apiCall('stripe_cancel_subscription', {}, 'POST'); }
export async function stripeReactivate() { return apiCall('stripe_reactivate', {}, 'POST'); }
export async function stripeSavedCard() { return apiCall('stripe_saved_card'); }
export async function stripeUpgrade(plan, storageGb) { return apiCall('stripe_upgrade', { plan, storage_gb: storageGb || undefined }, 'POST'); }

// ============================================================
// STRIPE DIAMOND PURCHASE (WAVE 43E — 2026-05-21)
// One-shot PaymentIntents NOT tied to a subscription. Used by the
// web checkout page at chatyy.com.br/comprar-diamantes and (later)
// by Android's Payment Sheet integration. iOS deep-links to the
// web flow — App Store 3.1.1 forbids 3rd-party processors for
// digital goods inside the iOS app.
// ============================================================
export async function stripeDiamondPacks() { return apiCall('stripe_diamond_packs'); }
export async function stripeDiamondSetupIntent() { return apiCall('stripe_diamond_setup_intent', {}, 'POST'); }
export async function stripeDiamondPaymentIntent(sku, paymentMethodId = null, offSession = false) {
  return apiCall('stripe_diamond_payment_intent', {
    sku,
    payment_method_id: paymentMethodId || undefined,
    off_session: offSession || undefined,
  }, 'POST');
}
export async function stripeDiamondListCards() { return apiCall('stripe_diamond_list_cards'); }
export async function stripeDiamondDeleteCard(paymentMethodId) {
  return apiCall('stripe_diamond_delete_card', { payment_method_id: paymentMethodId }, 'POST');
}
export async function stripeDiamondHistory() { return apiCall('stripe_diamond_history'); }

// ============================================================
// CONTENT SAFETY / MODERATION
// ============================================================
export async function feedBookmarkList() { return apiCall('feed_bookmark_list'); }
export async function reportContent(data) { return apiCall('report_content', data, 'POST'); }
export async function checkAccountStatus() { return apiCall('check_account_status'); }
export async function appealSuspension(appealText) { return apiCall('appeal_suspension', { appeal_text: appealText }, 'POST'); }
export async function requestDataDownload() { return apiCall('request_data_download', {}, 'POST'); }
export async function dataDownloadStatus() { return apiCall('data_download_status'); }

// ============================================================
// AI IMAGE GENERATION
// ============================================================
export async function aiGenerateImage(prompt, size = '1024x1024') { return apiCall('ai_generate_image', { prompt, size }, 'POST'); }

// ── Group management (v2 — uses the invite_token schema) ───────────────
export async function chatGroupInviteLinkV2(conversationId, mode = 'get') {
  return apiCall('chat_group_invite_link', { conversation_id: conversationId, mode }, 'POST');
}
export async function chatGroupJoinViaLink(token) {
  return apiCall('chat_group_join_via_link', { token }, 'POST');
}
export async function chatGroupSetAdminOnly(conversationId, adminOnly) {
  return apiCall('chat_group_set_admin_only', { conversation_id: conversationId, admin_only: !!adminOnly }, 'POST');
}

// ── Sticker conversion ──────────────────────────────────────────────────
export async function stickerConvertAnimated(fileOrUrl) {
  // Accepts either a FormData-ready file { uri, name, type } / blob, or a source_url string
  if (typeof fileOrUrl === 'string') {
    return apiCall('sticker_animated', { source_url: fileOrUrl }, 'POST');
  }
  const fd = new FormData();
  if (fileOrUrl._raw) fd.append('video', fileOrUrl._raw, fileOrUrl.name || 'video.mp4');
  else fd.append('video', fileOrUrl);
  const r = await fetch(`${BASE_URL}/api/email.php?action=sticker_animated`, {
    method: 'POST',
    headers: { ...getAuthHeaders() },
    body: fd,
  });
  return r.json();
}

// ============================================================
// PER-CHAT NOTIFICATION SOUND
// ============================================================
export async function chatSetNotificationSound(conversationId, sound) { return apiCall('chat_set_notification_sound', { conversation_id: conversationId, sound }, 'POST'); }

// ============================================================
// ADVANCED SEARCH
// ============================================================
export async function chatSearchAdvanced(opts) { return apiCall('chat_search_advanced', opts, 'POST'); }

// ============================================================
// SESSION / DEVICE MANAGEMENT
// ============================================================
export async function sessionList() { return apiCall('session_list'); }
export async function sessionRevoke(sessionId) { return apiCall('session_revoke', { session_id: sessionId }, 'POST'); }

// ============================================================
// PER-CONTACT PRIVACY
// ============================================================
export async function chatPrivacyContactSet(opts) { return apiCall('chat_privacy_contact_set', opts, 'POST'); }
export async function chatPrivacyContactList() { return apiCall('chat_privacy_contact_list'); }

// ============================================================
// DEFAULT DISAPPEARING TIMER (global)
// ============================================================
export async function chatSetDefaultDisappearing(seconds) { return apiCall('chat_set_default_disappearing', { seconds }, 'POST'); }

// ============================================================
// BUSINESS CATALOG
// ============================================================
export async function businessCatalogList(email) { return apiCall('business_catalog_list', { email }, 'POST'); }
export async function businessCatalogAdd(item) { return apiCall('business_catalog_add', item, 'POST'); }
export async function businessCatalogUpdate(item) { return apiCall('business_catalog_update', item, 'POST'); }
export async function businessCatalogDelete(id) { return apiCall('business_catalog_delete', { id }, 'POST'); }

// ============================================================
// IN-CHAT PAYMENTS (Stripe Payment Links)
// ============================================================
export async function chatPaymentCreate(opts) { return apiCall('chat_payment_create', opts, 'POST'); }
export async function chatPaymentList(conversationId) { return apiCall('chat_payment_list', { conversation_id: conversationId }, 'POST'); }

// ============================================================
// VOICE ROOMS (Clubhouse-style)
// ============================================================
export async function voiceRoomCreate(opts) { return apiCall('voice_room_create', opts, 'POST'); }
export async function voiceRoomList() { return apiCall('voice_room_list'); }
export async function voiceRoomJoin(roomId) { return apiCall('voice_room_join', { room_id: roomId }, 'POST'); }
export async function voiceRoomLeave(roomId) { return apiCall('voice_room_leave', { room_id: roomId }, 'POST'); }
export async function voiceRoomEnd(roomId) { return apiCall('voice_room_end', { room_id: roomId }, 'POST'); }
export async function voiceRoomParticipants(roomId) { return apiCall('voice_room_participants', { room_id: roomId }, 'POST'); }

// ============================================================
// GIVEAWAYS
// ============================================================
export async function giveawayCreate(opts) { return apiCall('giveaway_create', opts, 'POST'); }
export async function giveawayEnter(giveawayId) { return apiCall('giveaway_enter', { giveaway_id: giveawayId }, 'POST'); }
export async function giveawayList(conversationId) { return apiCall('giveaway_list', conversationId ? { conversation_id: conversationId } : {}, 'POST'); }

// ============================================================
// CHANNEL POST COMMENTS
// ============================================================
export async function channelPostCommentAdd(opts) { return apiCall('channel_post_comment_add', opts, 'POST'); }
export async function channelPostComments(postId) { return apiCall('channel_post_comments', { post_id: postId }, 'POST'); }

// ============================================================
// SECRET CHAT MODE
// ============================================================
export async function chatSetSecretMode(conversationId, enabled) { return apiCall('chat_set_secret_mode', { conversation_id: conversationId, enabled }, 'POST'); }

// ============================================================
// APPLE IAP API
// ============================================================
export async function iapValidateReceipt(receipt, productId) { return apiCall('iap_validate_receipt', { receipt, product_id: productId }, 'POST'); }
export async function iapRestorePurchases(receipt) { return apiCall('iap_restore_purchases', { receipt }, 'POST'); }
export async function iapSubscriptionInfo() { return apiCall('iap_subscription_info'); }

// ============================================================
// QR CODE AUTH
// ============================================================
// Backend handlers live in chat.php as `chat_qr_login_*`. The whitelist in
// email.php for unauthenticated routing also targets those names — using
// `qr_generate` returns "Unknown action" 400. Backend uses status='approved'
// and the bearer comes back as `token`/`bearer_token`; the frontend was
// written to expect status='confirmed' and `auth_token`. Normalize here so
// callers see a stable shape.
// device_kind defaults to 'web' on the backend; legacy desktop QR calls keep
// working without changes. Pass 'mobile' for companion-mode pairing.
export async function qrGenerate(deviceKind) {
  const body = deviceKind ? { device_kind: deviceKind } : {};
  return apiCall('chat_qr_login_create', body, 'POST');
}
export async function qrCheck(token) {
  const r = await apiCall('chat_qr_login_status', { token }, 'POST');
  if (r?.success && r.data) {
    const s = r.data.status;
    if (s === 'approved') r.data.status = 'confirmed';
    if (!r.data.auth_token) r.data.auth_token = r.data.token || r.data.bearer_token;
  }
  return r;
}
export async function qrConfirm(token, deviceKind) {
  const body = deviceKind ? { token, device_kind: deviceKind } : { token };
  return apiCall('chat_qr_login_approve', body, 'POST');
}

// ============================================================
// PER-DEVICE PUBLIC KEY REGISTRY (SQLite-first migration — Stage 2)
// ============================================================
// Each linked surface (web/desktop/companion-mobile) generates its own
// X25519 keypair and publishes the pubkey here after QR pairing. Phone
// fetches the list on foreground so Stage 5 envelope encryption can
// target every device individually instead of one envelope per email.
export async function chatDeviceKeyPublish(deviceId, pubkey, kind) {
  if (!deviceId || !pubkey) {
    return { success: false, message: 'device_id and pubkey required' };
  }
  const body = { device_id: deviceId, pubkey };
  if (kind) body.kind = kind;
  return apiCall('chat_device_key_publish', body, 'POST');
}
export async function chatDeviceKeysList() {
  return apiCall('chat_device_keys_list');
}
// Fan-out helper used by Stage 5 sender: returns all (email, device_id,
// pubkey) tuples for every member of the conversation, including the
// sender's other paired devices. Caller must be a member of the convo.
export async function chatConvDeviceKeys(conversationId) {
  if (!conversationId) return { success: false, message: 'conversation_id required' };
  return apiCall('chat_conv_device_keys', { conversation_id: conversationId });
}
// Stage 5 convenience: returns the device-key array shape buildEnvelopes()
// expects ([{email, device_id, pubkey}, ...]). Returns [] on error so the
// envelope flow can no-op (zero envelopes is a server-accepted shape).
export async function getRecipientDeviceKeys(conversationId) {
  try {
    const r = await chatConvDeviceKeys(conversationId);
    const list = r?.data?.devices || r?.devices || [];
    if (!Array.isArray(list)) return [];
    return list
      .filter(d => d && d.email && d.device_id && d.pubkey)
      .map(d => ({ email: d.email, device_id: d.device_id, pubkey: d.pubkey }));
  } catch (e) {
    console.warn('[getRecipientDeviceKeys] ' + (e?.message || e));
    return [];
  }
}
export async function chatDeviceKeyTouch(deviceId) {
  if (!deviceId) return { success: false, message: 'device_id required' };
  return apiCall('chat_device_key_touch', { device_id: deviceId }, 'POST');
}

// ============================================================
// ENCRYPTED ENVELOPE DELIVERY (SQLite-first migration — Stage 5)
// ============================================================
// Per-recipient-device ciphertext fan-out. Plaintext never touches the
// server in this mode — chat_pending_envelopes stores nacl.box output
// keyed by (recipient_email, device_id, client_message_id) and the
// receiver decrypts + acks. See services/envelope.js for the
// build/decrypt helpers and services/envelopePuller.js for the
// foreground pull loop.
export async function chatEnvelopeSend(payload) {
  // Payload accepts EITHER shape — backend chat_envelope_send detects via
  // presence of `body`:
  //   (A) Legacy per-device:
  //       { conversation_id, client_message_id, envelopes: [
  //           { recipient_email, recipient_device_id, ciphertext,
  //             ephemeral_pubkey, nonce }, ... ] }
  //   (B) Sender-Keys (Stage 5 optimization, 2026-05-16):
  //       { conversation_id, client_message_id,
  //         body: { ciphertext, iv, tag, algo },
  //         keys: [ { recipient_email, recipient_device_id, key_ciphertext,
  //                   key_ephemeral_pubkey, key_nonce }, ... ] }
  //
  // Both shapes route to chat_pending_envelopes on the server; (B) also
  // writes a single chat_message_bodies row referenced by all key rows.
  if (!payload || !payload.conversation_id || !payload.client_message_id) {
    return { success: false, message: 'conversation_id, client_message_id required' };
  }
  const hasBody = payload.body && typeof payload.body === 'object';
  if (hasBody) {
    // Sender-Keys shape — validate the key wraps array.
    if (!Array.isArray(payload.keys)) {
      return { success: false, message: 'keys[] required for sender-keys payload' };
    }
    if (payload.keys.length === 0) {
      // No paired devices to wrap for — treat as no-op, same as legacy
      // empty-envelopes path. Avoid hitting the server with a body row
      // that has zero recipients.
      return { success: true, data: { inserted: 0, skipped: 0, total: 0 } };
    }
  } else {
    // Legacy shape — must carry an envelopes array.
    if (!Array.isArray(payload.envelopes)) {
      return { success: false, message: 'conversation_id, client_message_id, envelopes[] required' };
    }
    if (payload.envelopes.length === 0) {
      // Nothing to send (no paired devices yet). Caller treats as no-op.
      return { success: true, data: { inserted: 0, skipped: 0, total: 0 } };
    }
  }
  return apiCall('chat_envelope_send', payload, 'POST');
}
export async function chatEnvelopesPull(deviceId) {
  if (!deviceId) return { success: false, message: 'device_id required' };
  // GET on PHP for cacheless pull. Action is on the URL; device_id on query.
  return apiCall('chat_envelopes_pull', { device_id: deviceId });
}
export async function chatEnvelopeAck(ids, deviceId) {
  if (!deviceId) return { success: false, message: 'device_id required' };
  if (!Array.isArray(ids) || ids.length === 0) {
    return { success: false, message: 'ids[] required' };
  }
  return apiCall('chat_envelope_ack', { ids, device_id: deviceId }, 'POST');
}

// ============================================================
// CHECK CONTACTS (Chatyy registration lookup)
// ============================================================
export async function checkContacts(emails, phones) {
  return apiCall('check_contacts', { emails: emails || [], phones: phones || [] }, 'POST');
}

// ============================================================
// NOTES API
// ============================================================
export async function notesList(filters = {}) { return apiCall('notes_list', filters); }
export async function notesCreate(data) { return apiCall('notes_create', data, 'POST'); }
export async function notesUpdate(id, data) { return apiCall('notes_update', { id, ...data }, 'POST'); }
export async function notesDelete(id) { return apiCall('notes_delete', { id }, 'POST'); }
export async function notesExportPdf(id) { return apiCall('notes_export_pdf', { id }); }
export async function notesSendEmail(id, to_email) { return apiCall('notes_send_email', { id, to_email }, 'POST'); }
export async function notebooksList() { return apiCall('notebooks_list'); }
export async function notebooksCreate(data) { return apiCall('notebooks_create', data, 'POST'); }
export async function notebooksUpdate(id, data) { return apiCall('notebooks_update', { id, ...data }, 'POST'); }
export async function notebooksDelete(id) { return apiCall('notebooks_delete', { id }, 'POST'); }

// Notebook Pages (drawing + text)
export async function notebookPagesList(notebookId) { return apiCall('notebook_pages_list', { notebook_id: notebookId }); }
export async function notebookPageGet(pageId) { return apiCall('notebook_page_get', { page_id: pageId }); }
export async function notebookPageSave(pageId, data) { return apiCall('notebook_page_save', { page_id: pageId, ...data }, 'POST'); }
export async function notebookPageCreate(notebookId, background) { return apiCall('notebook_page_create', { notebook_id: notebookId, background: background || 'lined' }, 'POST'); }
export async function notebookPageDelete(pageId) { return apiCall('notebook_page_delete', { page_id: pageId }, 'POST'); }

// Referral system
export async function getReferralCode() { return apiCall('get_referral_code'); }
export async function applyReferral(code) { return apiCall('apply_referral', { code }, 'POST'); }


// VoIP SIP credentials - direct fetch (bypass Cloudflare for speed)
export async function voipSipCredentials() {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${BASE_URL}/api/email.php?action=voip_sip_credentials`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'voip_sip_credentials' }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return await r.json();
  } catch (e) { clearTimeout(timeout); return { success: false, message: e.message }; }
}

// Twilio Voice — STAGE 1 da migração A3 (substitui Telnyx Verto WS).
// Backend gera Access Token JWT (HS256) com grant 'voice' Twilio v2.
export async function voipTwilioToken() {
  return apiCall('voip_twilio_token', {}, 'POST');
}

// App init (combined endpoint)
export async function appInit() {
  return apiCall('app_init');
}

// Bootstrap: single request returns ALL data (Redis-cached 60s on server)
// Use this on every app open for instant data
export async function bootstrap() {
  const r = await apiCall('bootstrap');
  if (r?.success && r.data) {
    // Cache locally for offline/instant access
    try {
      const { setString, setJSON } = require('./mmkv');
      if (r.data.conversations) setString('chat_conversations', JSON.stringify(r.data.conversations));
      if (r.data.profile) setJSON('omc_profile', { data: r.data.profile, ts: Date.now() });
      if (r.data.call_history) setJSON('omc_call_history', { data: r.data.call_history, ts: Date.now() });
      if (r.data.folders) {
        const { setCache } = require('./cache');
        setCache('email_folders', r.data.folders, 600000).catch(() => {});
      }
    } catch {}
  }
  // [WAVE 54 2026-05-21] Prefetch status_manifest so the home strip paints
  // from HTTP/SWR cache when the user navigates to the Chat tab. Fire and
  // forget — failures are silent and the strip's own fetch still runs.
  try { statusManifestPrefetch(); } catch {}
  return r;
}

// Wait for token ready — resolves once authToken is loaded from storage
export async function waitForTokenReady() {
  return _tokenReadyPromise;
}

// Chat send with client_message_id for dedup
export async function chatSendDedup(conversationId, content, type, replyId, mentions, files, disappearing, clientMessageId) {
  return apiCall('chat_send', {
    conversation_id: conversationId,
    content, type: type || 'text',
    reply_to_id: replyId || null,
    mentions: mentions || [],
    files: files || null,
    disappearing_timer: disappearing || null,
    client_message_id: clientMessageId || null,
  }, 'POST');
}

// Incremental sync — get all chat events since last_seq
export async function chatSync(lastSeq = 0, limit = 100) {
  return apiCall('chat_sync', { last_seq: lastSeq, limit }, 'POST');
}

// ─── Documents ───
export async function docsList(params = {}) { return apiCall('docs_list', params); }
export async function docsGet(docId) { return apiCall('docs_get', { doc_id: docId }); }
export async function docsCreate(data) {
  // Accept both object and legacy (title, type) signatures
  if (typeof data === 'string') data = { title: data, type: 'document' };
  return apiCall('docs_create', data, 'POST');
}
export async function docsRename(docId, title) { return apiCall('docs_rename', { doc_id: docId, title }, 'POST'); }
export async function docsTrash(docId) { return apiCall('docs_trash', { doc_id: docId }, 'POST'); }
export async function docsDuplicate(docId) { return apiCall('docs_duplicate', { doc_id: docId }, 'POST'); }

// ─── Parental Controls ───
export async function parentalCreateChild(childName, childBirthday) { return apiCall('parental_create_child', { child_name: childName, child_birthday: childBirthday }, 'POST'); }
export async function parentalListChildren() { return apiCall('parental_list_children'); }
export async function parentalChildChats(childEmail) { return apiCall('parental_child_chats', { child_email: childEmail }); }
export async function parentalChildMessages(childEmail, conversationId, limit = 50) { return apiCall('parental_child_messages', { child_email: childEmail, conversation_id: conversationId, limit }); }
export async function parentalAlerts(childEmail) { return apiCall('parental_alerts', childEmail ? { child_email: childEmail } : {}); }
export async function parentalMarkAlertRead(alertId) { return apiCall('parental_mark_alert_read', { alert_id: alertId }, 'POST'); }
export async function parentalUpdateRestrictions(childEmail, restrictions) { return apiCall('parental_update_restrictions', { child_email: childEmail, ...restrictions }, 'POST'); }
export async function parentalGetRestrictions(childEmail) { return apiCall('parental_get_restrictions', { child_email: childEmail }); }
export async function parentalMyStatus() { return apiCall('parental_my_status'); }
export async function parentalRevokeChild(childEmail) { return apiCall('parental_revoke_child', { child_email: childEmail }, 'POST'); }
export async function parentalScreenTime(childEmail) { return apiCall('parental_screen_time', { child_email: childEmail }); }
export async function parentalCallHistory(childEmail) { return apiCall('parental_call_history', { child_email: childEmail }); }
export async function parentalContactWhitelist(childEmail) { return apiCall('parental_contact_whitelist', { child_email: childEmail }); }
export async function parentalAddContact(childEmail, contactEmail) { return apiCall('parental_contact_whitelist', { child_email: childEmail, contact_email: contactEmail }, 'POST'); }
export async function parentalRemoveContact(childEmail, contactEmail) { return apiCall('parental_remove_contact', { child_email: childEmail, contact_email: contactEmail }, 'POST'); }
export async function parentalSetTimeLimits(childEmail, data) { return apiCall('parental_set_time_limits', { child_email: childEmail, ...data }, 'POST'); }
export async function parentalActivitySummary(childEmail) { return apiCall('parental_activity_summary', { child_email: childEmail }); }
export async function parentalUpdateLocation(lat, lng, accuracy, battery) { return apiCall('parental_update_location', { latitude: lat, longitude: lng, accuracy, battery_level: battery }, 'POST'); }
export async function parentalGetLocation(childEmail) { return apiCall('parental_get_location', { child_email: childEmail }); }
export async function parentalGeofences(childEmail) { return apiCall('parental_geofences', { child_email: childEmail }); }

// New monitor tabs: today/week/contacts/activity/summary.
// These hit endpoints that may not exist on every backend version yet —
// callers must tolerate `success: false` and fall back to the existing
// `parentalScreenTime`/`parentalActivitySummary` data already on the
// screen. Never throw, never block the rest of the loaders.
export async function parentalChildToday(childEmail) {
  try { return await apiCall('parental_child_today', { child_email: childEmail }); }
  catch { return { success: false }; }
}
export async function parentalChildWeek(childEmail) {
  try { return await apiCall('parental_child_week', { child_email: childEmail }); }
  catch { return { success: false }; }
}
export async function parentalChildContacts(childEmail) {
  try { return await apiCall('parental_child_contacts', { child_email: childEmail }); }
  catch { return { success: false }; }
}
export async function parentalChildActivity(childEmail, limit = 80) {
  try { return await apiCall('parental_child_activity', { child_email: childEmail, limit }); }
  catch { return { success: false }; }
}
export async function parentalSummary(childEmail) {
  try { return await apiCall('parental_summary', { child_email: childEmail }); }
  catch { return { success: false }; }
}
export async function parentalApproveContact(childEmail, contactEmail) {
  return apiCall('parental_approve_contact', { child_email: childEmail, contact_email: contactEmail }, 'POST');
}
export async function parentalBlockContact(childEmail, contactEmail) {
  return apiCall('parental_reject_contact', { child_email: childEmail, contact_email: contactEmail }, 'POST');
}

// Kids — Ask Parent (child sends request; parent approves/denies).
// Maps frontend "type" labels onto backend parental_unlock_request reasons
// so a single endpoint covers all surfaces (chat/feed/calls/email).
export async function kidsAskParent(type, message, extras = {}) {
  const REASON_MAP = {
    bedtime_unlock:    'bedtime',
    chat_unlock:       'chat_disabled',
    feed_unlock:       'feed_disabled',
    calls_unlock:      'calls_disabled',
    contact_unlock:    'contact_blocked',
    extra_time:        'extra_time',
    new_contact:       'new_contact',
    new_app:           'new_app',
  };
  const reason = REASON_MAP[type] || type || '';
  return apiCall('parental_unlock_request', {
    reason,
    note: message || '',
    surface: extras?.surface || '',
    ...extras,
  }, 'POST');
}
export async function kidsMyRequests() { return apiCall('kids_my_requests'); }
export async function parentalPendingRequests(status = 'pending') { return apiCall('parental_pending_requests', { status }); }
export async function parentalResolveRequest(id, decision) {
  return apiCall('parental_resolve_request', { id, decision }, 'POST');
}

// Convenience wrappers used by /parental dashboard quick-actions.
// These all hit existing endpoints (`parental_update_restrictions` /
// `parental_set_time_limits`) — no new backend handler needed.
export async function parentalLockChild(childEmail) {
  return apiCall('parental_update_restrictions', { child_email: childEmail, locked: true, locked_at: Date.now() }, 'POST');
}
export async function parentalUnlockChild(childEmail) {
  return apiCall('parental_update_restrictions', { child_email: childEmail, locked: false }, 'POST');
}
export async function parentalGrantExtraTime(childEmail, minutes = 15) {
  return apiCall('parental_set_time_limits', { child_email: childEmail, bonus_minutes: minutes, granted_at: Date.now() }, 'POST');
}

// Kids — Achievements + Daily quest
export async function kidsAchievements() { return apiCall('kids_achievements'); }
export async function kidsDailyQuest() { return apiCall('kids_daily_quest'); }

// ─── Parental review surface ───
// Mark a child's chat message as inappropriate for review on the parental
// dashboard. TODO: backend handler `parental_flag_message` not yet
// implemented — wire when ready (chat.php should expose it; stores
// flagged_at + flagged_by on chat_messages or in parental_flags table).
export async function parentalFlagMessage(childEmail, messageId, flagged = true) {
  return apiCall('parental_flag_message', {
    child_email: childEmail,
    message_id: messageId,
    flagged: flagged ? 1 : 0,
  }, 'POST');
}

// Aggregate history for unlock requests so kid can see status (Aprovado /
// Negado / Pendente). `kidsMyRequests` already exists above; alias for
// the parent-side perspective.
export async function parentalUnlockHistory(childEmail) {
  // TODO: backend handler `parental_unlock_history` may not exist yet —
  //       on prod the parental dashboard already calls
  //       `parental_pending_requests`; this wrapper covers the kid-side
  //       lookup if/when needed.
  return apiCall('parental_unlock_history', childEmail ? { child_email: childEmail } : {});
}

// ─── Family Sharing (Apple-style hub) ───
// TODO: backend endpoints below are NOT yet implemented. Wrappers return
// the apiCall promise so screens render gracefully (`success: false`)
// until PHP handlers ship. Drop the TODO comments when each backend
// lands.

// Returns family unit metadata: { id, name, avatar_url, members[] }.
// Member shape: { email, name, role: 'parent'|'child'|'spouse', age?, avatar_url, online?, location? }
export async function familyInfo() {
  // TODO: backend handler `family_info` pending.
  return apiCall('family_info');
}

// Invite a new member by email or phone with a role.
// role: 'parent' | 'child' | 'spouse'
export async function familyInvite(target, role = 'child') {
  // TODO: backend handler `family_invite` pending.
  return apiCall('family_invite', { target, role }, 'POST');
}

// Link a spouse account (also a parent — full perms over children).
export async function familyAddSpouse(spouseEmail) {
  // TODO: backend handler `family_add_spouse` pending.
  return apiCall('family_add_spouse', { spouse_email: spouseEmail }, 'POST');
}

// Update family metadata (name, photo).
export async function familyUpdate(data) {
  // TODO: backend handler `family_update` pending.
  return apiCall('family_update', data || {}, 'POST');
}

// Remove a family member (only the family owner can do this).
export async function familyRemoveMember(email) {
  // TODO: backend handler `family_remove_member` pending.
  return apiCall('family_remove_member', { email }, 'POST');
}

// Shared photo album — list and append. Stored in R2 under
// /family/<family_id>/album/* (same pattern as feed-files).
export async function familySharedAlbum() {
  // TODO: backend handler `family_shared_album` pending.
  return apiCall('family_shared_album');
}

export async function familySharedAlbumAdd(fileUri, caption = '') {
  // TODO: backend handler `family_shared_album_add` pending.
  const formData = new FormData();
  formData.append('caption', caption);
  formData.append('file', { uri: fileUri, name: 'photo.jpg', type: 'image/jpeg' });
  const headers = getAuthHeaders();
  if (headers && headers['Content-Type']) delete headers['Content-Type']; // let runtime add boundary
  const res = await fetch(API_URL + '?action=family_shared_album_add', {
    method: 'POST', headers, body: formData, credentials: 'include',
  });
  return res.json().catch(() => ({ success: false }));
}

// Shared family calendar — pulls events tagged with family_id.
export async function familySharedCalendar() {
  // TODO: backend handler `family_shared_calendar` pending.
  return apiCall('family_shared_calendar');
}

// Shared shopping list — list + add + check.
export async function familyShoppingList() {
  // TODO: backend handler `family_shopping_list` pending.
  return apiCall('family_shopping_list');
}

export async function familyShoppingListAdd(item) {
  // TODO: backend handler `family_shopping_list_add` pending.
  return apiCall('family_shopping_list_add', { item }, 'POST');
}

export async function familyShoppingListToggle(id, checked) {
  // TODO: backend handler `family_shopping_list_toggle` pending.
  return apiCall('family_shopping_list_toggle', { id, checked: checked ? 1 : 0 }, 'POST');
}

// Find My Family — returns last known location for every member. Should
// reuse the parental_update_location / chat_user_locations storage.
export async function familyLocationAll() {
  // TODO: backend handler `family_location_all` pending.
  return apiCall('family_location_all');
}

// Plan share — reads which plan is active and who else benefits.
export async function familyPlanShare() {
  // TODO: backend handler `family_plan_share` pending.
  return apiCall('family_plan_share');
}

// SOS Emergency System
export async function parentalSOS(type, message, latitude, longitude, accuracy, battery) {
  return apiCall('parental_sos', { type, message, latitude, longitude, accuracy, battery }, 'POST');
}
export async function parentalSOSResolve(sosId) { return apiCall('parental_sos_resolve', { sos_id: sosId }, 'POST'); }
export async function parentalSOSHistory(childEmail) { return apiCall('parental_sos_history', { child_email: childEmail }); }
export async function parentalEmergencyContacts(childEmail) { return apiCall('parental_emergency_contacts', { child_email: childEmail }); }
export async function parentalAddEmergencyContact(childEmail, name, phone, relationship, isPolice) {
  return apiCall('parental_emergency_contacts', { child_email: childEmail, name, phone, relationship, is_police: isPolice }, 'POST');
}

// Kids TV
export async function kidsTVChannels(category) { return apiCall('kids_tv_channels', category ? { category } : {}); }
export async function kidsTVVideos(channelId) { return apiCall('kids_tv_videos', { channel_id: channelId }); }
export async function kidsTVFeatured() { return apiCall('kids_tv_featured'); }

// Professora ONE Kids
export async function oneKidsChat(message, topic, imageUri) {
  if (imageUri) {
    const formData = new FormData();
    formData.append('message', message);
    formData.append('topic', topic || '');
    formData.append('image', { uri: imageUri, name: 'homework.jpg', type: 'image/jpeg' });
    const res = await fetch(`${API_URL}?action=one_kids_chat`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body: formData,
    });
    return res.json();
  }
  return apiCall('one_kids_chat', { message, topic }, 'POST');
}
export async function parentalUploadDocument(accountId, documentType, fileUri) {
  const formData = new FormData();
  formData.append('account_id', accountId);
  formData.append('document_type', documentType);
  formData.append('document', { uri: fileUri, name: 'document.jpg', type: 'image/jpeg' });
  const headers = getAuthHeaders();
  const res = await fetch(API_URL + '?action=parental_upload_document', { method: 'POST', headers, body: formData, credentials: 'include' });
  return res.json();
}

// ─── IVR (Interactive Voice Response) ───
export async function ivrList() { return apiCall('ivr_list'); }
export async function ivrCreate(data) { return apiCall('ivr_create', data, 'POST'); }
export async function ivrUpdate(data) { return apiCall('ivr_update', data, 'POST'); }
export async function ivrUpdateOptions(menuId, options) { return apiCall('ivr_update_options', { menu_id: menuId, options }, 'POST'); }
export async function ivrDelete(menuId) { return apiCall('ivr_delete', { menu_id: menuId }, 'POST'); }
export async function ivrLogs(menuId, limit = 50) { return apiCall('ivr_logs', { menu_id: menuId, limit }); }

// ─── Stickers ───
export async function stickerPacks() {
  return apiCall('sticker_packs');
}
export async function stickerList(packId) {
  return apiCall('sticker_list', { pack_id: packId });
}
export async function stickerAddPack(packId) {
  return apiCall('sticker_add_pack', { pack_id: packId }, 'POST');
}

// ─── Sticker packs (new) ───
export async function chatStickerPacksList() {
  return apiCall('chat_sticker_packs_list', {}, 'POST');
}
export async function chatStickerPackInstall(packId) {
  return apiCall('chat_sticker_pack_install', { pack_id: packId }, 'POST');
}
export async function chatStickerPackUninstall(packId) {
  return apiCall('chat_sticker_pack_uninstall', { pack_id: packId }, 'POST');
}
export async function chatStickerPackStickers(packId) {
  return apiCall('chat_sticker_pack_stickers', { pack_id: packId }, 'POST');
}
export async function chatUserStickers() {
  return apiCall('chat_user_stickers', {}, 'POST');
}

// ─── Custom sticker creation (WhatsApp/Telegram-level) ───
export async function chatStickerCreate(file, { packId = null, emoji = '', emojiTags = '' } = {}) {
  const formData = new FormData();
  if (Platform.OS === 'web') {
    if (file instanceof Blob || file instanceof File) formData.append('file', file, file.name || 'sticker.png');
    else if (file?.blob instanceof Blob) formData.append('file', file.blob, file.name || 'sticker.png');
    else if (file?._raw instanceof Blob || file?._raw instanceof File) formData.append('file', file._raw, file.name || 'sticker.png');
    else if (file?.uri) {
      try { const blob = await fetch(file.uri).then(r => r.blob()); formData.append('file', blob, file.name || 'sticker.png'); }
      catch { return { success: false, message: 'Could not read sticker blob' }; }
    } else return { success: false, message: 'Invalid file' };
  } else {
    if (!file?.uri) return { success: false, message: 'Invalid file' };
    formData.append('file', { uri: file.uri, name: file.name || 'sticker.png', type: file.type || 'image/png' });
  }
  if (packId) formData.append('pack_id', String(packId));
  if (emoji) formData.append('emoji', emoji);
  if (emojiTags) formData.append('emoji_tags', emojiTags);
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const resp = await fetch(`${API_URL}?action=chat_sticker_create`, { method: 'POST', body: formData, credentials: 'include', headers, signal: ctrl.signal });
    clearTimeout(timer);
    return resp.json();
  } catch (e) { return { success: false, message: e?.message || 'upload_failed' }; }
}
export async function chatStickerCreateAnimated(file, { packId = null, emoji = '', emojiTags = '' } = {}) {
  const formData = new FormData();
  if (Platform.OS === 'web') {
    if (file instanceof Blob || file instanceof File) formData.append('file', file, file.name || 'sticker.mp4');
    else if (file?.blob instanceof Blob) formData.append('file', file.blob, file.name || 'sticker.mp4');
    else if (file?._raw instanceof Blob || file?._raw instanceof File) formData.append('file', file._raw, file.name || 'sticker.mp4');
    else if (file?.uri) {
      try { const blob = await fetch(file.uri).then(r => r.blob()); formData.append('file', blob, file.name || 'sticker.mp4'); }
      catch { return { success: false, message: 'Could not read sticker blob' }; }
    } else return { success: false, message: 'Invalid file' };
  } else {
    if (!file?.uri) return { success: false, message: 'Invalid file' };
    formData.append('file', { uri: file.uri, name: file.name || 'sticker.mp4', type: file.type || 'video/mp4' });
  }
  if (packId) formData.append('pack_id', String(packId));
  if (emoji) formData.append('emoji', emoji);
  if (emojiTags) formData.append('emoji_tags', emojiTags);
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const resp = await fetch(`${API_URL}?action=chat_sticker_create_animated`, { method: 'POST', body: formData, credentials: 'include', headers, signal: ctrl.signal });
    clearTimeout(timer);
    return resp.json();
  } catch (e) { return { success: false, message: e?.message || 'upload_failed' }; }
}
export async function chatStickerDelete(stickerId) {
  return apiCall('chat_sticker_delete', { sticker_id: stickerId }, 'POST');
}
export async function chatStickerPackCreate({ name, description = '', coverUrl = '' }) {
  return apiCall('chat_sticker_pack_create', { name, description, cover_url: coverUrl }, 'POST');
}
export async function chatStickerPackDelete(packId) {
  return apiCall('chat_sticker_pack_delete', { pack_id: packId }, 'POST');
}
export async function chatStickerMyPacks() {
  return apiCall('chat_sticker_my_packs', {}, 'POST');
}
export async function chatStickerMyStickers({ packId = null, q = '' } = {}) {
  const params = {};
  if (packId) params.pack_id = packId;
  if (q) params.q = q;
  return apiCall('chat_sticker_my_stickers', params, 'POST');
}
export async function chatStickerSearch(q) {
  return apiCall('chat_sticker_search', { q }, 'POST');
}
// chat_sticker_global_search — discovery search across every public pack
// (every uploaded sticker tagged by anyone, not just installed). Backed by
// a per-user rate limit server-side (60/min), so call it debounced.
export async function chatStickerGlobalSearch(q) {
  return apiCall('chat_sticker_global_search', { q }, 'POST');
}
// Server-side favorites. The local AsyncStorage cache stays in place for
// offline writes but every toggle hits the server too — favorites survive
// reinstall and follow the user across devices.
export async function chatStickerFavoriteToggle(url) {
  return apiCall('chat_sticker_favorite_toggle', { url }, 'POST');
}
export async function chatStickerFavoritesList() {
  return apiCall('chat_sticker_favorites_list', {}, 'POST');
}
// ─── Sticker store / custom animated emoji (Telegram Premium-style) ───
// New marketplace endpoints introduced for /stickers/store + /stickers/my.
// Authors create packs, add R2-uploaded items, and other users install +
// browse via Trending / New / Animated / Premium filters. Custom animated
// emoji is Pro-tier gated server-side (HTTP 402 on free/plus accounts).
export async function stickerPackCreate({ name, description = '', coverR2Key = '' } = {}) {
  return apiCall('sticker_pack_create', { name, description, cover_r2_key: coverR2Key }, 'POST');
}
export async function stickerPackAddItem({ packId, stickerR2Key, emojiAlt = '' } = {}) {
  return apiCall('sticker_pack_add_item', {
    pack_id: packId,
    sticker_r2_key: stickerR2Key,
    emoji_alt: emojiAlt,
  }, 'POST');
}
export async function stickerPackInstall(packId) {
  return apiCall('sticker_pack_install', { pack_id: packId }, 'POST');
}
export async function stickerPackUninstall(packId) {
  return apiCall('sticker_pack_uninstall', { pack_id: packId }, 'POST');
}
export async function stickerPackMy() {
  return apiCall('sticker_pack_my', {}, 'POST');
}
export async function stickerPackBrowse(filter = 'trending') {
  return apiCall('sticker_pack_browse', { filter }, 'POST');
}
export async function stickerPackSearch(q) {
  return apiCall('sticker_pack_search', { q }, 'POST');
}
// Resolve a share-link handle to a pack row (used by deep-link install).
export async function stickerPackGetByHandle(handle) {
  return apiCall('sticker_pack_get_by_handle', { handle }, 'POST');
}
// Persist the user's pack ordering server-side so it survives reinstall +
// propagates across devices.
export async function stickerPackReorder(ids) {
  return apiCall('sticker_pack_reorder', { ids }, 'POST');
}
export async function customEmojiUpload({ emojiHandle, webpR2Key } = {}) {
  return apiCall('custom_emoji_upload', {
    emoji_handle: emojiHandle,
    webp_r2_key: webpR2Key,
  }, 'POST');
}
export async function customEmojiMy() {
  return apiCall('custom_emoji_my', {}, 'POST');
}
export async function customEmojiDelete(id) {
  return apiCall('custom_emoji_delete', { id }, 'POST');
}

export async function chatStickerRemoveBg(file, { clientProcessed = false } = {}) {
  const formData = new FormData();
  if (Platform.OS === 'web') {
    if (file instanceof Blob || file instanceof File) formData.append('file', file, file.name || 'sticker.png');
    else if (file?.blob) formData.append('file', file.blob, file.name || 'sticker.png');
    else if (file?.uri) {
      try { const blob = await fetch(file.uri).then(r => r.blob()); formData.append('file', blob, file.name || 'sticker.png'); } catch { return { success: false }; }
    } else return { success: false };
  } else {
    if (!file?.uri) return { success: false };
    formData.append('file', { uri: file.uri, name: file.name || 'sticker.png', type: file.type || 'image/png' });
  }
  // When the client already extracted the subject (e.g. MediaPipe on web)
  // the server skips the floodfill and just re-encodes to 512x512 PNG.
  if (clientProcessed) formData.append('client_processed', '1');
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    const resp = await fetch(`${API_URL}?action=chat_sticker_remove_bg`, { method: 'POST', body: formData, credentials: 'include', headers });
    return resp.json();
  } catch (e) { return { success: false, message: e?.message }; }
}

// ─── Edit history ───
export async function chatMessageHistory(messageId) {
  return apiCall('chat_message_history', { message_id: messageId }, 'POST');
}

// ─── Privacy settings ───
export async function chatPrivacyGet() {
  return apiCall('chat_privacy_get', {}, 'POST');
}
export async function chatPrivacySet(settings) {
  return apiCall('chat_privacy_set', settings, 'POST');
}

// ─── Unified audit log (Settings → Segurança → Histórico de atividades) ───
// Backend records security-relevant events automatically (login, logout,
// password change, BYOK set, chat delete, message delete-for-all, spam
// report, discoverable toggle). The _add helper exists for the client to
// record events that the server can't observe directly (e.g. unlock).
export async function userActivityLogList(limit = 100, offset = 0) {
  return apiCall('user_activity_log_list', { limit, offset }, 'POST');
}
export async function userActivityLogAdd(action, deviceLabel = '') {
  return apiCall('user_activity_log_add', { action, device_label: deviceLabel }, 'POST');
}

// ─── Contact-discovery opt-out (Settings → Privacidade → "Permitir que
// outros me encontrem pelo número"). Default ON. When OFF, the backend
// filters this user from chat_sync_contacts and skips the "X entrou no
// Chatyy" push to existing contacts on phone register. ───
export async function chatDiscoverableGet() {
  return apiCall('chat_discoverable_get', {}, 'POST');
}
export async function chatDiscoverableSet(discoverable) {
  return apiCall('chat_discoverable_set', { discoverable: !!discoverable }, 'POST');
}

// ─── BYOK — Bring Your Own Key. Master key is generated client-side and
// NEVER sent to the server. The server only stores the SHA-256 fingerprint
// so other devices can verify a restored key matches.
// (services/byok.js handles the local key generation + Keychain/Keystore.) ───
export async function chatMasterKeyFingerprintGet() {
  return apiCall('chat_master_key_fingerprint_get', {}, 'POST');
}
export async function chatMasterKeyFingerprintSet(fingerprintHex) {
  return apiCall('chat_master_key_fingerprint_set', { fingerprint: fingerprintHex }, 'POST');
}
export async function chatMasterKeyFingerprintClear() {
  return apiCall('chat_master_key_fingerprint_clear', {}, 'POST');
}

// ─── Spam reporting (long-press chat in list → "Reportar como spam") ───
// Backend counts reports per sender — >10 in 24h auto-shadowbans them
// from chat_sync_contacts search results.
export async function chatReportSpam(convId, reason = '') {
  return apiCall('chat_report_spam', { conv_id: convId, reason }, 'POST');
}

// ─── Channel threading ───
export async function chatThreadMessages(parentMessageId) {
  return apiCall('chat_thread_messages', { parent_message_id: parentMessageId }, 'POST');
}

// ─── LiveKit (group calls SFU) ───
// [2026-05-21] Pass device_id so backend Agent A can suffix the LK identity
// for dedup across multi-device sessions (phone + web + share-ext etc.).
export async function chatLivekitToken(conversationId, room = '') {
  const payload = { conversation_id: conversationId, room };
  const _did = await _getDeviceIdSafe();
  if (_did) payload.device_id = _did;
  return apiCall('chat_livekit_token', payload, 'POST');
}

// [WAVE 119, 2026-05-22] Relay-first call invite v2 — single round-trip that:
//   1. Mints the LK token for the caller (no separate chat_livekit_token call)
//   2. Mints time-limited TURN HMAC credentials + returns turn_uris[]
//   3. INSERTs chat_call_active row (survives SFU/relay restart)
//   4. Fans VoIP/FCM/WS invites to every callee with the same payload
// Returns { call_id, lk_token, lk_url, lk_room, lk_expires_at, turn_uris,
//           turn_username, turn_password, turn_expires_at, call_type,
//           relay_node, backup_relay, e2ee_key_pending, invited[] }.
// Caller passes { conversationId, callId?, video, calleeEmail | emails[] }.
// See /var/www/mail/docs/relay-first-migration.md for runbook.
export async function chatCallInviteV2({ conversationId, callId, video = false, calleeEmail, emails, callType } = {}) {
  const payload = {
    conversation_id: conversationId,
    video: !!video,
  };
  if (callId) payload.call_id = callId;
  if (calleeEmail) payload.callee_email = calleeEmail;
  if (Array.isArray(emails) && emails.length) payload.emails = emails;
  if (callType) payload.call_type = callType;
  const _did = await _getDeviceIdSafe();
  if (_did) payload.device_id = _did;
  return apiCall('chat_call_invite_v2', payload, 'POST');
}

// Crash-recovery probe — clients hit this after DTLS drop / suspected relay
// restart to learn whether the call survived and which node to reconnect to.
// Returns { call: {...}, devices: [...] } or 404 if the call ended.
export async function chatCallActiveStateGet(callId) {
  return apiCall('chat_call_active_state_get', { call_id: callId }, 'POST');
}

// Explicit hangup/timeout/cancelled close — idempotent.
export async function chatCallActiveClose(callId, reason = 'hangup') {
  return apiCall('chat_call_active_close', { call_id: callId, reason }, 'POST');
}

// [gap E2 2026-05-20] "Join ongoing call" banner.
// Polls the chat_call_state table for an active (started, not ended,
// not locked) call attached to this conversation. Used by the chat
// header chip in chat-conversation.js to surface a tap-to-join CTA
// when a group call is already in progress and the current user is
// NOT a participant yet. Backend response shape:
//   { active: bool, locked: bool, call_id, room, participants: [emails],
//     started_at, host_email }
export async function chatCallStateActive(conversationId) {
  return apiCall('chat_call_state_active', { conversation_id: conversationId }, 'POST');
}

// ─── Group call host controls (2026-05-18) ───
// Mute ALL non-host participants in a group call. Backend enforces host role
// via conversation admin check, then fans `call_mute_request` WS events to
// every remote identity in the LK room (skipping host).
export async function chatCallMuteAll(conversationId, callId) {
  return apiCall('chat_call_mute_all', {
    conversation_id: conversationId,
    call_id: callId,
  }, 'POST');
}

// Host removes a participant from the call. Backend issues a LiveKit
// RemoveParticipant API call (server-authoritative kick) AND fans a WS
// `call_force_end` event to the target so their /group-call screen exits
// cleanly even when the LK signal arrives late.
export async function chatCallRemoveParticipant(conversationId, callId, targetEmail) {
  return apiCall('chat_call_remove_participant', {
    conversation_id: conversationId,
    call_id: callId,
    target_email: targetEmail,
  }, 'POST');
}

// Lock / unlock the room so no new joiners can hit the LK token endpoint
// for this call. Persisted in chat_call_state table — `chat_livekit_token`
// rejects locked rooms unless the requester is already a participant.
export async function chatCallSetLocked(conversationId, callId, locked) {
  return apiCall('chat_call_set_locked', {
    conversation_id: conversationId,
    call_id: callId,
    locked: locked ? 1 : 0,
  }, 'POST');
}

// Promote a participant to co-host. Co-hosts inherit the same mute/remove
// permissions as the original host. Tracked in chat_call_roles table.
export async function chatCallMakeCoHost(conversationId, callId, targetEmail) {
  return apiCall('chat_call_make_cohost', {
    conversation_id: conversationId,
    call_id: callId,
    target_email: targetEmail,
  }, 'POST');
}

// Toggle host recording state. When started, backend fans
// `call_recording_started` to all participants so every client paints the
// "Being recorded" banner (legal consent requirement in multiple
// jurisdictions). Stopping fans `call_recording_stopped`.
export async function chatCallSetRecording(conversationId, callId, recording) {
  return apiCall('chat_call_set_recording', {
    conversation_id: conversationId,
    call_id: callId,
    recording: recording ? 1 : 0,
  }, 'POST');
}

// Create / fetch a persistent shareable call link. Backend returns a URL
// `https://chatyy.com.br/call/<roomId>` plus the room id. The room is kept
// alive (in chat_call_state with type='link') and anyone with the link can
// hit `chat_livekit_token` against it until the host closes the call. Used
// by the "Share link" button in HostControlsSheet.
export async function chatCallCreateLink(conversationId, callId) {
  return apiCall('chat_call_create_link', {
    conversation_id: conversationId,
    call_id: callId,
  }, 'POST');
}

// ─── Live broadcast cohost (TikTok-style) ───
// Viewer calls this to ask the host to bring them on as a cohost. The
// raw-WS `live_join_request` path is silently dropped by the active Go WS
// hub (no case in main.go switch — only the legacy Node server had it
// and that's `inactive (dead)` post-migration). This REST endpoint
// publishes a `live_join_request` event onto the host's auto-subscribed
// `chat_user_{host_email}` channel via /broadcast, so the host's
// live-broadcast.js handler fires "X pediu pra entrar" reliably.
export async function liveCohostRequest(sessionId, hostEmail) {
  return apiCall('chat_live_cohost_request', {
    session_id: sessionId,
    host_email: hostEmail,
  }, 'POST');
}
// Host calls this to approve a viewer as cohost. Backend inserts auth row
// and pushes `live_cohost_approved` via WS to the viewer's channel.
export async function liveCohostApprove(sessionId, viewerEmail) {
  return apiCall('chat_live_cohost_approve', { session_id: sessionId, viewer_email: viewerEmail }, 'POST');
}
// Viewer (after receiving live_cohost_approved) calls this to get a
// LiveKit publisher token for the live session's room. Backend verifies
// the approve row exists for this user.
export async function liveCohostToken(sessionId) {
  return apiCall('chat_live_cohost_token', { session_id: sessionId }, 'POST');
}

// Stage 3 of #929 — host of a live session requests a subscribe-only LK
// token so they can render cohost video tracks alongside their own
// (still-via-raw-WebRTC) primary stream. Backend checks chat_live_sessions
// ownership before minting.
export async function liveHostLkToken(sessionId) {
  return apiCall('chat_live_host_lk_token', { session_id: sessionId }, 'POST');
}

// ─── Telnyx Verified Number (caller ID PSTN) ───
// phone optional (defaults to profile.verified_phone on the server). method
// is 'sms' (default) or 'call' — Telnyx sends the 6-digit code accordingly.
export async function voipVerifiedNumberRequest(phone, method) {
  const body = {};
  if (phone) body.phone = phone;
  if (method) body.method = method;
  return apiCall('voip_verified_number_request', body, 'POST');
}
export async function voipVerifiedNumberConfirm(code) {
  return apiCall('voip_verified_number_confirm', { code }, 'POST');
}
export async function voipVerifiedNumberStatus() {
  return apiCall('voip_verified_number_status', {}, 'POST');
}

// ─── QR login pairing ───
// device_kind ('web'|'mobile'|'desktop') is optional; backend defaults to
// 'web' to keep desktop QR login behavior identical when callers omit it.
// Companion mode (mobile-to-mobile) uses device_kind='mobile' on both sides.
export async function chatQrLoginCreate(deviceKind) {
  const body = deviceKind ? { device_kind: deviceKind } : {};
  return apiCall('chat_qr_login_create', body, 'POST');
}
export async function chatQrLoginStatus(token) {
  return apiCall('chat_qr_login_status', { token }, 'POST');
}
export async function chatQrLoginApprove(code, deviceKind) {
  const body = deviceKind ? { code, device_kind: deviceKind } : { code };
  return apiCall('chat_qr_login_approve', body, 'POST');
}


// ─── Channels (legacy aliases — use channelMyChannels/channelDiscover/channelFeed above) ───

// ─── Security / 2FA ───
export async function enable2fa(pin) {
  return apiCall('enable_2fa', pin ? { pin } : {}, 'POST');
}
export async function verify2fa(code) {
  return apiCall('verify_2fa', { code }, 'POST');
}
export async function disable2fa(password) {
  return apiCall('disable_2fa', { password }, 'POST');
}
export async function check2faStatus() {
  return apiCall('check_2fa_status');
}
export async function verifyLogin2fa(tempToken, code) {
  return apiCall('verify_login_2fa', { temp_token: tempToken, code }, 'POST');
}
export async function getLoginHistory() {
  return apiCall('login_history');
}

// ─── Explore / Social ───
export async function trendingHashtags(limit = 20) {
  return apiCall('trending_hashtags', { limit }, 'POST');
}
export async function closeFriendsList() {
  return apiCall('close_friends_list', {}, 'POST');
}
export async function closeFriendsAdd(email) {
  return apiCall('close_friends_add', { email }, 'POST');
}
export async function closeFriendsRemove(email) {
  return apiCall('close_friends_remove', { email }, 'POST');
}
export async function closeFriendsSet(emails) {
  return apiCall('close_friends_set', { emails: Array.isArray(emails) ? emails : [] }, 'POST');
}

// Creator analytics (last 7 days). Returns 3 cards + 7-day sparklines:
// profile_views_count, posts_reach, engagement_total, spark_views/reach/engagement.
export async function profileInsights() {
  return apiCall('profile_insights', {}, 'POST');
}

// ─── Chatyy Pay ───
export async function paymentSend(toEmail, amount, currency = 'BRL') {
  return apiCall('payment_send', { to_email: toEmail, amount, currency }, 'POST');
}
export async function paymentHistory(limit = 50) {
  return apiCall('payment_history', { limit });
}
export async function paymentGeneratePix(amount) {
  return apiCall('payment_generate_pix', { amount }, 'POST');
}

// ─── Business ───
export async function businessSetup(data) {
  return apiCall('business_setup', data, 'POST');
}
export async function businessAnalytics() {
  return apiCall('business_analytics');
}
export async function businessAutoReply(message) {
  return apiCall('business_auto_reply', { message }, 'POST');
}

// ─── Premium ───
export async function premiumSubscribe() {
  return apiCall('premium_subscribe', {}, 'POST');
}
export async function premiumStatus() {
  return apiCall('premium_status');
}

// ─── Ads ───
export async function adCreate(data) {
  return apiCall('ad_create', data, 'POST');
}
export async function adList() {
  return apiCall('ad_list');
}

// ─── Communities (Telegram-style supergroups) ───
// Backend (chat.php): community_* actions with handle/photo/cover/rules/welcome.
export async function communityCreate(payload = {}) {
  // Accept either positional legacy (name, description, icon) or full payload object.
  const body = (typeof payload === 'string')
    ? { name: payload, description: arguments[1] || '', photo_url: arguments[2] || '' }
    : { ...payload };
  return apiCall('community_create', body, 'POST');
}
export async function communityList() {
  return apiCall('community_list');
}
export async function communityInfo(idOrHandle) {
  // Accept numeric id or string @handle — backend resolves both.
  return apiCall('community_info', { community_id: idOrHandle, id_or_handle: idOrHandle });
}
export async function communityUpdate(communityId, fields = {}) {
  return apiCall('community_update', { community_id: communityId, ...fields }, 'POST');
}
export async function communityAddGroup(communityId, opts = {}) {
  // opts: { conversation_id?, name?, kind? }
  // Back-compat: a numeric second arg means "link existing conversation".
  const body = (typeof opts === 'number') ? { conversation_id: opts } : opts;
  return apiCall('community_add_group', { community_id: communityId, ...body }, 'POST');
}
export async function communityRemoveGroup(communityId, conversationId) {
  return apiCall('community_remove_group', { community_id: communityId, conversation_id: conversationId }, 'POST');
}
export async function communityMembers(communityId) {
  return apiCall('community_members', { community_id: communityId });
}
export async function communityAnnounce(communityId, text, attachments = null) {
  return apiCall('community_announce', { community_id: communityId, text, attachments }, 'POST');
}
// Back-compat with older call sites
export async function communityAnnouncement(communityId, content) {
  return apiCall('community_announce', { community_id: communityId, text: content }, 'POST');
}
export async function communityMemberRole(communityId, memberEmail, role) {
  return apiCall('community_member_role', { community_id: communityId, member_email: memberEmail, role }, 'POST');
}
export async function communityKick(communityId, memberEmail) {
  return apiCall('community_kick', { community_id: communityId, member_email: memberEmail }, 'POST');
}
export async function communityDiscover(opts = {}) {
  // opts: { category?, q?, limit?, offset? }
  return apiCall('community_discover', { ...opts });
}
export async function communityJoin(idOrHandle) {
  return apiCall('community_join', { community_id: idOrHandle, id_or_handle: idOrHandle }, 'POST');
}
export async function communityLeave(communityId) {
  return apiCall('community_leave', { community_id: communityId }, 'POST');
}

// (notifications* exports defined earlier — duplicate removed to fix bundler error)

// ─── Marketplace ───
export async function marketplaceList(params = {}) {
  return apiCall('marketplace_list', params);
}
export async function marketplaceCreate(data) {
  return apiCall('marketplace_create', data, 'POST');
}
export async function marketplaceDetail(listingId) {
  return apiCall('marketplace_detail', { listing_id: listingId });
}
export async function marketplaceFavorite(listingId) {
  return apiCall('marketplace_favorite', { listing_id: listingId }, 'POST');
}
export async function marketplaceOffer(listingId, amountCents, message = '') {
  return apiCall('marketplace_offer', { listing_id: listingId, amount_cents: amountCents, message }, 'POST');
}
export async function marketplaceMyListings() {
  return apiCall('marketplace_my_listings');
}
export async function marketplaceSaved() {
  return apiCall('marketplace_saved');
}
export async function marketplaceDelete(listingId) {
  return apiCall('marketplace_delete', { listing_id: listingId }, 'POST');
}

// ─── Business (WhatsApp Business) ───
export async function businessGetProfile() { return apiCall('business_get_profile'); }
export async function businessSaveProfile(data) { return apiCall('business_save_profile', data, 'POST'); }
export async function businessListProducts(search = '') { return apiCall('business_list_products', search ? { search } : {}); }
export async function businessAddProduct(data) { return apiCall('business_add_product', data, 'POST'); }
export async function businessUpdateProduct(data) { return apiCall('business_update_product', data, 'POST'); }
export async function businessDeleteProduct(productId) { return apiCall('business_delete_product', { product_id: productId }, 'POST'); }
export async function businessPlaceOrder(data) { return apiCall('business_place_order', data, 'POST'); }
export async function businessGetAutoreplies() { return apiCall('business_get_autoreplies'); }
export async function businessSaveAutoreplies(data) { return apiCall('business_save_autoreplies', data, 'POST'); }
export async function businessAddQuickReply(data) { return apiCall('business_add_quick_reply', data, 'POST'); }
export async function businessUpdateQuickReply(data) { return apiCall('business_update_quick_reply', data, 'POST'); }
export async function businessDeleteQuickReply(id) { return apiCall('business_delete_quick_reply', { id }, 'POST'); }
export async function businessListLabels() { return apiCall('business_list_labels'); }
export async function businessAddLabel(data) { return apiCall('business_add_label', data, 'POST'); }
export async function businessUpdateLabel(data) { return apiCall('business_update_label', data, 'POST'); }
export async function businessDeleteLabel(labelId) { return apiCall('business_delete_label', { label_id: labelId }, 'POST'); }
export async function businessAssignLabel(conversationId, labelId) { return apiCall('business_assign_label', { conversation_id: conversationId, label_id: labelId }, 'POST'); }
export async function businessRemoveLabel(conversationId, labelId) { return apiCall('business_remove_label', { conversation_id: conversationId, label_id: labelId }, 'POST'); }

// ============================================================
// EMAIL GAP CLOSURES (2026-05-17) — confidential SMS OTP, unsubscribe,
// saved searches, URL preview, nested labels.
// ============================================================

// Send an SMS OTP to the recipient of a confidential email so they can
// unlock the body. Recipient receives a 6-digit code on the phone the
// sender attached when creating the confidential email.
export async function emailConfidentialSendOtp(confidentialId) {
  return apiCall('email_confidential_send_otp', { id: confidentialId }, 'POST');
}

// Verify the 6-digit code and receive an opaque otp_token. Pass that token
// back to confidential_view to retrieve the email body.
export async function emailConfidentialVerifyOtp(confidentialId, code) {
  return apiCall('email_confidential_verify_otp', { id: confidentialId, code }, 'POST');
}

// One-shot unsubscribe — backend dispatches an HTTP one-click request and
// (when present) a mailto: unsubscribe email on the user's behalf.
export async function emailUnsubscribe({ url = '', mailto = '', oneClick = false, headers = '' } = {}) {
  return apiCall('email_unsubscribe', { url, mailto, one_click: oneClick ? 1 : 0, headers }, 'POST');
}

// Saved searches CRUD (PG-backed via chat_user_saved_searches).
export async function emailSearchSave(query, name = '') {
  return apiCall('email_search_save', { query, name }, 'POST');
}
export async function emailSearchList() {
  // [2026-05-19] Skip when no bearer — endpoint requires auth + 400s otherwise,
  // and inbox.js calls it on every cold start before login finishes hydrating.
  if (!authToken) return { success: false, data: { searches: [] } };
  return apiCall('email_search_list');
}
export async function emailSearchDelete(id) {
  return apiCall('email_search_delete', { id }, 'POST');
}

// URL preview for compose unfurl — backend scrapes og:* meta tags.
export async function emailUrlPreview(url) {
  return apiCall('email_url_preview', { url }, 'POST');
}

// Nested labels (PG-backed with parent_label).
export async function labelList() {
  return apiCall('label_list');
}
export async function labelCreateNested(name, color = '#1a73e8', parentLabel = null) {
  return apiCall('label_create_nested', { name, color, parent_label: parentLabel || '' }, 'POST');
}
export async function labelDeleteNested({ id = 0, name = '' } = {}) {
  return apiCall('label_delete_nested', { id, name }, 'POST');
}

// ──────────────────────────────────────────────────────────────────
// OAuth import (Gmail / Outlook). Frontend obtains the access_token
// via expo-auth-session and posts it here; the backend pages through
// the provider's API and APPENDs each message into a sub-folder under
// the user's maildir via IMAP. Sync is chunked (25/call) so the UI
// shows a smooth progress bar without one giant 60-second request.
// ──────────────────────────────────────────────────────────────────
export async function emailOauthImportStart(provider, accessToken, maxEmails = 1000) {
  return apiCall('email_oauth_import_start', { provider, access_token: accessToken, max_emails: maxEmails }, 'POST');
}
export async function emailOauthImportStep(importId) {
  return apiCall('email_oauth_import_step', { import_id: importId }, 'POST');
}
export async function emailOauthImportList() {
  return apiCall('email_oauth_import_list');
}

// ──────────────────────────────────────────────────────────────────
// PGP key registry — public keys go to PG; private keys live ONLY
// on the device in SecureStore (encrypted with the user passphrase
// the openpgpjs lib applies). Body-encryption happens client-side
// via OpenPGP.js; we just shuttle armored blocks around.
// ──────────────────────────────────────────────────────────────────
export async function pgpKeyUpload(publicKeyArmor, fingerprint) {
  return apiCall('pgp_key_upload', { public_key_armor: publicKeyArmor, fingerprint }, 'POST');
}
export async function pgpKeyGet(email) {
  return apiCall('pgp_key_get', { email });
}
export async function pgpKeyDelete() {
  return apiCall('pgp_key_delete', {}, 'POST');
}
export async function pgpSendPassphraseSms(phone, passphrase) {
  return apiCall('pgp_send_passphrase_sms', { phone, passphrase }, 'POST');
}

// ──────────────────────────────────────────────────────────────────
// Tasks — PG-backed user task list with optional backref to an email.
// ──────────────────────────────────────────────────────────────────
export async function taskList(filter = 'pending') {
  return apiCall('task_list', { filter });
}
export async function taskCreate(payload) {
  return apiCall('task_create', payload, 'POST');
}
export async function taskUpdate(id, fields) {
  return apiCall('task_update', { id, ...fields }, 'POST');
}
export async function taskDelete(id) {
  return apiCall('task_delete', { id }, 'POST');
}
export async function taskCreateFromEmail(uid, folder = 'INBOX', extra = {}) {
  return apiCall('task_create_from_email', { uid, folder, ...extra }, 'POST');
}

// ──────────────────────────────────────────────────────────────────
// Gmail-style bundles for the active folder (default INBOX). The
// response shape mirrors CategoryTabs so the inbox screen can render
// them with the same component.
// ──────────────────────────────────────────────────────────────────
export async function emailBundles(folder = 'INBOX', limit = 80) {
  return apiCall('email_bundles', { folder, limit });
}

// Mark every unread in the entire current folder as read in one IMAP
// command (not just the visible UIDs in the email list).
export async function bulkMarkReadFolder(folder = 'INBOX') {
  return apiCall('bulk_mark_read_folder', { folder }, 'POST');
}

// ──────────────────────────────────────────────────────────────────
// Identity / contacts gap-fills (2026-05-18)
// ──────────────────────────────────────────────────────────────────

// "Contatos em comum" — intersection of the viewer's contact book with
// the target user's contact book. Backend endpoint `common_contacts`
// (otherEmail) → { items: [{ email, name, avatar }] }. If the backend
// hasn't been deployed yet it returns 404 / unsupported_action; we
// swallow that and resolve with an empty list so the UI can render a
// "Em breve" placeholder. TODO: implement common_contacts in email.php.
export async function commonContacts(otherUserEmail) {
  if (!otherUserEmail) return { items: [] };
  try {
    const r = await apiCall('common_contacts', { email: otherUserEmail });
    if (Array.isArray(r?.items)) return { items: r.items };
    if (Array.isArray(r)) return { items: r };
    return { items: [] };
  } catch (e) {
    return { items: [] };
  }
}

// Linked alt phone numbers (secondary numbers attached to the same
// account — primary stays managed via /change-phone). Stub endpoints so
// the UI ships now; backend `linked_phones_list/add/remove` to follow.
// On unsupported backend we degrade to empty/no-op without throwing.
export async function linkedPhonesList() {
  try {
    const r = await apiCall('linked_phones_list');
    if (Array.isArray(r?.items)) return { items: r.items };
    if (Array.isArray(r)) return { items: r };
    return { items: [] };
  } catch (e) {
    return { items: [] };
  }
}

export async function linkedPhonesAdd(phone) {
  if (!phone) return { success: false, error: 'missing_phone' };
  try {
    const r = await apiCall('linked_phones_add', { phone }, 'POST');
    return r || { success: true };
  } catch (e) {
    // Backend stub — pretend success so the flow is testable end-to-end.
    return { success: true, stub: true };
  }
}

export async function linkedPhonesRemove(phone) {
  if (!phone) return { success: false, error: 'missing_phone' };
  try {
    const r = await apiCall('linked_phones_remove', { phone }, 'POST');
    return r || { success: true };
  } catch (e) {
    return { success: true, stub: true };
  }
}

// Push login (SuperBora-style cross-app sign-in). Direct fetch instead of
// apiCall() because this endpoint lives outside /api/email.php — it's a
// standalone PHP at /api/push/login-approve that the user approves via
// the global PushLoginRequestModal.
async function _pushLoginRespond(challengeId, action) {
  if (!challengeId) throw new Error('missing_challenge_id');
  const r = await fetch(`${BASE_URL}/api/push/login-approve`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, action }),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  if (!r.ok) {
    const err = new Error((json && json.error) || `http_${r.status}`);
    err.status = r.status;
    err.response = json;
    throw err;
  }
  return json || { ok: true };
}

export async function pushLoginApprove(challengeId) {
  return _pushLoginRespond(challengeId, 'approve');
}

export async function pushLoginReject(challengeId) {
  return _pushLoginRespond(challengeId, 'reject');
}
