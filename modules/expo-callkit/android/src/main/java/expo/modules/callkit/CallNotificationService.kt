package expo.modules.callkit

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat

object CallNotificationService {

  const val CHANNEL_ID = "incoming_calls"
  private const val NOTIFICATION_TAG = "call_notification"

  fun createNotificationChannel(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val name = "Chamadas recebidas"
      val description = "Notificacoes de chamadas recebidas"
      val importance = NotificationManager.IMPORTANCE_HIGH

      val channel = NotificationChannel(CHANNEL_ID, name, importance).apply {
        this.description = description
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        setBypassDnd(true)
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 1000, 1000)

        val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val audioAttributes = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build()
        setSound(ringtoneUri, audioAttributes)
      }

      val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      notificationManager.createNotificationChannel(channel)
    }
  }

  /**
   * Build a Notification object for an incoming call.
   * Used by both CallRingingService (foreground service) and the fallback path.
   */
  fun buildIncomingCallNotification(
    context: Context,
    callId: String,
    callerName: String,
    callerEmail: String,
    conversationId: String,
    hasVideo: Boolean
  ): Notification {
    val notificationId = callId.hashCode()

    // Full-screen intent -> launches IncomingCallActivity
    val fullScreenIntent = Intent(context, IncomingCallActivity::class.java).apply {
      putExtra("call_id", callId)
      putExtra("caller_name", callerName)
      putExtra("caller_email", callerEmail)
      putExtra("conversation_id", conversationId)
      putExtra("has_video", hasVideo)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
    }
    val fullScreenPendingIntent = PendingIntent.getActivity(
      context,
      notificationId,
      fullScreenIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    // Accept action — uses PendingIntent.getActivity to launch IncomingCallActivity
    // with auto_accept=true. On Android 12+, BroadcastReceivers CANNOT start Activities
    // from background, so we must use getActivity directly.
    val acceptIntent = Intent(context, IncomingCallActivity::class.java).apply {
      putExtra("call_id", callId)
      putExtra("caller_name", callerName)
      putExtra("caller_email", callerEmail)
      putExtra("conversation_id", conversationId)
      putExtra("has_video", hasVideo)
      putExtra("auto_accept", true)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val acceptPendingIntent = PendingIntent.getActivity(
      context,
      notificationId + 1,
      acceptIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    // Decline action — BroadcastReceiver is fine for decline (no Activity needed)
    val declineIntent = Intent(context, CallActionReceiver::class.java).apply {
      action = "ACTION_DECLINE_CALL"
      putExtra("call_id", callId)
    }
    val declinePendingIntent = PendingIntent.getBroadcast(
      context,
      notificationId + 2,
      declineIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val callTypeText = if (hasVideo) "Chamada de video" else "Chamada de voz"

    // Get the app icon resource
    val appIconRes = context.applicationInfo.icon
    val smallIconRes = try {
      context.resources.getIdentifier("ic_notification", "drawable", context.packageName)
    } catch (_: Exception) { 0 }
    val iconRes = if (smallIconRes != 0) smallIconRes else appIconRes

    return NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(iconRes)
      .setContentTitle(callerName)
      .setContentText(callTypeText)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setFullScreenIntent(fullScreenPendingIntent, true)
      .addAction(0, "Recusar", declinePendingIntent)
      .addAction(0, "Atender", acceptPendingIntent)
      .setDeleteIntent(declinePendingIntent)
      .build()
  }

  /**
   * Show an incoming call notification directly (fallback when foreground service fails).
   */
  fun showIncomingCallNotification(
    context: Context,
    callId: String,
    callerName: String,
    hasVideo: Boolean,
    callerEmail: String = "",
    conversationId: String = ""
  ) {
    createNotificationChannel(context)

    val notification = buildIncomingCallNotification(context, callId, callerName, callerEmail, conversationId, hasVideo)
    val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    notificationManager.notify(NOTIFICATION_TAG, callId.hashCode(), notification)
  }

  fun cancelNotification(context: Context, callId: String) {
    val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    notificationManager.cancel(NOTIFICATION_TAG, callId.hashCode())
  }
}
