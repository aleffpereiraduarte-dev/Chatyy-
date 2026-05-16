package expo.modules.nativevideo

import android.graphics.Bitmap
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.io.FileOutputStream

/**
 * ExpoNativeVideoModule — Stage 1 (2026-05-16).
 *
 * Native helpers for the chat video upload pipeline. Three AsyncFunctions:
 *
 *   • getInfo(srcUri)              — duration, dimensions, mime, size.
 *                                    Trivial wrapper over MediaMetadataRetriever.
 *   • generateThumbnail(srcUri, atMs, maxDim)
 *                                  — JPEG frame at the requested timestamp,
 *                                    scaled to maxDim on the longest edge,
 *                                    written to cacheDir/<rand>.jpg.
 *   • compressVideo(srcUri, opts)  — Stage 1 ships a SAFE FALLBACK: we read
 *                                    the source's existing dimensions + bitrate
 *                                    via MediaMetadataRetriever; if it's
 *                                    already within the requested envelope we
 *                                    return the source URI unchanged.
 *                                    Otherwise we currently STILL return the
 *                                    source URI but with a clear log line —
 *                                    full MediaCodec H.264 transcode is a
 *                                    ~500 LOC native pipeline (EGL surface
 *                                    bridging decoder → encoder) and is
 *                                    deferred to Stage 2 rather than shipped
 *                                    half-working. iOS path (AVAssetExportSession)
 *                                    DOES compress today so iOS users get the
 *                                    real bandwidth win immediately; Android
 *                                    falls back to the existing "upload raw"
 *                                    behaviour.
 *
 * TODO(Stage 2): Implement the actual transcode in Kotlin. The plan is:
 *   1. MediaExtractor on src → identify video + audio tracks.
 *   2. MediaCodec.createDecoderByType(srcMime) feeding into an EGL Surface
 *      bound to MediaCodec.createEncoderByType("video/avc")'s input surface.
 *   3. The OpenGL pass scales the decoded frame to (maxWidth × maxHeight)
 *      preserving aspect, lets the encoder emit H.264 NAL units at
 *      `bitrate` bps with `fps` capped from the source.
 *   4. Audio track copied as-is when AAC; transcoded via a second MediaCodec
 *      pair when not.
 *   5. MediaMuxer (OutputFormat MP4) muxes both, writes to cache.
 * Reference: bigflake/grafika ExtractDecodeEditEncodeMuxTest.
 */
class ExpoNativeVideoModule : Module() {

  companion object {
    private const val TAG = "ExpoNativeVideo"
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoNativeVideo")

    AsyncFunction("getInfo") { srcUri: String ->
      return@AsyncFunction readInfo(srcUri)
    }

    AsyncFunction("generateThumbnail") { srcUri: String, atMs: Double, maxDim: Double ->
      return@AsyncFunction makeThumbnail(srcUri, atMs.toLong(), maxDim.toInt())
    }

    AsyncFunction("compressVideo") { srcUri: String, options: Map<String, Any?> ->
      return@AsyncFunction compress(srcUri, options)
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private fun openRetriever(srcUri: String): MediaMetadataRetriever {
    val mmr = MediaMetadataRetriever()
    try {
      val uri = Uri.parse(srcUri)
      if (uri.scheme == "file" || uri.scheme == null) {
        // Local file path. setDataSource(String) takes a filesystem path.
        val path = uri.path ?: srcUri
        mmr.setDataSource(path)
      } else if (uri.scheme == "content") {
        // content:// → SAF. Pass through Context resolver.
        mmr.setDataSource(appContext.reactContext!!, uri)
      } else {
        // http(s)://, rtsp:// etc — MediaMetadataRetriever supports remote
        // URLs via the (String, headers) overload, but our use-case is
        // always local capture so we treat anything else as the raw path
        // and let setDataSource throw if it's not.
        mmr.setDataSource(srcUri)
      }
    } catch (t: Throwable) {
      try { mmr.release() } catch (_: Throwable) {}
      throw CodedException("E_INFO_OPEN", "Cannot open video: ${t.message}", t)
    }
    return mmr
  }

  private fun readInfo(srcUri: String): Map<String, Any> {
    val mmr = openRetriever(srcUri)
    try {
      val durationMs = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      val width = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val height = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val mime = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE) ?: "video/mp4"
      // Rotation (90/180/270) on Android phones — swap w/h so the JS layer
      // sees the orientation the user actually filmed.
      val rotation = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      val (effW, effH) = if (rotation == 90 || rotation == 270) Pair(height, width) else Pair(width, height)
      val sizeBytes = try {
        val path = Uri.parse(srcUri).path
        if (path != null) File(path).length() else 0L
      } catch (_: Throwable) { 0L }

      return mapOf(
        "durationMs" to durationMs,
        "width" to effW,
        "height" to effH,
        "sizeBytes" to sizeBytes,
        "mimeType" to mime
      )
    } finally {
      try { mmr.release() } catch (_: Throwable) {}
    }
  }

  private fun makeThumbnail(srcUri: String, atMs: Long, maxDim: Int): Map<String, Any> {
    val mmr = openRetriever(srcUri)
    try {
      // getFrameAtTime takes microseconds and a hint about which frame to
      // prefer. OPTION_CLOSEST_SYNC finds the nearest keyframe which is far
      // cheaper than OPTION_CLOSEST (which has to decode forward from the
      // last keyframe). For a chat thumbnail "close enough" is fine.
      val timeUs = if (atMs > 0) atMs * 1000L else 0L
      val raw: Bitmap = mmr.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        ?: throw CodedException("E_THUMB_DECODE", "Cannot decode frame at ${atMs}ms", null)

      val dim = if (maxDim > 0) maxDim else 480
      val scaled: Bitmap = if (raw.width > dim || raw.height > dim) {
        val ratio = raw.width.toFloat() / raw.height.toFloat()
        val targetW: Int; val targetH: Int
        if (raw.width >= raw.height) {
          targetW = dim
          targetH = (dim / ratio).toInt().coerceAtLeast(1)
        } else {
          targetH = dim
          targetW = (dim * ratio).toInt().coerceAtLeast(1)
        }
        Bitmap.createScaledBitmap(raw, targetW, targetH, true)
      } else {
        raw
      }

      // Write to app cache as JPEG q=85 (sweet spot — visually lossless,
      // small enough for the chat list thumbnail strip).
      val cacheDir = appContext.reactContext?.cacheDir
        ?: throw CodedException("E_NO_CACHE", "cacheDir unavailable", null)
      val outFile = File(cacheDir, "thumb_${System.currentTimeMillis()}_${(Math.random() * 1000).toInt()}.jpg")
      FileOutputStream(outFile).use { fos ->
        scaled.compress(Bitmap.CompressFormat.JPEG, 85, fos)
      }
      if (scaled !== raw) {
        try { scaled.recycle() } catch (_: Throwable) {}
      }
      try { raw.recycle() } catch (_: Throwable) {}

      return mapOf(
        "uri" to "file://${outFile.absolutePath}",
        "width" to (if (scaled !== raw) scaled.width else raw.width),
        "height" to (if (scaled !== raw) scaled.height else raw.height)
      )
    } finally {
      try { mmr.release() } catch (_: Throwable) {}
    }
  }

  private fun compress(srcUri: String, options: Map<String, Any?>): Map<String, Any> {
    // Pull options with defaults that match the TS layer.
    val maxWidth = (options["maxWidth"] as? Number)?.toInt() ?: 1280
    val maxHeight = (options["maxHeight"] as? Number)?.toInt() ?: 720
    val targetBitrate = (options["bitrate"] as? Number)?.toLong() ?: 1_500_000L

    // Read source info to decide if we even NEED to re-encode.
    val info = readInfo(srcUri)
    val srcW = (info["width"] as? Int) ?: 0
    val srcH = (info["height"] as? Int) ?: 0
    val srcSize = (info["sizeBytes"] as? Long) ?: 0L
    val durationMs = (info["durationMs"] as? Long) ?: 0L

    // Heuristic: if dims already fit AND average bitrate already at/below
    // target, this clip is already efficient — return the source URI
    // unchanged. Saves a redundant transcode for already-compressed clips
    // (e.g., a video downloaded from another chat, screen recordings, etc.).
    val srcBitrate = if (durationMs > 0) (srcSize * 8L * 1000L) / durationMs else Long.MAX_VALUE
    val withinEnvelope = srcW > 0 && srcH > 0
      && srcW <= maxWidth && srcH <= maxHeight
      && srcBitrate <= (targetBitrate * 12L / 10L) // 20% tolerance — re-encoding to save 10% isn't worth it

    if (withinEnvelope) {
      Log.i(TAG, "compressVideo: src ${srcW}x${srcH} ${srcBitrate}bps already within envelope (${maxWidth}x${maxHeight} ${targetBitrate}bps) — skipping transcode")
      return mapOf(
        "uri" to srcUri,
        "size" to srcSize,
        "width" to srcW,
        "height" to srcH,
        "durationMs" to durationMs
      )
    }

    // Stage 1 fallback: real MediaCodec transcode pipeline is deferred to
    // Stage 2 (see file header TODO). Returning the source URI unchanged
    // means the JS upload path proceeds with the raw clip — same behaviour
    // as before this module existed. iOS users still get the win via
    // AVAssetExportSession, so this isn't a regression anywhere.
    Log.w(TAG, "compressVideo: src ${srcW}x${srcH} ${srcBitrate}bps EXCEEDS target ${maxWidth}x${maxHeight} ${targetBitrate}bps but Android MediaCodec transcode is Stage 2 — uploading raw")
    return mapOf(
      "uri" to srcUri,
      "size" to srcSize,
      "width" to srcW,
      "height" to srcH,
      "durationMs" to durationMs
    )
  }
}
