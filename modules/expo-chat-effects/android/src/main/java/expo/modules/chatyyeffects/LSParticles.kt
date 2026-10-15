package expo.modules.chatyyeffects

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// [2026-10-15 native-live] Partículas do palco da live (corações, love-bomb,
// presentes). Tudo analítico a partir do tempo (ms); unidades em PX (o
// chamador já converte dp→px). Desenhado no dispatchDraw do palco.

internal class LSHeart(
  val x: Float, val y: Float, val color: Int, val emoji: String?,
  val size: Float, val drift: Float, val phase: Float, val rise: Float,
  val tilt: Float, val dur: Float, val start: Long,
) {
  /** false = acabou. */
  fun draw(c: Canvas, now: Long): Boolean {
    val t = (now - start).toFloat()
    if (t >= dur) return false
    val p = clamp01(t / dur)
    val cy = y - rise * Ez.outCubic(p)
    val cx = x + drift * 0.5f * sin(phase + p * PI.toFloat() * 1.5f)
    val a = if (p < 0.08f) p / 0.08f else if (p > 0.6f) (1f - p) / 0.4f else 1f
    val s = if (t < 350f) interp(t, floatArrayOf(0f, 210f, 350f), floatArrayOf(0.4f, 1.1f, 1f)) else 1f
    val px = max(4, size.toInt())
    val bmp = if (emoji != null) CEBitmaps.emoji(emoji, px) else CEBitmaps.heart(color, px * 2, false)
    val w = if (emoji != null) size * 1.25f else size
    drawBitmapAt(c, bmp, cx, cy, w, w, a, tilt * p, s)
    return true
  }
}

internal class LSBurstHeart(
  val x: Float, val y: Float, val dx: Float, val dy: Float, val color: Int, val size: Float, val start: Long,
) {
  fun draw(c: Canvas, now: Long): Boolean {
    val t = (now - start).toFloat()
    if (t >= 900f) return false
    val p = clamp01(t / 900f)
    val e = Ez.outCubic(p)
    val a = if (p < 0.5f) 1f else (1f - p) / 0.5f
    val s = lerp(0.5f, 1.3f, e)
    drawBitmapAt(c, CEBitmaps.heart(color, (size * 2).toInt(), false), x + dx * e, y + dy * e, size, size, a, 0f, s)
    return true
  }
}

internal class LSGift(
  val kind: String, val title: String, val subtitle: String, val count: Int, val color: Int,
) {
  var start = 0L
  private val sparkAngles = FloatArray(16) { i -> (2 * PI * i / 16).toFloat() + rnd(-0.12f, 0.12f) }

  companion object {
    const val TTL = 2200f

    fun catalogColor(kind: String): Int = when (kind) {
      "rose" -> 0xFFEF4444.toInt()
      "star" -> 0xFFFACC15.toInt()
      "crown" -> 0xFFFBBF24.toInt()
      "fire" -> 0xFFF97316.toInt()
      "rocket" -> 0xFFE5E7EB.toInt()
      else -> 0xFFFF4D6D.toInt()
    }

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val chipBg = Paint(Paint.ANTI_ALIAS_FLAG)
    private val titleP = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; typeface = Typeface.DEFAULT_BOLD }
    private val subP = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val rect = RectF()

    private fun withAlpha(c: Int, a: Float): Int = (c and 0x00FFFFFF) or ((clamp01(a) * ((c ushr 24) and 0xFF)).toInt() shl 24)

    /** Glifo vetorial no espaço 24×24 (o canvas já está escalado/centrado). */
    fun drawGlyph(c: Canvas, kind: String, color: Int, a: Float) {
      fill.style = Paint.Style.FILL
      when (kind) {
        "rose" -> {
          val p = Path()
          p.moveTo(12f, 2f)
          p.cubicTo(9f, 2f, 7f, 4f, 7f, 7f)
          p.cubicTo(7f, 9f, 8f, 10.5f, 9.5f, 11.5f)
          p.cubicTo(8f, 12.5f, 7f, 14f, 7f, 16f)
          p.cubicTo(7f, 19f, 9f, 21f, 12f, 21f)
          p.cubicTo(15f, 21f, 17f, 19f, 17f, 16f)
          p.cubicTo(17f, 14f, 16f, 12.5f, 14.5f, 11.5f)
          p.cubicTo(16f, 10.5f, 17f, 9f, 17f, 7f)
          p.cubicTo(17f, 4f, 15f, 2f, 12f, 2f)
          p.close()
          stroke.color = withAlpha(0xFF16A34A.toInt(), a); stroke.strokeWidth = 2f
          c.drawLine(12f, 20f, 12f, 23.5f, stroke)
          fill.color = withAlpha(color, a); c.drawPath(p, fill)
          fill.color = withAlpha(0xFF7F1D1D.toInt(), a); c.drawCircle(12f, 10.5f, 2.5f, fill)
        }
        "star" -> {
          fill.color = withAlpha(color, a); c.drawPath(CEBitmaps.starPath(24f), fill)
          stroke.color = withAlpha(0xFFA16207.toInt(), a); stroke.strokeWidth = 0.6f
          c.drawPath(CEBitmaps.starPath(24f), stroke)
        }
        "crown" -> {
          val p = Path()
          p.moveTo(2f, 8f); p.lineTo(7f, 12f); p.lineTo(12f, 4f); p.lineTo(17f, 12f); p.lineTo(22f, 8f)
          p.lineTo(20f, 18.5f); p.lineTo(4f, 18.5f); p.close()
          fill.color = withAlpha(color, a); c.drawPath(p, fill)
          c.drawRoundRect(RectF(4f, 19.5f, 20f, 22f), 0.8f, 0.8f, fill)
          fill.color = withAlpha(0xFFFFFFFF.toInt(), a * 0.85f)
          c.drawCircle(12f, 13.5f, 1.4f, fill); c.drawCircle(7.5f, 15f, 1f, fill); c.drawCircle(16.5f, 15f, 1f, fill)
        }
        "fire" -> {
          val p = Path()
          p.moveTo(12f, 2f)
          p.cubicTo(12f, 2f, 19f, 8f, 19f, 14f)
          p.cubicTo(19f, 18f, 16f, 22f, 12f, 22f)
          p.cubicTo(8f, 22f, 5f, 18f, 5f, 14f)
          p.cubicTo(5f, 10f, 9f, 8f, 9f, 4f)
          p.cubicTo(11f, 6f, 12f, 2f, 12f, 2f)
          p.close()
          fill.color = withAlpha(color, a); c.drawPath(p, fill)
          val q = Path()
          q.moveTo(12f, 12f)
          q.cubicTo(12f, 12f, 15f, 15f, 15f, 17f)
          q.cubicTo(15f, 19f, 13.5f, 20f, 12f, 20f)
          q.cubicTo(10.5f, 20f, 9f, 19f, 9f, 17f)
          q.cubicTo(9f, 15f, 12f, 12f, 12f, 12f)
          q.close()
          fill.color = withAlpha(0xFFFDE047.toInt(), a); c.drawPath(q, fill)
        }
        "rocket" -> {
          val flame = Path(); flame.moveTo(10f, 17f); flame.lineTo(12f, 22.5f); flame.lineTo(14f, 17f); flame.close()
          fill.color = withAlpha(0xFFF97316.toInt(), a); c.drawPath(flame, fill)
          val fins = Path()
          fins.moveTo(8f, 12.5f); fins.lineTo(4.5f, 17.5f); fins.lineTo(8f, 17f); fins.close()
          fins.moveTo(16f, 12.5f); fins.lineTo(19.5f, 17.5f); fins.lineTo(16f, 17f); fins.close()
          fill.color = withAlpha(0xFFEF4444.toInt(), a); c.drawPath(fins, fill)
          val body = Path()
          body.moveTo(12f, 2f)
          body.cubicTo(15f, 4f, 16f, 8f, 16f, 12f)
          body.lineTo(16f, 17f); body.lineTo(8f, 17f); body.lineTo(8f, 12f)
          body.cubicTo(8f, 8f, 9f, 4f, 12f, 2f)
          body.close()
          fill.color = withAlpha(color, a); c.drawPath(body, fill)
          fill.color = withAlpha(0xFF60A5FA.toInt(), a); c.drawCircle(12f, 9f, 1.8f, fill)
        }
        else -> {
          fill.color = withAlpha(color, a); c.drawPath(CEBitmaps.heartPath(24f), fill)
          fill.color = withAlpha(0x38FFFFFF, a); c.drawOval(RectF(5.3f, 4.8f, 11.5f, 8.6f), fill)
        }
      }
    }
  }

  /** false = acabou. dens = densidade (px/dp). */
  fun draw(c: Canvas, now: Long, W: Float, H: Float, dens: Float): Boolean {
    if (start == 0L) start = now
    val t = (now - start).toFloat()
    if (t >= TTL) return false
    val ga = if (t > TTL - 350f) (TTL - t) / 350f else 1f
    val size = 120f * dens
    val cx = W / 2f
    val cy = H * 0.42f + sin(t / 1000f * 2f * PI.toFloat() * 0.8f) * 4f * dens
    val s = if (t < 450f) interp(t, floatArrayOf(0f, 300f, 450f), floatArrayOf(0.2f, 1.2f, 1f)) else 1f

    // halo pulsando
    val r = size * 0.62f * (1f + 0.08f * sin(t * 0.008f)) * min(1f, s)
    fill.style = Paint.Style.FILL
    fill.color = withAlpha(color, 0.35f * ga)
    c.drawCircle(cx, cy, r, fill)

    // faíscas radiais (a partir de 0.2 s)
    if (t >= 200f) {
      val q = clamp01((t - 200f) / 700f)
      if (q < 1f) {
        val d = (40f + 110f * Ez.outCubic(q)) * dens
        fill.color = withAlpha(color, (1f - q) * ga)
        val rr = 4f * dens * (1f - q) + 0.5f
        for (ang in sparkAngles) c.drawCircle(cx + cos(ang) * d, cy + sin(ang) * d, rr, fill)
      }
    }

    // glifo
    c.save()
    c.translate(cx, cy)
    c.scale(s, s)
    val k = size / 24f
    c.scale(k, k)
    c.translate(-12f, -12f)
    drawGlyph(c, kind, color, ga)
    c.restore()

    // chip (sobe do glifo)
    if (t >= 250f && (title.isNotEmpty() || subtitle.isNotEmpty())) {
      val q = clamp01((t - 250f) / 300f)
      val e = Ez.outCubic(q)
      val chipCy = lerp(cy, cy + size * 0.75f, e)
      val ca = q * ga
      titleP.textSize = 15f * dens
      subP.textSize = 12f * dens
      val tt = if (count > 1) "$title x$count" else title
      val tw = titleP.measureText(tt)
      val sw = if (subtitle.isNotEmpty()) subP.measureText(subtitle) else 0f
      val padX = 12f * dens
      val padY = 7f * dens
      val th = titleP.fontMetrics.let { it.descent - it.ascent }
      val sh = if (subtitle.isNotEmpty()) subP.fontMetrics.let { it.descent - it.ascent } else 0f
      val w = min(W - 32f * dens, max(tw, sw) + padX * 2)
      val h = th + sh + padY * 2
      rect.set(cx - w / 2, chipCy - h / 2, cx + w / 2, chipCy + h / 2)
      chipBg.color = withAlpha(0x99000000.toInt(), ca)
      c.drawRoundRect(rect, h / 2, h / 2, chipBg)
      titleP.alpha = (255 * ca).toInt()
      subP.alpha = (255 * 0.8f * ca).toInt()
      titleP.textAlign = Paint.Align.CENTER
      subP.textAlign = Paint.Align.CENTER
      c.save()
      c.clipRect(rect)
      var by = rect.top + padY - titleP.fontMetrics.ascent
      c.drawText(tt, cx, by, titleP)
      if (subtitle.isNotEmpty()) {
        by += titleP.fontMetrics.descent - subP.fontMetrics.ascent
        c.drawText(subtitle, cx, by, subP)
      }
      c.restore()
    }
    return true
  }
}
