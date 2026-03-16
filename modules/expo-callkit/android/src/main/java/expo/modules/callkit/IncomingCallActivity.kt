package expo.modules.callkit

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.media.Ringtone
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
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
  private var conversationId: String? = null
  private var hasVideo: Boolean = false

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
    callerName = intent.getStringExtra("caller_name") ?: "Unknown"
    callerEmail = intent.getStringExtra("caller_email") ?: ""
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
    container.addView(avatarText)

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

  private fun onAccept() {
    stopRinging()

    // Save to SharedPreferences so JS can read on cold start
    ExpoCallKitModule.savePendingAcceptedCall(
      this, callId ?: "", callerName ?: "", callerEmail ?: "", conversationId ?: "", hasVideo
    )

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

    finish()
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
      conversationId = newIntent.getStringExtra("conversation_id") ?: conversationId
      hasVideo = newIntent.getBooleanExtra("has_video", hasVideo)
      onAccept()
    }
  }

  override fun onDestroy() {
    stopRinging()
    try {
      unregisterReceiver(closeReceiver)
    } catch (_: Exception) {}
    super.onDestroy()
  }

  override fun onBackPressed() {
    // Do not allow back press to dismiss - must accept or decline
  }
}
