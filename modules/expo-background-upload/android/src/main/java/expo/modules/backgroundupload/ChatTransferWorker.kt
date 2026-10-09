package expo.modules.backgroundupload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit

/**
 * [2026-10-09 media-native] Chat media transfers that survive the app being
 * swiped away (WhatsApp parity) — WorkManager + foreground notification
 * (dataSync), OkHttp.
 *
 * UPLOAD: JS (services/bgTransfer.js) opens/resumes the Rust chunked session
 * and hands us upload id + the chunk indexes the server lacks; we POST each
 * chunk (multipart upload_id / chunk_index / chunk — same wire format as
 * services/api.js rustChunkedUploadNative), then `/upload/complete`, and store
 * its JSON (cdn_url …) in the record. JS reconciles on resume and commits
 * chat_send. Done chunks are persisted, so a retried/restarted worker only
 * sends the rest.
 *
 * DOWNLOAD: GET into `<dest>.part` with Range resume, renamed to dest.
 *
 * Records: filesDir/chatyy-transfers/<id>.json (ChatTransferStore).
 */
object ChatTransferStore {
  private const val DIR = "chatyy-transfers"
  private val lock = Any()

  private fun dir(ctx: Context): File {
    val d = File(ctx.filesDir, DIR)
    if (!d.exists()) d.mkdirs()
    return d
  }

  private fun file(ctx: Context, id: String) = File(dir(ctx), id.replace('/', '_') + ".json")

  fun get(ctx: Context, id: String): JSONObject? {
    synchronized(lock) {
      val f = file(ctx, id)
      if (!f.exists()) return null
      return try {
        JSONObject(f.readText())
      } catch (_: Throwable) {
        null
      }
    }
  }

  fun put(ctx: Context, rec: JSONObject) {
    synchronized(lock) {
      val id = rec.optString("id")
      if (id.isEmpty()) return
      rec.put("updatedAt", System.currentTimeMillis().toDouble() / 1000.0)
      val f = file(ctx, id)
      val tmp = File(f.parentFile, f.name + ".tmp")
      try {
        tmp.writeText(rec.toString())
        if (!tmp.renameTo(f)) {
          f.writeText(rec.toString())
          tmp.delete()
        }
      } catch (t: Throwable) {
        Log.w("ChatTransfer", "store put failed: ${t.message}")
      }
    }
  }

  /** Atomic read-modify-write. */
  fun update(ctx: Context, id: String, fn: (JSONObject) -> Unit): JSONObject? {
    synchronized(lock) {
      val rec = get(ctx, id) ?: return null
      fn(rec)
      put(ctx, rec)
      return rec
    }
  }

  fun remove(ctx: Context, id: String) {
    synchronized(lock) {
      file(ctx, id).delete()
    }
  }

  fun all(ctx: Context): List<JSONObject> {
    synchronized(lock) {
      val out = ArrayList<JSONObject>()
      val now = System.currentTimeMillis().toDouble() / 1000.0
      val files = dir(ctx).listFiles() ?: return out
      for (f in files) {
        if (!f.name.endsWith(".json")) continue
        var rec: JSONObject? = null
        try {
          rec = JSONObject(f.readText())
        } catch (_: Throwable) {
        }
        if (rec == null) continue
        val st = rec.optString("state")
        if (st != "running" && st != "queued" && now - rec.optDouble("updatedAt", 0.0) > 7 * 86400) {
          f.delete()
          continue
        }
        out.add(rec)
      }
      return out
    }
  }

  fun publicView(rec: JSONObject): Map<String, Any?> {
    val m = HashMap<String, Any?>()
    m["id"] = rec.optString("id")
    m["kind"] = rec.optString("kind")
    m["state"] = rec.optString("state")
    m["progress"] = rec.optDouble("progress", 0.0)
    rec.optJSONObject("result")?.let { m["result"] = jsonToMap(it) }
    if (rec.has("error")) m["error"] = rec.optString("error")
    if (rec.has("httpStatus")) m["httpStatus"] = rec.optInt("httpStatus")
    if (rec.has("dest")) m["dest"] = rec.optString("dest")
    return m
  }

  fun jsonToMap(o: JSONObject): Map<String, Any?> {
    val m = HashMap<String, Any?>()
    val it = o.keys()
    while (it.hasNext()) {
      val k = it.next()
      m[k] = when (val v = o.opt(k)) {
        is JSONObject -> jsonToMap(v)
        is JSONArray -> (0 until v.length()).map { i -> v.opt(i) }
        JSONObject.NULL -> null
        else -> v
      }
    }
    return m
  }
}

/** Static bridge to the JS module while it is alive (same process). */
object ChatTransferEvents {
  @Volatile
  var listener: ((String, Map<String, Any?>) -> Unit)? = null
  private val main = Handler(Looper.getMainLooper())

  fun emit(name: String, body: Map<String, Any?>) {
    val l = listener ?: return
    main.post {
      try {
        l(name, body)
      } catch (_: Throwable) {
      }
    }
  }
}

class ChatTransferWorker(
  private val ctx: Context,
  params: WorkerParameters
) : CoroutineWorker(ctx, params) {

  companion object {
    private const val TAG = "ChatTransferWorker"
    private const val CHANNEL_ID = "chatyy_transfers"
    private const val MAX_RUN_ATTEMPTS = 12

    fun workName(id: String) = "chatyy-transfer-$id"

    fun enqueue(ctx: Context, id: String, policy: ExistingWorkPolicy = ExistingWorkPolicy.KEEP) {
      val req = OneTimeWorkRequestBuilder<ChatTransferWorker>()
        .setInputData(workDataOf("id" to id))
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
        .addTag("chatyy-transfer")
        .build()
      WorkManager.getInstance(ctx).enqueueUniqueWork(workName(id), policy, req)
    }

    fun cancelWork(ctx: Context, id: String) {
      WorkManager.getInstance(ctx).cancelUniqueWork(workName(id))
    }

    private val http: OkHttpClient by lazy {
      OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(90, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    }
  }

  private class HardFailure(val code: String, val status: Int) : Exception(code)

  private var lastNotifyAt = 0L
  private var lastEmitAt = 0L

  override suspend fun getForegroundInfo(): ForegroundInfo {
    val id = inputData.getString("id") ?: ""
    return foregroundInfo(id, ChatTransferStore.get(ctx, id), 0.0)
  }

  override suspend fun doWork(): Result {
    val id = inputData.getString("id") ?: return Result.failure()
    val rec = ChatTransferStore.get(ctx, id) ?: return Result.failure()
    val st = rec.optString("state")
    if (st != "running" && st != "queued") return Result.success()
    try {
      setForeground(foregroundInfo(id, rec, rec.optDouble("progress", 0.0)))
    } catch (t: Throwable) {
      // Android 12+ may refuse an FGS start from the background — keep going
      // as a plain worker (still survives the app being swiped).
      Log.w(TAG, "setForeground refused: ${t.message}")
    }
    return try {
      if (rec.optString("kind") == "download") runDownload(id) else runUpload(id)
      Result.success()
    } catch (h: HardFailure) {
      finish(id, "failed", h.code, h.status)
      Result.failure()
    } catch (t: Throwable) {
      Log.w(TAG, "transfer $id attempt failed: ${t.message}")
      if (isStopped) return Result.retry()
      if (runAttemptCount + 1 >= MAX_RUN_ATTEMPTS) {
        finish(id, "failed", t.message ?: "network", 0)
        Result.failure()
      } else {
        Result.retry()
      }
    }
  }

  // ── Upload ─────────────────────────────────────────────────────────────

  private fun stillRunning(id: String): Boolean {
    val st = ChatTransferStore.get(ctx, id)?.optString("state") ?: return false
    return st == "running" || st == "queued"
  }

  private suspend fun runUpload(id: String) {
    val rec = ChatTransferStore.get(ctx, id) ?: throw HardFailure("no_record", 0)
    if (!rec.optBoolean("completing", false)) {
      val pendingArr = rec.optJSONArray("pending") ?: JSONArray()
      val pending = (0 until pendingArr.length()).map { pendingArr.getInt(it) }
      val totalSize = rec.optLong("totalSize")
      val chunkSize = rec.optLong("chunkSize")
      val totalChunks = rec.optInt("totalChunks")
      if (chunkSize <= 0 || totalSize <= 0) throw HardFailure("bad_record", 0)
      val path = filePath(rec.optString("fileUri"))
      if (!File(path).exists()) throw HardFailure("file_missing", 0)
      val sem = Semaphore(3)
      coroutineScope {
        pending.map { i ->
          async(Dispatchers.IO) {
            sem.withPermit {
              if (!stillRunning(id)) return@withPermit
              uploadChunk(id, path, i, chunkSize, totalSize)
              val after = ChatTransferStore.update(ctx, id) { r ->
                val arr = r.optJSONArray("pending") ?: JSONArray()
                val keep = JSONArray()
                for (k in 0 until arr.length()) if (arr.getInt(k) != i) keep.put(arr.getInt(k))
                r.put("pending", keep)
                val done = totalChunks - keep.length()
                r.put("progress", if (totalChunks > 0) minOf(0.99, done.toDouble() / totalChunks) else 0.0)
              }
              if (after != null) progress(id, after.optDouble("progress", 0.0))
            }
          }
        }.awaitAll()
      }
      if (!stillRunning(id)) return
      val left = ChatTransferStore.get(ctx, id)?.optJSONArray("pending")?.length() ?: 0
      if (left > 0) throw IllegalStateException("chunks_left_$left")
      ChatTransferStore.update(ctx, id) { it.put("completing", true) }
    }
    complete(id)
  }

  private fun uploadChunk(id: String, path: String, i: Int, chunkSize: Long, totalSize: Long) {
    val rec = ChatTransferStore.get(ctx, id) ?: throw HardFailure("no_record", 0)
    val start = i.toLong() * chunkSize
    val len = minOf(chunkSize, totalSize - start).toInt()
    if (len <= 0) return
    val bytes = ByteArray(len)
    RandomAccessFile(path, "r").use { raf ->
      raf.seek(start)
      raf.readFully(bytes)
    }
    val body = MultipartBody.Builder()
      .setType(MultipartBody.FORM)
      .addFormDataPart("upload_id", rec.optString("uploadId"))
      .addFormDataPart("chunk_index", i.toString())
      .addFormDataPart("chunk", "chunk_$i.bin", bytes.toRequestBody("application/octet-stream".toMediaType()))
      .build()
    var attempt = 0
    while (true) {
      attempt++
      val bearer = ChatTransferStore.get(ctx, id)?.optString("bearer") ?: ""
      val rb = Request.Builder().url(rec.optString("base") + "/api/rust/upload/chunk").post(body)
      if (bearer.isNotEmpty()) rb.header("Authorization", "Bearer $bearer")
      var status = 0
      try {
        http.newCall(rb.build()).execute().use { resp -> status = resp.code }
      } catch (t: Throwable) {
        status = 0
        if (attempt >= 3) throw t
      }
      if (status in 200..299) return
      if (status != 0 && !retryable(status)) {
        throw HardFailure(if (status == 413) "file_too_large" else "chunk_http_$status", status)
      }
      if (attempt >= 3) throw IllegalStateException("chunk_${i}_http_$status")
      Thread.sleep(minOf(8000L, 1000L shl attempt))
    }
  }

  private fun complete(id: String) {
    val rec = ChatTransferStore.get(ctx, id) ?: throw HardFailure("no_record", 0)
    val payload = JSONObject()
      .put("upload_id", rec.optString("uploadId"))
      .put("filename", rec.optString("filename", "upload"))
      .put("content_type", rec.optString("contentType", "application/octet-stream"))
      .put("user_email", rec.optString("userEmail"))
      .put("context", rec.optString("context", "chat"))
    val rb = Request.Builder()
      .url(rec.optString("base") + "/api/rust/upload/complete")
      .post(payload.toString().toRequestBody("application/json".toMediaType()))
    val bearer = rec.optString("bearer")
    if (bearer.isNotEmpty()) rb.header("Authorization", "Bearer $bearer")
    var status = 0
    var text = ""
    http.newCall(rb.build()).execute().use { resp ->
      status = resp.code
      text = resp.body?.string() ?: ""
    }
    if (status !in 200..299) {
      if (!retryable(status)) throw HardFailure(if (status == 413) "file_too_large" else "complete_http_$status", status)
      throw IllegalStateException("complete_http_$status")
    }
    val json = try {
      JSONObject(text)
    } catch (_: Throwable) {
      JSONObject()
    }
    if ((json.has("success") && !json.optBoolean("success")) || json.optString("cdn_url").isEmpty()) {
      ChatTransferStore.update(ctx, id) { it.put("result", json) }
      throw HardFailure(json.optString("error").ifEmpty { "complete_no_url" }, status)
    }
    ChatTransferStore.update(ctx, id) { it.put("result", json) }
    finish(id, "done", null, status)
  }

  // ── Download ───────────────────────────────────────────────────────────

  private suspend fun runDownload(id: String) = withContext(Dispatchers.IO) {
    val rec = ChatTransferStore.get(ctx, id) ?: throw HardFailure("no_record", 0)
    val dest = File(filePath(rec.optString("dest")))
    dest.parentFile?.mkdirs()
    val part = File(dest.path + ".part")
    val have = if (part.exists()) part.length() else 0L
    val rb = Request.Builder().url(rec.optString("url")).get()
    rec.optJSONObject("headers")?.let { h ->
      val it = h.keys()
      while (it.hasNext()) {
        val k = it.next()
        rb.header(k, h.optString(k))
      }
    }
    if (have > 0) rb.header("Range", "bytes=$have-")
    http.newCall(rb.build()).execute().use { resp ->
      val status = resp.code
      if (status == 416) {
        part.delete()
        throw IllegalStateException("range_not_satisfiable")
      }
      if (status !in 200..299) {
        if (!retryable(status)) throw HardFailure("http_$status", status)
        throw IllegalStateException("http_$status")
      }
      val append = status == 206 && have > 0
      val body = resp.body ?: throw IllegalStateException("empty_body")
      val contentLen = body.contentLength()
      val total = if (contentLen > 0) (if (append) have + contentLen else contentLen) else -1L
      var written = if (append) have else 0L
      FileOutputStream(part, append).use { out ->
        body.byteStream().use { input ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            if (isStopped) throw IllegalStateException("stopped")
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            written += n
            if (total > 0) progress(id, minOf(0.99, written.toDouble() / total))
          }
        }
      }
      if (total > 0 && written != total) throw IllegalStateException("short_body")
      if (dest.exists()) dest.delete()
      if (!part.renameTo(dest)) {
        part.copyTo(dest, overwrite = true)
        part.delete()
      }
      ChatTransferStore.update(ctx, id) {
        val res = JSONObject().put("size", dest.length()).put("status", status)
        resp.header("Content-Type")?.let { ct -> res.put("contentType", ct) }
        it.put("result", res)
      }
      finish(id, "done", null, status)
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private fun retryable(status: Int) =
    status == 0 || status == 408 || status == 425 || status == 429 || status >= 500

  private fun filePath(uri: String): String =
    if (uri.startsWith("file://")) (android.net.Uri.parse(uri).path ?: uri.removePrefix("file://")) else uri

  private fun finish(id: String, state: String, error: String?, status: Int) {
    val rec = ChatTransferStore.update(ctx, id) { r ->
      r.put("state", state)
      r.remove("bearer")
      if (state == "done") r.put("progress", 1.0)
      if (error != null) r.put("error", error)
      if (status > 0) r.put("httpStatus", status)
    } ?: return
    if (rec.optString("kind") == "download" && state != "done") {
      try {
        File(filePath(rec.optString("dest")) + ".part").delete()
      } catch (_: Throwable) {
      }
    }
    ChatTransferEvents.emit("onTransferDone", ChatTransferStore.publicView(rec))
  }

  private suspend fun progress(id: String, p: Double) {
    val now = System.currentTimeMillis()
    ChatTransferStore.update(ctx, id) { it.put("progress", p) }
    if (now - lastEmitAt >= 250) {
      lastEmitAt = now
      ChatTransferEvents.emit("onTransferProgress", mapOf("id" to id, "progress" to p))
      try {
        setProgress(workDataOf("progress" to p))
      } catch (_: Throwable) {
      }
    }
    if (now - lastNotifyAt >= 1000) {
      lastNotifyAt = now
      try {
        setForeground(foregroundInfo(id, ChatTransferStore.get(ctx, id), p))
      } catch (_: Throwable) {
      }
    }
  }

  private fun foregroundInfo(id: String, rec: JSONObject?, p: Double): ForegroundInfo {
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val label = try {
      ctx.applicationInfo.loadLabel(ctx.packageManager).toString()
    } catch (_: Throwable) {
      "Chatyy"
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
      val ch = NotificationChannel(CHANNEL_ID, label, NotificationManager.IMPORTANCE_LOW)
      ch.setShowBadge(false)
      ch.setSound(null, null)
      ch.enableVibration(false)
      nm.createNotificationChannel(ch)
    }
    val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(ctx, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(ctx)
    }
    val iconId = ctx.resources.getIdentifier("notification_icon", "drawable", ctx.packageName)
    val title = rec?.optString("title")?.takeIf { it.isNotEmpty() } ?: label
    val pct = (p * 100).toInt().coerceIn(0, 100)
    b.setSmallIcon(if (iconId != 0) iconId else ctx.applicationInfo.icon)
      .setContentTitle(title)
      .setContentText("$pct%")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setProgress(100, pct, pct == 0)
    val launch: Intent? = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
    if (launch != null) {
      b.setContentIntent(
        PendingIntent.getActivity(ctx, 0x7C20, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      )
    }
    val notifId = 0x7C000 + (id.hashCode() and 0xFFF)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ForegroundInfo(notifId, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      ForegroundInfo(notifId, b.build())
    }
  }
}
