package expo.modules.callkit

// Stage 998/1000 — Compose mirror of iOS LiveBroadcastView.swift / LiveViewerView.swift
//
// LiveBroadcastActivity — Jetpack Compose host UI for /live (broadcaster side).
//
// Mirrors LiveBroadcastView.swift (~630 lines) + LiveBroadcastViewController.swift
// in a single Android Activity. Owns:
//   - The LiveKit Android Room (publisher role) — publishes camera + mic to the
//     `live_<sessionId>` LK room. Optional screen-share via the #1030 path runs
//     through LiveKitRoomHolder (no direct dep here).
//   - The OkHttp WebSocket connection that carries live_* events
//     (live_pin_comment, live_slow_mode, live_viewer_kicked, live_poll_*,
//     live_comment, live_reaction, live_cohost_approved) — talking to
//     wss://ws.chatyy.com.br/ws using the SharedPreferences bearer (same store
//     CallSignalWs uses: "expo_callkit_prefs" / "auth_token").
//   - LiveBroadcastSessionState — Compose-observable state via mutableStateOf.
//     Mutations dispatched onto Dispatchers.Main; Compose re-renders the
//     affected nodes only.
//   - Duration ticker (1 Hz) updating session.durationSeconds for the top-bar.
//   - Reaction GC timer that purges floating reactions after their animation
//     duration so the list doesn't grow unbounded.
//
// Intent extras (set by ExpoCallKitModule.startLiveBroadcast):
//   EXTRA_LIVE_SESSION_ID, EXTRA_LK_URL, EXTRA_LK_TOKEN,
//   EXTRA_HOST_EMAIL, EXTRA_HOST_NAME, EXTRA_HOST_AVATAR
//
// LiveKit Android 2.24.1 API surface used:
//   - LiveKit.create(applicationContext) -> Room
//   - room.events.collect { ... } (RoomEvent.{Connected, Reconnecting,
//     Reconnected, Disconnected, ParticipantConnected, TrackSubscribed,
//     ConnectionQualityChanged, DataReceived})
//   - room.connect(url, token) (suspend)
//   - room.localParticipant.setMicrophoneEnabled(true) (suspend)
//   - room.localParticipant.setCameraEnabled(true) (suspend)
//   - room.localParticipant.publishData(bytes) (data channel reactions/polls)
//   - room.disconnect() (suspend)
//   - VideoTrack rendered via TextureViewRenderer + room.initVideoRenderer
//
// Note on strings: hardcoded in Portuguese per task spec — no i18n.
// Note on icons: material-icons-extended already in build.gradle (~5MB).

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color as AGColor
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FlashOff
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import expo.modules.screenshare.LiveKitRoomHolder
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.renderer.SurfaceViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CoroutineScope
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
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

// MARK: - Palette ------------------------------------------------------------

private val BG_COLOR = Color(0xFF0B141A)
private val CHIP_COLOR = Color(0xFF1F2C34)
private val LIVE_RED = Color(0xFFDC2626)
private val SECONDARY = Color(0xFF8696A0)
private val GOLD = Color(0xFFFBBF24)
private val OVERLAY_BG = Color(0x59000000) // black 35%

// MARK: - Domain models -------------------------------------------------------

/** Pinned-comment snapshot. Mirrors LivePinnedComment in Swift. */
data class LivePinnedComment(
    val authorName: String,
    val text: String
)

/** One row in the chat overlay. */
data class LiveChatMessage(
    val id: String,
    val authorEmail: String,
    val authorName: String,
    val text: String,
    val isHost: Boolean = false,
    val timestampMs: Long
)

/** Floating reaction emoji on top of the broadcast. */
data class LiveFloatingReaction(
    val id: String,
    val emoji: String,
    val xOffsetDp: Float,
    val spawnedAtMs: Long
)

/** Cohost roster entry — appears in the mini-grid bottom-right. */
data class LiveCohost(
    val identity: String,
    val name: String,
    val videoTrack: VideoTrack? = null
)

/** Active poll snapshot. */
data class LivePoll(
    val id: String,
    val question: String,
    val options: List<LivePollOption>,
    val totalVotes: Int,
    val closed: Boolean
)

data class LivePollOption(
    val text: String,
    val votes: Int
)

/**
 * Compose-observable state holder. Each field is a mutableStateOf so a write
 * triggers recomposition of only the consuming subtree. Equivalent of the
 * Swift @Published-annotated LiveBroadcastSessionState.
 */
class LiveBroadcastSessionState {
    var localVideoTrack by mutableStateOf<LocalVideoTrack?>(null)
    var cameraStatus by mutableStateOf("Conectando à câmera...")
    var viewerCount by mutableIntStateOf(0)
    var durationSeconds by mutableIntStateOf(0)
    var connectionQuality by mutableStateOf("good")
    var pinnedComment by mutableStateOf<LivePinnedComment?>(null)
    var slowModeSeconds by mutableIntStateOf(0)
    val chatMessages = mutableStateListOf<LiveChatMessage>()
    val floatingReactions = mutableStateListOf<LiveFloatingReaction>()
    var activePoll by mutableStateOf<LivePoll?>(null)
    val cohosts = mutableStateListOf<LiveCohost>()
    var flashOn by mutableStateOf(false)
    var ended by mutableStateOf(false)
    val viewers = mutableStateListOf<LiveViewerRow>()
    /** Room reference exposed so AndroidView factories can call
     *  initVideoRenderer(view) before binding a track. Not a Compose state
     *  field — never reassigned after activity onCreate, so no re-render. */
    var roomRef: Room? = null
}

/** Viewer row used by the settings bottom-sheet viewer list. */
data class LiveViewerRow(
    val email: String,
    val name: String
)

// MARK: - Activity -----------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
class LiveBroadcastActivity : ComponentActivity() {

    companion object {
        private const val TAG = "LiveBroadcastActivity"
        const val ACTION_CLOSE = "expo.modules.callkit.CLOSE_LIVE_BROADCAST"

        const val EXTRA_LIVE_SESSION_ID = "live_session_id"
        const val EXTRA_LK_URL = "lk_url"
        const val EXTRA_LK_TOKEN = "lk_token"
        const val EXTRA_HOST_EMAIL = "host_email"
        const val EXTRA_HOST_NAME = "host_name"
        const val EXTRA_HOST_AVATAR = "host_avatar"

        private const val WS_URL = "wss://ws.chatyy.com.br/ws"
        private const val PREFS_NAME = "expo_callkit_prefs"
        private const val MAX_RECONNECT = 3
        private val RECONNECT_BACKOFF_MS = longArrayOf(1_000L, 2_000L, 4_000L)
        private const val WS_PING_SEC = 25L
        private const val REACTION_TTL_MS = 2_800L
    }

    private var liveSessionId: String = ""
    private var lkUrl: String = ""
    private var lkToken: String = ""
    private var hostEmail: String = ""
    private var hostName: String = ""
    private var hostAvatar: String? = null

    private val session = LiveBroadcastSessionState()

    // LiveKit room + jobs ------------------------------------------------------
    private var room: Room? = null
    private var eventsJob: Job? = null
    private var connectJob: Job? = null
    private var lkReconnectAttempts = 0

    // WS state ----------------------------------------------------------------
    private var ws: WebSocket? = null
    private var wsAuthed = false
    private var wsReconnectAttempts = 0
    private var okHttp: OkHttpClient? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    // Tickers -----------------------------------------------------------------
    private var durationJob: Job? = null
    private var reactionGcJob: Job? = null
    private val startedAtMs: Long = System.currentTimeMillis()

    // Front/back camera tracking (LK doesn't expose a flip directly; we track
    // and re-publish on toggle). Stub: facing flag only.
    private var cameraFront = true

    // Close-by-broadcast receiver (host kicked from elsewhere, etc.) ---------
    private val closeReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            Log.d(TAG, "closeReceiver — finishing")
            finishLive(reason = "close_broadcast")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Show over lockscreen + keep screen on for the duration of the live.
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
        liveSessionId = extras.getString(EXTRA_LIVE_SESSION_ID) ?: ""
        lkUrl = extras.getString(EXTRA_LK_URL) ?: ""
        lkToken = extras.getString(EXTRA_LK_TOKEN) ?: ""
        hostEmail = extras.getString(EXTRA_HOST_EMAIL) ?: ""
        hostName = extras.getString(EXTRA_HOST_NAME) ?: ""
        hostAvatar = extras.getString(EXTRA_HOST_AVATAR)

        Log.d(
            TAG,
            "onCreate: session=$liveSessionId host=$hostName " +
                "hasUrl=${lkUrl.isNotEmpty()} hasToken=${lkToken.isNotEmpty()}"
        )

        setContent {
            MaterialTheme {
                LiveBroadcastScreen(
                    session = session,
                    hostName = hostName,
                    hostEmail = hostEmail,
                    hostAvatar = hostAvatar,
                    onClose = { handleClose(userInitiated = true) },
                    onFlipCamera = { flipCamera() },
                    onToggleFlash = { toggleFlash() },
                    onOpenFilters = { /* stub: filters sheet, future stage */ },
                    onOpenSettings = { /* opened by sheet local state */ },
                    onEndLive = { confirmEndLive() },
                    onSendComment = { txt -> sendComment(txt) },
                    onSendReaction = { emoji -> sendReaction(emoji) },
                    onOpenPollCreator = { /* opened by modal local state */ },
                    onTapPoll = { /* poll details — modal local state */ },
                    onOpenViewerList = { /* opens settings sheet w/ viewers */ },
                    onChangeSlowMode = { secs -> changeSlowMode(secs) },
                    onRemoveViewer = { email -> removeViewer(email) },
                    onBlockViewer = { email -> blockViewer(email) },
                    onCreatePoll = { question, opts -> createPoll(question, opts) }
                )
            }
        }

        // Listen for external close (e.g., server-side terminate).
        val filter = IntentFilter(ACTION_CLOSE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(closeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(closeReceiver, filter)
        }

        // Bring up duration ticker BEFORE LK connect so the top bar shows the
        // elapsed time even if LK takes a few seconds to negotiate.
        startDurationTicker()
        startReactionGc()

        // Connect LK + WS.
        if (lkUrl.isNotEmpty() && lkToken.isNotEmpty()) {
            connectLiveKit()
        } else {
            session.cameraStatus = "Erro: credenciais ausentes"
            Log.w(TAG, "missing lkUrl/lkToken — skipping LK connect")
        }
        connectWs()
    }

    // MARK: - LiveKit ---------------------------------------------------------

    private fun connectLiveKit() {
        val r = LiveKit.create(applicationContext)
        room = r
        session.roomRef = r
        // Stage #1030 hook — let ScreenShareService publish into this room
        // once the user grants MediaProjection.
        LiveKitRoomHolder.set(r)

        eventsJob = lifecycleScope.launch {
            r.events.collect { event ->
                when (event) {
                    is RoomEvent.Connected -> {
                        Log.d(TAG, "RoomEvent.Connected")
                        session.cameraStatus = "Câmera ativa"
                        lkReconnectAttempts = 0
                    }
                    is RoomEvent.Reconnecting -> {
                        Log.d(TAG, "RoomEvent.Reconnecting")
                        session.cameraStatus = "Reconectando..."
                    }
                    is RoomEvent.Reconnected -> {
                        Log.d(TAG, "RoomEvent.Reconnected")
                        session.cameraStatus = "Câmera ativa"
                    }
                    is RoomEvent.Disconnected -> {
                        Log.d(TAG, "RoomEvent.Disconnected reason=${event.reason}")
                        scheduleLkReconnect()
                    }
                    is RoomEvent.ParticipantConnected -> {
                        Log.d(TAG, "ParticipantConnected ${event.participant.identity}")
                        session.viewerCount = (session.viewerCount + 1)
                            .coerceAtLeast(r.remoteParticipants.size)
                    }
                    is RoomEvent.ParticipantDisconnected -> {
                        session.viewerCount = (session.viewerCount - 1).coerceAtLeast(0)
                        // Remove cohost if their tile was up.
                        val id = event.participant.identity?.value ?: ""
                        session.cohosts.removeAll { it.identity == id }
                    }
                    is RoomEvent.TrackSubscribed -> {
                        val t = event.track
                        if (t is VideoTrack) {
                            // Could be a cohost video; map to cohost grid.
                            val id = event.participant.identity?.value ?: ""
                            val idx = session.cohosts.indexOfFirst { it.identity == id }
                            if (idx >= 0) {
                                session.cohosts[idx] = session.cohosts[idx].copy(videoTrack = t)
                            }
                        }
                    }
                    // [2026-05-18] LiveKit 2.x merged LocalTrackPublished into
                    // TrackPublished — gate on participant type.
                    is RoomEvent.TrackPublished -> if (event.participant is LocalParticipant) {
                        // Camera track just landed — push it into Compose state so
                        // CameraFill swaps from the placeholder avatar to the
                        // SurfaceView renderer.
                        val pubTrack = event.publication.track
                        if (pubTrack is LocalVideoTrack) {
                            session.localVideoTrack = pubTrack
                            session.cameraStatus = "Câmera ativa"
                        }
                    }
                    is RoomEvent.ConnectionQualityChanged -> {
                        // LK enum -> string for the bars indicator.
                        val q = event.quality.name.lowercase()
                        session.connectionQuality = when (q) {
                            "excellent" -> "excellent"
                            "good" -> "good"
                            "poor" -> "poor"
                            "lost" -> "lost"
                            else -> "good"
                        }
                    }
                    is RoomEvent.DataReceived -> {
                        // Reactions + polls broadcast over the LK data channel.
                        handleLkDataChannel(event.data)
                    }
                    else -> { /* no-op for the rest */ }
                }
            }
        }

        connectJob = lifecycleScope.launch {
            try {
                r.connect(lkUrl, lkToken)
                r.localParticipant.setMicrophoneEnabled(true)
                r.localParticipant.setCameraEnabled(true)
                // The local camera track surfaces via RoomEvent.LocalTrackPublished
                // (handled above) — we don't try to read it off localParticipant
                // synchronously because the LK 2.x API uses a deferred publish
                // flow under the hood (capture device → encoder → SDP renegotiate
                // → onLocalTrackPublished). Mirrors CallActivity's pattern.
                Log.d(TAG, "LK connect + publish OK")
            } catch (t: Throwable) {
                Log.e(TAG, "LK connect failed: ${t.message}", t)
                session.cameraStatus = "Falha ao conectar"
                scheduleLkReconnect()
            }
        }
    }

    private fun scheduleLkReconnect() {
        if (lkReconnectAttempts >= MAX_RECONNECT) {
            Log.w(TAG, "LK reconnect: max attempts reached")
            return
        }
        val backoff = RECONNECT_BACKOFF_MS[min(lkReconnectAttempts, RECONNECT_BACKOFF_MS.lastIndex)]
        lkReconnectAttempts++
        Log.d(TAG, "LK reconnect: attempt $lkReconnectAttempts in ${backoff}ms")
        mainHandler.postDelayed({ connectLiveKit() }, backoff)
    }

    private fun handleLkDataChannel(bytes: ByteArray) {
        try {
            val json = JSONObject(String(bytes, Charsets.UTF_8))
            when (json.optString("type")) {
                "reaction" -> {
                    val emoji = json.optString("emoji", "❤️")
                    spawnFloatingReaction(emoji)
                }
                "poll_voted" -> {
                    // Re-broadcast poll updates over WS — LK data is a fast path.
                    val pollId = json.optString("poll_id")
                    val pickedIdx = json.optInt("option_idx", -1)
                    bumpPollLocal(pollId, pickedIdx)
                }
                else -> {}
            }
        } catch (t: Throwable) {
            Log.w(TAG, "lk data parse fail: ${t.message}")
        }
    }

    // MARK: - WebSocket -------------------------------------------------------

    private fun connectWs() {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val token = prefs.getString("auth_token", null)
        if (token.isNullOrEmpty()) {
            Log.w(TAG, "WS: no auth_token — skipping (JS fallback delivers)")
            return
        }

        val client = okHttp ?: OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .pingInterval(WS_PING_SEC, TimeUnit.SECONDS)
            .build()
            .also { okHttp = it }

        val req = Request.Builder().url(WS_URL).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                Log.d(TAG, "WS open — auth")
                val auth = JSONObject().apply {
                    put("type", "auth")
                    put("token", token)
                }
                ws.send(auth.toString())
            }

            override fun onMessage(ws: WebSocket, text: String) {
                runOnUiThread { handleWsFrame(text) }
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) { /* unused */ }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "WS failure: ${t.message}")
                wsAuthed = false
                scheduleWsReconnect()
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WS closed: $code $reason")
                wsAuthed = false
                scheduleWsReconnect()
            }
        }
        ws = client.newWebSocket(req, listener)
    }

    private fun scheduleWsReconnect() {
        if (wsReconnectAttempts >= MAX_RECONNECT) {
            Log.w(TAG, "WS reconnect: max attempts reached")
            return
        }
        val backoff = RECONNECT_BACKOFF_MS[min(wsReconnectAttempts, RECONNECT_BACKOFF_MS.lastIndex)]
        wsReconnectAttempts++
        mainHandler.postDelayed({ connectWs() }, backoff)
    }

    private fun handleWsFrame(text: String) {
        try {
            val json = JSONObject(text)
            when (json.optString("type")) {
                "auth_success" -> {
                    wsAuthed = true
                    wsReconnectAttempts = 0
                    // Subscribe to the live channel so the server forwards
                    // live_* events to us.
                    val sub = JSONObject().apply {
                        put("type", "live_subscribe")
                        put("live_session_id", liveSessionId)
                    }
                    ws?.send(sub.toString())
                }
                "live_pin_comment" -> {
                    val author = json.optString("author_name")
                    val txt = json.optString("text")
                    session.pinnedComment = if (txt.isEmpty()) null
                    else LivePinnedComment(author, txt)
                }
                "live_slow_mode" -> {
                    session.slowModeSeconds = json.optInt("seconds", 0)
                }
                "live_viewer_kicked" -> {
                    // Host: just refresh viewer list count.
                    session.viewerCount = (session.viewerCount - 1).coerceAtLeast(0)
                    val email = json.optString("email")
                    session.viewers.removeAll { it.email == email }
                }
                "live_poll_created" -> {
                    val id = json.optString("poll_id")
                    val q = json.optString("question")
                    val optsJson = json.optJSONArray("options")
                    val opts = mutableListOf<LivePollOption>()
                    if (optsJson != null) for (i in 0 until optsJson.length()) {
                        opts.add(LivePollOption(optsJson.optString(i), 0))
                    }
                    session.activePoll = LivePoll(id, q, opts, 0, false)
                }
                "live_poll_voted" -> {
                    val id = json.optString("poll_id")
                    val idx = json.optInt("option_idx", -1)
                    bumpPollLocal(id, idx)
                }
                "live_poll_closed" -> {
                    session.activePoll = session.activePoll?.copy(closed = true)
                }
                "live_comment" -> {
                    val mid = json.optString("msg_id", UUID.randomUUID().toString())
                    val email = json.optString("author_email")
                    val name = json.optString("author_name")
                    val body = json.optString("text")
                    val isHost = json.optBoolean("is_host", false)
                    session.chatMessages.add(
                        LiveChatMessage(
                            id = mid, authorEmail = email, authorName = name,
                            text = body, isHost = isHost,
                            timestampMs = System.currentTimeMillis()
                        )
                    )
                    // Cap chat tail in memory at 200 — UI shows last 6.
                    while (session.chatMessages.size > 200) session.chatMessages.removeAt(0)
                }
                "live_reaction" -> {
                    val emoji = json.optString("emoji", "❤️")
                    spawnFloatingReaction(emoji)
                }
                "live_cohost_approved" -> {
                    val email = json.optString("email")
                    val name = json.optString("name")
                    if (session.cohosts.none { it.identity == email }) {
                        session.cohosts.add(LiveCohost(identity = email, name = name))
                    }
                }
                "live_viewer_joined" -> {
                    val email = json.optString("email")
                    val name = json.optString("name")
                    if (session.viewers.none { it.email == email }) {
                        session.viewers.add(LiveViewerRow(email, name))
                    }
                }
                else -> { /* unknown — ignore */ }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "WS frame parse fail: ${t.message}")
        }
    }

    private fun wsSend(payload: JSONObject) {
        val ws0 = ws
        if (ws0 == null || !wsAuthed) {
            Log.d(TAG, "wsSend: not authed yet — dropping ${payload.optString("type")}")
            return
        }
        ws0.send(payload.toString())
    }

    // MARK: - User actions ----------------------------------------------------

    private fun flipCamera() {
        // Stub: re-flip flag, future stage swaps the LK camera capturer.
        cameraFront = !cameraFront
        Log.d(TAG, "flipCamera -> front=$cameraFront")
        // LK Android 2.x: room.localParticipant.flipCamera() exists in some
        // versions; we fall back to setCameraEnabled(false) → (true) which
        // re-selects the default device. Keep simple stub here.
    }

    private fun toggleFlash() {
        session.flashOn = !session.flashOn
        Log.d(TAG, "toggleFlash -> ${session.flashOn}")
        // Stub: Camera2 flash control would attach here. LK's video source
        // exposes the underlying camera, but the API differs by version —
        // future stage wires the actual torch toggle.
    }

    private fun confirmEndLive() {
        // No native AlertDialog in Compose — keep flow simple: end immediately,
        // mirroring the iOS confirm (which still allows quick re-tap via
        // gesture). Future stage adds a Material3 AlertDialog wrap.
        endLive()
    }

    private fun endLive() {
        Log.d(TAG, "endLive")
        session.ended = true
        wsSend(JSONObject().apply {
            put("type", "live_end")
            put("live_session_id", liveSessionId)
        })
        finishLive(reason = "host_end")
    }

    private fun sendComment(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        wsSend(JSONObject().apply {
            put("type", "live_comment")
            put("live_session_id", liveSessionId)
            put("text", trimmed)
        })
    }

    private fun sendReaction(emoji: String) {
        // Local optimistic burst.
        spawnFloatingReaction(emoji)
        // Broadcast over LK data channel (low-latency) + WS (durable).
        try {
            val payload = JSONObject().apply {
                put("type", "reaction")
                put("emoji", emoji)
            }
            val bytes = payload.toString().toByteArray(Charsets.UTF_8)
            lifecycleScope.launch {
                try { room?.localParticipant?.publishData(bytes) } catch (_: Throwable) {}
            }
        } catch (_: Throwable) {}
        wsSend(JSONObject().apply {
            put("type", "live_reaction")
            put("live_session_id", liveSessionId)
            put("emoji", emoji)
        })
    }

    private fun spawnFloatingReaction(emoji: String) {
        val x = Random.nextFloat() * 200f - 100f
        session.floatingReactions.add(
            LiveFloatingReaction(
                id = UUID.randomUUID().toString(),
                emoji = emoji,
                xOffsetDp = x,
                spawnedAtMs = System.currentTimeMillis()
            )
        )
        if (session.floatingReactions.size > 30) session.floatingReactions.removeAt(0)
    }

    private fun changeSlowMode(secs: Int) {
        session.slowModeSeconds = secs
        wsSend(JSONObject().apply {
            put("type", "live_slow_mode")
            put("live_session_id", liveSessionId)
            put("seconds", secs)
        })
    }

    private fun removeViewer(email: String) {
        wsSend(JSONObject().apply {
            put("type", "live_viewer_kick")
            put("live_session_id", liveSessionId)
            put("email", email)
        })
        session.viewers.removeAll { it.email == email }
    }

    private fun blockViewer(email: String) {
        wsSend(JSONObject().apply {
            put("type", "live_viewer_block")
            put("live_session_id", liveSessionId)
            put("email", email)
        })
        session.viewers.removeAll { it.email == email }
    }

    private fun createPoll(question: String, options: List<String>) {
        wsSend(JSONObject().apply {
            put("type", "live_poll_create")
            put("live_session_id", liveSessionId)
            put("question", question)
            put("options", options)
        })
        // Optimistic local state — server will echo with a real poll_id.
        session.activePoll = LivePoll(
            id = "pending_${System.currentTimeMillis()}",
            question = question,
            options = options.map { LivePollOption(it, 0) },
            totalVotes = 0,
            closed = false
        )
    }

    private fun bumpPollLocal(pollId: String, idx: Int) {
        val poll = session.activePoll ?: return
        if (poll.id != pollId && !poll.id.startsWith("pending_")) return
        if (idx < 0 || idx >= poll.options.size) return
        val newOpts = poll.options.toMutableList()
        val cur = newOpts[idx]
        newOpts[idx] = cur.copy(votes = cur.votes + 1)
        session.activePoll = poll.copy(options = newOpts, totalVotes = poll.totalVotes + 1)
    }

    private fun handleClose(userInitiated: Boolean) {
        if (userInitiated) confirmEndLive() else finishLive(reason = "external")
    }

    // MARK: - Tickers ---------------------------------------------------------

    private fun startDurationTicker() {
        durationJob = lifecycleScope.launch {
            while (!session.ended) {
                val now = System.currentTimeMillis()
                session.durationSeconds = ((now - startedAtMs) / 1000L).toInt()
                delay(1000L)
            }
        }
    }

    private fun startReactionGc() {
        reactionGcJob = lifecycleScope.launch {
            while (!session.ended) {
                val now = System.currentTimeMillis()
                session.floatingReactions.removeAll { now - it.spawnedAtMs > REACTION_TTL_MS }
                delay(400L)
            }
        }
    }

    // MARK: - Tear down ------------------------------------------------------

    private fun finishLive(reason: String) {
        Log.d(TAG, "finishLive reason=$reason")
        session.ended = true
        durationJob?.cancel()
        reactionGcJob?.cancel()
        try { ws?.close(1000, "live_end") } catch (_: Throwable) {}
        ws = null
        ExpoCallKitModule.emitCallEnded(liveSessionId)
        finish()
    }

    @OptIn(DelicateCoroutinesApi::class)
    override fun onDestroy() {
        try { unregisterReceiver(closeReceiver) } catch (_: Exception) {}
        durationJob?.cancel()
        reactionGcJob?.cancel()
        eventsJob?.cancel()
        connectJob?.cancel()
        val r = room
        room = null
        if (r != null) {
            GlobalScope.launch(Dispatchers.IO) {
                try { r.disconnect() } catch (t: Throwable) {
                    Log.w(TAG, "room.disconnect threw: ${t.message}")
                }
            }
        }
        LiveKitRoomHolder.clear()
        try { ws?.close(1000, "destroy") } catch (_: Throwable) {}
        super.onDestroy()
    }

    override fun onBackPressed() {
        // Ignore back press during live — host must tap close X / END LIVE.
        Log.d(TAG, "back press ignored — use END LIVE")
    }
}

// ============================================================================
// Composable tree
// ============================================================================

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LiveBroadcastScreen(
    session: LiveBroadcastSessionState,
    hostName: String,
    hostEmail: String,
    hostAvatar: String?,
    onClose: () -> Unit,
    onFlipCamera: () -> Unit,
    onToggleFlash: () -> Unit,
    onOpenFilters: () -> Unit,
    onOpenSettings: () -> Unit,
    onEndLive: () -> Unit,
    onSendComment: (String) -> Unit,
    onSendReaction: (String) -> Unit,
    onOpenPollCreator: () -> Unit,
    onTapPoll: () -> Unit,
    onOpenViewerList: () -> Unit,
    onChangeSlowMode: (Int) -> Unit,
    onRemoveViewer: (String) -> Unit,
    onBlockViewer: (String) -> Unit,
    onCreatePoll: (String, List<String>) -> Unit,
) {
    var showSettings by remember { mutableStateOf(false) }
    var showPollCreator by remember { mutableStateOf(false) }
    var showPollDetails by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(BG_COLOR)
    ) {
        // 1. Camera fill behind everything.
        CameraFill(session = session, hostName = hostName, hostEmail = hostEmail)

        // 2. Top bar.
        Column(modifier = Modifier.fillMaxWidth()) {
            TopBar(
                session = session,
                hostName = hostName,
                hostEmail = hostEmail,
                onClose = onClose,
                onOpenViewerList = {
                    showSettings = true
                    onOpenViewerList()
                }
            )
            PinnedCommentChip(session = session)
        }

        // 3. Right rail.
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(top = 120.dp),
            horizontalArrangement = Arrangement.End
        ) {
            RightRail(
                session = session,
                onFlipCamera = onFlipCamera,
                onToggleFlash = onToggleFlash,
                onOpenFilters = onOpenFilters,
                onOpenSettings = {
                    showSettings = true
                    onOpenSettings()
                },
                onOpenPollCreator = {
                    showPollCreator = true
                    onOpenPollCreator()
                },
                onEndLive = onEndLive
            )
            Spacer(Modifier.width(12.dp))
        }

        // 4. Bottom column with cohost grid + active poll chip + slow mode +
        // chat + composer.
        Column(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.navigationBars)
                .imePadding(),
            verticalArrangement = Arrangement.Bottom
        ) {
            Spacer(Modifier.weight(1f))
            CohostStrip(session = session)
            ActivePollChip(session = session, onTapPoll = {
                showPollDetails = true
                onTapPoll()
            })
            SlowModeIndicator(session = session)
            ChatOverlay(session = session)
            BottomBar(
                onSendComment = onSendComment,
                onSendReaction = onSendReaction
            )
        }

        // 5. Floating reaction burst layer — non-interactive, top of stack.
        ReactionBurst(session = session)
    }

    // Settings bottom sheet — slow mode + viewer list.
    if (showSettings) {
        SettingsSheet(
            session = session,
            onDismiss = { showSettings = false },
            onChangeSlowMode = onChangeSlowMode,
            onRemoveViewer = onRemoveViewer,
            onBlockViewer = onBlockViewer
        )
    }

    if (showPollCreator) {
        PollCreatorSheet(
            onDismiss = { showPollCreator = false },
            onCreate = { q, opts ->
                onCreatePoll(q, opts)
                showPollCreator = false
            }
        )
    }

    if (showPollDetails && session.activePoll != null) {
        PollDetailsSheet(
            poll = session.activePoll!!,
            onDismiss = { showPollDetails = false }
        )
    }
}

// ---------- Camera fill ----------

@Composable
private fun CameraFill(
    session: LiveBroadcastSessionState,
    hostName: String,
    hostEmail: String
) {
    val track = session.localVideoTrack
    val roomRef = session.roomRef
    if (track != null) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                SurfaceViewRenderer(ctx).apply {
                    setBackgroundColor(AGColor.BLACK)
                    layoutParams = FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                    // EGL init must come from the Room so libwebrtc shares the
                    // SurfaceTextureHelper context. addRenderer below silently
                    // fails on an un-initialised renderer.
                    roomRef?.initVideoRenderer(this)
                }
            },
            update = { renderer ->
                try { track.addRenderer(renderer) } catch (_: Throwable) {}
            }
        )
    } else {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(BG_COLOR),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                AvatarCircle(name = hostName, email = hostEmail, size = 96.dp)
                Spacer(Modifier.height(12.dp))
                Text(
                    session.cameraStatus,
                    color = SECONDARY,
                    fontSize = 14.sp
                )
            }
        }
    }
}

// ---------- Top bar ----------

@Composable
private fun TopBar(
    session: LiveBroadcastSessionState,
    hostName: String,
    hostEmail: String,
    onClose: () -> Unit,
    onOpenViewerList: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                Brush.verticalGradient(
                    colors = listOf(Color.Black.copy(alpha = 0.6f), Color.Transparent)
                )
            )
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        AvatarCircle(name = hostName, email = hostEmail, size = 40.dp)
        Column(
            modifier = Modifier
                .weight(1f)
                .clickable { onOpenViewerList() }
        ) {
            Text(
                hostName.ifEmpty { hostEmail },
                color = Color.White,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = Icons.Filled.Visibility,
                    contentDescription = null,
                    tint = Color.White.copy(alpha = 0.85f),
                    modifier = Modifier.size(11.dp)
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    "${session.viewerCount}",
                    color = Color.White.copy(alpha = 0.85f),
                    fontSize = 12.sp
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    "·",
                    color = Color.White.copy(alpha = 0.6f),
                    fontSize = 12.sp
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    formatDuration(session.durationSeconds),
                    color = Color.White.copy(alpha = 0.85f),
                    fontSize = 12.sp
                )
            }
        }
        LiveBadge()
        ConnectionBars(quality = session.connectionQuality, hideExcellent = false)
        IconCircleButton(
            iconVec = Icons.Filled.Close,
            size = 32.dp,
            onClick = onClose
        )
    }
}

/** Pulsing red AO VIVO pill. */
@Composable
private fun LiveBadge() {
    val infinite = rememberInfiniteTransition(label = "livePulse")
    val pulse by infinite.animateFloat(
        initialValue = 1f,
        targetValue = 0.4f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 800),
            repeatMode = RepeatMode.Reverse
        ),
        label = "livePulseValue"
    )
    Row(
        modifier = Modifier
            .background(LIVE_RED, CircleShape)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Box(
            Modifier
                .size(6.dp)
                .background(Color.White.copy(alpha = pulse), CircleShape)
        )
        Text(
            "AO VIVO",
            color = Color.White,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold
        )
    }
}

@Composable
private fun ConnectionBars(quality: String, hideExcellent: Boolean) {
    val (bars, color, hide) = when (quality) {
        "excellent" -> Triple(3, Color(0xFF4ADE80), hideExcellent)
        "good" -> Triple(2, Color(0xFF4ADE80), false)
        "poor" -> Triple(1, Color(0xFFFBBF24), false)
        "lost" -> Triple(0, Color(0xFFEF4444), false)
        else -> Triple(2, Color(0xFF4ADE80), false)
    }
    if (hide) return
    Row(
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        modifier = Modifier.padding(horizontal = 4.dp)
    ) {
        for (i in 0..2) {
            val h: Dp = (6 + i * 4).dp
            Box(
                Modifier
                    .width(3.dp)
                    .height(h)
                    .background(
                        if (i < bars) color else Color.White.copy(alpha = 0.25f),
                        RoundedCornerShape(1.dp)
                    )
            )
        }
    }
}

@Composable
private fun IconCircleButton(
    iconVec: androidx.compose.ui.graphics.vector.ImageVector,
    size: Dp,
    bg: Color = Color.Black.copy(alpha = 0.5f),
    onClick: () -> Unit
) {
    Box(
        modifier = Modifier
            .size(size)
            .background(bg, CircleShape)
            .clickable { onClick() },
        contentAlignment = Alignment.Center
    ) {
        Icon(
            imageVector = iconVec,
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(size * 0.45f)
        )
    }
}

// ---------- Pinned comment ----------

@Composable
private fun PinnedCommentChip(session: LiveBroadcastSessionState) {
    AnimatedVisibility(
        visible = session.pinnedComment != null,
        enter = fadeIn(),
        exit = fadeOut()
    ) {
        val pinned = session.pinnedComment ?: return@AnimatedVisibility
        Row(
            modifier = Modifier
                .padding(horizontal = 60.dp, vertical = 6.dp)
                .background(OVERLAY_BG, RoundedCornerShape(10.dp))
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Icon(
                Icons.Filled.PushPin,
                contentDescription = null,
                tint = Color.White,
                modifier = Modifier.size(11.dp)
            )
            Column {
                Text(
                    pinned.authorName,
                    color = Color.White.copy(alpha = 0.9f),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    pinned.text,
                    color = Color.White,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

// ---------- Right rail ----------

@Composable
private fun RightRail(
    session: LiveBroadcastSessionState,
    onFlipCamera: () -> Unit,
    onToggleFlash: () -> Unit,
    onOpenFilters: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenPollCreator: () -> Unit,
    onEndLive: () -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(14.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        RailButton(
            iconVec = Icons.Filled.Cameraswitch,
            label = "Câmera",
            onClick = onFlipCamera
        )
        RailButton(
            iconVec = if (session.flashOn) Icons.Filled.Bolt else Icons.Filled.FlashOff,
            label = "Flash",
            tint = if (session.flashOn) GOLD else Color.White,
            onClick = onToggleFlash
        )
        RailButton(
            iconVec = Icons.Filled.Tune,
            label = "Filtros",
            onClick = onOpenFilters
        )
        RailButton(
            iconVec = Icons.Filled.Settings,
            label = "Mais",
            onClick = onOpenSettings
        )
        RailButton(
            iconVec = Icons.Filled.BarChart,
            label = "Enquete",
            onClick = onOpenPollCreator
        )
        // END LIVE — prominent red.
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .background(LIVE_RED, CircleShape)
                    .clickable { onEndLive() },
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    Icons.Filled.Stop,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(20.dp)
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "Encerrar",
                color = Color.White,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

@Composable
private fun RailButton(
    iconVec: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tint: Color = Color.White,
    onClick: () -> Unit
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .background(Color.Black.copy(alpha = 0.45f), CircleShape)
                .clickable { onClick() },
            contentAlignment = Alignment.Center
        ) {
            Icon(
                iconVec,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(20.dp)
            )
        }
        Spacer(Modifier.height(4.dp))
        Text(
            label,
            color = Color.White.copy(alpha = 0.85f),
            fontSize = 10.sp,
            fontWeight = FontWeight.Medium
        )
    }
}

// ---------- Cohost grid (bottom-right mini) ----------

@Composable
private fun CohostStrip(session: LiveBroadcastSessionState) {
    // Multi-cam grid (P0 — cap raised to 4 in 2026-05-17). Adaptive layout:
    //   0   → nothing
    //   1   → bottom-right mini PiP (legacy)
    //   2   → side-by-side split
    //   3-4 → 2×2 grid
    // Backend cap is 4; we still take prefix(4) so a server race doesn't
    // crash the column.
    val cohosts = session.cohosts.take(4)
    if (cohosts.isEmpty()) return
    when (cohosts.size) {
        1 -> {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Spacer(Modifier.weight(1f))
                CohostTile(cohost = cohosts[0], roomRef = session.roomRef,
                    width = 110.dp, height = 150.dp)
            }
        }
        2 -> {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                for (ch in cohosts) {
                    Box(modifier = Modifier.weight(1f)) {
                        CohostTile(cohost = ch, roomRef = session.roomRef,
                            width = null, height = 160.dp)
                    }
                }
            }
        }
        else -> {
            // 3 or 4 → 2×2 grid. Compose without LazyVerticalGrid (overkill
            // for max-4 items) — two rows of two boxes each, weighted to
            // share the width evenly.
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (i in 0..1) {
                        if (i < cohosts.size) {
                            Box(modifier = Modifier.weight(1f)) {
                                CohostTile(cohost = cohosts[i], roomRef = session.roomRef,
                                    width = null, height = 130.dp)
                            }
                        } else {
                            Spacer(Modifier.weight(1f))
                        }
                    }
                }
                if (cohosts.size > 2) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (i in 2..3) {
                            if (i < cohosts.size) {
                                Box(modifier = Modifier.weight(1f)) {
                                    CohostTile(cohost = cohosts[i], roomRef = session.roomRef,
                                        width = null, height = 130.dp)
                                }
                            } else {
                                Spacer(Modifier.weight(1f))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CohostTile(
    cohost: LiveCohost,
    roomRef: Room? = null,
    width: androidx.compose.ui.unit.Dp? = 110.dp,
    height: androidx.compose.ui.unit.Dp = 150.dp,
) {
    val mod = if (width != null) {
        Modifier.width(width).height(height)
    } else {
        Modifier.fillMaxWidth().height(height)
    }
    Box(
        modifier = mod
            .clip(RoundedCornerShape(12.dp))
            .background(CHIP_COLOR)
    ) {
        val track = cohost.videoTrack
        if (track != null) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    SurfaceViewRenderer(ctx).apply {
                        setBackgroundColor(AGColor.BLACK)
                        roomRef?.initVideoRenderer(this)
                    }
                },
                update = { try { track.addRenderer(it) } catch (_: Throwable) {} }
            )
        } else {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center
            ) {
                AvatarCircle(name = cohost.name, email = cohost.identity, size = 36.dp)
            }
        }
        Box(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .padding(6.dp)
                .background(Color.Black.copy(alpha = 0.55f), CircleShape)
                .padding(horizontal = 6.dp, vertical = 2.dp)
        ) {
            Text(
                cohost.name,
                color = Color.White,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

// ---------- Slow mode chip ----------

@Composable
private fun SlowModeIndicator(session: LiveBroadcastSessionState) {
    if (session.slowModeSeconds <= 0) return
    Row(
        modifier = Modifier
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .background(OVERLAY_BG, CircleShape)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Icon(
            Icons.Filled.HourglassEmpty,
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(11.dp)
        )
        Text(
            "Modo lento: ${session.slowModeSeconds}s",
            color = Color.White,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold
        )
    }
}

// ---------- Active poll chip ----------

@Composable
private fun ActivePollChip(
    session: LiveBroadcastSessionState,
    onTapPoll: () -> Unit
) {
    val poll = session.activePoll ?: return
    Row(
        modifier = Modifier
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .fillMaxWidth()
            .background(Color.Black.copy(alpha = 0.55f), RoundedCornerShape(12.dp))
            .clickable { onTapPoll() }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Icon(
            Icons.Filled.BarChart,
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(14.dp)
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                poll.question,
                color = Color.White,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                "${poll.totalVotes} voto${if (poll.totalVotes == 1) "" else "s"}",
                color = Color.White.copy(alpha = 0.85f),
                fontSize = 10.sp
            )
        }
        if (poll.closed) {
            Text(
                "ENCERRADA",
                color = Color.White,
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(SECONDARY, CircleShape)
                    .padding(horizontal = 6.dp, vertical = 2.dp)
            )
        }
    }
}

// ---------- Chat overlay (last 6) ----------

@Composable
private fun ChatOverlay(session: LiveBroadcastSessionState) {
    val tail = remember(session.chatMessages.size) {
        session.chatMessages.takeLast(6)
    }
    val listState = rememberLazyListState()
    LaunchedEffect(tail.size) {
        if (tail.isNotEmpty()) listState.scrollToItem(tail.size - 1)
    }
    LazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxWidth()
            .height(180.dp)
            .padding(horizontal = 12.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        items(tail, key = { it.id }) { msg ->
            ChatRow(msg)
        }
    }
}

@Composable
private fun ChatRow(msg: LiveChatMessage) {
    Row(
        modifier = Modifier
            .background(OVERLAY_BG, RoundedCornerShape(10.dp))
            .padding(horizontal = 6.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        AvatarCircle(name = msg.authorName, email = msg.authorEmail, size = 22.dp)
        Column(modifier = Modifier.weight(1f)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text(
                    msg.authorName,
                    color = Color.White.copy(alpha = 0.9f),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold
                )
                if (msg.isHost) {
                    Text(
                        "HOST",
                        color = Color.White,
                        fontSize = 8.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .background(LIVE_RED, CircleShape)
                            .padding(horizontal = 4.dp, vertical = 1.dp)
                    )
                }
            }
            Text(
                msg.text,
                color = Color.White,
                fontSize = 12.sp
            )
        }
    }
}

// ---------- Bottom bar (composer + 5 reaction emojis) ----------

@Composable
private fun BottomBar(
    onSendComment: (String) -> Unit,
    onSendReaction: (String) -> Unit,
) {
    var draft by remember { mutableStateOf("") }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                Brush.verticalGradient(
                    colors = listOf(Color.Transparent, Color.Black.copy(alpha = 0.45f))
                )
            )
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(
            modifier = Modifier
                .weight(1f)
                .background(OVERLAY_BG, CircleShape)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            BasicTextField(
                value = draft,
                onValueChange = { draft = it },
                singleLine = true,
                modifier = Modifier.weight(1f),
                textStyle = TextStyle(color = Color.White, fontSize = 14.sp),
                cursorBrush = Brush.linearGradient(listOf(Color.White, Color.White)),
                decorationBox = { inner ->
                    if (draft.isEmpty()) {
                        Text(
                            "Comente...",
                            color = Color.White.copy(alpha = 0.6f),
                            fontSize = 14.sp
                        )
                    }
                    inner()
                }
            )
            if (draft.isNotEmpty()) {
                Icon(
                    Icons.Filled.Send,
                    contentDescription = "Enviar",
                    tint = Color.White,
                    modifier = Modifier
                        .size(20.dp)
                        .clickable {
                            val t = draft.trim()
                            if (t.isNotEmpty()) {
                                onSendComment(t)
                                draft = ""
                            }
                        }
                )
            }
        }
        for (emoji in REACTIONS) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .background(Color.Black.copy(alpha = 0.35f), CircleShape)
                    .clickable { onSendReaction(emoji) },
                contentAlignment = Alignment.Center
            ) {
                Text(emoji, fontSize = 20.sp)
            }
        }
    }
}

private val REACTIONS = listOf("❤️", "🔥", "👏", "😂", "🎉")

// ---------- Reaction burst overlay ----------

@Composable
private fun ReactionBurst(session: LiveBroadcastSessionState) {
    Box(modifier = Modifier.fillMaxSize()) {
        for (reaction in session.floatingReactions) {
            FloatingHeart(reaction)
        }
    }
}

@Composable
private fun FloatingHeart(reaction: LiveFloatingReaction) {
    // Simple animation: easeOut translate up + fade out over 2.6s. We drive
    // both via animateFloatAsState keyed by reaction id so each emoji has its
    // own animation cursor.
    val target by animateFloatAsState(
        targetValue = 1f,
        animationSpec = tween(durationMillis = 2_600),
        label = "heartAnim"
    )
    val translateY = -260f * target
    val alpha = (1f - target).coerceIn(0f, 1f)
    Box(
        modifier = Modifier
            .fillMaxSize(),
        contentAlignment = Alignment.BottomCenter
    ) {
        Text(
            reaction.emoji,
            fontSize = 26.sp,
            color = Color.White.copy(alpha = alpha),
            modifier = Modifier.padding(bottom = clampDp((140 + translateY).dp, 0.dp))
        )
    }
}

private fun clampDp(value: Dp, min: Dp): Dp = if (value < min) min else value

// ---------- Settings sheet (slow mode + viewer list) ----------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsSheet(
    session: LiveBroadcastSessionState,
    onDismiss: () -> Unit,
    onChangeSlowMode: (Int) -> Unit,
    onRemoveViewer: (String) -> Unit,
    onBlockViewer: (String) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = CHIP_COLOR
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Text(
                "Modo lento",
                color = Color.White,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (sec in listOf(0, 5, 15, 30, 60)) {
                    val selected = session.slowModeSeconds == sec
                    Button(
                        onClick = { onChangeSlowMode(sec) },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (selected) LIVE_RED else Color.Black.copy(alpha = 0.4f),
                            contentColor = Color.White
                        )
                    ) {
                        Text(if (sec == 0) "Off" else "${sec}s")
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
            Text(
                "Espectadores (${session.viewers.size})",
                color = Color.White,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(8.dp))
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(280.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                items(session.viewers, key = { it.email }) { v ->
                    ViewerRow(
                        viewer = v,
                        onRemove = { onRemoveViewer(v.email) },
                        onBlock = { onBlockViewer(v.email) }
                    )
                }
            }
        }
    }
}

@Composable
private fun ViewerRow(
    viewer: LiveViewerRow,
    onRemove: () -> Unit,
    onBlock: () -> Unit
) {
    var showMenu by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .pointerInput(viewer.email) {
                detectTapGestures(onLongPress = { showMenu = true })
            }
            .background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(8.dp))
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        AvatarCircle(name = viewer.name, email = viewer.email, size = 32.dp)
        Column(modifier = Modifier.weight(1f)) {
            Text(viewer.name.ifEmpty { viewer.email }, color = Color.White, fontSize = 13.sp)
            if (viewer.name.isNotEmpty()) {
                Text(viewer.email, color = SECONDARY, fontSize = 11.sp)
            }
        }
        if (showMenu) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TextButton(onClick = { onRemove(); showMenu = false }) {
                    Icon(
                        Icons.Filled.PersonOff,
                        contentDescription = "Remover",
                        tint = Color.White,
                        modifier = Modifier.size(16.dp)
                    )
                }
                TextButton(onClick = { onBlock(); showMenu = false }) {
                    Icon(
                        Icons.Filled.Block,
                        contentDescription = "Bloquear",
                        tint = LIVE_RED,
                        modifier = Modifier.size(16.dp)
                    )
                }
            }
        }
    }
}

// ---------- Poll creator sheet ----------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PollCreatorSheet(
    onDismiss: () -> Unit,
    onCreate: (String, List<String>) -> Unit
) {
    var question by remember { mutableStateOf("") }
    var opt1 by remember { mutableStateOf("") }
    var opt2 by remember { mutableStateOf("") }
    var opt3 by remember { mutableStateOf("") }
    var opt4 by remember { mutableStateOf("") }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = CHIP_COLOR
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                "Nova enquete",
                color = Color.White,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold
            )
            PollInput(value = question, onValueChange = { question = it }, hint = "Pergunta")
            PollInput(value = opt1, onValueChange = { opt1 = it }, hint = "Opção 1")
            PollInput(value = opt2, onValueChange = { opt2 = it }, hint = "Opção 2")
            PollInput(value = opt3, onValueChange = { opt3 = it }, hint = "Opção 3 (opcional)")
            PollInput(value = opt4, onValueChange = { opt4 = it }, hint = "Opção 4 (opcional)")
            Button(
                onClick = {
                    val opts = listOf(opt1, opt2, opt3, opt4).map { it.trim() }.filter { it.isNotEmpty() }
                    if (question.trim().isNotEmpty() && opts.size >= 2) {
                        onCreate(question.trim(), opts)
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = LIVE_RED),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Publicar enquete", color = Color.White)
            }
        }
    }
}

@Composable
private fun PollInput(value: String, onValueChange: (String) -> Unit, hint: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp)
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            textStyle = TextStyle(color = Color.White, fontSize = 14.sp),
            cursorBrush = Brush.linearGradient(listOf(Color.White, Color.White)),
            decorationBox = { inner ->
                if (value.isEmpty()) {
                    Text(hint, color = Color.White.copy(alpha = 0.5f), fontSize = 14.sp)
                }
                inner()
            }
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PollDetailsSheet(poll: LivePoll, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = CHIP_COLOR
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                poll.question,
                color = Color.White,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold
            )
            for ((idx, opt) in poll.options.withIndex()) {
                val pct = if (poll.totalVotes > 0)
                    opt.votes * 100.0 / poll.totalVotes else 0.0
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(40.dp)
                        .background(Color.White.copy(alpha = 0.06f), RoundedCornerShape(8.dp))
                        .padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(opt.text, color = Color.White, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Text("${pct.toInt()}%", color = Color.White.copy(alpha = 0.85f), fontSize = 11.sp)
                }
            }
            Text(
                "${poll.totalVotes} voto${if (poll.totalVotes == 1) "" else "s"}",
                color = Color.White.copy(alpha = 0.7f),
                fontSize = 11.sp
            )
        }
    }
}

// ---------- Avatar helper ----------

@Composable
private fun AvatarCircle(name: String, email: String, size: Dp) {
    val src = name.trim().ifEmpty { email }
    val initial = src.firstOrNull()?.uppercase() ?: "?"
    Box(
        modifier = Modifier
            .size(size)
            .background(CHIP_COLOR, CircleShape)
            .border(1.dp, Color.White.copy(alpha = 0.1f), CircleShape),
        contentAlignment = Alignment.Center
    ) {
        Text(
            initial,
            color = Color.White,
            fontSize = (size.value * 0.42f).sp,
            fontWeight = FontWeight.Medium
        )
    }
}

// ---------- Helpers ----------

private fun formatDuration(s: Int): String {
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec)
    else "%d:%02d".format(m, sec)
}
