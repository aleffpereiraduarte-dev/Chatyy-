package expo.modules.screenshare

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import java.util.concurrent.atomic.AtomicBoolean

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
    /** [Bridge #1 2026-05-19] LocalBroadcast action fired right before the
     *  foreground service tears itself down. The module's BroadcastReceiver
     *  catches this and forwards an "onBroadcastStopped" event to JS so the
     *  "Sharing…" UI can dismiss when the user taps "Stop sharing" in the
     *  system status bar (MediaProjection.Callback.onStop path) — without
     *  this the JS button stays stuck on "Sharing…" forever because
     *  MediaProjection.Callback fires on a binder thread inside the service
     *  process and JS never learns about it. */
    const val ACTION_STOPPED = "expo.modules.screenshare.STOPPED"
    const val EXTRA_STOP_REASON = "reason"

    @Volatile var isRunning: Boolean = false
      private set
  }

  private var mediaProjection: MediaProjection? = null
  private var serviceScope: CoroutineScope? = null
  private var mediaProjectionCallback: MediaProjection.Callback? = null

  // [2026-05-20 Wave 17 F2] Screen-audio capture: AudioPlaybackCaptureConfiguration
  // requires API 29 (Q) and a live MediaProjection. We start it after the LK
  // video track is published and stop it in stopSelfClean. Real wire into a
  // LK LocalAudioTrack with source=SCREEN_SHARE_AUDIO is still TODO — see
  // pumpAppAudio() for the consumer stub.
  private var appAudioRecord: AudioRecord? = null
  private val appAudioRunning = AtomicBoolean(false)
  private var appAudioJob: Job? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.d(TAG, "onStartCommand action=${intent?.action}")

    if (intent?.action == ACTION_STOP) {
      Log.d(TAG, "stop action received")
      stopSelfClean(reason = "user_stop")
      return START_NOT_STICKY
    }

    val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
    val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
    if (resultCode == 0 || resultData == null) {
      Log.w(TAG, "missing MediaProjection result — stopping")
      stopSelfClean(reason = "missing_result")
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
      stopSelfClean(reason = "mp_failed")
      return START_NOT_STICKY
    }
    if (mp == null) {
      Log.w(TAG, "getMediaProjection returned null — likely user revoked")
      stopSelfClean(reason = "mp_null")
      return START_NOT_STICKY
    }
    mediaProjection = mp
    isRunning = true

    // If the user taps "Stop sharing" in the system status bar, the
    // MediaProjection fires onStop on a binder thread. Tear down the FGS.
    val cb = object : MediaProjection.Callback() {
      override fun onStop() {
        Log.d(TAG, "MediaProjection.onStop")
        // [Bridge #1 2026-05-19] User tapped "Stop sharing" in the system
        // status bar — distinguish from the user_stop reason (Stop button in
        // our own notification) so the JS layer can tell apart user-initiated
        // dismiss-via-notification vs system-bar revocation.
        stopSelfClean(reason = "system_stop")
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
      stopSelfClean(reason = "no_room")
      return
    }

    try {
      // Primary path: LK 2.24 public API. The SDK owns capturer + track +
      // RtpSender lifetime from here on; we just hand it the result Intent
      // from MediaProjectionManager.createScreenCaptureIntent().
      room.localParticipant.setScreenShareEnabled(true, ScreenCaptureParams(resultData))
      Log.d(TAG, "LK screen share enabled (setScreenShareEnabled true)")

      // [2026-05-20 Wave 17 F2] Now that the LK video track is up, start
      // capturing app/playback audio so Spotify / YouTube / games come
      // through to the peer. API 29+ only; older Androids silently skip.
      val mp = mediaProjection
      if (mp != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        try {
          startScreenAudioCapture(mp)
        } catch (t: Throwable) {
          // Non-fatal: video share keeps working, peer just won't hear app
          // audio. Likely cause is OEM lockdown of playback capture (some
          // builds mark all audio as DO_NOT_CAPTURE by default).
          Log.w(TAG, "screen audio capture failed: ${t.message}", t)
        }
      } else {
        Log.d(TAG, "skipping screen audio capture (API < 29 or no projection)")
      }
    } catch (t: Throwable) {
      Log.e(TAG, "setScreenShareEnabled failed: ${t.message}", t)
      // Fallback path (not exercised in normal flow): if LK ever changes the
      // signature, we can build the track ourselves here. Leaving the
      // exception bubble swallow so the FGS keeps the MediaProjection alive
      // (user still sees the system "Sharing screen" indicator) — operator
      // can grep logs and pivot to the manual LocalScreencastVideoTrack path.
    }
  }

  /**
   * [2026-05-20 Wave 17 F2] Capture device playback audio (music, video,
   * game SFX) via AudioPlaybackCaptureConfiguration so the peer hears what
   * the user is sharing — not just sees it. Today this is a STUB: we open
   * the AudioRecord, start a drain loop, and log frame sizes. Wiring the
   * PCM into a LiveKit LocalAudioTrack with source=SCREEN_SHARE_AUDIO is a
   * follow-up — the SDK side of that needs an AudioCustomSource which LK
   * 2.24 only exposes via internals. Until then the bytes get read and
   * dropped, which is enough to validate that capture works + that no app
   * playback session has DO_NOT_CAPTURE policy set.
   *
   * NOTE: requires android.permission.RECORD_AUDIO (already declared by the
   * host app for the mic) AND a live MediaProjection. The system enforces
   * that the playback capture config has the same MediaProjection token as
   * the screen capture — you can't reuse one from a different session.
   *
   * Apps that opt out (or whose audio attributes are CONTENT_TYPE_SPEECH /
   * USAGE_VOICE_COMMUNICATION) won't appear in the captured stream. That's
   * by design from Android: protects calls / voicemail / etc.
   */
  @RequiresApi(Build.VERSION_CODES.Q)
  @SuppressLint("MissingPermission")
  private fun startScreenAudioCapture(projection: MediaProjection) {
    if (appAudioRunning.get()) {
      Log.d(TAG, "screen audio capture already running")
      return
    }

    val config = AudioPlaybackCaptureConfiguration.Builder(projection)
      .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
      .addMatchingUsage(AudioAttributes.USAGE_GAME)
      .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
      .build()

    val format = AudioFormat.Builder()
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .setSampleRate(48_000)
      .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
      .build()

    val minBuf = AudioRecord.getMinBufferSize(
      48_000,
      AudioFormat.CHANNEL_IN_STEREO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    if (minBuf <= 0) {
      Log.w(TAG, "AudioRecord.getMinBufferSize returned $minBuf — abort")
      return
    }
    val bufSize = minBuf * 4

    val record = AudioRecord.Builder()
      .setAudioPlaybackCaptureConfig(config)
      .setAudioFormat(format)
      .setBufferSizeInBytes(bufSize)
      .build()

    if (record.state != AudioRecord.STATE_INITIALIZED) {
      Log.w(TAG, "AudioRecord failed to initialize, state=${record.state}")
      try { record.release() } catch (_: Throwable) {}
      return
    }

    record.startRecording()
    appAudioRecord = record
    appAudioRunning.set(true)
    // [Wave 17.6] Flag the cross-module mixer so the LK audio thread (set
    // up in CallActivity via ScreenAudioMixer.attach) starts consuming.
    ScreenAudioMixer.setEnabled(true)
    Log.d(TAG, "screen audio capture started (48kHz stereo PCM16, buf=$bufSize)")

    val scope = serviceScope ?: return
    appAudioJob = scope.launch(Dispatchers.IO) {
      pumpAppAudio(record, bufSize)
    }
  }

  /**
   * Drain loop for the playback-capture AudioRecord. Today this is a stub
   * that reads + discards so the system kernel buffer doesn't overflow
   * (which would cause the AudioRecord to enter ERROR state). Real consumer
   * needs to push the bytes into a LK LocalAudioTrack — see TODO at
   * startScreenAudioCapture. Log every ~1s to confirm samples are flowing.
   */
  private suspend fun pumpAppAudio(record: AudioRecord, bufSize: Int) {
    val buffer = ByteArray(bufSize)
    var totalBytes = 0L
    var lastLogMs = System.currentTimeMillis()
    try {
      while (appAudioRunning.get() && (serviceScope?.isActive == true)) {
        val read = try {
          record.read(buffer, 0, buffer.size)
        } catch (t: Throwable) {
          Log.w(TAG, "AudioRecord.read threw: ${t.message}")
          break
        }
        if (read < 0) {
          Log.w(TAG, "AudioRecord.read returned error $read — stopping pump")
          break
        }
        if (read == 0) continue
        totalBytes += read
        // [Wave 17.6] Pump samples into ScreenAudioMixer ring. CallActivity
        // is expected to wire LiveKit's audioProcessingController callback
        // to ScreenAudioMixer.mixInto() so peer hears mic+screen merged
        // (LK Android 2.10.3 has no public AudioCustomSource yet, so we
        // mix into the existing mic track — same approach as Zoom/Meet).
        ScreenAudioMixer.push(buffer, read)

        val now = System.currentTimeMillis()
        if (now - lastLogMs > 1000) {
          Log.d(TAG, "screen audio: ${totalBytes} bytes captured (last 1s)")
          totalBytes = 0
          lastLogMs = now
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "pumpAppAudio loop error: ${t.message}", t)
    } finally {
      Log.d(TAG, "screen audio pump exiting")
    }
  }

  private fun stopScreenAudioCapture() {
    if (!appAudioRunning.getAndSet(false)) return
    // [Wave 17.6] Flag mixer disabled so the LK audio thread stops draining.
    ScreenAudioMixer.setEnabled(false)
    try { appAudioJob?.cancel() } catch (_: Throwable) {}
    appAudioJob = null
    val rec = appAudioRecord
    appAudioRecord = null
    if (rec != null) {
      try {
        if (rec.recordingState == AudioRecord.RECORDSTATE_RECORDING) rec.stop()
      } catch (t: Throwable) {
        Log.w(TAG, "AudioRecord.stop failed: ${t.message}")
      }
      try { rec.release() } catch (_: Throwable) {}
      Log.d(TAG, "screen audio capture stopped + released")
    }
  }

  @OptIn(DelicateCoroutinesApi::class)
  private fun stopSelfClean(reason: String = "unknown") {
    Log.d(TAG, "stopSelfClean reason=$reason")
    isRunning = false

    // [2026-05-20 Wave 17 F2] Stop screen-audio capture BEFORE we release
    // the MediaProjection — AudioRecord built from AudioPlaybackCaptureConfig
    // becomes invalid the moment the projection dies, and a late .stop()
    // call against a stale record sometimes throws IllegalStateException on
    // OEM ROMs (Samsung/Xiaomi). Tear it down explicitly here.
    stopScreenAudioCapture()

    // [Bridge #1 2026-05-19] Notify the module process (same app, but a
    // BroadcastReceiver inside ExpoScreenShareModule listens for this) BEFORE
    // we tear down the foreground service. LocalBroadcastManager keeps the
    // broadcast in-process — no external app can intercept and we don't need
    // RECEIVER_NOT_EXPORTED gymnastics. Fire-and-forget; failure to deliver
    // shouldn't block the FGS teardown.
    try {
      val intent = Intent(ACTION_STOPPED).apply {
        putExtra(EXTRA_STOP_REASON, reason)
      }
      LocalBroadcastManager.getInstance(applicationContext).sendBroadcast(intent)
    } catch (t: Throwable) {
      Log.w(TAG, "STOPPED broadcast failed: ${t.message}")
    }

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
    stopScreenAudioCapture()
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
