/**
 * Chatyy Auto Photo Backup — ORCHESTRATOR
 *
 * This module is ONLY responsible for:
 * - BackgroundFetch task registration (TaskManager.defineTask)
 * - MediaLibrary listener (instant new photo trigger)
 * - AppState listener (foreground resume trigger)
 * - iOS native module bridge (NativeUpload / NSURLSession)
 *
 * ALL upload logic is delegated to BackupEngine via the unified backup API.
 * State is managed by backup/backupStorage.js.
 *
 * Execution modes:
 * 1. BACKGROUND: expo-background-fetch (every ~15 min) -> engine.runFullBackup
 * 2. FOREGROUND: startForegroundBackup -> engine.runFullBackup (or NativeUpload on iOS)
 * 3. INSTANT: MediaLibrary listener -> engine.runFullBackup (small batch)
 */
import { Platform, AppState } from 'react-native';
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as api from './api';
import {
  getSettings, saveSettings, getBackedUpMap, saveBackedUpMap,
  markAssetBackedUp, setLastSync, KEYS,
} from './backup/backupStorage';

// Native module for iOS background uploads (PHCachingImageManager + NSURLSession)
let NativeUpload = null;
try {
  if (Platform.OS === 'ios') {
    NativeUpload = require('../modules/expo-background-upload').default;
  }
} catch (e) { console.warn('[AutoBackup] Error loading native module:', e.message); NativeUpload = null; }

// ============================================================
// CONSTANTS
// ============================================================
const TASK_NAME = 'CHATYY_AUTO_BACKUP';
const APP_STATE_COOLDOWN = 5 * 60 * 1000; // 5 minutes cooldown

// ============================================================
// MODULE STATE
// ============================================================
let lockState = 'idle'; // 'idle' | 'foreground' | 'batch' | 'stopping'
let progressCallback = null;
let mediaSubscription = null;
let appStateSubscription = null;
let initialized = false;
let lastAppStateBackupTime = 0;

function acquireLock(requestedState) {
  if (lockState === 'idle') { lockState = requestedState; return true; }
  return false;
}
function releaseLock() { lockState = 'idle'; }
function requestStop() { if (lockState !== 'idle') lockState = 'stopping'; }
function isStopping() { return lockState === 'stopping'; }
function isLocked() { return lockState !== 'idle'; }

// ============================================================
// HELPERS: Asset metadata
// ============================================================
const MIME_MAP = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  heic: 'image/heic', heif: 'image/heif', gif: 'image/gif',
  webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska',
};

function assetFilename(asset) {
  return asset.filename || asset.name || `photo_${Date.now()}.jpg`;
}

function assetMime(asset) {
  const filename = assetFilename(asset);
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const isVideo = asset.mediaType === 'video' || ['mp4', 'mov', 'avi', 'mkv'].includes(ext);
  return isVideo ? (MIME_MAP[ext] || 'video/mp4') : (MIME_MAP[ext] || 'image/jpeg');
}

// ============================================================
// BACKGROUND TASK DEFINITION (must be at module level)
// ============================================================
TaskManager.defineTask(TASK_NAME, async () => {
  if (Platform.OS === 'web') return BackgroundFetch.BackgroundFetchResult.NoData;

  try {
    const settings = await getSettings();
    if (!settings.enabled) return BackgroundFetch.BackgroundFetchResult.NoData;

    // WiFi check
    if (settings.wifiOnly) {
      try {
        const NetInfo = require('@react-native-community/netinfo').default;
        const netState = await NetInfo.fetch();
        if (netState.type !== 'wifi') return BackgroundFetch.BackgroundFetchResult.NoData;
      } catch (e) { console.warn('[AutoBackup] Error checking network:', e.message); }
    }

    if (!api.getAuthToken()) return BackgroundFetch.BackgroundFetchResult.NoData;

    // iOS native path: presigned batch upload via NSURLSession (survives background)
    let uploaded = 0;
    if (Platform.OS === 'ios') {
      try {
        const ML = require('expo-media-library');
        const FS = require('expo-file-system');
        const { status } = await ML.getPermissionsAsync();
        if (status === 'granted') {
          const backedUpIds = await getBackedUpMap();
          const assets = await ML.getAssetsAsync({
            mediaType: [ML.MediaType.photo, ML.MediaType.video],
            first: 200, sortBy: [ML.SortBy.creationTime],
          });
          const pending = (assets?.assets || []).filter(a => !backedUpIds[a.id]);
          if (pending.length > 0) {
            const cacheDir = FS.cacheDirectory + 'backup_queue/';
            await FS.makeDirectoryAsync(cacheDir, { intermediates: true }).catch(() => {});
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
                      try {
                        const r = await FS.uploadAsync(batchResult.data.uploads[idx].upload_url, destUri, {
                          httpMethod: 'PUT',
                          uploadType: FS.FileSystemUploadType.BINARY_CONTENT,
                          sessionType: FS.FileSystemSessionType.BACKGROUND,
                        });
                        FS.deleteAsync(destUri, { idempotent: true }).catch(() => {});
                        if (r.status >= 200 && r.status < 300) {
                          const confirmResult = await api.confirmUpload(batchResult.data.uploads[idx].file_id);
                          if (confirmResult?.success !== false) {
                            markAssetBackedUp(backedUpIds, chunk[idx].id);
                            uploaded++;
                          }
                        }
                      } catch (uploadErr) {
                        console.warn('[AutoBackup] Error uploading in background:', uploadErr.message);
                        FS.deleteAsync(destUri, { idempotent: true }).catch(() => {});
                      }
                    } catch (e) { console.warn('[AutoBackup] Error processing asset in background:', e.message); }
                  }
                }
              } catch (e) { console.warn('[AutoBackup] Error getting presigned batch:', e.message); }
            }
            await saveBackedUpMap(backedUpIds);
          }
        }
      } catch (e) { console.warn('[AutoBackup] Error in iOS background backup:', e.message); }
    }

    // Fallback: use BackupEngine for non-iOS or if native upload yielded nothing
    if (uploaded === 0) {
      try {
        const { getBackupEngine } = require('./backupEngine');
        const engine = getBackupEngine();
        await engine.init();
        const result = await engine.runFullBackup({
          includeVideos: settings.includeVideos,
          quality: settings.quality || 'economy',
        });
        uploaded = result?.uploaded || 0;
      } catch (e) { console.warn('[AutoBackup] Error in engine fallback:', e.message); }
    }

    if (uploaded > 0) {
      await setLastSync(new Date().toISOString());
      return BackgroundFetch.BackgroundFetchResult.NewData;
    }
    return BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (e) {
    console.warn('[AutoBackup] Error in background task:', e.message);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// ============================================================
// FOREGROUND BACKUP
// ============================================================
/**
 * Start a foreground backup of all device photos.
 * Uses NativeUpload on iOS if available, otherwise BackupEngine.
 *
 * @param {Function} onProgress - Called with { current, total }
 * @returns {Promise<{ uploaded: number, total: number }>}
 */
export async function startForegroundBackup(onProgress) {
  if (Platform.OS === 'web') return { uploaded: 0, total: 0, error: 'web_unsupported' };

  // If already running, request stop and wait
  if (isLocked()) {
    requestStop();
    const waitStart = Date.now();
    while (isLocked() && Date.now() - waitStart < 5000) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (isLocked()) {
      // Force release stale lock (probably from a crashed previous run)
      console.warn('[AutoBackup] Force releasing stale lock');
      releaseLock();
    }
  }

  if (!acquireLock('foreground')) return { uploaded: 0, total: 0, error: 'lock_contention' };

  progressCallback = onProgress || null;

  try {
    const settings = await getSettings();

    // WiFi check — only for auto/background backup, NOT foreground (user pressed button)
    // Foreground backup always proceeds regardless of network type

    const ML = require('expo-media-library');
    const { status } = await ML.getPermissionsAsync();
    if (status !== 'granted') {
      releaseLock();
      return { uploaded: 0, total: 0, error: 'permission_denied' };
    }

    // ===== PATH A: NATIVE MODULE (iOS) — DISABLED: uses slow /upload-photo =====
    // Now using Path B (BackupEngine JS) for ALL platforms — presigned direct to R2, 5 parallel
    if (false && NativeUpload?.startNativeBackup && Platform.OS === 'ios') {
      console.log(`[backup] Starting NATIVE backup (Swift handles everything)`);
      const serverUrl = api.BASE_URL + '/api/email.php';
      const authToken = api.getAuthToken() || '';
      let uploaded = 0;
      let done = 0;

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

      if (uploaded > 0) await setLastSync(new Date().toISOString());
      releaseLock();
      progressCallback = null;
      return { uploaded, total: done };
    }

    // ===== PATH B: BackupEngine (Android + iOS without native module) =====
    const { getBackupEngine } = require('./backupEngine');
    const engine = getBackupEngine();
    await engine.init();

    // Wire up progress callback to translate engine progress format
    const result = await engine.runFullBackup({
      includeVideos: settings.includeVideos,
      quality: settings.quality || 'economy',
      onProgress: (progress) => {
        if (progressCallback) {
          try {
            progressCallback({
              current: progress.completedFiles + progress.failedFiles,
              total: progress.totalFiles,
            });
          } catch {}
        }
      },
    });

    const uploaded = result?.uploaded || result?.completedFiles || 0;
    const totalBackedUp = result?.totalBackedUp || 0;

    if (uploaded > 0) await setLastSync(new Date().toISOString());

    releaseLock();
    progressCallback = null;
    console.log(`[backup] Foreground complete: ${uploaded} uploaded`);
    return {
      uploaded,
      total: result?.totalFiles || 0,
      backedUpCount: totalBackedUp,
    };
  } catch (err) {
    releaseLock();
    progressCallback = null;
    return { uploaded: 0, total: 0, error: err?.message || 'unknown' };
  }
}

/**
 * Pause the current foreground backup.
 */
export function pause() {
  requestStop();
}

/**
 * Check if backup is currently running.
 */
export function getIsRunning() {
  return isLocked();
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
            // New photos detected - trigger a backup via the engine
            if (!isLocked()) {
              startForegroundBackup(null).catch((e) => {
                console.warn('[AutoBackup] Error in media listener backup:', e.message);
              });
            }
          }
        });
      } catch (e) { console.warn('[AutoBackup] Error setting up media listener:', e.message); }
    })();
  } catch (e) { console.warn('[AutoBackup] Error requiring media library:', e.message); }
}

// ============================================================
// APP STATE LISTENER (foreground check) — with 5 minute cooldown
// ============================================================
function setupAppStateListener() {
  if (appStateSubscription) return;

  appStateSubscription = AppState.addEventListener('change', async (state) => {
    if (state === 'active') {
      const now = Date.now();
      if (now - lastAppStateBackupTime < APP_STATE_COOLDOWN) return;
      lastAppStateBackupTime = now;

      setTimeout(() => {
        if (!isLocked()) startForegroundBackup(null).catch((e) => {
          console.warn('[AutoBackup] Error starting foreground backup on app active:', e.message);
        });
      }, 30000); // 30s delay — let chat/UI load first before starting photo backup
    } else if (state === 'background' && NativeUpload && Platform.OS === 'ios') {
      // App going to background - quickly enqueue a batch via native module
      console.log('[backup] Going to background - quick enqueue');
      try {
        const ML = require('expo-media-library');
        const { status } = await ML.getPermissionsAsync();
        if (status !== 'granted') return;
        const backedUpIds = await getBackedUpMap();
        const assets = await ML.getAssetsAsync({
          mediaType: [ML.MediaType.photo, ML.MediaType.video],
          first: 50, sortBy: [ML.SortBy.creationTime],
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
          console.log('[backup] Enqueued ' + pending.length + ' before background');
        }
      } catch (e) {
        console.warn('[backup] Background enqueue error:', e?.message);
      }
    }
  });
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
  } catch (e) { console.warn('[AutoBackup] Error registering background task:', e.message); }
}

async function unregisterBackgroundTask() {
  if (Platform.OS === 'web') return;
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    if (isRegistered) {
      await BackgroundFetch.unregisterTaskAsync(TASK_NAME);
    }
  } catch (e) { console.warn('[AutoBackup] Error unregistering background task:', e.message); }
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

  // Run unified migration first
  const { migrateBackupStateV2 } = require('./backup/backupStorage');
  await migrateBackupStateV2();

  const settings = await getSettings();

  // ALWAYS register background task (even if not enabled yet)
  // This way backup resumes in background if interrupted
  initialized = true;
  registerBackgroundTask().catch(() => {});
  setupMediaListener();
  setupAppStateListener();

  // Auto-enable backup if there are pending photos
  if (!settings.enabled) {
    try {
      const ML = require('expo-media-library');
      const { status } = await ML.getPermissionsAsync();
      if (status === 'granted') {
        const r = await ML.getAssetsAsync({ mediaType: [ML.MediaType.photo], first: 1 });
        const deviceTotal = r?.totalCount || 0;
        const apiRes = await api.filePhotos('all', 1, 1).catch(() => null);
        const backedUp = apiRes?.data?.total || 0;
        if (deviceTotal > backedUp + 100) {
          // More than 100 photos not backed up — auto-enable
          console.log(`[backup] Auto-enabling: ${deviceTotal} on device, ${backedUp} backed up`);
          await saveSettings({ ...settings, enabled: true });
          settings.enabled = true;
        }
      }
    } catch {}
  }

  if (!settings.enabled) {
    console.log('[backup] Not enabled - background registered but not starting');
    return;
  }

  console.log('[backup] Initializing auto backup (foreground + background)');

  // Start immediately on app launch
  if (!isLocked()) {
    startForegroundBackup(null).catch((e) => console.warn('[backup] Foreground start error:', e?.message));
  }
}

/**
 * Stop all auto-backup listeners and unregister background task.
 */
export function stopAutoBackup() {
  requestStop();
  setTimeout(() => { if (isLocked()) releaseLock(); }, 3000);

  if (mediaSubscription) { mediaSubscription.remove(); mediaSubscription = null; }
  if (appStateSubscription) { appStateSubscription.remove(); appStateSubscription = null; }

  unregisterBackgroundTask().catch((e) => { console.warn('[AutoBackup] Error in unregisterBackgroundTask:', e.message); });
  initialized = false;
}

/**
 * Called when the backup setting changes (from photos.js toggle).
 */
export async function onBackupSettingChanged(enabled) {
  if (Platform.OS === 'web') return;

  if (enabled) {
    initialized = false;
    if (isLocked()) {
      requestStop();
      const waitStart = Date.now();
      while (isLocked() && Date.now() - waitStart < 3000) {
        await new Promise(r => setTimeout(r, 200));
      }
      if (isLocked()) releaseLock();
    }
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
    const backedUpIds = await getBackedUpMap();
    const assets = await ML.getAssetsAsync({
      mediaType: [ML.MediaType.photo, ML.MediaType.video],
      first: 200, sortBy: [ML.SortBy.creationTime],
    });
    return (assets?.assets || []).filter(a => !backedUpIds[a.id]).length;
  } catch (e) {
    console.warn('[AutoBackup] Error getting pending count:', e.message);
    return 0;
  }
}

/**
 * Get the total number of backed up photos.
 */
export async function getBackedUpCount() {
  const ids = await getBackedUpMap();
  return Object.keys(ids).length;
}

/**
 * Reset backup history (re-upload everything).
 */
export async function resetBackupHistory() {
  const { clearBackedUpMap } = require('./backup/backupStorage');
  await clearBackedUpMap();
}
