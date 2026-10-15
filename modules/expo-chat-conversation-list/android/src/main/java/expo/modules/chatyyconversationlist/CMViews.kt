package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] COMUNIDADES em nativo (Android): linha única
// (CMRowView, ViewGroup com layout manual — mesmas medidas do iOS/CMCells)
// e o motor da lista (CMListBaseView: RecyclerView + DiffUtil com payload,
// SwipeRefreshLayout, filhos RN como header/rodapé via CLChildHost).
// ChatyyCommunityListView / ChatyyCommunityDetailView só herdam daqui.
//
// Cartão segmentado: cada linha desenha a MESMA forma arredondada estendida
// além das bordas que continuam (o canvas da linha recorta) → borda
// contínua, cantos só nas pontas.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.widget.TextViewCompat
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.max
import kotlin.math.min

// ─── Linha ─────────────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CMRowView(ctx: Context) : ViewGroup(ctx) {
  interface Listener {
    fun onPress(id: String)
    fun onLongPress(id: String)
    fun onAction(id: String, action: String)
  }

  var listener: Listener? = null
  var row = CMRow()
    private set
  private var palette = CMPalette(false)

  private val d = ctx.resources.displayMetrics.density
  private fun dp(v: Float): Int = Math.round(v * d)
  private fun dpf(v: Float): Float = v * d

  private val shapePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val divPaint = Paint()
  private val insetPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val rect = RectF()

  private val avatarBox = FrameLayout(ctx)
  private val avatarImage = ImageView(ctx)
  private val initialText = TextView(ctx)
  private val title = TextView(ctx)
  private val sub = TextView(ctx)
  private val chevron = ImageView(ctx)
  private val tag = TextView(ctx)
  private val rtag = TextView(ctx)
  private val removeBtn = ImageView(ctx)
  private val body = TextView(ctx)
  private val spinner = ProgressBar(ctx)
  private val pill1 = TextView(ctx)
  private val pill2 = TextView(ctx)

  private var loadedUrl = ""
  private var pressed = false
  private var chevKey = ""
  private var pill1Key = ""
  private var pill2Key = ""

  init {
    setWillNotDraw(false)
    clipChildren = true
    isClickable = true
    isFocusable = true

    avatarBox.clipToOutline = true
    avatarBox.outlineProvider = object : android.view.ViewOutlineProvider() {
      override fun getOutline(view: View, outline: android.graphics.Outline) {
        outline.setRoundRect(0, 0, view.width, view.height, dpf(14f))
      }
    }
    initialText.gravity = Gravity.CENTER
    initialText.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 20f)
    initialText.typeface = CLType.weight(700)
    avatarImage.scaleType = ImageView.ScaleType.CENTER_CROP
    avatarBox.addView(initialText, FrameLayout.LayoutParams(-1, -1))
    avatarBox.addView(avatarImage, FrameLayout.LayoutParams(-1, -1))
    addView(avatarBox)

    for (t in listOf(title, sub, tag, rtag, initialText)) {
      t.includeFontPadding = false
    }
    title.maxLines = 1
    title.ellipsize = TextUtils.TruncateAt.END
    sub.ellipsize = TextUtils.TruncateAt.END
    addView(title)
    addView(sub)

    chevron.scaleType = ImageView.ScaleType.FIT_CENTER
    addView(chevron)

    for (t in listOf(tag, rtag)) {
      t.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 11f)
      t.typeface = CLType.weight(700)
      t.gravity = Gravity.CENTER
      t.maxLines = 1
      addView(t)
    }

    removeBtn.scaleType = ImageView.ScaleType.CENTER
    removeBtn.isClickable = true
    removeBtn.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      listener?.onAction(row.id, "remove")
    }
    addView(removeBtn)

    body.includeFontPadding = false
    addView(body)

    spinner.isIndeterminate = true
    addView(spinner)

    for ((i, p) in listOf(pill1, pill2).withIndex()) {
      p.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 13f)
      p.typeface = CLType.weight(600)
      p.gravity = Gravity.CENTER_VERTICAL
      p.includeFontPadding = false
      p.maxLines = 1
      p.compoundDrawablePadding = dp(6f)
      p.setPadding(dp(14f), 0, dp(14f), 0)
      p.isClickable = true
      p.setOnClickListener {
        it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        val key = if (i == 0) row.b1k else row.b2k
        if (key.isNotEmpty()) listener?.onAction(row.id, key)
      }
      p.setOnTouchListener { v, e ->
        when (e.actionMasked) {
          MotionEvent.ACTION_DOWN -> v.animate().scaleX(0.96f).scaleY(0.96f).setDuration(80).start()
          MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> v.animate().scaleX(1f).scaleY(1f).setDuration(180).start()
        }
        false
      }
      addView(p)
    }

    setOnClickListener { if (row.tap) listener?.onPress(row.id) }
    setOnLongClickListener {
      if (!row.longPress) return@setOnLongClickListener false
      performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      listener?.onLongPress(row.id)
      true
    }
  }

  fun bind(r: CMRow, p: CMPalette) {
    val flip = row.id == r.id && row.expanded != r.expanded && isAttachedToWindow
    row = r
    palette = p
    isClickable = r.tap
    isLongClickable = r.longPress
    contentDescription = r.a11y.ifEmpty { listOf(r.title, r.sub).filter { it.isNotEmpty() }.joinToString(", ") }

    val k = r.kind
    val isCard = k == "card"
    val isGroup = k == "group"
    val isRow = k == "row"
    val isText = k == "text"
    fun vis(v: View, on: Boolean) { v.visibility = if (on) View.VISIBLE else View.GONE }
    vis(avatarBox, isCard)
    vis(chevron, isCard && r.chevron)
    vis(removeBtn, isGroup && r.remove)
    vis(title, isCard || isGroup || isRow)
    vis(sub, (isCard || isGroup || isRow) && r.sub.isNotEmpty())
    vis(tag, isRow && r.tag.isNotEmpty())
    vis(rtag, isRow && r.rtag.isNotEmpty())
    vis(body, isText)
    vis(spinner, k == "loading")
    vis(pill1, k == "actions" && r.b1.isNotEmpty())
    vis(pill2, k == "actions" && r.b2.isNotEmpty())

    when {
      isCard -> {
        avatarBox.setBackgroundColor(p.iconBg)
        initialText.text = r.initial
        initialText.setTextColor(p.text)
        styleText(title, 16f, 600, p.text)
        styleText(sub, 13f, 400, p.sub)
        sub.maxLines = 1
        title.gravity = Gravity.START
        val ck = "${p.chevron}"
        if (ck != chevKey) {
          chevKey = ck
          chevron.setImageDrawable(CMIcon(CMIcon.CHEVRON_DOWN, p.chevron, 2f, d))
        }
        val rot = if (r.expanded) 180f else 0f
        if (flip) chevron.animate().rotation(rot).setDuration(220).start() else { chevron.animate().cancel(); chevron.rotation = rot }
        loadImage(r.url, r.auth)
      }
      isGroup -> {
        styleText(title, 14f, 500, p.text)
        styleText(sub, 12f, 400, p.ter)
        sub.maxLines = 1
        title.gravity = Gravity.START
        removeBtn.setImageDrawable(CMIcon(CMIcon.X, p.danger, 2.2f, d, 14f))
        removeBtn.contentDescription = r.a11y
      }
      isRow -> {
        styleText(title, 15f, 600, if (r.ink) p.ink else p.text)
        styleText(sub, 13f, 400, p.sub)
        sub.maxLines = 2
        title.gravity = if (r.center) Gravity.CENTER_HORIZONTAL else Gravity.START
        styleTag(tag, r.tag, SLColor.parse(r.tagBg) ?: p.ink, SLColor.parse(r.tagFg) ?: p.bg)
        styleTag(rtag, r.rtag, SLColor.parse(r.rtagBg) ?: p.sub, SLColor.parse(r.rtagFg) ?: 0xFFFFFFFF.toInt())
      }
      isText -> styleBody(r, p)
    }
    if (isCard || isGroup || isRow) {
      title.text = r.title
      sub.text = r.sub
    }
    if (k == "loading") {
      spinner.indeterminateDrawable?.setTint(p.ink)
    }
    if (k == "actions") {
      pill1Key = stylePill(pill1, r.b1, r.b1i, pill1Key)
      pill2Key = stylePill(pill2, r.b2, r.b2i, pill2Key)
    }
    requestLayout()
    invalidate()
  }

  private fun styleText(t: TextView, sizeDp: Float, weight: Int, color: Int) {
    t.setTextSize(TypedValue.COMPLEX_UNIT_DIP, sizeDp)
    t.typeface = CLType.weight(weight)
    t.setTextColor(color)
  }

  private fun styleTag(t: TextView, text: String, bg: Int, fg: Int) {
    t.text = text
    t.setTextColor(fg)
    val g = android.graphics.drawable.GradientDrawable()
    g.cornerRadius = dpf(10f)
    g.setColor(bg)
    t.background = g
  }

  private fun stylePill(t: TextView, text: String, icon: String, prevKey: String): String {
    t.text = text
    t.setTextColor(palette.text)
    t.contentDescription = text
    val g = android.graphics.drawable.GradientDrawable()
    g.cornerRadius = dpf(17f)
    g.setColor(palette.pill)
    t.background = g
    val key = "$icon|${palette.text}"
    if (key != prevKey) {
      val pd = CMIcon.forKey(icon)
      if (pd.isEmpty()) {
        t.setCompoundDrawables(null, null, null, null)
      } else {
        val ic = CMIcon(pd, palette.text, 1.8f, d)
        ic.setBounds(0, 0, dp(16f), dp(16f))
        t.setCompoundDrawables(ic, null, null, null)
      }
    }
    return key
  }

  /** (tamanho, peso, entrelinha, recuo cima, recuo baixo, centralizado, maiúsculas, itálico) */
  private data class TS(val size: Float, val weight: Int, val lh: Float, val top: Float, val bottom: Float,
                        val center: Boolean, val upper: Boolean, val italic: Boolean)

  private fun textStyle(ts: String): TS = when (ts) {
    "label" -> TS(12f, 600, 16f, 10f, 8f, false, true, false)
    "title" -> TS(12f, 700, 16f, 0f, 6f, false, true, false)
    "desc" -> TS(13f, 400, 18f, 10f, 0f, false, false, false)
    "empty" -> TS(13f, 400, 18f, 12f, 12f, false, false, false)
    "hint" -> TS(12f, 400, 16f, 8f, 8f, true, false, true)
    else -> TS(14f, 400, 20f, 0f, 2f, false, false, false)
  }

  private fun styleBody(r: CMRow, p: CMPalette) {
    val s = textStyle(r.ts)
    body.setTextSize(TypedValue.COMPLEX_UNIT_DIP, s.size)
    body.typeface = if (s.italic) Typeface.create(Typeface.DEFAULT, Typeface.ITALIC) else CLType.weight(s.weight)
    TextViewCompat.setLineHeight(body, dp(s.lh))
    body.isAllCaps = s.upper
    body.letterSpacing = if (s.upper) 0.5f / s.size else 0f
    body.gravity = if (s.center) Gravity.CENTER_HORIZONTAL else Gravity.START
    body.setTextColor(when (r.ts) {
      "label", "desc", "title", "hint" -> p.sub
      "empty" -> p.ter
      else -> p.text
    })
    body.text = r.body.ifEmpty { r.title }
  }

  private fun loadImage(url: String, auth: Boolean) {
    if (url == loadedUrl && avatarImage.drawable != null) return
    loadedUrl = url
    if (url.isEmpty()) {
      RLImages.clear(avatarImage)
      return
    }
    RLImages.load(avatarImage, url, auth)
  }

  // ─── medida / layout ────────────────────────────────────────────────────

  private fun exactly(v: Int) = MeasureSpec.makeMeasureSpec(max(0, v), MeasureSpec.EXACTLY)
  private fun atMost(v: Int) = MeasureSpec.makeMeasureSpec(max(0, v), MeasureSpec.AT_MOST)
  private val unspec = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)

  private var contentH = 0

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val r = row
    val cardW = max(0, w - dp(r.hx) * 2)
    contentH = when (r.kind) {
      "card" -> {
        avatarBox.measure(exactly(dp(48f)), exactly(dp(48f)))
        chevron.measure(exactly(dp(16f)), exactly(dp(16f)))
        val tw = cardW - dp(14f) - dp(48f) - dp(12f) - dp(14f) - (if (r.chevron) dp(30f) else 0)
        title.measure(exactly(tw), unspec)
        if (sub.visibility != View.GONE) sub.measure(exactly(tw), unspec)
        dp(76f)
      }
      "group" -> {
        val bw = cardW - dp(r.px) * 2
        val tw = bw - dp(28f) - (if (r.remove) dp(36f) else dp(10f))
        title.measure(exactly(tw), unspec)
        if (sub.visibility != View.GONE) sub.measure(exactly(tw), unspec)
        removeBtn.measure(exactly(dp(32f)), exactly(dp(32f)))
        dp(53f) + dp(4f)
      }
      "loading" -> {
        spinner.measure(exactly(dp(22f)), exactly(dp(22f)))
        dp(44f)
      }
      "actions" -> {
        for (p in listOf(pill1, pill2)) if (p.visibility != View.GONE) p.measure(atMost(cardW - dp(r.px) * 2), exactly(dp(34f)))
        dp(12f) + dp(34f)
      }
      "text" -> {
        val s = textStyle(r.ts)
        body.measure(exactly(cardW - dp(r.px) * 2), unspec)
        dp(s.top) + body.measuredHeight + dp(s.bottom)
      }
      else -> {
        var right = cardW - dp(14f) * 2
        if (rtag.visibility != View.GONE) {
          rtag.measure(unspec, exactly(dp(20f)))
          val rw = rtag.measuredWidth + dp(16f)
          rtag.measure(exactly(rw), exactly(dp(20f)))
          right -= rw + dp(8f)
        }
        var tw = right
        if (tag.visibility != View.GONE) {
          tag.measure(unspec, exactly(dp(20f)))
          val lw = tag.measuredWidth + dp(16f)
          tag.measure(exactly(lw), exactly(dp(20f)))
          tw -= lw + dp(8f)
        }
        title.measure(exactly(tw), unspec)
        var h = dp(14f) + max(title.measuredHeight, if (tag.visibility != View.GONE) dp(20f) else 0)
        if (sub.visibility != View.GONE) {
          sub.measure(exactly(right), unspec)
          h += dp(2f) + sub.measuredHeight
        }
        h + dp(14f)
      }
    }
    val total = dp(r.topGap) + contentH + dp(r.pb) + dp(r.bottomGap)
    setMeasuredDimension(w, total)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, rr: Int, b: Int) {
    val r = row
    val w = rr - l
    val cardX = dp(r.hx)
    val cardW = max(0, w - cardX * 2)
    val top = dp(r.topGap)
    when (r.kind) {
      "card" -> {
        val ax = cardX + dp(14f)
        val ay = top + dp(14f)
        avatarBox.layout(ax, ay, ax + dp(48f), ay + dp(48f))
        val cx = cardX + cardW - dp(14f) - dp(4f) - dp(16f)
        val cy = top + (dp(76f) - dp(16f)) / 2
        chevron.layout(cx, cy, cx + dp(16f), cy + dp(16f))
        val tx = ax + dp(48f) + dp(12f)
        val th = title.measuredHeight
        val sh = if (sub.visibility != View.GONE) sub.measuredHeight + dp(2f) else 0
        val ty = top + (dp(76f) - th - sh) / 2
        title.layout(tx, ty, tx + title.measuredWidth, ty + th)
        if (sub.visibility != View.GONE) sub.layout(tx, ty + th + dp(2f), tx + sub.measuredWidth, ty + th + sh)
      }
      "group" -> {
        val bx = cardX + dp(r.px)
        val bh = dp(53f)
        val tx = bx + dp(28f)
        val th = title.measuredHeight
        val sh = if (sub.visibility != View.GONE) sub.measuredHeight + dp(1f) else 0
        val ty = top + (bh - th - sh) / 2
        title.layout(tx, ty, tx + title.measuredWidth, ty + th)
        if (sub.visibility != View.GONE) sub.layout(tx, ty + th + dp(1f), tx + sub.measuredWidth, ty + th + sh)
        val bw = cardW - dp(r.px) * 2
        val rx = bx + bw - dp(4f) - dp(32f)
        val ry = top + (bh - dp(32f)) / 2
        removeBtn.layout(rx, ry, rx + dp(32f), ry + dp(32f))
      }
      "loading" -> {
        val sx = (w - dp(22f)) / 2
        val sy = top + (dp(44f) - dp(22f)) / 2
        spinner.layout(sx, sy, sx + dp(22f), sy + dp(22f))
      }
      "actions" -> {
        var x = cardX + dp(r.px)
        val y = top + dp(12f)
        for (p in listOf(pill1, pill2)) {
          if (p.visibility == View.GONE) continue
          val pw = min(p.measuredWidth, cardX + cardW - dp(r.px) - x)
          p.layout(x, y, x + max(0, pw), y + dp(34f))
          x += pw + dp(8f)
        }
      }
      "text" -> {
        val s = textStyle(r.ts)
        val bx = cardX + dp(r.px)
        val by = top + dp(s.top)
        body.layout(bx, by, bx + body.measuredWidth, by + body.measuredHeight)
      }
      else -> {
        val pad = dp(14f)
        var x = cardX + pad
        val right = cardX + cardW - pad
        val tTop = top + pad
        val lineH = max(title.measuredHeight, if (tag.visibility != View.GONE) dp(20f) else 0)
        if (rtag.visibility != View.GONE) {
          val rw = rtag.measuredWidth
          val ry = top + (contentH - dp(20f)) / 2
          rtag.layout(right - rw, ry, right, ry + dp(20f))
        }
        if (tag.visibility != View.GONE) {
          val ty = tTop + (lineH - dp(20f)) / 2
          tag.layout(x, ty, x + tag.measuredWidth, ty + dp(20f))
          x += tag.measuredWidth + dp(8f)
        }
        val ty = tTop + (lineH - title.measuredHeight) / 2
        title.layout(x, ty, x + title.measuredWidth, ty + title.measuredHeight)
        if (sub.visibility != View.GONE) {
          val sy = tTop + lineH + dp(2f)
          sub.layout(cardX + pad, sy, cardX + pad + sub.measuredWidth, sy + sub.measuredHeight)
        }
      }
    }
  }

  // ─── desenho (cartão / caixa interna / divisória) ───────────────────────

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val r = row
    val p = palette
    val w = width.toFloat()
    val h = height.toFloat()
    val cardX = dpf(r.hx)
    val cardR = w - cardX
    val top = dp(r.topGap).toFloat()
    val bottom = h - dp(r.bottomGap)
    if (r.hasCard) {
      val ext = dpf(40f)
      val y0 = if (r.seg == "one" || r.seg == "top") top else -ext
      val y1 = if (r.seg == "one" || r.seg == "bot") bottom else h + ext
      val radius = if (r.cs == "c") dpf(14f) else dpf(8f)
      val sw = if (r.cs == "d") dpf(1f) else max(1f, dpf(0.5f))
      rect.set(cardX + sw / 2f, y0 + sw / 2f, cardR - sw / 2f, y1 - sw / 2f)
      when (r.cs) {
        "b" -> {
          shapePaint.color = p.box
          canvas.drawRoundRect(rect, radius, radius, shapePaint)
        }
        "d" -> {
          strokePaint.color = p.ink
          strokePaint.strokeWidth = sw
          strokePaint.pathEffect = DashPathEffect(floatArrayOf(dpf(5f), dpf(4f)), 0f)
          canvas.drawRoundRect(rect, radius, radius, strokePaint)
        }
        else -> {
          shapePaint.color = p.card
          canvas.drawRoundRect(rect, radius, radius, shapePaint)
          strokePaint.color = p.border
          strokePaint.strokeWidth = sw
          strokePaint.pathEffect = null
          canvas.drawRoundRect(rect, radius, radius, strokePaint)
        }
      }
    }
    if (r.div) {
      divPaint.color = p.border
      canvas.drawRect(cardX, top, cardR, top + max(1f, dpf(0.5f)), divPaint)
    }
    if (r.kind == "group") {
      val bx = cardX + dpf(r.px)
      val bw = (cardR - cardX) - dpf(r.px) * 2
      rect.set(bx, top, bx + bw, top + dpf(53f))
      insetPaint.color = p.inset
      canvas.drawRoundRect(rect, dpf(10f), dpf(10f), insetPaint)
      dotPaint.color = p.text
      canvas.drawCircle(bx + dpf(14f), top + dpf(53f) / 2f, dpf(4f), dotPaint)
    }
  }

  // ─── toque ──────────────────────────────────────────────────────────────

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (row.tap) {
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> setPressedState(true)
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> setPressedState(false)
      }
    }
    return super.onTouchEvent(event)
  }

  private fun setPressedState(on: Boolean) {
    if (pressed == on) return
    pressed = on
    // Só o conteúdo esmaece (o cartão é desenhado no canvas da linha).
    for (i in 0 until childCount) {
      getChildAt(i).animate().alpha(if (on) 0.55f else 1f).setDuration(if (on) 60 else 180).start()
    }
  }
}

// ─── Motor da lista ────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
open class CMListBaseView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onLongPress by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  private val rows = HashMap<String, CMRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private val dirty = HashSet<String>()
  private var pendingReset = false
  private var needsApply = false
  private var firstPaintSent = false

  private var dark = false
  private var paletteMap: Map<String, Any?>? = null
  private var palette = CMPalette(false)
  private var paletteDirty = true
  private var bottomInsetPx = 0
  private var headerHintPx = 0
  private var footerHintPx = 0

  private val rnChildren = ArrayList<View>()
  private val headerHost = CLChildHost(context) { headerHintPx }
  private val footerHost = CLChildHost(context) { footerHintPx }

  private val refresh = SwipeRefreshLayout(context)
  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()

  // ─── Props ───────────────────────────────────────────────────────────────

  fun setRowsPatch(p: Map<String, Any?>?) {
    if (p == null) return
    try {
      val pseq = CLVal.double(p["seq"])
      val reset = CLVal.list(p["reset"])
      if (reset != null) {
        if (pseq == seq && firstPaintSent) return
        rows.clear()
        val ids = ArrayList<String>()
        for (item in reset) {
          val m = CLVal.map(item) ?: continue
          val r = CMRow.from(m)
          if (r.id.isEmpty()) continue
          if (!rows.containsKey(r.id)) ids.add(r.id)
          rows[r.id] = r
        }
        order = CLVal.list(p["order"])?.map { CLVal.str(it) } ?: ids
        seq = pseq
        pendingReset = true
        needsApply = true
        return
      }
      if (pseq <= seq) return
      val base = CLVal.double(p["base"])
      if (base != seq) {
        if (resyncAskedFor != seq) {
          resyncAskedFor = seq
          onResync(mapOf("seq" to seq))
        }
        return
      }
      CLVal.list(p["remove"])?.forEach { rows.remove(CLVal.str(it)) }
      val hasOrder = p["order"] != null
      val appended = ArrayList<String>()
      CLVal.list(p["upsert"])?.forEach { item ->
        val m = CLVal.map(item) ?: return@forEach
        val r = CMRow.from(m)
        if (r.id.isEmpty()) return@forEach
        if (!rows.containsKey(r.id) && !hasOrder) appended.add(r.id)
        rows[r.id] = r
        dirty.add(r.id)
      }
      val ord = CLVal.list(p["order"])
      order = if (ord != null) ord.map { CLVal.str(it) } else order + appended
      seq = pseq
      needsApply = true
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("patch: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  fun setDark(d: Boolean) {
    if (d == dark && !paletteDirty) return
    dark = d
    paletteDirty = true
  }

  fun setPaletteProp(m: Map<String, Any?>?) {
    paletteMap = m
    paletteDirty = true
  }

  fun setAuthToken(t: String?) { if (!t.isNullOrEmpty()) CLAuth.token = t }

  fun setHeaderHeightHint(v: Double) {
    headerHintPx = (max(0.0, v) * density).toInt()
    headerHost.requestLayout()
  }

  fun setFooterHeightHint(v: Double) {
    footerHintPx = (max(0.0, v) * density).toInt()
    footerHost.requestLayout()
  }

  fun setBottomInset(v: Double) {
    val px = (max(0.0, v) * density).toInt()
    if (px != bottomInsetPx) {
      bottomInsetPx = px
      recycler.setPadding(0, 0, 0, px)
    }
  }

  fun setRefreshingProp(on: Boolean) {
    if (!on && refresh.isRefreshing) refresh.isRefreshing = false
  }

  fun setRefreshTint(hex: String?) {
    val c = SLColor.parse(hex ?: "") ?: return
    refresh.setColorSchemeColors(c)
  }

  fun setRefreshEnabled(on: Boolean) { refresh.isEnabled = on }

  fun commitProps() {
    var rebindAll = false
    if (paletteDirty) {
      palette = CMPalette(dark, paletteMap)
      setBackgroundColor(palette.bg)
      recycler.setBackgroundColor(palette.bg)
      refresh.setProgressBackgroundColorSchemeColor(if (dark) 0xFF1A1A1A.toInt() else 0xFFFFFFFF.toInt())
      paletteDirty = false
      rebindAll = true
    }
    applyData(rebindAll)
  }

  // ─── Dados → adapter ─────────────────────────────────────────────────────

  private sealed class Item {
    object Header : Item()
    object Footer : Item()
    data class Row(val id: String) : Item()
  }

  private var items: List<Item> = listOf(Item.Header, Item.Footer)
  private val stableIds = HashMap<String, Long>()
  private var nextStable = 10L

  private fun stableId(id: String): Long = stableIds.getOrPut(id) { nextStable++ }

  private fun applyData(rebindAll: Boolean) {
    if (!needsApply && !rebindAll && firstPaintSent) return
    needsApply = false
    try {
      val seen = HashSet<String>()
      val ids = ArrayList<String>(order.size)
      for (id in order) if (rows.containsKey(id) && seen.add(id)) ids.add(id)
      if (ids.size < rows.size) rows.keys.retainAll(seen)
      order = ids
      val next = ArrayList<Item>(ids.size + 2)
      next.add(Item.Header)
      for (id in ids) next.add(Item.Row(id))
      next.add(Item.Footer)
      val old = items
      val changed = if (rebindAll || pendingReset) HashSet(ids) else HashSet(dirty)
      dirty.clear()
      val reset = pendingReset
      pendingReset = false
      if (reset && old.size <= 2) {
        items = next
        adapter.notifyDataSetChanged()
      } else {
        val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
          override fun getOldListSize() = old.size
          override fun getNewListSize() = next.size
          override fun areItemsTheSame(o: Int, n: Int): Boolean = old[o] == next[n]
          override fun areContentsTheSame(o: Int, n: Int): Boolean {
            val it = next[n]
            return !(it is Item.Row && changed.contains(it.id))
          }
          override fun getChangePayload(o: Int, n: Int): Any = PAYLOAD_BIND
        }, true)
        items = next
        diff.dispatchUpdatesTo(adapter)
      }
      if (!firstPaintSent) {
        firstPaintSent = true
        recycler.post { onFirstPaint(mapOf("count" to ids.size)) }
      }
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("apply: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  // ─── Filhos RN (GroupView) ───────────────────────────────────────────────

  fun addRnChild(child: View, index: Int) {
    val i = index.coerceIn(0, rnChildren.size)
    rnChildren.add(i, child)
    reattachChildren()
  }

  fun rnChildCount(): Int = rnChildren.size

  fun rnChildAt(index: Int): View? = rnChildren.getOrNull(index)

  fun removeRnChild(child: View) {
    headerHost.detach(child)
    footerHost.detach(child)
    rnChildren.remove(child)
    reattachChildren()
  }

  fun removeRnChildAt(index: Int) {
    val c = rnChildren.getOrNull(index) ?: return
    removeRnChild(c)
  }

  private fun reattachChildren() {
    rnChildren.forEachIndexed { i, v ->
      if (i == 0) headerHost.attach(v) else footerHost.attach(v)
    }
    headerHost.requestLayout()
    footerHost.requestLayout()
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class HostHolder(v: View) : RecyclerView.ViewHolder(v)
  private class RowHolder(val rowView: CMRowView) : RecyclerView.ViewHolder(rowView)

  private val rowListener = object : CMRowView.Listener {
    override fun onPress(id: String) { onRowPress(mapOf("id" to id)) }
    override fun onLongPress(id: String) { onLongPress(mapOf("id" to id)) }
    override fun onAction(id: String, action: String) { onRowAction(mapOf("id" to id, "action" to action)) }
  }

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (items[position]) {
      is Item.Header -> TYPE_HEADER
      is Item.Footer -> TYPE_FOOTER
      is Item.Row -> TYPE_ROW
    }

    override fun getItemId(position: Int): Long = when (val it = items[position]) {
      is Item.Header -> 1L
      is Item.Footer -> 2L
      is Item.Row -> stableId(it.id)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val lp = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
      if (viewType == TYPE_HEADER || viewType == TYPE_FOOTER) {
        val host = if (viewType == TYPE_HEADER) headerHost else footerHost
        (host.parent as? ViewGroup)?.removeView(host)
        host.layoutParams = lp
        val h = HostHolder(host)
        h.setIsRecyclable(false)
        return h
      }
      val v = CMRowView(parent.context)
      v.layoutParams = lp
      v.listener = rowListener
      return RowHolder(v)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      val item = items.getOrNull(position) as? Item.Row ?: return
      val row = rows[item.id] ?: return
      try {
        if (holder is RowHolder) holder.rowView.bind(row, palette)
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  init {
    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.setItemViewCacheSize(8)
    recycler.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 220
      addDuration = 180
      removeDuration = 160
    }
    refresh.addView(recycler, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    refresh.setOnRefreshListener {
      onRefresh(mapOf<String, Any>())
      main.postDelayed({ if (refresh.isRefreshing) refresh.isRefreshing = false }, 8000L)
    }
    addView(refresh, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    setBackgroundColor(palette.bg)
  }

  override fun onDetachedFromWindow() {
    main.removeCallbacksAndMessages(null)
    super.onDetachedFromWindow()
  }

  companion object {
    private const val TYPE_HEADER = 0
    private const val TYPE_ROW = 1
    private const val TYPE_FOOTER = 2
    private val PAYLOAD_BIND = Any()
  }
}
