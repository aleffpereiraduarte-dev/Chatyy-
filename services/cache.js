// Chatyy Cache Service v2 — powered by MMKV (<1ms sync reads)
// Pattern: show cached data INSTANTLY, fetch fresh in background
// All keys are prefixed with the current user's email hash to prevent cross-account leaks

import { Platform } from 'react-native';
import { getString, setString, remove, getAllKeys } from './mmkv';

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
    keys.filter(k => k.startsWith(BASE_PREFIX) || k.startsWith('chat_')).forEach(k => remove(k));
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
