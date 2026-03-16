/**
 * Chatyy Photo/Video Backup Service
 * Automatic backup of device photos and videos to Chatyy Drive,
 * similar to Google Photos backup.
 *
 * Handles:
 * - Tracking backed-up assets via AsyncStorage
 * - Requesting media library permissions
 * - Sequential upload to avoid server overload
 * - Background task registration for automatic backup
 * - WiFi-only mode
 * - Graceful degradation on web / missing native modules
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAuthToken, BASE_URL } from './api';

const API_URL = `${BASE_URL}/api/email.php`;
const BACKED_UP_KEY = '@chatyy_photo_backup_ids';
const BACKUP_SETTINGS_KEY = '@chatyy_backup_settings';
const LAST_BACKUP_KEY = '@chatyy_last_backup_date';
const BACKGROUND_TASK_NAME = 'CHATYY_PHOTO_BACKUP';
const MAX_BACKGROUND_UPLOADS = 10;

// ─── Default settings ───────────────────────────────────────
const DEFAULT_SETTINGS = {
  enabled: false,
  wifiOnly: true,
  includeVideos: true,
  quality: 'original', // 'original' | 'high' | 'medium'
};

// ─── Internal helpers ────────────────────────────────────────

/**
 * Load the set of already-backed-up asset IDs from AsyncStorage.
 * @returns {Promise<Set<string>>}
 */
async function loadBackedUpIds() {
  try {
    const raw = await AsyncStorage.getItem(BACKED_UP_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (err) {
    console.warn('[photoBackup] Failed to load backed-up IDs:', err);
    return new Set();
  }
}

/**
 * Persist the backed-up asset ID set to AsyncStorage.
 * @param {Set<string>} ids
 */
async function saveBackedUpIds(ids) {
  try {
    await AsyncStorage.setItem(BACKED_UP_KEY, JSON.stringify([...ids]));
  } catch (err) {
    console.warn('[photoBackup] Failed to save backed-up IDs:', err);
  }
}

/**
 * Add a single asset ID to the backed-up set.
 * @param {string} assetId
 */
async function markAsBackedUp(assetId) {
  const ids = await loadBackedUpIds();
  ids.add(assetId);
  await saveBackedUpIds(ids);
}

/**
 * Check whether the device is currently on WiFi.
 * Returns true if check is unavailable (fail-open).
 */
async function isOnWifi() {
  try {
    const NetInfo = require('@react-native-community/netinfo');
    const state = await NetInfo.default.fetch();
    return state.type === 'wifi';
  } catch {
    // Module not available or error — allow backup
    return true;
  }
}

// ─── Web no-ops ──────────────────────────────────────────────
// On web, media library is not available. Export stub functions
// that return sensible defaults so consumers don't need to
// platform-check every call site.

const WEB_NOOP = {
  async requestPermissions() {
    return { granted: false, reason: 'web_unsupported' };
  },
  async getPhotosToBackup() {
    return [];
  },
  async uploadAsset() {
    return { success: false, message: 'web_unsupported' };
  },
  async runBackup() {
    return { uploaded: 0, failed: 0, skipped: 0 };
  },
  async getBackupStats() {
    return { totalOnDevice: 0, backedUp: 0, remaining: 0, lastBackupDate: null };
  },
  async clearBackupHistory() {},
  async registerBackgroundBackup() {},
  async unregisterBackgroundBackup() {},
  async isBackupEnabled() {
    return false;
  },
  async setBackupEnabled() {},
  async getBackupSettings() {
    return { ...DEFAULT_SETTINGS };
  },
  async setBackupSettings() {},
};

// ─── Exported functions ──────────────────────────────────────

/**
 * Request media library permissions.
 * @returns {Promise<{granted: boolean, reason?: string}>}
 */
export async function requestPermissions() {
  if (Platform.OS === 'web') return WEB_NOOP.requestPermissions();

  try {
    const MediaLibrary = require('expo-media-library');
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status === 'granted') {
      return { granted: true };
    }
    return { granted: false, reason: 'permission_denied' };
  } catch (err) {
    console.warn('[photoBackup] requestPermissions error:', err);
    return { granted: false, reason: 'module_unavailable' };
  }
}

/**
 * Get photos/videos from device that have not yet been backed up.
 * Results are sorted newest-first.
 *
 * @param {number} limit - Max assets to return (default 50)
 * @returns {Promise<Array>} Array of MediaLibrary asset objects
 */
export async function getPhotosToBackup(limit = 50) {
  if (Platform.OS === 'web') return [];

  try {
    const MediaLibrary = require('expo-media-library');
    const settings = await getBackupSettings();
    const backedUpIds = await loadBackedUpIds();

    const mediaType = settings.includeVideos
      ? [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video]
      : [MediaLibrary.MediaType.photo];

    // Fetch assets sorted by creation time (newest first)
    const { assets } = await MediaLibrary.getAssetsAsync({
      first: limit + backedUpIds.size, // fetch extra to account for filtering
      mediaType,
      sortBy: [[MediaLibrary.SortBy.creationTime, false]], // descending
    });

    if (!assets || assets.length === 0) return [];

    // Filter out already backed-up
    const needsBackup = assets.filter((a) => !backedUpIds.has(a.id));

    return needsBackup.slice(0, limit);
  } catch (err) {
    console.warn('[photoBackup] getPhotosToBackup error:', err);
    return [];
  }
}

/**
 * Upload a single asset to Chatyy Drive photo backup.
 *
 * @param {object} asset - MediaLibrary asset object
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function uploadAsset(asset) {
  if (Platform.OS === 'web') return WEB_NOOP.uploadAsset();

  try {
    const MediaLibrary = require('expo-media-library');

    // Get full asset info (including local URI)
    const info = await MediaLibrary.getAssetInfoAsync(asset);
    const uri = info.localUri || info.uri || asset.uri;

    if (!uri) {
      return { success: false, message: 'no_uri' };
    }

    const token = getAuthToken();
    if (!token) {
      return { success: false, message: 'not_authenticated' };
    }

    const isVideo = asset.mediaType === 'video';
    const mimeType = isVideo ? 'video/mp4' : 'image/jpeg';
    const ext = isVideo ? 'mp4' : 'jpg';
    const filename = asset.filename || `backup_${asset.id}.${ext}`;

    const formData = new FormData();
    formData.append('action', 'drive_upload_photo_backup');
    formData.append('file', {
      uri,
      type: mimeType,
      name: filename,
    });
    // Send creation date so server can organize by date
    if (asset.creationTime) {
      formData.append('created_at', new Date(asset.creationTime).toISOString());
    }
    if (asset.width) formData.append('width', String(asset.width));
    if (asset.height) formData.append('height', String(asset.height));
    if (asset.duration) formData.append('duration', String(asset.duration));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const res = await fetch(`${API_URL}?action=drive_upload_photo_backup`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const text = await res.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        result = { success: false, message: 'invalid_response' };
      }

      if (result.success) {
        await markAsBackedUp(asset.id);
      }
      return result;
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        return { success: false, message: 'timeout' };
      }
      return { success: false, message: err.message || 'upload_failed' };
    }
  } catch (err) {
    console.warn('[photoBackup] uploadAsset error:', err);
    return { success: false, message: 'upload_error' };
  }
}

/**
 * Main backup function. Uploads pending photos/videos sequentially.
 *
 * @param {object} options
 * @param {function} options.onProgress - Called after each upload: ({current, total, asset})
 * @param {number}   options.maxFiles   - Max files to upload this run (default 50)
 * @param {boolean}  options.wifiOnly   - Only upload on WiFi (default from settings)
 * @returns {Promise<{uploaded: number, failed: number, skipped: number}>}
 */
export async function runBackup(options = {}) {
  if (Platform.OS === 'web') return WEB_NOOP.runBackup();

  const settings = await getBackupSettings();
  const {
    onProgress,
    maxFiles = 50,
    wifiOnly = settings.wifiOnly,
  } = options;

  const result = { uploaded: 0, failed: 0, skipped: 0 };

  // Check WiFi if required
  if (wifiOnly) {
    const wifi = await isOnWifi();
    if (!wifi) {
      console.log('[photoBackup] Skipping backup — not on WiFi');
      return result;
    }
  }

  // Check auth
  const token = getAuthToken();
  if (!token) {
    console.warn('[photoBackup] Skipping backup — not authenticated');
    return result;
  }

  // Get pending assets
  const assets = await getPhotosToBackup(maxFiles);
  if (assets.length === 0) {
    return result;
  }

  const total = assets.length;

  // Upload sequentially to avoid overwhelming the server
  for (let i = 0; i < total; i++) {
    const asset = assets[i];

    // Re-check WiFi periodically (every 5 uploads)
    if (wifiOnly && i > 0 && i % 5 === 0) {
      const stillWifi = await isOnWifi();
      if (!stillWifi) {
        result.skipped += total - i;
        console.log('[photoBackup] Lost WiFi, stopping backup');
        break;
      }
    }

    const uploadResult = await uploadAsset(asset);

    if (uploadResult.success) {
      result.uploaded++;
    } else {
      result.failed++;
    }

    if (onProgress) {
      try {
        onProgress({ current: i + 1, total, asset, success: uploadResult.success });
      } catch {
        // Ignore callback errors
      }
    }
  }

  // Update last backup timestamp
  try {
    await AsyncStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  } catch {
    // Non-critical
  }

  console.log(`[photoBackup] Backup complete: ${result.uploaded} uploaded, ${result.failed} failed, ${result.skipped} skipped`);
  return result;
}

/**
 * Return backup statistics.
 * @returns {Promise<{totalOnDevice: number, backedUp: number, remaining: number, lastBackupDate: string|null}>}
 */
export async function getBackupStats() {
  if (Platform.OS === 'web') return WEB_NOOP.getBackupStats();

  try {
    const MediaLibrary = require('expo-media-library');
    const settings = await getBackupSettings();

    const mediaType = settings.includeVideos
      ? [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video]
      : [MediaLibrary.MediaType.photo];

    // Get total asset count on device
    const { totalCount } = await MediaLibrary.getAssetsAsync({
      first: 1,
      mediaType,
    });

    const backedUpIds = await loadBackedUpIds();
    const backedUp = backedUpIds.size;

    let lastBackupDate = null;
    try {
      lastBackupDate = await AsyncStorage.getItem(LAST_BACKUP_KEY);
    } catch {
      // ignore
    }

    return {
      totalOnDevice: totalCount || 0,
      backedUp,
      remaining: Math.max(0, (totalCount || 0) - backedUp),
      lastBackupDate,
    };
  } catch (err) {
    console.warn('[photoBackup] getBackupStats error:', err);
    const backedUpIds = await loadBackedUpIds();
    let lastBackupDate = null;
    try {
      lastBackupDate = await AsyncStorage.getItem(LAST_BACKUP_KEY);
    } catch {
      // ignore
    }
    return {
      totalOnDevice: 0,
      backedUp: backedUpIds.size,
      remaining: 0,
      lastBackupDate,
    };
  }
}

/**
 * Clear the backup history, forcing all assets to be re-uploaded.
 */
export async function clearBackupHistory() {
  if (Platform.OS === 'web') return;
  try {
    await AsyncStorage.removeItem(BACKED_UP_KEY);
    await AsyncStorage.removeItem(LAST_BACKUP_KEY);
    console.log('[photoBackup] Backup history cleared');
  } catch (err) {
    console.warn('[photoBackup] clearBackupHistory error:', err);
  }
}

/**
 * Register a background task that periodically backs up photos.
 * Uses expo-background-fetch + expo-task-manager.
 * Uploads up to MAX_BACKGROUND_UPLOADS per run (background time is limited).
 */
export async function registerBackgroundBackup() {
  if (Platform.OS === 'web') return;

  try {
    const TaskManager = require('expo-task-manager');
    const BackgroundFetch = require('expo-background-fetch');

    // Define the background task
    TaskManager.defineTask(BACKGROUND_TASK_NAME, async () => {
      try {
        const settings = await getBackupSettings();
        if (!settings.enabled) {
          return BackgroundFetch.BackgroundFetchResult.NoData;
        }

        const api = require('./api');
        const token = api.getAuthToken();
        if (!token) {
          return BackgroundFetch.BackgroundFetchResult.NoData;
        }

        const result = await runBackup({
          maxFiles: MAX_BACKGROUND_UPLOADS,
          wifiOnly: settings.wifiOnly,
        });

        return result.uploaded > 0
          ? BackgroundFetch.BackgroundFetchResult.NewData
          : BackgroundFetch.BackgroundFetchResult.NoData;
      } catch (err) {
        console.warn('[photoBackup] Background task error:', err);
        return BackgroundFetch.BackgroundFetchResult.Failed;
      }
    });

    // Register the background fetch
    const status = await BackgroundFetch.getStatusAsync();
    if (status === BackgroundFetch.BackgroundFetchStatus.Available) {
      await BackgroundFetch.registerTaskAsync(BACKGROUND_TASK_NAME, {
        minimumInterval: 15 * 60, // 15 minutes (iOS minimum)
        stopOnTerminate: false,
        startOnBoot: true,
      });
      console.log('[photoBackup] Background backup registered');
    } else {
      console.warn('[photoBackup] Background fetch not available, status:', status);
    }
  } catch (err) {
    console.warn('[photoBackup] registerBackgroundBackup error:', err);
  }
}

/**
 * Unregister the background backup task.
 */
export async function unregisterBackgroundBackup() {
  if (Platform.OS === 'web') return;

  try {
    const BackgroundFetch = require('expo-background-fetch');
    await BackgroundFetch.unregisterTaskAsync(BACKGROUND_TASK_NAME);
    console.log('[photoBackup] Background backup unregistered');
  } catch {
    // Task may not have been registered
  }
}

/**
 * Check if backup is enabled.
 * @returns {Promise<boolean>}
 */
export async function isBackupEnabled() {
  if (Platform.OS === 'web') return false;
  const settings = await getBackupSettings();
  return settings.enabled;
}

/**
 * Enable or disable backup. Also registers/unregisters background task.
 * @param {boolean} enabled
 */
export async function setBackupEnabled(enabled) {
  if (Platform.OS === 'web') return;

  const settings = await getBackupSettings();
  settings.enabled = !!enabled;
  await setBackupSettings(settings);

  if (enabled) {
    await registerBackgroundBackup();
  } else {
    await unregisterBackgroundBackup();
  }
}

/**
 * Get backup settings from AsyncStorage.
 * @returns {Promise<{enabled: boolean, wifiOnly: boolean, includeVideos: boolean, quality: string}>}
 */
export async function getBackupSettings() {
  try {
    const raw = await AsyncStorage.getItem(BACKUP_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Save backup settings to AsyncStorage.
 * @param {object} settings - Partial settings to merge with existing
 */
export async function setBackupSettings(settings) {
  try {
    const current = await getBackupSettings();
    const merged = { ...current, ...settings };
    await AsyncStorage.setItem(BACKUP_SETTINGS_KEY, JSON.stringify(merged));
  } catch (err) {
    console.warn('[photoBackup] setBackupSettings error:', err);
  }
}
