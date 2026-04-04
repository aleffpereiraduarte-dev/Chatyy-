/**
 * Audio Cache Service
 *
 * Caches audio messages locally so they load instantly after first play.
 * - Native: uses expo-file-system to download and store in cacheDirectory
 * - Web: uses Cache API (or falls back to browser default caching)
 *
 * Cache limits: max 200 files or ~100MB, evicts oldest first.
 */

import { Platform } from 'react-native';

const CACHE_DIR_NAME = 'audio-cache/';
const MAX_FILES = 200;
const MAX_BYTES = 100 * 1024 * 1024; // 100MB

let FileSystem = null;

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
  return fs.cacheDirectory + CACHE_DIR_NAME;
}

// Simple hash of a string to create a safe filename
function hashKey(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

// Extract audio extension from URL
function audioExt(url) {
  const m = url.match(/\.(m4a|mp3|ogg|webm|wav|aac|opus|mp4)(\?|#|$)/i);
  return m ? m[1].toLowerCase() : 'bin';
}

// Build cache filename from url + messageId
function cacheFileName(url, messageId) {
  const key = messageId ? String(messageId) : hashKey(url);
  const ext = audioExt(url);
  return key + '_' + hashKey(url) + '.' + ext;
}

// ============================================================
// WEB: Cache API helpers
// ============================================================

const WEB_CACHE_NAME = 'chatyy-audio-v1';

// Track blob URLs per remote URL so we can revoke old ones and reuse existing ones
const _blobUrlMap = new Map(); // remoteUrl -> blobUrl

function _createTrackedBlobUrl(remoteUrl, blob) {
  // Revoke previous blob URL for this remote URL if it exists
  const prev = _blobUrlMap.get(remoteUrl);
  if (prev) {
    try { URL.revokeObjectURL(prev); } catch {}
  }
  const blobUrl = URL.createObjectURL(blob);
  _blobUrlMap.set(remoteUrl, blobUrl);
  return blobUrl;
}

async function webGetCachedUri(url) {
  if (typeof caches === 'undefined') return url;
  // Return existing blob URL if we already have one
  const existing = _blobUrlMap.get(url);
  if (existing) return existing;
  try {
    const cache = await caches.open(WEB_CACHE_NAME);
    const resp = await cache.match(url);
    if (resp) {
      const blob = await resp.blob();
      return _createTrackedBlobUrl(url, blob);
    }
  } catch {}
  return null;
}

async function webCacheAudio(url) {
  if (typeof caches === 'undefined') return url;
  // Return existing blob URL if we already have one
  const existing = _blobUrlMap.get(url);
  if (existing) return existing;
  try {
    const cache = await caches.open(WEB_CACHE_NAME);
    // Check if already cached
    const cachedResp = await cache.match(url);
    if (cachedResp) {
      const blob = await cachedResp.blob();
      return _createTrackedBlobUrl(url, blob);
    }
    // Fetch and store
    const resp = await fetch(url);
    if (resp.ok) {
      await cache.put(url, resp.clone());
      const blob = await resp.blob();
      return _createTrackedBlobUrl(url, blob);
    }
  } catch {}
  return url;
}

async function webClearCache() {
  // Revoke all tracked blob URLs to free memory
  for (const blobUrl of _blobUrlMap.values()) {
    try { URL.revokeObjectURL(blobUrl); } catch {}
  }
  _blobUrlMap.clear();
  if (typeof caches === 'undefined') return;
  try { await caches.delete(WEB_CACHE_NAME); } catch {}
}

async function webGetCacheSize() {
  // Cache API doesn't expose size easily; return 0
  return 0;
}

// ============================================================
// NATIVE: expo-file-system helpers
// ============================================================

// In-memory index of cached files (rebuilt on first access)
let _index = null; // { files: [{ name, size, atime }], totalSize }

async function ensureDir() {
  const fs = getFS();
  if (!fs) return false;
  const dir = getCacheDir();
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) {
      await fs.makeDirectoryAsync(dir, { intermediates: true });
    }
    return true;
  } catch { return false; }
}

async function buildIndex() {
  const fs = getFS();
  if (!fs) { _index = { files: [], totalSize: 0 }; return; }
  const dir = getCacheDir();
  try {
    const dirInfo = await fs.getInfoAsync(dir);
    if (!dirInfo.exists) { _index = { files: [], totalSize: 0 }; return; }
    const entries = await fs.readDirectoryAsync(dir);
    const files = [];
    let totalSize = 0;
    // Get info for each file (batch of 20 at a time to avoid overwhelming)
    for (let i = 0; i < entries.length; i += 20) {
      const batch = entries.slice(i, i + 20);
      const infos = await Promise.allSettled(
        batch.map(name => fs.getInfoAsync(dir + name))
      );
      infos.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value.exists) {
          const size = r.value.size || 0;
          files.push({
            name: batch[idx],
            size,
            // modificationTime as proxy for access time
            atime: r.value.modificationTime || 0,
          });
          totalSize += size;
        }
      });
    }
    // Sort by access time ascending (oldest first) for eviction
    files.sort((a, b) => a.atime - b.atime);
    _index = { files, totalSize };
  } catch {
    _index = { files: [], totalSize: 0 };
  }
}

async function evictIfNeeded() {
  const fs = getFS();
  if (!fs || !_index) return;
  const dir = getCacheDir();

  while (_index.files.length > MAX_FILES || _index.totalSize > MAX_BYTES) {
    const oldest = _index.files.shift();
    if (!oldest) break;
    try {
      await fs.deleteAsync(dir + oldest.name, { idempotent: true });
      _index.totalSize -= oldest.size;
    } catch {}
  }
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Get a cached audio URI. If the file is cached locally, returns the local path.
 * If not cached, downloads it first (on native), or caches via Cache API (on web).
 *
 * @param {string} remoteUrl - The remote audio URL
 * @param {string|number} messageId - Message ID (used as part of cache key)
 * @param {function} onProgress - Optional callback: (progress: 0-1) => void
 * @returns {Promise<string>} Local or blob URI for playback
 */
export async function getCachedAudioUri(remoteUrl, messageId, onProgress) {
  if (!remoteUrl) return remoteUrl;

  // Web: use Cache API
  if (Platform.OS === 'web') {
    if (onProgress) onProgress(0.5);
    const uri = await webCacheAudio(remoteUrl);
    if (onProgress) onProgress(1);
    return uri;
  }

  // Native: use expo-file-system
  const fs = getFS();
  if (!fs) return remoteUrl;

  if (!_index) await buildIndex();
  await ensureDir();

  const fileName = cacheFileName(remoteUrl, messageId);
  const localPath = getCacheDir() + fileName;

  // Check if already cached
  try {
    const info = await fs.getInfoAsync(localPath);
    if (info.exists && info.size > 0) {
      return localPath;
    }
  } catch {}

  // Download with progress
  try {
    const downloadResumable = fs.createDownloadResumable(
      remoteUrl,
      localPath,
      {},
      onProgress
        ? (downloadProgress) => {
            if (downloadProgress.totalBytesExpectedToWrite > 0) {
              onProgress(
                downloadProgress.totalBytesWritten /
                downloadProgress.totalBytesExpectedToWrite
              );
            }
          }
        : undefined
    );

    const result = await downloadResumable.downloadAsync();
    if (result && result.status === 200) {
      // Update index
      const size = result.headers?.['content-length']
        ? parseInt(result.headers['content-length'], 10)
        : 0;
      let fileSize = size;
      try {
        const finfo = await fs.getInfoAsync(localPath);
        if (finfo.exists) fileSize = finfo.size || size;
      } catch {}

      _index.files.push({ name: fileName, size: fileSize, atime: Date.now() / 1000 });
      _index.totalSize += fileSize;

      // Evict old files if over limits
      await evictIfNeeded();

      return localPath;
    }

    // Failed download - clean up
    try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
  } catch {}

  return remoteUrl; // Fallback to remote
}

/**
 * Clear the entire audio cache.
 */
export async function clearAudioCache() {
  if (Platform.OS === 'web') {
    await webClearCache();
    return;
  }
  const fs = getFS();
  if (!fs) return;
  const dir = getCacheDir();
  try {
    await fs.deleteAsync(dir, { idempotent: true });
  } catch {}
  _index = null;
}

/**
 * Get the current audio cache size in bytes.
 */
export async function getAudioCacheSize() {
  if (Platform.OS === 'web') return webGetCacheSize();
  if (!_index) await buildIndex();
  return _index ? _index.totalSize : 0;
}

/**
 * Get the number of cached audio files.
 */
export async function getAudioCacheCount() {
  if (Platform.OS === 'web') return 0; // Not easily accessible from Cache API
  if (!_index) await buildIndex();
  return _index ? _index.files.length : 0;
}
