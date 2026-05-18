/**
 * liveBroadcastNotification.js — ongoing notification while the user is
 * actively broadcasting a Live. Closes gap #2 of "Notifications 100%".
 *
 * Mirrors WhatsApp / Instagram "Live transmitindo" pill that sits in the
 * notification shade for the duration of the broadcast.
 *
 *   - Android: sticky local notification on a LOW-importance channel so it
 *     stays in the shade without nagging. setOngoing(true) prevents swipe-
 *     dismiss while the broadcast is running. Tapping returns the user to
 *     /live-broadcast.
 *   - iOS:  passive UNNotification (interruptionLevel='passive') so iOS
 *     surfaces it in Notification Center but never as a banner. Lives until
 *     stop() is called (or the user opts to dismiss after broadcast ends).
 *     A foreground task or AVAudioSession.background category is what
 *     actually keeps the publisher running — that's already handled by the
 *     RTMP / LiveKit native modules. This notification is a UX surface, not
 *     the keep-alive mechanism.
 *
 * Public API:
 *   start({ sessionId, title })   start ongoing
 *   updateViewers(sessionId, n)   refresh body with "X assistindo"
 *   stop(sessionId)               dismiss
 *
 * Tap returns to live broadcast via the deep_link in the data payload —
 * services/pushNotifications.js already routes type=live_broadcast_self
 * through router.push('/live-broadcast?session_id=...').
 */

import { Platform } from 'react-native';

let Notifications = null;
let _channelReady = false;
const _activeBroadcasts = new Map(); // sessionId → { title, viewers }

async function _loadNotifications() {
  if (Platform.OS === 'web') return false;
  if (!Notifications) {
    try {
      Notifications = await import('expo-notifications');
    } catch (e) {
      console.warn('[liveBroadcastNotif] expo-notifications missing:', e?.message);
      return false;
    }
  }
  return true;
}

async function _ensureChannel() {
  if (Platform.OS !== 'android' || _channelReady) return;
  if (!(await _loadNotifications())) return;
  try {
    // LOW importance: ongoing pill that NEVER buzzes / pings. Same vibe as
    // Google Meet "Ongoing call" or YouTube Live's broadcast pill.
    await Notifications.setNotificationChannelAsync('live_broadcast_self', {
      name: 'Transmissão ao vivo (sua)',
      description: 'Notificação persistente enquanto você está transmitindo',
      importance: Notifications.AndroidImportance.LOW,
      vibrationPattern: null,
      enableVibrate: false,
      enableLights: true,
      lightColor: '#dc2626',
      sound: null,
      showBadge: false,
    });
    _channelReady = true;
  } catch (e) {
    console.warn('[liveBroadcastNotif] channel setup failed:', e?.message);
  }
}

function _notifId(sessionId) {
  return 'live_broadcast_self_' + String(sessionId);
}

function _body(viewers) {
  if (typeof viewers !== 'number' || viewers < 0) return 'Toque para voltar ao estúdio';
  if (viewers === 0) return 'Aguardando o primeiro espectador...';
  if (viewers === 1) return '1 pessoa assistindo · Toque para voltar';
  return `${viewers} pessoas assistindo · Toque para voltar`;
}

/**
 * Surface the ongoing-broadcast pill. Idempotent — calling start() with
 * the same sessionId just refreshes the row.
 */
export async function start({ sessionId, title }) {
  if (Platform.OS === 'web' || !sessionId) return;
  if (!(await _loadNotifications())) return;
  await _ensureChannel();
  _activeBroadcasts.set(sessionId, { title: title || 'Transmitindo ao vivo', viewers: 0 });
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: _notifId(sessionId),
      content: {
        title: '🔴 ' + (title || 'Transmitindo ao vivo'),
        body: _body(0),
        data: {
          type: 'live_broadcast_self',
          session_id: String(sessionId),
        },
        sticky: true,
        autoDismiss: false,
        sound: null,
        ...(Platform.OS === 'android' ? {
          channelId: 'live_broadcast_self',
          color: '#dc2626',
          priority: Notifications.AndroidNotificationPriority?.LOW || 'low',
        } : {}),
        ...(Platform.OS === 'ios' ? { interruptionLevel: 'passive' } : {}),
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[liveBroadcastNotif] start failed:', e?.message);
  }
}

/**
 * Tick viewer count (called from the host's WS viewer_count event handler).
 * Throttle in the caller — every-second is overkill.
 */
export async function updateViewers(sessionId, viewers) {
  if (Platform.OS === 'web' || !sessionId) return;
  if (!(await _loadNotifications())) return;
  const entry = _activeBroadcasts.get(sessionId);
  if (!entry) return;
  if (entry.viewers === viewers) return;
  entry.viewers = viewers;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: _notifId(sessionId),
      content: {
        title: '🔴 ' + (entry.title || 'Transmitindo ao vivo'),
        body: _body(viewers),
        data: { type: 'live_broadcast_self', session_id: String(sessionId) },
        sticky: true,
        autoDismiss: false,
        sound: null,
        ...(Platform.OS === 'android' ? {
          channelId: 'live_broadcast_self',
          color: '#dc2626',
          priority: Notifications.AndroidNotificationPriority?.LOW || 'low',
        } : {}),
        ...(Platform.OS === 'ios' ? { interruptionLevel: 'passive' } : {}),
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[liveBroadcastNotif] updateViewers failed:', e?.message);
  }
}

/**
 * Dismiss the broadcast pill. Called when the host ends the stream.
 */
export async function stop(sessionId) {
  if (Platform.OS === 'web' || !sessionId) return;
  _activeBroadcasts.delete(sessionId);
  if (!(await _loadNotifications())) return;
  try {
    await Notifications.dismissNotificationAsync(_notifId(sessionId));
  } catch {}
}

export default { start, updateViewers, stop };
