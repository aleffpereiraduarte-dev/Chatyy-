package expo.modules.callkit

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Fetches a LiveKit JWT token + URL from the backend so the native side can
 * connect to a Room before the JS bundle parses.
 *
 * Bearer token + API base come from SharedPreferences ("expo_callkit_prefs"),
 * persisted by `services/api.js` on login via
 * `ExpoCallKit.persistAuthForNativeCall(token, baseUrl)`.
 *
 * Backend endpoint: POST {base}/api/chat.php?action=chat_livekit_token
 *   body: {room_name, identity, role: "subscriber"}
 *   returns: {token, url}
 */
object LkTokenFetcher {
    private const val TAG = "LkTokenFetcher"
    private const val PREFS = "expo_callkit_prefs"
    private const val KEY_AUTH = "auth_token"
    private const val KEY_BASE = "api_base"

    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .writeTimeout(5, TimeUnit.SECONDS)
        .build()

    data class Result(val token: String, val url: String)

    /** Synchronous — call from a background thread / coroutine. */
    fun fetch(ctx: Context, roomName: String, identity: String): Result? {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val authToken = prefs.getString(KEY_AUTH, null)
        val base = prefs.getString(KEY_BASE, null)
        if (authToken.isNullOrBlank() || base.isNullOrBlank()) {
            Log.w(TAG, "Missing auth/base in prefs — JS hasn't called persistAuthForNativeCall yet")
            return null
        }

        val body = JSONObject().apply {
            put("room_name", roomName)
            put("identity", identity)
            put("role", "subscriber")
        }.toString().toRequestBody("application/json".toMediaType())

        val req = Request.Builder()
            .url("$base/api/chat.php?action=chat_livekit_token")
            .header("Authorization", "Bearer $authToken")
            .header("Content-Type", "application/json")
            .post(body)
            .build()

        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    Log.w(TAG, "token fetch HTTP ${resp.code}")
                    return null
                }
                val json = JSONObject(resp.body?.string().orEmpty())
                val token = json.optString("token")
                val url = json.optString("url")
                if (token.isBlank() || url.isBlank()) {
                    Log.w(TAG, "token fetch missing fields in response")
                    return null
                }
                Result(token, url)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "token fetch failed: ${t.message}")
            null
        }
    }

    /** Stash pre-fetched token+url (e.g. JS sent it via persistPendingLkToken when push received). */
    fun setCached(ctx: Context, roomName: String, token: String, url: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("lk_token_$roomName", token)
            .putString("lk_url_$roomName", url)
            .putLong("lk_ts_$roomName", System.currentTimeMillis())
            .apply()
    }

    /** Returns cached token if it's fresh (< 5 min old). LiveKit tokens TTL ~6h, but we
     *  re-fetch if older to avoid edge cases. */
    fun getCached(ctx: Context, roomName: String): Result? {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val ts = prefs.getLong("lk_ts_$roomName", 0)
        if (ts == 0L || System.currentTimeMillis() - ts > 5 * 60 * 1000) return null
        val token = prefs.getString("lk_token_$roomName", null) ?: return null
        val url = prefs.getString("lk_url_$roomName", null) ?: return null
        return Result(token, url)
    }

    fun clearCached(ctx: Context, roomName: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove("lk_token_$roomName")
            .remove("lk_url_$roomName")
            .remove("lk_ts_$roomName")
            .apply()
    }
}
