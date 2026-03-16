import { Platform } from 'react-native';

const CACHE_DIR = 'chat-media-cache';
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
  return fs.cacheDirectory + CACHE_DIR + '/';
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
    if (download.status === 200) return localPath;
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

// Clear the entire cache
export async function clearMediaCache() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  const dir = getCacheDir();
  try {
    await fs.deleteAsync(dir, { idempotent: true });
  } catch {}
}
