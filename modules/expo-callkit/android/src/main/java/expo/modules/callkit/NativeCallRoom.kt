package expo.modules.callkit

import android.content.Context
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.audio.AudioSwitchHandler
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.Track
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Singleton owning the LiveKit Room used for incoming/outgoing calls when the
 * connection has to happen before the RN bundle is parsed (cold-start accept).
 *
 * Owned by Kotlin. JS calls `ExpoCallKit.adoptNativeRoom(callId)` from /call.js
 * which returns the connection snapshot; JS does NOT instantiate its own Room
 * in that case — only subscribes to events that this object emits via
 * ExpoCallKitModule.emit* companion methods.
 *
 * Lifecycle:
 *   - `connect()` from IncomingCallActivity.onAccept (cold path) OR from JS
 *     via `lkConnect(...)` (outgoing/warm path).
 *   - Events flow into ExpoCallKitModule and out to JS via Expo event channels.
 *   - `disconnect()` from JS via `lkDisconnect()` or auto on call end.
 */
object NativeCallRoom {
    private const val TAG = "NativeCallRoom"

    @Volatile private var room: Room? = null
    @Volatile private var activeCallId: String? = null
    private var audioSwitch: AudioSwitchHandler? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var eventJob: Job? = null
    private val lock = Any()

    /** True when there's a connected Room. JS reads this via `isNativeRoomConnected()`. */
    fun isConnected(): Boolean = synchronized(lock) { room?.state?.value == Room.State.CONNECTED }

    fun currentCallId(): String? = synchronized(lock) { activeCallId }

    /**
     * Connects to a LiveKit room. Idempotent for the same callId — if a
     * connection is already active for the same call, it's a no-op.
     *
     * Safe to call from any thread. The actual connect runs on IO dispatcher.
     */
    fun connect(
        ctx: Context,
        url: String,
        token: String,
        callId: String,
        hasVideo: Boolean,
    ) {
        synchronized(lock) {
            if (activeCallId == callId && room?.state?.value == Room.State.CONNECTED) {
                Log.i(TAG, "Already connected to $callId, skipping")
                return
            }
            if (room != null) {
                Log.w(TAG, "Replacing existing room (was: $activeCallId, new: $callId)")
                disconnectInternal()
            }
            activeCallId = callId
        }

        scope.launch {
            try {
                val appCtx = ctx.applicationContext
                val newRoom = LiveKit.create(
                    appContext = appCtx,
                    options = RoomOptions(
                        adaptiveStream = true,
                        dynacast = true,
                    ),
                )
                synchronized(lock) { room = newRoom }

                // Start AudioSwitchHandler BEFORE connect — it manages routing
                // (earpiece/speaker/BT) and activates AudioManager mode. Without
                // this, no audio plays even after subscribing to remote track.
                val switch = AudioSwitchHandler(appCtx)
                switch.start()
                audioSwitch = switch

                Log.i(TAG, "Connecting to $url (call=$callId)")
                newRoom.connect(
                    url = url,
                    token = token,
                    options = ConnectOptions(autoSubscribe = true),
                )

                // Local participant: enable mic (always) + camera if video call.
                newRoom.localParticipant.setMicrophoneEnabled(true)
                if (hasVideo) {
                    newRoom.localParticipant.setCameraEnabled(true)
                }

                Log.i(TAG, "Connected. Local SID=${newRoom.localParticipant.sid?.value}")
                ExpoCallKitModule.emitLkConnected(callId, snapshot(newRoom))

                // Collect events forever (until disconnected or job cancelled).
                eventJob = scope.launch {
                    newRoom.events.collect { ev -> forwardEvent(callId, ev) }
                }
            } catch (t: Throwable) {
                Log.e(TAG, "connect failed: ${t.message}", t)
                ExpoCallKitModule.emitLkError(callId, t.message ?: "connect failed")
                synchronized(lock) {
                    room = null
                    activeCallId = null
                }
            }
        }
    }

    private fun forwardEvent(callId: String, ev: RoomEvent) {
        when (ev) {
            is RoomEvent.ParticipantConnected -> {
                ExpoCallKitModule.emitLkParticipantConnected(
                    callId, ev.participant.identity?.value ?: "", ev.participant.sid?.value ?: ""
                )
            }
            is RoomEvent.ParticipantDisconnected -> {
                ExpoCallKitModule.emitLkParticipantDisconnected(
                    callId, ev.participant.identity?.value ?: ""
                )
            }
            is RoomEvent.TrackSubscribed -> {
                ExpoCallKitModule.emitLkTrackSubscribed(
                    callId,
                    ev.participant.identity?.value ?: "",
                    ev.track.kind.name.lowercase(),
                    ev.track.sid ?: "",
                )
            }
            is RoomEvent.TrackUnsubscribed -> {
                ExpoCallKitModule.emitLkTrackUnsubscribed(
                    callId,
                    ev.participant.identity?.value ?: "",
                    ev.track.kind.name.lowercase(),
                )
            }
            is RoomEvent.ConnectionQualityChanged -> {
                ExpoCallKitModule.emitLkConnectionQuality(
                    callId,
                    ev.participant.identity?.value ?: "",
                    ev.quality.name.lowercase(),
                )
            }
            is RoomEvent.Disconnected -> {
                ExpoCallKitModule.emitLkDisconnected(callId, ev.reason?.name ?: "unknown")
                // Server-initiated disconnect (e.g. JS opened a second Room
                // with same identity → server kicked us). Clean up state so
                // future calls start fresh.
                synchronized(lock) {
                    if (room?.state?.value == Room.State.DISCONNECTED) {
                        Log.i(TAG, "Disconnected event — cleaning up state")
                        eventJob?.cancel()
                        eventJob = null
                        audioSwitch?.stop()
                        audioSwitch = null
                        room = null
                        activeCallId = null
                    }
                }
            }
            is RoomEvent.DataReceived -> {
                ExpoCallKitModule.emitLkDataReceived(
                    callId,
                    ev.participant?.identity?.value ?: "",
                    String(ev.data, Charsets.UTF_8),
                )
            }
            else -> { /* ignore: TrackMuted/Unmuted/Reconnecting/etc */ }
        }
    }

    /** Read-only snapshot of current state for `adoptNativeRoom()` return value. */
    private fun snapshot(r: Room): Map<String, Any?> {
        return mapOf(
            "callId" to activeCallId,
            "state" to r.state.value.name.lowercase(),
            "localSid" to (r.localParticipant.sid?.value),
            "localIdentity" to (r.localParticipant.identity?.value),
            "participants" to r.remoteParticipants.values.map { p ->
                mapOf(
                    "sid" to (p.sid?.value),
                    "identity" to (p.identity?.value),
                    "tracks" to p.trackPublications.values.mapNotNull { pub ->
                        pub.track?.let { t ->
                            mapOf(
                                "sid" to t.sid,
                                "kind" to t.kind.name.lowercase(),
                                "subscribed" to true,
                            )
                        }
                    }
                )
            }
        )
    }

    suspend fun getSnapshot(): Map<String, Any?>? = withContext(Dispatchers.Default) {
        val r = synchronized(lock) { room } ?: return@withContext null
        snapshot(r)
    }

    suspend fun setMicEnabled(enabled: Boolean) = withContext(Dispatchers.IO) {
        try {
            synchronized(lock) { room }?.localParticipant?.setMicrophoneEnabled(enabled)
        } catch (t: Throwable) {
            Log.e(TAG, "setMicEnabled failed: ${t.message}")
        }
    }

    suspend fun setCameraEnabled(enabled: Boolean) = withContext(Dispatchers.IO) {
        try {
            synchronized(lock) { room }?.localParticipant?.setCameraEnabled(enabled)
        } catch (t: Throwable) {
            Log.e(TAG, "setCameraEnabled failed: ${t.message}")
        }
    }

    fun disconnect() {
        synchronized(lock) {
            if (room == null) return
            disconnectInternal()
        }
    }

    private fun disconnectInternal() {
        // assumes caller holds `lock`
        try {
            eventJob?.cancel()
            eventJob = null
            audioSwitch?.stop()
            audioSwitch = null
            room?.disconnect()
        } catch (t: Throwable) {
            Log.w(TAG, "disconnect cleanup error: ${t.message}")
        } finally {
            room = null
            activeCallId = null
        }
    }
}
