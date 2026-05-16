package expo.modules.screenshare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * [2026-05-16 Android screenshare Stage 1] Foreground service that owns the
 * MediaProjection lifetime + (eventually) feeds frames into the active
 * LiveKit Room.
 *
 * CRITICAL Android 14+ ordering (see https://developer.android.com/develop/
 * background-work/services/foreground-services#media-projection):
 *
 *   1. App calls MediaProjectionManager.createScreenCaptureIntent() and the
 *      user accepts. The resultCode + Intent are passed here via extras.
 *   2. THIS SERVICE must call startForeground(...) with
 *      ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION BEFORE calling
 *      mpm.getMediaProjection(resultCode, data). Reverse order = SecurityException.
 *   3. Once the MediaProjection is acquired we hand it to the active LK Room
 *      via LocalParticipant.setScreenShareEnabled(true, ...). The LK SDK
 *      internally creates a ScreenCapturerAndroid + VirtualDisplay + WebRTC
 *      VideoCapturer + RtpSender. (See "Wiring" TODO below — Stage 1 stops
 *      here pending Stage 2 of the task.)
 *
 * Service is started by ExpoScreenShareModule.presentBroadcastPicker() once
 * the user accepts the system MediaProjection dialog. Stopped by
 * ExpoScreenShareModule.requestStopBroadcast() or when the MediaProjection
 * itself dies (user taps "Stop sharing" in the status bar).
 */
class ScreenShareService : Service() {

  companion object {
    private const val TAG = "ScreenShareService"

    private const val NOTIFICATION_ID = 27815  // arbitrary, app-unique
    private const val CHANNEL_ID = "screenshare_channel"
    private const val CHANNEL_NAME = "Compartilhamento de tela"

    const val EXTRA_RESULT_CODE = "result_code"
    const val EXTRA_RESULT_DATA = "result_data"
    const val ACTION_STOP = "expo.modules.screenshare.STOP"

    @Volatile var isRunning: Boolean = false
      private set
  }

  private var mediaProjection: MediaProjection? = null
  private var serviceScope: CoroutineScope? = null
  private var mediaProjectionCallback: MediaProjection.Callback? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.d(TAG, "onStartCommand action=${intent?.action}")

    if (intent?.action == ACTION_STOP) {
      Log.d(TAG, "stop action received")
      stopSelfClean()
      return START_NOT_STICKY
    }

    val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
    val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
    if (resultCode == 0 || resultData == null) {
      Log.w(TAG, "missing MediaProjection result — stopping")
      stopSelfClean()
      return START_NOT_STICKY
    }

    // STEP 1: startForeground BEFORE acquiring MediaProjection (Android 14+).
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    // STEP 2: Now safe to acquire MediaProjection.
    val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    val mp = try {
      mpm.getMediaProjection(resultCode, resultData)
    } catch (t: Throwable) {
      Log.e(TAG, "getMediaProjection failed: ${t.message}", t)
      stopSelfClean()
      return START_NOT_STICKY
    }
    if (mp == null) {
      Log.w(TAG, "getMediaProjection returned null — likely user revoked")
      stopSelfClean()
      return START_NOT_STICKY
    }
    mediaProjection = mp
    isRunning = true

    // If the user taps "Stop sharing" in the system status bar, the
    // MediaProjection fires onStop on a binder thread. Tear down the FGS.
    val cb = object : MediaProjection.Callback() {
      override fun onStop() {
        Log.d(TAG, "MediaProjection.onStop")
        stopSelfClean()
      }
    }
    mediaProjectionCallback = cb
    // Android 14+ requires a Handler for registerCallback. The 2-arg form
    // (callback, handler) is available since Lollipop so it covers all our
    // minSdk=24 surface.
    mp.registerCallback(cb, android.os.Handler(mainLooper))

    // STEP 3: Hand MediaProjection to the active LiveKit Room.
    serviceScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    serviceScope?.launch { publishToLiveKit(resultCode, resultData) }

    return START_NOT_STICKY
  }

  /**
   * Publish the screen-capture track into the active LK Room.
   *
   * STAGE 2 WIRED (2026-05-16) — CallActivity.bringUpRoom now sets the holder
   * after `LiveKit.create(applicationContext)` and clears it in onDestroy, so
   * `LiveKitRoomHolder.current()` returns the live Room here whenever a call
   * is in flight. Live host wiring (LiveHostActivity / GroupCallActivity)
   * lands in a separate task — until then, screenshare from those screens
   * will hit the null branch below and stop the service cleanly.
   *
   * LK Android 2.24 API used (validated against the public
   * livekit/client-sdk-android sample-app-basic/MainActivity.kt + the
   * KDoc in io.livekit.android.room.participant.LocalParticipant):
   *
   *   suspend fun LocalParticipant.setScreenShareEnabled(
   *     enabled: Boolean,
   *     mediaProjectionPermissionResultData: Intent? = null,
   *     options: ScreenShareTrackOptions? = null
   *   )
   *
   * On the first call with enabled=true, the SDK internally constructs a
   * ScreenCapturerAndroid(resultData, callback), wraps it in a
   * LocalScreencastVideoTrack, and publishes it as source=SCREEN_SHARE.
   * The SDK also auto-publishes the system audio capture on Android 10+
   * when ScreenShareTrackOptions.captureSystemAudio is true.
   *
   * TODO(audio): Screen audio capture requires
   * AudioPlaybackCaptureConfiguration (API 29+) plus an AudioRecord routed
   * back into a LK LocalAudioTrack with source=SCREEN_SHARE_AUDIO. The LK
   * SDK does NOT pipe system audio for us automatically — we'd need to wire
   * it manually. Defer to a follow-up commit; current scope is video-only.
   *
   * If `setScreenShareEnabled` ever disappears from LK's public API in a
   * future bump, fall back to manually constructing a
   * LocalScreencastVideoTrack from ScreenCapturerAndroid and calling
   * `room.localParticipant.publishVideoTrack(track)` — see the Stage 2
   * task notes for the exact signature.
   */
  private suspend fun publishToLiveKit(resultCode: Int, resultData: Intent) {
    val room = LiveKitRoomHolder.current()
    if (room == null) {
      Log.w(
        TAG,
        "LiveKitRoomHolder.current() == null — MediaProjection acquired but " +
          "no active Room to publish to. Stopping screenshare service."
      )
      // Race: user might tap "Compartilhar tela" before CallActivity has run
      // bringUpRoom (LK.create + holder.set are synchronous in bringUpRoom,
      // but the Service IPC fires the moment the user accepts the permission
      // dialog so there is a small window if accept happens within the first
      // ~50ms of CallActivity.onCreate). On null we stop the FGS cleanly so
      // the user gets visible feedback (notification disappears) rather than
      // a phantom "sharing screen" that publishes nothing.
      stopSelfClean()
      return
    }

    try {
      // Primary path: LK 2.24 public API. The SDK owns capturer + track +
      // RtpSender lifetime from here on; we just hand it the result Intent
      // from MediaProjectionManager.createScreenCaptureIntent().
      room.localParticipant.setScreenShareEnabled(true, resultData)
      Log.d(TAG, "LK screen share enabled (setScreenShareEnabled true)")
    } catch (t: Throwable) {
      Log.e(TAG, "setScreenShareEnabled failed: ${t.message}", t)
      // Fallback path (not exercised in normal flow): if LK ever changes the
      // signature, we can build the track ourselves here. Leaving the
      // exception bubble swallow so the FGS keeps the MediaProjection alive
      // (user still sees the system "Sharing screen" indicator) — operator
      // can grep logs and pivot to the manual LocalScreencastVideoTrack path.
    }
  }

  @OptIn(DelicateCoroutinesApi::class)
  private fun stopSelfClean() {
    Log.d(TAG, "stopSelfClean")
    isRunning = false

    // Best-effort: stop screen share on the Room before releasing the
    // MediaProjection so the SDK can flush its capturer cleanly. We fire on
    // GlobalScope/Main here because serviceScope is about to be cancelled
    // below — a coroutine launched on a cancelled scope never runs, so the
    // setScreenShareEnabled(false) call would silently no-op and leave the
    // SDK's capturer holding stale refs until the Room itself disconnects.
    val room = LiveKitRoomHolder.current()
    if (room != null) {
      GlobalScope.launch(Dispatchers.Main) {
        try {
          room.localParticipant.setScreenShareEnabled(false)
          Log.d(TAG, "LK screen share disabled (setScreenShareEnabled false)")
        } catch (t: Throwable) {
          Log.w(TAG, "disable screenShare on Room failed: ${t.message}")
        }
      }
    }

    try {
      mediaProjectionCallback?.let { mediaProjection?.unregisterCallback(it) }
    } catch (_: Throwable) {}
    mediaProjectionCallback = null

    try { mediaProjection?.stop() } catch (_: Throwable) {}
    mediaProjection = null

    serviceScope?.cancel()
    serviceScope = null

    try {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } catch (_: Throwable) {
      @Suppress("DEPRECATION")
      try { stopForeground(true) } catch (_: Throwable) {}
    }
    stopSelf()
  }

  override fun onDestroy() {
    Log.d(TAG, "onDestroy")
    isRunning = false
    try {
      mediaProjectionCallback?.let { mediaProjection?.unregisterCallback(it) }
    } catch (_: Throwable) {}
    mediaProjectionCallback = null
    try { mediaProjection?.stop() } catch (_: Throwable) {}
    mediaProjection = null
    serviceScope?.cancel()
    serviceScope = null
    super.onDestroy()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      CHANNEL_NAME,
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "Notificação contínua enquanto a tela está sendo compartilhada"
      setShowBadge(false)
      enableLights(false)
      enableVibration(false)
    }
    nm.createNotificationChannel(channel)
  }

  private fun buildNotification(): Notification {
    val stopIntent = Intent(this, ScreenShareService::class.java).apply {
      action = ACTION_STOP
    }
    // FLAG_IMMUTABLE required since Android 12 (S).
    val stopPi = PendingIntent.getService(
      this,
      0,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    // Reuse a system icon so we don't depend on a drawable that the host app
    // may or may not ship. android.R.drawable.ic_menu_share is present on all
    // API levels we support.
    val smallIcon = android.R.drawable.ic_menu_share

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(smallIcon)
      .setContentTitle("Compartilhando tela")
      .setContentText("Toque em Parar para encerrar o compartilhamento")
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOnlyAlertOnce(true)
      .addAction(0, "Parar", stopPi)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    }

    return builder.build()
  }
}
