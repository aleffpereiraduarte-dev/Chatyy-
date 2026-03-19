/**
 * Chatyy Auto Photo Backup Service — V4 NATIVE
 *
 * Two paths:
 * A) NATIVE (iOS): Custom Swift module with PHCachingImageManager + NSURLSession background
 *    - Reads photos natively (no ph:// resolution needed)
 *    - Uploads directly to S3 via presigned URLs
 *    - Continues even when app is closed (NSURLSession daemon)
 *    - Google Photos-level performance
 *
 * B) FALLBACK (Android/web): Upload through PHP server
 *    - App resolves URI → uploads via FormData → PHP relays to S3
 *
 * Three execution modes:
 * 1. BACKGROUND: expo-background-fetch (every ~15 min)
 * 2. FOREGROUND: Native batch upload with progress events
 * 3. INSTANT: MediaLibrary listener for newly taken photos
 */
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as api from './api';

// Native module for iOS background uploads (PHCachingImageManager + NSURLSession)
let NativeUpload = null;
try {
  if (Platform.OS === 'ios') {
    NativeUpload = require('../modules/expo-background-upload').default;
  }
} catch { NativeUpload = null; }

// ============================================================
// CONSTANTS
// ============================================================
const TASK_NAME = 'CHATYY_PHOTO_BACKUP';

const STORAGE_KEYS = {
  BACKED_UP: 'backed_up_photos',
  ENABLED: 'backup_auto_enabled',
  WIFI_ONLY: 'backup_wifi_only',
  INCLUDE_VIDEO: 'backup_include_video',
  QUALITY: 'backup_quality',
  LAST_DATE: 'last_backup_date',
};

const MIME_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
};

const UPLOAD_WORKERS = 5;        // Parallel PHP uploads
const COMPRESS_MAX_DIM = 2048;   // Max pixel dimension for compression
const COMPRESS_QUALITY = 0.8;    // JPEG quality (0-1)
const BACKGROUND_BATCH = 500;    // Background task batch size (enqueue many so NSURLSession continues)

// ============================================================
// MODULE STATE
// ============================================================
let isRunning = false;
let shouldStop = false;
let progressCallback = null;
let mediaSubscription = null;
let appStateSubscription = null;
let initialized = false;

// ============================================================
// BACKGROUND TASK DEFINITION (must be at module level)
// ============================================================
TaskManager.defineTask(TASK_NAME, async () => {
  if (Platform.OS === 'web') return BackgroundFetch.BackgroundFetchResult.NoData;

  try {
    const enabled = await AsyncStorage.getItem(STORAGE_KEYS.ENABLED);
    if (enabled !== 'true') return BackgroundFetch.BackgroundFetchResult.NoData;

    const wifiOnly = await AsyncStorage.getItem(STORAGE_KEYS.WIFI_ONLY);
    if (wifiOnly === 'true') {
      try {
        const NetInfo = require('@react-native-community/netinfo').default;
        const netState = await NetInfo.fetch();
        if (netState.type !== 'wifi') return BackgroundFetch.BackgroundFetchResult.NoData;
      } catch {}
    }

    if (!api.getAuthToken()) return BackgroundFetch.BackgroundFetchResult.NoData;

    // Background fetch: copy photos to file:// + enqueue S3 uploads (30s limit)
    let uploaded = 0;
    if (Platform.OS === 'ios') {
      try {
        const ML = require('expo-media-library');
        const FS = require('expo-file-system');
        const { status } = await ML.getPermissionsAsync();
        if (status === 'granted') {
          const backedUpIds = await getBackedUpIds();
          const assets = await ML.getAssetsAsync({ mediaType: [ML.MediaType.photo, ML.MediaType.video], first: 200, sortBy: [ML.SortBy.creationTime] });
          const pending = (assets?.assets || []).filter(a => !backedUpIds[a.id]);
          if (pending.length > 0) {
            const cacheDir = FS.cacheDirectory + 'backup_queue/';
            await FS.makeDirectoryAsync(cacheDir, { intermediates: true }).catch(() => {});
            // Copy + enqueue up to 200 photos in sub-batches of 50
            const maxPhotos = Math.min(pending.length, 200);
            for (let i = 0; i < maxPhotos; i += 50) {
              const chunk = pending.slice(i, Math.min(i + 50, maxPhotos));
              const filesForChunk = chunk.map(a => ({ name: assetFilename(a), mime: assetMime(a) }));
              try {
                const batchResult = await api.getPresignedBatch(filesForChunk);
                if (batchResult?.success && batchResult?.data?.uploads) {
                  for (let idx = 0; idx < chunk.length; idx++) {
                    try {
                      const info = await ML.getAssetInfoAsync(chunk[idx].id);
                      const localUri = (info?.localUri || '').split('#')[0];
                      if (!localUri) continue;
                      const destUri = cacheDir + Date.now() + '_' + idx + '_' + assetFilename(chunk[idx]);
                      await FS.copyAsync({ from: localUri, to: destUri });
                      FS.uploadAsync(batchResult.data.uploads[idx].upload_url, destUri, {
                        httpMethod: 'PUT',
                        uploadType: FS.FileSystemUploadType.BINARY_CONTENT,
                        sessionType: FS.FileSystemSessionType.BACKGROUND,
                      }).then(r => {
                        FS.deleteAsync(destUri, { idempotent: true }).catch(() => {});
                        if (r.status >= 200 && r.status < 300) {
                          api.confirmUpload(batchResult.data.uploads[idx].file_id).catch(() => {});
                        }
                      }).catch(() => { FS.deleteAsync(destUri, { idempotent: true }).catch(() => {}); });
                      backedUpIds[chunk[idx].id] = -2;
                      uploaded++;
                    } catch {}
                  }
                }
              } catch {}
            }
            await saveBackedUpIds(backedUpIds);
          }
        }
      } catch {}
    }

    // Fallback to PHP upload if native didn't work
    if (uploaded === 0) uploaded = await uploadBatch(BACKGROUND_BATCH);
    if (uploaded > 0) {
      await AsyncStorage.setItem(STORAGE_KEYS.LAST_DATE, new Date().toISOString());
      return BackgroundFetch.BackgroundFetchResult.NewData;
    }
    return BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// ============================================================
// BACKED UP IDS CACHE (avoids repeated AsyncStorage reads)
// ============================================================
let cachedBackedUpIds = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30000;

async function getBackedUpIds() {
  const now = Date.now();
  if (cachedBackedUpIds && now - cacheTimestamp < CACHE_TTL) {
    return cachedBackedUpIds;
  }
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEYS.BACKED_UP);
    cachedBackedUpIds = saved ? JSON.parse(saved) : {};
  } catch {
    cachedBackedUpIds = {};
  }
  cacheTimestamp = Date.now();
  return cachedBackedUpIds;
}

async function saveBackedUpIds(ids) {
  cachedBackedUpIds = ids;
  cacheTimestamp = Date.now();
  await AsyncStorage.setItem(STORAGE_KEYS.BACKED_UP, JSON.stringify(ids));
}

function markBacked(ids, assetId) {
  ids[assetId] = Date.now();
  cachedBackedUpIds = ids;
  cacheTimestamp = Date.now();
}

// ============================================================
// HELPERS: Asset metadata (no getAssetInfoAsync!)
// ============================================================
function assetFilename(asset) {
  return asset.filename || asset.name || `photo_${Date.now()}.jpg`;
}

function assetMime(asset) {
  const filename = assetFilename(asset);
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const isVideo = asset.mediaType === 'video' || ['mp4', 'mov', 'avi', 'mkv'].includes(ext);
  return isVideo ? (MIME_MAP[ext] || 'video/mp4') : (MIME_MAP[ext] || 'image/jpeg');
}

function assetUri(asset) {
  // Use asset.uri directly — works with fetch() and FileSystem on both iOS (ph://) and Android (content://)
  return (asset.uri || '').split('#')[0];
}

function isVideoAsset(asset) {
  const ext = (assetFilename(asset).split('.').pop() || '').toLowerCase();
  return asset.mediaType === 'video' || ['mp4', 'mov', 'avi', 'mkv'].includes(ext);
}

// ============================================================
// COMPRESS: Resize + JPEG compress (2048px, quality 80)
// ============================================================
async function compressPhoto(uri, asset) {
  if (isVideoAsset(asset)) return { uri, mime: assetMime(asset) };

  // If ph:// URI, resolve to file:// first (manipulateAsync needs file access)
  let sourceUri = uri;
  if (uri.startsWith('ph://') || uri.startsWith('assets-library://')) {
    try {
      const ML = require('expo-media-library');
      const assetId = asset.id || asset.deviceId || uri.replace('ph://', '').split('/')[0];
      const info = await ML.getAssetInfoAsync(assetId);
      sourceUri = (info?.localUri || '').split('#')[0] || uri;
    } catch {}
  }

  try {
    const ImageManipulator = require('expo-image-manipulator');
    const actions = [];
    const w = asset.width || 0;
    const h = asset.height || 0;
    if (w > COMPRESS_MAX_DIM || h > COMPRESS_MAX_DIM) {
      actions.push(w >= h ? { resize: { width: COMPRESS_MAX_DIM } } : { resize: { height: COMPRESS_MAX_DIM } });
    }
    const result = await ImageManipulator.manipulateAsync(
      sourceUri, actions,
      { compress: COMPRESS_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
    );
    return { uri: result.uri, mime: 'image/jpeg' };
  } catch (err) {
    console.warn(`[backup] Compress failed:`, err?.message);
    return { uri: sourceUri, mime: assetMime(asset) };
  }
}

// ============================================================
// SINGLE PHOTO UPLOAD — Upload through PHP (server relays to S3)
// Works with ph:// URIs natively via FormData
// ============================================================
async function uploadOnePhoto(asset) {
  try {
    const filename = assetFilename(asset);
    const mime = assetMime(asset);

    // Must resolve ph:// to file:// (iOS FormData doesn't handle ph://)
    let uploadUri = assetUri(asset);
    if (Platform.OS === 'ios' && (uploadUri.startsWith('ph://') || uploadUri.startsWith('assets-library://'))) {
      const ML = require('expo-media-library');
      const assetId = asset.id || uploadUri.replace('ph://', '').split('/')[0];
      const info = await ML.getAssetInfoAsync(assetId);
      uploadUri = (info?.localUri || '').split('#')[0];
      if (!uploadUri) return false;
    }
    if (!uploadUri) return false;

    // Upload to PHP server via FormData with file:// URI
    const result = await api.uploadPhotoBackup(
      { uri: uploadUri, name: filename, mimeType: mime }
    );
    return !!(result?.success || result?.data?.id || result?.data?.files);
  } catch (err) {
    console.warn(`[backup] uploadOnePhoto error:`, err?.message || err);
    return false;
  }
}

// ============================================================
// BATCH UPLOAD (for background task)
// ============================================================
let isBatchRunning = false;

async function uploadBatch(maxCount) {
  if (isRunning || isBatchRunning) return 0;
  isBatchRunning = true;

  let uploaded = 0;
  try {
    const ML = require('expo-media-library');
    const { status } = await ML.getPermissionsAsync();
    if (status !== 'granted') { isBatchRunning = false; return 0; }

    const backedUpIds = await getBackedUpIds();

    const mediaTypes = [ML.MediaType.photo, ML.MediaType.video];

    const assets = await ML.getAssetsAsync({
      mediaType: mediaTypes,
      first: 100,
      sortBy: [ML.SortBy.creationTime],
    });

    const pending = (assets?.assets || []).filter(a => !backedUpIds[a.id]);
    const batch = pending.slice(0, maxCount);

    for (const asset of batch) {
      if (shouldStop) break;
      const ok = await uploadOnePhoto(asset);
      if (ok === true) {
        markBacked(backedUpIds, asset.id);
        uploaded++;
      }
    }

    if (uploaded > 0) await saveBackedUpIds(backedUpIds);
  } catch {}

  isBatchRunning = false;
  return uploaded;
}

// ============================================================
// FOREGROUND BACKUP — Simple parallel upload through PHP
// ============================================================

/**
 * Start a foreground backup of all device photos.
 *
 * Simple flow:
 * 1. Get all pending photos from device
 * 2. Compress + upload to PHP server with 3 parallel workers
 * 3. PHP saves file, inserts DB, relays to S3
 * 4. Client gets immediate success per photo
 *
 * @param {Function} onProgress - Called with { current, total }
 * @returns {Promise<{ uploaded: number, total: number }>}
 */
export async function startForegroundBackup(onProgress) {
  if (Platform.OS === 'web') return { uploaded: 0, total: 0, error: 'web_unsupported' };

  // If already running, force-stop and take over
  if (isRunning) {
    shouldStop = true;
    await new Promise(r => setTimeout(r, 500));
    isRunning = false;
  }

  shouldStop = false;
  isRunning = true;
  progressCallback = onProgress || null;

  try {
    // Check WiFi-only setting
    const wifiOnly = await AsyncStorage.getItem(STORAGE_KEYS.WIFI_ONLY);
    if (wifiOnly === 'true') {
      try {
        const NetInfo = require('@react-native-community/netinfo').default;
        const netState = await NetInfo.fetch();
        if (netState.type !== 'wifi') {
          isRunning = false;
          return { uploaded: 0, total: 0, error: 'wifi_required' };
        }
      } catch {}
    }

    const ML = require('expo-media-library');
    const { status } = await ML.getPermissionsAsync(); // faster than request (no popup)
    if (status !== 'granted') {
      isRunning = false;
      return { uploaded: 0, total: 0, error: 'permission_denied' };
    }

    const backedUpIds = await getBackedUpIds();

    const mediaTypes = [ML.MediaType.photo, ML.MediaType.video];

    // Stream-and-enqueue: fetch page by page, enqueue IMMEDIATELY per page
    // This way photos start uploading within 1 second, not after scanning all 43000
    let done = 0;
    let uploaded = 0;
    let totalScanned = 0;
    let hasMoreAssets = true;
    let afterCursor = undefined;
    const total = 0; // unknown until scan complete

    // ===== PATH A: NATIVE MODULE (iOS) - ONE CALL, Swift does everything =====
    if (NativeUpload?.startNativeBackup && Platform.OS === 'ios') {
      console.log(`[backup] Starting NATIVE backup (Swift handles everything)`);

      // ONE call to Swift - it handles everything:
      // 1. Scans PHAssets natively
      // 2. Copies to file:// (nsurlsessiond can't read ph://)
      // 3. Creates multipart POST upload task to PHP server
      // 4. NSURLSession background continues after minimize
      // 5. Uses beginBackgroundTask for extra time (~30s-4min)
      const serverUrl = api.BASE_URL + '/api/email.php';
      const authToken = api.getAuthToken() || '';

      const progressSub = NativeUpload.addListener('onProgress', (event) => {
        if (progressCallback) {
          try { progressCallback({ current: event.uploaded || 0, total: event.total || 0 }); } catch {}
        }
      });

      try {
        const result = await NativeUpload.startNativeBackup(serverUrl, authToken);
        uploaded = result.uploaded || 0;
        done = result.total || 0;
        console.log(`[backup] Native backup done: ${uploaded}/${done} stopped=${result.stopped}`);
      } catch (err) {
        console.warn(`[backup] Native backup error:`, err?.message);
      }

      progressSub?.remove();

    // ===== PATH B: JS FALLBACK (Android/web) =====
    } else {
      console.log(`[backup] Using JS fallback upload for ${total} photos`);
      let nextIdx = 0;

      async function worker() {
        while (nextIdx < pending.length && !shouldStop) {
          const idx = nextIdx++;
          const asset = pending[idx];

          try {
            const ok = await uploadOnePhoto(asset);
            if (ok === true) {
              markBacked(backedUpIds, asset.id);
              uploaded++;
            }
          } catch {}

          done++;
          if (progressCallback) {
            try { progressCallback({ current: done, total }); } catch {}
          }
          if (done % 10 === 0) await saveBackedUpIds(backedUpIds);
        }
      }

      await Promise.all(Array.from({ length: UPLOAD_WORKERS }, () => worker()));
    }

    // Final save
    await saveBackedUpIds(backedUpIds);
    await AsyncStorage.setItem(STORAGE_KEYS.LAST_DATE, new Date().toISOString());

    isRunning = false;
    progressCallback = null;
    console.log(`[backup] Complete: ${uploaded}/${total} uploaded`);
    return {
      uploaded,
      total,
      backedUpCount: Object.keys(backedUpIds).length,
    };
  } catch (err) {
    isRunning = false;
    progressCallback = null;
    return { uploaded: 0, total: 0, error: err?.message || 'unknown' };
  }
}

/**
 * Pause the current foreground backup.
 */
export function pause() {
  shouldStop = true;
}

/**
 * Check if backup is currently running.
 */
export function getIsRunning() {
  return isRunning;
}

// ============================================================
// MEDIA LIBRARY LISTENER (instant new photo trigger)
// ============================================================
function setupMediaListener() {
  if (mediaSubscription) return;

  try {
    const ML = require('expo-media-library');

    (async () => {
      try {
        const { status } = await ML.getPermissionsAsync();
        if (status !== 'granted') return;

        mediaSubscription = ML.addListener((event) => {
          if (event.hasIncrementalChanges) {
            if (event.insertedAssets && event.insertedAssets.length > 0) {
              backupNewAssets(event.insertedAssets);
            } else {
              uploadBatch(20).catch(() => {});
            }
          }
        });
      } catch {}
    })();
  } catch {}
}

// ============================================================
// APP STATE LISTENER (foreground check)
// ============================================================
function setupAppStateListener() {
  if (appStateSubscription) return;

  appStateSubscription = AppState.addEventListener('change', async (state) => {
    if (state === 'active') {
      // Auto-restart when returning to foreground
      setTimeout(() => {
        if (!isRunning) startForegroundBackup(null).catch(() => {});
      }, 1000);
    } else if (state === 'background' && NativeUpload && Platform.OS === 'ios') {
      // App going to background - quickly enqueue a batch via native module
      // iOS gives ~30 seconds of background time automatically
      console.log('[backup] Going to background - quick enqueue');
      try {
        const ML = require('expo-media-library');
        const { status } = await ML.getPermissionsAsync();
        if (status !== 'granted') return;
        const backedUpIds = await getBackedUpIds();
        const assets = await ML.getAssetsAsync({
          mediaType: [ML.MediaType.photo, ML.MediaType.video],
          first: 50,
          sortBy: [ML.SortBy.creationTime],
        });
        const pending = (assets?.assets || []).filter(a => !backedUpIds[a.id]);
        if (pending.length === 0) return;
        const filesForBatch = pending.map(a => ({ name: assetFilename(a), mime: assetMime(a) }));
        const batchResult = await api.getPresignedBatch(filesForBatch);
        if (batchResult?.success && batchResult?.data?.uploads) {
          const requests = pending.map((asset, idx) => ({
            assetId: asset.id,
            presignedUrl: batchResult.data.uploads[idx].upload_url,
            mimeType: assetMime(asset),
            maxWidth: 0, maxHeight: 0,
          }));
          await NativeUpload.uploadBatch(requests);
          for (const asset of pending) backedUpIds[asset.id] = -2;
          await saveBackedUpIds(backedUpIds);
          console.log('[backup] Enqueued ' + pending.length + ' before background');
        }
      } catch (e) {
        console.warn('[backup] Background enqueue error:', e?.message);
      }
    }
  });
}

// ============================================================
// BACKUP NEW ASSETS (from MediaLibrary listener)
// ============================================================
async function backupNewAssets(assets) {
  if (isRunning || isBatchRunning) return;
  isBatchRunning = true;

  try {
    const backedUpIds = await getBackedUpIds();
    let uploadedCount = 0;

    const pending = assets.filter(a => !backedUpIds[a.id]);
    if (pending.length === 0) { isBatchRunning = false; return; }

    for (const asset of pending) {
      if (shouldStop) break;
      const ok = await uploadOnePhoto(asset);
      if (ok) {
        markBacked(backedUpIds, asset.id);
        uploadedCount++;
      }
    }

    if (uploadedCount > 0) {
      await saveBackedUpIds(backedUpIds);
      await AsyncStorage.setItem(STORAGE_KEYS.LAST_DATE, new Date().toISOString());
    }
  } catch {}

  isBatchRunning = false;
}

// ============================================================
// BACKGROUND FETCH REGISTRATION
// ============================================================
async function registerBackgroundTask() {
  if (Platform.OS === 'web') return;

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    if (isRegistered) return;

    await BackgroundFetch.registerTaskAsync(TASK_NAME, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch {}
}

async function unregisterBackgroundTask() {
  if (Platform.OS === 'web') return;

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    if (isRegistered) {
      await BackgroundFetch.unregisterTaskAsync(TASK_NAME);
    }
  } catch {}
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Initialize auto-backup system. Call once from _layout.js.
 * Safe to call multiple times (idempotent).
 */
export async function initAutoBackup() {
  if (Platform.OS === 'web') return;
  if (initialized) return;

  const enabled = await AsyncStorage.getItem(STORAGE_KEYS.ENABLED).catch(() => null);
  if (enabled !== 'true') return;

  initialized = true;

  registerBackgroundTask().catch(() => {});
  setupMediaListener();
  setupAppStateListener();

  // Start enqueuing IMMEDIATELY on app launch
  if (!isRunning) startForegroundBackup(null).catch(() => {});
}

/**
 * Stop all auto-backup listeners and unregister background task.
 */
export function stopAutoBackup() {
  shouldStop = true;
  isRunning = false;
  isBatchRunning = false;

  if (mediaSubscription) {
    mediaSubscription.remove();
    mediaSubscription = null;
  }
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }

  unregisterBackgroundTask().catch(() => {});
  initialized = false;
}

/**
 * Called when the backup setting changes (from photos.js toggle).
 */
export async function onBackupSettingChanged(enabled) {
  if (Platform.OS === 'web') return;

  if (enabled) {
    initialized = false;
    shouldStop = false;
    await initAutoBackup();
  } else {
    stopAutoBackup();
  }
}

/**
 * Get the count of pending (not yet backed up) photos.
 */
export async function getPendingCount() {
  if (Platform.OS === 'web') return 0;

  try {
    const ML = require('expo-media-library');
    const { status } = await ML.getPermissionsAsync();
    if (status !== 'granted') return 0;

    const mediaTypes = [ML.MediaType.photo, ML.MediaType.video];

    const backedUpIds = await getBackedUpIds();

    const assets = await ML.getAssetsAsync({
      mediaType: mediaTypes,
      first: 200,
      sortBy: [ML.SortBy.creationTime],
    });

    return (assets?.assets || []).filter(a => !backedUpIds[a.id]).length;
  } catch {
    return 0;
  }
}

/**
 * Get the total number of backed up photos.
 */
export async function getBackedUpCount() {
  const ids = await getBackedUpIds();
  return Object.keys(ids).length;
}

/**
 * Reset backup history (re-upload everything).
 */
export async function resetBackupHistory() {
  cachedBackedUpIds = {};
  cacheTimestamp = Date.now();
  await AsyncStorage.removeItem(STORAGE_KEYS.BACKED_UP);
}
