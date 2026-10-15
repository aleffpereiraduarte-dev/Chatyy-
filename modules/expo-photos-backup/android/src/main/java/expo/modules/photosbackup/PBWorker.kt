package expo.modules.photosbackup

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

// [2026-10-15 photos-native] Rodada de backup (WorkManager, processo do app).
// Por item: export (original = stream do content://; economia = JPEG 2048 q82)
// → SHA-256 → drive_init_upload (dedupe hash/asset_id) → PUT streaming no R2
// (URL pré-assinada; 403 = expirou → re-assina) → drive_confirm_upload.
// Estado durável no PBStore a cada passo: matar o app no meio retoma de onde
// parou (confirm pendente não re-envia bytes). NUNCA apaga mídia do aparelho.
class PBWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

  companion object {
    private const val TAG = "PBWorker"
    const val CHANNEL = "chatyy_photos_backup"
    const val NOTIF_PROGRESS = 47110
    const val NOTIF_DONE = 47111
    private const val CONCURRENCY = 2
    /** URL pré-assinada vale 1 h; reusa só até 50 min. */
    private const val SIGN_TTL_SEC = 50 * 60
    private const val ECONOMY_MAX = 2048
    private const val ECONOMY_Q = 82

    /** Uma rodada por processo (principal/periódico/gatilho/retry podem coincidir). */
    internal val runLock = Mutex()
    @Volatile internal var running = false
    @Volatile internal var bytesPerSec = 0L

    internal fun ensureChannel(context: Context, prefs: PBPrefs) {
      if (Build.VERSION.SDK_INT < 26) return
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val ch = NotificationChannel(CHANNEL, prefs.label("channel", "Backup de fotos"), NotificationManager.IMPORTANCE_LOW)
      ch.setSound(null, null)
      ch.enableVibration(false)
      ch.setShowBadge(false)
      nm.createNotificationChannel(ch)
    }

    internal fun emitState(context: Context, prefs: PBPrefs) {
      PBEvents.emit("onState", mapOf(
        "running" to running,
        "paused" to prefs.paused,
        "blockedBy" to prefs.blockedBy.ifEmpty { null }
      ))
    }

    internal fun emitProgress(store: PBStore) {
      val c = store.counts()
      PBEvents.emit("onProgress", mapOf(
        "done" to c.done, "total" to c.total, "pending" to c.pending,
        "uploading" to c.uploading, "failed" to c.failed, "bytesPerSec" to bytesPerSec
      ))
    }
  }

  private class AuthBlocked(val reason: String) : Exception(reason)

  private val prefs = PBPrefs(applicationContext)
  private val fresh = AtomicInteger(0)
  private val bytesWindow = AtomicLong(0)
  private var windowStart = System.currentTimeMillis()
  private var lastNotifAt = 0L
  private val inFlight = HashSet<String>()

  override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
    val acct = inputData.getString(PBScheduler.KEY_ACCT) ?: prefs.acct
    val kind = inputData.getString(PBScheduler.KEY_KIND) ?: "main"
    if (prefs.acct.isEmpty() || acct != prefs.acct) return@withContext Result.success()
    if (kind == "trigger") {
      // Gatilho é one-shot: re-arma (roda depois desta terminar).
      try { PBScheduler.armTrigger(applicationContext, prefs, ExistingWorkPolicy.APPEND_OR_REPLACE) } catch (_: Throwable) {}
    }
    if (prefs.paused) return@withContext Result.success()
    val g = PBScheduler.gate(applicationContext, prefs)
    if (g != null) {
      if (g.isNotEmpty()) { prefs.blockedBy = g; emitState(applicationContext, prefs) }
      return@withContext Result.success()
    }
    if (!runLock.tryLock()) return@withContext Result.success()
    val store = PBStore.get(applicationContext, acct)
    running = true
    prefs.blockedBy = ""
    emitState(applicationContext, prefs)
    try {
      store.resetStaleUploading()
      try {
        PBScanner.scan(applicationContext, store, prefs, force = kind == "trigger")
      } catch (e: Throwable) {
        Log.w(TAG, "scan failed: ${e.message}")
      }
      emitProgress(store)
      val c0 = store.counts()
      if (c0.pending + c0.uploading > 0) {
        try { setForeground(foregroundInfo(store)) } catch (e: Throwable) {
          // Android 12+ pode recusar FGS vindo do background: segue sem (≤10 min).
          Log.w(TAG, "setForeground refused: ${e.message}")
        }
      }
      coroutineScope {
        (0 until CONCURRENCY).map { async { lane(acct, store) } }.awaitAll()
      }
    } catch (e: AuthBlocked) {
      prefs.blockedBy = e.reason
    } catch (e: Throwable) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.w(TAG, "run failed: ${e.message}")
      prefs.lastError = (e.message ?: "error").take(200)
    } finally {
      running = false
      runLock.unlock()
      prefs.lastRunAt = System.currentTimeMillis()
      try { emitProgress(store); emitState(applicationContext, prefs) } catch (_: Throwable) {}
      try { NotificationManagerCompat.from(applicationContext).cancel(NOTIF_PROGRESS) } catch (_: Throwable) {}
    }
    if (!isStopped && prefs.acct == acct) {
      postDone(store)
      val next = store.earliestRetryAt()
      val now = System.currentTimeMillis() / 1000.0
      if (next > now && prefs.blockedBy.isEmpty()) {
        PBScheduler.scheduleRetry(applicationContext, prefs, (next - now).toLong() + 1)
      }
    }
    Result.success()
  }

  private fun shouldStop(acct: String): Boolean {
    if (isStopped) return true
    if (prefs.paused || !prefs.enabled || prefs.acct != acct || prefs.token.isEmpty()) return true
    if (prefs.blockedBy.isNotEmpty()) return true
    val g = PBScheduler.gate(applicationContext, prefs)
    if (g != null) {
      if (g.isNotEmpty()) prefs.blockedBy = g
      return true
    }
    return false
  }

  private fun claim(store: PBStore): PBStore.Row? = synchronized(inFlight) {
    val r = store.nextEligible(inFlight) ?: return null
    inFlight.add(r.localId)
    r
  }

  private fun release(id: String) = synchronized(inFlight) { inFlight.remove(id) }

  private suspend fun lane(acct: String, store: PBStore) {
    while (!shouldStop(acct)) {
      val row = claim(store) ?: return
      try {
        process(store, row)
      } catch (e: AuthBlocked) {
        throw e
      } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
      } catch (e: Throwable) {
        Log.w(TAG, "item ${row.localId} failed: ${e.message}")
        store.fail(row.localId, row.attempts, if (row.state == PBStore.S_UPLOADED) PBStore.S_UPLOADED else PBStore.S_PENDING, e.message ?: "error")
      } finally {
        release(row.localId)
      }
      tickNotification(store)
    }
  }

  // ── um item ─────────────────────────────────────────────────────────
  private suspend fun process(store: PBStore, row0: PBStore.Row) {
    var row = row0
    val id = row.localId
    if (row.state == PBStore.S_UPLOADED && row.objectKey != null) {
      confirm(store, row, null)
      return
    }
    val media = PBScanner.lookup(applicationContext, id, row.media)
    if (media == null) {
      store.fail(id, row.attempts, PBStore.S_PENDING, "not_found")
      return
    }
    if (media.size <= 0) {
      store.setState(id, PBStore.S_FAILED, ContentValues().apply { put("err", "empty") })
      return
    }

    // 1. fonte (original ou economia)
    val economy = prefs.quality == "economy" && !media.isVideo && media.mime.startsWith("image/") && !media.mime.contains("gif")
    var tempFile: File? = row.tempPath?.let { File(it) }?.takeIf { it.exists() && it.length() > 0 }
    if (economy && tempFile == null) {
      tempFile = compress(media)
      if (tempFile == null) {
        store.fail(id, row.attempts, PBStore.S_PENDING, "compress_failed")
        return
      }
    }
    val mime = if (economy) "image/jpeg" else media.mime
    val size = tempFile?.length() ?: media.size
    val open: () -> InputStream = tempFile?.let { f -> { FileInputStream(f) } } ?: {
      applicationContext.contentResolver.openInputStream(media.uri) ?: throw java.io.IOException("open_failed")
    }
    // 2. hash (reusa se o arquivo é o mesmo)
    val sameBytes = row.hash != null && row.size == size && row.state >= PBStore.S_EXPORTED &&
      (!economy || (tempFile != null && row.tempPath == tempFile.absolutePath))
    val hash = if (sameBytes) row.hash!! else sha256(open)
    store.update(id, ContentValues().apply {
      put("state", maxOf(row.state, PBStore.S_EXPORTED).coerceAtMost(PBStore.S_SIGNED))
      put("hash", hash); put("size", size)
      if (tempFile != null) put("temp_path", tempFile.absolutePath)
    })
    val filename = taggedName(media.name, id, if (economy) "jpg" else null)

    var attemptSign = 0
    while (true) {
      // 3. assinatura (reusa URL < 50 min)
      val nowSec = System.currentTimeMillis() / 1000.0
      if (!(row.state == PBStore.S_SIGNED && row.uploadUrl != null && nowSec - row.signedAt < SIGN_TTL_SEC && (sameBytes || row.hash == hash))) {
        val body = JSONObject()
          .put("filename", filename).put("mime_type", mime).put("asset_id", id)
          .put("content_hash", hash).put("size", size).put("taken_at", media.takenMs)
        val r = PBNet.postWithFallback(prefs, "drive_init_upload", body)
        val data = r.json?.optJSONObject("data")
        when {
          r.code == 401 || r.code == 403 -> throw AuthBlocked("auth")
          r.code == 507 -> throw AuthBlocked("quota")
          r.code == 413 || data?.optString("code") == "file_too_large" -> {
            store.setState(id, PBStore.S_FAILED, ContentValues().apply { put("err", "file_too_large") })
            dropTemp(tempFile)
            emitItem(id, "failed", null)
            return
          }
          r.code in 200..299 && r.json?.optBoolean("success", false) == true && data != null -> {
            if (data.optBoolean("deduped", false)) {
              markDone(store, id, data.optLong("file_id", 0), tempFile, 0)
              return
            }
            val url = data.optString("upload_url", "")
            val key = data.optString("object_key", "")
            if (url.isEmpty() || key.isEmpty()) {
              store.fail(id, row.attempts, PBStore.S_EXPORTED, "init_no_url"); return
            }
            store.update(id, ContentValues().apply {
              put("state", PBStore.S_SIGNED); put("upload_url", url); put("object_key", key)
              put("file_id", data.optLong("file_id", 0)); put("signed_at", nowSec)
            })
            row = row.copy(state = PBStore.S_SIGNED, uploadUrl = url, objectKey = key,
              fileId = data.optLong("file_id", 0), signedAt = nowSec, size = size, hash = hash)
          }
          else -> {
            store.fail(id, row.attempts, PBStore.S_EXPORTED, "init_${r.code}"); return
          }
        }
      }

      // 4. PUT streaming
      store.setState(id, PBStore.S_UPLOADING)
      emitItem(id, "uploading", null)
      val code = PBNet.put(row.uploadUrl!!, mime, size, open) { n -> countBytes(n) }
      if (code in 200..299) {
        store.setState(id, PBStore.S_UPLOADED)
        row = row.copy(state = PBStore.S_UPLOADED)
        confirm(store, row, tempFile, mediaTakenMs = media.takenMs, bytes = size)
        return
      }
      if (code == 403 && attemptSign == 0) {
        // URL expirou/assinatura não bate → re-assina uma vez já.
        attemptSign++
        store.update(id, ContentValues().apply { put("state", PBStore.S_EXPORTED); putNull("upload_url") })
        row = row.copy(state = PBStore.S_EXPORTED, uploadUrl = null)
        continue
      }
      store.fail(id, row.attempts, if (code == 403) PBStore.S_EXPORTED else PBStore.S_SIGNED, "put_$code")
      emitItem(id, "pending", null)
      return
    }
  }

  private suspend fun confirm(store: PBStore, row: PBStore.Row, tempFile: File?, mediaTakenMs: Long = 0, bytes: Long = 0) {
    val body = JSONObject()
      .put("file_id", row.fileId).put("s3_key", row.objectKey ?: "")
      .put("content_hash", row.hash ?: "").put("asset_id", row.localId)
    if (mediaTakenMs > 0) body.put("taken_at", mediaTakenMs)
    val r = PBNet.postWithFallback(prefs, "drive_confirm_upload", body)
    when {
      r.code in 200..299 && r.json?.optBoolean("success", false) == true -> {
        val fid = r.json.optJSONObject("data")?.optLong("file_id", row.fileId) ?: row.fileId
        markDone(store, row.localId, if (fid > 0) fid else row.fileId, tempFile ?: row.tempPath?.let { File(it) }, bytes)
        fresh.incrementAndGet()
      }
      r.code == 401 -> throw AuthBlocked("auth")
      r.code == 404 -> {
        // objeto/linha não existe → envia de novo do zero
        store.fail(row.localId, row.attempts, PBStore.S_PENDING, "confirm_404")
        store.update(row.localId, ContentValues().apply { putNull("upload_url"); putNull("object_key") })
      }
      else -> store.fail(row.localId, row.attempts, PBStore.S_UPLOADED, "confirm_${r.code}")
    }
  }

  private fun markDone(store: PBStore, id: String, fileId: Long, temp: File?, bytes: Long) {
    store.update(id, ContentValues().apply {
      put("state", PBStore.S_DONE); put("file_id", fileId); put("err", null as String?)
      putNull("upload_url"); putNull("temp_path"); put("attempts", 0); put("next_at", 0)
    })
    dropTemp(temp)
    if (bytes > 0) {
      val prev = store.meta("bytesDone")?.toLongOrNull() ?: 0L
      store.setMeta("bytesDone", (prev + bytes).toString())
    }
    emitItem(id, "cloud", fileId)
  }

  private fun dropTemp(f: File?) { try { f?.delete() } catch (_: Throwable) {} }

  private fun emitItem(id: String, state: String, fileId: Long?) {
    val m = HashMap<String, Any?>()
    m["localId"] = id; m["state"] = state
    if (fileId != null && fileId > 0) m["fileId"] = fileId
    PBEvents.emit("onItem", m)
  }

  // ── utilidades ──────────────────────────────────────────────────────
  private fun sha256(open: () -> InputStream): String {
    val md = MessageDigest.getInstance("SHA-256")
    open().use { input ->
      val buf = ByteArray(256 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n <= 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }

  private fun md5Tag(id: String): String {
    val d = MessageDigest.getInstance("MD5").digest(id.toByteArray())
    return d.joinToString("") { "%02x".format(it) }.substring(0, 10)
  }

  /** NOME_<md5(localId)[0:10]>.ext — mesma tag que o servidor usa no dedupe. */
  private fun taggedName(name: String, id: String, forceExt: String?): String {
    val clean = name.replace(Regex("[^a-zA-Z0-9._-]"), "_").ifEmpty { "media_$id" }
    val dot = clean.lastIndexOf('.')
    var base = if (dot > 0) clean.substring(0, dot) else clean
    var ext = if (dot > 0) clean.substring(dot + 1) else ""
    if (forceExt != null) ext = forceExt
    val tag = md5Tag(id)
    if (base.endsWith("_$tag")) base = base.removeSuffix("_$tag")
    base = base.take(120)
    return if (ext.isNotEmpty()) "${base}_$tag.$ext" else "${base}_$tag"
  }

  private fun tempDir(): File {
    val d = File(applicationContext.cacheDir, "pb_${prefs.acct}")
    d.mkdirs()
    return d
  }

  /** Economia: JPEG lado maior ≤ 2048, q82, orientação EXIF aplicada. */
  private fun compress(media: PBScanner.Media): File? {
    return try {
      val cr = applicationContext.contentResolver
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      cr.openInputStream(media.uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
      val w = bounds.outWidth; val h = bounds.outHeight
      if (w <= 0 || h <= 0) return null
      var sample = 1
      while (maxOf(w, h) / (sample * 2) >= ECONOMY_MAX) sample *= 2
      val opts = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
      var bmp = cr.openInputStream(media.uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
      val rot = exifRotation(media)
      val longSide = maxOf(bmp.width, bmp.height)
      if (longSide > ECONOMY_MAX || rot != 0) {
        val m = Matrix()
        val s = if (longSide > ECONOMY_MAX) ECONOMY_MAX.toFloat() / longSide else 1f
        m.postScale(s, s)
        if (rot != 0) m.postRotate(rot.toFloat())
        val nb = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        if (nb !== bmp) bmp.recycle()
        bmp = nb
      }
      val out = File(tempDir(), "${media.id}_${System.currentTimeMillis()}.jpg")
      out.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, ECONOMY_Q, it) }
      bmp.recycle()
      out
    } catch (e: Throwable) {
      Log.w(TAG, "compress ${media.id} failed: ${e.message}")
      null
    }
  }

  private fun exifRotation(media: PBScanner.Media): Int {
    return try {
      val proj = arrayOf(android.provider.MediaStore.Images.ImageColumns.ORIENTATION)
      applicationContext.contentResolver.query(media.uri, proj, null, null, null)?.use { c ->
        if (c.moveToFirst() && !c.isNull(0)) c.getInt(0) else 0
      } ?: 0
    } catch (_: Throwable) { 0 }
  }

  private fun countBytes(n: Long) {
    bytesWindow.addAndGet(n)
    val now = System.currentTimeMillis()
    val span = now - windowStart
    if (span >= 2000) {
      bytesPerSec = bytesWindow.getAndSet(0) * 1000 / span
      windowStart = now
    }
  }

  // ── notificações (discretas: canal LOW, silenciosas) ────────────────
  private fun pauseIntent(): PendingIntent {
    val i = Intent(applicationContext, PBActionReceiver::class.java).setAction(PBActionReceiver.ACTION_PAUSE)
    return PendingIntent.getBroadcast(applicationContext, 1, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun launchIntent(): PendingIntent? {
    val li = applicationContext.packageManager.getLaunchIntentForPackage(applicationContext.packageName) ?: return null
    return PendingIntent.getActivity(applicationContext, 2, li, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun buildProgress(store: PBStore): android.app.Notification {
    ensureChannel(applicationContext, prefs)
    val c = store.counts()
    val body = prefs.label("progressBody", "{done} de {total}")
      .replace("{done}", c.done.toString()).replace("{total}", c.total.toString())
    return NotificationCompat.Builder(applicationContext, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle(prefs.label("progressTitle", "Salvando fotos"))
      .setContentText(body)
      .setProgress(maxOf(c.total, 1), c.done, false)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setContentIntent(launchIntent())
      .addAction(0, prefs.label("pause", "Pausar"), pauseIntent())
      .build()
  }

  private fun foregroundInfo(store: PBStore): ForegroundInfo {
    val n = buildProgress(store)
    return if (Build.VERSION.SDK_INT >= 29) {
      ForegroundInfo(NOTIF_PROGRESS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      ForegroundInfo(NOTIF_PROGRESS, n)
    }
  }

  private suspend fun tickNotification(store: PBStore) {
    val now = System.currentTimeMillis()
    if (now - lastNotifAt < 1500) return
    lastNotifAt = now
    emitProgress(store)
    try { setProgress(androidx.work.Data.Builder().putLong("t", now).build()) } catch (_: Throwable) {}
    try {
      if (NotificationManagerCompat.from(applicationContext).areNotificationsEnabled()) {
        NotificationManagerCompat.from(applicationContext).notify(NOTIF_PROGRESS, buildProgress(store))
      }
    } catch (_: SecurityException) {} catch (_: Throwable) {}
  }

  private fun postDone(store: PBStore) {
    val n = fresh.get()
    if (n <= 0 || !prefs.notify) return
    try {
      val nm = NotificationManagerCompat.from(applicationContext)
      if (!nm.areNotificationsEnabled()) return
      ensureChannel(applicationContext, prefs)
      val c = store.counts()
      val title = if (c.pending + c.uploading == 0) prefs.label("doneTitle", "Backup concluído")
        else prefs.label("progressTitle", "Salvando fotos")
      val body = prefs.label("doneBody", "{n} itens salvos").replace("{n}", n.toString())
      val notif = NotificationCompat.Builder(applicationContext, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_sys_upload_done)
        .setContentTitle(title)
        .setContentText(body)
        .setSilent(true)
        .setAutoCancel(true)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setContentIntent(launchIntent())
        .build()
      nm.notify(NOTIF_DONE, notif)
    } catch (_: SecurityException) {} catch (_: Throwable) {}
  }
}

/** Botão "Pausar" da notificação: pausa persistente (o JS lê em getStatus/onState). */
class PBActionReceiver : BroadcastReceiver() {
  companion object { const val ACTION_PAUSE = "expo.modules.photosbackup.PAUSE" }

  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action != ACTION_PAUSE) return
    val prefs = PBPrefs(context)
    prefs.paused = true
    PBScheduler.cancelAll(context)
    try { NotificationManagerCompat.from(context).cancel(PBWorker.NOTIF_PROGRESS) } catch (_: Throwable) {}
    PBWorker.emitState(context, prefs)
  }
}
