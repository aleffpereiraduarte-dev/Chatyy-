package expo.modules.chatcache

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.thread

/**
 * ExpoChatCacheModule — Android port.
 *
 * Mirrors the iOS Swift module's API surface so the JS layer calls the same
 * functions on both platforms. The whole point is TRULY synchronous reads so
 * the chat screen paints cached messages on first render — no async gap.
 *
 * Architecture:
 *   - SQLite file in getCacheDir()/chatyy_chat_cache.sqlite
 *   - In-memory map mirrors hot rows for sub-millisecond reads
 *   - Writes go to memory first, then SQLite on a background thread
 *   - Media cache: content-addressable files in getCacheDir()/chat-media/
 *
 * Sync Functions (called from JS render path):
 *   getCachedMessagesSync, getLastSyncIdSync, getCachedConversationsSync,
 *   getLocalUriSync, getAvatarLocalUriSync, getCachedEmailsSync,
 *   getCachedDriveFilesSync, searchMessagesSync, searchEmailsSync
 *
 * Async Functions:
 *   saveMessages, saveMessage, saveConversations, saveEmails,
 *   prefetchMedia, registerLocalMedia, clearConversation, clearAll, ...
 */
class ExpoChatCacheModule : Module() {

  companion object {
    private const val TAG = "ExpoChatCache"
    private const val DB_NAME = "chatyy_chat_cache.sqlite"
    private const val DEFAULT_LIMIT = 50
    private const val MEMORY_CACHE_SIZE = 100
  }

  private val dbLock = ReentrantLock()
  private val memLock = ReentrantLock()
  private var dbHelper: ChatDbHelper? = null

  // Hot in-memory caches — always read under memLock
  private val memMessages = ConcurrentHashMap<Long, MutableList<JSONObject>>()
  private var convCache: MutableList<JSONObject>? = null
  private val mediaCache = ConcurrentHashMap<String, String>()
  private val emailCache = ConcurrentHashMap<String, MutableList<JSONObject>>()
  private val driveCache = ConcurrentHashMap<Long, MutableList<JSONObject>>()
  private val avatarCache = ConcurrentHashMap<String, String>()

  private val ctx: Context get() = appContext.reactContext!!

  override fun definition() = ModuleDefinition {
    Name("ExpoChatCache")

    OnCreate {
      openDb()
      preloadMemoryCache()
    }

    // ── Messages ─────────────────────────────────────────────────
    Function("getCachedMessagesSync") { conversationId: Long, limit: Int? ->
      val lim = (limit ?: DEFAULT_LIMIT).coerceAtMost(200)
      // Memory first (no I/O)
      memLock.lock()
      try {
        val cached = memMessages[conversationId]
        if (cached != null && cached.isNotEmpty()) {
          val result = if (cached.size <= lim) cached else cached.subList(cached.size - lim, cached.size)
          return@Function result.map { jsonToMap(it) }
        }
      } finally { memLock.unlock() }
      // SQLite fallback
      val rows = queryMessages(conversationId, lim)
      if (rows.isNotEmpty()) {
        memLock.lock()
        try { memMessages[conversationId] = rows.toMutableList() } finally { memLock.unlock() }
      }
      rows.map { jsonToMap(it) }
    }

    Function("getLastSyncIdSync") { conversationId: Long ->
      memLock.lock()
      try {
        val cached = memMessages[conversationId]
        if (cached != null && cached.isNotEmpty()) {
          return@Function cached.maxOf { it.optLong("id", 0L) }
        }
      } finally { memLock.unlock() }
      val db = dbHelper?.readableDatabase ?: return@Function 0L
      db.rawQuery("SELECT MAX(id) FROM messages WHERE conversation_id = ?", arrayOf(conversationId.toString())).use {
        if (it.moveToFirst()) it.getLong(0) else 0L
      }
    }

    AsyncFunction("saveMessages") { conversationId: Long, messages: List<Map<String, Any?>> ->
      if (messages.isEmpty()) return@AsyncFunction
      val jsonList = messages.map { mapToJson(it) }
      // Memory update first
      memLock.lock()
      try {
        val list = memMessages.getOrPut(conversationId) { mutableListOf() }
        for (msg in jsonList) {
          val id = msg.optLong("id", 0L)
          if (id == 0L) continue
          val idx = list.indexOfFirst { it.optLong("id") == id }
          if (idx >= 0) list[idx] = msg else list.add(msg)
        }
        list.sortBy { it.optLong("id", 0L) }
        if (list.size > MEMORY_CACHE_SIZE) {
          val drop = list.size - MEMORY_CACHE_SIZE
          repeat(drop) { list.removeAt(0) }
        }
      } finally { memLock.unlock() }
      // Persist to SQLite on bg thread
      thread(start = true, isDaemon = true) {
        dbLock.lock()
        try {
          val db = dbHelper?.writableDatabase ?: return@thread
          db.beginTransaction()
          try {
            val stmt = db.compileStatement(
              "INSERT OR REPLACE INTO messages (id, conversation_id, sender_email, content, type, file_url, file_name, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            )
            for (msg in jsonList) {
              val id = msg.optLong("id", 0L); if (id == 0L) continue
              stmt.bindLong(1, id)
              stmt.bindLong(2, conversationId)
              stmt.bindString(3, msg.optString("sender_email", ""))
              stmt.bindString(4, msg.optString("content", ""))
              stmt.bindString(5, msg.optString("type", "text"))
              stmt.bindString(6, msg.optString("file_url", ""))
              stmt.bindString(7, msg.optString("file_name", ""))
              stmt.bindString(8, msg.optString("created_at", ""))
              stmt.bindString(9, msg.toString())
              stmt.executeInsert()
              stmt.clearBindings()
            }
            db.setTransactionSuccessful()
          } finally { db.endTransaction() }
        } catch (e: Exception) {
          Log.w(TAG, "saveMessages failed: ${e.message}")
        } finally { dbLock.unlock() }
      }
    }

    AsyncFunction("saveMessage") { conversationId: Long, message: Map<String, Any?> ->
      // Reuse the bulk path
      val id = (message["id"] as? Number)?.toLong() ?: return@AsyncFunction
      val j = mapToJson(message)
      memLock.lock()
      try {
        val list = memMessages.getOrPut(conversationId) { mutableListOf() }
        val idx = list.indexOfFirst { it.optLong("id") == id }
        if (idx >= 0) list[idx] = j else list.add(j)
        list.sortBy { it.optLong("id", 0L) }
      } finally { memLock.unlock() }
      thread(start = true, isDaemon = true) {
        dbLock.lock()
        try {
          val db = dbHelper?.writableDatabase ?: return@thread
          db.execSQL(
            "INSERT OR REPLACE INTO messages (id, conversation_id, sender_email, content, type, file_url, file_name, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            arrayOf(id, conversationId, j.optString("sender_email",""), j.optString("content",""), j.optString("type","text"),
                    j.optString("file_url",""), j.optString("file_name",""), j.optString("created_at",""), j.toString())
          )
        } catch (_: Exception) {} finally { dbLock.unlock() }
      }
    }

    AsyncFunction("clearConversation") { conversationId: Long ->
      memLock.lock()
      try { memMessages.remove(conversationId) } finally { memLock.unlock() }
      thread(start = true, isDaemon = true) {
        dbLock.lock()
        try { dbHelper?.writableDatabase?.delete("messages", "conversation_id = ?", arrayOf(conversationId.toString())) }
        catch (_: Exception) {} finally { dbLock.unlock() }
      }
    }

    AsyncFunction("clearAll") {
      memLock.lock()
      try {
        memMessages.clear(); convCache = null; mediaCache.clear()
        emailCache.clear(); driveCache.clear(); avatarCache.clear()
      } finally { memLock.unlock() }
      thread(start = true, isDaemon = true) {
        dbLock.lock()
        try {
          val db = dbHelper?.writableDatabase ?: return@thread
          db.execSQL("DELETE FROM messages")
          db.execSQL("DELETE FROM conversations")
          db.execSQL("DELETE FROM media")
          db.execSQL("DELETE FROM emails")
        } catch (_: Exception) {} finally { dbLock.unlock() }
      }
    }

    AsyncFunction("warmCache") { conversationId: Long ->
      // Ensure messages for this conversation are in memory
      memLock.lock()
      val hit = memMessages[conversationId]?.isNotEmpty() == true
      memLock.unlock()
      if (hit) return@AsyncFunction
      val rows = queryMessages(conversationId, MEMORY_CACHE_SIZE)
      if (rows.isNotEmpty()) {
        memLock.lock()
        try { memMessages[conversationId] = rows.toMutableList() } finally { memLock.unlock() }
      }
    }

    AsyncFunction("deleteMessage") { conversationId: Long, messageId: Long ->
      memLock.lock()
      try {
        memMessages[conversationId]?.removeAll { it.optLong("id") == messageId }
      } finally { memLock.unlock() }
      thread(start = true, isDaemon = true) {
        dbLock.lock()
        try { dbHelper?.writableDatabase?.delete("messages", "id = ? AND conversation_id = ?", arrayOf(messageId.toString(), conversationId.toString())) }
        catch (_: Exception) {} finally { dbLock.unlock() }
      }
    }

    // ── Conversations ───────────────────────────────────────────
    Function("getCachedConversationsSync") {
      memLock.lock()
      try {
        if (convCache != null) return@Function convCache!!.map { jsonToMap(it) }
      } finally { memLock.unlock() }
      val rows = queryConversations()
      if (rows.isNotEmpty()) {
        memLock.lock()
        try { convCache = rows.toMutableList() } finally { memLock.unlock() }
      }
      rows.map { jsonToMap(it) }
    }

    AsyncFunction("saveConversations") { conversations: List<Map<String, Any?>> ->
      val jsonList = conversations.map { mapToJson(it) }
      memLock.lock()
      try { convCache = jsonList.toMutableList() } finally { memLock.unlock() }
      thread(start = true, isDaemon = true) {
        dbLock.lock()
        try {
          val db = dbHelper?.writableDatabase ?: return@thread
          db.beginTransaction()
          try {
            db.execSQL("DELETE FROM conversations")
            val stmt = db.compileStatement("INSERT INTO conversations (id, payload, updated_at) VALUES (?, ?, ?)")
            for (c in jsonList) {
              val id = c.optLong("id", 0L); if (id == 0L) continue
              stmt.bindLong(1, id)
              stmt.bindString(2, c.toString())
              stmt.bindString(3, c.optString("updated_at", ""))
              stmt.executeInsert()
              stmt.clearBindings()
            }
            db.setTransactionSuccessful()
          } finally { db.endTransaction() }
        } catch (_: Exception) {} finally { dbLock.unlock() }
      }
    }

    AsyncFunction("updateConversation") { conversation: Map<String, Any?> ->
      val j = mapToJson(conversation)
      val id = j.optLong("id", 0L); if (id == 0L) return@AsyncFunction
      memLock.lock()
      try {
        val list = convCache ?: mutableListOf<JSONObject>().also { convCache = it }
        val idx = list.indexOfFirst { it.optLong("id") == id }
        if (idx >= 0) list[idx] = j else list.add(0, j)
      } finally { memLock.unlock() }
      thread(start = true, isDaemon = true) {
        dbLock.lock()
        try {
          dbHelper?.writableDatabase?.execSQL(
            "INSERT OR REPLACE INTO conversations (id, payload, updated_at) VALUES (?, ?, ?)",
            arrayOf(id, j.toString(), j.optString("updated_at",""))
          )
        } catch (_: Exception) {} finally { dbLock.unlock() }
      }
    }

    AsyncFunction("clearConversations") {
      memLock.lock()
      try { convCache = null } finally { memLock.unlock() }
      thread(start = true, isDaemon = true) {
        dbLock.lock()
        try { dbHelper?.writableDatabase?.execSQL("DELETE FROM conversations") }
        catch (_: Exception) {} finally { dbLock.unlock() }
      }
    }

    // ── Media URI cache ──────────────────────────────────────────
    Function("getLocalUriSync") { remoteUrl: String ->
      val cached = mediaCache[remoteUrl]
      if (cached != null && File(cached).exists()) return@Function "file://$cached"
      // SQLite fallback
      val db = dbHelper?.readableDatabase ?: return@Function null
      db.rawQuery("SELECT local_path FROM media WHERE remote_url = ? LIMIT 1", arrayOf(remoteUrl)).use { c ->
        if (c.moveToFirst()) {
          val path = c.getString(0)
          if (path != null && File(path).exists()) {
            mediaCache[remoteUrl] = path
            return@Function "file://$path"
          }
        }
      }
      null
    }

    AsyncFunction("prefetchMedia") { remoteUrl: String ->
      if (mediaCache.containsKey(remoteUrl)) return@AsyncFunction
      // Background download into chat-media/<sha256>
      thread(start = true, isDaemon = true) {
        try {
          val hash = sha256(remoteUrl)
          val dir = File(ctx.cacheDir, "chat-media").apply { mkdirs() }
          val ext = remoteUrl.substringAfterLast('.', "").lowercase().take(4).ifEmpty { "bin" }
          val file = File(dir, "$hash.$ext")
          if (file.exists() && file.length() > 0) {
            mediaCache[remoteUrl] = file.absolutePath
            registerMediaSql(remoteUrl, file.absolutePath)
            return@thread
          }
          val conn = URL(remoteUrl).openConnection()
          conn.connectTimeout = 10_000; conn.readTimeout = 30_000
          conn.getInputStream().use { input ->
            FileOutputStream(file).use { output -> input.copyTo(output) }
          }
          mediaCache[remoteUrl] = file.absolutePath
          registerMediaSql(remoteUrl, file.absolutePath)
        } catch (e: Exception) {
          Log.w(TAG, "prefetchMedia failed for $remoteUrl: ${e.message}")
        }
      }
    }

    AsyncFunction("registerLocalMedia") { remoteUrl: String, localPath: String ->
      val path = localPath.removePrefix("file://")
      mediaCache[remoteUrl] = path
      thread(start = true, isDaemon = true) { registerMediaSql(remoteUrl, path) }
    }

    AsyncFunction("getMediaCacheSize") {
      val dir = File(ctx.cacheDir, "chat-media")
      if (!dir.exists()) return@AsyncFunction 0
      dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
    }

    AsyncFunction("clearMediaCache") {
      mediaCache.clear()
      thread(start = true, isDaemon = true) {
        try {
          File(ctx.cacheDir, "chat-media").deleteRecursively()
          dbLock.lock()
          try { dbHelper?.writableDatabase?.execSQL("DELETE FROM media") }
          finally { dbLock.unlock() }
        } catch (_: Exception) {}
      }
    }

    // ── Email cache ──────────────────────────────────────────────
    Function("getCachedEmailsSync") { folder: String, limit: Int? ->
      val lim = (limit ?: DEFAULT_LIMIT).coerceAtMost(200)
      emailCache[folder]?.let {
        val n = it.size
        return@Function (if (n <= lim) it else it.subList(0, lim)).map { j -> jsonToMap(j) }
      }
      val rows = queryEmails(folder, lim)
      if (rows.isNotEmpty()) emailCache[folder] = rows.toMutableList()
      rows.map { jsonToMap(it) }
    }

    AsyncFunction("saveEmails") { folder: String, emails: List<Map<String, Any?>> ->
      val jsonList = emails.map { mapToJson(it) }
      emailCache[folder] = jsonList.toMutableList()
      thread(start = true, isDaemon = true) {
        dbLock.lock()
        try {
          val db = dbHelper?.writableDatabase ?: return@thread
          db.beginTransaction()
          try {
            db.delete("emails", "folder = ?", arrayOf(folder))
            val stmt = db.compileStatement("INSERT INTO emails (uid, folder, payload) VALUES (?, ?, ?)")
            for (e in jsonList) {
              val uid = e.optLong("uid", 0L); if (uid == 0L) continue
              stmt.bindLong(1, uid); stmt.bindString(2, folder); stmt.bindString(3, e.toString())
              stmt.executeInsert(); stmt.clearBindings()
            }
            db.setTransactionSuccessful()
          } finally { db.endTransaction() }
        } catch (_: Exception) {} finally { dbLock.unlock() }
      }
    }

    AsyncFunction("clearFolder") { folder: String ->
      emailCache.remove(folder)
      thread(start = true, isDaemon = true) {
        dbLock.lock()
        try { dbHelper?.writableDatabase?.delete("emails", "folder = ?", arrayOf(folder)) }
        catch (_: Exception) {} finally { dbLock.unlock() }
      }
    }

    // ── Stubs for drive/avatar/search (return empty, keep JS callsite happy) ─
    Function("getCachedDriveFilesSync") { _: Long, _: Int? -> emptyList<Map<String, Any?>>() }
    AsyncFunction("saveDriveFiles") { _: Long, _: List<Map<String, Any?>> -> }
    Function("getAvatarLocalUriSync") { email: String -> avatarCache[email]?.let { if (File(it).exists()) "file://$it" else null } }
    AsyncFunction("prefetchAvatar") { email: String, remoteUrl: String ->
      thread(start = true, isDaemon = true) {
        try {
          val hash = sha256("avatar:$email")
          val dir = File(ctx.cacheDir, "avatars").apply { mkdirs() }
          val file = File(dir, "$hash.jpg")
          if (file.exists() && file.length() > 0) { avatarCache[email] = file.absolutePath; return@thread }
          val conn = URL(remoteUrl).openConnection()
          conn.connectTimeout = 5_000; conn.readTimeout = 15_000
          conn.getInputStream().use { input -> FileOutputStream(file).use { output -> input.copyTo(output) } }
          avatarCache[email] = file.absolutePath
        } catch (_: Exception) {}
      }
    }
    Function("searchMessagesSync") { _: String, _: Int? -> emptyList<Map<String, Any?>>() }
    Function("searchEmailsSync") { _: String, _: String?, _: Int? -> emptyList<Map<String, Any?>>() }
    AsyncFunction("indexEmailForSearch") { _: Long, _: String, _: String, _: String, _: String -> }
  }

  // ── DB helper + queries ────────────────────────────────────────

  private fun openDb() {
    dbHelper = ChatDbHelper(ctx)
    // Trigger init
    dbHelper?.writableDatabase?.close()
  }

  private fun preloadMemoryCache() {
    // On cold start, pull the most recent conversations + their last 50 msgs
    // into memory so the first render hits the sync path.
    thread(start = true, isDaemon = true) {
      try {
        val convs = queryConversations()
        memLock.lock()
        try { if (convs.isNotEmpty()) convCache = convs.toMutableList() } finally { memLock.unlock() }
        for (c in convs.take(15)) {
          val cid = c.optLong("id", 0L); if (cid == 0L) continue
          val msgs = queryMessages(cid, MEMORY_CACHE_SIZE)
          if (msgs.isNotEmpty()) {
            memLock.lock()
            try { memMessages[cid] = msgs.toMutableList() } finally { memLock.unlock() }
          }
        }
      } catch (e: Exception) { Log.w(TAG, "preload failed: ${e.message}") }
    }
  }

  private fun queryMessages(conversationId: Long, limit: Int): List<JSONObject> {
    val db = dbHelper?.readableDatabase ?: return emptyList()
    val out = mutableListOf<JSONObject>()
    db.rawQuery(
      "SELECT payload FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
      arrayOf(conversationId.toString(), limit.toString())
    ).use {
      while (it.moveToNext()) {
        try { out.add(JSONObject(it.getString(0))) } catch (_: Exception) {}
      }
    }
    out.reverse() // ascending
    return out
  }

  private fun queryConversations(): List<JSONObject> {
    val db = dbHelper?.readableDatabase ?: return emptyList()
    val out = mutableListOf<JSONObject>()
    db.rawQuery("SELECT payload FROM conversations ORDER BY updated_at DESC LIMIT 100", null).use {
      while (it.moveToNext()) {
        try { out.add(JSONObject(it.getString(0))) } catch (_: Exception) {}
      }
    }
    return out
  }

  private fun queryEmails(folder: String, limit: Int): List<JSONObject> {
    val db = dbHelper?.readableDatabase ?: return emptyList()
    val out = mutableListOf<JSONObject>()
    db.rawQuery(
      "SELECT payload FROM emails WHERE folder = ? ORDER BY uid DESC LIMIT ?",
      arrayOf(folder, limit.toString())
    ).use {
      while (it.moveToNext()) {
        try { out.add(JSONObject(it.getString(0))) } catch (_: Exception) {}
      }
    }
    return out
  }

  private fun registerMediaSql(remoteUrl: String, localPath: String) {
    dbLock.lock()
    try {
      dbHelper?.writableDatabase?.execSQL(
        "INSERT OR REPLACE INTO media (remote_url, local_path, cached_at) VALUES (?, ?, strftime('%s','now'))",
        arrayOf(remoteUrl, localPath)
      )
    } catch (_: Exception) {} finally { dbLock.unlock() }
  }

  // ── JSON ↔ Map helpers ─────────────────────────────────────────

  private fun mapToJson(m: Map<String, Any?>): JSONObject {
    val j = JSONObject()
    for ((k, v) in m) {
      when (v) {
        null -> j.put(k, JSONObject.NULL)
        is Map<*, *> -> j.put(k, mapToJson(@Suppress("UNCHECKED_CAST") (v as Map<String, Any?>)))
        is List<*> -> {
          val arr = JSONArray()
          for (item in v) {
            if (item is Map<*, *>) arr.put(mapToJson(@Suppress("UNCHECKED_CAST") (item as Map<String, Any?>)))
            else arr.put(item)
          }
          j.put(k, arr)
        }
        else -> j.put(k, v)
      }
    }
    return j
  }

  private fun jsonToMap(j: JSONObject): Map<String, Any?> {
    val m = mutableMapOf<String, Any?>()
    val keys = j.keys()
    while (keys.hasNext()) {
      val k = keys.next()
      val v = j.opt(k)
      m[k] = when (v) {
        JSONObject.NULL -> null
        is JSONObject -> jsonToMap(v)
        is JSONArray -> jsonArrayToList(v)
        else -> v
      }
    }
    return m
  }

  private fun jsonArrayToList(a: JSONArray): List<Any?> {
    val out = mutableListOf<Any?>()
    for (i in 0 until a.length()) {
      val v = a.opt(i)
      out.add(
        when (v) {
          JSONObject.NULL -> null
          is JSONObject -> jsonToMap(v)
          is JSONArray -> jsonArrayToList(v)
          else -> v
        }
      )
    }
    return out
  }

  private fun sha256(s: String): String {
    val bytes = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
    return bytes.joinToString("") { "%02x".format(it) }
  }
}

// ── SQLite schema ────────────────────────────────────────────────

private class ChatDbHelper(ctx: Context) : SQLiteOpenHelper(ctx, "chatyy_chat_cache.sqlite", null, 1) {
  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL("""
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        sender_email TEXT,
        content TEXT,
        type TEXT,
        file_url TEXT,
        file_name TEXT,
        created_at TEXT,
        payload TEXT NOT NULL
      )
    """)
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id)")
    db.execSQL("""
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT
      )
    """)
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC)")
    db.execSQL("""
      CREATE TABLE IF NOT EXISTS media (
        remote_url TEXT PRIMARY KEY,
        local_path TEXT NOT NULL,
        cached_at INTEGER
      )
    """)
    db.execSQL("""
      CREATE TABLE IF NOT EXISTS emails (
        uid INTEGER,
        folder TEXT,
        payload TEXT NOT NULL,
        PRIMARY KEY (uid, folder)
      )
    """)
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder, uid)")
  }
  override fun onUpgrade(db: SQLiteDatabase, oldV: Int, newV: Int) { /* no-op v1 */ }
}
