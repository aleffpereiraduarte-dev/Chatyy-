// avatarCache.js — disk persistence for OTHER users' avatars.
//
// Why this exists (separate from mediaCache):
//   `expo-image` cachePolicy: 'memory-disk' uses NSURLCache / OkHttp's HTTP
//   cache, which lives in cacheDirectory — iOS can evict it at any time and
//   some Android OEMs nuke it on low-mem. Once evicted, opening a contact's
//   profile while offline shows only the initials bubble even though the
//   avatar URL is sitting in SQLite (conversations.avatar_url + contacts.
//   avatar_url). WhatsApp/Telegram solve this by writing avatars into the
//   sandbox's documentDirectory, where the OS can't reclaim the bytes.
//
// Why NOT piggyback on mediaCache:
//   1. mediaCache's LRU sweep tags entries by `conversationId`; avatars
//      don't belong to a conversation (one avatar serves N conversations).
//      Mixing them would force evictIfNeeded() to special-case avatar
//      entries or risk evicting a popular avatar that 50 chat rows reference.
//   2. mediaCache uses a content-bucket policy (photos/audio/videos/docs)
//      with cellular gates. Avatars are tiny (~5-30KB) and need to land
//      regardless of bucket pref — they're chrome, not content.
//   3. Separate dirs mean a "Clear chat media" UI button in storage settings
//      can wipe one without affecting the other.
//
// Shape:
//   - On-disk: documentDirectory/avatar-saved/<urlKey>.jpg
//   - In-memory index: urlKey → absolute file:// path (MMKV-persisted)
//   - 200MB cap, 1000 entry cap (whichever hits first triggers LRU sweep).
//   - Concurrency: shared 3-slot semaphore (matches mediaCache parity).
//
// Web: no-op. Browsers' built-in HTTP cache (Cache-Control headers from
// the backend) already covers avatars, and there's no `documentDirectory`
// equivalent in `expo-file-system` web. Every export returns the input URL.

import { Platform } from 'react-native';

const AVATAR_DIR = 'avatar-saved';
const MAX_AVATAR_BYTES = 200 * 1024 * 1024; // 200MB cap
const MAX_AVATAR_ENTRIES = 1000;            // hard entry-count cap
const INDEX_MMKV_KEY = 'avatar_sync_index_v1';

let FileSystem = null;
function getFS() {
  if (Platform.OS === 'web') return null;
  if (!FileSystem) {
    try { FileSystem = require('expo-file-system'); } catch { return null; }
  }
  return FileSystem;
}

function getAvatarDir() {
  const fs = getFS();
  if (!fs) return null;
  return fs.documentDirectory + AVATAR_DIR + '/';
}

// ── URL → safe filename ───────────────────────────────────────────────
//
// Avatar URLs almost always carry a cache-buster (?v=<ts>&d=YYYYMMDD)
// that rotates daily. We INCLUDE the `v=` param in the hash so a new
// upload (bumped version) gets its own filename — old version stays on
// disk until LRU evicts it, but the freshly-bumped URL writes to a new
// path. The `d=YYYYMMDD` daily bust is stripped before hashing, otherwise
// every midnight would invalidate every avatar.
function urlToKey(url) {
  const s = String(url);
  // Keep `v=` (real version), drop `d=` (daily bust).
  // Strip the daily bust param wherever it sits in the query string.
  const cleaned = s
    .replace(/([?&])d=\d{8}(?=&|$)/, '$1')
    .replace(/[?&]$/, '')
    .replace(/&&+/g, '&')
    .replace(/\?&/, '?');
  let hash = 0;
  for (let i = 0; i < cleaned.length; i++) {
    hash = ((hash << 5) - hash) + cleaned.charCodeAt(i);
    hash |= 0;
  }
  // Avatars are PNG or JPG from the backend — extension is informational
  // (expo-image sniffs the bytes), but a stable `.jpg` keeps the file tree
  // grep-friendly.
  return Math.abs(hash).toString(36) + '.jpg';
}

// ── Sync in-memory index ──────────────────────────────────────────────
//
// urlKey → absolute file:// path. Populated from MMKV at module load,
// scanned against disk on first access via `_ensureIndex()`. Components
// consult this BEFORE rendering so the file:// URI is available on the
// very first commit (no flicker).

const syncIndex = new Map();
let _indexHydrated = false;
let _persistTimer = null;

function _loadIndex() {
  if (Platform.OS === 'web') return;
  try {
    const mmkv = require('./mmkv');
    const raw = mmkv.getString?.(INDEX_MMKV_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') syncIndex.set(k, v);
      }
    }
  } catch {}
}

function _schedulePersist() {
  if (Platform.OS === 'web') return;
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      const mmkv = require('./mmkv');
      const obj = {};
      for (const [k, v] of syncIndex.entries()) obj[k] = v;
      mmkv.setString?.(INDEX_MMKV_KEY, JSON.stringify(obj));
    } catch {}
  }, 2000);
}

// Lazy hydrate — first call rebuilds the in-memory map from MMKV. Cheap;
// no disk I/O. The disk scan in `_scanDir()` runs on first cache hit.
function _ensureIndex() {
  if (_indexHydrated) return;
  _indexHydrated = true;
  _loadIndex();
}

// One-shot disk reconciliation. iOS sometimes changes the sandbox UUID
// after an app update — paths stored in MMKV become stale absolute paths
// that point at the OLD sandbox. We refresh against the live dir on first
// access so stale entries get rewritten with current paths (same pattern
// mediaCache uses in waitForSyncIndexReady).
let _scanPromise = null;
function _scanDir() {
  if (Platform.OS === 'web') return Promise.resolve();
  if (_scanPromise) return _scanPromise;
  _scanPromise = (async () => {
    const fs = getFS();
    if (!fs) return;
    const dir = getAvatarDir();
    try {
      const info = await fs.getInfoAsync(dir);
      if (!info.exists) {
        // Nothing on disk → drop any stale MMKV entries.
        if (syncIndex.size > 0) {
          syncIndex.clear();
          _schedulePersist();
        }
        return;
      }
      const entries = await fs.readDirectoryAsync(dir);
      const live = new Set(entries);
      let changed = false;
      // Re-key against the current dir absolute path.
      for (const name of entries) {
        const path = dir + name;
        if (syncIndex.get(name) !== path) {
          syncIndex.set(name, path);
          changed = true;
        }
      }
      // Scrub: drop any index entry whose file no longer exists.
      for (const k of [...syncIndex.keys()]) {
        if (!live.has(k)) { syncIndex.delete(k); changed = true; }
      }
      if (changed) _schedulePersist();
    } catch {}
  })();
  return _scanPromise;
}

// ── Concurrency throttle (3-slot semaphore) ───────────────────────────
//
// Bulk prefetch for a 100-row chat list would otherwise enqueue 100
// downloads at once and saturate the radio. 3 is mediaCache's value too
// — keeps headroom for foreground requests (avatar of the row the user
// just tapped, chat send, etc).

const _MAX_CONCURRENT = 3;
let _activeDownloads = 0;
const _waitQueue = [];
// Abort flag — flipped true by `clearAvatarCache()` so any in-flight
// download bails before writing to a dir that's about to be wiped, and
// any queued download that hadn't started yet short-circuits to the
// remote URL instead of materializing a file inside the deleted dir.
let _aborted = false;

function _acquireSlot() {
  if (_activeDownloads < _MAX_CONCURRENT) {
    _activeDownloads++;
    return Promise.resolve();
  }
  return new Promise(resolve => _waitQueue.push(resolve));
}

function _releaseSlot() {
  const next = _waitQueue.shift();
  if (next) {
    try { next(); } catch { _activeDownloads--; }
  } else {
    _activeDownloads--;
    if (_activeDownloads < 0) _activeDownloads = 0;
  }
}

// ── In-flight dedup ───────────────────────────────────────────────────
//
// Same URL requested twice before the first download completes → share
// the Promise. Without this, two simultaneous cacheAvatar() calls race
// on the same destination path and one fails with EEXIST.

const _inflight = new Map(); // urlKey → Promise<localPath | url>

// ── Public API ────────────────────────────────────────────────────────

/**
 * Synchronous lookup. Returns a file:// path if the URL is already on
 * disk per the in-memory index, otherwise returns the input URL. Safe
 * to call in render closures — zero I/O.
 *
 * This is what AvatarCircle consults BEFORE rendering. On the second
 * launch (after `cacheAvatar` has stored the bytes once), the file://
 * lookup hits the cache instantly and the avatar paints on first commit
 * — no flicker, no network wait, works offline.
 */
export function getCachedAvatarUri(url) {
  if (!url || Platform.OS === 'web') return url;
  _ensureIndex();
  const key = urlToKey(url);
  const indexed = syncIndex.get(key);
  return indexed || url;
}

/**
 * Returns the file:// path if cached, otherwise `null`. Used when the
 * caller wants to know whether to render the initials fallback (cache
 * miss + offline) instead of triggering an image fetch that will
 * silently fail.
 */
export function getCachedAvatarUriOrNull(url) {
  if (!url || Platform.OS === 'web') return null;
  _ensureIndex();
  const key = urlToKey(url);
  return syncIndex.get(key) || null;
}

/**
 * Download an avatar URL into documentDirectory/avatar-saved. Idempotent
 * — if the file already exists (or another caller's download is in
 * flight), returns the cached path without re-downloading. Resolves to
 * the file:// path on success or the input URL on failure.
 *
 * Fire-and-forget contract: callers should NOT await this in render
 * paths. The component's syncIndex consult on the NEXT commit will pick
 * up the freshly-cached path automatically (via a setState the caller
 * triggers from the resolved promise).
 */
export async function cacheAvatar(url) {
  if (!url || Platform.OS === 'web') return url;
  // Logout in progress — don't materialize new files into a dir that's
  // about to be deleted (would race fs.deleteAsync, and the file would
  // outlive the clear, leaking the prev user's contacts).
  if (_aborted) return url;
  const fs = getFS();
  if (!fs) return url;

  _ensureIndex();
  const key = urlToKey(url);

  // Fast path: index hit + file actually exists.
  const indexed = syncIndex.get(key);
  if (indexed) {
    try {
      const info = await fs.getInfoAsync(indexed);
      if (info.exists) return indexed;
    } catch {}
    // Stale entry — fall through to re-download.
    syncIndex.delete(key);
  }

  // Direct disk probe (covers entries the dir-scan would've found but
  // hasn't run yet on this cold start).
  const dir = getAvatarDir();
  const localPath = dir + key;
  try {
    const info = await fs.getInfoAsync(localPath);
    if (info.exists && info.size > 0) {
      syncIndex.set(key, localPath);
      _schedulePersist();
      return localPath;
    }
  } catch {}

  // Dedup in-flight.
  if (_inflight.has(key)) return _inflight.get(key);

  const dlPromise = (async () => {
    if (_aborted) return url;
    try {
      const dirInfo = await fs.getInfoAsync(dir);
      if (!dirInfo.exists) {
        await fs.makeDirectoryAsync(dir, { intermediates: true });
      }
    } catch {}

    await _acquireSlot();
    // Re-check after waiting for a semaphore slot — a logout might have
    // landed while we were queued behind 3 other downloads.
    if (_aborted) {
      _releaseSlot();
      return url;
    }
    try {
      // 15s timeout — avatars are tiny so a stuck CDN means dead edge.
      // Cheaper to bail and let the next mount retry than hold the
      // semaphore slot blocking other prefetches.
      const download = await Promise.race([
        fs.downloadAsync(url, localPath),
        new Promise((_, rej) => setTimeout(() => rej(new Error('avatar_dl_timeout')), 15000)),
      ]);
      if (download?.status === 200) {
        syncIndex.set(key, localPath);
        _schedulePersist();
        // Fire LRU sweep — debounced inside.
        try { evictIfNeeded(); } catch {}
        return localPath;
      }
      // Non-200 (404 expired link, 403 token expired) — purge any
      // partial file so we don't serve a 0-byte image.
      try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
    } catch {
      try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
    } finally {
      _releaseSlot();
    }
    return url; // Fall back to remote URL on failure.
  })();
  _inflight.set(key, dlPromise);
  try {
    return await dlPromise;
  } finally {
    _inflight.delete(key);
  }
}

/**
 * Bulk prefetch — fire `cacheAvatar()` for an array of emails. Uses
 * `getAvatarUrlForEmail` to resolve each email to its current URL.
 *
 * Called by ChatListTab when conversations land so by the time the user
 * scrolls / taps into a profile, the bytes are on disk. The shared
 * 3-slot semaphore caps in-flight downloads so a 200-conv list doesn't
 * thunder the radio.
 *
 * Fire-and-forget. Returns a Promise so tests can await but production
 * callers ignore it.
 */
export function prefetchAvatarsForList(emails) {
  if (Platform.OS === 'web') return Promise.resolve();
  if (!Array.isArray(emails) || emails.length === 0) return Promise.resolve();

  let api = null;
  try { api = require('./api'); } catch { return Promise.resolve(); }
  if (!api || typeof api.getAvatarUrlForEmail !== 'function') return Promise.resolve();

  // Dedup emails (a 100-row list with the same peer 3× shouldn't fire
  // 3 downloads). Lowercase normalization matches AvatarCircle's lookup.
  const seen = new Set();
  const unique = [];
  for (const raw of emails) {
    if (typeof raw !== 'string') continue;
    const e = raw.trim().toLowerCase();
    if (!e || !e.includes('@') || seen.has(e)) continue;
    seen.add(e);
    unique.push(e);
  }
  if (unique.length === 0) return Promise.resolve();

  // Fire all — the semaphore inside `cacheAvatar` caps concurrency at
  // 3, so this loop is effectively a producer; the downloads themselves
  // serialize through the slots.
  return Promise.allSettled(unique.map(email => {
    let url = null;
    try { url = api.getAvatarUrlForEmail(email); } catch {}
    if (!url) return Promise.resolve();
    return cacheAvatar(url).catch(() => {});
  }));
}

// ── LRU eviction ──────────────────────────────────────────────────────
//
// Walks the avatar dir, sums total bytes + counts entries, and if either
// limit is breached deletes the oldest (by mtime) until both fit. Same
// debounce pattern as mediaCache (1 sweep / 10 min) — avatars rarely
// land hot enough to need a tighter cadence.

let _lastEvictAt = 0;
let _evictInflight = null;

export async function evictIfNeeded(opts) {
  if (Platform.OS === 'web') return;
  const force = !!(opts && opts.force);
  const now = Date.now();
  if (!force && now - _lastEvictAt < 10 * 60 * 1000) return;
  if (_evictInflight) return _evictInflight;
  const fs = getFS();
  if (!fs) return;
  _evictInflight = (async () => {
    try {
      const dir = getAvatarDir();
      const info = await fs.getInfoAsync(dir);
      if (!info.exists) return;
      const names = await fs.readDirectoryAsync(dir);
      const entries = [];
      let total = 0;
      for (const name of names) {
        const path = dir + name;
        try {
          const st = await fs.getInfoAsync(path);
          if (st.exists && !st.isDirectory) {
            entries.push({ path, name, size: st.size || 0, mtime: st.modificationTime || 0 });
            total += st.size || 0;
          }
        } catch {}
      }
      // Both caps — bytes AND entry count.
      const overBytes = total > MAX_AVATAR_BYTES;
      const overCount = entries.length > MAX_AVATAR_ENTRIES;
      if (!overBytes && !overCount) return;

      entries.sort((a, b) => a.mtime - b.mtime); // oldest first

      const targetBytes = MAX_AVATAR_BYTES * 0.9; // sweep to 90% so the
                                                  // next download doesn't
                                                  // immediately re-trigger.
      const targetCount = Math.floor(MAX_AVATAR_ENTRIES * 0.9);

      let liveBytes = total;
      let liveCount = entries.length;
      for (const e of entries) {
        if (liveBytes <= targetBytes && liveCount <= targetCount) break;
        try {
          await fs.deleteAsync(e.path, { idempotent: true });
          syncIndex.delete(e.name);
          liveBytes -= e.size;
          liveCount -= 1;
        } catch {}
      }
      _schedulePersist();
    } finally {
      _lastEvictAt = Date.now();
      _evictInflight = null;
    }
  })();
  return _evictInflight;
}

// ── Logout cleanup ────────────────────────────────────────────────────
//
// Avatars are user-visible identifiers — leaving them on disk after
// logout means a stranger picking up the device could see who the
// previous user was chatting with. Called from AuthContext.
// clearAllPerAccountCaches.

export async function clearAvatarCache() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  // Flip the abort flag so any in-flight cacheAvatar() bails before
  // writing into the dir we're about to delete. Then drain — wait for
  // already-started downloads to finish (or hit the 5s cap, after which
  // we proceed; deleteAsync is `idempotent` so a stragger writing
  // mid-delete just throws and gets garbage-collected on next launch).
  _aborted = true;
  const start = Date.now();
  while (_activeDownloads > 0 && Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 50));
  }
  const dir = getAvatarDir();
  try {
    await fs.deleteAsync(dir, { idempotent: true });
  } catch {}
  syncIndex.clear();
  // Persist the empty index immediately (don't wait for the 2s debounce
  // — the user just logged out, the device might be killed in 100ms).
  try {
    const mmkv = require('./mmkv');
    mmkv.setString?.(INDEX_MMKV_KEY, '{}');
  } catch {}
  _lastEvictAt = 0;
  _scanPromise = null;
  // Reset the abort gate so a subsequent login can resume caching.
  _aborted = false;
}

// Kick the dir scan after the splash so subsequent renders hit the
// reconciled index. Cheap (one readdir + N stat calls). Safe at module
// load — gated on Platform.OS internally.
if (Platform.OS !== 'web') {
  _ensureIndex();
  // Defer the disk scan a tick so module-load doesn't block JS startup.
  setTimeout(() => { _scanDir().catch(() => {}); }, 0);
}
