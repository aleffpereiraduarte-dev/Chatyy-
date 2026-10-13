package expo.modules.callkit

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
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
            // [2026-10-13 dack-retry] Falha de rede/5xx não perde mais o ✓✓: o token
            // vai p/ uma fila (SharedPreferences) drenada aqui no próximo push e por
            // um WorkManager one-shot com rede (sobrevive ao processo morrer).
            val app = ctx.applicationContext
            Thread({
                if (!post(dAck)) { addPending(app, dAck); scheduleRetry(app) }
                else drainPending(app, 5) // rede ok → reenvia pendentes antigos
            }, "chatyy-dack").apply { isDaemon = true }.start()
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

    /** true = servidor respondeu definitivo (2xx, ou 4xx = token inválido/expirado → não reenvia). */
    internal fun post(dAck: String): Boolean {
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
            try { (if (code < 400) conn.inputStream else conn.errorStream)?.use { it.readBytes() } } catch (_: Throwable) {}
            return code in 200..499 && code != 429 && code != 408
        } catch (t: Throwable) {
            Log.w(TAG, "delivered ack failed: ${t.message}")
            return false
        } finally {
            try { conn?.disconnect() } catch (e: Throwable) {}
        }
    }

    // ---- fila de reenvio ([2026-10-13 dack-retry]) — token HMAC vale 24 h; servidor idempotente.
    private const val KEY_PENDING = "pending"
    private const val MAX_PENDING = 40
    private const val RETRY_WORK = "chatyy_dack_retry"

    @Synchronized
    private fun addPending(ctx: Context, dAck: String) {
        try {
            val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val arr = try { JSONArray(prefs.getString(KEY_PENDING, "[]") ?: "[]") } catch (e: Throwable) { JSONArray() }
            for (i in 0 until arr.length()) if (arr.optString(i) == dAck) return
            arr.put(dAck)
            val out = if (arr.length() > MAX_PENDING) {
                JSONArray().also { o -> for (i in (arr.length() - MAX_PENDING) until arr.length()) o.put(arr.optString(i)) }
            } else arr
            prefs.edit().putString(KEY_PENDING, out.toString()).apply()
        } catch (_: Throwable) {}
    }

    @Synchronized
    private fun takePending(ctx: Context, max: Int): List<String> {
        return try {
            val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val arr = try { JSONArray(prefs.getString(KEY_PENDING, "[]") ?: "[]") } catch (e: Throwable) { JSONArray() }
            if (arr.length() == 0) return emptyList()
            val n = minOf(max, arr.length())
            val taken = ArrayList<String>(n)
            for (i in (arr.length() - n) until arr.length()) taken.add(arr.optString(i))
            val rest = JSONArray()
            for (i in 0 until arr.length() - n) rest.put(arr.optString(i))
            prefs.edit().putString(KEY_PENDING, rest.toString()).apply()
            taken.filter { it.isNotBlank() }
        } catch (_: Throwable) { emptyList() }
    }

    /** Reenvia até [max] pendentes; o que falhar de novo volta p/ a fila. Retorna true se a fila esvaziou. */
    internal fun drainPending(ctx: Context, max: Int): Boolean {
        var allOk = true
        for (tok in takePending(ctx, max)) {
            if (!post(tok)) { addPending(ctx, tok); allOk = false }
        }
        return allOk
    }

    private fun scheduleRetry(ctx: Context) {
        try {
            val req = OneTimeWorkRequestBuilder<ChatDeliveryAckWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL, 30, java.util.concurrent.TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx.applicationContext).enqueueUniqueWork(RETRY_WORK, ExistingWorkPolicy.KEEP, req)
        } catch (t: Throwable) {
            Log.w(TAG, "scheduleRetry failed: ${t.message}")
        }
    }
}

/** [2026-10-13 dack-retry] Drena a fila de ✓✓ pendentes quando houver rede (até ~5 tentativas). */
class ChatDeliveryAckWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        return try {
            val ok = ChatDeliveryReporter.drainPending(applicationContext, 40)
            if (ok || runAttemptCount >= 5) Result.success() else Result.retry()
        } catch (_: Throwable) {
            if (runAttemptCount >= 5) Result.success() else Result.retry()
        }
    }
}
