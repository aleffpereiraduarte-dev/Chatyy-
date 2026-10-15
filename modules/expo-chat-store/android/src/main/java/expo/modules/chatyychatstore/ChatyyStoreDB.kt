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
    const val SCHEMA_VERSION = 3
    const val THREAD_WINDOW = 60
    const val MAX_MESSAGES_PER_CONV = 400
    const val MAX_THREADS = 400
    /** [fase 4] fila de envio nativa — mesmo DDL no Swift. */
    const val OUTBOX_DDL = "CREATE TABLE IF NOT EXISTS outbox (cmi TEXT PRIMARY KEY, conv TEXT NOT NULL, seq INTEGER NOT NULL, " +
      "kind TEXT NOT NULL, body TEXT NOT NULL, frame TEXT, file TEXT, up TEXT, state TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, " +
      "next_at INTEGER NOT NULL DEFAULT 0, err TEXT, server TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"

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
      // [2026-10-15 fase 2b/4] fila de envio NATIVA (sobrevive a app fechado)
      db.execSQL(OUTBOX_DDL)
      db.execSQL("CREATE INDEX IF NOT EXISTS idx_outbox_conv ON outbox(conv, seq)")
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
          // [2b] a lista gravou a foto com o que a tela tem → deixa de estar desatualizada
          db.execSQL("DELETE FROM meta WHERE k = ?", arrayOf<Any>("stale:$conv"))
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
    return applyBatchObj(account, b)
  }

  private fun applyBatchObj(account: String, b: JSONObject): Map<String, Any> {
    val db = open(account) ?: return mapOf("ok" to 0, "why" to "open")
    val touched = HashSet<String>()
    var nMsg = 0; var nThreads = 0; var nNative = 0; var nStale = 0
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
      // ─── [2b] chaves do transporte nativo (StoreIngest.translate) ───
      if (b.has("conv_types") || b.has("self_reads") || b.has("peer_reads") || b.has("delivs") || b.has("touch")) {
        val r = applyIngestKeys(account, db, b, touched)
        nNative += r.first; nStale += r.second
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
    return mapOf("ok" to 1, "messages" to nMsg, "threads" to nThreads, "convs" to touched.size, "nativeRows" to nNative, "stale" to nStale)
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
          val ra = op.optJSONArray("rows") ?: continue@loop
          if (after.isNotEmpty() && keys.lastOrNull() != after) {
            // [2b] o transporte nativo já anexou estas linhas (texto simples) →
            // o JS chega depois com a linha "oficial": troca no lugar. Qualquer
            // outra divergência → para (foto não está onde o JS acha).
            var all = ra.length() > 0 && after in keys
            for (j in 0 until ra.length()) { val k = jStr(ra.optJSONObject(j)?.opt("k")); if (k.isEmpty() || k !in keys) { all = false; break } }
            if (!all) {
              if (after in keys) {
                // divergiu do que o nativo anexou (lacuna) → apaga a foto (JS repinta ao abrir)
                db.execSQL("DELETE FROM thread_rows WHERE conv = ?", arrayOf<Any?>(conv))
                db.execSQL("DELETE FROM thread_snap WHERE conv = ?", arrayOf<Any?>(conv))
                db.execSQL("DELETE FROM meta WHERE k = ?", arrayOf<Any?>("stale:$conv"))
                return true
              }
              break@loop
            }
            for (j in 0 until ra.length()) {
              val r = ra.optJSONObject(j) ?: continue
              val k = jStr(r.opt("k"))
              val old = rows[k]
              // mantém o recibo que a foto já subiu (✓✓/azul) se o JS montou com menos
              if (old != null && old.has("st") && r.has("st") && jLong(old.opt("st")) > jLong(r.opt("st"))) r.put("st", old.get("st"))
              rows[k] = r; dirty.add(k); changed = true
            }
            continue@loop
          }
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
        // [fase 4] fila nativa: ✓ (só sobe de relógio/falha) / "!" (só de relógio)
        "ack", "fail" -> {
          val k = jStr(op.opt("k"))
          val r = rows[k] ?: continue@loop
          val cur = if (r.has("st")) jLong(r.opt("st")) else 0L
          if (jStr(op.opt("op")) == "ack") {
            if (cur >= 1) continue@loop
            r.put("st", 1); val id = jStr(op.opt("id")); if (id.isNotEmpty()) r.put("id", id)
          } else {
            if (cur != 0L) continue@loop
            r.put("st", -1)
          }
          dirty.add(k); changed = true
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
    // [2b] foto alcançou a mensagem que a deixou desatualizada → limpa a marca
    val stale = metaGet(db, "stale:$conv")?.toLongOrNull()
    if (stale != null) {
      val newestId = finalKeys.lastOrNull()?.let { rows[it] }?.let { jStr(it.opt("id")).toLongOrNull() } ?: 0L
      if (newestId >= stale) db.execSQL("DELETE FROM meta WHERE k = ?", arrayOf<Any?>("stale:$conv"))
    }
    return true
  }

  private fun metaGet(db: SQLiteDatabase, k: String): String? =
    db.rawQuery("SELECT v FROM meta WHERE k = ?", arrayOf(k)).use { c -> if (c.moveToFirst()) c.getString(0) else null }

  private fun metaSet(db: SQLiteDatabase, k: String, v: String?) {
    if (v == null) db.execSQL("DELETE FROM meta WHERE k = ?", arrayOf<Any?>(k))
    else db.execSQL("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", arrayOf<Any?>(k, v))
  }

  // ═══ [2026-10-15 fase 2b] transporte WS nativo grava direto (sem JS) ═══════

  /**
   * Frames crus do hub (já pré-filtrados por StoreIngest.wants) → lote numa
   * transação, na fila do store. Chamado pelo expo-chat-transport.
   */
  fun ingestFrames(account: String, frames: List<String>, done: ((Map<String, Any>) -> Unit)? = null) {
    if (account.isEmpty() || frames.isEmpty()) return
    ex.execute {
      val out = try {
        val b = StoreIngest.translate(normAccount(account), frames)
        if (b == null) mapOf<String, Any>("ok" to 1, "messages" to 0) else applyBatchObj(account, b)
      } catch (_: SQLiteDatabaseCorruptException) { drop(account); mapOf<String, Any>("ok" to 0, "why" to "corrupt") }
      catch (t: Throwable) { mapOf<String, Any>("ok" to 0, "why" to (t.message ?: "err")) }
      try { done?.invoke(out) } catch (_: Throwable) {}
    }
  }

  /** Perfil de formato p/ o RowBuilder nativo de texto ("" = remove). */
  fun setThreadProfile(account: String, conv: String, json: String) {
    if (account.isEmpty() || conv.isEmpty()) return
    ex.execute {
      try { val db = open(account) ?: return@execute; metaSet(db, "tp:$conv", json.ifEmpty { null }) } catch (_: Throwable) {}
    }
  }

  fun clearThreadProfiles(account: String) {
    if (account.isEmpty()) return
    ex.execute { try { open(account)?.execSQL("DELETE FROM meta WHERE k LIKE 'tp:%'") } catch (_: Throwable) {} }
  }

  /** id da mensagem que deixou a foto desatualizada (0 = em dia). Síncrono. */
  fun threadStaleSync(account: String, conv: String): Long {
    if (account.isEmpty() || conv.isEmpty()) return 0L
    return onEx(1500L, 0L) { val db = open(account) ?: return@onEx 0L; metaGet(db, "stale:$conv")?.toLongOrNull() ?: 0L }
  }

  private fun snapKeys(db: SQLiteDatabase, conv: String): Pair<String, ArrayList<String>>? {
    var rev: String? = null; var sk = ""
    db.rawQuery("SELECT rev, keys FROM thread_snap WHERE conv = ?", arrayOf(conv)).use { c -> if (c.moveToFirst()) { rev = c.getString(0); sk = c.getString(1) ?: "" } }
    val r = rev ?: return null
    val ka = try { JSONArray(sk) } catch (_: Throwable) { JSONArray() }
    return Pair(r, ArrayList<String>(ka.length()).also { l -> for (i in 0 until ka.length()) l.add(ka.optString(i, "")) })
  }

  private fun tailOf(db: SQLiteDatabase, conv: String, keys: List<String>): StoreIngest.Tail? {
    val k = keys.lastOrNull() ?: return null
    val row = db.rawQuery("SELECT row FROM thread_rows WHERE conv = ? AND k = ?", arrayOf(conv, k)).use { c ->
      if (c.moveToFirst()) try { JSONObject(c.getString(0) ?: "{}") } catch (_: Throwable) { null } else null
    } ?: return null
    if (row.optString("kind") != "msg") return null
    val id = jStr(row.opt("id")).toLongOrNull() ?: return null
    return db.rawQuery("SELECT created_at, sender, type FROM messages WHERE conv = ? AND id = ?", arrayOf(conv, id.toString())).use { c ->
      if (!c.moveToFirst()) null
      else { val ts = c.getLong(0); StoreIngest.Tail(k, id, (c.getString(1) ?: "").lowercase(), ts, c.getString(2) ?: "text", StoreIngest.dayKey(ts)) }
    }
  }

  private fun convType(db: SQLiteDatabase, conv: String, b: JSONObject): String {
    val t = b.optJSONObject("conv_types")?.optString(conv, "") ?: ""
    if (t.isNotEmpty()) return t
    return db.rawQuery("SELECT type FROM conversations WHERE id = ?", arrayOf(conv)).use { c -> if (c.moveToFirst()) c.getString(0) ?: "" else "" }
  }

  /** Recibos/leituras + linhas nativas de texto + marca "foto desatualizada". (nativas, stale) */
  private fun applyIngestKeys(account: String, db: SQLiteDatabase, b: JSONObject, touched: HashSet<String>): Pair<Int, Int> {
    val me = normAccount(account)
    var nNative = 0; var nStale = 0
    b.optJSONArray("self_reads")?.let { a ->
      for (i in 0 until a.length()) {
        val r = a.optJSONObject(i) ?: continue
        val conv = jStr(r.opt("conv")); val upTo = jLong(r.opt("upTo")); if (conv.isEmpty() || upTo <= 0) continue
        db.execSQL("UPDATE conversations SET unread = 0, read_watermark = MAX(COALESCE(read_watermark,0), ?) WHERE id = ?", arrayOf<Any?>(upTo, conv))
        db.execSQL("INSERT OR IGNORE INTO cursors (scope, pts, last_id, v, updated_at) VALUES (?,0,0,'',0)", arrayOf<Any?>("read:$conv"))
        db.execSQL("UPDATE cursors SET last_id = MAX(COALESCE(last_id,0), ?), updated_at = ? WHERE scope = ?", arrayOf<Any?>(upTo, System.currentTimeMillis(), "read:$conv"))
        touched.add(conv)
      }
    }
    b.optJSONArray("peer_reads")?.let { a ->
      for (i in 0 until a.length()) {
        val r = a.optJSONObject(i) ?: continue
        val conv = jStr(r.opt("conv")); val upTo = jLong(r.opt("upTo")); if (conv.isEmpty() || upTo <= 0) continue
        val scope = "peer_read:$conv:" + jStr(r.opt("email"))
        db.execSQL("INSERT OR IGNORE INTO cursors (scope, pts, last_id, v, updated_at) VALUES (?,0,0,'',0)", arrayOf<Any?>(scope))
        db.execSQL("UPDATE cursors SET last_id = MAX(COALESCE(last_id,0), ?), updated_at = ? WHERE scope = ?", arrayOf<Any?>(upTo, System.currentTimeMillis(), scope))
        // grupo: leitura de UM membro não é "lido" → só cursor
        if (convType(db, conv, b) != "direct") continue
        val now = System.currentTimeMillis()
        db.execSQL("INSERT OR IGNORE INTO receipts (conv, msg_id, delivered_at, read_at) SELECT conv, id, 0, 0 FROM messages WHERE conv = ? AND sender = ? AND id <= ?", arrayOf<Any?>(conv, me, upTo))
        db.execSQL("UPDATE receipts SET read_at = MAX(COALESCE(read_at,0), ?), delivered_at = MAX(COALESCE(delivered_at,0), ?) WHERE conv = ? AND msg_id <= ? AND msg_id IN (SELECT id FROM messages WHERE conv = ? AND sender = ?)",
          arrayOf<Any?>(now, now, conv, upTo, conv, me))
        if (applyThreadOps(db, conv, "", JSONArray().put(JSONObject().put("op", "stUpTo").put("id", upTo).put("st", 3)))) dropCached(account, conv)
        touched.add(conv)
      }
    }
    b.optJSONArray("delivs")?.let { a ->
      for (i in 0 until a.length()) {
        val r = a.optJSONObject(i) ?: continue
        val conv = jStr(r.opt("conv")); if (conv.isEmpty()) continue
        val at = jLong(r.opt("at")); val ids = r.optJSONArray("ids") ?: continue
        var mx = 0L
        for (j in 0 until ids.length()) {
          val id = jLong(ids.opt(j)); if (id <= 0) continue
          mx = maxOf(mx, id)
          db.execSQL("INSERT OR IGNORE INTO receipts (conv, msg_id, delivered_at, read_at) VALUES (?,?,0,0)", arrayOf<Any?>(conv, id))
          db.execSQL("UPDATE receipts SET delivered_at = MAX(COALESCE(delivered_at,0), ?) WHERE conv = ? AND msg_id = ?", arrayOf<Any?>(at, conv, id))
        }
        if (mx > 0 && convType(db, conv, b) == "direct" &&
          applyThreadOps(db, conv, "", JSONArray().put(JSONObject().put("op", "stUpTo").put("id", mx).put("st", 2)))) dropCached(account, conv)
        touched.add(conv)
      }
    }
    val touch = b.optJSONArray("touch") ?: return Pair(0, 0)
    val nowDay = StoreIngest.dayKey(System.currentTimeMillis())
    val profiles = HashMap<String, StoreIngest.TextProfile?>()
    for (i in 0 until touch.length()) {
      val t = touch.optJSONObject(i) ?: continue
      val conv = jStr(t.opt("conv")); val id = jLong(t.opt("id")); val m = t.optJSONObject("msg") ?: continue
      if (conv.isEmpty() || id <= 0) continue
      val snap = snapKeys(db, conv) ?: continue // sem foto: nada a desatualizar
      val (srev, keys) = snap
      val key = StoreIngest.keyOf(m)
      val isNew = jStr(t.opt("kind")) == "new"
      if (isNew && key in keys) continue // a foto já tem (JS anexou antes)
      if (!isNew) {
        // editada/apagada/reação: só importa se a mensagem está na foto
        val cl = jStr(m.opt("client_message_id"))
        val base = if (cl.isNotEmpty()) "c:$cl" else id.toString()
        if (base !in keys && "${base}_d" !in keys) continue
      }
      val already = metaGet(db, "stale:$conv")?.toLongOrNull()
      if (isNew && already == null) {
        val prof = profiles.getOrPut(conv) {
          metaGet(db, "tp:$conv")?.let { try { StoreIngest.TextProfile(JSONObject(it)) } catch (_: Throwable) { null } }
        }
        if (prof != null && prof.rev == srev) {
          val tail = tailOf(db, conv, keys)
          // lacuna: mensagem canônica entre a última da foto e esta → não anexa
          val gap = tail != null && db.rawQuery("SELECT 1 FROM messages WHERE conv = ? AND id > ? AND id < ? LIMIT 1",
            arrayOf(conv, tail.id.toString(), id.toString())).use { c -> c.moveToFirst() }
          val ops = if (tail != null && !gap) StoreIngest.textOps(prof, m, tail, nowDay) else null
          if (ops != null && applyThreadOps(db, conv, srev, ops)) {
            dropCached(account, conv); touched.add(conv); nNative++
            continue
          }
        }
      }
      if (already == null || already < id) metaSet(db, "stale:$conv", id.toString())
      touched.add(conv); nStale++
    }
    return Pair(nNative, nStale)
  }

  // ═══ [2026-10-15 fase 4] fila de envio NATIVA (persistência) ═════════════
  // O motor (envio WS/HTTP, backoff, ordem, 2º plano) mora no expo-chat-transport
  // (ChatOutbox); aqui só a tabela `outbox` do arquivo da conta. Tudo síncrono
  // na fila do store (chamado da thread do transporte/Worker).

  private val OUTBOX_COLS = arrayOf("cmi", "conv", "seq", "kind", "body", "frame", "file", "up", "state", "tries", "next_at", "err", "server", "created_at", "updated_at")

  /** Insere (idempotente por cmi). Devolve "new" ou o estado atual da linha existente. */
  fun outboxPut(account: String, item: JSONObject): String = onEx(4000L, "") {
    val db = open(account) ?: return@onEx ""
    val cmi = jStr(item.opt("cmi")); val conv = jStr(item.opt("conv"))
    if (cmi.isEmpty() || conv.isEmpty()) return@onEx ""
    val cur = db.rawQuery("SELECT state FROM outbox WHERE cmi = ?", arrayOf(cmi)).use { c -> if (c.moveToFirst()) c.getString(0) else null }
    if (cur != null) return@onEx cur
    val now = System.currentTimeMillis()
    db.execSQL(
      "INSERT OR IGNORE INTO outbox (cmi, conv, seq, kind, body, frame, file, up, state, tries, next_at, err, server, created_at, updated_at) " +
        "VALUES (?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM outbox), ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?)",
      arrayOf<Any?>(cmi, conv, jStr(item.opt("kind")).ifEmpty { "text" }, (item.opt("body") ?: JSONObject()).toString(),
        optStr(item, "frame"), optStr(item, "file"), item.optJSONObject("up")?.toString(), jStr(item.opt("state")).ifEmpty { "queued" },
        jLong(item.opt("created_at")).let { if (it > 0) it else now }, now)
    )
    "new"
  }

  /** Todas as linhas (JSON array, ordem seq). */
  fun outboxAll(account: String): String = onEx(4000L, "[]") {
    val db = open(account) ?: return@onEx "[]"
    val a = JSONArray()
    db.rawQuery("SELECT ${OUTBOX_COLS.joinToString(",")} FROM outbox ORDER BY seq ASC", null).use { c ->
      while (c.moveToNext()) {
        val o = JSONObject()
        for ((i, col) in OUTBOX_COLS.withIndex()) {
          if (c.isNull(i)) continue
          when (col) { "seq", "tries", "next_at", "created_at", "updated_at" -> o.put(col, c.getLong(i)); else -> o.put(col, c.getString(i)) }
        }
        a.put(o)
      }
    }
    a.toString()
  }

  /** Atualiza colunas (state/tries/next_at/err/server/body/file/up). */
  fun outboxPatch(account: String, cmi: String, patch: JSONObject) {
    onEx(4000L, Unit) {
      val db = open(account) ?: return@onEx Unit
      val sets = ArrayList<String>(); val args = ArrayList<Any?>()
      val it = patch.keys()
      while (it.hasNext()) {
        val k = it.next()
        if (k !in arrayOf("state", "tries", "next_at", "err", "server", "body", "file", "up")) continue
        sets.add("$k = ?")
        args.add(if (patch.isNull(k)) null else when (k) { "tries", "next_at" -> jLong(patch.opt(k)); else -> patch.opt(k).toString() })
      }
      if (sets.isEmpty()) return@onEx Unit
      sets.add("updated_at = ?"); args.add(System.currentTimeMillis()); args.add(cmi)
      db.execSQL("UPDATE outbox SET ${sets.joinToString(", ")} WHERE cmi = ?", args.toTypedArray())
      Unit
    }
  }

  fun outboxRemove(account: String, cmi: String) {
    onEx(4000L, Unit) { open(account)?.execSQL("DELETE FROM outbox WHERE cmi = ?", arrayOf<Any?>(cmi)); Unit }
  }

  /** Volta 'sending' órfão (processo morreu no meio) p/ 'queued'. */
  fun outboxRecover(account: String): Int = onEx(4000L, 0) {
    val db = open(account) ?: return@onEx 0
    val st = db.compileStatement("UPDATE outbox SET state = 'queued', next_at = 0 WHERE state = 'sending'")
    val n = try { st.executeUpdateDelete() } finally { st.close() }
    n
  }

  /**
   * Servidor confirmou: linha 'sent' + mensagem canônica + bolha da foto (✓, id
   * do servidor) — a lista nativa reflete mesmo com o JS ocupado/morto.
   */
  fun outboxSent(account: String, cmi: String, conv: String, server: JSONObject) {
    onEx(4000L, Unit) {
      val db = open(account) ?: return@onEx Unit
      db.beginTransaction()
      try {
        db.execSQL("UPDATE outbox SET state = 'sent', server = ?, err = NULL, updated_at = ? WHERE cmi = ?", arrayOf<Any?>(server.toString(), System.currentTimeMillis(), cmi))
        val id = jLong(server.opt("id"))
        if (id > 0) {
          db.execSQL(
            "INSERT OR REPLACE INTO messages (conv, id, ckey, client_id, sender, type, created_at, edited_at, deleted, reply_to, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            arrayOf<Any?>(conv, id, "c:$cmi", cmi, (jStr(server.opt("sender_email")).ifEmpty { account }).lowercase(), jStr(server.opt("type")).ifEmpty { "text" },
              StoreIngest.ms(server.opt("created_at")), 0L, 0L, jLong(server.opt("reply_to_id")), server.toString())
          )
          if (applyThreadOps(db, conv, "", JSONArray().put(JSONObject().put("op", "ack").put("k", "c:$cmi").put("id", id.toString())))) dropCached(account, conv)
        }
        db.setTransactionSuccessful()
      } finally { db.endTransaction() }
      notifyConvs(account, setOf(conv))
      Unit
    }
  }

  /** Falha definitiva: bolha da foto com "!" (st -1). */
  fun outboxFailedMark(account: String, cmi: String, conv: String) {
    onEx(4000L, Unit) {
      val db = open(account) ?: return@onEx Unit
      if (applyThreadOps(db, conv, "", JSONArray().put(JSONObject().put("op", "fail").put("k", "c:$cmi")))) {
        dropCached(account, conv); notifyConvs(account, setOf(conv))
      }
      Unit
    }
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
