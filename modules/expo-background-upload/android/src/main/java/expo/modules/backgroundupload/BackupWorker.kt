package expo.modules.backgroundupload

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * WorkManager periodic worker for true background continuation.
 *
 * Lives in the WorkManager system process, so it survives:
 *   - user swiping the app off the recents stack
 *   - Android battery saver / doze killing the app's normal process
 *   - app being upgraded mid-backup
 *
 * The worker:
 *   1. Reads bearer/api creds from SharedPreferences (stashed by JS via
 *      setBackupCreds when the user logged in).
 *   2. Scans MediaStore for items not yet in the backed-up-ids set.
 *   3. For each item: hash → call drive_init_upload → upload via OkHttp →
 *      mark in the backed-up-ids set.
 *   4. Respects wifiOnly / chargingOnly via the WorkManager constraints
 *      attached at enqueue time (system enforces these — we just run).
 *
 * Per-file primitive operations reuse ExpoBackgroundUploadModule's internal
 * methods via a freshly-constructed temporary helper. We DON'T grab the JS
 * module instance because the JS bridge may not exist when WorkManager
 * wakes us.
 */
class BackupWorker(
  appContext: Context,
  params: WorkerParameters
) : CoroutineWorker(appContext, params) {

  companion object {
    private const val TAG = "BgUpWorker"
    private const val PREFS = "expo_bg_upload_prefs"
    private const val BACKED_UP_KEY = "backed_up_ids"
    private const val MAX_FILES_PER_RUN = 50
    // Skip files larger than 100MB in the background path — those go through
    // the foreground multipart flow that JS still drives. Trying to push a
    // 500MB video through a 15-min worker window just wastes battery.
    private const val MAX_FILE_SIZE_BG = 100L * 1024L * 1024L
  }

  override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
    val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val bearer = prefs.getString("bearer", null)
    val apiBase = prefs.getString("apiBase", null)
    val email = prefs.getString("email", null)

    if (bearer.isNullOrEmpty() || apiBase.isNullOrEmpty() || email.isNullOrEmpty()) {
      Log.w(TAG, "Missing creds (bearer/apiBase/email) — user not logged in, skipping")
      // success() so WorkManager doesn't retry-loop on a logged-out device
      return@withContext Result.success()
    }

    try {
      val rows = MediaStoreHelper.scan(applicationContext, sinceMs = null)
      val backedUp = loadBackedUpIds(prefs)

      var uploaded = 0
      var failed = 0
      // Helper for the per-file primitives — we don't need the Expo Module
      // lifecycle, just the same code paths.
      val helper = WorkerHelper(applicationContext)

      for (row in rows) {
        if (uploaded + failed >= MAX_FILES_PER_RUN) break
        if (backedUp.contains(row.id)) continue
        if (row.size > MAX_FILE_SIZE_BG) continue
        if (row.size <= 0) continue

        try {
          val hash = helper.hashFile(row.uri)
          val initResp = initUpload(
            apiBase, bearer, email,
            filename = row.displayName,
            mimeType = row.mimeType,
            size = row.size,
            contentHash = hash
          )

          if (initResp.optBoolean("duplicate", false)) {
            // Server already has it — mark and move on.
            backedUp.add(row.id); uploaded++
            continue
          }

          val data = initResp.optJSONObject("data")
          val uploadUrl = data?.optString("upload_url", "") ?: ""
          if (uploadUrl.isEmpty()) {
            failed++; continue
          }

          val result = helper.uploadFromContentUri(
            uri = row.uri,
            presignedUrl = uploadUrl,
            mimeType = row.mimeType
          )

          if (result) {
            // Tell the server the upload finished — same call shape JS uses.
            registerUploaded(
              apiBase, bearer, email,
              filename = row.displayName,
              size = row.size,
              mimeType = row.mimeType,
              contentHash = hash,
              assetId = row.id,
              fileId = data?.optString("file_id", "") ?: ""
            )
            backedUp.add(row.id)
            uploaded++
          } else {
            failed++
          }
        } catch (e: Exception) {
          Log.w(TAG, "Upload failed for ${row.id}: ${e.message}")
          failed++
          // Stop on too many consecutive failures — likely auth or network issue
          if (failed >= 5 && uploaded == 0) {
            Log.w(TAG, "5 fails before first success — backing off, will retry on next window")
            saveBackedUpIds(prefs, backedUp)
            return@withContext Result.retry()
          }
        }
      }

      saveBackedUpIds(prefs, backedUp)
      Log.i(TAG, "doWork complete: uploaded=$uploaded failed=$failed remaining=${rows.size - backedUp.size}")
      Result.success()
    } catch (e: Exception) {
      Log.e(TAG, "doWork fatal", e)
      Result.retry()
    }
  }

  // ── Backed-up-id set persistence ────────────────────────────────────
  private fun loadBackedUpIds(prefs: android.content.SharedPreferences): MutableSet<String> {
    val raw = prefs.getString(BACKED_UP_KEY, "[]") ?: "[]"
    val arr = try { JSONArray(raw) } catch (_: Exception) { JSONArray() }
    val out = HashSet<String>(arr.length())
    for (i in 0 until arr.length()) out.add(arr.optString(i))
    return out
  }

  private fun saveBackedUpIds(prefs: android.content.SharedPreferences, ids: Set<String>) {
    val arr = JSONArray()
    for (id in ids) arr.put(id)
    prefs.edit().putString(BACKED_UP_KEY, arr.toString()).apply()
  }

  // ── Server round-trips ──────────────────────────────────────────────
  private fun initUpload(
    apiBase: String,
    bearer: String,
    email: String,
    filename: String,
    mimeType: String,
    size: Long,
    contentHash: String
  ): JSONObject {
    val body = JSONObject().apply {
      put("action", "drive_init_upload")
      put("filename", filename)
      put("mime_type", mimeType)
      put("size", size)
      put("content_hash", contentHash)
    }
    val req = Request.Builder()
      .url(apiBase.trimEnd('/') + "/email.php")
      .header("Authorization", "Bearer $bearer")
      .header("X-User-Email", email)
      .post(body.toString().toRequestBody("application/json".toMediaTypeOrNull()))
      .build()
    ExpoBackgroundUploadModule.httpClient.newCall(req).execute().use { resp ->
      val txt = resp.body?.string() ?: "{}"
      return JSONObject(txt)
    }
  }

  private fun registerUploaded(
    apiBase: String,
    bearer: String,
    email: String,
    filename: String,
    size: Long,
    mimeType: String,
    contentHash: String,
    assetId: String,
    fileId: String
  ) {
    val body = JSONObject().apply {
      put("action", "drive_register_uploaded")
      put("filename", filename)
      put("size", size)
      put("mime_type", mimeType)
      put("content_hash", contentHash)
      put("asset_id", assetId)
      if (fileId.isNotEmpty()) put("file_id", fileId)
    }
    val req = Request.Builder()
      .url(apiBase.trimEnd('/') + "/email.php")
      .header("Authorization", "Bearer $bearer")
      .header("X-User-Email", email)
      .post(body.toString().toRequestBody("application/json".toMediaTypeOrNull()))
      .build()
    try {
      ExpoBackgroundUploadModule.httpClient.newCall(req).execute().close()
    } catch (e: Exception) {
      Log.w(TAG, "registerUploaded best-effort failed: ${e.message}")
    }
  }
}

/**
 * Plain-class helper for the per-file primitives so BackupWorker doesn't
 * need an instantiated Expo Module (those have a React bridge dependency
 * that doesn't exist when WorkManager wakes us).
 */
internal class WorkerHelper(private val context: Context) {

  fun hashFile(uriString: String): String {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
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

  fun uploadFromContentUri(uri: String, presignedUrl: String, mimeType: String): Boolean {
    // Stage the content:// uri to a temp file first because OkHttp's
    // RequestBody needs a stable Source — content URIs can vanish mid-read
    // if the underlying MediaStore row changes.
    val tmp = File(context.cacheDir, "bgw_${System.currentTimeMillis()}.bin")
    try {
      openInput(uri).use { input ->
        tmp.outputStream().use { out -> input.copyTo(out, 64 * 1024) }
      }
      val body = tmp.asRequestBody(mimeType)
      val req = Request.Builder()
        .url(presignedUrl)
        .put(body)
        .header("Content-Type", mimeType)
        .build()
      ExpoBackgroundUploadModule.httpClient.newCall(req).execute().use { resp ->
        return resp.isSuccessful
      }
    } finally {
      try { tmp.delete() } catch (_: Exception) {}
    }
  }

  private fun openInput(uriString: String): java.io.InputStream {
    return if (uriString.startsWith("content://")) {
      context.contentResolver.openInputStream(android.net.Uri.parse(uriString))
        ?: throw RuntimeException("openInputStream_returned_null: $uriString")
    } else if (uriString.startsWith("file://")) {
      File(uriString.removePrefix("file://")).inputStream()
    } else {
      File(uriString).inputStream()
    }
  }

  private fun File.asRequestBody(mt: String) = okhttp3.RequestBody.create(
    mt.toMediaTypeOrNull(),
    this
  )
}
