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
async function _hydrateIndexWhenReady() {
  if (Platform.OS === 'web') return;
  if (_loadIndexFromMmkv()) return; // got it synchronously (hot start)
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
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
    hash |= 0;
  }
  const ext = url.match(
    /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|tiff|mp4|mov|webm|mkv|m4v|3gp|avi|mp3|m4a|ogg|opus|wav|aac|flac|tgs|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|txt|csv|json)(\?|$)/i
  )?.[1] || 'bin';
  return Math.abs(hash).toString(36) + '.' + ext;
}

// ── Synchronous lookup / index bootstrap ───────────────────────────────

// Returns the local file:// path if the URL is already cached on disk,
// otherwise null. Zero latency — reads from an in-memory Map populated
// once at app start. Use this in render closures.
export function getLocalUriSyncJs(url) {
  if (!url || Platform.OS === 'web') return null;
  return syncIndex.get(urlToKey(url)) || null;
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

// Download and cache a URL, return local URI
export async function cacheMedia(url) {
  if (!url || Platform.OS === 'web') return url;
  const fs = getFS();
  if (!fs) return url;

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
      // 20s timeout so a stuck CDN (slow 3G, dead edge node) doesn't hold the
      // promise forever and freeze downstream awaits.
      const download = await Promise.race([
        fs.downloadAsync(url, localPath),
        new Promise((_, rej) => setTimeout(() => rej(new Error('download_timeout')), 20000)),
      ]);
      if (download?.status === 200) { registerSyncKey(url, localPath); return localPath; }
      try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
    } catch {
      try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
    }
    return url;
  })();
  _inflightDownloads.set(key, dlPromise);
  try { return await dlPromise; }
  finally { _inflightDownloads.delete(key); }
}

// Pre-cache an array of URLs (for batch caching when entering a conversation)
export async function preCacheUrls(urls) {
  if (Platform.OS === 'web' || !urls?.length) return;
  // Cache up to 20 at a time to avoid overwhelming
  const batch = urls.slice(0, 20);
  await Promise.allSettled(batch.map(url => cacheMedia(url)));
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
  const mediaMessages = messages.filter(m =>
    m.file_url && ['image', 'video', 'audio', 'voice', 'gif', 'sticker', 'file'].includes(m.type)
  );
  // Salva TODAS (antes só as últimas 100), em lotes de 20 em paralelo pra
  // não saturar a rede. User reclamou que rolando pra cima as mídias
  // antigas ficavam re-baixando — agora tudo que já foi visto vira permanente.
  const BATCH_SIZE = 20;
  for (let i = 0; i < mediaMessages.length; i += BATCH_SIZE) {
    const batch = mediaMessages.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(msg => {
      const url = msg.file_url?.startsWith('http') ? msg.file_url : `https://chatyy.com.br${msg.file_url}`;
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
