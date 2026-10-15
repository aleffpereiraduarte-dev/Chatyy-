package expo.modules.chatyyconversationlist

// [2026-10-15 native-wallet] Cartão-herói da carteira (Android): fundo grafite
// em degradê (+ brilho azul opcional), diamante com halo, saldo com CONTAGEM
// ROLANDO (ValueAnimator, ease-out cúbico 650 ms; animações do sistema
// desligadas = direto), referência, estatísticas, barra até o saque mínimo,
// aviso e botões (pílula 48 dp). Mesmo desenho do iOS (WLHeroView.swift).

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.animation.LinearInterpolator
import android.widget.ImageView
import android.widget.TextView
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/** Diamante com halo radial (o drawable wl_ic_diamond é colorido; sem tint). */
internal class WLDiamondView(ctx: Context) : View(ctx) {
  var halo = true
  var glyphSizePx = 0
  private val haloPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val drawable = androidx.core.content.ContextCompat.getDrawable(ctx, R.drawable.wl_ic_diamond)?.mutate()

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    val h = height.toFloat()
    if (halo && w > 0 && h > 0) {
      haloPaint.shader = RadialGradient(w / 2, h / 2, min(w, h) / 2, 0x6160A5FA, 0x0060A5FA, Shader.TileMode.CLAMP)
      canvas.drawCircle(w / 2, h / 2, min(w, h) / 2, haloPaint)
    }
    val g = if (glyphSizePx > 0) glyphSizePx else min(width, height)
    val l = (width - g) / 2
    val t = (height - g) / 2
    drawable?.setBounds(l, t, l + g, t + g)
    drawable?.draw(canvas)
  }
}

@SuppressLint("ViewConstructor")
internal class WLHeroView(ctx: Context) : ViewGroup(ctx) {
  var onAction: ((String) -> Unit)? = null

  private val d = ctx.resources.displayMetrics.density
  private fun px(v: Float): Int = (v * d + 0.5f).toInt()

  private val bg = GradientDrawable()
  private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val capsTv = label(12f, 700, WLHeroColors.sub)
  private val brandTv = label(11f, 800, WLHeroColors.faint)
  private val diamond = WLDiamondView(ctx)
  private val numTv = label(46f, 700, WLHeroColors.text)
  private val subTv = label(13f, 400, WLHeroColors.sub)
  private val noteTv = label(13f, 400, WLHeroColors.sub)
  private val statsLine = View(ctx)
  private val statsDivider = View(ctx)
  private val statViews = ArrayList<Triple<TextView, TextView, TextView>>()
  private val track = View(ctx)
  private val bar = View(ctx)
  private val progTv = label(13f, 400, WLHeroColors.sub)
  private val noticeLine = View(ctx)
  private val noticeTv = label(13f, 400, WLHeroColors.sub)
  private val buttonViews = ArrayList<TextView>()
  private val footTv = label(13f, 400, WLHeroColors.sub)

  var hero = WLHero()
    private set
  private var dark = false

  private var shown: Double? = null
  private var animTo = 0.0
  private var animator: ValueAnimator? = null

  private fun label(sizeSp: Float, weight: Int, color: Int): TextView {
    val tv = TextView(context)
    tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
    tv.typeface = CLType.weight(weight)
    tv.setTextColor(color)
    tv.includeFontPadding = false
    return tv
  }

  init {
    setWillNotDraw(false)
    clipToOutline = true
    outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        outline.setRoundRect(0, 0, view.width, view.height, 22f * d)
      }
    }
    bg.cornerRadius = 22f * d
    bg.orientation = GradientDrawable.Orientation.TL_BR
    background = bg
    capsTv.letterSpacing = 0.9f / 12f
    capsTv.isAllCaps = true
    capsTv.maxLines = 1
    capsTv.ellipsize = TextUtils.TruncateAt.END
    brandTv.letterSpacing = 2.2f / 11f
    brandTv.maxLines = 1
    numTv.maxLines = 1
    numTv.letterSpacing = -1.4f / 46f
    numTv.fontFeatureSettings = "tnum"
    subTv.fontFeatureSettings = "tnum"
    subTv.maxLines = 1
    subTv.ellipsize = TextUtils.TruncateAt.END
    footTv.gravity = Gravity.CENTER_HORIZONTAL
    statsLine.setBackgroundColor(WLHeroColors.line)
    statsDivider.setBackgroundColor(WLHeroColors.line)
    noticeLine.setBackgroundColor(WLHeroColors.line)
    val trackBg = GradientDrawable()
    trackBg.cornerRadius = 3f * d
    trackBg.setColor(WLHeroColors.fill)
    track.background = trackBg
    val barBg = GradientDrawable()
    barBg.cornerRadius = 3f * d
    barBg.setColor(Color.WHITE)
    bar.background = barBg
    for (v in listOf(capsTv, brandTv, diamond, numTv, subTv, noteTv, statsLine, statsDivider, track, bar, progTv, noticeLine, noticeTv, footTv)) addView(v)
    capsTv.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    brandTv.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    if (Build.VERSION.SDK_INT >= 21) elevation = 0f
  }

  fun configure(h: WLHero, isDark: Boolean) {
    val prevValue = hero.value
    hero = h
    dark = isDark
    val end = if (isDark) 0xFF0E0E10.toInt() else 0xFF09090A.toInt()
    val start = if (isDark) 0xFF1E1E21.toInt() else 0xFF232326.toInt()
    bg.colors = intArrayOf(start, end)
    if (isDark) bg.setStroke(max(1, (d * 0.5f).toInt()), 0x24FFFFFF) else bg.setStroke(0, Color.TRANSPARENT)
    elevation = if (isDark) 0f else 6f * d

    capsTv.text = h.caps
    brandTv.text = h.brand
    brandTv.visibility = if (h.brand.isEmpty()) GONE else VISIBLE
    diamond.visibility = if (h.diamond) VISIBLE else GONE
    diamond.glyphSizePx = px(30f)
    numTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, h.numSize)
    numTv.setTextColor(if (h.danger) WLHeroColors.danger else WLHeroColors.text)
    numTv.contentDescription = if (h.a11y.isEmpty()) "${h.caps}: ${h.text}" else h.a11y
    subTv.text = h.sub
    subTv.visibility = if (h.sub.isEmpty()) GONE else VISIBLE
    noteTv.text = h.note
    noteTv.visibility = if (h.note.isEmpty()) GONE else VISIBLE

    while (statViews.size < h.stats.size) {
      val a = label(12f, 400, WLHeroColors.sub)
      val b = label(16f, 700, WLHeroColors.text)
      b.fontFeatureSettings = "tnum"
      b.maxLines = 1
      b.ellipsize = TextUtils.TruncateAt.END
      val c = label(11f, 400, WLHeroColors.faint)
      for (v in listOf(a, b, c)) { v.maxLines = 1; addView(v) }
      statViews.add(Triple(a, b, c))
    }
    statViews.forEachIndexed { i, t ->
      val on = i < h.stats.size && i < 2
      val vis = if (on) VISIBLE else GONE
      t.first.visibility = vis; t.second.visibility = vis; t.third.visibility = vis
      if (on) {
        t.first.text = h.stats[i].label
        t.second.text = h.stats[i].value
        t.third.text = h.stats[i].sub
      }
    }
    statsLine.visibility = if (h.stats.isEmpty()) GONE else VISIBLE
    statsDivider.visibility = if (h.stats.size >= 2) VISIBLE else GONE
    val hasProg = h.progress >= 0
    track.visibility = if (hasProg) VISIBLE else GONE
    bar.visibility = if (hasProg && h.progress > 0) VISIBLE else GONE
    track.contentDescription = h.progressText
    progTv.text = h.progressText
    progTv.visibility = if (hasProg && h.progressText.isNotEmpty()) VISIBLE else GONE
    noticeTv.text = h.notice
    noticeTv.visibility = if (h.notice.isEmpty()) GONE else VISIBLE
    noticeLine.visibility = noticeTv.visibility

    val btns = if (h.notice.isEmpty()) h.buttons else emptyList()
    while (buttonViews.size < btns.size) {
      val b = label(15f, 700, Color.WHITE)
      b.gravity = Gravity.CENTER
      b.maxLines = 1
      b.ellipsize = TextUtils.TruncateAt.END
      b.isClickable = true
      b.isFocusable = true
      addView(b)
      buttonViews.add(b)
    }
    buttonViews.forEachIndexed { i, b ->
      if (i >= btns.size) { b.visibility = GONE; return@forEachIndexed }
      val m = btns[i]
      b.visibility = VISIBLE
      b.text = m.label
      b.contentDescription = if (m.a11y.isEmpty()) m.label else m.a11y
      b.tag = m
      val shape = GradientDrawable()
      shape.cornerRadius = 24f * d
      when {
        m.disabled -> { shape.setColor(0x0AFFFFFF); shape.setStroke(px(1f), WLHeroColors.line); b.setTextColor(WLHeroColors.faint) }
        m.primary -> { shape.setColor(Color.WHITE); b.setTextColor(Color.BLACK) }
        else -> { shape.setColor(Color.TRANSPARENT); shape.setStroke(px(1f), WLHeroColors.outline); b.setTextColor(WLHeroColors.text) }
      }
      b.background = android.graphics.drawable.RippleDrawable(
        android.content.res.ColorStateList.valueOf(if (m.primary && !m.disabled) 0x22000000 else 0x33FFFFFF), shape, null)
      b.isEnabled = !m.disabled
      b.setOnClickListener { v ->
        val bm = v.tag as? WLHeroButton ?: return@setOnClickListener
        if (bm.disabled) return@setOnClickListener
        v.performHapticFeedback(if (bm.primary) HapticFeedbackConstants.CONTEXT_CLICK else HapticFeedbackConstants.VIRTUAL_KEY)
        onAction?.invoke(bm.id)
      }
    }
    footTv.text = h.foot
    footTv.visibility = if (h.foot.isEmpty()) GONE else VISIBLE

    val to = h.value
    if (to != null) {
      val cur = shown
      if (prevValue == null && cur == null) startCount(0.0, to)
      else if (cur != null && cur != to && (animator == null || animTo != to)) startCount(cur, to)
      else if (animator == null) { shown = to; numTv.text = finalText(to) }
    } else {
      animator?.cancel(); animator = null
      shown = null
      numTv.text = if (h.text.isEmpty()) "—" else h.text
    }
    requestLayout()
    invalidate()
  }

  private fun finalText(v: Double): String = if (hero.text.isEmpty()) WLNumber.format(v, hero.format, hero.locale) else hero.text

  private fun animationsOff(): Boolean {
    var scale = 1f
    try { scale = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) } catch (_: Throwable) {}
    return scale == 0f
  }

  private fun startCount(from: Double, to: Double) {
    animator?.cancel(); animator = null
    animTo = to
    if (from == to || animationsOff()) {
      shown = to
      numTv.text = finalText(to)
      return
    }
    shown = from
    numTv.text = WLNumber.format(from, hero.format, hero.locale)
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 650
    a.interpolator = LinearInterpolator()
    a.addUpdateListener { va ->
      val p = (va.animatedValue as Float).toDouble()
      val e = 1 - (1 - p).pow(3.0)
      val v = from + (to - from) * e
      shown = v
      if (p >= 1.0) {
        shown = to
        numTv.text = finalText(to)
        animator = null
      } else {
        numTv.text = WLNumber.format(v, hero.format, hero.locale)
      }
    }
    animator = a
    a.start()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    val a = animator ?: return
    a.cancel()
    animator = null
    shown = animTo
    numTv.text = finalText(animTo)
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  private fun measureWrap(v: View, maxW: Int) {
    v.measure(MeasureSpec.makeMeasureSpec(max(0, maxW), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
  }

  private fun measureExact(v: View, w: Int, h: Int) {
    v.measure(MeasureSpec.makeMeasureSpec(max(0, w), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(max(0, h), MeasureSpec.EXACTLY))
  }

  /** Mede e posiciona tudo; devolve a altura. `apply` = chamar layout() nos filhos. */
  private fun run(w: Int, apply: Boolean): Int {
    val h = hero
    val padX = px(20f)
    val inner = max(0, w - padX * 2)
    var y = px(16f)

    // Topo: caixa alta + marca.
    var brandW = 0
    if (brandTv.visibility == VISIBLE) { measureWrap(brandTv, inner / 2); brandW = brandTv.measuredWidth }
    measureWrap(capsTv, inner - brandW - px(8f))
    val capsH = max(capsTv.measuredHeight, if (brandW > 0) brandTv.measuredHeight else 0)
    if (apply) {
      capsTv.layout(padX, y, padX + capsTv.measuredWidth, y + capsTv.measuredHeight)
      if (brandW > 0) brandTv.layout(w - padX - brandW, y, w - padX, y + brandTv.measuredHeight)
    }
    y += capsH + px(8f)

    // Número (encolhe até 55% se não couber).
    val lineH = px(h.numSize * 1.17f)
    val numX: Int
    var rowH = lineH
    if (h.diamond) {
      val box = px(30f * 1.7f)
      rowH = max(box, lineH)
      measureExact(diamond, box, box)
      if (apply) diamond.layout(padX - px(10f), y + (rowH - box) / 2, padX - px(10f) + box, y + (rowH - box) / 2 + box)
      numX = padX - px(10f) + box + px(2f)
    } else {
      numX = padX
    }
    val numW = max(0, w - padX - numX)
    fitNumber(numW)
    measureExact(numTv, numW, lineH)
    numTv.gravity = Gravity.CENTER_VERTICAL
    if (apply) numTv.layout(numX, y + (rowH - lineH) / 2, numX + numW, y + (rowH - lineH) / 2 + lineH)
    y += rowH

    fun block(v: TextView, top: Int) {
      if (v.visibility != VISIBLE) return
      y += top
      v.measure(MeasureSpec.makeMeasureSpec(inner, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      if (apply) v.layout(padX, y, padX + inner, y + v.measuredHeight)
      y += v.measuredHeight
    }
    block(subTv, px(2f))
    block(noteTv, px(8f))

    val hair = max(1, (d * 0.5f).toInt())
    if (h.stats.isNotEmpty()) {
      y += px(16f)
      measureExact(statsLine, inner, hair)
      if (apply) statsLine.layout(padX, y, padX + inner, y + hair)
      y += px(12f)
      val two = h.stats.size >= 2
      val colW = if (two) inner / 2 else inner
      var colH = 0
      statViews.forEachIndexed { i, t ->
        if (i >= min(2, h.stats.size)) return@forEachIndexed
        val x = padX + if (i == 0) 0 else colW + px(16f)
        val cw = if (i == 0) colW - (if (two) px(8f) else 0) else colW - px(16f)
        var cy = y
        for ((j, v) in listOf(t.first, t.second, t.third).withIndex()) {
          if (j == 2 && v.text.isNullOrEmpty()) continue
          if (j > 0) cy += px(if (j == 1) 2f else 1f)
          v.measure(MeasureSpec.makeMeasureSpec(max(0, cw), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
          if (apply) v.layout(x, cy, x + max(0, cw), cy + v.measuredHeight)
          cy += v.measuredHeight
        }
        colH = max(colH, cy - y)
      }
      if (two) {
        measureExact(statsDivider, hair, colH)
        if (apply) statsDivider.layout(padX + colW, y, padX + colW + hair, y + colH)
      }
      y += colH
    }
    if (h.progress >= 0) {
      y += px(16f)
      val th = px(6f)
      measureExact(track, inner, th)
      val p = h.progress.coerceIn(0.0, 1.0)
      val bw = if (p > 0) max((inner * p).toInt(), (inner * 0.03).toInt()) else 0
      measureExact(bar, bw, th)
      if (apply) {
        track.layout(padX, y, padX + inner, y + th)
        bar.layout(padX, y, padX + bw, y + th)
      }
      y += th
      block(progTv, px(8f))
    }
    if (noticeTv.visibility == VISIBLE) {
      y += px(16f)
      measureExact(noticeLine, inner, hair)
      if (apply) noticeLine.layout(padX, y, padX + inner, y + hair)
      y += px(12f) - px(16f)
      block(noticeTv, px(16f))
    }
    val visible = buttonViews.filter { it.visibility == VISIBLE }
    if (visible.isNotEmpty()) {
      y += if (h.stats.isEmpty() && h.progress < 0) px(20f) else px(16f)
      val gap = px(8f)
      val weights = visible.map { b -> if ((b.tag as? WLHeroButton)?.primary == true && visible.size > 1) 1.45 else 1.0 }
      val total = weights.sum()
      val avail = inner - gap * (visible.size - 1)
      var x = padX
      val bh = px(48f)
      visible.forEachIndexed { i, b ->
        val bw = (avail * (weights[i] / total)).toInt()
        measureExact(b, bw, bh)
        if (apply) b.layout(x, y, x + bw, y + bh)
        x += bw + gap
      }
      y += bh
    }
    block(footTv, px(8f))
    y += px(20f)
    return y
  }

  /** Reduz o tamanho do número até caber (adjustsFontSizeToFit, mín. 55%). */
  private fun fitNumber(availW: Int) {
    val base = hero.numSize
    numTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, base)
    if (availW <= 0) return
    val text = numTv.text?.toString() ?: return
    var size = base
    val minSize = base * 0.55f
    while (size > minSize && numTv.paint.measureText(text) > availW) {
      size -= 2f
      numTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, max(size, minSize))
    }
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = run(w, false)
    setMeasuredDimension(w, h)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    run(r - l, true)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (!hero.glow || width <= 0 || height <= 0) return
    val cx = width * 0.12f
    val r = max(width * 0.7f, height * 0.8f)
    glowPaint.shader = RadialGradient(cx, 0f, r, intArrayOf(0x3860A5FA, 0x0F3B82F6, 0x003B82F6), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
    canvas.drawRect(RectF(0f, 0f, width.toFloat(), height.toFloat()), glowPaint)
  }
}
