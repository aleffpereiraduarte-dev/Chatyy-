package expo.modules.nativevideo

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.util.Log
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.locks.ReentrantLock

/**
 * VideoTranscoder — Stage 3 (2026-10-11, "WhatsApp-level").
 *
 * Real H.264 re-encode for the Android chat video pipeline.
 *
 * Pipeline (bigflake / grafika ExtractDecodeEditEncodeMuxTest pattern):
 *
 *   MediaExtractor(src)
 *     → video MediaCodec decoder  (outputs onto an OpenGL SurfaceTexture)
 *     → TextureRender (GL_TEXTURE_EXTERNAL_OES → encoder input surface, scaled)
 *     → video MediaCodec encoder  ("video/avc" High/VBR when supported)
 *     → MediaMuxer (mp4, orientation hint = source rotation)
 *     → Mp4FastStart (moov moved before mdat; best-effort)
 *   Audio track is copied through unchanged (AAC stays AAC) and INTERLEAVED
 *   with the video samples (so a faststart file streams progressively).
 *
 * Stage 3 changes:
 *   • Fit by SHORT/LONG side (orientation-agnostic), never upscale, even dims
 *     (codec alignment honoured; 16-aligned fallback if the codec rejects).
 *   • Rotation: frames are encoded in the CODED orientation (decoder rotation
 *     forced to 0 so the GL pass never squashes a rotated frame into a
 *     landscape viewport) and the source rotation is written back via
 *     MediaMuxer.setOrientationHint → portrait clips stay portrait.
 *   • Encoder: AVC High (→ Main → Baseline) + computed level, VBR (→ CBR),
 *     I-frame every 2 s, fps = source capped by the requested fps (frames
 *     above the cap are dropped), no B-frames (muxer/player compat).
 *     Configure ladder falls back to a plain format if a codec rejects keys.
 *   • Faststart (moov before mdat).
 *
 * EVERYTHING here is best-effort. `transcode()` returns null on ANY failure —
 * the caller (ExpoNativeVideoModule.compress) then uploads the raw source.
 */
object VideoTranscoder {

  private const val TAG = "VideoTranscoder"
  private const val OUTPUT_MIME = "video/avc"
  private const val TIMEOUT_US = 10_000L
  // EGL_RECORDABLE_ANDROID — flags an EGLConfig as usable for MediaCodec input.
  private const val EGL_RECORDABLE_ANDROID = 0x3142

  /** [width]/[height] are the DISPLAY dims (rotation applied), like getInfo. */
  data class Result(
    val path: String,
    val width: Int,
    val height: Int,
    val size: Long,
    val rotation: Int = 0,
    val fastStart: Boolean = false
  )

  /** Back-compat entry (box semantics, orientation-agnostic: long×short). */
  fun transcode(
    srcPath: String,
    cacheDir: File,
    maxWidth: Int,
    maxHeight: Int,
    bitrate: Long,
    fps: Int
  ): Result? = transcodeShortSide(
    srcPath, cacheDir,
    maxShortSide = maxOf(1, minOf(maxWidth, maxHeight)),
    maxLongSide = maxOf(maxWidth, maxHeight),
    bitrate = bitrate,
    fps = fps
  )

  /**
   * Re-encode [srcPath] to H.264 so that the output's short side ≤ [maxShortSide]
   * and long side ≤ [maxLongSide] (never upscaled), at ~[bitrate] bps and at most
   * [fps] (capped to 60). Writes an .mp4 into [cacheDir]. Returns null on any
   * failure.
   */
  fun transcodeShortSide(
    srcPath: String,
    cacheDir: File,
    maxShortSide: Int,
    maxLongSide: Int,
    bitrate: Long,
    fps: Int
  ): Result? {
    var extractor: MediaExtractor? = null
    var decoder: MediaCodec? = null
    var encoder: MediaCodec? = null
    var muxer: MediaMuxer? = null
    var inputSurface: CodecInputSurface? = null
    var outputSurface: OutputSurface? = null
    var audioExtractor: MediaExtractor? = null
    val outFile = File(cacheDir, "cvx_${System.currentTimeMillis()}_${(Math.random() * 100000).toInt()}.mp4")

    try {
      // ── 1. Source video track ────────────────────────────────────────────
      extractor = MediaExtractor()
      extractor.setDataSource(srcPath)
      val videoTrack = selectTrack(extractor, "video/")
      if (videoTrack < 0) {
        Log.w(TAG, "no video track")
        return null
      }
      extractor.selectTrack(videoTrack)
      val srcFormat = extractor.getTrackFormat(videoTrack)

      // CODED dims (pre-rotation) — that's what the decoder outputs and what
      // we encode; the rotation is re-applied by the muxer's orientation hint.
      val srcW = srcFormat.getInteger(MediaFormat.KEY_WIDTH)
      val srcH = srcFormat.getInteger(MediaFormat.KEY_HEIGHT)
      if (srcW <= 0 || srcH <= 0) return null

      val rotation = readRotation(srcFormat, srcPath)
      // Make sure the decoder does NOT rotate on its output surface (some
      // devices honour KEY_ROTATION there): a 90°-rotated frame drawn into
      // our coded-size (landscape) viewport would be squashed/stretched.
      if (srcFormat.containsKey(MediaFormat.KEY_ROTATION)) {
        srcFormat.setInteger(MediaFormat.KEY_ROTATION, 0)
      }

      // Uniform scale ⇒ orientation-agnostic: compare short↔short, long↔long.
      val (fitW, fitH) = fitShortLong(srcW, srcH, maxShortSide, maxLongSide)
      if (fitW < 16 || fitH < 16) return null

      val srcFps = readFrameRate(srcFormat)
      val fpsCap = fps.coerceIn(1, 60)
      val targetFps = if (srcFps in 1..fpsCap) srcFps else fpsCap
      // Drop frames only when the source is clearly faster than the cap.
      val frameIntervalUs = if (srcFps > fpsCap + 1) 1_000_000L / targetFps else 0L
      val dropThresholdUs = frameIntervalUs - frameIntervalUs / 4

      // ── 2. Encoder (configured first to obtain its input Surface) ─────────
      val setup = configureEncoder(fitW, fitH, bitrate, targetFps)
        ?: run { Log.w(TAG, "no encoder config accepted"); return null }
      encoder = setup.codec
      val outW = setup.width
      val outH = setup.height
      inputSurface = CodecInputSurface(encoder.createInputSurface())
      encoder.start()

      // ── 3. Decoder rendering onto an OpenGL SurfaceTexture ────────────────
      inputSurface.makeCurrent()
      GLES20.glViewport(0, 0, outW, outH)
      outputSurface = OutputSurface()
      val decMime = srcFormat.getString(MediaFormat.KEY_MIME) ?: return null
      decoder = MediaCodec.createDecoderByType(decMime)
      decoder.configure(srcFormat, outputSurface.surface, null, 0)
      decoder.start()

      // ── 4. Muxer (+ orientation) ─────────────────────────────────────────
      muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      if (rotation != 0) muxer.setOrientationHint(rotation)

      // Optional audio passthrough.
      audioExtractor = MediaExtractor()
      audioExtractor.setDataSource(srcPath)
      val audioTrack = selectTrack(audioExtractor, "audio/")
      var muxAudioTrack = -1
      var audioFormat: MediaFormat? = null
      if (audioTrack >= 0) {
        audioExtractor.selectTrack(audioTrack)
        audioFormat = audioExtractor.getTrackFormat(audioTrack)
      } else {
        audioExtractor.release()
        audioExtractor = null
      }
      val audioPump = if (audioExtractor != null && audioFormat != null)
        AudioPump(audioExtractor, audioFormat) else null

      val bufferInfo = MediaCodec.BufferInfo()
      var muxVideoTrack = -1
      var muxerStarted = false

      var inputDone = false
      var decodeDone = false
      var encodeDone = false
      var lastRenderedPtsUs = Long.MIN_VALUE
      var framesIn = 0
      var framesOut = 0

      // Drives the loop: pull from extractor → decoder → GL → encoder → muxer.
      while (!encodeDone) {
        // 4a. Feed encoded source samples into the decoder.
        if (!inputDone) {
          val inIndex = decoder.dequeueInputBuffer(TIMEOUT_US)
          if (inIndex >= 0) {
            val inBuf = decoder.getInputBuffer(inIndex)
            val sampleSize = if (inBuf != null) extractor.readSampleData(inBuf, 0) else -1
            if (sampleSize < 0) {
              decoder.queueInputBuffer(inIndex, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              val pts = extractor.sampleTime
              decoder.queueInputBuffer(inIndex, 0, sampleSize, pts, 0)
              extractor.advance()
            }
          }
        }

        // 4b. Drain the decoder; each decoded frame → GL render → encoder.
        var decoderBusy = true
        while (decoderBusy && !decodeDone) {
          val outIndex = decoder.dequeueOutputBuffer(bufferInfo, TIMEOUT_US)
          when {
            outIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> decoderBusy = false
            outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> { /* ignore for surface */ }
            outIndex >= 0 -> {
              val eos = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
              val pts = bufferInfo.presentationTimeUs
              var render = bufferInfo.size != 0
              if (render) framesIn++
              // fps cap: drop frames that arrive faster than the target rate.
              if (render && frameIntervalUs > 0 && lastRenderedPtsUs != Long.MIN_VALUE &&
                pts - lastRenderedPtsUs < dropThresholdUs) {
                render = false
              }
              decoder.releaseOutputBuffer(outIndex, render)
              if (render) {
                // Pull the frame into our external texture and draw it scaled
                // onto the encoder's input surface.
                outputSurface.awaitNewImage()
                outputSurface.drawImage()
                inputSurface.setPresentationTime(pts * 1000L)
                inputSurface.swapBuffers()
                lastRenderedPtsUs = pts
                framesOut++
              }
              if (eos) {
                decodeDone = true
                encoder.signalEndOfInputStream()
              }
              decoderBusy = false
            }
          }
        }

        // 4c. Drain the encoder → muxer (audio interleaved up to video pts).
        var encoderBusy = true
        while (encoderBusy) {
          val outIndex = encoder.dequeueOutputBuffer(bufferInfo, TIMEOUT_US)
          when {
            outIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> encoderBusy = false
            outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              if (muxerStarted) throw RuntimeException("format changed twice")
              val newFormat = encoder.outputFormat
              muxVideoTrack = muxer.addTrack(newFormat)
              if (audioFormat != null) muxAudioTrack = muxer.addTrack(audioFormat)
              muxer.start()
              muxerStarted = true
            }
            outIndex >= 0 -> {
              val encoded = encoder.getOutputBuffer(outIndex)
              if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                bufferInfo.size = 0
              }
              if (bufferInfo.size != 0 && encoded != null) {
                if (!muxerStarted) throw RuntimeException("muxer not started")
                encoded.position(bufferInfo.offset)
                encoded.limit(bufferInfo.offset + bufferInfo.size)
                muxer.writeSampleData(muxVideoTrack, encoded, bufferInfo)
                if (audioPump != null && muxAudioTrack >= 0) {
                  audioPump.pumpUntil(muxer, muxAudioTrack, bufferInfo.presentationTimeUs)
                }
              }
              encoder.releaseOutputBuffer(outIndex, false)
              if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                encodeDone = true
                encoderBusy = false
              }
            }
          }
        }
      }

      // ── 5. Flush the remaining audio samples ─────────────────────────────
      if (audioPump != null && muxAudioTrack >= 0 && muxerStarted) {
        audioPump.pumpUntil(muxer, muxAudioTrack, Long.MAX_VALUE)
      }
      if (!muxerStarted) return null

      muxer.stop()
      try { muxer.release() } catch (_: Throwable) {}
      muxer = null

      // ── 6. Faststart (moov before mdat). Best-effort: on any failure the
      //      original muxed file is kept untouched.
      val fast = try { Mp4FastStart.apply(outFile) } catch (t: Throwable) {
        Log.w(TAG, "faststart failed (keeping muxed file): ${t.message}")
        false
      }

      val size = outFile.length()
      if (size <= 0L) return null
      val swap = rotation == 90 || rotation == 270
      val dispW = if (swap) outH else outW
      val dispH = if (swap) outW else outH
      Log.i(TAG, "transcode OK: coded ${srcW}x${srcH} rot=$rotation -> ${outW}x${outH} " +
        "(${setup.desc}) @ ${bitrate}bps ${targetFps}fps frames $framesIn->$framesOut, " +
        "faststart=$fast, $size bytes")
      return Result(outFile.absolutePath, dispW, dispH, size, rotation, fast)
    } catch (t: Throwable) {
      Log.w(TAG, "transcode failed, caller will upload raw: ${t.message}", t)
      try { muxer?.release() } catch (_: Throwable) {}
      muxer = null
      try { outFile.delete() } catch (_: Throwable) {}
      return null
    } finally {
      try { decoder?.stop() } catch (_: Throwable) {}
      try { decoder?.release() } catch (_: Throwable) {}
      try { encoder?.stop() } catch (_: Throwable) {}
      try { encoder?.release() } catch (_: Throwable) {}
      try { inputSurface?.release() } catch (_: Throwable) {}
      try { outputSurface?.release() } catch (_: Throwable) {}
      try { muxer?.release() } catch (_: Throwable) {}
      try { extractor?.release() } catch (_: Throwable) {}
      try { audioExtractor?.release() } catch (_: Throwable) {}
    }
  }

  // ── sizing ─────────────────────────────────────────────────────────────────

  /**
   * Uniform scale so that short ≤ maxShort and long ≤ maxLong, never > 1.
   * Rounded DOWN to even numbers (min 2). Orientation-agnostic.
   */
  internal fun fitShortLong(w: Int, h: Int, maxShort: Int, maxLong: Int): Pair<Int, Int> {
    val s = minOf(w, h).toDouble()
    val l = maxOf(w, h).toDouble()
    var scale = 1.0
    if (maxShort > 0) scale = minOf(scale, maxShort / s)
    if (maxLong > 0) scale = minOf(scale, maxLong / l)
    val ow = if (scale >= 1.0) w else Math.floor(w * scale + 1e-6).toInt()
    val oh = if (scale >= 1.0) h else Math.floor(h * scale + 1e-6).toInt()
    return Pair(maxOf(2, even(ow)), maxOf(2, even(oh)))
  }

  private fun even(v: Int): Int = v and 1.inv()

  private fun alignDown(v: Int, a: Int): Int = if (a <= 1) v else v - (v % a)

  // ── encoder configuration ladder ───────────────────────────────────────────

  private class EncoderSetup(val codec: MediaCodec, val width: Int, val height: Int, val desc: String)

  /**
   * Tries, in order, every (dims × format tier) combination until a codec
   * accepts `configure()`:
   *   dims : exact even dims (aligned to the codec's own alignment), then a
   *          16-aligned variant (some HW encoders need macroblock alignment).
   *   tier : 0 = profile+level+bitrate mode, 1 = bitrate mode only, 2 = plain.
   */
  private fun configureEncoder(w: Int, h: Int, bitrate: Long, fps: Int): EncoderSetup? {
    val candidates = ArrayList<Pair<Int, Int>>(2)
    candidates.add(Pair(w, h))
    val w16 = alignDown(w, 16)
    val h16 = alignDown(h, 16)
    if ((w16 != w || h16 != h) && w16 >= 16 && h16 >= 16) candidates.add(Pair(w16, h16))

    for ((cw0, ch0) in candidates) {
      for (tier in 0..2) {
        var codec: MediaCodec? = null
        try {
          codec = MediaCodec.createEncoderByType(OUTPUT_MIME)
          val caps = try { codec.codecInfo.getCapabilitiesForType(OUTPUT_MIME) } catch (_: Throwable) { null }
          val vcaps = caps?.videoCapabilities
          var cw = cw0
          var ch = ch0
          if (vcaps != null) {
            cw = maxOf(2, even(alignDown(cw, maxOf(2, vcaps.widthAlignment))))
            ch = maxOf(2, even(alignDown(ch, maxOf(2, vcaps.heightAlignment))))
            if (!vcaps.isSizeSupported(cw, ch)) {
              Log.w(TAG, "encoder ${codec.name}: size ${cw}x${ch} unsupported")
              codec.release(); codec = null
              break // next dims candidate
            }
          }
          var br = bitrate.coerceIn(100_000L, Int.MAX_VALUE.toLong()).toInt()
          if (vcaps != null) {
            try { br = vcaps.bitrateRange.clamp(br) } catch (_: Throwable) {}
          }
          val fmt = MediaFormat.createVideoFormat(OUTPUT_MIME, cw, ch).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, br)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
          }
          val desc = StringBuilder(codec.name).append(" ").append(cw).append("x").append(ch)
          if (tier <= 1 && caps != null) {
            val enc = caps.encoderCapabilities
            val mode = when {
              enc == null -> -1
              enc.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR) ->
                MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR
              enc.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR) ->
                MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR
              else -> -1
            }
            if (mode >= 0) {
              fmt.setInteger(MediaFormat.KEY_BITRATE_MODE, mode)
              desc.append(if (mode == MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR) " VBR" else " CBR")
            }
          }
          if (tier == 0 && caps != null) {
            val pl = pickProfileLevel(caps, cw, ch, fps, br)
            if (pl != null) {
              fmt.setInteger(MediaFormat.KEY_PROFILE, pl.first)
              fmt.setInteger(MediaFormat.KEY_LEVEL, pl.second)
              desc.append(" profile=").append(profileName(pl.first)).append(" level=0x")
                .append(Integer.toHexString(pl.second))
            }
            // No B-frames: keeps MediaMuxer/older players happy (ctts/edit-list
            // quirks); High profile still gains CABAC + 8x8 transform.
            fmt.setInteger("max-bframes", 0)
          }
          codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
          return EncoderSetup(codec, cw, ch, desc.append(" tier=").append(tier).toString())
        } catch (t: Throwable) {
          Log.w(TAG, "encoder configure failed (dims ${cw0}x${ch0}, tier $tier): ${t.message}")
          try { codec?.release() } catch (_: Throwable) {}
        }
      }
    }
    return null
  }

  private fun profileName(p: Int): String = when (p) {
    MediaCodecInfo.CodecProfileLevel.AVCProfileHigh -> "High"
    MediaCodecInfo.CodecProfileLevel.AVCProfileMain -> "Main"
    MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline -> "Baseline"
    else -> p.toString()
  }

  // H.264 Annex A limits: (level, maxMBPS, maxFS, maxBR kbps for Baseline/Main).
  private val AVC_LEVELS: Array<IntArray> = arrayOf(
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel1, 1485, 99, 64),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel11, 3000, 396, 192),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel12, 6000, 396, 384),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel13, 11880, 396, 768),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel2, 11880, 396, 2000),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel21, 19800, 792, 4000),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel22, 20250, 1620, 4000),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel3, 40500, 1620, 10000),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel31, 108000, 3600, 14000),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel32, 216000, 5120, 20000),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel4, 245760, 8192, 20000),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel41, 245760, 8192, 50000),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel42, 522240, 8704, 50000),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel5, 589824, 22080, 135000),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel51, 983040, 36864, 240000),
    intArrayOf(MediaCodecInfo.CodecProfileLevel.AVCLevel52, 2073600, 36864, 240000)
  )

  /** Minimum AVC level for w×h@fps / bitrate (High allows 1.25× the bitrate). */
  private fun requiredLevel(w: Int, h: Int, fps: Int, bitrate: Int, high: Boolean): Int? {
    val mbW = (w + 15) / 16
    val mbH = (h + 15) / 16
    val fs = mbW * mbH
    val mbps = fs.toLong() * maxOf(1, fps)
    val kbps = (bitrate + 999) / 1000
    for (row in AVC_LEVELS) {
      val maxBr = if (high) row[3] * 5 / 4 else row[3]
      if (mbps <= row[1] && fs <= row[2] && kbps <= maxBr) return row[0]
    }
    return null
  }

  /** (profile, level) preferring High → Main → Baseline, or null to let the codec pick. */
  private fun pickProfileLevel(
    caps: MediaCodecInfo.CodecCapabilities, w: Int, h: Int, fps: Int, bitrate: Int
  ): Pair<Int, Int>? {
    val pls = caps.profileLevels ?: return null
    val order = intArrayOf(
      MediaCodecInfo.CodecProfileLevel.AVCProfileHigh,
      MediaCodecInfo.CodecProfileLevel.AVCProfileMain,
      MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline
    )
    for (profile in order) {
      var maxLevel = -1
      for (pl in pls) if (pl.profile == profile && pl.level > maxLevel) maxLevel = pl.level
      if (maxLevel < 0) continue
      val need = requiredLevel(w, h, fps, bitrate, profile == MediaCodecInfo.CodecProfileLevel.AVCProfileHigh)
        ?: continue
      // AVCLevel* constants are increasing bit flags → numeric compare works.
      if (need <= maxLevel) return Pair(profile, need)
    }
    return null
  }

  // ── source probing ─────────────────────────────────────────────────────────

  private fun normalizeRotation(r: Int): Int {
    val n = ((r % 360) + 360) % 360
    return when (n) { 90, 180, 270 -> n; else -> 0 }
  }

  private fun readRotation(fmt: MediaFormat, srcPath: String): Int {
    try {
      if (fmt.containsKey(MediaFormat.KEY_ROTATION)) {
        return normalizeRotation(fmt.getInteger(MediaFormat.KEY_ROTATION))
      }
    } catch (_: Throwable) {}
    val mmr = MediaMetadataRetriever()
    return try {
      mmr.setDataSource(srcPath)
      normalizeRotation(
        mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      )
    } catch (_: Throwable) {
      0
    } finally {
      try { mmr.release() } catch (_: Throwable) {}
    }
  }

  /** KEY_FRAME_RATE may be stored as Integer OR Float depending on the extractor. */
  private fun readFrameRate(fmt: MediaFormat): Int {
    if (!fmt.containsKey(MediaFormat.KEY_FRAME_RATE)) return 0
    return try {
      fmt.getInteger(MediaFormat.KEY_FRAME_RATE)
    } catch (_: Throwable) {
      try { Math.round(fmt.getFloat(MediaFormat.KEY_FRAME_RATE)) } catch (_: Throwable) { 0 }
    }
  }

  private fun selectTrack(extractor: MediaExtractor, prefix: String): Int {
    for (i in 0 until extractor.trackCount) {
      val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
      if (mime.startsWith(prefix)) return i
    }
    return -1
  }

  // ── audio passthrough (interleaved) ────────────────────────────────────────

  /** Copies audio samples into the muxer up to a given pts (interleaving). */
  private class AudioPump(private val extractor: MediaExtractor, format: MediaFormat) {
    private val buffer: ByteBuffer
    private val info = MediaCodec.BufferInfo()
    private var done = false

    init {
      val maxIn = try {
        if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0
      } catch (_: Throwable) { 0 }
      buffer = ByteBuffer.allocateDirect(if (maxIn in 1..(8 shl 20)) maxOf(maxIn, 64 * 1024) else (1 shl 20))
    }

    fun pumpUntil(muxer: MediaMuxer, dstTrack: Int, untilUs: Long) {
      while (!done) {
        val t = extractor.sampleTime
        if (t < 0) { done = true; return }
        if (t > untilUs) return
        buffer.clear()
        val size = extractor.readSampleData(buffer, 0)
        if (size < 0) { done = true; return }
        info.offset = 0
        info.size = size
        info.presentationTimeUs = t
        info.flags = if ((extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0)
          MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
        muxer.writeSampleData(dstTrack, buffer, info)
        extractor.advance()
      }
    }
  }

  // ── EGL: encoder input surface ──────────────────────────────────────────────

  /**
   * Holds an EGL context + window surface bound to the MediaCodec encoder's
   * input Surface. Each decoded+rendered frame is presented here with the
   * source presentation timestamp.
   */
  private class CodecInputSurface(private val surface: Surface) {
    private var eglDisplay: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var eglContext: EGLContext = EGL14.EGL_NO_CONTEXT
    private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE

    init {
      eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
      if (eglDisplay === EGL14.EGL_NO_DISPLAY) throw RuntimeException("no EGL display")
      val version = IntArray(2)
      if (!EGL14.eglInitialize(eglDisplay, version, 0, version, 1)) {
        throw RuntimeException("eglInitialize failed")
      }
      val attribList = intArrayOf(
        EGL14.EGL_RED_SIZE, 8,
        EGL14.EGL_GREEN_SIZE, 8,
        EGL14.EGL_BLUE_SIZE, 8,
        EGL14.EGL_ALPHA_SIZE, 8,
        EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
        EGL_RECORDABLE_ANDROID, 1,
        EGL14.EGL_NONE
      )
      val configs = arrayOfNulls<EGLConfig>(1)
      val numConfigs = IntArray(1)
      if (!EGL14.eglChooseConfig(eglDisplay, attribList, 0, configs, 0, configs.size, numConfigs, 0)) {
        throw RuntimeException("eglChooseConfig failed")
      }
      val ctxAttribs = intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE)
      eglContext = EGL14.eglCreateContext(eglDisplay, configs[0], EGL14.EGL_NO_CONTEXT, ctxAttribs, 0)
      checkEglError("eglCreateContext")
      val surfaceAttribs = intArrayOf(EGL14.EGL_NONE)
      eglSurface = EGL14.eglCreateWindowSurface(eglDisplay, configs[0], surface, surfaceAttribs, 0)
      checkEglError("eglCreateWindowSurface")
    }

    fun makeCurrent() {
      if (!EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)) {
        throw RuntimeException("eglMakeCurrent failed")
      }
    }

    fun swapBuffers(): Boolean = EGL14.eglSwapBuffers(eglDisplay, eglSurface)

    fun setPresentationTime(nsecs: Long) {
      EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, nsecs)
    }

    fun release() {
      if (eglDisplay !== EGL14.EGL_NO_DISPLAY) {
        EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
        EGL14.eglDestroySurface(eglDisplay, eglSurface)
        EGL14.eglDestroyContext(eglDisplay, eglContext)
        EGL14.eglReleaseThread()
        EGL14.eglTerminate(eglDisplay)
      }
      eglDisplay = EGL14.EGL_NO_DISPLAY
      eglContext = EGL14.EGL_NO_CONTEXT
      eglSurface = EGL14.EGL_NO_SURFACE
      try { surface.release() } catch (_: Throwable) {}
    }

    private fun checkEglError(op: String) {
      val err = EGL14.eglGetError()
      if (err != EGL14.EGL_SUCCESS) throw RuntimeException("$op: EGL error 0x${Integer.toHexString(err)}")
    }
  }

  // ── GL: decoder output texture → fullscreen quad ────────────────────────────

  /**
   * Wraps a SurfaceTexture bound to an external OES texture. The decoder
   * renders frames onto [surface]; [awaitNewImage] blocks for the next frame
   * and [drawImage] draws it (scaled to the current GL viewport, i.e. the
   * encoder input surface size) using the SurfaceTexture transform matrix.
   */
  private class OutputSurface {
    val surface: Surface
    private val surfaceTexture: android.graphics.SurfaceTexture
    private val textureRender: TextureRender
    // Kotlin can't use Object.wait/notify on Any, so use a Lock + Condition.
    private val frameLock = ReentrantLock()
    private val frameCondition = frameLock.newCondition()
    private var frameAvailable = false

    init {
      textureRender = TextureRender()
      surfaceTexture = android.graphics.SurfaceTexture(textureRender.textureId)
      surfaceTexture.setOnFrameAvailableListener {
        frameLock.lock()
        try {
          frameAvailable = true
          frameCondition.signalAll()
        } finally {
          frameLock.unlock()
        }
      }
      surface = Surface(surfaceTexture)
    }

    fun awaitNewImage() {
      frameLock.lock()
      try {
        // Wait up to 2.5s for the decoder to push a frame onto the texture.
        while (!frameAvailable) {
          if (frameCondition.awaitNanos(2_500_000_000L) <= 0L && !frameAvailable) {
            throw RuntimeException("frame wait timed out")
          }
        }
        frameAvailable = false
      } finally {
        frameLock.unlock()
      }
      surfaceTexture.updateTexImage()
    }

    fun drawImage() {
      textureRender.drawFrame(surfaceTexture)
    }

    fun release() {
      try { surface.release() } catch (_: Throwable) {}
      try { surfaceTexture.release() } catch (_: Throwable) {}
    }
  }

  /**
   * Minimal GLES2 renderer: draws a fullscreen quad sampling an external OES
   * texture, honouring the SurfaceTexture transform matrix.
   */
  private class TextureRender {
    val textureId: Int

    private val program: Int
    private val muTexMatrixHandle: Int
    private val aPositionHandle: Int
    private val aTextureHandle: Int
    private val texMatrix = FloatArray(16)

    private val vertexBuffer: FloatBuffer

    init {
      val verts = floatArrayOf(
        // x, y, u, v  — fullscreen quad as a triangle strip
        -1f, -1f, 0f, 0f,
         1f, -1f, 1f, 0f,
        -1f,  1f, 0f, 1f,
         1f,  1f, 1f, 1f
      )
      vertexBuffer = ByteBuffer.allocateDirect(verts.size * 4)
        .order(ByteOrder.nativeOrder())
        .asFloatBuffer()
      vertexBuffer.put(verts).position(0)

      program = buildProgram(VERTEX_SHADER, FRAGMENT_SHADER)
      aPositionHandle = GLES20.glGetAttribLocation(program, "aPosition")
      aTextureHandle = GLES20.glGetAttribLocation(program, "aTextureCoord")
      muTexMatrixHandle = GLES20.glGetUniformLocation(program, "uTexMatrix")

      val textures = IntArray(1)
      GLES20.glGenTextures(1, textures, 0)
      textureId = textures[0]
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    }

    fun drawFrame(st: android.graphics.SurfaceTexture) {
      st.getTransformMatrix(texMatrix)
      GLES20.glClearColor(0f, 0f, 0f, 1f)
      GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
      GLES20.glUseProgram(program)

      GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)

      vertexBuffer.position(0)
      GLES20.glEnableVertexAttribArray(aPositionHandle)
      GLES20.glVertexAttribPointer(aPositionHandle, 2, GLES20.GL_FLOAT, false, 16, vertexBuffer)

      vertexBuffer.position(2)
      GLES20.glEnableVertexAttribArray(aTextureHandle)
      GLES20.glVertexAttribPointer(aTextureHandle, 2, GLES20.GL_FLOAT, false, 16, vertexBuffer)

      GLES20.glUniformMatrix4fv(muTexMatrixHandle, 1, false, texMatrix, 0)
      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)

      GLES20.glDisableVertexAttribArray(aPositionHandle)
      GLES20.glDisableVertexAttribArray(aTextureHandle)
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, 0)
    }

    private fun buildProgram(vs: String, fs: String): Int {
      val v = loadShader(GLES20.GL_VERTEX_SHADER, vs)
      val f = loadShader(GLES20.GL_FRAGMENT_SHADER, fs)
      val prog = GLES20.glCreateProgram()
      GLES20.glAttachShader(prog, v)
      GLES20.glAttachShader(prog, f)
      GLES20.glLinkProgram(prog)
      val status = IntArray(1)
      GLES20.glGetProgramiv(prog, GLES20.GL_LINK_STATUS, status, 0)
      if (status[0] != GLES20.GL_TRUE) {
        val log = GLES20.glGetProgramInfoLog(prog)
        GLES20.glDeleteProgram(prog)
        throw RuntimeException("program link failed: $log")
      }
      return prog
    }

    private fun loadShader(type: Int, src: String): Int {
      val shader = GLES20.glCreateShader(type)
      GLES20.glShaderSource(shader, src)
      GLES20.glCompileShader(shader)
      val compiled = IntArray(1)
      GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0)
      if (compiled[0] == 0) {
        val log = GLES20.glGetShaderInfoLog(shader)
        GLES20.glDeleteShader(shader)
        throw RuntimeException("shader compile failed: $log")
      }
      return shader
    }

    companion object {
      private const val VERTEX_SHADER =
        "attribute vec4 aPosition;\n" +
        "attribute vec4 aTextureCoord;\n" +
        "uniform mat4 uTexMatrix;\n" +
        "varying vec2 vTextureCoord;\n" +
        "void main() {\n" +
        "  gl_Position = aPosition;\n" +
        "  vTextureCoord = (uTexMatrix * aTextureCoord).xy;\n" +
        "}\n"

      private const val FRAGMENT_SHADER =
        "#extension GL_OES_EGL_image_external : require\n" +
        "precision mediump float;\n" +
        "varying vec2 vTextureCoord;\n" +
        "uniform samplerExternalOES sTexture;\n" +
        "void main() {\n" +
        "  gl_FragColor = texture2D(sTexture, vTextureCoord);\n" +
        "}\n"
    }
  }
}
