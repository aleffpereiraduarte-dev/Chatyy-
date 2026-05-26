import { Platform, AppState } from 'react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { getJSON, setJSON } from './mmkv';
import { isOnline, queueOfflineAction } from './offlineCache';

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

// Remote diagnostic: posts each step of registerForPushNotifications to the
// backend so we can see WHERE on Android the chain breaks (Android has zero
// tokens registered across the entire backend, so something silently fails
// before sendTokenToBackend is called).
//
// Uses raw fetch — bypasses apiCall/auth so it fires even pre-login. Tries
// to grab the bearer if available, otherwise sends as anon (backend accepts
// both for the push_diag endpoint). OTA-safe (no native deps).
async function _diagPush(step, info) {
  try {
    // Try to attach bearer if available, otherwise send anon
    let bearer = '';
    try {
      const SecureStore = require('expo-secure-store');
      bearer = (await SecureStore.getItemAsync('mail_token')) || '';
    } catch {}
    const BASE_URL = 'https://chatyy.com.br/api/email.php';
    // Anon identifier — random per app install, so we can group entries even
    // without a logged-in user. Lazily generated; stored in AsyncStorage.
    let anonId = '';
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      anonId = (await AsyncStorage.getItem('push_diag_anon_id')) || '';
      if (!anonId) {
        anonId = 'anon-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
        await AsyncStorage.setItem('push_diag_anon_id', anonId);
      }
    } catch {}
    const body = JSON.stringify({
      action: 'push_diag',
      step,
      platform: Platform.OS,
      info: info ? String(info).slice(0, 500) : '',
      ts: new Date().toISOString(),
      anon_id: anonId,
    });
    const headers = { 'Content-Type': 'application/json' };
    if (bearer) headers['Authorization'] = 'Bearer ' + bearer;
    fetch(BASE_URL, { method: 'POST', headers, body }).catch(() => {});
  } catch {}
}

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

        // Find My Friends — silent WAKE-PING. Backend (chat_friend_location_ping)
        // fires a data-only push when a viewer's map sees this user's pin stale.
        // Re-run getCurrentPosition + POST chat_friend_location_share_update so
        // the sharer's location refreshes even when the app is backgrounded (the
        // WS path LiveLocationPingListener only works when WS is connected). No
        // visible notification. 60s self-throttle to protect APNs quota.
        if (data?.type === 'location_ping') {
          (async () => {
            try {
              const now = Date.now();
              if (now - (globalThis.__chatyyLastLocPing || 0) < 60000) return;
              globalThis.__chatyyLastLocPing = now;
              const Location = await import('expo-location');
              const fg = await Location.getForegroundPermissionsAsync?.().catch(() => null);
              if (fg && fg.status !== 'granted') return;
              const loc = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy?.Balanced ?? 3,
              }).catch(() => null);
              if (!loc?.coords) return;
              const api = require('./api');
              await api.apiCall('chat_friend_location_share_update', {
                latitude: loc.coords.latitude,
                longitude: loc.coords.longitude,
                accuracy: loc.coords.accuracy || null,
                heading: loc.coords.heading ?? null,
                speed: loc.coords.speed ?? null,
              }, 'POST').catch(() => {});
            } catch {}
          })();
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

          // [#992 Stage 4 — retire JS modal on mobile]
          // On iOS the PKPushRegistry → AppDelegate VoIP push path already
          // reported the call to CXProvider before this expo-notifications
          // handler runs. On Android the priority=10 CallFirebaseMessagingService
          // already launched IncomingCallActivity / CallRingingService before
          // expo-notifications surfaces the foreground notification. The JS
          // Modal would now be a second, overlapping UI. Suppress it on
          // mobile (still need shouldShowAlert=false so the system banner
          // doesn't double up). Web keeps the JS Modal because Service
          // Workers can't show full-screen incoming UI.
          if (Platform.OS === 'web') {
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
          }

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

        // [2026-05-19] WhatsApp-parity foreground gate.
        // When app is in foreground (AppState === 'active'), NEVER let the
        // OS render a tray/heads-up notification for content-type pushes
        // (chat_message, chat_mention, chat_keyword, new_email, social).
        // The in-app NotificationToast handles the visible UX; the OS
        // banner on top of it was duplicating ("banner duplo" — user
        // report 2026-05-19). On Android the FCM payload still includes
        // a root `notification` block (backend behavior unchanged so
        // background/killed flows still surface), but in foreground the
        // expo-notifications JS handler is the final authority and
        // `shouldShowAlert: false` suppresses NotificationManager from
        // re-presenting the heads-up. Signaling pushes (incoming_call,
        // login_challenge, silent_sync) were already short-circuited
        // earlier and don't reach this gate.
        const _foregroundContentTypes = new Set([
          'chat_message',
          'chat_mention',
          'chat_keyword',
          'new_email',
          'email',
          'like',
          'comment',
          'follow',
          'mention',
          'live',
          'reaction',
          'status_reply',
        ]);
        if (AppState.currentState === 'active' && _foregroundContentTypes.has(data?.type)) {
          if (_onForegroundNotification && data) {
            try {
              _onForegroundNotification({
                title: notification.request?.content?.title,
                body: notification.request?.content?.body,
                data,
              });
            } catch {}
          }
          // WhatsApp parity: ack delivered the moment the push lands in
          // foreground too. addNotificationReceivedListener also fires this,
          // but the receivedSub path runs AFTER handleNotification on some
          // platforms — eager ack here removes the ~50-200ms window where
          // the sender's UI is at ✓ while we're already handling the body.
          if (data?.type === 'chat_message' && data.conversation_id && data.message_id) {
            try {
              const convId = Number(data.conversation_id) || data.conversation_id;
              const mid = Number(data.message_id);
              if (mid > 0) {
                const api = require('./api');
                if (typeof api.chatDeliveryAckBatched === 'function') {
                  api.chatDeliveryAckBatched(convId, [mid]);
                }
              }
            } catch {}
          }
          return {
            shouldShowAlert: false,
            shouldPlaySound: false,
            shouldSetBadge: true,
          };
        }

        // WhatsApp parity: silencia toasts de chat enquanto call ativa.
        // While the user is on an active voice/video call, foreground chat
        // pushes shouldn't pop a toast over the call screen (the system call
        // UI plus the LK audio session make any chat alert disruptive). The
        // badge still increments via AsyncStorage downstream, so the chat
        // list reflects the unread on call end. Signaling-style pushes
        // (incoming_call, login_challenge, etc) handled earlier still fire.
        try {
          const { isCallActive } = require('../components/IncomingCallListener');
          if (typeof isCallActive === 'function' && isCallActive() && data?.type === 'chat_message') {
            return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: true };
          }
        } catch {}

        // Global preview privacy gate — when the backend says
        // preview_when='never', strip body even before we get to the
        // per-conversation cache lookup. The same flag pre-redacts on
        // backend so this is belt-and-suspenders. 'unlocked' is a hint
        // the OS-level handler enforces (Android VISIBILITY_PRIVATE +
        // iOS Notification Content Setting); we don't strip in JS for
        // 'unlocked' because the user expects to see the body once they
        // unlock.
        if (data?.preview_when === 'never' && notification?.request?.content) {
          try {
            // Mutate the body to a generic safe value. Backend already
            // does this — covered here only for clients that received a
            // push from an older backend that hadn't propagated yet.
            notification.request.content.body = '🔒 Nova mensagem';
          } catch {}
        }

        // Channel routing hint for Android — backend stamps `data.is_group`
        // on every chat push. If the OS already routed by channel
        // (notification.request.trigger.channelId on Android), we trust it;
        // otherwise we mark the data payload so downstream readers (foreground
        // toast, in-app banner) can pick the right styling/sound. The actual
        // channel is honored at the OS level when the system displays the
        // notification — this just mirrors the routing into JS state for
        // foreground UI.
        if (Platform.OS === 'android' && data?.type === 'chat_message') {
          const isGroup = data.is_group === '1' || data.is_group === true || data.is_group === 'true';
          // Mutate data so the foreground toast helper sees the intended
          // channel without re-deriving from is_group everywhere.
          data.__channel = isGroup ? 'chat_group' : 'chat_dm';
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
  _diagPush('register_start', Platform.OS);
  try {
    const loaded = await loadModules();
    _diagPush('load_modules', loaded ? 'ok' : 'failed');
    if (!loaded) return null;

    // 2026-05-12: Removed hard return on !Device.isDevice. Keeping the log via
    // diag so we can SEE when isDevice is false (potential root cause of zero
    // Android tokens system-wide). Letting registration proceed anyway —
    // worst case Expo Push fails further down and we record THAT in the diag.
    if (!Device.isDevice) {
      _diagPush('not_device_continuing', 'isDevice=' + String(Device.isDevice) + ' brand=' + String(Device.brand || '?') + ' modelName=' + String(Device.modelName || '?'));
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    _diagPush('existing_perm', existingStatus);
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
      _diagPush('request_perm', finalStatus);
    }

    if (finalStatus !== 'granted') {
      _diagPush('perm_denied', finalStatus);
      return null;
    }

    // Em standalone production builds expoConfig pode estar undefined —
    // easConfig.projectId é o fallback documentado.
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    _diagPush('project_id', projectId || 'undefined');
    // #836: Android cold-start race vs Google Play Services → SERVICE_NOT_AVAILABLE.
    // Retry 4× com backoff (250ms → 750ms → 1500ms → 3000ms) antes de desistir.
    let tokenData;
    let lastErr = null;
    const _retryDelays = [0, 250, 750, 1500, 3000];
    for (let attempt = 0; attempt < _retryDelays.length; attempt++) {
      if (_retryDelays[attempt] > 0) {
        await new Promise(r => setTimeout(r, _retryDelays[attempt]));
      }
      try {
        tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        if (tokenData?.data) {
          _diagPush('expo_token', 'len=' + String(tokenData.data).length + (attempt > 0 ? ' attempt=' + (attempt + 1) : ''));
          lastErr = null;
          break;
        }
        _diagPush('expo_token_empty_attempt' + (attempt + 1), 'no data');
      } catch (e) {
        lastErr = e;
        const msg = e?.message || String(e);
        _diagPush('expo_token_err_attempt' + (attempt + 1), msg);
        // Não retry em erros não-transient
        if (!/SERVICE_NOT_AVAILABLE|TIMEOUT|TIMEDOUT|network/i.test(msg)) break;
      }
    }
    if (lastErr || !tokenData?.data) {
      _diagPush('expo_token_err_final', lastErr ? (lastErr.message || String(lastErr)) : 'no token after retries');
      if (lastErr) throw lastErr;
      // No error thrown but every retry returned empty data. Bail out cleanly
      // instead of falling through — otherwise the `_setCachedPushToken(tokenData.data)`
      // below would TypeError on `undefined.data` and we'd hit the outer
      // catch with a misleading message.
      return null;
    }

    // Android notification channels.
    //
    // setNotificationChannelAsync is idempotent at the OS level (re-calling
    // with the same id updates the existing channel, it does NOT create a
    // duplicate), but it's a relatively expensive native round-trip and
    // re-running the whole block on every registerForPushNotifications() call
    // (which fires on every 6h foreground refresh) is wasted work. We guard
    // it behind a versioned AsyncStorage flag: the set only (re)registers
    // when the CHANNELS_VERSION below changes. Bump CHANNELS_VERSION whenever
    // a channel definition is added/changed so existing installs pick it up
    // on their next foreground.
    if (Platform.OS === 'android') {
      const CHANNELS_VERSION = 2;
      const CHANNELS_FLAG_KEY = `channels_v${CHANNELS_VERSION}_created`;
      let _channelsAlreadyCreated = false;
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        _channelsAlreadyCreated = (await AsyncStorage.getItem(CHANNELS_FLAG_KEY)) === '1';
      } catch {}

      if (!_channelsAlreadyCreated) {
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

      // Chat channel — legacy bucket kept for backward compat with pushes
      // sent before the chat_dm / chat_group split landed. New pushes from
      // backend use the more specific channels below so users can fine-tune
      // DMs and group chats separately in the system notification UI.
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

      // chat_dm — direct messages (1:1). HIGH importance + default sound +
      // vibration so DMs feel like WhatsApp/Signal 1:1s. Backend tags the
      // FCM payload with channelId 'chat_dm' when conversation has 2
      // members (is_group=false). i18n.notif.channel.dm provides the
      // localized title — Android caches the channel name across launches,
      // so the localized string is only rebuilt on next install/upgrade.
      await Notifications.setNotificationChannelAsync('chat_dm', {
        name: 'Mensagens diretas',
        description: 'Notificações de conversas individuais (1:1)',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 150, 80, 150],
        lightColor: '#10b981',
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
      });

      // chat_group — group chats. DEFAULT importance + silent sound to
      // avoid waking the user every time a 200-member group pings.
      // Mirrors WhatsApp: groups go to the quiet bucket by default and
      // users opt back into sound per-group via the conversation settings
      // sheet (which writes chat_user_conv_settings.sound override).
      await Notifications.setNotificationChannelAsync('chat_group', {
        name: 'Grupos',
        description: 'Notificações de conversas em grupo',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 100],
        lightColor: '#3b82f6',
        // null sound = system silent for this channel. Group pushes still
        // show in the tray + drop a badge; they just don't ping audibly
        // unless the user flips the channel sound from system settings.
        sound: null,
        enableLights: true,
        enableVibrate: false,
        showBadge: true,
      });

      // [notif-p0p1] Keyword-highlight channel — used when a chat msg
      // matches one of the user's per-keyword highlights (Slack-style
      // "notify when someone says X"). MAX importance + distinct sound so
      // it pierces silently-muted general chat noise.
      await Notifications.setNotificationChannelAsync('chat_keyword', {
        name: 'Chat — Palavras-chave',
        description: 'Mensagens que contêm uma palavra-chave que você configurou',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 200, 100, 200, 100, 200],
        lightColor: '#ef4444',
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
        bypassDnd: false,
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

        // Mark this channel-set version as created so the block is skipped on
        // subsequent registrations until CHANNELS_VERSION is bumped.
        try {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          await AsyncStorage.setItem(CHANNELS_FLAG_KEY, '1');
        } catch {}
      }
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

    // [notif-p0p1] chat_reaction — someone reacted to one of your msgs.
    // Single action to jump straight to the original message; no reply
    // (you'd reply via the normal chat_message category if you tap reply
    // on the threaded conversation).
    await Notifications.setNotificationCategoryAsync('chat_reaction', [
      {
        identifier: 'view',
        buttonTitle: 'Ver',
        options: { opensAppToForeground: true },
      },
      {
        identifier: 'reply',
        buttonTitle: 'Responder',
        textInput: { submitButtonTitle: 'Enviar', placeholder: 'Mensagem...' },
      },
    ]);

    // [notif-p0p1] Generic mute action on chat — also surfaced inside the
    // dynamic smart-reply category registered by the NSE per-notification.
    // This static category is the fallback for clients that haven't
    // upgraded to the NSE pathway yet (older iOS / web).
    await Notifications.setNotificationCategoryAsync('chat_with_mute', [
      {
        identifier: 'reply',
        buttonTitle: 'Responder',
        textInput: { submitButtonTitle: 'Enviar', placeholder: 'Mensagem...' },
      },
      { identifier: 'mark_read', buttonTitle: 'Marcar como lido' },
      { identifier: 'mute_8h', buttonTitle: 'Silenciar 8h' },
      { identifier: 'snooze_1h', buttonTitle: 'Soneca 1h' },
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

    // missed_call — fired when caller hung up before we picked up (or we
    // declined). Single action "Ligar de volta" that dials the caller back
    // through /call.js as the initiator. Pairs with the Android side handled
    // by ChatActionReceiver.ACTION_CALL_BACK so both platforms surface the
    // same shortcut without opening the app first.
    await Notifications.setNotificationCategoryAsync('missed_call', [
      {
        identifier: 'CALL_BACK',
        // i18n.notif.missedCall.callBack mirrors this — kept here as a
        // hard-coded fallback because UNNotificationAction titles are
        // rendered by iOS, not by our JS, so they need the literal string
        // at registration time. The active language is read from the
        // running app, but iOS caches the category between launches so
        // the title only updates after the app foregrounds.
        buttonTitle: 'Ligar de volta',
        options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: true },
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

      // Try up to FIVE times with backoff — Firebase's first install handshake
      // can be slow on cold start, slow networks, or after Google Play Services
      // updates. WITHOUT fcm_device token, the user gets ZERO Android pushes
      // because Expo Push for Android needs FCM Server Key uploaded to Expo
      // creds (not currently configured). 5 attempts × 1.5s delay = 7.5s max.
      // Incident 2026-05-12 round 2: only Expo token registered, no fcm_device,
      // so all chat pushes failed with InvalidCredentials and never delivered.
      let deviceToken = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          deviceToken = await Notifications.getDevicePushTokenAsync();
          _diagPush('fcm_device_attempt_' + attempt, deviceToken?.data ? ('type=' + (deviceToken.type || '?') + ' len=' + String(deviceToken.data).length) : ('type=' + (deviceToken?.type || '?') + ' empty'));
          if (deviceToken?.data) break;
        } catch (err) {
          _diagPush('fcm_device_err_' + attempt, err?.message || String(err));
          deviceToken = null;
        }
        if (attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }

      if (deviceToken?.data) {
        pushNotificationsState.deviceToken = deviceToken.data;
        _diagPush('fcm_device_ok', 'type=' + (deviceToken.type || '?'));
      } else {
        _diagPush('fcm_device_missing', 'no fcm token after retry');
      }
    }

    try { _setCachedPushToken(tokenData.data); } catch {}
    _diagPush('register_done', 'ok');
    return tokenData.data;
  } catch (err) {
    _diagPush('register_failed', err?.message || String(err));
    console.warn('[Push] Registration failed:', err.message);
    return null;
  }
}

// ============================================================
// PENDING TOKEN SENDS (offline retry)
// ============================================================
// If sendTokenToBackend() fails (network down, server 5xx, /etc/mail-api.env
// reload mid-deploy) we lose the token registration silently and the user
// never receives push notifications until the next 6h foreground refresh —
// which itself can fail forever in a row. The MMKV-backed queue below
// retries on every AppState foreground transition + WS auth ack, dedups by
// token, caps at 5 entries (LRU drop oldest) so we don't pile up forever
// across multi-account toggles.
const PENDING_TOKEN_SENDS_KEY = 'pending_token_sends';
const PENDING_TOKEN_SENDS_MAX = 5;
// Track tokens we've already successfully sent in this app session so two
// flushes (foreground + WS auth_ack firing back-to-back) don't re-POST the
// same {token, email} pair to the backend.
const _flushedTokensInSession = new Set();

function _readPendingTokenSends() {
  const v = getJSON(PENDING_TOKEN_SENDS_KEY);
  return Array.isArray(v) ? v : [];
}

function _writePendingTokenSends(arr) {
  setJSON(PENDING_TOKEN_SENDS_KEY, Array.isArray(arr) ? arr.slice(-PENDING_TOKEN_SENDS_MAX) : []);
}

function _enqueuePendingTokenSend(entry) {
  if (!entry?.token) return;
  const list = _readPendingTokenSends();
  // Dedup by (token, email, token_type). If an identical entry already
  // exists, refresh its ts (LRU bump) instead of duplicating — protects
  // against a user toggling foreground 20× while still offline.
  const sig = (e) => `${e.token}|${e.email || ''}|${e.token_type || ''}`;
  const incomingSig = sig(entry);
  const next = list.filter((e) => sig(e) !== incomingSig);
  next.push({ ...entry, ts: entry.ts || Date.now() });
  // LRU cap — drop OLDEST so the most recent token rotation always wins
  // (a rotated FCM token from the same install is more useful than a stale
  // entry from a previous session).
  while (next.length > PENDING_TOKEN_SENDS_MAX) next.shift();
  _writePendingTokenSends(next);
}

async function _getActiveEmailSafe() {
  try {
    const { getActiveAccountEmail } = require('./api');
    return (typeof getActiveAccountEmail === 'function' ? getActiveAccountEmail() : '') || '';
  } catch { return ''; }
}

export async function sendTokenToBackend(pushToken) {
  _diagPush('send_start', pushToken ? ('len=' + String(pushToken).length) : 'no token');
  if (!pushToken) return;
  const email = await _getActiveEmailSafe();
  try {
    const { apiCall } = require('./api');
    const r1 = await apiCall('register_push_token', { token: pushToken, platform: Platform.OS }, 'POST');
    _diagPush('send_expo', r1?.success ? 'ok' : ('fail:' + (r1?.error || 'unknown')));
    if (r1?.success) {
      _flushedTokensInSession.add(pushToken + '|' + email + '|');
    } else {
      // API returned a non-throwing failure (e.g. 5xx wrapped in success:false).
      // Queue for retry just like a network throw.
      _enqueuePendingTokenSend({ token: pushToken, email, platform: Platform.OS });
    }

    // Also register the raw FCM device token for Android incoming calls
    if (Platform.OS === 'android') {
      if (pushNotificationsState.deviceToken) {
        const fcmTok = pushNotificationsState.deviceToken;
        const r2 = await apiCall('register_push_token', {
          token: fcmTok,
          platform: 'android',
          token_type: 'fcm_device',
        }, 'POST');
        _diagPush('send_fcm', r2?.success ? 'ok' : ('fail:' + (r2?.error || 'unknown')));
        if (r2?.success) {
          _flushedTokensInSession.add(fcmTok + '|' + email + '|fcm_device');
        } else {
          _enqueuePendingTokenSend({ token: fcmTok, email, platform: 'android', token_type: 'fcm_device' });
        }
      } else {
        _diagPush('send_fcm_skip', 'no deviceToken in state');
      }
    }
  } catch (err) {
    _diagPush('send_err', err?.message || String(err));
    // Offline / network throw — persist the intent so we retry on next
    // foreground or WS auth_ack. Without this the backend never learns the
    // token until the 6h ensurePushTokenFresh throttle expires AND the
    // device happens to be online at that moment (incident 2026-05-12:
    // Android had zero tokens registered because every cold start retry
    // hit the same offline window).
    _enqueuePendingTokenSend({ token: pushToken, email, platform: Platform.OS });
    if (Platform.OS === 'android' && pushNotificationsState.deviceToken) {
      _enqueuePendingTokenSend({
        token: pushNotificationsState.deviceToken,
        email,
        platform: 'android',
        token_type: 'fcm_device',
      });
    }
  }
}

/**
 * Drain the pending_token_sends queue. Iterates each entry, POSTs to the
 * backend, removes on success (or hard 4xx) and keeps on transient failure.
 * Called on AppState foreground transition + on WS auth_ack via the
 * connection event listener registered in setupNotificationListeners().
 *
 * Dedup: a token+email pair successfully flushed in the current session
 * is skipped on subsequent flushes — prevents a foreground bounce + WS
 * reconnect double-firing the same register_push_token call.
 */
export async function flushPendingTokens() {
  if (Platform.OS === 'web') return { flushed: 0, kept: 0 };
  // Bail when we're certain the network is down — saves the round-trip
  // and keeps the entries queued for the next attempt. isOnline() is a
  // best-effort signal (NetInfo cached value) so we still try when it
  // says "online but actually unreachable" — apiCall will catch + requeue.
  try { if (typeof isOnline === 'function' && isOnline() === false) return { flushed: 0, kept: -1 }; } catch {}
  const list = _readPendingTokenSends();
  if (!list.length) return { flushed: 0, kept: 0 };
  const { apiCall } = require('./api');
  const kept = [];
  let flushed = 0;
  for (const entry of list) {
    const dedupKey = entry.token + '|' + (entry.email || '') + '|' + (entry.token_type || '');
    if (_flushedTokensInSession.has(dedupKey)) {
      flushed++;
      continue;
    }
    try {
      const payload = { token: entry.token, platform: entry.platform || Platform.OS };
      if (entry.token_type) payload.token_type = entry.token_type;
      const r = await apiCall('register_push_token', payload, 'POST');
      if (r?.success) {
        flushed++;
        _flushedTokensInSession.add(dedupKey);
      } else {
        // Server returned a structured failure. If the response shape
        // suggests a permanent error (invalid token format, account
        // deleted) we drop it; otherwise keep for retry. Without a
        // discriminator we keep — better to retry a few extra times
        // than to silently lose registration forever.
        const msg = String(r?.error || r?.message || '').toLowerCase();
        const isHard = /invalid.?token|malformed|account.?(deleted|not.?found)|forbidden/.test(msg);
        if (!isHard) kept.push(entry);
      }
    } catch (err) {
      _diagPush('flush_pending_err', err?.message || String(err));
      kept.push(entry);
    }
  }
  _writePendingTokenSends(kept);
  _diagPush('flush_pending_done', `flushed=${flushed} kept=${kept.length}`);
  return { flushed, kept: kept.length };
}

// Cache the Expo push token from the most recent getExpoPushTokenAsync()
// call so logout can pass it to removeTokenFromBackend() without a fresh
// Notifications call (which would fail if permission just got revoked).
let _cachedPushToken = null;
export function _setCachedPushToken(tok) { _cachedPushToken = tok || null; }
export function getCachedPushToken() { return _cachedPushToken; }

// ============================================================
// AUTO RE-REGISTER ON FOREGROUND (incident 2026-05-18)
// ============================================================
// Some users were losing their push token mid-life — the server-side
// tokens.json went empty until the user logged out and back in. Root cause
// is a mix of (a) silent backend write failures (now surfaced via the
// defensive write in email.php case 'register_push_token' / 'register_voip_token')
// and (b) FCM/APNs token rotation that the app didn't push back to the
// server until the next cold-start.
//
// Fix: every time the app foregrounds, re-run registerForPushNotifications
// + sendTokenToBackend, throttled to 1× per 6h so we don't flood the
// backend for users who toggle in and out of the app. Persisted via
// AsyncStorage so a cold restart still respects the throttle.
const PUSH_REFRESH_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h
const PUSH_REFRESH_LAST_KEY = 'push_refresh_last_at';
const PUSH_REFRESH_FAIL_KEY = 'push_refresh_fail_count';

async function _readJsonKey(key, fallback) {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  } catch { return fallback; }
}
async function _writeJsonKey(key, val) {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

/**
 * Ensure the push token on the backend is fresh. Throttled to once every
 * PUSH_REFRESH_THROTTLE_MS (6h). Safe to call on every AppState 'active'.
 *
 * @param {object} opts
 * @param {boolean} [opts.force]  Bypass the 6h throttle (used by manual
 *                                 retry from the stale-token banner tap).
 * @returns {Promise<{ok:boolean, throttled?:boolean, token?:string}>}
 */
export async function ensurePushTokenFresh(opts = {}) {
  if (Platform.OS === 'web') return { ok: false };
  const now = Date.now();
  if (!opts.force) {
    const lastAt = await _readJsonKey(PUSH_REFRESH_LAST_KEY, 0);
    if (typeof lastAt === 'number' && now - lastAt < PUSH_REFRESH_THROTTLE_MS) {
      return { ok: true, throttled: true };
    }
  }
  // Stamp BEFORE the call so a slow registration doesn't allow a second
  // overlapping call from another AppState bounce. If it ultimately fails
  // the failure-counter path still surfaces the banner.
  await _writeJsonKey(PUSH_REFRESH_LAST_KEY, now);
  let token = null;
  try {
    token = await registerForPushNotifications();
  } catch (e) {
    _diagPush('ensure_fresh_register_threw', e?.message || String(e));
    token = null;
  }
  if (!token) {
    const failCount = (await _readJsonKey(PUSH_REFRESH_FAIL_KEY, 0)) || 0;
    const next = failCount + 1;
    await _writeJsonKey(PUSH_REFRESH_FAIL_KEY, next);
    // 2+ consecutive failures → surface a global banner flag so the UI can
    // ask the user to tap-to-retry. Single failures stay silent (most users
    // recover on the next foreground without ever noticing).
    if (next >= 2) {
      try { globalThis.__chatyy_push_token_stale = true; } catch {}
    }
    return { ok: false };
  }
  try {
    await sendTokenToBackend(token);
  } catch (e) {
    _diagPush('ensure_fresh_send_threw', e?.message || String(e));
  }
  // Reset failure counter on any successful round-trip.
  await _writeJsonKey(PUSH_REFRESH_FAIL_KEY, 0);
  try { globalThis.__chatyy_push_token_stale = false; } catch {}
  return { ok: true, token };
}

/**
 * Manual retry from the PushTokenStaleBanner tap. Bypasses the 6h throttle.
 */
export async function retryPushTokenRegistration() {
  return ensurePushTokenFresh({ force: true });
}

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
  // 3. Web platform path — FCM Web SDK lives in services/webPush.js and
  // talks to a different backend table (web_tokens.json). Without this
  // call, logging out on a browser leaves the SW receiving pushes until
  // the FCM token rotates (potentially weeks). Mirrors the native paths.
  if (Platform.OS === 'web') {
    try {
      const { unregisterWebPushToken } = require('./webPush');
      if (typeof unregisterWebPushToken === 'function') await unregisterWebPushToken();
    } catch {}
  }
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
    // WhatsApp parity (2026-05-21): the moment a chat_message push lands on
    // this device — regardless of whether the WS is connected, the app is
    // foreground/background, or the user opens the conversation — fire a
    // delivery ack so the sender's ticks flip from ✓ (sent) to ✓✓ (delivered)
    // immediately. Previously delivery only acked when the message arrived
    // via WS (active app) OR the user opened the thread; users with the app
    // killed would leave the sender stuck at single check until they next
    // tapped the notification. The backend `chat_delivery_ack` action is
    // idempotent (ON CONFLICT preserves first-write timestamp) so an extra
    // ack from a later WS handler is a no-op.
    if (data?.type === 'chat_message' && data.conversation_id && data.message_id) {
      try {
        const convId = Number(data.conversation_id) || data.conversation_id;
        const mid = Number(data.message_id);
        if (mid > 0) {
          const api = require('./api');
          if (typeof api.chatDeliveryAckBatched === 'function') {
            api.chatDeliveryAckBatched(convId, [mid]);
          } else if (typeof api.chatDeliveryAck === 'function') {
            api.chatDeliveryAck(convId, [mid]).catch(() => {});
          }
        }
      } catch {}
    }
    // Find My Friends — backend pushes data.type='location_request' when peer
    // asks to see this user's location. Open the global accept/decline sheet
    // instead of relying on the snap-map screen being open.
    if (data?.type === 'location_request' && data.requester_email) {
      try {
        const { triggerLocationRequestModal } = require('../components/LocationRequestModal');
        triggerLocationRequestModal({
          requester_email: data.requester_email,
          requester_name: data.requester_name,
          message: data.message,
        });
        // Suppress the system banner — modal is already on screen.
        try { Notifications.dismissNotificationAsync(notification.request.identifier); } catch {}
      } catch {}
    }
    // SuperBora (and future sibling apps): cross-app sign-in approval. The
    // backend already shipped all fields in the data payload, so just hand
    // the whole blob to the modal. Background-tap path mirrors this below.
    if (data?.type === 'push_login' && data.challenge_id) {
      try {
        const { triggerPushLoginModal } = require('../components/PushLoginRequestModal');
        triggerPushLoginModal(data);
        try { Notifications.dismissNotificationAsync(notification.request.identifier); } catch {}
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
    // [notif-p0p1] Smart-reply chip tap: NSE registers UNTextInputNotificationActions
    // with identifiers `smart_reply_0` / `_1` / `_2`. iOS still surfaces the
    // text input so the user can edit before sending — the chip text is the
    // pre-filled value via response.userText.
    if (/^smart_reply_\d+$/.test(actionId || '') && data?.conversation_id) {
      const userText = response.userText;
      if (userText?.trim()) {
        handleChatReplyFromNotification(data.conversation_id, userText.trim());
      }
      return;
    }
    // [notif-p0p1] Mute-from-notification (8h). Identifier `mute_8h` is
    // registered statically (chat_with_mute) and dynamically (NSE smart
    // category). Sends chat_user_conv_settings_set with mute_until = now+8h.
    if (actionId === 'mute_8h' && data?.conversation_id) {
      try {
        const { apiCall } = require('./api');
        const muteUntil = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
        apiCall('chat_user_conv_settings_set', {
          conversation_id: data.conversation_id,
          mute_until: muteUntil,
        }, 'POST').catch(() => {});
      } catch {}
      try { Notifications.dismissNotificationAsync(response.notification.request.identifier); } catch {}
      return;
    }
    // [notif-p0p1] Snooze user-level for 1h. Pushes for the next hour fold
    // into silent data pushes (push fanout reads chat_user_snooze).
    if (actionId === 'snooze_1h') {
      try {
        const { apiCall } = require('./api');
        apiCall('chat_user_snooze_set', { minutes: 60 }, 'POST').catch(() => {});
      } catch {}
      try { Notifications.dismissNotificationAsync(response.notification.request.identifier); } catch {}
      return;
    }
    // [notif-p0p1] Reaction "view" action — jump to the reacted message.
    if (actionId === 'view' && data?.conversation_id) {
      handleNotificationNavigation({ ...data, type: 'chat_message' });
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
    // Missed call → "Ligar de volta". Same identifier used by the iOS
    // notification action and the Android ChatActionReceiver broadcast that
    // tunnels back into JS via expo-notifications' presentation hook.
    if (actionId === 'CALL_BACK' && (data?.caller_email || data?.peer_email || data?.target_email)) {
      const peer = data.caller_email || data.peer_email || data.target_email;
      const peerName = data.caller_name || data.peer_name || '';
      const isVideo = (data.video === '1' || data.video === true) ? '1' : '0';
      try { Notifications.dismissAllNotificationsAsync(); } catch {}
      router.push(`/call?email=${encodeURIComponent(peer)}&name=${encodeURIComponent(peerName)}&initiator=1&isVideo=${isVideo}`);
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
      // [#992 Stage 3] On mobile the native incoming-direct path
      // (CallActivity / CallViewController) opens automatically once the
      // user taps Accept in the system notification — JS shouldn't push
      // /call.js here. Web still uses /call.js.
      try {
        const { Platform } = require('react-native');
        if (Platform.OS === 'web') {
          router.push(`/call?callId=${callId}&contactName=${encodeURIComponent(data.caller_name || '')}&contactEmail=${encodeURIComponent(data.caller_email || '')}&isVideo=${isVideo}&conversationId=${data.conversation_id || ''}&isCaller=0`);
        }
      } catch {
        router.push(`/call?callId=${callId}&contactName=${encodeURIComponent(data.caller_name || '')}&contactEmail=${encodeURIComponent(data.caller_email || '')}&isVideo=${isVideo}&conversationId=${data.conversation_id || ''}&isCaller=0`);
      }
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

  // ─── Offline retry wiring for pending_token_sends ────────────────────
  // 1. Drain on every foreground transition (matches the existing 6h
  //    ensurePushTokenFresh hook in AuthContext but cheaper: no permission
  //    prompt, no re-derive token, just retry the persisted POST).
  // 2. Drain on WS auth_ack — the same network event that flushes the
  //    chat outbox is the strongest "we're back online" signal we have,
  //    much faster than the AppState bounce in carrier-flap scenarios.
  let _flushAppStateSub = null;
  let _flushWsConnUnsub = null;
  try {
    _flushAppStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        flushPendingTokens().catch(() => {});
      }
    });
  } catch {}
  try {
    const mailWs = require('./websocket').default;
    if (mailWs && typeof mailWs.on === 'function') {
      _flushWsConnUnsub = mailWs.on('connection', (evt) => {
        if (evt?.status === 'authenticated') {
          flushPendingTokens().catch(() => {});
        }
      });
    }
  } catch {}
  // Best-effort initial drain in case there were pending entries from the
  // last session (cold start with stale queue).
  flushPendingTokens().catch(() => {});

  return () => {
    receivedSub?.remove?.();
    responseSub?.remove?.();
    try { _flushAppStateSub?.remove?.(); } catch {}
    try { _flushWsConnUnsub?.(); } catch {}
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
    // Voicemail deep-link — tapping a "X left you a voicemail" push lands on
    // the conversation with the voicemail bubble scrolled into view and the
    // player auto-starts. Backend sends `data.type === 'voicemail'` plus
    // `data.conversation_id` and `data.voicemail_id`.
    //
    // TODO(chat-conversation.js): currently only `id` is consumed from the
    // route params (see chat-conversation.js useLocalSearchParams ~L5685).
    // Need to read `voicemail_id` + `autoplay` to scroll-to-message + auto
    // tap play on the matching VoicemailMessage component. Until then the
    // user still lands on the right conversation — just no scroll/autoplay.
    if (data.type === 'voicemail' && data.conversation_id) {
      const vmId = data.voicemail_id || data.vm_id || '';
      const vmParam = vmId ? `&voicemail_id=${encodeURIComponent(vmId)}` : '';
      router.push(`/chat-conversation?id=${data.conversation_id}${vmParam}&autoplay=1&type=direct`);
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
    // Find My Friends — peer requested to see this user's location. Route
    // to snap-map with the requester pre-loaded so the accept/decline sheet
    // auto-opens on mount (see app/snap-map.js incoming_request param).
    if (data.type === 'location_request' && data.requester_email) {
      const nameParam = data.requester_name ? `&requester_name=${encodeURIComponent(data.requester_name)}` : '';
      const msgParam = data.message ? `&message=${encodeURIComponent(data.message)}` : '';
      router.push(`/snap-map?incoming_request=${encodeURIComponent(data.requester_email)}${nameParam}${msgParam}`);
      return;
    }
    // SuperBora cross-app sign-in (background tap). The notification payload
    // is self-contained, so we render the same modal instead of routing to a
    // dedicated screen that would just re-fetch the same data.
    if (data.type === 'push_login' && data.challenge_id) {
      try {
        const { triggerPushLoginModal } = require('../components/PushLoginRequestModal');
        triggerPushLoginModal(data);
      } catch {}
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
    // Ongoing broadcast pill (host's own session) — tap returns to studio.
    if (data.type === 'live_broadcast_self' && data.session_id) {
      router.push(`/live-broadcast?session_id=${data.session_id}`);
      return;
    }
    // Upload progress notification: tap surfaces the photos backup screen
    // so the user can pause / inspect status without digging through Settings.
    if (data.type === 'upload_progress' || data.type === 'upload_complete' || data.type === 'upload_error') {
      router.push('/photos');
      return;
    }
    if (data.type === 'incoming_call' && (data.room_id || data.call_id)) {
      // Dismiss system notifications
      try { Notifications.dismissAllNotificationsAsync(); } catch {}
      // [#992 Stage 4 — retire JS modal on mobile]
      // Native CallKit (iOS) / IncomingCallActivity (Android) already
      // owns the incoming-call UI by the time this tap-response handler
      // runs, so re-triggering the JS Modal here would just overlap.
      // Web still needs the JS Modal trigger (no native call UI).
      if (Platform.OS === 'web') {
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
      }
      return;
    }
    router.push('/inbox');
  } catch (err) {
    console.warn('[Push] Nav error:', err.message);
  }
}

// Notification action handlers — these run when the user taps Archive /
// Mark-read / Delete / Reply directly from the lockscreen / notification
// shade. Before Wave 5 these used `.catch(() => {})` which silently dropped
// the action on offline / 5xx: the user saw the swipe animation succeed
// (system UI dismisses the notification regardless) but the email/chat
// stayed unread on the server forever. Now we queue via offlineCache's
// replay engine so the next foreground / WS reconnect retries with the
// same backoff cadence as in-app actions.
async function _queueNotificationAction(actionType, params) {
  try {
    await queueOfflineAction({
      type: 'notification_action',
      action_type: actionType,
      params,
    });
  } catch (e) {
    _diagPush('notif_action_queue_err', e?.message || String(e));
  }
}

async function handleArchiveFromNotification(data) {
  const params = { uid: data.uid, folder: data.folder || 'INBOX', destination: 'Archive' };
  try {
    const { apiCall } = require('./api');
    await apiCall('move', params, 'POST');
  } catch (err) {
    _diagPush('notif_archive_offline', err?.message || String(err));
    await _queueNotificationAction('archive', params);
  }
}

async function handleMarkReadFromNotification(data) {
  const params = { uid: data.uid, folder: data.folder || 'INBOX' };
  try {
    const { apiCall } = require('./api');
    await apiCall('mark_read', params, 'POST');
  } catch (err) {
    _diagPush('notif_markread_offline', err?.message || String(err));
    await _queueNotificationAction('mark_read', params);
  }
}

async function handleDeleteFromNotification(data) {
  const params = { uid: data.uid, folder: data.folder || 'INBOX' };
  try {
    const { apiCall } = require('./api');
    await apiCall('delete', params, 'POST');
  } catch (err) {
    _diagPush('notif_delete_offline', err?.message || String(err));
    await _queueNotificationAction('delete', params);
  }
}

async function handleChatReplyFromNotification(conversationId, text) {
  try {
    const { chatSend, chatRead } = require('./api');
    const r = await chatSend(conversationId, text, 'text');
    if (!r || r.success === false) throw new Error(r?.error || r?.message || 'chat_send_failed');
    // Mark as read too — best effort; failure here doesn't roll back the
    // send, just queues a chat_read retry.
    try {
      await chatRead(conversationId, 0);
    } catch (readErr) {
      await _queueNotificationAction('chat_read', { conversation_id: conversationId });
    }
    try { await refreshBadgeCount?.(); } catch {}
  } catch (err) {
    // HTTP fallback dropped — queue as the canonical chat_send action that
    // replayOfflineQueue already knows how to retry (same backoff, same
    // server idempotency via client_message_id). Without the cmid, server
    // dedup can't protect us from a duplicate if the original POST actually
    // landed but the response was lost — so we mint one here.
    console.warn('[Push] Chat reply failed:', err?.message || err);
    _diagPush('notif_chat_reply_offline', err?.message || String(err));
    try {
      const cmid = 'qr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      await queueOfflineAction({
        type: 'chat_send',
        conversation_id: conversationId,
        content: text,
        msgType: 'text',
        client_message_id: cmid,
      });
      // Also queue a chat_read so when the reply finally lands, the
      // conversation is marked read just like the inline tap would.
      await _queueNotificationAction('chat_read', { conversation_id: conversationId });
    } catch (qErr) {
      _diagPush('notif_chat_reply_queue_err', qErr?.message || String(qErr));
    }
  }
}

async function handleMarkReadChatFromNotification(conversationId) {
  try {
    const { chatRead } = require('./api');
    await chatRead(conversationId, 0);
    try { await refreshBadgeCount?.(); } catch {}
  } catch (err) {
    _diagPush('notif_chat_markread_offline', err?.message || String(err));
    await _queueNotificationAction('chat_read', { conversation_id: conversationId });
  }
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

  // [Round 1188 Agent F PATCH-5 2026-05-19] Force an envelope flush so the
  // recipient pulls the new ciphertext that triggered this wake. Without
  // this, the silent push arrives but envelopePuller's only trigger paths
  // (WS envelope_available / AppState=active / 30s safety) may all be
  // unavailable in the background — leaving the user waiting until the
  // next foreground transition. WhatsApp/Telegram parity: silent push =>
  // pull => decrypt => save => visible badge.
  try {
    if (syncType !== 'email') {
      const { flushEnvelopesNow } = require('./envelopePuller');
      if (typeof flushEnvelopesNow === 'function') {
        flushEnvelopesNow().catch(() => {});
      }
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
