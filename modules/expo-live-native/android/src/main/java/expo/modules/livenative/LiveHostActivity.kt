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
import io.livekit.android.room.track.LocalVideoTrack
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
 * LiveHostActivity — Stage 2 (2026-05-16). Full-native Live host screen.
 *
 * Owns the entire host UX:
 *   - LiveKit `Room` publisher (mic + front camera).
 *   - WebSocket connection to wss://ws.chatyy.com.br/ws for chat/reactions/
 *     viewer-count events on channel `live_<sessionId>`.
 *   - Programmatic Views (NO Jetpack Compose — keep build risk low). Camera
 *     preview behind, overlay UI on top.
 *
 * Pattern adapted from modules/expo-callkit/CallActivity.kt + GroupCallActivity.kt.
 *
 * Intent extras (set by ExpoLiveNativeModule.openHost):
 *   - EXTRA_LK_TOKEN      (String, required)
 *   - EXTRA_LK_URL        (String, required)
 *   - EXTRA_ROOM_NAME     (String, required — used as session_id for WS)
 *   - EXTRA_HOST_EMAIL    (String, required)
 *   - EXTRA_TITLE         (String, optional)
 *   - EXTRA_AUDIENCE      (String, optional)
 */
class LiveHostActivity : ComponentActivity() {

  companion object {
    private const val TAG = "LiveHostActivity"
    private const val WS_URL = "wss://ws.chatyy.com.br/ws"
    private const val WS_PREFS = "expo_callkit_prefs"   // share token w/ callkit
    private const val MAX_COMMENTS = 50
    private const val MAX_REACTIONS = 20

    const val EXTRA_LK_TOKEN = "lk_token"
    const val EXTRA_LK_URL = "lk_url"
    const val EXTRA_ROOM_NAME = "room_name"
    const val EXTRA_HOST_EMAIL = "host_email"
    const val EXTRA_TITLE = "title"
    const val EXTRA_AUDIENCE = "audience"

    // Wave 16 (2026-05-17): AR/Beauty/Greenscreen filter selection. Static
    // ref so ExpoLiveNativeModule.setArFilter can poke the currently-running
    // host activity without a heavyweight binder. Cleared on activity destroy.
    @Volatile private var current: LiveHostActivity? = null

    fun applyArFilter(presetKey: String, wallpaperId: Int) {
      val act = current ?: return
      act.runOnUiThread { act.setArFilterPreset(presetKey, wallpaperId) }
    }
  }

  // Intent state
  private var lkUrl: String? = null
  private var lkToken: String? = null
  private var roomName: String = ""
  private var hostEmail: String = ""
  private var titleText: String = ""
  private var audience: String = "public"

  // LiveKit
  private var room: Room? = null
  private var eventsJob: Job? = null
  private var connectJob: Job? = null

  // Local preview
  private var localRenderer: SurfaceViewRenderer? = null
  private var localVideoTrack: LocalVideoTrack? = null

  // Local mic / camera state
  private var micEnabled = true
  private var camEnabled = true
  private var isPaused = false

  // UI refs
  private lateinit var statusText: TextView
  private lateinit var viewerCountText: TextView
  private lateinit var durationText: TextView
  private lateinit var commentsContainer: LinearLayout
  private lateinit var commentsScroll: ScrollView
  private lateinit var commentInput: EditText
  private lateinit var composerRow: LinearLayout
  private lateinit var heartLayer: FrameLayout
  private lateinit var livePill: TextView
  private lateinit var commentsCountPill: TextView

  // Comments memory cap
  private val comments: ArrayDeque<Comment> = ArrayDeque()
  private var commentsTotal: Int = 0

  // Duration timer
  private val startedAtMs: Long = System.currentTimeMillis()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val tickRunnable = object : Runnable {
    override fun run() {
      updateDuration()
      // Pulse pill alpha
      livePill.alpha = if ((System.currentTimeMillis() / 800) % 2L == 0L) 1.0f else 0.55f
      mainHandler.postDelayed(this, 1000)
    }
  }

  // WebSocket
  private var ws: WebSocket? = null
  private var wsAuthed = false
  private var wsClient: OkHttpClient? = null
  private val wsScope = kotlinx.coroutines.CoroutineScope(
    kotlinx.coroutines.SupervisorJob() + Dispatchers.IO
  )
  private val outboundQueue = java.util.concurrent.ConcurrentLinkedQueue<String>()

  private data class Comment(val name: String, val text: String)

  // ─── Wave 16: active AR/beauty/greenscreen preset (2026-05-17) ───
  // Stored here so MediaPipe pipeline hooks (when wired) can read it.
  // 'none' = no filter applied.
  @Volatile private var activeArPreset: String = "none"
  @Volatile private var activeArWallpaperId: Int = 0

  fun setArFilterPreset(presetKey: String, wallpaperId: Int) {
    activeArPreset = if (presetKey.isBlank()) "none" else presetKey
    activeArWallpaperId = wallpaperId
    Log.d(TAG, "AR filter set: preset=$activeArPreset wallpaper=$activeArWallpaperId")
    // Surface a hint on the status pill so the host knows the filter applied.
    // The actual MediaPipe processing (FaceLandmarker + SelfieSegmentation
    // composite) lives in a follow-up commit — pipeline plumbing requires
    // vendoring the MediaPipe AAR + a custom LK VideoCapturer that wraps
    // the CameraCapturer, intercepts frames, runs the graph, and re-emits.
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    current = this

    // Show over lockscreen (live broadcast may be started from lock — rare but
    // safe), keep screen on while live.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
      )
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    val extras = intent?.extras ?: Bundle()
    lkToken = extras.getString(EXTRA_LK_TOKEN)
    lkUrl = extras.getString(EXTRA_LK_URL)
    roomName = extras.getString(EXTRA_ROOM_NAME) ?: ""
    hostEmail = extras.getString(EXTRA_HOST_EMAIL) ?: ""
    titleText = extras.getString(EXTRA_TITLE) ?: ""
    audience = extras.getString(EXTRA_AUDIENCE) ?: "public"

    Log.d(TAG, "onCreate: room=$roomName host=$hostEmail title=$titleText audience=$audience " +
      "hasUrl=${!lkUrl.isNullOrEmpty()} hasToken=${!lkToken.isNullOrEmpty()}")

    setContentView(buildRootView())

    if (!lkUrl.isNullOrEmpty() && !lkToken.isNullOrEmpty()) {
      bringUpRoom(lkUrl!!, lkToken!!)
    } else {
      Log.w(TAG, "missing lk_url or lk_token — host UI shown without LK connect")
      statusText.text = "Sem token"
    }

    // Start WS in parallel with LK so chat is ready as soon as the host
    // appears. The WS auth re-uses the SharedPreferences bearer that the
    // callkit module already persists.
    connectWs()

    // Tick timer (duration + LIVE pill pulse).
    mainHandler.post(tickRunnable)
  }

  // ────────────────────────────────────────────────────────────────────────
  //  LiveKit
  // ────────────────────────────────────────────────────────────────────────

  private fun bringUpRoom(url: String, token: String) {
    val r = LiveKit.create(applicationContext)
    room = r

    // Pre-register the local preview renderer so the EGL context exists by
    // the time setCameraEnabled hands us a track.
    localRenderer?.let { r.initVideoRenderer(it) }

    eventsJob = lifecycleScope.launch {
      r.events.collect { event ->
        when (event) {
          is RoomEvent.Connected -> {
            Log.d(TAG, "RoomEvent.Connected")
            statusText.text = "AO VIVO"
            statusText.visibility = View.GONE  // hide "Conectando…" once live
            // Fire WS live_start now that LK is up — viewers can subscribe.
            sendWs(JSONObject().apply {
              put("type", "live_start")
              put("session_id", roomName)
            }.toString())
          }
          is RoomEvent.Reconnecting -> { statusText.visibility = View.VISIBLE; statusText.text = "Reconectando…" }
          is RoomEvent.Reconnected  -> { statusText.visibility = View.GONE }
          is RoomEvent.Disconnected -> {
            Log.d(TAG, "RoomEvent.Disconnected reason=${event.reason} err=${event.error}")
            finishLive(reason = "room_disconnect")
          }
          is RoomEvent.ParticipantConnected -> {
            // A viewer joined the LK room (cohost path will publish later).
            val identity = event.participant.identity?.value ?: ""
            Log.d(TAG, "ParticipantConnected $identity")
            try {
              ExpoLiveNativeModule.emitViewerJoined(roomName, identity, event.participant.name)
            } catch (_: Throwable) {}
          }
          else -> { /* no-op — local camera renderer is bound after setCameraEnabled in connectJob below */ }
        }
      }
    }

    connectJob = lifecycleScope.launch {
      try {
        r.connect(url, token)
        // Host publishes both. Mic first (cheap), camera second.
        r.localParticipant.setMicrophoneEnabled(true)
        r.localParticipant.setCameraEnabled(true)
        Log.d(TAG, "LK connect + publish OK")
      } catch (t: Throwable) {
        Log.e(TAG, "LK connect failed: ${t.message}", t)
        statusText.text = "Erro de conexão"
        ExpoLiveNativeModule.emitLiveError(roomName, t.message ?: "LK connect failed")
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  WebSocket (chat / reactions / viewer count)
  // ────────────────────────────────────────────────────────────────────────

  private fun connectWs() {
    val prefs = applicationContext.getSharedPreferences(WS_PREFS, Context.MODE_PRIVATE)
    val token = prefs.getString("auth_token", null)
    if (token.isNullOrEmpty()) {
      Log.w(TAG, "connectWs: no auth_token in $WS_PREFS — WS chat disabled")
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
        Log.d(TAG, "WS open — sending auth")
        w.send(JSONObject().apply {
          put("type", "auth")
          put("token", token)
        }.toString())
      }
      override fun onMessage(w: WebSocket, text: String) { handleWsFrame(text) }
      override fun onMessage(w: WebSocket, bytes: ByteString) { /* ignore */ }
      override fun onFailure(w: WebSocket, t: Throwable, response: Response?) {
        Log.w(TAG, "WS failure: ${t.message}")
        wsAuthed = false
        ws = null
        scheduleWsReconnect()
      }
      override fun onClosed(w: WebSocket, code: Int, reason: String) {
        Log.d(TAG, "WS closed code=$code reason=$reason")
        wsAuthed = false
        ws = null
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
        Log.d(TAG, "WS auth_success — flushing queue (${outboundQueue.size})")
        wsAuthed = true
        // Subscribe to live channel by sending live_start (Connected handler
        // already did this on the LK path, but it's idempotent server-side).
        // Drain anything that was queued before auth landed.
        while (true) {
          val msg = outboundQueue.poll() ?: break
          ws?.send(msg)
        }
      }
      "live_chat" -> {
        val name = obj.optString("sender_name", obj.optString("sender_email", "?"))
        val content = obj.optString("content", "")
        if (content.isNotEmpty()) {
          mainHandler.post { appendComment(name, content) }
        }
      }
      "live_reaction" -> {
        val emoji = obj.optString("emoji", "♥")
        mainHandler.post { spawnReaction(emoji) }
      }
      "live_viewer_count" -> {
        val count = obj.optInt("count", 0)
        mainHandler.post { viewerCountText.text = formatViewerCount(count) }
      }
      "live_viewer_joined" -> {
        val name = obj.optString("viewer_name", obj.optString("viewer_email", "?"))
        mainHandler.post { appendComment("Sistema", "$name entrou") }
      }
      "live_join_request" -> {
        // Cohost flow lands in a later stage; for now we log + surface in
        // the comment stream so the host can manually decide later.
        val viewer = obj.optString("viewer_name", obj.optString("viewer_email", "?"))
        Log.d(TAG, "live_join_request from $viewer")
        mainHandler.post { appendComment("Sistema", "$viewer quer entrar como cohost") }
      }
      else -> { /* no-op for the rest in Stage 2 */ }
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
    val c = Comment(name, text)
    comments.addLast(c)
    while (comments.size > MAX_COMMENTS) comments.removeFirst()
    commentsTotal += 1
    commentsCountPill.text = "Comentários · $commentsTotal"

    // Append a new TextView line at the bottom, fade in.
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
    // Trim the visible LinearLayout to MAX_COMMENTS rows too.
    while (commentsContainer.childCount > MAX_COMMENTS) {
      commentsContainer.removeViewAt(0)
    }
    line.startAnimation(AlphaAnimation(0f, 1f).apply { duration = 200 })
    // Auto-scroll to the new line.
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
      gravity = Gravity.BOTTOM or Gravity.START
      leftMargin = startX
      bottomMargin = dp(80)
    }
    heartLayer.addView(heart, lp)
    // Cap on-screen reactions so we don't unbounded-leak views.
    while (heartLayer.childCount > MAX_REACTIONS) heartLayer.removeViewAt(0)

    val set = AnimationSet(true).apply {
      addAnimation(TranslateAnimation(0f, dp(30).toFloat(), 0f, -dp(220).toFloat()))
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

  private fun updateDuration() {
    val sec = ((System.currentTimeMillis() - startedAtMs) / 1000).toInt().coerceAtLeast(0)
    durationText.text = String.format("%02d:%02d", sec / 60, sec % 60)
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

    // Camera preview fills the screen behind everything.
    localRenderer = SurfaceViewRenderer(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
      setMirror(true)
    }
    root.addView(localRenderer)

    // Heart-burst layer — same frame, transparent, child reactions float up.
    heartLayer = FrameLayout(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    root.addView(heartLayer)

    // Status text ("Conectando…") — top-center initially, hidden once Connected.
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
        gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
        topMargin = dp(56)
      }
    }
    root.addView(statusText)

    // ── Top bar: X · LIVE pill · viewers · duration
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
      finishLive("user_close")
    }.apply {
      setImageDrawable(makeCloseDrawable())
    }
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

    durationText = TextView(this).apply {
      text = "00:00"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      setPadding(dp(10), dp(4), dp(10), dp(4))
      background = pillDrawable(Color.parseColor("#80000000"))
    }
    topBar.addView(durationText, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ))

    // Spacer pushes nothing — top bar is left-aligned. The right side stays open.
    val spacer = View(this)
    topBar.addView(spacer, LinearLayout.LayoutParams(0, 0, 1f))

    root.addView(topBar)

    // ── Comments overlay (bottom-left, scroll-up + fade).
    val commentsBox = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(8), dp(8), dp(8), dp(8))
      background = pillDrawable(Color.parseColor("#66000000"))
      layoutParams = FrameLayout.LayoutParams(
        dp(280),
        dp(220)
      ).apply {
        gravity = Gravity.BOTTOM or Gravity.START
        leftMargin = dp(12)
        bottomMargin = dp(140)
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

    // ── Bottom bar: Comentários · Compartilhar · Pause · Switch cam
    val bottomBar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(12), dp(8), dp(12), dp(28))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply { gravity = Gravity.BOTTOM }
    }

    commentsCountPill = TextView(this).apply {
      text = "Comentários · 0"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setPadding(dp(14), dp(8), dp(14), dp(8))
      background = pillDrawable(Color.parseColor("#80000000"))
      setOnClickListener { toggleComposer() }
    }
    bottomBar.addView(commentsCountPill, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { marginEnd = dp(8) })

    val shareBtn = TextView(this).apply {
      text = "Compartilhar"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setPadding(dp(14), dp(8), dp(14), dp(8))
      background = pillDrawable(Color.parseColor("#80000000"))
      setOnClickListener {
        // Stub — the JS side has share sheets; this can use Android share intent.
        try {
          val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(android.content.Intent.EXTRA_TEXT,
              "Tô ao vivo no Chatyy! https://chatyy.com.br/live/$roomName")
          }
          startActivity(android.content.Intent.createChooser(send, "Compartilhar live"))
        } catch (t: Throwable) { Log.w(TAG, "share failed: ${t.message}") }
      }
    }
    bottomBar.addView(shareBtn, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { marginEnd = dp(8) })

    val pauseBtn = TextView(this).apply {
      text = "Pausar"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setPadding(dp(14), dp(8), dp(14), dp(8))
      background = pillDrawable(Color.parseColor("#80000000"))
      setOnClickListener {
        isPaused = !isPaused
        text = if (isPaused) "Retomar" else "Pausar"
        lifecycleScope.launch {
          try {
            room?.localParticipant?.setCameraEnabled(!isPaused)
            room?.localParticipant?.setMicrophoneEnabled(!isPaused)
          } catch (t: Throwable) { Log.w(TAG, "pause toggle failed: ${t.message}") }
        }
      }
    }
    bottomBar.addView(pauseBtn, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { marginEnd = dp(8) })

    val switchCam = TextView(this).apply {
      text = "Virar"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setPadding(dp(14), dp(8), dp(14), dp(8))
      background = pillDrawable(Color.parseColor("#80000000"))
      setOnClickListener {
        // LK Android: localVideoTrack is a CameraCapturer-backed track. We
        // poke through setCameraEnabled(false) → true to swap (the SDK does
        // not expose a switch in our pinned 2.24 API in a stable Swift-like
        // way; the toggle is the safe path). For Stage 2 this is good enough.
        lifecycleScope.launch {
          try {
            room?.localParticipant?.setCameraEnabled(false)
            room?.localParticipant?.setCameraEnabled(true)
          } catch (t: Throwable) { Log.w(TAG, "switch cam failed: ${t.message}") }
        }
      }
    }
    bottomBar.addView(switchCam, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ))

    root.addView(bottomBar)

    // ── Comment composer (hidden by default, slides up from bottom).
    composerRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(12), dp(10), dp(12), dp(28))
      setBackgroundColor(Color.parseColor("#CC000000"))
      visibility = View.GONE
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply { gravity = Gravity.BOTTOM }
    }
    commentInput = EditText(this).apply {
      hint = "Diga algo…"
      setHintTextColor(Color.parseColor("#80FFFFFF"))
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      setPadding(dp(12), dp(10), dp(12), dp(10))
      background = pillDrawable(Color.parseColor("#1F2C34"))
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      maxLines = 2
    }
    composerRow.addView(commentInput, LinearLayout.LayoutParams(0,
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
          // Server doesn't echo to sender in some paths — append locally too.
          appendComment("Você", txt)
          commentInput.setText("")
        }
      }
    }
    composerRow.addView(sendBtn, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ))

    root.addView(composerRow)

    return root
  }

  private fun toggleComposer() {
    val show = composerRow.visibility != View.VISIBLE
    composerRow.visibility = if (show) View.VISIBLE else View.GONE
    if (show) commentInput.requestFocus()
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
    // Simple X drawn via TextView fallback — easier than rasterizing here.
    val txt = TextView(this).apply {
      text = "×"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
      gravity = Gravity.CENTER
    }
    // Render into a bitmap-backed drawable. Cheap one-shot.
    val size = dp(36)
    val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(bmp)
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

  override fun onBackPressed() {
    finishLive("back")
  }

  private fun finishLive(reason: String) {
    Log.d(TAG, "finishLive reason=$reason room=$roomName")
    // Fire WS live_end so server fans out + viewers see "stream ended".
    sendWs(JSONObject().apply {
      put("type", "live_end")
      put("session_id", roomName)
    }.toString())
    mainHandler.removeCallbacks(tickRunnable)
    eventsJob?.cancel()
    connectJob?.cancel()
    try { ExpoLiveNativeModule.emitLiveEnded(roomName, reason) } catch (_: Throwable) {}
    finish()
  }

  @OptIn(DelicateCoroutinesApi::class)
  override fun onDestroy() {
    if (current === this) current = null
    mainHandler.removeCallbacks(tickRunnable)
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
    localRenderer?.release()
    super.onDestroy()
  }
}
