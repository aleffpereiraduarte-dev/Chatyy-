package expo.modules.chatyyconversationlist

// [2026-10-15 native-apps] Linhas da agenda do calendário nativo (Android):
// cabeçalho do dia, cartão de evento (faixa de cor, hora, local, repetição,
// reunião + "Entrar", selos) e vazio com "Novo evento". Mesmo visual do iOS
// (ios/CACells.swift) e do SwipeableEventCard do app/calendar.js (P&B).

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

private fun Context.caDp(v: Float): Int = (v * resources.displayMetrics.density + 0.5f).toInt()

private fun caAlpha(c: Int, a: Float): Int {
  val base = (c ushr 24) and 0xFF
  return (c and 0x00FFFFFF) or (((base * a).toInt().coerceIn(0, 255)) shl 24)
}

private fun caRound(color: Int, radiusPx: Float, stroke: Int = 0, strokeColor: Int = 0): GradientDrawable =
  GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = radiusPx
    setColor(color)
    if (stroke > 0) setStroke(stroke, strokeColor)
  }

private fun caText(ctx: Context, sp: Float, bold: Int = 0): TextView = TextView(ctx).apply {
  setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
  typeface = when (bold) {
    0 -> Typeface.DEFAULT
    1 -> Typeface.create("sans-serif-medium", Typeface.NORMAL)
    else -> Typeface.DEFAULT_BOLD
  }
  includeFontPadding = false
  maxLines = 1
  ellipsize = TextUtils.TruncateAt.END
}

@SuppressLint("ViewConstructor")
internal class CAHeaderRowView(ctx: Context) : LinearLayout(ctx) {
  private val hair = View(ctx)
  private val line = LinearLayout(ctx)
  private val title = caText(ctx, 14f, 2)
  private val count = caText(ctx, 13f)

  init {
    orientation = VERTICAL
    addView(hair, LayoutParams(LayoutParams.MATCH_PARENT, 1).apply { topMargin = ctx.caDp(3f) })
    line.orientation = HORIZONTAL
    line.gravity = Gravity.CENTER_VERTICAL
    line.setPadding(ctx.caDp(8f), ctx.caDp(6f), ctx.caDp(8f), ctx.caDp(6f))
    line.addView(title, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    line.addView(count, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { leftMargin = ctx.caDp(8f) })
    addView(line, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  fun bind(row: CARow, style: CAStyle) {
    val c = style.colors
    setBackgroundColor(c.bg)
    hair.setBackgroundColor(c.border)
    (hair.layoutParams as LayoutParams).topMargin = context.caDp(if (row.top) 8f else 3f)
    hair.requestLayout()
    title.text = row.title
    title.setTextColor(c.text)
    count.text = row.sub
    count.setTextColor(c.sub)
    contentDescription = if (row.sub.isEmpty()) row.title else "${row.title}, ${row.sub}"
    if (android.os.Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
  }
}

/** "ícone + texto" do cartão (some quando o texto é vazio). */
@SuppressLint("ViewConstructor")
private class CAMetaLine(ctx: Context) : LinearLayout(ctx) {
  private val icon = ImageView(ctx)
  private val label = caText(ctx, 13f)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    val s = ctx.caDp(13f)
    addView(icon, LayoutParams(s, s))
    addView(label, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = ctx.caDp(5f) })
  }

  fun set(res: Int, text: String, color: Int, bold: Boolean = false) {
    visibility = if (text.isEmpty()) GONE else VISIBLE
    if (text.isEmpty()) return
    icon.setImageDrawable(tintedIcon(context, res, color))
    label.text = text
    label.setTextColor(color)
    label.typeface = if (bold) Typeface.create("sans-serif-medium", Typeface.BOLD) else Typeface.DEFAULT
  }
}

@SuppressLint("ViewConstructor")
internal class CAEventRowView(ctx: Context) : FrameLayout(ctx) {
  var onPress: ((String) -> Unit)? = null
  var onAction: ((String, String) -> Unit)? = null
  var row = CARow()
    private set

  private val card = LinearLayout(ctx)
  private val accent = View(ctx)
  private val body = LinearLayout(ctx)
  private val titleRow = LinearLayout(ctx)
  private val title = caText(ctx, 16f, 2)
  private val rel = caText(ctx, 12f, 2)
  private val timeLine = CAMetaLine(ctx)
  private val locLine = CAMetaLine(ctx)
  private val recLine = CAMetaLine(ctx)
  private val meetLine = CAMetaLine(ctx)
  private val right = LinearLayout(ctx)
  private val syncIcon = ImageView(ctx)
  private val bellIcon = ImageView(ctx)
  private val calLabel = caText(ctx, 12f, 1)
  private val join = LinearLayout(ctx)
  private val joinIcon = ImageView(ctx)
  private val joinText = caText(ctx, 13f, 1)

  init {
    val d = { v: Float -> ctx.caDp(v) }
    setPadding(d(8f), 0, d(8f), d(6f))
    clipToPadding = false
    clipChildren = false

    card.orientation = LinearLayout.HORIZONTAL
    card.isClickable = true
    card.isFocusable = true
    card.setOnClickListener { onPress?.invoke(row.id) }
    addView(card, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

    card.addView(accent, LinearLayout.LayoutParams(d(5f), LinearLayout.LayoutParams.MATCH_PARENT))

    body.orientation = LinearLayout.VERTICAL
    body.setPadding(d(14f), d(13f), d(8f), d(13f))
    card.addView(body, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

    titleRow.orientation = LinearLayout.HORIZONTAL
    titleRow.gravity = Gravity.CENTER_VERTICAL
    titleRow.addView(title, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    rel.setPadding(d(8f), d(3f), d(8f), d(3f))
    titleRow.addView(rel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = d(8f) })
    body.addView(titleRow)
    for (l in listOf(timeLine, locLine, recLine, meetLine)) {
      body.addView(l, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = d(7f) })
    }

    right.orientation = LinearLayout.VERTICAL
    right.gravity = Gravity.END or Gravity.CENTER_VERTICAL
    right.setPadding(0, d(6f), d(10f), d(6f))
    card.addView(right, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT))
    for (iv in listOf(syncIcon, bellIcon)) {
      iv.scaleType = ImageView.ScaleType.CENTER_INSIDE
      iv.setPadding(d(4f), d(4f), d(4f), d(4f))
      right.addView(iv, LinearLayout.LayoutParams(d(18f), d(18f)).apply { bottomMargin = d(5f); gravity = Gravity.END })
    }
    calLabel.setPadding(d(8f), d(3f), d(8f), d(3f))
    right.addView(calLabel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { gravity = Gravity.END })
    calLabel.maxWidth = d(120f)

    join.orientation = LinearLayout.HORIZONTAL
    join.gravity = Gravity.CENTER_VERTICAL
    join.setPadding(d(12f), d(8f), d(12f), d(8f))
    join.isClickable = true
    join.isFocusable = true
    join.addView(joinIcon, LinearLayout.LayoutParams(d(14f), d(14f)))
    join.addView(joinText, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = d(4f) })
    join.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      onAction?.invoke(row.id, "join")
    }
    right.addView(join, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = d(8f); gravity = Gravity.END })
  }

  fun bind(r: CARow, style: CAStyle) {
    row = r
    val c = style.colors
    val ctx = context
    setBackgroundColor(c.bg)
    val radius = ctx.caDp(16f).toFloat()
    val bgShape = if (c.dark) caRound(style.card, radius, 1, c.border) else caRound(style.card, radius)
    card.background = android.graphics.drawable.RippleDrawable(
      android.content.res.ColorStateList.valueOf(c.press), bgShape, caRound(0xFF000000.toInt(), radius)
    )
    card.elevation = if (c.dark) 0f else ctx.caDp(2f).toFloat()
    card.outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
    card.clipToOutline = true
    val acc = r.accent ?: c.text
    accent.setBackgroundColor(acc)

    title.text = r.title
    title.setTextColor(c.text)
    rel.visibility = if (r.rel.isEmpty()) View.GONE else View.VISIBLE
    rel.text = r.rel
    rel.setTextColor(acc)
    rel.background = caRound(caAlpha(acc, 0.1f), ctx.caDp(6f).toFloat())

    timeLine.set(R.drawable.ccl_ic_clock, r.time, c.sub)
    locLine.set(R.drawable.ccl_ic_map_pin, r.location, c.sub)
    recLine.set(R.drawable.ca_ic_repeat, r.recurrence, c.sub)
    meetLine.set(R.drawable.ccl_ic_video, r.meeting, c.primary, true)

    syncIcon.visibility = if (r.synced) View.VISIBLE else View.GONE
    syncIcon.setImageDrawable(tintedIcon(ctx, R.drawable.ca_ic_smartphone, c.primary))
    syncIcon.background = caRound(caAlpha(c.primary, 0.13f), ctx.caDp(9f).toFloat())
    bellIcon.visibility = if (r.reminder) View.VISIBLE else View.GONE
    bellIcon.setImageDrawable(tintedIcon(ctx, R.drawable.ccl_ic_bell, acc))
    bellIcon.background = caRound(caAlpha(acc, 0.1f), ctx.caDp(9f).toFloat())
    val calColor = r.calColor ?: c.primary
    calLabel.visibility = if (r.calendar.isEmpty()) View.GONE else View.VISIBLE
    calLabel.text = r.calendar
    calLabel.setTextColor(calColor)
    calLabel.background = caRound(caAlpha(calColor, 0.1f), ctx.caDp(10f).toFloat())

    join.visibility = if (r.join.isEmpty()) View.GONE else View.VISIBLE
    if (r.join.isNotEmpty()) {
      join.background = caRound(c.primary, ctx.caDp(10f).toFloat())
      joinIcon.setImageDrawable(tintedIcon(ctx, R.drawable.ccl_ic_video, c.onPrimary))
      joinText.text = r.join
      joinText.setTextColor(c.onPrimary)
      join.contentDescription = r.join
    }
    val anyRight = r.synced || r.reminder || r.calendar.isNotEmpty() || r.join.isNotEmpty()
    right.visibility = if (anyRight) View.VISIBLE else View.GONE

    card.contentDescription = listOf(r.title, r.time, r.location, r.recurrence, r.meeting, r.rel)
      .filter { it.isNotEmpty() }.joinToString(", ")
  }
}

@SuppressLint("ViewConstructor")
internal class CAEmptyRowView(ctx: Context) : LinearLayout(ctx) {
  var onAction: ((String, String) -> Unit)? = null
  private var rowId = ""
  private val iconWrap = FrameLayout(ctx)
  private val icon = ImageView(ctx)
  private val title = caText(ctx, 17f, 2)
  private val sub = caText(ctx, 14f)
  private val button = caText(ctx, 15f, 1)

  init {
    val d = { v: Float -> ctx.caDp(v) }
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    setPadding(d(32f), d(28f), d(32f), d(28f))
    iconWrap.addView(icon, FrameLayout.LayoutParams(d(24f), d(24f), Gravity.CENTER))
    addView(iconWrap, LayoutParams(d(56f), d(56f)))
    title.maxLines = 2
    title.gravity = Gravity.CENTER
    addView(title, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = d(14f) })
    sub.maxLines = 3
    sub.gravity = Gravity.CENTER
    addView(sub, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = d(8f) })
    button.setPadding(d(22f), d(11f), d(22f), d(11f))
    button.isClickable = true
    button.isFocusable = true
    button.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      onAction?.invoke(rowId, "add")
    }
    addView(button, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = d(16f) })
  }

  fun bind(r: CARow, style: CAStyle) {
    rowId = r.id
    val c = style.colors
    setBackgroundColor(c.bg)
    iconWrap.background = caRound(style.selBg, context.caDp(28f).toFloat())
    icon.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_calendar, c.text))
    title.text = r.title
    title.setTextColor(c.text)
    sub.text = r.sub
    sub.setTextColor(c.sub)
    sub.visibility = if (r.sub.isEmpty()) View.GONE else View.VISIBLE
    button.text = r.button
    button.setTextColor(c.onPrimary)
    button.background = caRound(c.primary, context.caDp(12f).toFloat())
    button.visibility = if (r.button.isEmpty()) View.GONE else View.VISIBLE
  }
}
