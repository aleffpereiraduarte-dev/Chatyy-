package expo.modules.chatyyconversationlist

// [2026-10-15 native-contacts] Peças da lista de contatos nativa (Android):
// cabeçalho de seção (também usado como cabeçalho FIXO sobreposto), linha de
// contato (avatar CLAvatarView + nome/selo/NOVO + e-mail/@ + recado + chip/
// última interação + Convidar/estrela/lixeira/check) e o ÍNDICE A–Z lateral
// com arrasto, balão e haptic (como os Contatos do iOS).

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import kotlin.math.max
import kotlin.math.min

internal fun View.ctPx(v: Float): Int = Math.round(v * resources.displayMetrics.density)

internal fun ctLabel(ctx: Context, sizeSp: Float, weight: Int, lines: Int = 1): TextView {
  val tv = TextView(ctx)
  tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
  tv.typeface = CLType.weight(weight)
  tv.includeFontPadding = false
  tv.maxLines = lines
  if (lines == 1) tv.setSingleLine(true)
  tv.ellipsize = TextUtils.TruncateAt.END
  return tv
}

private fun withAlpha(c: Int, a: Float): Int =
  Color.argb((Color.alpha(c) * a).toInt().coerceIn(0, 255), Color.red(c), Color.green(c), Color.blue(c))

// ─── Cabeçalho de seção ─────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CTSectionView(ctx: Context) : LinearLayout(ctx) {
  private val bar = View(ctx)
  private val barBg = GradientDrawable()
  private val label = ctLabel(ctx, 13f, 600)
  private val hairPaint = Paint().apply { style = Paint.Style.FILL }
  private var showHair = false
  var row = CTRow()
    private set

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    barBg.cornerRadius = ctPx(1.5f).toFloat()
    bar.background = barBg
    addView(bar, LayoutParams(ctPx(3f), ctPx(12f)).apply { marginEnd = ctPx(8f) })
    addView(label, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    setWillNotDraw(false)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  fun bind(r: CTRow, c: CTColors) {
    row = r
    setBackgroundColor(r.sBg ?: c.bg)
    bar.visibility = if (r.sBar) VISIBLE else GONE
    barBg.setColor(withAlpha(c.primary, 0.6f))
    label.setTextSize(TypedValue.COMPLEX_UNIT_SP, r.sSize)
    label.typeface = CLType.weight(r.sWeight)
    label.setTextColor(r.sFg ?: c.faint)
    label.letterSpacing = if (r.sSize > 0f) r.sSpacing / r.sSize else 0f
    label.text = if (r.sUpper) r.title.uppercase() else r.title
    setPadding(ctPx(r.sPadH), ctPx(r.sPadTop), ctPx(r.sPadH), ctPx(r.sPadBottom))
    showHair = r.sHair
    hairPaint.color = c.hair
    contentDescription = r.title
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (showHair) {
      val h = max(1f, resources.displayMetrics.density * 0.5f)
      canvas.drawRect(0f, height - h, width.toFloat(), height.toFloat(), hairPaint)
    }
  }
}

// ─── Linha 1: nome encolhe, selo/NOVO ficam visíveis ────────────────────────

internal class CTTitleLine(ctx: Context) : ViewGroup(ctx) {
  val title = ctLabel(ctx, 16f, 600)
  val badge = ImageView(ctx)
  val newBadge = ctLabel(ctx, 9f, 800)
  private val gap = ctPx(6f)

  init {
    addView(title)
    badge.scaleType = ImageView.ScaleType.FIT_CENTER
    addView(badge, LayoutParams(ctPx(13f), ctPx(13f)))
    newBadge.setPadding(ctPx(6f), ctPx(2f), ctPx(6f), ctPx(2f))
    addView(newBadge)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val unspec = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
    var extras = 0
    var h = 0
    if (badge.visibility != GONE) {
      badge.measure(MeasureSpec.makeMeasureSpec(ctPx(13f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(ctPx(13f), MeasureSpec.EXACTLY))
      extras += badge.measuredWidth + gap
      h = max(h, badge.measuredHeight)
    }
    if (newBadge.visibility != GONE) {
      newBadge.measure(unspec, unspec)
      extras += newBadge.measuredWidth + gap
      h = max(h, newBadge.measuredHeight)
    }
    val tw = max(0, w - extras)
    title.measure(MeasureSpec.makeMeasureSpec(tw, MeasureSpec.AT_MOST), unspec)
    h = max(h, title.measuredHeight)
    setMeasuredDimension(w, h)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val h = b - t
    var x = 0
    val rtl = layoutDirection == LAYOUT_DIRECTION_RTL
    val w = r - l
    fun place(v: View) {
      val vw = v.measuredWidth
      val vh = v.measuredHeight
      val y = (h - vh) / 2
      if (rtl) v.layout(w - x - vw, y, w - x, y + vh) else v.layout(x, y, x + vw, y + vh)
      x += vw + gap
    }
    place(title)
    if (badge.visibility != GONE) place(badge)
    if (newBadge.visibility != GONE) place(newBadge)
  }
}

// ─── Linha de contato ───────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CTRowView(ctx: Context) : LinearLayout(ctx) {
  interface Listener {
    fun onPress(id: String)
    fun onLongPress(id: String)
    fun onAction(id: String, action: String)
  }

  var listener: Listener? = null
  var row = CTRow()
    private set
  private var colors = CTColors()

  private val avatarBox = FrameLayout(ctx)
  private val avatarRingBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
  private val avatar = CLAvatarView(ctx)
  private val glyph = ImageView(ctx)
  private val glyphBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }

  private val info = LinearLayout(ctx)
  private val line1 = CTTitleLine(ctx)
  private val newBadgeBg = GradientDrawable()
  private val line2 = ctLabel(ctx, 13f, 400)
  private val line3 = ctLabel(ctx, 12f, 400)
  private val line4 = LinearLayout(ctx)
  private val chip = ctLabel(ctx, 10f, 600)
  private val chipBg = GradientDrawable()
  private val meta = ctLabel(ctx, 10f, 400)

  private val pill = LinearLayout(ctx)
  private val pillBg = GradientDrawable()
  private val pillIcon = ImageView(ctx)
  private val pillText = ctLabel(ctx, 12f, 700)
  private val pillSpinner = ProgressBar(ctx)
  private val star = ImageView(ctx)
  private val trash = ImageView(ctx)
  private val check = CLCheckView(ctx)

  private val rowBg = ColorDrawable(Color.WHITE)
  private val hairPaint = Paint().apply { style = Paint.Style.FILL }
  private var metrics = CTMetrics()

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setWillNotDraw(false)

    avatarBox.addView(avatar, FrameLayout.LayoutParams(ctPx(40f), ctPx(40f), Gravity.CENTER))
    glyph.scaleType = ImageView.ScaleType.CENTER
    glyph.background = glyphBg
    avatarBox.addView(glyph, FrameLayout.LayoutParams(ctPx(44f), ctPx(44f), Gravity.CENTER))
    addView(avatarBox, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))

    info.orientation = VERTICAL
    info.addView(line1, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    info.addView(line2, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    info.addView(line3, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    line4.orientation = HORIZONTAL
    line4.gravity = Gravity.CENTER_VERTICAL
    chipBg.cornerRadius = ctPx(4f).toFloat()
    chip.background = chipBg
    chip.setPadding(ctPx(6f), ctPx(1f), ctPx(6f), ctPx(1f))
    line4.addView(chip, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginEnd = ctPx(6f) })
    line4.addView(meta, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    info.addView(line4, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(info, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))

    pill.orientation = HORIZONTAL
    pill.gravity = Gravity.CENTER
    pill.background = pillBg
    pillIcon.scaleType = ImageView.ScaleType.FIT_CENTER
    pill.addView(pillIcon, LayoutParams(ctPx(13f), ctPx(13f)).apply { marginEnd = ctPx(6f) })
    pill.addView(pillText, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    pill.addView(pillSpinner, LayoutParams(ctPx(14f), ctPx(14f)))
    pill.isClickable = true
    pill.setOnClickListener { listener?.onAction(row.id, "pill") }
    pill.setOnLongClickListener {
      performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      listener?.onAction(row.id, "pillLong")
      true
    }
    addView(pill, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = ctPx(5f) })

    star.scaleType = ImageView.ScaleType.CENTER_INSIDE
    star.setPadding(ctPx(5f), ctPx(5f), ctPx(5f), ctPx(5f))
    star.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      listener?.onAction(row.id, "star")
    }
    addView(star, LayoutParams(ctPx(28f), ctPx(28f)))

    trash.scaleType = ImageView.ScaleType.CENTER_INSIDE
    trash.setPadding(ctPx(5f), ctPx(5f), ctPx(5f), ctPx(5f))
    trash.setOnClickListener { listener?.onAction(row.id, "delete") }
    addView(trash, LayoutParams(ctPx(26f), ctPx(26f)))

    addView(check, LayoutParams(ctPx(24f), ctPx(24f)).apply { marginStart = ctPx(8f) })

    setOnClickListener { if (row.tap) listener?.onPress(row.id) }
    setOnLongClickListener {
      if (!row.longPress) return@setOnLongClickListener false
      performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      listener?.onLongPress(row.id)
      true
    }
  }

  fun bind(r: CTRow, c: CTColors, m: CTMetrics) {
    row = r
    colors = c
    metrics = m
    val gap = ctPx(m.gap)
    setPadding(ctPx(m.padH), ctPx(m.padV), ctPx(m.padH), ctPx(m.padV))
    minimumHeight = ctPx(m.minH)

    rowBg.color = c.bg
    if (background !is RippleDrawable) {
      background = RippleDrawable(ColorStateList.valueOf(c.press), rowBg, null)
    } else {
      (background as RippleDrawable).setColor(ColorStateList.valueOf(c.press))
    }
    isClickable = r.tap || r.longPress
    hairPaint.color = c.hair

    // Avatar / glifo
    val avLp = avatarBox.layoutParams as LayoutParams
    avLp.marginEnd = gap
    if (r.glyph.isNotEmpty()) {
      avatar.visibility = GONE
      glyph.visibility = VISIBLE
      glyphBg.setColor(r.glyphBg ?: Color.parseColor("#111111"))
      glyph.setImageDrawable(tintedIcon(context, R.drawable.cct_ic_user_plus, Color.WHITE)?.also {
        it.setBounds(0, 0, ctPx(18f), ctPx(18f))
      })
      glyph.scaleType = ImageView.ScaleType.FIT_CENTER
      val p = ctPx(13f)
      glyph.setPadding(p, p, p, p)
      avatarBox.background = null
      avatarBox.setPadding(0, 0, 0, 0)
    } else {
      glyph.visibility = GONE
      avatar.visibility = VISIBLE
      val side = ctPx(r.avatar)
      val alp = avatar.layoutParams as FrameLayout.LayoutParams
      if (alp.width != side) {
        alp.width = side
        alp.height = side
        avatar.layoutParams = alp
      }
      avatar.setBoxDp(r.avatar)
      avatar.bind(r.avatarRow(), c.theme, c.bg)
      if (r.avatarRing) {
        avatarRingBg.setColor(Color.TRANSPARENT)
        avatarRingBg.setStroke(max(1, ctPx(1f)), c.hair)
        avatarBox.background = avatarRingBg
        val p = ctPx(2f) + max(1, ctPx(1f))
        avatarBox.setPadding(p, p, p, p)
      } else {
        avatarBox.background = null
        avatarBox.setPadding(0, 0, 0, 0)
      }
    }
    avatarBox.layoutParams = avLp

    // Linha 1: nome (+ sufixo "(Você)") · selo Chatyy · NOVO
    val t = line1.title
    t.setTextSize(TypedValue.COMPLEX_UNIT_SP, m.nameSize)
    t.typeface = CLType.weight(r.titleWeight)
    t.setTextColor(c.text)
    if (r.suffix.isNotEmpty()) {
      val sb = SpannableStringBuilder(r.title).append(" ")
      val st = sb.length
      sb.append(r.suffix)
      sb.setSpan(ForegroundColorSpan(c.faint), st, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      sb.setSpan(CLTypefaceSpan(CLType.weight(500)), st, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      t.text = sb
    } else {
      t.text = r.title
    }
    if (r.verified) {
      line1.badge.visibility = VISIBLE
      line1.badge.setImageDrawable(tintedIcon(context, R.drawable.cct_ic_verified, c.primary))
    } else {
      line1.badge.visibility = GONE
    }
    if (r.newBadge.isNotEmpty()) {
      line1.newBadge.visibility = VISIBLE
      line1.newBadge.text = r.newBadge
      line1.newBadge.setTextColor(c.onPrimary)
      line1.newBadge.letterSpacing = 0.5f / 9f
      newBadgeBg.cornerRadius = ctPx(8f).toFloat()
      newBadgeBg.setColor(c.primary)
      line1.newBadge.background = newBadgeBg
    } else {
      line1.newBadge.visibility = GONE
    }

    // Linha 2: e-mail / telefone (+ @usuário)
    if (r.sub.isNotEmpty() || r.username.isNotEmpty()) {
      line2.visibility = VISIBLE
      line2.setTextSize(TypedValue.COMPLEX_UNIT_SP, m.subSize)
      line2.setTextColor(if (r.subTone == 1) c.faint else c.sub)
      if (r.username.isNotEmpty()) {
        val sb = SpannableStringBuilder(r.sub)
        if (sb.isNotEmpty()) sb.append("  ")
        val st = sb.length
        sb.append("@").append(r.username)
        sb.setSpan(ForegroundColorSpan(c.text), st, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        sb.setSpan(CLTypefaceSpan(CLType.weight(600)), st, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        line2.text = sb
      } else {
        line2.text = r.sub
      }
      (line2.layoutParams as LayoutParams).topMargin = ctPx(2f)
    } else {
      line2.visibility = GONE
    }

    // Linha 3: recado / visto por último / telefone
    if (r.sub2.isNotEmpty()) {
      line3.visibility = VISIBLE
      line3.setTextSize(TypedValue.COMPLEX_UNIT_SP, m.sub2Size)
      line3.setTextColor(when (r.sub2Tone) { 1 -> c.faint; 2 -> withAlpha(c.faint, 0.6f); else -> c.sub })
      line3.setTypeface(CLType.weight(400), if (r.sub2Italic) Typeface.ITALIC else Typeface.NORMAL)
      line3.text = r.sub2
      (line3.layoutParams as LayoutParams).topMargin = ctPx(if (r.sub2Italic) 3f else 1f)
    } else {
      line3.visibility = GONE
    }

    // Linha 4: grupo + última interação
    if (r.chip.isNotEmpty() || r.meta.isNotEmpty()) {
      line4.visibility = VISIBLE
      (line4.layoutParams as LayoutParams).topMargin = ctPx(3f)
      chip.visibility = if (r.chip.isNotEmpty()) VISIBLE else GONE
      chip.text = r.chip
      chip.setTextColor(c.chipText)
      chipBg.setColor(c.chipBg)
      meta.visibility = if (r.meta.isNotEmpty()) VISIBLE else GONE
      meta.text = r.meta
      meta.setTextSize(TypedValue.COMPLEX_UNIT_SP, m.metaSize)
      meta.setTextColor(c.faint)
    } else {
      line4.visibility = GONE
    }

    // Convidar
    if (r.pill.isNotEmpty()) {
      pill.visibility = VISIBLE
      if (r.pillFilled) {
        pillBg.cornerRadius = ctPx(14f).toFloat()
        pillBg.setColor(c.primary)
        pillBg.setStroke(0, Color.TRANSPARENT)
        pill.setPadding(ctPx(16f), 0, ctPx(16f), 0)
        pill.minimumHeight = ctPx(32f)
        pillText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        pillText.typeface = CLType.weight(700)
        pillText.letterSpacing = 0.2f / 12f
        pillText.setTextColor(c.onPrimary)
        pill.elevation = ctPx(2f).toFloat()
      } else {
        pillBg.cornerRadius = ctPx(14f).toFloat()
        pillBg.setColor(Color.TRANSPARENT)
        pillBg.setStroke(max(1, ctPx(1f)), c.text)
        pill.setPadding(ctPx(12f), ctPx(5f), ctPx(12f), ctPx(5f))
        pill.minimumHeight = 0
        pillText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        pillText.typeface = CLType.weight(600)
        pillText.letterSpacing = 0.1f / 13f
        pillText.setTextColor(c.text)
        pill.elevation = 0f
      }
      pillText.text = r.pill
      pill.contentDescription = r.pill
      val busy = r.pillBusy
      pillSpinner.visibility = if (busy) VISIBLE else GONE
      pillSpinner.indeterminateTintList = ColorStateList.valueOf(if (r.pillFilled) c.onPrimary else c.text)
      pillText.visibility = if (busy) GONE else VISIBLE
      pillIcon.visibility = if (!busy && r.pillIcon) VISIBLE else GONE
      if (r.pillIcon) pillIcon.setImageDrawable(tintedIcon(context, R.drawable.cct_ic_user_plus, if (r.pillFilled) c.onPrimary else c.text))
      pill.isEnabled = !busy
    } else {
      pill.visibility = GONE
    }

    // Estrela / lixeira / check
    if (r.star > 0) {
      star.visibility = VISIBLE
      val on = r.star == 2
      star.setImageDrawable(tintedIcon(context, if (on) R.drawable.cct_ic_star_fill else R.drawable.cct_ic_star, if (on) c.warning else c.faint))
      star.alpha = if (on) 1f else 0.4f
      star.contentDescription = r.a11y
    } else {
      star.visibility = GONE
    }
    if (r.trash) {
      trash.visibility = VISIBLE
      trash.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_trash, c.faint))
    } else {
      trash.visibility = GONE
    }
    if (r.check > 0) {
      check.visibility = VISIBLE
      check.checked = r.check == 2
      check.onColor = c.primary
      check.tickColor = c.onPrimary
      check.borderTint = c.border
    } else {
      check.visibility = GONE
    }

    contentDescription = r.a11y.ifEmpty { listOf(r.title, r.sub).filter { it.isNotEmpty() }.joinToString(", ") }
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val h = max(1f, resources.displayMetrics.density * 0.5f)
    canvas.drawRect(0f, height - h, width.toFloat(), height.toFloat(), hairPaint)
  }
}

// ─── Índice A–Z lateral ─────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CTIndexBar(ctx: Context) : View(ctx) {
  var letters: List<String> = emptyList()
    set(v) { field = v; requestLayout(); invalidate() }
  var color = Color.BLACK
    set(v) { field = v; paint.color = v; invalidate() }
  /** Área útil (px, relativa à própria view) onde as letras ficam centradas. */
  var rangeTop = 0
    set(v) { if (field != v) { field = v; invalidate() } }
  var rangeBottom = 0
    set(v) { if (field != v) { field = v; invalidate() } }
  var onLetter: ((String, Float) -> Unit)? = null
  var onRelease: (() -> Unit)? = null

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textAlign = Paint.Align.CENTER
    typeface = CLType.weight(600)
    textSize = ctx.dp(11f)
  }
  private var current = -1

  private fun slot(): Float = min(ctPx(16f).toFloat(), (rangeBottom - rangeTop - ctPx(8f)).toFloat() / max(1, letters.size))
  private fun startY(): Float = rangeTop + ((rangeBottom - rangeTop) - slot() * letters.size) / 2f

  fun fits(): Boolean = letters.isNotEmpty() && (rangeBottom - rangeTop) >= letters.size * ctPx(14f) + ctPx(24f)

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (letters.isEmpty()) return
    val s = slot()
    val y0 = startY()
    val fm = paint.fontMetrics
    val cx = width / 2f
    letters.forEachIndexed { i, l ->
      val cy = y0 + s * i + s / 2f
      canvas.drawText(l, cx, cy - (fm.ascent + fm.descent) / 2f, paint)
    }
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(e: MotionEvent): Boolean {
    if (letters.isEmpty()) return false
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> {
        parent?.requestDisallowInterceptTouchEvent(true)
        val s = slot()
        if (s <= 0f) return true
        val i = ((e.y - startY()) / s).toInt().coerceIn(0, letters.size - 1)
        if (i != current) {
          current = i
          performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
          onLetter?.invoke(letters[i], startY() + s * i + s / 2f)
        }
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        current = -1
        onRelease?.invoke()
        return true
      }
    }
    return true
  }
}
