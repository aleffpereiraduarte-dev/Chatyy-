package expo.modules.callkit

import android.content.Context
import android.util.Log
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

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
     * Snapshot consumed by `adoptNativeRoom(callId)`. Returns null if there
     * is no live Room or the Room hasn't reached CONNECTED yet — JS then
     * falls back to its own connect path.
     */
    fun getSnapshot(): Map<String, Any?>? {
        val r = room ?: return null
        if (r.state != Room.State.CONNECTED) return null
        return mapOf(
            "connected" to true,
            "alreadyConnected" to true,
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
                r.localParticipant.setCameraEnabled(enabled)
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
     */
    fun disconnect() {
        val r = room
        if (r == null) {
            Log.d(TAG, "disconnect: no live Room (no-op)")
            return
        }
        try {
            r.disconnect()
            Log.d(TAG, "disconnect: room.disconnect() called")
        } catch (t: Throwable) {
            Log.w(TAG, "disconnect threw: ${t.message}")
        } finally {
            clear()
        }
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
            else -> {
                // No-op: TrackMuted/TrackUnmuted/ActiveSpeakersChanged/etc.
                // are handled inside CallActivity's own collector for the
                // Compose UI. JS doesn't need every event mirrored.
            }
        }
    }
}
