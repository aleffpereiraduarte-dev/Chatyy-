/**
 * Unified Backup API Facade
 *
 * Single entry point for all backup operations. Delegates to:
 * - backupStorage.js for state management
 * - backupEngine.js for upload logic (dedup, presigned, retry, sessions)
 * - autoBackup.js for orchestration (BackgroundFetch, listeners)
 *
 * Callers should import from here:
 *   import { initBackup, runBackupNow, ... } from '../services/backup';
 */
import { Platform } from 'react-native';
import {
  migrateBackupStateV2,
  getSettings, saveSettings,
  getBackedUpMap, saveBackedUpMap, clearBackedUpMap,
  getLastSync, setLastSync, getLastRun, setLastRun,
  resetAllBackupState, DEFAULT_SETTINGS,
  isBackupKilled, setBackupKilled,
  isBackupNotificationsEnabled, setBackupNotificationsEnabled,
} from './backupStorage';

// Lazy imports to avoid circular deps at module level
let _engine = null;
function getEngine() {
  if (!_engine) {
    const { getBackupEngine } = require('../backupEngine');
    _engine = getBackupEngine();
  }
  return _engine;
}

let _initDone = false;
let _initPromise = null;

// ─── Web no-ops ─────────────────────────────────────────────
const WEB_RESULT = { uploaded: 0, failed: 0, skipped: 0 };
const WEB_STATS = { totalOnDevice: 0, backedUp: 0, remaining: 0, lastBackupDate: null };

// ─── Public API ─────────────────────────────────────────────

/**
 * Initialize the backup system. Call once at app startup.
 * Runs the V2 migration on first launch, then initializes the engine.
 */
export async function initBackup() {
  if (Platform.OS === 'web') return;
  if (_initDone) return;
  // Lock concorrente — chamadas simultâneas (foreground + WS reconnect +
  // useEffect) compartilham a mesma promise em vez de rodar migrate 2x.
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      await migrateBackupStateV2();
      const engine = getEngine();
      await engine.init();
      _initDone = true;
    } finally {
      _initPromise = null;
    }
  })();
  return _initPromise;
}

/**
 * Run a backup now (foreground). Delegates to BackupEngine.runFullBackup.
 *
 * @param {object} opts
 * @param {function} opts.onProgress - Progress callback
 * @param {function} opts.onComplete - Completion callback
 * @param {function} opts.onError - Error callback
 * @returns {Promise<object>} Result with uploaded/failed/skipped counts
 */
export async function runBackupNow(opts = {}) {
  if (Platform.OS === 'web') return WEB_RESULT;

  if (!_initDone) await initBackup();

  const settings = await getSettings();
  const engine = getEngine();

  const result = await engine.runFullBackup({
    includeVideos: settings.includeVideos,
    quality: settings.quality || 'economy',
    onProgress: opts.onProgress,
    onComplete: opts.onComplete,
    onError: opts.onError,
  });

  // Update last run timestamp
  if (result && (result.uploaded > 0 || result.status === 'complete')) {
    await setLastRun(new Date().toISOString());
  }

  return result;
}

/**
 * Enable or disable backup. Also triggers orchestrator registration.
 */
export async function setBackupEnabled(enabled) {
  if (Platform.OS === 'web') return;

  await saveSettings({ enabled: !!enabled });

  // Delegate to autoBackup orchestrator for listener/task management
  try {
    const autoBackup = require('../autoBackup');
    await autoBackup.onBackupSettingChanged(!!enabled);
  } catch (err) {
    console.warn('[backup] Error in setBackupEnabled:', err);
  }
}

/**
 * Get backup settings.
 */
export async function getBackupSettings() {
  return getSettings();
}

/**
 * Update backup settings (partial merge).
 */
export async function setBackupSettings(patch) {
  return saveSettings(patch);
}

/**
 * Get backup statistics.
 */
export async function getBackupStats() {
  if (Platform.OS === 'web') return WEB_STATS;

  try {
    const ML = require('expo-media-library');
    const settings = await getSettings();

    const mediaType = settings.includeVideos
      ? [ML.MediaType.photo, ML.MediaType.video]
      : [ML.MediaType.photo];

    const { totalCount } = await ML.getAssetsAsync({
      first: 1,
      mediaType,
    });

    const backedUpMap = await getBackedUpMap();
    const backedUp = Object.keys(backedUpMap).length;
    const lastBackupDate = await getLastSync();

    return {
      totalOnDevice: totalCount || 0,
      backedUp,
      remaining: Math.max(0, (totalCount || 0) - backedUp),
      lastBackupDate,
    };
  } catch (err) {
    console.warn('[backup] getBackupStats error:', err);
    const backedUpMap = await getBackedUpMap();
    const lastBackupDate = await getLastSync();
    return {
      totalOnDevice: 0,
      backedUp: Object.keys(backedUpMap).length,
      remaining: 0,
      lastBackupDate,
    };
  }
}

/**
 * Pause a running backup.
 */
export function pauseBackup() {
  try {
    const engine = getEngine();
    engine.pause();
  } catch {}
}

/**
 * Resume a paused backup.
 */
export function resumeBackup() {
  try {
    const engine = getEngine();
    engine.resume();
  } catch {}
}

/**
 * Reset all backup history (force re-upload everything).
 */
export async function resetBackupHistory() {
  if (Platform.OS === 'web') return;

  // Reset engine state
  try {
    const engine = getEngine();
    await engine.reset();
  } catch {}

  // Clear unified storage
  await clearBackedUpMap();

  // Reset last sync
  await setLastSync('');
  await setLastRun('');
}

/**
 * Get the count of backed-up assets.
 */
export async function getBackedUpCount() {
  const map = await getBackedUpMap();
  return Object.keys(map).length;
}

/**
 * Check if backup is enabled.
 */
export async function isBackupEnabled() {
  if (Platform.OS === 'web') return false;
  const settings = await getSettings();
  return settings.enabled;
}

/**
 * Check if a backup is currently running.
 */
export function isBackupRunning() {
  try {
    const engine = getEngine();
    return engine.isRunning;
  } catch {
    return false;
  }
}

// Re-export storage utilities for advanced callers
export {
  getBackedUpMap,
  saveBackedUpMap,
  getLastSync,
  setLastSync,
  migrateBackupStateV2,
  DEFAULT_SETTINGS,
  isBackupKilled,
  setBackupKilled,
  isBackupNotificationsEnabled,
  setBackupNotificationsEnabled,
};

/**
 * Emergency killswitch (2026-05-18) — halts every backup entry point.
 * Use when the "Backup do Chatyy" phantom-progress banner appears and
 * needs to be silenced immediately. After flipping ON, the next time the
 * user backgrounds + foregrounds the app, no notification will fire.
 * Backend can set this remotely by pushing a feature flag that calls
 * setBackupKilled(true) from the response handler.
 */
export async function killBackup() {
  await setBackupKilled(true);
  try {
    const autoBackup = require('../autoBackup');
    if (autoBackup.getIsRunning?.()) autoBackup.pause();
    autoBackup.stopAutoBackup?.();
  } catch {}
  // Also dismiss any currently-visible "Backup do Chatyy" notification.
  try {
    if (Platform.OS !== 'web') {
      const Notifications = require('expo-notifications');
      await Notifications.dismissNotificationAsync('upload_progress_chatyy_photo_backup').catch(() => {});
    }
  } catch {}
}

export async function reviveBackup() {
  await setBackupKilled(false);
}
