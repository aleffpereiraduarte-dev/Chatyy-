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
 *   GET  <base>/api/email.php?action=chat_contacts
 *        → { success, data: [ { email, name, status, last_seen }, ... ] }
 *   POST <base>/api/email.php?action=chat_call_add
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
        val urlStr = "$base/api/email.php?action=chat_contacts"
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
        // [2026-10-10 p2p-android] Virou grupo: P2P (1:1) cai p/ o LiveKit antes
        // do convidado entrar no Room.
        try {
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                try { P2PCallSession.get(callId)?.fallback("became_group") } catch (_: Throwable) {}
            }
        } catch (_: Throwable) {}
        val auth = LkTokenFetcher.resolveAuth(ctx, intentExtras) ?: run {
            Log.w(TAG, "ringIntoCall: no auth")
            return false
        }
        val (token, apiBase) = auth
        val base = apiBase.trimEnd('/')
        val urlStr = "$base/api/email.php?action=chat_call_add"
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

    // ─────────────────────────────────────────────────────────────────────
    // [2026-10-13 add-to-call] Seletor novo (CallAddParticipantSheet): só
    // conversas direct + agenda (chat_call_add_candidates), sem contas de
    // teste, nome de exibição, @usuário, foto, estado na chamada; convite com
    // VÁRIAS pessoas e motivo do erro (data.code) em vez de "não foi possível".
    // ─────────────────────────────────────────────────────────────────────

    data class Candidate(
        val email: String,
        val name: String,
        val username: String,
        val avatar: String,
        val callState: String, // "in_call" | "ringing" | ""
    )

    data class Lists(
        val ok: Boolean,
        val recent: List<Candidate>,
        val contacts: List<Candidate>,
        val results: List<Candidate>,
    )

    data class AddResult(
        val ok: Boolean,
        val code: String,
        /** email → reachable (tem aparelho/WS que vai tocar) */
        val invited: List<Pair<String, Boolean>>,
        /** email → motivo (blocked / not_allowed …) */
        val skipped: List<Pair<String, String>>,
    )

    private val HIDDEN_LOCAL = Regex("^(apitest|appletest|smoketest|testkid|reels|noreply|no-reply|donotreply|do-not-reply|postmaster|mailer-daemon|abuse|root|system|bot|qa|qa[0-9]+|qa-?bot|qa-?robot|test[0-9]*|teste[0-9]*|demo[0-9]*)$")

    /** Contas de teste/sistema nunca aparecem (mesma regra do servidor e do JS). */
    fun isHidden(email: String): Boolean {
        val e = email.lowercase()
        val at = e.indexOf('@')
        if (at <= 0) return true
        return HIDDEN_LOCAL.matches(e.substring(0, at))
    }

    /** minúsculas + sem acento (busca local "Ána" == "ana"). */
    fun fold(s: String): String = try {
        java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFD)
            .replace(Regex("\\p{InCombiningDiacriticalMarks}+"), "")
            .lowercase()
            .trim()
    } catch (_: Throwable) { s.lowercase().trim() }

    private fun candidateFrom(o: JSONObject?): Candidate? {
        if (o == null) return null
        val email = o.optString("email", "").trim().lowercase()
        if (email.isEmpty() || isHidden(email)) return null
        val name = o.optString("name", "").ifEmpty { email.substringBefore('@') }
        return Candidate(
            email = email,
            name = name,
            username = o.optString("username", ""),
            avatar = o.optString("avatar", ""),
            callState = o.optString("call_state", ""),
        )
    }

    /** GET → (status, json|null). status 0 = rede. */
    private fun getJson(urlStr: String, token: String): Pair<Int, JSONObject?> {
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
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.use { it.readBytes() }?.toString(StandardCharsets.UTF_8) ?: ""
            val json = try { JSONObject(text) } catch (_: Throwable) { null }
            Pair(code, json)
        } catch (t: Throwable) {
            Log.w(TAG, "getJson threw: ${t.message}")
            Pair(0, null)
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }

    /**
     * Lista do seletor. Sem [query]: recent + contacts; com [query]: results.
     * Servidor antigo (sem a action) → chat_contacts filtrado aqui.
     * Bloqueante — chamar em Dispatchers.IO.
     */
    fun fetchCandidates(ctx: Context, query: String, callId: String, intentExtras: Bundle? = null): Lists {
        val empty = Lists(false, emptyList(), emptyList(), emptyList())
        val auth = LkTokenFetcher.resolveAuth(ctx, intentExtras) ?: return empty
        val (token, apiBase) = auth
        val base = apiBase.trimEnd('/')
        val q = query.take(64)
        val enc = { v: String -> java.net.URLEncoder.encode(v, "UTF-8") }
        val (status, json) = getJson(
            "$base/api/email.php?action=chat_call_add_candidates&query=${enc(q)}&call_id=${enc(callId)}&limit=80",
            token,
        )
        if (json != null && json.optBoolean("success", false)) {
            val d = json.optJSONObject("data")
            if (d != null) {
                fun list(k: String): List<Candidate> {
                    val arr = d.optJSONArray(k) ?: return emptyList()
                    val out = ArrayList<Candidate>(arr.length())
                    for (i in 0 until arr.length()) candidateFrom(arr.optJSONObject(i))?.let { out.add(it) }
                    return out
                }
                return Lists(true, list("recent"), list("contacts"), list("results"))
            }
        }
        if (status == 0) return empty
        // Servidor antigo → chat_contacts (filtrado: sem contas de teste).
        val (_, legacy) = getJson("$base/api/email.php?action=chat_contacts", token)
        if (legacy == null || !legacy.optBoolean("success", false)) return empty
        val arr: JSONArray = when (val d = legacy.opt("data")) {
            is JSONArray -> d
            is JSONObject -> d.optJSONArray("contacts") ?: JSONArray()
            else -> JSONArray()
        }
        val all = ArrayList<Candidate>(arr.length())
        for (i in 0 until arr.length()) candidateFrom(arr.optJSONObject(i))?.let { all.add(it) }
        val qn = fold(q.removePrefix("@"))
        if (qn.isEmpty()) return Lists(true, emptyList(), all.sortedBy { fold(it.name) }, emptyList())
        return Lists(true, emptyList(), emptyList(), all.filter { fold(it.name).contains(qn) || it.email.contains(qn) })
    }

    /**
     * Toca [emails] (até 16) na chamada em andamento (sala == [callId]).
     * Bloqueante — chamar em Dispatchers.IO. Nunca lança.
     */
    fun ringIntoCallMany(
        ctx: Context,
        callId: String,
        conversationId: String,
        emails: List<String>,
        isVideo: Boolean,
        intentExtras: Bundle? = null,
    ): AddResult {
        if (callId.isEmpty() || emails.isEmpty()) return AddResult(false, "no_invitees", emptyList(), emptyList())
        // Virou grupo: P2P (1:1) cai p/ o LiveKit antes do convidado entrar no Room.
        try {
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                try { P2PCallSession.get(callId)?.fallback("became_group") } catch (_: Throwable) {}
            }
        } catch (_: Throwable) {}
        val auth = LkTokenFetcher.resolveAuth(ctx, intentExtras)
            ?: return AddResult(false, "generic", emptyList(), emptyList())
        val (token, apiBase) = auth
        val base = apiBase.trimEnd('/')
        val list = emails.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct().take(16)
        val body = JSONObject().apply {
            put("action", "chat_call_add")
            put("call_id", callId)
            conversationId.toIntOrNull()?.let { put("conversation_id", it) }
            put("video", if (isVideo) 1 else 0)
            put("emails", JSONArray().apply { list.forEach { put(it) } })
        }.toString()
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("$base/api/email.php?action=chat_call_add").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_CONNECT_MS
                readTimeout = 12_000
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
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.use { it.readBytes() }?.toString(StandardCharsets.UTF_8) ?: ""
            val parsed: JSONObject? = try { JSONObject(text) } catch (_: Throwable) { null }
            val json = parsed ?: return AddResult(false, if (code == 429) "rate_limited" else "generic", emptyList(), emptyList())
            val d = json.optJSONObject("data")
            val skipped = ArrayList<Pair<String, String>>()
            d?.optJSONArray("skipped")?.let { a ->
                for (i in 0 until a.length()) {
                    val o = a.optJSONObject(i) ?: continue
                    val e = o.optString("email", "").lowercase()
                    if (e.isNotEmpty()) skipped.add(e to o.optString("reason", "generic"))
                }
            }
            if (!json.optBoolean("success", false)) {
                var c = d?.optString("code", "") ?: ""
                if (c.isEmpty()) {
                    val m = json.optString("message", "").lowercase()
                    c = when {
                        code == 429 || m.contains("rate") -> "rate_limited"
                        m.contains("blocked") -> "blocked"
                        m.contains("no valid invitees") -> "not_allowed"
                        m.contains("not a member") -> "not_in_call"
                        else -> "generic"
                    }
                }
                Log.w(TAG, "ringIntoCallMany: HTTP $code code=$c")
                return AddResult(false, c, emptyList(), skipped)
            }
            val invited = ArrayList<Pair<String, Boolean>>()
            d?.optJSONArray("invited")?.let { a ->
                for (i in 0 until a.length()) {
                    val o = a.optJSONObject(i) ?: continue
                    val e = o.optString("email", "").lowercase()
                    if (e.isNotEmpty()) invited.add(e to o.optBoolean("reachable", true))
                }
            }
            if (invited.isEmpty()) list.forEach { invited.add(it to true) }
            AddResult(true, "", invited, skipped)
        } catch (t: Throwable) {
            Log.w(TAG, "ringIntoCallMany threw: ${t.message}")
            AddResult(false, "network", emptyList(), emptyList())
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }

    /** Texto claro e traduzido p/ um código de erro (GroupCallStrings pk.*). */
    fun errorText(code: String, name: String): String {
        val key = when (code) {
            "not_allowed" -> "pk.errNotAllowed"
            "blocked" -> "pk.errBlocked"
            "not_in_call" -> "pk.errNotInCall"
            "parental" -> "pk.errParental"
            "rate_limited" -> "pk.errRateLimited"
            "offline" -> "pk.errOffline"
            "limit" -> "pk.errLimit"
            "network" -> "pk.errNetwork"
            else -> "pk.errGeneric"
        }
        return GroupCallStrings.s(key, "name" to name)
    }
}
