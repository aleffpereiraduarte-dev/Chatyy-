package expo.modules.callkit

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * LkTokenFetcher — fetches (or returns cached) LiveKit token+url from the
 * backend WITHOUT relying on the JS bridge.
 *
 * Used by:
 *   - IncomingCallActivity.onAccept (warm path: cache hit, cold path: fetch)
 *   - CallActionReceiver.ACTION_ACCEPT_CALL (same logic from notification btn)
 *   - CallFirebaseMessagingService (auto-accept cold-start path)
 *
 * Requires JS to have called `persistAuthForNativeCall(token, baseUrl)` at
 * login time so the Kotlin side can find `auth_token` + `api_base` in the
 * "expo_callkit_prefs" SharedPreferences.
 *
 * Backend contract (chat.php case 'chat_livekit_token'):
 *   POST <api_base>/api/email.php?action=chat_livekit_token
 *   Headers: Authorization: Bearer <token>, Content-Type: application/json
 *   Body:    { "action": "chat_livekit_token", "room": "<callId>",
 *              "identity": "<user_email>", "role": "publisher" }
 *   Response: { success: true, data: { token, url, room, identity, ... } }
 *
 * All errors are swallowed → null return. The caller is expected to fall
 * back to the legacy JS-side connect path when this returns null.
 */
object LkTokenFetcher {
    private const val TAG = "LkTokenFetcher"
    private const val PREFS_NAME = "expo_callkit_prefs"
    private const val TIMEOUT_CONNECT_MS = 5_000
    private const val TIMEOUT_READ_MS = 8_000
    // Cache TTL: a token is good for 6h on the backend side; we re-fetch
    // whenever the cached entry is older than 30s to avoid stale-token races
    // if the call was rescheduled / the user re-signed in.
    private const val CACHE_TTL_MS = 30_000L

    data class Result(val token: String, val url: String)

    // ────────────────── public API ──────────────────

    /**
     * Synchronous-style fetch (runs on caller's thread — caller MUST NOT be
     * the main thread). Returns null on any error. Callers
     * (IncomingCallActivity#launchCallActivity, CallActionReceiver,
     * CallFirebaseMessagingService) invoke this from a worker Thread or
     * Dispatchers.IO coroutine, so blocking I/O here is fine.
     */
    fun fetch(ctx: Context, roomName: String, identity: String): Result? {
        return try {
            doFetch(ctx, roomName, identity)
        } catch (t: Throwable) {
            Log.w(TAG, "fetch failed: ${t.message}")
            null
        }
    }

    /**
     * Coroutine-friendly variant — runs the blocking fetch on IO dispatcher.
     * Use from suspend contexts (e.g. CallActivity.bringUpRoom or a
     * lifecycleScope.launch inside IncomingCallActivity).
     *
     * `isVideo` is accepted for API symmetry with the call site but is NOT
     * sent to the backend — the LiveKit grant on the server is the same
     * regardless of audio/video (canPublish covers both tracks). The flag
     * is preserved here so future shaping (subscribe-only viewer token,
     * audio-only publisher token, etc.) doesn't require touching callers.
     */
    suspend fun fetchToken(ctx: Context, callId: String, isVideo: Boolean): Result? {
        if (callId.isEmpty()) return null
        return withContext(Dispatchers.IO) {
            val identity = resolveIdentity(ctx)
            // Cache check first — saves a round trip if JS already pre-stashed.
            val cached = getCached(ctx, callId)
            if (cached != null) {
                Log.d(TAG, "fetchToken: cache hit for $callId")
                return@withContext cached
            }
            doFetch(ctx, callId, identity)
        }
    }

    // ────────────────── cache (warm path) ──────────────────

    /**
     * Pre-stash a token JS just fetched. Lets the native accept path skip
     * the HTTP round-trip when the JS side has already done the work
     * (call_invite WS handler in IncomingCallListener / chat-conversation).
     */
    fun setCached(ctx: Context, roomName: String, token: String, url: String) {
        if (roomName.isEmpty() || token.isEmpty() || url.isEmpty()) return
        try {
            val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_TOKEN_CACHE, "{}") ?: "{}"
            val obj = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
            val entry = JSONObject().apply {
                put("token", token)
                put("url", url)
                put("at", System.currentTimeMillis())
            }
            obj.put(roomName, entry)
            prefs.edit().putString(KEY_TOKEN_CACHE, obj.toString()).apply()
            Log.d(TAG, "setCached: stashed token for room=$roomName")
        } catch (t: Throwable) {
            Log.w(TAG, "setCached failed: ${t.message}")
        }
    }

    fun getCached(ctx: Context, roomName: String): Result? {
        if (roomName.isEmpty()) return null
        return try {
            val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_TOKEN_CACHE, null) ?: return null
            val obj = JSONObject(raw)
            val entry = obj.optJSONObject(roomName) ?: return null
            val at = entry.optLong("at", 0L)
            if (System.currentTimeMillis() - at > CACHE_TTL_MS) {
                Log.d(TAG, "getCached: stale entry for room=$roomName, ignoring")
                return null
            }
            val token = entry.optString("token", "")
            val url = entry.optString("url", "")
            if (token.isEmpty() || url.isEmpty()) return null
            Result(token, url)
        } catch (t: Throwable) {
            Log.w(TAG, "getCached failed: ${t.message}")
            null
        }
    }

    fun clearCached(ctx: Context, roomName: String) {
        if (roomName.isEmpty()) return
        try {
            val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_TOKEN_CACHE, null) ?: return
            val obj = JSONObject(raw)
            obj.remove(roomName)
            prefs.edit().putString(KEY_TOKEN_CACHE, obj.toString()).apply()
        } catch (_: Throwable) {}
    }

    // ────────────────── internals ──────────────────

    private const val KEY_TOKEN_CACHE = "lk_token_cache"

    private fun resolveIdentity(ctx: Context): String {
        // The backend overrides `sub` with $user['email'] from the bearer
        // anyway (see chat.php case 'chat_livekit_token' — 'sub' => $user
        // ['email']), so the identity we send is mostly informational. But
        // we still ship a sensible value: prefer the stashed user email if
        // JS persisted one, otherwise fall back to a synthesized identifier.
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString("user_email", null)
            ?: prefs.getString("auth_email", null)
            ?: "android-native"
    }

    /**
     * Blocking HTTP fetch. Returns null on any failure path:
     *   - missing auth_token / api_base in SharedPreferences
     *   - non-2xx status code
     *   - malformed JSON
     *   - network error / timeout
     *
     * Never throws.
     */
    private fun doFetch(ctx: Context, roomName: String, identity: String): Result? {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val authToken = prefs.getString("auth_token", null)
        val apiBase = prefs.getString("api_base", null)
        if (authToken.isNullOrEmpty() || apiBase.isNullOrEmpty()) {
            Log.w(TAG, "doFetch: missing auth_token or api_base in prefs — JS hasn't called persistAuthForNativeCall yet")
            return null
        }
        // Normalize base: strip trailing slash so we control the path joining.
        val base = apiBase.trimEnd('/')
        val urlStr = "$base/api/email.php?action=chat_livekit_token"

        val body = JSONObject().apply {
            put("action", "chat_livekit_token")
            put("room", roomName)
            put("identity", identity)
            put("role", "publisher")
        }.toString()

        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_CONNECT_MS
                readTimeout = TIMEOUT_READ_MS
                doInput = true
                doOutput = true
                setRequestProperty("Authorization", "Bearer $authToken")
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                useCaches = false
            }
            conn.outputStream.use { os ->
                os.write(body.toByteArray(StandardCharsets.UTF_8))
                os.flush()
            }
            val code = conn.responseCode
            if (code !in 200..299) {
                Log.w(TAG, "doFetch: HTTP $code from $urlStr")
                return null
            }
            val text = conn.inputStream.use { it.readBytes() }
                .toString(StandardCharsets.UTF_8)
            val json = JSONObject(text)
            if (!json.optBoolean("success", false)) {
                Log.w(TAG, "doFetch: success=false (${json.optString("message")})")
                return null
            }
            val data = json.optJSONObject("data") ?: run {
                Log.w(TAG, "doFetch: missing data object")
                return null
            }
            val token = data.optString("token", "")
            val url = data.optString("url", "")
            if (token.isEmpty() || url.isEmpty()) {
                Log.w(TAG, "doFetch: empty token/url in response")
                return null
            }
            Log.d(TAG, "doFetch: OK for room=$roomName url=$url")
            val result = Result(token, url)
            // Cache for the next accept attempt on the same call (e.g. user
            // taps Aceitar twice while the UI is transitioning).
            setCached(ctx, roomName, token, url)
            result
        } catch (t: Throwable) {
            Log.w(TAG, "doFetch threw: ${t.message}")
            null
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }
}
