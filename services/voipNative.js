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

import { Platform } from 'react-native';
import * as ExpoCallKit from '../modules/expo-callkit';
import * as api from './api';

const TAG = '[voipNative]';

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
  if (!calleeEmail) {
    throw new Error('startOutgoingCall: calleeEmail is required');
  }
  const cid = callId || generateCallId();

  // Fire-and-forget push notification so the callee's phone rings. Server
  // returns immediately — we don't block the native present on this.
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

  // Best-effort warm-up: mint the LiveKit token on the JS side so the native
  // screen can connect to LK without an extra HTTP round trip after the
  // CXStartCallAction / CallActivity start. If the mint fails the native side
  // will fall back to its own NativeCallTokenFetcher / LkTokenFetcher.
  let lkUrl = null;
  let lkToken = null;
  try {
    const tokenResp = await api.chatLivekitToken(conversationId || '', cid);
    if (tokenResp?.success && tokenResp.data) {
      lkUrl = tokenResp.data.url || null;
      lkToken = tokenResp.data.token || null;
      // Cache into native so the answer path (if it races) can pick it up.
      if (lkUrl && lkToken) {
        try {
          await ExpoCallKit.persistPendingLkToken(cid, lkToken, lkUrl);
        } catch {}
      }
    }
  } catch (e) {
    console.warn(TAG, 'chatLivekitToken failed (non-fatal):', e?.message || e);
  }

  try {
    await ExpoCallKit.startOutgoingCall({
      calleeEmail,
      calleeName: calleeName || calleeEmail,
      callerName: callerName || '',
      isVideo: !!isVideo,
      roomName: cid,
      conversationId: conversationId || '',
      callId: cid,
      lkUrl: lkUrl || undefined,
      lkToken: lkToken || undefined,
    });
    return { callId: cid, native: true };
  } catch (e) {
    console.warn(TAG, 'native startOutgoingCall failed:', e?.message || e);
    // Surface failure so the caller can fall back to /call.js.
    return { callId: cid, native: false, error: e };
  }
}

export default { startOutgoingCall };
