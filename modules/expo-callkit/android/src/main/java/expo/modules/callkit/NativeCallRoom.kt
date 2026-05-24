package expo.modules.callkit

import android.content.Context
import android.content.Intent
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * NativeCallRoom — singleton holder for the LiveKit Room owned by CallActivity.
 *
 * The motivation (#1207, 2026-05-19): until today, CallActivity created its
 * own LK Room and JS `/call.js` created a SECOND Room with the same identity
 * on the same SFU room. Both connected, both tried to publish mic, the SFU
 * issued "duplicate identity" eviction signals → audio fighting, mute desync,
 * "no audio" on Android receiver, ghost participants. The `adoptNativeRoom()`
 * AsyncFunction always returned `null` because the previous stub had no live
 * Room reference, so the JS fallback path always ran.
 *
 * The fix: CallActivity calls [publish] after `LiveKit.create(...)` + the
 * `r.connect(...)` coroutine kicks off, handing the live Room to this
 * singleton. `adoptNativeRoom()` now returns a real snapshot when the call
 * matches, JS skips its own Room.connect, and the second Room never spawns.
 *
 * Lifecycle is bound to CallActivity:
 *   - `publish(room, callId, roomName, context)` — called from
 *     CallActivity.bringUpRoom right after LiveKit.create + room = r.
 *   - `clear()` — called from CallActivity.onDestroy (and finishCall) so
 *     stale snapshots don't survive past the call.
 *
 * Event forwarding: we attach a `room.events.collect { }` listener on a
 * SupervisorJob coroutine so JS subscribers via ExpoCallKitModule.emit*
 * receive the same RoomEvent stream CallActivity handles. CallActivity ALSO
 * subscribes to room.events for its own Compose state — both subscribers
 * coexist (LiveKit's events flow is multi-subscriber safe).
 */
object NativeCallRoom {
    private const val TAG = "NativeCallRoom"

    @Volatile private var room: Room? = null
    @Volatile private var callId: String? = null
    @Volatile private var roomName: String? = null
    @Volatile private var listenerJob: Job? = null

    // [STAGE-B 2026-05-20] Pre-warm state. When the FCM payload lands, we
    // call preconnect(url, token, callId) which kicks LiveKit.create +
    // Room.connect in a background coroutine BEFORE the user has tapped
    // Accept. By the time Telecom fires Connection.onAnswer → adoptForCall,
    // the Room is typically already CONNECTED — adoptForCall just publishes
    // mic and returns. Saves ~200-500ms on the "tap → audio" budget which
    // is the bulk of the gap between Chatyy and WhatsApp today.
    @Volatile private var preconnectingCallId: String? = null
    @Volatile private var preconnectJob: Job? = null

    // SupervisorJob so a single event handler crash doesn't kill the whole
    // listener scope. Main dispatcher so emit* calls (which post to React
    // Native bridge) happen on the JS main thread.
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // ────────────── Public state ──────────────

    fun isConnected(): Boolean {
        val r = room ?: return false
        return r.state == Room.State.CONNECTED
    }

    fun currentCallId(): String? = callId

    /**
     * Snapshot consumed by `adoptNativeRoom(callId)`. Returns null only when
     * there is no Room object at all — if the Room exists but is still
     * CONNECTING, we still return a snapshot with `connected=false` so JS
     * can adopt it and wait via the onLkConnected listener.
     * [FIX 2026-05-20 #954 regression] Previously rejected on `state !=
     * CONNECTED` → JS spawned a duplicate Room with same identity → SFU
     * evicted one → audio one-way / mute desync.
     */
    fun getSnapshot(): Map<String, Any?>? {
        val r = room ?: return null
        val isConnected = (r.state == Room.State.CONNECTED)
        return mapOf(
            "connected" to isConnected,
            "alreadyConnected" to isConnected,
            "state" to r.state.toString(),
            "roomName" to (roomName ?: ""),
            "localIdentity" to (r.localParticipant.identity?.value ?: ""),
            "participants" to r.remoteParticipants.size,
            "callId" to (callId ?: "")
        )
    }

    // ────────────── Publish from CallActivity ──────────────

    /**
     * Called by CallActivity once it has created the Room. Idempotent: a
     * second call for the same Room replaces the listener but keeps the
     * Room reference. A second call with a DIFFERENT Room clears the old
     * listener and switches over (covers the rare case where CallActivity
     * recreates after a failed connect).
     */
    fun publish(room: Room, callId: String, roomName: String, context: Context) {
        val previous = this.room
        if (previous != null && previous !== room) {
            Log.w(TAG, "publish: replacing previous Room (callId=${this.callId} → $callId)")
            listenerJob?.cancel()
        }
        this.room = room
        this.callId = callId
        this.roomName = roomName

        Log.d(TAG, "publish: Room registered callId=$callId roomName=$roomName state=${room.state}")

        // Cancel any prior listener before starting a new one.
        listenerJob?.cancel()
        listenerJob = scope.launch {
            try {
                room.events.collect { ev -> handleEvent(ev) }
            } catch (t: Throwable) {
                Log.w(TAG, "events.collect terminated: ${t.message}")
            }
        }

        // If the Room is already CONNECTED at publish time (CallActivity
        // called us after r.connect returned), fire onLkConnected
        // immediately so JS subscribers don't miss it.
        if (room.state == Room.State.CONNECTED) {
            val snap = getSnapshot()
            if (snap != null) {
                ExpoCallKitModule.emitLkConnected(callId, snap)
            }
        }
    }

    /**
     * Clear all state. Called by CallActivity.onDestroy (and the final
     * branch of finishCall). Safe to call multiple times.
     */
    fun clear() {
        val hadRoom = room != null
        listenerJob?.cancel()
        listenerJob = null
        // [STAGE-B] Also tear down preconnect bookkeeping so a stale
        // preconnect Job + callId pointer doesn't survive a finishCall.
        preconnectJob?.cancel()
        preconnectJob = null
        preconnectingCallId = null
        room = null
        callId = null
        roomName = null
        if (hadRoom) {
            Log.d(TAG, "clear: NativeCallRoom state reset")
        }
    }

    // ────────────── JS-side control surface ──────────────
    // ExpoCallKitModule AsyncFunction lambdas are NOT suspending in Expo
    // Modules SDK 55, so we expose non-suspend entry points that fire-and-
    // forget on our scope. LiveKit's setMicrophoneEnabled /
    // setCameraEnabled / Room.connect are suspend internally; we wrap them
    // here. Returns Unit so JS sees immediate Promise.resolve(undefined).

    fun setMicEnabled(enabled: Boolean) {
        val r = room
        if (r == null) {
            Log.w(TAG, "setMicEnabled($enabled): no live Room")
            return
        }
        scope.launch {
            try {
                r.localParticipant.setMicrophoneEnabled(enabled)
                ExpoCallKitModule.emitLkLocalAudioChanged(enabled)
            } catch (t: Throwable) {
                Log.w(TAG, "setMicEnabled($enabled) threw: ${t.message}")
            }
        }
    }

    fun setCameraEnabled(enabled: Boolean) {
        val r = room
        if (r == null) {
            Log.w(TAG, "setCameraEnabled($enabled): no live Room")
            return
        }
        scope.launch {
            try {
                if (enabled) {
                    // [WAVE 44B, 2026-05-21 gap A3] Mirror the CallActivity
                    // publish path: VP9 + simulcast + balanced degradation +
                    // 720p@30 capture. Without this, JS-triggered camera
                    // enable (adoptNativeRoom path) ends up calling the no-arg
                    // overload which falls back to VP8/no-simulcast defaults.
                    // Reflective in case LK Android rev changes the option
                    // surface — graceful fallback to plain enable on failure.
                    var usedOpts = false
                    try {
                        val publishDefaultsCls = Class.forName(
                            "io.livekit.android.room.track.VideoTrackPublishDefaults"
                        )
                        val captureCls = Class.forName(
                            "io.livekit.android.room.track.LocalVideoTrackOptions"
                        )
                        val captureParamCls = Class.forName(
                            "io.livekit.android.room.track.VideoCaptureParameter"
                        )
                        // Construct VideoCaptureParameter(1280, 720, 30).
                        val capParam = try {
                            captureParamCls
                                .getDeclaredConstructor(Int::class.java, Int::class.java, Int::class.java)
                                .newInstance(1280, 720, 30)
                        } catch (_: Throwable) { null }
                        val captureOpts = try {
                            // Try (captureParams) named-arg ctor first; fall back to no-arg.
                            captureCls.declaredConstructors.firstOrNull {
                                it.parameterTypes.any { p -> p.name.contains("VideoCaptureParameter") }
                            }?.let { ctor ->
                                val args = ctor.parameterTypes.map { p ->
                                    if (p.name.contains("VideoCaptureParameter")) capParam else null
                                }
                                ctor.newInstance(*args.toTypedArray())
                            } ?: captureCls.getDeclaredConstructor().newInstance()
                        } catch (_: Throwable) { null }
                        val publishOpts = publishDefaultsCls.getDeclaredConstructor().newInstance()
                        // Pin codec/simulcast/degradation reflectively.
                        publishDefaultsCls.declaredFields.forEach { f ->
                            f.isAccessible = true
                            when {
                                f.name.contains("simulcast", true) && f.type == Boolean::class.java -> f.set(publishOpts, true)
                                f.name.contains("codec", true) && f.type == String::class.java -> f.set(publishOpts, "vp9")
                                f.name.contains("degradation", true) -> {
                                    val t = f.type
                                    val v: Any = if (t.isEnum) {
                                        t.enumConstants?.firstOrNull { it.toString().equals("BALANCED", true) }
                                            ?: "balanced"
                                    } else "balanced"
                                    f.set(publishOpts, v)
                                }
                            }
                        }
                        // Try the 3-arg overload: setCameraEnabled(true, captureOpts, publishOpts).
                        val method = r.localParticipant.javaClass.methods.firstOrNull {
                            it.name == "setCameraEnabled" && it.parameterTypes.size == 3
                        }
                        if (method != null && captureOpts != null) {
                            method.invoke(r.localParticipant, true, captureOpts, publishOpts)
                            usedOpts = true
                            Log.d(TAG, "setCameraEnabled(true) with VP9+simulcast publish opts")
                        }
                    } catch (t: Throwable) {
                        Log.w(TAG, "VP9 publish opts reflective set failed (falling back): ${t.message}")
                    }
                    if (!usedOpts) {
                        r.localParticipant.setCameraEnabled(true)
                    }
                } else {
                    r.localParticipant.setCameraEnabled(false)
                }
                ExpoCallKitModule.emitLkLocalVideoChanged(enabled)
            } catch (t: Throwable) {
                Log.w(TAG, "setCameraEnabled($enabled) threw: ${t.message}")
            }
        }
    }

    /**
     * JS-initiated outgoing connect — for the rare case where there is no
     * CallActivity yet and JS asks us to bring up a Room directly. Currently
     * unused in the main flow (CallActivity owns the create path) but kept
     * here as a stub so future Stage 5 outgoing-from-JS paths can wire in
     * without re-touching ExpoCallKitModule.
     */
    fun connect(
        ctx: Context,
        url: String,
        token: String,
        callId: String,
        hasVideo: Boolean,
    ) {
        Log.i(
            TAG,
            "connect(callId=$callId hasVideo=$hasVideo): JS-initiated direct connect not yet wired. " +
                "CallActivity owns the LK create path; use lkConnect via the Activity-level intent flow instead."
        )
    }

    /**
     * Disconnect the live Room. Room.disconnect() is NOT a suspend in LK
     * 2.24.x — it returns Unit. Non-suspend so the AsyncFunction bridge
     * in ExpoCallKitModule can call it without coroutine boilerplate.
     *
     * [2026-05-22 #1331 fix] Even non-suspend disconnect can block on WS
     * teardown; wrap in coroutine with 10s timeout so JS bridge call never
     * stalls and stale Room can't keep peer stuck on "Conectando".
     */
    fun disconnect() {
        val r = room
        if (r == null) {
            Log.d(TAG, "disconnect: no live Room (no-op)")
            return
        }
        // Snapshot + null fields immediately so a re-entrant call is a no-op
        // and stale state can't survive past this point.
        room = null
        scope.launch(Dispatchers.IO) {
            val result = withTimeoutOrNull(10_000L) {
                try {
                    r.disconnect()
                    Log.d(TAG, "disconnect: room.disconnect() called")
                } catch (t: Throwable) {
                    Log.w(TAG, "disconnect threw: ${t.message}")
                }
            }
            if (result == null) {
                Log.w(TAG, "[#1331] disconnect timed out after 10s — forcing engine shutdown")
                try {
                    val engineField = r.javaClass.declaredFields.firstOrNull {
                        it.name.contains("engine", ignoreCase = true)
                    }
                    val engine = engineField?.apply { isAccessible = true }?.get(r)
                    val shutdown = engine?.javaClass?.methods?.firstOrNull { it.name == "shutdown" && it.parameterTypes.isEmpty() }
                    shutdown?.invoke(engine)
                } catch (t: Throwable) {
                    Log.w(TAG, "engine.shutdown threw: ${t.message}")
                }
            }
        }
        clear()
    }

    // ────────────── Event forwarding ──────────────

    private fun handleEvent(ev: RoomEvent) {
        val cid = callId ?: return
        when (ev) {
            is RoomEvent.Connected -> {
                val snap = getSnapshot() ?: return
                ExpoCallKitModule.emitLkConnected(cid, snap)
            }
            is RoomEvent.Disconnected -> {
                val reason = ev.reason?.name ?: "unknown"
                ExpoCallKitModule.emitLkDisconnected(cid, reason)
            }
            is RoomEvent.FailedToConnect -> {
                ExpoCallKitModule.emitLkError(cid, ev.error.message ?: "FailedToConnect")
            }
            is RoomEvent.ParticipantConnected -> {
                val ident = ev.participant.identity?.value ?: ""
                val sid = ev.participant.sid.value
                ExpoCallKitModule.emitLkParticipantConnected(cid, ident, sid)
            }
            is RoomEvent.ParticipantDisconnected -> {
                val ident = ev.participant.identity?.value ?: ""
                ExpoCallKitModule.emitLkParticipantDisconnected(cid, ident)
            }
            is RoomEvent.TrackSubscribed -> {
                val ident = ev.participant.identity?.value ?: ""
                val kind = if (ev.track is VideoTrack) "video" else "audio"
                val sid = ev.publication.sid
                ExpoCallKitModule.emitLkTrackSubscribed(cid, ident, kind, sid)
            }
            is RoomEvent.TrackUnsubscribed -> {
                val ident = ev.participant.identity?.value ?: ""
                val kind = if (ev.track is VideoTrack) "video" else "audio"
                ExpoCallKitModule.emitLkTrackUnsubscribed(cid, ident, kind)
            }
            is RoomEvent.ConnectionQualityChanged -> {
                val ident = ev.participant.identity?.value ?: ""
                ExpoCallKitModule.emitLkConnectionQuality(cid, ident, ev.quality.name)
            }
            is RoomEvent.DataReceived -> {
                val ident = ev.participant?.identity?.value ?: ""
                val text = try { String(ev.data, Charsets.UTF_8) } catch (_: Throwable) { "" }
                ExpoCallKitModule.emitLkDataReceived(cid, ident, text)
            }
            is RoomEvent.Reconnecting -> {
                Log.w(TAG, "Room reconnecting...")
                try { ExpoCallKitModule.emitLkReconnecting(cid) } catch (_: Exception) {}
            }
            is RoomEvent.Reconnected -> {
                Log.i(TAG, "Room reconnected")
                try { ExpoCallKitModule.emitLkReconnected(cid) } catch (_: Exception) {}
            }
            else -> {
                // unhandled: TrackMuted/TrackUnmuted/ActiveSpeakersChanged/etc.
                // are handled inside CallActivity's own collector for the
                // Compose UI. JS doesn't need every event mirrored.
            }
        }
    }

    // ────────────── [STAGE-B 2026-05-20] Pre-warm / Telecom adopt ──────────────

    /**
     * [STAGE-B] Kick off LiveKit.create + Room.connect for the incoming
     * call BEFORE the user accepts. Called from CallFirebaseMessagingService
     * the instant the FCM payload arrives. By the time Telecom delivers
     * Connection.onAnswer, the Room is typically CONNECTED already and
     * adoptForCall just needs to publish mic (~50-150ms instead of the
     * full ~500-800ms cold connect).
     *
     * Idempotent across same callId — a second preconnect for the same
     * callId no-ops. A second preconnect for a DIFFERENT callId clears the
     * prior Room (the previous call must be over or the FCM payload is
     * stale; either way we keep the most recent).
     *
     * Failure modes:
     *   - LK SDK init throws (e.g. missing native libs) → log + clear.
     *   - Room.connect times out → handled by Room.events
     *     FailedToConnect; adoptForCall will fall back to CallActivity
     *     restart with the same token (which is still cached via
     *     LkTokenFetcher.setCached).
     */
    fun preconnect(ctx: Context, url: String, token: String, callId: String) {
        if (url.isBlank() || token.isBlank() || callId.isBlank()) {
            Log.w(TAG, "preconnect: missing params (url=${url.isNotBlank()} tk=${token.isNotBlank()} id=${callId.isNotBlank()})")
            return
        }
        if (preconnectingCallId == callId && room != null) {
            Log.d(TAG, "preconnect: already in-flight or done for callId=$callId")
            return
        }
        if (preconnectingCallId != null && preconnectingCallId != callId) {
            Log.w(TAG, "preconnect: switching from ${preconnectingCallId} → $callId; clearing prior Room")
            // [2026-05-22 #1331 fix] Fire-and-forget timeout-bounded disconnect
            // so a hung WS teardown on the prior Room can't block the new call.
            val prior = room
            if (prior != null) {
                scope.launch(Dispatchers.IO) {
                    withTimeoutOrNull(10_000L) {
                        try { prior.disconnect() } catch (_: Throwable) {}
                    }
                }
            }
            clear()
        }
        preconnectingCallId = callId
        // Stash the token in LkTokenFetcher so the cache-hit fallback path
        // (Connection.onAnswer → adoptForCall → CallActivity restart) still
        // sees fresh creds even if our preconnect Room somehow died.
        try {
            LkTokenFetcher.setCached(ctx.applicationContext, callId, token, url)
        } catch (_: Throwable) {}

        Log.i(TAG, "preconnect: kicking LK.create + Room.connect for callId=$callId url=$url")
        preconnectJob?.cancel()
        preconnectJob = scope.launch {
            try {
                val r = LiveKit.create(ctx.applicationContext)
                // publish() here so events.collect is wired BEFORE we await
                // connect — otherwise the first Connected event might fire
                // before our listener attaches and JS would miss it.
                publish(r, callId, callId, ctx.applicationContext)
                r.connect(url, token)
                Log.i(TAG, "preconnect: Room.connect returned subscribe-only, state=${r.state}")
                // [bug 2026-05-24 ios-caller-auto-answers] DO NOT publish mic
                // during preconnect. This matches iOS (CallViewController.swift:
                // "subscribe-only, mic publish deferred to answer"). Publishing
                // pre-accept makes the caller's `ParticipantConnected` handler
                // think the callee already answered — caller UI flips to
                // "Conectado" + CallKit reports answered while the callee
                // phone is still ringing. Mic is published in adoptForCall
                // after the user actually taps Accept.
            } catch (t: Throwable) {
                Log.w(TAG, "preconnect failed for callId=$callId: ${t.message}")
                // Don't clear() — the cached token still lets onAnswer's
                // fallback launch CallActivity cleanly.
                preconnectingCallId = null
            }
        }
    }

    /** True when preconnect() has been called for [callId] and the Room
     *  is at least CONNECTING (so adoptForCall can wait on it instead of
     *  starting from scratch). */
    fun isPreconnected(callId: String): Boolean {
        val r = room ?: return false
        if (this.callId != callId) return false
        return when (r.state) {
            Room.State.CONNECTED, Room.State.CONNECTING, Room.State.RECONNECTING -> true
            else -> false
        }
    }

    /**
     * [STAGE-B] Called from ChatyyConnection.onAnswer. By the time we get
     * here:
     *   - preconnect() may have already CONNECTED the Room (warm path)
     *   - or preconnect() failed / never ran (cold path)
     *
     * Either way, the user has tapped Accept and the audio focus is now
     * ours (Telecom set it via setActive()). Our job is:
     *
     *   1. If Room is CONNECTED: setMicEnabled(true) and we're done.
     *   2. If Room is still CONNECTING/RECONNECTING: setMicEnabled(true)
     *      anyway — LiveKit queues mic publish until the connection is
     *      live.
     *   3. If no Room (preconnect never ran or failed): launch
     *      CallActivity with the lkUrl/lkToken in the Intent. CallActivity
     *      owns the cold-connect path identical to the existing flow.
     */
    fun adoptForCall(
        ctx: Context,
        callId: String,
        lkUrl: String?,
        lkToken: String?,
        callerName: String,
        callerEmail: String,
        conversationId: String,
        hasVideo: Boolean,
        callerAvatar: String,
    ) {
        Log.i(TAG, "adoptForCall: callId=$callId preconnected=${isPreconnected(callId)}")
        if (isPreconnected(callId)) {
            // Warm path. Just attach the mic and we're done.
            try {
                setMicEnabled(true)
                if (hasVideo) setCameraEnabled(true)
            } catch (t: Throwable) {
                Log.w(TAG, "adoptForCall: setMic/Cam failed: ${t.message}")
            }
            // Fire-and-forget signal to caller.
            // [WAVE 104C] Pass callerEmail so C++ WS relay routes the frame.
            try {
                CallSignalWs.fireCallAnswered(ctx.applicationContext, callId, conversationId, callerEmail)
            } catch (_: Throwable) {}
            return
        }
        // Cold path — no preconnect (or it failed). Hand off to CallActivity
        // exactly the way the legacy IncomingCallActivity did.
        Log.w(TAG, "adoptForCall: no preconnect — falling back to CallActivity cold-launch")
        try {
            val intent = Intent(ctx, CallActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                        or Intent.FLAG_ACTIVITY_SINGLE_TOP
                        or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                        or Intent.FLAG_ACTIVITY_CLEAR_TOP
                )
                putExtra(CallActivity.EXTRA_CALL_ID, callId)
                putExtra(CallActivity.EXTRA_CALLER_NAME, callerName)
                putExtra(CallActivity.EXTRA_CALLER_EMAIL, callerEmail)
                putExtra(CallActivity.EXTRA_CONVERSATION_ID, conversationId)
                putExtra(CallActivity.EXTRA_HAS_VIDEO, hasVideo)
                if (!lkUrl.isNullOrEmpty()) putExtra(CallActivity.EXTRA_LK_URL, lkUrl)
                if (!lkToken.isNullOrEmpty()) putExtra(CallActivity.EXTRA_LK_TOKEN, lkToken)
                if (callerAvatar.isNotEmpty()) putExtra(CallActivity.EXTRA_CALLER_AVATAR, callerAvatar)
                ExpoCallKitModule.enrichIntentWithAuth(ctx.applicationContext, this)
            }
            ctx.startActivity(intent)
            // [WAVE 104C] Pass callerEmail so C++ WS relay routes the frame.
            try {
                CallSignalWs.fireCallAnswered(ctx.applicationContext, callId, conversationId, callerEmail)
            } catch (_: Throwable) {}
        } catch (t: Throwable) {
            Log.e(TAG, "adoptForCall fallback launch failed: ${t.message}")
        }
    }
}
