package expo.modules.nativevideo

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
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
 * VideoTranscoder — Stage 2 (2026-06-29).
 *
 * Real H.264 re-encode for the Android chat video pipeline, implementing the
 * surface-to-surface MediaCodec transcode that was deferred in
 * ExpoNativeVideoModule's Stage 1. This makes the WhatsApp-style HD / Standard
 * quality toggle actually shrink video on Android (iOS already does via
 * AVAssetExportSession).
 *
 * Pipeline (bigflake / grafika ExtractDecodeEditEncodeMuxTest pattern):
 *
 *   MediaExtractor(src)
 *     → video MediaCodec decoder  (outputs onto an OpenGL SurfaceTexture)
 *     → TextureRender (GL_TEXTURE_EXTERNAL_OES → encoder input surface, scaled)
 *     → video MediaCodec encoder  ("video/avc" @ target W×H / bitrate / fps)
 *     → MediaMuxer (mp4)
 *   Audio track is copied through unchanged (no re-encode — AAC stays AAC),
 *   muxed alongside the re-encoded video.
 *
 * EVERYTHING here is best-effort. `transcode()` returns the output path on
 * success or `null` on ANY failure — the caller (ExpoNativeVideoModule.compress)
 * treats null as "fall back to uploading the raw source", which is exactly the
 * Stage 1 behaviour. So a transcode bug degrades to "no compression", never a
 * crash or a broken upload.
 */
object VideoTranscoder {

  private const val TAG = "VideoTranscoder"
  private const val OUTPUT_MIME = "video/avc"
  private const val TIMEOUT_US = 10_000L
  // EGL_RECORDABLE_ANDROID — flags an EGLConfig as usable for MediaCodec input.
  private const val EGL_RECORDABLE_ANDROID = 0x3142

  data class Result(val path: String, val width: Int, val height: Int, val size: Long)

  /**
   * Re-encode [srcPath] to H.264 at up to [maxWidth]×[maxHeight] and [bitrate]
   * bps, writing an .mp4 into [cacheDir]. Returns null on any failure.
   *
   * The caller has already decided a transcode is WANTED (source exceeds the
   * target envelope); here we just do it.
   */
  fun transcode(
    srcPath: String,
    cacheDir: File,
    maxWidth: Int,
    maxHeight: Int,
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

      val srcW = srcFormat.getInteger(MediaFormat.KEY_WIDTH)
      val srcH = srcFormat.getInteger(MediaFormat.KEY_HEIGHT)
      if (srcW <= 0 || srcH <= 0) return null

      // Compute target dims preserving aspect ratio, fitting inside the
      // (maxWidth × maxHeight) box. Encoders want even dimensions, so round
      // each down to a multiple of 2.
      val (outW, outH) = fitInside(srcW, srcH, maxWidth, maxHeight)
      if (outW < 16 || outH < 16) return null

      val srcDurationUs = if (srcFormat.containsKey(MediaFormat.KEY_DURATION))
        srcFormat.getLong(MediaFormat.KEY_DURATION) else 0L

      // Source frame rate hint (fallback to requested fps if absent).
      val srcFps = if (srcFormat.containsKey(MediaFormat.KEY_FRAME_RATE))
        srcFormat.getInteger(MediaFormat.KEY_FRAME_RATE) else fps
      val targetFps = if (srcFps in 1..fps) srcFps else fps

      // ── 2. Encoder (configured first to obtain its input Surface) ─────────
      val encFormat = MediaFormat.createVideoFormat(OUTPUT_MIME, outW, outH).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        setInteger(MediaFormat.KEY_BIT_RATE, bitrate.toInt())
        setInteger(MediaFormat.KEY_FRAME_RATE, targetFps)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
      }
      encoder = MediaCodec.createEncoderByType(OUTPUT_MIME)
      encoder.configure(encFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      inputSurface = CodecInputSurface(encoder.createInputSurface())
      encoder.start()

      // ── 3. Decoder rendering onto an OpenGL SurfaceTexture ────────────────
      inputSurface.makeCurrent()
      outputSurface = OutputSurface()
      val decMime = srcFormat.getString(MediaFormat.KEY_MIME) ?: return null
      decoder = MediaCodec.createDecoderByType(decMime)
      decoder.configure(srcFormat, outputSurface.surface, null, 0)
      decoder.start()

      // ── 4. Muxer (audio track added upfront; video added once known) ──────
      muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

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

      val bufferInfo = MediaCodec.BufferInfo()
      var muxVideoTrack = -1
      var muxerStarted = false

      var inputDone = false
      var decodeDone = false
      var encodeDone = false

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
              val render = bufferInfo.size != 0
              decoder.releaseOutputBuffer(outIndex, render)
              if (render) {
                // Pull the frame into our external texture and draw it scaled
                // onto the encoder's input surface.
                outputSurface.awaitNewImage()
                outputSurface.drawImage()
                inputSurface.setPresentationTime(bufferInfo.presentationTimeUs * 1000L)
                inputSurface.swapBuffers()
              }
              if (eos) {
                decodeDone = true
                encoder.signalEndOfInputStream()
              }
              decoderBusy = false
            }
          }
        }

        // 4c. Drain the encoder → muxer.
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

      // ── 5. Copy audio samples through unchanged ──────────────────────────
      if (audioExtractor != null && muxAudioTrack >= 0 && muxerStarted) {
        copyAudio(audioExtractor, muxer, muxAudioTrack)
      }

      muxer.stop()

      val size = outFile.length()
      if (size <= 0L) return null
      Log.i(TAG, "transcode OK: ${srcW}x${srcH} -> ${outW}x${outH} @ ${bitrate}bps, ${size} bytes")
      return Result(outFile.absolutePath, outW, outH, size)
    } catch (t: Throwable) {
      Log.w(TAG, "transcode failed, caller will upload raw: ${t.message}", t)
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

  // ── helpers ────────────────────────────────────────────────────────────────

  private fun selectTrack(extractor: MediaExtractor, prefix: String): Int {
    for (i in 0 until extractor.trackCount) {
      val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
      if (mime.startsWith(prefix)) return i
    }
    return -1
  }

  private fun fitInside(srcW: Int, srcH: Int, maxW: Int, maxH: Int): Pair<Int, Int> {
    if (srcW <= maxW && srcH <= maxH) return Pair(even(srcW), even(srcH))
    val ratio = minOf(maxW.toFloat() / srcW, maxH.toFloat() / srcH)
    return Pair(even((srcW * ratio).toInt()), even((srcH * ratio).toInt()))
  }

  private fun even(v: Int): Int = if (v % 2 == 0) v else v - 1

  private fun copyAudio(extractor: MediaExtractor, muxer: MediaMuxer, dstTrack: Int) {
    val maxSample = 1 shl 20 // 1 MB
    val buffer = ByteBuffer.allocate(maxSample)
    val info = MediaCodec.BufferInfo()
    while (true) {
      val size = extractor.readSampleData(buffer, 0)
      if (size < 0) break
      info.offset = 0
      info.size = size
      info.presentationTimeUs = extractor.sampleTime
      info.flags = sampleFlagsToBufferFlags(extractor.sampleFlags)
      muxer.writeSampleData(dstTrack, buffer, info)
      extractor.advance()
    }
  }

  private fun sampleFlagsToBufferFlags(sampleFlags: Int): Int {
    var flags = 0
    if (sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) {
      flags = flags or MediaCodec.BUFFER_FLAG_KEY_FRAME
    }
    return flags
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
