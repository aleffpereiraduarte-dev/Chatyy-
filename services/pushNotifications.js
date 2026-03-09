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

// Incoming call callback — set by IncomingCallListener
let _onIncomingCall = null;
export function setIncomingCallHandler(handler) {
  _onIncomingCall = handler;
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
        const data = notification.request?.content?.data;

        // Incoming call: trigger CallKit (iOS) or IncomingCallListener (web/Android)
        if (data?.type === 'incoming_call' && (data?.room_id || data?.call_id)) {
          const callId = data.call_id || data.room_id;
          const callerName = data.caller_name || data.caller_email?.split('@')[0] || 'Unknown';
          const isVideo = data.video === '1' || data.video === true;

          // Try CallKit first (iOS native call screen)
          let usedCallKit = false;
          if (Platform.OS === 'ios') {
            try {
              const { displayIncomingCall } = require('./callkeep');
              usedCallKit = displayIncomingCall(callId, callerName, data.caller_email || '', isVideo);
            } catch {}
          }

          // Also trigger IncomingCallListener for in-app UI
          try {
            const { triggerIncomingCall } = require('../components/IncomingCallListener');
            triggerIncomingCall({
              caller_email: data.caller_email,
              caller_name: data.caller_name,
              conversation_id: data.conversation_id,
              room_id: data.room_id || callId,
              call_id: callId,
              video: isVideo,
            });
          } catch {}

          // Suppress system notification — CallKit or IncomingCallListener handles it
          return {
            shouldShowAlert: !usedCallKit,
            shouldPlaySound: !usedCallKit,
            shouldSetBadge: false,
          };
        }

        // Other notifications in foreground: show toast
        if (_onForegroundNotification && data) {
          _onForegroundNotification({
            title: notification.request.content.title,
            body: notification.request.content.body,
            data,
          });
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

      // Call channel - highest priority with custom ringtone
      await Notifications.setNotificationChannelAsync('calls', {
        name: 'Incoming Calls',
        description: 'Notifications for incoming voice and video calls',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 800, 400, 800, 200, 800, 400, 800, 2000],
        lightColor: '#22c55e',
        sound: 'ringtone.wav',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
        lockscreenVisibility: 1,
        bypassDnd: true,
      });

      // Also keep default channel for backward compat
      await Notifications.setNotificationChannelAsync('default', {
        name: 'General',
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: 'default',
      });
    }

    // Register notification categories with actions
    await Notifications.setNotificationCategoryAsync('chat_message', [
      {
        identifier: 'reply_chat',
        buttonTitle: 'Responder',
        textInput: {
          submitButtonTitle: 'Enviar',
          placeholder: 'Digite uma resposta...',
        },
      },
      {
        identifier: 'mark_read_chat',
        buttonTitle: 'Lida',
        options: { isDestructive: false, isAuthenticationRequired: false },
      },
    ]);

    await Notifications.setNotificationCategoryAsync('new_email', [
      {
        identifier: 'archive',
        buttonTitle: 'Archive',
        options: { isDestructive: false },
      },
      {
        identifier: 'mark_read',
        buttonTitle: 'Mark Read',
        options: { isDestructive: false },
      },
    ]);

    await Notifications.setNotificationCategoryAsync('incoming_call', [
      {
        identifier: 'accept_call',
        buttonTitle: 'Atender',
        options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: true },
      },
      {
        identifier: 'decline_call',
        buttonTitle: 'Recusar',
        options: { isDestructive: true, isAuthenticationRequired: false },
      },
    ]);

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
    if (actionId === 'reply_chat' && data?.conversation_id) {
      const userText = response.userText;
      if (userText?.trim()) {
        handleChatReplyFromNotification(data.conversation_id, userText.trim());
      }
      return;
    }
    if (actionId === 'mark_read_chat' && data?.conversation_id) {
      handleMarkReadChatFromNotification(data.conversation_id);
      return;
    }
    if (actionId === 'accept_call' && (data?.room_id || data?.call_id)) {
      const callId = data.call_id || data.room_id;
      const isVideo = (data.video === '1' || data.video === true) ? '1' : '0';
      // Notify caller via WS that we accepted
      try {
        const mailWs = require('./websocket').default;
        if (mailWs.isConnected) {
          mailWs._send({
            type: 'call_accepted',
            call_id: callId,
            conversation_id: data.conversation_id || '',
            target_email: data.caller_email,
          });
        }
      } catch {}
      router.push(`/call?callId=${callId}&contactName=${encodeURIComponent(data.caller_name || '')}&contactEmail=${encodeURIComponent(data.caller_email || '')}&isVideo=${isVideo}&conversationId=${data.conversation_id || ''}&isCaller=0`);
      return;
    }
    if (actionId === 'decline_call' && (data?.room_id || data?.call_id)) {
      // Notify caller that call was declined
      try {
        const mailWs = require('./websocket').default;
        if (mailWs.isConnected) {
          mailWs._send({
            type: 'call_end',
            call_id: data.call_id || data.room_id,
            target_email: data.caller_email,
            reason: 'declined',
          });
        }
      } catch {}
      return;
    }

    handleNotificationNavigation(data);
  });

  return () => {
    receivedSub?.remove?.();
    responseSub?.remove?.();
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
    if (data.type === 'incoming_call' && (data.room_id || data.call_id)) {
      // Show the incoming call UI
      try {
        const { triggerIncomingCall } = require('../components/IncomingCallListener');
        triggerIncomingCall({
          caller_email: data.caller_email,
          caller_name: data.caller_name,
          conversation_id: data.conversation_id,
          room_id: data.room_id || data.call_id,
          call_id: data.call_id || data.room_id,
          video: data.video === '1' || data.video === true,
        });
      } catch {}
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

async function handleChatReplyFromNotification(conversationId, text) {
  try {
    const { chatSend, chatRead } = require('./api');
    await chatSend(conversationId, text, 'text');
    // Mark as read too
    await chatRead(conversationId, 0);
  } catch (err) {
    console.warn('[Push] Chat reply failed:', err.message);
  }
}

async function handleMarkReadChatFromNotification(conversationId) {
  try {
    const { chatRead } = require('./api');
    await chatRead(conversationId, 0);
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
