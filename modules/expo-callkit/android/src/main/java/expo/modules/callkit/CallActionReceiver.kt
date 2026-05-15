package expo.modules.callkit

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class CallActionReceiver : BroadcastReceiver() {

  companion object {
    private const val TAG = "CallActionReceiver"
  }

  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra("call_id") ?: return

    when (intent.action) {
      // Accept is now handled by PendingIntent.getActivity -> IncomingCallActivity with auto_accept=true
      // This avoids Android 12+ restriction where BroadcastReceivers cannot start Activities from background

      "ACTION_DECLINE_CALL" -> {
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
}
