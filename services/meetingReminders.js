import { Platform } from 'react-native';
import { meetList } from './api';

const REMINDER_PREFIX = 'meet-reminder-';
let scheduledMeetings = new Set();

let Notifications = null;

async function loadNotifications() {
  if (Platform.OS === 'web') return false;
  if (!Notifications) {
    Notifications = await import('expo-notifications');
  }
  return true;
}

// Schedule a local notification 5 min before a meeting
async function scheduleReminder(meeting) {
  const id = meeting.room_id || meeting.id;
  if (scheduledMeetings.has(id)) return;

  const scheduledAt = new Date(meeting.scheduled_at);
  const reminderTime = new Date(scheduledAt.getTime() - 5 * 60 * 1000); // 5 min before
  const now = new Date();

  // Don't schedule if already past or less than 30s away
  if (reminderTime.getTime() - now.getTime() < 30000) return;

  try {
    const loaded = await loadNotifications();
    if (!loaded) return;

    await Notifications.scheduleNotificationAsync({
      identifier: REMINDER_PREFIX + id,
      content: {
        title: 'Reuniao em 5 minutos',
        body: meeting.title || 'Reuniao sem titulo',
        data: { type: 'meeting_reminder', room_id: id },
        sound: true,
        ...(Platform.OS === 'android' ? { channelId: 'meetings' } : {}),
      },
      trigger: { date: reminderTime },
    });
    scheduledMeetings.add(id);
  } catch (e) {
    console.warn('[MeetReminder] Failed to schedule:', e);
  }
}

// Cancel a specific reminder
async function cancelReminder(roomId) {
  try {
    const loaded = await loadNotifications();
    if (!loaded) return;
    await Notifications.cancelScheduledNotificationAsync(REMINDER_PREFIX + roomId);
    scheduledMeetings.delete(roomId);
  } catch {}
}

// Sync all upcoming meetings with reminders
export async function syncMeetingReminders() {
  if (Platform.OS === 'web') return; // No local notifications on web

  try {
    const res = await meetList('upcoming');
    if (!res?.success) return;

    const meetings = res.data?.meetings || [];
    const now = new Date();

    // Cancel reminders for meetings that no longer exist
    const currentIds = new Set(meetings.map(m => m.room_id || m.id));
    for (const id of scheduledMeetings) {
      if (!currentIds.has(id)) {
        await cancelReminder(id);
      }
    }

    // Schedule reminders for upcoming meetings
    for (const meeting of meetings) {
      if (!meeting.scheduled_at) continue;
      const scheduledAt = new Date(meeting.scheduled_at);
      if (scheduledAt > now) {
        await scheduleReminder(meeting);
      }
    }
  } catch (e) {
    console.warn('[MeetReminder] Sync failed:', e);
  }
}

// Setup Android notification channel for meetings
export async function setupMeetingChannel() {
  if (Platform.OS !== 'android') return;
  try {
    const loaded = await loadNotifications();
    if (!loaded) return;
    await Notifications.setNotificationChannelAsync('meetings', {
      name: 'Lembretes de Reuniao',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
    });
  } catch {}
}

// Initialize — call on app startup
export async function initMeetingReminders() {
  await setupMeetingChannel();
  await syncMeetingReminders();
}

export { cancelReminder };
