// services/voipNative.js — Stage #996 outgoing-call entry point.
//
// Replaces the inline `openNativeCall(...)` + JS-side LiveKit SDK
// `Room.connect` pattern that used to live in chat-conversation.js / one.js /
// CallStatusBar.js. The new `startOutgoingCall` flow on iOS+Android uses the
// native ExpoCallKitModule directly so the call benefits from:
//
//   * iOS: real CXStartCallAction → CallKit shows the call in Recents, lock
//     screen, audio session lifecycle is owned by CallKit.
//   * Android: CallActivity with EXTRA_IS_OUTGOING=true → fires call_invite
//     via CallSignalWs (no JS bridge), plays the standard PSTN ringback tone
//     (TONE_SUP_RINGTONE), survives the user backgrounding the app via
//     CallOngoingService.
//   * Web: still routes to the JS /call screen (no native module available).
//
// JS callsites should import { startOutgoingCall } from this module and pass
// the conversation/contact info; the module fetches the LK token, asks the
// backend to broadcast a push to the callee (callNotify), then hands off to
// the native flow.

import { Platform, AppState } from 'react-native';
import * as ExpoCallKit from '../modules/expo-callkit';
import * as api from './api';

const TAG = '[voipNative]';

/**
 * [2026-05-20 restore foreground gate — WhatsApp/Telegram parity]
 * Decide if the OUTGOING call should render the rich JS UI (/call.js with
 * invite-friend, audio↔video upgrade, screenshare, grid, emoji, raise hand)
 * vs the bare-bones native CallActivity / CallViewController.
 *
 * Rule: app foreground → JS (user already inside the app, expects rich UI).
 *       app background/killed → native (rare for outgoing, but covers
 *       Siri shortcut / share-extension dialing / cold-start).
 *
 * Incoming flow is UNAFFECTED — it always goes native via VoipPushAppDelegate-
 * Subscriber (iOS) / CallFirebaseMessagingService (Android) so the OS-level
 * CallKit / lock-screen FullScreenIntent can ring even when killed.
 *
 * History:
 *   #1208 introduced this gate. #1217 reverted to full-native because the
 *   native↔JS handoff had dual-mount bugs. Now the native side has the
 *   suppressVCPresent flag (iOS) and isAppForeground guard (Android) so we
 *   can safely route outgoing-while-foreground to JS again.
 */
function isAppForeground() {
  try {
    return AppState?.currentState === 'active';
  } catch {
    return false;
  }
}

/**
 * Generate a server-side call_id. Format mirrors the legacy inline
 * generator in chat-conversation.js so backend logs stay comparable.
 */
function generateCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Start an outgoing call to a single email. For group calls use the
 * /group-call route — group flow has its own entry (server-side call_notify
 * fans out to every member).
 *
 * @param {object} params
 * @param {string} params.calleeEmail        Required — the person being called.
 * @param {string} [params.calleeName]       Display name to show on the native screen.
 * @param {string} [params.callerName]       Local user's display name (for call_invite).
 * @param {boolean} params.isVideo           True for video, false for audio.
 * @param {string} [params.conversationId]   Chat conversation row id.
 * @param {string} [params.callId]           Pin a callId; otherwise generated.
 * @param {function} [params.onWebFallback]  Called on web with the generated callId
 *                                           so the caller can router.push('/call').
 * @returns {Promise<{callId: string, native: boolean}>}
 *          callId is the canonical server-side identifier. `native` is true when
 *          the call was handed off to the native flow; false on web / native
 *          module unavailable, in which case the caller should fall back to the
 *          JS /call screen.
 */
export async function startOutgoingCall({
  calleeEmail,
  calleeName,
  callerName,
  isVideo,
  conversationId,
  callId,
  onWebFallback,
} = {}) {
  // [2026-05-21] Defensive validation. The native (iOS/Android) layer
  // returns cryptic errors ("callee_email required", "Cannot convert
  // [object Object]... Value is undefined") when the JS payload is
  // malformed. Catch upstream and surface the actual offending value so
  // the caller (chat-conversation.js, ChatCallsTab.js, one.js) can show
  // a meaningful Alert instead of "empty string reached native".
  const calleeEmailStr = (calleeEmail == null ? '' : String(calleeEmail)).trim();
  if (!calleeEmailStr) {
    const err = new Error(
      'callee_email required (got: ' + JSON.stringify(calleeEmail) + ')'
    );
    err.code = 'CALLEE_EMAIL_EMPTY';
    throw err;
  }
  // Use the trimmed value below so downstream native layers receive a
  // clean string with no whitespace surprises.
  calleeEmail = calleeEmailStr;
  const cid = callId || generateCallId();
  // [CALL-TRACE 2026-05-20 WAVE42] Step 2/12 — JS hands the call off to
  // native CallKit / CallActivity. From this point the foreground UI is
  // either /call.js (in-app foreground branch below) or the native call
  // surface. The callId here is what propagates through native, WS, server,
  // LK room name, and post-call diag.
  try {
    console.log('[CALL-TRACE][2/12] voipNative.startOutgoingCall', {
      callId: cid,
      calleeEmail,
      video: !!isVideo,
      conversationId: conversationId || '',
      platform: Platform.OS,
      ts: Date.now(),
    });
  } catch {}

  // Fire-and-forget push notification so the callee's phone rings. Server
  // returns immediately — we don't block the native present on this. Bug
  // history (#1176, 2026-05-18): we used to AWAIT this + chatLivekitToken
  // sequentially before calling ExpoCallKit.startOutgoingCall, which meant
  // the user tapped "Ligar" and saw nothing for 300-800ms while the chat
  // screen stayed up. The native call UI only appeared AFTER both HTTPs
  // resolved. Now we fire callNotify in the background and kick the native
  // surface immediately so CallKit / CallActivity is visible in <100ms.
  if (conversationId) {
    api.callNotify(conversationId, cid, isVideo).catch((e) => {
      console.warn(TAG, 'callNotify failed (non-fatal):', e?.message || e);
    });
  }

  // On web we have no native module; let the caller route to /call.js.
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    if (typeof onWebFallback === 'function') {
      try {
        onWebFallback(cid);
      } catch (e) {
        console.warn(TAG, 'onWebFallback threw:', e);
      }
    }
    return { callId: cid, native: false };
  }

  // [WAVE 117A] Mobile = 100% native (WhatsApp/Telegram pattern).
  // Foreground gate removed for iOS/Android: every outgoing call on mobile
  // goes through the native CallViewController (iOS) / CallActivity (Android)
  // regardless of app state. The rich JS /call.js screen is Web-only.
  // onWebFallback callers are also gated with Platform.OS === 'web' so
  // this is belt-and-suspenders — calling onWebFallback on mobile is a no-op.

  // Pre-resolve the callee avatar URL so the native screen can paint a real
  // avatar (not just the initial letter) before LK Room is even up. The URL
  // points at the backend /get_avatar?email=... endpoint, which is cached on
  // CDN; both iOS (AsyncImage) and Android (Coil-less HttpURLConnection in
  // CallNotificationService.fetchAvatarBitmap) load it directly.
  let calleeAvatar = '';
  try {
    calleeAvatar = api.getAvatarUrlForEmail(calleeEmail) || '';
  } catch {}

  // [#1176 polish, 2026-05-18] Fire the native present IMMEDIATELY. We do
  // NOT await chatLivekitToken first — that HTTP round-trip is 200-500ms
  // on a warm network and was the visible "delay between tap and native
  // fullscreen". Instead:
  //
  //   1. Kick native startOutgoingCall now → CallKit / CallActivity surfaces
  //      in <100ms with avatar + name + "Chamando…" placeholder.
  //   2. In parallel, mint chat_livekit_token in the background.
  //   3. When the token resolves, persist it via persistPendingLkToken.
  //      iOS: CXStartCallAction's delegate handler calls
  //      NativeCallTokenFetcher when the JS-supplied token is nil, so this
  //      path "just works". Android: CallActivity reads EXTRA_LK_URL /
  //      EXTRA_LK_TOKEN at onCreate; the persistPendingLkToken cache is
  //      consulted by LkTokenFetcher (used by IncomingCallActivity), so we
  //      also fire a second startActivity with the populated extras — the
  //      activity's onNewIntent picks up the late token and calls
  //      bringUpRoom() without re-creating the UI.
  const nativePresent = ExpoCallKit.startOutgoingCall({
    callee_email: String(calleeEmail ?? ''),
    callee_name: String(calleeName || calleeEmail || ''),
    callee_avatar: String(calleeAvatar ?? ''),
    caller_name: String(callerName ?? ''),
    is_video: !!isVideo,
    room_name: String(cid ?? ''),
    conversation_id: String(conversationId ?? ''),
    call_id: String(cid ?? ''),
  });

  // Background: mint LK token then forward it to native.
  (async () => {
    try {
      const tokenResp = await api.chatLivekitToken(conversationId || '', cid);
      if (tokenResp?.success && tokenResp.data) {
        const lkUrl = tokenResp.data.url || '';
        const lkToken = tokenResp.data.token || '';
        if (lkUrl && lkToken) {
          // Cache for the iOS CX delegate fetcher AND for the Android
          // CallActivity.onNewIntent late-token path.
          try {
            await ExpoCallKit.persistPendingLkToken(cid, lkToken, lkUrl);
          } catch {}
          // Android needs a second startActivity with the token in extras so
          // onNewIntent fires bringUpRoom. iOS doesn't need this — its
          // delegate path consults NativeCallTokenFetcher directly.
          if (Platform.OS === 'android') {
            try {
              await ExpoCallKit.startOutgoingCall({
                callee_email: String(calleeEmail ?? ''),
                callee_name: String(calleeName || calleeEmail || ''),
                callee_avatar: String(calleeAvatar ?? ''),
                caller_name: String(callerName ?? ''),
                is_video: !!isVideo,
                room_name: String(cid ?? ''),
                conversation_id: String(conversationId ?? ''),
                call_id: String(cid ?? ''),
                lk_url: String(lkUrl ?? ''),
                lk_token: String(lkToken ?? ''),
              });
            } catch (e) {
              console.warn(TAG, 'android late-token re-launch failed:', e?.message || e);
            }
          }
        }
      }
    } catch (e) {
      console.warn(TAG, 'chatLivekitToken failed (non-fatal):', e?.message || e);
    }
  })();

  try {
    await nativePresent;
    return { callId: cid, native: true };
  } catch (e) {
    console.warn(TAG, 'native startOutgoingCall failed:', e?.message || e);
    // [WAVE 117A] Mobile = 100% native. Callers gate any router.push('/call')
    // behind Platform.OS === 'web', so native failure shows user-facing error
    // on mobile instead of falling through to the JS screen.
    return { callId: cid, native: false, error: e };
  }
}

export default { startOutgoingCall };
