// Chatyy Storage — AsyncStorage with in-memory sync cache
// Pre-loads during splash so reads are instant.
//
// [2026-10-06 android-storage-ceiling] Three Android failure modes fixed here:
//   1. CursorWindow is 2 MB per row on Android. The old boot did ONE multiGet of
//      every `mmkv_*` key inside a silent `catch {}` → a single oversized value
//      (1500-msg group thread, HTML email) made the WHOLE cache unreadable on
//      every launch (chat list / inbox empty after restart, forever).
//      Now: batches of HYDRATE_BATCH keys; a batch that throws is bisected down
//      to the offending key(s), which are dropped (removeItem) + beaconed
//      (`mmkv_oversized_key_dropped`) and the rest of the cache still loads.
//   2. Writes are capped at MAX_VALUE_BYTES (UTF-8) on Android so a value that
//      can never be read back is never written. `chat_msgs_*` arrays are
//      truncated to the newest messages that fit; anything else keeps its
//      previous on-disk value (memory still gets the new one for this session).
//   3. Boot hydrated EVERYTHING (every conversation's message blob ×2 copies,
//      email bodies) before first paint = 300–800 ms on heavy users. Keys under
//      LAZY_PREFIXES are now NOT loaded at boot: they are only listed, and load
//      on the first getString() (which returns null + kicks an async load, then
//      notifies `onKeysLoaded` listeners) or via `ensureLoaded()`. Everything
//      else (theme, auth/edge, conv list + index, settings, media/avatar index,
//      offline queue, …) is still hydrated before the cache-ready gate, so all
//      existing sync callers keep working unchanged. It is a DENY-list on
//      purpose: an unknown key defaults to eager (safe) rather than lazy.
//
// [2026-10-10 storage-boot]
//   4. LAZY_PREFIXES now apply on iOS too (flag MMKV_LAZY_IOS). Before, iOS
//      multiGet'd + smartChatCache JSON.parse'd EVERY conversation blob at boot
//      (up to 40 MB budget + chatCache's legacy copy). Same lazy contract that
//      Android has run since 10-06 — every lazy-sensitive caller already goes
//      through isKeyPending / ensureLoaded / onKeysLoaded.
//   5. Optional SQLite KV backend (flag KV_SQLITE_ENABLED, default OFF): one
//      `kv(k,v)` table in expo-sqlite (`chatyy_kv.db`) read SYNCHRONOUSLY — boot
//      is a single SELECT (no bridge round-trips) and a lazy key read is a sync
//      point lookup, so getString() of a cold conversation returns data on
//      frame 1 instead of null+kick. 1st launch with the flag: normal
//      AsyncStorage boot + background copy AsyncStorage→SQLite; marker
//      `__kv_migrated_v1` flips the next boot to SQLite. Writes go to BOTH
//      stores (dual-write) for this transition version → turning the flag off
//      is a safe rollback (that boot also wipes the KV table so a later re-enable
//      re-migrates instead of serving stale rows). Every SQLite failure falls
//      back to AsyncStorage.
import { Platform } from 'react-native';
import { MMKV_LAZY_IOS, KV_SQLITE_ENABLED } from '../constants/featureFlags';

const PFX = 'mmkv_';
const HYDRATE_BATCH = 40;
// CursorWindow = 2 MB/row and also holds the key + row overhead. 1.5 MB leaves
// a comfortable margin. Only enforced on Android (iOS stores large values as
// files — no per-row ceiling).
export const MAX_VALUE_BYTES = Math.floor(1.5 * 1024 * 1024);
const ENFORCE_CAP = Platform.OS === 'android';

// Keys loaded on demand instead of at boot. Per-conversation message blobs
// (smartChatCache `chat_msgs_v2_*` + chatCache legacy `chat_msgs_*`) and cached
// email bodies (`omc_msg_<acct>_<id>`, NOT the `omc_msg_index_*` LRU index).
// [2026-10-08 offline-first] + api.js offline last-known bodies (`apiofl1_*`):
// only read on a network failure (async, ensureLoaded) → never on the boot path.
const LAZY_PREFIXES = [PFX + 'chat_msgs_', PFX + 'omc_msg_', PFX + 'apiofl1_'];
const LAZY_EXCEPT_PREFIXES = [PFX + 'omc_msg_index_'];
function _lazyOn() {
  // [2026-10-06] Android (CursorWindow/6 MB). [2026-10-10] iOS também (boot
  // parseava todos os blobs de mensagem) — flag MMKV_LAZY_IOS (false = antigo).
  if (Platform.OS === 'android') return true;
  return Platform.OS === 'ios' && MMKV_LAZY_IOS !== false;
}
export function isLazyKey(fullKey) {
  if (typeof fullKey !== 'string' || !_lazyOn()) return false;
  if (!LAZY_PREFIXES.some(p => fullKey.startsWith(p))) return false;
  return !LAZY_EXCEPT_PREFIXES.some(p => fullKey.startsWith(p));
}
// Same predicate as isLazyKey, as a SQL expression over column `k` (prefixes
// are compile-time constants without quotes → safe to inline).
function _lazySql() {
  if (!_lazyOn()) return '0';
  const inc = LAZY_PREFIXES.map(p => `substr(k,1,${p.length})='${p}'`).join(' OR ');
  const exc = LAZY_EXCEPT_PREFIXES.map(p => `substr(k,1,${p.length})='${p}'`).join(' OR ');
  return `((${inc}) AND NOT (${exc}))`;
}

// ─── SQLite KV backend (flag KV_SQLITE_ENABLED) ──────────────────────────────
const KV_DB_NAME = 'chatyy_kv.db';
const KV_MIGRATED = '__kv_migrated_v1';      // row inside kv (not mmkv_-prefixed)
const AS_KV_MARKER = 'kvsql_migrated_v1';    // AsyncStorage twin of the marker
const KV_DUAL_WRITE = true;                  // keep AsyncStorage current (rollback)
const KV_MIGRATE_DELAY_MS = 8000;            // stay off the cold-start path
const KV_MIGRATE_BATCH = 12;                 // ≤ ~18 MB of strings per batch
const KV_FLUSH_MS = 30;
let _kv = null;           // expo-sqlite handle (sync API) while a kv mode is on
let _kvMode = 'off';      // 'off' | 'migrating' (AsyncStorage primary) | 'primary'
let _kvTouched = null;    // keys written/removed while migrating → copy skips them
const _kvDirty = new Map(); // fullKey → string (upsert) | null (delete)
let _kvFlushTimer = null;

function _kvFlagOn() {
  if (Platform.OS === 'web') return false;
  try {
    const o = typeof globalThis !== 'undefined' ? globalThis.__chatyy_kv_sqlite : undefined;
    if (o === true || o === false) return o;
  } catch {}
  return KV_SQLITE_ENABLED === true;
}

function _kvOpen() {
  try {
    const SQLite = require('expo-sqlite');
    if (!SQLite || typeof SQLite.openDatabaseSync !== 'function') return null;
    const db = SQLite.openDatabaseSync(KV_DB_NAME);
    try { db.execSync('PRAGMA journal_mode = WAL;'); } catch {}
    try { db.execSync('PRAGMA synchronous = NORMAL;'); } catch {}
    try { db.execSync('PRAGMA busy_timeout = 3000;'); } catch {}
    db.execSync('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);');
    return db;
  } catch (e) {
    _beacon('kv_open_failed', String(e?.message || e).slice(0, 120));
    return null;
  }
}

function _kvTx(db, fn) {
  if (typeof db.withTransactionSync === 'function') db.withTransactionSync(fn); else fn();
}

// Persist queued kv writes in ONE sync transaction. Never throws.
export function flushStorageWrites() {
  if (_kvFlushTimer) { try { clearTimeout(_kvFlushTimer); } catch {} _kvFlushTimer = null; }
  if (!_kv || !_kvDirty.size) return;
  const items = Array.from(_kvDirty.entries());
  _kvDirty.clear();
  try {
    _kvTx(_kv, () => {
      for (const [k, v] of items) {
        if (v === null) _kv.runSync('DELETE FROM kv WHERE k = ?', [k]);
        else _kv.runSync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [k, v]);
      }
    });
  } catch (e) {
    _stats.kvErrors++;
    _beacon('kv_write_failed', `n=${items.length} err=${String(e?.message || e).slice(0, 100)}`);
    // AsyncStorage still has everything (dual-write). Distrust the kv copy:
    // drop the marker so the next launch boots from AsyncStorage + re-migrates.
    try { _kv.runSync('DELETE FROM kv WHERE k = ?', [KV_MIGRATED]); } catch {}
    try { _asyncStorage?.removeItem(AS_KV_MARKER).catch(() => {}); } catch {}
  }
}

function _kvQueue(fullKey, value) {
  if (!_kv || _kvMode === 'off') return;
  if (_kvTouched) _kvTouched.add(fullKey);
  _kvDirty.set(fullKey, value);
  if (!_kvFlushTimer) _kvFlushTimer = setTimeout(flushStorageWrites, KV_FLUSH_MS);
}

// Sync single-key read for the 'primary' mode. undefined = read failed.
function _kvReadSync(fullKey) {
  try {
    const row = _kv.getFirstSync('SELECT v FROM kv WHERE k = ?', [fullKey]);
    return row && typeof row.v === 'string' ? row.v : null;
  } catch (e) {
    _stats.kvErrors++;
    return undefined;
  }
}

// Synchronous boot from the KV table. true = fully booted from SQLite.
function _bootFromKv() {
  const db = _kvOpen();
  if (!db) return false;
  _kv = db;
  let migrated = false;
  try { migrated = !!db.getFirstSync('SELECT v FROM kv WHERE k = ?', [KV_MIGRATED]); } catch {}
  if (!migrated) { _kvMode = 'migrating'; _kvTouched = new Set(); return false; }
  try {
    const rows = db.getAllSync(
      `SELECT k, CASE WHEN ${_lazySql()} THEN NULL ELSE v END AS v FROM kv WHERE substr(k,1,${PFX.length})='${PFX}'`
    ) || [];
    let n = 0;
    for (const r of rows) {
      if (!r || typeof r.k !== 'string') continue;
      if (r.v === null || r.v === undefined) _pending.add(r.k);
      else { _mem[r.k] = r.v; n++; }
    }
    _stats.bootKeys = n;
    _stats.lazyKeys = _pending.size;
    _kvMode = 'primary';
    _stats.backend = 'sqlite';
    return true;
  } catch (e) {
    _beacon('kv_boot_failed', String(e?.message || e).slice(0, 120));
    _mem = {}; _pending.clear();
    _kv = null; _kvMode = 'off';
    return false;
  }
}

// Background one-time copy AsyncStorage → kv (runs in 'migrating' mode only).
const _yield = () => new Promise(r => setTimeout(r, 0));
async function _kvMigrate() {
  if (_kvMode !== 'migrating' || !_kv || !_asyncStorage) return;
  const t0 = Date.now();
  let copied = 0;
  try {
    const all = (await _asyncStorage.getAllKeys()) || [];
    const keys = all.filter(k => typeof k === 'string' && k.startsWith(PFX));
    for (let i = 0; i < keys.length; i += KV_MIGRATE_BATCH) {
      if (_kvMode !== 'migrating' || !_kv) return; // clearAll / failure mid-way
      const chunk = keys.slice(i, i + KV_MIGRATE_BATCH).filter(k => !_kvTouched?.has(k));
      if (!chunk.length) continue;
      const pairs = await _multiGetSafe(chunk);
      const rows = [];
      for (const p of pairs) {
        // Re-check AFTER the await: a write/remove during the read wins.
        if (p && typeof p[1] === 'string' && !_kvTouched?.has(p[0])) rows.push(p);
      }
      if (rows.length) {
        _kvTx(_kv, () => {
          for (const [k, v] of rows) _kv.runSync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [k, v]);
        });
        copied += rows.length;
      }
      await _yield();
    }
    flushStorageWrites();
    _kv.runSync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [KV_MIGRATED, String(Date.now())]);
    try { await _asyncStorage.setItem(AS_KV_MARKER, '1'); } catch {}
    _stats.kvMigrated = copied;
    _stats.kvMigrateMs = Date.now() - t0;
    _beacon('kv_migrated', `keys=${copied} ms=${_stats.kvMigrateMs}`);
  } catch (e) {
    _stats.kvErrors++;
    _beacon('kv_migrate_failed', `copied=${copied} err=${String(e?.message || e).slice(0, 100)}`);
  }
}

// Flag turned OFF after a migration: AsyncStorage becomes the only writer
// again, so the kv copy goes stale → wipe it (a later re-enable re-migrates).
async function _kvInvalidate() {
  try {
    const db = _kvOpen();
    if (db) { db.runSync('DELETE FROM kv'); try { db.closeSync?.(); } catch {} }
    await _asyncStorage.removeItem(AS_KV_MARKER);
  } catch {}
}

let _asyncStorage = null;
let _mem = {};
const _pending = new Set();   // full keys present on disk but not yet loaded
const _listeners = new Set(); // (logicalKeys: string[]) => void
let _ready = false;
let _readyResolve = null;
const _readyPromise = new Promise(r => { _readyResolve = r; });
const _stats = { bootMs: 0, bootKeys: 0, lazyKeys: 0, dropped: 0, truncated: 0, refused: 0, backend: 'async', lazyLoads: 0, lazySyncHits: 0, kvMigrated: 0, kvMigrateMs: 0, kvErrors: 0 };

// ─── Beacons (lazy require; deferred so boot never waits on the reporter) ───
function _beacon(context, message) {
  try {
    setTimeout(() => {
      try { require('./crashReporter').reportCrash?.({ type: 'mmkv', context, message }); } catch {}
    }, 0);
  } catch {}
}

// UTF-8 byte length. Only walks the string when it could exceed the cap.
export function utf8Bytes(s) {
  if (typeof s !== 'string') return 0;
  const n = s.length;
  if (n * 3 <= MAX_VALUE_BYTES) return n; // cheap lower bound is enough here
  let b = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) b += 1;
    else if (c < 0x800) b += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { b += 4; i++; }
    else b += 3;
  }
  return b;
}

// ─── Batched, CursorWindow-safe multiGet ─────────────────────────────────────
// Resolves to [key, value][] for every readable key. A batch that throws is
// split in half until the failing single key is isolated; that key is removed
// from disk (it can never be read again on this device) and beaconed.
async function _multiGetSafe(keys) {
  if (!keys.length) return [];
  try {
    const pairs = await _asyncStorage.multiGet(keys);
    return Array.isArray(pairs) ? pairs : [];
  } catch (e) {
    if (keys.length === 1) {
      const k = keys[0];
      _stats.dropped++;
      try { _asyncStorage.removeItem(k).catch(() => {}); } catch {}
      _pending.delete(k);
      _beacon('oversized_key_dropped', `key=${k} size=unreadable(>CursorWindow) err=${String(e?.message || e).slice(0, 80)}`);
      return [];
    }
    const mid = keys.length >> 1;
    const a = await _multiGetSafe(keys.slice(0, mid));
    const b = await _multiGetSafe(keys.slice(mid));
    return a.concat(b);
  }
}

// Loads `fullKeys` into _mem in batches. `onlyIfPending` = lazy path: never
// overwrite a value that was written (or removed) while the read was in flight.
async function _loadKeys(fullKeys, onlyIfPending) {
  const loaded = [];
  for (let i = 0; i < fullKeys.length; i += HYDRATE_BATCH) {
    const chunk = fullKeys.slice(i, i + HYDRATE_BATCH);
    let pairs = [];
    try { pairs = await _multiGetSafe(chunk); } catch {}
    for (const pair of pairs) {
      try {
        const k = pair[0]; const v = pair[1];
        if (onlyIfPending && !_pending.has(k)) continue;
        _pending.delete(k);
        if (v !== null && v !== undefined) { _mem[k] = v; loaded.push(k); }
      } catch {}
    }
    // Keys the native side silently skipped are no longer "pending" either.
    if (onlyIfPending) for (const k of chunk) _pending.delete(k);
  }
  return loaded;
}

async function _init() {
  if (Platform.OS === 'web') { _ready = true; _readyResolve(); return; }
  const t0 = Date.now();
  try { _asyncStorage = require('@react-native-async-storage/async-storage').default; } catch { _asyncStorage = null; }
  // [2026-10-10] SQLite KV primary: fully synchronous boot (ready before the
  // first await → smartChatCache's sync hydrate pass already sees the data).
  const kvOn = _kvFlagOn();
  if (kvOn) {
    let ok = false;
    try { ok = _bootFromKv(); } catch { ok = false; }
    if (ok) {
      _stats.bootMs = Date.now() - t0;
      _ready = true;
      _readyResolve();
      return;
    }
  }
  let keys = null;
  try {
    keys = await _asyncStorage.getAllKeys();
    const boot = [];
    for (const k of keys || []) {
      if (typeof k !== 'string' || !k.startsWith(PFX)) continue;
      if (isLazyKey(k)) _pending.add(k); else boot.push(k);
    }
    _stats.lazyKeys = _pending.size;
    _stats.bootKeys = (await _loadKeys(boot, false)).length;
  } catch {}
  _stats.bootMs = Date.now() - t0;
  if (_kvMode === 'migrating') _stats.backend = 'async+migrating';
  _ready = true;
  _readyResolve();
  try {
    if (_kvMode === 'migrating') setTimeout(() => { _kvMigrate().catch(() => {}); }, KV_MIGRATE_DELAY_MS);
    else if (!kvOn && Array.isArray(keys) && keys.includes(AS_KV_MARKER)) setTimeout(() => { _kvInvalidate().catch(() => {}); }, 3000);
  } catch {}
}
_init();

export function waitForCacheReady() { return _readyPromise; }
export function isCacheReady() { return _ready; }
export function getHydrateStats() { return { ..._stats, pending: _pending.size }; }

// ─── Lazy loading ────────────────────────────────────────────────────────────
// True when the key exists on disk but its value has not been read yet — a
// getString() would return null even though data exists. Callers that do a
// read-modify-write MUST `await ensureLoaded(key)` first (see smartChatCache
// _flushOne, chatCache _kvSet) or they'd clobber the stored value.
export function isKeyPending(key) {
  if (Platform.OS === 'web') return false;
  return _pending.has(PFX + key);
}

function _emit(fullKeys) {
  if (!fullKeys.length || !_listeners.size) return;
  const logical = fullKeys.map(k => k.substring(PFX.length));
  for (const fn of Array.from(_listeners)) { try { fn(logical); } catch {} }
}

// Coalesces the sync-miss kicks of one frame into a single batched read.
let _kickQueue = new Set();
let _kickTimer = null;
const _inflight = new Map(); // fullKey → Promise
function _kick(fullKey) {
  if (_inflight.has(fullKey) || _kickQueue.has(fullKey)) return;
  _kickQueue.add(fullKey);
  if (_kickTimer) return;
  _kickTimer = setTimeout(() => {
    _kickTimer = null;
    const batch = Array.from(_kickQueue);
    _kickQueue = new Set();
    _startLoad(batch);
  }, 0);
}
function _startLoad(fullKeys) {
  const todo = fullKeys.filter(k => _pending.has(k) && !_inflight.has(k));
  if (!todo.length) return;
  const p = (async () => {
    if (_kvMode === 'primary' && _kv) {
      // [2026-10-10] KV: sync point reads, a few per task so a 20-conversation
      // prefetch never blocks a frame. A failed read falls back to AsyncStorage.
      const loaded = []; const fallback = [];
      for (let i = 0; i < todo.length; i++) {
        if (i % 4 === 0) await _yield();
        const k = todo[i];
        if (!_pending.has(k)) continue; // written/removed meanwhile → memory wins
        const v = _kvReadSync(k);
        if (v === undefined) { fallback.push(k); continue; }
        _pending.delete(k);
        if (v !== null) { _mem[k] = v; loaded.push(k); _stats.lazyLoads++; }
      }
      if (fallback.length && _asyncStorage) loaded.push(...(await _loadKeys(fallback, true)));
      _emit(loaded);
      return;
    }
    if (!_asyncStorage) return;
    const loaded = await _loadKeys(todo, true);
    _stats.lazyLoads += loaded.length;
    _emit(loaded);
  })().catch(() => {}).finally(() => { for (const k of todo) _inflight.delete(k); });
  for (const k of todo) _inflight.set(k, p);
}

// Resolves once every given (logical) key is in memory (or known absent).
export async function ensureLoaded(keys) {
  if (Platform.OS === 'web') return;
  if (!_ready) await _readyPromise;
  const list = (Array.isArray(keys) ? keys : [keys]).filter(k => typeof k === 'string').map(k => PFX + k);
  _startLoad(list);
  const waits = [];
  for (const k of list) { const p = _inflight.get(k); if (p) waits.push(p); }
  if (waits.length) await Promise.all(waits);
}

// Subscribe to lazy loads (logical keys, without the `mmkv_` prefix).
export function onKeysLoaded(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

// ─── Write cap ───────────────────────────────────────────────────────────────
// Keep the newest messages of a chat array that fit under the cap. Returns the
// re-serialized string, or null if the value isn't a JSON array.
function _truncateArrayTail(fullKey, value, bytes) {
  let arr;
  try { arr = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const target = Math.floor(MAX_VALUE_BYTES * 0.9);
  let n = Math.max(1, Math.floor(arr.length * (target / bytes)));
  let out = JSON.stringify(arr.slice(-n));
  while (n > 1 && utf8Bytes(out) > MAX_VALUE_BYTES) {
    n = Math.max(1, Math.floor(n * 0.85));
    out = JSON.stringify(arr.slice(-n));
  }
  if (utf8Bytes(out) > MAX_VALUE_BYTES) return null;
  _stats.truncated++;
  _beacon('value_truncated', `key=${fullKey} bytes=${bytes} kept=${n}/${arr.length}`);
  return out;
}

export function getString(key) {
  if (Platform.OS === 'web') {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(`mmkv_${key}`) : null; } catch { return null; }
  }
  const fk = PFX + key;
  const v = _mem[fk];
  if (v !== undefined && v !== null) return v;
  if (_pending.has(fk)) {
    // [2026-10-10] KV primary: the lazy key is one sync lookup away → return
    // it NOW (frame-1 paint of a cold conversation) instead of null + kick.
    if (_kvMode === 'primary' && _kv && !_inflight.has(fk)) {
      const r = _kvReadSync(fk);
      if (r !== undefined) {
        _pending.delete(fk);
        _stats.lazySyncHits++;
        if (r !== null) { _mem[fk] = r; return r; }
        return null;
      }
    }
    _kick(fk);
  }
  return null;
}

export function setString(key, value) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(`mmkv_${key}`, value); } catch {}
    return;
  }
  const fk = PFX + key;
  _pending.delete(fk);
  _mem[fk] = value;
  if (!_asyncStorage) {
    if (_kvMode === 'primary') _kvQueue(fk, typeof value === 'string' ? value : String(value));
    return;
  }
  let toWrite = value;
  if (ENFORCE_CAP && typeof value === 'string') {
    const bytes = utf8Bytes(value);
    if (bytes > MAX_VALUE_BYTES) {
      const isChatArray = fk.startsWith(PFX + 'chat_msgs_') && value.charCodeAt(0) === 91 /* [ */;
      toWrite = isChatArray ? _truncateArrayTail(fk, value, bytes) : null;
      if (toWrite === null) {
        // Unreadable-on-Android value: keep the previous on-disk copy instead.
        _stats.refused++;
        _beacon('oversized_write_refused', `key=${fk} bytes=${bytes}`);
        return;
      }
      _mem[fk] = toWrite;
    }
  }
  if (_kvMode !== 'off') {
    _kvQueue(fk, typeof toWrite === 'string' ? toWrite : String(toWrite));
    if (_kvMode === 'primary' && !KV_DUAL_WRITE) return;
  }
  _asyncStorage.setItem(fk, toWrite).catch(() => {});
}

export function getNumber(key) {
  const v = getString(key); return v !== null ? Number(v) : null;
}
export function setNumber(key, value) { setString(key, String(value)); }

export function getBoolean(key) {
  const v = getString(key);
  if (v === 'true') return true; if (v === 'false') return false; return null;
}
export function setBoolean(key, value) { setString(key, value ? 'true' : 'false'); }

export function getJSON(key) {
  const v = getString(key);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
export function setJSON(key, value) {
  // JSON.stringify(undefined) === undefined → grava "undefined" no web e
  // quebra no native. Tratar undefined como deleção.
  if (value === undefined) return remove(key);
  setString(key, JSON.stringify(value));
}

export function remove(key) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(`mmkv_${key}`); } catch {}
    return;
  }
  const fk = PFX + key;
  _pending.delete(fk);
  delete _mem[fk];
  if (_kvMode !== 'off') _kvQueue(fk, null);
  if (_asyncStorage) _asyncStorage.removeItem(fk).catch(() => {});
}

// Includes lazy keys that exist on disk but aren't loaded yet, so prefix
// sweeps (clearChatCache, logout wipes, migrations) still see them.
export function getAllKeys() {
  if (Platform.OS === 'web') {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('mmkv_')) keys.push(k.substring(5));
      }
      return keys;
    } catch { return []; }
  }
  const out = Object.keys(_mem).filter(k => k.startsWith(PFX));
  for (const k of _pending) if (!(k in _mem)) out.push(k);
  return out.map(k => k.substring(PFX.length));
}

export function clearAll() {
  if (Platform.OS === 'web') {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('mmkv_')) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    } catch {}
    return;
  }
  _mem = {};
  _pending.clear();
  if (_kv && _kvMode !== 'off') {
    _kvDirty.clear();
    try { _kv.runSync(`DELETE FROM kv WHERE substr(k,1,${PFX.length})='${PFX}'`); } catch {}
    if (_kvTouched) {
      // Mid-migration: anything the copy would still read is being removed
      // from AsyncStorage too → stop it; the next launch re-migrates.
      _kvMode = 'off';
      try { _kv.runSync('DELETE FROM kv WHERE k = ?', [KV_MIGRATED]); } catch {}
    }
  }
  if (_asyncStorage) {
    _asyncStorage.getAllKeys().then(keys => {
      const mk = (keys || []).filter(k => k.startsWith('mmkv_'));
      if (mk.length) _asyncStorage.multiRemove(mk).catch(() => {});
    }).catch(() => {});
  }
}


export function getStorageBackend() { return _kvMode === 'primary' ? 'sqlite' : (_kvMode === 'migrating' ? 'async+migrating' : 'async'); }

// Flush queued KV writes when the app leaves the foreground (iOS may suspend
// before the 30 ms timer fires).
try {
  if (Platform.OS !== 'web') {
    const { AppState } = require('react-native');
    AppState?.addEventListener?.('change', (next) => {
      if (next === 'background' || next === 'inactive') flushStorageWrites();
    });
  }
} catch {}
