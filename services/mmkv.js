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
import { Platform } from 'react-native';

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
const LAZY_PREFIXES = [PFX + 'chat_msgs_', PFX + 'omc_msg_'];
const LAZY_EXCEPT_PREFIXES = [PFX + 'omc_msg_index_'];
export function isLazyKey(fullKey) {
  // [2026-10-06] Só Android (CursorWindow/6 MB). iOS fica intocado: sem lazy, mesmo boot de antes.
  if (Platform.OS !== 'android') return false;
  if (!LAZY_PREFIXES.some(p => fullKey.startsWith(p))) return false;
  return !LAZY_EXCEPT_PREFIXES.some(p => fullKey.startsWith(p));
}

let _asyncStorage = null;
let _mem = {};
const _pending = new Set();   // full keys present on disk but not yet loaded
const _listeners = new Set(); // (logicalKeys: string[]) => void
let _ready = false;
let _readyResolve = null;
const _readyPromise = new Promise(r => { _readyResolve = r; });
const _stats = { bootMs: 0, bootKeys: 0, lazyKeys: 0, dropped: 0, truncated: 0, refused: 0 };

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
  try {
    _asyncStorage = require('@react-native-async-storage/async-storage').default;
    const keys = await _asyncStorage.getAllKeys();
    const boot = [];
    for (const k of keys || []) {
      if (typeof k !== 'string' || !k.startsWith(PFX)) continue;
      if (isLazyKey(k)) _pending.add(k); else boot.push(k);
    }
    _stats.lazyKeys = _pending.size;
    _stats.bootKeys = (await _loadKeys(boot, false)).length;
  } catch {}
  _stats.bootMs = Date.now() - t0;
  _ready = true;
  _readyResolve();
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
    if (!_asyncStorage) return;
    const loaded = await _loadKeys(todo, true);
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
  if (_pending.has(fk)) _kick(fk);
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
  if (!_asyncStorage) return;
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
  if (_asyncStorage) {
    _asyncStorage.getAllKeys().then(keys => {
      const mk = (keys || []).filter(k => k.startsWith('mmkv_'));
      if (mk.length) _asyncStorage.multiRemove(mk).catch(() => {});
    }).catch(() => {});
  }
}
