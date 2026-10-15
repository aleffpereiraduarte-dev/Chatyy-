package expo.modules.callkit

// [2026-10-15 screen-share WA] Shared pieces of the WhatsApp-level screen
// share used by BOTH native call screens (CallActivity 1:1 + GroupCallActivity):
//
//   * privacy notice ("Tudo na sua tela, incluindo notificações, ficará
//     visível…") shown ONLY the first time (SharedPreferences);
//   * a FRESH MediaProjection consent intent per session (Android 14+ makes
//     the token single-use; we never cache a result Intent). On API 34+ the
//     consent is pinned to the whole default display
//     (MediaProjectionConfig.createConfigForDefaultDisplay), same as WhatsApp;
//   * the foreground notification "Você está compartilhando a tela" with a
//     "Parar" action → ACTION_STOP broadcast (package-scoped) that the live
//     call activity listens for (registerStopReceiver);
//   * app/media audio of the shared screen (Android 10+): LiveKit 2.24.1's own
//     io.livekit.android.audio.ScreenAudioCapturer (AudioPlaybackCapture with
//     USAGE_MEDIA / USAGE_GAME / USAGE_UNKNOWN only — never voice-call or
//     notification audio, and our own call audio is VOICE_COMMUNICATION which
//     is not capturable) mixed into the published mic track via
//     LocalAudioTrack.setAudioBufferCallback;
//   * a full-screen viewer for a REMOTE shared screen (TextureViewRenderer,
//     aspect-fit, pinch 1×–4×, drag-to-pan, double tap 1×↔2×), banner
//     "Fulano está compartilhando a tela", Minimizar, landscape allowed while
//     it is open.
//
// FGS ordering (Android 14 rules): LiveKit's setScreenShareEnabled(true,
// ScreenCaptureParams) does createScreencastTrack → startForegroundService
// (binds io.livekit.android.room.track.screencapture.ScreenCaptureService,
// foregroundServiceType="mediaProjection" + FOREGROUND_SERVICE_MEDIA_PROJECTION
// declared in the LK aar manifest) → startCapture (getMediaProjection). So the
// mediaProjection FGS is in the foreground BEFORE the projection is created.

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import androidx.annotation.RequiresApi
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.RendererCommon

object ScreenShareKit {
  private const val TAG = "ScreenShareKit"

  /** Notification "Parar" → this package-scoped broadcast. */
  const val ACTION_STOP = "expo.modules.callkit.SCREEN_SHARE_STOP"
  const val CHANNEL_ID = "chatyy_screen_share"

  private const val PREFS = "chatyy_call_prefs"
  private const val KEY_PRIVACY_ACK = "screen_share_privacy_ack_v1"

  // ─── privacy notice (first time only) ───────────────────────────────────

  fun confirmPrivacyThen(activity: Activity, onContinue: () -> Unit, onCancel: () -> Unit = {}) {
    val prefs = try { activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE) } catch (_: Throwable) { null }
    if (prefs?.getBoolean(KEY_PRIVACY_ACK, false) == true) { onContinue(); return }
    try {
      var decided = false
      android.app.AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
        .setTitle(CallStrings.s("ssPrivacyTitle"))
        .setMessage(CallStrings.s("ssPrivacyBody"))
        .setPositiveButton(CallStrings.s("ssContinue")) { _, _ ->
          decided = true
          try { prefs?.edit()?.putBoolean(KEY_PRIVACY_ACK, true)?.apply() } catch (_: Throwable) {}
          onContinue()
        }
        .setNegativeButton(CallStrings.s("cancel")) { _, _ -> decided = true; onCancel() }
        .setOnDismissListener { if (!decided) { decided = true; onCancel() } }
        .show()
    } catch (t: Throwable) {
      Log.w(TAG, "privacy dialog failed: ${t.message}")
      onContinue()
    }
  }

  // ─── consent intent (fresh per session) ─────────────────────────────────

  fun captureIntent(ctx: Context): Intent {
    val mpm = ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      try {
        return mpm.createScreenCaptureIntent(android.media.projection.MediaProjectionConfig.createConfigForDefaultDisplay())
      } catch (t: Throwable) {
        Log.w(TAG, "createConfigForDefaultDisplay failed: ${t.message}")
      }
    }
    return mpm.createScreenCaptureIntent()
  }

  // ─── foreground notification with "Parar" ───────────────────────────────

  fun buildNotification(ctx: Context, contentText: String, openActivity: Class<out Activity>, requestCode: Int): Notification {
    val iconRes = try {
      ctx.resources.getIdentifier("ic_notification", "drawable", ctx.packageName).takeIf { it != 0 } ?: ctx.applicationInfo.icon
    } catch (_: Throwable) { ctx.applicationInfo.icon }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
          nm.createNotificationChannel(
            android.app.NotificationChannel(CHANNEL_ID, CallStrings.s("sharingScreen"), android.app.NotificationManager.IMPORTANCE_LOW)
          )
        }
      } catch (_: Throwable) {}
    }
    val open = try {
      PendingIntent.getActivity(
        ctx, requestCode,
        Intent(ctx, openActivity).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    } catch (_: Throwable) { null }
    val stop = try {
      PendingIntent.getBroadcast(
        ctx, requestCode + 1,
        Intent(ACTION_STOP).setPackage(ctx.packageName),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    } catch (_: Throwable) { null }
    return androidx.core.app.NotificationCompat.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(iconRes)
      .setContentTitle(CallStrings.s("ssYouAreSharing"))
      .setContentText(contentText)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(androidx.core.app.NotificationCompat.CATEGORY_CALL)
      .apply {
        if (open != null) setContentIntent(open)
        if (stop != null) addAction(0, CallStrings.s("stop"), stop)
      }
      .build()
  }

  /** Listen for the notification's "Parar". Call [unregisterStopReceiver] in onDestroy. */
  fun registerStopReceiver(activity: Activity, onStop: () -> Unit): BroadcastReceiver {
    val rx = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action == ACTION_STOP) activity.runOnUiThread { onStop() }
      }
    }
    val f = IntentFilter(ACTION_STOP)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        activity.registerReceiver(rx, f, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        activity.registerReceiver(rx, f)
      }
    } catch (t: Throwable) { Log.w(TAG, "registerStopReceiver: ${t.message}") }
    return rx
  }

  fun unregisterStopReceiver(activity: Activity, rx: BroadcastReceiver?) {
    if (rx == null) return
    try { activity.unregisterReceiver(rx) } catch (_: Throwable) {}
  }

  // ─── app/media audio of the shared screen (Android 10+) ─────────────────

  /** Opaque handle; pass back to [stopAudio]. */
  class AudioShare internal constructor(internal val capturer: Any, internal val mic: LocalAudioTrack)

  /**
   * Mix the device's MEDIA/GAME playback into the published mic track while
   * the screen is shared. Returns null when unavailable (API < 29, no
   * RECORD_AUDIO, mic not published yet, projection not started) — the video
   * share is unaffected. Note: a muted mic publication also silences it.
   */
  fun startAudio(ctx: Context, room: Room): AudioShare? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return null
    return try { startAudioQ(room) } catch (t: Throwable) {
      Log.w(TAG, "screen audio start failed: ${t.message}")
      null
    }
  }

  @SuppressLint("MissingPermission")
  @RequiresApi(Build.VERSION_CODES.Q)
  private fun startAudioQ(room: Room): AudioShare? {
    val lp = room.localParticipant
    val screen = lp.getTrackPublication(Track.Source.SCREEN_SHARE)?.track ?: return null
    val mic = lp.getTrackPublication(Track.Source.MICROPHONE)?.track as? LocalAudioTrack ?: return null
    val cap = io.livekit.android.audio.ScreenAudioCapturer.createFromScreenShareTrack(screen) ?: return null
    cap.gain = 0.8f
    mic.setAudioBufferCallback(cap)
    return AudioShare(cap, mic)
  }

  fun stopAudio(share: AudioShare?) {
    if (share == null) return
    try { share.mic.setAudioBufferCallback(null) } catch (_: Throwable) {}
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // Let an in-flight onBufferRequest (audio thread) finish before release.
      android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
        try { (share.capturer as? io.livekit.android.audio.ScreenAudioCapturer)?.releaseAudioResources() } catch (_: Throwable) {}
      }, 250L)
    }
  }

  // ─── full-screen viewer for a REMOTE shared screen ──────────────────────

  /**
   * View overlay added on top of the activity content (works over Compose).
   * Landscape is allowed while it is open (configChanges in the manifest
   * already include orientation|screenSize, so no activity recreation);
   * portrait is restored on close.
   */
  class Viewer(
    private val activity: Activity,
    private val room: Room,
    val track: VideoTrack,
    private val title: String,
    private val onMinimize: () -> Unit,
  ) {
    private var overlay: FrameLayout? = null
    private var tv: TextureViewRenderer? = null
    private var prevOrientation: Int = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    val isOpen: Boolean get() = overlay != null

    private fun dp(v: Int): Int = (v * activity.resources.displayMetrics.density).toInt()

    fun open(): Boolean {
      if (overlay != null) return true
      val ov = FrameLayout(activity).apply {
        setBackgroundColor(Color.BLACK)
        isClickable = true
      }
      val r = TextureViewRenderer(activity)
      try {
        room.initVideoRenderer(r)
        r.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
      } catch (t: Throwable) {
        Log.w(TAG, "viewer renderer init failed: ${t.message}")
        return false
      }
      ov.addView(r, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

      var scale = 1f
      fun clampPan() {
        val maxX = (scale - 1f) * r.width / 2f
        val maxY = (scale - 1f) * r.height / 2f
        r.translationX = r.translationX.coerceIn(-maxX, maxX)
        r.translationY = r.translationY.coerceIn(-maxY, maxY)
      }
      val scaleDetector = android.view.ScaleGestureDetector(activity,
        object : android.view.ScaleGestureDetector.SimpleOnScaleGestureListener() {
          override fun onScale(detector: android.view.ScaleGestureDetector): Boolean {
            scale = (scale * detector.scaleFactor).coerceIn(1f, 4f)
            r.scaleX = scale
            r.scaleY = scale
            clampPan()
            return true
          }
        })
      val bar = FrameLayout(activity)
      val gestureDetector = android.view.GestureDetector(activity,
        object : android.view.GestureDetector.SimpleOnGestureListener() {
          override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
            if (scale <= 1.01f) return false
            r.translationX -= distanceX
            r.translationY -= distanceY
            clampPan()
            return true
          }

          override fun onDoubleTap(e: MotionEvent): Boolean {
            scale = if (scale > 1.01f) 1f else 2f
            r.animate().scaleX(scale).scaleY(scale).translationX(0f).translationY(0f).setDuration(180).start()
            return true
          }

          override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            // Tap toggles the banner/minimize bar (immersive viewing).
            bar.animate().alpha(if (bar.alpha > 0.5f) 0f else 1f).setDuration(160).start()
            return true
          }
        })
      ov.setOnTouchListener { _, ev ->
        scaleDetector.onTouchEvent(ev)
        gestureDetector.onTouchEvent(ev)
        true
      }
      // Rotation / size change → reset zoom so the pan clamp stays valid.
      r.addOnLayoutChangeListener { _, l, t, rr, b, ol, ot, orr, ob ->
        if ((rr - l) != (orr - ol) || (b - t) != (ob - ot)) {
          scale = 1f
          r.scaleX = 1f; r.scaleY = 1f; r.translationX = 0f; r.translationY = 0f
        }
      }

      val banner = TextView(activity).apply {
        text = title
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
        background = GradientDrawable().apply {
          cornerRadius = dp(16).toFloat()
          setColor(Color.parseColor("#99000000"))
        }
        setPadding(dp(14), dp(7), dp(14), dp(7))
      }
      bar.addView(banner, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        gravity = Gravity.TOP or Gravity.START
        leftMargin = dp(16); rightMargin = dp(72); topMargin = dp(40)
      })
      val minimize = ImageButton(activity).apply {
        setImageResource(drawableOr(activity, "gc_fullscreen_exit", android.R.drawable.arrow_down_float))
        setColorFilter(Color.WHITE)
        background = GradientDrawable().apply {
          shape = GradientDrawable.OVAL
          setColor(Color.parseColor("#99000000"))
        }
        contentDescription = CallStrings.s("minimize")
        setOnClickListener { close(); onMinimize() }
      }
      bar.addView(minimize, FrameLayout.LayoutParams(dp(40), dp(40)).apply {
        gravity = Gravity.TOP or Gravity.END
        rightMargin = dp(16); topMargin = dp(36)
      })
      ov.addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

      try { track.addRenderer(r) } catch (t: Throwable) { Log.w(TAG, "viewer addRenderer: ${t.message}") }
      try {
        activity.addContentView(ov, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      } catch (t: Throwable) {
        Log.w(TAG, "viewer addContentView: ${t.message}")
        try { track.removeRenderer(r) } catch (_: Throwable) {}
        try { r.release() } catch (_: Throwable) {}
        return false
      }
      overlay = ov
      tv = r
      try {
        prevOrientation = activity.requestedOrientation
        // FULL_USER honours the user's rotation lock (WhatsApp behaviour).
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_USER
      } catch (_: Throwable) {}
      return true
    }

    fun close() {
      val ov = overlay ?: return
      overlay = null
      val r = tv
      tv = null
      try { if (r != null) track.removeRenderer(r) } catch (_: Throwable) {}
      try { r?.release() } catch (_: Throwable) {}
      try { (ov.parent as? ViewGroup)?.removeView(ov) } catch (_: Throwable) {}
      try {
        activity.requestedOrientation =
          if (prevOrientation == ActivityInfo.SCREEN_ORIENTATION_FULL_USER) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else prevOrientation
      } catch (_: Throwable) {}
    }

    /** PiP: hide the chrome (banner/minimize) — the frame itself stays. */
    fun setChromeVisible(visible: Boolean) {
      val ov = overlay ?: return
      if (ov.childCount > 1) ov.getChildAt(1).visibility = if (visible) View.VISIBLE else View.GONE
    }
  }

  private fun drawableOr(ctx: Context, name: String, fallback: Int): Int = try {
    ctx.resources.getIdentifier(name, "drawable", ctx.packageName).takeIf { it != 0 } ?: fallback
  } catch (_: Throwable) { fallback }
}
