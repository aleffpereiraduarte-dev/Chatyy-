/**
 * Chatyy Presence Cache — offline-resilient last-seen / online state.
 *
 * Why: when the WebSocket drops or the device is offline, the chat UI used to
 * fall back to "?" because there was no cached presence. With this cache, we
 * persist last_seen_at + is_online per email and surface the most recent value
 * we know about ("Visto hoje às 14:30") with an `isStale` flag the UI can use
 * to dim the indicator while we wait for fresh data.
 *
 * Storage: AsyncStorage key `@chatyy/presence_cache_v1`
 *   Map<email, { last_seen_at: number, is_online: boolean, updated_at: number }>
 *
 * TTL: 7 days. Entries older than that are dropped on the next prune.
 *
 * Wire (future): in services/websocket.js message handler, case 'presence_update':
 *   await setPresence(data.email, { last_seen_at: data.last_seen, is_online: data.online });
 * On cold boot (e.g. ChatListTab mount), call getAllPresence() once for batch
 * hydration of every row instead of doing per-email reads.
 *
 * NOTE: this service does NOT import websocket.js / LanguageContext /
 * ThemeContext / any chat cache — it's intentionally standalone so the future
 * websocket wiring is a single import.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@chatyy/presence_cache_v1';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;            // 7 days
const STALE_AFTER_MS = 2 * 60 * 1000;              // 2 min — UI dims indicator
const ONLINE_FRESH_MS = 60 * 1000;                 // 60 s — "Online" only if last update under this

// ─── In-memory mirror ────────────────────────────────────────────────────
// AsyncStorage is async; chat list rows render synchronously. We keep a hot
// copy in memory so getPresence is sync-friendly after the first hydration.
let _mem = null;          // null = not yet loaded from disk
let _loading = null;      // Promise<void> while initial load is in flight
const _subs = new Map();  // email -> Set<callback>

async function _ensureLoaded() {
  if (_mem) return _mem;
  if (_loading) { await _loading; return _mem; }
  _loading = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      _mem = raw ? (JSON.parse(raw) || {}) : {};
    } catch {
      _mem = {};
    }
  })();
  await _loading;
  _loading = null;
  return _mem;
}

// Debounced persistence — avoids hammering AsyncStorage when many presence
// events arrive back-to-back (typical right after WS reconnect).
let _persistTimer = null;
function _schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(async () => {
    _persistTimer = null;
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(_mem || {}));
    } catch {
      // swallow — next write will retry
    }
  }, 250);
}

function _notify(email) {
  const set = _subs.get(email);
  if (!set || set.size === 0) return;
  const snapshot = _readSync(email);
  for (const cb of set) {
    try { cb(snapshot); } catch {}
  }
}

function _normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function _readSync(email) {
  const key = _normalizeEmail(email);
  if (!key || !_mem) return null;
  const entry = _mem[key];
  if (!entry) return null;
  const now = Date.now();
  const isStale = (now - (entry.updated_at || 0)) > STALE_AFTER_MS;
  return {
    last_seen_at: entry.last_seen_at || 0,
    is_online: !!entry.is_online,
    isStale,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Store / overwrite a presence entry for an email.
 * @param {string} email
 * @param {{ last_seen_at?: number, is_online?: boolean }} data
 */
export async function setPresence(email, { last_seen_at, is_online } = {}) {
  const key = _normalizeEmail(email);
  if (!key) return;
  await _ensureLoaded();
  const now = Date.now();
  const prev = _mem[key] || {};
  // last_seen_at: prefer the explicit value; if omitted but the user is
  // online, treat now() as the last activity timestamp.
  const nextLastSeen =
    typeof last_seen_at === 'number' && last_seen_at > 0
      ? last_seen_at
      : is_online
        ? now
        : (prev.last_seen_at || 0);
  _mem[key] = {
    last_seen_at: nextLastSeen,
    is_online: !!is_online,
    updated_at: now,
  };
  _schedulePersist();
  _notify(key);
}

/**
 * Read a single presence entry. Returns null when we have no cached value
 * (caller can render "?" or a skeleton). When present, includes `isStale`
 * so the UI can dim the dot until fresh data arrives.
 * @param {string} email
 * @returns {Promise<null | { last_seen_at: number, is_online: boolean, isStale: boolean }>}
 */
export async function getPresence(email) {
  await _ensureLoaded();
  return _readSync(email);
}

/**
 * Batch read for cold boot — returns the whole map keyed by email.
 * Use this once in ChatListTab mount, then subscribePresence per row.
 * @returns {Promise<Record<string, { last_seen_at: number, is_online: boolean, isStale: boolean }>>}
 */
export async function getAllPresence() {
  await _ensureLoaded();
  const now = Date.now();
  const out = {};
  for (const [k, entry] of Object.entries(_mem)) {
    if (!entry) continue;
    out[k] = {
      last_seen_at: entry.last_seen_at || 0,
      is_online: !!entry.is_online,
      isStale: (now - (entry.updated_at || 0)) > STALE_AFTER_MS,
    };
  }
  return out;
}

/**
 * Drop entries older than 7 days. Safe to call on app start or from a
 * periodic background task.
 * @returns {Promise<number>} number of removed entries
 */
export async function pruneOldPresence() {
  await _ensureLoaded();
  const now = Date.now();
  let removed = 0;
  for (const [k, entry] of Object.entries(_mem)) {
    if (!entry || (now - (entry.updated_at || 0)) > TTL_MS) {
      delete _mem[k];
      removed++;
    }
  }
  if (removed > 0) _schedulePersist();
  return removed;
}

/**
 * Subscribe to presence changes for a single email. Returns an unsubscribe
 * fn. The callback receives the same shape as getPresence().
 * @param {string} email
 * @param {(snapshot: null | { last_seen_at: number, is_online: boolean, isStale: boolean }) => void} callback
 * @returns {() => void}
 */
export function subscribePresence(email, callback) {
  const key = _normalizeEmail(email);
  if (!key || typeof callback !== 'function') return () => {};
  let set = _subs.get(key);
  if (!set) { set = new Set(); _subs.set(key, set); }
  set.add(callback);
  // Fire once with current value (may be null until hydrated).
  if (_mem) {
    try { callback(_readSync(key)); } catch {}
  } else {
    _ensureLoaded().then(() => {
      try { callback(_readSync(key)); } catch {}
    });
  }
  return () => {
    const s = _subs.get(key);
    if (!s) return;
    s.delete(callback);
    if (s.size === 0) _subs.delete(key);
  };
}

// ─── i18n-safe display formatter ─────────────────────────────────────────

function _pad2(n) { return n < 10 ? '0' + n : String(n); }

function _formatTime(d, locale) {
  try {
    return d.toLocaleTimeString(locale || undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return _pad2(d.getHours()) + ':' + _pad2(d.getMinutes());
  }
}

function _formatShortDate(d, locale) {
  // DD/MM for pt/es, MM/DD for en, plus whatever the locale prefers otherwise.
  try {
    return d.toLocaleDateString(locale || undefined, {
      day: '2-digit',
      month: '2-digit',
    });
  } catch {
    return _pad2(d.getDate()) + '/' + _pad2(d.getMonth() + 1);
  }
}

function _isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function _interpolate(template, vars) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (_m, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : '',
  );
}

/**
 * Render a localized last-seen string.
 *
 * Rules:
 *  - is_online && last_seen recent (< 60s)  → "Online"
 *  - last_seen < 60s ago                    → "Visto agora"
 *  - last_seen < 60min ago                  → "Visto há {n} min"
 *  - same calendar day                      → "Visto hoje às HH:MM"
 *  - yesterday                              → "Visto ontem às HH:MM"
 *  - older                                  → "Visto DD/MM às HH:MM"
 *
 * @param {number | { last_seen_at: number, is_online?: boolean }} input
 *        Either a raw timestamp or a presence snapshot from getPresence().
 * @param {(key: string, vars?: object) => string} t  i18n translator from LanguageContext
 * @param {string} [locale]  optional BCP-47 locale (e.g. "pt-BR"); used for date/time formatting
 * @returns {string}  empty string when there's nothing to show
 */
export function formatLastSeen(input, t, locale) {
  if (!input && input !== 0) return '';

  let last_seen_at = 0;
  let is_online = false;
  if (typeof input === 'number') {
    last_seen_at = input;
  } else if (typeof input === 'object') {
    last_seen_at = Number(input.last_seen_at) || 0;
    is_online = !!input.is_online;
  }
  if (!last_seen_at) return '';

  const tr = typeof t === 'function' ? t : (k, v) => _interpolate(k, v || {});
  const now = Date.now();
  const diffMs = Math.max(0, now - last_seen_at);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);

  if (is_online && diffMs < ONLINE_FRESH_MS) {
    return tr('presence.online');
  }
  if (diffSec < 60) {
    return tr('presence.justNow');
  }
  if (diffMin < 60) {
    return tr('presence.minutesAgo', { n: diffMin });
  }

  const seenDate = new Date(last_seen_at);
  const today = new Date(now);
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  const timeStr = _formatTime(seenDate, locale);

  if (_isSameDay(seenDate, today)) {
    return tr('presence.todayAt', { time: timeStr });
  }
  if (_isSameDay(seenDate, yesterday)) {
    return tr('presence.yesterdayAt', { time: timeStr });
  }
  const dateStr = _formatShortDate(seenDate, locale);
  return tr('presence.dateAt', { date: dateStr, time: timeStr });
}

// ─── Test helpers (not exported via index, but useful for unit tests) ────
export const __TEST__ = {
  STORAGE_KEY,
  TTL_MS,
  ONLINE_FRESH_MS,
  STALE_AFTER_MS,
  _reset: () => {
    _mem = {};
    _subs.clear();
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  },
};
