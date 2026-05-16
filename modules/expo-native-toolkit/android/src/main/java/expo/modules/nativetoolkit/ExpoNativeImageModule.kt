package expo.modules.nativetoolkit

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID

/**
 * ExpoNativeImageModule — Android port (2026-05-16).
 *
 * Mirrors the iOS Swift Core Image module. The whole motivation is that
 * expo-image-manipulator JPEG-encodes via JavaScript-controlled native bridges,
 * which on a 4032 × 3024 photo takes 6–10 s of CPU + bridge round-trips. Going
 * direct to BitmapFactory + Bitmap.compress lands the same output in ~600 ms.
 *
 * All AsyncFunctions hop onto Dispatchers.IO so the JS thread never blocks on
 * Bitmap decode (which can hold the thread for hundreds of ms even for small
 * images on cold JIT).
 *
 * EXIF stripping: Bitmap.compress(JPEG, ...) drops EXIF by default, so we get
 * privacy-friendly output for free. The iOS path also strips EXIF (it draws
 * into a fresh UIGraphicsImageRenderer context).
 */
class ExpoNativeImageModule : Module() {

  companion object {
    private const val TAG = "ExpoNativeImage"
    private const val DEFAULT_QUALITY = 85
  }

  private val ctx: Context get() = appContext.reactContext!!

  override fun definition() = ModuleDefinition {
    Name("ExpoNativeImage")

    // resize: matches the iOS contract — accepts maxWidth/maxHeight (either or
    // both), preserves aspect ratio by scaling by `min(maxW/w, maxH/h)`, and
    // returns { uri, width, height, sizeBytes }.
    AsyncFunction("resize") { input: Map<String, Any?> ->
      runBlocking {
        withContext(Dispatchers.IO) { resizeInternal(input) }
      }
    }

    AsyncFunction("videoThumbnail") { input: Map<String, Any?> ->
      runBlocking {
        withContext(Dispatchers.IO) { videoThumbnailInternal(input) }
      }
    }

    // Quick header-only dimensions read. inJustDecodeBounds = true means
    // BitmapFactory parses the JPEG/PNG header (typically < 4 KB) and skips
    // the pixel decode entirely.
    AsyncFunction("getDimensions") { srcUri: String ->
      runBlocking {
        withContext(Dispatchers.IO) {
          val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
          openInput(srcUri).use { BitmapFactory.decodeStream(it, null, opts) }
          mapOf(
            "width" to opts.outWidth,
            "height" to opts.outHeight,
            "mimeType" to (opts.outMimeType ?: "")
          )
        }
      }
    }

    // applyFilter — Android Bitmap has no built-in CIFilter equivalent, but
    // we mirror the iOS shape so JS doesn't need a Platform.OS branch. For
    // now this is a no-op pass-through that copies the bitmap so callers get
    // a usable file:// URI back; richer filtering can be added with
    // RenderScript later if needed.
    AsyncFunction("applyFilter") { input: Map<String, Any?> ->
      runBlocking {
        withContext(Dispatchers.IO) {
          val uri = (input["uri"] as? String) ?: throw IllegalArgumentException("uri required")
          val bmp = openInput(uri).use { BitmapFactory.decodeStream(it) }
            ?: throw RuntimeException("decode_failed: $uri")
          val outFile = File(ctx.cacheDir, "filtered_${UUID.randomUUID()}.jpg")
          FileOutputStream(outFile).use { fos ->
            bmp.compress(Bitmap.CompressFormat.JPEG, 90, fos)
          }
          bmp.recycle()
          mapOf("uri" to "file://${outFile.absolutePath}")
        }
      }
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private fun resizeInternal(input: Map<String, Any?>): Map<String, Any> {
    val uri = (input["uri"] as? String) ?: throw IllegalArgumentException("uri required")
    val maxW = (input["maxWidth"] as? Number)?.toInt()
    val maxH = (input["maxHeight"] as? Number)?.toInt()
    val quality = ((input["quality"] as? Number)?.toDouble() ?: 0.85).let {
      // iOS sends 0..1; we accept that and also accept 1..100 (legacy callers).
      if (it <= 1.0) (it * 100).toInt().coerceIn(1, 100) else it.toInt().coerceIn(1, 100)
    }
    val format = (input["format"] as? String) ?: "jpeg"

    // Phase 1: bounds-only decode to pick inSampleSize without paying for pixels.
    val boundsOpts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    openInput(uri).use { BitmapFactory.decodeStream(it, null, boundsOpts) }
    val srcW = boundsOpts.outWidth
    val srcH = boundsOpts.outHeight
    if (srcW <= 0 || srcH <= 0) {
      throw RuntimeException("resize_decode_failed: bounds=$srcW x $srcH for $uri")
    }

    // Compute target dims matching the iOS scale logic: scale = min(maxW/w, maxH/h, 1).
    val scaleW = if (maxW != null && srcW > maxW) maxW.toDouble() / srcW else 1.0
    val scaleH = if (maxH != null && srcH > maxH) maxH.toDouble() / srcH else 1.0
    val scale = minOf(scaleW, scaleH, 1.0)
    val targetW = (srcW * scale).toInt().coerceAtLeast(1)
    val targetH = (srcH * scale).toInt().coerceAtLeast(1)

    // Pick inSampleSize so the intermediate bitmap is ~2× target (keeps quality
    // for the final createScaledBitmap pass without burning memory on a full
    // decode for a thumbnail).
    val longestTarget = maxOf(targetW, targetH).coerceAtLeast(64)
    var sample = 1
    while ((srcW / sample) > longestTarget * 2 || (srcH / sample) > longestTarget * 2) {
      sample *= 2
    }

    // Phase 2: full decode at chosen subsample. ARGB_8888 avoids RGB_565
    // skin-tone banding observed in QA on Pixel hardware.
    val decodeOpts = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val raw: Bitmap = openInput(uri).use {
      BitmapFactory.decodeStream(it, null, decodeOpts)
    } ?: throw RuntimeException("resize_decode_returned_null: $uri")

    // Phase 3: final scale to exact target dims.
    val finalBmp = if (raw.width != targetW || raw.height != targetH) {
      val scaled = Bitmap.createScaledBitmap(raw, targetW, targetH, true)
      if (scaled !== raw) raw.recycle()
      scaled
    } else raw

    val ext = when (format) { "png" -> "png"; "webp" -> "webp"; else -> "jpg" }
    val outFile = File(ctx.cacheDir, "img_${UUID.randomUUID()}.$ext")
    val compressFmt = when (format) {
      "png" -> Bitmap.CompressFormat.PNG
      "webp" -> @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
      else -> Bitmap.CompressFormat.JPEG
    }
    FileOutputStream(outFile).use { fos ->
      finalBmp.compress(compressFmt, quality, fos)
    }
    val outW = finalBmp.width
    val outH = finalBmp.height
    finalBmp.recycle()

    val size = outFile.length()
    return mapOf(
      "uri" to "file://${outFile.absolutePath}",
      "width" to outW,
      "height" to outH,
      "sizeBytes" to size
    )
  }

  private fun videoThumbnailInternal(input: Map<String, Any?>): Map<String, Any> {
    val uri = (input["uri"] as? String) ?: throw IllegalArgumentException("uri required")
    val timeSec = (input["timeSec"] as? Number)?.toDouble() ?: 0.0
    val atMs = (input["atMs"] as? Number)?.toLong() ?: (timeSec * 1000).toLong()
    val maxDim = (input["maxWidth"] as? Number)?.toInt()

    val retriever = MediaMetadataRetriever()
    try {
      val cleaned = uri.removePrefix("file://")
      if (cleaned.startsWith("content://") || cleaned.startsWith("http")) {
        retriever.setDataSource(ctx, Uri.parse(cleaned))
      } else {
        retriever.setDataSource(cleaned)
      }
      // OPTION_CLOSEST_SYNC returns the nearest keyframe — much faster than
      // OPTION_CLOSEST, which decodes from the previous keyframe forward.
      val frame = retriever.getFrameAtTime(atMs * 1000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        ?: throw RuntimeException("video_thumbnail_no_frame: $uri")

      val outBmp = if (maxDim != null && (frame.width > maxDim || frame.height > maxDim)) {
        val s = maxDim.toFloat() / maxOf(frame.width, frame.height).toFloat()
        val w = (frame.width * s).toInt().coerceAtLeast(1)
        val h = (frame.height * s).toInt().coerceAtLeast(1)
        val scaled = Bitmap.createScaledBitmap(frame, w, h, true)
        if (scaled !== frame) frame.recycle()
        scaled
      } else frame

      val outFile = File(ctx.cacheDir, "thumb_${UUID.randomUUID()}.jpg")
      FileOutputStream(outFile).use { fos ->
        outBmp.compress(Bitmap.CompressFormat.JPEG, 85, fos)
      }
      val w = outBmp.width
      val h = outBmp.height
      outBmp.recycle()
      return mapOf(
        "uri" to "file://${outFile.absolutePath}",
        "width" to w,
        "height" to h
      )
    } finally {
      try { retriever.release() } catch (t: Throwable) { Log.v(TAG, "retriever.release: ${t.message}") }
    }
  }

  private fun openInput(uriString: String): InputStream {
    return if (uriString.startsWith("content://")) {
      ctx.contentResolver.openInputStream(Uri.parse(uriString))
        ?: throw RuntimeException("openInputStream_returned_null: $uriString")
    } else if (uriString.startsWith("file://")) {
      File(uriString.removePrefix("file://")).inputStream()
    } else {
      File(uriString).inputStream()
    }
  }
}
