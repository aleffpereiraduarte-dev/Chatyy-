package expo.modules.callkit

import android.content.Context
import android.content.Intent
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.e2ee.BaseKeyProvider
import io.livekit.android.e2ee.E2EEOptions
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

    // [echo fix 2026-05-24] Hardware audio effects (AEC/NS/AGC) attached after
    // mic publish. The WARM incoming path (preconnect → adoptForCall) used bare
    // LiveKit.create() and NEVER installed these — only the legacy CallActivity
    // cold path did (CallActivity.installHwAudioEffects). Result: callee on the
    // warm path echoed the caller's voice back ("escuto minha voz de retorno").
    // This ports the exact same effect attach so the warm path matches.
    private val hwAudioEffects = mutableListOf<android.media.audiofx.AudioEffect>()

    /** Resolve the WebRTC AudioRecord session id (reflective walk of LK's
     *  JavaAudioDeviceModule) and attach hardware AEC/NS/AGC. Mirror of
     *  CallActivity.installHwAudioEffects — graceful no-op if the session id
     *  can't be resolved. Must run AFTER setMicEnabled(true) so the mic
     *  AudioRecord actually exists. */
    private fun installHwAudioEffects(ctx: Context) {
        if (hwAudioEffects.isNotEmpty()) return // idempotent — already attached
        try {
            var sid = 0
            try {
                val r = room
                val candidates = listOfNotNull(
                    try { r?.javaClass?.getDeclaredField("engine")?.apply { isAccessible = true }?.get(r) } catch (_: Throwable) { null },
                    try { r?.javaClass?.declaredFields?.firstOrNull { it.name.contains("audioDeviceModule", true) }?.apply { isAccessible = true }?.get(r) } catch (_: Throwable) { null },
                )
                for (root in candidates) {
                    if (sid != 0) break
                    val visited = mutableSetOf<Any>()
                    fun walk(node: Any?, depth: Int) {
                        if (node == null || depth > 4 || sid != 0) return
                        if (!visited.add(node)) return
                        try {
                            for (f in node.javaClass.declaredFields) {
                                f.isAccessible = true
                                val v = try { f.get(node) } catch (_: Throwable) { null } ?: continue
                                if (v is android.media.AudioRecord) {
                                    val s = v.audioSessionId
                                    if (s > 0) { sid = s; return }
                                } else if (f.name.contains("audioRecord", true) ||
                                           f.name.contains("audioRecorder", true) ||
                                           f.name.contains("audioDevice", true) ||
                                           f.name.contains("engine", true)) {
                                    walk(v, depth + 1)
                                }
                            }
                        } catch (_: Throwable) {}
                    }
                    walk(root, 0)
                }
            } catch (_: Throwable) {}
            if (sid == 0) {
                try {
                    val am = ctx.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? android.media.AudioManager
                    sid = am?.generateAudioSessionId() ?: 0
                } catch (_: Throwable) {}
            }
            if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) {
                android.media.audiofx.AcousticEchoCanceler.create(sid)?.apply { enabled = true }?.let(hwAudioEffects::add)
            }
            if (android.media.audiofx.NoiseSuppressor.isAvailable()) {
                android.media.audiofx.NoiseSuppressor.create(sid)?.apply { enabled = true }?.let(hwAudioEffects::add)
            }
            if (android.media.audiofx.AutomaticGainControl.isAvailable()) {
                android.media.audiofx.AutomaticGainControl.create(sid)?.apply { enabled = true }?.let(hwAudioEffects::add)
            }
            Log.d(TAG, "installHwAudioEffects: ${hwAudioEffects.size} attached (sid=$sid)")
        } catch (t: Throwable) {
            Log.w(TAG, "installHwAudioEffects fail (graceful): ${t.message}")
        }
    }

    private fun releaseHwAudioEffects() {
        for (fx in hwAudioEffects) { try { fx.release() } catch (_: Throwable) {} }
        hwAudioEffects.clear()
    }

    // ────────────── [CALL_E2EE, flag-gated, default OFF] ──────────────
    /**
     * Build LiveKit E2EE options for [callId] IFF the JS layer pushed a
     * pending shared key (via ExpoCallKitModule.setCallE2EEKey, which only
     * fires when the CALL_E2EE feature flag is ON). Returns null when there is
     * no key — in which case the caller creates the Room exactly as before
     * (plaintext), so production behavior is unchanged until the flag is on.
     *
     * Key material — CROSS-PLATFORM CONTRACT (2026-06-28): the JS-supplied value
     * is the base64 STRING of the per-call key. Both Android and iOS feed THIS
     * EXACT STRING into BaseKeyProvider's String shared-key API, which uses the
     * string's UTF-8 bytes as key material. Because both platforms use the same
     * string + same String API, they derive identical material and frames
     * decrypt cross-platform. (LiveKit runs the shared key through its own
     * ratchet/KDF, so 44-byte base64 text is fine as key material — what matters
     * is that BOTH sides feed the SAME bytes, which they now do.)
     *
     * LiveKit Android 2.24.1 verified API:
     *   BaseKeyProvider()                 → enableSharedKey defaults to true
     *   BaseKeyProvider.setSharedKey(String)  → UTF-8 of the string (matches iOS)
     *   E2EEOptions(KeyProvider, livekit.LivekitModels.Encryption.Type)
     *   RoomOptions(e2eeOptions = ...)  (Kotlin data class, all-defaults ctor)
     */
    // internal (not private) so CallActivity's cold-launch bringUpRoom() can
    // apply the SAME E2EE options. Previously only the WARM preconnect path
    // (this object) had E2EE; a cold-launched incoming call (CallActivity
    // builds its OWN Room) connected plaintext even with a staged key.
    internal fun buildE2EEOptionsFor(callId: String?): E2EEOptions? {
        val keyB64 = ExpoCallKitModule.pendingE2EEKey(callId) ?: return null
        if (keyB64.isEmpty()) return null
        return try {
            val keyProvider = BaseKeyProvider().apply {
                // Base64-string shared key (UTF-8) — matches iOS BaseKeyProvider(sharedKey:).
                setSharedKey(keyB64)
            }
            val opts = E2EEOptions(
                keyProvider,
                livekit.LivekitModels.Encryption.Type.GCM
            )
            Log.i(TAG, "buildE2EEOptionsFor: E2EE ENABLED for callId=$callId (GCM, shared-key str len=${keyB64.length})")
            opts
        } catch (t: Throwable) {
            // Any failure ⇒ fall back to plaintext rather than blocking the call.
            Log.w(TAG, "buildE2EEOptionsFor: failed (${t.message}) — connecting WITHOUT E2EE")
            null
        }
    }

    /**
     * [HD voice + DSP 2026-06-29] RoomOptions for a 1:1 call with the SAME audio
     * quality knobs the GROUP path (GroupCallActivity) already pins, so the most
     * common call type (1:1) stops riding on whatever the LK SDK default happens
     * to be (which can silently shift across SDK bumps) and instead gets:
     *   - Opus PUBLISH: dtx (silence suppression) + red (REDundant audio —
     *     recovers single/short-burst loss with NO retransmit latency = the fix
     *     for "voz cortando" no 4G) + 48 kbps HD mono voice.
     *   - CAPTURE DSP: AEC (echo cancel) + AGC (auto gain) + NS (noise supp.)
     *     pinned explicitly (the LK 2.x default has them on, but pin protects a
     *     future SDK from flipping it).
     * Folds in the E2EE options when present. Reflective on purpose — the
     * RoomOptions field names + the AudioTrackPublishDefaults ctor have bounced
     * across SDK revs, and a hard compile dep would break on the next bump.
     * Every step is try/caught: any failure leaves SDK defaults in place, never
     * crashes/degrades the call (matches the proven block in CallActivity).
     */
    private fun buildCallRoomOptions(e2ee: E2EEOptions?): RoomOptions {
        val roomOptions = if (e2ee != null) RoomOptions(e2eeOptions = e2ee) else RoomOptions()
        // Capture-side DSP defaults (AEC + AGC + NS via the ctor defaults).
        try {
            val cls = Class.forName("io.livekit.android.room.track.LocalAudioTrackOptions")
            val audioOpts = cls.getDeclaredConstructor().newInstance()
            val field = roomOptions.javaClass.declaredFields.firstOrNull {
                it.name.contains("audio", ignoreCase = true) &&
                it.name.contains("captureDefault", ignoreCase = true)
            }
            if (field != null) {
                field.isAccessible = true
                field.set(roomOptions, audioOpts)
                Log.d(TAG, "buildCallRoomOptions: ${field.name} pinned (aec+agc+ns)")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "buildCallRoomOptions: audio capture defaults set failed (graceful): ${t.message}")
        }
        // Publish-side Opus knobs: AudioTrackPublishDefaults(audioBitrate, dtx, red, preconnect).
        try {
            val apdCls = Class.forName("io.livekit.android.room.participant.AudioTrackPublishDefaults")
            val apdCtor = apdCls.getDeclaredConstructor(
                java.lang.Integer::class.java,
                java.lang.Boolean.TYPE,
                java.lang.Boolean.TYPE,
                java.lang.Boolean.TYPE
            )
            apdCtor.isAccessible = true
            val audioPublishOpts = apdCtor.newInstance(
                Integer.valueOf(48_000), // audioBitrate — HD mono voice
                true,                    // dtx
                true,                    // red
                false                    // preconnect (we publish after connect)
            )
            val apField = roomOptions.javaClass.declaredFields.firstOrNull {
                it.name.contains("audio", ignoreCase = true) &&
                it.name.contains("publish", ignoreCase = true)
            }
            if (apField != null) {
                apField.isAccessible = true
                apField.set(roomOptions, audioPublishOpts)
                Log.d(TAG, "buildCallRoomOptions: ${apField.name} pinned (Opus dtx+red+48k)")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "buildCallRoomOptions: audio publish defaults set failed (graceful): ${t.message}")
        }
        return roomOptions
    }

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
        // [CALL_E2EE] Drop the staged shared key so it can't leak into a later
        // call that happens to reuse the same callId string. No-op when unset.
        try { ExpoCallKitModule.clearPendingE2EEKey(callId) } catch (_: Throwable) {}
        releaseHwAudioEffects()
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
                                // [remote-video render fix 2026-05-26] vp9 → h264.
                                // Must match CallActivity.bringUpRoom + the iOS
                                // publish sites — VP9 doesn't decode reliably
                                // cross-platform on mobile (iOS subscriber saw
                                // only the avatar). H.264 is HW-decoded everywhere.
                                f.name.contains("codec", true) && f.type == String::class.java -> f.set(publishOpts, "h264")
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
                            Log.d(TAG, "setCameraEnabled(true) with H264+simulcast publish opts")
                        }
                    } catch (t: Throwable) {
                        Log.w(TAG, "H264 publish opts reflective set failed (falling back): ${t.message}")
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
                // [CALL_E2EE, flag-gated] If JS staged a shared key for this
                // callId (flag ON), create the Room with E2EEOptions so frames
                // are encrypted. No key ⇒ e2ee == null ⇒ LiveKit.create() with
                // default options == the exact pre-E2EE path.
                val e2ee = buildE2EEOptionsFor(callId)
                // [HD voice + DSP 2026-06-29] 1:1 now creates the Room with the
                // same audio tuning the group already has (Opus 48k + RED + DTX
                // + AEC/AGC/NS). buildCallRoomOptions folds e2ee in when present,
                // so the no-key path == the old default + audio knobs.
                val r = LiveKit.create(ctx.applicationContext, buildCallRoomOptions(e2ee))
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
            // [WAVE 161B 2026-05-24] Respect the JS-persisted mute snapshot
            // when present. Prevents 200-1500ms of hot-mic leak between the
            // Accept tap and the JS lkSetMicEnabled(false) catching up (e.g.
            // host force-mute via WS landed before pickup, or user has the
            // "answer muted" preference). Defaults to UNMUTED when key is
            // absent, matching legacy behavior.
            val prefs = ctx.getSharedPreferences("expo_callkit_prefs", Context.MODE_PRIVATE)
            val startMuted = prefs.getBoolean("pending_call_mic_muted", false)
            try {
                setMicEnabled(!startMuted)
                if (hasVideo) setCameraEnabled(true)
                if (startMuted) Log.i(TAG, "adoptForCall: published mic muted (pending_call_mic_muted=true)")
                // [echo fix 2026-05-24] Attach HW AEC/NS/AGC now that the mic
                // AudioRecord exists. Synchronous attach (mirror CallActivity);
                // a delayed retry catches devices where the AudioRecord opens a
                // beat later. Idempotent — releaseHwAudioEffects() runs in clear().
                try { installHwAudioEffects(ctx) } catch (_: Throwable) {}
                scope.launch {
                    kotlinx.coroutines.delay(900)
                    try { installHwAudioEffects(ctx) } catch (_: Throwable) {}
                }
            } catch (t: Throwable) {
                Log.w(TAG, "adoptForCall: setMic/Cam failed: ${t.message}")
            }
            // Clear the flag so it doesn't bleed into the next call.
            try { prefs.edit().remove("pending_call_mic_muted").apply() } catch (_: Throwable) {}
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
