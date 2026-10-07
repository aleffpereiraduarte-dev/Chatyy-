package expo.modules.callkit

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets

/**
 * [2026-10-07 bgsync] ChatBgJournal — WhatsApp-style "the message is already on
 * the phone when you open the app".
 *
 * Every chat push (FCM-direct or Expo-routed) and every periodic background
 * sync (ChatBgSyncWorker) appends ONE JSON line per message to a small
 * append-only journal file. The JS app merges it into its expo-sqlite store
 * (services/bgJournal.js) synchronously BEFORE the chat list's first read, so
 * a cold start / resume paints the new message with no spinner. The normal
 * WS resume + delta sync (chatSync.js) then reconciles as usual — the journal
 * is an ACCELERATOR, never the source of truth (losing it = old behaviour).
 *
 * WHY A SEPARATE FILE (not a direct write into chatyy.db):
 *   expo-sqlite bundles its OWN SQLite library; android.database.sqlite is the
 *   framework copy. Two SQLite libraries opening the same DB file in the SAME
 *   process break POSIX advisory locking (closing one library's fd drops the
 *   other's locks) → documented corruption hazard
 *   (https://www.sqlite.org/howtocorrupt.html §2.2.1). A plain JSONL file
 *   guarded by one JVM monitor has no such risk and is ~1 ms to append.
 *
 * Format (one object per line, all values strings unless noted):
 *   v=1, src=fcm|bg, acct, at(ms number), cid, mid, full("1"/"0"), sender,
 *   sname, type, text, preview, ts, cmid, furl, fname, fsize, w, h, dur, thumb,
 *   reply, rquote, grp("1"/"0"), cname, unread, locked("1"/"0")
 * Identical to the iOS writers (ChatBgJournal.swift / NotificationService).
 *
 * Concurrency: FCM service, WorkManager worker and the JS module all run in
 * the app process → a single @Synchronized object is the lock. JS reads the
 * file + commits by byte offset (rewrite keeps anything appended after the
 * read), so nothing appended mid-merge is ever lost.
 */
object ChatBgJournal {
    private const val TAG = "ChatBgJournal"
    private const val DIR = "chatyy_bg_journal"
    private const val FILE = "inbox.jsonl"
    // Hard cap: past this we stop appending (the delta sync will fetch it all
    // anyway). Keeps the pre-paint merge bounded (<~1-2k lines).
    private const val MAX_BYTES = 384 * 1024L
    private val CHAT_TYPES = setOf("chat_message", "chat_mention", "chat_keyword")

    private fun file(ctx: Context): File {
        val d = File(ctx.filesDir, DIR)
        if (!d.exists()) d.mkdirs()
        return File(d, FILE)
    }

    @Synchronized
    fun appendLines(ctx: Context, lines: List<String>): Int {
        if (lines.isEmpty()) return 0
        return try {
            val f = file(ctx)
            if (f.exists() && f.length() > MAX_BYTES) {
                Log.w(TAG, "journal full (${f.length()} B) — skipping ${lines.size} lines")
                return 0
            }
            val sb = StringBuilder()
            for (l in lines) {
                if (l.isBlank() || l.contains('\n')) continue // JSONObject.toString never emits raw \n
                sb.append(l).append('\n')
            }
            FileOutputStream(f, true).use { it.write(sb.toString().toByteArray(StandardCharsets.UTF_8)) }
            lines.size
        } catch (t: Throwable) {
            Log.w(TAG, "append failed: ${t.message}")
            0
        }
    }

    /** Full journal contents (UTF-8). JS commits by passing back the byte length it read. */
    fun read(ctx: Context): String = readWithSize(ctx).first

    /** (text, raw byte length) — the length is what [commit] must receive. */
    @Synchronized
    fun readWithSize(ctx: Context): Pair<String, Long> {
        return try {
            val f = file(ctx)
            if (!f.exists() || f.length() == 0L) Pair("", 0L) else {
                val b = f.readBytes()
                Pair(String(b, StandardCharsets.UTF_8), b.size.toLong())
            }
        } catch (t: Throwable) {
            Log.w(TAG, "read failed: ${t.message}")
            Pair("", 0L)
        }
    }

    /**
     * Drop the first [consumedBytes] bytes (what JS read and merged), keep
     * whatever was appended after the read, and prepend [keep] (lines JS chose
     * to retain, e.g. entries of another signed-in account). Atomic rename.
     */
    @Synchronized
    fun commit(ctx: Context, consumedBytes: Long, keep: String?): Boolean {
        return try {
            val f = file(ctx)
            val all = if (f.exists()) f.readBytes() else ByteArray(0)
            val cut = consumedBytes.coerceIn(0L, all.size.toLong()).toInt()
            val tail = all.copyOfRange(cut, all.size)
            val head = (keep ?: "").let { k ->
                if (k.isEmpty()) ByteArray(0) else (if (k.endsWith("\n")) k else k + "\n").toByteArray(StandardCharsets.UTF_8)
            }
            if (head.isEmpty() && tail.isEmpty()) {
                if (f.exists()) f.delete()
                return true
            }
            val tmp = File(f.parentFile, "$FILE.tmp")
            FileOutputStream(tmp, false).use { out ->
                out.write(head); out.write(tail); out.fd.sync()
            }
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
            true
        } catch (t: Throwable) {
            Log.w(TAG, "commit failed: ${t.message}")
            false
        }
    }

    @Synchronized
    fun clear(ctx: Context) {
        try { file(ctx).delete() } catch (_: Throwable) {}
    }

    // ── Push → journal line ────────────────────────────────────────────────

    /**
     * Inspect an FCM data map (both wire shapes) and append the chat message
     * it carries. Called from CallFirebaseMessagingService BEFORE any
     * rendering branch (some of them return early). Never throws.
     */
    fun maybeAppendFromPush(ctx: Context, data: Map<String, String>) {
        try {
            val d = flatten(data) ?: return
            val type = d["type"] ?: return
            if (type !in CHAT_TYPES) return
            val cid = d["conversation_id"]?.takeIf { it.isNotBlank() } ?: return
            val mid = d["message_id"]?.takeIf { it.isNotBlank() } ?: return
            // Backend without [2026-10-07 bgsync] fields → still journal a
            // conversation-only bump (preview + unread) — better than nothing.
            val o = JSONObject()
            o.put("v", 1)
            o.put("src", "fcm")
            o.put("acct", ChatNotifStore.normEmail(d["recipient_email"]))
            o.put("at", System.currentTimeMillis())
            o.put("cid", cid)
            o.put("mid", mid)
            val locked = d["locked"] == "1"
            val full = d["bg_full"] == "1" && !locked
            o.put("full", if (full) "1" else "0")
            o.put("locked", if (locked) "1" else "0")
            o.put("sender", d["sender_email"] ?: "")
            if (!locked) o.put("sname", d["sender_name"] ?: "")
            o.put("type", d["bg_type"] ?: "")
            o.put("preview", (d["msg_preview"] ?: "").take(300))
            o.put("ts", d["bg_ts"] ?: "")
            val isGroup = d["is_group"] == "1" || d["is_group"] == "true" || d["conversation_type"] == "group"
            o.put("grp", if (isGroup) "1" else "0")
            if (!locked) o.put("cname", d["conversation_name"] ?: d["group_name"] ?: "")
            o.put("unread", d["unread_count"] ?: "")
            if (full) {
                fun cp(src: String, dst: String) { d[src]?.takeIf { it.isNotEmpty() }?.let { o.put(dst, it) } }
                cp("bg_text", "text"); cp("bg_cmid", "cmid"); cp("bg_furl", "furl")
                cp("bg_fname", "fname"); cp("bg_fsize", "fsize"); cp("bg_w", "w"); cp("bg_h", "h")
                cp("bg_dur", "dur"); cp("bg_thumb", "thumb"); cp("bg_reply", "reply"); cp("bg_rquote", "rquote")
            }
            appendLines(ctx, listOf(o.toString()))
        } catch (t: Throwable) {
            Log.w(TAG, "maybeAppendFromPush failed: ${t.message}")
        }
    }

    /** FCM-direct = top-level map; Expo-routed = our data as JSON in data["body"]. */
    private fun flatten(raw: Map<String, String>): Map<String, String>? {
        val nested = raw["body"]
        if (raw["type"].isNullOrEmpty() && nested != null && nested.trimStart().startsWith("{")) {
            val j = try { JSONObject(nested) } catch (_: Throwable) { null } ?: return null
            val out = HashMap<String, String>()
            val it = j.keys()
            while (it.hasNext()) {
                val k = it.next()
                val v = j.opt(k)
                if (v != null && v != JSONObject.NULL) out[k] = v.toString()
            }
            return out
        }
        return raw
    }

    // ── chat_sync row → journal line (ChatBgSyncWorker) ────────────────────

    /** Build a journal line from a `chat_sync` hydrated message row. */
    fun lineFromSyncRow(acct: String, convId: String, m: JSONObject): String? {
        return try {
            val mid = m.opt("id")?.toString()?.takeIf { it.isNotBlank() && it != "null" } ?: return null
            if (!m.isNull("deleted_at") && m.optString("deleted_at", "").isNotEmpty()) return null
            val content = if (m.isNull("content")) "" else m.optString("content", "")
            val sealed = m.optBoolean("sealed_sender", false) || m.optString("sealed_sender") == "t"
            val viewOnce = m.optBoolean("is_view_once", false) || m.optString("is_view_once") == "t"
            val e2e = content.startsWith("{\"e2e\"")
            val full = !(sealed || viewOnce || e2e)
            val o = JSONObject()
            o.put("v", 1); o.put("src", "bg"); o.put("acct", acct)
            o.put("at", System.currentTimeMillis())
            o.put("cid", convId); o.put("mid", mid)
            o.put("full", if (full) "1" else "0"); o.put("locked", "0")
            o.put("sender", m.optString("sender_email", ""))
            o.put("type", m.optString("type", "text"))
            o.put("ts", m.optString("created_at", ""))
            fun s(k: String): String = if (m.isNull(k)) "" else m.optString(k, "")
            if (full) {
                o.put("text", content)
                s("client_message_id").takeIf { it.isNotEmpty() }?.let { o.put("cmid", it) }
                s("file_url").takeIf { it.isNotEmpty() }?.let { o.put("furl", it) }
                s("file_name").takeIf { it.isNotEmpty() }?.let { o.put("fname", it) }
                s("file_size").takeIf { it.isNotEmpty() && it != "0" }?.let { o.put("fsize", it) }
                s("image_width").takeIf { it.isNotEmpty() && it != "0" }?.let { o.put("w", it) }
                s("image_height").takeIf { it.isNotEmpty() && it != "0" }?.let { o.put("h", it) }
                s("duration").takeIf { it.isNotEmpty() && it != "0" }?.let { o.put("dur", it) }
                s("thumbnail_url").takeIf { it.isNotEmpty() }?.let { o.put("thumb", it) }
                s("reply_to_id").takeIf { it.isNotEmpty() && it != "0" }?.let { o.put("reply", it) }
                s("reply_quote_text").takeIf { it.isNotEmpty() && !it.startsWith("{\"e2e\"") }?.let { o.put("rquote", it.take(100)) }
            }
            o.toString()
        } catch (_: Throwable) { null }
    }

    /** Diagnostics: number of journal lines currently stored. */
    fun countLines(ctx: Context): Int = read(ctx).count { it == '\n' }
}
