package expo.modules.callkit

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * [2026-10-07 native-core] ChatCoreSocket — phase 1 of the native messaging core.
 *
 * WhatsApp / Signal / Telegram keep the connection + local store in native
 * code; the UI only renders the store. Phase 1 here is a SHADOW socket:
 *   - opened only while the app is visible (JS calls start() on AppState
 *     'active', stop() on 'background'; native also refuses to (re)connect
 *     when ChatNotifStore.isAppVisibleToUser() is false);
 *   - authenticates with the same protocol as services/websocket.js
 *     ({type:auth, token, instance_id, device_id, client, platform} →
 *     auth_success → {type:resume, last_event_id} → app-level ping/pong);
 *   - for each chat_message / chat_summary frame appends ONE line to the
 *     existing ChatBgJournal (src="ws") and emits a JS event; receipts
 *     (message_delivered / message_read) are only emitted + counted (the
 *     journal line format is message-only — a receipt line would be merged as
 *     a message by services/bgJournal.js);
 *   - never SENDS anything but auth/resume/ping (no acks, no typing, no
 *     presence subscriptions, no chat sends). The JS socket keeps doing all
 *     of that unchanged.
 *
 * The hub (chatyy-ws-go) allows 16 sockets per e-mail and only supersedes
 * sockets with the SAME instance_id → this socket uses its own
 * "nc-…" instance id, so it never kicks the JS socket (and vice-versa).
 * resume on the hub is read-only (ws_event_log replay) → no side effects on
 * the JS socket's delivery.
 *
 * Nothing here runs unless JS calls start() (NATIVE_CORE_ENABLED flag).
 *
 * [2026-10-08 native-core-2] Phase 2 groundwork (JS flag NATIVE_CORE_PRIMARY,
 * default OFF — nothing below runs unless JS calls setPrimary(true) /
 * sendText()):
 *   - PRIMARY frames: while primary, every frame carrying a per-user
 *     `event_id` (ws_event_log → chat_message / chat_summary / receipts /
 *     edits / deletes …) is forwarded RAW to JS ("onChatCoreRaw"); JS injects
 *     it into services/websocket.js with a shared event_id dedup (first socket
 *     wins). Control frames (auth/resume/pong/send acks) are never forwarded.
 *   - NATIVE OUTBOX (text): sendText() queues a hub `chat_send` frame
 *     (native_send.go, gated by the `native_send` cap of auth_success),
 *     persisted in prefs (per account, cap 50, TTL 24h), sent when the socket
 *     is authenticated, re-sent with the SAME client_message_id after every
 *     reconnect (hub + PHP dedup by sender+cmi). chat_send_ack /
 *     chat_send_fallback → entry removed + "onChatCoreAck" to JS. JS can
 *     cancelSend(cmi) when it gives up and goes HTTP (same cmi).
 *   - The hub treats this socket as client "native-core": no presence, no
 *     initial_data, no offline-queue flush, no call/live/presence/typing
 *     frames, own 4-socket cap (never evicts the JS socket).
 */
object ChatCoreSocket {
    private const val TAG = "ChatCoreSocket"
    // [2026-10-09 native-transport] URL por conexão = ChatyyWsEndpoint.pick()
    // (entrada regional api-br/api-eu escolhida pelo JS, fallback US).
    @Volatile private var wsUrlCur: String? = null
    private const val PREFS = "chatyy_chat_core"
    private const val KEY_LAST_EVENT = "last_event_id"
    private const val KEY_LAST_EVENT_ACCT = "last_event_acct"
    private const val PING_MS = 25_000L
    private const val PONG_DEADLINE_MS = 10_000L
    private const val AUTH_WATCHDOG_MS = 6_000L
    private const val INVISIBLE_GRACE_MS = 60_000L
    private val BACKOFF_MS = longArrayOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L)
    private const val SEEN_MAX = 1024
    private const val KEY_OUTBOX = "outbox_v1"
    private const val OUTBOX_MAX = 50
    private const val OUTBOX_TTL_MS = 24L * 60L * 60L * 1000L
    /** Frames never forwarded raw to JS (control / per-socket replies). */
    private val CONTROL_TYPES = setOf(
        "auth_success", "auth_error", "welcome", "pong", "resume_result", "resume_complete",
        "resume_full_sync", "session_replaced", "superseded", "server_shutdown",
        "chat_send_ack", "chat_send_fallback", "subscribed", "msgpack_upgraded",
    )

    /** Native → module bridge (set by ChatCoreModule OnCreate, cleared OnDestroy). */
    interface Listener {
        fun onFrame(body: Map<String, Any?>)
        fun onState(body: Map<String, Any?>)
        /** [phase 2] raw per-user frame (only while primary). */
        fun onRaw(body: Map<String, Any?>) {}
        /** [phase 2] outbox result (chat_send_ack / chat_send_fallback / local fail). */
        fun onAck(body: Map<String, Any?>) {}
    }

    /** [phase 2] one queued text send (hub `chat_send` frame, JSON string). */
    private class OutItem(
        val cmi: String,
        val acct: String,
        val frame: String,
        val createdAt: Long,
        var sentAt: Long = 0L,
        var tries: Int = 0,
    )

    @Volatile var listener: Listener? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val clientRef = AtomicReference<OkHttpClient?>(null)
    private val wsRef = AtomicReference<WebSocket?>(null)
    private val enabled = AtomicBoolean(false)
    private val connecting = AtomicBoolean(false)
    private val authed = AtomicBoolean(false)
    private val attempts = AtomicInteger(0)
    private val lastEventId = AtomicLong(0L)
    private val lastPongAt = AtomicLong(0L)
    private val pingSentAt = AtomicLong(0L)
    private val invisibleSince = AtomicLong(0L)
    @Volatile private var appCtx: Context? = null
    @Volatile private var expectedAcct: String = ""
    @Volatile private var authedAcct: String = ""
    @Volatile private var instanceId: String = ""
    @Volatile private var deviceId: String = ""
    private var reconnectJob: Job? = null
    private var watchdogJob: Job? = null
    private var pingJob: Job? = null
    private var eventsSinceFlush = 0
    // [phase 2]
    @Volatile private var primary = false
    private val caps = AtomicReference<Set<String>>(emptySet())
    private val outbox = LinkedHashMap<String, OutItem>() // guarded by synchronized(outbox)
    @Volatile private var outboxLoaded = false

    // Stats (parity / diagnostics). Reset on start().
    private val stats = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val seenMids = object : LinkedHashMap<String, Boolean>(64, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?): Boolean = size > SEEN_MAX
    }

    private fun bump(k: String, by: Long = 1L) { stats.merge(k, by) { a, b -> a + b } }

    // ─── Public API (called from ChatCoreModule) ──────────────────────────

    /**
     * Start (or keep) the shadow socket. [acct] = active account (JS view),
     * [jsLastEventId] seeds the resume cursor the first time (so we don't
     * replay 200 old events), [devId] is diagnostics only.
     */
    @Synchronized
    fun start(ctx: Context, acct: String, jsLastEventId: Long, devId: String) {
        appCtx = ctx.applicationContext
        val a = ChatNotifStore.normEmail(acct)
        if (a != expectedAcct) {
            // Account switched → the socket (if any) belongs to the old bearer,
            // and the resume cursor belongs to the old account.
            closeSocket("acct_switch")
            authedAcct = ""
            lastEventId.set(0L)
        }
        expectedAcct = a
        deviceId = devId
        if (instanceId.isEmpty()) {
            instanceId = "nc-" + java.lang.Long.toString(System.currentTimeMillis(), 36) +
                java.lang.Long.toString((Math.random() * 1e9).toLong(), 36)
        }
        // Resume cursor: our own persisted one for this account, else the JS one.
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        var stored = 0L
        if ((sp.getString(KEY_LAST_EVENT_ACCT, "") ?: "") == a) stored = sp.getLong(KEY_LAST_EVENT, 0L)
        lastEventId.set(maxOf(lastEventId.get(), stored, jsLastEventId))
        loadOutbox(ctx)
        if (enabled.getAndSet(true) && (authed.get() || connecting.get())) {
            scope.launch { flushOutbox() }
            return
        }
        attempts.set(0)
        stats.clear()
        startPingLoop()
        scope.launch { connect() }
    }

    @Synchronized
    fun stop(reason: String) {
        enabled.set(false)
        reconnectJob?.cancel(); reconnectJob = null
        pingJob?.cancel(); pingJob = null
        persistLastEventId(true)
        closeSocket(reason)
    }

    fun isRunning(): Boolean = enabled.get()

    // ─── [phase 2] Primary + outbox API ───────────────────────────────────

    /** JS (NATIVE_CORE_PRIMARY) — forward raw per-user frames while true. */
    fun setPrimary(on: Boolean) {
        primary = on
        bump(if (on) "primary_on" else "primary_off")
    }

    /**
     * Queue a text send. [frameJson] must be a hub `chat_send` frame with the
     * same client_message_id as [cmi]. Returns false when rejected locally
     * (bad frame / full) → JS uses its own path.
     */
    fun sendText(ctx: Context, acct: String, cmi: String, frameJson: String): Boolean {
        appCtx = ctx.applicationContext
        loadOutbox(ctx)
        val a = ChatNotifStore.normEmail(acct)
        if (a.isEmpty() || cmi.isEmpty() || cmi.length > 128 || frameJson.length > 64 * 1024) return false
        val ok = try {
            val o = JSONObject(frameJson)
            o.optString("type") == "chat_send" && o.optString("client_message_id") == cmi
        } catch (_: Throwable) { false }
        if (!ok) { bump("outbox_reject"); return false }
        synchronized(outbox) {
            if (!outbox.containsKey(cmi)) {
                if (outbox.size >= OUTBOX_MAX) { bump("outbox_full"); return false }
                outbox[cmi] = OutItem(cmi, a, frameJson, System.currentTimeMillis())
            }
        }
        bump("outbox_add")
        persistOutbox()
        scope.launch { flushOutbox() }
        return true
    }

    /** JS gave up on the native path (timeout → HTTP with the same cmi). */
    fun cancelSend(cmi: String) {
        val removed = synchronized(outbox) { outbox.remove(cmi) != null }
        if (removed) { bump("outbox_cancel"); persistOutbox() }
    }

    fun snapshot(): Map<String, Any?> {
        val m = HashMap<String, Any?>()
        m["enabled"] = enabled.get()
        m["connecting"] = connecting.get()
        m["authenticated"] = authed.get()
        m["acct"] = authedAcct
        m["lastEventId"] = lastEventId.get().toDouble()
        m["instanceId"] = instanceId
        m["primary"] = primary
        m["caps"] = caps.get().toList()
        m["outbox"] = synchronized(outbox) { outbox.size }.toDouble()
        val s = HashMap<String, Any?>()
        for ((k, v) in stats) s[k] = v.toDouble()
        m["stats"] = s
        return m
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private fun emitState(state: String, extra: Map<String, Any?> = emptyMap()) {
        val body = HashMap<String, Any?>(extra)
        body["state"] = state
        body["at"] = System.currentTimeMillis().toDouble()
        try { listener?.onState(body) } catch (_: Throwable) {}
    }

    private fun closeSocket(reason: String) {
        watchdogJob?.cancel(); watchdogJob = null
        authed.set(false)
        connecting.set(false)
        markOutboxUnsent()
        val ws = wsRef.getAndSet(null) ?: return
        try { ws.close(1000, reason.take(60)) } catch (_: Throwable) {}
        emitState("closed", mapOf("reason" to reason))
    }

    private fun client(): OkHttpClient {
        clientRef.get()?.let { return it }
        val c = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .pingInterval(30, TimeUnit.SECONDS)
            .build()
        clientRef.compareAndSet(null, c)
        return clientRef.get() ?: c
    }

    private fun connect() {
        if (!enabled.get()) return
        if (authed.get() && wsRef.get() != null) return
        val ctx = appCtx ?: return
        if (!ChatNotifStore.isAppVisibleToUser(ctx)) {
            // Phase 1 = foreground only. JS start() on the next 'active' retries.
            bump("skip_invisible")
            return
        }
        if (!connecting.compareAndSet(false, true)) return
        wsRef.getAndSet(null)?.let { old -> try { old.cancel() } catch (_: Throwable) {} }
        val token = ChatNotifStore.bearerFor(ctx, expectedAcct)
        if (token.isNullOrEmpty()) {
            connecting.set(false)
            bump("no_bearer")
            emitState("no_bearer")
            return
        }
        bump("connect")
        emitState("connecting")
        val wsUrl = ChatyyWsEndpoint.pick(ctx)
        wsUrlCur = wsUrl
        val req = Request.Builder().url(wsUrl).build()
        val listenerObj = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val cur = wsRef.get()
                if (cur != null && cur !== webSocket) return
                val auth = JSONObject()
                auth.put("type", "auth")
                auth.put("token", token)
                auth.put("instance_id", instanceId)
                auth.put("device_id", deviceId)
                auth.put("client", "native-core")
                auth.put("platform", "android")
                webSocket.send(auth.toString())
                watchdogJob?.cancel()
                watchdogJob = scope.launch {
                    delay(AUTH_WATCHDOG_MS)
                    if (wsRef.get() === webSocket && !authed.get()) {
                        Log.w(TAG, "auth watchdog — reconnect")
                        bump("auth_watchdog")
                        try { webSocket.cancel() } catch (_: Throwable) {}
                        onDisconnect(webSocket, "auth_watchdog")
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!enabled.get()) return
                val cur = wsRef.get()
                if (cur != null && cur !== webSocket) return
                handleFrame(webSocket, text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // JSON-only socket (we never ask for msgpack/CWP).
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                try { webSocket.close(1000, null) } catch (_: Throwable) {}
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onDisconnect(webSocket, "closed_$code")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "failure: ${t.message}")
                onDisconnect(webSocket, "failure")
            }
        }
        try {
            val ws = client().newWebSocket(req, listenerObj)
            wsRef.set(ws)
        } catch (t: Throwable) {
            Log.w(TAG, "newWebSocket failed: ${t.message}")
            connecting.set(false)
            scheduleReconnect()
        }
    }

    private fun onDisconnect(ws: WebSocket, why: String) {
        // Callback of a socket that is no longer the current one → ignore.
        if (!wsRef.compareAndSet(ws, null)) return
        watchdogJob?.cancel(); watchdogJob = null
        if (!authed.get()) ChatyyWsEndpoint.noteFailedBeforeAuth(wsUrlCur)
        authed.set(false)
        connecting.set(false)
        bump("disconnect")
        emitState("closed", mapOf("reason" to why))
        persistLastEventId(true)
        markOutboxUnsent()
        scheduleReconnect()
    }

    @Synchronized
    private fun scheduleReconnect() {
        if (!enabled.get()) return
        if (reconnectJob?.isActive == true) return
        val n = attempts.getAndIncrement()
        val wait = BACKOFF_MS[minOf(n, BACKOFF_MS.size - 1)]
        reconnectJob = scope.launch {
            delay(wait)
            connect()
        }
    }

    private fun startPingLoop() {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (isActive && enabled.get()) {
                delay(PING_MS)
                val ctx = appCtx
                // Foreground-only guard (JS 'background' stop() may never arrive
                // if the JS thread is frozen): invisible for > grace → close.
                if (ctx != null && !ChatNotifStore.isAppVisibleToUser(ctx)) {
                    val since = invisibleSince.get()
                    if (since == 0L) invisibleSince.set(System.currentTimeMillis())
                    else if (System.currentTimeMillis() - since > INVISIBLE_GRACE_MS && wsRef.get() != null) {
                        bump("close_invisible")
                        persistLastEventId(true)
                        closeSocket("invisible")
                    }
                    continue
                }
                invisibleSince.set(0L)
                val ws = wsRef.get()
                if (ws == null) {
                    if (!connecting.get()) { attempts.set(0); connect() }
                    continue
                }
                if (!authed.get()) continue
                val sentAt = System.currentTimeMillis()
                pingSentAt.set(sentAt)
                try { ws.send(JSONObject().put("type", "ping").put("ts", sentAt).toString()) } catch (_: Throwable) {}
                launch {
                    delay(PONG_DEADLINE_MS)
                    if (wsRef.get() === ws && authed.get() && lastPongAt.get() < sentAt) {
                        Log.w(TAG, "pong deadline — reconnect")
                        bump("pong_timeout")
                        try { ws.cancel() } catch (_: Throwable) {}
                        onDisconnect(ws, "pong_timeout")
                    }
                }
            }
        }
    }

    private fun persistLastEventId(force: Boolean) {
        val ctx = appCtx ?: return
        if (!force && eventsSinceFlush < 10) return
        eventsSinceFlush = 0
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong(KEY_LAST_EVENT, lastEventId.get())
                .putString(KEY_LAST_EVENT_ACCT, if (authedAcct.isNotEmpty()) authedAcct else expectedAcct)
                .apply()
        } catch (_: Throwable) {}
    }

    private fun handleFrame(ws: WebSocket, text: String) {
        val msg = try { JSONObject(text) } catch (_: Throwable) { return }
        val type = msg.optString("type", "")
        bump("rx")
        val ev = msg.optLong("event_id", 0L)
        if (ev > 0L) {
            var advanced = false
            while (true) {
                val cur = lastEventId.get()
                if (ev <= cur) break
                if (lastEventId.compareAndSet(cur, ev)) { advanced = true; break }
            }
            if (advanced) {
                eventsSinceFlush++
                persistLastEventId(false)
            }
        }
        // [phase 2] raw forward of per-user frames while primary.
        if (primary && ev > 0L && type.isNotEmpty() && type !in CONTROL_TYPES) {
            bump("raw_fwd")
            val body = HashMap<String, Any?>()
            body["raw"] = text
            body["type"] = type
            body["eventId"] = ev.toDouble()
            body["at"] = System.currentTimeMillis().toDouble()
            try { listener?.onRaw(body) } catch (_: Throwable) {}
        }
        when (type) {
            "auth_success" -> {
                val email = ChatNotifStore.normEmail(msg.optString("email", ""))
                if (expectedAcct.isNotEmpty() && email.isNotEmpty() && email != expectedAcct) {
                    // Bearer in prefs belongs to another account → never journal
                    // with the wrong owner. JS restarts us on the next switch.
                    Log.w(TAG, "auth acct mismatch ($email != $expectedAcct) — stopping")
                    bump("acct_mismatch")
                    emitState("acct_mismatch", mapOf("email" to email))
                    stop("acct_mismatch")
                    return
                }
                authedAcct = if (email.isNotEmpty()) email else expectedAcct
                authed.set(true)
                ChatyyWsEndpoint.noteAuthed(wsUrlCur)
                connecting.set(false)
                attempts.set(0)
                watchdogJob?.cancel(); watchdogJob = null
                lastPongAt.set(System.currentTimeMillis())
                bump("auth_ok")
                val capsArr = msg.optJSONArray("caps")
                val cs = HashSet<String>()
                if (capsArr != null) for (i in 0 until minOf(capsArr.length(), 32)) cs.add(capsArr.optString(i, ""))
                caps.set(cs)
                emitState("authenticated", mapOf("email" to authedAcct, "caps" to cs.toList()))
                sendResume(ws)
                scope.launch { flushOutbox() }
            }
            "chat_send_ack", "chat_send_fallback" -> onSendResult(type, msg, text)
            "auth_error" -> {
                bump("auth_error")
                val fatal = msg.optBoolean("fatal", false) || msg.optString("reason") == "logged_out"
                emitState(if (fatal) "fatal" else "auth_error", mapOf("reason" to msg.optString("reason", "")))
                if (fatal) stop("logged_out")
                // non-fatal → server closes; onDisconnect backs off and re-reads the bearer.
            }
            "pong" -> lastPongAt.set(System.currentTimeMillis())
            "session_replaced" -> {
                // Evicted (16-socket cap). Don't fight for the slot in phase 1.
                bump("session_replaced")
                emitState("replaced")
                stop("session_replaced")
            }
            "resume_result" -> {
                val l = msg.optLong("last_event_id", 0L)
                if (l > lastEventId.get()) lastEventId.set(l)
                persistLastEventId(true)
                bump("resume_replayed", msg.optLong("count", 0L))
                if (msg.optBoolean("has_more", false)) sendResume(ws)
            }
            "resume_complete" -> bump("resume_replayed", msg.optLong("count", 0L))
            "resume_full_sync" -> {
                val cur = msg.optLong("current_event_id", 0L)
                if (cur > lastEventId.get()) lastEventId.set(cur)
                persistLastEventId(true)
                bump("resume_full_sync")
                emitState("full_sync", mapOf("reason" to msg.optString("reason", "")))
            }
            "chat_message", "chat_summary" -> onChatFrame(type, msg, ev)
            "message_delivered", "message_read" -> onReceiptFrame(type, msg, ev)
            else -> {}
        }
    }

    private fun sendResume(ws: WebSocket) {
        try {
            ws.send(JSONObject().put("type", "resume").put("last_event_id", lastEventId.get()).toString())
        } catch (_: Throwable) {}
    }

    /** chat_message / chat_summary → journal line + JS event. */
    private fun onChatFrame(type: String, msg: JSONObject, ev: Long) {
        bump(type)
        val data = msg.optJSONObject("data") ?: msg
        val row = data.optJSONObject("message") ?: data
        val mid = row.optLong("id", 0L)
        var cid = row.optLong("conversation_id", 0L)
        if (cid <= 0L) cid = data.optLong("conversation_id", 0L)
        if (mid <= 0L || cid <= 0L) { bump("chat_unparsed"); return }
        val key = "$cid:$mid"
        val enriched = row.has("thumb_b64") || row.has("thumbnail_url") || row.has("width")
        val dup = synchronized(seenMids) {
            val d = seenMids.containsKey(key)
            if (!d) seenMids[key] = true
            d
        }
        var journaled = false
        val ctx = appCtx
        if (!dup && ctx != null) {
            val acct = if (authedAcct.isNotEmpty()) authedAcct else expectedAcct
            val line = ChatBgJournal.lineFromSyncRow(acct, cid.toString(), row)
            if (line != null) {
                val withSrc = try {
                    val o = JSONObject(line)
                    o.put("src", "ws")
                    val sn = if (row.isNull("sender_name")) "" else row.optString("sender_name", "")
                    if (sn.isNotEmpty() && o.optString("full") == "1") o.put("sname", sn)
                    o.toString()
                } catch (_: Throwable) { line }
                journaled = ChatBgJournal.appendLines(ctx, listOf(withSrc)) > 0
                if (journaled) bump("journaled") else bump("journal_skip")
            }
        } else if (dup) bump("dup")
        val body = HashMap<String, Any?>()
        body["type"] = type
        body["cid"] = cid.toDouble()
        body["mid"] = mid.toDouble()
        body["eventId"] = ev.toDouble()
        body["sender"] = row.optString("sender_email", "")
        body["dup"] = dup
        body["enriched"] = enriched
        body["journaled"] = journaled
        body["at"] = System.currentTimeMillis().toDouble()
        try { listener?.onFrame(body) } catch (_: Throwable) {}
    }

    // ─── [phase 2] Outbox internals ──────────────────────────────────────

    private fun emitAck(cmi: String, ok: Boolean, reason: String, raw: String?) {
        val body = HashMap<String, Any?>()
        body["cmi"] = cmi
        body["ok"] = ok
        body["reason"] = reason
        if (raw != null) body["raw"] = raw
        body["at"] = System.currentTimeMillis().toDouble()
        try { listener?.onAck(body) } catch (_: Throwable) {}
    }

    private fun onSendResult(type: String, msg: JSONObject, text: String) {
        val cmi = msg.optString("client_message_id", "")
        if (cmi.isEmpty()) return
        val removed = synchronized(outbox) { outbox.remove(cmi) != null }
        if (removed) persistOutbox()
        val ok = type == "chat_send_ack" && msg.optBoolean("success", true)
        bump(if (ok) "send_ack" else "send_fallback")
        emitAck(cmi, ok, if (ok) "" else msg.optString("reason", "fallback"), text)
    }

    private fun markOutboxUnsent() {
        synchronized(outbox) { for (it in outbox.values) it.sentAt = 0L }
    }

    private fun flushOutbox() {
        val ws = wsRef.get() ?: return
        if (!authed.get()) return
        val acct = authedAcct
        if (acct.isEmpty()) return
        val now = System.currentTimeMillis()
        val canSend = caps.get().contains("native_send")
        val toSend = ArrayList<OutItem>()
        val failed = ArrayList<Pair<String, String>>()
        synchronized(outbox) {
            val it = outbox.values.iterator()
            while (it.hasNext()) {
                val o = it.next()
                if (now - o.createdAt > OUTBOX_TTL_MS) { failed.add(o.cmi to "expired"); it.remove(); continue }
                if (o.acct != acct) continue // other account's bearer — wait for it
                if (!canSend) { failed.add(o.cmi to "no_caps"); it.remove(); continue }
                if (o.sentAt == 0L) { o.sentAt = now; o.tries++; toSend.add(o) }
            }
        }
        if (failed.isNotEmpty()) persistOutbox()
        for ((cmi, why) in failed) { bump("send_local_fail"); emitAck(cmi, false, why, null) }
        for (o in toSend) {
            val sent = try { ws.send(o.frame) } catch (_: Throwable) { false }
            if (sent) bump("send_tx") else synchronized(outbox) { o.sentAt = 0L }
        }
    }

    private fun loadOutbox(ctx: Context) {
        if (outboxLoaded) return
        synchronized(outbox) {
            if (outboxLoaded) return
            outboxLoaded = true
            try {
                val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_OUTBOX, null) ?: return
                val arr = org.json.JSONArray(raw)
                val now = System.currentTimeMillis()
                for (i in 0 until minOf(arr.length(), OUTBOX_MAX)) {
                    val o = arr.optJSONObject(i) ?: continue
                    val cmi = o.optString("cmi", "")
                    val created = o.optLong("at", 0L)
                    if (cmi.isEmpty() || now - created > OUTBOX_TTL_MS) continue
                    outbox[cmi] = OutItem(cmi, o.optString("acct", ""), o.optString("frame", ""), created)
                }
            } catch (_: Throwable) {}
        }
    }

    private fun persistOutbox() {
        val ctx = appCtx ?: return
        try {
            val arr = org.json.JSONArray()
            synchronized(outbox) {
                for (o in outbox.values) {
                    arr.put(JSONObject().put("cmi", o.cmi).put("acct", o.acct).put("frame", o.frame).put("at", o.createdAt))
                }
            }
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_OUTBOX, arr.toString()).apply()
        } catch (_: Throwable) {}
    }

    private fun onReceiptFrame(type: String, msg: JSONObject, ev: Long) {
        bump(type)
        val data = msg.optJSONObject("data") ?: msg
        val body = HashMap<String, Any?>()
        body["type"] = type
        body["cid"] = data.optLong("conversation_id", 0L).toDouble()
        body["mid"] = data.optLong("message_id", 0L).toDouble()
        body["eventId"] = ev.toDouble()
        body["at"] = System.currentTimeMillis().toDouble()
        try { listener?.onFrame(body) } catch (_: Throwable) {}
    }
}
