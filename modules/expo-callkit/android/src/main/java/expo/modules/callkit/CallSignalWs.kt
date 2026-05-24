package expo.modules.callkit

import android.content.Context
import android.content.Intent
import android.os.Build
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

    // [P0 2026-05-18 #1132] Track inbound call_invite IDs we've already
    // surfaced to the ringing service so a re-deliver (server retry, FCM ↔ WS
    // race, multi-device fan-out) doesn't ring twice. Bounded — 32 entries.
    private const val SEEN_INVITES_MAX = 32
    private val seenIncomingInvites: MutableSet<String> =
        java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())

    // [P0 2026-05-18 #1132] When true, the WS stays connected even with an
    // empty outgoing queue, so inbound `call_invite` frames can be received
    // by the callee (who has nothing to send). Flipped on by `warmConnect()`.
    private val keepAlive = AtomicBoolean(false)

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
        // [CALL-TRACE 2026-05-20 WAVE42] Step 4/12 — caller pushes call_invite
        // into the WS outbox. enqueueAndShip will eventually drain to the
        // server (or queue if WS still authenticating). If [4/12] never shows
        // up in logcat it means the native fallback path didn't fire (JS WS
        // alone tried to ship; check services/websocket.js for the JS twin).
        Log.i("CallTrace", "[4/12] WS send call_invite callId=$callId callee=$calleeEmail video=$hasVideo ts=${System.currentTimeMillis()}")
        enqueueAndShip(context, payload)
    }

    fun fireCallAnswered(
        context: Context,
        callId: String,
        conversationId: String,
        callerEmail: String = ""
    ) {
        val payload = JSONObject().apply {
            put("type", "call_answered")
            put("call_id", callId)
            put("conversation_id", conversationId)
            // [WAVE 104C] target_email is required for the C++ WS relay to
            // route this frame to the caller's chat_user_<email> channel and
            // fan it out as call_accepted. Without it the C++ WS has no target
            // and the iOS "Conectando..." UI never transitions to connected.
            if (callerEmail.isNotEmpty()) put("target_email", callerEmail)
            put("ts", System.currentTimeMillis())
        }.toString()
        enqueueAndShip(context, payload)
    }

    fun fireCallEnd(
        context: Context,
        callId: String,
        conversationId: String,
        reason: String,
        targetEmail: String = ""
    ) {
        // [2026-05-24] CRITICAL: target_email is REQUIRED so the C++ WS server
        // can relay the call_end frame to the peer. Without it the server logs
        // "no target — drop" and the OTHER side stays stranded on the call
        // screen — root cause of the "desligo de um lado e o outro nao recebe"
        // bug.
        val payload = JSONObject().apply {
            put("type", "call_end")
            put("call_id", callId)
            put("conversation_id", conversationId)
            put("reason", reason)
            put("ts", System.currentTimeMillis())
            if (targetEmail.isNotEmpty()) {
                val em = targetEmail.lowercase()
                put("target_email", em)
                put("caller_email", em)
            }
        }.toString()
        enqueueAndShip(context, payload)
    }

    /**
     * [P0 2026-05-18 #1132] Open the WS now (if not already open) and keep
     * it open across reconnects so inbound `call_invite` frames can launch
     * `CallRingingService`. JS should call this after login + on app
     * foreground. Idempotent.
     */
    fun warmConnect(context: Context) {
        appContext = context.applicationContext
        keepAlive.set(true)
        scope.launch {
            if (authenticated.get()) return@launch
            if (connecting.get()) return@launch
            reconnectAttempts.set(0)
            connect()
        }
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
        val outer = try { JSONObject(text) } catch (_: Throwable) { return }
        val type = outer.optString("type")
        // [P0 2026-05-21 ROOT-CAUSE-FIX C++ WS envelope]
        //
        // The C++ WS server (/opt/chatyy-ws-cpp/src/main.cpp:166-181 build_frame,
        // live since 2026-05-19 cutover) wraps EVERY broadcast payload as
        // {"type":"call_invite", "data":{call_id, room_id, caller_email, ...}}.
        // This file was authored against the legacy Go WS frame format which
        // delivered fields flat at the top level. Since the C++ cutover, every
        // call_invite / call_end reaching Android via WS dropped silently:
        // `obj.optString("call_id")` returned "" because the real call_id was
        // nested inside `data`.
        //
        // Symptom (visible in logcat): `W CallSignalWs: call_invite: missing
        // call_id/room_id, skipping` — and CallRingingService NEVER started.
        //
        // Result: 3 days where every Android incoming call via WS-active path
        // (callee online) dropped without ringing. The only path that survived
        // was FCM data-message (callee offline), because FCM payloads ARE
        // flat by design.
        //
        // Fix: unwrap the C++ envelope before dispatching. Accept BOTH shapes
        // (data wrapper + legacy flat) so a Go-WS rollback can't re-break us.
        val obj = outer.optJSONObject("data") ?: outer
        when (type) {
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
            "call_invite" -> {
                // [P0 2026-05-18 #1132] Native ring-service fallback for
                // INCOMING calls.
                //
                // Before: only the JS WS (services/websocket.js) handled
                // inbound `call_invite`. If JS was paused/lazy/short-circuited
                // (stale callRef / handlingRef / Suspense not yet committed),
                // the modal never showed and the user heard nothing — even
                // though the server delivered the frame and our raw WS
                // received it (server log: "broadcastToEmail count=1").
                //
                // Now: native CallRingingService kicks off here directly,
                // mirroring the FCM data-message path. The ringing UI ALWAYS
                // shows. JS still has its own subscription (`mailWs.on
                // 'call_invite'`) for the in-app modal; this is belt-and-
                // suspenders so the callee always rings.
                handleIncomingCallInvite(obj)
            }
            "call_accepted", "call_answered" -> {
                // [WAVE 161 2026-05-23] Paridade com iOS WAVE 1349.
                // Caller-side handler when callee taps Accept — flip the
                // outgoing-call native UI from "Chamando…" to "Conectado"
                // BEFORE LK ParticipantConnected fires (saves 200-2000ms).
                //
                // Antes: Android só tinha handlers de call_invite + call_end.
                // call_accepted (sent by callee → relayed by server to caller)
                // foi silenciosamente dropado. Caller ficava em "Chamando…"
                // até LK RoomEvent.ParticipantConnected disparar — funciona
                // mas é mais lento que WhatsApp porque a UI espera o handshake
                // SFU completo. iOS já tinha esse pre-empt (#1349); Android
                // perdeu o paralelo.
                //
                // Agora: broadcast ACTION_CALL_ANSWERED → CallActivity escuta
                // e flippa status imediatamente. Idempotente com o
                // RoomEvent.Connected fallback.
                val callId = obj.optString("call_id").ifEmpty { obj.optString("room_id") }
                Log.d(TAG, "$type $callId — broadcasting ACTION_CALL_ANSWERED")
                try {
                    val intent = Intent("expo.modules.callkit.CALL_ANSWERED")
                    intent.putExtra("call_id", callId)
                    appContext?.sendBroadcast(intent)
                } catch (t: Throwable) {
                    Log.w(TAG, "broadcast CALL_ANSWERED failed: ${t.message}")
                }
            }
            "call_declined", "call_rejected", "call_cancel" -> {
                // [WAVE 161 2026-05-23] Callee rejected, OR caller cancelled
                // before pickup. Tear down native call UI same as call_end.
                // (call_cancel is fired by caller's WS to all callee devices
                // when caller hangs up before pickup — sibling-cancel pattern.)
                Log.d(TAG, "$type — treating as call_end equivalent")
                handleIncomingCallEnd(obj)
            }
            "call_end" -> {
                // [#1179 cleanup, 2026-05-19] Native dismissal fallback for
                // REMOTE hangup.
                //
                // Before: only the JS WS (services/websocket.js) handled
                // inbound `call_end`. If JS was paused (CPU-throttled
                // background, AppState lag, Suspense unmounted), our native
                // CallActivity / IncomingCallActivity / CallRingingService
                // stayed alive — user kept seeing "Calling..." / ringing
                // screen forever even though the peer had ended the call.
                // Worse: LK Room stayed connected, draining mic + data.
                //
                // Now: broadcast ACTION_CLOSE so CallActivity.closeReceiver
                // and IncomingCallActivity.closeReceiver finish themselves
                // (CallActivity's path also fires call_end + Room.disconnect
                // + stopForeground inside finishCall — finishing is now
                // idempotent so the WS echo is harmless). Stop the ringing
                // service and cancel the notification too. JS still has
                // `mailWs.on('call_end')` for in-app UI cleanup; this is
                // belt-and-suspenders so native UIs always come down.
                handleIncomingCallEnd(obj)
            }
            // We don't consume any other server-pushed frames; the JS WS owns
            // the real call event surface (incoming_call, call_answered, …).
            else -> { /* no-op */ }
        }
    }

    /**
     * [#1179 cleanup, 2026-05-19] Native cleanup for inbound `call_end`.
     * Mirrors handleIncomingCallInvite but in reverse — tears down every
     * native UI / service that may be holding the call open. Safe to call
     * even when no call is active (every step is best-effort).
     */
    private fun handleIncomingCallEnd(obj: JSONObject) {
        val ctx = appContext ?: return
        val callId = obj.optString("call_id").ifEmpty { obj.optString("room_id") }
        val reason = obj.optString("reason").ifEmpty { "remote_hangup" }
        Log.d(TAG, "call_end $callId reason=$reason — dismissing native call UIs")

        // 1. Broadcast ACTION_CLOSE — CallActivity and IncomingCallActivity
        //    both listen on this filter and finish themselves cleanly
        //    (CallActivity.closeReceiver → finishCall("close_broadcast")
        //    which tears down LK Room + ongoing FGS; IncomingCallActivity.
        //    closeReceiver → finish()).
        // [2026-05-24] Ghost-disconnect fix: stamp call_id on the broadcast
        // so the receiver only finishes if it matches its OWN active call.
        // Without this, a stale server `call_end` for an old/cancelled call
        // (or a multi-device fan-out from the callee declining a previous
        // session) was tearing down an in-flight outgoing call mid-handshake.
        try {
            val closeIntent = Intent("expo.modules.callkit.CLOSE_CALL_ACTIVITY")
            if (callId.isNotEmpty()) closeIntent.putExtra("call_id", callId)
            ctx.sendBroadcast(closeIntent)
        } catch (t: Throwable) {
            Log.w(TAG, "broadcast CLOSE_CALL_ACTIVITY failed: ${t.message}")
        }

        // 2. Cancel the incoming-call notification (no-op if not posted).
        try {
            CallNotificationService.cancelNotification(ctx, callId)
        } catch (_: Throwable) {}

        // 3. Stop the ringing foreground service explicitly. The activity
        //    closeReceiver doesn't stop the service; if the user never
        //    accepted, the FGS is still ringing.
        try {
            val stopIntent = Intent(ctx, CallRingingService::class.java)
            ctx.stopService(stopIntent)
        } catch (_: Throwable) {}

        // 4. Dedup table: forget this call so a stale retransmit of the
        //    invite (server retry, race) wouldn't be filtered out.
        seenIncomingInvites.remove(callId)
    }

    private fun handleIncomingCallInvite(obj: JSONObject) {
        val ctx = appContext ?: run {
            Log.w(TAG, "call_invite: no appContext (should not happen post-enqueue)")
            return
        }
        val callId = obj.optString("call_id").ifEmpty { obj.optString("room_id") }
        if (callId.isEmpty()) {
            Log.w(TAG, "call_invite: missing call_id/room_id, skipping")
            return
        }
        // Dedup vs server retries + FCM↔WS race + multi-device fan-out.
        // CallRingingService is also idempotent on call_id, but bailing here
        // avoids a redundant startForegroundService spin.
        if (!seenIncomingInvites.add(callId)) {
            Log.d(TAG, "call_invite $callId: already surfaced, skipping")
            return
        }
        // FIFO trim — ConcurrentHashMap.newKeySet doesn't preserve insertion
        // order, so we cap via best-effort eviction. The Set's contains() is
        // O(1) regardless, so size doesn't hurt lookup speed.
        if (seenIncomingInvites.size > SEEN_INVITES_MAX) {
            try {
                val it = seenIncomingInvites.iterator()
                while (seenIncomingInvites.size > SEEN_INVITES_MAX && it.hasNext()) {
                    it.next(); it.remove()
                }
            } catch (_: Throwable) { /* best-effort */ }
        }

        val callerEmail = obj.optString("caller_email")
        val callerName = obj.optString("caller_name").ifEmpty { callerEmail }
        val conversationId = obj.optString("conversation_id")
        // [CALL-TRACE 2026-05-20 WAVE42] Step 6/12 — callee's WS picks up the
        // call_invite frame. If you see [4/12] (caller side) but no [6/12]
        // on the callee device the server didn't fan the frame out — check
        // chatyy-ws-cpp (or fallback go) broadcastToEmail logs.
        Log.i("CallTrace", "[6/12] WS recv call_invite callId=$callId fromCallerEmail=$callerEmail conv=$conversationId ts=${System.currentTimeMillis()}")
        val hasVideo: Boolean = when {
            obj.has("video") -> {
                val v = obj.opt("video")
                when (v) {
                    is Boolean -> v
                    is Number -> v.toInt() != 0
                    is String -> v == "1" || v.equals("true", ignoreCase = true)
                    else -> false
                }
            }
            obj.has("has_video") -> obj.optBoolean("has_video", false)
            else -> false
        }

        // Self-echo guard — should never happen server-side but harden.
        if (callerEmail.isNotEmpty()) {
            try {
                val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                val selfEmail = prefs.getString("user_email", null)?.lowercase()
                if (selfEmail != null && callerEmail.lowercase() == selfEmail) {
                    Log.d(TAG, "call_invite $callId: self-echo, skipping")
                    return
                }
            } catch (_: Throwable) { /* fall through */ }
        }

        // [foreground gate, 2026-05-21] WhatsApp/Telegram parity for INCOMING.
        // If the app is currently in the foreground, the JS WS subscription
        // (services/websocket.js → IncomingCallListener.js `mailWs.on
        // 'call_invite'`) already received this same frame and is rendering
        // the rich in-app IncomingCallSheet (avatar + accept/decline + ringtone).
        // Launching CallRingingService → IncomingCallActivity → CallActivity
        // on top stacks two ringing UIs and creates the "2 telas" feedback
        // (incidente 2026-05-12). Mirrors the gate that
        // CallFirebaseMessagingService applies for FCM-driven invites — the
        // WS-driven path was the last branch missing it.
        //
        // BACKGROUND / KILLED app keeps the native ring path so the OS-level
        // lock-screen FSI can still ring even when JS is paused or unloaded.
        val appForeground = try {
            ExpoCallKitModule.isAppForeground || isProcessForeground(ctx)
        } catch (_: Throwable) { false }
        if (appForeground) {
            Log.d(TAG, "call_invite $callId: app foreground — JS WS handler owns the UI, skipping native ring")
            // Best-effort: also nudge ExpoCallKitModule so any onIncomingCall
            // listener wired through the module gets a copy (parity with the
            // VoIP push path on iOS). JS-side primary surface remains the
            // mailWs `call_invite` subscription.
            try {
                ExpoCallKitModule.emitIncomingCallForeground(
                    callId, callerName, callerEmail, conversationId, hasVideo
                )
            } catch (_: Throwable) { /* best-effort */ }
            return
        }

        Log.d(TAG, "call_invite $callId from $callerEmail — launching CallRingingService")
        try {
            val serviceIntent = Intent(ctx, CallRingingService::class.java).apply {
                putExtra("call_id", callId)
                putExtra("caller_name", callerName)
                putExtra("has_video", hasVideo)
                putExtra("caller_email", callerEmail)
                putExtra("conversation_id", conversationId)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(serviceIntent)
            } else {
                ctx.startService(serviceIntent)
            }
        } catch (e: Throwable) {
            Log.e(TAG, "call_invite $callId: startForegroundService failed — falling back to notification", e)
            try {
                CallNotificationService.showIncomingCallNotification(
                    ctx,
                    callId,
                    callerName,
                    hasVideo,
                    callerEmail,
                    conversationId
                )
            } catch (e2: Throwable) {
                Log.e(TAG, "call_invite $callId: notification fallback also failed", e2)
            }
        }
    }

    /**
     * [foreground gate, 2026-05-21] ActivityManager-based process foreground
     * check mirroring CallFirebaseMessagingService.isProcessForeground. The
     * `ExpoCallKitModule.isAppForeground` flag is set by Activity lifecycle
     * hooks which can lag by 50-500ms on Android (AppState race on first
     * resume from cold), so we use this complement to avoid a brief window
     * where the flag is still false even though the user has the app open.
     */
    private fun isProcessForeground(ctx: Context): Boolean {
        return try {
            val am = ctx.applicationContext.getSystemService(Context.ACTIVITY_SERVICE)
                as? android.app.ActivityManager ?: return false
            val procs = am.runningAppProcesses ?: return false
            val myPkg = ctx.applicationContext.packageName
            for (p in procs) {
                if (p.processName != myPkg) continue
                // IMPORTANCE_VISIBLE accepted (matches FCM path) — covers
                // app-behind-system-dialog / app-in-Recents.
                if (p.importance <= android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE) {
                    return true
                }
            }
            false
        } catch (e: Exception) {
            Log.w(TAG, "isProcessForeground check failed: ${e.message}")
            false
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
        // Idle: stop reconnecting unless we're in keep-alive mode (callee
        // path — needs to receive inbound call_invite frames even with an
        // empty outgoing queue).
        if (queue.isEmpty() && !keepAlive.get()) return
        val attempt = reconnectAttempts.getAndIncrement()
        if (attempt >= MAX_RECONNECT) {
            if (keepAlive.get()) {
                // Keep-alive mode: never give up entirely — slow-retry every
                // 30s. The JS WS is still the primary path; this is the
                // native ring fallback for inbound call_invite.
                Log.w(TAG, "keep-alive: $MAX_RECONNECT attempts spent — slow retry in 30s")
                reconnectAttempts.set(0)
                scope.launch {
                    delay(30_000L)
                    connect()
                }
                return
            }
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
