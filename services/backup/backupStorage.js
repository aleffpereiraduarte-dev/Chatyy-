/**
 * Unified Backup Storage — Single source of truth for all backup state.
 *
 * Replaces the 3 separate AsyncStorage key schemes from:
 * - photoBackup.js (@chatyy_photo_backup_ids, @chatyy_backup_settings, @chatyy_last_backup_date)
 * - backupEngine.js (backed_up_photos, backup_last_sync_timestamp, backup_upload_sessions)
 * - autoBackup.js (backed_up_photos, backup_auto_enabled, backup_wifi_only, etc.)
 *
 * All keys are now under @chatyy_backup/* namespace.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Unified key namespace ──────────────────────────────────
export const KEYS = {
  MIGRATION_VERSION: '@chatyy_backup_migration_v3',
  SETTINGS:          '@chatyy_backup/settings',
  BACKED_UP_MAP:     '@chatyy_backup/backed_up_map',   // { assetId: timestamp }
  LAST_SYNC:         '@chatyy_backup/last_sync',       // ISO string
  LAST_RUN:          '@chatyy_backup/last_run',        // ISO string
  UPLOAD_SESSIONS:   '@chatyy_backup/upload_sessions', // resumable sessions
  KILLSWITCH:        '@chatyy_backup/killswitch',      // '1' → halt ALL backup entry points
  NOTIFY:            '@chatyy_backup/notifications',   // '1' (default) → show batch-complete + sticky notifs; '0' → silent
};

// ─── Backup notifications toggle ────────────────────────────
// User-facing OFF switch for both the JS sticky "Backup do Chatyy"
// progress banner (uploadNotification.start) AND the native iOS
// "X fotos salvas" / "Backup concluído" batch-complete banner posted
// by ExpoBackgroundUploadModule's defer block. Set via the toggle in
// app/backup.js ("Notificações de backup"). Defaults to ON so existing
// installs keep the previous behavior unless the user opts out.
//
// SPAM-FIX (2026-05-18): user got 30+ "Backup do Chatyy" banners per
// session because the native module's defer-block fired one banner per
// startNativeBackup call AND the JS uploadNotification re-fired on
// every progress tick. Even with the per-call dedup identifier, the
// cumulative volume was disruptive. The 3-layer fix is:
//   1) Native cooldown (1h) inside notifyBackupComplete
//   2) Native UserDefaults flag the user controls from JS
//   3) JS-side honor of this AsyncStorage flag before calling
//      uploadNotification.start
let _notifCache = null;
let _notifTs = 0;
const NOTIF_CACHE_MS = 30 * 1000;
export async function isBackupNotificationsEnabled() {
  const now = Date.now();
  if (_notifCache !== null && now - _notifTs < NOTIF_CACHE_MS) {
    return _notifCache;
  }
  try {
    const v = await AsyncStorage.getItem(KEYS.NOTIFY);
    // Default ON when the key has never been written.
    _notifCache = v == null ? true : (v === '1');
    _notifTs = now;
    return _notifCache;
  } catch {
    return true;
  }
}
export async function setBackupNotificationsEnabled(enabled) {
  _notifCache = !!enabled;
  _notifTs = Date.now();
  try {
    await AsyncStorage.setItem(KEYS.NOTIFY, enabled ? '1' : '0');
  } catch {}
  // Mirror the flag into the native iOS module so its background
  // wake-ups (which can't read AsyncStorage) respect the toggle.
  try {
    if (require('react-native').Platform.OS === 'ios') {
      const native = require('../../modules/expo-background-upload').default;
      if (native && typeof native.setBackupNotificationsEnabled === 'function') {
        native.setBackupNotificationsEnabled(!!enabled);
      }
    }
  } catch {}
  // If the user is disabling notifications, also dismiss any
  // currently-visible sticky/banner so the change is immediate.
  if (!enabled) {
    try {
      const { Platform } = require('react-native');
      if (Platform.OS !== 'web') {
        const Notifications = require('expo-notifications');
        // Sticky JS banner id used by uploadNotification.start
        Notifications.dismissNotificationAsync('upload_progress_chatyy_photo_backup').catch(() => {});
        Notifications.dismissNotificationAsync('upload_progress_chatyy_photo_backup_done').catch(() => {});
        Notifications.dismissNotificationAsync('upload_progress_chatyy_photo_backup_err').catch(() => {});
      }
    } catch {}
  }
}

// ─── Global killswitch ──────────────────────────────────────
// When set, every backup entry point bails out immediately. This is the
// last-resort circuit breaker for the "Backup do Chatyy" banner bug where
// the native module emits phantom onProgress events for already-deduped
// assets and fires a notification that never goes away. The flag is read
// from AsyncStorage on every entry, so flipping it (via support backend
// or in-app setting) takes effect on the next backup attempt without
// requiring a rebuild. To flip remotely, set it from the backend
// response handler in api.js when a feature flag arrives.
let _killswitchCache = null;
let _killswitchTs = 0;
const KILLSWITCH_CACHE_MS = 30 * 1000;
export async function isBackupKilled() {
  const now = Date.now();
  if (_killswitchCache !== null && now - _killswitchTs < KILLSWITCH_CACHE_MS) {
    return _killswitchCache;
  }
  try {
    const v = await AsyncStorage.getItem(KEYS.KILLSWITCH);
    _killswitchCache = v === '1';
    _killswitchTs = now;
    return _killswitchCache;
  } catch {
    return false;
  }
}
export async function setBackupKilled(killed) {
  _killswitchCache = !!killed;
  _killswitchTs = Date.now();
  try {
    if (killed) {
      await AsyncStorage.setItem(KEYS.KILLSWITCH, '1');
    } else {
      await AsyncStorage.removeItem(KEYS.KILLSWITCH);
    }
  } catch {}
}

// ─── Legacy keys (for migration only) ──────────────────────
const LEGACY = {
  PHOTO_IDS:        '@chatyy_photo_backup_ids',
  PHOTO_SETTINGS:   '@chatyy_backup_settings',
  PHOTO_LAST:       '@chatyy_last_backup_date',

  ENGINE_BACKED:    'backed_up_photos',
  ENGINE_LAST_SYNC: 'backup_last_sync_timestamp',
  ENGINE_SESSIONS:  'backup_upload_sessions',

  AUTO_ENABLED:     'backup_auto_enabled',
  AUTO_WIFI:        'backup_wifi_only',
  AUTO_VIDEO:       'backup_include_video',
  AUTO_QUALITY:     'backup_quality',
  AUTO_LAST:        'last_backup_date',
};

// ─── Default settings ───────────────────────────────────────
const DEFAULT_SETTINGS = {
  enabled: false,
  wifiOnly: false,
  includeVideos: true,
  quality: 'economy',
};

// ─── In-memory cache (avoid repeated AsyncStorage reads) ────
let _cachedMap = null;
let _cacheTs = 0;
const CACHE_TTL = 30000; // 30s

// ─── Migration ──────────────────────────────────────────────
/**
 * One-shot migration that merges state from all 3 legacy systems
 * into the unified @chatyy_backup/* namespace.
 * Safe to call multiple times (idempotent via version flag).
 */
export async function migrateBackupStateV2() {
  try {
    const done = await AsyncStorage.getItem(KEYS.MIGRATION_VERSION);
    if (done === '3') return;
    // v3 migration: clear stale backedUpIds, but BACKUP first so we can
    // recover if the wipe was wrong (it was — caused the "57k > 44k device"
    // ghost-count incident in task #469). Saved to a one-shot key the
    // user can pull back via the Settings → Backup → "Restore IDs" path.
    if (done === '2') {
      try {
        const existing = await AsyncStorage.getItem(KEYS.BACKED_UP_MAP);
        if (existing) {
          await AsyncStorage.setItem(KEYS.BACKED_UP_MAP + '_v2_backup', existing);
          await AsyncStorage.setItem(KEYS.BACKED_UP_MAP + '_v2_backup_at', String(Date.now()));
        }
      } catch {}
      await AsyncStorage.removeItem(KEYS.BACKED_UP_MAP);
      await AsyncStorage.setItem(KEYS.MIGRATION_VERSION, '3');
      console.log('[Backup] v3 migration: cleared stale backedUpIds (backup saved at _v2_backup)');
      return;
    }

    const entries = await AsyncStorage.multiGet([
      LEGACY.PHOTO_IDS, LEGACY.ENGINE_BACKED, LEGACY.ENGINE_LAST_SYNC,
      LEGACY.PHOTO_LAST, LEGACY.AUTO_LAST,
      LEGACY.PHOTO_SETTINGS, LEGACY.AUTO_ENABLED, LEGACY.AUTO_WIFI,
      LEGACY.AUTO_VIDEO, LEGACY.AUTO_QUALITY, LEGACY.ENGINE_SESSIONS,
    ]);
    const vals = entries.map(([, v]) => v);
    const [
      photoIdsRaw, engineBackedRaw, engineLastSync, photoLast, autoLast,
      photoSettingsRaw, autoEnabled, autoWifi, autoVideo, autoQuality, engineSessionsRaw,
    ] = vals;

    // Merge backed-up maps
    const mergedBacked = {};

    // photoBackup stored an array of IDs
    if (photoIdsRaw) {
      try {
        const arr = JSON.parse(photoIdsRaw);
        if (Array.isArray(arr)) {
          arr.forEach(id => { mergedBacked[id] = Date.now(); });
        }
      } catch {}
    }

    // backupEngine + autoBackup stored { assetId: timestamp }
    if (engineBackedRaw) {
      try { Object.assign(mergedBacked, JSON.parse(engineBackedRaw)); } catch {}
    }

    // Merge settings
    let settings = { ...DEFAULT_SETTINGS };
    if (photoSettingsRaw) {
      try { settings = { ...settings, ...JSON.parse(photoSettingsRaw) }; } catch {}
    }
    if (autoEnabled != null) settings.enabled = autoEnabled === 'true';
    if (autoWifi != null) settings.wifiOnly = autoWifi === 'true';
    if (autoVideo != null) settings.includeVideos = autoVideo === 'true';
    if (autoQuality) settings.quality = autoQuality;

    // Best last-sync timestamp
    const lastSync = engineLastSync || photoLast || autoLast || '';

    // Write unified state
    await AsyncStorage.multiSet([
      [KEYS.BACKED_UP_MAP, JSON.stringify(mergedBacked)],
      [KEYS.SETTINGS, JSON.stringify(settings)],
      [KEYS.LAST_SYNC, lastSync],
      [KEYS.UPLOAD_SESSIONS, engineSessionsRaw || '{}'],
      [KEYS.MIGRATION_VERSION, '3'],
    ]);

    // Also write back to legacy keys so any in-flight code sees current data.
    // This is a safety measure during transition.
    await AsyncStorage.setItem(LEGACY.ENGINE_BACKED, JSON.stringify(mergedBacked)).catch(() => {});
    await AsyncStorage.setItem(LEGACY.AUTO_ENABLED, settings.enabled ? 'true' : 'false').catch(() => {});
    // Replica também as outras flags legadas — antes só ENABLED ia, deixando
    // wifi/video/quality dessincronizados em código in-flight.
    await AsyncStorage.multiSet([
      [LEGACY.AUTO_WIFI, settings.wifiOnly ? 'true' : 'false'],
      [LEGACY.AUTO_VIDEO, settings.includeVideos ? 'true' : 'false'],
      [LEGACY.AUTO_QUALITY, settings.quality || ''],
    ]).catch(() => {});

    // Update memory cache
    _cachedMap = mergedBacked;
    _cacheTs = Date.now();

    console.log('[backupStorage] Migration V2 complete:', Object.keys(mergedBacked).length, 'assets tracked');
  } catch (err) {
    console.warn('[backupStorage] Migration error:', err);
  }
}

// ─── Backed-up Map ──────────────────────────────────────────
/**
 * Get the backed-up asset map { assetId: timestamp }.
 * Uses in-memory cache with 30s TTL.
 */
export async function getBackedUpMap() {
  const now = Date.now();
  if (_cachedMap && now - _cacheTs < CACHE_TTL) {
    return _cachedMap;
  }
  try {
    const raw = await AsyncStorage.getItem(KEYS.BACKED_UP_MAP);
    _cachedMap = raw ? JSON.parse(raw) : {};
  } catch {
    _cachedMap = {};
  }
  _cacheTs = Date.now();
  return _cachedMap;
}

/**
 * Save the backed-up asset map. Also updates in-memory cache.
 */
export async function saveBackedUpMap(map) {
  _cachedMap = map;
  _cacheTs = Date.now();
  await AsyncStorage.setItem(KEYS.BACKED_UP_MAP, JSON.stringify(map));
  // Keep legacy key in sync for any in-flight code
  await AsyncStorage.setItem(LEGACY.ENGINE_BACKED, JSON.stringify(map)).catch(() => {});
}

/**
 * Mark a single asset as backed up (in-memory only, call saveBackedUpMap to persist).
 */
export function markAssetBackedUp(map, assetId) {
  map[assetId] = Date.now();
  _cachedMap = map;
  _cacheTs = Date.now();
}

/**
 * Clear the backed-up map (force re-upload everything).
 */
export async function clearBackedUpMap() {
  _cachedMap = {};
  _cacheTs = Date.now();
  await AsyncStorage.removeItem(KEYS.BACKED_UP_MAP);
  await AsyncStorage.removeItem(LEGACY.ENGINE_BACKED).catch(() => {});
}

// ─── Settings ───────────────────────────────────────────────
export async function getSettings() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  const current = await getSettings();
  const merged = { ...current, ...settings };
  await AsyncStorage.setItem(KEYS.SETTINGS, JSON.stringify(merged));
  // Keep legacy keys in sync
  await AsyncStorage.setItem(LEGACY.AUTO_ENABLED, merged.enabled ? 'true' : 'false').catch(() => {});
  await AsyncStorage.setItem(LEGACY.AUTO_WIFI, merged.wifiOnly ? 'true' : 'false').catch(() => {});
  await AsyncStorage.setItem(LEGACY.AUTO_VIDEO, merged.includeVideos ? 'true' : 'false').catch(() => {});
  if (merged.quality) await AsyncStorage.setItem(LEGACY.AUTO_QUALITY, merged.quality).catch(() => {});
  return merged;
}

// ─── Last Sync / Last Run ───────────────────────────────────
export async function getLastSync() {
  try {
    return await AsyncStorage.getItem(KEYS.LAST_SYNC) || null;
  } catch { return null; }
}

export async function setLastSync(isoString) {
  await AsyncStorage.setItem(KEYS.LAST_SYNC, isoString || '');
  // Legacy compat
  await AsyncStorage.setItem(LEGACY.ENGINE_LAST_SYNC, isoString || '').catch(() => {});
  await AsyncStorage.setItem(LEGACY.PHOTO_LAST, isoString || '').catch(() => {});
  await AsyncStorage.setItem(LEGACY.AUTO_LAST, isoString || '').catch(() => {});
}

export async function getLastRun() {
  try {
    return await AsyncStorage.getItem(KEYS.LAST_RUN) || null;
  } catch { return null; }
}

export async function setLastRun(isoString) {
  await AsyncStorage.setItem(KEYS.LAST_RUN, isoString || '');
}

// ─── Upload Sessions ────────────────────────────────────────
export async function getUploadSessions() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.UPLOAD_SESSIONS);
    // Quando o valor salvo é string "null", JSON.parse vira null e o
    // consumidor acessa .key em null → quebra. Garante objeto.
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}

export async function saveUploadSessions(sessions) {
  await AsyncStorage.setItem(KEYS.UPLOAD_SESSIONS, JSON.stringify(sessions));
}

// ─── v2 → v3 migration restore ──────────────────────────────
/**
 * Returns true if a v2 backup snapshot exists (the v3 migration saved the
 * pre-wipe map at `_v2_backup` so the user could recover from the ghost-
 * count fix gone wrong). Used to decide whether to show the Restore button.
 */
export async function hasV2Snapshot() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.BACKED_UP_MAP + '_v2_backup');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0;
  } catch { return false; }
}

/**
 * Restore the v2 snapshot into the current backed-up map. Used from the
 * "Restaurar mapa anterior" button in Settings → Backup. Returns the number
 * of asset IDs merged back in, or -1 if no snapshot existed.
 */
export async function restoreV2Snapshot() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.BACKED_UP_MAP + '_v2_backup');
    if (!raw) return -1;
    const v2map = JSON.parse(raw) || {};
    if (Object.keys(v2map).length === 0) return 0;
    // Merge with the current map (the user may have backed up new photos
    // since the wipe; we don't want to overwrite those timestamps).
    const current = await getBackedUpMap();
    const merged = { ...v2map, ...current };
    await saveBackedUpMap(merged);
    return Object.keys(v2map).length;
  } catch { return -1; }
}

// ─── Full Reset ─────────────────────────────────────────────
export async function resetAllBackupState() {
  _cachedMap = {};
  _cacheTs = Date.now();
  await AsyncStorage.multiRemove([
    KEYS.BACKED_UP_MAP, KEYS.SETTINGS, KEYS.LAST_SYNC,
    KEYS.LAST_RUN, KEYS.UPLOAD_SESSIONS, KEYS.MIGRATION_VERSION,
    // Also clear legacy keys
    LEGACY.PHOTO_IDS, LEGACY.ENGINE_BACKED, LEGACY.ENGINE_LAST_SYNC,
    LEGACY.PHOTO_LAST, LEGACY.AUTO_LAST, LEGACY.PHOTO_SETTINGS,
    LEGACY.AUTO_ENABLED, LEGACY.AUTO_WIFI, LEGACY.AUTO_VIDEO,
    LEGACY.AUTO_QUALITY, LEGACY.ENGINE_SESSIONS,
  ]).catch(() => {});
}

export { DEFAULT_SETTINGS };
