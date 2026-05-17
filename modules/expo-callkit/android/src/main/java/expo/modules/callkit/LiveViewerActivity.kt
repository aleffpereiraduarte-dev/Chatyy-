package expo.modules.callkit

// Stage 998/1000 — Compose mirror of iOS LiveBroadcastView.swift / LiveViewerView.swift
//
// LiveViewerActivity — Jetpack Compose viewer (audience) UI for /live-viewer.
//
// Mirrors LiveViewerView.swift (~543 lines) + LiveViewerViewController.swift
// in a single Android Activity. The viewer subscribes-only — no camera/mic
// publish unless they're approved as a cohost (live_cohost_approved WS event
// flips a flag that future stages turn into a publisher upgrade).
//
// Architecture:
//   - On openLiveViewer JS bridge call, ExpoCallKitModule starts this activity
//     with extras { liveSessionId, lkUrl, lkToken, hostEmail, hostName,
//     hostAvatar, pinnedComment?, slowModeSeconds? }.
//   - In onCreate, LiveKit.create(applicationContext) gets a Room, then
//     room.connect(url, token). For viewers we disable autoSubscribe only
//     for tracks we don't want — but here we want everything (audio + video).
//   - We also open the WS to wss://ws.chatyy.com.br/ws with the bearer from
//     SharedPreferences (same store CallSignalWs uses) so the server can
//     forward live_pin_comment / live_slow_mode / live_poll_* /
//     live_viewer_kicked / live_cohost_approved frames.
//   - Compose-observable state in LiveViewerSessionState. Mutations dispatched
//     onto Dispatchers.Main; Compose re-renders the affected subtree.
//   - Auto-close: if a live_viewer_kicked frame arrives carrying our own
//     email, we immediately finishViewer() with reason="kicked".
//   - Long-press top bar → report sheet (bottom-sheet modal).
//
// Intent extras:
//   EXTRA_LIVE_SESSION_ID, EXTRA_LK_URL, EXTRA_LK_TOKEN, EXTRA_HOST_EMAIL,
//   EXTRA_HOST_NAME, EXTRA_HOST_AVATAR, EXTRA_PINNED_AUTHOR,
//   EXTRA_PINNED_TEXT, EXTRA_SLOW_MODE_SECONDS, EXTRA_MY_EMAIL
//
// LiveKit Android 2.24.1 API used: same surface as the broadcast side, plus
// no setCameraEnabled/setMicrophoneEnabled (viewers don't publish).
//
// Strings in Portuguese per spec.

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
import android.widget.Toast
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
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
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
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

// MARK: - Palette ------------------------------------------------------------
// Shared values with LiveBroadcastActivity — duplicated here to keep the two
// activities independently compilable.

private val V_BG_COLOR = Color(0xFF0B141A)
private val V_CHIP_COLOR = Color(0xFF1F2C34)
private val V_LIVE_RED = Color(0xFFDC2626)
private val V_SECONDARY = Color(0xFF8696A0)
private val V_PURPLE = Color(0xB39C27B0)
private val V_GREEN = Color(0xB34CAF50)
private val V_OVERLAY_BG = Color(0x59000000) // black 35%

// MARK: - Domain models -------------------------------------------------------

/** Pinned-comment shared shape (the same struct exists in the broadcast file —
 *  we redeclare here under a viewer-local namespace so the two activity files
 *  stay independently compilable without cross-file refactor risk). */
data class LiveViewerPinnedComment(
    val authorName: String,
    val text: String
)

data class LiveViewerChatMessage(
    val id: String,
    val authorEmail: String,
    val authorName: String,
    val text: String,
    val isHost: Boolean,
    val timestampMs: Long
)

data class LiveViewerFloatingReaction(
    val id: String,
    val emoji: String,
    val xOffsetDp: Float,
    val spawnedAtMs: Long
)

data class LiveViewerPoll(
    val id: String,
    val question: String,
    val options: List<LiveViewerPollOption>,
    val totalVotes: Int,
    val closed: Boolean
)

data class LiveViewerPollOption(
    val text: String,
    val votes: Int
)

/**
 * Compose-observable state holder for the viewer side. Each field is a
 * mutableStateOf — Compose recomposes only the consuming subtrees on write.
 */
class LiveViewerSessionState {
    var hostVideoTrack by mutableStateOf<VideoTrack?>(null)
    var connectStatus by mutableStateOf("Conectando...")
    var reconnecting by mutableStateOf(false)
    var viewerCount by mutableIntStateOf(0)
    var connectionQuality by mutableStateOf("good")
    var pinnedComment by mutableStateOf<LiveViewerPinnedComment?>(null)
    var slowModeSeconds by mutableIntStateOf(0)
    /** Unix-ms timestamp until which the composer is locked by slow mode. */
    var slowModeBlockedUntilMs by mutableLongStateOf(0L)
    val chatMessages = mutableStateListOf<LiveViewerChatMessage>()
    val floatingReactions = mutableStateListOf<LiveViewerFloatingReaction>()
    var activePoll by mutableStateOf<LiveViewerPoll?>(null)
    /** Index of the option the local viewer voted for (null = not voted). */
    var myPollVote by mutableStateOf<Int?>(null)
    var cohostRequested by mutableStateOf(false)
    var cohostApproved by mutableStateOf(false)
    /** Room reference for AndroidView factories that need
     *  initVideoRenderer() before binding a remote track. */
    var roomRef: Room? = null
}

// MARK: - Activity -----------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
class LiveViewerActivity : ComponentActivity() {

    companion object {
        private const val TAG = "LiveViewerActivity"
        const val ACTION_CLOSE = "expo.modules.callkit.CLOSE_LIVE_VIEWER"

        const val EXTRA_LIVE_SESSION_ID = "live_session_id"
        const val EXTRA_LK_URL = "lk_url"
        const val EXTRA_LK_TOKEN = "lk_token"
        const val EXTRA_HOST_EMAIL = "host_email"
        const val EXTRA_HOST_NAME = "host_name"
        const val EXTRA_HOST_AVATAR = "host_avatar"
        const val EXTRA_PINNED_AUTHOR = "pinned_author"
        const val EXTRA_PINNED_TEXT = "pinned_text"
        const val EXTRA_SLOW_MODE_SECONDS = "slow_mode_seconds"
        const val EXTRA_MY_EMAIL = "my_email"

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
    private var myEmail: String = ""

    private val session = LiveViewerSessionState()

    // LiveKit state ----------------------------------------------------------
    private var room: Room? = null
    private var eventsJob: Job? = null
    private var connectJob: Job? = null
    private var lkReconnectAttempts = 0

    // WS state ---------------------------------------------------------------
    private var ws: WebSocket? = null
    private var wsAuthed = false
    private var wsReconnectAttempts = 0
    private var okHttp: OkHttpClient? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    // Tickers ----------------------------------------------------------------
    private var reactionGcJob: Job? = null

    // External-close receiver -------------------------------------------------
    private val closeReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            Log.d(TAG, "closeReceiver — finishing")
            finishViewer(reason = "close_broadcast")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
        myEmail = extras.getString(EXTRA_MY_EMAIL) ?: ""

        // Pre-populate pinned + slow mode if the bridge had them at open time.
        val pinnedAuthor = extras.getString(EXTRA_PINNED_AUTHOR) ?: ""
        val pinnedText = extras.getString(EXTRA_PINNED_TEXT) ?: ""
        if (pinnedText.isNotEmpty()) {
            session.pinnedComment = LiveViewerPinnedComment(pinnedAuthor, pinnedText)
        }
        session.slowModeSeconds = extras.getInt(EXTRA_SLOW_MODE_SECONDS, 0)

        Log.d(
            TAG,
            "onCreate: session=$liveSessionId host=$hostName myEmail=$myEmail"
        )

        setContent {
            MaterialTheme {
                LiveViewerScreen(
                    session = session,
                    hostName = hostName,
                    hostEmail = hostEmail,
                    onClose = { finishViewer(reason = "user_close") },
                    onSendComment = { txt -> sendComment(txt) },
                    onSendReaction = { e -> sendReaction(e) },
                    onTap = { spawnFloatingReaction(pickAny()) },
                    onLongPressTop = { /* report sheet handled inline */ },
                    onRequestCohost = { requestCohost() },
                    onTapPoll = { /* poll details — inline */ },
                    onVotePollOption = { idx -> votePoll(idx) },
                    onSubmitReport = { reason -> submitReport(reason) }
                )
            }
        }

        // External-close filter.
        val filter = IntentFilter(ACTION_CLOSE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(closeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(closeReceiver, filter)
        }

        startReactionGc()

        if (lkUrl.isNotEmpty() && lkToken.isNotEmpty()) {
            connectLiveKit()
        } else {
            session.connectStatus = "Erro: credenciais ausentes"
        }
        connectWs()
    }

    // MARK: - LiveKit (subscribe-only) ---------------------------------------

    private fun connectLiveKit() {
        val r = LiveKit.create(applicationContext)
        room = r
        session.roomRef = r
        session.reconnecting = false
        eventsJob = lifecycleScope.launch {
            r.events.collect { event ->
                when (event) {
                    is RoomEvent.Connected -> {
                        Log.d(TAG, "RoomEvent.Connected")
                        session.connectStatus = "Conectado"
                        session.reconnecting = false
                        lkReconnectAttempts = 0
                    }
                    is RoomEvent.Reconnecting -> {
                        Log.d(TAG, "RoomEvent.Reconnecting")
                        session.connectStatus = "Reconectando..."
                        session.reconnecting = true
                    }
                    is RoomEvent.Reconnected -> {
                        Log.d(TAG, "RoomEvent.Reconnected")
                        session.connectStatus = "Conectado"
                        session.reconnecting = false
                    }
                    is RoomEvent.Disconnected -> {
                        Log.d(TAG, "RoomEvent.Disconnected reason=${event.reason}")
                        scheduleLkReconnect()
                    }
                    is RoomEvent.ParticipantConnected -> {
                        session.viewerCount = (session.viewerCount + 1)
                            .coerceAtLeast(r.remoteParticipants.size)
                    }
                    is RoomEvent.ParticipantDisconnected -> {
                        session.viewerCount = (session.viewerCount - 1).coerceAtLeast(0)
                    }
                    is RoomEvent.TrackSubscribed -> {
                        val t = event.track
                        if (t is VideoTrack) {
                            val identity = event.participant.identity?.value ?: ""
                            // The first video track belonging to the host is
                            // the main feed. If multiple hosts publish video
                            // (cohost grid scenario), we keep showing the
                            // original host as fullscreen and let cohost
                            // tiles draw separately in a future stage.
                            if (identity == hostEmail || session.hostVideoTrack == null) {
                                session.hostVideoTrack = t
                            }
                        }
                    }
                    is RoomEvent.TrackUnsubscribed -> {
                        // If the host's track is unsubscribed (broadcast ended
                        // from the host side), drop the renderer so the avatar
                        // fallback re-appears.
                        val t = event.track
                        if (t is VideoTrack && session.hostVideoTrack == t) {
                            session.hostVideoTrack = null
                            session.connectStatus = "Host saiu"
                        }
                    }
                    is RoomEvent.ConnectionQualityChanged -> {
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
                        handleLkDataChannel(event.data)
                    }
                    else -> { /* no-op */ }
                }
            }
        }

        connectJob = lifecycleScope.launch {
            try {
                r.connect(lkUrl, lkToken)
                Log.d(TAG, "LK connect OK (subscribe-only)")
            } catch (t: Throwable) {
                Log.e(TAG, "LK connect failed: ${t.message}", t)
                session.connectStatus = "Falha ao conectar"
                scheduleLkReconnect()
            }
        }
    }

    private fun scheduleLkReconnect() {
        if (lkReconnectAttempts >= MAX_RECONNECT) {
            Log.w(TAG, "LK reconnect: max attempts reached")
            session.connectStatus = "Sem conexão"
            return
        }
        val backoff = RECONNECT_BACKOFF_MS[min(lkReconnectAttempts, RECONNECT_BACKOFF_MS.lastIndex)]
        lkReconnectAttempts++
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
                    val id = json.optString("poll_id")
                    val idx = json.optInt("option_idx", -1)
                    bumpPollLocal(id, idx)
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
                    // Tell the server we're now watching this live so it
                    // forwards live_* events to us.
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
                    else LiveViewerPinnedComment(author, txt)
                }
                "live_slow_mode" -> {
                    val s = json.optInt("seconds", 0)
                    session.slowModeSeconds = s
                    if (s == 0) session.slowModeBlockedUntilMs = 0
                }
                "live_viewer_kicked" -> {
                    val kickedEmail = json.optString("email")
                    if (kickedEmail.equals(myEmail, ignoreCase = true)) {
                        Log.d(TAG, "Got kicked — closing")
                        Toast.makeText(this, "Você foi removido da live", Toast.LENGTH_SHORT).show()
                        finishViewer(reason = "kicked")
                    }
                }
                "live_poll_created" -> {
                    val id = json.optString("poll_id")
                    val q = json.optString("question")
                    val optsJson = json.optJSONArray("options")
                    val opts = mutableListOf<LiveViewerPollOption>()
                    if (optsJson != null) for (i in 0 until optsJson.length()) {
                        opts.add(LiveViewerPollOption(optsJson.optString(i), 0))
                    }
                    session.activePoll = LiveViewerPoll(id, q, opts, 0, false)
                    session.myPollVote = null
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
                        LiveViewerChatMessage(
                            id = mid,
                            authorEmail = email,
                            authorName = name,
                            text = body,
                            isHost = isHost,
                            timestampMs = System.currentTimeMillis()
                        )
                    )
                    while (session.chatMessages.size > 200) session.chatMessages.removeAt(0)
                }
                "live_reaction" -> {
                    val emoji = json.optString("emoji", "❤️")
                    spawnFloatingReaction(emoji)
                }
                "live_cohost_approved" -> {
                    val approvedEmail = json.optString("email")
                    if (approvedEmail.equals(myEmail, ignoreCase = true)) {
                        session.cohostApproved = true
                        Log.d(TAG, "I'm approved as cohost — publisher upgrade TBD")
                        // Future stage: setMicrophoneEnabled+setCameraEnabled
                        // to flip into publisher mode in the same Room.
                    }
                }
                else -> { /* unknown */ }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "WS frame parse fail: ${t.message}")
        }
    }

    private fun wsSend(payload: JSONObject): Boolean {
        val ws0 = ws
        if (ws0 == null || !wsAuthed) {
            Log.d(TAG, "wsSend: not authed — dropping ${payload.optString("type")}")
            return false
        }
        return ws0.send(payload.toString())
    }

    // MARK: - User actions ---------------------------------------------------

    private fun sendComment(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        // Slow-mode local rate-limit. Server is the source of truth, but the
        // local check gives instant feedback before the WS RTT.
        val now = System.currentTimeMillis()
        if (session.slowModeSeconds > 0 && now < session.slowModeBlockedUntilMs) {
            val waitSec = ((session.slowModeBlockedUntilMs - now) / 1000L) + 1
            Toast.makeText(
                this,
                "Modo lento: aguarde ${waitSec}s",
                Toast.LENGTH_SHORT
            ).show()
            return
        }
        val sent = wsSend(JSONObject().apply {
            put("type", "live_comment")
            put("live_session_id", liveSessionId)
            put("text", trimmed)
        })
        if (sent && session.slowModeSeconds > 0) {
            session.slowModeBlockedUntilMs = now + session.slowModeSeconds * 1000L
        } else if (!sent) {
            // Toast for the rare WS-not-ready race; UX is identical to slow
            // mode failure so the user knows to retry.
            Toast.makeText(this, "Conectando, tente novamente em instantes", Toast.LENGTH_SHORT).show()
        }
    }

    private fun sendReaction(emoji: String) {
        spawnFloatingReaction(emoji)
        // LK data channel (low-latency) — we publish from the viewer's local
        // participant. Even though we're subscribe-only for tracks, data
        // channel sends are still allowed.
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
            LiveViewerFloatingReaction(
                id = UUID.randomUUID().toString(),
                emoji = emoji,
                xOffsetDp = x,
                spawnedAtMs = System.currentTimeMillis()
            )
        )
        if (session.floatingReactions.size > 30) session.floatingReactions.removeAt(0)
    }

    private fun pickAny(): String {
        val r = listOf("❤️", "🔥", "👏", "😂", "🎉")
        return r[Random.nextInt(r.size)]
    }

    private fun requestCohost() {
        if (session.cohostRequested) return
        session.cohostRequested = true
        wsSend(JSONObject().apply {
            put("type", "live_cohost_request")
            put("live_session_id", liveSessionId)
        })
        Toast.makeText(this, "Pedido enviado, aguardando aprovação", Toast.LENGTH_SHORT).show()
    }

    private fun votePoll(idx: Int) {
        val poll = session.activePoll ?: return
        if (poll.closed) return
        if (session.myPollVote != null) return
        if (idx < 0 || idx >= poll.options.size) return
        session.myPollVote = idx
        bumpPollLocal(poll.id, idx)
        wsSend(JSONObject().apply {
            put("type", "live_poll_vote")
            put("live_session_id", liveSessionId)
            put("poll_id", poll.id)
            put("option_idx", idx)
        })
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

    private fun submitReport(reason: String) {
        wsSend(JSONObject().apply {
            put("type", "live_report")
            put("live_session_id", liveSessionId)
            put("reason", reason)
        })
        Toast.makeText(this, "Denúncia enviada", Toast.LENGTH_SHORT).show()
    }

    // MARK: - Tickers --------------------------------------------------------

    private fun startReactionGc() {
        reactionGcJob = lifecycleScope.launch {
            while (true) {
                val now = System.currentTimeMillis()
                session.floatingReactions.removeAll { now - it.spawnedAtMs > REACTION_TTL_MS }
                delay(400L)
            }
        }
    }

    // MARK: - Tear down ------------------------------------------------------

    private fun finishViewer(reason: String) {
        Log.d(TAG, "finishViewer reason=$reason")
        reactionGcJob?.cancel()
        try { ws?.close(1000, "viewer_close") } catch (_: Throwable) {}
        ws = null
        ExpoCallKitModule.emitCallEnded(liveSessionId)
        finish()
    }

    @OptIn(DelicateCoroutinesApi::class)
    override fun onDestroy() {
        try { unregisterReceiver(closeReceiver) } catch (_: Exception) {}
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
        try { ws?.close(1000, "destroy") } catch (_: Throwable) {}
        super.onDestroy()
    }

    override fun onBackPressed() {
        // Viewer's back press = leave the live. Symmetric to a tap on the X.
        finishViewer(reason = "back_press")
    }
}

// ============================================================================
// Composable tree (viewer)
// ============================================================================

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LiveViewerScreen(
    session: LiveViewerSessionState,
    hostName: String,
    hostEmail: String,
    onClose: () -> Unit,
    onSendComment: (String) -> Unit,
    onSendReaction: (String) -> Unit,
    onTap: () -> Unit,
    onLongPressTop: () -> Unit,
    onRequestCohost: () -> Unit,
    onTapPoll: () -> Unit,
    onVotePollOption: (Int) -> Unit,
    onSubmitReport: (String) -> Unit,
) {
    var showReportSheet by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(V_BG_COLOR)
    ) {
        // 1. Remote host video (or avatar fallback) fills behind everything.
        RemoteFill(
            session = session,
            hostName = hostName,
            hostEmail = hostEmail,
            onTap = onTap,
            onLongPressTop = {
                showReportSheet = true
                onLongPressTop()
            }
        )

        // 2. Top bar + pinned comment.
        Column(modifier = Modifier.fillMaxWidth()) {
            ViewerTopBar(
                session = session,
                hostName = hostName,
                hostEmail = hostEmail,
                onClose = onClose,
                onLongPressTop = {
                    showReportSheet = true
                    onLongPressTop()
                }
            )
            ViewerPinnedCommentChip(session = session)
        }

        // 3. Center column for the active poll overlay.
        if (session.activePoll != null) {
            Column(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.Top
            ) {
                Spacer(Modifier.height(220.dp))
                ViewerPollOverlay(
                    session = session,
                    onTapPoll = onTapPoll,
                    onVotePollOption = onVotePollOption
                )
            }
        }

        // 4. Bottom column: slow toast + cohost CTA + chat + composer.
        Column(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.navigationBars)
                .imePadding(),
            verticalArrangement = Arrangement.Bottom
        ) {
            Spacer(Modifier.weight(1f))
            ViewerSlowModeToast(session = session)
            ViewerCohostRequestBar(session = session, onRequestCohost = onRequestCohost)
            ViewerChatOverlay(session = session)
            ViewerBottomBar(
                session = session,
                onSendComment = onSendComment,
                onSendReaction = onSendReaction
            )
        }

        // 5. Floating reaction burst (non-interactive).
        ViewerReactionBurst(session = session)
    }

    if (showReportSheet) {
        ReportSheet(
            onDismiss = { showReportSheet = false },
            onSubmit = { reason ->
                onSubmitReport(reason)
                showReportSheet = false
            }
        )
    }
}

// ---------- Remote fill ----------

@Composable
private fun RemoteFill(
    session: LiveViewerSessionState,
    hostName: String,
    hostEmail: String,
    onTap: () -> Unit,
    onLongPressTop: () -> Unit,
) {
    val track = session.hostVideoTrack
    Box(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { onTap() },
                    onLongPress = { onLongPressTop() }
                )
            }
    ) {
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
                        // EGL init: the renderer needs the Room's
                        // SurfaceTextureHelper context before addRenderer.
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
                    .background(V_BG_COLOR),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    ViewerAvatarCircle(name = hostName, email = hostEmail, size = 96.dp)
                    Spacer(Modifier.height(12.dp))
                    Text(
                        session.connectStatus,
                        color = V_SECONDARY,
                        fontSize = 14.sp
                    )
                    if (session.reconnecting) {
                        Spacer(Modifier.height(8.dp))
                        CircularProgressIndicator(
                            color = Color.White,
                            modifier = Modifier.size(20.dp)
                        )
                    }
                }
            }
        }
    }
}

// ---------- Top bar ----------

@Composable
private fun ViewerTopBar(
    session: LiveViewerSessionState,
    hostName: String,
    hostEmail: String,
    onClose: () -> Unit,
    onLongPressTop: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                Brush.verticalGradient(
                    colors = listOf(Color.Black.copy(alpha = 0.55f), Color.Transparent)
                )
            )
            .windowInsetsPadding(WindowInsets.statusBars)
            .pointerInput(Unit) {
                detectTapGestures(onLongPress = { onLongPressTop() })
            }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        ViewerAvatarCircle(name = hostName, email = hostEmail, size = 36.dp)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                hostName.ifEmpty { hostEmail },
                color = Color.White,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                ViewerLiveBadge()
                Spacer(Modifier.width(6.dp))
                Icon(
                    Icons.Filled.Visibility,
                    contentDescription = null,
                    tint = Color.White.copy(alpha = 0.85f),
                    modifier = Modifier.size(10.dp)
                )
                Spacer(Modifier.width(3.dp))
                Text(
                    "${session.viewerCount}",
                    color = Color.White.copy(alpha = 0.85f),
                    fontSize = 11.sp
                )
            }
        }
        // Auto-hide bars when quality is excellent (instagram/YT live UX).
        ViewerConnectionBars(quality = session.connectionQuality)
        ViewerIconCircleButton(
            iconVec = Icons.Filled.Close,
            size = 32.dp,
            onClick = onClose
        )
    }
}

@Composable
private fun ViewerLiveBadge() {
    val infinite = rememberInfiniteTransition(label = "viewerLivePulse")
    val pulse by infinite.animateFloat(
        initialValue = 1f,
        targetValue = 0.4f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 800),
            repeatMode = RepeatMode.Reverse
        ),
        label = "viewerLivePulseValue"
    )
    Row(
        modifier = Modifier
            .background(V_LIVE_RED, CircleShape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp)
    ) {
        Box(
            Modifier
                .size(5.dp)
                .background(Color.White.copy(alpha = pulse), CircleShape)
        )
        Text(
            "AO VIVO",
            color = Color.White,
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold
        )
    }
}

/**
 * Connection bars w/ auto-hide on "excellent" — same UX as Instagram / YT
 * Live: only surface the indicator when there's actually a problem so the
 * top bar stays clean during a great stream.
 */
@Composable
private fun ViewerConnectionBars(quality: String) {
    val (bars, color, hide) = when (quality) {
        "excellent" -> Triple(3, Color(0xFF4ADE80), true)
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
private fun ViewerIconCircleButton(
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
private fun ViewerPinnedCommentChip(session: LiveViewerSessionState) {
    AnimatedVisibility(
        visible = session.pinnedComment != null,
        enter = fadeIn(),
        exit = fadeOut()
    ) {
        val pinned = session.pinnedComment ?: return@AnimatedVisibility
        Row(
            modifier = Modifier
                .padding(horizontal = 60.dp, vertical = 6.dp)
                .background(V_OVERLAY_BG, RoundedCornerShape(10.dp))
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

// ---------- Poll overlay (tap-to-vote) ----------

@Composable
private fun ViewerPollOverlay(
    session: LiveViewerSessionState,
    onTapPoll: () -> Unit,
    onVotePollOption: (Int) -> Unit,
) {
    AnimatedVisibility(
        visible = session.activePoll != null,
        enter = slideInVertically { -it } + fadeIn(),
        exit = slideOutVertically { -it } + fadeOut()
    ) {
        val poll = session.activePoll ?: return@AnimatedVisibility
        Column(
            modifier = Modifier
                .padding(horizontal = 20.dp)
                .fillMaxWidth()
                .background(Color.Black.copy(alpha = 0.6f), RoundedCornerShape(14.dp))
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.BarChart,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(14.dp)
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    poll.question,
                    color = Color.White,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f)
                )
                Icon(
                    Icons.Filled.KeyboardArrowUp,
                    contentDescription = null,
                    tint = Color.White.copy(alpha = 0.7f),
                    modifier = Modifier
                        .size(14.dp)
                        .clickable { onTapPoll() }
                )
            }
            for ((idx, opt) in poll.options.withIndex()) {
                val pct = if (poll.totalVotes > 0)
                    opt.votes * 100.0 / poll.totalVotes else 0.0
                val myVote = session.myPollVote
                val selected = myVote == idx
                val locked = poll.closed || myVote != null
                ViewerPollOptionRow(
                    opt = opt,
                    percent = pct,
                    selected = selected,
                    locked = locked,
                    onClick = {
                        if (!poll.closed && myVote == null) onVotePollOption(idx)
                    }
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${poll.totalVotes} voto${if (poll.totalVotes == 1) "" else "s"}",
                    color = Color.White.copy(alpha = 0.7f),
                    fontSize = 11.sp,
                    modifier = Modifier.weight(1f)
                )
                if (poll.closed) {
                    Text(
                        "ENCERRADA",
                        color = Color.White,
                        fontSize = 9.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .background(V_SECONDARY, CircleShape)
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun ViewerPollOptionRow(
    opt: LiveViewerPollOption,
    percent: Double,
    selected: Boolean,
    locked: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(36.dp)
            .background(Color.White.copy(alpha = 0.06f), RoundedCornerShape(8.dp))
            .clickable(enabled = !locked) { onClick() }
    ) {
        // Filled progress underlay — percentage width.
        Box(
            modifier = Modifier
                .fillMaxWidth(fraction = (percent / 100.0).toFloat().coerceIn(0f, 1f))
                .height(36.dp)
                .background(
                    if (selected) V_LIVE_RED.copy(alpha = 0.85f) else Color.White.copy(alpha = 0.18f),
                    RoundedCornerShape(8.dp)
                )
        )
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                opt.text,
                color = Color.White,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            if (locked) {
                Text(
                    "${percent.toInt()}%",
                    color = Color.White.copy(alpha = 0.85f),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
    }
}

// ---------- Slow mode toast ----------

@Composable
private fun ViewerSlowModeToast(session: LiveViewerSessionState) {
    if (session.slowModeSeconds <= 0) return
    Row(
        modifier = Modifier
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .background(V_OVERLAY_BG, CircleShape)
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
            "Modo lento: 1 comentário a cada ${session.slowModeSeconds}s",
            color = Color.White,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold
        )
    }
}

// ---------- Cohost request bar ----------

@Composable
private fun ViewerCohostRequestBar(
    session: LiveViewerSessionState,
    onRequestCohost: () -> Unit,
) {
    when {
        !session.cohostRequested -> {
            Row(
                modifier = Modifier
                    .padding(horizontal = 12.dp, vertical = 6.dp)
                    .background(V_PURPLE, CircleShape)
                    .clickable { onRequestCohost() }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Icon(
                    Icons.Filled.PersonAdd,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(12.dp)
                )
                Text(
                    "Pedir pra entrar",
                    color = Color.White,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
        session.cohostApproved -> {
            Row(
                modifier = Modifier
                    .padding(horizontal = 12.dp, vertical = 6.dp)
                    .background(V_GREEN, CircleShape)
                    .padding(horizontal = 12.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Icon(
                    Icons.Filled.CheckCircle,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(12.dp)
                )
                Text(
                    "Você está no ar!",
                    color = Color.White,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
        else -> {
            Text(
                "Pedido enviado, aguardando...",
                color = Color.White.copy(alpha = 0.85f),
                fontSize = 11.sp,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)
            )
        }
    }
}

// ---------- Chat overlay ----------

@Composable
private fun ViewerChatOverlay(session: LiveViewerSessionState) {
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
            ViewerChatRow(msg)
        }
    }
}

@Composable
private fun ViewerChatRow(msg: LiveViewerChatMessage) {
    Row(
        modifier = Modifier
            .background(V_OVERLAY_BG, RoundedCornerShape(10.dp))
            .padding(horizontal = 6.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        ViewerAvatarCircle(name = msg.authorName, email = msg.authorEmail, size = 22.dp)
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
                            .background(V_LIVE_RED, CircleShape)
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

// ---------- Bottom bar (composer + 5 reactions) ----------

@Composable
private fun ViewerBottomBar(
    session: LiveViewerSessionState,
    onSendComment: (String) -> Unit,
    onSendReaction: (String) -> Unit,
) {
    var draft by remember { mutableStateOf("") }
    val now = System.currentTimeMillis()
    val locked = session.slowModeSeconds > 0 && now < session.slowModeBlockedUntilMs
    val hint = if (locked) "Modo lento ativo" else "Comente..."
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
                .background(V_OVERLAY_BG, CircleShape)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            BasicTextField(
                value = draft,
                onValueChange = { if (!locked) draft = it },
                singleLine = true,
                modifier = Modifier.weight(1f),
                textStyle = TextStyle(color = Color.White, fontSize = 14.sp),
                cursorBrush = Brush.linearGradient(listOf(Color.White, Color.White)),
                enabled = !locked,
                decorationBox = { inner ->
                    if (draft.isEmpty()) {
                        Text(
                            hint,
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
        for (emoji in VIEWER_REACTIONS) {
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

private val VIEWER_REACTIONS = listOf("❤️", "🔥", "👏", "😂", "🎉")

// ---------- Reaction burst overlay ----------

@Composable
private fun ViewerReactionBurst(session: LiveViewerSessionState) {
    Box(modifier = Modifier.fillMaxSize()) {
        for (reaction in session.floatingReactions) {
            ViewerFloatingHeart(reaction)
        }
    }
}

@Composable
private fun ViewerFloatingHeart(reaction: LiveViewerFloatingReaction) {
    val target by animateFloatAsState(
        targetValue = 1f,
        animationSpec = tween(durationMillis = 2_600),
        label = "viewerHeartAnim"
    )
    val translateY = -260f * target
    val alpha = (1f - target).coerceIn(0f, 1f)
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.BottomCenter
    ) {
        Text(
            reaction.emoji,
            fontSize = 26.sp,
            color = Color.White.copy(alpha = alpha),
            modifier = Modifier.padding(bottom = vCoerceAtLeast((140 + translateY).dp, 0.dp))
        )
    }
}

private fun vCoerceAtLeast(value: Dp, min: Dp): Dp = if (value < min) min else value

// ---------- Report sheet ----------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReportSheet(onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = V_CHIP_COLOR
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                "Denunciar live",
                color = Color.White,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold
            )
            for (reason in listOf(
                "Spam",
                "Conteúdo sexual",
                "Discurso de ódio",
                "Violência",
                "Outro"
            )) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(8.dp))
                        .clickable { onSubmit(reason) }
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(
                        Icons.Filled.Flag,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(16.dp)
                    )
                    Text(reason, color = Color.White, fontSize = 14.sp)
                }
            }
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Cancelar", color = Color.White.copy(alpha = 0.7f))
            }
        }
    }
}

// ---------- Avatar helper ----------

@Composable
private fun ViewerAvatarCircle(name: String, email: String, size: Dp) {
    val src = name.trim().ifEmpty { email }
    val initial = src.firstOrNull()?.uppercase() ?: "?"
    Box(
        modifier = Modifier
            .size(size)
            .background(V_CHIP_COLOR, CircleShape)
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

