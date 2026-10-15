package expo.modules.chatyyconversationlist

// [2026-10-15 native-notes] Peças da lista de NOTAS nativa (Android): cabeçalho
// de seção ("Fixadas", "Com lembrete"…) e o card da nota — mesmo visual P&B do
// NoteCardItem de app/notes.js e do iOS (ios/NTCells.swift): fundo surface,
// borda fina, faixa da cor da nota, alfinete, título (2 linhas), prévia (3 na
// lista / o que couber na grade), etiquetas, lembrete, caderno e data.
// Layout manual (onMeasure/onLayout) — a mesma conta mede e posiciona.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.SpannableString
import android.text.Spanned
import android.text.TextUtils
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

// ─── Seção ─────────────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class NTSectionView(context: Context) : FrameLayout(context) {
  private val density = context.resources.displayMetrics.density
  private val label = TextView(context).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
    letterSpacing = 0.04f
    isAllCaps = true
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    includeFontPadding = false
  }
  private var hasTitle = false

  init {
    addView(label, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
      leftMargin = (NTMetrics.cellPadH * density).toInt()
      rightMargin = (NTMetrics.cellPadH * density).toInt()
      bottomMargin = (8 * density).toInt()
    })
  }

  fun bind(r: NTRow, s: NTStyle) {
    hasTitle = r.title.isNotEmpty()
    label.text = r.title
    label.setTextColor(s.colors.faint)
    label.visibility = if (hasTitle) View.VISIBLE else View.GONE
    contentDescription = r.title
    importantForAccessibility = if (hasTitle) View.IMPORTANT_FOR_ACCESSIBILITY_YES else View.IMPORTANT_FOR_ACCESSIBILITY_NO
    if (android.os.Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = hasTitle
    requestLayout()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val h = ((if (hasTitle) NTMetrics.sectionH else NTMetrics.spacerH) * density).toInt()
    super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
  }
}

// ─── Card da nota ──────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class NTCardView(context: Context) : ViewGroup(context) {
  private val density = context.resources.displayMetrics.density
  var row = NTRow()
    private set
  private var style = NTStyle()

  private val pinView = ImageView(context).apply {
    scaleType = ImageView.ScaleType.FIT_CENTER
    rotation = 20f
  }
  private val titleView = text(16f, Typeface.BOLD)
  private val previewView = text(13f, Typeface.NORMAL).apply { setLineSpacing(0f, 1.18f) }
  private val tagViews = List(4) { chip() }
  private val reminderView = chip().apply { compoundDrawablePadding = (3 * density).toInt() }
  private val notebookView = chip()
  private val dateView = text(11f, Typeface.NORMAL).apply { maxLines = 1 }

  private val cardRect = RectF()
  private val cardPath = Path()
  private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val stripPaint = Paint(Paint.ANTI_ALIAS_FLAG)

  // Posições calculadas no onMeasure (x, y) por filho.
  private val pos = HashMap<View, IntArray>()
  private var cardH = 0

  init {
    setWillNotDraw(false)
    clipChildren = true
    addView(pinView)
    addView(titleView)
    addView(previewView)
    tagViews.forEach { addView(it) }
    addView(reminderView)
    addView(notebookView)
    addView(dateView)
    isClickable = true
    isLongClickable = true
    isFocusable = true
  }

  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()

  private fun text(sp: Float, weight: Int): TextView = TextView(context).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    typeface = Typeface.create(if (weight == Typeface.BOLD) "sans-serif" else "sans-serif", weight)
    ellipsize = TextUtils.TruncateAt.END
    includeFontPadding = false
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  private fun chip(): TextView = TextView(context).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    includeFontPadding = false
    gravity = Gravity.CENTER
    setPadding(dp(8f), 0, dp(8f), 0)
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  private fun highlighted(text: String, s: NTStyle): CharSequence {
    if (s.tokens.isEmpty() || text.isEmpty()) return text
    val ranges = RLHighlight.ranges(text, s.tokens)
    if (ranges.isEmpty()) return text
    val sp = SpannableString(text)
    val bg = if (s.colors.dark) Color.argb(46, 255, 255, 255) else Color.argb(26, 0, 0, 0)
    for (r in ranges) {
      val a = max(0, min(r[0], text.length))
      val b = max(a, min(r[1], text.length))
      if (b <= a) continue
      sp.setSpan(StyleSpan(Typeface.BOLD), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      sp.setSpan(BackgroundColorSpan(bg), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      sp.setSpan(ForegroundColorSpan(s.colors.text), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    return sp
  }

  private fun chipBg(color: Int, stroke: Int?): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = NTMetrics.chipH * density / 2f
    setColor(color)
    if (stroke != null) setStroke(max(1, dp(1f)), stroke)
  }

  fun bind(r: NTRow, s: NTStyle) {
    row = r
    style = s
    fillPaint.color = s.card
    strokePaint.color = s.cardBorder
    strokePaint.strokeWidth = max(1f, density)
    stripPaint.color = r.color ?: Color.parseColor("#FFF9C4")

    pinView.visibility = if (r.pinned) View.VISIBLE else View.GONE
    if (r.pinned) pinView.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_pin, s.colors.text))

    if (r.title.isNotEmpty()) {
      titleView.text = highlighted(r.title, s)
      titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
      titleView.setTypeface(Typeface.create("sans-serif", Typeface.BOLD), Typeface.BOLD)
      titleView.setTextColor(s.colors.text)
      titleView.maxLines = 2
      titleView.visibility = View.VISIBLE
    } else if (r.preview.isEmpty() && r.placeholder.isNotEmpty()) {
      titleView.text = r.placeholder
      titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      titleView.setTypeface(Typeface.create("sans-serif", Typeface.ITALIC), Typeface.ITALIC)
      titleView.setTextColor(s.colors.sub)
      titleView.maxLines = 1
      titleView.visibility = View.VISIBLE
    } else {
      titleView.text = ""
      titleView.visibility = View.GONE
    }

    previewView.text = highlighted(r.preview, s)
    previewView.setTextColor(s.colors.sub)
    previewView.visibility = if (r.preview.isEmpty()) View.GONE else View.VISIBLE

    tagViews.forEachIndexed { i, v ->
      if (i < r.tags.size) {
        v.text = "#" + r.tags[i]
        v.setTextColor(s.colors.chipText)
        v.background = chipBg(s.colors.chipBg, null)
        v.visibility = View.VISIBLE
      } else {
        v.text = ""
        v.visibility = View.GONE
      }
    }

    if (r.reminder.isNotEmpty()) {
      reminderView.text = r.reminder
      reminderView.setTextColor(s.colors.sub)
      reminderView.paintFlags = if (r.reminderOverdue) reminderView.paintFlags or Paint.STRIKE_THRU_TEXT_FLAG
        else reminderView.paintFlags and Paint.STRIKE_THRU_TEXT_FLAG.inv()
      reminderView.background = chipBg(Color.TRANSPARENT, if (r.reminderOverdue) s.colors.hair else s.colors.border)
      val sz = dp(11f)
      val bell = tintedIcon(context, R.drawable.ccl_ic_bell, s.colors.sub)?.apply { setBounds(0, 0, sz, sz) }
      val rep = if (r.reminderRepeat) tintedIcon(context, R.drawable.nt_ic_repeat, s.colors.sub)?.apply { setBounds(0, 0, dp(10f), dp(10f)) } else null
      reminderView.setCompoundDrawablesRelative(bell, null, rep, null)
      reminderView.visibility = View.VISIBLE
    } else {
      reminderView.text = ""
      reminderView.setCompoundDrawablesRelative(null, null, null, null)
      reminderView.visibility = View.GONE
    }

    if (r.notebook.isNotEmpty()) {
      notebookView.text = r.notebook
      notebookView.setTextColor(s.colors.text)
      notebookView.background = chipBg(s.colors.chipBg, null)
      notebookView.visibility = View.VISIBLE
    } else {
      notebookView.text = ""
      notebookView.visibility = View.GONE
    }

    dateView.text = r.date
    dateView.setTextColor(s.colors.sub)
    dateView.visibility = if (r.date.isEmpty()) View.GONE else View.VISIBLE

    contentDescription = r.a11y.ifEmpty {
      listOf(r.title.ifEmpty { r.placeholder }, r.preview, r.date).filter { it.isNotEmpty() }.joinToString(", ")
    }
    requestLayout()
    invalidate()
  }

  // ─── Medida / layout ─────────────────────────────────────────────────────

  private fun measureAt(v: View, w: Int, exactW: Boolean, h: Int? = null) {
    val ws = MeasureSpec.makeMeasureSpec(max(0, w), if (exactW) MeasureSpec.EXACTLY else MeasureSpec.AT_MOST)
    val hs = if (h != null) MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY) else MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
    v.measure(ws, hs)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    pos.clear()
    val padH = dp(NTMetrics.cellPadH)
    val padV = dp(NTMetrics.cellPadV)
    val cardW = max(0, w - 2 * padH)
    val x0 = padH + dp(NTMetrics.strip) + dp(NTMetrics.padLeft)
    val innerW = max(0, cardW - dp(NTMetrics.strip) - dp(NTMetrics.padLeft) - dp(NTMetrics.padRight))
    var y = padV + dp(NTMetrics.padTop)
    val gridCardH = dp(NTMetrics.gridHeight) - 2 * padV

    val ps = dp(18f)
    measureAt(pinView, ps, true, ps)
    pos[pinView] = intArrayOf(padH + cardW - dp(10f) - ps, padV + dp(8f))

    if (titleView.visibility == View.VISIBLE) {
      measureAt(titleView, innerW - dp(24f), true)
      pos[titleView] = intArrayOf(x0, y)
      y += titleView.measuredHeight + if (row.preview.isEmpty()) 0 else dp(NTMetrics.titleGap)
    }

    val chipH = max(dp(NTMetrics.chipH), (dateView.textSize * 1.3f).toInt() + dp(6f))
    val hasTags = tagViews.any { it.visibility == View.VISIBLE }
    measureAt(dateView, innerW / 2, false)
    val footerH = max(chipH, dateView.measuredHeight)

    if (previewView.visibility == View.VISIBLE) {
      var maxLines = 3
      if (style.grid) {
        val reserved = (if (hasTags) dp(NTMetrics.rowGap) + chipH else 0) + dp(NTMetrics.rowGap) + footerH + dp(NTMetrics.padBottom)
        val avail = padV + gridCardH - y - reserved
        maxLines = max(0, floor(avail.toDouble() / max(1, previewView.lineHeight)).toInt())
      }
      if (maxLines <= 0) {
        measureAt(previewView, innerW, true, 0)
      } else {
        previewView.maxLines = maxLines
        measureAt(previewView, innerW, true)
      }
      pos[previewView] = intArrayOf(x0, y)
      y += previewView.measuredHeight
    }

    if (hasTags) {
      y += dp(NTMetrics.rowGap)
      var tx = x0
      for (v in tagViews) {
        if (v.visibility != View.VISIBLE) continue
        measureAt(v, innerW, false, chipH)
        if (tx + v.measuredWidth > x0 + innerW) {
          measureAt(v, 0, true, 0) // não coube na linha: fica de fora
          pos[v] = intArrayOf(tx, y)
          continue
        }
        pos[v] = intArrayOf(tx, y)
        tx += v.measuredWidth + dp(4f)
      }
      y += chipH
    }

    y += dp(NTMetrics.rowGap)
    cardH = if (style.grid) gridCardH else (y - padV) + footerH + dp(NTMetrics.padBottom)
    val fy = if (style.grid) padV + cardH - dp(NTMetrics.padBottom) - footerH else y
    var lx = x0
    var right = x0 + innerW
    if (dateView.visibility == View.VISIBLE) {
      pos[dateView] = intArrayOf(right - dateView.measuredWidth, fy + (footerH - dateView.measuredHeight) / 2)
      right -= dateView.measuredWidth + dp(6f)
    }
    if (reminderView.visibility == View.VISIBLE) {
      measureAt(reminderView, max(0, right - lx), false, chipH)
      if (reminderView.measuredWidth < dp(24f)) measureAt(reminderView, 0, true, 0)
      pos[reminderView] = intArrayOf(lx, fy + (footerH - chipH) / 2)
      if (reminderView.measuredWidth > 0) lx += reminderView.measuredWidth + dp(6f)
    }
    if (notebookView.visibility == View.VISIBLE) {
      measureAt(notebookView, max(0, right - lx), false, chipH)
      if (notebookView.measuredWidth < dp(24f)) measureAt(notebookView, 0, true, 0)
      pos[notebookView] = intArrayOf(lx, fy + (footerH - chipH) / 2)
    }
    val total = if (style.grid) dp(NTMetrics.gridHeight) else cardH + 2 * padV
    setMeasuredDimension(w, total)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    for (i in 0 until childCount) {
      val v = getChildAt(i)
      if (v.visibility == View.GONE) continue
      val p = pos[v] ?: intArrayOf(0, 0)
      v.layout(p[0], p[1], p[0] + v.measuredWidth, p[1] + v.measuredHeight)
    }
  }

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val padH = NTMetrics.cellPadH * density
    val padV = NTMetrics.cellPadV * density
    val rad = NTMetrics.radius * density
    cardRect.set(padH, padV, width - padH, padV + cardH)
    cardPath.reset()
    cardPath.addRoundRect(cardRect, rad, rad, Path.Direction.CW)
    fillPaint.color = if (isPressed) rlBlend(style.colors.press, style.card) else style.card
    canvas.drawPath(cardPath, fillPaint)
    canvas.save()
    canvas.clipPath(cardPath)
    canvas.drawRect(cardRect.left, cardRect.top, cardRect.left + NTMetrics.strip * density, cardRect.bottom, stripPaint)
    canvas.restore()
    val half = strokePaint.strokeWidth / 2f
    cardRect.inset(half, half)
    canvas.drawRoundRect(cardRect, rad - half, rad - half, strokePaint)
  }

  /** Retângulo do card (para o fundo do swipe acompanhar o card). */
  fun cardBounds(out: RectF) {
    val padH = NTMetrics.cellPadH * density
    val padV = NTMetrics.cellPadV * density
    out.set(left + padH, top + padV, right - padH, top + padV + cardH)
  }
}
