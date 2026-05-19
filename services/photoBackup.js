/**
 * Chatyy Photo/Video Backup Service — BACKWARD COMPATIBILITY WRAPPER
 *
 * This module delegates all functionality to the unified backup system:
 * - services/backup/index.js (public API facade)
 * - services/backup/backupStorage.js (state management)
 * - services/backupEngine.js (upload engine)
 *
 * All exports maintain the same interface so existing callers
 * (photos.js, ChatProfileTab.js, etc.) work without changes.
 */
import { Platform, AppState } from 'react-native';

// ─── Web no-ops ──────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  enabled: false,
  wifiOnly: false,
  includeVideos: true,
};

const WEB_NOOP = {
  async requestPermissions() { return { granted: false, reason: 'web_unsupported' }; },
  async getPhotosToBackup() { return []; },
  async uploadAsset() { return { success: false, message: 'web_unsupported' }; },
  async runBackup() { return { uploaded: 0, failed: 0, skipped: 0 }; },
  async getBackupStats() { return { totalOnDevice: 0, backedUp: 0, remaining: 0, lastBackupDate: null }; },
  async clearBackupHistory() {},
  async registerBackgroundBackup() {},
  async unregisterBackgroundBackup() {},
  async isBackupEnabled() { return false; },
  async setBackupEnabled() {},
  async getBackupSettings() { return { ...DEFAULT_SETTINGS }; },
  async setBackupSettings() {},
};

// ─── Lazy load unified backup API ───────────────────────────
function getUnifiedAPI() {
  return require('./backup/index');
}

// ─── Exported functions (same interface as before) ──────────

export async function requestPermissions() {
  if (Platform.OS === 'web') return WEB_NOOP.requestPermissions();
  try {
    const MediaLibrary = require('expo-media-library');
    const { status } = await MediaLibrary.requestPermissionsAsync();
    // iOS aceita 'limited' (usuário escolheu álbuns específicos) — também
    // conta como granted para fins de backup.
    if (status === 'granted' || status === 'limited') return { granted: true };
    return { granted: false, reason: 'permission_denied' };
  } catch (err) {
    console.warn('[photoBackup] requestPermissions error:', err);
    return { granted: false, reason: 'module_unavailable' };
  }
}

export async function getPhotosToBackup(limit = 50) {
  if (Platform.OS === 'web') return [];
  try {
    const MediaLibrary = require('expo-media-library');
    const backup = getUnifiedAPI();
    const settings = await backup.getBackupSettings();
    const backedUpMap = await backup.getBackedUpMap();

    const mediaType = settings.includeVideos
      ? [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video]
      : [MediaLibrary.MediaType.photo];

    const needsBackup = [];
    let after = undefined;
    const PAGE_SIZE = 100;

    while (needsBackup.length < limit) {
      const page = await MediaLibrary.getAssetsAsync({
        first: PAGE_SIZE,
        after,
        mediaType,
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      if (!page.assets || page.assets.length === 0) break;
      for (const asset of page.assets) {
        if (!backedUpMap[asset.id]) {
          needsBackup.push(asset);
          if (needsBackup.length >= limit) break;
        }
      }
      if (!page.hasNextPage) break;
      after = page.endCursor;
    }
    return needsBackup;
  } catch (err) {
    console.warn('[photoBackup] getPhotosToBackup error:', err);
    return [];
  }
}

export async function uploadAsset(asset, attempt = 0) {
  if (Platform.OS === 'web') return WEB_NOOP.uploadAsset();
  // Delegate to engine — but maintain the simple return interface
  try {
    const backup = getUnifiedAPI();
    // Antes ignorava o asset passado e subia qualquer item da fila;
    // passar targetAssetIds garante que sobe exatamente o que o caller pediu.
    const opts = asset?.id ? { targetAssetIds: [asset.id], maxFiles: 1 } : { maxFiles: 1 };
    const result = await backup.runBackupNow(opts);
    return { success: (result?.uploaded || 0) > 0 };
  } catch (err) {
    return { success: false, message: err?.message || 'upload_error' };
  }
}

export async function runBackup(options = {}) {
  if (Platform.OS === 'web') return WEB_NOOP.runBackup();
  try {
    const backup = getUnifiedAPI();
    const result = await backup.runBackupNow({
      onProgress: options.onProgress,
    });
    return {
      uploaded: result?.uploaded || 0,
      failed: result?.failed || 0,
      skipped: result?.skipped || 0,
    };
  } catch (err) {
    console.warn('[photoBackup] runBackup error:', err);
    return { uploaded: 0, failed: 0, skipped: 0 };
  }
}

export async function getBackupStats() {
  if (Platform.OS === 'web') return WEB_NOOP.getBackupStats();
  try {
    const backup = getUnifiedAPI();
    return await backup.getBackupStats();
  } catch (err) {
    console.warn('[photoBackup] getBackupStats error:', err);
    return { totalOnDevice: 0, backedUp: 0, remaining: 0, lastBackupDate: null };
  }
}

export async function clearBackupHistory() {
  if (Platform.OS === 'web') return;
  try {
    const backup = getUnifiedAPI();
    await backup.resetBackupHistory();
  } catch (err) {
    console.warn('[photoBackup] clearBackupHistory error:', err);
  }
}

export async function registerBackgroundBackup() {
  if (Platform.OS === 'web') return;
  // Background registration is now handled by autoBackup orchestrator
  try {
    const backup = getUnifiedAPI();
    await backup.setBackupEnabled(true);
  } catch (err) {
    console.warn('[photoBackup] registerBackgroundBackup error:', err);
  }

  // ── Android: schedule the native WorkManager job ────────
  // Replaces the JS TaskManager.defineTask path that Android battery
  // saver was killing within minutes. WorkManager runs in the system
  // process and survives swipe-to-kill / doze.
  if (Platform.OS === 'android') {
    try {
      const native = require('../modules/expo-background-upload').default;
      if (native && typeof native.scheduleBackup === 'function') {
        const settings = await getBackupSettings();
        await native.scheduleBackup(!!settings?.wifiOnly, false /* chargingOnly */);

        // Stash creds for the worker to use after process death.
        if (typeof native.setBackupCreds === 'function') {
          try {
            const apiSvc = require('./api');
            const bearer = (apiSvc.getAuthToken && apiSvc.getAuthToken()) || '';
            const email = (apiSvc.getSavedEmail && apiSvc.getSavedEmail()) || '';
            // BASE_URL is just the host; the worker appends /email.php so
            // we hand it the /api path here for parity with the JS callers.
            const host = apiSvc.BASE_URL || 'https://chatyy.com.br';
            const base = host.replace(/\/+$/, '') + '/api';
            if (bearer && email) {
              await native.setBackupCreds(bearer, base, email);
            }
          } catch (e) {
            console.warn('[photoBackup] setBackupCreds failed:', e?.message);
          }
        }
      }
    } catch (err) {
      console.warn('[photoBackup] android scheduleBackup error:', err?.message);
    }
  }
}

export async function unregisterBackgroundBackup() {
  if (Platform.OS === 'web') return;
  try {
    const backup = getUnifiedAPI();
    await backup.setBackupEnabled(false);
  } catch (err) {
    console.warn('[photoBackup] unregisterBackgroundBackup error:', err);
  }

  if (Platform.OS === 'android') {
    try {
      const native = require('../modules/expo-background-upload').default;
      if (native && typeof native.cancelBackup === 'function') {
        await native.cancelBackup();
      }
    } catch (err) {
      console.warn('[photoBackup] android cancelBackup error:', err?.message);
    }
  }
}

export async function isBackupEnabled() {
  if (Platform.OS === 'web') return false;
  const backup = getUnifiedAPI();
  return await backup.isBackupEnabled();
}

export async function setBackupEnabled(enabled) {
  if (Platform.OS === 'web') return;
  const backup = getUnifiedAPI();
  await backup.setBackupEnabled(enabled);
}

export async function getBackupSettings() {
  try {
    const backup = getUnifiedAPI();
    return await backup.getBackupSettings();
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setBackupSettings(settings) {
  try {
    const backup = getUnifiedAPI();
    await backup.setBackupSettings(settings);
  } catch (err) {
    console.warn('[photoBackup] setBackupSettings error:', err);
  }
}

// ─── Worker-side delta reconciliation (Android, 2026-05-19) ─────────────
//
// The Android BackupWorker continues uploading photos after the app is
// swiped away. When the app re-opens, it needs to learn which ids the
// worker uploaded while it wasn't watching — otherwise the backup screen
// will show stale counts AND the next foreground run will re-attempt the
// same files (the same content_hash precheck will dedup them server-side,
// but the device wastes battery hashing+POSTing).
//
// The worker writes a delta file (~/files/chatyy-backup-delta.json) plus
// emits a LocalBroadcast every run. We listen to both:
//   1. AppState 'active' / cold-start: call reconcileWorkerBackedUp() to
//      drain the file and merge into AsyncStorage backedUpMap.
//   2. onBatchComplete native event: merge in-process when JS is alive.
//
// The native module's getBackedUpCount / scan path then naturally treats
// these as already-uploaded.

let _reconcileWired = false;

export function wireWorkerReconcile() {
  if (Platform.OS !== 'android' || _reconcileWired) return;
  _reconcileWired = true;

  const doReconcile = async () => {
    try {
      const native = require('../modules/expo-background-upload').default;
      if (!native || typeof native.reconcileWorkerBackedUp !== 'function') return;
      const delta = await native.reconcileWorkerBackedUp();
      const ids = delta?.ids || [];
      if (ids.length === 0) return;
      // Merge into AsyncStorage backedUpMap. Idempotent — re-running this
      // with the same ids is a no-op.
      try {
        const { getBackedUpMap, saveBackedUpMap } = require('./backup/backupStorage');
        const map = await getBackedUpMap();
        const now = Date.now();
        let changed = 0;
        for (const id of ids) {
          if (!map[id]) { map[id] = now; changed++; }
        }
        if (changed > 0) {
          await saveBackedUpMap(map);
          if (__DEV__) console.log(`[photoBackup] reconciled ${changed} worker-uploaded ids`);
        }
      } catch (e) {
        if (__DEV__) console.warn('[photoBackup] reconcile merge failed:', e?.message);
      }
    } catch (e) {
      if (__DEV__) console.warn('[photoBackup] reconcileWorkerBackedUp failed:', e?.message);
    }
  };

  // Cold-start: run immediately. The first AppState event sometimes
  // arrives 1-2s after mount because the listener doesn't get the
  // current state — better to just pull on first wire.
  doReconcile();

  // Foreground transitions: when the user returns to the app, drain
  // anything the worker uploaded while we were backgrounded.
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      doReconcile();
    }
  });

  // Live event: when the worker fires its LocalBroadcast and JS happens
  // to be running, merge ids into the map directly (skips the file
  // round-trip; the file still gets cleaned on the next AppState pass).
  try {
    const native = require('../modules/expo-background-upload').default;
    if (native && typeof native.addListener === 'function') {
      native.addListener('onBatchComplete', async (event) => {
        const ids = event?.ids;
        if (!Array.isArray(ids) || ids.length === 0) return;
        try {
          const { getBackedUpMap, saveBackedUpMap } = require('./backup/backupStorage');
          const map = await getBackedUpMap();
          const now = Date.now();
          let changed = 0;
          for (const id of ids) {
            if (!map[id]) { map[id] = now; changed++; }
          }
          if (changed > 0) await saveBackedUpMap(map);
        } catch {}
      });
    }
  } catch {}
}
