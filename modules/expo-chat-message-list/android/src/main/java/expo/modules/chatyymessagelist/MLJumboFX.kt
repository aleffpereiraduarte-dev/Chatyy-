package expo.modules.chatyymessagelist

import android.animation.ValueAnimator
import android.os.Build

/**
 * [2026-10-15 native-effects] Emoji grande (1–3 emojis sem balão): anima UMA
 * vez por mensagem quando a linha entra na tela, estilo Telegram — coração
 * "bate" duas vezes, os demais dão um pulo com leve giro. Mesmos keyframes do
 * iOS (ios/CMLJumboFX.swift). "Remover animações" → nada.
 */
object MLJumboFX {
  private val played = HashSet<String>()

  fun claim(key: String): Boolean {
    if (key.isEmpty()) return false
    if (Build.VERSION.SDK_INT >= 26 && !ValueAnimator.areAnimatorsEnabled()) return false
    if (played.contains(key)) return false
    if (played.size > 5000) played.clear()
    played.add(key)
    return true
  }

  fun isHeart(s: String): Boolean {
    var i = 0
    while (i < s.length) {
      val cp = s.codePointAt(i)
      if (cp == 0x2764 || cp == 0x2763 || cp in 0x1F493..0x1F49F || cp == 0x1F5A4 || cp == 0x1F90D || cp == 0x1F90E || cp == 0x1F9E1 || cp in 0x1FA75..0x1FA77) return true
      i += Character.charCount(cp)
    }
    return false
  }

  private val HT = floatArrayOf(0f, 0.2f, 0.38f, 0.56f, 0.78f, 1f)
  private val HS = floatArrayOf(0.6f, 1.24f, 0.95f, 1.16f, 0.98f, 1f)
  private val JT = floatArrayOf(0f, 0.35f, 0.6f, 0.8f, 1f)
  private val JS = floatArrayOf(0.55f, 1.2f, 0.93f, 1.05f, 1f)
  private val JR = floatArrayOf(0f, -8f, 5.7f, -2.3f, 0f)

  fun duration(heart: Boolean): Long = if (heart) 1000L else 750L

  private fun kf(p: Float, t: FloatArray, v: FloatArray): Float {
    if (p <= t[0]) return v[0]
    for (i in 1 until t.size) {
      if (p <= t[i]) {
        val f = (p - t[i - 1]) / (t[i] - t[i - 1])
        return v[i - 1] + (v[i] - v[i - 1]) * f
      }
    }
    return v[v.size - 1]
  }

  /** p = fração já com ease-out aplicado. */
  fun scale(heart: Boolean, p: Float): Float = if (heart) kf(p, HT, HS) else kf(p, JT, JS)
  fun rotation(heart: Boolean, p: Float): Float = if (heart) 0f else kf(p, JT, JR)
}
