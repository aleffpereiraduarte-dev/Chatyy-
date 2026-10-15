// Chatyy Cache Service v2 — powered by MMKV (<1ms sync reads)
// Pattern: show cached data INSTANTLY, fetch fresh in background
// All keys are prefixed with the current user's email hash to prevent cross-account leaks

import { Platform } from 'react-native';
import { getString, setString, remove, getAllKeys, isCacheReady } from './mmkv';

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
      // [2026-10-14 offline-first] NÃO apaga do disco: getCachedEntrySync (telas
      // offline-first, maxAge 7d) ainda pinta essa cópia; o LRU/logout limpam.
      // (Antes o warmCache do boot apagava contatos/agenda/notas/arquivos >10 min.)
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
  // `ts` (write time) is additive — readers only destructure data/expiry. It
  // lets prefetch() skip a network refresh of a copy that is still fresh.
  const entry = { data, expiry: Date.now() + ttlMs, ts: Date.now() };

  _memSet(fullKey, entry);

  try {
    const str = JSON.stringify(entry);
    // [2026-10-14 offline-first] teto por entrada + orçamento total com LRU.
    if (str && str.length > _ENTRY_CAP) { _idxDrop(fullKey); remove(fullKey); return; }
    setString(fullKey, str);
    _idxTouch(fullKey, str ? str.length : 0);
  } catch {}
}

// ─── [2026-10-14 offline-first] Orçamento de disco + LRU ────────────────────
// Todas as telas guardam o último dado aqui (useCachedAction + chamadas
// diretas de setCache). Sem teto, o namespace crescia sem limite. Índice
// global (todas as contas) fullKey → [chars, lastUse]; quando passa do
// orçamento, remove as entradas menos usadas recentemente. Chaves legadas
// gravadas antes do índice só entram nele na próxima escrita.
const _IDX_KEY = '@chatyy_cidx_v1';
const _IS_WEB = Platform.OS === 'web';
const _BUDGET = _IS_WEB ? 3 * 1024 * 1024 : 30 * 1024 * 1024; // chars ≈ bytes (UTF-16 no web)
const _ENTRY_CAP = _IS_WEB ? 1024 * 1024 : Math.floor(1.4 * 1024 * 1024);
let _idx = null;      // Map fullKey -> [chars, lastUse]
let _idxTotal = 0;
let _idxTimer = null;
function _idxLoad() {
  if (_idx) return true;
  if (!_IS_WEB && !isCacheReady()) return false; // não sobrescrever o índice salvo antes do boot
  _idx = new Map(); _idxTotal = 0;
  try {
    const o = JSON.parse(getString(_IDX_KEY) || '{}');
    for (const k of Object.keys(o || {})) {
      const v = o[k];
      if (Array.isArray(v) && v.length === 2) { _idx.set(k, v); _idxTotal += Number(v[0]) || 0; }
    }
  } catch {}
  return true;
}
function _idxSave() {
  if (_idxTimer) return;
  _idxTimer = setTimeout(() => {
    _idxTimer = null;
    if (!_idx) return;
    try { const o = {}; for (const [k, v] of _idx) o[k] = v; setString(_IDX_KEY, JSON.stringify(o)); } catch {}
  }, 1500);
}
function _idxDrop(fullKey) {
  if (!_idxLoad()) return;
  const v = _idx.get(fullKey);
  if (v) { _idxTotal -= Number(v[0]) || 0; _idx.delete(fullKey); _idxSave(); }
}
function _idxTouch(fullKey, chars) {
  if (!_idxLoad()) return;
  const prev = _idx.get(fullKey);
  if (prev) _idxTotal -= Number(prev[0]) || 0;
  _idx.set(fullKey, [chars, Date.now()]);
  _idxTotal += chars;
  if (_idxTotal > _BUDGET) {
    const target = _BUDGET * 0.85;
    const lru = Array.from(_idx.entries()).sort((a, b) => a[1][1] - b[1][1]);
    for (const [k, v] of lru) {
      if (_idxTotal <= target) break;
      if (k === fullKey) continue;
      _idx.delete(k); _idxTotal -= Number(v[0]) || 0;
      _memCache.delete(k);
      try { remove(k); } catch {}
    }
  }
  _idxSave();
}
// Leitura conta como "uso" (só memória; persiste junto da próxima escrita).
function _idxUse(fullKey) {
  if (!_idx) return;
  const v = _idx.get(fullKey);
  if (v) v[1] = Date.now();
}
export function getCacheStats() { _idxLoad(); return { entries: _idx ? _idx.size : 0, chars: _idxTotal, budget: _BUDGET }; }

/** Há uma conta definida para o escopo do cache? (sem conta = chaves sem escopo → não usar) */
export function hasCacheUser() { return !!_userHash; }
/** Escopo atual (opaco) — p/ descartar uma resposta que chegou depois de uma troca de conta. */
export function cacheUserScope() { return _userHash; }

/**
 * Entrada crua { data, ts } SÍNCRONA, ignorando `expiry` mas respeitando
 * `maxAgeMs` (idade desde a gravação). Para telas offline-first: o dado salvo
 * aparece mesmo depois do TTL curto do gravador; a revalidação decide o resto.
 * Sem conta no escopo → null (nunca lê chave sem escopo).
 */
export function getCachedEntrySync(key, maxAgeMs = 7 * 24 * 3600 * 1000) {
  if (!_userHash) return null;
  const fullKey = _getPrefix() + key;
  let entry = _memCache.get(fullKey);
  if (!entry) {
    try {
      const raw = getString(fullKey);
      if (!raw) return null;
      entry = JSON.parse(raw);
      if (!entry || typeof entry !== 'object') return null;
      _memSet(fullKey, entry);
    } catch { return null; }
  }
  if (entry.data == null) return null;
  const ts = entry.ts || (entry.expiry ? entry.expiry - 600000 : 0);
  if (maxAgeMs > 0 && ts && Date.now() - ts > maxAgeMs) return null;
  _idxUse(fullKey);
  return { data: entry.data, ts };
}

/** Apaga as entradas de UMA conta (remoção/revogação de conta guardada). */
export function clearUserCache(email) {
  const e = String(email || '');
  if (!e) return;
  const pfxs = Array.from(new Set([e, e.trim(), e.trim().toLowerCase()])).filter(Boolean).map((x) => {
    let hash = 0;
    for (let i = 0; i < x.length; i++) hash = ((hash << 5) - hash + x.charCodeAt(i)) | 0;
    return BASE_PREFIX + Math.abs(hash).toString(36) + '_';
  });
  try {
    for (const k of getAllKeys()) {
      if (pfxs.some((p) => k.startsWith(p))) { _memCache.delete(k); _idxDrop(k); try { remove(k); } catch {} }
    }
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
 * Invalidate a cached key SYNCHRONOUSLY (memory + MMKV). Use after a write
 * (profile edit, avatar change, etc.) so the next read misses the stale
 * entry instead of serving it for the rest of its TTL. Same effect as
 * clearCache() but exposed under the name callers expect and safe to call
 * without awaiting. Returns nothing.
 */
export function invalidate(key) {
  if (!key) return;
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
  _idx = new Map(); _idxTotal = 0;
  try { remove(_IDX_KEY); } catch {}
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
export async function prefetch(key, apiFn, ttlMs = 2592000000, opts = null) {
  // [2026-10-10 perf-data] opts.skipIfFresherThanMs: when the cached copy was
  // written less than that long ago, skip the network entirely (cold starts in
  // quick succession — iOS kills/relaunches — re-downloaded contacts/calendar/
  // files/notes every time). Entries without `ts` (written before this
  // change) always refresh, exactly like before.
  const skipMs = opts && opts.skipIfFresherThanMs;
  if (skipMs > 0) {
    try {
      const fullKey = _getPrefix() + key;
      let entry = _memCache.get(fullKey);
      if (!entry) { const raw = getString(fullKey); if (raw) entry = JSON.parse(raw); }
      if (entry && entry.ts && (Date.now() - entry.ts) < skipMs
        && !(entry.expiry && Date.now() > entry.expiry) && entry.data != null) {
        return entry.data;
      }
    } catch {}
  }
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

