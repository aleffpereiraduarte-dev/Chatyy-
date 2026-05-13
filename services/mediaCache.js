import { Platform } from 'react-native';

const CACHE_DIR = 'chat-media-cache';
const PERMANENT_DIR = 'chat-media-saved'; // Permanent storage (not cleared by OS)
const MAX_CACHE_MB = 500; // Max cache size before cleanup
let FileSystem = null;

// ── Sync in-memory index: url → local file:// path ─────────────────────
// Populated from MMKV at module-load (instant, survives restarts) + a
// post-splash disk scan that adds anything not yet recorded. Lets
// resolveMediaUri() return file:// synchronously on first paint — no more
// re-downloads after the image was already saved in a previous session.
const syncIndex = new Map();        // filenameKey → local absolute path
let syncInitPromise = null;          // dedupe concurrent init calls
const INDEX_MMKV_KEY = 'media_sync_index_v1';
let _pendingPersist = null;
// Returns true if any entries were loaded.
function _loadIndexFromMmkv() {
  if (Platform.OS === 'web') return false;
  try {
    const mmkv = require('./mmkv');
    const raw = mmkv.getString?.(INDEX_MMKV_KEY);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      let n = 0;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') { syncIndex.set(k, v); n++; }
      }
      return n > 0;
    }
  } catch {}
  return false;
}
// The MMKV layer fills its in-memory map asynchronously at splash. If we
// hit it at module-load we get empty; retry once the cache is ready so the
// index is populated before the user navigates into a chat.
// Resolves once `syncIndex` has been refreshed against the actual disk
// state. After install or app update iOS may change the sandbox UUID, so
// the absolute paths persisted in MMKV from a previous launch can be
// stale. `waitForSyncIndexReady` does the disk scan FIRST, overrides any
// stale MMKV entries with current absolute paths, and only then resolves
// — eliminating the "first cold start re-downloads everything" symptom
// the user kept hitting after kill-and-reopen.
let _syncIndexFullPromise = null;
export function waitForSyncIndexReady() {
  if (_syncIndexFullPromise) return _syncIndexFullPromise;
  _syncIndexFullPromise = (async () => {
    if (Platform.OS === 'web') return;
    await _hydrateIndexWhenReady();
    try { await initSyncCache(); } catch {}
  })();
  return _syncIndexFullPromise;
}

async function _hydrateIndexWhenReady() {
  if (Platform.OS === 'web') return;
  if (_loadIndexFromMmkv()) return; // hot start
  try {
    const mmkv = require('./mmkv');
    if (mmkv.waitForCacheReady) {
      await mmkv.waitForCacheReady();
      _loadIndexFromMmkv();
    }
  } catch {}
}
function _schedulePersistIndex() {
  if (Platform.OS === 'web') return;
  if (_pendingPersist) return;
  _pendingPersist = setTimeout(() => {
    _pendingPersist = null;
    try {
      const mmkv = require('./mmkv');
      const obj = {};
      for (const [k, v] of syncIndex.entries()) obj[k] = v;
      mmkv.setString?.(INDEX_MMKV_KEY, JSON.stringify(obj));
    } catch {}
  }, 2000);
}
// Warm the in-memory index from MMKV. First try synchronously (hot start);
// if empty, retry once MMKV's in-mem layer finishes loading from AsyncStorage.
_hydrateIndexWhenReady();

// Lazy load expo-file-system (only on native)
function getFS() {
  if (Platform.OS === 'web') return null;
  if (!FileSystem) {
    try { FileSystem = require('expo-file-system'); } catch { return null; }
  }
  return FileSystem;
}

function getCacheDir() {
  const fs = getFS();
  if (!fs) return null;
  return fs.cacheDirectory + CACHE_DIR + '/';
}

// Permanent directory for saved media (survives OS cache cleanup)
function getSavedDir() {
  const fs = getFS();
  if (!fs) return null;
  return fs.documentDirectory + PERMANENT_DIR + '/';
}

// Hash a URL to a safe filename. Extension list covers every media type
// the chat actually sends: images (jpg/png/gif/webp/heic/heif/bmp), video
// (mp4/mov/webm/mkv/m4v/3gp), audio/voice (mp3/m4a/ogg/opus/wav/aac/flac),
// GIF, sticker (tgs/webp), and generic files (pdf/doc/zip/txt). Unknown
// extensions fall back to `bin` so they still get cached — we just can't
// use the extension to hint content-type.
function urlToKey(url) {
  // Strip query/fragment before hashing so signed-URL token rotation
  // (e.g. `?X-Amz-…&Expires=…`) doesn't bust the cache. Same R2/CDN object
  // with a fresh signature must hit the same local file. Anything that's
  // ACTUALLY a different resource will have a different path component.
  const base = String(url).split('?')[0].split('#')[0];
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = ((hash << 5) - hash) + base.charCodeAt(i);
    hash |= 0;
  }
  const ext = base.match(
    /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|tiff|mp4|mov|webm|mkv|m4v|3gp|avi|mp3|m4a|ogg|opus|wav|aac|flac|tgs|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|txt|csv|json)$/i
  )?.[1] || 'bin';
  return Math.abs(hash).toString(36) + '.' + ext;
}

// ── Synchronous lookup / index bootstrap ───────────────────────────────

// Returns the local file:// path if the URL is already cached on disk,
// otherwise null. Zero latency — reads from an in-memory Map populated
// once at app start. Use this in render closures.
//
// NOTA: a versão anterior retornava um "optimistic guess" (path
// determinístico mesmo se o arquivo não existia). Isso dava falso
// positivo — ExpoImage tentava o file://, falhava no onError, setava
// cachedUris[remote]=remote, e re-baixava TUDO. Removido: agora só
// retorna path se o syncIndex confirma presença. Se não, o render usa
// remoto + cacheMedia dispara em background; na próxima abertura
// (syncIndex populado) vira instantâneo.
export function getLocalUriSyncJs(url) {
  if (!url || Platform.OS === 'web') return null;
  const key = urlToKey(url);
  return syncIndex.get(key) || null;
}

// Scan both cache and saved dirs once, fill syncIndex. Call at app boot
// (post-login) so that subsequent renders hit the Map instantly.
export function initSyncCache() {
  if (Platform.OS === 'web') return Promise.resolve();
  if (syncInitPromise) return syncInitPromise;
  syncInitPromise = (async () => {
    await _hydrateIndexWhenReady();

    const fs = getFS();
    if (!fs) return;
    let changed = false;
    const liveKeys = new Set(); // filenames actually present on disk this boot
    for (const dir of [getCacheDir(), getSavedDir()]) {
      try {
        const info = await fs.getInfoAsync(dir);
        if (!info.exists) continue;
        const entries = await fs.readDirectoryAsync(dir);
        for (const name of entries) {
          liveKeys.add(name);
          const path = dir + name;
          if (syncIndex.get(name) !== path) {
            syncIndex.set(name, path);
            changed = true;
          }
        }
      } catch {}
    }
    // Scrub stale entries — iOS can clear NSCachesDirectory at any time.
    // If the index points to a file that no longer exists, render would
    // hand ExpoImage a broken file:// path and the image stays blank.
    // This sweep evicts those entries so cacheMedia re-downloads cleanly.
    for (const key of [...syncIndex.keys()]) {
      if (!liveKeys.has(key)) {
        syncIndex.delete(key);
        changed = true;
      }
    }
    if (changed) _schedulePersistIndex();
  })();
  return syncInitPromise;
}

// Re-register a single URL → local path (called after every successful
// cacheMedia / saveMediaPermanent so syncIndex stays fresh mid-session).
function registerSyncKey(url, localPath) {
  if (Platform.OS === 'web' || !url || !localPath) return;
  syncIndex.set(urlToKey(url), localPath);
  _schedulePersistIndex();
}

// Get cached URI for a URL, or return the original URL
export async function getCachedUri(url) {
  if (!url || Platform.OS === 'web') return url;
  const fs = getFS();
  if (!fs) return url;

  const key = urlToKey(url);
  // Fast path: if syncIndex already knows where the file lives (e.g. scanned
  // by initSyncCache at boot or registered by cacheMedia mid-session), skip
  // the fs.getInfoAsync round-trip and the getSavedDir fallback below.
  const indexed = syncIndex.get(key);
  if (indexed) return indexed;

  // Check BOTH locations — saveMediaPermanent writes to documentDirectory
  // while cacheMedia writes to cacheDirectory. Only checking the cache dir
  // (the old behavior) meant permanently-saved media got re-downloaded
  // every app launch because it was invisible to this lookup path.
  for (const dir of [getCacheDir(), getSavedDir()]) {
    if (!dir) continue;
    const localPath = dir + key;
    try {
      const info = await fs.getInfoAsync(localPath);
      if (info.exists) {
        registerSyncKey(url, localPath);
        return localPath;
      }
    } catch {}
  }

  return url; // Not cached yet
}

// In-flight download dedup — if the same URL is requested twice before the
// first completes, share the same Promise. Without this, two simultaneous
// cacheMedia(url) calls race on the same local path — one download wins, the
// other fails with EEXIST, both callers fall back to the remote URL, and
// the image appears uncached on next open.
const _inflightDownloads = new Map(); // key → Promise<localPath | url>

// Heuristic: extension hints whether the asset is heavy (video/file) and
// should be deferred on cellular vs lightweight (image/audio/voice) which is
// safe to auto-fetch on any connection. Telegram & WhatsApp default behavior:
// auto-download images on any data, defer video/document to wifi (or explicit
// tap). Caller can still force an immediate download by passing { force: true }.
function _isHeavyByUrl(url) {
  if (typeof url !== 'string') return false;
  return /\.(mp4|mov|m4v|webm|mkv|avi|pdf|doc|docx|xls|xlsx|zip|rar|7z)(\?|$)/i.test(url);
}

// Download and cache a URL, return local URI.
// `opts.force` (default false): bypass the cellular gate. Use this for the
// user's explicit "tap to download" gesture on a media bubble — the
// background prefetch path leaves opts.force unset so cellular saves data.
export async function cacheMedia(url, opts = {}) {
  if (!url || Platform.OS === 'web') return url;
  const fs = getFS();
  if (!fs) return url;

  // Cellular gate: skip auto-prefetch of heavy assets when not on wifi. The
  // tap-to-download UI in the bubble passes { force: true } so the user's
  // explicit intent always proceeds.
  if (!opts.force && _isHeavyByUrl(url)) {
    try {
      const { isWifi } = require('./networkInfo');
      if (typeof isWifi === 'function' && isWifi() === false) {
        return url; // Return remote URL — bubble shows "tap to download" UI.
      }
    } catch {}
  }

  const key = urlToKey(url);
  const indexed = syncIndex.get(key);
  if (indexed) {
    try {
      const info = await fs.getInfoAsync(indexed);
      if (info.exists) return indexed;
    } catch {}
    syncIndex.delete(key);
  }
  for (const d of [getCacheDir(), getSavedDir()]) {
    if (!d) continue;
    const p = d + key;
    try {
      const info = await fs.getInfoAsync(p);
      if (info.exists) { registerSyncKey(url, p); return p; }
    } catch {}
  }

  if (_inflightDownloads.has(key)) return _inflightDownloads.get(key);

  // Salvar direto em documentDirectory (getSavedDir) em vez de cacheDirectory.
  // iOS pode (e faz) despejar o cacheDirectory sempre que o dispositivo fica
  // com pouco storage, então cada mídia que baixava ficava "carregando" de
  // novo na próxima abertura. documentDirectory persiste até o user desinstalar
  // ou limpar manualmente no Settings do app. Mesma estratégia do WhatsApp.
  const dir = getSavedDir();
  const localPath = dir + key;
  const dlPromise = (async () => {
    try {
      const dirInfo = await fs.getInfoAsync(dir);
      if (!dirInfo.exists) {
        await fs.makeDirectoryAsync(dir, { intermediates: true });
      }
      // Retry com exponential backoff em 5xx / network failures. 4xx
      // (404, 410, 403) são bug nosso ou link expirado — retry só queima
      // bateria. Backoff: 0ms → 500ms → 1500ms (3 tentativas no total).
      const BACKOFFS_MS = [0, 500, 1500];
      let lastStatus = 0;
      for (let attempt = 0; attempt < BACKOFFS_MS.length; attempt++) {
        if (BACKOFFS_MS[attempt] > 0) {
          await new Promise(r => setTimeout(r, BACKOFFS_MS[attempt]));
        }
        try {
          // 20s timeout so a stuck CDN (slow 3G, dead edge node) doesn't hold the
          // promise forever and freeze downstream awaits.
          const download = await Promise.race([
            fs.downloadAsync(url, localPath),
            new Promise((_, rej) => setTimeout(() => rej(new Error('download_timeout')), 20000)),
          ]);
          if (download?.status === 200) { registerSyncKey(url, localPath); return localPath; }
          lastStatus = download?.status || 0;
          try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
          // Abort em 4xx — não vai mudar com retry. Recursos ausentes /
          // tokens inválidos são bug, não flaky network.
          if (lastStatus >= 400 && lastStatus < 500) break;
        } catch {
          // Network/timeout — vale tentar de novo.
          try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
        }
      }
    } catch {
      try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
    }
    return url;
  })();
  _inflightDownloads.set(key, dlPromise);
  try { return await dlPromise; }
  finally {
    _inflightDownloads.delete(key);
    // Fire-and-forget LRU sweep (debounced inside) — keeps saved dir
    // bounded after each new download lands.
    try { evictIfNeeded(); } catch {}
  }
}

// Pre-cache an array of URLs (for batch caching when entering a conversation)
export async function preCacheUrls(urls) {
  if (Platform.OS === 'web' || !urls?.length) return;
  // Cache em batches de 20 — antes só processava os 20 primeiros e
  // ignorava o resto, deixando mídias antigas sem cache.
  for (let i = 0; i < urls.length; i += 20) {
    await Promise.allSettled(urls.slice(i, i + 20).map(url => cacheMedia(url)));
  }
}

// Get cache size in bytes
export async function getCacheSize() {
  if (Platform.OS === 'web') return 0;
  const fs = getFS();
  if (!fs) return 0;
  const dir = getCacheDir();
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) return 0;
    return info.size || 0;
  } catch { return 0; }
}

// Save media permanently (won't be cleared by OS)
export async function saveMediaPermanent(url) {
  if (!url || Platform.OS === 'web') return url;
  const fs = getFS();
  if (!fs) return url;

  const dir = getSavedDir();
  const key = urlToKey(url);
  const localPath = dir + key;

  try {
    const info = await fs.getInfoAsync(localPath);
    if (info.exists) return localPath;
  } catch {}

  try {
    const dirInfo = await fs.getInfoAsync(dir);
    if (!dirInfo.exists) await fs.makeDirectoryAsync(dir, { intermediates: true });

    // Check if already in cache — move instead of re-downloading
    const cachedPath = getCacheDir() + key;
    try {
      const cachedInfo = await fs.getInfoAsync(cachedPath);
      if (cachedInfo.exists) {
        await fs.copyAsync({ from: cachedPath, to: localPath });
        registerSyncKey(url, localPath);
        return localPath;
      }
    } catch {}

    // Download fresh
    const download = await fs.downloadAsync(url, localPath);
    if (download.status === 200) { registerSyncKey(url, localPath); return localPath; }
    try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
  } catch {}

  return url;
}

// Adopt an existing local file (e.g. just-recorded voice note at
// file:///.../voice_xxx.m4a) as the cached copy for a remote CDN URL.
// Used by the SEND path: after the server returns the canonical file_url,
// we already have the bytes on disk — copy them into the cache dir under
// the deterministic key so subsequent loads of the SAME message (or any
// other client viewing it later) hit the local copy instead of re-DLing.
//
// Idempotent: if the destination already exists we skip the copy. Returns
// the local path on success or null on failure / unsupported (web).
export async function adoptLocalFileAsCache(remoteUrl, localUri) {
  if (Platform.OS === 'web' || !remoteUrl || !localUri) return null;
  if (typeof localUri !== 'string' || !localUri.startsWith('file://')) return null;
  const fs = getFS();
  if (!fs) return null;
  const dir = getSavedDir();
  const key = urlToKey(remoteUrl);
  const destPath = dir + key;
  try {
    // Skip if already adopted (deterministic key — same URL → same path).
    try {
      const existing = await fs.getInfoAsync(destPath);
      if (existing.exists && existing.size > 0) {
        registerSyncKey(remoteUrl, destPath);
        return destPath;
      }
    } catch {}
    // Ensure parent dir.
    try {
      const dirInfo = await fs.getInfoAsync(dir);
      if (!dirInfo.exists) await fs.makeDirectoryAsync(dir, { intermediates: true });
    } catch {}
    // Source must still exist (expo-av sometimes purges its recording temp).
    try {
      const src = await fs.getInfoAsync(localUri);
      if (!src.exists || !src.size) return null;
    } catch { return null; }
    await fs.copyAsync({ from: localUri, to: destPath });
    registerSyncKey(remoteUrl, destPath);
    return destPath;
  } catch {
    try { await fs.deleteAsync(destPath, { idempotent: true }); } catch {}
    return null;
  }
}

// Task #886 — prefetch a single audio message's media so the bubble plays
// offline-clean even if the user never tapped it before going dark. Designed
// to be called the instant a `type==='audio'|'voice'` row enters state (WS
// receive, TCP receive, load, sync, etc). Idempotent: if the file is already
// cached, returns the local path without re-downloading. force:true bypasses
// the cellular gate — audio is tiny (~50-300KB), users always want it.
//
// Returns a Promise resolving to the local path on success or the remote URL
// on failure. Callers should treat as fire-and-forget; the AudioPlayer will
// pick up the cached file on its next mount via getCachedAudioUri.
export function prefetchAudioMessage(remoteUrl) {
  if (!remoteUrl || Platform.OS === 'web') return Promise.resolve(remoteUrl);
  try { console.log('[audio_offline] prefetch', String(remoteUrl).slice(0, 80)); } catch {}
  // saveMediaPermanent writes to documentDirectory (the "saved" dir) — same
  // location getCachedAudioUri checks via the mediaCache consolidation hook,
  // so a single download serves both the bubble's player AND the chat list
  // preview. No cellular gate inside saveMediaPermanent → safe for audio.
  return saveMediaPermanent(remoteUrl).catch(() => remoteUrl);
}

// Get permanent saved URI
export async function getSavedUri(url) {
  if (!url || Platform.OS === 'web') return null;
  const fs = getFS();
  if (!fs) return null;
  const path = getSavedDir() + urlToKey(url);
  try {
    const info = await fs.getInfoAsync(path);
    return info.exists ? path : null;
  } catch { return null; }
}

// Auto-save all media from a conversation for offline access. Covers every
// attachment type — image, video, audio/voice, gif, sticker, and plain file.
// Anything with a file_url is eligible; the type filter was previously too
// narrow and left gifs/stickers/files re-downloading every app launch.
export async function saveConversationMedia(messages) {
  if (Platform.OS === 'web' || !messages?.length) return;
  // GIFs and stickers (Tenor URLs) live in `m.content`, not `m.file_url`.
  // Treat both as media sources so they get persisted to the local cache
  // and survive across app launches.
  const types = ['image', 'video', 'audio', 'voice', 'gif', 'sticker', 'file'];
  const pickUrl = (m) => {
    if (m.file_url) return m.file_url;
    if ((m.type === 'gif' || m.type === 'sticker') && typeof m.content === 'string' && m.content.startsWith('http')) return m.content;
    return null;
  };
  const mediaMessages = messages.filter(m => types.includes(m.type) && pickUrl(m));
  const BATCH_SIZE = 20;
  for (let i = 0; i < mediaMessages.length; i += BATCH_SIZE) {
    const batch = mediaMessages.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(msg => {
      const raw = pickUrl(msg);
      const url = raw?.startsWith('http') ? raw : `https://chatyy.com.br${raw}`;
      return saveMediaPermanent(url).catch(() => {});
    }));
  }
}

// Get total saved media size
export async function getSavedSize() {
  if (Platform.OS === 'web') return 0;
  const fs = getFS();
  if (!fs) return 0;
  try {
    const dir = getSavedDir();
    const info = await fs.getInfoAsync(dir);
    return info.exists ? (info.size || 0) : 0;
  } catch { return 0; }
}

// LRU eviction: scan saved/cache dirs, sum sizes, if over MAX_CACHE_MB
// delete oldest files (by modificationTime) until under the cap. Without
// this the saved dir grows unbounded — first-time users hit photos heavy
// channels and end up with multi-GB sandboxes after a few weeks.
// Called opportunistically (debounced) — not blocking on every download.
let _lastEvictAt = 0;
let _evictInflight = null;
export async function evictIfNeeded() {
  if (Platform.OS === 'web') return;
  // Debounce: at most one sweep every 5 min. Scanning the dir on every
  // cacheMedia call is its own perf problem on accounts with thousands
  // of media files.
  const now = Date.now();
  if (now - _lastEvictAt < 5 * 60 * 1000) return;
  if (_evictInflight) return _evictInflight;
  const fs = getFS();
  if (!fs) return;
  _evictInflight = (async () => {
    try {
      const limitBytes = MAX_CACHE_MB * 1024 * 1024;
      const entries = [];
      for (const dir of [getCacheDir(), getSavedDir()]) {
        if (!dir) continue;
        try {
          const info = await fs.getInfoAsync(dir);
          if (!info.exists) continue;
          const names = await fs.readDirectoryAsync(dir);
          for (const name of names) {
            const path = dir + name;
            try {
              const st = await fs.getInfoAsync(path);
              if (st.exists && !st.isDirectory) {
                entries.push({ path, size: st.size || 0, mtime: st.modificationTime || 0, name });
              }
            } catch {}
          }
        } catch {}
      }
      const total = entries.reduce((a, e) => a + e.size, 0);
      if (total <= limitBytes) return;
      // Oldest first — purge LRU until under cap.
      entries.sort((a, b) => a.mtime - b.mtime);
      let freed = 0;
      const need = total - limitBytes;
      for (const e of entries) {
        if (freed >= need) break;
        try {
          await fs.deleteAsync(e.path, { idempotent: true });
          syncIndex.delete(e.name);
          freed += e.size;
        } catch {}
      }
      _schedulePersistIndex();
    } finally {
      _lastEvictAt = Date.now();
      _evictInflight = null;
    }
  })();
  return _evictInflight;
}

// Clear the entire cache (not saved media)
export async function clearMediaCache() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  const dir = getCacheDir();
  try {
    await fs.deleteAsync(dir, { idempotent: true });
  } catch {}
}

// Clear saved media
export async function clearSavedMedia() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  try {
    await fs.deleteAsync(getSavedDir(), { idempotent: true });
  } catch {}
}

// Delete a single URL's local copies (both cache + permanent). Called when
// a conversation is deleted — WhatsApp-parity: user expects all media tied
// to that chat to leave the device.
export async function deleteCachedUrl(url) {
  if (Platform.OS === 'web' || !url) return;
  const fs = getFS();
  if (!fs) return;
  const key = urlToKey(url);
  for (const dir of [getCacheDir(), getSavedDir()]) {
    try { await fs.deleteAsync(dir + key, { idempotent: true }); } catch {}
  }
  syncIndex.delete(urlToKey(url));
}

// Bulk delete local media for a conversation. Pass the list of messages
// (from the SmartCache / server) before the DB rows are wiped.
export async function deleteConversationMedia(messages) {
  if (Platform.OS === 'web' || !Array.isArray(messages) || messages.length === 0) return;
  const urls = new Set();
  for (const m of messages) {
    if (!m?.file_url) continue;
    const url = m.file_url.startsWith('http') ? m.file_url : `https://chatyy.com.br${m.file_url}`;
    urls.add(url);
  }
  for (const url of urls) {
    try { await deleteCachedUrl(url); } catch {}
  }
}
