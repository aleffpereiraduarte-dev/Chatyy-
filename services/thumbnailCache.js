import * as FileSystem from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Platform } from 'react-native';

// Native Core Image resize (iOS) — 5-10x faster than expo-image-manipulator
// because CIImage stays on the GPU. Falls back to expo-image-manipulator
// when the native module isn't available.
const _NativeImage = (() => {
  if (Platform.OS !== 'ios') return null;
  try { return require('../modules/expo-native-toolkit').Image; } catch { return null; }
})();

const THUMB_DIR = `${FileSystem.documentDirectory}photo_thumbs/`;
const THUMB_SIZE = 200;

let dirReady = false;
// In-memory index of cached thumbnails - avoids disk I/O per photo
let memoryIndex = null; // Set of sanitized asset IDs

async function ensureDir() {
  if (dirReady) return;
  const info = await FileSystem.getInfoAsync(THUMB_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(THUMB_DIR, { intermediates: true });
  dirReady = true;
}

// Load the list of cached thumbnails into memory (one disk read)
async function loadIndex() {
  if (memoryIndex) return;
  await ensureDir();
  try {
    const files = await FileSystem.readDirectoryAsync(THUMB_DIR);
    // .replace('.jpg', '') sem âncora pode comer ".jpg" no meio do nome.
    memoryIndex = new Set(files.map(f => f.replace(/\.jpg$/i, '')));
  } catch {
    memoryIndex = new Set();
  }
}

function sanitizeId(assetId) {
  if (!assetId) return '';
  return String(assetId).replace(/[^a-zA-Z0-9-]/g, '_');
}

function thumbPath(assetId) {
  return `${THUMB_DIR}${sanitizeId(assetId)}.jpg`;
}

// Check cache - instant (memory lookup, zero disk I/O)
export function hasThumbnailSync(assetId) {
  if (!memoryIndex) return null;
  const safe = sanitizeId(assetId);
  return memoryIndex.has(safe) ? `${THUMB_DIR}${safe}.jpg` : null;
}

// Generate thumbnail from ph:// or file:// URI
export async function generateThumbnail(assetId, sourceUri) {
  if (Platform.OS === 'web') return sourceUri;

  await ensureDir();
  if (!memoryIndex) await loadIndex();

  // Check memory cache
  const cached = hasThumbnailSync(assetId);
  if (cached) return cached;

  const safe = sanitizeId(assetId);
  const dest = thumbPath(assetId);

  // Try 0: native Core Image (iOS only) — much faster
  if (_NativeImage?.resize) {
    try {
      const result = await _NativeImage.resize({
        uri: sourceUri, maxWidth: THUMB_SIZE, quality: 0.7, format: 'jpeg',
      });
      if (result?.uri) {
        // Antes: replace + recolocar 'file://' gerava `file:////...` quando
        // result.uri já vinha sem o prefixo, quebrando moveAsync.
        await FileSystem.moveAsync({ from: result.uri, to: dest });
        memoryIndex.add(safe);
        return dest;
      }
    } catch {}
  }
  // Try 1: manipulate directly from ph:// URI (works for most photos)
  try {
    const result = await manipulateAsync(
      sourceUri,
      [{ resize: { width: THUMB_SIZE } }],
      { format: SaveFormat.JPEG, compress: 0.7 }
    );
    await FileSystem.moveAsync({ from: result.uri, to: dest });
    memoryIndex.add(safe);
    return dest;
  } catch {}

  // Try 2: resolve localUri via MediaLibrary (for recent/iCloud photos)
  try {
    const ML = require('expo-media-library');
    const info = await ML.getAssetInfoAsync(assetId);
    const localUri = (info?.localUri || '').split('#')[0];
    if (localUri) {
      const result = await manipulateAsync(
        localUri,
        [{ resize: { width: THUMB_SIZE } }],
        { format: SaveFormat.JPEG, compress: 0.7 }
      );
      await FileSystem.moveAsync({ from: result.uri, to: dest });
      memoryIndex.add(safe);
      return dest;
    }
  } catch {}

  return sourceUri;
}

// Generate thumbnails for a batch of assets
export async function generateBatch(assets, onProgress) {
  // Curto-circuito no web — FileSystem é nativo, sem-op aqui.
  if (Platform.OS === 'web') {
    const out = new Map();
    for (const a of assets) out.set(a.deviceId || a.id, a.uri || a.thumb_uri || '');
    return out;
  }
  await ensureDir();
  if (!memoryIndex) await loadIndex();

  const results = new Map();
  const uncached = [];

  // Check cache from memory (instant, no disk I/O)
  for (const asset of assets) {
    const id = asset.deviceId || asset.id;
    const cached = hasThumbnailSync(id);
    if (cached) {
      results.set(id, cached);
    } else {
      uncached.push(asset);
    }
  }

  // Generate uncached in parallel (10 at a time)
  const PARALLEL = 10;
  for (let i = 0; i < uncached.length; i += PARALLEL) {
    const batch = uncached.slice(i, i + PARALLEL);
    const generated = await Promise.all(
      batch.map(async (asset) => {
        const id = asset.deviceId || asset.id;
        const uri = await generateThumbnail(id, asset.uri);
        return { id, uri };
      })
    );
    for (const { id, uri } of generated) {
      results.set(id, uri);
    }
    if (onProgress) onProgress(Math.min(i + PARALLEL, uncached.length), uncached.length);
  }

  return results;
}

// Clear all cached thumbnails
export async function clearCache() {
  try {
    await FileSystem.deleteAsync(THUMB_DIR, { idempotent: true });
    dirReady = false;
    memoryIndex = null;
  } catch {}
}
