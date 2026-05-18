/**
 * uploadNotification.js — Ongoing persistent upload notification.
 *
 * Closes gap #1 of the "Notifications 100%" wave. When the user starts a
 * photo backup or large media upload, we present a sticky local notification
 * that:
 *   - Shows current progress (X de Y).
 *   - Is ongoing (Android `setOngoing(true)`) so the user can't swipe it away
 *     while the upload is still running.
 *   - Carries a Cancel action that the JS-side action handler intercepts to
 *     call the registered `onCancel` callback (which actually halts the
 *     uploader queue via autoBackup.pause() / mediaUploader.cancel()).
 *   - Auto-dismisses on complete OR replaces itself with a success
 *     "X de Y fotos enviadas" toast that disappears after 4s.
 *
 * Implementation notes:
 *   - Uses expo-notifications local scheduling. Same notification id is
 *     reused on every progress tick so the OS replaces the row in place
 *     instead of stacking.
 *   - Android channel `upload_progress` is registered lazily on first
 *     `start()` so we don't bloat the cold-start path.
 *   - iOS doesn't expose a sticky/foreground bar via UN. The system
 *     "Uploading..." indicator only appears for NSURLSessionConfiguration
 *     .background URLSessions (which the Swift NativeUpload module already
 *     uses for photo backup) — we still surface a local notification on
 *     iOS so the user knows backup is running when the app is in the
 *     background and they expand Notification Center.
 *   - All Notifications imports are lazy + Platform-gated so the web bundle
 *     doesn't trip on missing native modules.
 *
 * Public API:
 *   start({ id, title, total, onCancel }) → starts the notification
 *   update(id, { current, total, body? })  → tick progress
 *   complete(id, { successCount, total })  → swap to success summary
 *   fail(id, { errorMessage })             → swap to error
 *   cancel(id)                             → dismiss + fire onCancel
 *
 * Action handler is wired automatically when start() is first called.
 */

import { Platform } from 'react-native';

let Notifications = null;
let _channelReady = false;
let _responseSubscription = null;
const _activeUploads = new Map(); // id → { title, total, onCancel }

async function _loadNotifications() {
  if (Platform.OS === 'web') return false;
  if (!Notifications) {
    try {
      Notifications = await import('expo-notifications');
    } catch (e) {
      console.warn('[uploadNotif] expo-notifications missing:', e?.message);
      return false;
    }
  }
  return true;
}

async function _ensureChannel() {
  if (Platform.OS !== 'android' || _channelReady) return;
  if (!(await _loadNotifications())) return;
  try {
    // Importance LOW so the channel never plays a sound or pops a heads-up
    // banner — it should sit silently in the shade like Google Drive's
    // upload progress. Vibration off for the same reason.
    await Notifications.setNotificationChannelAsync('upload_progress', {
      name: 'Backup e upload',
      description: 'Progresso do backup de fotos e uploads grandes',
      importance: Notifications.AndroidImportance.LOW,
      vibrationPattern: null,
      enableVibrate: false,
      enableLights: false,
      sound: null,
      showBadge: false,
    });
    // Category with a Cancel action so users can stop a long upload
    // without opening the app. Identifier matches what the action handler
    // below dispatches on.
    await Notifications.setNotificationCategoryAsync('upload_progress', [
      {
        identifier: 'cancel_upload',
        buttonTitle: 'Cancelar',
        options: { isDestructive: true, isAuthenticationRequired: false },
      },
    ]);
    _channelReady = true;
  } catch (e) {
    console.warn('[uploadNotif] channel setup failed:', e?.message);
  }
}

function _wireResponseHandlerOnce() {
  if (_responseSubscription || !Notifications) return;
  try {
    _responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response?.notification?.request?.content?.data;
      const actionId = response?.actionIdentifier;
      if (!data || data.type !== 'upload_progress') return;
      if (actionId !== 'cancel_upload') return;
      const id = data.upload_id;
      const entry = _activeUploads.get(id);
      if (entry?.onCancel) {
        try { entry.onCancel(); } catch (e) { console.warn('[uploadNotif] onCancel error:', e?.message); }
      }
      // Dismiss immediately — the engine will tick to final state and the
      // success/fail wrapper takes over from there.
      try { Notifications.dismissNotificationAsync(_uniqueRequestId(id)); } catch {}
    });
  } catch (e) {
    console.warn('[uploadNotif] response wire failed:', e?.message);
  }
}

// We reuse a deterministic identifier per upload-id so progress ticks
// REPLACE the previous row instead of stacking.
function _uniqueRequestId(id) {
  return 'upload_progress_' + String(id);
}

function _progressPct(current, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}

function _bodyForProgress(current, total, suffix) {
  const pct = _progressPct(current, total);
  const safeSuffix = suffix ? (' · ' + suffix) : '';
  if (!total || total <= 0) return 'Preparando...' + safeSuffix;
  return `${current} de ${total} (${pct}%)` + safeSuffix;
}

/**
 * Start an ongoing upload notification.
 *
 * @param {object} opts
 * @param {string} opts.id        unique id for this upload session (e.g. 'photo_backup' or 'chat_video_1234')
 * @param {string} opts.title     notification title (e.g. 'Backup do Chatyy')
 * @param {number} opts.total     total items (0 = indeterminate)
 * @param {string} [opts.body]    optional initial body override
 * @param {Function} [opts.onCancel] called when user taps the Cancel action
 */
export async function start({ id, title, total = 0, body, onCancel }) {
  if (Platform.OS === 'web') return;
  if (!(await _loadNotifications())) return;
  await _ensureChannel();
  _wireResponseHandlerOnce();
  _activeUploads.set(id, { title, total, onCancel: typeof onCancel === 'function' ? onCancel : null });
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: _uniqueRequestId(id),
      content: {
        title: title || 'Enviando...',
        body: body || _bodyForProgress(0, total),
        data: { type: 'upload_progress', upload_id: id },
        sticky: true,                     // Android: setOngoing(true)
        autoDismiss: false,
        sound: null,
        categoryIdentifier: 'upload_progress',
        ...(Platform.OS === 'android' ? {
          channelId: 'upload_progress',
          // expo-notifications maps `progress` to NotificationCompat
          //  .setProgress(max, current, indeterminate). 0/0/true = spinner.
          progress: total > 0 ? { max: total, current: 0, indeterminate: false } : { max: 0, current: 0, indeterminate: true },
          color: '#7C3AED',
          priority: Notifications.AndroidNotificationPriority?.LOW || 'low',
        } : {}),
        // iOS: passive interruption so we don't ping the user every tick.
        ...(Platform.OS === 'ios' ? {
          interruptionLevel: 'passive',
        } : {}),
      },
      trigger: null, // present immediately
    });
  } catch (e) {
    console.warn('[uploadNotif] start failed:', e?.message);
  }
}

/**
 * Tick progress. Same identifier replaces the previous row.
 *
 * @param {string} id
 * @param {object} opts
 * @param {number} opts.current
 * @param {number} [opts.total]   if provided, overrides the start() total
 * @param {string} [opts.bodySuffix]  appended to "X de Y (Z%)"
 */
export async function update(id, { current = 0, total, bodySuffix } = {}) {
  if (Platform.OS === 'web') return;
  if (!(await _loadNotifications())) return;
  const entry = _activeUploads.get(id);
  if (!entry) return;
  if (typeof total === 'number') entry.total = total;
  const effTotal = entry.total || 0;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: _uniqueRequestId(id),
      content: {
        title: entry.title || 'Enviando...',
        body: _bodyForProgress(current, effTotal, bodySuffix),
        data: { type: 'upload_progress', upload_id: id },
        sticky: true,
        autoDismiss: false,
        sound: null,
        categoryIdentifier: 'upload_progress',
        ...(Platform.OS === 'android' ? {
          channelId: 'upload_progress',
          progress: effTotal > 0
            ? { max: effTotal, current, indeterminate: false }
            : { max: 0, current: 0, indeterminate: true },
          color: '#7C3AED',
          priority: Notifications.AndroidNotificationPriority?.LOW || 'low',
        } : {}),
        ...(Platform.OS === 'ios' ? { interruptionLevel: 'passive' } : {}),
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[uploadNotif] update failed:', e?.message);
  }
}

/**
 * Wrap the upload with a final success summary. Non-sticky so the user can
 * swipe it away. Auto-dismisses after 6s on Android (iOS leaves it pending).
 */
export async function complete(id, { successCount = 0, total = 0 } = {}) {
  if (Platform.OS === 'web') return;
  if (!(await _loadNotifications())) return;
  const entry = _activeUploads.get(id);
  _activeUploads.delete(id);
  try {
    // First dismiss the ongoing one so we never leave a stale sticky.
    await Notifications.dismissNotificationAsync(_uniqueRequestId(id)).catch(() => {});
  } catch {}
  // Don't show a "0 uploaded" success — silent in that case.
  if (successCount <= 0) return;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: _uniqueRequestId(id) + '_done',
      content: {
        title: entry?.title || 'Backup',
        body: `${successCount} de ${total || successCount} fotos enviadas`,
        data: { type: 'upload_complete', upload_id: id },
        sound: null,
        ...(Platform.OS === 'android' ? {
          channelId: 'upload_progress',
          color: '#10B981',
        } : {}),
        ...(Platform.OS === 'ios' ? { interruptionLevel: 'passive' } : {}),
      },
      trigger: null,
    });
    // Auto-dismiss after 6s — feels less spammy than letting it linger.
    setTimeout(() => {
      try { Notifications.dismissNotificationAsync(_uniqueRequestId(id) + '_done'); } catch {}
    }, 6000);
  } catch (e) {
    console.warn('[uploadNotif] complete failed:', e?.message);
  }
}

/**
 * Swap ongoing notification for an error message. Auto-dismisses after 10s.
 */
export async function fail(id, { errorMessage = 'Falha no envio' } = {}) {
  if (Platform.OS === 'web') return;
  if (!(await _loadNotifications())) return;
  const entry = _activeUploads.get(id);
  _activeUploads.delete(id);
  try {
    await Notifications.dismissNotificationAsync(_uniqueRequestId(id)).catch(() => {});
  } catch {}
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: _uniqueRequestId(id) + '_err',
      content: {
        title: entry?.title || 'Backup',
        body: errorMessage,
        data: { type: 'upload_error', upload_id: id },
        sound: null,
        ...(Platform.OS === 'android' ? {
          channelId: 'upload_progress',
          color: '#ef4444',
        } : {}),
        ...(Platform.OS === 'ios' ? { interruptionLevel: 'passive' } : {}),
      },
      trigger: null,
    });
    setTimeout(() => {
      try { Notifications.dismissNotificationAsync(_uniqueRequestId(id) + '_err'); } catch {}
    }, 10000);
  } catch (e) {
    console.warn('[uploadNotif] fail failed:', e?.message);
  }
}

/**
 * Manual cancellation — fires the onCancel callback and dismisses.
 * Used by code paths that detect cancellation in JS (network gone, user
 * killed the screen, etc) rather than the user tapping the action button.
 */
export async function cancel(id) {
  if (Platform.OS === 'web') return;
  const entry = _activeUploads.get(id);
  _activeUploads.delete(id);
  if (entry?.onCancel) {
    try { entry.onCancel(); } catch {}
  }
  if (!(await _loadNotifications())) return;
  try {
    await Notifications.dismissNotificationAsync(_uniqueRequestId(id));
  } catch {}
}

export default { start, update, complete, fail, cancel };
