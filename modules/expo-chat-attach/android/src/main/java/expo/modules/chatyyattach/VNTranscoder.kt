package expo.modules.chatyyattach

import android.graphics.SurfaceTexture
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
 * [2026-10-15 native-vnote] Vídeo-recado: gravação do CameraX → MP4 QUADRADO
 * H.264 (size×size, padrão 640) + áudio AAC copiado direto.
 *
 * MediaExtractor → decoder (SurfaceTexture) → GL (recorte central quadrado
 * nas coordenadas de textura) → encoder AVC → MediaMuxer. O quadrado central
 * do quadro CODIFICADO é o mesmo do quadro exibido (rotação de 90/180/270 em
 * torno do centro), então a rotação da fonte é só repassada ao muxer
 * (setOrientationHint). Padrão grafika/bigflake (ver expo-native-video
 * VideoTranscoder.kt). Qualquer falha → null (o chamador envia o original).
 * Bloqueante — chamar fora da main.
 */
object VNTranscoder {
  private const val TAG = "ChatyyVNote"
  private const val MIME = "video/avc"
  private const val TIMEOUT_US = 10_000L
  private const val EGL_RECORDABLE_ANDROID = 0x3142

  fun transcode(src: File, out: File, size: Int, bitrate: Int, fps: Int = 30): Boolean {
    var extractor: MediaExtractor? = null
    var audioEx: MediaExtractor? = null
    var decoder: MediaCodec? = null
    var encoder: MediaCodec? = null
    var muxer: MediaMuxer? = null
    var input: InputSurface? = null
    var output: OutputSurface? = null
    try {
      extractor = MediaExtractor()
      extractor.setDataSource(src.absolutePath)
      val vt = track(extractor, "video/")
      if (vt < 0) return false
      extractor.selectTrack(vt)
      val fmt = extractor.getTrackFormat(vt)
      val sw = fmt.getInteger(MediaFormat.KEY_WIDTH)
      val sh = fmt.getInteger(MediaFormat.KEY_HEIGHT)
      if (sw <= 0 || sh <= 0) return false
      val rotation = rotationOf(fmt, src)
      if (fmt.containsKey(MediaFormat.KEY_ROTATION)) fmt.setInteger(MediaFormat.KEY_ROTATION, 0)

      val s = (size.coerceIn(160, 1080)) and 1.inv()
      encoder = configureEncoder(s, bitrate, fps) ?: return false
      input = InputSurface(encoder.createInputSurface())
      encoder.start()
      input.makeCurrent()
      GLES20.glViewport(0, 0, s, s)

      // Recorte central quadrado (coordenadas 0..1 antes da matriz do SurfaceTexture).
      val u0: Float; val u1: Float; val v0: Float; val v1: Float
      if (sw >= sh) {
        val f = sh.toFloat() / sw
        u0 = (1f - f) / 2f; u1 = 1f - u0; v0 = 0f; v1 = 1f
      } else {
        val f = sw.toFloat() / sh
        v0 = (1f - f) / 2f; v1 = 1f - v0; u0 = 0f; u1 = 1f
      }
      output = OutputSurface(u0, u1, v0, v1)
      val decMime = fmt.getString(MediaFormat.KEY_MIME) ?: return false
      decoder = MediaCodec.createDecoderByType(decMime)
      decoder.configure(fmt, output.surface, null, 0)
      decoder.start()

      muxer = MediaMuxer(out.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      if (rotation != 0) muxer.setOrientationHint(rotation)

      audioEx = MediaExtractor()
      audioEx.setDataSource(src.absolutePath)
      val at = track(audioEx, "audio/")
      var audioFmt: MediaFormat? = null
      if (at >= 0) { audioEx.selectTrack(at); audioFmt = audioEx.getTrackFormat(at) } else { audioEx.release(); audioEx = null }
      val pump = if (audioEx != null && audioFmt != null) AudioPump(audioEx, audioFmt) else null

      val info = MediaCodec.BufferInfo()
      var muxV = -1
      var muxA = -1
      var started = false
      var inDone = false
      var decDone = false
      var encDone = false
      val minGapUs = 1_000_000L / fps.coerceIn(1, 60) * 3 / 4
      var lastPts = Long.MIN_VALUE

      while (!encDone) {
        if (!inDone) {
          val i = decoder.dequeueInputBuffer(TIMEOUT_US)
          if (i >= 0) {
            val b = decoder.getInputBuffer(i)
            val n = if (b != null) extractor.readSampleData(b, 0) else -1
            if (n < 0) {
              decoder.queueInputBuffer(i, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inDone = true
            } else {
              decoder.queueInputBuffer(i, 0, n, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }
        var busy = true
        while (busy && !decDone) {
          val o = decoder.dequeueOutputBuffer(info, TIMEOUT_US)
          when {
            o == MediaCodec.INFO_TRY_AGAIN_LATER -> busy = false
            o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {}
            o >= 0 -> {
              val eos = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
              val pts = info.presentationTimeUs
              var render = info.size != 0
              if (render && lastPts != Long.MIN_VALUE && pts - lastPts < minGapUs) render = false
              decoder.releaseOutputBuffer(o, render)
              if (render) {
                output.awaitNewImage()
                output.draw()
                input.setPresentationTime(pts * 1000L)
                input.swapBuffers()
                lastPts = pts
              }
              if (eos) { decDone = true; encoder.signalEndOfInputStream() }
              busy = false
            }
          }
        }
        var ebusy = true
        while (ebusy) {
          val o = encoder.dequeueOutputBuffer(info, TIMEOUT_US)
          when {
            o == MediaCodec.INFO_TRY_AGAIN_LATER -> ebusy = false
            o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              if (started) throw RuntimeException("format changed twice")
              muxV = muxer.addTrack(encoder.outputFormat)
              if (audioFmt != null) muxA = muxer.addTrack(audioFmt)
              muxer.start()
              started = true
            }
            o >= 0 -> {
              val enc = encoder.getOutputBuffer(o)
              if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0
              if (info.size != 0 && enc != null) {
                if (!started) throw RuntimeException("muxer not started")
                enc.position(info.offset)
                enc.limit(info.offset + info.size)
                muxer.writeSampleData(muxV, enc, info)
                if (pump != null && muxA >= 0) pump.pumpUntil(muxer, muxA, info.presentationTimeUs)
              }
              encoder.releaseOutputBuffer(o, false)
              if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) { encDone = true; ebusy = false }
            }
          }
        }
      }
      if (!started) return false
      if (pump != null && muxA >= 0) pump.pumpUntil(muxer, muxA, Long.MAX_VALUE)
      muxer.stop()
      try { muxer.release() } catch (_: Throwable) {}
      muxer = null
      return out.length() > 0
    } catch (t: Throwable) {
      Log.w(TAG, "transcode failed: ${t.message}")
      try { muxer?.release() } catch (_: Throwable) {}
      muxer = null
      try { out.delete() } catch (_: Throwable) {}
      return false
    } finally {
      try { decoder?.stop() } catch (_: Throwable) {}
      try { decoder?.release() } catch (_: Throwable) {}
      try { encoder?.stop() } catch (_: Throwable) {}
      try { encoder?.release() } catch (_: Throwable) {}
      try { input?.release() } catch (_: Throwable) {}
      try { output?.release() } catch (_: Throwable) {}
      try { muxer?.release() } catch (_: Throwable) {}
      try { extractor?.release() } catch (_: Throwable) {}
      try { audioEx?.release() } catch (_: Throwable) {}
    }
  }

  private fun configureEncoder(s: Int, bitrate: Int, fps: Int): MediaCodec? {
    for (tier in 0..2) {
      var codec: MediaCodec? = null
      try {
        codec = MediaCodec.createEncoderByType(MIME)
        val caps = try { codec.codecInfo.getCapabilitiesForType(MIME) } catch (_: Throwable) { null }
        var br = bitrate.coerceIn(200_000, 8_000_000)
        try { caps?.videoCapabilities?.bitrateRange?.let { br = it.clamp(br) } } catch (_: Throwable) {}
        val f = MediaFormat.createVideoFormat(MIME, s, s).apply {
          setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
          setInteger(MediaFormat.KEY_BIT_RATE, br)
          setInteger(MediaFormat.KEY_FRAME_RATE, fps)
          setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        if (tier <= 1) {
          val enc = caps?.encoderCapabilities
          if (enc != null && enc.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)) {
            f.setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
          }
        }
        if (tier == 0) {
          val hasMain = caps?.profileLevels?.any { it.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileMain } == true
          if (hasMain) {
            f.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileMain)
            f.setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel31)
          }
          f.setInteger("max-bframes", 0)
        }
        codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        return codec
      } catch (t: Throwable) {
        Log.w(TAG, "encoder tier $tier failed: ${t.message}")
        try { codec?.release() } catch (_: Throwable) {}
      }
    }
    return null
  }

  private fun track(ex: MediaExtractor, prefix: String): Int {
    for (i in 0 until ex.trackCount) {
      val m = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
      if (m.startsWith(prefix)) return i
    }
    return -1
  }

  private fun norm(r: Int): Int = when (((r % 360) + 360) % 360) { 90 -> 90; 180 -> 180; 270 -> 270; else -> 0 }

  private fun rotationOf(fmt: MediaFormat, src: File): Int {
    try { if (fmt.containsKey(MediaFormat.KEY_ROTATION)) return norm(fmt.getInteger(MediaFormat.KEY_ROTATION)) } catch (_: Throwable) {}
    val r = MediaMetadataRetriever()
    return try {
      r.setDataSource(src.absolutePath)
      norm(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0)
    } catch (_: Throwable) { 0 } finally { try { r.release() } catch (_: Throwable) {} }
  }

  private class AudioPump(private val ex: MediaExtractor, format: MediaFormat) {
    private val buf: ByteBuffer
    private val info = MediaCodec.BufferInfo()
    private var done = false

    init {
      val max = try { if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0 } catch (_: Throwable) { 0 }
      buf = ByteBuffer.allocateDirect(if (max in 1..(8 shl 20)) maxOf(max, 64 * 1024) else (1 shl 20))
    }

    fun pumpUntil(m: MediaMuxer, dst: Int, until: Long) {
      while (!done) {
        val t = ex.sampleTime
        if (t < 0) { done = true; return }
        if (t > until) return
        buf.clear()
        val n = ex.readSampleData(buf, 0)
        if (n < 0) { done = true; return }
        info.offset = 0
        info.size = n
        info.presentationTimeUs = t
        info.flags = if ((ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
        m.writeSampleData(dst, buf, info)
        ex.advance()
      }
    }
  }

  private class InputSurface(private val surface: Surface) {
    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var egl: EGLSurface = EGL14.EGL_NO_SURFACE

    init {
      display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
      if (display === EGL14.EGL_NO_DISPLAY) throw RuntimeException("no EGL display")
      val v = IntArray(2)
      if (!EGL14.eglInitialize(display, v, 0, v, 1)) throw RuntimeException("eglInitialize")
      val attrs = intArrayOf(
        EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
        EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, EGL_RECORDABLE_ANDROID, 1, EGL14.EGL_NONE
      )
      val cfgs = arrayOfNulls<EGLConfig>(1)
      val n = IntArray(1)
      if (!EGL14.eglChooseConfig(display, attrs, 0, cfgs, 0, 1, n, 0) || n[0] < 1) throw RuntimeException("eglChooseConfig")
      context = EGL14.eglCreateContext(display, cfgs[0], EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
      if (context === EGL14.EGL_NO_CONTEXT) throw RuntimeException("eglCreateContext")
      egl = EGL14.eglCreateWindowSurface(display, cfgs[0], surface, intArrayOf(EGL14.EGL_NONE), 0)
      if (egl === EGL14.EGL_NO_SURFACE) throw RuntimeException("eglCreateWindowSurface")
    }

    fun makeCurrent() { if (!EGL14.eglMakeCurrent(display, egl, egl, context)) throw RuntimeException("eglMakeCurrent") }
    fun swapBuffers() = EGL14.eglSwapBuffers(display, egl)
    fun setPresentationTime(ns: Long) { EGLExt.eglPresentationTimeANDROID(display, egl, ns) }

    fun release() {
      if (display !== EGL14.EGL_NO_DISPLAY) {
        EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
        EGL14.eglDestroySurface(display, egl)
        EGL14.eglDestroyContext(display, context)
        EGL14.eglReleaseThread()
        EGL14.eglTerminate(display)
      }
      display = EGL14.EGL_NO_DISPLAY
      try { surface.release() } catch (_: Throwable) {}
    }
  }

  private class OutputSurface(u0: Float, u1: Float, v0: Float, v1: Float) {
    val surface: Surface
    private val st: SurfaceTexture
    private val lock = ReentrantLock()
    private val cond = lock.newCondition()
    private var available = false
    private val texId: Int
    private val program: Int
    private val aPos: Int
    private val aTex: Int
    private val uMat: Int
    private val mat = FloatArray(16)
    private val quad: FloatBuffer

    init {
      val verts = floatArrayOf(
        -1f, -1f, u0, v0,
        1f, -1f, u1, v0,
        -1f, 1f, u0, v1,
        1f, 1f, u1, v1,
      )
      quad = ByteBuffer.allocateDirect(verts.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
      quad.put(verts).position(0)
      program = link(VS, FS)
      aPos = GLES20.glGetAttribLocation(program, "aPosition")
      aTex = GLES20.glGetAttribLocation(program, "aTextureCoord")
      uMat = GLES20.glGetUniformLocation(program, "uTexMatrix")
      val t = IntArray(1)
      GLES20.glGenTextures(1, t, 0)
      texId = t[0]
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texId)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
      st = SurfaceTexture(texId)
      st.setOnFrameAvailableListener {
        lock.lock()
        try { available = true; cond.signalAll() } finally { lock.unlock() }
      }
      surface = Surface(st)
    }

    fun awaitNewImage() {
      lock.lock()
      try {
        while (!available) {
          if (cond.awaitNanos(2_500_000_000L) <= 0L && !available) throw RuntimeException("frame wait timed out")
        }
        available = false
      } finally { lock.unlock() }
      st.updateTexImage()
    }

    fun draw() {
      st.getTransformMatrix(mat)
      GLES20.glClearColor(0f, 0f, 0f, 1f)
      GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
      GLES20.glUseProgram(program)
      GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texId)
      quad.position(0)
      GLES20.glEnableVertexAttribArray(aPos)
      GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 16, quad)
      quad.position(2)
      GLES20.glEnableVertexAttribArray(aTex)
      GLES20.glVertexAttribPointer(aTex, 2, GLES20.GL_FLOAT, false, 16, quad)
      GLES20.glUniformMatrix4fv(uMat, 1, false, mat, 0)
      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
      GLES20.glDisableVertexAttribArray(aPos)
      GLES20.glDisableVertexAttribArray(aTex)
    }

    fun release() {
      try { surface.release() } catch (_: Throwable) {}
      try { st.release() } catch (_: Throwable) {}
    }

    private fun link(vs: String, fs: String): Int {
      val v = shader(GLES20.GL_VERTEX_SHADER, vs)
      val f = shader(GLES20.GL_FRAGMENT_SHADER, fs)
      val p = GLES20.glCreateProgram()
      GLES20.glAttachShader(p, v)
      GLES20.glAttachShader(p, f)
      GLES20.glLinkProgram(p)
      val s = IntArray(1)
      GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, s, 0)
      if (s[0] != GLES20.GL_TRUE) throw RuntimeException("link: " + GLES20.glGetProgramInfoLog(p))
      return p
    }

    private fun shader(type: Int, src: String): Int {
      val s = GLES20.glCreateShader(type)
      GLES20.glShaderSource(s, src)
      GLES20.glCompileShader(s)
      val ok = IntArray(1)
      GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0)
      if (ok[0] == 0) throw RuntimeException("shader: " + GLES20.glGetShaderInfoLog(s))
      return s
    }

    companion object {
      const val VS = "attribute vec4 aPosition;\nattribute vec4 aTextureCoord;\nuniform mat4 uTexMatrix;\nvarying vec2 vTextureCoord;\n" +
        "void main() {\n  gl_Position = aPosition;\n  vTextureCoord = (uTexMatrix * aTextureCoord).xy;\n}\n"
      const val FS = "#extension GL_OES_EGL_image_external : require\nprecision mediump float;\nvarying vec2 vTextureCoord;\n" +
        "uniform samplerExternalOES sTexture;\nvoid main() {\n  gl_FragColor = texture2D(sTexture, vTextureCoord);\n}\n"
    }
  }
}
