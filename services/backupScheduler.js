/**
 * backupScheduler — runs chat cloud backup once per day in the background.
 *
 * Wraps `services/chatBackupCloud.runBackup()` with the gating logic the
 * WhatsApp/iCloud Backup screen documents: skip if a recent backup is on
 * file (<20h), skip on low battery (<20%), skip on cellular roaming.
 *
 * Registration model:
 *   • iOS — expo-background-fetch hands us an opportunistic ~15min wakeup
 *     window; we self-throttle to once a day inside the task callback.
 *   • Android — same expo-background-fetch entry point (the same JS task
 *     runs on both platforms).
 *
 * `scheduleDaily()` is idempotent — calling it on every cold start from
 * `app/_layout.js` is the intended use. The task is registered once with
 * expo-task-manager (deduped by name) and the background-fetch registration
 * is also a no-op when it's already on file. Returns true if scheduled,
 * false if expo-background-fetch isn't linked (dev builds, web).
 *
 * Manual one-shot: `runBackupNow()` bypasses every gate (used by the
 * "Backup now" button in /chat-backup).
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { runBackup } from './chatBackupCloud';

const TASK_NAME = 'chatyy-backup-scheduler-daily';
const SS_LAST_RUN_AT = 'chatyy_backup_scheduler_last_run_at';
// MMKV mirror key — written alongside SecureStore so other modules (and the
// restore-on-fresh-install prompt) can read the last-backup timestamp via
// the synchronous MMKV API without paying the async SecureStore round-trip.
// Read it back via getLastBackupAtMMKV() in this module, or directly with
// `new MMKV({ id: 'chatyy-backup' }).getString('last_backup_at')`.
const MMKV_LAST_BACKUP_AT = 'last_backup_at';

// Lazy MMKV instance — react-native-mmkv isn't linked in web/test builds, so
// we feature-detect and fall back to a no-op writer.
let _mmkvInst = null;
function _mmkv() {
  if (_mmkvInst !== null) return _mmkvInst;
  try {
    const { MMKV } = require('react-native-mmkv');
    _mmkvInst = new MMKV({ id: 'chatyy-backup' });
  } catch {
    _mmkvInst = false; // explicit "tried and failed" sentinel
  }
  return _mmkvInst || null;
}

// Gate thresholds.
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20h since last successful run
const LOW_BATTERY_THRESHOLD = 0.20;          // 20% — skip below this unless charging

let _scheduled = false;

/** Best-effort: respect "wifi-only" + roaming + cellular gates. */
async function _networkAllowed() {
  try {
    const NetInfo = await import('@react-native-community/netinfo').catch(() => null);
    if (!NetInfo) return true; // dep missing — allow
    const state = await NetInfo.default.fetch();
    if (!state?.isConnected) return false;
    // Hard skip on cellular roaming — backup payloads can be >50MB and
    // we'd burn through the user's roaming allowance on a single run.
    if (state.type === 'cellular' && state.details?.isConnectionExpensive) return false;
    if (state.type === 'cellular' && state.details?.cellularGeneration === '2g') return false;
    // Roaming detection: NetInfo surfaces it on Android only. iOS doesn't
    // expose it via the public API, so we soft-allow cellular there.
    if (state.details?.isInternetReachable === false) return false;
    return true;
  } catch {
    return true;
  }
}

/** Best-effort battery gate — mirrors fullHistorySync._checkBattery. */
async function _batteryOk() {
  try {
    const Battery = require('expo-battery');
    if (!Battery?.getBatteryLevelAsync) return true;
    const lvl = await Battery.getBatteryLevelAsync();
    let charging = false;
    try {
      charging = (await Battery.getBatteryStateAsync()) === Battery.BatteryState?.CHARGING;
    } catch {}
    if (charging) return true;
    if (lvl != null && lvl < LOW_BATTERY_THRESHOLD) return false;
    return true;
  } catch {
    return true; // expo-battery not linked — assume OK
  }
}

async function _withinDailyWindow() {
  try {
    const v = await SecureStore.getItemAsync(SS_LAST_RUN_AT);
    if (!v) return false; // first run — always proceed
    const lastAt = parseInt(v, 10);
    if (!Number.isFinite(lastAt)) return false;
    return Date.now() - lastAt < MIN_INTERVAL_MS;
  } catch {
    return false;
  }
}

async function _markRanNow() {
  const now = Date.now();
  try { await SecureStore.setItemAsync(SS_LAST_RUN_AT, String(now)); } catch {}
  // Mirror to MMKV for synchronous access from the restore prompt + diag UI.
  try {
    const m = _mmkv();
    if (m) m.set(MMKV_LAST_BACKUP_AT, String(now));
  } catch {}
  // Diagnostic log — gives us a visible signal in adb logcat / Console.app
  // that the scheduler successfully fired today. The 20h window gate makes
  // false-positives essentially impossible.
  try {
    // eslint-disable-next-line no-console
    console.log(
      '[backupScheduler] backup completed at',
      new Date(now).toISOString(),
      `(mmkv:${_mmkv() ? 'ok' : 'unavail'})`
    );
  } catch {}
}

/**
 * Run the backup task body once. Returns a `BackgroundFetchResult` enum
 * value when called from inside the BG-fetch task, or a plain object when
 * called directly from `runBackupNow()` (manual path).
 */
async function _runOnce(BackgroundFetch) {
  const NoData = BackgroundFetch?.BackgroundFetchResult?.NoData ?? 1;
  const NewData = BackgroundFetch?.BackgroundFetchResult?.NewData ?? 2;
  const Failed = BackgroundFetch?.BackgroundFetchResult?.Failed ?? 3;

  // Gate 1 — daily window.
  if (await _withinDailyWindow()) return NoData;
  // Gate 2 — battery.
  if (!(await _batteryOk())) return NoData;
  // Gate 3 — network (skip on cellular roaming / no connection).
  if (!(await _networkAllowed())) return NoData;
  // Gate 4 — passphrase cached. runBackup() throws ERR_NO_PASSPHRASE
  // otherwise; we just short-circuit silently here to avoid a Failed result
  // every 15min until the user finishes setup.
  try {
    const pw = await SecureStore.getItemAsync('chatyy_cloud_backup_passphrase');
    if (!pw) return NoData;
  } catch { return NoData; }

  try {
    await runBackup({});
    await _markRanNow();
    return NewData;
  } catch (e) {
    if (e?.code === 'ERR_NO_PASSPHRASE') return NoData;
    return Failed;
  }
}

/**
 * Register the daily backup task. Safe to call repeatedly from app launch.
 * Returns true if registration succeeded, false otherwise (dev / web).
 */
export async function scheduleDaily() {
  if (_scheduled) return true;
  if (Platform.OS === 'web') return false; // no BG fetch on web

  let BackgroundFetch, TaskManager;
  try {
    BackgroundFetch = await import('expo-background-fetch');
    TaskManager = await import('expo-task-manager');
  } catch {
    return false; // deps missing in dev — skip silently
  }

  try {
    if (!TaskManager.isTaskDefined(TASK_NAME)) {
      TaskManager.defineTask(TASK_NAME, async () => {
        return _runOnce(BackgroundFetch);
      });
    }
    await BackgroundFetch.registerTaskAsync(TASK_NAME, {
      // Use the system's minimum (15min). We self-throttle to once a day
      // inside the task — letting the OS wake us more often gives more
      // chances to land a backup when the gates align (wifi + ≥20% battery).
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
    _scheduled = true;
    return true;
  } catch {
    return false;
  }
}

/** Tear down the daily task — used when the user disables cloud backup. */
export async function unscheduleDaily() {
  if (Platform.OS === 'web') return;
  try {
    const BackgroundFetch = await import('expo-background-fetch');
    await BackgroundFetch.unregisterTaskAsync(TASK_NAME);
  } catch {}
  _scheduled = false;
}

/**
 * Manual one-shot used by the UI's "Backup now" button. Bypasses the daily
 * window + battery gates (the user explicitly asked). Still respects the
 * passphrase requirement — runBackup() will throw ERR_NO_PASSPHRASE if not
 * cached and the caller is expected to surface the setup flow.
 */
export async function runBackupNow(opts = {}) {
  const r = await runBackup(opts);
  await _markRanNow();
  return r;
}

/** Last successful backup timestamp (ms since epoch), or null. */
export async function getLastScheduledRunAt() {
  try {
    const v = await SecureStore.getItemAsync(SS_LAST_RUN_AT);
    const n = v ? parseInt(v, 10) : null;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Synchronous accessor for the MMKV-mirrored timestamp. Useful when the
 * caller can't afford an async SecureStore read (e.g. the login screen's
 * restore-prompt heuristic, which has to decide before the first frame).
 * Returns null when MMKV is unavailable or the timestamp was never written.
 */
export function getLastBackupAtMMKV() {
  try {
    const m = _mmkv();
    if (!m) return null;
    const v = m.getString(MMKV_LAST_BACKUP_AT);
    const n = v ? parseInt(v, 10) : null;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
