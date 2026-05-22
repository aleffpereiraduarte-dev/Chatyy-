// CurrentCallTracker.kt
//
// [Wave Bridge-Surface, 2026-05-21 / Agent 9] Backing storage for the
// CallStateSnapshot read API. Native code (CallActivity, ChatyyConnection,
// IncomingCallActivity, CallSignalWs, AudioRouter) writes to this tracker
// as the call advances; ExpoCallKitModule.getCurrentCallSnapshot() reads.
//
// JS NEVER writes to this. The whole point of the bridge-surface policy is
// that JS cannot reach into the call state machine — JS only reads the
// composed snapshot. See docs/whatsapp-migration/IMPL-bridge-surface-policy.md.
//
// Companion to iOS' `ExpoCallKitModule.currentCallContext` (instance state
// on the module). We use a singleton on Android because the Telecom
// pipeline (CallActivity → ChatyyConnection → AudioRouter) is process-wide
// and can't always reach the active module instance.

package expo.modules.callkit

import java.util.concurrent.atomic.AtomicReference

object CurrentCallTracker {

    /** Snapshot of the active call. Null = no call in progress. */
    data class Active(
        val callId: String,
        val contactEmail: String,
        val contactName: String,
        val isVideo: Boolean,
        val mic: Boolean,
        val speaker: Boolean,
        /** Epoch millis when the call was answered. 0 while ringing. */
        val startedAtMs: Long,
        val ringState: String,
    ) {
        /** Seconds since the call connected. 0 if not yet answered. */
        fun durationSec(): Int {
            if (startedAtMs <= 0L) return 0
            val delta = (System.currentTimeMillis() - startedAtMs) / 1000L
            return delta.coerceAtLeast(0L).toInt()
        }
    }

    // AtomicReference avoids locking on the read path (getCurrentCallSnapshot
    // is called every 1s from JS poll). Writes are infrequent enough that
    // the CAS loop is fine.
    private val active = AtomicReference<Active?>(null)

    /** Called when a new call enters ringing state (incoming) or connecting
     *  (outgoing). */
    @JvmStatic
    fun begin(
        callId: String,
        contactEmail: String,
        contactName: String,
        isVideo: Boolean,
        ringState: String = "ringing",
    ) {
        active.set(
            Active(
                callId = callId,
                contactEmail = contactEmail,
                contactName = contactName,
                isVideo = isVideo,
                mic = true,
                speaker = false,
                startedAtMs = 0L,
                ringState = ringState,
            )
        )
    }

    /** Called when CallKit/Telecom marks the call as answered/active. */
    @JvmStatic
    fun markActive() {
        active.getAndUpdate { cur ->
            cur?.copy(ringState = "active", startedAtMs = System.currentTimeMillis())
        }
    }

    /** Called when the call moves to connecting (post-answer, pre-media). */
    @JvmStatic
    fun markConnecting() {
        active.getAndUpdate { cur -> cur?.copy(ringState = "connecting") }
    }

    /** Hold/resume transitions. */
    @JvmStatic
    fun setHeld(held: Boolean) {
        active.getAndUpdate { cur ->
            cur?.copy(ringState = if (held) "held" else "active")
        }
    }

    /** Mic mute/unmute. `mic` = true means unmuted. */
    @JvmStatic
    fun setMic(mic: Boolean) {
        active.getAndUpdate { cur -> cur?.copy(mic = mic) }
    }

    /** Speaker on/off. */
    @JvmStatic
    fun setSpeaker(speaker: Boolean) {
        active.getAndUpdate { cur -> cur?.copy(speaker = speaker) }
    }

    /** Clear the snapshot — call has ended. */
    @JvmStatic
    fun end() {
        active.set(null)
    }

    /** Read for the JS snapshot bridge. Returns null when no call. */
    @JvmStatic
    fun snapshotOrNull(): Active? = active.get()

    // TODO(Agent 9 follow-up wave): wire write sites
    //   - CallFirebaseMessagingService.onMessageReceived  → begin "ringing"
    //   - IncomingCallActivity.onAccept                   → markConnecting
    //   - ChatyyConnection.onAnswer                       → markActive
    //   - ChatyyConnection.onHold / onUnhold              → setHeld(true/false)
    //   - AudioRouter speaker route change                → setSpeaker
    //   - CXSetMutedCallAction-equivalent (mute path)     → setMic
    //   - cleanup paths (CallEnded/CallActivity.onDestroy)→ end()
    // Until those land, snapshotOrNull() returns null even mid-call;
    // CallStatusBar falls back to CallContext via the hybrid path.
}
