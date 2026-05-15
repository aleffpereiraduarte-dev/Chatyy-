package expo.modules.callkit

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.media.Ringtone
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class IncomingCallActivity : AppCompatActivity() {

  private var ringtone: Ringtone? = null
  private var vibrator: Vibrator? = null
  private var callId: String? = null
  private var callerName: String? = null
  private var callerEmail: String? = null
  private var callerAvatar: String? = null
  private var conversationId: String? = null
  private var hasVideo: Boolean = false
  private var avatarTextView: TextView? = null
  private var avatarSizePx: Int = 0
  private val mainHandler = Handler(Looper.getMainLooper())

  // Receiver to close this activity when call is handled from notification
  private val closeReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      stopRinging()
      finish()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    callId = intent.getStringExtra("call_id")
    callerEmail = intent.getStringExtra("caller_email") ?: ""
    // [#978-2] Email-local-part fallback so JS never receives the literal
    // "Unknown" sentinel (which it then displayed as "Contato desconhecido").
    callerName = intent.getStringExtra("caller_name")?.takeIf { it.isNotBlank() }
      ?: callerEmail.substringBefore('@').takeIf { it.isNotBlank() }
      ?: "Chamada"
    callerAvatar = intent.getStringExtra("caller_avatar") ?: ""
    conversationId = intent.getStringExtra("conversation_id") ?: ""
    hasVideo = intent.getBooleanExtra("has_video", false)
    val autoAccept = intent.getBooleanExtra("auto_accept", false)

    // Register receiver to close from notification action buttons
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(
        closeReceiver,
        IntentFilter("expo.modules.callkit.CLOSE_CALL_ACTIVITY"),
        Context.RECEIVER_NOT_EXPORTED
      )
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      registerReceiver(
        closeReceiver,
        IntentFilter("expo.modules.callkit.CLOSE_CALL_ACTIVITY")
      )
    }

    // Show on lock screen and turn screen on
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
      val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
      keyguardManager.requestDismissKeyguard(this, null)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
        WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
      )
    }

    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    // If auto_accept (from notification "Atender" button), skip UI and accept immediately
    if (autoAccept) {
      onAccept()
      return
    }

    buildUI()
    startRinging()
  }

  private fun dpToPx(dp: Int): Int {
    return TypedValue.applyDimension(
      TypedValue.COMPLEX_UNIT_DIP,
      dp.toFloat(),
      resources.displayMetrics
    ).toInt()
  }

  private fun buildUI() {
    val root = FrameLayout(this).apply {
      setBackgroundColor(Color.parseColor("#1a1a2e"))
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      )
    }

    val container = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      ).apply {
        gravity = Gravity.CENTER
      }
    }

    // Avatar circle with initial
    val avatarSize = dpToPx(120)
    avatarSizePx = avatarSize
    val avatarBg = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(Color.parseColor("#16213e"))
      setStroke(dpToPx(3), Color.parseColor("#0f3460"))
    }
    val avatarText = TextView(this).apply {
      val initial = callerName?.firstOrNull()?.uppercase() ?: "?"
      text = initial
      setTextColor(Color.WHITE)
      textSize = 48f
      gravity = Gravity.CENTER
      background = avatarBg
      layoutParams = LinearLayout.LayoutParams(avatarSize, avatarSize).apply {
        gravity = Gravity.CENTER_HORIZONTAL
        bottomMargin = dpToPx(24)
      }
    }
    avatarTextView = avatarText
    container.addView(avatarText)

    // Async: baixa o avatar real e substitui o background gradiente por um
    // BitmapDrawable circular. Sem isso o callee só vê inicial+gradiente
    // (igual pra qualquer chamador). Backend manda caller_avatar no FCM.
    fetchAndApplyAvatar()

    // Caller name
    val nameText = TextView(this).apply {
      text = callerName
      setTextColor(Color.WHITE)
      textSize = 28f
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply {
        bottomMargin = dpToPx(8)
      }
    }
    container.addView(nameText)

    // Call type label
    val typeText = TextView(this).apply {
      text = if (hasVideo) "Chamada de video" else "Chamada de voz"
      setTextColor(Color.parseColor("#aaaaaa"))
      textSize = 16f
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply {
        bottomMargin = dpToPx(80)
      }
    }
    container.addView(typeText)

    // Buttons row
    val buttonsRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      )
    }

    // Decline button
    val declineBtnSize = dpToPx(72)
    val declineContainer = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply {
        marginEnd = dpToPx(48)
      }
    }

    val declineBg = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(Color.parseColor("#e74c3c"))
    }
    val declineBtn = TextView(this).apply {
      text = "\u2716"
      textSize = 28f
      setTextColor(Color.WHITE)
      gravity = Gravity.CENTER
      background = declineBg
      layoutParams = LinearLayout.LayoutParams(declineBtnSize, declineBtnSize)
      isClickable = true
      isFocusable = true
      setOnClickListener { onDecline() }
    }
    declineContainer.addView(declineBtn)

    val declineLabel = TextView(this).apply {
      text = "Recusar"
      setTextColor(Color.parseColor("#e74c3c"))
      textSize = 14f
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply {
        topMargin = dpToPx(8)
      }
    }
    declineContainer.addView(declineLabel)
    buttonsRow.addView(declineContainer)

    // Accept button
    val acceptContainer = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      )
    }

    val acceptBg = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(Color.parseColor("#2ecc71"))
    }
    val acceptBtn = TextView(this).apply {
      text = "\u2714"
      textSize = 28f
      setTextColor(Color.WHITE)
      gravity = Gravity.CENTER
      background = acceptBg
      layoutParams = LinearLayout.LayoutParams(declineBtnSize, declineBtnSize)
      isClickable = true
      isFocusable = true
      setOnClickListener { onAccept() }
    }
    acceptContainer.addView(acceptBtn)

    val acceptLabel = TextView(this).apply {
      text = "Atender"
      setTextColor(Color.parseColor("#2ecc71"))
      textSize = 14f
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply {
        topMargin = dpToPx(8)
      }
    }
    acceptContainer.addView(acceptLabel)
    buttonsRow.addView(acceptContainer)

    container.addView(buttonsRow)
    root.addView(container)
    setContentView(root)
  }

  private fun startRinging() {
    // Play ringtone
    try {
      val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
      ringtone = RingtoneManager.getRingtone(this, ringtoneUri)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        ringtone?.isLooping = true
      }
      ringtone?.play()
    } catch (e: Exception) {
      // Ringtone may not be available
    }

    // Vibrate
    try {
      vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
        vibratorManager.defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
      }

      val pattern = longArrayOf(0, 1000, 1000) // wait, vibrate, pause, repeat
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        vibrator?.vibrate(
          VibrationEffect.createWaveform(pattern, 0),
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .build()
        )
      } else {
        @Suppress("DEPRECATION")
        vibrator?.vibrate(pattern, 0)
      }
    } catch (e: Exception) {
      // Vibration may not be available
    }
  }

  private fun stopRinging() {
    try {
      ringtone?.stop()
      ringtone = null
    } catch (_: Exception) {}
    try {
      vibrator?.cancel()
      vibrator = null
    } catch (_: Exception) {}
  }

  /**
   * Baixa o avatar do chamador em background thread e aplica como background
   * circular do TextView avatar (sobrescrevendo o gradiente + a inicial). Sem
   * isso o callee só vê inicial mesmo quando o backend manda caller_avatar.
   * Usa o cache global do CallNotificationService pra evitar re-download.
   */
  private fun fetchAndApplyAvatar() {
    val url = callerAvatar ?: ""
    if (url.isEmpty()) return
    Thread {
      val bmp = CallNotificationService.fetchAvatarBitmap(url) ?: return@Thread
      try {
        val circular = makeCircularBitmap(bmp, avatarSizePx)
        mainHandler.post {
          try {
            avatarTextView?.let {
              it.text = "" // remove a inicial, mostra só a foto
              it.background = BitmapDrawable(resources, circular)
            }
          } catch (e: Exception) {
            Log.w("IncomingCallActivity", "Apply avatar failed: ${e.message}")
          }
        }
      } catch (e: Exception) {
        Log.w("IncomingCallActivity", "fetchAndApplyAvatar failed: ${e.message}")
      }
    }.start()
  }

  /**
   * Recorta um Bitmap retangular em um Bitmap circular com diâmetro `size`.
   */
  private fun makeCircularBitmap(src: Bitmap, size: Int): Bitmap {
    val s = if (size <= 0) src.width.coerceAtMost(src.height) else size
    val output = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(output)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    val rect = Rect(0, 0, s, s)
    val rectF = RectF(rect)
    canvas.drawARGB(0, 0, 0, 0)
    canvas.drawOval(rectF, paint)
    paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
    // Center-crop source to square s × s
    val scale = s.toFloat() / src.width.coerceAtMost(src.height).toFloat()
    val scaledW = (src.width * scale).toInt()
    val scaledH = (src.height * scale).toInt()
    val srcScaled = Bitmap.createScaledBitmap(src, scaledW, scaledH, true)
    val dx = (s - scaledW) / 2
    val dy = (s - scaledH) / 2
    canvas.drawBitmap(srcScaled, dx.toFloat(), dy.toFloat(), paint)
    return output
  }

  private fun onAccept() {
    stopRinging()

    // #841: pre-warm AudioManager antes do RN mount pra WebRTC ontrack nao perder os primeiros 1-3s de RTP
    try {
      val am = getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
      am.mode = android.media.AudioManager.MODE_IN_COMMUNICATION
      am.requestAudioFocus(null, android.media.AudioManager.STREAM_VOICE_CALL,
                           android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    } catch (_: Exception) {}

    // Save to SharedPreferences so JS can read on cold start
    ExpoCallKitModule.savePendingAcceptedCall(
      this, callId ?: "", callerName ?: "", callerEmail ?: "", conversationId ?: "", hasVideo
    )

    // [2026-05-15 #977] Persist accept flag too, BEFORE cancelNotification +
    // stopRingingService. CallActionReceiver checks this on every deleteIntent
    // delivery, including ones that fire after process death (FCM cold-start
    // kill). Without persistence, the in-memory acceptingCallIds map is empty
    // in the reborn process and the phantom decline gets through.
    ExpoCallKitModule.persistCallAccepting(this, callId ?: "")

    // Try to send event to JS (may fail if app is dead)
    ExpoCallKitModule.emitCallAnswered(callId ?: "")

    // Cancel the notification and stop the ringing foreground service
    CallNotificationService.cancelNotification(this, callId ?: "")
    stopRingingService()

    // Launch the main app
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    if (launchIntent != null) {
      launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      launchIntent.putExtra("call_id", callId)
      launchIntent.putExtra("caller_name", callerName)
      launchIntent.putExtra("caller_email", callerEmail)
      launchIntent.putExtra("conversation_id", conversationId)
      launchIntent.putExtra("has_video", hasVideo)
      startActivity(launchIntent)
    }

    // WhatsApp-grade warm UI: instead of dropping the activity (which leaves the
    // user staring at the launcher / home screen / black for 2-5s while the JS
    // bundle parses + Hermes warms up), keep this activity on top with a
    // "Conectando com X..." overlay until JS calls ExpoCallKit.notifyAppReady().
    // The existing closeReceiver finishes us when that broadcast fires; we also
    // arm an 8s safety timeout so a JS crash can't strand the overlay forever.
    buildConnectingOverlay()
    mainHandler.postDelayed({
      try { finishAndRemoveTask() } catch (_: Exception) {}
    }, 8000)
  }

  /**
   * Swap the ringing UI for a "Conectando com X..." card while the JS bundle
   * loads. Keeps the avatar + name in the same place so it feels like a
   * continuous transition instead of a flicker → home screen → /call.
   */
  private fun buildConnectingOverlay() {
    val root = FrameLayout(this).apply {
      setBackgroundColor(Color.parseColor("#1a1a2e"))
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      )
    }
    val container = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      ).apply { gravity = Gravity.CENTER }
    }

    val avatarSize = dpToPx(120)
    avatarSizePx = avatarSize
    val avatarBg = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(Color.parseColor("#16213e"))
      setStroke(dpToPx(3), Color.parseColor("#2ecc71"))
    }
    val avatarText = TextView(this).apply {
      val initial = callerName?.firstOrNull()?.uppercase() ?: "?"
      text = initial
      setTextColor(Color.WHITE)
      textSize = 48f
      gravity = Gravity.CENTER
      background = avatarBg
      layoutParams = LinearLayout.LayoutParams(avatarSize, avatarSize).apply {
        gravity = Gravity.CENTER_HORIZONTAL
        bottomMargin = dpToPx(24)
      }
    }
    avatarTextView = avatarText
    container.addView(avatarText)
    fetchAndApplyAvatar()

    val nameText = TextView(this).apply {
      text = callerName
      setTextColor(Color.WHITE)
      textSize = 24f
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply { bottomMargin = dpToPx(8) }
    }
    container.addView(nameText)

    val statusText = TextView(this).apply {
      text = "Conectando..."
      setTextColor(Color.parseColor("#2ecc71"))
      textSize = 16f
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply { bottomMargin = dpToPx(24) }
    }
    container.addView(statusText)

    val spinner = android.widget.ProgressBar(this).apply {
      isIndeterminate = true
      layoutParams = LinearLayout.LayoutParams(
        dpToPx(36), dpToPx(36)
      ).apply { gravity = Gravity.CENTER_HORIZONTAL }
    }
    container.addView(spinner)

    root.addView(container)
    setContentView(root)
  }

  private fun onDecline() {
    stopRinging()

    // Send event to JS via the module
    ExpoCallKitModule.emitCallEnded(callId ?: "")

    // Cancel the notification and stop the ringing foreground service
    CallNotificationService.cancelNotification(this, callId ?: "")
    stopRingingService()

    finish()
  }

  private fun stopRingingService() {
    try {
      val stopIntent = Intent(this, CallRingingService::class.java)
      stopService(stopIntent)
    } catch (_: Exception) {}
  }

  /**
   * Handle new intent when Activity already exists (singleInstance launchMode).
   * This happens when user taps "Atender" on notification while IncomingCallActivity
   * is already showing from the fullScreenIntent.
   */
  override fun onNewIntent(newIntent: Intent?) {
    super.onNewIntent(newIntent)
    if (newIntent?.getBooleanExtra("auto_accept", false) == true) {
      // Update call data from the new intent
      callId = newIntent.getStringExtra("call_id") ?: callId
      callerName = newIntent.getStringExtra("caller_name") ?: callerName
      callerEmail = newIntent.getStringExtra("caller_email") ?: callerEmail
      callerAvatar = newIntent.getStringExtra("caller_avatar") ?: callerAvatar
      conversationId = newIntent.getStringExtra("conversation_id") ?: conversationId
      hasVideo = newIntent.getBooleanExtra("has_video", hasVideo)
      onAccept()
    }
  }

  override fun onDestroy() {
    stopRinging()
    try {
      mainHandler.removeCallbacksAndMessages(null)
    } catch (_: Exception) {}
    try {
      unregisterReceiver(closeReceiver)
    } catch (_: Exception) {}
    super.onDestroy()
  }

  override fun onBackPressed() {
    // Do not allow back press to dismiss - must accept or decline
  }
}
