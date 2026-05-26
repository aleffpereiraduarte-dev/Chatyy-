package expo.modules.callkit

import android.content.Context
import android.os.Bundle
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * CallContacts — backend helpers for the in-call "add participant" (person+)
 * button. Fetches the user's Chatyy contacts and rings a selected contact
 * into the CURRENT call's LiveKit room (same call_id) by POSTing to the
 * backend `chat_call_add` endpoint.
 *
 * Auth: reuses LkTokenFetcher.resolveAuth (the same 4-source bearer + base
 * resolution the call-token path already relies on), so no new auth plumbing
 * is introduced. Both calls run on a worker thread (callers invoke from
 * Dispatchers.IO / a background coroutine) — blocking I/O here is fine.
 *
 * Backend contracts:
 *   GET  <base>/api/chat.php?action=chat_contacts
 *        → { success, data: [ { email, name, status, last_seen }, ... ] }
 *   POST <base>/api/chat.php?action=chat_call_add
 *        body { action, call_id, conversation_id, video, emails:[email] }
 *        → rings the invitee into the EXISTING room (room == call_id) via
 *          VoIP/FCM/WS fanout. Backend filters caller + blocked users.
 *
 * All errors are swallowed → empty list / false. Never throws.
 */
object CallContacts {
    private const val TAG = "CallContacts"
    private const val TIMEOUT_CONNECT_MS = 5_000
    private const val TIMEOUT_READ_MS = 8_000

    /** A pickable contact row for the add-participant sheet. */
    data class Contact(val email: String, val name: String, val online: Boolean)

    /**
     * Fetch the caller's Chatyy contacts (people who share conversations
     * with them). Returns an empty list on any failure. Runs blocking I/O —
     * call from a worker thread.
     */
    fun fetchContacts(ctx: Context, intentExtras: Bundle? = null): List<Contact> {
        val auth = LkTokenFetcher.resolveAuth(ctx, intentExtras) ?: run {
            Log.w(TAG, "fetchContacts: no auth across sources")
            return emptyList()
        }
        val (token, apiBase) = auth
        val base = apiBase.trimEnd('/')
        val urlStr = "$base/api/chat.php?action=chat_contacts"
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = TIMEOUT_CONNECT_MS
                readTimeout = TIMEOUT_READ_MS
                doInput = true
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("Accept", "application/json")
                useCaches = false
            }
            val code = conn.responseCode
            if (code !in 200..299) {
                Log.w(TAG, "fetchContacts: HTTP $code")
                return emptyList()
            }
            val text = conn.inputStream.use { it.readBytes() }.toString(StandardCharsets.UTF_8)
            val json = JSONObject(text)
            if (!json.optBoolean("success", false)) return emptyList()
            // `data` may be an array (chat_contacts returns a bare array under
            // data) — be tolerant of an object wrapper too.
            val arr: JSONArray = when (val d = json.opt("data")) {
                is JSONArray -> d
                is JSONObject -> d.optJSONArray("contacts") ?: JSONArray()
                else -> JSONArray()
            }
            val out = ArrayList<Contact>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val email = o.optString("email", "").trim()
                if (email.isEmpty()) continue
                val name = o.optString("name", "").ifEmpty { email.substringBefore('@') }
                val online = o.optString("status", "offline").equals("online", ignoreCase = true)
                out.add(Contact(email = email, name = name, online = online))
            }
            out
        } catch (t: Throwable) {
            Log.w(TAG, "fetchContacts threw: ${t.message}")
            emptyList()
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }

    /**
     * Ring [email] into the running call identified by [callId] (joins the
     * same LiveKit room). [conversationId] is optional context for the
     * incoming-call card. Returns true on a 2xx + success response.
     * Runs blocking I/O — call from a worker thread.
     */
    fun ringIntoCall(
        ctx: Context,
        callId: String,
        conversationId: String,
        email: String,
        isVideo: Boolean,
        intentExtras: Bundle? = null,
    ): Boolean {
        if (callId.isEmpty() || email.isEmpty()) return false
        val auth = LkTokenFetcher.resolveAuth(ctx, intentExtras) ?: run {
            Log.w(TAG, "ringIntoCall: no auth")
            return false
        }
        val (token, apiBase) = auth
        val base = apiBase.trimEnd('/')
        val urlStr = "$base/api/chat.php?action=chat_call_add"
        val body = JSONObject().apply {
            put("action", "chat_call_add")
            put("call_id", callId)
            if (conversationId.isNotEmpty()) {
                put("conversation_id", conversationId.toIntOrNull() ?: 0)
            }
            put("video", if (isVideo) 1 else 0)
            put("emails", JSONArray().put(email))
        }.toString()
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_CONNECT_MS
                readTimeout = TIMEOUT_READ_MS
                doInput = true
                doOutput = true
                setRequestProperty("Authorization", "Bearer $token")
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
                Log.w(TAG, "ringIntoCall: HTTP $code for $email")
                return false
            }
            val text = conn.inputStream.use { it.readBytes() }.toString(StandardCharsets.UTF_8)
            val ok = JSONObject(text).optBoolean("success", false)
            Log.d(TAG, "ringIntoCall($email) → $ok")
            ok
        } catch (t: Throwable) {
            Log.w(TAG, "ringIntoCall threw: ${t.message}")
            false
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }
}
