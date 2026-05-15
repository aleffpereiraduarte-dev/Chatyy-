package expo.modules.callkit

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

object CallNotificationService {

  const val CHANNEL_ID = "incoming_calls"
  private const val NOTIFICATION_TAG = "call_notification"
  private const val TAG = "CallNotificationService"

  // Cache fetched avatar bitmaps por URL pra evitar re-download enquanto a
  // notification re-renderiza (ringing+chamada). Cap em 8 entries.
  private val avatarCache = ConcurrentHashMap<String, Bitmap>()

  /**
   * Baixa o avatar sincronamente (chamado dentro de Thread). Retorna null em
   * caso de qualquer erro — notification cai no fallback de inicial.
   */
  fun fetchAvatarBitmap(urlStr: String): Bitmap? {
    if (urlStr.isEmpty()) return null
    avatarCache[urlStr]?.let { return it }
    return try {
      val conn = URL(urlStr).openConnection()
      conn.connectTimeout = 5_000
      conn.readTimeout = 5_000
      val bmp = conn.getInputStream().use { BitmapFactory.decodeStream(it) }
      if (bmp != null) {
        // Cap cache size
        if (avatarCache.size >= 8) avatarCache.clear()
        avatarCache[urlStr] = bmp
      }
      bmp
    } catch (e: Exception) {
      Log.w(TAG, "fetchAvatarBitmap failed for $urlStr: ${e.message}")
      null
    }
  }

  /**
   * Dispara o re-build da notification em background com setLargeIcon.
   * Sem isso o usuário só vê a inicial — o avatar é fetched async no
   * mesmo NotificationId pra atualizar em ~200-800ms (LAN/WiFi).
   */
  private fun refreshNotificationWithAvatar(
    context: Context,
    callId: String,
    callerName: String,
    callerEmail: String,
    conversationId: String,
    hasVideo: Boolean,
    avatarUrl: String
  ) {
    if (avatarUrl.isEmpty()) return
    Thread {
      val bmp = fetchAvatarBitmap(avatarUrl) ?: return@Thread
      try {
        val notif = buildIncomingCallNotification(
          context, callId, callerName, callerEmail, conversationId, hasVideo, avatarUrl, bmp
        )
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_TAG, callId.hashCode(), notif)
      } catch (e: Exception) {
        Log.w(TAG, "refreshNotificationWithAvatar failed: ${e.message}")
      }
    }.start()
  }

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
   *
   * `callerAvatarUrl` é a URL HTTPS do avatar do chamador (vem do FCM data
   * payload `caller_avatar`). Se vier preenchido e `cachedAvatarBitmap` for
   * null, a notification é construída sem largeIcon e o caller dispara o
   * download async; quando o bitmap chega, refreshNotificationWithAvatar
   * re-emite a notification com o mesmo ID, atualizando in-place.
   */
  fun buildIncomingCallNotification(
    context: Context,
    callId: String,
    callerName: String,
    callerEmail: String,
    conversationId: String,
    hasVideo: Boolean,
    callerAvatarUrl: String = "",
    cachedAvatarBitmap: Bitmap? = null
  ): Notification {
    val notificationId = callId.hashCode()

    // Full-screen intent -> launches IncomingCallActivity
    val fullScreenIntent = Intent(context, IncomingCallActivity::class.java).apply {
      putExtra("call_id", callId)
      putExtra("caller_name", callerName)
      putExtra("caller_email", callerEmail)
      putExtra("conversation_id", conversationId)
      putExtra("has_video", hasVideo)
      putExtra("caller_avatar", callerAvatarUrl)
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
      putExtra("caller_avatar", callerAvatarUrl)
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

    // Tenta usar bitmap já cacheado se o caller não passou (síncrono local).
    val largeIcon: Bitmap? = cachedAvatarBitmap
      ?: (if (callerAvatarUrl.isNotEmpty()) avatarCache[callerAvatarUrl] else null)

    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
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
      // [2026-05-15 #977 cold-start phantom decline]
      // Used to be `.setDeleteIntent(declinePendingIntent)` — intended to
      // catch user-swipe dismissals, but `setOngoing(true)` already
      // prevents user swipes. On accept, IncomingCallActivity.onAccept
      // calls cancelNotification + stopRingingService, which tears down
      // the foreground service. Android then fires deleteIntent as a
      // side-effect of clearing the foreground notification, which
      // routed into the decline path and shipped a phantom WS call_end
      // to the caller. The phantom round-tripped and ended the call
      // right after /call mounted (user saw "Chamada encerrada" + home).
      // The `acceptingCallIds` HashMap guard didn't help because the FCM
      // process is often killed and reborn during cold-start accept,
      // wiping the in-memory set. Removing this is safe: the only
      // user-initiated decline paths are the Recusar action above and
      // IncomingCallActivity.onDecline (the red button).

    if (largeIcon != null) {
      builder.setLargeIcon(largeIcon)
    }

    return builder.build()
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
    conversationId: String = "",
    callerAvatarUrl: String = ""
  ) {
    createNotificationChannel(context)

    val notification = buildIncomingCallNotification(
      context, callId, callerName, callerEmail, conversationId, hasVideo, callerAvatarUrl
    )
    val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    notificationManager.notify(NOTIFICATION_TAG, callId.hashCode(), notification)

    // Async-update notification with the real avatar bitmap.
    refreshNotificationWithAvatar(
      context, callId, callerName, callerEmail, conversationId, hasVideo, callerAvatarUrl
    )
  }

  fun cancelNotification(context: Context, callId: String) {
    val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    notificationManager.cancel(NOTIFICATION_TAG, callId.hashCode())
  }
}
