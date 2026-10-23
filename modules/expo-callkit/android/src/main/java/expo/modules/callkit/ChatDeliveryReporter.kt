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
 *
 * [2026-10-22 dlv-device] Ack POR APARELHO (fila sombra chat_msg_device_dlv no servidor): o corpo
 * leva `device_id` = id E2EE v5 do NÚCLEO deste aparelho para a conta do push (uid pelo mapa
 * conta→uid do expo-chatyy-crypto, id lido do meta/<uid>.json — só leitura, nunca cria aparelho;
 * o servidor confere que o id é desta conta, senão conta como '?'), e `persisted` = 1 quando a
 * mensagem COMPLETA ficou no journal local (ChatBgJournal, chamado ANTES daqui) — 0 para
 * prévia/E2EE/trancada (o envelope E2EE ainda não é gravado no store nativo pelo push; o app grava
 * ao sincronizar). Pendentes guardam o persisted junto ("<token>|1").
 */
object ChatDeliveryReporter {
    private const val TAG = "ChatDeliveryReporter"
    private const val PREFS = "chatyy_delivery_ack"
    private const val KEY_RECENT = "recent"
    private const val MAX_RECENT = 300
    private const val ENDPOINT = "https://chatyy.com.br/api/email.php?action=chat_push_delivered"
    private const val TIMEOUT_CONNECT_MS = 4_000
    private const val TIMEOUT_CONNECT_FAST_MS = 2_500 // ack_url: falha rápido → cai na URL de sempre
    private const val TIMEOUT_READ_MS = 8_000
    private val CHAT_TYPES = setOf("chat_message", "chat_mention", "chat_keyword")

    /**
     * Inspect an incoming FCM data map and, if it is a chat push carrying a
     * `d_ack`, report delivery on a background thread. Never throws.
     */
    fun maybeReport(ctx: Context, data: Map<String, String>, persisted: Boolean = false) {
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
            val item = if (persisted) "$dAck|1" else dAck
            // [2026-10-23 push-rapido 3-nativo] `ack_url` opcional do servidor (https, *.chatyy.com.br):
            // ack vai primeiro para ele (ex.: borda mais perto); falha/não-2xx → URL de sempre.
            val ackUrl = field("ack_url")?.let { validAckUrl(app, it) }
            Thread({
                val t0 = android.os.SystemClock.elapsedRealtime()
                var via = "default"
                val ok = if (ackUrl != null && postCode(app, item, ackUrl, TIMEOUT_CONNECT_FAST_MS) in 200..299) {
                    via = "ack_url"; true
                } else {
                    if (ackUrl != null) via = "fallback"
                    post(app, item)
                }
                Log.i(TAG, "dack ok=$ok via=$via ms=${android.os.SystemClock.elapsedRealtime() - t0}")
                if (!ok) { addPending(app, item); scheduleRetry(app) }
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

    private val DEV_RE = Regex("^[A-Z][A-Z2-7]{12}$")

    /** Conta (campo `e`) do payload do token d_ack — só p/ escolher o aparelho; a assinatura é do servidor. */
    private fun acctOfDack(dAck: String): String {
        return try {
            val p = dAck.substringBefore('.')
            val raw = android.util.Base64.decode(p, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
            JSONObject(String(raw, StandardCharsets.UTF_8)).optString("e", "").trim().lowercase()
        } catch (_: Throwable) { "" }
    }

    /** device_id E2EE v5 do núcleo p/ a conta ('' = sem núcleo/store). Nunca lança. */
    internal fun deviceIdFor(ctx: Context, account: String): String {
        return try {
            val uid = (if (account.isNotEmpty()) expo.modules.chatyycrypto.ChatyyCryptoFlags.uidForAccount(ctx, account)
                       else expo.modules.chatyycrypto.ChatyyCryptoFlags.lastUid(ctx)) ?: return ""
            val d = expo.modules.chatyycrypto.ChatyyCryptoSecrets.deviceId(ctx, uid)
            if (DEV_RE.matches(d)) d else ""
        } catch (_: Throwable) { "" }
    }

    /** [2026-10-23] `ack_url` aceito só se https, host chatyy.com.br ou *.chatyy.com.br, sem usuário/porta
     *  estranha. Kill: SharedPreferences "chatyy_push_fast" ack_url=false → sempre a URL de sempre. */
    private fun validAckUrl(ctx: Context, raw: String): String? {
        return try {
            if (!ctx.getSharedPreferences(ChatyyRnGate.PREFS, Context.MODE_PRIVATE).getBoolean("ack_url", true)) return null
            val s = raw.trim()
            if (s.length > 512) return null
            val u = URL(s)
            val host = (u.host ?: "").lowercase()
            val okHost = host == "chatyy.com.br" || (host.endsWith(".chatyy.com.br") && host.length > ".chatyy.com.br".length)
            if (u.protocol != "https" || !okHost || u.userInfo != null || (u.port != -1 && u.port != 443)) null else s
        } catch (_: Throwable) { null }
    }

    /** true = servidor respondeu definitivo (2xx, ou 4xx = token inválido/expirado → não reenvia).
     *  [item] = "<d_ack>" ou "<d_ack>|1" (persisted). */
    internal fun post(ctx: Context, item: String): Boolean {
        val code = postCode(ctx, item, ENDPOINT, TIMEOUT_CONNECT_MS)
        return code in 200..499 && code != 429 && code != 408
    }

    /** POST do ack para [url]; devolve o HTTP status (0 = falha de rede). */
    private fun postCode(ctx: Context, item: String, url: String, connectTimeoutMs: Int): Int {
        val dAck = item.substringBefore('|')
        val persisted = item.endsWith("|1")
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = connectTimeoutMs
                readTimeout = TIMEOUT_READ_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
            }
            val bodyObj = JSONObject().put("d_ack", dAck).put("persisted", if (persisted) 1 else 0)
            val dev = deviceIdFor(ctx, acctOfDack(dAck))
            if (dev.isNotEmpty()) bodyObj.put("device_id", dev)
            val body = bodyObj.toString().toByteArray(StandardCharsets.UTF_8)
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            Log.d(TAG, "delivered ack HTTP $code")
            try { (if (code < 400) conn.inputStream else conn.errorStream)?.use { it.readBytes() } } catch (_: Throwable) {}
            return code
        } catch (t: Throwable) {
            Log.w(TAG, "delivered ack failed: ${t.message}")
            return 0
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
            if (!post(ctx, tok)) { addPending(ctx, tok); allOk = false }
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
