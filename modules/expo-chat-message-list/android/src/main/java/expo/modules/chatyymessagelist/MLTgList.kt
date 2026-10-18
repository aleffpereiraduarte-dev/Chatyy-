package expo.modules.chatyymessagelist

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.TextPaint
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.LinearLayout
import java.text.Normalizer
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

// [2026-10-18 tg-list, apiVersion 11] Lista "nível Telegram" (Android):
//   MLSearchState  realce dos termos da busca (setSearch {term, ids, cur, scroll})
//   MLOverlay      botões flutuantes de baixo (↓ com não lidas, @ menções, ♥ reações)
//   MLPopLayer     pop do emoji do toque duplo p/ reagir (quickReact)
// Tudo opt-in: sem as props/funções novas o comportamento é o da api 10.

/** Estado da busca: tokens dobrados (sem acento/caixa), ids das mensagens que bateram, atual. */
class MLSearchState(val tokens: List<String>, val ids: Set<String>, val cur: String, val version: Int) {
  val active: Boolean get() = tokens.isNotEmpty() && ids.isNotEmpty()

  fun matches(row: MLRow?): Boolean = row != null && active && row.kind == MLKind.MSG && !row.deleted && row.id.isNotEmpty() && row.id in ids

  companion object {
    private fun foldCp(s: String): String {
      val n = try { Normalizer.normalize(s, Normalizer.Form.NFD) } catch (_: Throwable) { s }
      val sb = StringBuilder(n.length)
      var i = 0
      while (i < n.length) {
        val cp = n.codePointAt(i)
        val t = Character.getType(cp)
        if (t != Character.NON_SPACING_MARK.toInt() && t != Character.ENCLOSING_MARK.toInt()) sb.appendCodePoint(cp)
        i += Character.charCount(cp)
      }
      return sb.toString().lowercase(Locale.ROOT)
    }

    fun fold(s: String): String {
      val sb = StringBuilder(s.length)
      var i = 0
      while (i < s.length) {
        val cp = s.codePointAt(i)
        val n = Character.charCount(cp)
        sb.append(foldCp(s.substring(i, i + n)))
        i += n
      }
      return sb.toString()
    }

    fun tokensOf(term: String): List<String> =
      fold(term).split(Regex("\\s+")).filter { it.isNotEmpty() }.take(8)

    /** Ocorrências (offsets UTF-16 do texto ORIGINAL, [início, fim)) de cada token. */
    fun ranges(text: String, tokens: List<String>): List<IntArray> {
      if (text.isEmpty() || tokens.isEmpty()) return emptyList()
      val sb = StringBuilder(text.length)
      val os = IntArray(text.length * 3 + 8)
      val oe = IntArray(text.length * 3 + 8)
      var cnt = 0
      var i = 0
      while (i < text.length) {
        val cp = text.codePointAt(i)
        val n = Character.charCount(cp)
        val f = foldCp(text.substring(i, i + n))
        for (ch in f) {
          if (cnt >= os.size) break
          sb.append(ch); os[cnt] = i; oe[cnt] = i + n; cnt++
        }
        i += n
      }
      val folded = sb.toString()
      val out = ArrayList<IntArray>()
      for (tk in tokens) {
        var from = 0
        var guard = 0
        while (guard++ < 200) {
          val idx = folded.indexOf(tk, from)
          if (idx < 0) break
          val last = idx + tk.length - 1
          if (last >= cnt) break
          out.add(intArrayOf(os[idx], oe[last]))
          from = idx + max(1, tk.length)
        }
      }
      return out
    }

    /** Retângulos arredondados atrás dos glifos (coords do layout). */
    fun draw(c: Canvas, layout: Layout, ranges: List<IntArray>, paint: Paint, radius: Float, pad: Float) {
      val len = layout.text.length
      val r = RectF()
      for (rg in ranges) {
        val a = rg[0].coerceIn(0, len)
        val b = rg[1].coerceIn(a, len)
        if (b <= a) continue
        val la = layout.getLineForOffset(a)
        val lb = layout.getLineForOffset(max(a, b - 1))
        for (line in la..lb) {
          val ls = layout.getLineStart(line)
          val le = layout.getLineEnd(line)
          val s0 = max(a, ls)
          val e0 = min(b, le)
          if (e0 <= s0) continue
          val x1 = layout.getPrimaryHorizontal(s0)
          val x2 = if (e0 >= le && line < layout.lineCount - 1) layout.getLineRight(line) else layout.getPrimaryHorizontal(e0)
          var l = min(x1, x2); var rr = max(x1, x2)
          if (rr - l < 1f) { if (e0 >= le) rr = max(rr, layout.getLineRight(line)) else continue }
          l -= pad; rr += pad
          r.set(l, layout.getLineTop(line).toFloat(), rr, layout.getLineBottom(line).toFloat())
          c.drawRoundRect(r, radius, radius, paint)
        }
      }
    }
  }
}

/** Um botão redondo do overlay (círculo 44 dp + badge no topo). */
private class MLOverlayButton(context: Context, val kind: String) : View(context) {
  private val d = resources.displayMetrics.density
  private fun dp(v: Float) = v * d
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val txt = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD); textAlign = Paint.Align.CENTER }
  private val path = Path()
  var dark = false
  var wall = 0xFFFFFFFF.toInt()
  var count = 0
    set(v) {
      val up = v > field && field >= 0 && shownState
      field = v
      if (up) punch()
      invalidate()
    }
  var shownState = false
  private var badgeScale = 1f
  private var punchAnim: ValueAnimator? = null
  private val circle = RectF()

  init {
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    visibility = GONE
    alpha = 0f
    outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        outline.setOval(dp(4f).toInt(), dp(12f).toInt(), dp(48f).toInt(), dp(56f).toInt())
      }
    }
    elevation = dp(3f)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(dp(52f).toInt(), dp(58f).toInt())
  }

  private fun punch() {
    punchAnim?.cancel()
    val a = ValueAnimator.ofFloat(1.3f, 1f)
    a.duration = 320
    a.interpolator = OvershootInterpolator(3f)
    a.addUpdateListener { badgeScale = it.animatedValue as Float; invalidate() }
    punchAnim = a
    a.start()
  }

  fun cancelAnims() { punchAnim?.cancel(); punchAnim = null; badgeScale = 1f; animate().cancel() }

  override fun onDraw(c: Canvas) {
    super.onDraw(c)
    circle.set(dp(4f), dp(12f), dp(48f), dp(56f))
    val cx = circle.centerX(); val cy = circle.centerY()
    fill.color = if (dark) 0xFF1C1C1E.toInt() else 0xFFFFFFFF.toInt()
    c.drawOval(circle, fill)
    stroke.color = if (dark) 0x1AFFFFFF else 0x1A000000
    stroke.strokeWidth = max(1f, dp(0.5f))
    c.drawOval(circle, stroke)
    if (isPressed) { fill.color = if (dark) 0x14FFFFFF else 0x0F000000; c.drawOval(circle, fill) }
    val ink = if (dark) 0xFFF5F5F7.toInt() else 0xFF111111.toInt()
    when (kind) {
      "down" -> {
        stroke.color = ink; stroke.strokeWidth = dp(2.2f)
        path.reset()
        path.moveTo(cx - dp(6f), cy - dp(2.5f)); path.lineTo(cx, cy + dp(3.5f)); path.lineTo(cx + dp(6f), cy - dp(2.5f))
        c.drawPath(path, stroke)
      }
      "mention" -> {
        txt.color = ink; txt.textSize = dp(20f)
        val fm = txt.fontMetrics
        c.drawText("@", cx, cy - (fm.ascent + fm.descent) / 2, txt)
      }
      else -> {
        // coração (caixa 24 → 20 dp)
        val s = dp(20f) / 24f
        val ox = cx - 12f * s; val oy = cy - 12f * s
        path.reset()
        path.moveTo(ox + 12f * s, oy + 20.5f * s)
        path.cubicTo(ox + 5f * s, oy + 15.5f * s, ox + 2.5f * s, oy + 12f * s, ox + 2.5f * s, oy + 8.5f * s)
        path.cubicTo(ox + 2.5f * s, oy + 5.5f * s, ox + 4.8f * s, oy + 3.5f * s, ox + 7.5f * s, oy + 3.5f * s)
        path.cubicTo(ox + 9.4f * s, oy + 3.5f * s, ox + 11f * s, oy + 4.6f * s, ox + 12f * s, oy + 6.2f * s)
        path.cubicTo(ox + 13f * s, oy + 4.6f * s, ox + 14.6f * s, oy + 3.5f * s, ox + 16.5f * s, oy + 3.5f * s)
        path.cubicTo(ox + 19.2f * s, oy + 3.5f * s, ox + 21.5f * s, oy + 5.5f * s, ox + 21.5f * s, oy + 8.5f * s)
        path.cubicTo(ox + 21.5f * s, oy + 12f * s, ox + 19f * s, oy + 15.5f * s, ox + 12f * s, oy + 20.5f * s)
        path.close()
        fill.color = ink
        c.drawPath(path, fill)
      }
    }
    if (count > 0) {
      val label = if (count > 99) "99+" else count.toString()
      txt.textSize = dp(12f)
      val tw = txt.measureText(label)
      val bh = dp(20f)
      val bw = max(bh, tw + dp(12f))
      val bcy = dp(12f) + dp(1f)
      c.save()
      c.scale(badgeScale, badgeScale, cx, bcy)
      val br = RectF(cx - bw / 2, bcy - bh / 2, cx + bw / 2, bcy + bh / 2)
      fill.color = wall
      val ring = dp(1.5f)
      c.drawRoundRect(RectF(br.left - ring, br.top - ring, br.right + ring, br.bottom + ring), bh / 2 + ring, bh / 2 + ring, fill)
      fill.color = if (dark) 0xFFFFFFFF.toInt() else 0xFF111111.toInt()
      c.drawRoundRect(br, bh / 2, bh / 2, fill)
      txt.color = if (dark) 0xFF111111.toInt() else 0xFFFFFFFF.toInt()
      val fm = txt.fontMetrics
      c.drawText(label, cx, bcy - (fm.ascent + fm.descent) / 2, txt)
      c.restore()
    }
  }

  override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
}

/**
 * [tg-list] Overlay inferior nativo: pilha à direita (de baixo p/ cima: ↓, @, ♥).
 * ↓ aparece com distância até o fim > 300 dp; @/♥ com contador > 0. Toque →
 * onPress(kind) (o JS decide o que fazer).
 */
class MLOverlay(context: Context, private val onPress: (String) -> Unit) : LinearLayout(context) {
  private val reaction = MLOverlayButton(context, "reaction")
  private val mention = MLOverlayButton(context, "mention")
  private val down = MLOverlayButton(context, "down")
  var on = false; private set
  private var unread = 0
  private var mentions = 0
  private var reactions = 0
  var extraBottomDp = 12f; private set
  private var dark = false
  private var wall = 0xFFFFFFFF.toInt()
  private var distDp = 0f
  private var suppressed = false

  init {
    orientation = VERTICAL
    gravity = Gravity.BOTTOM or Gravity.END
    clipChildren = false
    clipToPadding = false
    for (b in listOf(reaction, mention, down)) {
      addView(b, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
      b.setOnClickListener { if (b.shownState) onPress(b.kind) }
    }
  }

  fun configure(m: Map<String, Any?>?, wallColor: Int) {
    on = m != null && MLRow.bool(m["on"])
    wall = wallColor
    if (m != null) {
      unread = (MLRow.num(m["unread"]) ?: 0.0).toInt().coerceAtLeast(0)
      mentions = (MLRow.num(m["mention"]) ?: 0.0).toInt().coerceAtLeast(0)
      reactions = (MLRow.num(m["reaction"]) ?: 0.0).toInt().coerceAtLeast(0)
      extraBottomDp = (MLRow.num(m["b"]) ?: 12.0).toFloat()
      dark = MLRow.bool(m["dark"])
      val ax = m["ax"] as? Map<*, *>
      down.contentDescription = (ax?.get("down") as? String) ?: "Scroll to bottom"
      mention.contentDescription = (ax?.get("mention") as? String) ?: "Mentions"
      reaction.contentDescription = (ax?.get("reaction") as? String) ?: "Reactions"
    }
    for (b in listOf(reaction, mention, down)) { b.dark = dark; b.wall = wall }
    down.count = unread
    mention.count = mentions
    reaction.count = reactions
    refresh()
  }

  fun setWall(c: Int) { wall = c; for (b in listOf(reaction, mention, down)) { b.wall = c; b.invalidate() } }

  fun setDist(dp: Float) { if (dp != distDp) { distDp = dp; refresh() } }

  fun setSuppressed(v: Boolean) { if (v != suppressed) { suppressed = v; refresh() } }

  private fun refresh() {
    val base = on && !suppressed
    show(down, base && distDp > 300f)
    show(mention, base && mentions > 0)
    show(reaction, base && reactions > 0)
  }

  private fun show(b: MLOverlayButton, v: Boolean) {
    if (b.shownState == v) return
    b.shownState = v
    b.animate().cancel()
    val anim = MLMotion.systemOn()
    b.pivotX = b.resources.displayMetrics.density * 26f
    b.pivotY = b.resources.displayMetrics.density * 34f
    if (v) {
      b.visibility = VISIBLE
      if (!anim) { b.alpha = 1f; b.scaleX = 1f; b.scaleY = 1f; return }
      if (b.alpha < 0.05f) { b.scaleX = 0.85f; b.scaleY = 0.85f }
      b.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(350).setInterpolator(OvershootInterpolator(1.2f)).setListener(null).start()
    } else {
      if (!anim) { b.alpha = 0f; b.visibility = GONE; return }
      b.animate().alpha(0f).scaleX(0.85f).scaleY(0.85f).setDuration(200).setInterpolator(DecelerateInterpolator())
        .setListener(object : AnimatorListenerAdapter() {
          override fun onAnimationEnd(animation: Animator) { if (!b.shownState) b.visibility = GONE }
        }).start()
    }
  }

  fun destroy() { for (b in listOf(reaction, mention, down)) b.cancelAnims() }
}

/** [tg-list] Camada (sem toque) que desenha o pop do emoji do toque duplo. */
class MLPopLayer(context: Context) : View(context) {
  private class Pop(val emoji: String, val cx: Float, val cy: Float, val size: Float) { var p = 0f; var anim: ValueAnimator? = null }
  private val pops = ArrayList<Pop>()
  private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }
  private val d = resources.displayMetrics.density

  init {
    isClickable = false
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    setWillNotDraw(false)
  }

  fun pop(emoji: String, cx: Float, cy: Float) {
    if (pops.size > 6) pops.removeAt(0).anim?.cancel()
    val p = Pop(emoji.ifEmpty { "❤️" }, cx, cy, 36f * d)
    pops.add(p)
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = if (MLMotion.systemOn()) 600 else 1
    a.interpolator = LinearInterpolator()
    a.addUpdateListener { p.p = it.animatedValue as Float; invalidate() }
    a.addListener(object : AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: Animator) { pops.remove(p); invalidate() }
    })
    p.anim = a
    a.start()
  }

  fun cancelAll() { for (p in ArrayList(pops)) p.anim?.cancel(); pops.clear(); invalidate() }

  override fun onDraw(c: Canvas) {
    super.onDraw(c)
    for (p in pops) {
      val t = p.p
      // 0→1.25 (0..0.25) → 1 (0.25..0.4) → 1; sobe 24 dp (ease out); some nos últimos 40%
      val sc = when {
        t < 0.25f -> 1.25f * (t / 0.25f)
        t < 0.4f -> 1.25f - 0.25f * ((t - 0.25f) / 0.15f)
        else -> 1f
      }
      val e = 1f - (1f - t) * (1f - t)
      val ty = -24f * d * e
      val al = if (t < 0.6f) 1f else max(0f, 1f - (t - 0.6f) / 0.4f)
      if (sc <= 0.01f || al <= 0f) continue
      paint.textSize = p.size
      paint.alpha = (255 * al).toInt()
      val fm = paint.fontMetrics
      c.save()
      c.translate(p.cx, p.cy + ty)
      c.scale(sc, sc)
      c.drawText(p.emoji, 0f, -(fm.ascent + fm.descent) / 2, paint)
      c.restore()
    }
  }
}
