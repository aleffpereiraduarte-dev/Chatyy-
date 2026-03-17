/**
 * Chatyy Auto Photo Backup Service
 *
 * Runs globally (from _layout.js), independent of any screen.
 * Provides Google Photos-style automatic backup via three mechanisms:
 *
 * 1. MediaLibrary.addListener  -- instant trigger when user takes a new photo
 * 2. AppState 'active' listener -- check for new photos when app returns to foreground
 * 3. Background task (registered separately in photos.js) -- periodic every 15 min
 *
 * Uses the same AsyncStorage keys and upload approach as the background task
 * defined in photos.js, so they share progress seamlessly.
 */
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from './api';

let isRunning = false;
let mediaSubscription = null;
let appStateSubscription = null;
let initialized = false;

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
};

/**
 * Initialize auto-backup listeners. Call once from _layout.js.
 * Safe to call multiple times (idempotent).
 */
export async function initAutoBackup() {
  if (Platform.OS === 'web') return;
  if (initialized) return;

  // Check if auto-backup is enabled
  const enabled = await AsyncStorage.getItem('backup_auto_enabled').catch(() => null);
  if (enabled !== 'true') return;

  initialized = true;

  // 1. Listen for new photos added to the media library (instant trigger)
  setupMediaListener();

  // 2. Listen for app returning to foreground
  setupAppStateListener();

  // 3. Run an initial check for any photos missed while app was closed
  setTimeout(() => checkAndBackupNew(), 8000); // Delay 8s to not block app startup
}

/**
 * Set up the MediaLibrary change listener.
 * Fires when user takes a new photo or saves an image.
 */
function setupMediaListener() {
  if (mediaSubscription) return;

  try {
    const ML = require('expo-media-library');

    (async () => {
      try {
        const { status } = await ML.getPermissionsAsync();
        if (status !== 'granted') return;

        mediaSubscription = ML.addListener((event) => {
          // event.hasIncrementalChanges is true when assets were added/modified
          // event.insertedAssets contains newly added assets (iOS)
          // On Android, we get hasIncrementalChanges but may not get insertedAssets
          if (event.hasIncrementalChanges) {
            if (event.insertedAssets && event.insertedAssets.length > 0) {
              // iOS: we know exactly which assets were added
              backupNewAssets(event.insertedAssets);
            } else {
              // Android: just check for new photos
              checkAndBackupNew();
            }
          }
        });
      } catch {}
    })();
  } catch {}
}

/**
 * Set up AppState listener to check for new photos when app becomes active.
 */
function setupAppStateListener() {
  if (appStateSubscription) return;

  appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      // Small delay so UI can finish rendering first
      setTimeout(() => checkAndBackupNew(), 2000);
    }
  });
}

/**
 * Backup specific new assets (typically from MediaLibrary listener).
 * Uses the same AsyncStorage key ('backed_up_photos') as the background task
 * in photos.js, so progress is shared.
 */
async function backupNewAssets(assets) {
  if (isRunning) return;
  isRunning = true;

  try {
    const ML = require('expo-media-library');
    const FS = require('expo-file-system');

    let backedUpIds = {};
    try {
      const s = await AsyncStorage.getItem('backed_up_photos');
      if (s) backedUpIds = JSON.parse(s);
    } catch {}

    let uploadedCount = 0;

    for (const asset of assets) {
      if (backedUpIds[asset.id]) continue; // Already backed up

      try {
        const info = await ML.getAssetInfoAsync(asset.id);
        const uri = info?.localUri || asset.uri;
        const name = asset.filename || 'photo.jpg';
        const ext = (name.split('.').pop() || '').toLowerCase();
        const mimeType = asset.mediaType === 'video'
          ? 'video/mp4'
          : (MIME_MAP[ext] || 'image/jpeg');

        const presigned = await api.getPresignedUpload(name, mimeType);
        if (presigned?.success && presigned?.data?.upload_url) {
          const result = await FS.uploadAsync(presigned.data.upload_url, uri, {
            httpMethod: 'PUT',
            uploadType: FS.FileSystemUploadType.BINARY_CONTENT,
            headers: { 'Content-Type': mimeType },
            sessionType: FS.FileSystemSessionType.BACKGROUND,
          });
          if (result.status >= 200 && result.status < 300) {
            if (presigned.data.file_id) {
              api.confirmUpload(presigned.data.file_id).catch(() => {});
            }
            backedUpIds[asset.id] = Date.now();
            uploadedCount++;
          }
        }
      } catch {}
    }

    if (uploadedCount > 0) {
      await AsyncStorage.setItem('backed_up_photos', JSON.stringify(backedUpIds));
    }
  } catch {}

  isRunning = false;
}

/**
 * Check for any new photos on the device since last backup.
 * Fetches the most recent 50 photos and uploads any that are not yet backed up.
 */
async function checkAndBackupNew() {
  if (isRunning) return;

  // Re-check if backup is still enabled
  const enabled = await AsyncStorage.getItem('backup_auto_enabled').catch(() => null);
  if (enabled !== 'true') return;

  isRunning = true;

  try {
    const ML = require('expo-media-library');
    const { status } = await ML.getPermissionsAsync();
    if (status !== 'granted') {
      isRunning = false;
      return;
    }

    let backedUpIds = {};
    try {
      const s = await AsyncStorage.getItem('backed_up_photos');
      if (s) backedUpIds = JSON.parse(s);
    } catch {}

    // Get recent photos (last 50)
    const assets = await ML.getAssetsAsync({
      mediaType: [ML.MediaType.photo, ML.MediaType.video],
      first: 50,
      sortBy: [ML.SortBy.creationTime],
    });

    const newPhotos = (assets?.assets || []).filter(a => !backedUpIds[a.id]);
    if (newPhotos.length > 0) {
      // Release the lock so backupNewAssets can acquire it
      isRunning = false;
      await backupNewAssets(newPhotos);
      return; // backupNewAssets sets isRunning = false
    }
  } catch {}

  isRunning = false;
}

/**
 * Stop all auto-backup listeners.
 */
export function stopAutoBackup() {
  if (mediaSubscription) {
    mediaSubscription.remove();
    mediaSubscription = null;
  }
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
  initialized = false;
}

/**
 * Call when the backup setting changes (from photos.js toggle).
 * Starts or stops the auto-backup listeners accordingly.
 */
export async function onBackupSettingChanged(enabled) {
  if (Platform.OS === 'web') return;

  if (enabled) {
    // Reset initialized flag so initAutoBackup runs fresh
    initialized = false;
    await initAutoBackup();
  } else {
    stopAutoBackup();
  }
}
