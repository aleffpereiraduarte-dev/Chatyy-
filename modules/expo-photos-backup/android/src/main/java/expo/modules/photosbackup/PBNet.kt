package expo.modules.photosbackup

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import okio.source
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

// [2026-10-15 photos-native] HTTP do backup: JSON nas actions do email.php
// (Bearer da conta) + PUT streaming p/ a URL pré-assinada do R2.
internal object PBNet {
  val client: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(60, TimeUnit.SECONDS)
      .writeTimeout(120, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .build()
  }

  class HttpResult(val code: Int, val json: JSONObject?)

  /** Await cancelável: cancelar a coroutine (Worker parado/conta trocada) cancela o Call. */
  suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        if (!cont.isCancelled) cont.resumeWithException(e)
      }
      override fun onResponse(call: Call, response: Response) {
        cont.resume(response)
      }
    })
    cont.invokeOnCancellation { try { cancel() } catch (_: Throwable) {} }
  }

  private fun origin(base: String): String = base.trim().trimEnd('/').removeSuffix("/api/email.php").removeSuffix("/api")

  /** POST JSON em {base}/api/email.php?action=X. code=-1 → erro de rede. */
  suspend fun postAction(base: String, token: String, action: String, body: JSONObject): HttpResult {
    val req = Request.Builder()
      .url(origin(base) + "/api/email.php?action=" + action)
      .header("Authorization", "Bearer $token")
      .header("Accept", "application/json")
      .post(body.toString().toRequestBody("application/json".toMediaTypeOrNull()))
      .build()
    return try {
      client.newCall(req).await().use { r ->
        val txt = r.body?.string() ?: ""
        val j = try { if (txt.isNotEmpty()) JSONObject(txt) else null } catch (_: Exception) { null }
        HttpResult(r.code, j)
      }
    } catch (e: IOException) {
      HttpResult(-1, null)
    }
  }

  /** Igual a postAction, mas em rede/5xx tenta UMA vez o fallbackBase. */
  suspend fun postWithFallback(prefs: PBPrefs, action: String, body: JSONObject): HttpResult {
    val r = postAction(prefs.apiBase, prefs.token, action, body)
    val fb = prefs.fallbackBase
    if ((r.code == -1 || r.code >= 500) && fb.isNotEmpty() && origin(fb) != origin(prefs.apiBase)) {
      return postAction(fb, prefs.token, action, body)
    }
    return r
  }

  /** Corpo streaming de um InputStream com tamanho conhecido (sem carregar na RAM). */
  class StreamBody(
    private val mime: String,
    private val length: Long,
    private val open: () -> InputStream,
    private val onBytes: (Long) -> Unit
  ) : RequestBody() {
    override fun contentType(): MediaType? = mime.toMediaTypeOrNull()
    override fun contentLength(): Long = length
    override fun writeTo(sink: BufferedSink) {
      open().use { input ->
        val src = input.source()
        var total = 0L
        while (true) {
          val n = src.read(sink.buffer, 256 * 1024L)
          if (n == -1L) break
          total += n
          sink.emitCompleteSegments()
          onBytes(n)
        }
        if (total != length) throw IOException("size_changed $total != $length")
      }
    }
  }

  /** PUT pré-assinado. Devolve o status HTTP (-1 = rede). */
  suspend fun put(url: String, mime: String, length: Long, open: () -> InputStream, onBytes: (Long) -> Unit): Int {
    val req = Request.Builder()
      .url(url)
      .header("Content-Type", mime)
      .put(StreamBody(mime, length, open, onBytes))
      .build()
    val c = client.newBuilder().writeTimeout(10, TimeUnit.MINUTES).readTimeout(5, TimeUnit.MINUTES).build()
    return try {
      c.newCall(req).await().use { it.code }
    } catch (e: IOException) {
      -1
    }
  }
}
