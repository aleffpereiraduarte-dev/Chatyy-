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
    val emailExtra = intent.getStringExtra("caller_email") ?: ""
    callerEmail = emailExtra
    // [#978-2] Email-local-part fallback so JS never receives the literal
    // "Unknown" sentinel (which it then displayed as "Contato desconhecido").
    callerName = intent.getStringExtra("caller_name")?.takeIf { it.isNotBlank() }
      ?: emailExtra.substringBefore('@').takeIf { it.isNotBlank() }
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

    // [decline-with-message, 2026-05-17] Secondary "Recusar com mensagem"
    // button below the main accept/decline row. Tapping it opens a bottom
    // sheet with 4 preset replies + a custom field. Mirrors WhatsApp's
    // incoming-call quick-reply. The actual send happens in
    // onDeclineWithMessage which posts to chat_call_decline_with_message
    // (so the caller sees the reason as a chat message) and then ends
    // the call with reason='declined' just like a plain decline.
    val quickReplyContainer = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply { topMargin = dpToPx(20) }
    }
    val quickReplyBtn = TextView(this).apply {
      text = "Recusar com mensagem"
      setTextColor(Color.parseColor("#90a4ae"))
      textSize = 14f
      gravity = Gravity.CENTER
      setPadding(dpToPx(16), dpToPx(10), dpToPx(16), dpToPx(10))
      val bg = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dpToPx(24).toFloat()
        setStroke(dpToPx(1), Color.parseColor("#4a5662"))
      }
      background = bg
      isClickable = true
      isFocusable = true
      setOnClickListener { showQuickReplySheet() }
    }
    quickReplyContainer.addView(quickReplyBtn)
    container.addView(quickReplyContainer)

    root.addView(container)
    setContentView(root)
  }

  /**
   * Bottom sheet with 4 preset replies + a custom input. Each preset on tap
   * posts the message into the DM via chat_call_decline_with_message AND
   * closes the call. The custom row reveals an EditText + Send button.
   */
  private fun showQuickReplySheet() {
    val presets = listOf(
      "Te ligo já",
      "Estou ocupado",
      "Não posso falar agora",
      "Pode mandar mensagem?",
    )
    val builder = androidx.appcompat.app.AlertDialog.Builder(this, androidx.appcompat.R.style.Theme_AppCompat_Dialog_Alert)
    val sheet = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dpToPx(20), dpToPx(16), dpToPx(20), dpToPx(20))
    }
    val title = TextView(this).apply {
      text = "Responder com mensagem"
      setTextColor(Color.parseColor("#212121"))
      textSize = 16f
      setPadding(0, 0, 0, dpToPx(12))
    }
    sheet.addView(title)
    val dialog = builder.setView(sheet).setCancelable(true).create()
    presets.forEach { p ->
      val row = TextView(this).apply {
        text = p
        textSize = 15f
        setTextColor(Color.parseColor("#1976d2"))
        setPadding(dpToPx(8), dpToPx(14), dpToPx(8), dpToPx(14))
        isClickable = true
        isFocusable = true
        setOnClickListener {
          dialog.dismiss()
          onDeclineWithMessage(p)
        }
      }
      sheet.addView(row)
    }
    // Custom row — inline EditText + Send.
    val customRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(0, dpToPx(8), 0, 0)
    }
    val input = android.widget.EditText(this).apply {
      hint = "Mensagem personalizada"
      textSize = 15f
      setTextColor(Color.parseColor("#212121"))
      setHintTextColor(Color.parseColor("#9e9e9e"))
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
      maxLines = 2
      filters = arrayOf(android.text.InputFilter.LengthFilter(240))
    }
    val sendBtn = TextView(this).apply {
      text = "Enviar"
      setTextColor(Color.parseColor("#1976d2"))
      textSize = 15f
      setPadding(dpToPx(12), dpToPx(10), dpToPx(12), dpToPx(10))
      isClickable = true
      isFocusable = true
      setOnClickListener {
        val txt = input.text?.toString()?.trim().orEmpty()
        if (txt.isNotEmpty()) {
          dialog.dismiss()
          onDeclineWithMessage(txt)
        }
      }
    }
    customRow.addView(input)
    customRow.addView(sendBtn)
    sheet.addView(customRow)
    dialog.show()
  }

  /**
   * Decline + drop a chat message. POSTs to chat_call_decline_with_message
   * on the backend which inserts the message into the conversation and
   * fans the standard call_end event to the caller. We do NOT block the
   * dismiss on the HTTP roundtrip — the user expects the screen to close
   * instantly; the backend handles delivery asynchronously.
   */
  private fun onDeclineWithMessage(message: String) {
    // Same UI side-effects as onDecline: stop ring + service + finish.
    stopRinging()
    ExpoCallKitModule.emitCallEnded(callId ?: "")
    CallNotificationService.cancelNotification(this, callId ?: "")
    stopRingingService()

    // Best-effort HTTP send. We don't have the auth token in this Activity
    // (it lives in SharedPreferences via persistAuthForNativeCall) — read
    // it the same way NativeCallTokenFetcher does in the iOS path.
    val ctx = applicationContext
    val cid = callId ?: ""
    val conv = conversationId ?: ""
    val target = callerEmail ?: ""
    Thread {
      try {
        val sp = ctx.getSharedPreferences("expo_callkit_prefs", Context.MODE_PRIVATE)
        val authToken = sp.getString("auth_token", "") ?: ""
        val apiBase = sp.getString("api_base", "") ?: ""
        if (authToken.isEmpty() || apiBase.isEmpty()) return@Thread
        val base = if (apiBase.endsWith("/")) apiBase.dropLast(1) else apiBase
        val url = java.net.URL("$base/api/email.php?action=chat_call_decline_with_message")
        val conn = (url.openConnection() as java.net.HttpURLConnection).apply {
          requestMethod = "POST"
          setRequestProperty("Authorization", "Bearer $authToken")
          setRequestProperty("Content-Type", "application/json")
          setRequestProperty("Accept", "application/json")
          doOutput = true
          connectTimeout = 4000
          readTimeout = 6000
        }
        val body = org.json.JSONObject(mapOf(
          "action" to "chat_call_decline_with_message",
          "call_id" to cid,
          "conversation_id" to conv,
          "to_email" to target,
          "message" to message.take(240),
        )).toString()
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        Log.d("IncomingCallActivity", "decline-with-msg HTTP ${conn.responseCode}")
        try { conn.inputStream.close() } catch (_: Throwable) {}
      } catch (t: Throwable) {
        Log.w("IncomingCallActivity", "decline-with-msg failed: ${t.message}")
      }
    }.start()
    finish()
  }

  private fun startRinging() {
    // [2026-05-15 #fix-6] Removed the activity-side RingtoneManager playback.
    // The NotificationChannel "incoming_calls" (CallNotificationService.kt:87)
    // already configures setSound(defaultRingtoneUri, USAGE_NOTIFICATION_RINGTONE)
    // at IMPORTANCE_HIGH, so the OS is already ringing as soon as the
    // foreground notification posts — playing a second Ringtone here
    // produced a 1-2s audible double-ring (channel sound + Ringtone) at
    // call start before audio focus settled. The channel is the single
    // owner of the ringtone audio path; vibration stays here because the
    // activity needs a tighter on/off cadence than the channel pattern.

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

    // Save to SharedPreferences so JS can read on cold start. JS still
    // consumePendingCall()s this when it eventually mounts (catches up to
    // the call state, hydrates UI). Native CallActivity is the one the
    // user actually SEES — JS is just bookkeeping at this point.
    ExpoCallKitModule.savePendingAcceptedCall(
      this, callId ?: "", callerName ?: "", callerEmail ?: "", conversationId ?: "", hasVideo
    )

    // [2026-05-15 #977] Persist accept flag too, BEFORE cancelNotification +
    // stopRingingService. CallActionReceiver checks this on every deleteIntent
    // delivery, including ones that fire after process death (FCM cold-start
    // kill). Without persistence, the in-memory acceptingCallIds map is empty
    // in the reborn process and the phantom decline gets through.
    ExpoCallKitModule.persistCallAccepting(this, callId ?: "")

    // Try to send event to JS (may fail if app is dead — that's OK, JS picks
    // up the call via consumePendingCall when it eventually mounts).
    ExpoCallKitModule.emitCallAnswered(callId ?: "")

    // Cancel the notification and stop the ringing foreground service. Do
    // this BEFORE launching CallActivity so the user doesn't see both UIs
    // briefly stacked during the transition.
    CallNotificationService.cancelNotification(this, callId ?: "")
    stopRingingService()

    // [2026-05-16 Stage 4 full-native] Jump STRAIGHT to CallActivity.
    //   - Cache hit (JS pre-stashed via persistPendingLkToken on call_invite
    //     WS event) → launch synchronously, audio publishes ~500ms.
    //   - Cache miss → launch coroutine on Dispatchers.IO to fetch the
    //     token + url, then start CallActivity. While the fetch is in
    //     flight (~300ms typical, 8s timeout) we keep this activity alive
    //     showing the "Conectando…" overlay so the user is never staring
    //     at a black screen.
    //
    // This replaces the old MainActivity launch path. The user's first
    // visible frame after tapping Aceitar is now CallActivity (native LK
    // connect) — no JS bundle parse on the critical path, no
    // "atender e desliga" race.
    launchCallActivity()

    // WhatsApp-grade transitional overlay while CallActivity becomes
    // visible (and while the token fetch resolves on cache miss). The
    // existing closeReceiver finishes us when CallActivity / JS signals
    // the call is up; safety timeout fires after 15s as last resort.
    buildConnectingOverlay()
    mainHandler.postDelayed({
      try { finishAndRemoveTask() } catch (_: Exception) {}
    }, 15000)
  }

  /**
   * [2026-05-16 Stage 4] Hand the call to CallActivity, which owns the
   * actual LiveKit Room and renders the in-call UI. Token resolution:
   *
   *   1. Try LkTokenFetcher.getCached(callId) — JS may have already
   *      fetched this in response to the call_invite WS event and
   *      stashed it via persistPendingLkToken. If present, start the
   *      activity synchronously.
   *   2. Otherwise, launch a background Thread (NOT main-thread, the
   *      doFetch in LkTokenFetcher does blocking HTTP) that fetches the
   *      token and then starts the activity on the main thread.
   *   3. On fetch failure (no auth persisted, network error, backend
   *      down) we still start CallActivity but WITHOUT lk_url/lk_token —
   *      CallActivity gracefully shows "Sem token" and the user can
   *      hangup. The legacy JS path no longer exists as a fallback (this
   *      IS the only path), so we must always show *something* native.
   */
  private fun launchCallActivity() {
    val id = callId ?: return
    val name = callerName ?: ""
    val email = callerEmail ?: ""
    val video = hasVideo

    val cached = LkTokenFetcher.getCached(applicationContext, id)
    if (cached != null) {
      Log.d("IncomingCallActivity", "[stage4] cache hit — launching CallActivity sync")
      startCallActivityWith(id, name, email, video, cached.url, cached.token)
      // [2026-05-16 Stage 2 native WS signaling] Fire call_answered from
      // native AFTER CallActivity is launched (cache-hit path). JS-side
      // services/api.js call_answered fires in parallel via emitCallAnswered
      // → JS listener; server dedupes by call_id, so the duplicate is safe.
      // Empty conversationId is tolerated for dialer-style calls.
      CallSignalWs.fireCallAnswered(applicationContext, id, conversationId ?: "")
      return
    }

    // Cache miss → fetch on a background thread, then launch.
    // [#1175 2026-05-18] Pass our own Intent extras so LkTokenFetcher can
    // resolve auth via fallback B (intent) if SharedPreferences (source A)
    // is empty.
    val ourExtras = intent?.extras
    Thread {
      val identity = email.takeIf { it.isNotBlank() } ?: "android-$id"
      val tk = LkTokenFetcher.fetch(applicationContext, id, identity, ourExtras)
      mainHandler.post {
        if (tk == null) {
          Log.w("IncomingCallActivity", "[stage4] token fetch FAILED — launching CallActivity without token (user will see error)")
          startCallActivityWith(id, name, email, video, null, null)
        } else {
          Log.d("IncomingCallActivity", "[stage4] token fetched (${tk.token.length} chars) — launching CallActivity")
          startCallActivityWith(id, name, email, video, tk.url, tk.token)
        }
        // [2026-05-16 Stage 2 native WS signaling] Fire call_answered AFTER
        // LkTokenFetcher.fetch returns (success OR failure). We fire even on
        // token failure because the user did tap Accept — letting the
        // caller's UI know the callee answered is independent of whether
        // the media plane comes up. Server dedupes by call_id.
        CallSignalWs.fireCallAnswered(applicationContext, id, conversationId ?: "")
      }
    }.start()
  }

  private fun startCallActivityWith(
    id: String,
    name: String,
    email: String,
    video: Boolean,
    url: String?,
    token: String?
  ) {
    try {
      val intent = Intent(this, CallActivity::class.java).apply {
        // [#1172 native-call-in-background fix, 2026-05-19] Same foreground-
        // forcing flag set as ExpoCallKitModule.openNativeCall. Without
        // REORDER_TO_FRONT the lockscreen ringing task / launcher task can
        // keep itself on top while CallActivity builds invisibly in its own
        // affinity-less task — i.e. activity does start, LK connects, audio
        // captures, but the user never sees the UI ("native call screen
        // opens in background"). SINGLE_TOP avoids a 2nd instance; CLEAR_TOP
        // clears anything stale sitting between this and the call screen.
        addFlags(
          Intent.FLAG_ACTIVITY_NEW_TASK
            or Intent.FLAG_ACTIVITY_SINGLE_TOP
            or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            or Intent.FLAG_ACTIVITY_CLEAR_TOP
        )
        putExtra(CallActivity.EXTRA_CALL_ID, id)
        putExtra(CallActivity.EXTRA_CALLER_NAME, name)
        putExtra(CallActivity.EXTRA_CALLER_EMAIL, email)
        putExtra(CallActivity.EXTRA_HAS_VIDEO, video)
        // [2026-05-16 Stage 2] Forward the conversation_id so CallActivity's
        // finishCall() can fire call_end with the right (call_id, conv_id)
        // pair via CallSignalWs.
        putExtra(CallActivity.EXTRA_CONVERSATION_ID, conversationId ?: "")
        if (!url.isNullOrEmpty()) putExtra(CallActivity.EXTRA_LK_URL, url)
        if (!token.isNullOrEmpty()) putExtra(CallActivity.EXTRA_LK_TOKEN, token)
        // [#1114 avatar handoff, 2026-05-19] Forward caller_avatar so the
        // in-call SwiftUI/Compose screen renders the real photo instead of
        // the initials letter. Backend already populates this in FCM data
        // payload via chatCallerAvatarUrl(); IncomingCallActivity holds it
        // in `callerAvatar` since onCreate. Was being dropped when handing
        // off to CallActivity — that's why "Suporte" showed only the "S".
        if (!callerAvatar.isNullOrEmpty()) putExtra(CallActivity.EXTRA_CALLER_AVATAR, callerAvatar)
        // [#1175 2026-05-18] Carry the bearer + base URL in the Intent so
        // CallActivity's onCreate has them even if the SharedPreferences
        // was cleared between the FCM push (which seeded them) and the
        // user tapping Accept (which we honour right now). Without this,
        // a fallback fetchToken would fail and the user would see the
        // "Sem token" string on the receiver side — exactly the bug
        // #1175 is targeting.
        ExpoCallKitModule.enrichIntentWithAuth(applicationContext, this)
      }
      startActivity(intent)
    } catch (t: Throwable) {
      Log.e("IncomingCallActivity", "startCallActivity failed: ${t.message}")
    }
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

    // [#1179 cleanup, 2026-05-19] Notify the caller via WS that we declined.
    // Without this, the caller's UI stayed on "Calling..." until the 30s
    // ring timeout fired and the caller could not tell the call was rejected.
    // CallSignalWs.fireCallEnd is idempotent on the server (dedup by call_id),
    // so firing here AND the JS-side emitCallEnded path is safe — server
    // collapses duplicates.
    try {
      CallSignalWs.fireCallEnd(
        applicationContext,
        callId ?: "",
        conversationId ?: "",
        "declined"
      )
    } catch (_: Exception) {}

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
  override fun onNewIntent(newIntent: Intent) {
    super.onNewIntent(newIntent)
    if (newIntent.getBooleanExtra("auto_accept", false) == true) {
      // [2026-05-15] singleInstance launchMode means a 2nd incoming call's
      // "Atender" notification action would route through THIS activity's
      // onNewIntent, silently overwriting callId/callerName/etc. — i.e. we'd
      // dispatch onAccept() but with the call we just ACCEPTED on the same
      // screen still bound to the buttons. If the new intent is for a
      // different callId, ignore it; a separate IncomingCallActivity / FGS
      // is already (or will be) handling that 2nd call and we don't want to
      // hijack the in-flight accept.
      val newCallId = newIntent.getStringExtra("call_id") ?: ""
      val currentId = callId ?: ""
      if (newCallId.isNotEmpty() && currentId.isNotEmpty() && newCallId != currentId) {
        Log.w("IncomingCallActivity", "onNewIntent callId mismatch — ignoring (current=$currentId new=$newCallId)")
        return
      }
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
