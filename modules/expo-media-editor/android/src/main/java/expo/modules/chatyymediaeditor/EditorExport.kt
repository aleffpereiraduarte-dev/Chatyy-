package expo.modules.chatyymediaeditor

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.media.ExifInterface
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import android.os.Build
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** [2026-10-15 native-editor] Decodificação, exportação de foto e remux de vídeo. */
object EditorExport {
  private const val TAG = "ChatyyMediaEditor"

  private fun open(ctx: Context, uri: String): InputStream? {
    val u = Uri.parse(uri)
    return when (u.scheme) {
      "content", "android.resource" -> ctx.contentResolver.openInputStream(u)
      "file" -> File(u.path ?: return null).inputStream()
      null -> File(uri).inputStream()
      else -> null
    }
  }

  private fun exifOrientation(ctx: Context, uri: String): Int {
    return try {
      open(ctx, uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
        ?: ExifInterface.ORIENTATION_NORMAL
    } catch (_: Throwable) { ExifInterface.ORIENTATION_NORMAL }
  }

  /** Tamanho já com EXIF aplicado (largura, altura). */
  fun imageSize(ctx: Context, uri: String): Pair<Int, Int>? {
    val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    try { open(ctx, uri)?.use { BitmapFactory.decodeStream(it, null, o) } } catch (_: Throwable) { return null }
    if (o.outWidth <= 0 || o.outHeight <= 0) return null
    val ori = exifOrientation(ctx, uri)
    val swap = ori == ExifInterface.ORIENTATION_ROTATE_90 || ori == ExifInterface.ORIENTATION_ROTATE_270 ||
      ori == ExifInterface.ORIENTATION_TRANSPOSE || ori == ExifInterface.ORIENTATION_TRANSVERSE
    return if (swap) Pair(o.outHeight, o.outWidth) else Pair(o.outWidth, o.outHeight)
  }

  /** Decodifica com lado maior ≤ maxDim e orientação EXIF aplicada. */
  fun decode(ctx: Context, uri: String, maxDim: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    try { open(ctx, uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } } catch (_: Throwable) { return null }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    val longSide = max(bounds.outWidth, bounds.outHeight)
    while (longSide / (sample * 2) >= maxDim) sample *= 2
    val opts = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    var bm = try { open(ctx, uri)?.use { BitmapFactory.decodeStream(it, null, opts) } } catch (t: Throwable) {
      Log.w(TAG, "decode failed: ${t.message}"); null
    } ?: return null
    // reduz ao teto exato
    val ls = max(bm.width, bm.height)
    if (ls > maxDim) {
      val k = maxDim.toFloat() / ls
      val scaled = Bitmap.createScaledBitmap(bm, max(1, (bm.width * k).roundToInt()), max(1, (bm.height * k).roundToInt()), true)
      if (scaled !== bm) bm.recycle()
      bm = scaled
    }
    val ori = exifOrientation(ctx, uri)
    val m = Matrix()
    when (ori) {
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

  /** Matriz que leva a imagem original ao espaço girado q×90° (horário). */
  fun rotationMatrix(w: Int, h: Int, q: Int): Matrix {
    val m = Matrix()
    when (((q % 4) + 4) % 4) {
      1 -> { m.postRotate(90f); m.postTranslate(h.toFloat(), 0f) }
      2 -> { m.postRotate(180f); m.postTranslate(w.toFloat(), h.toFloat()) }
      3 -> { m.postRotate(270f); m.postTranslate(0f, w.toFloat()) }
    }
    return m
  }

  fun rotated(b: Bitmap, q: Int): Bitmap {
    val qq = ((q % 4) + 4) % 4
    if (qq == 0) return b
    val m = Matrix()
    m.postRotate(90f * qq)
    return Bitmap.createBitmap(b, 0, 0, b.width, b.height, m, true)
  }

  fun saveJpeg(b: Bitmap, file: File, quality: Int): Boolean {
    return try {
      FileOutputStream(file).use { b.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(40, 100), it) }
      file.exists() && file.length() > 0
    } catch (t: Throwable) {
      Log.w(TAG, "saveJpeg failed: ${t.message}")
      false
    }
  }

  class PhotoOut(val uri: String, val width: Int, val height: Int, val size: Long)

  /** Aplica giro → recorte → filtro → traços/objetos e grava JPEG. */
  fun renderPhoto(ctx: Context, src: String, st: MEState, filter: FloatArray?, maxDim: Int, quality: Int): PhotoOut? {
    val base = decode(ctx, src, maxDim) ?: return null
    try {
      val q = ((st.rotQ % 4) + 4) % 4
      val rw = if (q % 2 == 1) base.height else base.width
      val rh = if (q % 2 == 1) base.width else base.height
      val c = st.crop
      val cl = (c.left.coerceIn(0f, 1f) * rw).roundToInt()
      val ct = (c.top.coerceIn(0f, 1f) * rh).roundToInt()
      val cr = (c.right.coerceIn(0f, 1f) * rw).roundToInt()
      val cb = (c.bottom.coerceIn(0f, 1f) * rh).roundToInt()
      val ow = max(1, cr - cl)
      val oh = max(1, cb - ct)
      val out = Bitmap.createBitmap(ow, oh, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(out)
      canvas.drawColor(Color.BLACK)
      val m = rotationMatrix(base.width, base.height, q)
      m.postTranslate(-cl.toFloat(), -ct.toFloat())
      val p = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
      if (filter != null) p.colorFilter = ColorMatrixColorFilter(ColorMatrix(filter))
      canvas.drawBitmap(base, m, p)
      base.recycle()
      val fx = -cl.toFloat()
      val fy = -ct.toFloat()
      val short = min(rw, rh).toFloat()
      val sp = MEDraw.strokePaint()
      for (s in st.strokes) MEDraw.drawStroke(canvas, s, fx, fy, rw.toFloat(), rh.toFloat(), short, sp)
      for (o in st.objs) MEDraw.drawObj(canvas, o, fx + o.u * rw, fy + o.v * rh, short)
      val f = File(ctx.cacheDir, "edit_${System.currentTimeMillis()}.jpg")
      val ok = saveJpeg(out, f, quality)
      out.recycle()
      if (!ok) return null
      return PhotoOut("file://${f.absolutePath}", ow, oh, f.length())
    } catch (oom: OutOfMemoryError) {
      Log.w(TAG, "renderPhoto OOM @ $maxDim")
      try { if (!base.isRecycled) base.recycle() } catch (_: Throwable) {}
      return if (maxDim > 1600) renderPhoto(ctx, src, st, filter, 1600, quality) else null
    } catch (t: Throwable) {
      Log.w(TAG, "renderPhoto failed: ${t.message}")
      try { if (!base.isRecycled) base.recycle() } catch (_: Throwable) {}
      return null
    }
  }

  // ─── vídeo ────────────────────────────────────────────────────────────────

  fun retriever(ctx: Context, uri: String): MediaMetadataRetriever? {
    val mmr = MediaMetadataRetriever()
    return try {
      val u = Uri.parse(uri)
      when (u.scheme) {
        "content" -> mmr.setDataSource(ctx, u)
        "file", null -> mmr.setDataSource(u.path ?: uri)
        else -> mmr.setDataSource(uri, HashMap())
      }
      mmr
    } catch (t: Throwable) {
      try { mmr.release() } catch (_: Throwable) {}
      null
    }
  }

  class VideoInfo(val durationMs: Long, val width: Int, val height: Int, val rotation: Int, val hasAudio: Boolean)

  fun videoInfo(ctx: Context, uri: String): VideoInfo? {
    val mmr = retriever(ctx, uri) ?: return null
    try {
      val dur = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      val w = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val h = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val rot = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      val audio = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes"
      val sw = if (rot == 90 || rot == 270) h else w
      val sh = if (rot == 90 || rot == 270) w else h
      return VideoInfo(dur, sw, sh, rot, audio)
    } catch (_: Throwable) {
      return null
    } finally {
      try { mmr.release() } catch (_: Throwable) {}
    }
  }

  fun frameAt(mmr: MediaMetadataRetriever, ms: Long, maxDim: Int, exact: Boolean): Bitmap? {
    val opt = if (exact) MediaMetadataRetriever.OPTION_CLOSEST else MediaMetadataRetriever.OPTION_CLOSEST_SYNC
    return try {
      val b = if (Build.VERSION.SDK_INT >= 27) {
        mmr.getScaledFrameAtTime(ms * 1000L, opt, maxDim, maxDim)
      } else {
        mmr.getFrameAtTime(ms * 1000L, opt)
      } ?: return null
      val ls = max(b.width, b.height)
      if (ls > maxDim * 1.2f) {
        val k = maxDim.toFloat() / ls
        val s = Bitmap.createScaledBitmap(b, max(1, (b.width * k).toInt()), max(1, (b.height * k).toInt()), true)
        if (s !== b) b.recycle()
        s
      } else b
    } catch (_: Throwable) { null }
  }

  class VideoOut(val uri: String, val durationMs: Long, val size: Long)

  /**
   * Corta [startMs, endMs) e/ou tira o áudio SEM re-encode (MediaExtractor →
   * MediaMuxer). O início cai no keyframe anterior (igual ao trimVideo do
   * expo-native-video). Retorna null em falha → JS envia o original.
   */
  fun remux(ctx: Context, srcUri: String, startMs: Long, endMs: Long, muted: Boolean, rotation: Int): VideoOut? {
    var extractor: MediaExtractor? = null
    var muxer: MediaMuxer? = null
    val outFile = File(ctx.cacheDir, "edit_${System.currentTimeMillis()}.mp4")
    var started = false
    try {
      extractor = MediaExtractor()
      val u = Uri.parse(srcUri)
      when (u.scheme) {
        "content" -> extractor.setDataSource(ctx, u, null)
        "file", null -> extractor.setDataSource(u.path ?: srcUri)
        else -> extractor.setDataSource(srcUri)
      }
      muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val map = HashMap<Int, Int>()
      var maxIn = 0
      var hasVideo = false
      for (i in 0 until extractor.trackCount) {
        val fmt = extractor.getTrackFormat(i)
        val mime = fmt.getString(MediaFormat.KEY_MIME) ?: continue
        val isVideo = mime.startsWith("video/")
        val isAudio = mime.startsWith("audio/")
        if (!isVideo && !(isAudio && !muted)) continue
        if (isVideo) hasVideo = true
        extractor.selectTrack(i)
        map[i] = muxer.addTrack(fmt)
        if (fmt.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) maxIn = max(maxIn, fmt.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
      }
      if (!hasVideo) { try { muxer.release() } catch (_: Throwable) {}; muxer = null; outFile.delete(); return null }
      if (rotation != 0) try { muxer.setOrientationHint(rotation) } catch (_: Throwable) {}
      muxer.start()
      started = true
      val buf = ByteBuffer.allocate(if (maxIn > 0) maxIn else 2 shl 20)
      val info = MediaCodec.BufferInfo()
      val startUs = max(0L, startMs) * 1000L
      val endUs = if (endMs > 0) endMs * 1000L else Long.MAX_VALUE
      extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
      var baseUs = -1L
      var lastUs = 0L
      while (true) {
        info.offset = 0
        info.size = extractor.readSampleData(buf, 0)
        if (info.size < 0) break
        val t = extractor.sampleTime
        if (t < 0 || t >= endUs) break
        val dst = map[extractor.sampleTrackIndex]
        if (dst != null) {
          if (baseUs < 0) baseUs = t
          info.presentationTimeUs = max(0L, t - baseUs)
          info.flags = if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
          muxer.writeSampleData(dst, buf, info)
          if (info.presentationTimeUs > lastUs) lastUs = info.presentationTimeUs
        }
        extractor.advance()
      }
      try { muxer.stop() } catch (_: Throwable) {}
      started = false
      if (lastUs <= 0 || !outFile.exists() || outFile.length() <= 0) { outFile.delete(); return null }
      return VideoOut("file://${outFile.absolutePath}", lastUs / 1000L, outFile.length())
    } catch (t: Throwable) {
      Log.w(TAG, "remux failed: ${t.message}")
      try { outFile.delete() } catch (_: Throwable) {}
      return null
    } finally {
      if (started) try { muxer?.stop() } catch (_: Throwable) {}
      try { muxer?.release() } catch (_: Throwable) {}
      try { extractor?.release() } catch (_: Throwable) {}
    }
  }
}
