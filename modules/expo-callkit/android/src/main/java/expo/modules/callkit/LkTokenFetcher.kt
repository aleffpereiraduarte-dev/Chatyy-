package expo.modules.callkit

import android.content.Context
import android.util.Log

/**
 * Stub — see NativeCallRoom.kt for context. Will be reimplemented when
 * Stage 1 v2 lands with the correct LiveKit Android API.
 */
object LkTokenFetcher {
    private const val TAG = "LkTokenFetcher"
    data class Result(val token: String, val url: String)
    fun fetch(ctx: Context, roomName: String, identity: String): Result? = null
    fun setCached(ctx: Context, roomName: String, token: String, url: String) {}
    fun getCached(ctx: Context, roomName: String): Result? = null
    fun clearCached(ctx: Context, roomName: String) {}
}
