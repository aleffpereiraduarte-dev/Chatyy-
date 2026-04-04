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
import { Platform } from 'react-native';

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
    if (status === 'granted') return { granted: true };
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
    const result = await backup.runBackupNow({ maxFiles: 1 });
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
}

export async function unregisterBackgroundBackup() {
  if (Platform.OS === 'web') return;
  try {
    const backup = getUnifiedAPI();
    await backup.setBackupEnabled(false);
  } catch (err) {
    console.warn('[photoBackup] unregisterBackgroundBackup error:', err);
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
