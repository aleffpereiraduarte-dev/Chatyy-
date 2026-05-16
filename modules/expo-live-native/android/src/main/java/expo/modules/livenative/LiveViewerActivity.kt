package expo.modules.livenative

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.AlphaAnimation
import android.view.animation.AnimationSet
import android.view.animation.LinearInterpolator
import android.view.animation.TranslateAnimation
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.SurfaceViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * LiveViewerActivity — Stage 2 (2026-05-16). Full-native Live viewer screen.
 *
 * Subscribe-only LiveKit Room (host publishes, viewer never does in Stage 2).
 *  - On `TrackSubscribed(VideoTrack)` → bind track to fullscreen
 *    SurfaceViewRenderer.
 *  - WebSocket on `live_<sessionId>` for chat + reactions + viewer count.
 *  - Send comment composer, heart reaction button, "Pedir cohost" pill.
 *
 * Pattern mirrors LiveHostActivity (above) minus the camera publish + duration
 * timer; viewer doesn't host the session clock and never produces media.
 */
class LiveViewerActivity : ComponentActivity() {

  companion object {
    private const val TAG = "LiveViewerActivity"
    private const val WS_URL = "wss://ws.chatyy.com.br/ws"
    private const val WS_PREFS = "expo_callkit_prefs"
    private const val MAX_COMMENTS = 50
    private const val MAX_REACTIONS = 20

    const val EXTRA_LK_TOKEN = "lk_token"
    const val EXTRA_LK_URL = "lk_url"
    const val EXTRA_ROOM_NAME = "room_name"
    const val EXTRA_HOST_NAME = "host_name"
    const val EXTRA_HOST_AVATAR_URL = "host_avatar_url"
  }

  // Intent state
  private var lkUrl: String? = null
  private var lkToken: String? = null
  private var roomName: String = ""
  private var hostName: String = ""
  private var hostAvatarUrl: String = ""

  // LiveKit
  private var room: Room? = null
  private var eventsJob: Job? = null
  private var connectJob: Job? = null
  private var remoteRenderer: SurfaceViewRenderer? = null

  // UI
  private lateinit var statusText: TextView
  private lateinit var viewerCountText: TextView
  private lateinit var hostNameText: TextView
  private lateinit var commentsContainer: LinearLayout
  private lateinit var commentsScroll: ScrollView
  private lateinit var commentInput: EditText
  private lateinit var heartLayer: FrameLayout
  private lateinit var livePill: TextView

  // WebSocket
  private var ws: WebSocket? = null
  private var wsAuthed = false
  private var wsClient: OkHttpClient? = null
  private val wsScope = kotlinx.coroutines.CoroutineScope(
    kotlinx.coroutines.SupervisorJob() + Dispatchers.IO
  )
  private val outboundQueue = java.util.concurrent.ConcurrentLinkedQueue<String>()

  private val mainHandler = Handler(Looper.getMainLooper())
  private val pulseRunnable = object : Runnable {
    override fun run() {
      livePill.alpha = if ((System.currentTimeMillis() / 800) % 2L == 0L) 1.0f else 0.55f
      mainHandler.postDelayed(this, 800)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    val extras = intent?.extras ?: Bundle()
    lkToken = extras.getString(EXTRA_LK_TOKEN)
    lkUrl = extras.getString(EXTRA_LK_URL)
    roomName = extras.getString(EXTRA_ROOM_NAME) ?: ""
    hostName = extras.getString(EXTRA_HOST_NAME) ?: ""
    hostAvatarUrl = extras.getString(EXTRA_HOST_AVATAR_URL) ?: ""

    Log.d(TAG, "onCreate: room=$roomName host=$hostName " +
      "hasUrl=${!lkUrl.isNullOrEmpty()} hasToken=${!lkToken.isNullOrEmpty()}")

    setContentView(buildRootView())

    if (!lkUrl.isNullOrEmpty() && !lkToken.isNullOrEmpty()) {
      bringUpRoom(lkUrl!!, lkToken!!)
    } else {
      statusText.text = "Sem token"
    }

    connectWs()
    mainHandler.post(pulseRunnable)
  }

  // ────────────────────────────────────────────────────────────────────────
  //  LiveKit — SUBSCRIBE-ONLY
  // ────────────────────────────────────────────────────────────────────────

  private fun bringUpRoom(url: String, token: String) {
    val r = LiveKit.create(applicationContext)
    room = r

    remoteRenderer?.let { r.initVideoRenderer(it) }

    eventsJob = lifecycleScope.launch {
      r.events.collect { event ->
        when (event) {
          is RoomEvent.Connected -> {
            Log.d(TAG, "RoomEvent.Connected — subscribe-only")
            statusText.visibility = View.GONE
            // Mirror legacy JS viewer: emit live_join so server adds us to
            // the channel + bumps the viewer count.
            sendWs(JSONObject().apply {
              put("type", "live_join")
              put("session_id", roomName)
            }.toString())
          }
          is RoomEvent.Reconnecting -> { statusText.visibility = View.VISIBLE; statusText.text = "Reconectando…" }
          is RoomEvent.Reconnected  -> { statusText.visibility = View.GONE }
          is RoomEvent.Disconnected -> {
            Log.d(TAG, "RoomEvent.Disconnected reason=${event.reason}")
            finishViewer("room_disconnect")
          }
          is RoomEvent.TrackSubscribed -> {
            val t = event.track
            if (t is VideoTrack) {
              Log.d(TAG, "TrackSubscribed video sid=${event.publication.sid}")
              remoteRenderer?.let { rv ->
                try { t.addRenderer(rv) } catch (e: Throwable) {
                  Log.w(TAG, "addRenderer(remote) failed: ${e.message}")
                }
              }
            }
          }
          else -> { /* no-op */ }
        }
      }
    }

    connectJob = lifecycleScope.launch {
      try {
        r.connect(url, token)
        // Viewer is subscribe-only — explicitly DO NOT enable mic/camera.
        // Defensive: in case the LK server token grants publish, we still
        // toggle off so the device camera/mic never wake.
        try { r.localParticipant.setMicrophoneEnabled(false) } catch (_: Throwable) {}
        try { r.localParticipant.setCameraEnabled(false) } catch (_: Throwable) {}
        Log.d(TAG, "LK viewer connect OK (subscribe-only)")
      } catch (t: Throwable) {
        Log.e(TAG, "LK viewer connect failed: ${t.message}", t)
        statusText.text = "Erro de conexão"
        ExpoLiveNativeModule.emitLiveError(roomName, t.message ?: "viewer connect failed")
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  WebSocket
  // ────────────────────────────────────────────────────────────────────────

  private fun connectWs() {
    val prefs = applicationContext.getSharedPreferences(WS_PREFS, Context.MODE_PRIVATE)
    val token = prefs.getString("auth_token", null)
    if (token.isNullOrEmpty()) {
      Log.w(TAG, "connectWs: no auth_token — WS chat disabled")
      return
    }

    val client = OkHttpClient.Builder()
      .connectTimeout(5, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .writeTimeout(5, TimeUnit.SECONDS)
      .pingInterval(30, TimeUnit.SECONDS)
      .build()
    wsClient = client

    val req = Request.Builder().url(WS_URL).build()
    val listener = object : WebSocketListener() {
      override fun onOpen(w: WebSocket, response: Response) {
        Log.d(TAG, "WS open — auth")
        w.send(JSONObject().apply {
          put("type", "auth")
          put("token", token)
        }.toString())
      }
      override fun onMessage(w: WebSocket, text: String) { handleWsFrame(text) }
      override fun onMessage(w: WebSocket, bytes: ByteString) { /* ignore */ }
      override fun onFailure(w: WebSocket, t: Throwable, response: Response?) {
        Log.w(TAG, "WS failure: ${t.message}")
        wsAuthed = false; ws = null; scheduleWsReconnect()
      }
      override fun onClosed(w: WebSocket, code: Int, reason: String) {
        Log.d(TAG, "WS closed $code $reason")
        wsAuthed = false; ws = null
        if (!isFinishing) scheduleWsReconnect()
      }
    }
    ws = client.newWebSocket(req, listener)
  }

  private fun scheduleWsReconnect() {
    if (isFinishing || isDestroyed) return
    wsScope.launch {
      delay(2_000)
      if (!isFinishing && !isDestroyed) connectWs()
    }
  }

  private fun handleWsFrame(text: String) {
    val obj = try { JSONObject(text) } catch (_: Throwable) { return }
    when (obj.optString("type")) {
      "auth_success" -> {
        wsAuthed = true
        // Subscribe via live_join now that auth landed.
        sendWs(JSONObject().apply {
          put("type", "live_join")
          put("session_id", roomName)
        }.toString())
        while (true) {
          val msg = outboundQueue.poll() ?: break
          ws?.send(msg)
        }
      }
      "live_chat" -> {
        val name = obj.optString("sender_name", obj.optString("sender_email", "?"))
        val content = obj.optString("content", "")
        if (content.isNotEmpty()) mainHandler.post { appendComment(name, content) }
      }
      "live_reaction" -> {
        val emoji = obj.optString("emoji", "♥")
        mainHandler.post { spawnReaction(emoji) }
      }
      "live_viewer_count" -> {
        val count = obj.optInt("count", 0)
        mainHandler.post { viewerCountText.text = formatViewerCount(count) }
      }
      "live_ended", "live_end" -> {
        mainHandler.post {
          statusText.visibility = View.VISIBLE
          statusText.text = "Live encerrada"
          mainHandler.postDelayed({ finishViewer("host_ended") }, 1500)
        }
      }
      else -> { /* no-op */ }
    }
  }

  private fun sendWs(json: String) {
    if (wsAuthed && ws != null) {
      try { ws!!.send(json) } catch (t: Throwable) {
        Log.w(TAG, "WS send failed: ${t.message}")
        outboundQueue.offer(json)
      }
    } else {
      outboundQueue.offer(json)
      if (outboundQueue.size > 64) outboundQueue.poll()
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  UI helpers
  // ────────────────────────────────────────────────────────────────────────

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

  private fun appendComment(name: String, text: String) {
    val line = TextView(this).apply {
      val full = "$name: $text"
      val sb = android.text.SpannableStringBuilder(full)
      sb.setSpan(android.text.style.StyleSpan(Typeface.BOLD), 0, name.length,
        android.text.Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
      setText(sb)
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      setPadding(dp(8), dp(4), dp(8), dp(4))
    }
    commentsContainer.addView(line)
    while (commentsContainer.childCount > MAX_COMMENTS) {
      commentsContainer.removeViewAt(0)
    }
    line.startAnimation(AlphaAnimation(0f, 1f).apply { duration = 200 })
    commentsScroll.post { commentsScroll.fullScroll(View.FOCUS_DOWN) }
  }

  private fun spawnReaction(emoji: String) {
    val heart = TextView(this).apply {
      text = emoji
      setTextColor(Color.parseColor("#FF3B6B"))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
    }
    val startX = (Math.random() * dp(40)).toInt() + dp(4)
    val lp = FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply {
      gravity = Gravity.BOTTOM or Gravity.END
      rightMargin = startX
      bottomMargin = dp(150)
    }
    heartLayer.addView(heart, lp)
    while (heartLayer.childCount > MAX_REACTIONS) heartLayer.removeViewAt(0)

    val set = AnimationSet(true).apply {
      addAnimation(TranslateAnimation(0f, -dp(30).toFloat(), 0f, -dp(220).toFloat()))
      addAnimation(AlphaAnimation(1f, 0f).apply { startOffset = 1000 })
      duration = 2000
      interpolator = LinearInterpolator()
      fillAfter = false
    }
    heart.startAnimation(set)
    mainHandler.postDelayed({
      try { heartLayer.removeView(heart) } catch (_: Throwable) {}
    }, 2100)
  }

  private fun formatViewerCount(n: Int): String {
    return when {
      n >= 1_000_000 -> String.format("%.1fM", n / 1_000_000.0)
      n >= 1_000     -> String.format("%.1fK", n / 1_000.0)
      else           -> n.toString()
    } + " 👁"
  }

  // ────────────────────────────────────────────────────────────────────────
  //  View tree
  // ────────────────────────────────────────────────────────────────────────

  private fun buildRootView(): View {
    val root = FrameLayout(this).apply {
      setBackgroundColor(Color.BLACK)
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }

    // Fullscreen remote video.
    remoteRenderer = SurfaceViewRenderer(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    root.addView(remoteRenderer)

    heartLayer = FrameLayout(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    root.addView(heartLayer)

    statusText = TextView(this).apply {
      text = "Conectando…"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      setBackgroundColor(Color.parseColor("#80000000"))
      setPadding(dp(12), dp(6), dp(12), dp(6))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply {
        gravity = Gravity.CENTER
      }
    }
    root.addView(statusText)

    // ── Top bar
    val topBar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(12), dp(40), dp(12), dp(8))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply { gravity = Gravity.TOP }
    }

    val closeBtn = makeCircleButton(dp(36), Color.parseColor("#80000000")) {
      finishViewer("user_leave")
    }
    closeBtn.setImageDrawable(makeCloseDrawable())
    topBar.addView(closeBtn, LinearLayout.LayoutParams(dp(36), dp(36)).apply {
      marginEnd = dp(8)
    })

    livePill = TextView(this).apply {
      text = "AO VIVO"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      setTypeface(typeface, Typeface.BOLD)
      setPadding(dp(10), dp(4), dp(10), dp(4))
      background = pillDrawable(Color.parseColor("#E53935"))
    }
    topBar.addView(livePill, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { marginEnd = dp(8) })

    viewerCountText = TextView(this).apply {
      text = formatViewerCount(0)
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      setPadding(dp(10), dp(4), dp(10), dp(4))
      background = pillDrawable(Color.parseColor("#80000000"))
    }
    topBar.addView(viewerCountText, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { marginEnd = dp(8) })

    hostNameText = TextView(this).apply {
      text = if (hostName.isNotEmpty()) hostName else "ao vivo"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setTypeface(typeface, Typeface.BOLD)
      setPadding(dp(10), dp(4), dp(10), dp(4))
      background = pillDrawable(Color.parseColor("#80000000"))
    }
    topBar.addView(hostNameText, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ))

    topBar.addView(View(this), LinearLayout.LayoutParams(0, 0, 1f))

    root.addView(topBar)

    // ── Comments overlay (bottom-left).
    val commentsBox = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(8), dp(8), dp(8), dp(8))
      background = pillDrawable(Color.parseColor("#66000000"))
      layoutParams = FrameLayout.LayoutParams(
        dp(280),
        dp(260)
      ).apply {
        gravity = Gravity.BOTTOM or Gravity.START
        leftMargin = dp(12)
        bottomMargin = dp(110)
      }
    }
    commentsScroll = ScrollView(this).apply {
      isVerticalScrollBarEnabled = false
      layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    commentsContainer = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.BOTTOM
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      )
    }
    commentsScroll.addView(commentsContainer)
    commentsBox.addView(commentsScroll)
    root.addView(commentsBox)

    // ── Bottom composer row + heart + cohost
    val bottomBar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(12), dp(8), dp(12), dp(28))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply { gravity = Gravity.BOTTOM }
    }

    commentInput = EditText(this).apply {
      hint = "Comentar…"
      setHintTextColor(Color.parseColor("#80FFFFFF"))
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      setPadding(dp(14), dp(8), dp(14), dp(8))
      background = pillDrawable(Color.parseColor("#80000000"))
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      maxLines = 2
    }
    bottomBar.addView(commentInput, LinearLayout.LayoutParams(0,
      ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(8) })

    val sendBtn = Button(this).apply {
      text = "Enviar"
      setOnClickListener {
        val txt = commentInput.text.toString().trim()
        if (txt.isNotEmpty()) {
          sendWs(JSONObject().apply {
            put("type", "live_chat")
            put("session_id", roomName)
            put("content", txt)
          }.toString())
          appendComment("Você", txt)
          commentInput.setText("")
        }
      }
    }
    bottomBar.addView(sendBtn, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { marginEnd = dp(8) })

    val heartBtn = TextView(this).apply {
      text = "♥"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
      gravity = Gravity.CENTER
      setPadding(dp(12), dp(8), dp(12), dp(8))
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.parseColor("#FF3B6B"))
      }
      setOnClickListener {
        sendWs(JSONObject().apply {
          put("type", "live_reaction")
          put("session_id", roomName)
          put("emoji", "♥")
        }.toString())
        spawnReaction("♥")
      }
    }
    bottomBar.addView(heartBtn, LinearLayout.LayoutParams(dp(44), dp(44)).apply {
      marginEnd = dp(8)
    })

    val cohostPill = TextView(this).apply {
      text = "Entrar"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      setPadding(dp(12), dp(8), dp(12), dp(8))
      background = pillDrawable(Color.parseColor("#1F2C34"))
      setOnClickListener {
        sendWs(JSONObject().apply {
          put("type", "live_join_request")
          put("session_id", roomName)
        }.toString())
        text = "Solicitado"
        isEnabled = false
      }
    }
    bottomBar.addView(cohostPill, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ))

    root.addView(bottomBar)

    return root
  }

  private fun makeCircleButton(size: Int, bg: Int, onClick: () -> Unit): ImageButton {
    return ImageButton(this).apply {
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(bg)
      }
      scaleType = android.widget.ImageView.ScaleType.CENTER_INSIDE
      layoutParams = ViewGroup.LayoutParams(size, size)
      setOnClickListener { onClick() }
    }
  }

  private fun makeCloseDrawable(): android.graphics.drawable.Drawable {
    val size = dp(36)
    val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(bmp)
    val txt = TextView(this).apply {
      text = "×"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
      gravity = Gravity.CENTER
    }
    txt.measure(
      View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY)
    )
    txt.layout(0, 0, size, size)
    txt.draw(canvas)
    return android.graphics.drawable.BitmapDrawable(resources, bmp)
  }

  private fun pillDrawable(color: Int): GradientDrawable {
    return GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      cornerRadius = dp(16).toFloat()
      setColor(color)
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Lifecycle
  // ────────────────────────────────────────────────────────────────────────

  override fun onBackPressed() { finishViewer("back") }

  private fun finishViewer(reason: String) {
    Log.d(TAG, "finishViewer reason=$reason room=$roomName")
    sendWs(JSONObject().apply {
      put("type", "live_leave")
      put("session_id", roomName)
    }.toString())
    mainHandler.removeCallbacks(pulseRunnable)
    eventsJob?.cancel()
    connectJob?.cancel()
    try { ExpoLiveNativeModule.emitLiveEnded(roomName, reason) } catch (_: Throwable) {}
    finish()
  }

  @OptIn(DelicateCoroutinesApi::class)
  override fun onDestroy() {
    mainHandler.removeCallbacks(pulseRunnable)
    eventsJob?.cancel()
    connectJob?.cancel()
    try { ws?.close(1000, "activity_destroyed") } catch (_: Throwable) {}
    ws = null
    val r = room
    room = null
    if (r != null) {
      GlobalScope.launch(Dispatchers.IO) {
        try { r.disconnect() } catch (t: Throwable) {
          Log.w(TAG, "room.disconnect() threw: ${t.message}")
        }
      }
    }
    remoteRenderer?.release()
    super.onDestroy()
  }
}
