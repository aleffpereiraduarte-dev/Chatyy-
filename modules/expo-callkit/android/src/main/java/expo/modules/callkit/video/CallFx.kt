package expo.modules.callkit.video

// [2026-10-16 wave13-B] EFEITOS EM CHAMADA (nível FaceTime/WhatsApp) — Android.
//
// Fundo (nenhum · desfoque leve/forte · 8 fundos P&B gerados no aparelho ·
// foto da galeria) + luz (retoque · pouca luz) aplicados nos frames da câmera
// ANTES do encoder: o outro lado vê e o PiP local mostra ao vivo.
//
// Gancho: livekit.org.webrtc.VideoSource.setVideoProcessor() — a fonte da
// LocalVideoTrack (LK 2.24.1 guarda em campo privado; achado por TIPO, não por
// nome, para sobreviver ao R8) ou a fonte do P2P. Fallback público:
// LocalVideoTrack.restartTrack(options, processor). Sem efeito → o frame passa
// direto (custo zero).
//
// Segmentação: MediaPipe tasks-vision (JÁ é dependência do módulo) +
// selfie_segmenter.tflite (já em src/main/assets) em ~256 px, máscara de
// confiança suavizada no tempo e ampliada com filtro (Canvas A8). Composição
// em I420 (Y/U/V) — sem conversão RGB de tela cheia; blur = reduzir 1/8–1/16
// + box blur + ampliar com libyuv; fundos → I420 via YuvHelper.ABGRToI420.
//
// Desempenho: saída limitada a 1280 px no lado maior (720p) e ≤ 30 fps com
// efeito ligado; máscara a cada 2 frames se o frame passar de ~30 ms ou o
// aparelho estiver em THERMAL_STATUS_MODERATE. Auto-pausa (passa direto,
// escolha mantida) em SEVERE+, economia de energia ou bateria < 15 % fora da
// tomada; volta sozinho. Kill switch: prefs "call_fx_enabled" = false
// (ExpoCallKit.setCallEffectsEnabled; JS globalThis.__chatyy_call_fx).

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.Shader
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.widget.Toast
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.framework.image.ByteBufferExtractor
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.imagesegmenter.ImageSegmenter
import io.livekit.android.room.track.LocalVideoTrack
import livekit.org.webrtc.JavaI420Buffer
import livekit.org.webrtc.VideoFrame
import livekit.org.webrtc.VideoProcessor
import livekit.org.webrtc.VideoSink
import livekit.org.webrtc.VideoSource
import livekit.org.webrtc.YuvHelper
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.WeakHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

object CallFx {
  private const val TAG = "CallFx"
  const val PREFS = "expo_callkit_prefs"
  private const val K_ENABLED = "call_fx_enabled"
  private const val K_BG = "call_fx_bg"
  private const val K_LIGHT = "call_fx_light"
  private const val CUSTOM_FILE = "call_fx_custom_bg.jpg"
  const val WALLPAPER_COUNT = 8

  const val BG_NONE = "none"
  const val BG_BLUR_LIGHT = "blur_light"
  const val BG_BLUR_STRONG = "blur_strong"
  const val BG_CUSTOM = "custom"
  const val LIGHT_NONE = "none"
  const val LIGHT_RETOUCH = "retouch"
  const val LIGHT_LOW = "low_light"

  const val PAUSE_NONE = ""
  const val PAUSE_HEAT = "heat"
  const val PAUSE_BATTERY = "battery"

  @Volatile private var appCtx: Context? = null
  @Volatile private var loaded = false
  @Volatile private var enabled = true
  @Volatile var background: String = BG_NONE
    private set
  @Volatile var light: String = LIGHT_NONE
    private set
  @Volatile var pauseReason: String = PAUSE_NONE
    private set
  @Volatile internal var thermalModerate = false
    private set
  @Volatile internal var customVersion = 0
    private set

  /** UI listeners (main thread): config or pause changed. */
  val listeners = CopyOnWriteArrayList<() -> Unit>()

  private val main = Handler(Looper.getMainLooper())
  private val attached = WeakHashMap<VideoSource, CallFxVideoProcessor>()

  fun wallpaperKey(i: Int) = "wp:$i"

  fun load(ctx: Context) {
    if (appCtx == null) appCtx = ctx.applicationContext
    if (loaded) return
    CallFxStrings.load(ctx)
    try {
      val p = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      enabled = p.getBoolean(K_ENABLED, true)
      background = sanitizeBg(p.getString(K_BG, BG_NONE))
      light = sanitizeLight(p.getString(K_LIGHT, LIGHT_NONE))
      if (background == BG_CUSTOM && !customFile(ctx).exists()) background = BG_NONE
      loaded = true
    } catch (_: Throwable) {}
  }

  private fun sanitizeBg(k: String?): String {
    val v = k ?: return BG_NONE
    if (v == BG_NONE || v == BG_BLUR_LIGHT || v == BG_BLUR_STRONG || v == BG_CUSTOM) return v
    if (v.startsWith("wp:")) {
      val i = v.substring(3).toIntOrNull() ?: return BG_NONE
      if (i in 0 until WALLPAPER_COUNT) return v
    }
    return BG_NONE
  }

  private fun sanitizeLight(k: String?): String = when (k) {
    LIGHT_RETOUCH, LIGHT_LOW -> k
    else -> LIGHT_NONE
  }

  fun isEnabled(ctx: Context): Boolean { load(ctx); return enabled }

  fun setEnabled(ctx: Context, on: Boolean) {
    load(ctx)
    enabled = on
    prefs(ctx)?.edit()?.putBoolean(K_ENABLED, on)?.apply()
    notifyListeners()
  }

  fun setBackground(ctx: Context, key: String) {
    load(ctx)
    background = sanitizeBg(key)
    prefs(ctx)?.edit()?.putString(K_BG, background)?.apply()
    notifyListeners()
  }

  fun setLight(ctx: Context, key: String) {
    load(ctx)
    light = sanitizeLight(key)
    prefs(ctx)?.edit()?.putString(K_LIGHT, light)?.apply()
    notifyListeners()
  }

  private fun prefs(ctx: Context) = try {
    ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  } catch (_: Throwable) { null }

  private fun notifyListeners() {
    main.post { for (l in listeners) try { l() } catch (_: Throwable) {} }
  }

  fun customFile(ctx: Context): File = File(ctx.applicationContext.filesDir, CUSTOM_FILE)

  fun hasCustom(ctx: Context): Boolean = customFile(ctx).exists()

  /** Decode (downscaled, EXIF-aware on API 28+), save JPEG, select it. Off the main thread. */
  fun saveCustomImage(ctx: Context, uri: Uri): Boolean {
    val bmp: Bitmap = try {
      if (Build.VERSION.SDK_INT >= 28) {
        val src = android.graphics.ImageDecoder.createSource(ctx.contentResolver, uri)
        android.graphics.ImageDecoder.decodeBitmap(src) { dec, info, _ ->
          val s = info.size
          val longSide = max(s.width, s.height)
          if (longSide > 1600) {
            val k = 1600f / longSide
            dec.setTargetSize(max(1, (s.width * k).toInt()), max(1, (s.height * k).toInt()))
          }
          dec.allocator = android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE
        }
      } else {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, o) }
        var sample = 1
        while (max(o.outWidth, o.outHeight) / (sample * 2) >= 1600) sample *= 2
        val o2 = BitmapFactory.Options().apply { inSampleSize = sample }
        ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, o2) } ?: return false
      }
    } catch (t: Throwable) {
      Log.w(TAG, "decode custom bg failed: ${t.message}")
      return false
    }
    return try {
      FileOutputStream(customFile(ctx)).use { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
      customVersion++
      setBackground(ctx, BG_CUSTOM)
      true
    } catch (t: Throwable) {
      Log.w(TAG, "save custom bg failed: ${t.message}")
      false
    }
  }

  // ─── attach ────────────────────────────────────────────────────────────

  /** Hook the processor into the camera track's VideoSource (idempotent). */
  fun attach(ctx: Context, track: LocalVideoTrack?) {
    track ?: return
    load(ctx)
    if (!enabled) return
    val src = findSource(track)
    if (src != null) {
      attachSource(ctx, src)
      return
    }
    // Fallback (field not found): public API — restarts the capture once.
    try {
      if (restarted.contains(track)) return
      restarted.add(track)
      track.restartTrack(track.options, CallFxVideoProcessor())
      Log.i(TAG, "attached via restartTrack")
    } catch (t: Throwable) {
      Log.w(TAG, "attach restartTrack failed: ${t.message}")
    }
  }

  private val restarted = java.util.Collections.newSetFromMap(WeakHashMap<LocalVideoTrack, Boolean>())

  fun attachSource(ctx: Context, src: VideoSource) {
    load(ctx)
    if (!enabled) return
    synchronized(attached) {
      if (attached[src] != null) return
      val p = CallFxVideoProcessor()
      try {
        src.setVideoProcessor(p)
        attached[src] = p
        Log.i(TAG, "processor attached to VideoSource")
      } catch (t: Throwable) {
        Log.w(TAG, "setVideoProcessor failed: ${t.message}")
      }
    }
  }

  private fun findSource(track: LocalVideoTrack): VideoSource? {
    var c: Class<*>? = track.javaClass
    while (c != null && c != Any::class.java) {
      for (f in c.declaredFields) {
        if (VideoSource::class.java.isAssignableFrom(f.type)) {
          return try {
            f.isAccessible = true
            f.get(track) as? VideoSource
          } catch (_: Throwable) { null }
        }
      }
      c = c.superclass
    }
    return null
  }

  // ─── pause (thermal / battery) ────────────────────────────────────────

  @Volatile private var lastEvalMs = 0L

  /** Rate-limited (5 s); safe from the capture thread. */
  internal fun maybeEvaluatePause() {
    val now = System.currentTimeMillis()
    if (now - lastEvalMs < 5_000L) return
    lastEvalMs = now
    val ctx = appCtx ?: return
    var thermal = 0
    var powerSave = false
    try {
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (pm != null) {
        powerSave = pm.isPowerSaveMode
        if (Build.VERSION.SDK_INT >= 29) thermal = pm.currentThermalStatus
      }
    } catch (_: Throwable) {}
    var level = -1
    var charging = false
    try {
      val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
      if (bm != null) {
        level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        charging = bm.isCharging
      }
    } catch (_: Throwable) {}
    // PowerManager.THERMAL_STATUS_MODERATE = 2, SEVERE = 3, LIGHT = 1.
    thermalModerate = thermal == 2
    val prev = pauseReason
    val lowBatt = powerSave || (!charging && level in 0..14)
    val next = when {
      thermal >= 3 -> PAUSE_HEAT
      lowBatt -> PAUSE_BATTERY
      prev == PAUSE_HEAT -> if (thermal <= 1) PAUSE_NONE else PAUSE_HEAT
      prev == PAUSE_BATTERY -> if (!powerSave && (charging || level < 0 || level >= 20)) PAUSE_NONE else PAUSE_BATTERY
      else -> PAUSE_NONE
    }
    if (next != prev) {
      pauseReason = next
      Log.i(TAG, "pause '${prev}' → '${next}' thermal=$thermal ps=$powerSave batt=$level chg=$charging")
      notifyListeners()
      val text = pauseText(next)
      if (text != null && (background != BG_NONE || light != LIGHT_NONE)) {
        main.post { try { Toast.makeText(ctx, text, Toast.LENGTH_LONG).show() } catch (_: Throwable) {} }
      }
    }
  }

  fun pauseText(r: String): String? = when (r) {
    PAUSE_HEAT -> CallFxStrings.s("pausedHeat")
    PAUSE_BATTERY -> CallFxStrings.s("pausedBattery")
    else -> null
  }

  internal fun isActive(): Boolean =
    enabled && pauseReason == PAUSE_NONE && (background != BG_NONE || light != LIGHT_NONE)

  internal fun context(): Context? = appCtx
}

/** One per VideoSource. Called on the camera (SurfaceTextureHelper) thread. */
class CallFxVideoProcessor : VideoProcessor {
  @Volatile private var sink: VideoSink? = null
  private var lastOutNs = 0L

  override fun setSink(sink: VideoSink?) { this.sink = sink }
  override fun onCapturerStarted(success: Boolean) {}
  override fun onCapturerStopped() {}

  override fun onFrameCaptured(frame: VideoFrame) {
    val s = sink ?: return
    CallFx.maybeEvaluatePause()
    if (!CallFx.isActive()) { s.onFrame(frame); return }
    // ≤ 30 fps while an effect is on.
    val ts = frame.timestampNs
    if (lastOutNs != 0L && ts > lastOutNs && ts - lastOutNs < 31_000_000L) return
    val out = try { CallFxEngine.process(frame) } catch (t: Throwable) {
      Log.w("CallFx", "process failed: ${t.message}")
      null
    }
    if (out == null) { s.onFrame(frame); return }
    lastOutNs = ts
    try { s.onFrame(out) } finally { out.release() }
  }
}

/** Frame engine (single instance; serialized). */
internal object CallFxEngine {
  private const val TAG = "CallFx"
  private const val SEG_LONG = 256

  private var segmenter: ImageSegmenter? = null
  private var segInitTried = false
  private var lastSegTsMs = 0L
  private var frameIdx = 0L
  private var emaMs = 0.0
  private var segEvery = 1
  private var polarity = 0      // 0 unknown, 1 = mask is person, -1 = mask is background
  private var polarityVotes = 0

  // reusable buffers
  private var yArr = ByteArray(0); private var uArr = ByteArray(0); private var vArr = ByteArray(0)
  private var bY = ByteArray(0); private var bU = ByteArray(0); private var bV = ByteArray(0)
  private var fullMask = ByteArray(0)
  private var smallMask = ByteArray(0); private var smallMaskPrev = ByteArray(0)
  private var smallMaskW = 0; private var smallMaskH = 0
  private var maskBmpSmall: Bitmap? = null
  private var maskBmpFull: Bitmap? = null
  private var maskReadBuf: ByteBuffer? = null
  private val maskPaint = Paint(Paint.FILTER_BITMAP_FLAG)

  private var wpKey: String? = null
  private var wpY = ByteArray(0); private var wpU = ByteArray(0); private var wpV = ByteArray(0)
  private var customSrc: Bitmap? = null
  private var customSrcVer = -1

  private val lutLow = ByteArray(256)
  private val lutRetouch = ByteArray(256)

  init {
    for (i in 0 until 256) {
      val x = i / 255.0
      // Low light: gamma lift of the shadows + slight contrast.
      val low = (x.pow(0.70) * 1.02 - 0.01).coerceIn(0.0, 1.0)
      lutLow[i] = (low * 255).roundToInt().coerceIn(16, 235).toByte()
      // Touch up: gentle midtone lift (no clipping).
      val mid = 1.0 - abs(2 * x - 1)
      val ret = (x + 0.045 * mid).coerceIn(0.0, 1.0)
      lutRetouch[i] = (ret * 255).roundToInt().coerceIn(0, 255).toByte()
    }
  }

  @Synchronized
  fun process(frame: VideoFrame): VideoFrame? {
    val t0 = System.nanoTime()
    frameIdx++
    val bg = CallFx.background
    val light = CallFx.light
    val buf = frame.buffer
    val rot = ((frame.rotation % 360) + 360) % 360
    val srcW = buf.width
    val srcH = buf.height
    if (srcW < 16 || srcH < 16) return null
    var w = srcW; var h = srcH
    val longSide = max(srcW, srcH)
    if (longSide > 1280) {
      val k = 1280f / longSide
      w = ((srcW * k).toInt()) and 1.inv()
      h = ((srcH * k).toInt()) and 1.inv()
    }
    w = w and 1.inv(); h = h and 1.inv()
    val cw = w / 2; val ch = h / 2

    val full: VideoFrame.I420Buffer = (if (w != srcW || h != srcH) {
      val sc = buf.cropAndScale(0, 0, srcW, srcH, w, h)
      try { sc.toI420() } finally { sc.release() }
    } else buf.toI420()) ?: return null
    try {
      ensure(w, h)
      copyPlane(full.dataY, full.strideY, yArr, w, h)
      copyPlane(full.dataU, full.strideU, uArr, cw, ch)
      copyPlane(full.dataV, full.strideV, vArr, cw, ch)
    } finally { full.release() }

    // Light first (applies to the person; the blurred backdrop inherits it).
    when (light) {
      CallFx.LIGHT_LOW -> { applyLut(yArr, w * h, lutLow); saturate(uArr, vArr, cw * ch, 1.08f, 0, 0) }
      CallFx.LIGHT_RETOUCH -> { applyLut(yArr, w * h, lutRetouch); saturate(uArr, vArr, cw * ch, 1.04f, -2, 3) }
    }

    if (bg != CallFx.BG_NONE) {
      val ok = computeMask(buf, rot, w, h)
      if (!ok) {
        if (light == CallFx.LIGHT_NONE) return null
      } else {
        val haveBg = when {
          bg == CallFx.BG_BLUR_LIGHT -> blurBackdrop(w, h, 8)
          bg == CallFx.BG_BLUR_STRONG -> blurBackdrop(w, h, 16)
          bg == CallFx.BG_CUSTOM || bg.startsWith("wp:") -> imageBackdrop(bg, w, h, rot)
          else -> false
        }
        if (haveBg) blend(w, h)
      }
    }

    val out = JavaI420Buffer.allocate(w, h)
    putPlane(out.dataY, out.strideY, yArr, w, h)
    putPlane(out.dataU, out.strideU, uArr, cw, ch)
    putPlane(out.dataV, out.strideV, vArr, cw, ch)

    val ms = (System.nanoTime() - t0) / 1e6
    emaMs = if (emaMs == 0.0) ms else emaMs * 0.9 + ms * 0.1
    segEvery = if (emaMs > 30 || CallFx.thermalModerate) 2 else if (emaMs < 22) 1 else segEvery
    if (frameIdx % 300L == 0L) Log.d(TAG, "frame ${w}x$h ema=${"%.1f".format(emaMs)}ms segEvery=$segEvery bg=$bg light=$light")
    return VideoFrame(out, frame.rotation, frame.timestampNs)
  }

  private fun ensure(w: Int, h: Int) {
    val n = w * h; val c = (w / 2) * (h / 2)
    if (yArr.size != n) { yArr = ByteArray(n); bY = ByteArray(n); fullMask = ByteArray(n) }
    if (uArr.size != c) { uArr = ByteArray(c); vArr = ByteArray(c); bU = ByteArray(c); bV = ByteArray(c) }
  }

  private fun copyPlane(src: ByteBuffer, stride: Int, dst: ByteArray, w: Int, h: Int) {
    val b = src.duplicate()
    if (stride == w) { b.position(0); b.get(dst, 0, w * h); return }
    for (r in 0 until h) { b.position(r * stride); b.get(dst, r * w, w) }
  }

  private fun putPlane(dst: ByteBuffer, stride: Int, src: ByteArray, w: Int, h: Int) {
    val b = dst.duplicate()
    if (stride == w) { b.position(0); b.put(src, 0, w * h); return }
    for (r in 0 until h) { b.position(r * stride); b.put(src, r * w, w) }
  }

  private fun applyLut(a: ByteArray, n: Int, lut: ByteArray) {
    for (i in 0 until n) a[i] = lut[a[i].toInt() and 0xFF]
  }

  private fun saturate(u: ByteArray, v: ByteArray, n: Int, k: Float, du: Int, dv: Int) {
    val ki = (k * 256).toInt()
    for (i in 0 until n) {
      val uu = (((u[i].toInt() and 0xFF) - 128) * ki shr 8) + 128 + du
      val vv = (((v[i].toInt() and 0xFF) - 128) * ki shr 8) + 128 + dv
      u[i] = uu.coerceIn(16, 240).toByte()
      v[i] = vv.coerceIn(16, 240).toByte()
    }
  }

  // ─── segmentation ─────────────────────────────────────────────────────

  private fun ensureSegmenter(): ImageSegmenter? {
    segmenter?.let { return it }
    if (segInitTried) return null
    segInitTried = true
    val ctx = CallFx.context() ?: return null
    return try {
      val base = BaseOptions.builder().setModelAssetPath("selfie_segmenter.tflite").build()
      val opts = ImageSegmenter.ImageSegmenterOptions.builder()
        .setBaseOptions(base)
        .setRunningMode(RunningMode.VIDEO)
        .setOutputConfidenceMasks(true)
        .setOutputCategoryMask(false)
        .build()
      ImageSegmenter.createFromOptions(ctx, opts).also { segmenter = it; Log.i(TAG, "segmenter ready") }
    } catch (t: Throwable) {
      Log.w(TAG, "segmenter init failed: ${t.message}")
      null
    }
  }

  /** Fills [fullMask] (w×h, buffer space, 255 = person). */
  private fun computeMask(buf: VideoFrame.Buffer, rot: Int, w: Int, h: Int): Boolean {
    val reuse = segEvery > 1 && (frameIdx % segEvery) != 0L && smallMaskW > 0
    if (!reuse) {
      if (!segmentSmall(buf, rot)) return false
    }
    if (smallMaskW == 0) return false
    // Upscale small mask → full (bilinear, native).
    var sm = maskBmpSmall
    if (sm == null || sm.width != smallMaskW || sm.height != smallMaskH) {
      sm = Bitmap.createBitmap(smallMaskW, smallMaskH, Bitmap.Config.ALPHA_8)
      maskBmpSmall = sm
    }
    // ALPHA_8 rows may be padded.
    val rb = sm!!.rowBytes
    val tmp = ByteBuffer.allocateDirect(rb * smallMaskH)
    for (r in 0 until smallMaskH) { tmp.position(r * rb); tmp.put(smallMask, r * smallMaskW, smallMaskW) }
    tmp.rewind()
    sm.copyPixelsFromBuffer(tmp)
    var fm = maskBmpFull
    if (fm == null || fm.width != w || fm.height != h) {
      fm = Bitmap.createBitmap(w, h, Bitmap.Config.ALPHA_8)
      maskBmpFull = fm
      maskReadBuf = ByteBuffer.allocateDirect(fm.rowBytes * h)
    }
    fm!!.eraseColor(Color.TRANSPARENT)
    Canvas(fm).drawBitmap(sm, Rect(0, 0, smallMaskW, smallMaskH), Rect(0, 0, w, h), maskPaint)
    val rd = maskReadBuf!!
    rd.rewind()
    fm.copyPixelsToBuffer(rd)
    val frb = fm.rowBytes
    if (frb == w) { rd.position(0); rd.get(fullMask, 0, w * h) }
    else for (r in 0 until h) { rd.position(r * frb); rd.get(fullMask, r * w, w) }
    return true
  }

  private fun segmentSmall(buf: VideoFrame.Buffer, rot: Int): Boolean {
    val seg = ensureSegmenter() ?: return false
    val bw = buf.width; val bh = buf.height
    val k = SEG_LONG.toFloat() / max(bw, bh)
    val sw = max(16, ((bw * k).toInt()) and 1.inv())
    val sh = max(16, ((bh * k).toInt()) and 1.inv())
    val sc = buf.cropAndScale(0, 0, bw, bh, sw, sh)
    val si = try { sc.toI420() } finally { sc.release() } ?: return false
    val argb = IntArray(sw * sh)
    try {
      val y = si.dataY.duplicate(); val u = si.dataU.duplicate(); val v = si.dataV.duplicate()
      val sy = si.strideY; val su = si.strideU; val sv = si.strideV
      for (r in 0 until sh) {
        for (c in 0 until sw) {
          val yy = (y.get(r * sy + c).toInt() and 0xFF) - 16
          val uu = (u.get((r shr 1) * su + (c shr 1)).toInt() and 0xFF) - 128
          val vv = (v.get((r shr 1) * sv + (c shr 1)).toInt() and 0xFF) - 128
          val yc = 298 * max(0, yy)
          val rr = ((yc + 409 * vv + 128) shr 8).coerceIn(0, 255)
          val gg = ((yc - 100 * uu - 208 * vv + 128) shr 8).coerceIn(0, 255)
          val bb = ((yc + 516 * uu + 128) shr 8).coerceIn(0, 255)
          argb[r * sw + c] = (0xFF shl 24) or (rr shl 16) or (gg shl 8) or bb
        }
      }
    } finally { si.release() }
    val small = Bitmap.createBitmap(argb, sw, sh, Bitmap.Config.ARGB_8888)
    val upright = if (rot == 0) small else {
      val m = Matrix().apply { postRotate(rot.toFloat()) }
      Bitmap.createBitmap(small, 0, 0, sw, sh, m, false)
    }
    val uw = upright.width; val uh = upright.height
    var ts = System.nanoTime() / 1_000_000L
    if (ts <= lastSegTsMs) ts = lastSegTsMs + 1
    lastSegTsMs = ts
    val mp = BitmapImageBuilder(upright).build()
    try {
      val res = seg.segmentForVideo(mp, ts)
      val masks = res.confidenceMasks()
      if (!masks.isPresent || masks.get().isEmpty()) return false
      val list = masks.get()
      val mImg = if (list.size >= 2) list[1] else list[0]
      val fb = ByteBufferExtractor.extract(mImg).order(ByteOrder.nativeOrder()).asFloatBuffer()
      val mw = mImg.width; val mh = mImg.height
      if (mw != uw || mh != uh || fb.remaining() < mw * mh) { for (x in list) try { x.close() } catch (_: Throwable) {}; return false }
      if (list.size == 1) votePolarity(fb, mw, mh)
      val invert = list.size == 1 && polarity < 0
      if (smallMask.size != sw * sh) {
        smallMask = ByteArray(sw * sh); smallMaskPrev = ByteArray(sw * sh)
      }
      val havePrev = smallMaskW == sw && smallMaskH == sh
      // Map buffer-space (c, r) → upright (ux, uy): upright = buffer rotated `rot` CW.
      for (r in 0 until sh) {
        for (c in 0 until sw) {
          val ux: Int; val uy: Int
          when (rot) {
            90 -> { ux = sh - 1 - r; uy = c }
            180 -> { ux = sw - 1 - c; uy = sh - 1 - r }
            270 -> { ux = r; uy = sw - 1 - c }
            else -> { ux = c; uy = r }
          }
          var p = fb.get(uy * mw + ux)
          if (invert) p = 1f - p
          // Soft threshold → crisper edge, fewer halos.
          val q = ((p - 0.25f) / 0.5f).coerceIn(0f, 1f)
          val cur = (q * 255f).toInt()
          val i = r * sw + c
          val outV = if (havePrev) (cur * 6 + (smallMaskPrev[i].toInt() and 0xFF) * 4) / 10 else cur
          smallMask[i] = outV.toByte()
        }
      }
      System.arraycopy(smallMask, 0, smallMaskPrev, 0, sw * sh)
      smallMaskW = sw; smallMaskH = sh
      for (x in list) try { x.close() } catch (_: Throwable) {}
      return true
    } catch (t: Throwable) {
      Log.w(TAG, "segment failed: ${t.message}")
      return false
    } finally {
      try { mp.close() } catch (_: Throwable) {}
      if (upright !== small) upright.recycle()
      small.recycle()
    }
  }

  /** Single-output model: decide once whether the mask is "person" (centre high). */
  private fun votePolarity(fb: java.nio.FloatBuffer, w: Int, h: Int) {
    if (polarity != 0 && polarityVotes >= 8) return
    var centre = 0f; var nc = 0
    var border = 0f; var nb = 0
    for (y in 0 until h step 4) for (x in 0 until w step 4) {
      val v = fb.get(y * w + x)
      val cx = abs(x - w / 2) < w / 5 && y > h / 3
      val edge = x < w / 10 || x > w - w / 10 || y < h / 12
      if (cx) { centre += v; nc++ } else if (edge) { border += v; nb++ }
    }
    if (nc == 0 || nb == 0) return
    val d = centre / nc - border / nb
    if (abs(d) < 0.2f) return
    val vote = if (d > 0) 1 else -1
    if (polarity == vote) polarityVotes++ else { polarity = vote; polarityVotes = 1 }
  }

  // ─── backdrops (fill bY/bU/bV, buffer space) ──────────────────────────

  private fun blurBackdrop(w: Int, h: Int, factor: Int): Boolean {
    val cw = w / 2; val ch = h / 2
    val sw = max(8, (w / factor) and 1.inv()); val sh = max(8, (h / factor) and 1.inv())
    // Downscale the (already light-filtered) person frame.
    val src = JavaI420Buffer.allocate(w, h)
    try {
      putPlane(src.dataY, src.strideY, yArr, w, h)
      putPlane(src.dataU, src.strideU, uArr, cw, ch)
      putPlane(src.dataV, src.strideV, vArr, cw, ch)
      val small = src.cropAndScale(0, 0, w, h, sw, sh) as VideoFrame.I420Buffer
      try {
        val ys = ByteArray(sw * sh); val us = ByteArray((sw / 2) * (sh / 2)); val vs = ByteArray((sw / 2) * (sh / 2))
        copyPlane(small.dataY, small.strideY, ys, sw, sh)
        copyPlane(small.dataU, small.strideU, us, sw / 2, sh / 2)
        copyPlane(small.dataV, small.strideV, vs, sw / 2, sh / 2)
        val passes = if (factor >= 16) 3 else 2
        repeat(passes) { boxBlur(ys, sw, sh); boxBlur(us, sw / 2, sh / 2); boxBlur(vs, sw / 2, sh / 2) }
        val tiny = JavaI420Buffer.allocate(sw, sh)
        try {
          putPlane(tiny.dataY, tiny.strideY, ys, sw, sh)
          putPlane(tiny.dataU, tiny.strideU, us, sw / 2, sh / 2)
          putPlane(tiny.dataV, tiny.strideV, vs, sw / 2, sh / 2)
          val up = tiny.cropAndScale(0, 0, sw, sh, w, h) as VideoFrame.I420Buffer
          try {
            copyPlane(up.dataY, up.strideY, bY, w, h)
            copyPlane(up.dataU, up.strideU, bU, cw, ch)
            copyPlane(up.dataV, up.strideV, bV, cw, ch)
          } finally { up.release() }
        } finally { tiny.release() }
      } finally { small.release() }
    } finally { src.release() }
    return true
  }

  /** 3×3 box blur in place (separable). */
  private fun boxBlur(a: ByteArray, w: Int, h: Int) {
    if (w < 3 || h < 3) return
    val t = IntArray(w * h)
    for (y in 0 until h) {
      val o = y * w
      for (x in 0 until w) {
        val l = a[o + max(0, x - 1)].toInt() and 0xFF
        val c = a[o + x].toInt() and 0xFF
        val r = a[o + min(w - 1, x + 1)].toInt() and 0xFF
        t[o + x] = l + c + r
      }
    }
    for (y in 0 until h) {
      val up = max(0, y - 1) * w; val o = y * w; val dn = min(h - 1, y + 1) * w
      for (x in 0 until w) a[o + x] = ((t[up + x] + t[o + x] + t[dn + x]) / 9).toByte()
    }
  }

  private fun imageBackdrop(key: String, w: Int, h: Int, rot: Int): Boolean {
    val ver = if (key == CallFx.BG_CUSTOM) CallFx.customVersion else 0
    val cacheKey = "$key/$ver@${w}x$h/$rot"
    if (cacheKey != wpKey) {
      val uw = if (rot == 90 || rot == 270) h else w
      val uh = if (rot == 90 || rot == 270) w else h
      val upright: Bitmap = if (key == CallFx.BG_CUSTOM) {
        customUpright(uw, uh, ver) ?: return false
      } else {
        val i = key.removePrefix("wp:").toIntOrNull() ?: return false
        CallFxWallpapers.render(i, uw, uh)
      }
      val inBuf = if (rot == 0) upright else {
        val m = Matrix().apply { postRotate(-rot.toFloat()) }
        Bitmap.createBitmap(upright, 0, 0, uw, uh, m, true)
      }
      if (inBuf.width != w || inBuf.height != h) { if (inBuf !== upright) inBuf.recycle(); upright.recycle(); return false }
      val rgba = ByteBuffer.allocateDirect(w * h * 4)
      val argbBmp = if (inBuf.config == Bitmap.Config.ARGB_8888) inBuf else inBuf.copy(Bitmap.Config.ARGB_8888, false)
      argbBmp.copyPixelsToBuffer(rgba)
      rgba.rewind()
      val cw = w / 2; val ch = h / 2
      val dy = ByteBuffer.allocateDirect(w * h); val du = ByteBuffer.allocateDirect(cw * ch); val dv = ByteBuffer.allocateDirect(cw * ch)
      // Android ARGB_8888 memory order = R,G,B,A = libyuv "ABGR".
      YuvHelper.ABGRToI420(rgba, w * 4, dy, w, du, cw, dv, cw, w, h)
      if (wpY.size != w * h) wpY = ByteArray(w * h)
      if (wpU.size != cw * ch) { wpU = ByteArray(cw * ch); wpV = ByteArray(cw * ch) }
      dy.rewind(); dy.get(wpY); du.rewind(); du.get(wpU); dv.rewind(); dv.get(wpV)
      if (argbBmp !== inBuf) argbBmp.recycle()
      if (inBuf !== upright) inBuf.recycle()
      upright.recycle()
      wpKey = cacheKey
    }
    System.arraycopy(wpY, 0, bY, 0, w * h)
    System.arraycopy(wpU, 0, bU, 0, wpU.size)
    System.arraycopy(wpV, 0, bV, 0, wpV.size)
    return true
  }

  private fun customUpright(uw: Int, uh: Int, ver: Int): Bitmap? {
    val ctx = CallFx.context() ?: return null
    if (customSrc == null || customSrcVer != ver) {
      customSrc?.recycle()
      customSrc = try { BitmapFactory.decodeFile(CallFx.customFile(ctx).absolutePath) } catch (_: Throwable) { null }
      customSrcVer = ver
    }
    val s = customSrc ?: return null
    val out = Bitmap.createBitmap(uw, uh, Bitmap.Config.ARGB_8888)
    // Aspect-fill + centre.
    val k = max(uw.toFloat() / s.width, uh.toFloat() / s.height)
    val cwSrc = (uw / k).toInt().coerceIn(1, s.width); val chSrc = (uh / k).toInt().coerceIn(1, s.height)
    val l = (s.width - cwSrc) / 2; val t = (s.height - chSrc) / 2
    Canvas(out).drawBitmap(s, Rect(l, t, l + cwSrc, t + chSrc), Rect(0, 0, uw, uh), Paint(Paint.FILTER_BITMAP_FLAG))
    return out
  }

  // ─── blend person (yArr/uArr/vArr) over backdrop with fullMask ────────

  private fun blend(w: Int, h: Int) {
    val n = w * h
    for (i in 0 until n) {
      val m0 = fullMask[i].toInt() and 0xFF
      if (m0 == 255) continue
      val a = m0 + (m0 shr 7)
      val p = yArr[i].toInt() and 0xFF
      val b = bY[i].toInt() and 0xFF
      yArr[i] = ((p * a + b * (256 - a)) shr 8).toByte()
    }
    val cw = w / 2; val ch = h / 2
    for (cy in 0 until ch) {
      val mrow = (cy * 2) * w
      val crow = cy * cw
      for (cx in 0 until cw) {
        val m0 = fullMask[mrow + cx * 2].toInt() and 0xFF
        if (m0 == 255) continue
        val a = m0 + (m0 shr 7)
        val j = crow + cx
        uArr[j] = (((uArr[j].toInt() and 0xFF) * a + (bU[j].toInt() and 0xFF) * (256 - a)) shr 8).toByte()
        vArr[j] = (((vArr[j].toInt() and 0xFF) * a + (bV[j].toInt() and 0xFF) * (256 - a)) shr 8).toByte()
      }
    }
  }
}

/** Built-in monochrome backgrounds, drawn on device (same designs as iOS). */
object CallFxWallpapers {
  private class Rng(var s: Int) {
    fun next(): Float {
      s = s * 1664525 + 1013904223
      return (s ushr 8).toFloat() / (1 shl 24).toFloat()
    }
  }

  private fun gray(v: Float, a: Float = 1f): Int {
    val c = (v * 255f).roundToInt().coerceIn(0, 255)
    return Color.argb((a * 255f).roundToInt().coerceIn(0, 255), c, c, c)
  }

  fun render(index: Int, w: Int, h: Int): Bitmap {
    val bmp = Bitmap.createBitmap(max(1, w), max(1, h), Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    val W = w.toFloat(); val H = h.toFloat()
    val mn = min(W, H); val mx = max(W, H)
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    fun linear(c0: Float, c1: Float, x0: Float, y0: Float, x1: Float, y1: Float) {
      p.shader = LinearGradient(x0, y0, x1, y1, gray(c0), gray(c1), Shader.TileMode.CLAMP)
      c.drawRect(0f, 0f, W, H, p); p.shader = null
    }
    when (index) {
      0 -> {
        p.shader = RadialGradient(W * 0.5f, H * 0.42f, mx * 0.75f, gray(0.42f), gray(0.11f), Shader.TileMode.CLAMP)
        c.drawRect(0f, 0f, W, H, p); p.shader = null
      }
      1 -> {
        linear(0.93f, 0.76f, 0f, 0f, 0f, H)
        p.shader = RadialGradient(W * 0.3f, H * 0.25f, mx * 0.5f, gray(1f, 0.25f), gray(1f, 0f), Shader.TileMode.CLAMP)
        c.drawRect(0f, 0f, W, H, p); p.shader = null
      }
      2 -> linear(0.23f, 0.07f, 0f, 0f, W, H)
      3 -> {
        linear(0.14f, 0.06f, 0f, 0f, 0f, H)
        val r = Rng(7)
        repeat(22) {
          val cx = r.next() * W; val cy = r.next() * H
          val rad = mn * (0.04f + r.next() * 0.09f)
          val a = 0.05f + r.next() * 0.13f
          p.color = gray(1f, a); c.drawCircle(cx, cy, rad, p)
        }
      }
      4 -> {
        linear(0.55f, 0.42f, 0f, 0f, 0f, H)
        p.style = Paint.Style.STROKE; p.strokeWidth = max(1f, mn * 0.004f); p.color = gray(1f, 0.10f)
        val step = max(4f, mn * 0.035f)
        var x = -H
        while (x < W) { c.drawLine(x, H, x + H, 0f, p); x += step }
        p.style = Paint.Style.FILL
      }
      5 -> {
        linear(0.86f, 0.80f, 0f, 0f, W, H)
        p.style = Paint.Style.STROKE; p.strokeWidth = max(1f, mn * 0.006f); p.color = gray(0f, 0.07f)
        val step = max(6f, mx * 0.06f)
        var rad = step
        while (rad < mx * 1.6f) { c.drawCircle(0f, H, rad, p); rad += step }
        p.style = Paint.Style.FILL
      }
      6 -> {
        linear(0.62f, 0.55f, 0f, 0f, W, H)
        val r = Rng(11)
        repeat(1400) {
          val cx = r.next() * W; val cy = r.next() * H
          val rad = mx * (0.002f + r.next() * 0.008f)
          val v = r.next()
          p.color = gray(v, 0.06f); c.drawCircle(cx, cy, rad, p)
        }
      }
      else -> {
        linear(0.20f, 0.12f, 0f, 0f, 0f, H)
        p.color = gray(1f, 0.07f)
        val bw = W * 0.09f
        val path = Path()
        for (i in 0 until 5) {
          val x0 = W * (0.08f + i * 0.19f)
          path.moveTo(x0, 0f); path.lineTo(x0 + bw, 0f)
          path.lineTo(x0 + bw + W * 0.25f, H); path.lineTo(x0 + W * 0.25f, H); path.close()
        }
        c.drawPath(path, p)
      }
    }
    return bmp
  }
}
