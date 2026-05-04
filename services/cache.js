// Chatyy Cache Service v2 — powered by MMKV (<1ms sync reads)
// Pattern: show cached data INSTANTLY, fetch fresh in background
// All keys are prefixed with the current user's email hash to prevent cross-account leaks

import { Platform } from 'react-native';
import { getString, setString, remove, getAllKeys } from './mmkv';

// Helper: scope a cache key to the currently-active user. Returns
// "u:<emailLower>:<key>" so two accounts on the same device write to
// different storage slots and can't read each other's drafts/locks.
// Falls back to the bare key if no active email (rare — only during
// initial mount before AuthContext hydrates).
//
// We require api.js lazily to avoid a circular import (api.js imports
// nothing from cache.js today, but defensive: lazy require keeps the
// module graph safe if someone wires it in).
export function userScopedKey(rawKey) {
  try {
    // Lazy require avoids a top-level circular dep with services/api.js
    const { getActiveAccountEmail } = require('./api');
    const email = (typeof getActiveAccountEmail === 'function' ? getActiveAccountEmail() : '') || '';
    const e = String(email).toLowerCase();
    if (!e) return rawKey;
    return `u:${e}:${rawKey}`;
  } catch {
    return rawKey;
  }
}

const BASE_PREFIX = '@chatyy_cache_';
let _userHash = '';

// --- In-memory LRU for sub-microsecond access ---
const _memCache = new Map();
const MEM_MAX = 200;

function _memSet(key, data) {
  if (_memCache.size >= MEM_MAX) {
    const first = _memCache.keys().next().value;
    _memCache.delete(first);
  }
  _memCache.set(key, data);
}

/**
 * Set the current user for cache isolation.
 * Must be called after login/account switch BEFORE any cache reads.
 */
export function setCacheUser(email) {
  const prevHash = _userHash;
  if (email) {
    let hash = 0;
    for (let i = 0; i < email.length; i++) {
      hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0;
    }
    _userHash = Math.abs(hash).toString(36) + '_';
  } else {
    _userHash = '';
  }
  // Clear in-memory cache when user changes to prevent cross-account data leaks
  if (_userHash !== prevHash) {
    _memCache.clear();
  }
}

function _getPrefix() {
  return BASE_PREFIX + _userHash;
}

/**
 * Get cached data — memory first, then MMKV (<1ms).
 * Returns null if no cache or expired.
 */
export async function getCached(key) {
  const fullKey = _getPrefix() + key;

  // 1. Memory (instant)
  const mem = _memCache.get(fullKey);
  if (mem) {
    if (mem.expiry && Date.now() > mem.expiry) {
      _memCache.delete(fullKey);
    } else {
      return mem.data;
    }
  }

  // 2. MMKV (<1ms)
  try {
    const raw = getString(fullKey);
    if (!raw) return null;
    const { data, expiry } = JSON.parse(raw);
    if (expiry && Date.now() > expiry) {
      remove(fullKey);
      return null;
    }
    _memSet(fullKey, { data, expiry });
    return data;
  } catch { return null; }
}

/**
 * Get cached data SYNCHRONOUSLY from memory or MMKV.
 * For use in useState initializers.
 */
export function getCachedSync(key) {
  const fullKey = _getPrefix() + key;

  // Memory first
  const mem = _memCache.get(fullKey);
  if (mem) {
    if (mem.expiry && Date.now() > mem.expiry) {
      _memCache.delete(fullKey);
      return null;
    }
    return mem.data;
  }

  // MMKV (sync!)
  try {
    const raw = getString(fullKey);
    if (!raw) return null;
    const { data, expiry } = JSON.parse(raw);
    if (expiry && Date.now() > expiry) return null;
    _memSet(fullKey, { data, expiry });
    return data;
  } catch { return null; }
}

/**
 * Store data in cache with TTL.
 * @param {string} key
 * @param {any} data
 * @param {number} ttlMs - Time to live in ms (default 90 days)
 */
export async function setCache(key, data, ttlMs = 7776000000) {
  const fullKey = _getPrefix() + key;
  const entry = { data, expiry: Date.now() + ttlMs };

  _memSet(fullKey, entry);

  try {
    setString(fullKey, JSON.stringify(entry));
  } catch {}
}

/**
 * Clear a specific cache key.
 */
export async function clearCache(key) {
  const fullKey = _getPrefix() + key;
  _memCache.delete(fullKey);
  try { remove(fullKey); } catch {}
}

/**
 * Clear ALL chatyy cache entries (all users).
 */
export async function clearAll() {
  _memCache.clear();
  try {
    const keys = getAllKeys();
    // Apenas chaves do nosso namespace — antes incluía qualquer 'chat_*'
    // o que apagava caches de terceiros / AsyncStorage de chat unrelated.
    keys.filter(k => k.startsWith(BASE_PREFIX)).forEach(k => remove(k));
  } catch {}
}

/**
 * Pre-warm cache: load from MMKV into memory.
 */
export async function warmCache(keys) {
  for (const key of keys) {
    try { await getCached(key); } catch {}
  }
}

/**
 * Pre-fetch and cache data from API.
 */
export async function prefetch(key, apiFn, ttlMs = 2592000000) {
  try {
    const data = await apiFn();
    if (data && data.success !== false) {
      await setCache(key, data, ttlMs);
    }
    return data;
  } catch { return null; }
}

// In-flight network requests — dedupes concurrent SWR calls for the same key
// so we don't hit the backend multiple times when several components mount
// simultaneously (chat list + sidebar + status row all reading feed_list).
const _inflight = new Map();

/**
 * Stale-while-revalidate — returns cached data INSTANTLY via onCached, then
 * fires the network and calls onFresh if the result changed. Use this in
 * effects when you want cache-first rendering with background refresh.
 *
 * Example:
 *   useEffect(() => {
 *     swr('feed_list_p1', () => api.feedList(1),
 *       (cached) => setPosts(cached.data?.posts || []),
 *       (fresh)  => setPosts(fresh.data?.posts || []),
 *       { ttlMs: 5 * 60 * 1000 } // 5min freshness
 *     );
 *   }, []);
 */
export async function swr(key, apiFn, onCached, onFresh, opts = {}) {
  const { ttlMs = 5 * 60 * 1000, staleAfterMs = 30 * 1000 } = opts;

  // 1. Hit cache synchronously (memory or MMKV) so the first paint shows
  //    something immediately.
  const cached = getCachedSync(key);
  if (cached !== null && onCached) {
    try { onCached(cached); } catch {}
  }

  // 2. Cached entries newer than staleAfterMs are considered fresh enough —
  //    skip the network call to save bandwidth and backend cycles.
  if (cached !== null) {
    try {
      const raw = getString(_getPrefix() + key);
      if (raw) {
        const meta = JSON.parse(raw);
        const writtenAt = (meta.expiry || 0) - ttlMs;
        if (Date.now() - writtenAt < staleAfterMs) {
          return cached; // recent, skip network
        }
      }
    } catch {}
  }

  // 3. Dedupe concurrent calls — one network per key.
  const fullKey = _getPrefix() + key;
  if (_inflight.has(fullKey)) {
    return _inflight.get(fullKey);
  }

  const p = (async () => {
    try {
      const fresh = await apiFn();
      if (fresh && fresh.success !== false) {
        await setCache(key, fresh, ttlMs);
        if (onFresh) {
          // Only dispatch if data actually changed (cheap JSON compare)
          try {
            const changed = cached === null || JSON.stringify(cached) !== JSON.stringify(fresh);
            if (changed) onFresh(fresh);
          } catch { onFresh(fresh); }
        }
      }
      return fresh;
    } catch {
      return null;
    } finally {
      _inflight.delete(fullKey);
    }
  })();
  _inflight.set(fullKey, p);
  return p;
}

