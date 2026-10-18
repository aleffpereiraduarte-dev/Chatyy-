package expo.modules.chatyymessagelist

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.LruCache
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.Future
import kotlin.math.max

// [2026-10-18 vthumb, apiVersion 9] 1º frame de vídeo que chegou SEM pôster
// (thumbnail_url/thumb_b64 vazios). O JS manda media.vf (URL http(s) ou file://)
// só nesse caso; o slot mantém o cinza + play e faz fade do frame quando chega.
//   • MediaMetadataRetriever num executor de 2 threads (nunca na main);
//   • memória: LruCache (24 MB); disco: cacheDir/chatyy-video-frames/<sha1>.jpg;
//   • cancel(url) tira da fila o que ainda não começou (reuso de célula);
//   • falha / 20 s sem resposta → cacheada por 10 min.
object MLVideoFrames {
  private val main = Handler(Looper.getMainLooper())
  private val pool = Executors.newFixedThreadPool(2) { r ->
    val t = Thread(r, "chatyy-vframe")
    t.isDaemon = true
    t.priority = Thread.MIN_PRIORITY + 1
    t
  }
  private val memory = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
    override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
  }
  // Estado abaixo: SÓ na main.
  private val waiters = HashMap<String, MutableList<(Bitmap?) -> Unit>>()
  private val interest = HashMap<String, Int>()
  private val futures = HashMap<String, Future<*>>()
  private val failedAt = HashMap<String, Long>()

  fun cached(url: String): Bitmap? = if (url.isEmpty()) null else memory.get(url)

  /** cb SEMPRE na main (null = falhou). Chamar na main. */
  fun load(ctx: Context, url: String, maxPx: Int, cb: (Bitmap?) -> Unit) {
    if (url.isEmpty()) { cb(null); return }
    val hit = memory.get(url)
    if (hit != null) { cb(hit); return }
    val f = failedAt[url]
    if (f != null && SystemClock.uptimeMillis() - f < 600_000L) { cb(null); return }
    interest[url] = (interest[url] ?: 0) + 1
    val list = waiters[url]
    if (list != null) { list.add(cb); return }
    waiters[url] = mutableListOf(cb)
    val dir = File(ctx.applicationContext.cacheDir, "chatyy-video-frames")
    val px = maxPx.coerceIn(96, 1280)
    val job = pool.submit(Runnable {
      var bmp: Bitmap? = null
      try {
        bmp = fromDisk(dir, url, px)
        if (bmp == null) {
          bmp = extract(url, px)
          val b = bmp
          if (b != null) toDisk(dir, url, b)
        }
      } catch (_: Throwable) {
        bmp = null
      }
      val result = bmp
      main.post { finish(url, result) }
    })
    futures[url] = job
    main.postDelayed({
      if (futures[url] === job) finish(url, null)
    }, 20_000L)
  }

  /** A célula desistiu (reuso / outra linha). Chamar na main. */
  fun cancel(url: String) {
    if (url.isEmpty()) return
    val n = interest[url] ?: return
    if (n > 1) { interest[url] = n - 1; return }
    interest.remove(url)
    val fu = futures[url] ?: return
    if (fu.cancel(false)) {
      futures.remove(url)
      waiters.remove(url)
    }
  }

  private fun finish(url: String, bmp: Bitmap?) {
    futures.remove(url)
    interest.remove(url)
    if (bmp != null) {
      memory.put(url, bmp)
      failedAt.remove(url)
    } else {
      failedAt[url] = SystemClock.uptimeMillis()
      if (failedAt.size > 500) failedAt.clear()
    }
    val list = waiters.remove(url) ?: return
    for (cb in list) {
      try { cb(bmp) } catch (_: Throwable) {}
    }
  }

  private fun extract(url: String, px: Int): Bitmap? {
    val mmr = MediaMetadataRetriever()
    try {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        mmr.setDataSource(url, HashMap<String, String>())
      } else {
        val path = if (url.startsWith("file://")) (Uri.parse(url).path ?: url.removePrefix("file://")) else url
        mmr.setDataSource(path)
      }
      var raw: Bitmap? = null
      if (Build.VERSION.SDK_INT >= 27) {
        raw = try { mmr.getScaledFrameAtTime(500_000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, px, px) } catch (_: Throwable) { null }
        if (raw == null) {
          raw = try { mmr.getScaledFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, px, px) } catch (_: Throwable) { null }
        }
      }
      if (raw == null) {
        raw = try { mmr.getFrameAtTime(500_000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC) } catch (_: Throwable) { null }
      }
      if (raw == null) {
        raw = try { mmr.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC) } catch (_: Throwable) { null }
      }
      val b = raw ?: return null
      return scaleDown(b, px)
    } catch (_: Throwable) {
      return null
    } finally {
      try { mmr.release() } catch (_: Throwable) {}
    }
  }

  private fun scaleDown(b: Bitmap, px: Int): Bitmap {
    val big = max(b.width, b.height)
    if (big <= px || big <= 0) return b
    val k = px.toFloat() / big.toFloat()
    val w = (b.width * k).toInt().coerceAtLeast(1)
    val h = (b.height * k).toInt().coerceAtLeast(1)
    val out = Bitmap.createScaledBitmap(b, w, h, true)
    if (out !== b) {
      try { b.recycle() } catch (_: Throwable) {}
    }
    return out
  }

  private fun fileFor(dir: File, url: String): File {
    val md = MessageDigest.getInstance("SHA-1")
    val hex = md.digest(url.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    return File(dir, "$hex.jpg")
  }

  private fun fromDisk(dir: File, url: String, px: Int): Bitmap? {
    val f = fileFor(dir, url)
    if (!f.isFile) return null
    val bounds = BitmapFactory.Options()
    bounds.inJustDecodeBounds = true
    BitmapFactory.decodeFile(f.path, bounds)
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= px) sample *= 2
    val opts = BitmapFactory.Options()
    opts.inSampleSize = sample
    return BitmapFactory.decodeFile(f.path, opts)
  }

  private fun toDisk(dir: File, url: String, b: Bitmap) {
    try {
      if (!dir.isDirectory) dir.mkdirs()
      val f = fileFor(dir, url)
      val tmp = File(dir, f.name + ".tmp")
      FileOutputStream(tmp).use { fos -> b.compress(Bitmap.CompressFormat.JPEG, 82, fos) }
      if (!tmp.renameTo(f)) tmp.delete()
    } catch (_: Throwable) {}
  }
}
