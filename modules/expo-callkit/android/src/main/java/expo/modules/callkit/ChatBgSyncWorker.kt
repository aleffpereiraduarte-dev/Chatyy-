package expo.modules.callkit

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

/**
 * [2026-10-07 bgsync] Periodic background chat sync (WhatsApp/Signal: a
 * WorkManager job that tops up the local store when no push arrived — muted
 * chats, DND, pushes dropped by OEM battery killers, Doze buckets).
 *
 * Every ~15 min (OS minimum; network-constrained, battery-not-low) it calls
 * `chat_sync` for the most recent conversations the app exported via
 * [configure] (id + since_pts), appends the hydrated new messages to
 * [ChatBgJournal], acks delivery (✓✓ gray) and advances its OWN copy of the
 * per-conversation pts. The JS cursors are untouched: the app's delta sync
 * stays the source of truth and the journal merge is idempotent by id.
 *
 * Skips when the app is visible (the live WS owns it then) or there is no
 * bearer for the configured account.
 */
class ChatBgSyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    companion object {
        private const val TAG = "ChatBgSyncWorker"
        private const val PREFS = "chatyy_bg_sync"
        private const val KEY_CFG = "cfg"
        private const val KEY_LAST_RUN = "last_run_at"
        private const val UNIQUE = "chatyy_bg_chat_sync"
        private const val MAX_CONVS = 60
        private const val PER_CONV_LIMIT = 50

        /**
         * JS → native: {acct, convs:[{id, pts}]}. Per-conversation pts is
         * merged with max() against what the worker already advanced, so a
         * stale JS cursor never makes the worker refetch the same window.
         */
        @Synchronized
        fun configure(ctx: Context, cfgJson: String) {
            try {
                val incoming = JSONObject(cfgJson)
                val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val prev = try { JSONObject(sp.getString(KEY_CFG, "{}") ?: "{}") } catch (_: Throwable) { JSONObject() }
                val acct = ChatNotifStore.normEmail(incoming.optString("acct", ""))
                val prevPts = HashMap<String, Long>()
                if (ChatNotifStore.normEmail(prev.optString("acct", "")) == acct) {
                    val pa = prev.optJSONArray("convs") ?: JSONArray()
                    for (i in 0 until pa.length()) {
                        val o = pa.optJSONObject(i) ?: continue
                        prevPts[o.optString("id")] = o.optLong("pts", 0L)
                    }
                }
                val out = JSONArray()
                val ia = incoming.optJSONArray("convs") ?: JSONArray()
                for (i in 0 until minOf(ia.length(), MAX_CONVS)) {
                    val o = ia.optJSONObject(i) ?: continue
                    val id = o.optString("id", "")
                    if (id.isEmpty()) continue
                    val pts = maxOf(o.optLong("pts", 0L), prevPts[id] ?: 0L)
                    out.put(JSONObject().put("id", id).put("pts", pts))
                }
                sp.edit().putString(KEY_CFG, JSONObject().put("acct", acct).put("convs", out).toString()).apply()
            } catch (t: Throwable) {
                Log.w(TAG, "configure failed: ${t.message}")
            }
        }

        @Synchronized
        fun advance(ctx: Context, acct: String, pts: Map<String, Long>) {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val cfg = try { JSONObject(sp.getString(KEY_CFG, "{}") ?: "{}") } catch (_: Throwable) { return }
            if (ChatNotifStore.normEmail(cfg.optString("acct", "")) != acct) return // account switched meanwhile
            val arr = cfg.optJSONArray("convs") ?: return
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val p = pts[o.optString("id")] ?: continue
                if (p > o.optLong("pts", 0L)) o.put("pts", p)
            }
            sp.edit().putString(KEY_CFG, cfg.toString()).apply()
        }

        fun clear(ctx: Context) {
            try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply() } catch (_: Throwable) {}
        }

        fun schedule(ctx: Context, enabled: Boolean) {
            try {
                val wm = WorkManager.getInstance(ctx.applicationContext)
                if (!enabled) { wm.cancelUniqueWork(UNIQUE); return }
                val constraints = Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .setRequiresBatteryNotLow(true)
                    .build()
                val req = PeriodicWorkRequestBuilder<ChatBgSyncWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(constraints)
                    .build()
                // KEEP: re-scheduling on every app start must not reset the period.
                wm.enqueueUniquePeriodicWork(UNIQUE, ExistingPeriodicWorkPolicy.KEEP, req)
            } catch (t: Throwable) {
                Log.w(TAG, "schedule failed: ${t.message}")
            }
        }
    }

    override fun doWork(): Result {
        val ctx = applicationContext
        try {
            if (ChatNotifStore.isAppVisibleToUser(ctx)) return Result.success()
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val cfg = try { JSONObject(sp.getString(KEY_CFG, "{}") ?: "{}") } catch (_: Throwable) { return Result.success() }
            val acct = ChatNotifStore.normEmail(cfg.optString("acct", ""))
            val convs = cfg.optJSONArray("convs") ?: return Result.success()
            if (acct.isEmpty() || convs.length() == 0) return Result.success()
            val bearer = ChatNotifStore.bearerFor(ctx, acct) ?: return Result.success()
            val base = ChatNotifStore.apiBase(ctx)

            val reqConvs = JSONArray()
            for (i in 0 until convs.length()) {
                val o = convs.optJSONObject(i) ?: continue
                val id = o.optString("id", "").toLongOrNull() ?: continue
                reqConvs.put(JSONObject().put("id", id).put("since_pts", o.optLong("pts", 0L)).put("limit", PER_CONV_LIMIT))
            }
            if (reqConvs.length() == 0) return Result.success()
            val resp = post("$base/api/email.php?action=chat_sync", bearer,
                JSONObject().put("conversations", reqConvs).toString()) ?: return Result.retry()
            if (!resp.optBoolean("success", false)) return Result.success()
            val outConvs = resp.optJSONObject("data")?.optJSONArray("conversations") ?: return Result.success()

            val lines = ArrayList<String>()
            val newPts = HashMap<String, Long>()
            val acks = HashMap<String, MutableList<Long>>()
            for (i in 0 until outConvs.length()) {
                val c = outConvs.optJSONObject(i) ?: continue
                if (c.optBoolean("denied", false)) continue
                val cid = c.opt("id")?.toString() ?: continue
                val msgs = c.optJSONArray("messages") ?: JSONArray()
                val hydrated = HashSet<Long>()
                for (j in 0 until msgs.length()) {
                    val m = msgs.optJSONObject(j) ?: continue
                    val mid = m.optLong("id", 0L)
                    if (mid <= 0) continue
                    hydrated.add(mid)
                    ChatBgJournal.lineFromSyncRow(acct, cid, m)?.let { lines.add(it) }
                    val sender = ChatNotifStore.normEmail(m.optString("sender_email", ""))
                    if (sender.isNotEmpty() && sender != acct) acks.getOrPut(cid) { ArrayList() }.add(mid)
                }
                // Watermark (mirror of services/chatSync.js): has_more → only up
                // to the last event received; a new_message event without its
                // hydrated row → don't advance (re-request next run).
                val events = c.optJSONArray("events") ?: JSONArray()
                var evMax = 0L
                var gap = false
                for (j in 0 until events.length()) {
                    val e = events.optJSONObject(j) ?: continue
                    evMax = maxOf(evMax, e.optLong("pts", 0L))
                    if (e.optString("type") == "new_message") {
                        val pmid = e.optJSONObject("payload")?.optLong("message_id", 0L) ?: 0L
                        if (pmid > 0 && !hydrated.contains(pmid)) gap = true
                    }
                }
                if (!gap) {
                    val wm = if (c.optBoolean("has_more", false)) evMax else c.optLong("latest_pts", 0L)
                    if (wm > 0) newPts[cid] = wm
                }
            }
            if (lines.isNotEmpty()) ChatBgJournal.appendLines(ctx, lines)
            if (newPts.isNotEmpty()) advance(ctx, acct, newPts)
            for ((cid, ids) in acks) {
                val cidL = cid.toLongOrNull() ?: continue
                try {
                    val arr = JSONArray(); ids.take(100).forEach { arr.put(it) }
                    post("$base/api/email.php?action=chat_delivery_ack", bearer,
                        JSONObject().put("conversation_id", cidL).put("message_ids", arr).toString())
                } catch (_: Throwable) {}
            }
            sp.edit().putLong(KEY_LAST_RUN, System.currentTimeMillis()).apply()
            Log.d(TAG, "bg sync ok: ${lines.size} msgs, ${newPts.size} convs advanced")
            return Result.success()
        } catch (t: Throwable) {
            Log.w(TAG, "doWork failed: ${t.message}")
            return Result.success()
        }
    }

    private fun post(url: String, bearer: String, body: String): JSONObject? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 20_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $bearer")
            }
            conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) return if (code >= 500) null else JSONObject()
            val text = conn.inputStream.use { String(it.readBytes(), StandardCharsets.UTF_8) }
            if (text.isBlank()) JSONObject() else JSONObject(text)
        } catch (t: Throwable) {
            Log.w(TAG, "POST failed: ${t.message}")
            null
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }
}
