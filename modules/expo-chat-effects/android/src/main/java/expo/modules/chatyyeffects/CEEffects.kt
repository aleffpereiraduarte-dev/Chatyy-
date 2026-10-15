package expo.modules.chatyyeffects

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random

// [2026-10-15 native-effects] Efeitos (Android). Cada efeito pré-sorteia as
// partículas no construtor e, a cada quadro, calcula posição/opacidade de
// forma analítica a partir do tempo (ms) — mesma coreografia de
// components/MessageScreenEffect.js e do antigo MessageEffectOverlay.

class CEOpts(
  val W: Float,
  val H: Float,
  val dark: Boolean,
  val intensity: Float,
  /** x, y, w, h (dp, coordenadas da janela) */
  val origin: FloatArray?,
  val emoji: String?,
  val density: Float,
) {
  val ink: Int get() = if (dark) Color.rgb(240, 240, 242) else Color.rgb(0x11, 0x11, 0x11)
  fun n(base: Int): Int = max(1, (base * intensity).roundToInt())
}

abstract class CEEffect(val name: String, val o: CEOpts) {
  var startNs = 0L
  abstract val ttl: Float
  abstract fun draw(c: Canvas, t: Float)
}

// ── matemática ──────────────────────────────────────────────────────

internal fun rnd(a: Float, b: Float): Float = if (b <= a) a else a + Random.nextFloat() * (b - a)
internal fun clamp01(x: Float): Float = if (x < 0f) 0f else if (x > 1f) 1f else x
internal fun lerp(a: Float, b: Float, t: Float): Float = a + (b - a) * t

/** Interpolação linear por partes (como Animated.interpolate, com clamp). */
internal fun interp(x: Float, ins: FloatArray, outs: FloatArray): Float {
  if (x <= ins[0]) return outs[0]
  for (i in 1 until ins.size) {
    if (x <= ins[i]) {
      val span = ins[i] - ins[i - 1]
      val f = if (span <= 0f) 1f else (x - ins[i - 1]) / span
      return lerp(outs[i - 1], outs[i], f)
    }
  }
  return outs[outs.size - 1]
}

internal object Ez {
  fun outCubic(t: Float): Float { val u = 1f - clamp01(t); return 1f - u * u * u }
  fun inOutSin(t: Float): Float = (-(cos(PI * clamp01(t)) - 1) / 2).toFloat()
  val inOut = Bz(0.42f, 0f, 0.58f, 1f)
}

/** cubic-bezier(x1,y1,x2,y2) como CSS / Easing.bezier. */
internal class Bz(x1: Float, y1: Float, x2: Float, y2: Float) {
  private val cx = 3f * x1
  private val bx = 3f * (x2 - x1) - cx
  private val ax = 1f - cx - bx
  private val cy = 3f * y1
  private val by = 3f * (y2 - y1) - cy
  private val ay = 1f - cy - by
  private fun sx(t: Float) = ((ax * t + bx) * t + cx) * t
  private fun sy(t: Float) = ((ay * t + by) * t + cy) * t
  private fun dx(t: Float) = (3f * ax * t + 2f * bx) * t + cx
  operator fun invoke(x: Float): Float {
    val xx = clamp01(x)
    var t = xx
    for (i in 0 until 8) {
      val err = sx(t) - xx
      if (abs(err) < 1e-4f) return sy(t)
      val d = dx(t)
      if (abs(d) < 1e-6f) break
      t -= err / d
    }
    var lo = 0f; var hi = 1f; t = xx
    for (i in 0 until 20) {
      val v = sx(t)
      if (abs(v - xx) < 1e-4f) break
      if (v < xx) lo = t else hi = t
      t = (lo + hi) / 2f
    }
    return sy(t)
  }
}

// ── bitmaps (cache) ─────────────────────────────────────────────────

internal object CEBitmaps {
  private val cache = HashMap<String, Bitmap>()

  private fun make(key: String, wPx: Int, hPx: Int, draw: (Canvas) -> Unit): Bitmap {
    cache[key]?.let { return it }
    if (cache.size > 120) cache.clear()
    val b = Bitmap.createBitmap(max(1, wPx), max(1, hPx), Bitmap.Config.ARGB_8888)
    draw(Canvas(b))
    cache[key] = b
    return b
  }

  fun heartPath(s: Float, inset: Float = 0f): Path {
    val k = (s - inset * 2) / 24f
    fun x(v: Float) = inset + v * k
    val p = Path()
    p.moveTo(x(12f), x(21f))
    p.cubicTo(x(12f), x(21f), x(4.5f), x(16.5f), x(2.5f), x(11.5f))
    p.cubicTo(x(1.5f), x(8f), x(4f), x(5f), x(7f), x(5f))
    p.cubicTo(x(9f), x(5f), x(10.5f), x(6f), x(12f), x(8f))
    p.cubicTo(x(13.5f), x(6f), x(15f), x(5f), x(17f), x(5f))
    p.cubicTo(x(20f), x(5f), x(22.5f), x(8f), x(21.5f), x(11.5f))
    p.cubicTo(x(19.5f), x(16.5f), x(12f), x(21f), x(12f), x(21f))
    p.close()
    return p
  }

  fun starPath(s: Float, inset: Float = 0f): Path {
    val k = (s - inset * 2) / 24f
    val pts = floatArrayOf(12f, 2f, 14.6f, 9f, 22f, 9f, 16f, 13.5f, 18.3f, 20.5f, 12f, 16f, 5.7f, 20.5f, 8f, 13.5f, 2f, 9f, 9.4f, 9f)
    val p = Path()
    var i = 0
    while (i < pts.size) {
      val px = inset + pts[i] * k; val py = inset + pts[i + 1] * k
      if (i == 0) p.moveTo(px, py) else p.lineTo(px, py)
      i += 2
    }
    p.close()
    return p
  }

  fun glowDot(color: Int, px: Int): Bitmap = make("dot-$color-$px", px, px) { c ->
    val r = px / 2f
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    p.shader = RadialGradient(r, r, r, intArrayOf(Color.WHITE, color, color and 0x00FFFFFF), floatArrayOf(0f, 0.32f, 1f), Shader.TileMode.CLAMP)
    c.drawCircle(r, r, r, p)
  }

  fun heart(color: Int, px: Int, glow: Boolean): Bitmap = make("heart-$color-$px-$glow", px, px) { c ->
    val s = px.toFloat()
    if (glow) {
      val g = Paint(Paint.ANTI_ALIAS_FLAG)
      g.shader = RadialGradient(s / 2, s / 2, s / 2, intArrayOf((color and 0x00FFFFFF) or (0x8C shl 24), color and 0x00FFFFFF), null, Shader.TileMode.CLAMP)
      c.drawCircle(s / 2, s / 2, s / 2, g)
    }
    val path = heartPath(s, if (glow) s * 0.12f else 0f)
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    p.color = color
    c.drawPath(path, p)
    c.save()
    c.clipPath(path)
    p.color = Color.argb(56, 255, 255, 255)
    c.drawOval(RectF(s * 0.22f, s * 0.2f, s * 0.48f, s * 0.36f), p)
    c.restore()
  }

  fun star(px: Int): Bitmap = make("star-$px", px, px) { c ->
    val s = px.toFloat()
    val gold = Color.rgb(0xFF, 0xD7, 0x00)
    val g = Paint(Paint.ANTI_ALIAS_FLAG)
    g.shader = RadialGradient(s / 2, s / 2, s / 2, intArrayOf((gold and 0x00FFFFFF) or (0xE6 shl 24), gold and 0x00FFFFFF), null, Shader.TileMode.CLAMP)
    c.drawCircle(s / 2, s / 2, s / 2, g)
    val path = starPath(s, s * 0.12f)
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    p.color = gold
    c.drawPath(path, p)
    p.style = Paint.Style.STROKE
    p.strokeWidth = s / 48f
    p.color = Color.rgb(0xFF, 0xA5, 0x00)
    c.drawPath(path, p)
  }

  /** Balão 100×190 unidades. */
  fun balloon(color: Int, wPx: Int): Bitmap = make("balloon-$color-$wPx", wPx, (wPx * 1.9f).toInt()) { c ->
    val k = wPx / 100f
    val body = Path()
    body.moveTo(50f * k, 4f * k)
    body.cubicTo(24f * k, 4f * k, 12f * k, 26f * k, 12f * k, 48f * k)
    body.cubicTo(12f * k, 72f * k, 28f * k, 92f * k, 50f * k, 96f * k)
    body.cubicTo(72f * k, 92f * k, 88f * k, 72f * k, 88f * k, 48f * k)
    body.cubicTo(88f * k, 26f * k, 76f * k, 4f * k, 50f * k, 4f * k)
    body.close()
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    // barbante
    val s = Path()
    s.moveTo(50f * k, 102f * k)
    s.quadTo(46f * k, 120f * k, 51f * k, 140f * k)
    s.quadTo(56f * k, 165f * k, 50f * k, 186f * k)
    p.style = Paint.Style.STROKE
    p.strokeWidth = max(1f, k * 1.2f)
    p.color = Color.argb(153, 128, 128, 128)
    c.drawPath(s, p)
    p.style = Paint.Style.FILL
    // nó
    val knot = Path()
    knot.moveTo(44f * k, 96f * k); knot.lineTo(56f * k, 96f * k); knot.lineTo(52f * k, 103f * k); knot.lineTo(48f * k, 103f * k); knot.close()
    p.color = color
    c.drawPath(knot, p)
    c.drawPath(body, p)
    c.save()
    c.clipPath(body)
    val hl = Paint(Paint.ANTI_ALIAS_FLAG)
    hl.shader = RadialGradient(36f * k, 30f * k, 42f * k, intArrayOf(Color.argb(140, 255, 255, 255), Color.argb(0, 255, 255, 255)), null, Shader.TileMode.CLAMP)
    c.drawRect(0f, 0f, wPx.toFloat(), wPx.toFloat(), hl)
    c.restore()
  }

  fun emoji(s: String, px: Int): Bitmap = make("emoji-$s-$px", (px * 1.25f).toInt(), (px * 1.25f).toInt()) { c ->
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    p.textSize = px.toFloat()
    p.textAlign = Paint.Align.CENTER
    val fm = p.fontMetrics
    val size = px * 1.25f
    val baseline = size / 2f - (fm.ascent + fm.descent) / 2f
    c.drawText(s, size / 2f, baseline, p)
  }
}

// ── helpers de desenho ──────────────────────────────────────────────

internal val bmpPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
internal val tmpRect = RectF()

internal fun drawBitmapAt(c: Canvas, b: Bitmap, cx: Float, cy: Float, w: Float, h: Float, alpha: Float, rotDeg: Float = 0f, scale: Float = 1f) {
  if (alpha <= 0.003f) return
  c.save()
  c.translate(cx, cy)
  if (rotDeg != 0f) c.rotate(rotDeg)
  if (scale != 1f) c.scale(scale, scale)
  tmpRect.set(-w / 2, -h / 2, w / 2, h / 2)
  bmpPaint.alpha = (clamp01(alpha) * 255).toInt()
  c.drawBitmap(b, null, tmpRect, bmpPaint)
  c.restore()
}

internal fun dpPx(o: CEOpts, dp: Float): Int = max(2, (dp * o.density).roundToInt())

// ── Flash ───────────────────────────────────────────────────────────

internal class FlashLayer {
  private val p = Paint().apply { color = Color.WHITE }
  fun draw(c: Canvas, t: Float, W: Float, H: Float) {
    if (t > 320f) return
    val a = interp(t, floatArrayOf(0f, 80f, 320f), floatArrayOf(0f, 0.2f, 0f))
    p.alpha = (a * 255).toInt()
    c.drawRect(0f, 0f, W, H, p)
  }
}

// ── Fogos (explosão analítica) ──────────────────────────────────────

internal class Burst(val x: Float, val y: Float, val color: Int, val delay: Float, sparks: Int, o: CEOpts, distMin: Float = 70f, distMax: Float = 120f) {
  private val n = max(6, (sparks * o.intensity).roundToInt())
  private val ang = FloatArray(n) { (2 * PI * it / n).toFloat() + rnd(-0.08f, 0.08f) }
  private val dist = FloatArray(n) { rnd(distMin, distMax) }
  private val dot = CEBitmaps.glowDot(color, dpPx(o, 12f))
  private val flare = Paint(Paint.ANTI_ALIAS_FLAG).also { it.color = Color.WHITE }
  private val trail = Paint(Paint.ANTI_ALIAS_FLAG).also { it.style = Paint.Style.STROKE; it.strokeCap = Paint.Cap.ROUND; it.strokeWidth = 2f; it.color = color }
  val end: Float get() = delay + 1400f

  private fun pos(i: Int, p: Float, out: FloatArray) {
    val e = Ez.outCubic(p)
    out[0] = x + cos(ang[i]) * dist[i] * e
    out[1] = y + sin(ang[i]) * dist[i] * e + 25f * e + 30f * p * p
  }

  private val a = FloatArray(2)
  private val b = FloatArray(2)

  fun draw(c: Canvas, t: Float) {
    val l = t - delay
    if (l < 0f || l > 1400f) return
    if (l < 200f) {
      val fp = l / 200f
      flare.alpha = (interp(fp, floatArrayOf(0f, 0.5f, 1f), floatArrayOf(0f, 0.9f, 0f)) * 255).toInt()
      c.drawCircle(x, y, 16f * lerp(0.4f, 1.6f, fp), flare)
    }
    val p = clamp01(l / 1300f)
    val op = interp(p, floatArrayOf(0f, 0.05f, 0.85f, 1f), floatArrayOf(0f, 1f, 1f, 0f))
    if (op <= 0f) return
    for (i in 0 until n) {
      pos(i, p, a)
      pos(i, max(0f, p - 0.07f), b)
      trail.alpha = (op * 110).toInt()
      c.drawLine(b[0], b[1], a[0], a[1], trail)
      drawBitmapAt(c, dot, a[0], a[1], 10f, 10f, op)
    }
  }
}

// ── Efeitos ─────────────────────────────────────────────────────────

internal class Balloons(o: CEOpts) : CEEffect("balloons", o) {
  private class B(val x: Float, val delay: Float, val dur: Float, val sway: Float, val period: Float, val size: Float, val bmp: Bitmap)
  private val items: List<B>
  override val ttl: Float
  init {
    val colors = intArrayOf(0xFFEF4444.toInt(), 0xFFF59E0B.toInt(), 0xFFFACC15.toInt(), 0xFF10B981.toInt(), 0xFF3B82F6.toInt(), o.ink, 0xFFFB7185.toInt(), 0xFF06B6D4.toInt())
    val n = o.n(28)
    val bw = dpPx(o, 64f)
    items = List(n) { i ->
      B(rnd(4f, max(5f, o.W - 60f)), i * 60f + rnd(0f, 220f), rnd(3800f, 4800f), rnd(6f, 18f), rnd(800f, 1500f), rnd(34f, 64f), CEBitmaps.balloon(colors[i % colors.size], bw))
    }
    ttl = (items.maxOfOrNull { it.delay + it.dur } ?: 0f) + 100f
  }
  private val ease = Bz(0.1f, 0.5f, 0.4f, 1f)
  override fun draw(c: Canvas, t: Float) {
    for (b in items) {
      val l = t - b.delay
      if (l < 0f || l > b.dur) continue
      val h = b.size * 1.9f
      val y = lerp(o.H + 80f + h / 2, -h / 2 - 20f, ease(l / b.dur))
      val s = sin(PI * l / b.period).toFloat()
      val op = min(clamp01(l / 240f), clamp01((b.dur - l) / 220f))
      drawBitmapAt(c, b.bmp, b.x + b.size / 2 + s * b.sway, y, b.size, h, op, s * b.sway * 0.35f)
    }
  }
}

internal class Confetti(o: CEOpts, private val golden: Boolean, name: String = "confetti") : CEEffect(name, o) {
  private class P(val fromX: Float, val drift: Float, val dur: Float, val delay: Float, val size: Float, val ratio: Float, val color: Int, val turns: Float, val flips: Float, val shape: Int)
  private val items: List<P>
  override val ttl: Float
  private val ease = Bz(0.2f, 0.4f, 0.4f, 1f)
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val tri = Path()
  private val xsIn = floatArrayOf(0f, 0.25f, 0.5f, 0.75f, 1f)
  private val xsOut = floatArrayOf(0f, 0.4f, 0.2f, 0.8f, 1f)
  private val opIn = floatArrayOf(0f, 0.05f, 0.75f, 1f)
  private val opOut = floatArrayOf(0f, 1f, 1f, 0f)
  init {
    val colors = if (golden) intArrayOf(0xFFFACC15.toInt(), 0xFFF59E0B.toInt(), 0xFFFCD34D.toInt(), if (o.dark) Color.WHITE else 0xFFD4A017.toInt(), 0xFFEAB308.toInt())
    else intArrayOf(0xFFEF4444.toInt(), 0xFFF59E0B.toInt(), 0xFFFACC15.toInt(), 0xFF10B981.toInt(), 0xFF3B82F6.toInt(), o.ink, 0xFFFB7185.toInt(), 0xFF06B6D4.toInt())
    val n = o.n(180)
    items = List(n) { i ->
      P(rnd(0f, o.W), rnd(-160f, 160f), rnd(2000f, 3800f), rnd(0f, 1000f), rnd(5f, 16f), rnd(0.35f, 1f), colors[i % colors.size],
        rnd(2f, 8f) * (if (Random.nextBoolean()) 1f else -1f), rnd(1f, 3f), i % 4)
    }
    ttl = (items.maxOfOrNull { it.delay + it.dur } ?: 0f) + 100f
  }
  override fun draw(c: Canvas, t: Float) {
    for (p in items) {
      val l = t - p.delay
      if (l < 0f || l > p.dur) continue
      val lin = l / p.dur
      val e = ease(lin)
      val op = interp(e, opIn, opOut)
      if (op <= 0.003f) continue
      val x = p.fromX + p.drift * interp(e, xsIn, xsOut)
      val y = -30f + (o.H + 60f) * e
      val flip = cos(2 * PI * p.flips * lin).toFloat()
      paint.color = p.color
      paint.alpha = (op * 255).toInt()
      c.save()
      c.translate(x, y)
      c.rotate(360f * p.turns * lin)
      c.scale(1f, if (abs(flip) < 0.08f) 0.08f else flip)
      when (p.shape) {
        0 -> c.drawCircle(0f, 0f, p.size / 2, paint)
        1 -> { tmpRect.set(-p.size / 2, -p.size * p.ratio / 2, p.size / 2, p.size * p.ratio / 2); c.drawRoundRect(tmpRect, 1.5f, 1.5f, paint) }
        2 -> { val h = max(1.5f, p.size * 0.25f); tmpRect.set(-p.size / 2, -h / 2, p.size / 2, h / 2); c.drawRoundRect(tmpRect, 1f, 1f, paint) }
        else -> {
          val s = p.size + 2f
          tri.reset(); tri.moveTo(0f, -s / 2); tri.lineTo(s / 2, s * 0.4f); tri.lineTo(-s / 2, s * 0.4f); tri.close()
          c.drawPath(tri, paint)
        }
      }
      c.restore()
    }
  }
}

internal class Love(o: CEOpts) : CEEffect("love", o) {
  private class H(val x: Float, val delay: Float, val dur: Float, val size: Float, val sway: Float, val bmp: Bitmap)
  private val bloom = CEBitmaps.heart(o.ink, dpPx(o, 120f), true)
  private val cx: Float
  private val cy: Float
  private val items: List<H>
  override val ttl: Float
  init {
    val og = o.origin
    cx = if (og != null) og[0] + og[2] / 2 else o.W / 2
    cy = if (og != null) og[1] + og[3] / 2 else o.H * 0.4f + 60f
    val colors = intArrayOf(0xFFFB7185.toInt(), o.ink, 0xFFF43F5E.toInt())
    val px = dpPx(o, 42f)
    items = List(o.n(32)) { i ->
      H(rnd(20f, max(21f, o.W - 40f)) + 10f, rnd(0f, 1100f), rnd(2400f, 3600f), rnd(18f, 42f), rnd(20f, 50f), CEBitmaps.heart(colors[i % 3], px, false))
    }
    ttl = max(1500f, (items.maxOfOrNull { it.delay + it.dur } ?: 0f)) + 100f
  }
  private val sIn = floatArrayOf(0f, 0.24f, 0.36f, 0.5f, 0.62f, 1f)
  private val sOut = floatArrayOf(0.2f, 1.25f, 1f, 1.12f, 1f, 2.4f)
  private val oIn = floatArrayOf(0f, 0.15f, 0.6f, 0.7f, 1f)
  private val oOut = floatArrayOf(0f, 0.95f, 0.95f, 0.9f, 0f)
  private val hIn = floatArrayOf(0f, 0.05f, 0.85f, 1f)
  private val hOut = floatArrayOf(0f, 0.95f, 0.95f, 0f)
  override fun draw(c: Canvas, t: Float) {
    if (t <= 1450f) {
      val p = t / 1450f
      val sc = interp(Ez.inOut(p), sIn, sOut)
      drawBitmapAt(c, bloom, cx, cy, 120f, 120f, interp(p, oIn, oOut), 0f, sc)
    }
    for (h in items) {
      val l = t - h.delay
      if (l < 0f || l > h.dur) continue
      val e = Ez.outCubic(l / h.dur)
      val y = lerp(o.H - 60f + h.size / 2, -60f, e)
      val s = sin(PI * l / 1100f).toFloat()
      val pop = if (l < 350f) interp(l / 350f, floatArrayOf(0f, 0.6f, 1f), floatArrayOf(0.4f, 1.1f, 1f)) else 1f
      drawBitmapAt(c, h.bmp, h.x + s * h.sway, y, h.size, h.size, interp(e, hIn, hOut), s * 10f, pop)
    }
  }
}

internal class Lasers(o: CEOpts) : CEEffect("lasers", o) {
  private class Beam(val color: Int, val fy: Float, val angle: Float, val delay: Float, val dir: Int, val halo: Shader)
  private val flash = FlashLayer()
  private val beams: List<Beam>
  private val haloPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val corePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
  private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val ease = Bz(0.3f, 0f, 0.6f, 1f)
  override val ttl = 2200f
  init {
    val ink = if (o.dark) 0xFFA78BFA.toInt() else 0xFF111111.toInt()
    val defs = listOf(
      Triple(ink, 0.2f, 14f), Triple(0xFF06B6D4.toInt(), 0.32f, -22f), Triple(0xFFF59E0B.toInt(), 0.45f, 30f),
      Triple(0xFFEC4899.toInt(), 0.55f, -18f), Triple(0xFF10B981.toInt(), 0.68f, 24f), Triple(0xFFFACC15.toInt(), 0.78f, -28f),
      Triple(0xFF3B82F6.toInt(), 0.88f, 16f), Triple(0xFFEF4444.toInt(), 0.15f, -10f)
    )
    beams = defs.mapIndexed { i, d ->
      val col = d.first
      val sh = LinearGradient(0f, -14f, 0f, 14f, intArrayOf(col and 0x00FFFFFF, (col and 0x00FFFFFF) or (0x8C shl 24), col and 0x00FFFFFF), floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
      Beam(col, d.second, d.third, i * 80f, if (i % 2 == 0) 1 else -1, sh)
    }
  }
  override fun draw(c: Canvas, t: Float) {
    flash.draw(c, t, o.W, o.H)
    val bw = o.W * 1.4f
    for (b in beams) {
      val l = t - b.delay
      if (l < 0f || l > 1500f) continue
      val e = ease(l / 1500f)
      val tx = if (b.dir > 0) lerp(-o.W, o.W * 1.5f, e) else lerp(o.W * 1.5f, -o.W, e)
      val ph = (l % 180f) / 180f
      val strobe = if (ph < 0.5f) lerp(0.6f, 1f, ph * 2f) else lerp(1f, 0.6f, (ph - 0.5f) * 2f)
      val op = interp(e, floatArrayOf(0f, 0.1f, 0.85f, 1f), floatArrayOf(0f, 1f, 1f, 0f)) * strobe
      if (op <= 0.003f) continue
      c.save()
      c.translate(bw / 2 + tx, o.H * b.fy + 1.5f)
      c.rotate(b.angle)
      haloPaint.shader = b.halo
      haloPaint.alpha = (op * 255).toInt()
      c.drawRect(-bw / 2, -14f, bw / 2, 14f, haloPaint)
      glowPaint.color = b.color
      glowPaint.alpha = (op * 150).toInt()
      c.drawRoundRect(-bw / 2, -3f, bw / 2, 3f, 3f, 3f, glowPaint)
      corePaint.alpha = (op * 255).toInt()
      c.drawRoundRect(-bw / 2, -1.5f, bw / 2, 1.5f, 1.5f, 1.5f, corePaint)
      c.restore()
    }
  }
}

internal class Fireworks(o: CEOpts) : CEEffect("fireworks", o) {
  private val flash = FlashLayer()
  private val bursts: List<Burst>
  override val ttl = 4200f
  init {
    val ink = if (o.dark) 0xFFC4B5FD.toInt() else 0xFF111111.toInt()
    val white = if (o.dark) Color.WHITE else 0xFF9CA3AF.toInt()
    val W = o.W; val H = o.H
    bursts = listOf(
      Burst(W * 0.25f, H * 0.25f, 0xFFF59E0B.toInt(), 0f, 28, o),
      Burst(W * 0.70f, H * 0.20f, 0xFFEF4444.toInt(), 220f, 26, o),
      Burst(W * 0.50f, H * 0.40f, 0xFF3B82F6.toInt(), 460f, 32, o),
      Burst(W * 0.18f, H * 0.50f, 0xFF10B981.toInt(), 700f, 24, o),
      Burst(W * 0.80f, H * 0.42f, ink, 940f, 28, o),
      Burst(W * 0.40f, H * 0.18f, 0xFFEC4899.toInt(), 1180f, 34, o),
      Burst(W * 0.60f, H * 0.60f, 0xFFFACC15.toInt(), 1420f, 28, o),
      Burst(W * 0.30f, H * 0.62f, 0xFF06B6D4.toInt(), 1660f, 24, o),
      Burst(W * 0.85f, H * 0.55f, 0xFFFB7185.toInt(), 1900f, 26, o),
      Burst(W * 0.15f, H * 0.32f, white, 2200f, 14, o, 45f, 80f),
      Burst(W * 0.55f, H * 0.30f, white, 2400f, 14, o, 45f, 80f),
      Burst(W * 0.78f, H * 0.68f, white, 2600f, 14, o, 45f, 80f)
    )
  }
  override fun draw(c: Canvas, t: Float) {
    flash.draw(c, t, o.W, o.H)
    for (b in bursts) b.draw(c, t)
  }
}

internal class Celebration(o: CEOpts) : CEEffect("celebration", o) {
  private val flash = FlashLayer()
  private val confetti = Confetti(o, true, "celebration")
  private val bursts = listOf(
    Burst(o.W / 2, o.H * 0.32f, 0xFFFACC15.toInt(), 0f, 26, o),
    Burst(o.W * 0.25f, o.H * 0.45f, 0xFFF59E0B.toInt(), 500f, 18, o, 55f, 95f),
    Burst(o.W * 0.75f, o.H * 0.45f, 0xFFEAB308.toInt(), 500f, 18, o, 55f, 95f)
  )
  override val ttl = max(confetti.ttl, 2200f)
  override fun draw(c: Canvas, t: Float) {
    flash.draw(c, t, o.W, o.H)
    confetti.draw(c, t)
    for (b in bursts) b.draw(c, t)
  }
}

internal class Spotlight(o: CEOpts) : CEEffect("spotlight", o) {
  private class M(val x: Float, val y: Float, val delay: Float, val size: Float)
  private val dim = Paint().apply { color = Color.BLACK }
  private val cone = Paint(Paint.ANTI_ALIAS_FLAG)
  private val mote = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
  private val motes: List<M>
  override val ttl = 2300f
  init {
    val og = o.origin
    val cyf = if (og != null) ((og[1] + og[3] / 2) / max(1f, o.H)).coerceIn(0.15f, 0.85f) else 0.4f
    val cx = o.W / 2; val cy = o.H * cyf
    val r = 0.55f * o.H
    val sh = RadialGradient(cx, cy, r, intArrayOf(Color.argb(140, 255, 255, 255), Color.argb(46, 255, 255, 255), Color.argb(0, 255, 255, 255)), floatArrayOf(0f, 0.4f, 1f), Shader.TileMode.CLAMP)
    // elipse: raio X = 55% da largura, raio Y = 55% da altura (igual ao SVG objectBoundingBox)
    val m = Matrix(); m.setScale(o.W / max(1f, o.H), 1f, cx, cy); sh.setLocalMatrix(m)
    cone.shader = sh
    motes = List(o.n(28)) { i -> M(o.W / 2 - 120f + rnd(0f, 240f), o.H * 0.12f + rnd(0f, o.H * 0.62f), i * 50f, rnd(1.5f, 4f)) }
  }
  override fun draw(c: Canvas, t: Float) {
    val tin = floatArrayOf(0f, 500f, 1700f, 2200f)
    dim.alpha = (interp(t, tin, floatArrayOf(0f, 0.7f, 0.7f, 0f)) * 255).toInt()
    c.drawRect(0f, 0f, o.W, o.H, dim)
    val ca = interp(t, floatArrayOf(0f, 800f, 1700f, 2200f), floatArrayOf(0f, 1f, 1f, 0f))
    cone.alpha = (Ez.outCubic(ca) * 255).toInt()
    c.drawRect(0f, 0f, o.W, o.H, cone)
    for (m in motes) {
      val l = t - m.delay
      if (l < 0f) continue
      val ph = (l % 2000f) / 2000f
      mote.alpha = (interp(ph, floatArrayOf(0f, 0.4f, 1f), floatArrayOf(0f, 0.7f, 0f)) * 255).toInt()
      c.drawCircle(m.x, m.y - 40f * ph, m.size / 2, mote)
    }
  }
}

internal class Echo(o: CEOpts) : CEEffect("echo", o) {
  private class C(val delay: Float, val dur: Float, val angle: Float, val dist: Float, val w: Float, val h: Float, val ox: Float, val oy: Float)
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = if (o.dark) Color.rgb(230, 230, 230) else 0xFF111111.toInt() }
  private val bx: Float
  private val by: Float
  private val items: List<C>
  override val ttl: Float
  init {
    val og = o.origin
    bx = if (og != null) og[0] + og[2] / 2 else o.W / 2
    by = if (og != null) og[1] + og[3] / 2 else o.H / 2 + 21f
    items = List(o.n(14)) { i ->
      val w = if (og != null) og[2].coerceIn(60f, o.W * 0.8f) else rnd(110f, 200f)
      val h = if (og != null) og[3].coerceIn(34f, 120f) else 42f
      C(i * 110f + rnd(0f, 80f), rnd(1300f, 1700f), (((i % 3) - 1) * PI / 6).toFloat(), rnd(140f, 220f), w, h, rnd(-30f, 30f), rnd(-20f, 20f))
    }
    ttl = (items.maxOfOrNull { it.delay + it.dur } ?: 0f) + 100f
  }
  override fun draw(c: Canvas, t: Float) {
    for (it in items) {
      val l = t - it.delay
      if (l < 0f || l > it.dur) continue
      val e = Ez.outCubic(l / it.dur)
      val op = interp(e, floatArrayOf(0f, 0.12f, 0.85f, 1f), floatArrayOf(0f, 0.78f, 0.45f, 0f))
      if (op <= 0.003f) continue
      val sc = lerp(0.5f, 1.7f, e)
      val x = bx + it.ox + sin(it.angle) * it.dist * e
      val y = by + it.oy - it.dist * 0.85f * e
      paint.alpha = (op * 255).toInt()
      c.save()
      c.translate(x, y)
      c.scale(sc, sc)
      val r = min(21f, it.h / 2)
      c.drawRoundRect(-it.w / 2, -it.h / 2, it.w / 2, it.h / 2, r, r, paint)
      c.restore()
    }
  }
}

internal class ShootingStar(o: CEOpts) : CEEffect("shooting-star", o) {
  private val sx = -60f
  private val sy = o.H * 0.18f
  private val ex = o.W * 0.8f
  private val ey = o.H * 0.55f
  private val mx = (sx + ex) / 2
  private val my = (sy + ey) / 2 - o.H * 0.06f
  private val ease = Bz(0.4f, 0f, 0.6f, 1f)
  private val star = CEBitmaps.star(dpPx(o, 50f))
  private val trailDot = CEBitmaps.glowDot(0xFFFFE58A.toInt(), dpPx(o, 12f))
  private val burst = Burst(ex, ey, 0xFFFFD700.toInt(), 1100f, 22, o, 40f, 80f)
  override val ttl = 2600f
  private fun px(e: Float): Float { val u = 1 - e; return u * u * sx + 2 * u * e * mx + e * e * ex }
  private fun py(e: Float): Float { val u = 1 - e; return u * u * sy + 2 * u * e * my + e * e * ey }
  override fun draw(c: Canvas, t: Float) {
    if (t <= 1100f + 300f) {
      val p = clamp01(t / 1100f)
      // rastro: 14 pontos "atrasados" (como os TrailDot do JS)
      for (k in 14 downTo 1) {
        val tp = (t - k * 35f) / 1100f
        if (tp < 0f || tp > 1f) continue
        val e = ease(tp)
        val a = interp(tp, floatArrayOf(0f, 0.1f, 0.7f, 1f), floatArrayOf(0f, 0.7f, 0.3f, 0f)) * (1f - k / 16f)
        val s = 4f + (14 - k) * 0.6f
        drawBitmapAt(c, trailDot, px(e), py(e), s * 2f, s * 2f, a)
      }
      val q = t / 1400f
      val e = ease(p)
      val op = interp(q, floatArrayOf(0f, 0.04f, 0.8f, 1f), floatArrayOf(0f, 1f, 1f, 0f))
      val sc = interp(q, floatArrayOf(0f, 0.4f, 0.78f, 1f), floatArrayOf(0.6f, 1.2f, 0.9f, 1.6f))
      drawBitmapAt(c, star, px(e), py(e), 50f, 50f, op, 360f * q, sc)
    }
    burst.draw(c, t)
  }
}

/** ❤️ / 🔥 / 🎉 subindo (antigo MessageEffectOverlay do chat-conversation). */
internal class EmojiRise(name: String, o: CEOpts, chars: List<String>, base: Int, private val gentle: Boolean) : CEEffect(name, o) {
  private class E(val sx: Float, val sy: Float, val drift: Float, val delay: Float, val dur: Float, val ty: Float, val size: Float, val rot: Float, val wob: Float, val bmp: Bitmap)
  private val items: List<E>
  override val ttl: Float
  init {
    val px = dpPx(o, 40f)
    val og = o.origin
    items = List(o.n(base)) { i ->
      val size = rnd(24f, 40f)
      val sx = if (og != null) og[0] + og[2] / 2 + rnd(-70f, 70f) else rnd(size / 2, max(size / 2 + 1f, o.W - size / 2))
      val sy = if (og != null) og[1] + rnd(-10f, 20f) else o.H + 20f + size / 2
      E(sx, sy, rnd(-60f, 60f), i * 60f, rnd(1800f, 2500f), -60f - rnd(0f, 200f), size,
        (Random.nextFloat() - 0.5f) * 360f, rnd(500f, 800f), CEBitmaps.emoji(chars[i % chars.size], px))
    }
    ttl = (items.maxOfOrNull { it.delay + max(it.dur, 2500f) } ?: 0f) + 100f
  }
  override fun draw(c: Canvas, t: Float) {
    for (it in items) {
      val l = t - it.delay
      if (l < 0f) continue
      val op = if (l < 500f) 1f else 1f - clamp01((l - 500f) / 2000f)
      if (op <= 0.003f) continue
      val e = Ez.inOut(clamp01(l / it.dur))
      val x = lerp(it.sx, it.sx + it.drift, e)
      val y = lerp(it.sy, it.ty, e)
      val rot: Float
      val sc: Float
      if (gentle) {
        rot = sin(2 * PI * l / (it.wob * 2)).toFloat() * 17f
        sc = if (l < 320f) interp(l / 320f, floatArrayOf(0f, 0.55f, 1f), floatArrayOf(0.3f, 1.18f, 1f)) else 1f
      } else {
        rot = it.rot * Ez.inOut(clamp01(l / 2000f))
        sc = 1f
      }
      drawBitmapAt(c, it.bmp, x, y, it.size * 1.25f, it.size * 1.25f, op, rot, sc)
    }
  }
}

object CEEffects {
  private val HEARTS = listOf("❤️", "💖", "💗", "💕", "💞", "💓")
  private val FIRE = listOf("🔥", "🌟", "✨", "💥", "🌞")
  private val PARTY = listOf("🎉", "🎊", "✨", "🎆", "🎇", "🥳", "🎈")

  fun create(name: String, o: CEOpts): CEEffect? {
    val custom = o.emoji?.let { listOf(it) }
    return when (name) {
      "balloons" -> Balloons(o)
      "confetti" -> Confetti(o, false)
      "celebration" -> Celebration(o)
      "love" -> Love(o)
      "lasers" -> Lasers(o)
      "fireworks" -> Fireworks(o)
      "spotlight" -> Spotlight(o)
      "echo" -> Echo(o)
      "shooting-star" -> ShootingStar(o)
      "hearts" -> EmojiRise("hearts", o, custom ?: HEARTS, 18, true)
      "fire" -> EmojiRise("fire", o, custom ?: FIRE, 14, false)
      "party" -> EmojiRise("party", o, custom ?: PARTY, 30, false)
      else -> null
    }
  }
}
