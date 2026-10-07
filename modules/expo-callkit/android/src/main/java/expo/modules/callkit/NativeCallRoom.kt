package expo.modules.callkit

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.e2ee.BaseKeyProvider
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
// [video-quality 2026-10-06] profile ladder + diag (CallVideoQuality below)
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import livekit.org.webrtc.HardwareVideoEncoderFactory
import livekit.org.webrtc.RTCStatsReport
import livekit.org.webrtc.RtpParameters
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
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

    // [P0 audio-drop fix 2026-10-04] Guards against starting the in-call
    // foreground service more than once for the same accepted call (a repeated
    // adoptForCall). Reset in clear(). See ensureForegroundServiceForWarmCall.
    @Volatile private var fgsStartedForCallId: String? = null

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
        // [double-AEC fix 2026-10-04] WhatsApp strategy — trust the HARDWARE AEC
        // owned by LiveKit's JavaAudioDeviceModule (it enables the platform
        // AEC/NS by default whenever the device supports them). Creating a SECOND
        // platform AcousticEchoCanceler/NoiseSuppressor on the SAME WebRTC
        // AudioRecord session put two cancellers in series → robotic/pumping
        // voice on speakerphone. So when the platform HW AEC is available (the
        // device module already engaged it) we DO NOT attach a manual canceller.
        // The manual attach stays only as a FALLBACK for devices with no platform
        // AEC (there the device module falls back to WebRTC's software AEC).
        if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) {
            Log.d(TAG, "installHwAudioEffects: platform HW AEC owned by device module — skipping manual attach (no double-AEC)")
            return
        }
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

    /**
     * [P0 audio-drop fix 2026-10-04] The WARM accept path (preconnect →
     * adoptForCall) returns WITHOUT launching CallActivity, so the in-call
     * foreground service (CallOngoingService, FOREGROUND_SERVICE_TYPE_PHONE_CALL)
     * and the AudioRouter were never set up — only the COLD path
     * (CallActivity.onCreate) did it. Because preconnect almost always lands the
     * Room before the Accept tap, the common case ran with NO foreground
     * service → Android 14+ revokes the mic ~5s after the app goes to the
     * background ("áudio cai ao minimizar"). This mirrors the cold-path setup
     * on the warm branch: configure audio routing + start the phoneCall FGS.
     *
     * Idempotent — starts CallOngoingService at most once per [callId]. The
     * cold path never runs after the warm branch's early return, so the FGS
     * can't be started twice for one call. The service is torn down by the
     * existing end-call cleanup (ExpoCallKitModule endCall / CallActionReceiver),
     * which already stop CallOngoingService, so no new teardown is needed here.
     */
    private fun ensureForegroundServiceForWarmCall(
        ctx: Context,
        callId: String,
        callerName: String,
        hasVideo: Boolean,
    ) {
        val app = ctx.applicationContext
        // Audio routing (earpiece for audio / speaker for video, BT hot-plug) —
        // mirror CallActivity.onCreate's AudioRouter.configureForCall(hasVideo).
        try {
            expo.modules.callkit.audio.AudioRouter.get(app).configureForCall(hasVideo)
        } catch (t: Throwable) {
            Log.w(TAG, "warm FGS: AudioRouter.configureForCall failed: ${t.message}")
        }
        if (fgsStartedForCallId == callId) {
            Log.d(TAG, "warm FGS: CallOngoingService already started for callId=$callId — skip")
            return
        }
        try {
            val svcIntent = Intent(app, CallOngoingService::class.java).apply {
                putExtra(CallOngoingService.EXTRA_CALL_ID, callId)
                putExtra(CallOngoingService.EXTRA_CALLER_NAME, callerName)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                app.startForegroundService(svcIntent)
            } else {
                app.startService(svcIntent)
            }
            fgsStartedForCallId = callId
            Log.i(TAG, "warm FGS: CallOngoingService started (phoneCall) for callId=$callId")
        } catch (t: Throwable) {
            Log.w(TAG, "warm FGS: startForegroundService(CallOngoingService) failed: ${t.message}")
        }
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
    private fun buildCallRoomOptions(ctx: Context, e2ee: E2EEOptions?): RoomOptions {
        // [video-quality 2026-10-06] The warm/preconnect Room used to be built
        // with NO video defaults — setCameraEnabled(true) on it published the
        // SDK defaults (VP8 + whatever capture size), which is the VP8
        // 1280x720 single-layer publish the SFU log showed for the Pixel.
        // Pin the SAME profile ladder CallActivity.bringUpRoom uses (public
        // ctor params verified on livekit-android 2.24.1 via javap; adaptive
        // stream/dynacast intentionally left at the warm-path defaults).
        val videoCapture = try { CallVideoQuality.captureDefaults(ctx, isGroup = false) } catch (_: Throwable) { null }
        val videoPublish = try { CallVideoQuality.publishDefaults() } catch (_: Throwable) { null }
        val roomOptions = try {
            RoomOptions(
                e2eeOptions = e2ee,
                videoTrackCaptureDefaults = videoCapture ?: LocalVideoTrackOptions(),
                videoTrackPublishDefaults = videoPublish ?: VideoTrackPublishDefaults(),
                screenShareTrackCaptureDefaults = CallVideoQuality.screenShareCaptureDefaults(),
                screenShareTrackPublishDefaults = CallVideoQuality.screenSharePublishDefaults()
            )
        } catch (t: Throwable) {
            Log.w(TAG, "buildCallRoomOptions: video defaults ctor failed (${t.message}) — SDK defaults")
            if (e2ee != null) RoomOptions(e2eeOptions = e2ee) else RoomOptions()
        }
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
            // [FIX 2026-06-30 DUPLICATE_IDENTITY] CallActivity.bringUpRoom just
            // created a NEW Room and is about to connect it (attemptConnect runs
            // AFTER this publish()). If the PREVIOUS Room is the warm preconnect
            // Room (same identity, still live on the SFU), leaving it connected
            // makes the SFU see two connections with the same identity → it
            // evicts one (DUPLICATE_IDENTITY in the livekit log) → audio/state
            // churn on the callee. Disconnecting the orphan HERE drops the old
            // identity cleanly BEFORE the new Room dials → no collision.
            // Timeout-bounded + fire-and-forget (a hung WS teardown can't block
            // the new call). Guarded `previous !== room` above → we never touch
            // the Room we're about to publish.
            try {
                val st = previous.state
                if (st == Room.State.CONNECTED || st == Room.State.CONNECTING || st == Room.State.RECONNECTING) {
                    Log.d(TAG, "publish: disconnecting orphan preconnect Room (state=$st) to avoid DUPLICATE_IDENTITY")
                    scope.launch(Dispatchers.IO) {
                        withTimeoutOrNull(5_000L) {
                            try { previous.disconnect() } catch (_: Throwable) {}
                        }
                    }
                }
            } catch (t: Throwable) {
                Log.w(TAG, "publish: orphan disconnect skipped: ${t.message}")
            }
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
        // [P0 audio-drop fix 2026-10-04] Allow the warm-path FGS to start again
        // for the next call. The FGS itself is stopped by the end-call cleanup.
        fgsStartedForCallId = null
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

    // [2026-10-06 android-incoming] Single source of truth for the Android
    // video codec + simulcast pair (CallActivity.bringUpRoom and the warm
    // setCameraEnabled path both read it). libwebrtc on Android has NO
    // software H.264 encoder: pinning "h264" on a device whose MediaCodec
    // list has no hardware AVC encoder makes the camera publish fail
    // silently (iPhone keeps seeing the avatar). H.264 also cannot simulcast.
    //   hardware AVC encoder present → "h264", simulcast=false
    //   otherwise                    → "vp8",  simulcast=true  (SW encoder)
    @Volatile private var cachedPreferredCodec: String? = null

    fun preferredVideoCodec(): String {
        cachedPreferredCodec?.let { return it }
        // [video-quality 2026-10-06] Ask libwebrtc ITSELF first. LiveKit builds
        // its encoder factory as HardwareVideoEncoderFactory(egl, intelVp8=true,
        // h264HighProfile=false) (javap: RTCModule.videoEncoderFactory →
        // CustomVideoEncoderFactory → SimulcastVideoEncoderFactoryWrapper), and
        // libwebrtc m144 only lists H264 when: SDK ≥ 29 → MediaCodecInfo
        // .isHardwareAccelerated(); SDK < 29 → name starts with OMX.qcom. /
        // OMX.Exynos.; AND the model is not in H264_HW_EXCEPTION_MODELS AND a
        // supported YUV color format exists. getSupportedCodecs() is pure Java
        // (no JNI, no EGL needed with a null context), so it is safe before
        // LiveKit.create(). If libwebrtc won't offer H264 the SFU negotiates
        // VP8 anyway — and with simulcast=false that was the worst of both
        // worlds (software VP8 720p30, no ladder). The MediaCodecList probe
        // below stays as the fallback if the factory call throws.
        val probe: String? = try {
            val hw = HardwareVideoEncoderFactory(null, true, false)
            val names = hw.supportedCodecs.map { it.name }
            Log.i(TAG, "[camera] libwebrtc HW encoders=${names.joinToString(",")}")
            if (names.any { it.equals("H264", ignoreCase = true) }) "h264" else "vp8"
        } catch (t: Throwable) {
            Log.w(TAG, "[camera] HardwareVideoEncoderFactory probe failed (${t.message}) — MediaCodecList fallback")
            null
        }
        if (probe != null) {
            Log.i(TAG, "[camera] preferredVideoCodec=$probe simulcast=${probe != "h264"} (device=${Build.MANUFACTURER} ${Build.MODEL} sdk=${Build.VERSION.SDK_INT})")
            cachedPreferredCodec = probe
            return probe
        }
        val codec = try {
            val list = android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS)
            val hasHwAvcEncoder = list.codecInfos.any { info ->
                if (!info.isEncoder) return@any false
                if (!info.supportedTypes.any { it.equals("video/avc", ignoreCase = true) }) return@any false
                val name = info.name.lowercase()
                val isSoftware = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    !info.isHardwareAccelerated
                } else {
                    name.startsWith("omx.google.") || name.startsWith("c2.android.")
                }
                !isSoftware
            }
            if (hasHwAvcEncoder) "h264" else "vp8"
        } catch (t: Throwable) {
            Log.w(TAG, "[camera] preferredVideoCodec probe failed (${t.message}) — defaulting to h264")
            "h264"
        }
        Log.i(TAG, "[camera] preferredVideoCodec=$codec simulcast=${codec != "h264"} (device=${Build.MANUFACTURER} ${Build.MODEL} sdk=${Build.VERSION.SDK_INT})")
        cachedPreferredCodec = codec
        return codec
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
                    // [video-quality 2026-10-06] livekit-android 2.24.1 has NO
                    // 3-arg setCameraEnabled(enabled, captureOpts, publishOpts)
                    // (javap: only setCameraEnabled(Boolean, Continuation)), so
                    // the old reflective lookup here ALWAYS fell through to the
                    // bare call and published whatever the Room defaults were —
                    // on the warm Room those were SDK defaults (VP8, no profile).
                    // The Room is now created with the profile ladder pinned
                    // (buildCallRoomOptions → CallVideoQuality), so the plain
                    // call publishes exactly the intended codec/res/bitrate.
                    r.localParticipant.setCameraEnabled(true)
                    Log.d(TAG, "setCameraEnabled(true) profile=${CallVideoQuality.current.name} codec=${preferredVideoCodec()}")
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
                val r = LiveKit.create(ctx.applicationContext, buildCallRoomOptions(ctx.applicationContext, e2ee))
                // [2026-10-07 audio-route] Ring-time preconnect: call type not
                // known here → voice policy (earpiece-first) in LiveKit's
                // AudioSwitch before connect; adoptForCall re-applies with the
                // real hasVideo.
                try { expo.modules.callkit.audio.AudioRouter.get(ctx.applicationContext).attachLiveKit(r, false) } catch (_: Throwable) {}
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
            // [P0 audio-drop fix 2026-10-04] Start the in-call foreground service
            // + configure audio routing BEFORE publishing the mic. The warm path
            // never reaches CallActivity (which owned this on the cold path), so
            // without it Android 14+ kills the mic ~5s after backgrounding.
            try { ensureForegroundServiceForWarmCall(ctx, callId, callerName, hasVideo) } catch (_: Throwable) {}
            // [2026-10-07 audio-route] Re-bind LiveKit's AudioSwitch with the
            // real call type (video → speaker-first) and re-select the device.
            try { expo.modules.callkit.audio.AudioRouter.get(ctx.applicationContext).attachLiveKit(room, hasVideo) } catch (_: Throwable) {}
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
            // [2026-10-06 android-incoming] The warm path published the mic
            // and RETURNED — no in-call UI ever appeared when the answer came
            // through Telecom (Bluetooth headset / Android Auto / Wear /
            // system call UI): audio flowed, screen showed nothing ("o módulo
            // de ligação não abre"). Launch CallActivity here too. It builds
            // its own Room; NativeCallRoom.publish() disconnects this warm
            // Room first (DUPLICATE_IDENTITY guard) so the hand-off is clean
            // — same end state as the cold path below.
            launchCallActivityFor(
                ctx, callId, lkUrl, lkToken, callerName, callerEmail,
                conversationId, hasVideo, callerAvatar, origin = "warm"
            )
            return
        }
        // Cold path — no preconnect (or it failed). Hand off to CallActivity
        // exactly the way the legacy IncomingCallActivity did.
        Log.w(TAG, "adoptForCall: no preconnect — falling back to CallActivity cold-launch")
        if (launchCallActivityFor(
                ctx, callId, lkUrl, lkToken, callerName, callerEmail,
                conversationId, hasVideo, callerAvatar, origin = "cold"
            )) {
            // [WAVE 104C] Pass callerEmail so C++ WS relay routes the frame.
            try {
                CallSignalWs.fireCallAnswered(ctx.applicationContext, callId, conversationId, callerEmail)
            } catch (_: Throwable) {}
        }
    }

    /**
     * [2026-10-06 android-incoming] Shared CallActivity launcher for the
     * Telecom-driven answer (ChatyyConnection.onAnswer → adoptForCall), warm
     * and cold. Flags mirror IncomingCallActivity.startCallActivityWith
     * (NEW_TASK | SINGLE_TOP | REORDER_TO_FRONT | CLEAR_TOP) so a CallActivity
     * that is already up for this call just gets onNewIntent. Returns true
     * when startActivity did not throw.
     */
    private fun launchCallActivityFor(
        ctx: Context,
        callId: String,
        lkUrl: String?,
        lkToken: String?,
        callerName: String,
        callerEmail: String,
        conversationId: String,
        hasVideo: Boolean,
        callerAvatar: String,
        origin: String,
    ): Boolean {
        Log.i(TAG, "[launch-decision] adoptForCall($origin) → CallActivity callId=$callId hasCreds=${!lkUrl.isNullOrEmpty() && !lkToken.isNullOrEmpty()} appForeground=${ExpoCallKitModule.isAppForeground}")
        Log.i("CallTrace", "[7c/12] Telecom answer ($origin) → CallActivity launch callId=$callId ts=${System.currentTimeMillis()}")
        return try {
            val intent = Intent(ctx.applicationContext, CallActivity::class.java).apply {
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
            ctx.applicationContext.startActivity(intent)
            true
        } catch (t: Throwable) {
            // Background-activity-launch denial lands here on some OEMs when
            // the answer came from a headset with the screen off. The call is
            // still live (mic published, CallOngoingService up) — the user can
            // reopen the screen from the ongoing notification.
            Log.e(TAG, "adoptForCall($origin) CallActivity launch failed: ${t.message}")
            false
        }
    }
}

/**
 * [video-quality 2026-10-06 "melhorar a qualidade do vídeo"]
 *
 * SINGLE SOURCE OF TRUTH for every camera / screen-share publish on Android:
 * CallActivity.bringUpRoom (cold path), NativeCallRoom.buildCallRoomOptions
 * (warm/preconnect path) and GroupCallActivity all read the ladder below.
 * Mirror of iOS `CallViewController.CallVideoQuality` and app/call.js
 * `VIDEO_QUALITY` — the SFU forwards whatever each publisher offers, so an
 * asymmetric ladder shows up as "um lado nítido, o outro borrado". Change the
 * numbers HERE, then mirror them on the other two platforms.
 *
 * Ladder (16:9, 30 fps):
 *   HD1080   1920x1080  3.5 Mbps   Wi-Fi/ethernet + "Qualidade HD" pref
 *   HD720    1280x720   2.3 Mbps   default 1:1 (Wi-Fi or healthy cellular)
 *   SD540     960x540   1.1 Mbps   cellular + constrained/poor link
 *   GROUP540  960x540   0.7 Mbps   group tiles (small on screen; N×uplink)
 *
 * Codec/simulcast pair comes from NativeCallRoom.preferredVideoCodec():
 *   "h264" (HW encoder present) → simulcast=false (libwebrtc Android has no
 *   H.264 simulcast — publish offer is invalid with it, see 2026-05-26/10-06)
 *   "vp8" otherwise → simulcast=true (SFU ladder from LK's default presets)
 * Degradation = BALANCED for camera (WebRTC default: sheds some fps AND res;
 * MAINTAIN_FRAMERATE made a congested face go 180p-blurry at 30 fps), and
 * MAINTAIN_RESOLUTION for screen share (text legibility first).
 *
 * All public ctor parameters verified on livekit-android 2.24.1 via javap:
 *   VideoTrackPublishDefaults(videoEncoding, simulcast, videoCodec,
 *     scalabilityMode, backupCodec, degradationPreference, simulcastLayers)
 *   LocalVideoTrackOptions(isScreencast, deviceId, position, captureParams)
 *   RoomOptions(..., videoTrackCaptureDefaults, videoTrackPublishDefaults,
 *     screenShareTrackCaptureDefaults, screenShareTrackPublishDefaults, ...)
 */
object CallVideoQuality {
    private const val TAG = "CallVideoQuality"
    private const val PREFS = "chatyy_call_prefs"
    const val HD_PREF_KEY = "chatyy_call_hd"
    private const val DIAG_ENDPOINT = "https://chatyy.com.br/api/email.php?action=push_diag"

    enum class Profile(val width: Int, val height: Int, val fps: Int, val maxBitrate: Int, val rank: Int) {
        HD1080(1920, 1080, 30, 3_500_000, 3),
        HD720(1280, 720, 30, 2_300_000, 2),
        SD540(960, 540, 30, 1_100_000, 1),
        GROUP540(960, 540, 30, 700_000, 0);
    }

    /** Screen share: 1080p @ 15 fps, ~3 Mbps, keep resolution. */
    private val SCREEN_CAPTURE = VideoCaptureParameter(1920, 1080, 15)
    private val SCREEN_ENCODING = VideoEncoding(3_000_000, 15)

    /** Last profile handed to a publish site (diag + step-down read it). */
    @Volatile var current: Profile = Profile.HD720

    // ─── preferences / network ──────────────────────────────────────────────
    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isHdPreferred(ctx: Context?): Boolean =
        try { ctx != null && prefs(ctx).getBoolean(HD_PREF_KEY, false) } catch (_: Throwable) { false }

    fun setHdPreferred(ctx: Context, on: Boolean) {
        try { prefs(ctx).edit().putBoolean(HD_PREF_KEY, on).apply() } catch (_: Throwable) {}
    }

    private data class Net(val label: String, val cellular: Boolean, val metered: Boolean)

    private fun net(ctx: Context?): Net {
        if (ctx == null) return Net("unknown", false, false)
        return try {
            val cm = ctx.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                ?: return Net("unknown", false, false)
            val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
                ?: return Net("offline", false, false)
            val wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            val eth = caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
            val cell = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) && !wifi && !eth
            val metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
            val label = when { wifi -> "wifi"; eth -> "ethernet"; cell -> "cellular"; else -> "online" }
            Net(label, cell, metered)
        } catch (_: Throwable) { Net("unknown", false, false) }
    }

    fun networkLabel(ctx: Context?): String = net(ctx).label
    fun isCellular(ctx: Context?): Boolean = net(ctx).let { it.cellular || it.metered }

    /**
     * Network-aware pick. `localQualityScore` is the 0-3 bars score
     * (3 excellent … 1 poor, 0 lost/unknown — pass 3 when unknown).
     */
    fun profile(ctx: Context?, isGroup: Boolean, localQualityScore: Int = 3): Profile {
        if (isGroup) return Profile.GROUP540
        val n = net(ctx)
        if (n.cellular || n.metered) {
            // poor (1) or lost (0) on cellular → 540p; healthy cellular → 720p.
            return if (localQualityScore <= 1) Profile.SD540 else Profile.HD720
        }
        return if (isHdPreferred(ctx)) Profile.HD1080 else Profile.HD720
    }

    // ─── builders ───────────────────────────────────────────────────────────
    fun captureParams(p: Profile): VideoCaptureParameter = VideoCaptureParameter(p.width, p.height, p.fps)

    fun captureDefaults(ctx: Context?, isGroup: Boolean, localQualityScore: Int = 3, forced: Profile? = null): LocalVideoTrackOptions {
        val p = forced ?: profile(ctx, isGroup, localQualityScore)
        current = p
        Log.i(TAG, "capture profile=${p.name} ${p.width}x${p.height}@${p.fps} net=${net(ctx).label} hd_pref=${isHdPreferred(ctx)}")
        return LocalVideoTrackOptions(captureParams = captureParams(p))
    }

    fun publishDefaults(profile: Profile? = null): VideoTrackPublishDefaults {
        val p = profile ?: current
        val codec = NativeCallRoom.preferredVideoCodec()
        val useSimulcast = codec != "h264"
        return VideoTrackPublishDefaults(
            videoEncoding = VideoEncoding(p.maxBitrate, p.fps),
            simulcast = useSimulcast,
            videoCodec = codec,
            degradationPreference = RtpParameters.DegradationPreference.BALANCED
        )
    }

    fun screenShareCaptureDefaults(): LocalVideoTrackOptions =
        LocalVideoTrackOptions(isScreencast = true, captureParams = SCREEN_CAPTURE)

    fun screenSharePublishDefaults(): VideoTrackPublishDefaults =
        VideoTrackPublishDefaults(
            videoEncoding = SCREEN_ENCODING,
            simulcast = false,
            videoCodec = NativeCallRoom.preferredVideoCodec(),
            degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
        )

    // ─── mid-call step-down (cellular + sustained poor) ─────────────────────
    @Volatile private var poorStreak = 0
    @Volatile private var stepDownDone = false

    fun resetCallState() { poorStreak = 0; stepDownDone = false }

    /**
     * Call on every LOCAL ConnectionQualityChanged (0-3 score). Cellular + 2
     * consecutive poor/lost → restart the capturer at 540p IN PLACE
     * (LocalVideoTrack.restartTrack: same track, no republish). Skipped while a
     * background effect is active — restartTrack(videoProcessor = null) would
     * drop the processor. One-way per call; BALANCED degradation does the rest.
     */
    fun noteLocalQuality(ctx: Context?, room: Room?, score: Int, backgroundEffectOn: Boolean, callId: String) {
        if (score <= 1) poorStreak++ else poorStreak = 0
        if (stepDownDone || poorStreak < 2) return
        if (!isCellular(ctx)) return
        if (current.rank <= Profile.SD540.rank) return
        stepDownDone = true
        if (backgroundEffectOn) {
            Log.i(TAG, "step-down skipped (background effect active) — encoder degradation only")
            postDiag("video_profile_change", "cid=${callId.takeLast(12)} to=SD540 skipped=bg_effect net=${net(ctx).label}")
            return
        }
        val track = try {
            room?.localParticipant?.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack
        } catch (_: Throwable) { null } ?: return
        try {
            track.restartTrack(LocalVideoTrackOptions(captureParams = captureParams(Profile.SD540)))
            current = Profile.SD540
            Log.i(TAG, "video profile → SD540 (poor_cellular_x$poorStreak)")
            postDiag("video_profile_change", "cid=${callId.takeLast(12)} to=SD540 reason=poor_cellular_x$poorStreak net=${net(ctx).label}")
        } catch (t: Throwable) {
            Log.w(TAG, "restartTrack(SD540) failed: ${t.message}")
        }
    }

    // ─── diag beacon (push_diag.log) ────────────────────────────────────────
    /** Fire-and-forget POST to email.php?action=push_diag (same channel as
     *  NativeCrashReporter / the JS _diag helper). Never throws. */
    fun postDiag(step: String, info: String) {
        try {
            val body = JSONObject().apply {
                put("platform", "android")
                put("step", step.take(40))
                put("info", info.take(900))
                put("anon_id", "android-native")
                put("ts", System.currentTimeMillis())
            }.toString()
            Thread {
                try {
                    val conn = (URL(DIAG_ENDPOINT).openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"
                        doOutput = true
                        connectTimeout = 4000
                        readTimeout = 4000
                        setRequestProperty("Content-Type", "application/json")
                    }
                    try {
                        OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
                        conn.responseCode
                        try { conn.inputStream.close() } catch (_: Throwable) {}
                    } finally { try { conn.disconnect() } catch (_: Throwable) {} }
                } catch (_: Throwable) {}
            }.apply { isDaemon = true }.start()
        } catch (_: Throwable) {}
    }

    private fun m(members: Map<String, Any>, key: String): String {
        val v = members[key] ?: return "?"
        return when (v) {
            is Double -> if (v == Math.floor(v)) v.toLong().toString() else String.format("%.1f", v)
            else -> v.toString()
        }
    }

    private fun kbps(members: Map<String, Any>, key: String): String {
        val v = members[key] as? Number ?: return "?"
        return "${(v.toDouble() / 1000).toInt()}k"
    }

    /**
     * One "video_quality" beacon with the REAL negotiated numbers: encoded
     * res/fps/target bitrate/limitation/encoder + codec (publisher PC) and
     * received res/fps/drops + decoder (subscriber PC), plus profile/net/bars.
     * Read with: grep video_quality /var/www/mail/data/push_diag.log | tail
     */
    fun reportVideoQuality(ctx: Context?, room: Room, tag: String, callId: String, bars: Int) {
        try {
            val head = "cid=${callId.takeLast(12)} tag=$tag profile=${current.name} codec_pref=${NativeCallRoom.preferredVideoCodec()} net=${net(ctx).label} bars=$bars dev=${Build.MODEL}/${Build.VERSION.SDK_INT}"
            val camDims = try {
                (room.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack)?.dimensions
            } catch (_: Throwable) { null }
            val cap = if (camDims != null) " cap=${camDims.width}x${camDims.height}" else " cap=none"
            room.getPublisherRTCStats { pub: RTCStatsReport ->
                val sb = StringBuilder(head).append(cap)
                try {
                    val stats = pub.statsMap.values
                    val codecs = stats.filter { it.type == "codec" }.associateBy({ it.id }, { it.members["mimeType"]?.toString() ?: "?" })
                    stats.filter { it.type == "outbound-rtp" && (it.members["kind"] == "video" || it.members["mediaType"] == "video") }
                        .forEach { st ->
                            val mm = st.members
                            sb.append(" out=${m(mm, "frameWidth")}x${m(mm, "frameHeight")}@${m(mm, "framesPerSecond")}")
                            sb.append(" tgt=${kbps(mm, "targetBitrate")}")
                            sb.append(" lim=${m(mm, "qualityLimitationReason")}")
                            sb.append(" enc=${m(mm, "encoderImplementation")}")
                            sb.append(" pli=${m(mm, "pliCount")} nack=${m(mm, "nackCount")}")
                            sb.append(" codec=${codecs[mm["codecId"]?.toString()] ?: "?"}")
                            if (mm["rid"] != null) sb.append(" rid=${mm["rid"]}")
                        }
                } catch (t: Throwable) { sb.append(" out_err=${t.message}") }
                try {
                    room.getSubscriberRTCStats { sub: RTCStatsReport ->
                        try {
                            val stats = sub.statsMap.values
                            val codecs = stats.filter { it.type == "codec" }.associateBy({ it.id }, { it.members["mimeType"]?.toString() ?: "?" })
                            stats.filter { it.type == "inbound-rtp" && (it.members["kind"] == "video" || it.members["mediaType"] == "video") }
                                .forEach { st ->
                                    val mm = st.members
                                    sb.append(" rx=${m(mm, "frameWidth")}x${m(mm, "frameHeight")}@${m(mm, "framesPerSecond")}")
                                    sb.append(" drop=${m(mm, "framesDropped")} rx_pli=${m(mm, "pliCount")} rx_nack=${m(mm, "nackCount")}")
                                    sb.append(" dec=${m(mm, "decoderImplementation")}")
                                    sb.append(" rx_codec=${codecs[mm["codecId"]?.toString()] ?: "?"}")
                                }
                        } catch (t: Throwable) { sb.append(" rx_err=${t.message}") }
                        Log.i(TAG, "video_quality $sb")
                        postDiag("video_quality", sb.toString())
                    }
                } catch (t: Throwable) {
                    Log.i(TAG, "video_quality $sb (no subscriber stats: ${t.message})")
                    postDiag("video_quality", sb.toString())
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "reportVideoQuality failed: ${t.message}")
        }
    }
}
