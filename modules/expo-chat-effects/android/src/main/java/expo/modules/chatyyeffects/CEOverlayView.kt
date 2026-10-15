package expo.modules.chatyyeffects

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.os.PowerManager
import android.provider.Settings
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout

/**
 * [2026-10-15 native-effects] Overlay de partículas no DecorView.
 *
 * Uma View por Activity (tag) desenha todos os efeitos ativos em onDraw; o
 * Choreographer invalida a cada vsync (60/90/120 Hz conforme o display) só
 * enquanto há efeito vivo. Sem efeito → a View se remove. Não é clicável nem
 * focável: os toques passam direto para o app. Unidades internas = dp (o
 * canvas é escalado pela densidade), tempos em ms — iguais ao JS.
 */
class CEOverlayView(context: Context) : View(context), Choreographer.FrameCallback {
  private val effects = ArrayList<CEEffect>()
  private var ticking = false
  private val density = resources.displayMetrics.density

  init {
    isClickable = false
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    setWillNotDraw(false)
    tag = TAG
  }

  fun widthDp(): Float = (if (width > 0) width else resources.displayMetrics.widthPixels) / density
  fun heightDp(): Float = (if (height > 0) height else resources.displayMetrics.heightPixels) / density

  fun add(e: CEEffect) {
    effects.removeAll { it.name == e.name }
    effects.add(e)
    if (!ticking) {
      ticking = true
      Choreographer.getInstance().postFrameCallback(this)
    }
    invalidate()
  }

  fun clear() {
    effects.clear()
    invalidate()
  }

  override fun doFrame(frameTimeNanos: Long) {
    if (effects.isEmpty() || !isAttachedToWindow) {
      ticking = false
      if (effects.isEmpty()) post { if (effects.isEmpty()) (parent as? ViewGroup)?.removeView(this) }
      return
    }
    invalidate()
    Choreographer.getInstance().postFrameCallback(this)
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    if (ticking) Choreographer.getInstance().removeFrameCallback(this)
    ticking = false
    effects.clear()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (effects.isEmpty()) return
    val now = System.nanoTime()
    canvas.save()
    canvas.scale(density, density)
    val it = effects.iterator()
    while (it.hasNext()) {
      val e = it.next()
      if (e.startNs == 0L) e.startNs = now
      val t = (now - e.startNs) / 1_000_000f
      if (t > e.ttl) { it.remove(); continue }
      try { e.draw(canvas, t) } catch (_: Throwable) { it.remove() }
    }
    canvas.restore()
  }

  companion object {
    const val TAG = "chatyy.effects.overlay"

    private val NAMES = setOf(
      "echo", "spotlight", "balloons", "confetti", "love", "lasers", "fireworks",
      "shooting-star", "celebration", "hearts", "fire", "party"
    )

    private fun animationsOff(ctx: Context): Boolean = try {
      Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    } catch (_: Throwable) { false }

    private fun num(v: Any?): Float? {
      val d = (v as? Number)?.toFloat() ?: return null
      return if (d.isNaN() || d.isInfinite()) null else d
    }

    fun play(activity: Activity?, name: String, opts: Map<String, Any?>): Boolean {
      if (name !in NAMES) return false
      val act = activity ?: return false
      if (act.isFinishing) return false
      // "Remover animações" (acessibilidade): assumimos e não animamos.
      if (animationsOff(act)) return true
      val decor = act.window?.decorView as? ViewGroup ?: return false
      var ov = decor.findViewWithTag<CEOverlayView>(TAG)
      if (ov == null) {
        ov = CEOverlayView(act)
        decor.addView(ov, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      } else {
        ov.bringToFront()
      }
      val night = (act.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
      val dark = (opts["dark"] as? Boolean) ?: night
      var intensity = (num(opts["intensity"]) ?: 1f).coerceIn(0.3f, 1.6f)
      try {
        val pm = act.getSystemService(Context.POWER_SERVICE) as? PowerManager
        if (pm?.isPowerSaveMode == true) intensity *= 0.6f
      } catch (_: Throwable) {}
      val x = num(opts["x"]); val y = num(opts["y"]); val w = num(opts["w"]); val h = num(opts["h"])
      val origin = if (x != null && y != null && w != null && h != null && w > 0f && h > 0f) floatArrayOf(x, y, w, h) else null
      val emoji = (opts["emoji"] as? String)?.takeIf { it.isNotEmpty() }?.take(16)
      val dens = act.resources.displayMetrics.density
      val wDp = if (decor.width > 0) decor.width / dens else ov.widthDp()
      val hDp = if (decor.height > 0) decor.height / dens else ov.heightDp()
      val o = CEOpts(wDp, hDp, dark, intensity, origin, emoji, act.resources.displayMetrics.density)
      val e = CEEffects.create(name, o) ?: return false
      ov.add(e)
      return true
    }

    fun stopAll(activity: Activity?) {
      val decor = activity?.window?.decorView as? ViewGroup ?: return
      decor.findViewWithTag<CEOverlayView>(TAG)?.clear()
    }
  }
}
