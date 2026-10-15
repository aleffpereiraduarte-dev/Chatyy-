package expo.modules.photosbackup

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

// [2026-10-15 photos-native] Fila durável do backup, UM banco por conta
// (pb_<acct>.sqlite em filesDir/databases). Estados (SPEC):
//   0 pending · 1 exported · 2 signed · 3 uploading · 4 uploaded (falta confirm)
//   5 done · 6 failed_perm · 7 skipped (vídeo com includeVideos=false)
internal class PBStore private constructor(context: Context, val acct: String) :
  SQLiteOpenHelper(context.applicationContext, "pb_$acct.sqlite", null, 1) {

  companion object {
    const val S_PENDING = 0
    const val S_EXPORTED = 1
    const val S_SIGNED = 2
    const val S_UPLOADING = 3
    const val S_UPLOADED = 4
    const val S_DONE = 5
    const val S_FAILED = 6
    const val S_SKIPPED = 7
    /** Tentativas a partir das quais o item conta como "failed" (até runNow). */
    const val MAX_ATTEMPTS = 12

    private val open = HashMap<String, PBStore>()

    @Synchronized
    fun get(context: Context, acct: String): PBStore =
      open.getOrPut(acct) { PBStore(context, acct) }
  }

  init {
    setWriteAheadLoggingEnabled(true)
  }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      """CREATE TABLE IF NOT EXISTS assets(
        local_id TEXT PRIMARY KEY, created REAL, media INTEGER, state INTEGER DEFAULT 0,
        attempts INTEGER DEFAULT 0, next_at REAL DEFAULT 0, file_id INTEGER DEFAULT 0,
        object_key TEXT, upload_url TEXT, signed_at REAL DEFAULT 0, hash TEXT, size INTEGER DEFAULT 0,
        temp_path TEXT, task_id INTEGER DEFAULT 0, err TEXT, updated REAL DEFAULT 0)"""
    )
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_assets_state ON assets(state, next_at, created)")
    db.execSQL("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

  data class Row(
    val localId: String,
    val created: Double,
    val media: Int,
    val state: Int,
    val attempts: Int,
    val fileId: Long,
    val objectKey: String?,
    val uploadUrl: String?,
    val signedAt: Double,
    val hash: String?,
    val size: Long,
    val tempPath: String?
  )

  // ── meta ────────────────────────────────────────────────────────────
  fun meta(k: String): String? {
    readableDatabase.rawQuery("SELECT v FROM meta WHERE k=?", arrayOf(k)).use { c ->
      return if (c.moveToFirst()) c.getString(0) else null
    }
  }

  fun setMeta(k: String, v: String?) {
    val db = writableDatabase
    if (v == null) db.delete("meta", "k=?", arrayOf(k))
    else db.insertWithOnConflict("meta", null, ContentValues().apply { put("k", k); put("v", v) }, SQLiteDatabase.CONFLICT_REPLACE)
  }

  // ── sincronização com o MediaStore ──────────────────────────────────
  /** Todos os ids conhecidos → estado. */
  fun allIds(): HashMap<String, Int> {
    val out = HashMap<String, Int>()
    readableDatabase.rawQuery("SELECT local_id, state FROM assets", null).use { c ->
      while (c.moveToNext()) out[c.getString(0)] = c.getInt(1)
    }
    return out
  }

  /** Insere novos itens (INSERT OR IGNORE) numa transação. */
  fun insertNew(items: List<Triple<String, Double, Int>>, includeVideos: Boolean) {
    if (items.isEmpty()) return
    val db = writableDatabase
    val now = nowSec()
    db.beginTransaction()
    try {
      val st = db.compileStatement(
        "INSERT OR IGNORE INTO assets(local_id, created, media, state, updated) VALUES(?,?,?,?,?)"
      )
      for ((id, created, media) in items) {
        st.clearBindings()
        st.bindString(1, id)
        st.bindDouble(2, created)
        st.bindLong(3, media.toLong())
        st.bindLong(4, if (media == 2 && !includeVideos) S_SKIPPED.toLong() else S_PENDING.toLong())
        st.bindDouble(5, now)
        st.executeInsert()
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  /** Remove itens que saíram do aparelho. Devolve temp_paths a apagar. */
  fun deleteIds(ids: Collection<String>): List<String> {
    if (ids.isEmpty()) return emptyList()
    val temps = ArrayList<String>()
    val db = writableDatabase
    db.beginTransaction()
    try {
      for (id in ids) {
        db.rawQuery("SELECT temp_path FROM assets WHERE local_id=?", arrayOf(id)).use { c ->
          if (c.moveToFirst() && !c.isNull(0)) temps.add(c.getString(0))
        }
        db.delete("assets", "local_id=?", arrayOf(id))
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    return temps
  }

  /** includeVideos mudou: vídeos 7 ↔ 0. */
  fun applyVideoPolicy(includeVideos: Boolean) {
    val db = writableDatabase
    if (includeVideos) db.execSQL("UPDATE assets SET state=$S_PENDING, next_at=0 WHERE media=2 AND state=$S_SKIPPED")
    else db.execSQL("UPDATE assets SET state=$S_SKIPPED WHERE media=2 AND state IN ($S_PENDING,$S_EXPORTED,$S_SIGNED)")
  }

  /** Semente: ids que o servidor já tem → done (só se ainda pending). */
  fun markDone(ids: Collection<String>) {
    if (ids.isEmpty()) return
    val db = writableDatabase
    db.beginTransaction()
    try {
      val st = db.compileStatement("UPDATE assets SET state=$S_DONE, updated=? WHERE local_id=? AND state=$S_PENDING")
      val now = nowSec()
      for (id in ids) {
        st.clearBindings(); st.bindDouble(1, now); st.bindString(2, id); st.executeUpdateDelete()
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun pendingIds(limit: Int, offset: Int): List<String> {
    val out = ArrayList<String>()
    readableDatabase.rawQuery(
      "SELECT local_id FROM assets WHERE state=$S_PENDING ORDER BY created DESC LIMIT $limit OFFSET $offset", null
    ).use { c -> while (c.moveToNext()) out.add(c.getString(0)) }
    return out
  }

  // ── fila de trabalho ────────────────────────────────────────────────
  /** Próximo item elegível que não esteja em `exclude` (mais novo primeiro). */
  fun nextEligible(exclude: Set<String>): Row? {
    val now = nowSec()
    readableDatabase.rawQuery(
      "SELECT local_id, created, media, state, attempts, file_id, object_key, upload_url, signed_at, hash, size, temp_path " +
        "FROM assets WHERE state IN ($S_PENDING,$S_EXPORTED,$S_SIGNED,$S_UPLOADING,$S_UPLOADED) " +
        "AND next_at <= ? AND attempts < $MAX_ATTEMPTS ORDER BY (state=$S_UPLOADED) DESC, created DESC LIMIT 64",
      arrayOf(now.toString())
    ).use { c ->
      while (c.moveToNext()) {
        val id = c.getString(0)
        if (exclude.contains(id)) continue
        return Row(
          localId = id,
          created = c.getDouble(1),
          media = c.getInt(2),
          state = c.getInt(3),
          attempts = c.getInt(4),
          fileId = c.getLong(5),
          objectKey = if (c.isNull(6)) null else c.getString(6),
          uploadUrl = if (c.isNull(7)) null else c.getString(7),
          signedAt = c.getDouble(8),
          hash = if (c.isNull(9)) null else c.getString(9),
          size = c.getLong(10),
          tempPath = if (c.isNull(11)) null else c.getString(11)
        )
      }
    }
    return null
  }

  /** Menor next_at futuro entre itens elegíveis (para reagendar). 0 = nenhum. */
  fun earliestRetryAt(): Double {
    readableDatabase.rawQuery(
      "SELECT MIN(next_at) FROM assets WHERE state IN ($S_PENDING,$S_EXPORTED,$S_SIGNED,$S_UPLOADING,$S_UPLOADED) AND attempts < $MAX_ATTEMPTS",
      null
    ).use { c -> return if (c.moveToFirst() && !c.isNull(0)) c.getDouble(0) else 0.0 }
  }

  fun update(localId: String, values: ContentValues) {
    values.put("updated", nowSec())
    writableDatabase.update("assets", values, "local_id=?", arrayOf(localId))
  }

  fun setState(localId: String, state: Int, extra: ContentValues? = null) {
    val v = extra ?: ContentValues()
    v.put("state", state)
    update(localId, v)
  }

  /** Falha transitória: attempts++ e backoff exponencial (30 s · 2^n, teto 6 h). */
  fun fail(localId: String, attempts: Int, backToState: Int, err: String) {
    val n = attempts + 1
    val delay = minOf(6.0 * 3600.0, 30.0 * Math.pow(2.0, attempts.toDouble()))
    update(localId, ContentValues().apply {
      put("attempts", n)
      put("next_at", nowSec() + delay)
      put("state", backToState)
      put("err", err.take(200))
    })
  }

  /** Itens marcados uploading de uma execução anterior que morreu → voltam ao início. */
  fun resetStaleUploading() {
    writableDatabase.execSQL(
      "UPDATE assets SET state=CASE WHEN upload_url IS NOT NULL THEN $S_SIGNED ELSE $S_PENDING END WHERE state=$S_UPLOADING"
    )
  }

  /** runNow: zera esperas e tentativas (inclusive os 'failed' por tentativas). */
  fun clearBackoff() {
    writableDatabase.execSQL("UPDATE assets SET next_at=0, attempts=0 WHERE state IN ($S_PENDING,$S_EXPORTED,$S_SIGNED,$S_UPLOADING,$S_UPLOADED)")
  }

  // ── contadores / snapshot ───────────────────────────────────────────
  data class Counts(
    val total: Int, val done: Int, val pending: Int, val uploading: Int,
    val failed: Int, val skipped: Int
  )

  fun counts(): Counts {
    var total = 0; var done = 0; var pending = 0; var uploading = 0; var failed = 0; var skipped = 0
    readableDatabase.rawQuery(
      "SELECT state, (attempts >= $MAX_ATTEMPTS) AS f, COUNT(*) FROM assets GROUP BY state, f", null
    ).use { c ->
      while (c.moveToNext()) {
        val s = c.getInt(0); val f = c.getInt(1) == 1; val n = c.getInt(2)
        when {
          s == S_SKIPPED -> skipped += n
          s == S_DONE -> done += n
          s == S_FAILED || f -> failed += n
          s == S_UPLOADING -> uploading += n
          else -> pending += n
        }
        if (s != S_SKIPPED) total += n
      }
    }
    return Counts(total, done, pending, uploading, failed, skipped)
  }

  /** {cloud, pending, uploading, failed, local} — ids por estado (p/ a grade). */
  fun snapshot(): Map<String, List<String>> {
    val cloud = ArrayList<String>(); val pending = ArrayList<String>()
    val uploading = ArrayList<String>(); val failed = ArrayList<String>(); val local = ArrayList<String>()
    readableDatabase.rawQuery("SELECT local_id, state, attempts FROM assets", null).use { c ->
      while (c.moveToNext()) {
        val id = c.getString(0); val s = c.getInt(1); val a = c.getInt(2)
        when {
          s == S_DONE -> cloud.add(id)
          s == S_SKIPPED -> local.add(id)
          s == S_FAILED || a >= MAX_ATTEMPTS -> failed.add(id)
          s == S_UPLOADING -> uploading.add(id)
          else -> pending.add(id)
        }
      }
    }
    return mapOf("cloud" to cloud, "pending" to pending, "uploading" to uploading, "failed" to failed, "local" to local)
  }

  private fun nowSec(): Double = System.currentTimeMillis() / 1000.0
}
