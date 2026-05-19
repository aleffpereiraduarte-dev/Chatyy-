package expo.modules.callkit

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class CallActionReceiver : BroadcastReceiver() {

  companion object {
    private const val TAG = "CallActionReceiver"
    const val ACTION_ACCEPT_CALL = "ACTION_ACCEPT_CALL"
    const val ACTION_DECLINE_CALL = "ACTION_DECLINE_CALL"
    /** [hangup-from-notif, 2026-05-19] Fired by the "Encerrar" action in the
     *  persistent in-call notification built by CallOngoingService. Different
     *  from DECLINE (which targets the *incoming* ring notification before
     *  accept); HANGUP targets an *active* call after both peers connected. */
    const val ACTION_HANGUP = "ACTION_HANGUP_CALL"
  }

  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra("call_id") ?: return

    when (intent.action) {
      // ──────────────────────────────────────────────────────────────
      // [2026-05-16 Stage 4] Native-only accept path. Mirror of
      // IncomingCallActivity.onAccept: persist accept flag + pending call,
      // emit JS event (no-op if app dead — JS picks up via
      // consumePendingCall on next mount), cancel ringing UI, then launch
      // CallActivity with LK token (cache hit) or fetch + launch async.
      //
      // This is added as an alternative entry point for the
      // notification "Aceitar" button. The notification currently uses
      // PendingIntent.getActivity → IncomingCallActivity (auto_accept=true);
      // platforms / future channels can target this receiver instead via
      // PendingIntent.getBroadcast for the same end-to-end behavior.
      // ──────────────────────────────────────────────────────────────
      ACTION_ACCEPT_CALL -> {
        val callerName = intent.getStringExtra("caller_name") ?: ""
        val callerEmail = intent.getStringExtra("caller_email") ?: ""
        val conversationId = intent.getStringExtra("conversation_id") ?: ""
        val hasVideo = intent.getBooleanExtra("has_video", false)

        Log.d(TAG, "ACTION_ACCEPT_CALL callId=$callId caller=$callerName video=$hasVideo")

        // Pre-warm audio so the first RTP packets aren't dropped while the
        // LK publisher attaches.
        try {
          val am = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
          am.mode = android.media.AudioManager.MODE_IN_COMMUNICATION
          am.requestAudioFocus(
            null,
            android.media.AudioManager.STREAM_VOICE_CALL,
            android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
          )
        } catch (_: Exception) {}

        // Bookkeeping: persist + emit BEFORE we tear down the notification,
        // matching IncomingCallActivity.onAccept ordering. The persisted
        // accept flag is what suppresses the phantom decline that fires
        // from the deleteIntent when stopRingingService nukes the FGS.
        ExpoCallKitModule.savePendingAcceptedCall(
          context.applicationContext,
          callId, callerName, callerEmail, conversationId, hasVideo
        )
        ExpoCallKitModule.persistCallAccepting(context.applicationContext, callId)
        ExpoCallKitModule.emitCallAnswered(callId)

        // Tear down ring UI before launching CallActivity to avoid stacking.
        CallNotificationService.cancelNotification(context, callId)
        stopRingingService(context)

        // Also close the lockscreen ringing activity if it's open, so the
        // user transitions cleanly from IncomingCallActivity → CallActivity.
        closeIncomingCallActivity(context)

        launchCallActivity(context.applicationContext, callId, callerName, callerEmail, conversationId, hasVideo)

        // [2026-05-16 Stage 2 native WS signaling] Fire call_answered from
        // native after the CallActivity launch is scheduled. This path is
        // the notification "Aceitar" button (separate from
        // IncomingCallActivity.onAccept); both fire call_answered, which
        // is fine — server dedupes by call_id. Empty conversation_id is
        // tolerated for dialer-style calls.
        CallSignalWs.fireCallAnswered(context.applicationContext, callId, conversationId)
      }

      ACTION_HANGUP -> {
        // [hangup-from-notif, 2026-05-19] User tapped "Encerrar" on the
        // persistent in-progress notification. Sequence mirrors the JS
        // endCall path in ExpoCallKitModule.endCall:
        //   1. Tell CallActivity (if alive) to finish via the broadcast it
        //      already listens to (ACTION_CLOSE wired to closeReceiver →
        //      finishCall("close_broadcast")).
        //   2. Stop the in-progress FGS so the notification disappears.
        //   3. Emit onCallEnded to JS so the WS layer fires call_end and
        //      the remote peer's UI tears down.
        // We do not need to touch the ringing services here — by definition
        // an ACTIVE call has already accepted the ring, so those are gone.
        Log.d(TAG, "ACTION_HANGUP callId=$callId — closing active call")
        try {
          val closeIntent = Intent("expo.modules.callkit.CLOSE_CALL_ACTIVITY")
          context.sendBroadcast(closeIntent)
        } catch (_: Exception) {}
        try {
          val stopOngoing = Intent(context, CallOngoingService::class.java)
          context.stopService(stopOngoing)
        } catch (_: Exception) {}
        ExpoCallKitModule.emitCallEnded(callId)
      }

      ACTION_DECLINE_CALL -> {
        // If the call is already in the accept path, swallow the decline. This
        // path also fires from setDeleteIntent when the foreground notification
        // is dismissed because the service is stopped during accept — without
        // this guard, emitCallEnded leaks to JS → onEnd handler sends call_end
        // to the WS server → caller A sees "call ended" while B is connecting.
        //
        // [2026-05-15 #977] Check BOTH the in-memory set AND the persisted
        // SharedPreferences flag. The in-memory set survives module re-init
        // but not full process death — FCM cold-start scenarios kill the JVM
        // mid-accept (the FCM service is one-shot, Android reaps the process
        // ~5s after stopSelf), and the phantom decline that fires after the
        // reborn process has an EMPTY HashMap → guard bypassed. The persisted
        // flag survives any number of process kills within the 60s TTL.
        if (ExpoCallKitModule.isCallAccepting(callId) ||
            ExpoCallKitModule.isCallAcceptingPersisted(context, callId)) {
          Log.d(TAG, "ACTION_DECLINE_CALL suppressed for callId=$callId (accept in flight)")
          return
        }

        // Cancel the notification
        CallNotificationService.cancelNotification(context, callId)

        // Stop the ringing foreground service
        stopRingingService(context)

        // Send event to JS
        ExpoCallKitModule.emitCallEnded(callId)

        // Close the IncomingCallActivity if it's open
        closeIncomingCallActivity(context)
      }
    }
  }

  // ────────────────── helpers ──────────────────

  private fun stopRingingService(context: Context) {
    try {
      val stopIntent = Intent(context, CallRingingService::class.java)
      context.stopService(stopIntent)
    } catch (e: Exception) {
      // Service may not be running
    }
  }

  private fun closeIncomingCallActivity(context: Context) {
    val closeIntent = Intent("expo.modules.callkit.CLOSE_CALL_ACTIVITY")
    context.sendBroadcast(closeIntent)
  }

  /**
   * Token resolution + CallActivity launch. Cache hit → start synchronously.
   * Cache miss → fetch on Dispatchers.IO via LkTokenFetcher, then start.
   * BroadcastReceivers in Android 12+ can start activities only while their
   * onReceive is running (foreground-equivalent grant) — but the grant
   * survives a brief async dispatch as long as the new activity comes from
   * the receiver's process. To be safe we use a goAsync() pending result
   * for the fetch path, finishing it once startActivity is called.
   */
  private fun launchCallActivity(
    context: Context,
    callId: String,
    callerName: String,
    callerEmail: String,
    conversationId: String,
    hasVideo: Boolean
  ) {
    val cached = LkTokenFetcher.getCached(context, callId)
    if (cached != null) {
      Log.d(TAG, "[stage4] cache hit — launching CallActivity sync")
      startCallActivityWith(context, callId, callerName, callerEmail, conversationId, hasVideo, cached.url, cached.token)
      return
    }

    // Cache miss — fetch async, then start.
    val pending = goAsync()
    CoroutineScope(Dispatchers.IO).launch {
      try {
        val identity = callerEmail.takeIf { it.isNotBlank() } ?: "android-$callId"
        val tk = LkTokenFetcher.fetch(context, callId, identity)
        if (tk == null) {
          Log.w(TAG, "[stage4] token fetch failed — launching CallActivity w/o token")
          startCallActivityWith(context, callId, callerName, callerEmail, conversationId, hasVideo, null, null)
        } else {
          Log.d(TAG, "[stage4] token fetched — launching CallActivity")
          startCallActivityWith(context, callId, callerName, callerEmail, conversationId, hasVideo, tk.url, tk.token)
        }
      } catch (t: Throwable) {
        Log.e(TAG, "launchCallActivity async failed: ${t.message}")
      } finally {
        try { pending.finish() } catch (_: Exception) {}
      }
    }
  }

  private fun startCallActivityWith(
    context: Context,
    callId: String,
    callerName: String,
    callerEmail: String,
    conversationId: String,
    hasVideo: Boolean,
    url: String?,
    token: String?
  ) {
    try {
      val intent = Intent(context, CallActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        putExtra(CallActivity.EXTRA_CALL_ID, callId)
        putExtra(CallActivity.EXTRA_CALLER_NAME, callerName)
        putExtra(CallActivity.EXTRA_CALLER_EMAIL, callerEmail)
        putExtra(CallActivity.EXTRA_HAS_VIDEO, hasVideo)
        // [2026-05-16 Stage 2] Forward conversation_id so CallActivity's
        // finishCall() fires call_end with the right (call_id, conv_id)
        // pair via CallSignalWs.
        putExtra(CallActivity.EXTRA_CONVERSATION_ID, conversationId)
        if (!url.isNullOrEmpty()) putExtra(CallActivity.EXTRA_LK_URL, url)
        if (!token.isNullOrEmpty()) putExtra(CallActivity.EXTRA_LK_TOKEN, token)
        // [#1175 2026-05-18] Carry auth in intent so CallActivity onCreate
        // has an independent copy even if SharedPreferences is wiped
        // between this broadcast and the activity onCreate.
        ExpoCallKitModule.enrichIntentWithAuth(context, this)
      }
      context.startActivity(intent)
    } catch (t: Throwable) {
      Log.e(TAG, "startCallActivity failed: ${t.message}")
    }
  }
}
