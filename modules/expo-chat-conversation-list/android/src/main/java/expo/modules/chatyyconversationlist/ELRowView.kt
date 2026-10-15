package expo.modules.chatyyconversationlist

// [2026-10-15 native-inbox] Linha do e-mail (Android). ViewGroup com layout
// manual, mesma estética do components/EmailRow.js: ponto de não lida à
// esquerda, avatar (ou bolinha de seleção), remetente 16 (700 não lido) +
// contador da conversa + mudo · clipe + hora 13; assunto 15 (600 não lido) +
// até 2 chips de rótulo; prévia 14; chips "responder?"/"adiado"; estrela.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import kotlin.math.max
import kotlin.math.min

@SuppressLint("ViewConstructor")
internal class ELRowView(ctx: Context) : ViewGroup(ctx) {
  interface Listener {
    fun onPress(id: String)
    fun onLeft(id: String)
    fun onStar(id: String)
    fun onLongPress(id: String, anchor: View)
    fun onA11yAction(id: String, action: String)
  }

  var listener: Listener? = null

  private val d = ctx.resources.displayMetrics.density
  private val fontScale = ctx.resources.configuration.fontScale
  private fun px(v: Float): Int = (v * d + 0.5f).toInt()
  private fun sp(size: Float, cap: Float): Float = size * d * min(max(fontScale, 0.85f), cap)

  val avatar = CLAvatarView(ctx)
  private val check = CLCheckView(ctx)
  private val leftArea = View(ctx)
  private val fromTv = label(16f, 1.3f, 500)
  private val badgeTv = label(12f, 1.2f, 600)
  private val muteIv = ImageView(ctx)
  private val clipIv = ImageView(ctx)
  private val dateTv = label(13f, 1.3f, 400)
  private val subjectTv = label(15f, 1.3f, 400)
  private val chipTvs = arrayOf(label(10f, 1.2f, 700), label(10f, 1.2f, 700))
  private val chipBgs = arrayOf(GradientDrawable(), GradientDrawable())
  private val previewTv = label(14f, 1.3f, 400)
  private val nudgeTv = label(12f, 1.2f, 600)
  private val snoozeTv = label(12f, 1.2f, 600)
  private val starIv = ImageView(ctx)
  private val badgeBg = GradientDrawable()
  private val nudgeBg = GradientDrawable()
  private val snoozeBg = GradientDrawable()
  private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val hairPaint = Paint()
  private val ripple = android.graphics.drawable.RippleDrawable(
    android.content.res.ColorStateList.valueOf(0x14000000), null, android.graphics.drawable.ColorDrawable(0xFFFFFFFF.toInt())
  )

  private val tfFrom = CLType.weight(500)
  private val tfFromBold = CLType.weight(700)
  private val tfSubj = CLType.weight(400)
  private val tfSubjBold = CLType.weight(600)
  private val tfDate = CLType.weight(400)
  private val tfDateBold = CLType.weight(600)

  var row = ELRow()
    private set
  private var palette = ELPalette(false)
  private var density = ELDensity()
  private var labels = CLLabels()
  private var selectionMode = false
  private var showDot = false
  private val a11yIds = ArrayList<Int>()

  init {
    clipChildren = false
    isClickable = true
    isLongClickable = true
    isFocusable = true
    setWillNotDraw(false)
    foreground = ripple
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    addView(leftArea)
    addView(avatar)
    addView(check)
    for (v in listOf(fromTv, badgeTv, dateTv, subjectTv, previewTv, nudgeTv, snoozeTv)) addView(v)
    for (t in chipTvs) addView(t)
    for (iv in listOf(muteIv, clipIv, starIv)) {
      iv.scaleType = ImageView.ScaleType.FIT_CENTER
      addView(iv)
    }
    dateTv.fontFeatureSettings = "tnum"
    badgeTv.fontFeatureSettings = "tnum"
    dateTv.gravity = Gravity.END
    badgeTv.gravity = Gravity.CENTER
    badgeBg.cornerRadius = px(999f).toFloat()
    badgeTv.background = badgeBg
    badgeTv.setPadding(px(7f), 0, px(7f), 0)
    for ((i, t) in chipTvs.withIndex()) {
      chipBgs[i].cornerRadius = px(10f).toFloat()
      t.background = chipBgs[i]
      t.gravity = Gravity.CENTER
      t.setPadding(px(8f), px(4f), px(8f), px(4f))
      t.letterSpacing = 0.02f
    }
    nudgeBg.cornerRadius = px(8f).toFloat()
    nudgeTv.background = nudgeBg
    nudgeTv.setPadding(px(8f), px(3f), px(8f), px(3f))
    snoozeBg.cornerRadius = px(8f).toFloat()
    snoozeTv.background = snoozeBg
    snoozeTv.setPadding(px(8f), px(3f), px(8f), px(3f))
    snoozeTv.compoundDrawablePadding = px(4f)
    for (i in 0 until childCount) {
      getChildAt(i).importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }
    avatar.isClickable = false
    leftArea.setOnClickListener {
      performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      listener?.onLeft(row.id)
    }
    starIv.setOnClickListener {
      performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
      starIv.animate().cancel()
      starIv.scaleX = 1.25f
      starIv.scaleY = 1.25f
      starIv.animate().scaleX(1f).scaleY(1f).setDuration(180).start()
      listener?.onStar(row.id)
    }
    setOnClickListener { listener?.onPress(row.id) }
    setOnLongClickListener {
      performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      listener?.onLongPress(row.id, this)
      true
    }
  }

  private fun label(size: Float, cap: Float, weight: Int): TextView {
    val tv = TextView(context)
    tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, sp(size, cap))
    tv.maxLines = 1
    tv.setSingleLine(true)
    tv.ellipsize = TextUtils.TruncateAt.END
    tv.includeFontPadding = false
    tv.typeface = CLType.weight(weight)
    return tv
  }

  fun bind(r: ELRow, p: ELPalette, dn: ELDensity, l: CLLabels, selection: Boolean) {
    row = r
    palette = p
    density = dn
    labels = l
    selectionMode = selection
    val unread = r.unread
    val bg = if (r.checked || r.active) p.selectedBg else p.bg
    setBackgroundColor(bg)
    ripple.setColor(android.content.res.ColorStateList.valueOf(if (p.dark) 0x1FFFFFFF else 0x14000000))
    showDot = unread && !selection
    dotPaint.color = p.primary
    hairPaint.color = p.hair

    avatar.visibility = if (selection) GONE else VISIBLE
    if (!selection) {
      avatar.setBoxDp(dn.avatar)
      avatar.bind(r.avatar, CLTheme(p.dark), bg)
    }
    check.visibility = if (selection) VISIBLE else GONE
    check.onColor = p.checkOn
    check.tickColor = p.bg
    check.borderTint = p.checkOff
    check.checked = r.checked

    fromTv.text = r.from
    fromTv.typeface = if (unread) tfFromBold else tfFrom
    fromTv.setTextColor(p.text)
    badgeTv.visibility = if (r.thread > 1) VISIBLE else GONE
    if (r.thread > 1) {
      badgeTv.text = r.thread.toString()
      badgeTv.setTextColor(p.sub)
      badgeBg.setColor(p.variant)
    }
    muteIv.visibility = if (r.muted) VISIBLE else GONE
    if (r.muted) {
      muteIv.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_bell_off, p.faint))
      muteIv.alpha = 0.6f
    }
    clipIv.visibility = if (r.attach) VISIBLE else GONE
    if (r.attach) clipIv.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_paperclip, p.faint))
    dateTv.text = r.time
    dateTv.typeface = if (unread) tfDateBold else tfDate
    dateTv.setTextColor(if (unread) p.text else p.faint)

    subjectTv.text = r.subject
    subjectTv.typeface = if (unread) tfSubjBold else tfSubj
    subjectTv.setTextColor(if (unread) p.text else p.sub)
    for (i in 0 until 2) {
      val c = r.chips.getOrNull(i)
      val tv = chipTvs[i]
      if (c == null) { tv.visibility = GONE; continue }
      tv.visibility = VISIBLE
      tv.text = c.name
      tv.setTextColor(c.fg)
      chipBgs[i].setColor(c.bg)
      chipBgs[i].setStroke(max(1, px(0.5f)), (c.bd and 0x00FFFFFF) or (0x80 shl 24))
    }
    val showPrev = dn.preview && r.preview.isNotEmpty()
    previewTv.visibility = if (showPrev) VISIBLE else GONE
    previewTv.text = r.preview
    previewTv.setTextColor(p.sub)

    nudgeTv.visibility = if (r.nudge.isNotEmpty()) VISIBLE else GONE
    nudgeTv.text = r.nudge
    nudgeTv.setTextColor(p.sub)
    nudgeBg.setColor(p.variant)
    snoozeTv.visibility = if (r.snoozed.isNotEmpty()) VISIBLE else GONE
    if (r.snoozed.isNotEmpty()) {
      snoozeTv.text = r.snoozed
      snoozeTv.setTextColor(p.primary)
      snoozeBg.setColor(p.variant)
      val ic = tintedIcon(context, R.drawable.ccl_ic_clock, p.primary)
      ic?.setBounds(0, 0, px(12f), px(12f))
      snoozeTv.setCompoundDrawables(ic, null, null, null)
    }

    starIv.visibility = if (selection) GONE else VISIBLE
    starIv.setImageDrawable(
      if (r.starred) tintedIcon(context, R.drawable.cel_ic_star_fill, p.star)
      else tintedIcon(context, R.drawable.cel_ic_star, p.starEmpty)
    )
    starIv.contentDescription = if (r.starred) labels.get("unstar", "Remover estrela") else labels.get("star", "Adicionar estrela")
    starIv.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO

    contentDescription = r.a11y.ifEmpty { "${r.from}, ${r.subject}" }
    isSelected = selection && r.checked
    setupA11yActions()
    requestLayout()
    invalidate()
  }

  private fun setupA11yActions() {
    for (id in a11yIds) ViewCompat.removeAccessibilityAction(this, id)
    a11yIds.clear()
    if (selectionMode) return
    val list = listOf(
      "star" to (if (row.starred) labels.get("unstar", "Remover estrela") else labels.get("star", "Adicionar estrela")),
      "archive" to labels.get("archive", "Arquivar"),
      "snooze" to labels.get("snooze", "Adiar"),
      "delete" to labels.get("delete", "Excluir"),
      "select" to labels.get("select", "Selecionar")
    )
    val rid = row.id
    for ((action, title) in list) {
      val aid = ViewCompat.addAccessibilityAction(this, title) { _, _ ->
        listener?.onA11yAction(rid, action)
        true
      }
      if (aid != View.NO_ID) a11yIds.add(aid)
    }
  }

  // ─── Medida / layout ─────────────────────────────────────────────────────

  private val unspec = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
  private fun exactly(v: Int) = MeasureSpec.makeMeasureSpec(max(0, v), MeasureSpec.EXACTLY)
  private fun atMost(v: Int) = MeasureSpec.makeMeasureSpec(max(0, v), MeasureSpec.AT_MOST)
  private fun vis(v: View) = v.visibility == VISIBLE

  private var cTextX = 0
  private var cRight = 0
  private var cFromW = 0
  private var cSubjW = 0
  private var cSubjH = 0
  private var cTotal = 0

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val padH = px(density.padH)
    val box = if (selectionMode) px(22f) else px(density.avatar)
    if (vis(avatar)) avatar.measure(exactly(box), exactly(box)) else avatar.measure(exactly(0), exactly(0))
    if (vis(check)) check.measure(exactly(box), exactly(box)) else check.measure(exactly(0), exactly(0))
    val textX = padH + box + px(density.gap)
    var right = w - padH
    if (vis(starIv)) {
      starIv.measure(exactly(px(18f)), exactly(px(18f)))
      right = right - px(36f) + px(6f) - px(4f)
    }
    leftArea.measure(exactly(box + px(16f)), exactly(0))

    dateTv.measure(unspec, unspec)
    var rx = right - dateTv.measuredWidth
    if (vis(clipIv)) {
      clipIv.measure(exactly(px(14f)), exactly(px(14f)))
      rx -= px(6f) + px(14f)
    }
    var tail = 0
    if (vis(badgeTv)) {
      badgeTv.measure(unspec, unspec)
      tail += px(6f) + badgeTv.measuredWidth + px(2f)
    }
    if (vis(muteIv)) {
      muteIv.measure(exactly(px(12f)), exactly(px(12f)))
      tail += px(4f) + px(12f)
    }
    fromTv.measure(atMost(max(0, rx - px(8f) - textX - tail)), unspec)
    cFromW = fromTv.measuredWidth

    var cx = right
    var chipH = 0
    for (t in chipTvs) {
      if (!vis(t)) continue
      t.measure(atMost(px(110f)), unspec)
      chipH = max(chipH, t.measuredHeight)
      cx -= t.measuredWidth + px(6f)
    }
    subjectTv.measure(atMost(max(0, (if (cx < right) cx else right) - textX)), unspec)
    cSubjW = subjectTv.measuredWidth
    cSubjH = max(subjectTv.measuredHeight, chipH)

    var total = fromTv.measuredHeight + px(3f) + cSubjH
    if (vis(previewTv)) {
      previewTv.measure(exactly(max(0, right - textX)), unspec)
      total += px(1f) + previewTv.measuredHeight
    }
    if (vis(nudgeTv)) {
      nudgeTv.measure(atMost(max(0, right - textX)), unspec)
      total += px(4f) + nudgeTv.measuredHeight
    }
    if (vis(snoozeTv)) {
      snoozeTv.measure(atMost(max(0, right - textX)), unspec)
      total += px(4f) + snoozeTv.measuredHeight
    }
    cTextX = textX
    cRight = right
    cTotal = total
    val h = max(px(density.minH), total + px(density.padV) * 2)
    setMeasuredDimension(w, h)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    val padH = px(density.padH)
    val box = if (selectionMode) px(22f) else px(density.avatar)
    val ay = (h - box) / 2
    leftArea.layout(padH - px(8f), 0, padH + box + px(8f), h)
    if (vis(avatar)) avatar.layout(padH, ay, padH + box, ay + box)
    if (vis(check)) check.layout(padH, ay, padH + box, ay + box)
    if (vis(starIv)) {
      val s = px(18f)
      val sx = w - padH + px(6f) - px(36f) + (px(36f) - s) / 2
      starIv.layout(sx, (h - s) / 2, sx + s, (h - s) / 2 + s)
    }
    val textX = cTextX
    val right = cRight
    var y = (h - cTotal) / 2

    // linha 1
    val fromH = fromTv.measuredHeight
    val base = y + fromTv.baseline
    val dw = dateTv.measuredWidth
    val dt = base - dateTv.baseline
    dateTv.layout(right - dw, dt, right, dt + dateTv.measuredHeight)
    var rx = right - dw
    if (vis(clipIv)) {
      val s = px(14f)
      clipIv.layout(rx - px(6f) - s, y + (fromH - s) / 2, rx - px(6f), y + (fromH - s) / 2 + s)
      rx -= px(6f) + s
    }
    fromTv.layout(textX, y, textX + cFromW, y + fromH)
    var tx = textX + cFromW
    if (vis(badgeTv)) {
      val bw = badgeTv.measuredWidth
      val bh = badgeTv.measuredHeight + px(2f)
      badgeTv.layout(tx + px(6f), y + (fromH - bh) / 2, tx + px(6f) + bw, y + (fromH - bh) / 2 + bh)
      tx += px(6f) + bw + px(2f)
    }
    if (vis(muteIv)) {
      val s = px(12f)
      muteIv.layout(tx + px(4f), y + (fromH - s) / 2, tx + px(4f) + s, y + (fromH - s) / 2 + s)
    }
    y += fromH + px(3f)

    // linha 2
    var cx = right
    for (i in chipTvs.indices.reversed()) {
      val c = chipTvs[i]
      if (!vis(c)) continue
      val cw = c.measuredWidth
      val ch = c.measuredHeight
      c.layout(cx - cw, y + (cSubjH - ch) / 2, cx, y + (cSubjH - ch) / 2 + ch)
      cx -= cw + px(6f)
    }
    val sh = subjectTv.measuredHeight
    subjectTv.layout(textX, y + (cSubjH - sh) / 2, textX + cSubjW, y + (cSubjH - sh) / 2 + sh)
    y += cSubjH

    if (vis(previewTv)) {
      y += px(1f)
      previewTv.layout(textX, y, textX + previewTv.measuredWidth, y + previewTv.measuredHeight)
      y += previewTv.measuredHeight
    }
    if (vis(nudgeTv)) {
      y += px(4f)
      nudgeTv.layout(textX, y, textX + nudgeTv.measuredWidth, y + nudgeTv.measuredHeight)
      y += nudgeTv.measuredHeight
    }
    if (vis(snoozeTv)) {
      y += px(4f)
      snoozeTv.layout(textX, y, textX + snoozeTv.measuredWidth, y + snoozeTv.measuredHeight)
    }
  }

  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    if (showDot) {
      val r = d * 4f
      canvas.drawCircle(d * 5f + r, height / 2f, r, dotPaint)
    }
    // Divisória fina (borderBottom hairline do JS)
    val hh = max(1f, d * 0.5f)
    canvas.drawRect(0f, height - hh, width.toFloat(), height.toFloat(), hairPaint)
  }

  override fun onInitializeAccessibilityNodeInfo(info: android.view.accessibility.AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    AccessibilityNodeInfoCompat.wrap(info).className = "android.widget.Button"
  }

  override fun hasOverlappingRendering(): Boolean = false
}

/** Cabeçalho de seção (Hoje, Ontem, Esta semana…). */
@SuppressLint("ViewConstructor")
internal class ELSectionView(ctx: Context) : TextView(ctx) {
  private val d = ctx.resources.displayMetrics.density
  private val fs = min(max(ctx.resources.configuration.fontScale, 0.85f), 1.2f)

  init {
    setTextSize(TypedValue.COMPLEX_UNIT_PX, 12f * d * fs)
    typeface = CLType.weight(600)
    letterSpacing = 0.04f
    isAllCaps = true
    maxLines = 1
    includeFontPadding = false
    gravity = Gravity.CENTER_VERTICAL
    ViewCompat.setAccessibilityHeading(this, true)
  }

  fun bind(r: ELRow, p: ELPalette, padH: Float) {
    text = r.title
    setTextColor(p.sub)
    setBackgroundColor(p.sectionBg)
    val ph = (padH * d).toInt()
    setPadding(ph, (10 * d).toInt(), ph, (10 * d).toInt())
  }
}
