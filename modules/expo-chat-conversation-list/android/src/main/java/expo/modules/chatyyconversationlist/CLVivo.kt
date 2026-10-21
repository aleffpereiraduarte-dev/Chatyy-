package expo.modules.chatyyconversationlist

// [2026-10-21 lista-viva, apiVersion 12] Peças da "lista de conversas viva"
// (mockup aprovado preview-2026/lista.html) — espelho de ios/CLVivo.swift.
// Só entram com a prop `vivo`; sem ela a lista desenha exatamente como antes.
//   • CLVivoDots  — "digitando" com 3 pontinhos que sobem e acendem
//   • CLWaveBars  — "gravando áudio" com ondinha de 5 barras
// Um ValueAnimator por view, ligado só visível + na janela; "Remover
// animações" (ANIMATOR_DURATION_SCALE 0) = parado.

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.PI
import kotlin.math.cos

/** Três pontinhos (5 dp, vão 3): opacidade 0,25→1 e sobe 2 dp; 1,2 s, defasados 0,15 s. */
internal class CLVivoDots(ctx: Context) : View(ctx) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private var phaseMs = 0f
  private var anim: ValueAnimator? = null
  private var still = false
  var color: Int = 0xFF000000.toInt()
    set(v) { if (field != v) { field = v; invalidate() } }

  fun setActive(on: Boolean) {
    visibility = if (on) VISIBLE else GONE
    if (on && isAttachedToWindow) start() else stop()
  }

  private fun start() {
    if (anim != null) return
    still = CLMotion.reduced(context)
    if (still) { invalidate(); return }
    val a = ValueAnimator.ofFloat(0f, 1200f)
    a.duration = 1200
    a.repeatCount = ValueAnimator.INFINITE
    a.interpolator = LinearInterpolator()
    a.addUpdateListener { phaseMs = it.animatedValue as Float; invalidate() }
    anim = a
    a.start()
  }

  private fun stop() {
    anim?.cancel()
    anim = null
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (visibility == VISIBLE) start()
  }

  override fun onDetachedFromWindow() {
    stop()
    super.onDetachedFromWindow()
  }

  /** Keyframes do CSS: 0 % e 60–100 % = repouso; 30 % = aceso e 2 dp acima. */
  private fun bump(p: Float): Float {
    if (p >= 0.6f) return 0f
    return if (p < 0.3f) p / 0.3f else 1f - (p - 0.3f) / 0.3f
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val d = resources.displayMetrics.density
    val r = 2.5f * d
    val cy = height / 2f
    for (i in 0 until 3) {
      var k: Float
      if (still) {
        k = 0f
        paint.color = color
        paint.alpha = ((1f - 0.3f * i) * (color ushr 24)).toInt()
      } else {
        var p = ((phaseMs - i * 150f) % 1200f) / 1200f
        if (p < 0f) p += 1f
        k = bump(p)
        paint.color = color
        paint.alpha = ((0.25f + 0.75f * k) * (color ushr 24)).toInt()
      }
      canvas.drawCircle(r + i * 8f * d, cy - 2f * d * k, r, paint)
    }
  }

  companion object { const val WIDTH_DP = 21f }
}

/** Ondinha de 5 barras (2,5 dp, vão 2; alturas 6/12/8/13/5): scaleY 1→0,4→1, 1 s. */
internal class CLWaveBars(ctx: Context) : View(ctx) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val rect = RectF()
  private var phaseMs = 0f
  private var anim: ValueAnimator? = null
  private var still = false
  var color: Int = 0xFF000000.toInt()
    set(v) { if (field != v) { field = v; invalidate() } }

  fun setActive(on: Boolean) {
    visibility = if (on) VISIBLE else GONE
    if (on && isAttachedToWindow) start() else stop()
  }

  private fun start() {
    if (anim != null) return
    still = CLMotion.reduced(context)
    if (still) { invalidate(); return }
    val a = ValueAnimator.ofFloat(0f, 1000f)
    a.duration = 1000
    a.repeatCount = ValueAnimator.INFINITE
    a.interpolator = LinearInterpolator()
    a.addUpdateListener { phaseMs = it.animatedValue as Float; invalidate() }
    anim = a
    a.start()
  }

  private fun stop() {
    anim?.cancel()
    anim = null
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (visibility == VISIBLE) start()
  }

  override fun onDetachedFromWindow() {
    stop()
    super.onDetachedFromWindow()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val d = resources.displayMetrics.density
    val mid = height / 2f
    paint.color = color
    for (i in 0 until 5) {
      var s = 1f
      if (!still) {
        var p = ((phaseMs - i * 100f) % 1000f) / 1000f
        if (p < 0f) p += 1f
        // ease-in-out 1 → 0,4 → 1 (cosseno)
        s = 0.7f + 0.3f * cos(2.0 * PI * p).toFloat()
      }
      val h = HEIGHTS[i] * d * s
      val x = i * 4.5f * d
      rect.set(x, mid - h / 2f, x + 2.5f * d, mid + h / 2f)
      canvas.drawRoundRect(rect, 1.25f * d, 1.25f * d, paint)
    }
  }

  companion object {
    const val WIDTH_DP = 21f
    private val HEIGHTS = floatArrayOf(6f, 12f, 8f, 13f, 5f)
  }
}
