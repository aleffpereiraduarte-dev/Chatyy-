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
const APP_STATE_COOLDOWN = 30 * 1000; // 30s cooldown — iOS kills background often, user expects backup to resume fast on every foreground

// ============================================================
// MODULE STATE
// ============================================================
let lockState = 'idle'; // 'idle' | 'foreground' | 'batch' | 'stopping'
let progressCallback = null;
let mediaSubscription = null;
let appStateSubscription = null;
let initialized = false;
let lastAppStateBackupTime = 0;
let _stopFlag = false;

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
  try {
    const { backupDebug } = require('./backupEngine');
    backupDebug('autoBackup.foreground.start', { platform: Platform.OS, locked: isLocked() });
  } catch {}
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

    // ===== PATH A: NATIVE iOS MODULE — Swift Google-Photos-style chunked upload =====
    // The Swift module talks directly to the Rust 9103 service via init/chunk/complete,
    // then calls drive_register_uploaded to create the DB row. Chunks are 4MB and each
    // request finishes in 1-3s — never hits the 60s nginx body timeout that killed
    // the previous single-shot multipart approach.
    if (NativeUpload?.startNativeBackup && Platform.OS === 'ios') {
      console.log(`[backup] Starting NATIVE backup (Swift chunked → Rust)`);
      const serverUrl = api.BASE_URL; // origin only — Swift appends the paths
      const authToken = api.getAuthToken() || '';
      const userEmail = (api.getSavedEmail && api.getSavedEmail()) || '';
      let uploaded = 0;
      let done = 0;

      // SYNC: tell the native module which asset.ids are already backed up.
      // Two sources:
      //   1. Local JS engine's backedUpIds map (previous sessions)
      //   2. Server-side batch precheck — ask the server which of OUR current
      //      device assets are already in drive_files (by md5(asset_id) filename
      //      tag). Without this, a fresh install re-dedupes 40k+ photos one-by-
      //      one at ~2/sec = hours of idle precheck traffic.
      try {
        const backedUpMap = await getBackedUpMap();
        const unionSet = new Set(Object.keys(backedUpMap || {}));

        // Pull ALL device asset ids once (fast, PHAsset fetch is in-memory)
        let deviceIds = [];
        try {
          const ML = require('expo-media-library');
          // Walk cursor — MediaLibrary.getAssetsAsync returns 10k per page typically
          let cursor = null, remaining = 60000, pages = 0;
          while (remaining > 0 && pages < 12) {
            pages++;
            const page = await ML.getAssetsAsync({
              first: Math.min(5000, remaining),
              after: cursor || undefined,
              mediaType: ['photo', 'video'],
              sortBy: ML.SortBy.creationTime,
            });
            if (!page?.assets?.length) break;
            for (const a of page.assets) deviceIds.push(a.id);
            if (!page.hasNextPage || !page.endCursor) break;
            cursor = page.endCursor;
            remaining -= page.assets.length;
          }
        } catch (e) { console.warn('[backup] device id scan failed:', e?.message); }

        // Batch server precheck: chunks of 1500 ids per call
        if (deviceIds.length > 0) {
          const CHUNK = 1500;
          for (let i = 0; i < deviceIds.length; i += CHUNK) {
            const slice = deviceIds.slice(i, i + CHUNK);
            try {
              const r = await api.apiCall('drive_precheck_asset_ids', { asset_ids: slice }, 'POST');
              const backedUp = r?.data?.backed_up || [];
              for (const id of backedUp) unionSet.add(id);
            } catch {}
          }
          console.log(`[backup] Batch precheck synced: ${unionSet.size} total IDs known (from ${deviceIds.length} device + ${Object.keys(backedUpMap || {}).length} cache)`);
        }

        const backedUpArray = Array.from(unionSet);
        if (backedUpArray.length > 0 && typeof NativeUpload.setBackedUpIds === 'function') {
          NativeUpload.setBackedUpIds(backedUpArray);
          console.log(`[backup] Synced ${backedUpArray.length} backed-up IDs to native module`);
        }

        // Persist union back to the local map so next run is already warm
        try {
          const newMap = { ...(backedUpMap || {}) };
          const now = Date.now();
          for (const id of backedUpArray) if (!newMap[id]) newMap[id] = now;
          await saveBackedUpMap(newMap);
        } catch {}
      } catch (e) {
        console.warn('[backup] Failed to sync backedUpIds to native:', e?.message);
      }

      const progressSub = NativeUpload.addListener('onProgress', (event) => {
        if (progressCallback) {
          try { progressCallback({ current: event.uploaded || 0, total: event.total || 0 }); } catch {}
        }
      });

      // Mirror native onComplete events back into JS backedUpIds map so the
      // JS engine fallback (and any UI code that reads from it) stays in sync.
      const completeSub = NativeUpload.addListener('onComplete', async (event) => {
        if (event?.success && event?.assetId) {
          try {
            const map = await getBackedUpMap();
            if (!map[event.assetId]) {
              map[event.assetId] = Date.now();
              await saveBackedUpMap(map);
            }
          } catch {}
        }
      });

      // Fully-native path: startNativeBackup (Swift) fetches the WHOLE
      // PHAsset library with no JS pagination, uses URLSessionConfiguration
      // .background (iOS keeps uploading up to 24h after the app is killed),
      // and posts progress events we already subscribed to above. This is
      // the same path Google Photos uses.
      //
      // Kept the uploadBatch fallback below for older binaries that don't
      // ship startNativeBackup.
      try {
        if (typeof NativeUpload.startNativeBackup === 'function') {
          console.log('[backup] calling startNativeBackup — full native path');
          // Loop while the app is in the foreground and there are still pending
          // photos. iOS cuts the background task to 30s–4min, so a single call
          // of startNativeBackup typically uploads ~50–300 photos then returns
          // with `stopped: true`. Previously we stopped there and relied on an
          // AppState change to retry — with a 2-minute cooldown — which is what
          // left backups frozen at partial counts. Now we just call it again
          // immediately, as long as the app is still active.
          let totalUploadedThisSession = 0;
          let lastTotal = 0;
          let spins = 0;
          // Hard cap so a pathological server-never-accepts loop can't hot-spin.
          // In practice one pass uploads ~200 photos so 30 spins = 6000 photos
          // per foreground session, more than any user needs before iOS
          // suspends the process.
          try {
            const { backupDebug, setBackupDebugEmail } = require('./backupEngine');
            setBackupDebugEmail(userEmail);
            backupDebug('native.pass.loop.enter', { userEmail });
          } catch {}
          while (spins++ < 30 && AppState.currentState === 'active' && !_stopFlag) {
            const r = await NativeUpload.startNativeBackup(serverUrl, authToken, userEmail);
            const passUploaded = r?.uploaded || 0;
            const passTotal = r?.total || 0;
            const stopped = !!r?.stopped;
            totalUploadedThisSession += passUploaded;
            lastTotal = passTotal;
            try { require('./backupEngine').backupDebug('native.pass', { spins, passUploaded, passTotal, stopped, err: r?.error || '' }); } catch {}
            console.log(`[backup] native pass ${spins}: uploaded=${passUploaded} total=${passTotal} stopped=${stopped}`);
            // If nothing uploaded this pass (all done, or stuck) — exit.
            if (passUploaded === 0) break;
            // Tiny yield so the main thread breathes between passes.
            await new Promise(r => setTimeout(r, 200));
          }
          uploaded = totalUploadedThisSession;
          done = lastTotal;
          console.log(`[backup] native backup session total: uploaded=${uploaded} total=${done} spins=${spins - 1}`);
          progressSub?.remove?.();
          completeSub?.remove?.();
          if (uploaded > 0) await setLastSync(new Date().toISOString());
          releaseLock();
          progressCallback = null;
          return { success: true, uploaded, total: done, nativeMode: true };
        }

        // ───── Legacy JS-orchestrated fallback (pre-native-backup builds) ─────
        const ML = require('expo-media-library');
        const { status } = await ML.getPermissionsAsync();
        if (status !== 'granted') { console.warn('[backup] permission missing'); throw new Error('permission_denied'); }

        const backedUpIds = await getBackedUpMap();
        // Paginated fetch across the WHOLE library, not just the first 2000.
        // With 26k+ photos the old `first: 2000` cap silently truncated the
        // queue — user saw the counter freeze at whatever chunk finished
        // because nothing else was ever enqueued.
        const PAGE = 1000;
        let allAssets = [];
        let after = undefined;
        let hasNext = true;
        let safety = 100; // 100 × 1000 = 100k assets — plenty of headroom
        while (hasNext && safety-- > 0) {
          const page = await ML.getAssetsAsync({
            mediaType: [ML.MediaType.photo, ML.MediaType.video],
            first: PAGE,
            after,
            sortBy: [ML.SortBy.creationTime],
          });
          const batch = page?.assets || [];
          if (batch.length === 0) break;
          allAssets = allAssets.concat(batch);
          hasNext = !!page.hasNextPage;
          after = page.endCursor || (batch[batch.length - 1]?.id);
          if (!after) break;
        }
        const allPending = allAssets.filter(a => !backedUpIds[a.id]);
        if (allPending.length === 0) {
          console.log('[backup] all done!');
        } else {
          console.log(`[backup] found ${allPending.length} pending, enqueuing in parallel batches of 50`);
        }

        const BATCH = 50;
        const PARALLEL = 3; // presign 3 batches simultaneously
        const enqueueOne = async (startIdx) => {
          const pending = allPending.slice(startIdx, startIdx + BATCH);
          if (pending.length === 0) return 0;
          const filesForBatch = pending.map(a => ({ name: assetFilename(a), mime: assetMime(a) }));
          const batchResult = await api.getPresignedBatch(filesForBatch);
          if (!batchResult?.success || !batchResult?.data?.uploads) {
            console.warn('[backup] presign failed:', batchResult?.message);
            return 0;
          }
          const requests = pending.map((asset, idx) => ({
            assetId: asset.id,
            presignedUrl: batchResult.data.uploads[idx].upload_url,
            mimeType: assetMime(asset),
            maxWidth: 0, maxHeight: 0,
          }));
          const r = await NativeUpload.uploadBatch(requests);
          return r?.queued || 0;
        };

        let idx = 0;
        let batchNum = 0;
        while (idx < allPending.length) {
          const slice = [];
          for (let k = 0; k < PARALLEL && idx < allPending.length; k++, idx += BATCH) {
            slice.push(enqueueOne(idx));
          }
          const results = await Promise.all(slice);
          const queued = results.reduce((a, b) => a + b, 0);
          uploaded += queued;
          batchNum += slice.length;
          done = idx;
          console.log(`[backup] ${batchNum} batches enqueued, ${idx}/${allPending.length} pending queued`);
          if (progressCallback) { try { progressCallback({ current: uploaded, total: allPending.length }); } catch {} }
        }
      } catch (err) {
        console.warn(`[backup] native backup error:`, err?.message);
      }

      progressSub?.remove();
      completeSub?.remove();

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
// Force a backup to start NOW, bypassing the cooldown.
// Used by a "Resume backup now" button when iOS killed the background session.
export async function forceStartBackup(onProgress) {
  lastAppStateBackupTime = 0;
  console.log('[AutoBackup] force-start requested');
  return startForegroundBackup(onProgress);
}

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
      if (now - lastAppStateBackupTime < APP_STATE_COOLDOWN) {
        console.log('[AutoBackup] app active but within cooldown — skip (waited '
          + Math.round((now - lastAppStateBackupTime)/1000) + 's, need ' + (APP_STATE_COOLDOWN/1000) + 's)');
        return;
      }
      lastAppStateBackupTime = now;
      console.log('[AutoBackup] app active — will start backup in 15s');

      setTimeout(() => {
        if (isLocked()) {
          console.log('[AutoBackup] skipped backup — app is locked');
          return;
        }
        startForegroundBackup(null).catch((e) => {
          console.warn('[AutoBackup] Error starting foreground backup on app active:', e.message);
        });
      }, 3000); // 3s delay — was 15s, cut tighter so backup resumes almost immediately after iOS kills the background session
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

  // Cache credentials into UserDefaults (iOS) so the native BGTaskScheduler
  // handler can upload even when the app is fully suspended and JS isn't
  // running. Mirrors Google Photos' behavior: "you can turn off your phone,
  // and backup keeps going when you're charging + on Wi-Fi".
  if (Platform.OS === 'ios' && NativeUpload?.setBackupCreds) {
    try {
      const serverUrl = api.BASE_URL;
      const authToken = api.getAuthToken?.() || '';
      const userEmail = (api.getSavedEmail && api.getSavedEmail()) || '';
      if (authToken && userEmail) {
        NativeUpload.setBackupCreds(serverUrl, authToken, userEmail);
      }
    } catch (e) { console.warn('[backup] setBackupCreds failed:', e?.message); }
  }

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
