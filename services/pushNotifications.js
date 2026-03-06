import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';

let Notifications = null;
let Device = null;

// Foreground notification callback — set by _layout to show in-app toast
let _onForegroundNotification = null;
export function setForegroundNotificationHandler(handler) {
  _onForegroundNotification = handler;
}

// Trigger the foreground toast directly (used on web where native notifications are unavailable)
export function _triggerForegroundToast(notif) {
  if (_onForegroundNotification && notif) {
    _onForegroundNotification(notif);
  }
}

// Lazy-load native modules (avoid crash on web)
async function loadModules() {
  if (Platform.OS === 'web') return false;
  if (!Notifications) {
    Notifications = await import('expo-notifications');
    Device = await import('expo-device');
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        // If app is in foreground, show our custom toast instead of system notification
        const data = notification.request?.content?.data;
        if (_onForegroundNotification && data) {
          _onForegroundNotification({
            title: notification.request.content.title,
            body: notification.request.content.body,
            data,
          });
          // Still show system notification but silently (no sound/alert if foreground toast shown)
          return {
            shouldShowAlert: false,
            shouldPlaySound: false,
            shouldSetBadge: true,
          };
        }
        return {
          shouldShowAlert: true,
          shouldPlaySound: true,
          shouldSetBadge: true,
        };
      },
    });
  }
  return true;
}

export async function registerForPushNotifications() {
  try {
    const loaded = await loadModules();
    if (!loaded) return null;

    if (!Device.isDevice) {
      console.warn('[Push] Must use physical device');
      return null;
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
          allowProvisional: false,
        },
      });
      finalStatus = status;
    }

    if (finalStatus !== 'granted') return null;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });

    // Android notification channels
    if (Platform.OS === 'android') {
      // Main email channel
      await Notifications.setNotificationChannelAsync('email', {
        name: 'New Emails',
        description: 'Notifications for new emails',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 100, 200],
        lightColor: '#2563eb',
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
      });

      // Chat channel
      await Notifications.setNotificationChannelAsync('chat', {
        name: 'Chat Messages',
        description: 'Notifications for new chat messages',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 150, 80, 150],
        lightColor: '#10b981',
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
      });

      // Also keep default channel for backward compat
      await Notifications.setNotificationChannelAsync('default', {
        name: 'General',
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: 'default',
      });
    }

    return tokenData.data;
  } catch (err) {
    console.warn('[Push] Registration failed:', err.message);
    return null;
  }
}

export async function sendTokenToBackend(pushToken) {
  if (!pushToken) return;
  try {
    const { apiCall } = require('./api');
    await apiCall('register_push_token', { token: pushToken, platform: Platform.OS }, 'POST');
  } catch (err) {
    console.warn('[Push] Token send failed:', err.message);
  }
}

export async function removeTokenFromBackend(pushToken) {
  if (!pushToken) return;
  try {
    const { apiCall } = require('./api');
    await apiCall('unregister_push_token', { token: pushToken }, 'POST');
  } catch {}
}

export async function setupNotificationListeners() {
  const loaded = await loadModules();
  if (!loaded) return () => {};

  const receivedSub = Notifications.addNotificationReceivedListener((notification) => {
    // Foreground handling is done in setNotificationHandler above
  });

  const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    const actionId = response.actionIdentifier;

    // Handle notification action buttons
    if (actionId === 'archive' && data?.uid) {
      handleArchiveFromNotification(data);
      return;
    }
    if (actionId === 'mark_read' && data?.uid) {
      handleMarkReadFromNotification(data);
      return;
    }

    handleNotificationNavigation(data);
  });

  return () => {
    Notifications.removeNotificationSubscription(receivedSub);
    Notifications.removeNotificationSubscription(responseSub);
  };
}

function handleNotificationNavigation(data) {
  if (!data) return;
  try {
    if (data.type === 'new_email' && data.uid) {
      // Navigate to the specific email
      const folder = data.folder || 'INBOX';
      router.push(`/read?uid=${data.uid}&folder=${encodeURIComponent(folder)}`);
      return;
    }
    if (data.type === 'meeting_reminder' && data.room_id) {
      router.push(`/meeting-detail?room_id=${data.room_id}`);
      return;
    }
    if (data.type === 'chat_message' && data.conversation_id) {
      router.push(`/chat-conversation?id=${data.conversation_id}`);
      return;
    }
    router.push('/inbox');
  } catch (err) {
    console.warn('[Push] Nav error:', err.message);
  }
}

async function handleArchiveFromNotification(data) {
  try {
    const { apiCall } = require('./api');
    await apiCall('move', { uid: data.uid, folder: data.folder || 'INBOX', destination: 'Archive' }, 'POST');
  } catch {}
}

async function handleMarkReadFromNotification(data) {
  try {
    const { apiCall } = require('./api');
    await apiCall('mark_read', { uid: data.uid, folder: data.folder || 'INBOX' }, 'POST');
  } catch {}
}

// Badge management
export async function clearBadge() {
  try {
    const loaded = await loadModules();
    if (!loaded) return;
    await Notifications.setBadgeCountAsync(0);
  } catch {}
}

export async function setBadgeCount(count) {
  try {
    const loaded = await loadModules();
    if (!loaded) return;
    await Notifications.setBadgeCountAsync(count);
  } catch {}
}
