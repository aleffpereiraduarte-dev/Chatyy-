package expo.modules.chatyyconversationlist

// [2026-10-15 native-wallet] Linhas da carteira nativa (Android) — mesmo
// visual do iOS (WLCells.swift) e do JS (app/wallet.js TxRow/EmptyActivity):
// transação min 64 dp, ícone 40 dp em círculo `fill`, título 16 semibold,
// sub 13, valor 16 bold tabular (crédito = success) + diamante 12 dp, valor
// secundário 12; separador recuado 68 dp; cartão = cantos 18 dp por posição.

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import kotlin.math.max
import kotlin.math.min

private fun Context.wlLabel(sizeSp: Float, weight: Int): TextView {
  val tv = TextView(this)
  tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
  tv.typeface = CLType.weight(weight)
  tv.includeFontPadding = false
  return tv
}

@SuppressLint("ViewConstructor")
internal class WLTxRowView(ctx: Context) : ViewGroup(ctx) {
  var onPress: ((String) -> Unit)? = null

  private val d = ctx.resources.displayMetrics.density
  private fun px(v: Float): Int = (v * d + 0.5f).toInt()

  private val iconBg = View(ctx)
  private val iconCircle = GradientDrawable()
  private val icon = ImageView(ctx)
  private val avatar = CLAvatarView(ctx)
  private val titleTv = ctx.wlLabel(16f, 600)
  private val subTv = ctx.wlLabel(13f, 400)
  private val amountTv = ctx.wlLabel(16f, 700)
  private val diamond = WLDiamondView(ctx)
  private val amountIcon = ImageView(ctx)
  private val amount2Tv = ctx.wlLabel(12f, 400)
  private val hairPaint = Paint()
  private val cardBg = GradientDrawable()
  private val maskBg = GradientDrawable()

  var row = WLRow()
    private set
  private var showSep = false

  init {
    setWillNotDraw(false)
    iconCircle.shape = GradientDrawable.OVAL
    iconBg.background = iconCircle
    addView(iconBg)
    icon.scaleType = ImageView.ScaleType.FIT_CENTER
    addView(icon)
    avatar.setBoxDp(40f)
    addView(avatar)
    for (tv in listOf(titleTv, subTv, amountTv, amount2Tv)) {
      tv.maxLines = 1
      tv.setSingleLine(true)
      tv.ellipsize = TextUtils.TruncateAt.END
      tv.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    amountTv.fontFeatureSettings = "tnum"
    amount2Tv.fontFeatureSettings = "tnum"
    amountTv.gravity = Gravity.END
    amount2Tv.gravity = Gravity.END
    diamond.halo = false
    amountIcon.scaleType = ImageView.ScaleType.FIT_CENTER
    for (v in listOf(titleTv, subTv, amountTv, diamond, amountIcon, amount2Tv)) addView(v)
    isFocusable = true
    setOnClickListener {
      if (!row.tap) return@setOnClickListener
      performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      onPress?.invoke(row.id)
    }
  }

  fun bind(r: WLRow, p: WLPalette, first: Boolean, last: Boolean) {
    row = r
    showSep = !last
    val rad = 18f * d
    val radii = floatArrayOf(
      if (first) rad else 0f, if (first) rad else 0f, if (first) rad else 0f, if (first) rad else 0f,
      if (last) rad else 0f, if (last) rad else 0f, if (last) rad else 0f, if (last) rad else 0f
    )
    cardBg.cornerRadii = radii
    cardBg.setColor(p.cardBg)
    maskBg.cornerRadii = radii
    maskBg.setColor(0xFFFFFFFF.toInt())
    background = if (r.tap) RippleDrawable(ColorStateList.valueOf(p.press), cardBg, maskBg) else cardBg
    isClickable = r.tap

    if (r.hasTiles) {
      avatar.visibility = VISIBLE
      iconBg.visibility = GONE
      icon.visibility = GONE
      avatar.bind(r.avatarRow(), CLTheme(p.dark), p.cardBg)
    } else {
      avatar.visibility = GONE
      iconBg.visibility = VISIBLE
      icon.visibility = VISIBLE
      iconCircle.setColor(p.fill)
      icon.setImageDrawable(tintedIcon(context, WLGlyphs.res(r.glyph), p.text))
    }
    titleTv.text = r.title
    titleTv.setTextColor(p.text)
    subTv.text = r.sub
    subTv.setTextColor(p.secondary)
    subTv.visibility = if (r.sub.isEmpty()) GONE else VISIBLE
    amountTv.text = r.amount
    amountTv.setTextColor(if (r.credit) p.success else p.text)
    diamond.visibility = if (r.diamond) VISIBLE else GONE
    amountIcon.visibility = if (r.amountGlyph.isEmpty()) GONE else VISIBLE
    if (r.amountGlyph.isNotEmpty()) amountIcon.setImageDrawable(tintedIcon(context, WLGlyphs.res(r.amountGlyph), p.secondary))
    amount2Tv.text = r.amount2
    amount2Tv.setTextColor(p.secondary)
    amount2Tv.visibility = if (r.amount2.isEmpty()) GONE else VISIBLE
    hairPaint.color = p.separator
    contentDescription = if (r.a11y.isNotEmpty()) r.a11y else listOf(r.title, r.amount, r.sub).filter { it.isNotEmpty() }.joinToString(". ")
    requestLayout()
    invalidate()
  }

  private fun wrap(v: View, maxW: Int) {
    v.measure(MeasureSpec.makeMeasureSpec(max(0, maxW), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val lead = px(40f)
    avatar.measure(MeasureSpec.makeMeasureSpec(lead, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(lead, MeasureSpec.EXACTLY))
    iconBg.measure(MeasureSpec.makeMeasureSpec(lead, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(lead, MeasureSpec.EXACTLY))
    val ic = px(20f)
    icon.measure(MeasureSpec.makeMeasureSpec(ic, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(ic, MeasureSpec.EXACTLY))
    val g12 = px(12f)
    diamond.measure(MeasureSpec.makeMeasureSpec(g12, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(g12, MeasureSpec.EXACTLY))
    val g14 = px(14f)
    amountIcon.measure(MeasureSpec.makeMeasureSpec(g14, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(g14, MeasureSpec.EXACTLY))
    wrap(amountTv, (w * 0.45f).toInt())
    wrap(amount2Tv, (w * 0.45f).toInt())
    val rightW = rightWidth(w)
    val textW = max(0, w - px(16f) - lead - px(12f) - px(8f) - rightW - px(16f))
    wrap(titleTv, textW)
    wrap(subTv, textW)
    val textH = titleTv.measuredHeight + if (subTv.visibility == VISIBLE) px(3f) + subTv.measuredHeight else 0
    val h = max(px(64f), textH + px(24f))
    setMeasuredDimension(w, h)
  }

  private fun rightWidth(w: Int): Int {
    val extra = (if (row.diamond) px(16f) else 0) + (if (row.amountGlyph.isNotEmpty()) px(18f) else 0)
    val a2 = if (amount2Tv.visibility == VISIBLE) amount2Tv.measuredWidth else 0
    return min((w * 0.45f).toInt(), max(amountTv.measuredWidth + extra, a2))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    val lead = px(40f)
    val lx = px(16f)
    val ly = (h - lead) / 2
    avatar.layout(lx, ly, lx + lead, ly + lead)
    iconBg.layout(lx, ly, lx + lead, ly + lead)
    val ic = icon.measuredWidth
    icon.layout(lx + (lead - ic) / 2, ly + (lead - ic) / 2, lx + (lead - ic) / 2 + ic, ly + (lead - ic) / 2 + ic)

    val right = w - px(16f)
    val rightW = rightWidth(w)
    val amtH = amountTv.measuredHeight
    val colH = amtH + if (amount2Tv.visibility == VISIBLE) px(2f) + amount2Tv.measuredHeight else 0
    var ry = (h - colH) / 2
    var ax = right
    if (row.diamond) {
      val g = diamond.measuredWidth
      diamond.layout(right - g, ry + (amtH - g) / 2, right, ry + (amtH - g) / 2 + g)
      ax = right - g - px(4f)
    }
    val amtW = min(amountTv.measuredWidth, max(0, ax - (right - rightW)))
    amountTv.layout(ax - amtW, ry, ax, ry + amtH)
    if (row.amountGlyph.isNotEmpty()) {
      val g = amountIcon.measuredWidth
      val gx = ax - amtW - px(4f) - g
      amountIcon.layout(gx, ry + (amtH - g) / 2, gx + g, ry + (amtH - g) / 2 + g)
    }
    ry += amtH + px(2f)
    if (amount2Tv.visibility == VISIBLE) amount2Tv.layout(right - amount2Tv.measuredWidth, ry, right, ry + amount2Tv.measuredHeight)

    val tx = lx + lead + px(12f)
    val textH = titleTv.measuredHeight + if (subTv.visibility == VISIBLE) px(3f) + subTv.measuredHeight else 0
    var ty = (h - textH) / 2
    titleTv.layout(tx, ty, tx + titleTv.measuredWidth, ty + titleTv.measuredHeight)
    ty += titleTv.measuredHeight + px(3f)
    if (subTv.visibility == VISIBLE) subTv.layout(tx, ty, tx + subTv.measuredWidth, ty + subTv.measuredHeight)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (!showSep) return
    val hair = max(1f, d * 0.5f)
    canvas.drawRect(px(68f).toFloat(), height - hair, width.toFloat(), height.toFloat(), hairPaint)
  }
}

@SuppressLint("ViewConstructor")
internal class WLEmptyView(ctx: Context) : ViewGroup(ctx) {
  var onAction: ((String, String) -> Unit)? = null

  private val d = ctx.resources.displayMetrics.density
  private fun px(v: Float): Int = (v * d + 0.5f).toInt()

  private val circle = View(ctx)
  private val ring = GradientDrawable()
  private val icon = ImageView(ctx)
  private val titleTv = ctx.wlLabel(17f, 600)
  private val subTv = ctx.wlLabel(13f, 400)
  private val button = ctx.wlLabel(15f, 700)
  private val bg = GradientDrawable()
  private var row = WLRow()

  init {
    bg.cornerRadius = 18f * d
    background = bg
    ring.shape = GradientDrawable.OVAL
    circle.background = ring
    addView(circle)
    icon.scaleType = ImageView.ScaleType.FIT_CENTER
    addView(icon)
    titleTv.gravity = Gravity.CENTER_HORIZONTAL
    subTv.gravity = Gravity.CENTER_HORIZONTAL
    subTv.setLineSpacing(0f, 1.15f)
    button.gravity = Gravity.CENTER
    button.setPadding(px(20f), 0, px(20f), 0)
    button.maxLines = 1
    button.isClickable = true
    button.isFocusable = true
    button.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      onAction?.invoke(row.id, if (row.buttonAction.isEmpty()) "button" else row.buttonAction)
    }
    for (v in listOf(titleTv, subTv, button)) addView(v)
  }

  fun bind(r: WLRow, p: WLPalette) {
    row = r
    bg.setColor(p.cardBg)
    ring.setColor(0)
    ring.setStroke(px(1f), p.separator)
    icon.setImageDrawable(tintedIcon(context, WLGlyphs.res(if (r.glyph.isEmpty()) "receipt" else r.glyph), p.secondary))
    titleTv.text = r.title
    titleTv.setTextColor(p.text)
    subTv.text = r.sub
    subTv.setTextColor(p.secondary)
    subTv.visibility = if (r.sub.isEmpty()) GONE else VISIBLE
    button.text = r.button
    button.setTextColor(p.text)
    val shape = GradientDrawable()
    shape.cornerRadius = 20f * d
    shape.setStroke(px(1f), p.ink)
    button.background = RippleDrawable(ColorStateList.valueOf(p.press), shape, null)
    button.visibility = if (r.button.isEmpty()) GONE else VISIBLE
    requestLayout()
  }

  private fun run(w: Int, apply: Boolean): Int {
    val inner = max(0, w - px(40f))
    var y = px(32f)
    val c = px(60f)
    if (apply) {
      circle.layout((w - c) / 2, y, (w - c) / 2 + c, y + c)
      val ic = px(26f)
      icon.layout((w - ic) / 2, y + (c - ic) / 2, (w - ic) / 2 + ic, y + (c - ic) / 2 + ic)
    }
    y += c + px(12f)
    for ((i, v) in listOf(titleTv, subTv).withIndex()) {
      if (v.visibility != VISIBLE) continue
      if (i > 0) y += px(4f)
      v.measure(MeasureSpec.makeMeasureSpec(inner, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      if (apply) v.layout(px(20f), y, px(20f) + inner, y + v.measuredHeight)
      y += v.measuredHeight
    }
    if (button.visibility == VISIBLE) {
      y += px(16f)
      button.measure(MeasureSpec.makeMeasureSpec(inner, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(px(40f), MeasureSpec.EXACTLY))
      val bw = button.measuredWidth
      if (apply) button.layout((w - bw) / 2, y, (w - bw) / 2 + bw, y + px(40f))
      y += px(40f)
    }
    return y + px(32f)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val c = px(60f)
    circle.measure(MeasureSpec.makeMeasureSpec(c, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(c, MeasureSpec.EXACTLY))
    val ic = px(26f)
    icon.measure(MeasureSpec.makeMeasureSpec(ic, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(ic, MeasureSpec.EXACTLY))
    setMeasuredDimension(w, run(w, false))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    run(r - l, true)
  }
}

internal object WLSimpleViews {
  fun day(ctx: Context): TextView {
    val tv = ctx.wlLabel(13f, 600)
    tv.maxLines = 1
    tv.ellipsize = TextUtils.TruncateAt.END
    return tv
  }

  fun note(ctx: Context): TextView {
    val tv = ctx.wlLabel(12f, 400)
    tv.gravity = Gravity.CENTER_HORIZONTAL
    tv.setLineSpacing(0f, 1.15f)
    return tv
  }

  fun loading(ctx: Context): ProgressBar {
    val pb = ProgressBar(ctx)
    pb.isIndeterminate = true
    return pb
  }
}
