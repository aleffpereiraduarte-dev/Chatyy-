package expo.modules.callkit

import android.content.Context
import android.util.Log

/**
 * NativeCallRoom — STUB (2026-05-15)
 *
 * Andriod LiveKit pre-connect path was scaffolded but the io.livekit:livekit-android
 * 2.x API surface (Room.connect signatures, RoomOptions params, RoomEvent names)
 * didn't match what we wrote. The CI gradle compile failed.
 *
 * This stub is intentionally a no-op. The Android cold-start accept path still
 * benefits from the 12 fixes shipped in commit 5a526e5 (SharedPrefs commit()
 * instead of apply(), LruCache for avatars, IMPORTANCE_VISIBLE guard, FGS catch,
 * canUseFullScreenIntent guard, single ringtone path, audio focus, FOREGROUND_
 * SERVICE_PHONE_CALL manifest, onNewIntent callId mismatch check, currentCallId
 * compareAndSet, HttpsURLConnection timeout, activity safety 15s).
 *
 * The JS-driven LiveKit Room.connect still runs from /call.js on mount, so the
 * call still completes — just without the <500ms native audio pre-connect that
 * Stage 1 was supposed to deliver. iOS Stage 2 (NativeCallRoom.swift) is
 * separately wired and DOES pre-connect natively.
 *
 * TODO: Re-implement using the actual 2.22.x API. Reference:
 *   https://docs.livekit.io/reference/client-sdk-android/livekit-android-sdk/io.livekit.android.room/-room/
 *   https://github.com/livekit/client-sdk-android/blob/main/sample-app-basic/src/main/java/io/livekit/android/sample/basic/MainActivity.kt
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
        Log.i(TAG, "Stub: connect(callId=$callId) — native LK pre-connect deferred to Stage 1 v2")
    }

    suspend fun setMicEnabled(enabled: Boolean) {
        Log.d(TAG, "Stub: setMicEnabled($enabled)")
    }

    suspend fun setCameraEnabled(enabled: Boolean) {
        Log.d(TAG, "Stub: setCameraEnabled($enabled)")
    }

    suspend fun getSnapshot(): Map<String, Any?>? = null

    fun disconnect() {
        Log.d(TAG, "Stub: disconnect()")
    }
}
