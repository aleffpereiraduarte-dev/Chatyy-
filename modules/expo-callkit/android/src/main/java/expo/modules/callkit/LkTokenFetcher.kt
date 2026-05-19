package expo.modules.callkit

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.os.Bundle
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
        return fetch(ctx, roomName, identity, null)
    }

    /**
     * [#1175 2026-05-18] Variant accepting Intent extras as an additional
     * auth source (fallback B). Lets IncomingCallActivity / CallActivity
     * carry the bearer + base in the Intent so the activity can mint a
     * token even if SharedPreferences was wiped between the FCM push and
     * the user tapping Accept.
     */
    fun fetch(ctx: Context, roomName: String, identity: String, intentExtras: Bundle?): Result? {
        return try {
            doFetch(ctx, roomName, identity, intentExtras)
        } catch (t: Throwable) {
            Log.w(TAG, "fetch failed: ${t.message}")
            null
        }
    }

    /**
     * [#1175 2026-05-18] Resolve auth from any of the 4 sources without
     * actually performing the HTTP fetch. Useful for callers that just
     * want to know "do we have credentials for the call path?" — e.g.
     * IncomingCallActivity surfacing a "log in again" banner when there's
     * NO auth anywhere, so the user gets a useful next step instead of
     * staring at "Sem token".
     *
     * Returns a Pair(authToken, apiBase) or null if no source has both.
     */
    fun resolveAuth(ctx: Context, intentExtras: Bundle? = null): Pair<String, String>? {
        return resolveAuthInternal(ctx, intentExtras)
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
        return fetchToken(ctx, callId, isVideo, null)
    }

    /**
     * [#1175 2026-05-18] Coroutine variant accepting Intent extras for
     * fallback B. CallActivity calls this from lifecycleScope on cold-start.
     */
    suspend fun fetchToken(ctx: Context, callId: String, isVideo: Boolean, intentExtras: Bundle?): Result? {
        if (callId.isEmpty()) return null
        return withContext(Dispatchers.IO) {
            val identity = resolveIdentity(ctx)
            // Cache check first — saves a round trip if JS already pre-stashed.
            val cached = getCached(ctx, callId)
            if (cached != null) {
                Log.d(TAG, "fetchToken: cache hit for $callId")
                return@withContext cached
            }
            doFetch(ctx, callId, identity, intentExtras)
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
     * [#1175 2026-05-18] 4-source auth resolution. Walks in priority order:
     *
     *   1. `expo_callkit_prefs` SharedPreferences — primary path written by
     *      JS via persistAuthForNativeCall. Fastest, no I/O beyond the
     *      already-open prefs file.
     *   2. Intent extras — call site (IncomingCallActivity / CallActivity /
     *      CallActionReceiver) may have carried the bearer in the intent so
     *      the activity has an independent copy even if SharedPreferences
     *      was wiped between FCM push and accept tap.
     *   3. AsyncStorage SQLite (`RKStorage` DB, `catalystLocalStorage` table)
     *      — read the `mail_token_fb` row that services/api.js maintains as
     *      a redundant mirror of the SecureStore bearer. Survives the
     *      "Clear cache" path that nukes SharedPreferences but leaves
     *      app SQLite intact.
     *   4. EncryptedSharedPreferences `SecureStore` file — the canonical
     *      home of the bearer. Values are AES-encrypted JSON so we can't
     *      decrypt without the same KeyStore handshake expo-secure-store
     *      runs; we treat presence-of-key as a signal that the user is
     *      logged in but couldn't surface the cleartext. Last-ditch
     *      check used only for the "show humanized banner" decision in
     *      resolveAuth() — `doFetch` doesn't use this source because the
     *      cleartext is unavailable.
     *
     * The base URL is treated the same way (sources 1+2+3); when no source
     * supplies one we fall back to the hard-coded production URL
     * `https://chatyy.com.br` so a cold-start cleared-cache user can still
     * mint a token if the bearer was found via fallback C.
     *
     * Returns Pair(token, apiBase) or null if no source yielded a bearer.
     */
    private fun resolveAuthInternal(ctx: Context, intentExtras: Bundle?): Pair<String, String>? {
        // ── Source 1: SharedPreferences (expo_callkit_prefs) — primary
        try {
            val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val tk = prefs.getString("auth_token", null)
            val base = prefs.getString("api_base", null)
            if (!tk.isNullOrEmpty() && !base.isNullOrEmpty()) {
                Log.d(TAG, "resolveAuth: source=prefs OK (len=${tk.length})")
                return Pair(tk, base)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "resolveAuth source=prefs failed: ${t.message}")
        }

        // ── Source 2: Intent extras — call-site carried copy
        try {
            if (intentExtras != null) {
                val tk = intentExtras.getString("auth_token") ?: intentExtras.getString("authToken")
                val base = intentExtras.getString("api_base")
                    ?: intentExtras.getString("apiBase")
                    ?: "https://chatyy.com.br"
                if (!tk.isNullOrEmpty()) {
                    Log.d(TAG, "resolveAuth: source=intent OK (len=${tk.length})")
                    // Heal the SharedPreferences write so the next attempt
                    // hits source 1 instead of paying the Intent walk again.
                    try {
                        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                            .putString("auth_token", tk)
                            .putString("api_base", base)
                            .apply()
                    } catch (_: Throwable) {}
                    return Pair(tk, base)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "resolveAuth source=intent failed: ${t.message}")
        }

        // ── Source 3: AsyncStorage SQLite (mail_token_fb)
        try {
            val tk = readFromAsyncStorage(ctx, "mail_token_fb")
            if (!tk.isNullOrEmpty()) {
                val base = "https://chatyy.com.br"
                Log.d(TAG, "resolveAuth: source=asyncstorage OK (len=${tk.length})")
                // Heal SharedPreferences so subsequent paths hit source 1.
                try {
                    ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                        .putString("auth_token", tk)
                        .putString("api_base", base)
                        .apply()
                } catch (_: Throwable) {}
                return Pair(tk, base)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "resolveAuth source=asyncstorage failed: ${t.message}")
        }

        // ── Source 4: EncryptedSharedPreferences "SecureStore" — presence
        // only. We can't decrypt without the KeyStore session; the caller
        // uses this to tell the user "session exists but app needs to
        // wake the bearer" (humanized banner) vs "log in again from
        // scratch".
        try {
            val ss = ctx.getSharedPreferences("SecureStore", Context.MODE_PRIVATE)
            if (ss.all.isNotEmpty()) {
                Log.d(TAG, "resolveAuth: SecureStore present but encrypted — humanized banner path")
            }
        } catch (_: Throwable) {}

        return null
    }

    /**
     * Open the AsyncStorage RKStorage SQLite db read-only and pull a value
     * by key. Returns null if the db doesn't exist, the table is missing,
     * the row isn't there, or anything else goes wrong. Never throws.
     */
    private fun readFromAsyncStorage(ctx: Context, key: String): String? {
        var db: SQLiteDatabase? = null
        return try {
            val dbFile = ctx.getDatabasePath("RKStorage")
            if (!dbFile.exists()) return null
            db = SQLiteDatabase.openDatabase(
                dbFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY
            )
            db.rawQuery(
                "SELECT value FROM catalystLocalStorage WHERE key = ? LIMIT 1",
                arrayOf(key)
            ).use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (t: Throwable) {
            Log.w(TAG, "readFromAsyncStorage($key) failed: ${t.message}")
            null
        } finally {
            try { db?.close() } catch (_: Throwable) {}
        }
    }

    /**
     * Blocking HTTP fetch. Returns null on any failure path:
     *   - missing auth_token / api_base across all 4 sources
     *   - non-2xx status code
     *   - malformed JSON
     *   - network error / timeout
     *
     * Never throws.
     */
    private fun doFetch(ctx: Context, roomName: String, identity: String, intentExtras: Bundle?): Result? {
        val resolved = resolveAuthInternal(ctx, intentExtras)
        if (resolved == null) {
            Log.w(TAG, "doFetch: NO auth across 4 sources (prefs/intent/asyncstorage/securestore) — user must log in again")
            return null
        }
        val (authToken, apiBase) = resolved
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
