package expo.modules.chatyystatusstudio

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.LruCache
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

object SSNet {
  private val main = Handler(Looper.getMainLooper())
  private val cache = LruCache<String, Bitmap>(40)

  /** Capa de música etc. (sem dependência nova: HttpURLConnection). */
  fun loadBitmap(url: String, maxPx: Int, cb: (Bitmap?) -> Unit) {
    cache.get(url)?.let { cb(it); return }
    Thread {
      var b: Bitmap? = null
      try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 8000
        c.readTimeout = 8000
        c.inputStream.use { ins ->
          val raw = BitmapFactory.decodeStream(ins)
          if (raw != null) {
            val k = maxPx.toFloat() / max(raw.width, raw.height)
            b = if (k < 1f) Bitmap.createScaledBitmap(raw, max(1, (raw.width * k).toInt()), max(1, (raw.height * k).toInt()), true) else raw
          }
        }
        c.disconnect()
      } catch (_: Throwable) {}
      val out = b
      if (out != null) cache.put(url, out)
      main.post { cb(out) }
    }.start()
  }
}

object SSExport {
  private const val TAG = "ChatyyStatusStudio"

  fun open(ctx: Context, uri: String): InputStream? {
    val u = Uri.parse(uri)
    return when (u.scheme) {
      "content", "android.resource" -> ctx.contentResolver.openInputStream(u)
      "file" -> File(u.path ?: return null).inputStream()
      null -> File(uri).inputStream()
      else -> null
    }
  }

  private fun exifOrientation(ctx: Context, uri: String): Int = try {
    open(ctx, uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
      ?: ExifInterface.ORIENTATION_NORMAL
  } catch (_: Throwable) { ExifInterface.ORIENTATION_NORMAL }

  /** Decodifica com EXIF aplicado, lado maior ≤ maxDim. */
  /**
   * [2026-10-18 status-telegram] Ferramenta Cortar: giro horário (múltiplo de 90)
   * + recorte central na proporção w/h (0 = mantém). Sem mudança → o próprio bm.
   */
  fun edited(bm: Bitmap, rotate: Int, aspect: Float): Bitmap {
    val r = ((rotate % 360) + 360) % 360
    if (r == 0 && aspect <= 0f) return bm
    return try {
      var src = bm
      if (r != 0) {
        val m = Matrix()
        m.postRotate(r.toFloat())
        src = Bitmap.createBitmap(bm, 0, 0, bm.width, bm.height, m, true)
      }
      if (aspect > 0f && src.width > 0 && src.height > 0) {
        val cur = src.width.toFloat() / src.height
        var w = src.width
        var h = src.height
        if (cur > aspect) w = max(1, min(src.width, (src.height * aspect).roundToInt()))
        else h = max(1, min(src.height, (src.width / aspect).roundToInt()))
        if (w != src.width || h != src.height) {
          val c = Bitmap.createBitmap(src, (src.width - w) / 2, (src.height - h) / 2, w, h)
          if (src !== bm && c !== src) src.recycle()
          src = c
        }
      }
      src
    } catch (t: Throwable) {
      Log.w(TAG, "edited: ${t.message}"); bm
    }
  }

  fun decode(ctx: Context, uri: String, maxDim: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    try { open(ctx, uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } } catch (_: Throwable) { return null }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    val longSide = max(bounds.outWidth, bounds.outHeight)
    while (longSide / (sample * 2) >= maxDim) sample *= 2
    val o = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
    var bm = try { open(ctx, uri)?.use { BitmapFactory.decodeStream(it, null, o) } } catch (t: Throwable) {
      Log.w(TAG, "decode: ${t.message}"); null
    } ?: return null
    val ls = max(bm.width, bm.height)
    if (ls > maxDim) {
      val k = maxDim.toFloat() / ls
      val sc = Bitmap.createScaledBitmap(bm, max(1, (bm.width * k).roundToInt()), max(1, (bm.height * k).roundToInt()), true)
      if (sc !== bm) bm.recycle()
      bm = sc
    }
    val m = Matrix()
    when (exifOrientation(ctx, uri)) {
      ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
      else -> return bm
    }
    val out = Bitmap.createBitmap(bm, 0, 0, bm.width, bm.height, m, true)
    if (out !== bm) bm.recycle()
    return out
  }

  fun videoFrame(ctx: Context, uri: String, maxPx: Int): Bitmap? {
    val r = MediaMetadataRetriever()
    return try {
      val u = Uri.parse(uri)
      if (u.scheme == "content") r.setDataSource(ctx, u) else r.setDataSource(u.path ?: uri)
      val f = r.getFrameAtTime(0) ?: return null
      val k = maxPx.toFloat() / max(f.width, f.height)
      if (k < 1f) Bitmap.createScaledBitmap(f, max(1, (f.width * k).toInt()), max(1, (f.height * k).toInt()), true) else f
    } catch (_: Throwable) { null } finally { try { r.release() } catch (_: Throwable) {} }
  }

  /** Fundo do palco: média da foto ×0.42 (stageBackground do statusFilters.js). */
  fun stageBackground(b: Bitmap?): Int {
    if (b == null) return Color.rgb(11, 11, 11)
    return try {
      val s = Bitmap.createScaledBitmap(b, 16, 16, true)
      var r = 0L; var g = 0L; var bl = 0L
      for (y in 0 until 16) for (x in 0 until 16) {
        val c = s.getPixel(x, y)
        r += Color.red(c); g += Color.green(c); bl += Color.blue(c)
      }
      if (s !== b) s.recycle()
      Color.rgb(((r / 256) * 0.42).toInt().coerceIn(0, 255), ((g / 256) * 0.42).toInt().coerceIn(0, 255), ((bl / 256) * 0.42).toInt().coerceIn(0, 255))
    } catch (_: Throwable) { Color.rgb(11, 11, 11) }
  }

  fun filtered(src: Bitmap, m: FloatArray?): Bitmap {
    if (m == null) return src
    val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
    val c = Canvas(out)
    val p = Paint(Paint.FILTER_BITMAP_FLAG)
    p.colorFilter = ColorMatrixColorFilter(ColorMatrix(m))
    c.drawBitmap(src, 0f, 0f, p)
    return out
  }

  /** Foto aspect-fit (com filtro) no retângulo w×h. */
  fun drawFit(c: Canvas, b: Bitmap, w: Float, h: Float, m: FloatArray?) {
    val k = min(w / b.width, h / b.height)
    val dw = b.width * k
    val dh = b.height * k
    val p = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    if (m != null) p.colorFilter = ColorMatrixColorFilter(ColorMatrix(m))
    c.drawBitmap(b, null, RectF((w - dw) / 2f, (h - dh) / 2f, (w + dw) / 2f, (h + dh) / 2f), p)
  }

  fun outFile(ctx: Context, ext: String): File {
    val dir = File(ctx.cacheDir, "status-studio")
    dir.mkdirs()
    // limpa exportações antigas (> 1 dia)
    try { dir.listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > 86_400_000L) it.delete() } } catch (_: Throwable) {}
    return File(dir, "st_${System.currentTimeMillis()}_${(Math.random() * 1e6).toInt()}.$ext")
  }

  fun saveJpeg(b: Bitmap, f: File, q: Int = 90): Boolean = try {
    FileOutputStream(f).use { b.compress(Bitmap.CompressFormat.JPEG, q, it) }
    true
  } catch (t: Throwable) { Log.w(TAG, "save: ${t.message}"); false }
}
