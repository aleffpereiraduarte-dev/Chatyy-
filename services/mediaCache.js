import { Platform } from 'react-native';

const CACHE_DIR = 'chat-media-cache';
const PERMANENT_DIR = 'chat-media-saved'; // Permanent storage (not cleared by OS)
const MAX_CACHE_MB = 500; // Max cache size before cleanup
let FileSystem = null;

// ── Sync in-memory index: url → local file:// path ─────────────────────
// Populated at app start by scanning the cache dir. Lets resolveMediaUri()
// return file:// synchronously on Android (iOS uses the native module).
const syncIndex = new Map();        // urlHashKey → local absolute path
let syncInitPromise = null;          // dedupe concurrent init calls

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

// Hash a URL to a safe filename
function urlToKey(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
    hash |= 0;
  }
  // Extract extension from URL
  const ext = url.match(/\.(jpg|jpeg|png|gif|mp4|mp3|m4a|ogg|webm|wav|webp|pdf)(\?|$)/i)?.[1] || 'bin';
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
    const fs = getFS();
    if (!fs) return;
    for (const dir of [getCacheDir(), getSavedDir()]) {
      try {
        const info = await fs.getInfoAsync(dir);
        if (!info.exists) continue;
        const entries = await fs.readDirectoryAsync(dir);
        for (const name of entries) {
          syncIndex.set(name, dir + name);
        }
      } catch {}
    }
  })();
  return syncInitPromise;
}

// Re-register a single URL → local path (called after every successful
// cacheMedia / saveMediaPermanent so syncIndex stays fresh mid-session).
function registerSyncKey(url, localPath) {
  if (Platform.OS === 'web' || !url || !localPath) return;
  syncIndex.set(urlToKey(url), localPath);
}

// Get cached URI for a URL, or return the original URL
export async function getCachedUri(url) {
  if (!url || Platform.OS === 'web') return url;
  const fs = getFS();
  if (!fs) return url;

  const dir = getCacheDir();
  const key = urlToKey(url);
  const localPath = dir + key;

  try {
    const info = await fs.getInfoAsync(localPath);
    if (info.exists) return localPath;
  } catch {}

  return url; // Not cached yet
}

// Download and cache a URL, return local URI
export async function cacheMedia(url) {
  if (!url || Platform.OS === 'web') return url;
  const fs = getFS();
  if (!fs) return url;

  const dir = getCacheDir();
  const key = urlToKey(url);
  const localPath = dir + key;

  try {
    const info = await fs.getInfoAsync(localPath);
    if (info.exists) return localPath;
  } catch {}

  try {
    // Ensure directory exists
    const dirInfo = await fs.getInfoAsync(dir);
    if (!dirInfo.exists) {
      await fs.makeDirectoryAsync(dir, { intermediates: true });
    }

    const download = await fs.downloadAsync(url, localPath);
    if (download.status === 200) { registerSyncKey(url, localPath); return localPath; }
    // Clean up failed download
    try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
  } catch {}

  return url; // Fallback to remote URL
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

// Auto-save all media from a conversation for offline access
export async function saveConversationMedia(messages) {
  if (Platform.OS === 'web' || !messages?.length) return;
  const mediaMessages = messages.filter(m =>
    m.file_url && ['image', 'video', 'audio', 'voice'].includes(m.type)
  );
  // Save up to 50 media files per conversation
  const batch = mediaMessages.slice(-50);
  for (const msg of batch) {
    const url = msg.file_url?.startsWith('http') ? msg.file_url : `https://chatyy.com.br${msg.file_url}`;
    try { await saveMediaPermanent(url); } catch {}
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
