package expo.modules.callkit

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
 * [2026-05-16 Stage 4] Silent push wake → raw WebSocket session.
 *
 * Triggered by CallFirebaseMessagingService when the FCM payload's
 * `type == "wake_relay"`. We are explicitly NOT bringing up the React
 * Native bundle here — that would defeat the point of a silent wake.
 *
 * Lifecycle:
 *   1. onCreate / onStartCommand: read bearer token + user email from
 *      expo_callkit_prefs SharedPreferences. If either is missing,
 *      stop immediately (no user is logged in on this device).
 *   2. Promote to foreground (foregroundServiceType=dataSync) with a
 *      MIN-importance silent notification. Android 14+ kills services
 *      started from background within ~5s otherwise.
 *   3. Open OkHttp WebSocket to wss://ws.chatyy.com.br/ws.
 *   4. Send {type:"auth", token} → wait for auth_success.
 *   5. Send {type:"subscribe", channel:"chat_user_<email>"}.
 *   6. Send {type:"relay_ready", requestId} so the server drains any
 *      pending relays parked while we were offline.
 *   7. Listen for relay_request frames for PHONE_WS_HOLD_MS, dispatching
 *      to a no-op stub here (the JS relayResponder.js owns the actual
 *      satisfaction when the bundle is alive — see services file).
 *   8. After PHONE_WS_HOLD_MS, close socket + stopSelf().
 *
 * SILENT contract: NO notification visible to the user (importance MIN),
 * NO sound, NO vibration, NO heads-up.
 *
 * Note: this service is best-effort. iOS silent push is rate-limited; we
 * mirror the same constraint by keeping the hold window tight (10s).
 */
class RelayWakeService : Service() {

    companion object {
        private const val TAG = "RelayWakeService"
        private const val CHANNEL_ID = "relay_wake_silent"
        private const val NOTIFICATION_ID = 1077

        // Tunable timings — see DEPLOYMENT NOTES at the bottom of this file.
        private const val PHONE_WS_HOLD_MS = 10_000L
        private const val AUTH_TIMEOUT_MS = 5_000L

        private const val PREFS_NAME = "expo_callkit_prefs"
        private const val WS_URL = "wss://ws.chatyy.com.br/ws"

        const val EXTRA_REQUEST_ID = "requestId"

        /**
         * Convenience entry point. Caller (CallFirebaseMessagingService)
         * just hands us the requestId from the FCM payload.
         */
        fun start(ctx: Context, requestId: String) {
            val intent = Intent(ctx, RelayWakeService::class.java).apply {
                putExtra(EXTRA_REQUEST_ID, requestId)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(intent)
                } else {
                    ctx.startService(intent)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to start RelayWakeService: ${t.message}")
            }
        }
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var watchdog: Job? = null
    private var webSocket: WebSocket? = null
    private var httpClient: OkHttpClient? = null
    private var authenticated = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val requestId = intent?.getStringExtra(EXTRA_REQUEST_ID).orEmpty()
        Log.d(TAG, "onStartCommand requestId=$requestId")

        // Promote to foreground IMMEDIATELY (Android 14+ requires this within
        // 5s of a background-initiated start). Use dataSync type — phoneCall
        // requires an ongoing CallKit-style call, which we don't have.
        try {
            val n = buildSilentNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NOTIFICATION_ID,
                    n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIFICATION_ID, n)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "startForeground failed: ${t.message}")
            // Even if FGS promotion fails, try to do the work — the OS will
            // kill us after the BG window expires but we may still complete.
        }

        // Reject duplicate starts — if a second wake push arrives while
        // we're still alive, just let the in-flight session handle it.
        if (webSocket != null) {
            Log.d(TAG, "Already running — ignoring duplicate start")
            return START_NOT_STICKY
        }

        val prefs = applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val authToken = prefs.getString("auth_token", null)
        val userEmail = prefs.getString("user_email", null)
            ?: prefs.getString("auth_email", null)

        if (authToken.isNullOrEmpty() || userEmail.isNullOrEmpty()) {
            Log.w(TAG, "No auth token / email in prefs — nothing to do")
            stopSelfClean()
            return START_NOT_STICKY
        }

        scope.launch {
            runSession(authToken, userEmail.lowercase(), requestId)
        }

        // Hard watchdog — even if every other timeout fails, we stop after
        // PHONE_WS_HOLD_MS + a small slack so we never linger in foreground.
        watchdog = scope.launch {
            delay(PHONE_WS_HOLD_MS + 2_000L)
            Log.d(TAG, "Watchdog elapsed — stopping")
            stopSelfClean()
        }

        return START_NOT_STICKY
    }

    private fun runSession(authToken: String, userEmailLc: String, requestId: String) {
        val client = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS) // WebSocket: no read timeout
            .writeTimeout(5, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
        httpClient = client

        val request = Request.Builder()
            .url(WS_URL)
            .build()

        val listener = object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                Log.d(TAG, "WS open — sending auth")
                val auth = JSONObject().apply {
                    put("type", "auth")
                    put("token", authToken)
                }
                ws.send(auth.toString())
            }

            override fun onMessage(ws: WebSocket, text: String) {
                handleFrame(ws, text, userEmailLc, requestId)
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                // Server only sends JSON text — ignore binary.
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "WS failure: ${t.message}")
                stopSelfClean()
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WS closed: $code $reason")
                stopSelfClean()
            }
        }

        webSocket = client.newWebSocket(request, listener)

        // Auth timeout — if we don't get auth_success in time, bail.
        scope.launch {
            delay(AUTH_TIMEOUT_MS)
            if (!authenticated) {
                Log.w(TAG, "Auth timeout — closing WS")
                webSocket?.close(1000, "auth_timeout")
                stopSelfClean()
            }
        }
    }

    private fun handleFrame(ws: WebSocket, text: String, userEmailLc: String, requestId: String) {
        val obj = try { JSONObject(text) } catch (_: Throwable) { return }
        val type = obj.optString("type")
        when (type) {
            "auth_success" -> {
                Log.d(TAG, "Authenticated as $userEmailLc")
                authenticated = true
                // Subscribe to our personal user channel so relay_request
                // frames can be delivered.
                val sub = JSONObject().apply {
                    put("type", "subscribe")
                    put("channel", "chat_user_$userEmailLc")
                }
                ws.send(sub.toString())
                // Tell server we're ready — it drains the wake-pending queue.
                val ready = JSONObject().apply {
                    put("type", "relay_ready")
                    put("requestId", requestId)
                }
                ws.send(ready.toString())

                // Schedule clean shutdown after PHONE_WS_HOLD_MS.
                scope.launch {
                    delay(PHONE_WS_HOLD_MS)
                    Log.d(TAG, "Hold window elapsed — closing WS")
                    try { ws.close(1000, "wake_done") } catch (_: Throwable) {}
                    stopSelfClean()
                }
            }
            "auth_error" -> {
                Log.w(TAG, "Auth error from WS — stale token. Stopping.")
                stopSelfClean()
            }
            "relay_request" -> {
                // The JS bundle (when alive) owns the actual SQLite read +
                // relay_response. From this native-only path we can't open
                // the database (no JS runtime → no localDb.js). Instead we
                // emit a relay_response with `error: 'js_unavailable'` so
                // the requester knows to retry — typically by the time the
                // retry arrives the JS bundle has booted (the silent push
                // also tickles RN's headless background JS task).
                val reqId = obj.optString("requestId")
                val requester = obj.optString("requester")
                Log.d(TAG, "Native relay_request rcvd requestId=$reqId — responding js_unavailable")
                val resp = JSONObject().apply {
                    put("type", "relay_response")
                    put("requestId", reqId)
                    put("target_email", requester)
                    put("error", "js_unavailable")
                }
                ws.send(resp.toString())
            }
            else -> {
                // Ignore everything else — we're not a full client.
            }
        }
    }

    private fun stopSelfClean() {
        try { webSocket?.close(1000, "done") } catch (_: Throwable) {}
        webSocket = null
        try { httpClient?.dispatcher?.executorService?.shutdown() } catch (_: Throwable) {}
        httpClient = null
        try { watchdog?.cancel() } catch (_: Throwable) {}
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Throwable) {}
        try { stopSelf() } catch (_: Throwable) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        try { scope.cancel() } catch (_: Throwable) {}
        try { webSocket?.close(1000, "destroyed") } catch (_: Throwable) {}
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        // IMPORTANCE_MIN — no sound, no vibration, no heads-up, no badge.
        // The notification still has to exist (FGS requirement) but is
        // invisible to the user in the shade.
        val ch = NotificationChannel(
            CHANNEL_ID,
            "Background sync",
            NotificationManager.IMPORTANCE_MIN
        ).apply {
            description = "Brief background sync when another device requests history."
            setShowBadge(false)
            enableLights(false)
            enableVibration(false)
            setSound(null, null)
        }
        mgr.createNotificationChannel(ch)
    }

    @Suppress("DEPRECATION")
    private fun buildSilentNotification(): Notification {
        // Notification.Builder(Context, channelId) requires API 26+. Below that
        // (we still support API 24/25) the legacy single-arg constructor is
        // the only option — it ignores priority/importance, which is fine
        // for our purposes since the notification is invisible-by-design.
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Channel is IMPORTANCE_MIN — already silences sound + vibration +
            // heads-up. setSilent() is API 29+; redundant when paired with a
            // MIN channel so we drop it to keep the API 26-28 path identical.
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
                .setPriority(Notification.PRIORITY_MIN)
        }
        builder
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("")
            .setContentText("")
            .setOngoing(true)
            .setShowWhen(false)
        // setForegroundServiceBehavior is API 31+ — guard for older devices.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_DEFERRED)
        }
        return builder.build()
    }
}

// ─────────────────────────────────────────────────────────────────────────
// DEPLOYMENT NOTES
// ─────────────────────────────────────────────────────────────────────────
// AndroidManifest entry (added in the same patch):
//   <service
//     android:name=".RelayWakeService"
//     android:exported="false"
//     android:foregroundServiceType="dataSync" />
//
// Permissions: no new ones — FOREGROUND_SERVICE is already declared.
//   (FOREGROUND_SERVICE_DATA_SYNC is added below for Android 14+.)
//
// Tunables:
//   - PHONE_WS_HOLD_MS = 10_000  — how long we keep the raw WS open after
//     subscribing. 10s gives the server's 15s wait window comfortable
//     headroom for one round-trip (push → wake → connect → drain → relay
//     → respond). Bump if mobile network handshake is consistently >3s.
//   - AUTH_TIMEOUT_MS  = 5_000   — bail if auth_success doesn't arrive.
//
// Dependencies: okhttp3 is pulled transitively by io.livekit:livekit-android.
// If LiveKit is ever dropped from the module, add an explicit
//   implementation 'com.squareup.okhttp3:okhttp:4.12.0'
// to build.gradle.
