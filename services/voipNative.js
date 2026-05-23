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
// [CALL-E2EE 2026-05-22 — Phase 1] Lazy-loaded so dev builds without the
// e2e-call service still boot. The module is pure JS (tweetnacl) so the
// import itself is cheap; we still gate behind the runtime feature flag.
let _e2eCall = null;
let _e2e = null;
function _loadE2eCall() {
  if (!_e2eCall) {
    try { _e2eCall = require('./e2e-call'); } catch (e) {
      console.warn('[voipNative] e2e-call module unavailable:', e?.message || e);
      _e2eCall = false;
    }
  }
  if (!_e2e) {
    try { _e2e = require('./e2e'); } catch { _e2e = false; }
  }
  return _e2eCall && _e2e ? { ec: _e2eCall, e: _e2e } : null;
}

// Feature-flag gate. The client default is OFF for Phase 1 — flipped to ON
// from a future settings hook or remote config. Mirrors the CALL_E2EE_ENABLED
// backend env: even if the caller forces it on, the server returns 501 unless
// the backend flag is also flipped.
function _callE2eeEnabled() {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : global;
    if (g && g.__CALL_E2EE_ENABLED === true) return true;
  } catch {}
  return false;
}

const TAG = '[voipNative]';

// [WAVE 119, 2026-05-22] Relay-first feature flag. When ON, startOutgoingCall
// calls `chat_call_invite_v2` BEFORE the native CallActivity launch and pipes
// the pre-minted LK token + TURN credentials into native via
// persistPendingLkToken — eliminating the legacy 200-500ms token-mint round
// trip that previously ran AFTER ExpoCallKit.startOutgoingCall. Combined with
// the client-side iceTransportPolicy='relay' (CallActivity.kt /
// CallViewController.swift WAVE 115 blocks) the tap→audible-audio budget
// drops from ~1500ms to <500ms p50.
//
// Toggle at runtime via setRelayFirstV2Enabled(true|false). Default OFF for
// canary rollout; flip to true after 5%/50%/100% measurements look healthy
// (see /var/www/mail/docs/relay-first-migration.md §Verification).
let RELAY_FIRST_V2_ENABLED = false;
export function setRelayFirstV2Enabled(v) { RELAY_FIRST_V2_ENABLED = !!v; }
export function isRelayFirstV2Enabled() { return RELAY_FIRST_V2_ENABLED; }

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

// [WAVE 138] BUG-4: Anti-double-tap lock. Without this, a user mashing
// the call button (or React re-rendering and re-firing onPress before the
// first tap settles) fires startOutgoingCall twice → 2 distinct callIds,
// 2 chat_call_invite_v2 requests, 2 native CallActivity launches,
// 2 UIs on the callee. Module-level Map keyed by (calleeEmail, conversationId)
// with a 5s TTL — covers React StrictMode double-invoke AND human jitter.
const _outgoingCallLock = new Map();
const _OUTGOING_LOCK_TTL_MS = 5000;

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
// [WAVE 141] signature dropped `onForegroundJsRoute` — mobile is always
// native; we kept the name out of the destructure on purpose so any straggler
// callsite still passing it just ignores the field instead of silently
// reactivating a JS foreground path.
export async function startOutgoingCall({
  calleeEmail,
  calleeName,
  callerName,
  isVideo,
  conversationId,
  callId,
  onWebFallback,
} = {}) {
  // [CALL-TRACE 2026-05-21 ROUND3] Step 2a/12 — voipNative entry. Snapshot
  // every field BEFORE any coercion / validation so we can see exactly what
  // the caller (chat-conversation/ChatCallsTab/one.js) handed us. Critical
  // for diagnosing camelCase mismatches and missing fields without a device
  // attached.
  try {
    console.log('[CALL-TRACE][2a/12] voipNative.startOutgoingCall ENTRY', {
      calleeEmail_raw: calleeEmail,
      calleeEmail_type: typeof calleeEmail,
      calleeName,
      callerName,
      isVideo: !!isVideo,
      conversationId,
      callId,
      hasOnWebFallback: typeof onWebFallback === 'function',
      ts: Date.now(),
    });
  } catch {}

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
    try {
      console.warn('[CALL-TRACE][2a/12][FAIL] empty calleeEmail', {
        calleeEmail_raw: calleeEmail,
        calleeName,
        conversationId,
        ts: Date.now(),
      });
    } catch {}
    throw err;
  }
  // Use the trimmed value below so downstream native layers receive a
  // clean string with no whitespace surprises.
  calleeEmail = calleeEmailStr;

  // [WAVE 138] BUG-4: Anti-double-tap lock. If we already have an
  // in-flight outgoing call to the same callee in the same conversation
  // within the last 5s, drop the second invocation. We DO NOT throw — we
  // return a sentinel `{blocked:'double_tap'}` so the JS caller (chat-
  // conversation.js, ChatCallsTab.js) can render a friendly toast instead
  // of an error modal. The lock is keyed by (calleeEmail, conversationId)
  // so a user can still place a deliberate second call to a different
  // contact / conversation without delay.
  const _lockKey = `${calleeEmail}:${conversationId || ''}`;
  const _lockHit = _outgoingCallLock.get(_lockKey);
  if (_lockHit && (Date.now() - _lockHit) < _OUTGOING_LOCK_TTL_MS) {
    try {
      console.warn(TAG, '[WAVE 138][BUG-4] double-tap blocked', {
        lockKey: _lockKey,
        msSinceFirst: Date.now() - _lockHit,
      });
    } catch {}
    return { callId: null, native: false, blocked: 'double_tap' };
  }
  _outgoingCallLock.set(_lockKey, Date.now());
  setTimeout(() => {
    try { _outgoingCallLock.delete(_lockKey); } catch {}
  }, _OUTGOING_LOCK_TTL_MS);

  const cid = callId || generateCallId();

  // [CALL-TRACE 2026-05-21 ROUND3] Step 2b/12 — post-validation. Confirms
  // the trimmed calleeEmail + generated cid that propagate to native.
  try {
    console.log('[CALL-TRACE][2b/12] voipNative validated', {
      calleeEmail,
      cid,
      isVideo: !!isVideo,
      conversationId: conversationId || '',
      platform: Platform.OS,
      ts: Date.now(),
    });
  } catch {}
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
  // [CALL-E2EE 2026-05-22] Mint+distribute the per-call master secret as
  // the FIRST network call so the callee's WS can receive the envelope
  // *before* the legacy call_invite push wakes them. Fire-and-forget — a
  // failure here MUST NOT block the call (we fall back to legacy SRTP /
  // DTLS-only). The backend rejects with 501 when CALL_E2EE_ENABLED isn't
  // set, which we treat as a no-op (the rollout staging plan).
  if (conversationId && _callE2eeEnabled()) {
    (async () => {
      try {
        const mods = _loadE2eCall();
        if (!mods) return;
        const { ec, e } = mods;
        // 1. Resolve callee device bundles. chat_conv_device_keys returns
        //    every member-device tuple for the conversation (including our
        //    own paired devices) — perfect fan-out target.
        const bundleResp = await api.apiCall('chat_conv_device_keys', { conversation_id: conversationId });
        const devices = Array.isArray(bundleResp?.data?.devices) ? bundleResp.data.devices : [];
        if (!devices.length) {
          console.warn(TAG, '[CALL-E2EE] no device bundles — skip e2ee mint');
          return;
        }
        // 2. Mint master + build per-device envelopes.
        const master = ec.mintCallMasterSecret();
        const bundles = devices.map((d) => ({
          email:      d.email,
          device_id:  d.device_id,
          pubkey_b64: d.pubkey,
        }));
        const envelopes = ec.buildEnvelopesForBundles(master, bundles);
        const callerDeviceId = await e.getDeviceId();
        // 3. Ship.
        const r = await api.chatCallInviteE2ee({
          callId: cid,
          callerDeviceId,
          envelopes,
          // sdp_fingerprint filled in by the native layer once DTLS cert is
          // generated; Phase 1 ships without the binding and adds it in a
          // follow-up patch when PJSIP/LK expose the cert via setLocalDescription.
          sdpFingerprint: '',
        });
        console.log('[CALL-E2EE] invite_e2ee resp', { ok: !!r?.success, stored: r?.data?.stored });
        // 4. Cache the master for the local SRTP-derivation step. We never
        //    persist this to disk — process-memory only, zeroized on call_end.
        try {
          const g = typeof globalThis !== 'undefined' ? globalThis : global;
          if (g) {
            if (!g.__callMasterSecrets) g.__callMasterSecrets = new Map();
            g.__callMasterSecrets.set(cid, master);
          }
        } catch {}
      } catch (e) {
        console.warn(TAG, '[CALL-E2EE] mint/distribute failed (non-fatal):', e?.message || e);
      }
    })();
  }

  // [WAVE 119, 2026-05-22] Relay-first v2 fast path. When the feature flag is
  // ON, replace the legacy fire-and-forget `call_notify` + lazy
  // `chat_livekit_token` round-trip with a single `chat_call_invite_v2` call
  // that:
  //   - mints the caller's LK token (no second HTTP)
  //   - mints TURN HMAC creds (no third HTTP)
  //   - INSERTs chat_call_active row (crash-recovery)
  //   - fans VoIP/FCM/WS invites to callees with their own pre-minted LK token
  //     embedded in the payload
  //
  // We AWAIT this here (~80-120ms) so the LK token + TURN creds are persisted
  // via persistPendingLkToken BEFORE ExpoCallKit.startOutgoingCall fires.
  // The native CallActivity / CallViewController reads the cached token at
  // onCreate / viewDidLoad and goes straight to LiveKit.create + Room.connect
  // with iceTransportPolicy='relay'. Net effect: tap → audible audio drops
  // from ~1500ms to <500ms.
  //
  // Legacy path (callNotify + parallel chatLivekitToken in the background
  // block below) is kept untouched and runs when the flag is OFF — additive
  // rollout, instant revert by flipping setRelayFirstV2Enabled(false).
  let v2Resp = null;
  if (RELAY_FIRST_V2_ENABLED && conversationId) {
    try {
      console.log('[CALL-TRACE][3v2/12] chat_call_invite_v2 fired', {
        conversationId, cid, isVideo: !!isVideo, calleeEmail, ts: Date.now(),
      });
    } catch {}
    try {
      v2Resp = await api.chatCallInviteV2({
        conversationId,
        callId: cid,
        video: !!isVideo,
        calleeEmail,
      });
      try {
        console.log('[CALL-TRACE][3v2/12] chat_call_invite_v2 resp', {
          cid,
          success: !!v2Resp?.success,
          hasLkToken: !!(v2Resp?.data?.lk_token),
          hasTurn: Array.isArray(v2Resp?.data?.turn_uris) && v2Resp.data.turn_uris.length > 0,
          relayNode: v2Resp?.data?.relay_node,
          error: v2Resp?.error || '',
          ts: Date.now(),
        });
      } catch {}
      // [WAVE 138] BUG-1 FIX: chat_call_invite_v2 returns {success:false} on
      // server-side rejection (rate limit, conv permission, missing LK config,
      // etc.) WITHOUT throwing. Previously we only checked `v2Resp` truthiness,
      // which made the legacy fallback below (`if (!v2Resp && conversationId)`)
      // think v2 succeeded — but no callNotify invite was ever sent → callee
      // phone never rings. Force null so the legacy fan-out engages.
      if (!v2Resp?.success) {
        console.warn(TAG, '[WAVE 138][v2] success=false; forcing legacy callNotify fallback', v2Resp?.error || '');
        v2Resp = null;
      }
      // Pre-cache the LK token so the native side picks it up without a
      // second round-trip. iOS: CXStartCallAction handler reads via the
      // NativeCallTokenFetcher pending cache. Android: LkTokenFetcher
      // consumes the same cache and CallActivity proceeds with EXTRA_LK_*
      // already populated (no late onNewIntent re-launch needed).
      const d = v2Resp?.data || {};
      if (d.lk_token && d.lk_url) {
        try {
          await ExpoCallKit.persistPendingLkToken(cid, d.lk_token, d.lk_url);
        } catch (e) {
          console.warn(TAG, '[v2] persistPendingLkToken failed:', e?.message || e);
        }
      }
      // Stash TURN creds on globalThis so the native bridge can read them
      // without yet another async hop. Both platforms can pick this up via
      // the existing camelCase-snake_case wrapper at index.ts.
      try {
        const g = typeof globalThis !== 'undefined' ? globalThis : global;
        if (!g.__pendingTurnCreds) g.__pendingTurnCreds = new Map();
        g.__pendingTurnCreds.set(cid, {
          turn_uris: d.turn_uris || [],
          turn_username: d.turn_username || '',
          turn_password: d.turn_password || '',
          turn_expires_at: d.turn_expires_at || 0,
          relay_node: d.relay_node || '',
          backup_relay: d.backup_relay || '',
        });
      } catch {}
    } catch (e) {
      console.warn(TAG, '[v2] chat_call_invite_v2 failed (falling back to legacy):', e?.message || e);
      v2Resp = null;
    }
  }

  // Legacy fire-and-forget callNotify — runs when v2 is OFF or when v2
  // failed/was skipped (e.g. no conversationId). Identical behavior to the
  // pre-WAVE-119 flow; preserved for rollback safety.
  if (!v2Resp && conversationId) {
    // [CALL-TRACE 2026-05-21 ROUND3] Step 3/12 — fire-and-forget push to
    // wake the callee. We log both the request kickoff and the response
    // shape so a missing call_invite on the peer side can be traced back
    // to a 400/401 here instead of guessing.
    try {
      console.log('[CALL-TRACE][3/12] callNotify fired', {
        conversationId, cid, isVideo: !!isVideo, ts: Date.now(),
      });
    } catch {}
    api.callNotify(conversationId, cid, isVideo)
      .then((resp) => {
        try {
          console.log('[CALL-TRACE][3/12] callNotify resp', {
            cid,
            success: !!resp?.success,
            error: resp?.error || '',
            ts: Date.now(),
          });
        } catch {}
      })
      .catch((e) => {
        console.warn(TAG, '[CALL-TRACE][3/12] callNotify failed (non-fatal):', e?.message || e);
      });
  } else if (!conversationId) {
    try {
      console.warn('[CALL-TRACE][3/12] callNotify SKIPPED (no conversationId)', { cid });
    } catch {}
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
  //
  // [WhatsApp-parity hybrid restore, 2026-05-22]
  // User mandate: "quando a ligacao e feita e o app ta aberto nos n
  // prescisamos de nativo, so se o app tiver minimizado ou fechado".
  // App foreground on mobile → /call.js JS UI (the rich screen with
  // invite-friend, audio↔video upgrade, screenshare, grid). The peer is
  // still rung via call_invite_v2 / callNotify above, and the callee's
  // CallKit / IncomingCallActivity still fires normally (independent of
  // our caller-side UI choice). Native is reserved for outgoing calls
  // from background/killed states — extremely rare in practice (Siri
  // shortcut, share-extension dialing, cold-start "Call again" pill).
  //
  // History: #1208 introduced this gate. #1217 ripped it out (WAVE 117A)
  // because the native↔JS handoff had dual-mount bugs (CallActivity AND
  // /call.js both visible). The Phase 2 native changes below (Swift +
  // Kotlin) close that gap by short-circuiting the native UI when JS
  // owns the foreground. Phase 1 (this commit) is OTA-able and ships
  // the JS side of the contract; Phase 2 lands in the next native build.
  // [WAVE 140 — WhatsApp arch revert, 2026-05-22]
  // GPT-5.5-pro Round 3: WhatsApp NUNCA usa JS como dono da call no mobile.
  // Sempre CallKit/Telecom + LK native + JS espelho. Manter foreground gate
  // JS criava 2 state machines (fg=JS, bg=native) e race condition. /call.js
  // renderer fica MAS agora adopts native session via adoptNativeRoom(callId).
  //
  // Previous behavior (WAVE 138 Phase 1) routed outgoing calls to JS /call.js
  // when AppState === 'active'. This dual-owner model was the root cause of:
  //   - peer receiving 2x 'ended' events (JS + native both signaling)
  //   - LK Room dual-mount when app foregrounded mid-call
  //   - ringtone double-play on callee
  // Native CallKit / CallActivity is now the unconditional owner on mobile.
  // [WAVE 141] kept signature backwards-compat = false; mobile always native.
  // The `onForegroundJsRoute` parameter was removed entirely.

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
  // [2026-05-21 ROOT-CAUSE FIX] The wrapper at modules/expo-callkit/index.ts
  // L545-556 re-maps camelCase → snake_case before calling native. If we pass
  // snake_case keys here, the wrapper's `params.calleeEmail` etc. all read as
  // undefined → native gets a Map with `undefined` values → Kotlin throws
  // "Cannot convert [object Object]... Value is undefined" and iOS Swift
  // sees empty strings for everything. Match the wrapper's expected
  // StartOutgoingCallParams shape (camelCase) and let it do the conversion.
  // [CALL-TRACE 2026-05-21 ROUND3] Step 4/12 — hand off to ExpoCallKit
  // wrapper (modules/expo-callkit/index.ts:542). The wrapper does the
  // camelCase→snake_case remap with the `s()` coercion fixed in the
  // earlier round. Logging the exact payload sent to the wrapper makes
  // any subsequent "Value is undefined" trivial to root-cause.
  const nativePayload = {
    calleeEmail: String(calleeEmail ?? ''),
    calleeName: String(calleeName || calleeEmail || ''),
    calleeAvatar: String(calleeAvatar ?? ''),
    callerName: String(callerName ?? ''),
    isVideo: !!isVideo,
    roomName: String(cid ?? ''),
    conversationId: String(conversationId ?? ''),
    callId: String(cid ?? ''),
  };
  try {
    console.log('[CALL-TRACE][4/12] ExpoCallKit.startOutgoingCall payload', {
      ...nativePayload,
      // Explicit empty-string spotting — the wrapper coerces undefined → ''
      // so the only way to see a true "" here is a truly empty source field.
      emptyFields: Object.keys(nativePayload).filter(
        (k) => typeof nativePayload[k] === 'string' && nativePayload[k] === ''
      ),
      ts: Date.now(),
    });
  } catch {}
  // [WAVE 136 2026-05-22] Pre-flush zombie CallKit UUIDs before requesting
  // a new outgoing call. Symptom: user retries a call → iOS rejects with
  // `com.apple.CallKit.error.requesttransaction error 7` =
  // CXErrorCodeRequestTransactionErrorMaximumCallGroupsReached, because
  // the CXProvider still holds a "live" reference to a previous call
  // whose end-action was never dispatched (JS hangup didn't propagate to
  // native — see WAVE 135 CallContext fix). v2.5.0 has the native-side
  // cleanup but until that ships, sweep AsyncStorage for any stale UUIDs
  // and tell CallKit to release them before requesting a fresh one. Idempotent
  // and safe even when the list is empty.
  try {
    const AS = require('@react-native-async-storage/async-storage').default;
    const raw = await AS.getItem('recent_callkit_uuids');
    if (raw) {
      try {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) {
          for (const oldId of ids) {
            if (oldId && oldId !== cid) {
              try { ExpoCallKit.endCall(String(oldId), 'failed'); } catch {}
            }
          }
        }
      } catch {}
    }
    // Track this new UUID so the next retry can flush it too if user closes
    // the app or the hangup doesn't propagate. Capped at 10 to avoid bloat.
    try {
      const existing = raw ? (JSON.parse(raw) || []) : [];
      const next = Array.isArray(existing) ? [cid, ...existing.filter(x => x !== cid)].slice(0, 10) : [cid];
      await AS.setItem('recent_callkit_uuids', JSON.stringify(next));
    } catch {}
  } catch {}

  // [WAVE 162 2026-05-23] CRITICAL Android→iOS "Sessão expirada" root cause:
  // ExpoCallKitModule.kt:1125-1204 (startOutgoingCall) calls enrichIntentWithAuth
  // which reads from `expo_callkit_prefs` SharedPrefs. If that's empty (cold
  // start, after install, after token rotation) → LkTokenFetcher's 4 sources
  // all return null → banner fires WITHOUT trying HTTP. The native module's
  // own persistAuthForNativeCall is the ONLY way to refresh this stash, and
  // it only ran from storeToken() which doesn't fire on every call.
  //
  // Fix: ALWAYS refresh the prefs stash with the CURRENT bearer right before
  // launching CallActivity. Fire-and-forget; ~5ms.
  try {
    const tok = api.getToken && api.getToken();
    const base = api.BASE_URL || 'https://chatyy.com.br';
    if (tok && ExpoCallKit.persistAuthForNativeCall) {
      ExpoCallKit.persistAuthForNativeCall(tok, base).catch(() => {});
    }
  } catch {}

  const nativePresent = ExpoCallKit.startOutgoingCall(nativePayload);

  // Background: mint LK token then forward it to native.
  // [WAVE 119, 2026-05-22] Skip when v2 already pre-minted the token above —
  // the persistPendingLkToken cache is already populated and the native side
  // doesn't need a second mint. We log the skip so the absence of the legacy
  // 5/12 trace doesn't read as a regression.
  if (v2Resp && v2Resp.data?.lk_token) {
    try {
      console.log('[CALL-TRACE][5/12] chatLivekitToken SKIPPED (v2 pre-minted)', { cid });
    } catch {}
  } else (async () => {
    try {
      // [CALL-TRACE 2026-05-21 ROUND3] Step 5/12 — chatLivekitToken request.
      // This races the native present (~100ms vs ~300-500ms). The native
      // side has token-fetcher fallbacks if this loses the race.
      try {
        console.log('[CALL-TRACE][5/12] chatLivekitToken request', {
          conversationId: conversationId || '', cid, ts: Date.now(),
        });
      } catch {}
      const tokenResp = await api.chatLivekitToken(conversationId || '', cid);
      try {
        console.log('[CALL-TRACE][5/12] chatLivekitToken resp', {
          cid,
          success: !!tokenResp?.success,
          hasUrl: !!tokenResp?.data?.url,
          hasToken: !!tokenResp?.data?.token,
          error: tokenResp?.error || '',
          ts: Date.now(),
        });
      } catch {}
      if (tokenResp?.success && tokenResp.data) {
        const lkUrl = tokenResp.data.url || '';
        const lkToken = tokenResp.data.token || '';
        if (lkUrl && lkToken) {
          // Cache for the iOS CX delegate fetcher AND for the Android
          // LkTokenFetcher cache-source path (#1169). The native side
          // observes this cache so the in-flight CallActivity picks up
          // the token without re-launching.
          try {
            await ExpoCallKit.persistPendingLkToken(cid, lkToken, lkUrl);
          } catch {}
          // [2026-05-21 #1310 "dual call system" fix] Removed the second
          // ExpoCallKit.startOutgoingCall(...) call that previously fired
          // here on Android. That extra startActivity was the root cause
          // of the "2 sistemas de ligação" user report: the first launch
          // mounted CallActivity without an LK token (showing
          // "Desconectado"), and the late-token re-launch started a
          // SECOND CallActivity instance on top, both visible (the bottom
          // CallStatusBar plus the new full-screen activity that finally
          // connects). Since #1169 wired LkTokenFetcher to consume the
          // `persistPendingLkToken` cache directly, the second
          // startActivity is no longer needed — the in-flight Activity
          // observes the cache and calls bringUpRoom() without a remount.
        }
      }
    } catch (e) {
      console.warn(TAG, 'chatLivekitToken failed (non-fatal):', e?.message || e);
    }
  })();

  try {
    const ok = await nativePresent;
    // [CALL-TRACE 2026-05-21 ROUND3] Step 6/12 — native promise resolved.
    // `ok` is the boolean returned by the wrapper (true once the
    // CXStartCallAction transaction was queued / startActivity fired).
    try {
      console.log('[CALL-TRACE][6/12] native startOutgoingCall resolved', {
        cid, ok, ts: Date.now(),
      });
    } catch {}
    return { callId: cid, native: true };
  } catch (e) {
    // [CALL-TRACE 2026-05-21 ROUND3] Step 6/12 FAIL — native rejection.
    // Most common causes: native module missing in build, CallKit not
    // configured (iOS), startActivity blocked by missing permission
    // (Android). Surface message+code so the caller's Alert is actionable.
    try {
      console.warn('[CALL-TRACE][6/12][FAIL] native startOutgoingCall rejected', {
        cid,
        message: e?.message || String(e),
        code: e?.code,
        ts: Date.now(),
      });
    } catch {}
    console.warn(TAG, 'native startOutgoingCall failed:', e?.message || e);
    // [WAVE 117A] Mobile = 100% native. Callers gate any router.push('/call')
    // behind Platform.OS === 'web', so native failure shows user-facing error
    // on mobile instead of falling through to the JS screen.
    return { callId: cid, native: false, error: e };
  }
}

export default { startOutgoingCall };
