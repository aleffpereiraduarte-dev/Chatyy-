package expo.modules.nativetoolkit

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL

/**
 * [2026-10-09 media-native] Lock-screen / notification-shade controls for the
 * voice-note player (WhatsApp parity) — framework MediaSession +
 * Notification.MediaStyle (no androidx.media dependency).
 *
 * Fed by ExpoNativeAudioModule: every `onVoiceStatus` body VoiceNotePlayer
 * emits passes through [onStatus], so the player needs no hooks. The
 * PlaybackState is rewritten only on coarse changes (play/pause, rate,
 * duration, seek, end); the system extrapolates position from the speed.
 *
 * Transport controls (play / pause / seek / ±15 s) act on the player directly;
 * the player then emits its normal status → JS follows.
 *
 * Media-session notifications are exempt from the Android 13 POST_NOTIFICATIONS
 * runtime prompt. No foreground service: voice notes are short and the player
 * already holds audio focus; the process stays alive while it renders audio
 * in practice (documented gap vs. a mediaPlayback FGS).
 *
 * Main looper only.
 */
class VoiceNowPlaying(
  private val context: Context,
  private val player: VoiceNotePlayer
) {
  companion object {
    private const val TAG = "VoiceNowPlaying"
    private const val CHANNEL_ID = "chatyy_voice_playback"
    private const val NOTIF_ID = 0x7C0E
    private const val ACTION_TOGGLE = "chatyy.voice.TOGGLE"
    private const val ACTION_STOP = "chatyy.voice.STOP"
  }

  private val main = Handler(Looper.getMainLooper())
  private var session: MediaSession? = null
  private var receiverRegistered = false
  private var active = false
  private var enabled = true
  private var title = ""
  private var subtitle = ""
  private var artworkUri: String? = null
  private var artwork: Bitmap? = null

  private var lastPlaying: Boolean? = null
  private var lastRate = -1.0
  private var lastDurationMs = -1.0
  private var lastToken = -1
  private var lastBody: Map<String, Any?> = emptyMap()

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(c: Context?, intent: Intent?) {
      when (intent?.action) {
        ACTION_TOGGLE -> toggle()
        ACTION_STOP -> {
          player.pause()
          clear()
        }
      }
    }
  }

  // ── Metadata from JS ─────────────────────────────────────────────────

  fun setMetadata(meta: Map<String, Any?>) {
    (meta["enabled"] as? Boolean)?.let { enabled = it }
    (meta["title"] as? String)?.let { title = it }
    (meta["subtitle"] as? String)?.let { subtitle = it }
    val art = meta["artworkUri"] as? String
    if (art != artworkUri) {
      artworkUri = art
      artwork = null
      if (!art.isNullOrEmpty()) loadArtwork(art)
    }
    if (!enabled) {
      clear()
      return
    }
    if (active) {
      pushMetadata()
      pushNotification(lastBody)
    }
  }

  // ── Status feed ──────────────────────────────────────────────────────

  fun onStatus(body: Map<String, Any?>) {
    if (!enabled) return
    val playing = body["playing"] as? Boolean ?: false
    if (body["stopped"] == true || (body["error"] != null && !playing)) {
      clear()
      return
    }
    val rate = (body["rate"] as? Number)?.toDouble() ?: 1.0
    val dur = (body["durationMs"] as? Number)?.toDouble() ?: 0.0
    val token = (body["token"] as? Number)?.toInt() ?: 0
    if (!active) {
      if (!playing) return
      if (!ensureSession()) return
      active = true
    }
    val coarse = body.containsKey("seeked") || body.containsKey("ended") || body.containsKey("reason")
    val durChanged = Math.abs(lastDurationMs - dur) > 1
    if (coarse || lastPlaying != playing || Math.abs(lastRate - rate) > 0.001 || durChanged || lastToken != token) {
      val notifChanged = lastPlaying != playing || lastToken != token
      lastPlaying = playing
      lastRate = rate
      lastDurationMs = dur
      lastToken = token
      lastBody = HashMap(body)
      if (durChanged || notifChanged) pushMetadata()
      pushState(body)
      if (notifChanged) pushNotification(body)
    }
  }

  fun clear() {
    if (!active && session == null) return
    active = false
    lastPlaying = null
    lastRate = -1.0
    lastDurationMs = -1.0
    lastToken = -1
    try {
      notificationManager()?.cancel(NOTIF_ID)
    } catch (_: Throwable) {
    }
    val s = session
    session = null
    if (s != null) {
      try {
        s.isActive = false
        s.release()
      } catch (_: Throwable) {
      }
    }
    if (receiverRegistered) {
      receiverRegistered = false
      try {
        context.unregisterReceiver(receiver)
      } catch (_: Throwable) {
      }
    }
  }

  // ── Session ──────────────────────────────────────────────────────────

  private fun ensureSession(): Boolean {
    if (session != null) return true
    return try {
      val s = MediaSession(context, "ChatyyVoiceNote")
      s.setCallback(object : MediaSession.Callback() {
        override fun onPlay() { player.resume() }
        override fun onPause() { player.pause() }
        override fun onStop() {
          player.pause()
          clear()
        }
        override fun onSeekTo(pos: Long) { player.seek(pos.toInt()) }
        override fun onFastForward() { skip(15000) }
        override fun onRewind() { skip(-15000) }
      }, main)
      s.isActive = true
      session = s
      if (!receiverRegistered) {
        val f = IntentFilter().apply {
          addAction(ACTION_TOGGLE)
          addAction(ACTION_STOP)
        }
        if (Build.VERSION.SDK_INT >= 33) {
          context.registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED)
        } else {
          @Suppress("UnspecifiedRegisterReceiverFlag")
          context.registerReceiver(receiver, f)
        }
        receiverRegistered = true
      }
      true
    } catch (t: Throwable) {
      Log.w(TAG, "session failed: ${t.message}")
      false
    }
  }

  private fun toggle() {
    val st = player.status()
    if (st["playing"] == true) player.pause() else player.resume()
  }

  private fun skip(deltaMs: Int) {
    val st = player.status()
    val pos = (st["positionMs"] as? Number)?.toInt() ?: 0
    val dur = (st["durationMs"] as? Number)?.toInt() ?: 0
    var target = (pos + deltaMs).coerceAtLeast(0)
    if (dur > 0) target = target.coerceAtMost((dur - 250).coerceAtLeast(0))
    player.seek(target)
  }

  private fun displayTitle(): String {
    if (title.isNotEmpty()) return title
    return try {
      context.applicationInfo.loadLabel(context.packageManager).toString()
    } catch (_: Throwable) {
      "Chatyy"
    }
  }

  private fun pushMetadata() {
    val s = session ?: return
    try {
      val b = MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, displayTitle())
        .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
      if (lastDurationMs > 0) b.putLong(MediaMetadata.METADATA_KEY_DURATION, lastDurationMs.toLong())
      artwork?.let { b.putBitmap(MediaMetadata.METADATA_KEY_ART, it) }
      s.setMetadata(b.build())
    } catch (t: Throwable) {
      Log.w(TAG, "metadata failed: ${t.message}")
    }
  }

  private fun pushState(body: Map<String, Any?>) {
    val s = session ?: return
    val playing = body["playing"] as? Boolean ?: false
    val rate = (body["rate"] as? Number)?.toFloat() ?: 1f
    val pos = (body["positionMs"] as? Number)?.toLong() ?: 0L
    try {
      val state = PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SEEK_TO or
            PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_REWIND or
            PlaybackState.ACTION_STOP
        )
        .setState(
          if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
          pos.coerceAtLeast(0L),
          if (playing) rate else 0f
        )
        .build()
      s.setPlaybackState(state)
    } catch (t: Throwable) {
      Log.w(TAG, "state failed: ${t.message}")
    }
  }

  // ── Notification ─────────────────────────────────────────────────────

  private fun notificationManager(): NotificationManager? =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager

  private fun smallIcon(): Int {
    val res = context.resources
    val pkg = context.packageName
    // expo-notifications' monochrome icon when present, else the app icon.
    val id = res.getIdentifier("notification_icon", "drawable", pkg)
    return if (id != 0) id else context.applicationInfo.icon
  }

  private fun broadcast(action: String, req: Int): PendingIntent {
    val i = Intent(action).setPackage(context.packageName)
    return PendingIntent.getBroadcast(
      context, req, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun pushNotification(body: Map<String, Any?>) {
    val s = session ?: return
    val nm = notificationManager() ?: return
    val playing = body["playing"] as? Boolean ?: false
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
        val label = try {
          context.applicationInfo.loadLabel(context.packageManager).toString()
        } catch (_: Throwable) {
          "Chatyy"
        }
        val ch = NotificationChannel(CHANNEL_ID, label, NotificationManager.IMPORTANCE_LOW)
        ch.setShowBadge(false)
        ch.setSound(null, null)
        ch.enableVibration(false)
        ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        nm.createNotificationChannel(ch)
      }
      val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      if (launch != null) {
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        b.setContentIntent(
          PendingIntent.getActivity(
            context, 0x7C10, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
          )
        )
      }
      val toggleIcon = if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
      val toggleLabel = if (playing) "Pause" else "Play"
      b.setSmallIcon(smallIcon())
        .setContentTitle(displayTitle())
        .setContentText(subtitle)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setShowWhen(false)
        .setOnlyAlertOnce(true)
        .setOngoing(playing)
        .setDeleteIntent(broadcast(ACTION_STOP, 0x7C12))
        .addAction(
          Notification.Action.Builder(
            Icon.createWithResource(context, toggleIcon), toggleLabel, broadcast(ACTION_TOGGLE, 0x7C11)
          ).build()
        )
        .setStyle(Notification.MediaStyle().setMediaSession(s.sessionToken).setShowActionsInCompactView(0))
      artwork?.let { b.setLargeIcon(it) }
      nm.notify(NOTIF_ID, b.build())
    } catch (t: Throwable) {
      // SecurityException (notifications blocked) etc. — lock-screen session
      // controls still work through the MediaSession on most launchers.
      Log.w(TAG, "notify failed: ${t.message}")
    }
  }

  // ── Artwork ──────────────────────────────────────────────────────────

  private fun loadArtwork(uri: String) {
    val wanted = uri
    Thread {
      var bmp: Bitmap? = null
      try {
        bmp = when {
          uri.startsWith("file://") -> BitmapFactory.decodeFile(Uri.parse(uri).path ?: uri.removePrefix("file://"))
          uri.startsWith("/") -> BitmapFactory.decodeFile(uri)
          uri.startsWith("https://") || uri.startsWith("http://") -> {
            val c = URL(uri).openConnection() as HttpURLConnection
            c.connectTimeout = 8000
            c.readTimeout = 8000
            try {
              c.inputStream.use { BitmapFactory.decodeStream(it) }
            } finally {
              c.disconnect()
            }
          }
          else -> null
        }
      } catch (_: Throwable) {
        bmp = null
      }
      val result = bmp ?: return@Thread
      val scaled = try {
        val max = 512
        if (result.width > max || result.height > max) {
          val k = max.toFloat() / maxOf(result.width, result.height)
          Bitmap.createScaledBitmap(result, (result.width * k).toInt().coerceAtLeast(1), (result.height * k).toInt().coerceAtLeast(1), true)
        } else result
      } catch (_: Throwable) {
        result
      }
      main.post {
        if (artworkUri != wanted) return@post
        artwork = scaled
        if (active) {
          pushMetadata()
          pushNotification(lastBody)
        }
      }
    }.start()
  }
}
