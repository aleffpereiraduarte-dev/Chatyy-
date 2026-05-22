// CallStateSnapshot.kt
//
// [Wave Bridge-Surface, 2026-05-21 / Agent 9] Read-only call state DTO
// returned by ExpoCallKitModule.getCurrentCallSnapshot(). Kotlin mirror of
// modules/expo-callkit/ios/CallStateSnapshot.swift — keep fields and types
// in lockstep with the Swift struct AND with the JS shape consumed by
// services/call-state-reader.js.
//
// Background — see docs/whatsapp-migration/08-native-call-no-bridge.md and
// docs/whatsapp-migration/IMPL-bridge-surface-policy.md. The native call
// state machine has exactly ONE shape it can serialize back to JS, and
// that shape is this data class.

package expo.modules.callkit

/**
 * Snapshot of the currently-active call. Exposed to JS via
 * [ExpoCallKitModule.getCurrentCallSnapshot] — synchronous, single bridge
 * crossing. Total payload ~300 bytes.
 *
 * Returned as a [Map] to Expo Modules (see [toMap]) since the Expo Modules
 * Android runtime serializes Kotlin data classes inconsistently across
 * SDK 51–55. Maps are bullet-proof.
 *
 * @property callId Server-side call id. Empty when no call active.
 * @property contactEmail Peer email (full address). Empty if not yet known.
 * @property contactName Display name resolved from contacts/backend.
 * @property isVideo Audio-only = `false`, video = `true`.
 * @property mic `true` = mic open, `false` = muted.
 * @property speaker `true` = audio routed to speaker (vs earpiece/headset).
 * @property durationSec Seconds since CallKit/Telecom marked the call
 *   answered. `0` while ringing or connecting.
 * @property lkConnected `true` when the underlying LiveKit Room is in
 *   `Connected` state. False during ring / connect / after peer hangup.
 * @property ringState One of `"idle" | "ringing" | "connecting" |
 *   "active" | "held" | "ended"`.
 */
data class CallStateSnapshot(
    val callId: String,
    val contactEmail: String,
    val contactName: String,
    val isVideo: Boolean,
    val mic: Boolean,
    val speaker: Boolean,
    val durationSec: Int,
    val lkConnected: Boolean,
    val ringState: String,
) {
    /**
     * Serialize to a `Map<String, Any>` for the Expo Modules JS bridge.
     * The module's `Function("getCurrentCallSnapshot")` body calls this.
     *
     * Field order matches Swift's [CallStateSnapshot.toDictionary] so logs
     * align side-by-side when comparing iOS and Android runs.
     */
    fun toMap(): Map<String, Any> = mapOf(
        "callId" to callId,
        "contactEmail" to contactEmail,
        "contactName" to contactName,
        "isVideo" to isVideo,
        "mic" to mic,
        "speaker" to speaker,
        "durationSec" to durationSec,
        "lkConnected" to lkConnected,
        "ringState" to ringState,
    )

    companion object {
        /** Sentinel "no active call" — JS sees `null` instead, but use
         *  this constant where Kotlin needs a default value. */
        val IDLE = CallStateSnapshot(
            callId = "",
            contactEmail = "",
            contactName = "",
            isVideo = false,
            mic = true,
            speaker = false,
            durationSec = 0,
            lkConnected = false,
            ringState = "idle",
        )
    }
}
