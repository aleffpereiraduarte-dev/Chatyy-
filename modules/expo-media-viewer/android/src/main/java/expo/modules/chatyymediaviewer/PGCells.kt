package expo.modules.chatyymediaviewer

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.view.View
import android.widget.ImageView

// [2026-10-15 native-photos] Células da grade: 1 ImageView que desenha por cima
// selo de status, duração e check de seleção (sem drawables/emoji).

@SuppressLint("AppCompatCustomView")
class PGCellView(context: Context) : ImageView(context) {
  private val d = context.resources.displayMetrics.density

  @JvmField var item: PGItem? = null
  @JvmField var status: Int = PGStatus.NONE
  @JvmField var showBadges = true
  @JvmField var tiny = false
  @JvmField var selectionMode = false
  @JvmField var selectedState = false
  @JvmField var accent = Color.parseColor("#2F80ED")
  @JvmField var placeholder = Color.argb(40, 128, 128, 128)

  init {
    scaleType = ScaleType.CENTER_CROP
    setBackgroundColor(placeholder)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    setMeasuredDimension(w, w)
  }

  fun setSelectedAnimated(sel: Boolean, animate: Boolean) {
    if (selectedState == sel && scaleX == (if (sel) SEL_SCALE else 1f)) { invalidate(); return }
    selectedState = sel
    val target = if (sel) SEL_SCALE else 1f
    animate().cancel()
    if (animate) animate().scaleX(target).scaleY(target).setDuration(140).start()
    else { scaleX = target; scaleY = target }
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val it = item ?: return
    val w = width.toFloat(); val h = height.toFloat()
    if (tiny) {
      if (selectionMode && selectedState) drawCheck(canvas, w - 2 * d - 6 * d, 2 * d + 6 * d, 6 * d, true)
      return
    }
    val res = Res.get(d)
    // vídeo: gradiente leve + duração (inferior esquerdo)
    val dur = it.durationLabel
    if (it.video && dur != null) {
      res.gradPaint.shader = res.gradient(h)
      canvas.save(); canvas.translate(0f, h - res.gradH)
      canvas.drawRect(0f, 0f, w, res.gradH, res.gradPaint)
      canvas.restore()
      canvas.drawText(dur, 5 * d, h - 6 * d, res.durPaint)
    }
    if (it.unavailable) {
      canvas.drawColor(Color.argb(110, 0, 0, 0))
    }
    if (showBadges && status != PGStatus.NONE) {
      val r = 9 * d
      val cx = w - 4 * d - r
      val cy = h - 4 * d - r
      drawBadge(canvas, res, cx, cy, r, status)
    }
    if (selectionMode) drawCheck(canvas, w - 6 * d - 10 * d, 6 * d + 10 * d, 10 * d, selectedState)
  }

  private fun drawBadge(c: Canvas, res: Res, cx: Float, cy: Float, r: Float, st: Int) {
    val failed = st == PGStatus.FAILED
    res.bgPaint.color = if (failed) Color.argb(235, 255, 69, 58) else Color.argb(140, 0, 0, 0)
    c.drawCircle(cx, cy, r, res.bgPaint)
    // nuvem (path em coordenadas unitárias, centrada)
    val s = r * 1.25f
    c.save()
    c.translate(cx - s / 2f, cy - s / 2f + s * 0.06f)
    c.scale(s, s)
    res.cloudPaint.alpha = if (st == PGStatus.PENDING) 150 else 255
    c.drawPath(res.cloud, res.cloudPaint)
    c.restore()
    val sym = res.symPaint
    sym.color = if (failed) Color.rgb(255, 69, 58) else Color.argb(220, 0, 0, 0)
    val u = s / 10f
    val sx = cx; val sy = cy + s * 0.12f
    when (st) {
      PGStatus.CLOUD -> {
        res.tmp.reset()
        res.tmp.moveTo(sx - 1.8f * u, sy)
        res.tmp.lineTo(sx - 0.4f * u, sy + 1.3f * u)
        res.tmp.lineTo(sx + 2f * u, sy - 1.3f * u)
        c.drawPath(res.tmp, sym)
      }
      PGStatus.UPLOADING -> {
        c.drawLine(sx, sy + 1.6f * u, sx, sy - 1.6f * u, sym)
        res.tmp.reset()
        res.tmp.moveTo(sx - 1.4f * u, sy - 0.3f * u)
        res.tmp.lineTo(sx, sy - 1.7f * u)
        res.tmp.lineTo(sx + 1.4f * u, sy - 0.3f * u)
        c.drawPath(res.tmp, sym)
      }
      PGStatus.FAILED -> {
        c.drawLine(sx, sy - 1.7f * u, sx, sy + 0.4f * u, sym)
        c.drawPoint(sx, sy + 1.6f * u, sym)
      }
      PGStatus.LOCAL -> {
        res.slashPaint.strokeWidth = 1.6f * d
        c.drawLine(cx - r * 0.62f, cy - r * 0.62f, cx + r * 0.62f, cy + r * 0.62f, res.slashOutline)
        c.drawLine(cx - r * 0.62f, cy - r * 0.62f, cx + r * 0.62f, cy + r * 0.62f, res.slashPaint)
      }
      else -> {}
    }
  }

  private fun drawCheck(c: Canvas, cx: Float, cy: Float, r: Float, on: Boolean) {
    val res = Res.get(d)
    if (on) {
      res.fill.color = accent
      c.drawCircle(cx, cy, r, res.fill)
      res.ring.color = Color.WHITE
      c.drawCircle(cx, cy, r, res.ring)
      res.tmp.reset()
      res.tmp.moveTo(cx - r * 0.45f, cy + r * 0.02f)
      res.tmp.lineTo(cx - r * 0.1f, cy + r * 0.38f)
      res.tmp.lineTo(cx + r * 0.48f, cy - r * 0.32f)
      res.checkPaint.strokeWidth = r * 0.22f
      c.drawPath(res.tmp, res.checkPaint)
    } else {
      res.fill.color = Color.argb(60, 0, 0, 0)
      c.drawCircle(cx, cy, r, res.fill)
      res.ring.color = Color.WHITE
      c.drawCircle(cx, cy, r, res.ring)
    }
  }

  /** Recursos de desenho compartilhados (sem alocação por célula/bind). */
  class Res private constructor(d: Float) {
    val gradH = 28 * d
    private var gradShader: LinearGradient? = null
    val gradPaint = Paint()
    val durPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE; textSize = 11.5f * d; typeface = Typeface.DEFAULT_BOLD
      setShadowLayer(2 * d, 0f, 0.5f * d, Color.argb(120, 0, 0, 0))
    }
    val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    val cloudPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL }
    val symPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE; strokeWidth = 1.5f * d; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    val slashPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND
    }
    val slashOutline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.argb(200, 0, 0, 0); style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeWidth = 3.4f * d
    }
    val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.5f * d }
    val checkPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    val tmp = Path()
    /** Nuvem em [0,1]x[0,1]. */
    val cloud = Path().apply {
      addCircle(0.32f, 0.58f, 0.2f, Path.Direction.CW)
      addCircle(0.55f, 0.45f, 0.26f, Path.Direction.CW)
      addCircle(0.76f, 0.62f, 0.17f, Path.Direction.CW)
      addRect(RectF(0.32f, 0.55f, 0.76f, 0.79f), Path.Direction.CW)
      fillType = Path.FillType.WINDING
    }

    fun gradient(h: Float): LinearGradient {
      val g = gradShader
      if (g != null) return g
      val n = LinearGradient(0f, 0f, 0f, gradH, Color.TRANSPARENT, Color.argb(120, 0, 0, 0), Shader.TileMode.CLAMP)
      gradShader = n
      return n
    }

    companion object {
      private var inst: Res? = null
      private var instD = 0f
      fun get(d: Float): Res {
        val i = inst
        if (i != null && instD == d) return i
        val n = Res(d); inst = n; instD = d
        return n
      }
    }
  }

  companion object {
    const val SEL_SCALE = 0.88f
  }
}

/** Linha de cabeçalho (dentro da lista; o grudado é desenhado pela decoration). */
class PGHeaderView(context: Context) : View(context) {
  private val d = context.resources.displayMetrics.density
  @JvmField var title: String = ""
  @JvmField var heightPx: Int = (44 * d).toInt()
  @JvmField var showSelect = false
  @JvmField var allSelected = false
  @JvmField var accent = Color.parseColor("#2F80ED")
  val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = 15f * d; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  }
  private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.5f * d }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val check = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 2f * d
    strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
  }
  private val path = Path()

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), heightPx)
  }

  override fun onDraw(canvas: Canvas) {
    PGHeaderView.drawHeader(canvas, width.toFloat(), height.toFloat(), d, title, textPaint, showSelect, allSelected,
      accent, ring, fill, check, path, null)
  }

  /** Retângulo (px, relativo ao header) do círculo "selecionar dia". */
  fun selectHit(x: Float): Boolean = showSelect && x > width - 52 * d

  companion object {
    fun drawHeader(
      c: Canvas, w: Float, h: Float, d: Float, title: String, textPaint: Paint,
      showSelect: Boolean, allSelected: Boolean, accent: Int,
      ring: Paint, fill: Paint, check: Paint, path: Path, bg: Paint?,
    ) {
      if (bg != null) c.drawRect(0f, 0f, w, h, bg)
      val fm = textPaint.fontMetrics
      val baseline = h / 2f - (fm.ascent + fm.descent) / 2f
      c.drawText(title, 16 * d, baseline, textPaint)
      if (showSelect) {
        val r = 10 * d
        val cx = w - 16 * d - r
        val cy = h / 2f
        if (allSelected) {
          fill.color = accent
          c.drawCircle(cx, cy, r, fill)
          path.reset()
          path.moveTo(cx - r * 0.45f, cy + r * 0.02f)
          path.lineTo(cx - r * 0.1f, cy + r * 0.38f)
          path.lineTo(cx + r * 0.48f, cy - r * 0.32f)
          c.drawPath(path, check)
        } else {
          ring.color = textPaint.color
          ring.alpha = 160
          c.drawCircle(cx, cy, r, ring)
        }
      }
    }
  }
}
