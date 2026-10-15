package expo.modules.chatyymediaviewer

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.bumptech.glide.Glide
import java.text.DateFormat
import java.util.Date
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * [2026-10-15 native-story v2] Camada de BLOCOS do status nativo: figurinhas
 * (enquete/quiz, pergunta, menção, contagem, slider, emoji), GIF animado
 * (Glide), texto sobreposto e desenho livre — em dp no espaço de tela do autor
 * (igual ao viewer JS: left:x/top:y). Estética P&B. Toques interativos →
 * onAction(overlay, info) → dialog → evento onSticker ao JS.
 * Filhos não clicáveis não consomem toque (o toque cai na camada de navegação).
 */
@SuppressLint("ViewConstructor")
class SVOverlayLayer(context: Context) : FrameLayout(context) {

  var onAction: ((SVOverlay, Map<String, Any?>) -> Unit)? = null
  private val blocks = ArrayList<Pair<SVOverlay, View>>()
  private val drawView = PathsView(context)
  private var token = 0

  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()
  private fun dpf(v: Float): Float = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)

  init {
    clipChildren = false
    addView(drawView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  /** Desenho livre (pontos em dp). */
  inner class PathsView(ctx: Context) : View(ctx) {
    var paths: List<SVPath> = emptyList()
      set(v) { field = v; invalidate() }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
    }
    private val path = Path()

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      val d = resources.displayMetrics.density
      for (p in paths) {
        if (p.points.size < 4) continue
        path.reset()
        path.moveTo(p.points[0] * d, p.points[1] * d)
        var i = 2
        while (i + 1 < p.points.size) {
          path.lineTo(p.points[i] * d, p.points[i + 1] * d)
          i += 2
        }
        paint.color = p.color
        paint.strokeWidth = p.width * d
        canvas.drawPath(path, paint)
      }
    }
  }

  private fun round(color: Int, radiusDp: Float, strokeColor: Int? = null): GradientDrawable =
    GradientDrawable().apply {
      cornerRadius = dpf(radiusDp)
      setColor(color)
      if (strokeColor != null) setStroke(max(1, dp(1f)), strokeColor)
    }

  private fun label(text: String, sp: Float, color: Int, bold: Boolean = true): TextView {
    val t = TextView(context)
    t.text = text
    t.textSize = sp
    t.setTextColor(color)
    if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD)
    t.gravity = Gravity.CENTER
    t.includeFontPadding = false
    return t
  }

  fun render(item: SVItem?) {
    token += 1
    for ((_, v) in blocks) removeView(v)
    blocks.clear()
    drawView.paths = item?.paths ?: emptyList()
    if (item == null) return
    for (o in item.overlays) {
      val v = makeBlock(o) ?: continue
      val lp = when (o.kind) {
        "poll", "question", "slider" -> LayoutParams(dp(250f), LayoutParams.WRAP_CONTENT)
        "countdown" -> LayoutParams(dp(220f), LayoutParams.WRAP_CONTENT)
        "gif" -> LayoutParams(dp(max(20f, o.w)), dp(max(20f, o.h)))
        else -> LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
      }
      addView(v, lp)
      blocks.add(o to v)
    }
    requestLayout()
  }

  private fun makeBlock(o: SVOverlay): View? {
    when (o.kind) {
      "text" -> {
        val t = label(o.text, 24f, o.color)
        t.setPadding(dp(16f), dp(8f), dp(16f), dp(8f))
        t.background = round(Color.argb(128, 0, 0, 0), 8f)
        t.maxWidth = resources.displayMetrics.widthPixels - dp(24f)
        return t
      }
      "emoji" -> return label(o.text, 48f, Color.WHITE, false)
      "gif" -> {
        if (o.url.isEmpty()) return null
        val iv = ImageView(context)
        iv.scaleType = ImageView.ScaleType.CENTER_CROP
        iv.background = round(Color.TRANSPARENT, 8f)
        iv.clipToOutline = true
        MVItem.glideModel(o.url)?.let { m ->
          try { Glide.with(context.applicationContext).load(m).into(iv) } catch (_: Throwable) {}
        }
        return iv
      }
      "mention" -> {
        val t = label(o.text, 16f, Color.BLACK)
        t.setPadding(dp(16f), dp(9f), dp(16f), dp(9f))
        t.background = round(Color.WHITE, 20f)
        t.elevation = dpf(3f)
        t.maxLines = 1
        t.ellipsize = TextUtils.TruncateAt.END
        t.contentDescription = o.text
        if (o.email.isNotEmpty() || o.text.drop(1).contains("@")) {
          t.isClickable = true
          t.setOnClickListener { onAction?.invoke(o, mapOf("kind" to "mention", "email" to o.email, "text" to o.text)) }
        }
        return t
      }
      "poll" -> return PollBlock(o)
      "question" -> {
        val box = LinearLayout(context)
        box.orientation = LinearLayout.VERTICAL
        box.gravity = Gravity.CENTER_HORIZONTAL
        box.setPadding(dp(14f), dp(14f), dp(14f), dp(14f))
        box.background = round(Color.WHITE, 16f)
        val p = label(o.text, 15f, Color.BLACK)
        p.maxLines = 3
        box.addView(p, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        val h = label(o.hint, 13f, Color.argb(115, 0, 0, 0), false)
        h.background = round(Color.argb(18, 0, 0, 0), 18f)
        box.addView(h, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36f)).apply { topMargin = dp(10f) })
        box.contentDescription = o.text
        if (o.votable) {
          box.isClickable = true
          box.setOnClickListener { onAction?.invoke(o, mapOf("kind" to "question")) }
        }
        return box
      }
      "countdown" -> return CountdownBlock(o)
      "slider" -> return SliderBlock(o)
    }
    return null
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    val w = right - left
    val h = bottom - top
    val d = resources.displayMetrics.density
    val pad = dp(4f)
    for ((o, v) in blocks) {
      val mw = v.measuredWidth
      val mh = v.measuredHeight
      var x = if (o.x < 0) (w - mw) / 2 else (o.x * d).roundToInt()
      var y = if (o.y < 0) (h - mh) / 2 else (o.y * d).roundToInt()
      x = x.coerceIn(pad, max(pad, w - mw - pad))
      y = y.coerceIn(pad, max(pad, h - mh - pad))
      v.layout(x, y, x + mw, y + mh)
    }
  }

  /** Relógio da página ativa (contagem regressiva). */
  fun tick() {
    for ((_, v) in blocks) (v as? CountdownBlock)?.tick()
  }

  /** Modelo já atualizado pelo dialog → repinta o bloco. */
  fun refresh(overlayId: String) {
    for ((o, v) in blocks) {
      if (o.id != overlayId) continue
      (v as? PollBlock)?.refresh()
      (v as? SliderBlock)?.invalidate()
    }
  }

  // ─── Enquete / quiz ──────────────────────────────────────────────────────

  inner class PollBlock(val o: SVOverlay) : LinearLayout(context) {
    private val rows = ArrayList<FrameLayout>()
    private val fills = ArrayList<View>()
    private val names = ArrayList<TextView>()
    private val pcts = ArrayList<TextView>()

    init {
      orientation = VERTICAL
      setPadding(dp(12f), dp(14f), dp(12f), dp(8f))
      background = round(Color.argb(184, 0, 0, 0), 16f, Color.argb(41, 255, 255, 255))
      if (o.question.isNotEmpty()) {
        val q = label(o.question, 15f, Color.WHITE)
        q.maxLines = 3
        addView(q, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(10f); leftMargin = dp(2f); rightMargin = dp(2f) })
      }
      o.options.forEachIndexed { i, opt ->
        val row = FrameLayout(context)
        row.clipToOutline = true
        val fill = View(context)
        row.addView(fill, FrameLayout.LayoutParams(0, FrameLayout.LayoutParams.MATCH_PARENT))
        val n = label(opt, 14f, Color.WHITE)
        n.gravity = Gravity.CENTER_VERTICAL or Gravity.START
        n.maxLines = 1
        n.ellipsize = TextUtils.TruncateAt.END
        row.addView(n, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply { leftMargin = dp(14f); rightMargin = dp(56f) })
        val p = label("", 13f, Color.WHITE)
        p.gravity = Gravity.CENTER_VERTICAL or Gravity.END
        row.addView(p, FrameLayout.LayoutParams(dp(52f), FrameLayout.LayoutParams.MATCH_PARENT, Gravity.END).apply { rightMargin = dp(12f) })
        row.contentDescription = opt
        row.setOnClickListener { vote(i) }
        addView(row, LayoutParams(LayoutParams.MATCH_PARENT, dp(38f)).apply { bottomMargin = dp(8f) })
        rows.add(row); fills.add(fill); names.add(n); pcts.add(p)
      }
      refresh()
    }

    private val isQuiz get() = o.correct >= 0
    private val voted get() = o.myVote >= 0 || o.myVote == -2

    private fun vote(i: Int) {
      if (!o.votable || o.myVote != -1 || i !in o.options.indices) return
      o.myVote = i
      if (o.counts.size == o.options.size) o.counts[i] = o.counts[i] + 1
      performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      refresh()
      onAction?.invoke(o, mapOf("kind" to (if (isQuiz) "quiz" else "poll"), "index" to i))
    }

    fun refresh() {
      val total = o.counts.sum()
      for (i in rows.indices) {
        val mine = o.myVote == i
        var bg = Color.argb(41, 255, 255, 255)
        var fg = Color.WHITE
        var fillC = Color.argb(72, 255, 255, 255)
        var strike = false
        if (isQuiz && voted) {
          if (i == o.correct) { bg = Color.WHITE; fg = Color.BLACK; fillC = Color.TRANSPARENT }
          else if (mine) { strike = true; fg = Color.argb(153, 255, 255, 255) }
        }
        rows[i].background = round(bg, 19f, if (mine) Color.WHITE else null)
        rows[i].isClickable = o.votable && !voted
        fills[i].setBackgroundColor(fillC)
        names[i].setTextColor(fg)
        names[i].paintFlags = if (strike) names[i].paintFlags or Paint.STRIKE_THRU_TEXT_FLAG else names[i].paintFlags and Paint.STRIKE_THRU_TEXT_FLAG.inv()
        names[i].text = if (mine || (isQuiz && voted && i == o.correct)) "✓  ${o.options[i]}" else o.options[i]
        pcts[i].setTextColor(fg)
        val show = voted && !isQuiz && total > 0 && i < o.counts.size
        pcts[i].text = if (show) "${(o.counts[i] * 100.0 / total).roundToInt()}%" else ""
        val frac = if (show) o.counts[i].toFloat() / total else 0f
        rows[i].post {
          val lp = fills[i].layoutParams
          lp.width = (rows[i].width * frac).toInt()
          fills[i].layoutParams = lp
        }
      }
    }
  }

  // ─── Contagem regressiva ─────────────────────────────────────────────────

  inner class CountdownBlock(val o: SVOverlay) : LinearLayout(context) {
    private val time = label("", 26f, Color.WHITE)
    private var last = Int.MIN_VALUE

    init {
      orientation = VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setPadding(dp(12f), dp(12f), dp(12f), dp(12f))
      background = round(Color.argb(184, 0, 0, 0), 16f, Color.argb(41, 255, 255, 255))
      addView(label(o.text, 12f, Color.argb(217, 255, 255, 255)), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
      time.typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
      time.maxLines = 1
      addView(time, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f); bottomMargin = dp(4f) })
      if (o.targetMs > 0) {
        val ds = try { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(o.targetMs.toLong())) } catch (_: Throwable) { "" }
        addView(label(ds, 11f, Color.argb(166, 255, 255, 255), false), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
      }
      tick()
    }

    fun tick() {
      val now = System.currentTimeMillis().toDouble()
      val left = if (o.targetMs > 0) floor((o.targetMs - now) / 1000.0).toInt() else -1
      if (left == last) return
      last = left
      if (left <= 0) {
        time.text = o.ended.ifEmpty { "00:00:00" }
        return
      }
      val d = left / 86400
      val hms = String.format(java.util.Locale.US, "%02d:%02d:%02d", (left % 86400) / 3600, (left % 3600) / 60, left % 60)
      time.text = if (d > 0) "${d}d $hms" else hms
    }
  }

  // ─── Slider (arrastar o emoji) ───────────────────────────────────────────

  inner class SliderBlock(val o: SVOverlay) : View(context) {
    private val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      textSize = dpf(14f)
      typeface = Typeface.DEFAULT_BOLD
      textAlign = Paint.Align.CENTER
    }
    private val emojiPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dpf(28f); textAlign = Paint.Align.CENTER }
    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(46, 255, 255, 255) }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val markStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; style = Paint.Style.STROKE; strokeWidth = dpf(2f) }
    private val rect = RectF()
    private var drag = if (o.value >= 0) o.value else 50.0
    private var tracking = false

    init {
      background = round(Color.argb(184, 0, 0, 0), 18f, Color.argb(41, 255, 255, 255))
      contentDescription = o.text
    }

    private val enabledNow get() = o.votable && o.value < 0

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
      setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec).let { if (it > 0) it else dp(250f) }, dp(96f))
    }

    private fun trackL() = dpf(20f)
    private fun trackR() = width - dpf(20f)
    private fun trackY() = dpf(64f)

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      val t = TextUtils.ellipsize(o.text, android.text.TextPaint(titlePaint), width - dpf(28f), TextUtils.TruncateAt.END).toString()
      canvas.drawText(t, width / 2f, dpf(30f), titlePaint)
      val l = trackL(); val r = trackR(); val y = trackY()
      val rr = dpf(4f)
      rect.set(l, y - rr, r, y + rr)
      canvas.drawRoundRect(rect, rr, rr, trackPaint)
      val v = (if (o.value >= 0) o.value else drag).coerceIn(0.0, 100.0).toFloat() / 100f
      val x = l + (r - l) * v
      rect.set(l, y - rr, x, y + rr)
      canvas.drawRoundRect(rect, rr, rr, fillPaint)
      if (o.avg >= 0 && o.value >= 0) {
        val ax = l + (r - l) * (o.avg.coerceIn(0.0, 100.0).toFloat() / 100f)
        canvas.drawCircle(ax, y, dpf(6f), fillPaint)
        canvas.drawCircle(ax, y, dpf(6f), markStroke)
      }
      canvas.drawText(o.emoji, x, y + dpf(10f), emojiPaint)
    }

    private fun valueAt(ex: Float): Double {
      val l = trackL(); val r = trackR()
      return (((ex - l) / max(1f, r - l)).coerceIn(0f, 1f) * 100f).toDouble()
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(ev: MotionEvent): Boolean {
      if (!enabledNow) return false
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          tracking = true
          parent?.requestDisallowInterceptTouchEvent(true)
          drag = valueAt(ev.x); invalidate()
        }
        MotionEvent.ACTION_MOVE -> { if (tracking) { drag = valueAt(ev.x); invalidate() } }
        MotionEvent.ACTION_UP -> {
          if (!tracking) return true
          tracking = false
          drag = valueAt(ev.x)
          o.value = drag
          performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
          invalidate()
          onAction?.invoke(o, mapOf("kind" to "slider", "value" to drag.roundToInt()))
        }
        MotionEvent.ACTION_CANCEL -> { tracking = false; drag = 50.0; invalidate() }
      }
      return true
    }
  }
}

/** [v2] Visual do status de VOZ: disco com microfone + ondas + legenda. */
class SVVoiceView(context: Context) : LinearLayout(context) {
  private val bars = ArrayList<View>()
  private val title = TextView(context)
  val caption = TextView(context)
  private val heights = intArrayOf(10, 18, 26, 16, 30, 22, 34, 20, 28, 14, 24, 32, 18, 26, 12, 22, 30, 16, 24, 20)

  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER
    setPadding(dp(32f), 0, dp(32f), 0)
    val outer = FrameLayout(context)
    outer.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.argb(41, 255, 255, 255)) }
    val inner = FrameLayout(context)
    inner.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.argb(56, 255, 255, 255)) }
    val mic = ImageView(context)
    mic.setImageResource(R.drawable.sv_ic_mic)
    mic.setColorFilter(Color.WHITE)
    inner.addView(mic, FrameLayout.LayoutParams(dp(40f), dp(40f), Gravity.CENTER))
    outer.addView(inner, FrameLayout.LayoutParams(dp(84f), dp(84f), Gravity.CENTER))
    addView(outer, LayoutParams(dp(108f), dp(108f)).apply { bottomMargin = dp(26f) })
    val row = LinearLayout(context)
    row.orientation = HORIZONTAL
    row.gravity = Gravity.CENTER
    for (h in heights) {
      val b = View(context)
      b.background = GradientDrawable().apply { cornerRadius = dp(2f).toFloat(); setColor(Color.WHITE) }
      b.alpha = 0.45f
      row.addView(b, LayoutParams(dp(4f), dp(h.toFloat())).apply { leftMargin = dp(2f); rightMargin = dp(2f) })
      bars.add(b)
    }
    addView(row, LayoutParams(LayoutParams.WRAP_CONTENT, dp(40f)))
    title.setTextColor(Color.WHITE)
    title.textSize = 16f
    title.setTypeface(Typeface.DEFAULT, Typeface.BOLD)
    title.gravity = Gravity.CENTER
    addView(title, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(18f) })
    caption.setTextColor(Color.argb(217, 255, 255, 255))
    caption.textSize = 15f
    caption.gravity = Gravity.CENTER
    caption.maxLines = 4
    caption.ellipsize = TextUtils.TruncateAt.END
    addView(caption, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f) })
  }

  fun configure(t: String, c: String) {
    title.text = t
    caption.text = c
    caption.visibility = if (c.isEmpty()) View.GONE else View.VISIBLE
    setProgress(0f)
  }

  fun setProgress(f: Float) {
    val lit = (f.coerceIn(0f, 1f) * bars.size).toInt()
    for (i in bars.indices) {
      val a = if (i < lit) 1f else 0.45f
      if (bars[i].alpha != a) bars[i].alpha = a
    }
  }
}

@Suppress("unused")
private fun svClamp(v: Float, lo: Float, hi: Float): Float = min(hi, max(lo, v))
