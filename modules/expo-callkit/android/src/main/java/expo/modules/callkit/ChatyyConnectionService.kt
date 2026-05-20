package expo.modules.callkit

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import androidx.annotation.RequiresApi

/**
 * [STAGE-B 2026-05-20] ChatyyConnectionService — the missing half of the
 * Telecom self-managed integration. ChatyyInCallService was a stub since
 * 2026-05-17; this file finally makes Chatyy a real Telecom calling app
 * with parity to WhatsApp/Telegram.
 *
 * What changes vs. the Signal-style fullScreenIntent-only path we had until
 * Stage A:
 *
 *   1. Auto MODE_IN_COMMUNICATION + audio focus. When we call `setActive()`
 *      on the Connection from `onAnswer()`, Telecom flips the system audio
 *      mode + claims STREAM_VOICE_CALL focus on our behalf. We no longer
 *      need to manually `am.mode = MODE_IN_COMMUNICATION`, `am.request
 *      AudioFocus(...)`, and worry about the abandonFocus(null) leak (the
 *      #1201 audio fix on IncomingCallActivity.onAccept). The OS does it.
 *
 *   2. Bluetooth / Auto / Wear integration. Self-managed Connections are
 *      first-class citizens to BluetoothHeadsetService and AAOS. Tapping
 *      the answer button on a Bose headset, an Android Auto head-unit, or
 *      a Wear OS watch routes the answer event into `onAnswer()` exactly
 *      like a tap on our IncomingCallActivity button.
 *
 *   3. Android 14+ FullScreenIntent policy compliance. Posting a heads-up
 *      notification with `setFullScreenIntent(...)` from background was
 *      gated on USE_FULL_SCREEN_INTENT in API 34; with a self-managed
 *      Connection set to RINGING the OS *itself* surfaces the FSI without
 *      needing our permission grant. Robust fallback when the user has
 *      denied the runtime permission via Settings.
 *
 *   4. Concurrency with cellular. The phone app's existing GSM call is a
 *      MANAGED Connection; ours is SELF_MANAGED. Telecom arbitrates: if
 *      the user has a cellular call active, ours rings only after that
 *      one disconnects (or in parallel with `setActive()` if both apps
 *      agree). Without Telecom, our ringer would just step on the cellular
 *      audio.
 *
 * Lifecycle wiring:
 *
 *   FCM data arrives → CallFirebaseMessagingService.onMessageReceived
 *     → ExpoCallKitModule.displayIncomingCall() (Stage A path) — starts
 *       CallRingingService for the ringtone + posts the notification
 *     → ALSO calls TelecomManager.addNewIncomingCall(handle, extras) with
 *       the call payload in extras
 *     → System dispatches into our [onCreateIncomingConnection], which
 *       returns a [ChatyyConnection] with PROPERTY_SELF_MANAGED + STATE_RINGING
 *     → user accepts via lockscreen FSI / IncomingCallActivity / headset:
 *       → Telecom calls [ChatyyConnection.onAnswer]
 *       → we call setActive() (Telecom flips audio focus)
 *       → we kick LK Room.publish (attach mic publish; Room is already
 *         CONNECTING/CONNECTED from the pre-warm coroutine kicked off in
 *         the FCM service)
 *
 * Manifest entry below the file (AndroidManifest.xml edit).
 */
@RequiresApi(Build.VERSION_CODES.O)
class ChatyyConnectionService : ConnectionService() {

  companion object {
    private const val TAG = "ChatyyConnSvc"

    /**
     * Stable account id used in addition to ChatyyInCallService's so an
     * upgrading user doesn't end up with two PhoneAccounts in Settings.
     * We deliberately reuse the same accountId because TelecomManager
     * dedupes on ComponentName+id, and we WANT the OS to bind both the
     * InCallService AND the ConnectionService to the same handle so the
     * stock dialer Recents tab can attribute calls to "Chatyy".
     */
    internal const val ACCOUNT_ID = "chatyy_voice"

    /**
     * Build a TelecomManager extras Bundle for a Chatyy incoming call.
     * Keep keys snake_case (consistent with FCM payload + Intent extras
     * used by IncomingCallActivity, CallActivity).
     */
    fun buildIncomingExtras(
      callId: String,
      callerName: String,
      callerEmail: String,
      conversationId: String,
      hasVideo: Boolean,
      callerAvatar: String,
      lkUrl: String?,
      lkToken: String?,
      // [A2 gap, 2026-05-20] E.164 phone number of the caller. Carried in the
      // FCM payload as `caller_phone_e164`; populated by chat.php call_notify
      // when the caller's chat_phone_registry entry resolves. Used by
      // onCreateIncomingConnection to build a `tel:` address so the stock
      // dialer Recents tab shows the call as if it came from a phone number
      // instead of a SIP URI — matching WhatsApp's "Recent calls" UX.
      callerPhoneE164: String? = null
    ): Bundle = Bundle().apply {
      putString("call_id", callId)
      putString("caller_name", callerName)
      putString("caller_email", callerEmail)
      putString("conversation_id", conversationId)
      putBoolean("has_video", hasVideo)
      putString("caller_avatar", callerAvatar)
      if (!lkUrl.isNullOrEmpty()) putString("lk_url", lkUrl)
      if (!lkToken.isNullOrEmpty()) putString("lk_token", lkToken)
      if (!callerPhoneE164.isNullOrEmpty()) putString("caller_phone_e164", callerPhoneE164)
    }

    /**
     * [STAGE-B] Stable handle to identify our ConnectionService. The
     * InCallService side (ChatyyInCallService.phoneAccountHandle) returns
     * a handle pointing at the InCallService class — we keep BOTH so
     * upgrading users don't lose the InCallService binding while the new
     * ConnectionService rolls out.
     */
    fun phoneAccountHandle(ctx: Context): PhoneAccountHandle {
      val cn = ComponentName(ctx, ChatyyConnectionService::class.java)
      return PhoneAccountHandle(cn, ACCOUNT_ID)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Incoming
  // ─────────────────────────────────────────────────────────────────────────

  override fun onCreateIncomingConnection(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest?
  ): Connection {
    Log.i(TAG, "onCreateIncomingConnection: req=${request?.address}")
    val extras = request?.extras ?: Bundle()
    // Telecom nests our extras under EXTRA_INCOMING_CALL_EXTRAS when we
    // call addNewIncomingCall(handle, extras) — unwrap if present.
    val inner = extras.getBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS) ?: extras

    val callId = inner.getString("call_id") ?: ""
    val callerName = inner.getString("caller_name") ?: "Chatyy"
    val callerEmail = inner.getString("caller_email") ?: ""
    val conversationId = inner.getString("conversation_id") ?: ""
    val hasVideo = inner.getBoolean("has_video", false)
    val callerAvatar = inner.getString("caller_avatar") ?: ""
    val lkUrl = inner.getString("lk_url")
    val lkToken = inner.getString("lk_token")
    // [A2 gap, 2026-05-20] Phone number lookup for the caller in E.164.
    val callerPhoneE164 = inner.getString("caller_phone_e164")

    Log.i(TAG, "onCreateIncomingConnection: callId=$callId from=$callerName video=$hasVideo " +
      "phoneE164=${!callerPhoneE164.isNullOrEmpty()}")

    val conn = ChatyyConnection(
      ctx = applicationContext,
      callId = callId,
      callerName = callerName,
      callerEmail = callerEmail,
      conversationId = conversationId,
      hasVideo = hasVideo,
      callerAvatar = callerAvatar,
      lkUrl = lkUrl,
      lkToken = lkToken,
    ).also { c ->
      // Required on every self-managed Connection.
      c.setAudioModeIsVoip(true)
      c.connectionProperties = Connection.PROPERTY_SELF_MANAGED
      // [A2 gap, 2026-05-20] Base capabilities + video capabilities when the
      // call is video. CAPABILITY_SUPPORTS_VT_LOCAL_RX + _REMOTE_RX tell the
      // Telecom framework that this Connection can carry a video stream, so
      // Android Auto / Wear OS / stock dialer surface the appropriate UI
      // (Hands-free voice-to-video upgrade, etc.). Without these, the system
      // treats us as voice-only and grays out video controls in the call UI.
      var caps = (
        Connection.CAPABILITY_HOLD
          or Connection.CAPABILITY_MUTE
          or Connection.CAPABILITY_SUPPORT_HOLD
      )
      if (hasVideo) {
        caps = caps or
          Connection.CAPABILITY_SUPPORTS_VT_LOCAL_RX or
          Connection.CAPABILITY_SUPPORTS_VT_REMOTE_RX
      }
      c.connectionCapabilities = caps
      // [A2 gap, 2026-05-20] Caller display. Prefer a real `tel:` URI when
      // the caller's E.164 phone is known — Recents shows it as if a phone
      // call came in (matches WhatsApp). Fall back to the email-based `sip:`
      // URI when phone is missing (callers that signed up via email only).
      val addressUri = if (!callerPhoneE164.isNullOrEmpty()) {
        Uri.fromParts("tel", callerPhoneE164, null)
      } else {
        Uri.fromParts("tel", callerEmail.ifBlank { "chatyy" }, null)
      }
      c.setAddress(addressUri, TelecomManager.PRESENTATION_ALLOWED)
      c.setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
      // [A2 gap, 2026-05-20] Set video state on the Connection when applicable.
      // VideoProfile.STATE_BIDIRECTIONAL says both sides can send + receive.
      if (hasVideo) {
        try {
          c.videoState = android.telecom.VideoProfile.STATE_BIDIRECTIONAL
        } catch (t: Throwable) {
          Log.w(TAG, "set videoState failed: ${t.message}")
        }
      }
      c.setRinging()
    }
    return conn
  }

  override fun onCreateIncomingConnectionFailed(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest?
  ) {
    Log.w(TAG, "onCreateIncomingConnectionFailed: request=$request")
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Outgoing (Stage B+ — kept minimal; IncomingCallActivity drives all UI
  // today. Real outgoing path lands when the JS "Ligar" CTA is rewritten
  // to hand the call to Telecom via placeCall(handle, extras).)
  // ─────────────────────────────────────────────────────────────────────────

  override fun onCreateOutgoingConnection(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest?
  ): Connection {
    Log.i(TAG, "onCreateOutgoingConnection: req=${request?.address}")
    val extras = request?.extras ?: Bundle()
    val callId = extras.getString("call_id") ?: ""
    val calleeName = extras.getString("callee_name") ?: "Chatyy"
    val calleeEmail = extras.getString("callee_email") ?: ""
    val hasVideo = extras.getBoolean("has_video", false)
    val lkUrl = extras.getString("lk_url")
    val lkToken = extras.getString("lk_token")

    val conn = ChatyyConnection(
      ctx = applicationContext,
      callId = callId,
      callerName = calleeName,
      callerEmail = calleeEmail,
      conversationId = extras.getString("conversation_id") ?: "",
      hasVideo = hasVideo,
      callerAvatar = "",
      lkUrl = lkUrl,
      lkToken = lkToken,
    ).also { c ->
      c.setAudioModeIsVoip(true)
      c.connectionProperties = Connection.PROPERTY_SELF_MANAGED
      c.connectionCapabilities = (
        Connection.CAPABILITY_HOLD
          or Connection.CAPABILITY_MUTE
          or Connection.CAPABILITY_SUPPORT_HOLD
      )
      c.setCallerDisplayName(calleeName, TelecomManager.PRESENTATION_ALLOWED)
      c.setDialing()
    }
    return conn
  }
}

/**
 * [STAGE-B 2026-05-20] The actual Connection object the Telecom framework
 * holds onto for the lifetime of a single call. Overrides the lifecycle
 * callbacks Telecom fires when the user (or a headset / Auto / Wear)
 * interacts with the system call UI.
 */
@RequiresApi(Build.VERSION_CODES.O)
class ChatyyConnection(
  private val ctx: Context,
  private val callId: String,
  private val callerName: String,
  private val callerEmail: String,
  private val conversationId: String,
  private val hasVideo: Boolean,
  private val callerAvatar: String,
  private val lkUrl: String?,
  private val lkToken: String?,
) : Connection() {

  companion object {
    private const val TAG = "ChatyyConn"
  }

  // ─────────── Telecom-driven lifecycle ───────────

  override fun onAnswer() {
    Log.i(TAG, "onAnswer: callId=$callId — flipping to ACTIVE (Telecom takes audio focus)")
    // [STAGE-B] THE WhatsApp SECRET. setActive() makes Telecom:
    //   - claim STREAM_VOICE_CALL focus for our process
    //   - set AudioManager.mode = MODE_IN_COMMUNICATION
    //   - route audio through the call audio policy (proximity sensor on,
    //     speakerphone false, BT SCO promoted if connected)
    // We no longer need to touch AudioManager directly on accept. The
    // previous IncomingCallActivity.onAccept manual flip remains as a
    // defensive fallback for devices where the user has revoked self-
    // managed permission.
    setActive()

    // Mark accept across in-process + persisted state so the deleteIntent
    // race we hardened in Stage A doesn't ship a phantom decline.
    ExpoCallKitModule.markCallAccepting(callId)
    ExpoCallKitModule.persistCallAccepting(ctx, callId)
    ExpoCallKitModule.savePendingAcceptedCall(
      ctx, callId, callerName, callerEmail, conversationId, hasVideo
    )

    // Stop the ringing FGS — Telecom now owns the audio path, the
    // ringtone has to go silent immediately. Ringtone teardown is
    // CallRingingService's job (stopForeground + cancel notification).
    try {
      val stopIntent = Intent(ctx, CallRingingService::class.java)
      ctx.stopService(stopIntent)
    } catch (_: Exception) {}

    // Tell JS the call is answered. Idempotent — if JS isn't alive yet
    // it's a no-op and the consumePendingCall path will catch up on
    // bundle parse.
    ExpoCallKitModule.emitCallAnswered(callId)

    // Hand mic publish to NativeCallRoom. The Room is already CONNECTING/
    // CONNECTED from the pre-warm path in CallFirebaseMessagingService;
    // if not, attemptAdoption falls back to a fresh launch into CallActivity
    // with the lk_url / lk_token we received in the FCM payload.
    NativeCallRoom.adoptForCall(
      ctx,
      callId = callId,
      lkUrl = lkUrl,
      lkToken = lkToken,
      callerName = callerName,
      callerEmail = callerEmail,
      conversationId = conversationId,
      hasVideo = hasVideo,
      callerAvatar = callerAvatar
    )
  }

  override fun onReject() {
    Log.i(TAG, "onReject: callId=$callId")
    rejectInternal("declined")
  }

  override fun onReject(replyMessage: String?) {
    Log.i(TAG, "onReject(msg): callId=$callId msg=${replyMessage?.take(40)}")
    rejectInternal("declined")
  }

  override fun onDisconnect() {
    Log.i(TAG, "onDisconnect: callId=$callId")
    setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
    ExpoCallKitModule.emitCallEnded(callId)
    try {
      val stop = Intent(ctx, CallRingingService::class.java)
      ctx.stopService(stop)
    } catch (_: Exception) {}
    destroy()
  }

  override fun onHold() {
    Log.i(TAG, "onHold: callId=$callId")
    setOnHold()
    NativeCallRoom.setMicEnabled(false)
  }

  override fun onUnhold() {
    Log.i(TAG, "onUnhold: callId=$callId")
    setActive()
    NativeCallRoom.setMicEnabled(true)
  }

  override fun onAbort() {
    Log.i(TAG, "onAbort: callId=$callId")
    setDisconnected(DisconnectCause(DisconnectCause.OTHER))
    destroy()
  }

  override fun onCallAudioStateChanged(state: android.telecom.CallAudioState?) {
    // Telecom hands us the current audio route (earpiece / speakerphone /
    // BT / wired). We forward to JS so the call screen's speakerphone
    // toggle matches reality (e.g. user plugged in Bose mid-call).
    val s = state ?: return
    val route = when (s.route) {
      android.telecom.CallAudioState.ROUTE_BLUETOOTH -> "bluetooth"
      android.telecom.CallAudioState.ROUTE_WIRED_HEADSET -> "wired"
      android.telecom.CallAudioState.ROUTE_EARPIECE -> "earpiece"
      android.telecom.CallAudioState.ROUTE_SPEAKER -> "speaker"
      else -> "unknown"
    }
    Log.d(TAG, "onCallAudioStateChanged: route=$route muted=${s.isMuted}")
    try {
      ExpoCallKitModule.emitAudioRouteChanged(route, s.isMuted)
    } catch (_: Throwable) {}
  }

  // ─────────── Private helpers ───────────

  private fun rejectInternal(reason: String) {
    setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
    ExpoCallKitModule.emitCallEnded(callId)
    try {
      val stop = Intent(ctx, CallRingingService::class.java)
      ctx.stopService(stop)
    } catch (_: Exception) {}
    // Tell the caller we declined via the existing native WS path. JS-side
    // IncomingCallListener also fires this from emitCallEnded → onCallEnded
    // handler; server dedupes by call_id. Safe.
    try {
      CallSignalWs.fireCallEnd(ctx, callId, conversationId, reason)
    } catch (_: Throwable) {}
    destroy()
  }
}
