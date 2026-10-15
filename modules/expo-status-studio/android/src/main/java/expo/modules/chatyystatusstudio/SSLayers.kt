package expo.modules.chatyystatusstudio

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.LineBackgroundSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.text.DateFormat
import java.util.Date
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Camada do palco. Queimáveis (texto/emoji/local): (u,v) = CENTRO normalizado no
 * palco, escala e giro livres. Interativas (menção/link/enquete/pergunta/
 * contagem/música): (u,v) = canto SUPERIOR-ESQUERDO normalizado, tamanho fixo
 * do viewer × (stageW/screenW) — só arrastar.
 */
class SSLayer(val id: String, val kind: String) {
  var text = ""
  var color = Color.WHITE
  var font = "sans"
  var bg = 0            // 0 sem fundo · 1 sólido · 2 suave
  var align = "center"
  var username = ""
  var email = ""
  var url = ""
  var label = ""
  var question = ""
  var optionA = ""
  var optionB = ""
  var prompt = ""
  var targetMs = 0L
  var track: SSTrack? = null
  var u = 0.5f
  var v = 0.4f
  var scale = 1f
  var rot = 0f          // graus

  val burnable: Boolean get() = kind == "text" || kind == "emoji" || kind == "location"
}

class SSStroke(val color: Int, val widthPx: Float, val type: String) {
  /** Pontos normalizados no palco (0..1). */
  val pts = ArrayList<PointF>()
}

object SSDraw {
  /** Mesma conta para palco e exportação: palco w×h em px. */
  fun drawStrokes(c: Canvas, strokes: List<SSStroke>, live: SSStroke?, w: Float, h: Float) {
    val all = if (live != null) strokes + live else strokes
    if (all.isEmpty()) return
    val sc = c.saveLayer(0f, 0f, w, h, null)
    for (s in all) drawStroke(c, s, w, h)
    c.restoreToCount(sc)
  }

  private fun pathOf(s: SSStroke, w: Float, h: Float): Path {
    val p = Path()
    if (s.pts.isEmpty()) return p
    var prev = s.pts[0]
    p.moveTo(prev.x * w, prev.y * h)
    if (s.pts.size == 1) { p.lineTo(prev.x * w + 0.1f, prev.y * h + 0.1f); return p }
    for (i in 1 until s.pts.size) {
      val q = s.pts[i]
      p.quadTo(prev.x * w, prev.y * h, (prev.x + q.x) / 2f * w, (prev.y + q.y) / 2f * h)
      prev = q
    }
    p.lineTo(prev.x * w, prev.y * h)
    return p
  }

  private fun drawStroke(c: Canvas, s: SSStroke, w: Float, h: Float) {
    val path = pathOf(s, w, h)
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    p.style = Paint.Style.STROKE
    p.strokeCap = Paint.Cap.ROUND
    p.strokeJoin = Paint.Join.ROUND
    when (s.type) {
      "marker" -> {
        p.color = Color.argb(140, Color.red(s.color), Color.green(s.color), Color.blue(s.color))
        p.strokeWidth = s.widthPx * 2.4f
        p.strokeCap = Paint.Cap.SQUARE
        c.drawPath(path, p)
      }
      "neon" -> {
        p.color = s.color
        p.strokeWidth = s.widthPx * 1.8f
        p.maskFilter = BlurMaskFilter(max(1f, s.widthPx * 1.3f), BlurMaskFilter.Blur.NORMAL)
        c.drawPath(path, p)
        p.maskFilter = null
        p.color = Color.WHITE
        p.strokeWidth = max(1f, s.widthPx * 0.55f)
        c.drawPath(path, p)
      }
      "eraser" -> {
        p.xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
        p.strokeWidth = s.widthPx * 2.2f
        c.drawPath(path, p)
      }
      else -> {
        p.color = s.color
        p.strokeWidth = s.widthPx
        c.drawPath(path, p)
      }
    }
  }

  /** Matriz de uma camada (igual à que a View aplica: escala/giro no pivô, depois translação). */
  fun layerMatrix(l: SSLayer, vw: Int, vh: Int, stageW: Float, stageH: Float, k: Float): Matrix {
    val m = Matrix()
    if (l.burnable) {
      m.postScale(l.scale, l.scale, vw / 2f, vh / 2f)
      m.postRotate(l.rot, vw / 2f, vh / 2f)
      m.postTranslate(l.u * stageW - vw / 2f, l.v * stageH - vh / 2f)
    } else {
      m.postScale(k, k, 0f, 0f)
      m.postTranslate(l.u * stageW, l.v * stageH)
    }
    return m
  }
}

/** Fundo da letra por linha (estilo Instagram), respeita o alinhamento. */
class SSLineBgSpan(private val color: Int, private val padH: Float, private val padV: Float, private val radius: Float) : LineBackgroundSpan {
  private val rect = RectF()
  override fun drawBackground(
    c: Canvas, p: Paint, left: Int, right: Int, top: Int, baseline: Int, bottom: Int,
    text: CharSequence, start: Int, end: Int, lnum: Int,
  ) {
    var e = end
    while (e > start && (text[e - 1] == '\n' || text[e - 1] == ' ')) e--
    if (e <= start) return
    val tw = p.measureText(text, start, e)
    val lineW = right - left
    val x0 = when (alignOf()) {
      Layout.Alignment.ALIGN_NORMAL -> left.toFloat()
      Layout.Alignment.ALIGN_OPPOSITE -> right - tw
      else -> left + (lineW - tw) / 2f
    }
    val oldC = p.color
    val oldS = p.style
    p.color = color
    p.style = Paint.Style.FILL
    rect.set(x0 - padH, top - padV, x0 + tw + padH, bottom + padV)
    c.drawRoundRect(rect, radius, radius, p)
    p.color = oldC
    p.style = oldS
  }

  var alignment: Layout.Alignment = Layout.Alignment.ALIGN_CENTER
  private fun alignOf() = alignment
}

object SSText {
  /** Auto-ajuste MEDIDO idêntico ao viewer (StoryGroupPage.layoutText): 44→14 sp, lineSpacing 1.12. */
  fun fitSp(ctx: Context, shown: String, font: String, maxW: Int, maxH: Int, align: Layout.Alignment = Layout.Alignment.ALIGN_CENTER, maxSp: Float = 44f): Float {
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    paint.typeface = SSUtil.typeface(font)
    if (font == "condensed") paint.letterSpacing = -0.02f
    val dm = ctx.resources.displayMetrics
    val s = if (shown.isEmpty()) " " else shown
    fun heightFor(sp: Float): Int {
      paint.textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, dm)
      val l = StaticLayout.Builder.obtain(s, 0, s.length, paint, max(1, maxW))
        .setAlignment(align)
        .setLineSpacing(0f, 1.12f)
        .setIncludePad(false)
        .build()
      return l.height
    }
    var lo = 14f
    var hi = maxSp
    var best = 14f
    if (heightFor(hi) <= maxH) {
      best = hi
    } else {
      while (hi - lo > 0.5f) {
        val mid = (lo + hi) / 2
        if (heightFor(mid) <= maxH) { best = mid; lo = mid } else hi = mid
      }
    }
    return floor(best)
  }

  fun alignment(a: String): Layout.Alignment = when (a) {
    "left" -> Layout.Alignment.ALIGN_NORMAL
    "right" -> Layout.Alignment.ALIGN_OPPOSITE
    else -> Layout.Alignment.ALIGN_CENTER
  }

  fun gravity(a: String): Int = when (a) {
    "left" -> Gravity.START or Gravity.CENTER_VERTICAL
    "right" -> Gravity.END or Gravity.CENTER_VERTICAL
    else -> Gravity.CENTER
  }
}

/** Fábrica das views das camadas (palco e exportação usam a MESMA). */
@SuppressLint("ViewConstructor")
class SSLayerViews(private val ctx: Context, private val opts: SSOptions) {
  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()
  private fun dpf(v: Float): Float = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics)

  private fun label(text: String, sp: Float, color: Int, bold: Boolean = true): TextView {
    val t = TextView(ctx)
    t.text = text
    t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    t.setTextColor(color)
    if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD)
    t.gravity = Gravity.CENTER
    t.includeFontPadding = false
    return t
  }

  /** stageW em px (largura máx do texto = 85% do palco, igual ao estúdio JS). */
  fun make(l: SSLayer, stageW: Int): View {
    val v: View = when (l.kind) {
      "text" -> {
        val t = TextView(ctx)
        t.text = l.text
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
        t.typeface = SSUtil.typeface(l.font)
        t.isAllCaps = l.font == "condensed"
        if (l.font == "condensed") t.letterSpacing = -0.02f
        t.includeFontPadding = false
        t.gravity = when (l.align) { "left" -> Gravity.START; "right" -> Gravity.END; else -> Gravity.CENTER_HORIZONTAL }
        t.maxWidth = (stageW * 0.85f).toInt()
        t.setLineSpacing(0f, 1.08f)
        when (l.bg) {
          1 -> {
            t.setTextColor(SSUtil.contrastOn(l.color))
            t.background = SSUtil.round(l.color, dpf(8f))
            t.setPadding(dp(10f), dp(5f), dp(10f), dp(5f))
          }
          2 -> {
            t.setTextColor(l.color)
            t.background = SSUtil.round(Color.argb(115, 0, 0, 0), dpf(8f))
            t.setPadding(dp(10f), dp(5f), dp(10f), dp(5f))
          }
          else -> {
            t.setTextColor(l.color)
            t.setShadowLayer(dpf(4f), 0f, dpf(1f), Color.argb(140, 0, 0, 0))
            t.setPadding(dp(4f), dp(2f), dp(4f), dp(2f))
          }
        }
        t
      }
      "emoji" -> label(l.text, 84f, Color.WHITE, false)
      "location" -> {
        val row = LinearLayout(ctx)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(dp(10f), dp(7f), dp(12f), dp(7f))
        row.background = SSUtil.round(Color.WHITE, dpf(10f))
        val ic = SSIconView(ctx, "pin", 16f)
        ic.color = Color.BLACK
        row.addView(ic, LinearLayout.LayoutParams(dp(18f), dp(18f)))
        val t = label(l.label.uppercase(), 15f, Color.BLACK)
        t.maxLines = 1
        t.ellipsize = TextUtils.TruncateAt.END
        t.maxWidth = (stageW * 0.7f).toInt()
        row.addView(t, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(6f) })
        row
      }
      // ── interativas: visual dos blocos do viewer Android (StoryOverlays.kt) ──
      "mention" -> {
        val t = label("@" + l.username.removePrefix("@"), 16f, Color.BLACK)
        t.setPadding(dp(16f), dp(9f), dp(16f), dp(9f))
        t.background = SSUtil.round(Color.WHITE, dpf(20f))
        t.maxLines = 1
        t.ellipsize = TextUtils.TruncateAt.END
        t
      }
      "link" -> {
        val row = LinearLayout(ctx)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(dp(14f), dp(9f), dp(16f), dp(9f))
        row.background = SSUtil.round(Color.WHITE, dpf(20f))
        val ic = SSIconView(ctx, "link", 16f)
        ic.color = Color.BLACK
        row.addView(ic, LinearLayout.LayoutParams(dp(18f), dp(18f)))
        val t = label(l.label.ifEmpty { l.url }, 15f, Color.BLACK)
        t.maxLines = 1
        t.ellipsize = TextUtils.TruncateAt.END
        t.maxWidth = dp(220f)
        row.addView(t, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(6f) })
        row
      }
      "poll" -> {
        val box = LinearLayout(ctx)
        box.orientation = LinearLayout.VERTICAL
        box.setPadding(dp(12f), dp(14f), dp(12f), dp(8f))
        box.background = SSUtil.round(Color.argb(184, 0, 0, 0), dpf(16f), Color.argb(41, 255, 255, 255), max(1, dp(1f)))
        if (l.question.isNotEmpty()) {
          val q = label(l.question, 15f, Color.WHITE)
          q.maxLines = 3
          box.addView(q, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10f); leftMargin = dp(2f); rightMargin = dp(2f) })
        }
        for (opt in listOf(l.optionA, l.optionB)) {
          val row = FrameLayout(ctx)
          row.background = SSUtil.round(Color.argb(41, 255, 255, 255), dpf(19f))
          val n = label(opt, 14f, Color.WHITE)
          n.gravity = Gravity.CENTER_VERTICAL or Gravity.START
          n.maxLines = 1
          n.ellipsize = TextUtils.TruncateAt.END
          row.addView(n, FrameLayout.LayoutParams(-1, -1).apply { leftMargin = dp(14f); rightMargin = dp(56f) })
          box.addView(row, LinearLayout.LayoutParams(-1, dp(38f)).apply { bottomMargin = dp(8f) })
        }
        box.layoutParams = FrameLayout.LayoutParams(dp(250f), -2)
        box
      }
      "question" -> {
        val box = LinearLayout(ctx)
        box.orientation = LinearLayout.VERTICAL
        box.gravity = Gravity.CENTER_HORIZONTAL
        box.setPadding(dp(14f), dp(14f), dp(14f), dp(14f))
        box.background = SSUtil.round(Color.WHITE, dpf(16f))
        val p = label(l.prompt, 15f, Color.BLACK)
        p.maxLines = 3
        box.addView(p, LinearLayout.LayoutParams(-1, -2))
        val h = label(opts.t("tapToReply", "Toque para responder"), 13f, Color.argb(115, 0, 0, 0), false)
        h.background = SSUtil.round(Color.argb(18, 0, 0, 0), dpf(18f))
        box.addView(h, LinearLayout.LayoutParams(-1, dp(36f)).apply { topMargin = dp(10f) })
        box.layoutParams = FrameLayout.LayoutParams(dp(250f), -2)
        box
      }
      "countdown" -> {
        val box = SSCountdownBlock(ctx, l, opts.t("ended", "Encerrado"))
        box.layoutParams = FrameLayout.LayoutParams(dp(220f), -2)
        box
      }
      "music" -> {
        val row = LinearLayout(ctx)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(dp(8f), dp(8f), dp(14f), dp(8f))
        row.background = SSUtil.round(Color.argb(184, 0, 0, 0), dpf(14f), Color.argb(41, 255, 255, 255), max(1, dp(1f)))
        val cover = FrameLayout(ctx)
        cover.background = SSUtil.round(Color.argb(60, 255, 255, 255), dpf(8f))
        cover.clipToOutline = true
        val ic = SSIconView(ctx, "music", 18f)
        cover.addView(ic, FrameLayout.LayoutParams(-1, -1))
        val iv = ImageView(ctx)
        iv.scaleType = ImageView.ScaleType.CENTER_CROP
        cover.addView(iv, FrameLayout.LayoutParams(-1, -1))
        l.track?.coverUrl?.takeIf { it.isNotEmpty() }?.let { SSNet.loadBitmap(it, 160) { b -> if (b != null) iv.setImageBitmap(b) } }
        row.addView(cover, LinearLayout.LayoutParams(dp(40f), dp(40f)))
        val col = LinearLayout(ctx)
        col.orientation = LinearLayout.VERTICAL
        val t1 = label(l.track?.title ?: "", 14f, Color.WHITE)
        t1.gravity = Gravity.START
        t1.maxLines = 1
        t1.ellipsize = TextUtils.TruncateAt.END
        t1.maxWidth = dp(190f)
        col.addView(t1)
        val t2 = label(l.track?.artist ?: "", 12f, Color.argb(190, 255, 255, 255), false)
        t2.gravity = Gravity.START
        t2.maxLines = 1
        t2.ellipsize = TextUtils.TruncateAt.END
        t2.maxWidth = dp(190f)
        if ((l.track?.artist ?: "").isNotEmpty()) col.addView(t2, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(3f) })
        row.addView(col, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(10f) })
        row
      }
      else -> View(ctx)
    }
    return v
  }

  /** Mede e posiciona (0,0) uma view fora da tela — usado na exportação. */
  fun measureLoose(v: View) {
    val lp = v.layoutParams
    val wSpec = if (lp != null && lp.width > 0) View.MeasureSpec.makeMeasureSpec(lp.width, View.MeasureSpec.EXACTLY)
    else View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
    v.measure(wSpec, View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    v.layout(0, 0, v.measuredWidth, v.measuredHeight)
  }
}

/** Contagem regressiva (visual do CountdownBlock do viewer). */
@SuppressLint("ViewConstructor")
class SSCountdownBlock(ctx: Context, private val l: SSLayer, private val ended: String) : LinearLayout(ctx) {
  private val time = TextView(ctx)
  private val title = TextView(ctx)
  private val date = TextView(ctx)
  private var last = Int.MIN_VALUE
  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    setPadding(dp(12f), dp(12f), dp(12f), dp(12f))
    background = SSUtil.round(Color.argb(184, 0, 0, 0), dp(16f).toFloat(), Color.argb(41, 255, 255, 255), max(1, dp(1f)))
    for ((tv, sp, c) in listOf(Triple(title, 12f, Color.argb(217, 255, 255, 255)), Triple(time, 26f, Color.WHITE), Triple(date, 11f, Color.argb(166, 255, 255, 255)))) {
      tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
      tv.setTextColor(c)
      tv.gravity = Gravity.CENTER
      tv.includeFontPadding = false
      tv.maxLines = 1
    }
    title.setTypeface(Typeface.DEFAULT, Typeface.BOLD)
    time.typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
    addView(title, LayoutParams(-1, -2))
    addView(time, LayoutParams(-1, -2).apply { topMargin = dp(6f); bottomMargin = dp(4f) })
    addView(date, LayoutParams(-1, -2))
    refresh()
  }

  fun refresh() {
    title.text = l.label
    date.text = if (l.targetMs > 0) try { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(l.targetMs)) } catch (_: Throwable) { "" } else ""
    last = Int.MIN_VALUE
    tick()
  }

  fun tick() {
    val left = if (l.targetMs > 0) floor((l.targetMs - System.currentTimeMillis()) / 1000.0).toInt() else -1
    if (left == last) return
    last = left
    if (left <= 0) { time.text = ended.ifEmpty { "00:00:00" }; return }
    val d = left / 86400
    val hms = String.format(java.util.Locale.US, "%02d:%02d:%02d", (left % 86400) / 3600, (left % 3600) / 60, left % 60)
    time.text = if (d > 0) "${d}d $hms" else hms
  }
}

@Suppress("unused")
private fun ssClamp(v: Float, lo: Float, hi: Float): Float = min(hi, max(lo, v))
