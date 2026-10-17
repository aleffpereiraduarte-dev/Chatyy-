package expo.modules.chatyyconversationlist

// [2026-10-15 settings-native] Linha da raiz das Configurações (Android) —
// mesmo visual da lista JS (SettingsKit): min 52 dp, padding 16/11, chip de
// ícone 32 dp (squircle, fundo suave) + título 16 + subtítulo 13 (1 linha) +
// seta (ou interruptor com haptic), separador hairline recuado 62 dp entre
// linhas; cartão = fundo arredondado 18 dp nos cantos da 1ª/última linha.

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.Switch
import android.widget.TextView
import kotlin.math.max
import kotlin.math.min

@SuppressLint("ViewConstructor", "UseSwitchCompatOrMaterialCode")
internal class STRowView(ctx: Context) : ViewGroup(ctx) {
  interface Listener {
    fun onPress(id: String)
    fun onToggle(id: String, value: Boolean)
  }

  var listener: Listener? = null

  private val d = ctx.resources.displayMetrics.density
  private val fontScale = ctx.resources.configuration.fontScale
  private fun px(v: Float): Int = (v * d + 0.5f).toInt()
  private fun sp(size: Float, cap: Float): Float = size * d * min(max(fontScale, 0.85f), cap)

  private val chip = View(ctx)
  private val chipBg = GradientDrawable()
  private val glyph = ImageView(ctx)
  private val titleTv = TextView(ctx)
  private val subTv = TextView(ctx)
  private val chevron = ImageView(ctx)
  private val toggle = Switch(ctx)
  private val cardBg = GradientDrawable()
  private val maskBg = GradientDrawable()
  private val hairPaint = Paint()

  var row = STRow()
    private set
  private var palette = STPalette.defaults(false)
  private var hasIcon = false
  private var showChevron = true
  private var isToggle = false
  private var showSeparator = false
  private var binding = false

  init {
    setWillNotDraw(false)
    isFocusable = true
    chipBg.cornerRadius = 7f * d // [2026-10-17 wa-cells] tile 30 dp, canto 7
    chip.background = chipBg
    addView(chip)
    glyph.scaleType = ImageView.ScaleType.FIT_CENTER
    addView(glyph)
    titleTv.setTextSize(TypedValue.COMPLEX_UNIT_PX, sp(16f, 1.35f))
    titleTv.letterSpacing = -0.25f / 16f
    titleTv.typeface = CLType.weight(400)
    titleTv.maxLines = 1
    titleTv.setSingleLine(true)
    titleTv.ellipsize = TextUtils.TruncateAt.END
    titleTv.includeFontPadding = false
    titleTv.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(titleTv)
    subTv.setTextSize(TypedValue.COMPLEX_UNIT_PX, sp(13f, 1.3f))
    subTv.typeface = CLType.weight(400)
    subTv.maxLines = 1
    subTv.setSingleLine(true)
    subTv.ellipsize = TextUtils.TruncateAt.END
    subTv.includeFontPadding = false
    subTv.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(subTv)
    chevron.scaleType = ImageView.ScaleType.FIT_CENTER
    chevron.setImageResource(R.drawable.cst_ic_chevron)
    addView(chevron)
    toggle.showText = false
    toggle.setOnCheckedChangeListener { v, checked ->
      if (binding) return@setOnCheckedChangeListener
      val c = if (Build.VERSION.SDK_INT >= 34) {
        if (checked) HapticFeedbackConstants.TOGGLE_ON else HapticFeedbackConstants.TOGGLE_OFF
      } else HapticFeedbackConstants.VIRTUAL_KEY
      v.performHapticFeedback(c)
      tintSwitch(checked)
      listener?.onToggle(row.id, checked)
    }
    addView(toggle)
    hairPaint.strokeWidth = max(1f, d * 0.5f)
    setOnClickListener {
      if (isToggle) toggle.toggle() else listener?.onPress(row.id)
    }
  }

  private fun tintSwitch(checked: Boolean) {
    val p = palette
    val states = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())
    toggle.trackTintList = ColorStateList(states, intArrayOf(p.switchOnTrack, p.switchOffTrack))
    toggle.thumbTintList = ColorStateList(states, intArrayOf(p.switchOnThumb, p.switchOffThumb))
    if (Build.VERSION.SDK_INT >= 29) toggle.trackTintMode = android.graphics.PorterDuff.Mode.SRC_IN
    toggle.refreshDrawableState()
  }

  fun bind(r: STRow, p: STPalette, first: Boolean, last: Boolean) {
    binding = true
    row = r
    palette = p
    isToggle = r.kind == "t"
    showSeparator = !last

    val rad = 18f * d
    val tl = if (first) rad else 0f
    val bl = if (last) rad else 0f
    val radii = floatArrayOf(tl, tl, tl, tl, bl, bl, bl, bl)
    cardBg.cornerRadii = radii
    cardBg.setColor(p.cardBg)
    maskBg.cornerRadii = radii
    maskBg.setColor(Color.WHITE)
    val ripple = ColorStateList.valueOf(if (isToggle) Color.TRANSPARENT else p.ripple)
    if (background !is RippleDrawable) background = RippleDrawable(ripple, cardBg, maskBg)
    else (background as RippleDrawable).setColor(ripple)

    val res = if (r.center) 0 else STText.drawable(r.icon)
    hasIcon = res != 0
    chip.visibility = if (hasIcon) VISIBLE else GONE
    glyph.visibility = if (hasIcon) VISIBLE else GONE
    if (hasIcon) {
      chipBg.setColor(p.chipBg)
      glyph.setImageDrawable(tintedIcon(context, res, p.chipFg))
    }

    titleTv.text = r.title
    titleTv.setTextColor(if (r.destructive) p.destructive else p.text)
    titleTv.gravity = if (r.center) Gravity.CENTER_HORIZONTAL else Gravity.START
    subTv.text = r.sub
    subTv.setTextColor(p.secondary)
    subTv.visibility = if (r.sub.isEmpty()) GONE else VISIBLE

    showChevron = !r.center && !r.destructive && !isToggle
    chevron.visibility = if (showChevron) VISIBLE else GONE
    if (showChevron) chevron.setColorFilter(p.tertiary)
    toggle.visibility = if (isToggle) VISIBLE else GONE
    if (isToggle) {
      tintSwitch(r.on)
      if (toggle.isChecked != r.on) toggle.isChecked = r.on
    }
    hairPaint.color = p.separator
    contentDescription = if (r.sub.isEmpty()) r.title else "${r.title}, ${r.sub}"
    binding = false
    requestLayout()
    invalidate()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val unspec = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
    val icon = px(30f)
    chip.measure(MeasureSpec.makeMeasureSpec(icon, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(icon, MeasureSpec.EXACTLY))
    val g = px(17f)
    glyph.measure(MeasureSpec.makeMeasureSpec(g, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(g, MeasureSpec.EXACTLY))
    val cv = px(17f)
    chevron.measure(MeasureSpec.makeMeasureSpec(cv, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(cv, MeasureSpec.EXACTLY))
    if (toggle.visibility != GONE) toggle.measure(unspec, unspec)
    val textW = max(0, textRight(w) - textLeft())
    val tw = MeasureSpec.makeMeasureSpec(textW, MeasureSpec.EXACTLY)
    titleTv.measure(tw, unspec)
    if (subTv.visibility != GONE) subTv.measure(tw, unspec)
    var textH = titleTv.measuredHeight
    if (subTv.visibility != GONE) textH += px(2f) + subTv.measuredHeight
    val h = max(px(52f), px(22f) + textH)
    setMeasuredDimension(w, h)
  }

  private fun textLeft(): Int = if (hasIcon) px(16f + 30f + 14f) else px(16f)

  private fun textRight(w: Int): Int {
    var r = w - px(16f)
    if (showChevron) r -= px(17f + 6f)
    else if (isToggle) r -= (toggle.measuredWidth + px(10f))
    return r
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    if (hasIcon) {
      val cx = px(16f)
      val cy = (h - chip.measuredHeight) / 2
      chip.layout(cx, cy, cx + chip.measuredWidth, cy + chip.measuredHeight)
      val gx = cx + (chip.measuredWidth - glyph.measuredWidth) / 2
      val gy = cy + (chip.measuredHeight - glyph.measuredHeight) / 2
      glyph.layout(gx, gy, gx + glyph.measuredWidth, gy + glyph.measuredHeight)
    }
    val tl = textLeft()
    var textH = titleTv.measuredHeight
    if (subTv.visibility != GONE) textH += px(2f) + subTv.measuredHeight
    var y = (h - textH) / 2
    titleTv.layout(tl, y, tl + titleTv.measuredWidth, y + titleTv.measuredHeight)
    y += titleTv.measuredHeight + px(2f)
    if (subTv.visibility != GONE) subTv.layout(tl, y, tl + subTv.measuredWidth, y + subTv.measuredHeight)
    if (showChevron) {
      val x = w - px(16f) - chevron.measuredWidth
      val cy = (h - chevron.measuredHeight) / 2
      chevron.layout(x, cy, x + chevron.measuredWidth, cy + chevron.measuredHeight)
    }
    if (isToggle) {
      val x = w - px(16f) - toggle.measuredWidth
      val cy = (h - toggle.measuredHeight) / 2
      toggle.layout(x, cy, x + toggle.measuredWidth, cy + toggle.measuredHeight)
    }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (showSeparator) {
      val inset = if (hasIcon && row.kind == "c") px(60f) else px(16f)
      val y = height - hairPaint.strokeWidth / 2f
      canvas.drawLine(inset.toFloat(), y, width.toFloat(), y, hairPaint)
    }
  }
}
