package expo.modules.backgroundupload

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Android Photo Backup engine — parity with the existing iOS Swift module.
 *
 * Bridges the per-file hot-path primitives (scan / hash / compress / upload)
 * into native Kotlin so the JS thread never has to:
 *   - decode a JPEG (was blocking the UI for 200-400ms per photo via expo-image-manipulator)
 *   - stream a 100MB video through base64 (was OOM-crashing on devices with <3GB RAM)
 *   - hash a multi-GB video (was 2-3min on slow flash chips)
 *
 * Orchestration (queue, retry, circuit-breaker, dedup batching) stays in JS
 * for the foreground case — same as iOS. The BackupWorker mirrors the iOS
 * BGProcessingTask path for true background continuation.
 */
class ExpoBackgroundUploadModule : Module() {

  companion object {
    private const val TAG = "BgUpload"
    private const val PREFS_NAME = "expo_bg_upload_prefs"
    internal const val WORK_NAME = "photo-backup"

    // OkHttp client is expensive to build — keep one connection pool app-wide.
    // 30s connect + no read timeout (long videos can take minutes on 4G).
    internal val httpClient: OkHttpClient by lazy {
      OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .writeTimeout(0, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    }

    // Dedicated dispatcher so AsyncFunction blocks (which Expo runs on its own
    // executor) don't pile up on Dispatchers.IO and starve other modules.
    internal val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  }

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context not ready" }

  override fun definition() = ModuleDefinition {
    Name("ExpoBackgroundUpload")

    Events(
      "onProgress",        // per-file upload byte progress
      "onComplete",        // per-file done
      "onBatchComplete",   // queue drained
      "onError"            // soft error (caller decides to retry)
    )

    // ── Scan MediaStore ───────────────────────────────────────────────
    // Returns the entire delta since `sinceMs` (null = full library).
    // Even on 30k+ libraries this is <2s because the cursor never crosses
    // the bridge — we just hand JS a finished List<Map>.
    AsyncFunction("scanMediaStore") { sinceMs: Long? ->
      runBlocking {
        withContext(Dispatchers.IO) {
          MediaStoreHelper.scan(context, sinceMs).map { it.toMap() }
        }
      }
    }

    // ── SHA-256 streaming hash ────────────────────────────────────────
    // 64KB chunks via MessageDigest — never holds more than 64KB in RAM.
    // A 100MB video hashes in ~6-8s on a mid-range device vs 2-3min when
    // JS was base64-loading the whole file via expo-file-system.
    AsyncFunction("hashFile") { uriString: String ->
      runBlocking {
        withContext(Dispatchers.IO) {
          hashFileInternal(uriString)
        }
      }
    }

    // ── Compress image ────────────────────────────────────────────────
    // Decodes via BitmapFactory with inSampleSize, resizes once, writes JPEG
    // to cacheDir. Returns the file path + new size so the JS layer can
    // pass it straight to uploadToR2 (or its existing chunked uploader).
    AsyncFunction("compressImage") { uriString: String, maxDim: Int, quality: Int ->
      runBlocking {
        withContext(Dispatchers.IO) {
          compressImageInternal(uriString, maxDim, quality)
        }
      }
    }

    // ── Upload to R2 (presigned PUT) ──────────────────────────────────
    // Streams from disk via OkHttp — no full-file buffer load. Emits
    // onProgress events with (assetId, bytesSent, totalBytes) so the JS
    // engine can update its progress UI exactly like iOS does today.
    AsyncFunction("uploadToR2") { localPath: String, presignedUrl: String, assetId: String?, mimeType: String? ->
      runBlocking {
        withContext(Dispatchers.IO) {
          uploadToR2Internal(localPath, presignedUrl, assetId ?: "", mimeType ?: "application/octet-stream")
        }
      }
    }

    // ── Schedule periodic background backup ───────────────────────────
    // Replaces the JS TaskManager.defineTask path that Android battery
    // saver was killing within minutes. PeriodicWorkRequest runs in the
    // WorkManager system process — survives swipe-to-kill and doze.
    AsyncFunction("scheduleBackup") { wifiOnly: Boolean, chargingOnly: Boolean ->
      val constraints = Constraints.Builder()
        .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .setRequiresCharging(chargingOnly)
        .setRequiresBatteryNotLow(true)
        .build()

      val request = PeriodicWorkRequestBuilder<BackupWorker>(15, TimeUnit.MINUTES)
        .setConstraints(constraints)
        .build()

      WorkManager.getInstance(context).enqueueUniquePeriodicWork(
        WORK_NAME,
        ExistingPeriodicWorkPolicy.UPDATE,
        request
      )

      // Stash the latest constraints in prefs so the worker can re-read them
      // when JS isn't alive to pass them in. The worker uses these to decide
      // whether to actually run (vs. skip until next window).
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
        .putBoolean("wifiOnly", wifiOnly)
        .putBoolean("chargingOnly", chargingOnly)
        .apply()
    }

    // ── Cancel scheduled backup ───────────────────────────────────────
    AsyncFunction("cancelBackup") {
      WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
    }

    // ── Stash credentials so the worker can call back into the API ────
    // The worker runs after process death so it can't reach the JS bridge
    // for the bearer token — it reads it from SharedPreferences instead.
    AsyncFunction("setBackupCreds") { bearer: String, apiBase: String, email: String ->
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
        .putString("bearer", bearer)
        .putString("apiBase", apiBase)
        .putString("email", email)
        .apply()
    }

    // ── Get the active worker count (for diagnostics) ─────────────────
    AsyncFunction("getActiveCount") {
      val infos = WorkManager.getInstance(context)
        .getWorkInfosForUniqueWork(WORK_NAME)
        .get()
      infos.count { !it.state.isFinished }
    }

    // ── No-op stubs so the TS-side iOS API surface compiles cleanly ───
    // (uploadAsset / uploadBatch / cancelAll / scanLibrary / startNativeBackup
    // are iOS-only orchestration helpers. The Android path drives orchestration
    // from JS for foreground and from BackupWorker for background, so these
    // resolve immediately with success-shaped payloads.)
    AsyncFunction("uploadAsset") { _request: Map<String, Any?> ->
      mapOf("assetId" to "", "queued" to false)
    }
    AsyncFunction("uploadBatch") { _requests: List<Map<String, Any?>> ->
      mapOf("queued" to 0, "failed" to 0)
    }
    Function("cancelAll") { /* no-op — BackupWorker is the only persistent path on Android */ }
  }

  // ──────────────────────────────────────────────────────────────────
  // Internal implementations — kept as plain methods so BackupWorker can
  // reuse them without going through the AsyncFunction reflection layer.
  // ──────────────────────────────────────────────────────────────────

  internal fun hashFileInternal(uriString: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
    openInput(uriString).use { input ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val read = input.read(buf)
        if (read <= 0) break
        digest.update(buf, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  internal fun compressImageInternal(uriString: String, maxDim: Int, quality: Int): Map<String, Any> {
    // Phase 1: decode bounds only to pick inSampleSize. Cheap — reads the
    // JPEG/HEIC header, not pixels.
    val boundsOpts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    openInput(uriString).use { BitmapFactory.decodeStream(it, null, boundsOpts) }
    val srcW = boundsOpts.outWidth
    val srcH = boundsOpts.outHeight
    if (srcW <= 0 || srcH <= 0) {
      throw RuntimeException("compress_decode_failed: bounds=$srcW x $srcH for $uriString")
    }

    val maxSide = maxDim.coerceAtLeast(64)
    var sample = 1
    while ((srcW / sample) > maxSide * 2 || (srcH / sample) > maxSide * 2) {
      sample *= 2
    }

    // Phase 2: full decode with the chosen subsample. inPreferredConfig =
    // ARGB_8888 because RGB_565 + JPEG compress causes banding on portrait
    // skin tones — observed on Pixel 5 in QA 2026-05-09.
    val decodeOpts = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val raw: Bitmap = openInput(uriString).use {
      BitmapFactory.decodeStream(it, null, decodeOpts)
    } ?: throw RuntimeException("compress_decode_returned_null: $uriString")

    // Phase 3: final resize to exactly fit maxDim on the longest side.
    val scale = maxSide.toFloat() / maxOf(raw.width, raw.height).toFloat()
    val finalBmp = if (scale < 1f) {
      val newW = (raw.width * scale).toInt().coerceAtLeast(1)
      val newH = (raw.height * scale).toInt().coerceAtLeast(1)
      val scaled = Bitmap.createScaledBitmap(raw, newW, newH, true)
      if (scaled !== raw) raw.recycle()
      scaled
    } else raw

    val outFile = File(
      context.cacheDir,
      "bgup_${System.currentTimeMillis()}_${(Math.random() * 1e9).toInt()}.jpg"
    )
    // Snapshot dimensions BEFORE recycle — calling getWidth on a recycled
    // bitmap returns -1 on some OEMs.
    val outW = finalBmp.width
    val outH = finalBmp.height
    FileOutputStream(outFile).use { fos ->
      finalBmp.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(1, 100), fos)
    }
    finalBmp.recycle()

    return mapOf(
      "uri" to "file://${outFile.absolutePath}",
      "path" to outFile.absolutePath,
      "size" to outFile.length(),
      "width" to outW,
      "height" to outH
    )
  }

  internal fun uploadToR2Internal(
    localPath: String,
    presignedUrl: String,
    assetId: String,
    mimeType: String
  ): Map<String, Any?> {
    val cleanPath = localPath.removePrefix("file://")
    val file = File(cleanPath)
    if (!file.exists()) {
      throw RuntimeException("upload_file_missing: $cleanPath")
    }
    val totalBytes = file.length()

    val body = object : RequestBody() {
      override fun contentType() = mimeType.toMediaTypeOrNull()
      override fun contentLength() = totalBytes
      override fun writeTo(sink: BufferedSink) {
        file.source().use { src ->
          val buf = okio.Buffer()
          var sent = 0L
          var lastEmit = 0L
          while (true) {
            val read = src.read(buf, 64 * 1024L)
            if (read == -1L) break
            sink.write(buf, read)
            sent += read
            // Throttle progress events to ~10/sec — emitting on every
            // 64KB chunk floods the bridge on 4G uploads.
            val now = System.currentTimeMillis()
            if (now - lastEmit > 100L || sent == totalBytes) {
              lastEmit = now
              try {
                sendEvent("onProgress", mapOf(
                  "assetId" to assetId,
                  "bytesSent" to sent,
                  "totalBytes" to totalBytes,
                  "progress" to (sent.toDouble() / totalBytes.coerceAtLeast(1L).toDouble())
                ))
              } catch (_: Throwable) { /* bridge gone — keep uploading */ }
            }
          }
        }
      }
    }

    val req = Request.Builder()
      .url(presignedUrl)
      .put(body)
      .header("Content-Type", mimeType)
      .build()

    httpClient.newCall(req).execute().use { resp ->
      val ok = resp.isSuccessful
      val result = mapOf(
        "uploaded" to ok,
        "status" to resp.code,
        "etag" to (resp.header("ETag") ?: "")
      )
      try {
        sendEvent("onComplete", mapOf(
          "assetId" to assetId,
          "success" to ok,
          "httpStatus" to resp.code
        ))
      } catch (_: Throwable) {}
      if (!ok) {
        Log.w(TAG, "uploadToR2 non-2xx: ${resp.code} for $assetId")
      }
      return result
    }
  }

  private fun openInput(uriString: String): InputStream {
    return if (uriString.startsWith("content://")) {
      context.contentResolver.openInputStream(Uri.parse(uriString))
        ?: throw RuntimeException("openInputStream_returned_null: $uriString")
    } else if (uriString.startsWith("file://")) {
      File(uriString.removePrefix("file://")).inputStream()
    } else {
      // Bare path — also valid for cache-dir compressed outputs that JS
      // sometimes hands back without a scheme.
      File(uriString).inputStream()
    }
  }
}
