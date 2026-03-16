package expo.modules.callkit

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class CallActionReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra("call_id") ?: return

    when (intent.action) {
      // Accept is now handled by PendingIntent.getActivity -> IncomingCallActivity with auto_accept=true
      // This avoids Android 12+ restriction where BroadcastReceivers cannot start Activities from background

      "ACTION_DECLINE_CALL" -> {
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
