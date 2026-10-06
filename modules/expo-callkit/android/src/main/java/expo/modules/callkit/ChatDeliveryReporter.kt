package expo.modules.callkit

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * ChatDeliveryReporter — "delivered-on-receipt" (WhatsApp ✓✓ gray parity).
 *
 * [2026-10-06] The moment THIS device receives a chat push (app killed,
 * backgrounded, no JS, no WS) we POST the backend-signed `d_ack` token back to
 * `chat_push_delivered`. The server flips the sender's ✓ → ✓✓ gray instantly,
 * exactly like WhatsApp's device-ack — previously Android only acked once the
 * user opened the app (the JS `chatDeliveryAckBatched` paths), so the sender's
 * tick lagged at ✓ for minutes/hours. The iOS twin lives in the Notification
 * Service Extension (plugins/with-notification-service.js → reportDelivered).
 *
 * Auth: the `d_ack` token is HMAC-signed by firebase_push.php and scoped to
 * (message_id, conversation_id, recipient, exp). No bearer, no secret here.
 * Never logged.
 *
 * Payload shapes:
 *   - FCM-direct: data["d_ack"] at top level.
 *   - Expo-routed (CHAT_PUSH_ANDROID_PREFER_EXPO): Expo nests our data as a
 *     JSON string in data["body"].
 *
 * Dedupe: a small SharedPreferences ring of "conv:msg" keys so a re-delivered /
 * duplicated FCM frame doesn't POST twice (the server is idempotent anyway —
 * this just saves radio).
 */
object ChatDeliveryReporter {
    private const val TAG = "ChatDeliveryReporter"
    private const val PREFS = "chatyy_delivery_ack"
    private const val KEY_RECENT = "recent"
    private const val MAX_RECENT = 300
    private const val ENDPOINT = "https://chatyy.com.br/api/email.php?action=chat_push_delivered"
    private const val TIMEOUT_CONNECT_MS = 4_000
    private const val TIMEOUT_READ_MS = 8_000
    private val CHAT_TYPES = setOf("chat_message", "chat_mention", "chat_keyword")

    /**
     * Inspect an incoming FCM data map and, if it is a chat push carrying a
     * `d_ack`, report delivery on a background thread. Never throws.
     */
    fun maybeReport(ctx: Context, data: Map<String, String>) {
        try {
            val nested = parseNested(data["body"])
            fun field(k: String): String? {
                data[k]?.takeIf { it.isNotBlank() }?.let { return it }
                return nested?.optString(k, "")?.takeIf { it.isNotBlank() }
            }
            val type = field("type") ?: return
            if (type !in CHAT_TYPES) return
            val dAck = field("d_ack") ?: return
            val convId = field("conversation_id") ?: ""
            val msgId = field("message_id") ?: ""
            val dedupeKey = "$convId:$msgId"
            if (convId.isNotEmpty() && msgId.isNotEmpty() && !remember(ctx, dedupeKey)) {
                Log.d(TAG, "already acked $dedupeKey — skip")
                return
            }
            Thread({ post(dAck) }, "chatyy-dack").apply { isDaemon = true }.start()
        } catch (t: Throwable) {
            Log.w(TAG, "maybeReport failed: ${t.message}")
        }
    }

    private fun parseNested(body: String?): JSONObject? {
        if (body.isNullOrBlank() || !body.trimStart().startsWith("{")) return null
        return try { JSONObject(body) } catch (e: Throwable) { null }
    }

    /** Returns true if the key was NEW (and is now remembered). */
    @Synchronized
    private fun remember(ctx: Context, key: String): Boolean {
        return try {
            val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val arr = try { JSONArray(prefs.getString(KEY_RECENT, "[]") ?: "[]") } catch (e: Throwable) { JSONArray() }
            for (i in 0 until arr.length()) if (arr.optString(i) == key) return false
            arr.put(key)
            val trimmed = if (arr.length() > MAX_RECENT) {
                JSONArray().also { out -> for (i in (arr.length() - MAX_RECENT) until arr.length()) out.put(arr.optString(i)) }
            } else arr
            prefs.edit().putString(KEY_RECENT, trimmed.toString()).apply()
            true
        } catch (e: Throwable) {
            true // fail-open: server dedupes
        }
    }

    private fun post(dAck: String) {
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(ENDPOINT).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_CONNECT_MS
                readTimeout = TIMEOUT_READ_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
            }
            val body = JSONObject().put("d_ack", dAck).toString().toByteArray(StandardCharsets.UTF_8)
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            Log.d(TAG, "delivered ack HTTP $code")
        } catch (t: Throwable) {
            Log.w(TAG, "delivered ack failed: ${t.message}")
        } finally {
            try { conn?.disconnect() } catch (e: Throwable) {}
        }
    }
}
