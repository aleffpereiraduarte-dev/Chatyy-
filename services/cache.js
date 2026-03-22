// Chatyy Cache Service - instant data for native feel
// Uses localStorage (web) / AsyncStorage (native) for persistence
// Pattern: show cached data INSTANTLY, fetch fresh in background
// All keys are prefixed with the current user's email hash to prevent cross-account leaks

import { Platform } from 'react-native';

const BASE_PREFIX = '@chatyy_cache_';
let _userHash = ''; // Set on login, cleared on logout

/**
 * Set the current user for cache isolation.
 * Must be called after login/account switch BEFORE any cache reads.
 */
export function setCacheUser(email) {
  if (email) {
    // Simple hash to keep keys short
    let hash = 0;
    for (let i = 0; i < email.length; i++) {
      hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0;
    }
    _userHash = Math.abs(hash).toString(36) + '_';
  } else {
    _userHash = '';
  }
}

function _getPrefix() {
  return BASE_PREFIX + _userHash;
}

// --- Storage abstraction (same as offlineCache.js) ---
let _asyncStorage = null;
async function getAS() {
  if (Platform.OS === 'web') return null;
  if (!_asyncStorage) {
    try { _asyncStorage = (await import('@react-native-async-storage/async-storage')).default; } catch {}
  }
  return _asyncStorage;
}

function _webGet(key) {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
}
function _webSet(key, val) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch {}
}
function _webRemove(key) {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); } catch {}
}

// --- In-memory LRU for instant access (no async needed) ---
const _memCache = new Map();
const MEM_MAX = 50;

function _memSet(key, data) {
  if (_memCache.size >= MEM_MAX) {
    // Remove oldest entry
    const first = _memCache.keys().next().value;
    _memCache.delete(first);
  }
  _memCache.set(key, data);
}

// --- Public API ---

/**
 * Get cached data synchronously from memory, or async from storage.
 * Returns null if no cache or expired.
 */
export async function getCached(key) {
  const fullKey = _getPrefix() + key;

  // 1. Try memory cache first (instant)
  const mem = _memCache.get(fullKey);
  if (mem) {
    if (mem.expiry && Date.now() > mem.expiry) {
      _memCache.delete(fullKey);
    } else {
      return mem.data;
    }
  }

  // 2. Try persistent storage
  try {
    let raw;
    if (Platform.OS === 'web') {
      raw = _webGet(fullKey);
    } else {
      const as = await getAS();
      if (!as) return null;
      raw = await as.getItem(fullKey);
    }
    if (!raw) return null;
    const { data, expiry } = JSON.parse(raw);
    if (expiry && Date.now() > expiry) {
      // Expired - clean up
      if (Platform.OS === 'web') _webRemove(fullKey);
      else { const as = await getAS(); if (as) as.removeItem(fullKey).catch(() => {}); }
      return null;
    }
    // Promote to memory cache
    _memSet(fullKey, { data, expiry });
    return data;
  } catch { return null; }
}

/**
 * Get cached data SYNCHRONOUSLY from memory only.
 * For use in useState initializers. Returns null if not in memory.
 */
export function getCachedSync(key) {
  const fullKey = _getPrefix() + key;
  const mem = _memCache.get(fullKey);
  if (mem) {
    if (mem.expiry && Date.now() > mem.expiry) {
      _memCache.delete(fullKey);
      return null;
    }
    return mem.data;
  }
  // On web, try localStorage synchronously
  if (Platform.OS === 'web') {
    try {
      const raw = _webGet(fullKey);
      if (!raw) return null;
      const { data, expiry } = JSON.parse(raw);
      if (expiry && Date.now() > expiry) return null;
      _memSet(fullKey, { data, expiry });
      return data;
    } catch { return null; }
  }
  return null;
}

/**
 * Store data in cache with TTL.
 * @param {string} key
 * @param {any} data
 * @param {number} ttlMs - Time to live in ms (default 5 min)
 */
export async function setCache(key, data, ttlMs = 300000) {
  const fullKey = _getPrefix() + key;
  const entry = { data, expiry: Date.now() + ttlMs };

  // 1. Always update memory cache (instant for next read)
  _memSet(fullKey, entry);

  // 2. Persist to storage (async, fire-and-forget is fine)
  try {
    const json = JSON.stringify(entry);
    if (Platform.OS === 'web') {
      _webSet(fullKey, json);
    } else {
      const as = await getAS();
      if (as) await as.setItem(fullKey, json);
    }
  } catch {}
}

/**
 * Clear a specific cache key.
 */
export async function clearCache(key) {
  const fullKey = _getPrefix() + key;
  _memCache.delete(fullKey);
  try {
    if (Platform.OS === 'web') {
      _webRemove(fullKey);
    } else {
      const as = await getAS();
      if (as) await as.removeItem(fullKey);
    }
  } catch {}
}

/**
 * Clear ALL chatyy cache entries (all users).
 * Call on logout / account switch to prevent data leaks.
 */
export async function clearAll() {
  // Clear memory
  _memCache.clear();

  // Clear persistent — remove ALL cache entries (any user prefix)
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith(BASE_PREFIX) || k.startsWith('chat_'))) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    } else {
      const as = await getAS();
      if (as) {
        const allKeys = await as.getAllKeys();
        const cacheKeys = allKeys.filter(k => k.startsWith(BASE_PREFIX) || k.startsWith('chat_'));
        if (cacheKeys.length > 0) await as.multiRemove(cacheKeys);
      }
    }
  } catch {}
}

/**
 * Pre-warm cache: load from persistent storage into memory.
 * Call this early (e.g., after login) so getCachedSync works.
 */
export async function warmCache(keys) {
  for (const key of keys) {
    try { await getCached(key); } catch {}
  }
}

/**
 * Pre-fetch and cache data from API.
 * Used to pre-load data for screens the user hasn't visited yet.
 */
export async function prefetch(key, apiFn, ttlMs = 300000) {
  try {
    const data = await apiFn();
    if (data && data.success !== false) {
      await setCache(key, data, ttlMs);
    }
    return data;
  } catch { return null; }
}
