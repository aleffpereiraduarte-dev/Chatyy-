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
  markAssetBackedUp, setLastSync, KEYS, isBackupKilled,
  isBackupNotificationsEnabled,
} from './backup/backupStorage';
import * as uploadNotification from './uploadNotification';

// Notification id used for the persistent ongoing backup progress
// notification. Same id is reused across progress ticks so the OS
// replaces the previous row in place (Android setOngoing + setProgress).
const BACKUP_NOTIF_ID = 'chatyy_photo_backup';

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
// 30min cooldown: 30s causava notif "Backup do Chatyy" toda vez que user
// minimizava+abria o app (loop infinito reportado 2026-05-18). BGTaskScheduler
// nativo já cobre wake-ups periódicos pra completar uploads pendentes.
const APP_STATE_COOLDOWN = 30 * 60 * 1000;

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
// Tracks whether startNativeBackup is in flight. The JS `lockState` only
// covers code paths that go through acquireLock/releaseLock; the AppState
// background handler used to call startNativeBackup directly without taking
// the lock, so two native sessions could run simultaneously (every photo
// uploaded twice, R2 bills double, server saw duplicate filenames). We
// gate every entry point on this flag.
let _nativeIsRunning = false;
function nativeRunningSet(v) { _nativeIsRunning = !!v; }
function isNativeRunning() { return _nativeIsRunning; }

// Lock with timestamp + auto-expiry. Bare string lock left stuck whenever a
// JS error escaped the upload loop — every subsequent backup attempt was
// blocked until app restart. 30 min expiry = "if a backup hasn't made any
// progress in 30 min something hung, take the lock."
let lockAcquiredAt = 0;
const LOCK_EXPIRY_MS = 30 * 60 * 1000;
function acquireLock(requestedState) {
  if (lockState === 'idle' || (Date.now() - lockAcquiredAt) > LOCK_EXPIRY_MS) {
    lockState = requestedState;
    lockAcquiredAt = Date.now();
    return true;
  }
  return false;
}
function releaseLock() { lockState = 'idle'; lockAcquiredAt = 0; }
function requestStop() { if (lockState !== 'idle') lockState = 'stopping'; }
function isStopping() { return lockState === 'stopping'; }
function isLocked() { return lockState !== 'idle'; }
function lockHeartbeat() { if (lockState !== 'idle') lockAcquiredAt = Date.now(); }

// Persist current auth into UserDefaults so the iOS BGTaskScheduler handler
// (which runs after the app is fully closed, with no JS) can authenticate.
// Safe to call any time; no-op without a token. Exported so login flows can
// refresh creds the moment a new token lands.
export function persistBackupCreds() {
  if (Platform.OS !== 'ios' || !NativeUpload?.setBackupCreds) return false;
  try {
    const serverUrl = api.BASE_URL;
    const authToken = api.getAuthToken?.() || '';
    const userEmail = (api.getSavedEmail && api.getSavedEmail()) || '';
    if (!authToken || !userEmail) return false;
    NativeUpload.setBackupCreds(serverUrl, authToken, userEmail);
    return true;
  } catch (e) {
    console.warn('[backup] persistBackupCreds failed:', e?.message);
    return false;
  }
}

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
    // Killswitch (2026-05-18): if the user / backend flipped it on, bail
    // out before doing any IO or scheduling. Killswitch is the only
    // reliable circuit-breaker for the phantom "Backup do Chatyy" banner.
    if (await isBackupKilled()) return BackgroundFetch.BackgroundFetchResult.NoData;
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
                            // Tag media kind (Live / Burst / Slo-mo / Time-lapse / RAW)
                            // so the viewer can render with motion / playback hints.
                            // Cheap: `info` is already fetched a few lines above; we
                            // just pass it through detectMediaKind. Fire-and-forget so
                            // the upload loop isn't gated on the tiny extra RTT.
                            try {
                              const { detectMediaKind, persistMediaKind } = require('./mediaKind');
                              const kind = detectMediaKind(info, { name: assetFilename(chunk[idx]), mimeType: assetMime(chunk[idx]) });
                              persistMediaKind(api, batchResult.data.uploads[idx].file_id, kind);
                            } catch {}
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
export async function startForegroundBackup(onProgress, options = {}) {
  const userInitiated = !!options.userInitiated;
  try {
    const { backupDebug } = require('./backupEngine');
    backupDebug('autoBackup.foreground.start', { platform: Platform.OS, locked: isLocked(), userInitiated });
  } catch {}
  if (Platform.OS === 'web') return { uploaded: 0, total: 0, error: 'web_unsupported' };

  // Killswitch (2026-05-18): backend / settings can disable backup remotely
  // when the phantom-progress banner pathology happens. Checked on every
  // entry — boot fire, MediaLibrary listener, AppState change, photos.js
  // button, BG task — so flipping the flag stops every code path at once.
  try {
    if (await isBackupKilled()) {
      console.log('[backup] startForegroundBackup: killswitch ON — bailing');
      return { uploaded: 0, total: 0, error: 'killswitch' };
    }
  } catch {}

  // Pre-flight pending count gate (2026-05-18). The boot fire in initAutoBackup
  // already does this, but every OTHER entry point (MediaLibrary listener
  // burst, AppState resume, internal restart) used to call straight into
  // native, and native emits onProgress for dedup-only passes which paints
  // the "X de Y (0%)" notification even when zero new bytes need to go to
  // R2. Skip the whole engine launch when nothing is pending. Pass
  // { userInitiated: true } from photos.js / forceStartBackup to bypass
  // this — the user explicitly asked for a backup, we should run even if
  // we believe everything is done (their belief may be stale).
  if (!userInitiated) {
    try {
      const pending = await getPendingCount();
      if (pending === 0) {
        console.log('[backup] startForegroundBackup: 0 pending — skipping (auto entry)');
        return { uploaded: 0, total: 0, skipped: 'no_pending' };
      }
    } catch {}
  }

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

  // Wrap the caller's progress callback so we ALSO drive the persistent
  // ongoing notification on every tick. Cheap — the wrapper is created once
  // per backup session and reused across all native/engine emit events.
  //
  // BUG FIX (2026-05-18): we used to fire the "Backup do Chatyy" sticky
  // notification BEFORE we even knew anything would be uploaded — so every
  // app cold-start auto-fired one even when 100% of photos were already
  // backed up (the user reported it as "toda vez que abre o app aparece um
  // novo backup do chatyy"). Now we lazily create the notification only
  // once we see a real progress tick with at least 1 pending item.
  const _userProgressCb = onProgress || null;
  let _notifStarted = false;
  // 2026-05-18: notification now requires confirmation from onComplete that
  // we actually transferred at least one FRESH (non-deduped) file to R2.
  // The native `onProgress` event fires on every successful asset including
  // pure dedups (the Swift module increments `uploaded` for every chunked
  // upload return value, and chunkedUploadAsset returns true for dedup short-
  // circuit hits). Without this gate, a library that's 100% already on the
  // server still paints "35 de 45597 (0%)" while it churns through precheck.
  // The flag below is flipped by the onComplete listener (further down).
  let _hasFreshUpload = false;
  function _onFreshUpload() { _hasFreshUpload = true; }

  // 2026-05-18: user-facing OFF switch for backup notifications. Read once
  // up-front and cache in the closure so the per-tick progressCallback
  // (called from native event listener, must be sync) can consult it
  // without awaiting AsyncStorage every tick. The flag also gates the
  // final complete()/fail() notifications below.
  let _notifAllowed = true;
  try {
    _notifAllowed = await isBackupNotificationsEnabled();
  } catch {}

  progressCallback = (p) => {
    try {
      const cur = p?.current || 0;
      const tot = p?.total || 0;
      // Honor the user's "Notificações de backup" toggle. When OFF we
      // never paint the sticky banner at all (no start, no update, no
      // complete). The progress callback still relays to _userProgressCb
      // so the in-app UI keeps updating in real time.
      if (!_notifAllowed) {
        if (_userProgressCb) {
          try { _userProgressCb(p); } catch {}
        }
        return;
      }
      // Only show the sticky notification when we've SEEN at least one real
      // (non-dedup) upload land. Pure-dedup passes never paint anything.
      if (!_notifStarted && tot > 0 && _hasFreshUpload) {
        _notifStarted = true;
        uploadNotification.start({
          id: BACKUP_NOTIF_ID,
          title: 'Backup do Chatyy',
          total: tot,
          onCancel: () => { requestStop(); },
        }).catch(() => {});
      }
      if (_notifStarted) {
        uploadNotification.update(BACKUP_NOTIF_ID, { current: cur, total: tot });
      }
    } catch {}
    if (_userProgressCb) {
      try { _userProgressCb(p); } catch {}
    }
  };
  // Expose the notif-started flag on the closure so the completion / failure
  // paths below can skip uploadNotification.complete() when we never showed
  // anything (otherwise expo-notifications fires a "Backup done" toast for a
  // notification that was never visible).
  progressCallback.__wasShown = () => _notifStarted;

  // Refresh BG creds — ensures the next BGTaskScheduler wake-up has a fresh
  // token, even if the user never opens the Photos screen explicitly.
  persistBackupCreds();

  try {
    const settings = await getSettings();

    // WiFi check — only for auto/background backup, NOT foreground (user pressed button)
    // Foreground backup always proceeds regardless of network type

    const ML = require('expo-media-library');
    const { status } = await ML.getPermissionsAsync();
    if (status !== 'granted') {
      // No need to surface a fail notification — we never showed the sticky
      // start notif yet (gated on first non-zero progress tick), and firing
      // "Falha no envio" when the user simply hasn't granted Photos access
      // is misleading.
      releaseLock();
      progressCallback = null;
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
        // INTENTIONALLY do NOT seed unionSet from the local map.
        //
        // The local backedUpMap can be poisoned: a previous upload session
        // marked an asset as "backed up" locally before the server-side row
        // was confirmed (network blip, register-step 5xx, app killed mid-
        // flight). Those phantom entries accumulate over time. With ~14k
        // poisoned IDs in the map, unionSet ends up containing every device
        // asset → setBackedUpIds(union) → native skips everything → zero
        // uploads despite the user clearly having pending photos.
        //
        // Server is the only source of truth (drive_files rows, matched by
        // md5(asset_id) tag). A fresh server precheck below rebuilds the
        // set. The local map remains useful as an in-memory dedup during
        // a single backup pass (saves repeated precheck on the same asset),
        // but it never claims authority over the server.
        const unionSet = new Set();

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
      //
      // Previously this read+serialize+write the entire map on EVERY native
      // completion event. With 40k photos and a growing map, each write was
      // O(n) JSON.stringify so the run cost was O(n²) — ~3 minutes of pure
      // AsyncStorage IO across the session, and the writes blocked the
      // JS thread enough to starve the progress callback. Now we accumulate
      // IDs in `_pendingMarks` and flush in a debounced batch every 1s.
      let _pendingMarks = [];
      let _flushTimer = null;
      const _flushPendingMarks = async () => {
        const batch = _pendingMarks;
        _pendingMarks = [];
        _flushTimer = null;
        if (batch.length === 0) return;
        try {
          const map = await getBackedUpMap();
          const now = Date.now();
          let changed = 0;
          for (const id of batch) {
            if (!map[id]) { map[id] = now; changed++; }
          }
          if (changed > 0) await saveBackedUpMap(map);
        } catch {}
      };
      const completeSub = NativeUpload.addListener('onComplete', (event) => {
        if (event?.success && event?.assetId) {
          _pendingMarks.push(event.assetId);
          if (!_flushTimer) {
            _flushTimer = setTimeout(_flushPendingMarks, 1000);
          }
          // 2026-05-18: flip the fresh-upload flag the first time we see
          // a NON-deduped completion. The progressCallback above gates the
          // sticky notification on this so dedup-only passes (where the
          // server already has every file via content_hash precheck or
          // drive_init_upload short-circuit) stay silent. The Swift module
          // sets `deduped:true` on the event payload for both the rust
          // precheck hit and the drive_init_upload `deduped:true` branch.
          if (event.deduped !== true) {
            try { _onFreshUpload(); } catch {}
          }
        }
      });
      // Stash the flusher on the sub so the outer cleanup can drain residual
      // marks before the listener detaches (otherwise the last <1s of
      // completions never make it into the map).
      completeSub._drain = _flushPendingMarks;

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
          // Loop while there are still pending photos. iOS cuts the background
          // task to 30s–4min, so a single call of startNativeBackup typically
          // uploads ~50–300 photos then returns with `stopped: true`. Previously
          // we stopped there and relied on an AppState change to retry — with a
          // 2-minute cooldown — which is what left backups frozen at partial
          // counts. Now we call it again immediately.
          //
          // IMPORTANT: do NOT gate on `AppState.currentState === 'active'`.
          // The native module uses URLSession.background + beginBackgroundTask,
          // so iOS keeps uploading for 30s–4min after the app backgrounds. If
          // we exit the JS loop the moment AppState flips, we abandon that
          // background grace window — the in-flight pass finishes, fires the
          // "X fotos enviadas" push, then nothing else gets enqueued.
          // Keeping the loop running lets us spin again during the bg grace
          // window. When iOS finally suspends the JS runtime, the awaiting
          // promise pauses naturally; when the BGTaskScheduler (registered in
          // the native module) wakes us later, it picks up from the same
          // backed-up set in UserDefaults.
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
          while (spins++ < 30 && !_stopFlag) {
            if (isNativeRunning()) {
              // Another entry point (AppState bg handler, BG task) is already
              // driving a native pass — yield instead of stacking calls.
              console.log('[backup] foreground loop: native already running, breaking');
              break;
            }
            nativeRunningSet(true);
            let r;
            try {
              r = await NativeUpload.startNativeBackup(serverUrl, authToken, userEmail);
            } finally {
              nativeRunningSet(false);
            }
            const passUploaded = r?.uploaded || 0;
            const passTotal = r?.total || 0;
            const stopped = !!r?.stopped;
            totalUploadedThisSession += passUploaded;
            lastTotal = passTotal;
            try { require('./backupEngine').backupDebug('native.pass', { spins, passUploaded, passTotal, stopped, err: r?.error || '', appState: AppState.currentState }); } catch {}
            console.log(`[backup] native pass ${spins}: uploaded=${passUploaded} total=${passTotal} stopped=${stopped} state=${AppState.currentState}`);
            // If nothing uploaded this pass (all done, or stuck) — exit.
            if (passUploaded === 0) break;
            // If iOS told the native side to stop (bg time expired) AND we're
            // backgrounded, bail out — the next BGTaskScheduler wake-up (which
            // the native module already scheduled) will pick it up. Spinning
            // further would just hot-loop until JS gets killed.
            if (stopped && AppState.currentState !== 'active') {
              console.log('[backup] native stopped + backgrounded — yielding to BGTaskScheduler');
              break;
            }
            // Tiny yield so the main thread breathes between passes.
            await new Promise(r => setTimeout(r, 200));
          }
          uploaded = totalUploadedThisSession;
          done = lastTotal;
          console.log(`[backup] native backup session total: uploaded=${uploaded} total=${done} spins=${spins - 1}`);
          progressSub?.remove?.();
          // Drain any pending batched writes before detaching the listener,
          // otherwise the last burst of completions is lost.
          try { await completeSub?._drain?.(); } catch {}
          completeSub?.remove?.();
          if (uploaded > 0) await setLastSync(new Date().toISOString());
          const _showCompleteNotif = !!progressCallback?.__wasShown?.();
          releaseLock();
          progressCallback = null;
          // Only surface the "Backup completo" toast when the sticky notif
          // was actually shown (i.e. there was something to back up).
          if (_showCompleteNotif) {
            try { await uploadNotification.complete(BACKUP_NOTIF_ID, { successCount: uploaded, total: done }); } catch {}
          }
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
      try { await completeSub?._drain?.(); } catch {}
      completeSub?.remove();

      if (uploaded > 0) await setLastSync(new Date().toISOString());
      const _showCompleteNotif = !!progressCallback?.__wasShown?.();
      releaseLock();
      progressCallback = null;
      if (_showCompleteNotif) {
        try { await uploadNotification.complete(BACKUP_NOTIF_ID, { successCount: uploaded, total: done }); } catch {}
      }
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

    const _showCompleteNotif = !!progressCallback?.__wasShown?.();
    releaseLock();
    progressCallback = null;
    if (_showCompleteNotif) {
      try {
        await uploadNotification.complete(BACKUP_NOTIF_ID, {
          successCount: uploaded,
          total: result?.totalFiles || uploaded,
        });
      } catch {}
    }
    console.log(`[backup] Foreground complete: ${uploaded} uploaded`);
    return {
      uploaded,
      total: result?.totalFiles || 0,
      backedUpCount: totalBackedUp,
    };
  } catch (err) {
    const _showFailNotif = !!progressCallback?.__wasShown?.();
    releaseLock();
    progressCallback = null;
    if (_showFailNotif) {
      try { await uploadNotification.fail(BACKUP_NOTIF_ID, { errorMessage: err?.message || 'Falha no envio' }); } catch {}
    }
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
  // userInitiated=true → bypass the 0-pending guard. The user explicitly
  // asked for a backup; even if our local accounting says nothing's
  // pending, run the full pass so the server-side precheck reconciles.
  return startForegroundBackup(onProgress, { userInitiated: true });
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

        // Debounce so a burst of new photos from the camera doesn't trigger
        // dozens of concurrent backup starts (each one was racing for the
        // same lock and dropping silently).
        let mlDebounceTimer = null;
        let mlLastTrigger = 0;
        // 10min gap: bursts (200 screenshots, live photo, iCloud thumb downloads)
        // antes disparavam 200 starts em fila, todos perdendo o lock e mostrando
        // notif "Backup do Chatyy" duplicada. 10min é o ritmo natural de uso.
        const MIN_GAP_MS = 10 * 60 * 1000;
        mediaSubscription = ML.addListener((event) => {
          if (!event.hasIncrementalChanges) return;
          if (isLocked()) return;
          if (mlDebounceTimer) clearTimeout(mlDebounceTimer);
          mlDebounceTimer = setTimeout(() => {
            const now = Date.now();
            if (now - mlLastTrigger < MIN_GAP_MS) return;
            mlLastTrigger = now;
            startForegroundBackup(null).catch((e) => {
              console.warn('[AutoBackup] Error in media listener backup:', e.message);
            });
          }, 1500);
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
      // Refresh creds on every foreground entry so the BG task always has
      // a non-stale auth token waiting in UserDefaults.
      persistBackupCreds();
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
      // App going to background.
      //
      // If a native backup is already running (startNativeBackup spinning),
      // do NOTHING — the native module already has its own beginBackgroundTask
      // window and URLSession.background will keep uploading after the app
      // suspends. Enqueuing a separate legacy uploadBatch here races against
      // the active session and burns the bg-time budget on duplicate work.
      //
      // If no backup is running but settings.enabled is true, refresh creds so
      // the BGTaskScheduler wake-up (registered natively, fires every ~15min
      // refresh / ~1h processing) has fresh auth to do its slice. We do NOT
      // try to start a new foreground backup here — iOS will refuse and the
      // JS task will get suspended in ~5s anyway.
      try {
        persistBackupCreds();
        // Killswitch (2026-05-18): bail before kicking a fresh background
        // native pass. Without this the BG-fire path stays a hot entry
        // point even when we're trying to halt everything.
        if (await isBackupKilled()) {
          console.log('[backup] backgrounded — killswitch ON, no bg fire');
          return;
        }
        // _nativeIsRunning is the authoritative "JS already launched a
        // startNativeBackup that hasn't returned yet" flag. isLocked() only
        // catches the JS lockState which the bg handler bypassed before,
        // letting two native passes race. Check BOTH.
        if (isLocked() || isNativeRunning()) {
          console.log('[backup] backgrounded with active native session — letting it continue');
          return;
        }
        const settings = await getSettings();
        if (!settings.enabled) return;
        // Skip if nothing pending — avoid spinning native through a full
        // PHAsset dedup pass just to fire an empty progress callback.
        try {
          const pending = await getPendingCount();
          if (pending === 0) {
            console.log('[backup] backgrounded — 0 pending, no bg fire');
            return;
          }
        } catch {}
        // No active session — kick off one native pass so the bg-time window
        // (30s–4min via beginBackgroundTask) gets used to upload something
        // before iOS suspends the JS runtime. startNativeBackup acquires its
        // own state lock natively, but the JS-side _nativeIsRunning flag
        // prevents a foreground entry from launching a parallel call.
        console.log('[backup] backgrounded with no active session — firing one native pass');
        const serverUrl = api.BASE_URL;
        const authToken = api.getAuthToken?.() || '';
        const userEmail = (api.getSavedEmail && api.getSavedEmail()) || '';
        if (!authToken || !userEmail) return;
        if (typeof NativeUpload.startNativeBackup === 'function') {
          // Fire-and-forget — we can't await here because the JS event loop
          // is about to get suspended. Mark the running flag so any
          // foreground entry that races a wake-up sees it. We DON'T await,
          // but we set + clear via .then/.catch so the flag eventually
          // releases when the native side returns.
          nativeRunningSet(true);
          NativeUpload.startNativeBackup(serverUrl, authToken, userEmail)
            .then(() => { nativeRunningSet(false); })
            .catch((e) => {
              nativeRunningSet(false);
              console.warn('[backup] background-fire startNativeBackup error:', e?.message);
            });
        }
      } catch (e) {
        console.warn('[backup] Background handler error:', e?.message);
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

  // 2026-05-18: sync the JS-side "Notificações de backup" toggle into the
  // native iOS module on boot. Without this, on a fresh launch the native
  // UserDefaults flag could go stale (e.g. user turned it OFF, app got
  // killed, BG task ran with the old flag). Reading from AsyncStorage and
  // mirroring into UserDefaults at every init guarantees both halves
  // agree before any backup entry point fires.
  try {
    const allowed = await isBackupNotificationsEnabled();
    if (Platform.OS === 'ios' && NativeUpload?.setBackupNotificationsEnabled) {
      NativeUpload.setBackupNotificationsEnabled(!!allowed);
    }
  } catch {}

  // Killswitch (2026-05-18): if active, skip ALL registration so neither
  // the BG TaskManager fetch task nor the AppState / MediaLibrary
  // listeners get installed. This is the cleanest way to halt every
  // backup-related side effect for a session.
  try {
    if (await isBackupKilled()) {
      console.log('[backup] initAutoBackup: killswitch ON — skipping all registration');
      initialized = true;
      return;
    }
  } catch {}

  const settings = await getSettings();

  // ALWAYS register background task (even if not enabled yet)
  // This way backup resumes in background if interrupted
  initialized = true;
  registerBackgroundTask().catch(() => {});
  setupMediaListener();
  setupAppStateListener();

  // Persist creds early — even when backup is currently disabled, we still
  // want UserDefaults populated so the BG task can run after the user toggles
  // backup on later (or after the auto-enable below flips it).
  persistBackupCreds();

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

  // Refresh creds again now that we know backup is actually enabled — if a
  // token rotated since the early call above, this catches it.
  persistBackupCreds();

  // Start immediately on app launch — BUT só se realmente tem foto pendente.
  // Antes (sem esse guard), cada cold start disparava startForegroundBackup
  // que mostrava notif "Backup do Chatyy" mesmo com 0 pending → user via
  // notif chata toda vez que abria o app.
  if (!isLocked()) {
    try {
      const pending = await getPendingCount().catch(() => 0);
      if (pending > 0) {
        startForegroundBackup(null).catch((e) => console.warn('[backup] Foreground start error:', e?.message));
      } else {
        console.log('[backup] Skipping boot fire — 0 pending photos');
      }
    } catch {
      // If pending check fails, fall back to old behavior
      startForegroundBackup(null).catch((e) => console.warn('[backup] Foreground start error:', e?.message));
    }
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
 *
 * Was using `first: 200` which truncated the calculation: a 40k-photo library
 * still returned at most 200 even when zero were backed up, so the UI showed
 * "200 pending" forever. We now use the cheap `totalCount` from MediaLibrary
 * (PHAsset count is in-memory, ~1ms) minus the size of the backed-up map.
 * That's an upper bound (the map may contain stale IDs for deleted assets)
 * but it never under-reports the real pending count.
 */
export async function getPendingCount() {
  if (Platform.OS === 'web') return 0;
  try {
    const ML = require('expo-media-library');
    const { status } = await ML.getPermissionsAsync();
    if (status !== 'granted') return 0;
    const backedUpIds = await getBackedUpMap();
    // `first: 1` is enough — we only need totalCount, not the asset list.
    const probe = await ML.getAssetsAsync({
      mediaType: [ML.MediaType.photo, ML.MediaType.video],
      first: 1,
      sortBy: [ML.SortBy.creationTime],
    });
    const deviceTotal = probe?.totalCount || 0;
    const backedUpSize = Object.keys(backedUpIds || {}).length;
    return Math.max(0, deviceTotal - backedUpSize);
  } catch (e) {
    console.warn('[AutoBackup] Error getting pending count:', e.message);
    return 0;
  }
}

/**
 * Get the total number of backed up photos.
 *
 * Local AsyncStorage map is unreliable as authority — it can accumulate
 * phantom IDs (asset marked locally before server confirmed, never cleaned
 * up). The server's `drive_backup_count` is the actual row count in
 * drive_files for this user and is the only trustworthy source. We cache
 * the server response for 30s so the UI can call this on every render
 * without flooding the backend.
 */
let _serverCountCache = { value: 0, ts: 0 };
const SERVER_COUNT_CACHE_MS = 30 * 1000;
export async function getBackedUpCount() {
  const now = Date.now();
  if (_serverCountCache.ts && now - _serverCountCache.ts < SERVER_COUNT_CACHE_MS) {
    return _serverCountCache.value;
  }
  try {
    const r = await api.apiCall('drive_backup_count');
    const serverCount = r?.data?.count || r?.data?.total || 0;
    if (serverCount > 0) {
      _serverCountCache = { value: serverCount, ts: now };
      return serverCount;
    }
  } catch {}
  // Server unreachable — fall back to the local map (still better than 0).
  try {
    const ids = await getBackedUpMap();
    return Object.keys(ids).length;
  } catch {
    return _serverCountCache.value || 0;
  }
}

/**
 * Reset backup history (re-upload everything).
 */
export async function resetBackupHistory() {
  const { clearBackedUpMap } = require('./backup/backupStorage');
  await clearBackedUpMap();
}
