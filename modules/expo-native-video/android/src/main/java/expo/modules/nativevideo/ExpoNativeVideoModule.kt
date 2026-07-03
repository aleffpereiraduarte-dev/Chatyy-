package expo.modules.nativevideo

import android.graphics.Bitmap
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import kotlin.math.min

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

    // segmentVideo(srcUri, segmentMs) — split a long clip into back-to-back
    // ≤segmentMs chunks (WhatsApp status parity: post a >30s video as several
    // 30s segments). Uses MediaExtractor → MediaMuxer sample-copy (NO re-encode
    // — fast + lossless), cutting on keyframe boundaries. Returns:
    //   { segments: [ { uri, index, durationMs } ], segmented: Boolean }
    // A clip already ≤segmentMs returns the source unchanged (segmented=false).
    // Throws only on unrecoverable errors so the JS caller falls back to
    // posting the single (capped) video — a user's post is never lost.
    AsyncFunction("segmentVideo") { srcUri: String, segmentMs: Double ->
      return@AsyncFunction segment(srcUri, segmentMs.toLong())
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

    // Stage 2: real MediaCodec surface-to-surface transcode (VideoTranscoder).
    // Best-effort — on ANY failure it returns null and we fall back to the
    // Stage 1 behaviour (upload the raw source), so this can never regress
    // into a crash or a broken upload. Only attempt it when we can resolve a
    // filesystem path (file:// or bare path); content:// streams fall back.
    val audioBitrate = (options["audioBitrate"] as? Number)?.toInt() ?: 128_000
    val fps = (options["fps"] as? Number)?.toInt() ?: 30
    val srcPath = resolveFilePath(srcUri)
    val cacheDir = appContext.reactContext?.cacheDir
    if (srcPath != null && cacheDir != null) {
      try {
        val r = VideoTranscoder.transcode(srcPath, cacheDir, maxWidth, maxHeight, targetBitrate, fps)
        if (r != null && r.size in 1L until srcSize) {
          // Only adopt the transcode if it actually got SMALLER — a re-encode
          // that grew the file (rare, e.g. already-efficient source) isn't worth
          // the upload; keep the raw clip in that case.
          Log.i(TAG, "compressVideo: transcoded ${srcW}x${srcH} -> ${r.width}x${r.height}, ${srcSize} -> ${r.size} bytes")
          return mapOf(
            "uri" to "file://${r.path}",
            "size" to r.size,
            "width" to r.width,
            "height" to r.height,
            "durationMs" to durationMs
          )
        }
      } catch (t: Throwable) {
        Log.w(TAG, "compressVideo: transcode threw, uploading raw: ${t.message}")
      }
    }

    // Fallback: return the source URI unchanged — the JS upload path proceeds
    // with the raw clip (same behaviour as before this module existed).
    Log.w(TAG, "compressVideo: src ${srcW}x${srcH} ${srcBitrate}bps — transcode unavailable/skipped, uploading raw")
    return mapOf(
      "uri" to srcUri,
      "size" to srcSize,
      "width" to srcW,
      "height" to srcH,
      "durationMs" to durationMs
    )
  }

  // ─── segmentVideo ────────────────────────────────────────────────────────

  private fun segment(srcUri: String, segmentMsIn: Long): Map<String, Any> {
    val segmentMs = if (segmentMsIn > 0) segmentMsIn else 30_000L
    val info = readInfo(srcUri)
    val totalMs = (info["durationMs"] as? Long) ?: 0L

    // Short clip (or unknown duration) → nothing to split; return as-is so the
    // JS path uploads it unchanged.
    if (totalMs <= 0L || totalMs <= segmentMs + 1_500L) {
      return mapOf(
        "segmented" to false,
        "segments" to listOf(
          mapOf("uri" to srcUri, "index" to 0, "durationMs" to totalMs)
        )
      )
    }

    val cacheDir = appContext.reactContext?.cacheDir
      ?: throw CodedException("E_SEG_NO_CACHE", "cacheDir unavailable", null)

    // Rotation so each segment preserves the shooting orientation.
    val rotation = try {
      val mmr = openRetriever(srcUri)
      try {
        mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      } finally { try { mmr.release() } catch (_: Throwable) {} }
    } catch (_: Throwable) { 0 }

    val totalUs = totalMs * 1000L
    val segUs = segmentMs * 1000L
    val stamp = System.currentTimeMillis()
    val segments = ArrayList<Map<String, Any>>()
    val written = ArrayList<File>()
    var index = 0
    var startUs = 0L
    try {
      while (startUs < totalUs) {
        val endUs = min(startUs + segUs, totalUs)
        val outFile = File(cacheDir, "seg_${stamp}_${index}.mp4")
        val actualDurUs = writeSegment(srcUri, outFile, startUs, endUs, rotation)
        if (actualDurUs <= 0L || !outFile.exists() || outFile.length() <= 0L) {
          throw CodedException("E_SEG_EMPTY", "Segment $index produced no output", null)
        }
        written.add(outFile)
        segments.add(
          mapOf(
            "uri" to "file://${outFile.absolutePath}",
            "index" to index,
            "durationMs" to (actualDurUs / 1000L)
          )
        )
        index++
        startUs = endUs
        // Safety cap — never spawn an unbounded number of segments.
        if (index >= 20) break
      }
    } catch (t: Throwable) {
      // Clean up partial output so we don't leak files, then rethrow so JS
      // falls back to posting the single video.
      for (f in written) { try { f.delete() } catch (_: Throwable) {} }
      Log.w(TAG, "segmentVideo failed: ${t.message}")
      throw if (t is CodedException) t else CodedException("E_SEG_FAILED", t.message ?: "segment failed", t)
    }

    Log.i(TAG, "segmentVideo: split ${totalMs}ms into ${segments.size} segments of ≤${segmentMs}ms")
    return mapOf("segmented" to true, "segments" to segments)
  }

  /**
   * Copy the sample range [startUs, endUs) from the source into a fresh MP4 at
   * `outFile` without re-encoding. Seeks to the keyframe at/before startUs so
   * the video is decodable, and rebases timestamps to 0. Returns the actual
   * written duration in µs (0 on failure).
   */
  private fun writeSegment(srcUri: String, outFile: File, startUs: Long, endUs: Long, rotation: Int): Long {
    var extractor: MediaExtractor? = null
    var muxer: MediaMuxer? = null
    try {
      extractor = MediaExtractor()
      val uri = Uri.parse(srcUri)
      when (uri.scheme) {
        "content" -> extractor.setDataSource(appContext.reactContext!!, uri, null)
        "file", null -> extractor.setDataSource(uri.path ?: srcUri)
        else -> extractor.setDataSource(srcUri)
      }

      val trackCount = extractor.trackCount
      if (outFile.exists()) outFile.delete()
      muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

      val indexMap = HashMap<Int, Int>()
      var maxInputSize = 0
      for (i in 0 until trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("video/") || mime.startsWith("audio/")) {
          extractor.selectTrack(i)
          val dst = muxer.addTrack(format)
          indexMap[i] = dst
          if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
            maxInputSize = maxOf(maxInputSize, format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
          }
        }
      }
      if (indexMap.isEmpty()) return 0L

      if (rotation != 0) {
        try { muxer.setOrientationHint(rotation) } catch (_: Throwable) {}
      }
      muxer.start()

      val bufSize = if (maxInputSize > 0) maxInputSize else 1 shl 20 // 1MB fallback
      val buffer = ByteBuffer.allocate(bufSize)
      val bufferInfo = MediaCodec.BufferInfo()

      // Seek to the keyframe at/before the segment start so decoding is clean.
      extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)

      var baseUs = -1L
      var lastUs = 0L
      while (true) {
        bufferInfo.offset = 0
        bufferInfo.size = extractor.readSampleData(buffer, 0)
        if (bufferInfo.size < 0) break
        val sampleTime = extractor.sampleTime
        if (sampleTime < 0) break
        if (sampleTime >= endUs) break
        if (baseUs < 0L) baseUs = sampleTime
        val track = extractor.sampleTrackIndex
        val dst = indexMap[track]
        if (dst != null) {
          bufferInfo.presentationTimeUs = sampleTime - baseUs
          bufferInfo.flags = sampleFlagsToBufferFlags(extractor.sampleFlags)
          muxer.writeSampleData(dst, buffer, bufferInfo)
          if (bufferInfo.presentationTimeUs > lastUs) lastUs = bufferInfo.presentationTimeUs
        }
        extractor.advance()
      }
      return lastUs
    } catch (t: Throwable) {
      Log.w(TAG, "writeSegment failed: ${t.message}")
      return 0L
    } finally {
      try { muxer?.stop() } catch (_: Throwable) {}
      try { muxer?.release() } catch (_: Throwable) {}
      try { extractor?.release() } catch (_: Throwable) {}
    }
  }

  /** Map MediaExtractor sample flags → MediaCodec buffer flags for the muxer. */
  private fun sampleFlagsToBufferFlags(sampleFlags: Int): Int {
    var flags = 0
    if (sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) {
      flags = flags or MediaCodec.BUFFER_FLAG_KEY_FRAME
    }
    return flags
  }

  /** Resolve a file:// or bare path to a filesystem path; null for content:// etc. */
  private fun resolveFilePath(srcUri: String): String? {
    return try {
      val uri = Uri.parse(srcUri)
      when (uri.scheme) {
        "file", null -> uri.path ?: srcUri
        else -> if (srcUri.startsWith("/")) srcUri else null
      }
    } catch (_: Throwable) {
      null
    }
  }
}
