package expo.modules.chatyychatstore

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * [2026-10-15 native-store] Motor do store local nativo (fase 1) — espelho do
 * ChatyyStoreDB.swift.
 *
 * • SQLite do SISTEMA (android.database.sqlite) — zero dependência nova.
 * • UM ARQUIVO POR CONTA: noBackupFilesDir/chatyy-store/<sha256(email)[0..24]>.db
 *   (fora do Auto Backup; armazenamento credential-encrypted do FBE).
 * • Um executor de 1 thread é dono das conexões (sem disputa de handle).
 * • É CACHE: corrupção → apaga o arquivo e recomeça.
 *
 * Fase 1 = fotos (snapshots) por conversa: as linhas JÁ MONTADAS (mesmo Map do
 * applyRows) da janela mais nova + a ordem. A lista nativa lê e grava direto.
 */
class ChatyyStoreDB private constructor(ctx: Context) {
  companion object {
    const val SCHEMA_VERSION = 2
    const val THREAD_WINDOW = 60
    const val MAX_MESSAGES_PER_CONV = 400
    const val MAX_THREADS = 400

    @Volatile private var inst: ChatyyStoreDB? = null

    fun get(ctx: Context): ChatyyStoreDB =
      inst ?: synchronized(this) { inst ?: ChatyyStoreDB(ctx.applicationContext).also { inst = it } }

    fun normAccount(s: String): String = s.trim().lowercase()

    fun accountHash(email: String): String {
      val n = normAccount(email)
      if (n.isEmpty()) return ""
      val d = MessageDigest.getInstance("SHA-256").digest(n.toByteArray(Charsets.UTF_8))
      val sb = StringBuilder()
      for (i in 0 until 12) sb.append(String.format("%02x", d[i].toInt() and 0xFF))
      return sb.toString()
    }

    /** JSONObject → Map (recursivo; números como Number, null como null). */
    fun toMap(o: JSONObject): Map<String, Any?> {
      val m = HashMap<String, Any?>(o.length() * 2)
      val it = o.keys()
      while (it.hasNext()) {
        val k = it.next()
        m[k] = unwrap(o.opt(k))
      }
      return m
    }

    private fun unwrap(v: Any?): Any? = when (v) {
      null, JSONObject.NULL -> null
      is JSONObject -> toMap(v)
      is JSONArray -> ArrayList<Any?>(v.length()).also { l -> for (i in 0 until v.length()) l.add(unwrap(v.opt(i))) }
      else -> v
    }
  }

  class Snapshot(val keys: List<String>, val rows: List<Map<String, Any?>>, val newest: String, val readMs: Double)

  private val dir = File(ctx.noBackupFilesDir, "chatyy-store")
  private val ex = Executors.newSingleThreadExecutor { r -> Thread(r, "chatyy-store").apply { priority = Thread.NORM_PRIORITY } }
  private val main = Handler(Looper.getMainLooper())
  private val dbs = HashMap<String, SQLiteDatabase>()
  private var saves = 0
  private var batches = 0

  // [fase 1.5] pré-carga no toque: foto decodificada em memória (LRU 4).
  private val memCache = LinkedHashMap<String, Pair<String, Snapshot>>()
  // [fase 2] observadores por conversa (callback na main).
  private val observers = HashMap<Int, Pair<String, () -> Unit>>()
  private var obsSeq = 0

  // ─── conexão (só no executor) ────────────────────────────────────────────
  private fun fileFor(h: String) = File(dir, "$h.db")

  private fun removeFiles(f: File) {
    for (suf in arrayOf("", "-wal", "-shm", "-journal")) { try { File(f.path + suf).delete() } catch (_: Throwable) {} }
  }

  private fun open(account: String): SQLiteDatabase? {
    val h = accountHash(account)
    if (h.isEmpty()) return null
    dbs[h]?.let { if (it.isOpen) return it }
    if (!dir.exists() && !dir.mkdirs()) return null
    val f = fileFor(h)
    for (attempt in 0 until 2) {
      try {
        val db = SQLiteDatabase.openDatabase(f.path, null, SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.OPEN_READWRITE)
        try { db.enableWriteAheadLogging() } catch (_: Throwable) {}
        if (migrate(db)) { dbs[h] = db; return db }
        try { db.close() } catch (_: Throwable) {}
      } catch (_: Throwable) {}
      if (attempt == 0) removeFiles(f)
    }
    return null
  }

  private fun migrate(db: SQLiteDatabase): Boolean {
    val v = db.version
    if (v > SCHEMA_VERSION) return false
    if (v == SCHEMA_VERSION) return true
    db.beginTransaction()
    try {
      db.execSQL("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
      db.execSQL(
        "CREATE TABLE IF NOT EXISTS thread_snap (conv TEXT PRIMARY KEY, rev TEXT NOT NULL, keys TEXT NOT NULL, " +
          "newest TEXT NOT NULL, n INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
      )
      db.execSQL(
        "CREATE TABLE IF NOT EXISTS thread_rows (conv TEXT NOT NULL, k TEXT NOT NULL, row TEXT NOT NULL, " +
          "PRIMARY KEY (conv, k)) WITHOUT ROWID"
      )
      db.execSQL("CREATE INDEX IF NOT EXISTS idx_thread_snap_upd ON thread_snap(updated_at)")
      // [2026-10-15 native-store fase 1.5/2] home + tabelas canônicas
      db.execSQL("CREATE TABLE IF NOT EXISTS home_snap (scope TEXT PRIMARY KEY, rev TEXT NOT NULL, ids TEXT NOT NULL, top TEXT NOT NULL, n INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
      db.execSQL("CREATE TABLE IF NOT EXISTS home_rows (scope TEXT NOT NULL, id TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (scope, id)) WITHOUT ROWID")
      db.execSQL(
        "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, type TEXT, name TEXT, avatar TEXT, last_msg_id INTEGER, last_ts INTEGER, " +
          "unread INTEGER, pinned INTEGER, muted INTEGER, archived INTEGER, pts INTEGER, read_watermark INTEGER, raw TEXT, updated_at INTEGER)"
      )
      db.execSQL(
        "CREATE TABLE IF NOT EXISTS messages (conv TEXT NOT NULL, id INTEGER NOT NULL, ckey TEXT, client_id TEXT, sender TEXT, type TEXT, " +
          "created_at INTEGER, edited_at INTEGER, deleted INTEGER, reply_to INTEGER, raw TEXT, PRIMARY KEY (conv, id)) WITHOUT ROWID"
      )
      db.execSQL("CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conv, created_at)")
      db.execSQL("CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id)")
      db.execSQL("CREATE TABLE IF NOT EXISTS receipts (conv TEXT NOT NULL, msg_id INTEGER NOT NULL, delivered_at INTEGER, read_at INTEGER, PRIMARY KEY (conv, msg_id)) WITHOUT ROWID")
      db.execSQL("CREATE TABLE IF NOT EXISTS reactions (conv TEXT NOT NULL, msg_id INTEGER NOT NULL, emoji TEXT NOT NULL, users TEXT, PRIMARY KEY (conv, msg_id, emoji)) WITHOUT ROWID")
      db.execSQL("CREATE TABLE IF NOT EXISTS cursors (scope TEXT PRIMARY KEY, pts INTEGER, last_id INTEGER, v TEXT, updated_at INTEGER)")
      db.version = SCHEMA_VERSION
      db.setTransactionSuccessful()
      return true
    } catch (_: Throwable) {
      return false
    } finally {
      try { db.endTransaction() } catch (_: Throwable) {}
    }
  }

  private fun drop(account: String) {
    val h = accountHash(account)
    if (h.isEmpty()) return
    dbs.remove(h)?.let { try { it.close() } catch (_: Throwable) {} }
    removeFiles(fileFor(h))
  }

  // ─── fotos por conversa ──────────────────────────────────────────────────
  /** keys mais antiga → mais nova; rows = Maps (linhas sem chave em keys são ignoradas). keys vazio apaga. */
  fun saveThread(account: String, conv: String, rev: String, keys: List<String>, rows: List<Map<String, Any?>>) {
    if (account.isEmpty() || conv.isEmpty()) return
    ex.execute {
      val db = open(account) ?: return@execute
      dropCached(account, conv)
      val keySet = HashSet(keys)
      val pairs = ArrayList<Pair<String, String>>(rows.size)
      for (d in rows) {
        val k = d["k"] as? String ?: continue
        if (k !in keySet) continue
        val s = try { JSONObject(d).toString() } catch (_: Throwable) { null } ?: continue
        pairs.add(Pair(k, s))
      }
      val have = HashSet<String>(pairs.size).also { s -> pairs.forEach { s.add(it.first) } }
      val ordered = keys.filter { it in have }
      try {
        db.beginTransaction()
        try {
          db.execSQL("DELETE FROM thread_rows WHERE conv = ?", arrayOf(conv))
          if (ordered.isEmpty()) {
            db.execSQL("DELETE FROM thread_snap WHERE conv = ?", arrayOf(conv))
          } else {
            val st = db.compileStatement("INSERT OR REPLACE INTO thread_rows (conv, k, row) VALUES (?, ?, ?)")
            for ((k, s) in pairs) {
              st.clearBindings(); st.bindString(1, conv); st.bindString(2, k); st.bindString(3, s); st.executeInsert()
            }
            st.close()
            db.execSQL(
              "INSERT OR REPLACE INTO thread_snap (conv, rev, keys, newest, n, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
              arrayOf<Any>(conv, rev, JSONArray(ordered).toString(), ordered.last(), ordered.size, System.currentTimeMillis())
            )
          }
          db.setTransactionSuccessful()
        } finally {
          db.endTransaction()
        }
        saves += 1
        if (saves % 50 == 0) prune(db)
      } catch (_: SQLiteDatabaseCorruptException) {
        drop(account)
      } catch (_: Throwable) {}
    }
  }

  private fun prune(db: SQLiteDatabase) {
    try {
      db.beginTransaction()
      try {
        val sub = "SELECT conv FROM thread_snap ORDER BY updated_at DESC LIMIT -1 OFFSET $MAX_THREADS"
        db.execSQL("DELETE FROM thread_rows WHERE conv IN ($sub)")
        db.execSQL("DELETE FROM thread_snap WHERE conv IN ($sub)")
        db.setTransactionSuccessful()
      } finally { db.endTransaction() }
    } catch (_: Throwable) {}
  }

  /** Lê a foto (só se `rev` bater); decodifica no executor; `done` na main. */
  fun loadThread(account: String, conv: String, rev: String, done: (Snapshot?, String) -> Unit) {
    if (account.isEmpty() || conv.isEmpty()) { main.post { done(null, "noacct") }; return }
    ex.execute {
      val t0 = SystemClock.elapsedRealtimeNanos()
      var out: Snapshot? = null
      var why = "miss"
      try {
        val db = open(account)
        if (db == null) {
          why = "open"
        } else {
          var srev: String? = null; var skeys = ""; var newest = ""
          db.rawQuery("SELECT rev, keys, newest FROM thread_snap WHERE conv = ?", arrayOf(conv)).use { c ->
            if (c.moveToFirst()) { srev = c.getString(0); skeys = c.getString(1) ?: ""; newest = c.getString(2) ?: "" }
          }
          if (srev != null && srev != rev) why = "rev"
          if (srev != null && srev == rev) {
            val ka = try { JSONArray(skeys) } catch (_: Throwable) { JSONArray() }
            val map = HashMap<String, Map<String, Any?>>()
            db.rawQuery("SELECT k, row FROM thread_rows WHERE conv = ?", arrayOf(conv)).use { c ->
              while (c.moveToNext()) {
                val k = c.getString(0) ?: continue
                try { map[k] = toMap(JSONObject(c.getString(1) ?: "{}")) } catch (_: Throwable) {}
              }
            }
            val ks = ArrayList<String>(ka.length())
            val rows = ArrayList<Map<String, Any?>>(ka.length())
            for (i in 0 until ka.length()) {
              val k = ka.optString(i, "")
              val d = map[k] ?: continue
              ks.add(k); rows.add(d)
            }
            if (ks.isNotEmpty()) {
              out = Snapshot(ks, rows, newest, (SystemClock.elapsedRealtimeNanos() - t0) / 1e6)
              why = "hit"
            }
          }
        }
      } catch (_: SQLiteDatabaseCorruptException) {
        drop(account); why = "corrupt"
      } catch (_: Throwable) {
        why = "err"
      }
      val o = out; val w = why
      main.post { done(o, w) }
    }
  }

  private fun <T> onEx(timeoutMs: Long, fallback: T, fn: () -> T): T =
    try { ex.submit(Callable { fn() }).get(timeoutMs, TimeUnit.MILLISECONDS) } catch (_: Throwable) { fallback }

  /** Chave mais nova da foto ('' = sem foto). Síncrono (gate do JS). */
  fun newestSync(account: String, conv: String): String {
    if (account.isEmpty() || conv.isEmpty()) return ""
    return onEx(1500L, "") {
      val db = open(account) ?: return@onEx ""
      db.rawQuery("SELECT newest FROM thread_snap WHERE conv = ? AND n > 0", arrayOf(conv)).use { c ->
        if (c.moveToFirst()) c.getString(0) ?: "" else ""
      }
    }
  }

  fun statsSync(account: String): Map<String, Any> = onEx(1500L, mapOf<String, Any>("threads" to 0, "rows" to 0, "bytes" to 0)) {
    val db = open(account) ?: return@onEx mapOf<String, Any>("threads" to 0, "rows" to 0, "bytes" to 0)
    db.rawQuery(
      "SELECT (SELECT COUNT(*) FROM thread_snap), (SELECT COUNT(*) FROM thread_rows), (SELECT COALESCE(SUM(LENGTH(row)),0) FROM thread_rows), " +
        "(SELECT COUNT(*) FROM messages), (SELECT COUNT(*) FROM conversations), (SELECT COUNT(*) FROM home_rows)",
      null
    ).use { c ->
      if (c.moveToFirst()) mapOf<String, Any>(
        "threads" to c.getLong(0), "rows" to c.getLong(1), "bytes" to c.getLong(2),
        "messages" to c.getLong(3), "convs" to c.getLong(4), "homeRows" to c.getLong(5)
      )
      else mapOf<String, Any>("threads" to 0, "rows" to 0, "bytes" to 0)
    }
  }


  // ─── helpers ─────────────────────────────────────────────────────────────
  private fun jStr(v: Any?): String = when (v) {
    null, JSONObject.NULL -> ""
    is String -> v
    is Number -> if (v is Double || v is Float) { val d = v.toDouble(); if (d == Math.floor(d) && !d.isInfinite()) d.toLong().toString() else d.toString() } else v.toString()
    else -> v.toString()
  }

  private fun jLong(v: Any?): Long = when (v) {
    is Number -> v.toLong()
    is String -> v.toLongOrNull() ?: (v.toDoubleOrNull()?.toLong() ?: 0L)
    is Boolean -> if (v) 1L else 0L
    else -> 0L
  }

  private fun optStr(o: JSONObject, k: String): String? = if (!o.has(k) || o.isNull(k)) null else o.opt(k)?.toString()

  private fun cacheKey(account: String, conv: String) = accountHash(account) + "|" + conv

  private fun putCached(account: String, conv: String, rev: String, snap: Snapshot) {
    synchronized(memCache) {
      val k = cacheKey(account, conv)
      memCache.remove(k)
      memCache[k] = Pair(rev, snap)
      while (memCache.size > 4) { val it = memCache.keys.iterator(); it.next(); it.remove() }
    }
  }

  private fun dropCached(account: String, conv: String) { synchronized(memCache) { memCache.remove(cacheKey(account, conv)) } }

  private fun clearCache() { synchronized(memCache) { memCache.clear() } }

  /** [fase 1.5] foto pré-carregada (qualquer thread, síncrono); null se não houver ou rev diferente. */
  fun cachedThread(account: String, conv: String, rev: String): Snapshot? {
    if (account.isEmpty() || conv.isEmpty()) return null
    synchronized(memCache) {
      val e = memCache[cacheKey(account, conv)] ?: return null
      return if (e.first == rev) e.second else null
    }
  }

  /** pressIn da home: lê + decodifica a foto (qualquer rev) para a memória. */
  fun prewarmThread(account: String, conv: String) {
    if (account.isEmpty() || conv.isEmpty()) return
    ex.execute {
      try {
        val t0 = SystemClock.elapsedRealtimeNanos()
        val db = open(account) ?: return@execute
        val r = readSnapshot(db, conv, t0) ?: return@execute
        putCached(account, conv, r.first, r.second)
      } catch (_: Throwable) {}
    }
  }

  private fun readRows(db: SQLiteDatabase, conv: String): HashMap<String, Map<String, Any?>> {
    val map = HashMap<String, Map<String, Any?>>()
    db.rawQuery("SELECT k, row FROM thread_rows WHERE conv = ?", arrayOf(conv)).use { c ->
      while (c.moveToNext()) {
        val k = c.getString(0) ?: continue
        try { map[k] = toMap(JSONObject(c.getString(1) ?: "{}")) } catch (_: Throwable) {}
      }
    }
    return map
  }

  private fun readSnapshot(db: SQLiteDatabase, conv: String, t0: Long): Pair<String, Snapshot>? {
    var rev: String? = null; var skeys = ""; var newest = ""
    db.rawQuery("SELECT rev, keys, newest FROM thread_snap WHERE conv = ?", arrayOf(conv)).use { c ->
      if (c.moveToFirst()) { rev = c.getString(0); skeys = c.getString(1) ?: ""; newest = c.getString(2) ?: "" }
    }
    val rv = rev ?: return null
    val ka = try { JSONArray(skeys) } catch (_: Throwable) { JSONArray() }
    val map = readRows(db, conv)
    val ks = ArrayList<String>(ka.length()); val rows = ArrayList<Map<String, Any?>>(ka.length())
    for (i in 0 until ka.length()) { val k = ka.optString(i, ""); val d = map[k] ?: continue; ks.add(k); rows.add(d) }
    if (ks.isEmpty()) return null
    return Pair(rv, Snapshot(ks, rows, newest, (SystemClock.elapsedRealtimeNanos() - t0) / 1e6))
  }

  // ─── [fase 2] observadores ───────────────────────────────────────────────
  fun addObserver(account: String, conv: String, cb: () -> Unit): Int = synchronized(observers) {
    obsSeq += 1
    observers[obsSeq] = Pair(cacheKey(account, conv), cb)
    obsSeq
  }

  fun removeObserver(token: Int) { synchronized(observers) { observers.remove(token) } }

  private fun notifyConvs(account: String, convs: Set<String>) {
    if (convs.isEmpty()) return
    val keys = convs.map { cacheKey(account, it) }.toHashSet()
    val cbs = synchronized(observers) { observers.values.filter { it.first in keys }.map { it.second } }
    if (cbs.isEmpty()) return
    main.post { for (cb in cbs) try { cb() } catch (_: Throwable) {} }
  }

  // ─── [fase 2] lote canônico (JS sync hoje; transporte WS nativo — fase 2b) ─
  /**
   * Aplica um lote (1 string JSON, formato em docs/native-store-DESIGN.md §3.3)
   * numa transação. API pública p/ o expo-chat-transport gravar direto.
   * `done` roda no executor do store.
   */
  fun applyBatch(account: String, json: String, done: ((Map<String, Any>) -> Unit)? = null) {
    if (account.isEmpty()) { done?.invoke(mapOf("ok" to 0, "why" to "noacct")); return }
    ex.execute {
      val out = try { applyBatchNow(account, json) } catch (_: SQLiteDatabaseCorruptException) { drop(account); mapOf<String, Any>("ok" to 0, "why" to "corrupt") } catch (t: Throwable) { mapOf<String, Any>("ok" to 0, "why" to (t.message ?: "err")) }
      try { done?.invoke(out) } catch (_: Throwable) {}
    }
  }

  private fun applyBatchNow(account: String, json: String): Map<String, Any> {
    val b = try { JSONObject(json) } catch (_: Throwable) { return mapOf("ok" to 0, "why" to "json") }
    val db = open(account) ?: return mapOf("ok" to 0, "why" to "open")
    val touched = HashSet<String>()
    var nMsg = 0; var nThreads = 0
    val now = System.currentTimeMillis()
    db.beginTransaction()
    try {
      b.optJSONArray("conversations")?.let { a ->
        for (i in 0 until a.length()) {
          val c = a.optJSONObject(i) ?: continue
          val id = jStr(c.opt("id")); if (id.isEmpty()) continue
          db.execSQL(
            "INSERT OR REPLACE INTO conversations (id, type, name, avatar, last_msg_id, last_ts, unread, pinned, muted, archived, pts, read_watermark, raw, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            arrayOf<Any?>(id, jStr(c.opt("type")), jStr(c.opt("name")), jStr(c.opt("avatar")), jLong(c.opt("last_msg_id")), jLong(c.opt("last_ts")),
              jLong(c.opt("unread")), jLong(c.opt("pinned")), jLong(c.opt("muted")), jLong(c.opt("archived")), jLong(c.opt("pts")),
              jLong(c.opt("read_watermark")), optStr(c, "raw"), now)
          )
        }
      }
      b.optJSONArray("conv_deletes")?.let { a ->
        for (i in 0 until a.length()) {
          val id = jStr(a.opt(i)); if (id.isEmpty()) continue
          for (t in arrayOf("conversations WHERE id", "messages WHERE conv", "receipts WHERE conv", "reactions WHERE conv", "thread_rows WHERE conv", "thread_snap WHERE conv")) {
            db.execSQL("DELETE FROM $t = ?", arrayOf<Any?>(id))
          }
          touched.add(id)
        }
      }
      b.optJSONArray("messages")?.let { a ->
        for (i in 0 until a.length()) {
          val m = a.optJSONObject(i) ?: continue
          val conv = jStr(m.opt("conv")); val id = jLong(m.opt("id"))
          if (conv.isEmpty() || id <= 0) continue
          db.execSQL(
            "INSERT OR REPLACE INTO messages (conv, id, ckey, client_id, sender, type, created_at, edited_at, deleted, reply_to, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            arrayOf<Any?>(conv, id, jStr(m.opt("ckey")), jStr(m.opt("client_id")), jStr(m.opt("sender")).lowercase(), jStr(m.opt("type")),
              jLong(m.opt("created_at")), jLong(m.opt("edited_at")), jLong(m.opt("deleted")), jLong(m.opt("reply_to")), optStr(m, "raw"))
          )
          touched.add(conv); nMsg++
        }
      }
      b.optJSONArray("msg_deletes")?.let { a ->
        for (i in 0 until a.length()) {
          val d = a.optJSONObject(i) ?: continue
          val conv = jStr(d.opt("conv")); val id = jLong(d.opt("id")); if (conv.isEmpty()) continue
          db.execSQL("DELETE FROM messages WHERE conv = ? AND id = ?", arrayOf<Any?>(conv, id))
          db.execSQL("DELETE FROM receipts WHERE conv = ? AND msg_id = ?", arrayOf<Any?>(conv, id))
          db.execSQL("DELETE FROM reactions WHERE conv = ? AND msg_id = ?", arrayOf<Any?>(conv, id))
          touched.add(conv)
        }
      }
      b.optJSONArray("receipts")?.let { a ->
        for (i in 0 until a.length()) {
          val r = a.optJSONObject(i) ?: continue
          val conv = jStr(r.opt("conv")); val id = jLong(r.opt("msg_id")); if (conv.isEmpty() || id <= 0) continue
          // sem UPSERT (API 24 = SQLite 3.9): INSERT OR IGNORE + UPDATE monotônico
          db.execSQL("INSERT OR IGNORE INTO receipts (conv, msg_id, delivered_at, read_at) VALUES (?,?,0,0)", arrayOf<Any?>(conv, id))
          db.execSQL(
            "UPDATE receipts SET delivered_at = MAX(COALESCE(delivered_at,0), ?), read_at = MAX(COALESCE(read_at,0), ?) WHERE conv = ? AND msg_id = ?",
            arrayOf<Any?>(jLong(r.opt("delivered_at")), jLong(r.opt("read_at")), conv, id)
          )
          touched.add(conv)
        }
      }
      b.optJSONArray("reactions")?.let { a ->
        for (i in 0 until a.length()) {
          val r = a.optJSONObject(i) ?: continue
          val conv = jStr(r.opt("conv")); val id = jLong(r.opt("msg_id")); if (conv.isEmpty() || id <= 0) continue
          db.execSQL("DELETE FROM reactions WHERE conv = ? AND msg_id = ?", arrayOf<Any?>(conv, id))
          r.optJSONArray("set")?.let { s ->
            for (j in 0 until s.length()) {
              val e = s.optJSONObject(j) ?: continue
              val emoji = jStr(e.opt("emoji")); if (emoji.isEmpty()) continue
              db.execSQL("INSERT OR REPLACE INTO reactions (conv, msg_id, emoji, users) VALUES (?,?,?,?)",
                arrayOf<Any?>(conv, id, emoji, (e.optJSONArray("users") ?: JSONArray()).toString()))
            }
          }
          touched.add(conv)
        }
      }
      b.optJSONArray("cursors")?.let { a ->
        for (i in 0 until a.length()) {
          val c = a.optJSONObject(i) ?: continue
          val scope = jStr(c.opt("scope")); if (scope.isEmpty()) continue
          db.execSQL("INSERT OR IGNORE INTO cursors (scope, pts, last_id, v, updated_at) VALUES (?,0,0,'',0)", arrayOf<Any?>(scope))
          db.execSQL(
            "UPDATE cursors SET pts = MAX(COALESCE(pts,0), ?), last_id = MAX(COALESCE(last_id,0), ?), v = COALESCE(?, v), updated_at = ? WHERE scope = ?",
            arrayOf<Any?>(jLong(c.opt("pts")), jLong(c.opt("last_id")), optStr(c, "v"), now, scope)
          )
        }
      }
      b.optJSONArray("threads")?.let { a ->
        for (i in 0 until a.length()) {
          val t = a.optJSONObject(i) ?: continue
          val conv = jStr(t.opt("conv")); if (conv.isEmpty()) continue
          if (applyThreadOps(db, conv, jStr(t.opt("rev")), t.optJSONArray("ops") ?: JSONArray())) {
            nThreads++; touched.add(conv); dropCached(account, conv)
          }
        }
      }
      for (conv in touched) {
        db.execSQL(
          "DELETE FROM messages WHERE conv = ? AND id < COALESCE((SELECT id FROM messages WHERE conv = ? ORDER BY id DESC LIMIT 1 OFFSET ${MAX_MESSAGES_PER_CONV - 1}), 0)",
          arrayOf<Any?>(conv, conv)
        )
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    batches += 1
    if (batches % 200 == 0) {
      try {
        db.execSQL("DELETE FROM receipts WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conv = receipts.conv AND m.id = receipts.msg_id)")
        db.execSQL("DELETE FROM reactions WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conv = reactions.conv AND m.id = reactions.msg_id)")
      } catch (_: Throwable) {}
    }
    notifyConvs(account, touched)
    return mapOf("ok" to 1, "messages" to nMsg, "threads" to nThreads, "convs" to touched.size)
  }

  /** Operações na foto (ver ChatyyStoreDB.swift applyThreadOps). true = gravou. */
  private fun applyThreadOps(db: SQLiteDatabase, conv: String, rev: String, ops: JSONArray): Boolean {
    if (ops.length() == 0) return false
    var srev: String? = null; var skeys = ""
    db.rawQuery("SELECT rev, keys FROM thread_snap WHERE conv = ?", arrayOf(conv)).use { c ->
      if (c.moveToFirst()) { srev = c.getString(0); skeys = c.getString(1) ?: "" }
    }
    val sr = srev ?: return false
    if (rev.isNotEmpty() && rev != sr) return false
    for (i in 0 until ops.length()) {
      if (jStr(ops.optJSONObject(i)?.opt("op")) == "drop") {
        db.execSQL("DELETE FROM thread_rows WHERE conv = ?", arrayOf<Any?>(conv))
        db.execSQL("DELETE FROM thread_snap WHERE conv = ?", arrayOf<Any?>(conv))
        return true
      }
    }
    val ka = try { JSONArray(skeys) } catch (_: Throwable) { JSONArray() }
    val keys = ArrayList<String>(ka.length()).also { l -> for (i in 0 until ka.length()) l.add(ka.optString(i, "")) }
    // linhas como JSONObject (são regravadas como JSON)
    val rows = HashMap<String, JSONObject>()
    db.rawQuery("SELECT k, row FROM thread_rows WHERE conv = ?", arrayOf(conv)).use { c ->
      while (c.moveToNext()) { val k = c.getString(0) ?: continue; try { rows[k] = JSONObject(c.getString(1) ?: "{}") } catch (_: Throwable) {} }
    }
    val dirty = HashSet<String>(); val removed = HashSet<String>()
    var changed = false
    loop@ for (i in 0 until ops.length()) {
      val op = ops.optJSONObject(i) ?: continue
      when (jStr(op.opt("op"))) {
        "append" -> {
          val after = jStr(op.opt("after"))
          if (after.isNotEmpty() && keys.lastOrNull() != after) break@loop
          val ra = op.optJSONArray("rows") ?: continue@loop
          for (j in 0 until ra.length()) {
            val r = ra.optJSONObject(j) ?: continue
            val k = jStr(r.opt("k")); if (k.isEmpty()) continue
            if (k !in keys) keys.add(k)
            rows[k] = r; dirty.add(k); removed.remove(k); changed = true
          }
        }
        "set" -> {
          val k = jStr(op.opt("k"))
          val r = rows[k] ?: continue@loop
          val set = op.optJSONObject("set") ?: continue@loop
          val it = set.keys()
          while (it.hasNext()) { val f = it.next(); if (set.isNull(f)) r.remove(f) else r.put(f, set.get(f)) }
          dirty.add(k); changed = true
        }
        "put" -> {
          val k = jStr(op.opt("k"))
          val old = rows[k] ?: continue@loop
          val r = op.optJSONObject("row") ?: continue@loop
          op.optJSONArray("keep")?.let { kp -> for (j in 0 until kp.length()) { val f = kp.optString(j, ""); if (f.isEmpty()) continue; if (old.has(f)) r.put(f, old.get(f)) else r.remove(f) } }
          val nk = jStr(op.opt("nk")).ifEmpty { k }
          r.put("k", nk)
          if (nk != k) {
            val idx = keys.indexOf(k); if (idx >= 0) keys[idx] = nk
            rows.remove(k); removed.add(k); dirty.remove(k)
          }
          rows[nk] = r; dirty.add(nk); changed = true
        }
        "stUpTo" -> {
          val upTo = jLong(op.opt("id")); val nst = jLong(op.opt("st"))
          if (upTo <= 0 || nst <= 0) continue@loop
          for (k in keys) {
            val r = rows[k] ?: continue
            if (r.optString("kind") != "msg" || jLong(r.opt("own")) != 1L) continue
            val id = jStr(r.opt("id")).toLongOrNull() ?: 0L
            val cur = jLong(r.opt("st"))
            if (id in 1..upTo && cur >= 1 && cur < nst) { r.put("st", nst); dirty.add(k); changed = true }
          }
        }
        else -> {}
      }
    }
    if (!changed) return false
    var finalKeys: List<String> = keys
    if (keys.size > THREAD_WINDOW) {
      for (k in keys.subList(0, keys.size - THREAD_WINDOW)) { removed.add(k); dirty.remove(k) }
      finalKeys = ArrayList(keys.subList(keys.size - THREAD_WINDOW, keys.size))
    }
    val keySet = finalKeys.toHashSet()
    for (k in removed) if (k !in keySet) db.execSQL("DELETE FROM thread_rows WHERE conv = ? AND k = ?", arrayOf<Any?>(conv, k))
    for (k in dirty) {
      val r = rows[k] ?: continue
      db.execSQL("INSERT OR REPLACE INTO thread_rows (conv, k, row) VALUES (?,?,?)", arrayOf<Any?>(conv, k, r.toString()))
    }
    db.execSQL(
      "UPDATE thread_snap SET keys = ?, newest = ?, n = ?, updated_at = ? WHERE conv = ?",
      arrayOf<Any?>(JSONArray(finalKeys).toString(), finalKeys.lastOrNull() ?: "", finalKeys.size, System.currentTimeMillis(), conv)
    )
    return true
  }

  /** Mensagens canônicas (raw), antiga → nova, como "[raw,…]". Síncrono. */
  fun messagesJSONSync(account: String, conv: String, beforeId: Long, limit: Int): String {
    if (account.isEmpty() || conv.isEmpty()) return "[]"
    return onEx(1500L, "[]") {
      val db = open(account) ?: return@onEx "[]"
      val raws = ArrayList<String>()
      val lim = maxOf(1, limit).toString()
      val c = if (beforeId > 0) db.rawQuery("SELECT raw FROM messages WHERE conv = ? AND id < ? ORDER BY id DESC LIMIT ?", arrayOf(conv, beforeId.toString(), lim))
        else db.rawQuery("SELECT raw FROM messages WHERE conv = ? ORDER BY id DESC LIMIT ?", arrayOf(conv, lim))
      c.use { while (it.moveToNext()) { val r = it.getString(0); if (!r.isNullOrEmpty()) raws.add(r) } }
      raws.reverse()
      "[" + raws.joinToString(",") + "]"
    }
  }

  // ─── [fase 1.5] foto da HOME ─────────────────────────────────────────────
  class HomeSnapshot(val ids: List<String>, val rows: List<Map<String, Any?>>, val top: String, val readMs: Double)

  fun saveHome(account: String, scope: String, rev: String, top: String, ids: List<String>, rows: List<Map<String, Any?>>) {
    if (account.isEmpty() || scope.isEmpty()) return
    ex.execute {
      try {
        val db = open(account) ?: return@execute
        val idSet = HashSet(ids)
        val pairs = ArrayList<Pair<String, String>>()
        for (d in rows) {
          val id = jStr(d["id"]); if (id.isEmpty() || id !in idSet) continue
          val s = try { JSONObject(d).toString() } catch (_: Throwable) { null } ?: continue
          pairs.add(Pair(id, s))
        }
        val have = pairs.map { it.first }.toHashSet()
        val ordered = ids.filter { it in have }
        db.beginTransaction()
        try {
          db.execSQL("DELETE FROM home_rows WHERE scope = ?", arrayOf<Any?>(scope))
          if (ordered.isEmpty()) {
            db.execSQL("DELETE FROM home_snap WHERE scope = ?", arrayOf<Any?>(scope))
          } else {
            for ((id, s) in pairs) db.execSQL("INSERT OR REPLACE INTO home_rows (scope, id, row) VALUES (?,?,?)", arrayOf<Any?>(scope, id, s))
            db.execSQL(
              "INSERT OR REPLACE INTO home_snap (scope, rev, ids, top, n, updated_at) VALUES (?,?,?,?,?,?)",
              arrayOf<Any?>(scope, rev, JSONArray(ordered).toString(), top, ordered.size, System.currentTimeMillis())
            )
          }
          db.setTransactionSuccessful()
        } finally { db.endTransaction() }
      } catch (_: SQLiteDatabaseCorruptException) { drop(account) } catch (_: Throwable) {}
    }
  }

  fun loadHome(account: String, scope: String, rev: String, done: (HomeSnapshot?, String) -> Unit) {
    if (account.isEmpty() || scope.isEmpty()) { main.post { done(null, "noacct") }; return }
    ex.execute {
      val t0 = SystemClock.elapsedRealtimeNanos()
      var out: HomeSnapshot? = null
      var why = "miss"
      try {
        val db = open(account)
        if (db == null) why = "open" else {
          var srev: String? = null; var sids = ""; var top = ""
          db.rawQuery("SELECT rev, ids, top FROM home_snap WHERE scope = ?", arrayOf(scope)).use { c ->
            if (c.moveToFirst()) { srev = c.getString(0); sids = c.getString(1) ?: ""; top = c.getString(2) ?: "" }
          }
          if (srev != null && srev != rev) why = "rev"
          if (srev != null && srev == rev) {
            val map = HashMap<String, Map<String, Any?>>()
            db.rawQuery("SELECT id, row FROM home_rows WHERE scope = ?", arrayOf(scope)).use { c ->
              while (c.moveToNext()) { val id = c.getString(0) ?: continue; try { map[id] = toMap(JSONObject(c.getString(1) ?: "{}")) } catch (_: Throwable) {} }
            }
            val ia = try { JSONArray(sids) } catch (_: Throwable) { JSONArray() }
            val ids = ArrayList<String>(); val rows = ArrayList<Map<String, Any?>>()
            for (i in 0 until ia.length()) { val id = ia.optString(i, ""); val d = map[id] ?: continue; ids.add(id); rows.add(d) }
            if (ids.isNotEmpty()) { out = HomeSnapshot(ids, rows, top, (SystemClock.elapsedRealtimeNanos() - t0) / 1e6); why = "hit" }
          }
        }
      } catch (_: SQLiteDatabaseCorruptException) { drop(account); why = "corrupt" } catch (_: Throwable) { why = "err" }
      val o = out; val w = why
      main.post { done(o, w) }
    }
  }

  /** "rev\ntop" da foto da home ('' = sem foto). Síncrono. */
  fun homeTopSync(account: String, scope: String): String {
    if (account.isEmpty() || scope.isEmpty()) return ""
    return onEx(1500L, "") {
      val db = open(account) ?: return@onEx ""
      db.rawQuery("SELECT rev, top FROM home_snap WHERE scope = ? AND n > 0", arrayOf(scope)).use { c ->
        if (c.moveToFirst()) (c.getString(0) ?: "") + "\n" + (c.getString(1) ?: "") else ""
      }
    }
  }

  // ─── limpeza (logout / troca de conta) ───────────────────────────────────
  fun wipeAccount(account: String) { onEx(5000L, Unit) { drop(account) }; clearCache() }

  fun wipeAll() {
    onEx(5000L, Unit) {
      for ((_, db) in dbs) { try { db.close() } catch (_: Throwable) {} }
      dbs.clear()
      try { dir.deleteRecursively() } catch (_: Throwable) {}
      Unit
    }
    clearCache()
  }
}
