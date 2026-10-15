package expo.modules.chatyystatusstudio

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.Typeface
import android.net.Uri
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import android.widget.VideoView
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Palco 9:16 do estúdio: foto (ColorMatrix) ou vídeo em loop, desenho, camadas.
 * Gestos à mão: arrastar/pinçar/girar (queimáveis), arrastar (interativas),
 * guia de centro com háptico, lixeira, deslizar horizontal = trocar filtro com
 * divisória acompanhando o dedo, toque vazio = novo texto, modo desenho.
 */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class SSStageView(ctx: Context, private val host: Host, private val factory: SSLayerViews) : FrameLayout(ctx) {

  interface Host {
    val layers: MutableList<SSLayer>
    val strokes: MutableList<SSStroke>
    val drawing: Boolean
    val brushColor: Int
    val brushWidthPx: Float
    val brushType: String
    fun canSwipeFilter(): Boolean
    fun neighborMatrix(dir: Int): Pair<Boolean, FloatArray?>
    fun onSwipeFilter(dir: Int)
    fun onTapEmpty()
    fun onTapLayer(l: SSLayer)
    fun onDragState(active: Boolean)
    fun onLayerDeleted(l: SSLayer)
    fun onStrokeAdded()
  }

  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()
  private fun dpf(v: Float): Float = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)

  val bgView = View(ctx)
  val image = ImageView(ctx)
  private val peek = ImageView(ctx)
  var video: VideoView? = null
    private set
  private val strokesView = object : View(ctx) {
    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      SSDraw.drawStrokes(canvas, host.strokes, live, width.toFloat(), height.toFloat())
    }
  }
  private val box = FrameLayout(ctx)
  private var guideV = false
  private var guideH = false
  private val guides = object : View(ctx) {
    private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(220, 255, 255, 255); strokeWidth = dpf(1f) }
    override fun onDraw(canvas: Canvas) {
      if (guideV) canvas.drawLine(width / 2f, 0f, width / 2f, height.toFloat(), p)
      if (guideH) canvas.drawLine(0f, height / 2f, width.toFloat(), height / 2f, p)
    }
  }
  private val trash = FrameLayout(ctx)
  private val trashIcon = SSIconView(ctx, "trash", 24f)
  private val flash = TextView(ctx)
  private val views = HashMap<String, View>()

  /** stageW/screenW — escala dos blocos interativos (tamanho do viewer). */
  var k = 1f
  var bitmap: Bitmap? = null
    set(v) { field = v; image.setImageBitmap(v); peek.setImageBitmap(v) }

  private var live: SSStroke? = null

  init {
    clipChildren = true
    addView(bgView, LayoutParams(-1, -1))
    image.scaleType = ImageView.ScaleType.FIT_CENTER
    addView(image, LayoutParams(-1, -1))
    peek.scaleType = ImageView.ScaleType.FIT_CENTER
    peek.visibility = View.GONE
    addView(peek, LayoutParams(-1, -1))
    strokesView.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
    addView(strokesView, LayoutParams(-1, -1))
    box.clipChildren = false
    addView(box, LayoutParams(-1, -1))
    addView(guides, LayoutParams(-1, -1))
    trash.background = SSUtil.round(Color.argb(150, 0, 0, 0), dpf(30f), Color.argb(90, 255, 255, 255), max(1, dp(1f)))
    trash.addView(trashIcon, LayoutParams(-1, -1))
    trash.visibility = View.GONE
    addView(trash, LayoutParams(dp(60f), dp(60f), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(22f) })
    flash.setTextColor(Color.WHITE)
    flash.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
    flash.typeface = Typeface.DEFAULT_BOLD
    flash.setShadowLayer(dpf(6f), 0f, dpf(1f), Color.argb(150, 0, 0, 0))
    flash.alpha = 0f
    addView(flash, LayoutParams(-2, -2, Gravity.CENTER))
  }

  fun setFilter(m: FloatArray?) {
    image.colorFilter = m?.let { ColorMatrixColorFilter(ColorMatrix(it)) }
  }

  fun showFlash(text: String) {
    flash.text = text
    flash.animate().cancel()
    flash.alpha = 1f
    flash.animate().alpha(0f).setStartDelay(700).setDuration(260).start()
  }

  fun setVideo(uri: String?) {
    video?.let { try { it.stopPlayback() } catch (_: Throwable) {}; removeView(it) }
    video = null
    if (uri == null) return
    val vv = VideoView(context)
    addView(vv, indexOfChild(image) + 1, LayoutParams(-2, -2, Gravity.CENTER))
    vv.setOnPreparedListener { mp -> try { mp.isLooping = true; vv.start() } catch (_: Throwable) {} }
    vv.setOnErrorListener { _, _, _ -> true }
    try { vv.setVideoURI(Uri.parse(uri)) } catch (_: Throwable) {}
    video = vv
  }

  fun pauseVideo() { try { video?.pause() } catch (_: Throwable) {} }
  fun resumeVideo() { try { video?.start() } catch (_: Throwable) {} }

  fun redrawStrokes() = strokesView.invalidate()

  // ─── camadas ──────────────────────────────────────────────────────────────

  fun rebuildLayers() {
    box.removeAllViews()
    views.clear()
    for (l in host.layers) addLayerView(l)
  }

  fun addLayerView(l: SSLayer) {
    val v = factory.make(l, width.takeIf { it > 0 } ?: dp(300f))
    val lp0 = v.layoutParams
    val lp = LayoutParams(if (lp0 != null && lp0.width > 0) lp0.width else LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START)
    v.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> apply(l, v) }
    box.addView(v, lp)
    views[l.id] = v
    v.post { apply(l, v) }
  }

  fun refreshLayer(l: SSLayer) {
    views.remove(l.id)?.let { box.removeView(it) }
    addLayerView(l)
  }

  fun removeLayerView(l: SSLayer) {
    views.remove(l.id)?.let { box.removeView(it) }
  }

  fun layerView(l: SSLayer): View? = views[l.id]

  fun tick() {
    for (v in views.values) (v as? SSCountdownBlock)?.tick()
  }

  private fun apply(l: SSLayer, v: View) {
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0 || h <= 0) return
    if (l.burnable) {
      v.pivotX = v.width / 2f
      v.pivotY = v.height / 2f
      v.scaleX = l.scale
      v.scaleY = l.scale
      v.rotation = l.rot
      v.translationX = l.u * w - v.width / 2f
      v.translationY = l.v * h - v.height / 2f
    } else {
      // u/v < 0 = centralizar na 1ª medição (bloco recém-criado)
      if (v.width > 0 && l.u < 0) l.u = ((w - v.width * k) / 2f) / w
      if (v.height > 0 && l.v < 0) l.v = ((h - v.height * k) / 2f) / h
      if (l.u < 0 || l.v < 0) return
      clampWidget(l, v)
      v.pivotX = 0f
      v.pivotY = 0f
      v.scaleX = k
      v.scaleY = k
      v.rotation = 0f
      v.translationX = l.u * w
      v.translationY = l.v * h
    }
  }

  private fun clampWidget(l: SSLayer, v: View) {
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0 || h <= 0) return
    val vw = v.width * k
    val vh = v.height * k
    l.u = l.u.coerceIn(0f, max(0f, (w - vw) / w))
    l.v = l.v.coerceIn(0f, max(0f, (h - vh) / h))
  }

  // ─── toque ────────────────────────────────────────────────────────────────

  private var active: SSLayer? = null
  private var activeView: View? = null
  private var pid = -1
  private var downX = 0f
  private var downY = 0f
  private var downT = 0L
  private var moved = false
  private var pinching = false
  private var swiping = false
  private var swipeDx = 0f
  private var overTrash = false
  private var u0 = 0f
  private var v0 = 0f
  private var s0 = 1f
  private var r0 = 0f
  private var d0 = 1f
  private var a0 = 0f
  private var c0 = PointF()
  private var bx = 0f
  private var by = 0f

  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean = true

  private fun hit(x: Float, y: Float): SSLayer? {
    val inv = Matrix()
    val pt = FloatArray(2)
    val slop = dpf(10f)
    for (i in host.layers.indices.reversed()) {
      val l = host.layers[i]
      val v = views[l.id] ?: continue
      pt[0] = x - v.left
      pt[1] = y - v.top
      if (!v.matrix.invert(inv)) continue
      inv.mapPoints(pt)
      val sl = slop / max(0.2f, if (l.burnable) l.scale else k)
      if (pt[0] >= -sl && pt[1] >= -sl && pt[0] <= v.width + sl && pt[1] <= v.height + sl) return l
    }
    return null
  }

  private fun base(ev: MotionEvent) {
    val l = active ?: return
    u0 = l.u; v0 = l.v; s0 = l.scale; r0 = l.rot
    if (ev.pointerCount >= 2 && l.burnable) {
      val dx = ev.getX(1) - ev.getX(0)
      val dy = ev.getY(1) - ev.getY(0)
      d0 = max(1f, hypot(dx, dy))
      a0 = Math.toDegrees(atan2(dy.toDouble(), dx.toDouble())).toFloat()
      c0 = PointF((ev.getX(0) + ev.getX(1)) / 2f, (ev.getY(0) + ev.getY(1)) / 2f)
      pinching = true
    } else {
      val i = max(0, ev.findPointerIndex(pid))
      bx = ev.getX(i); by = ev.getY(i)
      pinching = false
    }
  }

  private fun trashHit(x: Float, y: Float): Boolean {
    val cx = width / 2f
    val cy = height - dpf(22f) - dpf(30f)
    return hypot(x - cx, y - cy) < dpf(52f)
  }

  private fun haptic() { try { performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) } catch (_: Throwable) {} }

  override fun onTouchEvent(ev: MotionEvent): Boolean {
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0 || h <= 0) return false
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        pid = ev.getPointerId(0)
        downX = ev.x; downY = ev.y; downT = System.currentTimeMillis()
        moved = false; swiping = false; overTrash = false; pinching = false
        if (host.drawing) {
          val s = SSStroke(host.brushColor, host.brushWidthPx, host.brushType)
          s.pts.add(PointF(ev.x / w, ev.y / h))
          live = s
          strokesView.invalidate()
          return true
        }
        active = hit(ev.x, ev.y)
        activeView = active?.let { views[it.id] }
        active?.let { l ->
          host.layers.remove(l); host.layers.add(l)
          activeView?.bringToFront()
          base(ev)
        }
        return true
      }
      MotionEvent.ACTION_POINTER_DOWN -> {
        if (active?.burnable == true && !host.drawing) { moved = true; base(ev) }
      }
      MotionEvent.ACTION_POINTER_UP -> {
        if (active != null && !host.drawing) {
          val up = ev.getPointerId(ev.actionIndex)
          if (up == pid) {
            for (i in 0 until ev.pointerCount) if (ev.getPointerId(i) != up) { pid = ev.getPointerId(i); break }
          }
          pinching = false
          // rebase com o dedo que ficou
          val l = active!!
          u0 = l.u; v0 = l.v; s0 = l.scale; r0 = l.rot
          for (i in 0 until ev.pointerCount) if (ev.getPointerId(i) == pid) { bx = ev.getX(i); by = ev.getY(i) }
        }
      }
      MotionEvent.ACTION_MOVE -> {
        if (host.drawing) {
          val s = live ?: return true
          for (hI in 0 until ev.historySize) s.pts.add(PointF(ev.getHistoricalX(0, hI) / w, ev.getHistoricalY(0, hI) / h))
          s.pts.add(PointF(ev.x / w, ev.y / h))
          strokesView.invalidate()
          return true
        }
        val l = active
        val v = activeView
        if (l != null && v != null) {
          if (pinching && ev.pointerCount >= 2) {
            val dx = ev.getX(1) - ev.getX(0)
            val dy = ev.getY(1) - ev.getY(0)
            val d = max(1f, hypot(dx, dy))
            val a = Math.toDegrees(atan2(dy.toDouble(), dx.toDouble())).toFloat()
            val cx = (ev.getX(0) + ev.getX(1)) / 2f
            val cy = (ev.getY(0) + ev.getY(1)) / 2f
            l.scale = (s0 * d / d0).coerceIn(0.25f, 6f)
            l.rot = r0 + (a - a0)
            l.u = u0 + (cx - c0.x) / w
            l.v = v0 + (cy - c0.y) / h
            moved = true
            host.onDragState(true)
            apply(l, v)
            return true
          }
          val i = max(0, ev.findPointerIndex(pid))
          val x = ev.getX(i)
          val y = ev.getY(i)
          if (!moved && hypot(x - bx, y - by) > dpf(5f)) { moved = true; host.onDragState(true); trash.visibility = View.VISIBLE }
          if (!moved) return true
          l.u = u0 + (x - bx) / w
          l.v = v0 + (y - by) / h
          // guia de centro (encaixe ±6dp)
          val snap = dpf(6f)
          val cw = if (l.burnable) 0f else v.width * k / 2f
          val ch = if (l.burnable) 0f else v.height * k / 2f
          val cx = l.u * w + cw
          val cy = l.v * h + ch
          val gv = abs(cx - w / 2f) < snap
          val gh = abs(cy - h / 2f) < snap
          if (gv) l.u = (w / 2f - cw) / w
          if (gh) l.v = (h / 2f - ch) / h
          if ((gv && !guideV) || (gh && !guideH)) haptic()
          if (gv != guideV || gh != guideH) { guideV = gv; guideH = gh; guides.invalidate() }
          val ot = trashHit(x, y)
          if (ot != overTrash) {
            overTrash = ot
            if (ot) haptic()
            trash.background = SSUtil.round(if (ot) Color.rgb(239, 68, 68) else Color.argb(150, 0, 0, 0), dpf(30f), Color.argb(90, 255, 255, 255), max(1, dp(1f)))
            trash.animate().scaleX(if (ot) 1.18f else 1f).scaleY(if (ot) 1.18f else 1f).setDuration(120).start()
            v.alpha = if (ot) 0.45f else 1f
          }
          apply(l, v)
          return true
        }
        // área vazia: deslizar = filtro
        val dx = ev.x - downX
        val dy = ev.y - downY
        if (!swiping && !moved && host.canSwipeFilter() && abs(dx) > dpf(14f) && abs(dx) > abs(dy) * 1.4f) swiping = true
        if (!moved && hypot(dx, dy) > dpf(10f)) moved = true
        if (swiping) {
          swipeDx = dx
          val dir = if (dx < 0) 1 else -1
          val (ok, m) = host.neighborMatrix(dir)
          if (ok) {
            peek.colorFilter = m?.let { ColorMatrixColorFilter(ColorMatrix(it)) }
            peek.visibility = View.VISIBLE
            peek.clipBounds = if (dx < 0) Rect((w + dx).toInt().coerceIn(0, w.toInt()), 0, w.toInt(), h.toInt()) else Rect(0, 0, dx.toInt().coerceIn(0, w.toInt()), h.toInt())
          } else {
            peek.visibility = View.GONE
          }
        }
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val cancel = ev.actionMasked == MotionEvent.ACTION_CANCEL
        if (host.drawing) {
          val s = live
          live = null
          if (s != null && !cancel) { host.strokes.add(s); host.onStrokeAdded() }
          strokesView.invalidate()
          return true
        }
        val l = active
        val v = activeView
        active = null
        activeView = null
        if (guideV || guideH) { guideV = false; guideH = false; guides.invalidate() }
        trash.visibility = View.GONE
        trash.scaleX = 1f; trash.scaleY = 1f
        trash.background = SSUtil.round(Color.argb(150, 0, 0, 0), dpf(30f), Color.argb(90, 255, 255, 255), max(1, dp(1f)))
        if (l != null) {
          host.onDragState(false)
          v?.alpha = 1f
          if (!cancel && overTrash && moved) { host.onLayerDeleted(l); return true }
          if (!cancel && !moved && System.currentTimeMillis() - downT < 350) host.onTapLayer(l)
          return true
        }
        if (swiping) {
          peek.visibility = View.GONE
          val dt = System.currentTimeMillis() - downT
          val commit = abs(swipeDx) > w * 0.22f || (dt < 260 && abs(swipeDx) > dpf(40f))
          swiping = false
          if (!cancel && commit) host.onSwipeFilter(if (swipeDx < 0) 1 else -1)
          return true
        }
        if (!cancel && !moved && System.currentTimeMillis() - downT < 350) host.onTapEmpty()
        return true
      }
    }
    return true
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w > 0 && w != oldw) post { rebuildLayers() }
  }

  @Suppress("unused")
  private fun clampF(v: Float, lo: Float, hi: Float) = min(hi, max(lo, v))
}
