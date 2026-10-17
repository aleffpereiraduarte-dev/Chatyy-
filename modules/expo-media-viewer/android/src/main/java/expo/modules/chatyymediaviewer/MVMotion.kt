package expo.modules.chatyymediaviewer

import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * [2026-10-16 motion] Chaves de movimento do pacote de mídia (viewer, stories,
 * grades). O JS manda os kill switches globalThis.__chatyy_motion_* via
 * ChatyyMediaViewer.setMotion({...}); sem chamada = tudo ligado.
 * "Remover animações" do sistema (escala de animação 0) desliga
 * parallax/hero/cubo/origem.
 */
object MVMotion {
  @Volatile var parallax = true
  @Volatile var chromeSlide = true
  @Volatile var flingSpring = true
  @Volatile var storyOrigin = true
  @Volatile var holdScale = true
  @Volatile var gridSpring = true

  fun apply(flags: Map<String, Any?>) {
    fun b(k: String, cur: Boolean): Boolean = (flags[k] as? Boolean) ?: cur
    parallax = b("parallax", parallax)
    chromeSlide = b("chromeSlide", chromeSlide)
    flingSpring = b("flingSpring", flingSpring)
    storyOrigin = b("storyOrigin", storyOrigin)
    holdScale = b("holdScale", holdScale)
    gridSpring = b("gridSpring", gridSpring)
  }

  /** Escala de animação 0 / animações desligadas no sistema. */
  val reduceMotion: Boolean
    get() = try { !ValueAnimator.areAnimatorsEnabled() } catch (_: Throwable) { false }

  /** Velocidade normalizada (fração da distância por segundo), limitada. */
  fun normVelocity(v: Float, remaining: Float): Float {
    if (!flingSpring || kotlin.math.abs(remaining) < 1f) return 0f
    return (v / remaining).coerceIn(-12f, 12f)
  }
}

/**
 * Mola amortecida 0→1 como interpolador (sem dependência de dynamicanimation).
 * zeta = amortecimento (< 1 = leve overshoot), omega = rigidez (rad/s),
 * v0 = velocidade inicial normalizada (fração/s). Use [durationMs] no animator.
 */
class MVSpring(private val zeta: Float = 0.82f, private val omega: Float = 15f, private val v0: Float = 0f) : TimeInterpolator {
  val durationMs: Long = (6.2f / (zeta.coerceAtLeast(0.3f) * omega) * 1000f).toLong().coerceIn(180L, 900L)

  override fun getInterpolation(input: Float): Float {
    if (input >= 1f) return 1f
    val t = input * durationMs / 1000f
    val z = zeta.coerceIn(0.05f, 0.999f)
    val wd = omega * sqrt(1f - z * z)
    val e = exp(-z * omega * t)
    return 1f - e * (cos(wd * t) + ((z * omega - v0) / wd) * sin(wd * t))
  }
}
