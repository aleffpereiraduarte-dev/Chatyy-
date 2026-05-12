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

// Active conversation tracker — set by chat-conversation.js to suppress notifications for the open chat
let _activeConversationId = null;
export function setActiveConversation(conversationId) {
  _activeConversationId = conversationId;
}
export function clearActiveConversation() {
  _activeConversationId = null;
}
// Exposed so ChatListTab can also skip bumping unread_count for messages
// arriving INTO the conversation the user is currently viewing — without
// this, every WS message inside the open chat re-incremented the list's
// unread badge to 1+ and a back-press surfaced "X unread" for a thread
// you literally just finished reading (reported 2026-05-12).
export function getActiveConversation() {
  return _activeConversationId;
}

// Incoming call callback — set by IncomingCallListener
let _onIncomingCall = null;
export function setIncomingCallHandler(handler) {
  _onIncomingCall = handler;
}

// Internal state for native device FCM/APNs token. Declared up here (not
// further down) so that registerForPushNotifications() can safely mutate
// it without any TDZ / declaration-order risk.
const pushNotificationsState = {
  deviceToken: null,
};

// Trigger the foreground toast directly (used on web where native notifications are unavailable)
export function _triggerForegroundToast(notif) {
  if (_onForegroundNotification && notif) {
    _onForegroundNotification(notif);
  }
}

// Load native modules (avoid crash on web)
// Called eagerly on native to ensure notification handler is set before any push arrives
async function loadModules() {
  if (Platform.OS === 'web') return false;
  if (!Notifications) {
    Notifications = await import('expo-notifications');
    Device = await import('expo-device');
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data = notification.request?.content?.data;

        // Silent sync push — background data refresh, no visible notification
        if (data?.type === 'silent_sync') {
          triggerBackgroundSync(data);
          return {
            shouldShowAlert: false,
            shouldPlaySound: false,
            shouldSetBadge: false,
          };
        }

        // Login challenge: show verification prompt on existing device
        if (data?.type === 'login_challenge' && data?.challenge_id) {
          try {
            const { triggerLoginChallengePrompt } = require('../components/LoginChallengePrompt');
            triggerLoginChallengePrompt(data);
          } catch {}
          return {
            shouldShowAlert: true,
            shouldPlaySound: true,
            shouldSetBadge: false,
          };
        }

        // Incoming call: trigger IncomingCallListener (in-app UI with ringtone)
        if (data?.type === 'incoming_call' && (data?.room_id || data?.call_id)) {
          const callId = data.call_id || data.room_id;
          const isVideo = data.video === '1' || data.video === true;

          // ALWAYS try to trigger in-app call UI — don't check isCallActive here
          // (it might be stuck true from a previous call that didn't clean up)
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

          // Suppress system notification — IncomingCallListener handles it with full-screen UI
          return {
            shouldShowAlert: false,
            shouldPlaySound: false,
            shouldSetBadge: false,
          };
        }

        // Suppress notification if the user is already viewing this conversation
        if (_activeConversationId && data?.conversation_id &&
            String(data.conversation_id) === String(_activeConversationId)) {
          return {
            shouldShowAlert: false,
            shouldPlaySound: false,
            shouldSetBadge: false,
          };
        }

        // Per-conversation notification settings (set in
        // ChatNotificationSettingsSheet → cached locally as JSON in
        // AsyncStorage so we can read it sync-ish from this handler).
        // Honors:
        //  - mute_until: silence message-typed pushes when in window
        //  - mention_exception (groups only): bypass mute on @everyone /
        //    @currentEmail mentions so the user still hears important calls
        //  - notify_messages: master switch — overrides everything
        //  - preview: redact body when off (matches WhatsApp "Hide preview")
        if (data?.conversation_id && data?.type === 'chat_message') {
          const convSettings = await _readConvSettings(data.conversation_id);
          if (convSettings) {
            // Master switch off → silent no matter what
            if (convSettings.notify_messages === false) {
              return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: true };
            }
            const mutedNow = _isMutedNow(convSettings.mute_until);
            const mentioned = await _pushMentionsCurrentUser(data, notification.request?.content);
            const allowMention = mutedNow && convSettings.mention_exception !== false && mentioned;
            if (mutedNow && !allowMention) {
              // Silent — the badge still increments so the chat list shows it.
              return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: true };
            }
            // Sound/vibration overrides flow through Android channels — here
            // we just gate alert/sound globally. "silent" sound silences the
            // foreground tone; vibration off is honored at OS level.
            const wantSound = convSettings.sound !== 'silent';
            // Foreground toast: redact body when preview is disabled.
            if (_onForegroundNotification) {
              const body = convSettings.preview === false
                ? null
                : notification.request.content.body;
              _onForegroundNotification({
                title: notification.request.content.title,
                body,
                data,
              });
              return {
                shouldShowAlert: false,
                shouldPlaySound: wantSound,
                shouldSetBadge: true,
              };
            }
            return {
              shouldShowAlert: true,
              shouldPlaySound: wantSound,
              shouldSetBadge: true,
            };
          }
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

// Read per-conversation notification settings from the local cache mirror
// that ChatNotificationSettingsSheet writes on save. Best-effort — returns
// null if no AsyncStorage entry exists, in which case the handler falls
// through to the default "show alert + play sound" path.
async function _readConvSettings(conversationId) {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const raw = await AsyncStorage.getItem(`chat_notif_settings_${conversationId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _isMutedNow(muteUntil) {
  if (!muteUntil) return false;
  const t = Date.parse(muteUntil);
  if (!Number.isFinite(t)) return false;
  return t > Date.now();
}

// Returns true when the incoming chat-message push contains an @mention
// addressed to the currently-active user. Inspects:
//   - data.mentions  (array of emails sent by the backend, fast path)
//   - data.mention_everyone (server-set when message has @everyone/@all)
//   - notification body fallback for "@username" / "@email" — covers older
//     server payloads that don't ship a mentions[] hint.
async function _pushMentionsCurrentUser(data, content) {
  try {
    if (data?.mention_everyone === '1' || data?.mention_everyone === true) return true;
    let me = '';
    try {
      const { getActiveAccountEmail } = require('./api');
      me = (typeof getActiveAccountEmail === 'function' ? getActiveAccountEmail() : '') || '';
    } catch {}
    if (!me) return false;
    me = String(me).toLowerCase();
    if (Array.isArray(data?.mentions)) {
      const list = data.mentions.map(m => String(m || '').toLowerCase());
      if (list.includes(me) || list.includes('everyone') || list.includes('all')) return true;
    }
    const body = String(content?.body || '').toLowerCase();
    if (!body) return false;
    if (body.includes('@everyone') || body.includes('@all')) return true;
    const username = me.split('@')[0];
    // Word-boundary match — prevents a body like "@usernamefoo" matching
    // "username". Also matches the full email form ("@user@domain").
    const re = new RegExp(`@(${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'i');
    return re.test(body);
  } catch {
    return false;
  }
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

    // Em standalone production builds expoConfig pode estar undefined —
    // easConfig.projectId é o fallback documentado.
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });

    // Android notification channels
    if (Platform.OS === 'android') {
      // Main email channel
      await Notifications.setNotificationChannelAsync('email', {
        name: 'New Emails',
        description: 'Notifications for new emails',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 100, 200],
        lightColor: '#7C3AED',
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

      // Social channel (likes, comments, follows, mentions) — low priority to avoid noise
      await Notifications.setNotificationChannelAsync('social', {
        name: 'Social',
        description: 'Likes, comentários, seguidores e menções',
        importance: Notifications.AndroidImportance.LOW,
        vibrationPattern: [0, 100],
        lightColor: '#f59e0b',
        sound: 'default',
        enableLights: true,
        enableVibrate: false,
        showBadge: true,
      });

      // (Removed duplicate 'email' channel that re-registered at DEFAULT
      //  importance right after the HIGH one above — Android overrode the
      //  HIGH priority with DEFAULT, silently dropping email notifications
      //  into the low-priority bucket.)

      // Also keep default channel for backward compat
      await Notifications.setNotificationChannelAsync('default', {
        name: 'General',
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: 'default',
      });
    }

    // Register notification categories with actions
    await Notifications.setNotificationCategoryAsync('EMAIL', [
      {
        identifier: 'REPLY',
        buttonTitle: 'Responder',
        options: { opensAppToForeground: true },
      },
      {
        identifier: 'ARCHIVE',
        buttonTitle: 'Arquivar',
        options: { isDestructive: false },
      },
      {
        identifier: 'DELETE',
        buttonTitle: 'Excluir',
        options: { isDestructive: true },
      },
    ]);

    await Notifications.setNotificationCategoryAsync('CHAT', [
      {
        identifier: 'REPLY',
        buttonTitle: 'Responder',
        textInput: {
          submitButtonTitle: 'Enviar',
          placeholder: 'Mensagem...',
        },
      },
      {
        identifier: 'MARK_READ',
        buttonTitle: 'Marcar como lido',
      },
    ]);

    // chat_message — canonical category sent by backend (firebase_push.php sets
    // categoryId: 'chat_message' in the FCM data payload when type === 'chat_message').
    // WhatsApp/iMessage-style quick reply: user types inline without opening app.
    // expo-notifications maps this to a RemoteInput action on Android FCM too.
    await Notifications.setNotificationCategoryAsync('chat_message', [
      {
        identifier: 'reply',
        buttonTitle: 'Responder',
        textInput: {
          submitButtonTitle: 'Enviar',
          placeholder: 'Mensagem...',
        },
        options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: false },
      },
      {
        identifier: 'mark_read',
        buttonTitle: 'Marcar como lido',
        options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: false },
      },
    ]);

    await Notifications.setNotificationCategoryAsync('new_email', [
      {
        identifier: 'archive',
        buttonTitle: 'Arquivar',
        options: { isDestructive: false },
      },
      {
        identifier: 'mark_read',
        buttonTitle: 'Marcar como lido',
        options: { isDestructive: false },
      },
    ]);

    // email_new — canonical category ID sent by the backend (matches categoryId in FCM payload)
    await Notifications.setNotificationCategoryAsync('email_new', [
      {
        identifier: 'REPLY',
        buttonTitle: 'Responder',
        options: { opensAppToForeground: true },
      },
      {
        identifier: 'ARCHIVE',
        buttonTitle: 'Arquivar',
        options: { isDestructive: false },
      },
      {
        identifier: 'DELETE',
        buttonTitle: 'Excluir',
        options: { isDestructive: true },
      },
    ]);

    // chat_mention — @mention in a group; opens conversation directly
    await Notifications.setNotificationCategoryAsync('chat_mention', [
      {
        identifier: 'REPLY',
        buttonTitle: 'Responder',
        textInput: {
          submitButtonTitle: 'Enviar',
          placeholder: 'Responder menção...',
        },
      },
      {
        identifier: 'MARK_READ',
        buttonTitle: 'Marcar como lido',
        options: { isDestructive: false, isAuthenticationRequired: false },
      },
    ]);

    // feed_like / feed_comment / feed_follow — social actions (view only, no text reply)
    for (const cat of ['feed_like', 'feed_comment', 'feed_follow']) {
      await Notifications.setNotificationCategoryAsync(cat, [
        {
          identifier: 'VIEW',
          buttonTitle: 'Ver',
          options: { opensAppToForeground: true },
        },
      ]);
    }

    // live_start — someone started a Live broadcast
    await Notifications.setNotificationCategoryAsync('live_start', [
      {
        identifier: 'JOIN',
        buttonTitle: 'Entrar ao vivo',
        options: { opensAppToForeground: true },
      },
      {
        identifier: 'DISMISS',
        buttonTitle: 'Ignorar',
        options: { isDestructive: false },
      },
    ]);

    await Notifications.setNotificationCategoryAsync('incoming_call', [
      {
        identifier: 'accept_call',
        buttonTitle: 'Accept',
        options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: true },
      },
      {
        identifier: 'decline_call',
        buttonTitle: 'Decline',
        options: { isDestructive: true, isAuthenticationRequired: false },
      },
    ]);

    // On Android, also get the raw device FCM token.
    // This is needed for incoming call notifications: data-only FCM messages
    // must be sent directly to the FCM token (not via Expo Push) to ensure
    // they reach our CallFirebaseMessagingService when the app is killed.
    if (Platform.OS === 'android') {
      // Reset any stale value from a previous registration attempt so we
      // never register a token that belongs to a different install.
      pushNotificationsState.deviceToken = null;

      // Try up to twice — Firebase's first install handshake is sometimes
      // not ready by the time the JS bundle calls into it, especially on
      // cold start. A 1s wait + single retry covers that window without
      // blocking the main token registration if FCM is genuinely broken.
      let deviceToken = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          deviceToken = await Notifications.getDevicePushTokenAsync();
          console.warn(
            '[Push] Android FCM token result (attempt ' + attempt + '):',
            deviceToken && typeof deviceToken === 'object'
              ? { type: deviceToken.type, hasData: !!deviceToken.data, dataLen: deviceToken.data ? String(deviceToken.data).length : 0 }
              : deviceToken
          );
          if (deviceToken?.data) break;
        } catch (err) {
          console.warn('[Push] Failed to get device FCM token (attempt ' + attempt + '):', err?.message || err);
          deviceToken = null;
        }
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      if (deviceToken?.data) {
        pushNotificationsState.deviceToken = deviceToken.data;
        console.warn('[Push] Android FCM device token registered locally (type=' + (deviceToken.type || 'unknown') + ')');
      } else {
        console.warn('[Push] Android FCM device token UNAVAILABLE after retry — backend will not receive fcm_device token. Check google-services.json package_name and Firebase project.');
      }
    }

    try { _setCachedPushToken(tokenData.data); } catch {}
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

    // Also register the raw FCM device token for Android incoming calls
    if (Platform.OS === 'android') {
      if (pushNotificationsState.deviceToken) {
        console.warn('[Push] Sending Android fcm_device token to backend (len=' + String(pushNotificationsState.deviceToken).length + ')');
        await apiCall('register_push_token', {
          token: pushNotificationsState.deviceToken,
          platform: 'android',
          token_type: 'fcm_device',
        }, 'POST');
      } else {
        console.warn('[Push] Skipping fcm_device registration — pushNotificationsState.deviceToken is empty. Android calls (and FCM-direct payloads) will not work for this install.');
      }
    }
  } catch (err) {
    console.warn('[Push] Token send failed:', err?.message || err);
  }
}

// Cache the Expo push token from the most recent getExpoPushTokenAsync()
// call so logout can pass it to removeTokenFromBackend() without a fresh
// Notifications call (which would fail if permission just got revoked).
let _cachedPushToken = null;
export function _setCachedPushToken(tok) { _cachedPushToken = tok || null; }
export function getCachedPushToken() { return _cachedPushToken; }

export async function removeTokenFromBackend(pushToken) {
  const tok = pushToken || _cachedPushToken;
  const { apiCall } = require('./api');
  // 1. Token-specific revoke (preserves other devices on the same account).
  if (tok) {
    try { await apiCall('unregister_push_token', { token: tok }, 'POST'); } catch {}
  }
  // 2. Privacy fallback: when the cached token was lost (app reload, fresh
  // install, permission revoked) the call above can't identify what to
  // remove. Logout is an explicit "stop pushing me on this device" signal,
  // so we wipe ALL of this user's tokens. Other devices the user is
  // logged into will re-register on next foreground via sendTokenToBackend,
  // so the only window of missed pushes is until they next open the app.
  try { await apiCall('unregister_all_my_push_tokens', {}, 'POST'); } catch {}
  _cachedPushToken = null;
}

export async function setupNotificationListeners() {
  const loaded = await loadModules();
  if (!loaded) return () => {};

  // Explicitly request permissions early so iOS prompts on first launch
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    if (existingStatus !== 'granted') {
      await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
          allowProvisional: false,
        },
      });
    }
  } catch {}

  const receivedSub = Notifications.addNotificationReceivedListener((notification) => {
    // When a push arrives in foreground, emit event so chat can refresh instantly
    const data = notification.request?.content?.data;
    if (data?.conversation_id) {
      // Trigger immediate message fetch for this conversation
      try {
        const ws = require('./websocket').default;
        if (ws) {
          ws._emit('push_chat_refresh', { conversation_id: data.conversation_id });
        }
      } catch {}
    }
  });

  const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    const actionId = response.actionIdentifier;

    // Handle notification action buttons (new + legacy identifiers)

    // EMAIL: Reply (opens app to compose)
    if (actionId === 'REPLY' && data?.uid) {
      const folder = data.folder || 'INBOX';
      router.push(`/compose?replyUid=${data.uid}&folder=${encodeURIComponent(folder)}`);
      return;
    }
    // EMAIL: Archive
    if ((actionId === 'ARCHIVE' || actionId === 'archive') && data?.uid) {
      handleArchiveFromNotification(data);
      return;
    }
    // EMAIL: Delete
    if (actionId === 'DELETE' && data?.uid) {
      handleDeleteFromNotification(data);
      return;
    }
    // EMAIL: Mark read (legacy)
    if (actionId === 'mark_read' && data?.uid) {
      handleMarkReadFromNotification(data);
      return;
    }
    // CHAT: Reply with text input (WhatsApp/iMessage-style quick reply).
    // Accepts canonical `reply` (chat_message category) plus legacy `REPLY`/`reply_chat`.
    if ((actionId === 'reply' || actionId === 'REPLY' || actionId === 'reply_chat') && data?.conversation_id) {
      const userText = response.userText;
      if (userText?.trim()) {
        handleChatReplyFromNotification(data.conversation_id, userText.trim());
      }
      return;
    }
    // CHAT: Mark as read. `mark_read` is shared with the email legacy handler above,
    // but that branch guards on `data?.uid` so chat pushes (with `conversation_id`) fall through here.
    if ((actionId === 'mark_read' || actionId === 'MARK_READ' || actionId === 'mark_read_chat') && data?.conversation_id) {
      handleMarkReadChatFromNotification(data.conversation_id);
      return;
    }
    // FEED/SOCIAL: View post or profile
    if (actionId === 'VIEW') {
      handleViewFromNotification(data);
      return;
    }
    // LIVE: Join broadcast
    if (actionId === 'JOIN' && data?.session_id) {
      handleJoinLiveFromNotification(data);
      return;
    }
    if (actionId === 'accept_call' && (data?.room_id || data?.call_id)) {
      const callId = data.call_id || data.room_id;
      const isVideo = (data.video === '1' || data.video === true) ? '1' : '0';
      // CRITICAL: Set callActive BEFORE anything else — prevents IncomingCallListener
      // from showing the Modal when WS reconnects and delivers the pending call_invite
      try {
        const { setCallActive, dismissIncomingCall } = require('../components/IncomingCallListener');
        setCallActive(true);
        dismissIncomingCall();
      } catch {}
      // Dismiss all system notifications
      try { Notifications.dismissAllNotificationsAsync(); } catch {}
      // Send call_accepted via WS — retry if not connected yet (app may be waking up)
      const sendAccepted = () => {
        try {
          const mailWs = require('./websocket').default;
          if (mailWs.isConnected) {
            mailWs._send({
              type: 'call_accepted',
              call_id: callId,
              conversation_id: data.conversation_id || '',
              target_email: data.caller_email,
            });
            return true;
          }
        } catch {}
        return false;
      };
      if (!sendAccepted()) {
        // WS not connected yet — retry after 1s and 3s (app waking from background)
        setTimeout(sendAccepted, 1000);
        setTimeout(sendAccepted, 3000);
      }
      router.push(`/call?callId=${callId}&contactName=${encodeURIComponent(data.caller_name || '')}&contactEmail=${encodeURIComponent(data.caller_email || '')}&isVideo=${isVideo}&conversationId=${data.conversation_id || ''}&isCaller=0`);
      return;
    }
    if (actionId === 'decline_call' && (data?.room_id || data?.call_id)) {
      // Dismiss in-app call UI
      try {
        const { dismissIncomingCall } = require('../components/IncomingCallListener');
        dismissIncomingCall();
      } catch {}
      // Dismiss all system notifications
      try { Notifications.dismissAllNotificationsAsync(); } catch {}
      // Send decline via WS — retry if not connected yet
      const sendDecline = () => {
        try {
          const mailWs = require('./websocket').default;
          if (mailWs.isConnected) {
            mailWs._send({
              type: 'call_end',
              call_id: data.call_id || data.room_id,
              target_email: data.caller_email,
              reason: 'declined',
            });
            return true;
          }
        } catch {}
        return false;
      };
      if (!sendDecline()) {
        setTimeout(sendDecline, 1000);
        setTimeout(sendDecline, 3000);
      }
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
      const senderName = data.sender_name || data.title || '';
      const nameParam = senderName ? `&name=${encodeURIComponent(senderName)}` : '';
      const emailParam = data.sender_email ? `&email=${encodeURIComponent(data.sender_email)}` : '';
      router.push(`/chat-conversation?id=${data.conversation_id}${nameParam}${emailParam}&type=direct`);
      return;
    }
    if (data.type === 'login_challenge' && data.challenge_id) {
      // When user taps the login challenge notification, show the prompt
      try {
        const { triggerLoginChallengePrompt } = require('../components/LoginChallengePrompt');
        triggerLoginChallengePrompt(data);
      } catch {}
      return;
    }
    if (data.type === 'status_update') {
      router.push('/chat?tab=status');
      return;
    }
    // Feed/social notifications → open the relevant post
    if ((data.type === 'like' || data.type === 'feed_like' || data.type === 'comment' || data.type === 'feed_comment') && data.post_id) {
      router.push(`/chat?tab=feed&post_id=${data.post_id}`);
      return;
    }
    if ((data.type === 'follow' || data.type === 'feed_follow') && data.follower_email) {
      router.push(`/chat-conversation?email=${encodeURIComponent(data.follower_email)}&type=direct`);
      return;
    }
    // "X entrou no Chatyy" — someone whose number you had saved just joined.
    // Tap navigates to their public profile so the user can start a chat
    // right away. Same deep_link that lands in the notification payload.
    if (data.type === 'contact_joined' && data.email) {
      router.push(`/u/${encodeURIComponent(data.email)}`);
      return;
    }
    if ((data.type === 'live' || data.type === 'live_start') && data.session_id) {
      router.push(`/live-viewer?session_id=${data.session_id}`);
      return;
    }
    if (data.type === 'incoming_call' && (data.room_id || data.call_id)) {
      // Dismiss system notifications
      try { Notifications.dismissAllNotificationsAsync(); } catch {}
      // Show the incoming call UI (if not already showing)
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

async function handleDeleteFromNotification(data) {
  try {
    const { apiCall } = require('./api');
    await apiCall('delete', { uid: data.uid, folder: data.folder || 'INBOX' }, 'POST');
  } catch {}
}

async function handleChatReplyFromNotification(conversationId, text) {
  try {
    const { chatSend, chatRead } = require('./api');
    await chatSend(conversationId, text, 'text');
    // Mark as read too
    await chatRead(conversationId, 0);
    try { await refreshBadgeCount?.(); } catch {}
  } catch (err) {
    console.warn('[Push] Chat reply failed:', err.message);
  }
}

async function handleMarkReadChatFromNotification(conversationId) {
  try {
    const { chatRead } = require('./api');
    await chatRead(conversationId, 0);
    try { await refreshBadgeCount?.(); } catch {}
  } catch {}
}

// ============================================================
// BADGE MANAGEMENT
// ============================================================

/**
 * Clear the app icon badge (set to 0).
 * Called when the user opens the app or reads all messages.
 */
export async function clearBadge() {
  try {
    const loaded = await loadModules();
    if (!loaded) return;
    await Notifications.setBadgeCountAsync(0);
  } catch {}
}

/**
 * Set the app icon badge to an explicit count.
 * @param {number} count
 */
export async function setBadgeCount(count) {
  try {
    const loaded = await loadModules();
    if (!loaded) return;
    await Notifications.setBadgeCountAsync(Math.max(0, count));
  } catch {}
}

/**
 * Compute the total unread count (chat + email) from the backend
 * and update the app icon badge accordingly.
 *
 * Should be called:
 *   - After marking messages/emails as read
 *   - After receiving a silent_sync push
 *   - On app foreground (AppState change to 'active')
 */
export async function refreshBadgeCount() {
  if (Platform.OS === 'web') return;
  try {
    const { chatUnreadCount, apiCall } = require('./api');

    // Chat unread
    let chatUnread = 0;
    try {
      const chatResp = await chatUnreadCount();
      chatUnread = chatResp?.data?.unread_count ?? 0;
    } catch {}

    // Email unread (INBOX only — keep the badge focused on important mail)
    let emailUnread = 0;
    try {
      const emailResp = await apiCall('folder_counts');
      emailUnread = emailResp?.data?.INBOX?.unseen ?? 0;
    } catch {}

    const total = chatUnread + emailUnread;
    await setBadgeCount(total);
    return total;
  } catch (err) {
    console.warn('[Push] refreshBadgeCount failed:', err.message);
    return 0;
  }
}

// ============================================================
// SILENT PUSH / BACKGROUND SYNC
// ============================================================

/**
 * Handle a silent data-only push that the server sends to keep the app fresh.
 *
 * The backend sends these via fcmSendSilentSync() after:
 *   - A new chat message is delivered to a conversation the user is in
 *   - A new email lands in the inbox
 *
 * This function runs in the background (called from the notification handler
 * before the notification is displayed — or from the BGAppRefreshTask on iOS).
 *
 * @param {object} data  FCM data payload: { type: 'silent_sync', since: '...', sync_type: 'chat'|'email'|'all' }
 */
export function triggerBackgroundSync(data = {}) {
  const syncType = data.sync_type || 'all';
  try {
    // Emit a WebSocket-like internal event so the chat list / inbox can refresh
    const ws = require('./websocket').default;
    if (ws && syncType !== 'email') {
      ws._emit('silent_sync', { type: 'chat', since: data.since });
    }
    if (ws && syncType !== 'chat') {
      ws._emit('silent_sync', { type: 'email', since: data.since });
    }
  } catch {}

  // Refresh badge count in the background after sync
  refreshBadgeCount().catch(() => {});
}

// ============================================================
// RESPONSE HANDLER HELPERS (for new action identifiers)
// ============================================================

/**
 * Handle the VIEW action on feed/social notifications.
 * Navigates to the relevant feed post or profile.
 */
function handleViewFromNotification(data) {
  try {
    if (data?.post_id) {
      router.push(`/chat?tab=feed&post_id=${data.post_id}`);
    } else if (data?.follower_email) {
      router.push(`/chat-conversation?email=${encodeURIComponent(data.follower_email)}&type=direct`);
    } else {
      router.push('/chat?tab=feed');
    }
  } catch {}
}

/**
 * Handle the JOIN action on live broadcast notifications.
 */
function handleJoinLiveFromNotification(data) {
  try {
    if (data?.session_id) {
      router.push(`/live-viewer?session_id=${data.session_id}`);
    } else {
      router.push('/chat?tab=feed');
    }
  } catch {}
}

// Eagerly initialize notification handler on native so it's ready
// before the first push arrives (otherwise push might show as banner)
if (Platform.OS !== 'web') {
  loadModules().catch(() => {});
}
