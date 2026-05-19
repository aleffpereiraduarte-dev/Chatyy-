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
import androidx.collection.LruCache
import androidx.core.app.NotificationCompat
import java.net.HttpURLConnection
import java.net.URL

object CallNotificationService {

  const val CHANNEL_ID = "incoming_calls"
  /** [mute-call-ringtone, 2026-05-19] Parallel silent channel used when the
   *  user enabled "Modo silencioso para ligações" in settings, signalled to
   *  the device via the push payload `mute_ringtone=1`. NotificationChannel
   *  sound + vibration are immutable post-creation, so a parallel channel is
   *  the only way to honor the toggle without losing existing ringing UX. */
  const val CHANNEL_ID_SILENT = "incoming_calls_silent"
  private const val NOTIFICATION_TAG = "call_notification"
  private const val TAG = "CallNotificationService"

  // Cache fetched avatar bitmaps por URL pra evitar re-download enquanto a
  // notification re-renderiza (ringing+chamada). Cap em 8 entries.
  //
  // [2026-05-15] LruCache (synchronized internally) replaces
  // ConcurrentHashMap+clear(): LRU eviction is natural — accessing an entry
  // promotes it; once size > 8 the least-recently-used bitmap is dropped
  // without a stop-the-world clear() that would also discard the bitmap
  // we're literally about to render in the active call.
  private val avatarCache = LruCache<String, Bitmap>(8)

  /**
   * Baixa o avatar sincronamente (chamado dentro de Thread). Retorna null em
   * caso de qualquer erro — notification cai no fallback de inicial.
   */
  fun fetchAvatarBitmap(urlStr: String): Bitmap? {
    if (urlStr.isEmpty()) return null
    avatarCache.get(urlStr)?.let { return it }
    // [2026-05-15] HttpURLConnection (was openConnection() returning a raw
    // URLConnection) with explicit, shorter timeouts. The previous 5s/5s
    // combined could stall up to 10s on flaky cell — and on a phone call
    // notification we want to fail fast and fall back to the initial.
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
        connectTimeout = 3_000
        readTimeout = 4_000
        instanceFollowRedirects = true
        requestMethod = "GET"
      }
      val bmp = conn.inputStream.use { BitmapFactory.decodeStream(it) }
      if (bmp != null) {
        avatarCache.put(urlStr, bmp)
      }
      bmp
    } catch (e: Exception) {
      Log.w(TAG, "fetchAvatarBitmap failed for $urlStr: ${e.message}")
      null
    } finally {
      try { conn?.disconnect() } catch (_: Exception) {}
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
    avatarUrl: String,
    muteRingtone: Boolean = false
  ) {
    if (avatarUrl.isEmpty()) return
    Thread {
      val bmp = fetchAvatarBitmap(avatarUrl) ?: return@Thread
      try {
        val notif = buildIncomingCallNotification(
          context, callId, callerName, callerEmail, conversationId, hasVideo, avatarUrl, bmp,
          muteRingtone = muteRingtone
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

      // [mute-call-ringtone, 2026-05-19] Silent twin of the incoming-calls
      // channel. Same HIGH importance (so heads-up + FSI still fire on the
      // lockscreen) but no sound + no vibration. Routed to when the push
      // payload carries mute_ringtone=1.
      val silentChannel = NotificationChannel(CHANNEL_ID_SILENT, "Chamadas (silencioso)", importance).apply {
        this.description = "Chamadas recebidas em modo silencioso (sem som / vibração)"
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        setBypassDnd(true)
        enableVibration(false)
        setSound(null, null)
      }
      notificationManager.createNotificationChannel(silentChannel)
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
    cachedAvatarBitmap: Bitmap? = null,
    // [mute-call-ringtone, 2026-05-19] When true, route the notification
    // through the silent channel instead of the default ringing one.
    muteRingtone: Boolean = false
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
      ?: (if (callerAvatarUrl.isNotEmpty()) avatarCache.get(callerAvatarUrl) else null)

    // [mute-call-ringtone, 2026-05-19] Pick the silent channel when the
    // caller asked us to mute. Both channels live at IMPORTANCE_HIGH so
    // heads-up + FSI still fire — only sound + vibration differ.
    val activeChannel = if (muteRingtone) CHANNEL_ID_SILENT else CHANNEL_ID

    val builder = NotificationCompat.Builder(context, activeChannel)
      .setSmallIcon(iconRes)
      .setContentTitle(callerName)
      .setContentText(callTypeText)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .addAction(0, "Recusar", declinePendingIntent)
      .addAction(0, "Atender", acceptPendingIntent)
    if (muteRingtone) {
      // Belt-and-suspenders for pre-O devices (no channel concept). On O+
      // the channel config already silences everything; these calls are
      // ignored when a channel is attached.
      builder.setSilent(true)
      builder.setDefaults(0)
    }

    // [2026-05-15] Gate setFullScreenIntent behind canUseFullScreenIntent()
    // on Android 14+ (API 34). When the user has revoked the FSI permission
    // (Settings → Apps → permissions → Full screen notifications), the
    // builder still appears to accept the call but the system silently
    // drops the FSI hint AND can throw SecurityException in some OEM
    // builds. Falling back to a regular heads-up notification still rings
    // and offers Accept/Decline buttons — losing only the immersive
    // full-screen UI.
    if (Build.VERSION.SDK_INT >= 34) {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.canUseFullScreenIntent()) {
        builder.setFullScreenIntent(fullScreenPendingIntent, true)
      } else {
        Log.w(TAG, "USE_FULL_SCREEN_INTENT denied; falling back to heads-up only")
      }
    } else {
      builder.setFullScreenIntent(fullScreenPendingIntent, true)
    }
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
    callerAvatarUrl: String = "",
    muteRingtone: Boolean = false
  ) {
    createNotificationChannel(context)

    val notification = buildIncomingCallNotification(
      context, callId, callerName, callerEmail, conversationId, hasVideo, callerAvatarUrl,
      cachedAvatarBitmap = null,
      muteRingtone = muteRingtone
    )
    val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    notificationManager.notify(NOTIFICATION_TAG, callId.hashCode(), notification)

    // Async-update notification with the real avatar bitmap.
    refreshNotificationWithAvatar(
      context, callId, callerName, callerEmail, conversationId, hasVideo, callerAvatarUrl,
      muteRingtone = muteRingtone
    )
  }

  fun cancelNotification(context: Context, callId: String) {
    val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    notificationManager.cancel(NOTIFICATION_TAG, callId.hashCode())
  }
}
