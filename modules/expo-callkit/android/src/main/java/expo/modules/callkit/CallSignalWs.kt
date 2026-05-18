package expo.modules.callkit

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * [2026-05-16 native call signaling] CallSignalWs
 *
 * Native-side raw WebSocket to wss://ws.chatyy.com.br/ws used to fire the
 * three call-flow control messages without bouncing through the JS bridge:
 *
 *   call_invite     — caller → server when the outgoing call begins
 *   call_answered   — callee → server when CXAnswer fulfils / Aceitar tapped
 *   call_end        — either side, on hangup
 *
 * Today these are fired from JS (services/api.js, IncomingCallListener.js,
 * chat-conversation.js). Stage 1 (this file) only stands up the WS plumbing
 * + a JS-callable bridge in ExpoCallKitModule. Stage 2 wires CallActivity to
 * actually invoke the native methods. The JS-side WS keeps working as
 * fallback throughout — the two paths are idempotent on the server.
 *
 * Connection lifecycle
 * --------------------
 *  * Lazy: nothing happens until a fire*() call arrives.
 *  * The first fire opens the WS, sends {type:"auth", token:<bearer>}, waits
 *    for {type:"auth_success"}, then drains the message queue.
 *  * Subsequent fire*() calls reuse the warm WS (no re-auth).
 *  * If a fire happens before auth_success, the JSON is queued and shipped on
 *    drain. Queue is bounded — 64 entries cap, oldest dropped.
 *  * Disconnect (server close, network) triggers auto-reconnect with backoff:
 *    1s → 2s → 4s, max 3 attempts. After 3 failures we give up; the next
 *    fire*() call resets the attempt counter and tries again. The JS-side WS
 *    handles delivery in the meantime.
 *  * 30s ping interval via OkHttp pingInterval. WhatsApp does ~25s; the
 *    Chatyy Node WS server (server.js) is tolerant.
 *
 * Token rotation
 * --------------
 * The bearer is re-read from SharedPreferences on every (re)connect — JS
 * persists fresh creds via persistAuthForNativeCall on login. If the prefs
 * are empty (logged out) we silently no-op so the JS fallback can decide.
 *
 * Threading
 * ---------
 * All sends are dispatched via a Dispatchers.IO coroutine; callers never
 * block. The OkHttpClient is created once and held in an AtomicReference so
 * it survives activity destruction.
 */
object CallSignalWs {
    private const val TAG = "CallSignalWs"
    private const val PREFS_NAME = "expo_callkit_prefs"
    private const val WS_URL = "wss://ws.chatyy.com.br/ws"
    private const val PING_SEC = 30L
    private const val AUTH_TIMEOUT_MS = 5_000L
    private const val MAX_QUEUE = 64
    private const val MAX_RECONNECT = 3
    private val RECONNECT_BACKOFF_MS = longArrayOf(1_000L, 2_000L, 4_000L)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val clientRef = AtomicReference<OkHttpClient?>(null)
    private val wsRef = AtomicReference<WebSocket?>(null)
    private val authenticated = AtomicBoolean(false)
    private val connecting = AtomicBoolean(false)
    private val reconnectAttempts = AtomicInteger(0)
    private val queue = ConcurrentLinkedQueue<String>()
    private var authTimeoutJob: Job? = null
    private var appContext: Context? = null

    // ─── Public API ────────────────────────────────────────────────────────

    fun fireCallInvite(
        context: Context,
        callId: String,
        conversationId: String,
        calleeEmail: String,
        hasVideo: Boolean
    ) {
        // [P0 regression 2026-05-18 #1122] Server (chatyy-ws-go handleCallInvite)
        // routes the call by reading `target_email` — it ignores `callee_email`
        // and silently bails out when the key is missing, so the callee was
        // never rung. Always emit the canonical `target_email` key. We also
        // keep `callee_email` for older servers that may still expect it.
        val payload = JSONObject().apply {
            put("type", "call_invite")
            put("conversation_id", conversationId)
            put("call_id", callId)
            put("target_email", calleeEmail)
            put("callee_email", calleeEmail)
            put("video", hasVideo)
            put("has_video", hasVideo)
            put("ts", System.currentTimeMillis())
        }.toString()
        enqueueAndShip(context, payload)
    }

    fun fireCallAnswered(
        context: Context,
        callId: String,
        conversationId: String
    ) {
        val payload = JSONObject().apply {
            put("type", "call_answered")
            put("call_id", callId)
            put("conversation_id", conversationId)
            put("ts", System.currentTimeMillis())
        }.toString()
        enqueueAndShip(context, payload)
    }

    fun fireCallEnd(
        context: Context,
        callId: String,
        conversationId: String,
        reason: String
    ) {
        val payload = JSONObject().apply {
            put("type", "call_end")
            put("call_id", callId)
            put("conversation_id", conversationId)
            put("reason", reason)
            put("ts", System.currentTimeMillis())
        }.toString()
        enqueueAndShip(context, payload)
    }

    /**
     * [reaction bar, 2026-05-17] Floating-emoji reaction during an active
     * call. Mirrors fireCallReaction on iOS (CallSignalWs.swift). The LK
     * DataPacket path stays as the primary in-band transport — WS firing
     * is the parity fallback so reactions arrive even if LK data is briefly
     * disrupted. Mirrors the status-reaction WS event pattern.
     */
    fun fireCallReaction(
        context: Context,
        callId: String,
        conversationId: String,
        emoji: String
    ) {
        val payload = JSONObject().apply {
            put("type", "call_reaction")
            put("call_id", callId)
            put("conversation_id", conversationId)
            put("emoji", emoji)
            put("ts", System.currentTimeMillis())
        }.toString()
        enqueueAndShip(context, payload)
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private fun enqueueAndShip(context: Context, json: String) {
        appContext = context.applicationContext
        // Bound the queue — drop oldest if we somehow accumulate (server down,
        // long auth race). The JS-side WS is still firing in parallel today.
        while (queue.size >= MAX_QUEUE) queue.poll()
        queue.offer(json)
        scope.launch { tryFlush() }
    }

    private fun tryFlush() {
        // Already authed? Drain immediately.
        if (authenticated.get()) {
            drainQueue()
            return
        }
        // Connect path is in-flight already — let it drain on auth_success.
        if (connecting.get()) return
        // Reset reconnect counter on a fresh fire call. If we previously gave
        // up after MAX_RECONNECT, this lets the user's next action retry.
        reconnectAttempts.set(0)
        connect()
    }

    private fun connect() {
        if (!connecting.compareAndSet(false, true)) return
        val ctx = appContext ?: run {
            connecting.set(false)
            return
        }
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val token = prefs.getString("auth_token", null)
        if (token.isNullOrEmpty()) {
            Log.d(TAG, "connect: no auth_token in prefs — skipping (JS fallback will fire)")
            connecting.set(false)
            return
        }

        val client = clientRef.get() ?: OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS) // long-lived WS
            .writeTimeout(5, TimeUnit.SECONDS)
            .pingInterval(PING_SEC, TimeUnit.SECONDS)
            .build()
            .also { clientRef.compareAndSet(null, it) }

        val req = Request.Builder().url(WS_URL).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                Log.d(TAG, "WS open — auth")
                val auth = JSONObject().apply {
                    put("type", "auth")
                    put("token", token)
                }.toString()
                ws.send(auth)
                authTimeoutJob?.let { it.cancel() }
                authTimeoutJob = scope.launch {
                    delay(AUTH_TIMEOUT_MS)
                    if (!authenticated.get()) {
                        Log.w(TAG, "auth timeout — closing")
                        ws.close(1000, "auth_timeout")
                    }
                }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                handleFrame(ws, text)
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                // Server is text-only; ignore.
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "WS failure: ${t.message}")
                onDisconnect()
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WS closed: $code $reason")
                onDisconnect()
            }
        }

        try {
            wsRef.set(client.newWebSocket(req, listener))
        } catch (t: Throwable) {
            Log.w(TAG, "newWebSocket failed: ${t.message}")
            connecting.set(false)
            scheduleReconnect()
        }
    }

    private fun handleFrame(ws: WebSocket, text: String) {
        val obj = try { JSONObject(text) } catch (_: Throwable) { return }
        when (obj.optString("type")) {
            "auth_success" -> {
                Log.d(TAG, "auth_success — draining ${queue.size} queued frame(s)")
                authenticated.set(true)
                connecting.set(false)
                reconnectAttempts.set(0)
                authTimeoutJob?.cancel()
                authTimeoutJob = null
                drainQueue()
            }
            "error" -> {
                // Auth/format errors come back as {type:"error", ...} — treat as
                // disconnect so we backoff + retry once. Server-side rate-limit
                // hits land here too.
                Log.w(TAG, "WS error frame: $text")
            }
            // We don't consume any other server-pushed frames; the JS WS owns
            // the real call event surface (incoming_call, call_answered, …).
            else -> { /* no-op */ }
        }
    }

    private fun drainQueue() {
        val ws = wsRef.get() ?: return
        if (!authenticated.get()) return
        while (true) {
            val msg = queue.poll() ?: break
            val ok = try { ws.send(msg) } catch (t: Throwable) {
                Log.w(TAG, "send threw: ${t.message}")
                false
            }
            if (!ok) {
                // Could not enqueue (socket dead / backpressure) — put it back
                // at the head-ish (queue is FIFO so this becomes tail; close
                // enough since we'll auto-reconnect on the next fire).
                queue.offer(msg)
                break
            }
        }
    }

    private fun onDisconnect() {
        authenticated.set(false)
        connecting.set(false)
        wsRef.set(null)
        authTimeoutJob?.cancel()
        authTimeoutJob = null
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (queue.isEmpty()) return // nothing to ship — stay idle
        val attempt = reconnectAttempts.getAndIncrement()
        if (attempt >= MAX_RECONNECT) {
            Log.w(TAG, "reconnect: gave up after $MAX_RECONNECT attempts — JS WS is the fallback")
            return
        }
        val backoff = RECONNECT_BACKOFF_MS[attempt.coerceAtMost(RECONNECT_BACKOFF_MS.size - 1)]
        Log.d(TAG, "reconnect: attempt ${attempt + 1}/$MAX_RECONNECT in ${backoff}ms")
        scope.launch {
            delay(backoff)
            connect()
        }
    }
}
