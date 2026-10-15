package expo.modules.chatyyconversationlist

// [2026-10-15 native-drive] Views da lista de ARQUIVOS nativa (Android):
// ladrilho (miniatura Glide | glifo + selo + play), linha (lista), cartão
// (grade), cabeçalho de seção, check de seleção e barra de envio com progresso.
// Mesmo visual do iOS (ios/DVCells.swift), P&B.

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private fun Context.dpi(v: Float): Int = (v * resources.displayMetrics.density).roundToInt()

// ─── Check de seleção ──────────────────────────────────────────────────────

internal class DVCheckView(ctx: Context) : View(ctx) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private var on = false
  private var ring = Color.GRAY
  private var fill = Color.BLACK
  private var mark = Color.WHITE
  private var plate = Color.TRANSPARENT

  fun set(on: Boolean, s: DVStyle, withPlate: Boolean = false) {
    this.on = on
    ring = s.colors.faint
    fill = s.colors.primary
    mark = s.colors.onPrimary
    plate = if (withPlate && !on) (if (s.colors.dark) Color.argb(190, 0, 0, 0) else Color.argb(190, 255, 255, 255)) else Color.TRANSPARENT
    contentDescription = null
    invalidate()
  }

  override fun onDraw(c: Canvas) {
    super.onDraw(c)
    val d = resources.displayMetrics.density
    val r = min(width, height) / 2f - 1.5f * d
    val cx = width / 2f
    val cy = height / 2f
    if (plate != Color.TRANSPARENT) {
      paint.style = Paint.Style.FILL
      paint.color = plate
      c.drawCircle(cx, cy, r, paint)
    }
    if (on) {
      paint.style = Paint.Style.FILL
      paint.color = fill
      c.drawCircle(cx, cy, r, paint)
      paint.style = Paint.Style.STROKE
      paint.strokeWidth = 2f * d
      paint.strokeCap = Paint.Cap.ROUND
      paint.strokeJoin = Paint.Join.ROUND
      paint.color = mark
      path.reset()
      path.moveTo(cx - r * 0.42f, cy + r * 0.02f)
      path.lineTo(cx - r * 0.1f, cy + r * 0.34f)
      path.lineTo(cx + r * 0.45f, cy - r * 0.3f)
      c.drawPath(path, paint)
    } else {
      paint.style = Paint.Style.STROKE
      paint.strokeWidth = 1.5f * d
      paint.color = ring
      c.drawCircle(cx, cy, r, paint)
    }
  }
}

// ─── Ladrilho (miniatura | glifo + selo) ───────────────────────────────────

internal class DVTileView(ctx: Context) : FrameLayout(ctx) {
  private val image = ImageView(ctx)
  private val glyph = ImageView(ctx)
  private val badge = TextView(ctx)
  private val play = ImageView(ctx)
  private val bg = GradientDrawable()
  private var uri = ""
  private var big = false

  init {
    background = bg
    clipToOutline = true
    image.scaleType = ImageView.ScaleType.CENTER_CROP
    addView(image, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    glyph.scaleType = ImageView.ScaleType.CENTER_INSIDE
    addView(glyph, LayoutParams(ctx.dpi(22f), ctx.dpi(22f), Gravity.CENTER))
    badge.setTypeface(Typeface.DEFAULT_BOLD)
    badge.gravity = Gravity.CENTER
    badge.includeFontPadding = false
    badge.setPadding(ctx.dpi(3f), ctx.dpi(1f), ctx.dpi(3f), ctx.dpi(1f))
    addView(badge, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM))
    play.scaleType = ImageView.ScaleType.CENTER_INSIDE
    addView(play, LayoutParams(ctx.dpi(20f), ctx.dpi(20f), Gravity.CENTER))
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun bind(r: DVRow, s: DVStyle, glyphDp: Float, radiusDp: Float) {
    val ctx = context
    big = glyphDp >= 30f
    bg.cornerRadius = ctx.dpi(radiusDp).toFloat()
    bg.setColor(s.colors.chipBg)
    outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
    val tint = if (r.isFolder) (if (s.colors.dark) Color.parseColor("#AEAEB2") else Color.parseColor("#48484A")) else s.colors.sub
    glyph.setImageDrawable(tintedIcon(ctx, DVGlyphs.res(r.glyph), tint))
    (glyph.layoutParams as LayoutParams).apply { width = ctx.dpi(glyphDp); height = ctx.dpi(glyphDp) }
    val showBadge = r.badge.isNotEmpty() && r.thumb.isEmpty()
    badge.visibility = if (showBadge) View.VISIBLE else View.GONE
    if (showBadge) {
      badge.text = r.badge
      badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (big) 9f else 7.5f)
      badge.setTextColor(if (s.colors.dark) Color.BLACK else Color.WHITE)
      badge.background = GradientDrawable().apply {
        cornerRadius = ctx.dpi(3f).toFloat()
        setColor(if (s.colors.dark) Color.parseColor("#D1D1D6") else Color.parseColor("#111111"))
      }
      (badge.layoutParams as LayoutParams).bottomMargin = ctx.dpi(if (big) 8f else 3f)
    }
    val pd = ctx.dpi(if (big) 30f else 20f)
    (play.layoutParams as LayoutParams).apply { width = pd; height = pd }
    play.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.argb(115, 0, 0, 0)) }
    play.setImageDrawable(tintedIcon(ctx, R.drawable.crl_ic_play, Color.WHITE))
    play.setPadding(pd / 4, pd / 4, pd / 4, pd / 4)
    play.visibility = if (r.video && r.thumb.isNotEmpty()) View.VISIBLE else View.GONE

    if (r.thumb.isEmpty()) {
      if (uri.isNotEmpty()) DVThumbs.clear(image)
      uri = ""
      glyph.visibility = View.VISIBLE
    } else if (r.thumb != uri) {
      uri = r.thumb
      DVThumbs.clear(image)
      glyph.visibility = View.VISIBLE
      val want = r.thumb
      DVThumbs.load(image, want) { ok ->
        if (ok && uri == want) {
          glyph.visibility = View.GONE
          badge.visibility = View.GONE
        }
      }
    }
    requestLayout()
  }

  fun reset() {
    uri = ""
    DVThumbs.clear(image)
  }
}

// ─── Seção ─────────────────────────────────────────────────────────────────

internal class DVSectionView(ctx: Context) : FrameLayout(ctx) {
  private val label = TextView(ctx)

  init {
    label.setTypeface(CLType.weight(600))
    label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    label.isSingleLine = true
    label.ellipsize = TextUtils.TruncateAt.END
    label.setPadding(ctx.dpi(16f), ctx.dpi(14f), ctx.dpi(16f), ctx.dpi(6f))
    addView(label, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    if (android.os.Build.VERSION.SDK_INT >= 28) label.isAccessibilityHeading = true
  }

  fun bind(r: DVRow, s: DVStyle) {
    label.text = r.title
    label.setTextColor(s.colors.sub)
    setBackgroundColor(s.colors.bg)
  }
}

// ─── Linha (lista) ─────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class DVListRowView(ctx: Context) : LinearLayout(ctx) {
  var row: DVRow = DVRow.EMPTY
    private set
  private val check = DVCheckView(ctx)
  private val tile = DVTileView(ctx)
  private val texts = LinearLayout(ctx)
  private val title = TextView(ctx)
  private val metaRow = LinearLayout(ctx)
  private val sub = TextView(ctx)
  private val sharedIc = ImageView(ctx)
  private val starIc = ImageView(ctx)
  private val warn = TextView(ctx)
  private val chevron = ImageView(ctx)
  private val hair = Paint()
  private var hairX = 0f

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = ctx.dpi(66f)
    setPadding(ctx.dpi(16f), ctx.dpi(10f), ctx.dpi(16f), ctx.dpi(10f))
    setWillNotDraw(false)
    addView(check, LayoutParams(ctx.dpi(26f), ctx.dpi(26f)).apply { marginEnd = ctx.dpi(10f) })
    addView(tile, LayoutParams(ctx.dpi(44f), ctx.dpi(44f)).apply { marginEnd = ctx.dpi(12f) })
    texts.orientation = VERTICAL
    title.setTypeface(CLType.weight(500))
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    title.isSingleLine = true
    title.ellipsize = TextUtils.TruncateAt.MIDDLE
    texts.addView(title, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    metaRow.orientation = HORIZONTAL
    metaRow.gravity = Gravity.CENTER_VERTICAL
    sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
    sub.isSingleLine = true
    sub.ellipsize = TextUtils.TruncateAt.END
    metaRow.addView(sub, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { weight = 0f; width = LayoutParams.WRAP_CONTENT })
    metaRow.addView(sharedIc, LayoutParams(ctx.dpi(13f), ctx.dpi(13f)).apply { marginStart = ctx.dpi(5f) })
    metaRow.addView(starIc, LayoutParams(ctx.dpi(12f), ctx.dpi(12f)).apply { marginStart = ctx.dpi(4f) })
    texts.addView(metaRow, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = ctx.dpi(2f) })
    warn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    warn.isSingleLine = true
    warn.ellipsize = TextUtils.TruncateAt.END
    texts.addView(warn, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = ctx.dpi(1f) })
    addView(texts, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    chevron.scaleType = ImageView.ScaleType.CENTER_INSIDE
    addView(chevron, LayoutParams(ctx.dpi(16f), ctx.dpi(16f)).apply { marginStart = ctx.dpi(8f) })
    isClickable = true
    isLongClickable = true
    isFocusable = true
  }

  fun bind(r: DVRow, s: DVStyle) {
    row = r
    val ctx = context
    val sel = s.selectionMode && s.selected.contains(r.id)
    val showCheck = s.selectionMode && r.selectable
    check.visibility = if (showCheck) View.VISIBLE else View.GONE
    if (showCheck) check.set(sel, s)
    tile.bind(r, s, 20f, 10f)
    title.text = rlHighlighted(r.title, s.tokens, s.colors.text)
    title.setTextColor(s.colors.text)
    sub.text = r.sub
    sub.setTextColor(s.colors.faint)
    sub.visibility = if (r.sub.isEmpty()) View.GONE else View.VISIBLE
    sharedIc.visibility = if (r.shared) View.VISIBLE else View.GONE
    if (r.shared) sharedIc.setImageDrawable(tintedIcon(ctx, R.drawable.dv_ic_users, s.colors.sub))
    starIc.visibility = if (r.starred) View.VISIBLE else View.GONE
    if (r.starred) starIc.setImageDrawable(tintedIcon(ctx, R.drawable.cct_ic_star_fill, s.colors.text))
    metaRow.visibility = if (r.sub.isEmpty() && !r.shared && !r.starred) View.GONE else View.VISIBLE
    warn.visibility = if (r.warn.isEmpty()) View.GONE else View.VISIBLE
    if (r.warn.isNotEmpty()) {
      warn.text = r.warn
      warn.setTextColor(if (r.warnUrgent) s.colors.error else s.colors.faint)
      warn.setTypeface(CLType.weight(if (r.warnUrgent) 700 else 500))
    }
    val showChev = r.chevron && !s.selectionMode
    chevron.visibility = if (showChev) View.VISIBLE else View.GONE
    if (showChev) chevron.setImageDrawable(tintedIcon(ctx, R.drawable.cst_ic_chevron, s.colors.faint))
    hair.color = s.colors.hair
    val base = if (sel) rlBlend(s.selBg, s.colors.bg) else s.colors.bg
    background = RippleDrawable(ColorStateList.valueOf(s.colors.press), ColorDrawable(base), ColorDrawable(Color.WHITE))
    contentDescription = r.a11y.ifEmpty { listOf(r.title, r.sub).filter { it.isNotEmpty() }.joinToString(", ") }
    isSelected = sel
  }

  fun recycle() { tile.reset() }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    super.onLayout(changed, l, t, r, b)
    hairX = texts.left.toFloat()
  }

  override fun onDraw(c: Canvas) {
    super.onDraw(c)
    val h = max(1f, resources.displayMetrics.density * 0.5f)
    c.drawRect(hairX, height - h, width.toFloat(), height.toFloat(), hair)
  }
}

// ─── Cartão (grade) ────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class DVGridCardView(ctx: Context) : FrameLayout(ctx) {
  var row: DVRow = DVRow.EMPTY
    private set
  private val card = LinearLayout(ctx)
  private val tile = DVTileView(ctx)
  private val title = TextView(ctx)
  private val sub = TextView(ctx)
  private val check = DVCheckView(ctx)
  private val star = ImageView(ctx)
  private val cardBg = GradientDrawable()
  /** Meio vão entre cartões (a grade não tem ItemDecoration). */
  val half = ctx.dpi(5f)

  init {
    setPadding(half, half, half, half)
    card.orientation = LinearLayout.VERTICAL
    card.background = cardBg
    card.clipToOutline = true
    card.outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
    card.addView(tile, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
    title.setTypeface(CLType.weight(500))
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    title.maxLines = 2
    title.ellipsize = TextUtils.TruncateAt.MIDDLE
    title.setPadding(ctx.dpi(10f), ctx.dpi(7f), ctx.dpi(10f), 0)
    card.addView(title, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    sub.isSingleLine = true
    sub.ellipsize = TextUtils.TruncateAt.END
    sub.setPadding(ctx.dpi(10f), ctx.dpi(2f), ctx.dpi(10f), ctx.dpi(8f))
    card.addView(sub, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    addView(card, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(check, LayoutParams(ctx.dpi(26f), ctx.dpi(26f), Gravity.TOP or Gravity.START).apply {
      leftMargin = ctx.dpi(8f); topMargin = ctx.dpi(8f)
    })
    star.scaleType = ImageView.ScaleType.CENTER_INSIDE
    addView(star, LayoutParams(ctx.dpi(16f), ctx.dpi(16f), Gravity.TOP or Gravity.END).apply {
      rightMargin = ctx.dpi(8f); topMargin = ctx.dpi(8f)
    })
    isClickable = true
    isLongClickable = true
    isFocusable = true
  }

  fun bind(r: DVRow, s: DVStyle) {
    row = r
    val ctx = context
    val sel = s.selectionMode && s.selected.contains(r.id)
    tile.bind(r, s, 34f, 0f)
    title.text = rlHighlighted(r.title, s.tokens, s.colors.text)
    title.setTextColor(s.colors.text)
    val meta = if (r.warn.isEmpty()) r.sub else r.warn
    sub.text = meta
    sub.setTextColor(if (r.warn.isNotEmpty() && r.warnUrgent) s.colors.error else s.colors.faint)
    val showCheck = s.selectionMode && r.selectable
    check.visibility = if (showCheck) View.VISIBLE else View.GONE
    if (showCheck) check.set(sel, s, withPlate = true)
    star.visibility = if (r.starred) View.VISIBLE else View.GONE
    if (r.starred) {
      star.setImageDrawable(tintedIcon(ctx, R.drawable.cct_ic_star_fill, s.colors.text))
      star.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(if (s.colors.dark) Color.argb(150, 0, 0, 0) else Color.argb(170, 255, 255, 255)) }
      star.setPadding(ctx.dpi(2f), ctx.dpi(2f), ctx.dpi(2f), ctx.dpi(2f))
    }
    cardBg.cornerRadius = ctx.dpi(14f).toFloat()
    cardBg.setColor(s.card)
    cardBg.setStroke(ctx.dpi(if (sel) 2f else 1f), if (sel) s.colors.primary else s.colors.border)
    card.foreground = RippleDrawable(ColorStateList.valueOf(s.colors.press), null, GradientDrawable().apply {
      cornerRadius = ctx.dpi(14f).toFloat(); setColor(Color.WHITE)
    })
    contentDescription = r.a11y.ifEmpty { listOf(r.title, r.sub).filter { it.isNotEmpty() }.joinToString(", ") }
    isSelected = sel
  }

  override fun drawableHotspotChanged(x: Float, y: Float) {
    super.drawableHotspotChanged(x, y)
    card.drawableHotspotChanged(x - card.left, y - card.top)
  }

  override fun dispatchSetPressed(pressed: Boolean) {
    super.dispatchSetPressed(pressed)
    card.isPressed = pressed
    card.animate().scaleX(if (pressed) 0.97f else 1f).scaleY(if (pressed) 0.97f else 1f).setDuration(if (pressed) 80L else 160L).start()
  }

  fun recycle() {
    tile.reset()
    card.scaleX = 1f
    card.scaleY = 1f
  }
}

// ─── Barra de envio ────────────────────────────────────────────────────────

internal class DVUpload(val id: String, val name: String, val progress: Float, val state: String) {
  companion object {
    fun parse(v: List<Any?>?): List<DVUpload> {
      val out = ArrayList<DVUpload>()
      v?.forEach { x ->
        val m = CLVal.map(x) ?: return@forEach
        val p = CLVal.double(m["progress"]).toFloat().coerceIn(0f, 100f)
        out.add(DVUpload(CLVal.str(m["id"]), CLVal.str(m["name"]), p, CLVal.str(m["state"]).ifEmpty { "up" }))
      }
      return out
    }
  }
}

/** Cartão no topo: "Enviando…" + até 3 arquivos com barra (0 = indeterminado). */
internal class DVUploadBar(ctx: Context) : LinearLayout(ctx) {
  private val header = LinearLayout(ctx)
  private val title = TextView(ctx)
  private val count = TextView(ctx)
  private val names = ArrayList<TextView>()
  private val bars = ArrayList<DVProgressView>()
  private val bg = GradientDrawable()
  var items: List<DVUpload> = emptyList()
    private set

  init {
    orientation = VERTICAL
    background = bg
    setPadding(ctx.dpi(14f), ctx.dpi(12f), ctx.dpi(14f), ctx.dpi(12f))
    title.setTypeface(CLType.weight(600))
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    header.orientation = HORIZONTAL
    header.addView(title, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    count.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    count.gravity = Gravity.END
    header.addView(count, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    addView(header, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    for (i in 0 until MAX) {
      val n = TextView(ctx)
      n.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      n.isSingleLine = true
      n.ellipsize = TextUtils.TruncateAt.MIDDLE
      addView(n, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = ctx.dpi(8f) })
      val b = DVProgressView(ctx)
      addView(b, LayoutParams(LayoutParams.MATCH_PARENT, ctx.dpi(3f)).apply { topMargin = ctx.dpi(4f) })
      names.add(n)
      bars.add(b)
    }
    accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
  }

  fun bind(list: List<DVUpload>, s: DVStyle, L: DVLabels) {
    items = list
    bg.cornerRadius = context.dpi(14f).toFloat()
    bg.setColor(s.card)
    bg.setStroke(context.dpi(1f), s.colors.border)
    val done = list.count { it.state == "done" }
    title.text = L.get("uploading", "Enviando...")
    title.setTextColor(s.colors.text)
    count.text = if (list.size > 1) "$done/${list.size}" else ""
    count.setTextColor(s.colors.sub)
    val visible = (list.filter { it.state == "up" } + list.filter { it.state != "up" }).take(MAX)
    for (i in 0 until MAX) {
      val has = i < visible.size
      names[i].visibility = if (has) View.VISIBLE else View.GONE
      bars[i].visibility = if (has) View.VISIBLE else View.GONE
      if (!has) { bars[i].stop(); continue }
      val u = visible[i]
      names[i].text = u.name
      names[i].setTextColor(if (u.state == "error") s.colors.error else s.colors.sub)
      val track = if (s.colors.dark) Color.argb(20, 255, 255, 255) else Color.argb(18, 0, 0, 0)
      val fill = if (u.state == "error") s.colors.error else s.colors.primary
      bars[i].set(if (u.state == "up") u.progress / 100f else 1f, u.state == "up" && u.progress <= 0f, track, fill)
    }
    contentDescription = "${L.get("uploading", "Enviando...")} $done/${list.size}"
  }

  override fun onDetachedFromWindow() {
    for (b in bars) b.stop()
    super.onDetachedFromWindow()
  }

  companion object { const val MAX = 3 }
}

/** Barra fina de progresso; indeterminado = listra de 35% correndo. */
internal class DVProgressView(ctx: Context) : View(ctx) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val rect = RectF()
  private var progress = 0f
  private var shown = 0f
  private var indet = false
  private var track = Color.LTGRAY
  private var fill = Color.BLACK
  private var phase = 0f
  private var anim: ValueAnimator? = null
  private var progAnim: ValueAnimator? = null

  fun set(p: Float, indeterminate: Boolean, trackColor: Int, fillColor: Int) {
    track = trackColor
    fill = fillColor
    indet = indeterminate
    if (indet) {
      if (anim == null) {
        anim = ValueAnimator.ofFloat(0f, 1f).apply {
          duration = 1100L
          repeatCount = ValueAnimator.INFINITE
          interpolator = AccelerateDecelerateInterpolator()
          addUpdateListener { phase = it.animatedValue as Float; invalidate() }
          start()
        }
      }
    } else {
      stopIndet()
      val target = p.coerceIn(0f, 1f)
      if (target != progress) {
        val from = shown
        progress = target
        progAnim?.cancel()
        progAnim = ValueAnimator.ofFloat(from, target).apply {
          duration = 250L
          addUpdateListener { shown = it.animatedValue as Float; invalidate() }
          start()
        }
      }
    }
    invalidate()
  }

  private fun stopIndet() {
    anim?.cancel()
    anim = null
  }

  fun stop() {
    stopIndet()
    progAnim?.cancel()
    progAnim = null
  }

  override fun onDraw(c: Canvas) {
    super.onDraw(c)
    val w = width.toFloat()
    val h = height.toFloat()
    val r = h / 2f
    paint.color = track
    rect.set(0f, 0f, w, h)
    c.drawRoundRect(rect, r, r, paint)
    paint.color = fill
    if (indet) {
      val sw = w * 0.35f
      val x = -sw + (w + sw) * phase
      rect.set(max(0f, x), 0f, min(w, x + sw), h)
    } else {
      rect.set(0f, 0f, max(h, w * shown), h)
    }
    c.drawRoundRect(rect, r, r, paint)
  }

  override fun onDetachedFromWindow() {
    stop()
    super.onDetachedFromWindow()
  }
}

internal fun dvLayoutParams(): ViewGroup.LayoutParams =
  ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
