package expo.modules.chatyywallpaper

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ComposeShader
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.RectF
import android.graphics.Shader
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.LruCache
import android.view.Choreographer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * [2026-10-15 native-wallpaper] Fundo NATIVO da conversa (nível Telegram).
 *
 *  • gradiente de 4 cores: bitmap 60×80 (algoritmo do Telegram) ampliado com
 *    filtro bilinear; recalculado só ENQUANTO anima (Choreographer, ~0,5 s por
 *    passo) — parado, nenhum quadro é redesenhado;
 *  • padrão vetorial: azulejo desenhado uma vez → BitmapShader REPEAT. Modo
 *    'overlay' (traço por cima) ou 'mask' (escuro: o gradiente só aparece
 *    através do padrão sobre o preto — ComposeShader DST_IN, sem camada extra);
 *  • foto: download/decodificação fora da main, desfoque barato (reduz + box blur);
 *  • paralaxe: sensor de gravidade, só com motion=true e sem "Remover animações".
 */
class ChatyyWallpaperView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), SensorEventListener {

  private val density = resources.displayMetrics.density

  // props
  private var rgb: IntArray = IntArray(0)
  private var colorsKey = ""
  private var baseColor = Color.TRANSPARENT
  private var pattern: WPPattern? = null
  private var patternKey = ""
  private var patternIntensity = 0.1f
  private var patternMask = false
  private var patternColor = Color.BLACK
  private var patternColorKey = "#000000"
  private var patternScale = 1f
  private var imageUri = ""
  private var blur = 0f
  private var dim = 0f
  private var motion = false
  private var animate = true
  private var autoplayMs = 0.0

  private var dirtyGradient = true
  private var dirtyPattern = true
  private var dirtyImage = true
  private var dirtyMotion = true

  // gradiente
  private val gw = 60
  private val gh = 80
  private val gradPixels = IntArray(gw * gh)
  private val gradBitmap: Bitmap = Bitmap.createBitmap(gw, gh, Bitmap.Config.ARGB_8888)
  private var hasGradient = false
  private var phase = 0
  private var cur: FloatArray = positions(0)
  private var from: FloatArray = cur
  private var to: FloatArray = cur
  private var animStart = 0L
  private val animMs = 500L
  private var animating = false

  // desenho
  private val gradPaint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
  private val patternPaint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val maskPaint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val imagePaint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val dimPaint = Paint()
  private var gradShader: BitmapShader? = null
  private var tileShader: BitmapShader? = null
  private val gradMatrix = Matrix()
  private val imageMatrix = Matrix()
  private val rect = RectF()
  private var image: Bitmap? = null
  private var loadedImageKey = ""

  // paralaxe
  private val pad = 18f * density
  private var motionActive = false
  private var sensorOn = false
  private var offX = 0f
  private var offY = 0f
  private var tgtX = 0f
  private var tgtY = 0f

  private var scrollAcc = 0f
  private val handler = Handler(Looper.getMainLooper())
  private val autoRunnable = object : Runnable {
    override fun run() {
      step()
      if (autoplayMs >= 400 && isAttachedToWindow) handler.postDelayed(this, autoplayMs.toLong())
    }
  }
  private val frameCb = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) { tick() }
  }

  init {
    setWillNotDraw(false)
    isClickable = false
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    dimPaint.color = Color.BLACK
  }

  // ── props ────────────────────────────────────────────────────────────────

  fun setColors(v: List<String>) {
    val list = v.take(4)
    val key = list.joinToString(",")
    if (key == colorsKey) return
    colorsKey = key
    rgb = IntArray(list.size) { parseColor(list[it]) }
    dirtyGradient = true
  }
  fun setBaseColor(v: String?) { baseColor = if (v.isNullOrEmpty()) Color.TRANSPARENT else parseColor(v) }
  fun setPattern(v: Map<String, Any?>?) {
    val key = (v?.get("key") as? String) ?: (if (v == null) "" else "p" + ((v["items"] as? List<*>)?.size ?: 0))
    if (key == patternKey && (v == null) == (pattern == null)) return
    patternKey = key
    pattern = if (v == null) null else WPPattern.from(v)
    dirtyPattern = true
  }
  fun setPatternIntensity(v: Double) {
    val c = v.toFloat().coerceIn(0f, 1f)
    if (c != patternIntensity) { patternIntensity = c; dirtyPattern = true }
  }
  fun setPatternMode(v: String?) {
    val m = v == "mask"
    if (m != patternMask) { patternMask = m; dirtyPattern = true }
  }
  fun setPatternColor(v: String?) {
    val k = v ?: "#000000"
    if (k != patternColorKey) { patternColorKey = k; patternColor = parseColor(k); dirtyPattern = true }
  }
  fun setPatternScale(v: Double) {
    val s = v.toFloat().coerceIn(0.2f, 3f)
    if (s != patternScale) { patternScale = s; dirtyPattern = true }
  }
  fun setImageUri(v: String?) {
    val u = v ?: ""
    if (u != imageUri) { imageUri = u; dirtyImage = true }
  }
  fun setBlur(v: Double) {
    val b = v.toFloat().coerceIn(0f, 60f)
    if (b != blur) { blur = b; dirtyImage = true }
  }
  fun setDim(v: Double) { dim = v.toFloat().coerceIn(0f, 0.9f) }
  fun setMotion(v: Boolean) { if (v != motion) { motion = v; dirtyMotion = true } }
  fun setAnimate(v: Boolean) { animate = v }
  fun setAutoplay(v: Double) {
    val ms = max(0.0, v)
    if (ms != autoplayMs) { autoplayMs = ms; updateAutoplay() }
  }

  fun commitProps() {
    if (dirtyGradient) { dirtyGradient = false; renderGradient() }
    if (dirtyPattern) { dirtyPattern = false; buildPattern() }
    if (dirtyImage) { dirtyImage = false; loadImage() }
    if (dirtyMotion) { dirtyMotion = false; applyMotion() }
    invalidate()
  }

  // ── ciclo de vida ──────────────────────────────────────────────────────────

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    applyMotion()
    updateAutoplay()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    stopSensor()
    handler.removeCallbacks(autoRunnable)
    if (animating) {
      animating = false
      Choreographer.getInstance().removeFrameCallback(frameCb)
      cur = to
      renderGradient()
    }
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    updateMatrices()
  }

  private fun reduceMotion(): Boolean = try {
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
  } catch (_: Throwable) { false }

  // ── gradiente ──────────────────────────────────────────────────────────────

  private fun renderGradient() {
    val n = min(rgb.size, 4)
    if (n == 0) { hasGradient = false; return }
    hasGradient = true
    if (n == 1) {
      java.util.Arrays.fill(gradPixels, rgb[0] or 0xFF000000.toInt())
    } else {
      fillGradient(gradPixels, gw, gh, rgb, n, cur)
    }
    gradBitmap.setPixels(gradPixels, 0, gw, 0, 0, gw, gh)
    if (gradShader == null) {
      gradShader = BitmapShader(gradBitmap, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
      updateMatrices()
      rebuildMaskShader()
    }
  }

  private fun canStepGradient(): Boolean = animate && rgb.size >= 2 && isAttachedToWindow && !reduceMotion()

  fun step() {
    if (!canStepGradient()) return
    phase = (phase + 1) % 8
    from = cur.copyOf()
    to = positions(phase)
    animStart = SystemClock.uptimeMillis()
    if (!animating) {
      animating = true
      Choreographer.getInstance().postFrameCallback(frameCb)
    }
  }

  fun scrollBy(dy: Float) {
    scrollAcc += abs(dy)
    if (scrollAcc >= 420f) { scrollAcc = 0f; step() }
  }

  private fun tick() {
    if (!animating) return
    val t = min(1f, (SystemClock.uptimeMillis() - animStart).toFloat() / animMs)
    val e = if (t < 0.5f) 2f * t * t else 1f - (-2f * t + 2f).pow(2) / 2f
    val next = FloatArray(8)
    for (i in 0 until 8) next[i] = from[i] + (to[i] - from[i]) * e
    cur = next
    renderGradient()
    invalidate()
    if (t >= 1f) {
      animating = false
      cur = to
    } else {
      Choreographer.getInstance().postFrameCallback(frameCb)
    }
  }

  private fun updateAutoplay() {
    handler.removeCallbacks(autoRunnable)
    if (autoplayMs >= 400 && isAttachedToWindow) handler.postDelayed(autoRunnable, autoplayMs.toLong())
  }

  // ── padrão ─────────────────────────────────────────────────────────────────

  private fun buildPattern() {
    val p = pattern
    if (p == null || patternIntensity <= 0.001f) {
      tileShader = null
      rebuildMaskShader()
      return
    }
    val color = if (patternMask) Color.WHITE else {
      Color.argb((patternIntensity * 255).toInt().coerceIn(0, 255), Color.red(patternColor), Color.green(patternColor), Color.blue(patternColor))
    }
    val ck = "$patternKey|${if (patternMask) 1 else 0}|$color|$patternScale|$density"
    var tile = tileCache.get(ck)
    if (tile == null || tile.isRecycled) {
      tile = p.tileBitmap(color, patternScale * density)
      if (tile != null) tileCache.put(ck, tile)
    }
    tileShader = tile?.let { BitmapShader(it, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT) }
    patternPaint.shader = tileShader
    rebuildMaskShader()
  }

  private fun rebuildMaskShader() {
    val g = gradShader
    val t = tileShader
    maskPaint.shader = if (patternMask && g != null && t != null) ComposeShader(g, t, PorterDuff.Mode.DST_IN) else null
  }

  private fun updateMatrices() {
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    val ext = if (motionActive) pad else 0f
    gradMatrix.reset()
    gradMatrix.setScale((w + ext * 2) / gw, (h + ext * 2) / gh)
    gradMatrix.postTranslate(-ext, -ext)
    gradShader?.setLocalMatrix(gradMatrix)
    gradPaint.shader = gradShader
    image?.let { fitImage(it) }
  }

  // ── foto ───────────────────────────────────────────────────────────────────

  private fun loadImage() {
    val uri = imageUri
    val b = blur
    val key = "$uri|${b.toInt()}"
    if (uri.isEmpty()) { loadedImageKey = ""; image = null; return }
    if (key == loadedImageKey) return
    loadedImageKey = key
    val hit = imageCache.get(key)
    if (hit != null && !hit.isRecycled) { image = hit; fitImage(hit); return }
    io.execute {
      val bmp = try { decode(uri, 1400) } catch (_: Throwable) { null } ?: return@execute
      val out = if (b > 0f) (try { blurBitmap(bmp, b) } catch (_: Throwable) { bmp }) else bmp
      imageCache.put(key, out)
      handler.post {
        if (loadedImageKey == key) { image = out; fitImage(out); invalidate() }
      }
    }
  }

  private fun fitImage(bmp: Bitmap) {
    val ext = if (motionActive) pad else 0f
    val w = width + ext * 2
    val h = height + ext * 2
    if (w <= 0f || h <= 0f) return
    val s = max(w / bmp.width, h / bmp.height)
    imageMatrix.reset()
    imageMatrix.setScale(s, s)
    imageMatrix.postTranslate((w - bmp.width * s) / 2f - ext, (h - bmp.height * s) / 2f - ext)
  }

  // ── paralaxe ───────────────────────────────────────────────────────────────

  private fun applyMotion() {
    val on = motion && !reduceMotion()
    if (on != motionActive) {
      motionActive = on
      updateMatrices()
    }
    if (on && isAttachedToWindow) startSensor() else stopSensor()
    if (!on) { offX = 0f; offY = 0f; tgtX = 0f; tgtY = 0f }
    invalidate()
  }

  private fun startSensor() {
    if (sensorOn) return
    val sm = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
    val s = sm.getDefaultSensor(Sensor.TYPE_GRAVITY) ?: sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
    sensorOn = sm.registerListener(this, s, SensorManager.SENSOR_DELAY_GAME)
  }

  private fun stopSensor() {
    if (!sensorOn) return
    sensorOn = false
    (context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager)?.unregisterListener(this)
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (!motionActive) return
    val gx = (event.values[0] / 9.81f).coerceIn(-1f, 1f)
    val gy = ((event.values[1] / 9.81f) - 0.7f).coerceIn(-1f, 1f) // aparelho em pé ≈ gy 0,7
    tgtX = (gx * pad * 1.6f).coerceIn(-pad, pad)
    tgtY = (-gy * pad * 1.6f).coerceIn(-pad, pad)
    val nx = offX + (tgtX - offX) * 0.15f
    val ny = offY + (tgtY - offY) * 0.15f
    if (abs(nx - offX) > 0.25f || abs(ny - offY) > 0.25f) {
      offX = nx; offY = ny
      invalidate()
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  // ── desenho ────────────────────────────────────────────────────────────────

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    if (Color.alpha(baseColor) != 0) canvas.drawColor(baseColor)
    val save = canvas.save()
    canvas.clipRect(0f, 0f, w, h)
    if (motionActive) canvas.translate(offX, offY)
    val ext = if (motionActive) pad else 0f
    rect.set(-ext, -ext, w + ext, h + ext)

    val img = image
    if (img != null && !img.isRecycled && imageUri.isNotEmpty()) {
      canvas.drawBitmap(img, imageMatrix, imagePaint)
    }
    if (hasGradient) {
      if (patternMask && maskPaint.shader != null) {
        maskPaint.alpha = (patternIntensity * 255).toInt().coerceIn(0, 255)
        canvas.drawRect(rect, maskPaint)
      } else if (!patternMask) {
        canvas.drawRect(rect, gradPaint)
      }
    }
    if (!patternMask && tileShader != null) canvas.drawRect(rect, patternPaint)
    if (dim > 0.001f) {
      dimPaint.alpha = (dim * 255).toInt().coerceIn(0, 255)
      canvas.drawRect(rect, dimPaint)
    }
    canvas.restoreToCount(save)
  }

  companion object {
    private val io = Executors.newFixedThreadPool(2)
    private val tileCache = object : LruCache<String, Bitmap>(16 * 1024 * 1024) {
      override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    private val imageCache = object : LruCache<String, Bitmap>(28 * 1024 * 1024) {
      override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    private val BASE = floatArrayOf(
      0.80f, 0.10f, 0.60f, 0.20f, 0.35f, 0.25f, 0.25f, 0.60f,
      0.20f, 0.90f, 0.40f, 0.80f, 0.65f, 0.75f, 0.75f, 0.40f,
    )

    /** 4 pontos (x,y intercalados) da fase — igual ao iOS. */
    fun positions(phase: Int): FloatArray {
      val out = FloatArray(8)
      for (i in 0 until 4) {
        val k = ((phase + i * 2) % 8 + 8) % 8
        out[i * 2] = BASE[k * 2]
        out[i * 2 + 1] = BASE[k * 2 + 1]
      }
      return out
    }

    /** Algoritmo do gradiente do Telegram (redemoinho + soma por distância^4). */
    fun fillGradient(px: IntArray, w: Int, h: Int, rgb: IntArray, n: Int, pos: FloatArray) {
      for (y in 0 until h) {
        val cdy = y.toFloat() / h - 0.5f
        val cdy2 = cdy * cdy
        for (x in 0 until w) {
          val cdx = x.toFloat() / w - 0.5f
          val cd = sqrt(cdx * cdx + cdy2)
          val swirl = 0.35f * cd
          val theta = swirl * swirl * 0.8f * 8f
          val st = sin(theta)
          val ct = cos(theta)
          val pxv = (0.5f + cdx * ct - cdy * st).coerceIn(0f, 1f)
          val pyv = (0.5f + cdx * st + cdy * ct).coerceIn(0f, 1f)
          var sum = 0f; var r = 0f; var g = 0f; var b = 0f
          for (i in 0 until n) {
            val dx = pxv - pos[i * 2]
            val dy = pyv - pos[i * 2 + 1]
            var d = max(0f, 0.9f - sqrt(dx * dx + dy * dy))
            d = d * d * d * d
            sum += d
            val c = rgb[i]
            r += d * Color.red(c); g += d * Color.green(c); b += d * Color.blue(c)
          }
          if (sum < 0.00001f) sum = 0.00001f
          px[y * w + x] = Color.rgb((r / sum).toInt().coerceIn(0, 255), (g / sum).toInt().coerceIn(0, 255), (b / sum).toInt().coerceIn(0, 255))
        }
      }
    }

    fun parseColor(s: String): Int {
      var h = s.trim().removePrefix("#")
      if (h.length == 3) h = h.map { "$it$it" }.joinToString("")
      val v = h.take(6).toLongOrNull(16) ?: 0L
      return (0xFF000000L or v).toInt()
    }

    private fun decode(uri: String, maxPx: Int): Bitmap? {
      val bytes: ByteArray = if (uri.startsWith("file://") || uri.startsWith("/")) {
        File(uri.removePrefix("file://")).readBytes()
      } else {
        val c = URL(uri).openConnection() as HttpURLConnection
        c.connectTimeout = 15000
        c.readTimeout = 20000
        try { c.inputStream.use { it.readBytes() } } finally { c.disconnect() }
      }
      val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
      var sample = 1
      while (max(o.outWidth, o.outHeight) / (sample * 2) >= maxPx) sample *= 2
      val o2 = BitmapFactory.Options().apply { inSampleSize = sample }
      return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o2)
    }

    /** Desfoque barato: reduz (fator ∝ raio), 3 passes de box blur, devolve pequeno
     *  (o desenho amplia com filtro bilinear = suave). */
    private fun blurBitmap(src: Bitmap, radiusDp: Float): Bitmap {
      val factor = (radiusDp / 3f).coerceIn(2f, 12f)
      val w = max(8, (src.width / factor).toInt())
      val h = max(8, (src.height / factor).toInt())
      val small = Bitmap.createScaledBitmap(src, w, h, true).copy(Bitmap.Config.ARGB_8888, true)
      val px = IntArray(w * h)
      small.getPixels(px, 0, w, 0, 0, w, h)
      val tmp = IntArray(w * h)
      repeat(3) {
        boxPass(px, tmp, w, h, 2, true)
        boxPass(tmp, px, w, h, 2, false)
      }
      small.setPixels(px, 0, w, 0, 0, w, h)
      return small
    }

    private fun boxPass(src: IntArray, dst: IntArray, w: Int, h: Int, r: Int, horizontal: Boolean) {
      val len = if (horizontal) w else h
      val lines = if (horizontal) h else w
      val div = r * 2 + 1
      for (l in 0 until lines) {
        var sr = 0; var sg = 0; var sb = 0
        fun idx(i: Int): Int {
          val c = i.coerceIn(0, len - 1)
          return if (horizontal) l * w + c else c * w + l
        }
        for (i in -r..r) { val c = src[idx(i)]; sr += (c shr 16) and 255; sg += (c shr 8) and 255; sb += c and 255 }
        for (i in 0 until len) {
          dst[idx(i)] = (0xFF shl 24) or ((sr / div) shl 16) or ((sg / div) shl 8) or (sb / div)
          val a = src[idx(i - r)]; val b = src[idx(i + r + 1)]
          sr += ((b shr 16) and 255) - ((a shr 16) and 255)
          sg += ((b shr 8) and 255) - ((a shr 8) and 255)
          sb += (b and 255) - (a and 255)
        }
      }
    }
  }
}

/** Padrão vetorial: glifos (caixa 24×24) espalhados num azulejo T×T. */
class WPPattern(val tile: Float, val stroke: Float, val items: List<Item>) {
  class Item(val path: Path, val x: Float, val y: Float, val s: Float, val r: Float)

  /** Azulejo em px (T = tile × pxPerUnit); glifos também nas posições ±T (sem emendas). */
  fun tileBitmap(color: Int, pxPerUnit: Float): Bitmap? {
    val t = (tile * pxPerUnit).toInt()
    if (t < 4 || t > 4096) return null
    val bmp = Bitmap.createBitmap(t, t, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
      this.color = color
    }
    for (it in items) {
      for (ox in -1..1) for (oy in -1..1) {
        val cx = it.x + ox * tile
        val cy = it.y + oy * tile
        val reach = 18f * it.s
        if (cx < -reach || cy < -reach || cx > tile + reach || cy > tile + reach) continue
        val sv = c.save()
        c.translate(cx * pxPerUnit, cy * pxPerUnit)
        c.rotate(it.r)
        c.scale(it.s * pxPerUnit, it.s * pxPerUnit)
        c.translate(-12f, -12f)
        p.strokeWidth = stroke / it.s
        c.drawPath(it.path, p)
        c.restoreToCount(sv)
      }
    }
    return bmp
  }

  companion object {
    fun from(m: Map<String, Any?>): WPPattern? {
      val tile = (m["tile"] as? Number)?.toFloat() ?: 300f
      if (tile < 40f || tile > 2000f) return null
      val stroke = (m["stroke"] as? Number)?.toFloat() ?: 1.5f
      val raw = m["items"] as? List<*> ?: return null
      val out = ArrayList<Item>()
      for (o in raw.take(200)) {
        val it = o as? Map<*, *> ?: continue
        val d = it["d"] as? String ?: continue
        if (d.isEmpty()) continue
        fun num(k: String, def: Float) = (it[k] as? Number)?.toFloat() ?: def
        out.add(Item(WPSvg.path(d), num("x", 0f), num("y", 0f), max(0.1f, num("s", 1f)), num("r", 0f)))
      }
      return if (out.isEmpty()) null else WPPattern(tile, stroke, out)
    }
  }
}

/** Parser mínimo de path SVG: M L H V C Q Z (absolutos e relativos). */
object WPSvg {
  fun path(d: String): Path {
    val p = Path()
    val n = d.length
    var i = 0
    var cmd = ' '
    var cx = 0f; var cy = 0f
    var sx = 0f; var sy = 0f
    var has = false

    fun isSep(ch: Char) = ch == ' ' || ch == ',' || ch == '\t' || ch == '\n' || ch == '\r'
    fun skip() { while (i < n && isSep(d[i])) i++ }
    fun num(): Float? {
      skip()
      val s = i
      if (i < n && (d[i] == '-' || d[i] == '+')) i++
      var dot = false
      while (i < n) {
        val ch = d[i]
        if (ch in '0'..'9') { i++; continue }
        if (ch == '.' && !dot) { dot = true; i++; continue }
        if ((ch == 'e' || ch == 'E') && i + 1 < n) {
          i++
          if (d[i] == '-' || d[i] == '+') i++
          continue
        }
        break
      }
      if (i == s) return null
      return d.substring(s, i).toFloatOrNull()
    }

    while (true) {
      skip()
      if (i >= n) break
      if (d[i].isLetter()) { cmd = d[i]; i++ } else if (cmd == ' ') break
      val rel = cmd.isLowerCase()
      val bx = if (rel) cx else 0f
      val by = if (rel) cy else 0f
      when (cmd) {
        'M', 'm' -> {
          val x = num() ?: return p; val y = num() ?: return p
          cx = bx + x; cy = by + y
          p.moveTo(cx, cy); sx = cx; sy = cy; has = true
          cmd = if (rel) 'l' else 'L'
        }
        'L', 'l' -> {
          val x = num() ?: return p; val y = num() ?: return p
          cx = bx + x; cy = by + y
          if (!has) { p.moveTo(cx, cy); sx = cx; sy = cy; has = true } else p.lineTo(cx, cy)
        }
        'H', 'h' -> {
          val x = num() ?: return p
          cx = (if (rel) cx else 0f) + x
          if (has) p.lineTo(cx, cy)
        }
        'V', 'v' -> {
          val y = num() ?: return p
          cy = (if (rel) cy else 0f) + y
          if (has) p.lineTo(cx, cy)
        }
        'C', 'c' -> {
          val x1 = num() ?: return p; val y1 = num() ?: return p
          val x2 = num() ?: return p; val y2 = num() ?: return p
          val x = num() ?: return p; val y = num() ?: return p
          if (has) p.cubicTo(bx + x1, by + y1, bx + x2, by + y2, bx + x, by + y)
          cx = bx + x; cy = by + y
        }
        'Q', 'q' -> {
          val x1 = num() ?: return p; val y1 = num() ?: return p
          val x = num() ?: return p; val y = num() ?: return p
          if (has) p.quadTo(bx + x1, by + y1, bx + x, by + y)
          cx = bx + x; cy = by + y
        }
        'Z', 'z' -> {
          if (has) p.close()
          cx = sx; cy = sy
          cmd = ' '
          skip()
          if (i < n && !d[i].isLetter()) return p
        }
        else -> return p
      }
    }
    return p
  }
}
