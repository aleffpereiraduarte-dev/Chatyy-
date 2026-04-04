// Safe SQLite wrapper — NEVER crashes the app
// Uses dynamic import with try/catch so if expo-sqlite fails, app works normally
// Pattern: show cached data instantly → fetch API in background → update UI + cache

let _db = null;
let _ready = false;
let _initPromise = null;

async function _getDb() {
  if (_ready && _db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const { Platform } = require('react-native');
      if (Platform.OS === 'web') return null;

      const SQLite = require('expo-sqlite');
      const db = await Promise.race([
        SQLite.openDatabaseAsync('chatyy_safe.db'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);

      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
      `);

      _db = db;
      _ready = true;
      return db;
    } catch (e) {
      console.warn('[safeDb] init failed:', e?.message);
      return null;
    } finally {
      _initPromise = null;
    }
  })();

  return _initPromise;
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Get cached data instantly. Returns null if no cache.
 */
export async function getCache(key) {
  try {
    const db = await _getDb();
    if (!db) return null;
    const row = await db.getFirstAsync('SELECT value, updated_at FROM kv WHERE key = ?', [key]);
    if (!row) return null;
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/**
 * Save data to local cache.
 */
export async function setCache(key, data) {
  try {
    const db = await _getDb();
    if (!db) return;
    const json = JSON.stringify(data);
    await db.runAsync(
      'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
      [key, json, Date.now()]
    );
  } catch {}
}

/**
 * Delete cached data.
 */
export async function delCache(key) {
  try {
    const db = await _getDb();
    if (!db) return;
    await db.runAsync('DELETE FROM kv WHERE key = ?', [key]);
  } catch {}
}

/**
 * Clear all cache (logout).
 */
export async function clearAll() {
  try {
    const db = await _getDb();
    if (!db) return;
    await db.runAsync('DELETE FROM kv');
  } catch {}
}

/**
 * Cache-first pattern: returns cached data instantly, fetches fresh in background.
 * @param {string} key - Cache key
 * @param {Function} apiFn - Async function that fetches fresh data
 * @param {Function} onUpdate - Called with fresh data when API responds
 * @returns {any} Cached data (or null if no cache)
 */
export async function cacheFirst(key, apiFn, onUpdate) {
  // 1. Return cached immediately
  const cached = await getCache(key);

  // 2. Fetch fresh in background
  (async () => {
    try {
      const fresh = await apiFn();
      if (fresh && fresh.success !== false) {
        const data = fresh.data || fresh;
        await setCache(key, data);
        if (onUpdate) onUpdate(data);
      }
    } catch {}
  })();

  return cached;
}
