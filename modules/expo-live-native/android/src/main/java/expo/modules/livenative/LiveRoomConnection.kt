package expo.modules.livenative

import android.content.Context
import android.util.Log
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicReference

/**
 * Singleton wrapper around a single LiveKit [Room]. Holds the entire Live
 * session lifecycle (connect / publish / subscribe / disconnect) so the host
 * + viewer Activities don't have to care about ordering — they observe state
 * flows and re-render.
 *
 * We keep ONE room at a time. Calling [connectAsHost] or [connectAsViewer]
 * while a previous session is alive disconnects it first.
 *
 * The Activity owns the lifetime (calls [disconnect] in onDestroy). The Module
 * piggybacks on the same instance so it can emit JS events when the room ends.
 *
 * NOTE: this file is intentionally light on error handling — scaffolding only.
 * Production polish (reconnect, ICE retry, audio session focus, etc.) comes
 * later. See `app/live-broadcast.js` / `app/live-viewer.js` for the JS-side
 * reconnect logic that will eventually port over here.
 */
object LiveRoomConnection {

    private const val TAG = "LiveRoomConn"

    enum class Mode { NONE, HOST, VIEWER }

    enum class ConnectionState {
        IDLE,
        CONNECTING,
        CONNECTED,
        RECONNECTING,
        DISCONNECTED,
        FAILED
    }

    data class RemoteVideo(
        val identity: String,
        val track: VideoTrack
    )

    /** Coarse-grained state the Activities can observe. */
    private val _state = MutableStateFlow(ConnectionState.IDLE)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    /** Last error message — surfaced to JS via `onLiveError`. */
    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    /** First remote video track seen — viewer pins to this. */
    private val _remoteVideo = MutableStateFlow<RemoteVideo?>(null)
    val remoteVideo: StateFlow<RemoteVideo?> = _remoteVideo.asStateFlow()

    /** Local camera video track — host preview pins to this. */
    private val _localVideo = MutableStateFlow<VideoTrack?>(null)
    val localVideo: StateFlow<VideoTrack?> = _localVideo.asStateFlow()

    /** Current participant count (host + remote). Snapshotted off RoomEvents. */
    private val _participantCount = MutableStateFlow(0)
    val participantCount: StateFlow<Int> = _participantCount.asStateFlow()

    private val _isMicEnabled = MutableStateFlow(true)
    val isMicEnabled: StateFlow<Boolean> = _isMicEnabled.asStateFlow()

    private val _isCameraEnabled = MutableStateFlow(true)
    val isCameraEnabled: StateFlow<Boolean> = _isCameraEnabled.asStateFlow()

    private val _isFrontCamera = MutableStateFlow(true)
    val isFrontCamera: StateFlow<Boolean> = _isFrontCamera.asStateFlow()

    private val roomRef = AtomicReference<Room?>(null)
    private var scope: CoroutineScope? = null
    private var eventJob: Job? = null
    private var mode: Mode = Mode.NONE

    /**
     * Callback hooks so the module can forward events to JS. The Activities
     * never set these — only [ExpoLiveNativeModule] does, on OnCreate.
     */
    @Volatile var onEnded: (() -> Unit)? = null

    @Volatile var onError: ((String) -> Unit)? = null

    @Volatile var onViewerJoined: ((identity: String) -> Unit)? = null

    @Volatile var onLikeReceived: ((from: String) -> Unit)? = null

    fun currentMode(): Mode = mode

    fun room(): Room? = roomRef.get()

    /**
     * Host path: publishes camera + mic and broadcasts to the room.
     * Idempotent — if a session is already alive we tear it down first.
     */
    suspend fun connectAsHost(
        appContext: Context,
        url: String,
        token: String
    ) {
        teardownInternal("connectAsHost")
        mode = Mode.HOST
        _state.value = ConnectionState.CONNECTING

        try {
            val room = LiveKit.create(
                appContext = appContext.applicationContext,
                options = RoomOptions(
                    adaptiveStream = true,
                    dynacast = true
                )
            )
            roomRef.set(room)
            beginEventLoop(room)

            room.connect(
                url = url,
                token = token,
                options = ConnectOptions(autoSubscribe = true)
            )

            val local: LocalParticipant = room.localParticipant
            // Camera first so the preview lights up ASAP.
            local.setCameraEnabled(true)
            local.setMicrophoneEnabled(true)
            _isMicEnabled.value = true
            _isCameraEnabled.value = true

            captureLocalVideoTrack(local)
            _participantCount.value = (room.remoteParticipants.size) + 1
            _state.value = ConnectionState.CONNECTED
            Log.d(TAG, "connectAsHost: connected, sid=${room.sid}")
        } catch (t: Throwable) {
            Log.e(TAG, "connectAsHost failed", t)
            _state.value = ConnectionState.FAILED
            _lastError.value = t.message ?: "Failed to start broadcast"
            onError?.invoke(_lastError.value ?: "unknown")
            disconnect()
        }
    }

    /**
     * Viewer path: connects subscribe-only. We deliberately do NOT publish
     * any tracks here — the JS chat layer handles comments / hearts.
     */
    suspend fun connectAsViewer(
        appContext: Context,
        url: String,
        token: String
    ) {
        teardownInternal("connectAsViewer")
        mode = Mode.VIEWER
        _state.value = ConnectionState.CONNECTING

        try {
            val room = LiveKit.create(
                appContext = appContext.applicationContext,
                options = RoomOptions(
                    adaptiveStream = true,
                    dynacast = false
                )
            )
            roomRef.set(room)
            beginEventLoop(room)

            room.connect(
                url = url,
                token = token,
                options = ConnectOptions(autoSubscribe = true)
            )

            // Snapshot any participants already in the room. New ones arrive
            // through the event loop.
            room.remoteParticipants.values.forEach { p ->
                captureRemoteVideoIfAny(p)
            }
            _participantCount.value = (room.remoteParticipants.size) + 1
            _state.value = ConnectionState.CONNECTED
            Log.d(TAG, "connectAsViewer: connected, sid=${room.sid}")
        } catch (t: Throwable) {
            Log.e(TAG, "connectAsViewer failed", t)
            _state.value = ConnectionState.FAILED
            _lastError.value = t.message ?: "Failed to join live"
            onError?.invoke(_lastError.value ?: "unknown")
            disconnect()
        }
    }

    fun toggleMic() {
        val room = roomRef.get() ?: return
        val s = scope ?: return
        s.launch {
            try {
                val next = !_isMicEnabled.value
                room.localParticipant.setMicrophoneEnabled(next)
                _isMicEnabled.value = next
            } catch (t: Throwable) {
                Log.w(TAG, "toggleMic failed", t)
            }
        }
    }

    fun toggleCamera() {
        val room = roomRef.get() ?: return
        val s = scope ?: return
        s.launch {
            try {
                val next = !_isCameraEnabled.value
                room.localParticipant.setCameraEnabled(next)
                _isCameraEnabled.value = next
                if (next) captureLocalVideoTrack(room.localParticipant)
            } catch (t: Throwable) {
                Log.w(TAG, "toggleCamera failed", t)
            }
        }
    }

    /**
     * Flip between front + back cameras. Implementation deliberately minimal
     * here — the real LiveKit API to swap cameras goes through
     * `CameraCapturer.switchCamera()`; the scaffold logs a TODO so the
     * Compose UI button still wires up cleanly.
     */
    fun switchCamera() {
        val s = scope ?: return
        s.launch {
            try {
                // TODO(live-native): call CameraCapturer.switchCamera() on the
                //                    underlying VideoCapturer. The LiveKit
                //                    public API exposes this via
                //                    `room.localParticipant.getTrackPublication(...)
                //                       ?.track?.let { (it as? LocalVideoTrack)
                //                       ?.options?.position }`
                _isFrontCamera.value = !_isFrontCamera.value
                Log.d(TAG, "switchCamera: front=${_isFrontCamera.value} (stub)")
            } catch (t: Throwable) {
                Log.w(TAG, "switchCamera failed", t)
            }
        }
    }

    fun disconnect() {
        teardownInternal("disconnect")
        _state.value = ConnectionState.DISCONNECTED
        mode = Mode.NONE
        onEnded?.invoke()
    }

    // ---------------- internals ----------------

    private fun teardownInternal(reason: String) {
        try {
            eventJob?.cancel()
        } catch (_: Throwable) {}
        eventJob = null
        try {
            scope?.cancel()
        } catch (_: Throwable) {}
        scope = null
        val r = roomRef.getAndSet(null)
        if (r != null) {
            try { r.disconnect() } catch (t: Throwable) { Log.w(TAG, "disconnect failed", t) }
        }
        _localVideo.value = null
        _remoteVideo.value = null
        _participantCount.value = 0
        Log.d(TAG, "teardownInternal($reason)")
    }

    private fun beginEventLoop(room: Room) {
        val s = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        scope = s
        eventJob = s.launch {
            room.events.collect { ev: RoomEvent ->
                handleRoomEvent(room, ev)
            }
        }
    }

    private fun handleRoomEvent(room: Room, ev: RoomEvent) {
        when (ev) {
            is RoomEvent.ParticipantConnected -> {
                _participantCount.value = room.remoteParticipants.size + 1
                onViewerJoined?.invoke(identityOf(ev.participant))
                captureRemoteVideoIfAny(ev.participant)
            }
            is RoomEvent.ParticipantDisconnected -> {
                _participantCount.value = room.remoteParticipants.size + 1
                // If the disconnected one was our pinned remote, clear it.
                val pinned = _remoteVideo.value
                if (pinned != null && pinned.identity == (identityOf(ev.participant))) {
                    _remoteVideo.value = null
                    room.remoteParticipants.values.firstOrNull()
                        ?.let { captureRemoteVideoIfAny(it) }
                }
            }
            is RoomEvent.TrackSubscribed -> {
                val track = ev.track
                if (track is VideoTrack) {
                    val p = ev.participant
                    if (p is RemoteParticipant) captureRemoteVideoIfAny(p)
                }
            }
            is RoomEvent.TrackUnsubscribed -> {
                val pinned = _remoteVideo.value
                val ident = (identityOf(ev.participant))
                if (pinned != null && pinned.identity == ident) {
                    _remoteVideo.value = null
                }
            }
            is RoomEvent.LocalTrackPublished -> {
                captureLocalVideoTrack(room.localParticipant)
            }
            is RoomEvent.Reconnecting -> {
                _state.value = ConnectionState.RECONNECTING
            }
            is RoomEvent.Reconnected -> {
                _state.value = ConnectionState.CONNECTED
            }
            is RoomEvent.Disconnected -> {
                _state.value = ConnectionState.DISCONNECTED
                onEnded?.invoke()
            }
            is RoomEvent.FailedToConnect -> {
                _state.value = ConnectionState.FAILED
                val msg = runCatching {
                    // The exact property name has shifted across LiveKit
                    // releases (`.error`, `.throwable`, `.cause`). Reflect
                    // it lazily so a version bump doesn't break compile.
                    val f = ev.javaClass.declaredFields.firstOrNull {
                        Throwable::class.java.isAssignableFrom(it.type)
                    }
                    f?.let { it.isAccessible = true; (it.get(ev) as? Throwable)?.message }
                }.getOrNull()
                _lastError.value = msg ?: "Connection failed"
                onError?.invoke(_lastError.value ?: "unknown")
            }
            is RoomEvent.DataReceived -> {
                // Simple text data → treat as "like" if payload is `like`.
                // The real chat layer still lives in JS for v1; this is a
                // placeholder so the heart-button bridge has something to fire.
                try {
                    val payload = String(ev.data)
                    if (payload == "like" || payload == "heart") {
                        val from = ev.participant?.let { identityOf(it) } ?: ""
                        onLikeReceived?.invoke(from)
                    }
                } catch (_: Throwable) {}
            }
            else -> { /* ignore the rest for scaffold */ }
        }
    }

    private fun captureLocalVideoTrack(local: LocalParticipant) {
        try {
            val pub = local.getTrackPublication(Track.Source.CAMERA)
            val track = pub?.track as? LocalVideoTrack
            if (track != null) {
                _localVideo.value = track
            }
        } catch (t: Throwable) {
            Log.w(TAG, "captureLocalVideoTrack failed", t)
        }
    }

    private fun captureRemoteVideoIfAny(participant: RemoteParticipant) {
        try {
            val ident = identityOf(participant)
            if (ident.isEmpty()) return
            val videoPub = participant.trackPublications.values
                .firstOrNull { it.track is VideoTrack && it.subscribed }
            val vt = videoPub?.track as? VideoTrack
            if (vt != null) {
                _remoteVideo.value = RemoteVideo(identity = ident, track = vt)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "captureRemoteVideoIfAny failed", t)
        }
    }

    /**
     * Reflective identity reader. `Participant.identity` returns a value class
     * `Participant.Identity(val value: String)` in LiveKit 2.x, but the exact
     * accessor name (`value`, `getValue`, `getIdentity`) shifts across minor
     * releases. Use reflection so a bump doesn't break compile.
     */
    private fun identityOf(p: io.livekit.android.room.participant.Participant?): String {
        if (p == null) return ""
        return runCatching {
            val ident = p.identity ?: return@runCatching ""
            // First try .value (Kotlin value class accessor)
            val valueField = ident.javaClass.declaredFields.firstOrNull { it.name == "value" }
            if (valueField != null) {
                valueField.isAccessible = true
                return@runCatching (valueField.get(ident) as? String) ?: ident.toString()
            }
            // Fall back to toString()
            ident.toString()
        }.getOrDefault("")
    }
}
