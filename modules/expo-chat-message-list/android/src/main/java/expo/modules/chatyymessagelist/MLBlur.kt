package expo.modules.chatyymessagelist

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt

// [2026-10-18 lqip] Miniatura (LQIP) da foto/vídeo com desfoque suave em vez
// de pixelada: reescala p/ 64 px e aplica box blur 3× (≈ gaussiano) fora da
// main. Resultado cacheado por URI da miniatura.
internal object MLBlur {
  private val cache = object : LruCache<String, Bitmap>(4 * 1024 * 1024) {
    override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
  }
  private val exec = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())

  fun cached(key: String): Bitmap? = if (key.isEmpty()) null else cache.get(key)

  /** src deve ser uma cópia só nossa (software). done roda na main. */
  fun blur(key: String, src: Bitmap, done: (Bitmap?) -> Unit) {
    exec.execute {
      val out = try { blurNow(src) } catch (_: Throwable) { null }
      if (out != null) cache.put(key, out)
      main.post { done(out) }
    }
  }

  private fun blurNow(src: Bitmap): Bitmap? {
    val side = max(src.width, src.height)
    if (side < 1) return null
    val s = 64f / side
    val w = max(1, (src.width * s).roundToInt())
    val h = max(1, (src.height * s).roundToInt())
    val scaled = Bitmap.createScaledBitmap(src, w, h, true)
    val px = IntArray(w * h)
    scaled.getPixels(px, 0, w, 0, 0, w, h)
    val tmp = IntArray(w * h)
    repeat(3) {
      boxH(px, tmp, w, h, 3)
      boxV(tmp, px, w, h, 3)
    }
    return Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
  }

  private fun boxH(src: IntArray, dst: IntArray, w: Int, h: Int, r: Int) {
    val n = 2 * r + 1
    for (y in 0 until h) {
      val row = y * w
      for (x in 0 until w) {
        var a = 0
        var cr = 0
        var cg = 0
        var cb = 0
        for (k in -r..r) {
          val c = src[row + (x + k).coerceIn(0, w - 1)]
          a += (c ushr 24) and 0xff
          cr += (c shr 16) and 0xff
          cg += (c shr 8) and 0xff
          cb += c and 0xff
        }
        dst[row + x] = ((a / n) shl 24) or ((cr / n) shl 16) or ((cg / n) shl 8) or (cb / n)
      }
    }
  }

  private fun boxV(src: IntArray, dst: IntArray, w: Int, h: Int, r: Int) {
    val n = 2 * r + 1
    for (y in 0 until h) {
      for (x in 0 until w) {
        var a = 0
        var cr = 0
        var cg = 0
        var cb = 0
        for (k in -r..r) {
          val c = src[(y + k).coerceIn(0, h - 1) * w + x]
          a += (c ushr 24) and 0xff
          cr += (c shr 16) and 0xff
          cg += (c shr 8) and 0xff
          cb += c and 0xff
        }
        dst[y * w + x] = ((a / n) shl 24) or ((cr / n) shl 16) or ((cg / n) shl 8) or (cb / n)
      }
    }
  }
}
