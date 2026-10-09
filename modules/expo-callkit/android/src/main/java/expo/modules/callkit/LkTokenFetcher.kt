package expo.modules.callkit

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.os.Bundle
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import io.livekit.android.ConnectOptions
import livekit.org.webrtc.PeerConnection
import org.json.JSONArray
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
    // whenever the cached entry is older than the TTL to avoid stale-token
    // races if the call was rescheduled / the user re-signed in.
    // [2026-10-06 android-incoming] Was 30_000 — SHORTER than the 45s ring
    // (CallRingingService.RINGING_TIMEOUT_MS). An Accept after ~30s of
    // ringing threw away the pre-minted FCM token and fell into a blocking
    // bearer fetch (slow/401 on a stale bearer → "Conectando…" forever).
    // Now 60s, and when the token is a parseable JWT its own `exp` is
    // honoured (capped at CACHE_MAX_AGE_WITH_EXP_MS so a long-lived token
    // still can't be served for a call that is hours old).
    private const val CACHE_TTL_MS = 60_000L
    private const val CACHE_MAX_AGE_WITH_EXP_MS = 5 * 60_000L
    private const val EXP_SAFETY_MARGIN_MS = 5_000L

    // [2026-10-09 native-transport] iceServers do chat_livekit_token (TURN
    // regional + credencial 1h). Vazio = usa os do LiveKit (comportamento antigo).
    data class Result(
        val token: String,
        val url: String,
        val iceServers: List<PeerConnection.IceServer> = emptyList(),
    )

    // Indexado pelo próprio token: o token chega aos pontos de connect() por
    // vários caminhos (cache, FCM, Intent extras) só como String.
    private val iceByToken = java.util.Collections.synchronizedMap(
        object : LinkedHashMap<String, List<PeerConnection.IceServer>>(16, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, List<PeerConnection.IceServer>>?): Boolean = size > 8
        }
    )

    private fun rememberIce(token: String, ice: List<PeerConnection.IceServer>) {
        if (token.isEmpty() || ice.isEmpty()) return
        iceByToken[token] = ice
    }

    /** Lê `iceServers` ([{urls: String|[String], username?, credential?}]). */
    fun parseIceServers(arr: JSONArray?): List<PeerConnection.IceServer> {
        if (arr == null) return emptyList()
        val out = ArrayList<PeerConnection.IceServer>()
        for (i in 0 until arr.length()) {
            try {
                val s = arr.optJSONObject(i) ?: continue
                val urls = ArrayList<String>()
                val u = s.opt("urls")
                if (u is JSONArray) {
                    for (j in 0 until u.length()) { val v = u.optString(j, ""); if (v.isNotEmpty()) urls.add(v) }
                } else if (u is String && u.isNotEmpty()) {
                    urls.add(u)
                }
                if (urls.isEmpty()) continue
                val b = PeerConnection.IceServer.builder(urls)
                val user = s.optString("username", "")
                val cred = s.optString("credential", "")
                if (user.isNotEmpty()) b.setUsername(user)
                if (cred.isNotEmpty()) b.setPassword(cred)
                out.add(b.createIceServer())
            } catch (_: Throwable) {}
        }
        return out
    }

    /**
     * ConnectOptions p/ Room.connect. livekit-android 2.24.1 SÓ usa
     * ConnectOptions.iceServers quando rtcConfig != null (RTCEngine
     * makeRTCConfig), então a lista vai no próprio rtcConfig com os 2 campos
     * que o SDK exige. Sem lista → ConnectOptions() (= default do connect()).
     */
    fun connectOptionsFor(token: String): ConnectOptions {
        val ice = iceByToken[token]
        if (ice.isNullOrEmpty()) return ConnectOptions()
        val cfg = PeerConnection.RTCConfiguration(ArrayList(ice)).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        return ConnectOptions(rtcConfig = cfg)
    }

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
        // [CALL-TRACE 2026-05-20 WAVE42] Step 7/12 — callee mints (or pulls
        // cached) LK token. Triggered both pre-accept (preconnectRoom) and at
        // accept-time. If [7b] reports success=false we either had a 401
        // (auth_token resolveAuth failure across 4 sources), HTTP non-2xx,
        // or success=false in the JSON. fall-through path is no-token → user
        // sees forever "Conectando…".
        val t0 = System.currentTimeMillis()
        Log.i("CallTrace", "[7/12] LkTokenFetcher.fetchToken room=$callId isVideo=$isVideo ts=$t0")
        return withContext(Dispatchers.IO) {
            val identity = resolveIdentity(ctx)
            // Cache check first — saves a round trip if JS already pre-stashed.
            val cached = getCached(ctx, callId)
            if (cached != null) {
                Log.d(TAG, "fetchToken: cache hit for $callId")
                Log.i("CallTrace", "[7b/12] LkTokenFetcher result success=true source=cache elapsedMs=${System.currentTimeMillis() - t0} url=${cached.url}")
                return@withContext cached
            }
            val result = doFetch(ctx, callId, identity, intentExtras)
            Log.i("CallTrace", "[7b/12] LkTokenFetcher result success=${result != null} source=http elapsedMs=${System.currentTimeMillis() - t0} url=${result?.url ?: "<none>"}")
            result
        }
    }

    // ────────────────── cache (warm path) ──────────────────

    /**
     * Pre-stash a token JS just fetched. Lets the native accept path skip
     * the HTTP round-trip when the JS side has already done the work
     * (call_invite WS handler in IncomingCallListener / chat-conversation).
     */
    fun setCached(ctx: Context, roomName: String, token: String, url: String, iceJson: JSONArray? = null) {
        if (roomName.isEmpty() || token.isEmpty() || url.isEmpty()) return
        try {
            val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_TOKEN_CACHE, "{}") ?: "{}"
            val obj = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
            val entry = JSONObject().apply {
                put("token", token)
                put("url", url)
                put("at", System.currentTimeMillis())
                if (iceJson != null && iceJson.length() > 0) put("ice", iceJson)
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
            val token = entry.optString("token", "")
            val url = entry.optString("url", "")
            if (token.isEmpty() || url.isEmpty()) return null
            // [2026-10-06 android-incoming] Freshness: honour the JWT `exp`
            // when present (minus a safety margin, capped), else the flat TTL.
            val now = System.currentTimeMillis()
            val ageMs = now - at
            val expMs = jwtExpiryMs(token)
            val fresh = if (expMs > 0L) {
                now < expMs - EXP_SAFETY_MARGIN_MS && ageMs <= CACHE_MAX_AGE_WITH_EXP_MS
            } else {
                ageMs <= CACHE_TTL_MS
            }
            if (!fresh) {
                Log.d(TAG, "getCached: stale entry for room=$roomName (age=${ageMs}ms exp=${if (expMs > 0L) "${expMs - now}ms" else "n/a"}), ignoring")
                return null
            }
            val ice = parseIceServers(entry.optJSONArray("ice"))
            rememberIce(token, ice)
            Result(token, url, ice)
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

    /**
     * [2026-10-06 android-incoming] Epoch-millis expiry of a JWT (`exp`
     * claim, seconds), or 0 when the string is not a parseable JWT. LiveKit
     * access tokens are standard HS256 JWTs. Never throws.
     */
    private fun jwtExpiryMs(token: String): Long {
        return try {
            val parts = token.split('.')
            if (parts.size < 2) return 0L
            val payload = android.util.Base64.decode(
                parts[1],
                android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP
            )
            val exp = JSONObject(String(payload, StandardCharsets.UTF_8)).optLong("exp", 0L)
            if (exp > 0L) exp * 1000L else 0L
        } catch (_: Throwable) {
            0L
        }
    }

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
     *   - non-2xx status code (after retry on 401)
     *   - malformed JSON
     *   - network error / timeout
     *
     * On HTTP 401, evict the prefs auth_token, re-resolve (falls back to
     * AsyncStorage which JS keeps in sync via _persistAuthForNative on every
     * bearer rotation), and retry ONCE before giving up. This is the WA-grade
     * fix for "Sessão expirada — abra o app" that the user sees when JS has
     * rotated the bearer but the native prefs snapshot is stale.
     *
     * Never throws.
     */
    private fun doFetch(ctx: Context, roomName: String, identity: String, intentExtras: Bundle?): Result? {
        // First attempt with cached / freshly-resolved bearer.
        val r1 = doFetchOnce(ctx, roomName, identity, intentExtras, evictFirst = false)
        if (r1.result != null) return r1.result
        if (r1.httpCode != 401) return null
        // 401 path: prefs bearer is stale. Evict + re-resolve + retry once.
        Log.w(TAG, "doFetch: HTTP 401 — evicting stale prefs auth and retrying")
        val r2 = doFetchOnce(ctx, roomName, identity, intentExtras, evictFirst = true)
        if (r2.result == null) {
            Log.w(TAG, "doFetch: retry-after-401 also failed (httpCode=${r2.httpCode})")
        }
        return r2.result
    }

    private data class FetchAttempt(val result: Result?, val httpCode: Int)

    private fun doFetchOnce(
        ctx: Context,
        roomName: String,
        identity: String,
        intentExtras: Bundle?,
        evictFirst: Boolean,
    ): FetchAttempt {
        if (evictFirst) {
            try {
                val prefs = ctx.getSharedPreferences("expo_callkit_prefs", Context.MODE_PRIVATE)
                prefs.edit().remove("auth_token").apply()
            } catch (_: Throwable) {}
        }
        val resolved = resolveAuthInternal(ctx, intentExtras)
        if (resolved == null) {
            Log.w(TAG, "doFetchOnce: NO auth across 4 sources — user must log in again")
            return FetchAttempt(null, -1)
        }
        val (authToken, apiBase) = resolved
        val base = apiBase.trimEnd('/')
        val urlStr = "$base/api/email.php?action=chat_livekit_token"

        val body = JSONObject().apply {
            put("action", "chat_livekit_token")
            put("room", roomName)
            put("identity", identity)
            put("role", "publisher")
        }.toString()

        var conn: HttpURLConnection? = null
        var code = -1
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
            code = conn.responseCode
            if (code !in 200..299) {
                Log.w(TAG, "doFetchOnce: HTTP $code from $urlStr")
                return FetchAttempt(null, code)
            }
            val text = conn.inputStream.use { it.readBytes() }.toString(StandardCharsets.UTF_8)
            val json = JSONObject(text)
            if (!json.optBoolean("success", false)) {
                Log.w(TAG, "doFetchOnce: success=false (${json.optString("message")})")
                return FetchAttempt(null, code)
            }
            val data = json.optJSONObject("data") ?: run {
                Log.w(TAG, "doFetchOnce: missing data object")
                return FetchAttempt(null, code)
            }
            val token = data.optString("token", "")
            val url = data.optString("url", "")
            if (token.isEmpty() || url.isEmpty()) {
                Log.w(TAG, "doFetchOnce: empty token/url in response")
                return FetchAttempt(null, code)
            }
            val iceJson = data.optJSONArray("iceServers")
            val ice = parseIceServers(iceJson)
            rememberIce(token, ice)
            Log.d(TAG, "doFetchOnce: OK for room=$roomName url=$url ice=${ice.size}")
            val result = Result(token, url, ice)
            setCached(ctx, roomName, token, url, iceJson)
            FetchAttempt(result, code)
        } catch (t: Throwable) {
            Log.w(TAG, "doFetchOnce threw: ${t.message}")
            FetchAttempt(null, code)
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }
}
