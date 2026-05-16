package expo.modules.callkit

import android.content.Context
import android.util.Log

/**
 * NativeCallRoom — STUB (2026-05-15)
 *
 * Stage 1 v1 LiveKit native pre-connect deferred. Will be reimplemented
 * after verifying the correct LiveKit Android 2.22.x API. This stub keeps
 * ExpoCallKitModule's JS-facing functions compiling and returning sensible
 * no-op values until then.
 */
object NativeCallRoom {
    private const val TAG = "NativeCallRoom"

    fun isConnected(): Boolean = false

    fun currentCallId(): String? = null

    fun connect(
        ctx: Context,
        url: String,
        token: String,
        callId: String,
        hasVideo: Boolean,
    ) {
        Log.i(TAG, "Stub: connect(callId=$callId) — native LK pre-connect deferred")
    }

    fun setMicEnabled(enabled: Boolean) {
        Log.d(TAG, "Stub: setMicEnabled($enabled)")
    }

    fun setCameraEnabled(enabled: Boolean) {
        Log.d(TAG, "Stub: setCameraEnabled($enabled)")
    }

    fun getSnapshot(): Map<String, Any?>? = null

    fun disconnect() {
        Log.d(TAG, "Stub: disconnect()")
    }
}
