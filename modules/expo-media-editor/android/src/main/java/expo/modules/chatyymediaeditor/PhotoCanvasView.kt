package expo.modules.chatyymediaeditor

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.RectF
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * [2026-10-15 native-editor] Palco da foto: desenha imagem (com filtro
 * ColorMatrix na GPU via Paint), traços e objetos de texto/figurinha; trata os
 * gestos de desenhar, mover/pinçar/girar objetos e a moldura de recorte.
 */
@SuppressLint("ViewConstructor")
class PhotoCanvasView(ctx: Context, private val host: Host) : View(ctx) {

  interface Host {
    fun state(): MEState
    fun beginMutation()
    fun cancelMutation()
    fun changed()
    fun objTapped(index: Int)
    fun objDragging(active: Boolean, overTrash: Boolean)
    fun brushColor(): Int
    fun brushWidthPx(): Float
  }

  companion object {
    const val MODE_OBJECTS = 0
    const val MODE_DRAW = 1
    const val MODE_CROP = 2
  }

  var bitmap: Bitmap? = null
    set(v) { field = v; invalidate() }
  var mode = MODE_OBJECTS
    set(v) { field = v; activeObj = -1; invalidate() }
  /** Matriz 4x5 do Android (translação 0..255) ou null = original. */
  var filterMatrix: FloatArray? = null
    set(v) {
      field = v
      bmPaint.colorFilter = if (v != null) ColorMatrixColorFilter(ColorMatrix(v)) else null
      invalidate()
    }
  /** Moldura sendo editada (modo recorte), normalizada. */
  val editCrop = RectF(0f, 0f, 1f, 1f)
  /** 0 = livre; > 0 = proporção largura/altura em pixels. */
  var cropRatio = 0f

  private val density = resources.displayMetrics.density
  private val bmPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val strokePaint = MEDraw.strokePaint()
  private val dimPaint = Paint().apply { color = Color.argb(150, 0, 0, 0) }
  private val framePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.WHITE }
  private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.argb(110, 255, 255, 255) }
  private val handlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.WHITE; strokeCap = Paint.Cap.SQUARE }

  val fullRect = RectF()
  val cropRect = RectF()
  private val slop = ViewConfiguration.get(ctx).scaledTouchSlop.toFloat()

  // ── gesto atual ──
  private var activeObj = -1
  private var liveStroke: MEStroke? = null
  private var downX = 0f
  private var downY = 0f
  private var downAt = 0L
  private var moved = false
  private var o0u = 0f; private var o0v = 0f; private var o0s = 0f; private var o0r = 0f
  private var pinching = false
  private var p0dist = 1f; private var p0ang = 0f; private var p0cx = 0f; private var p0cy = 0f
  private var cropHandle = 0 // 1..4 cantos (tl,tr,br,bl) · 5..8 lados (l,t,r,b) · 9 mover
  private val crop0 = RectF()

  fun shortSide(): Float = min(fullRect.width(), fullRect.height())

  fun computeRects() {
    val bm = bitmap ?: return
    val bw = bm.width.toFloat()
    val bh = bm.height.toFloat()
    val inset = if (mode == MODE_CROP) 26f * density else 0f
    val aw = max(1f, width - inset * 2)
    val ah = max(1f, height - inset * 2)
    val shown = if (mode == MODE_CROP) RectF(0f, 0f, 1f, 1f) else host.state().crop
    val cw = max(1f, shown.width() * bw)
    val ch = max(1f, shown.height() * bh)
    val k = min(aw / cw, ah / ch)
    val dw = cw * k
    val dh = ch * k
    val dl = (width - dw) / 2f
    val dt = (height - dh) / 2f
    cropRect.set(dl, dt, dl + dw, dt + dh)
    val fl = dl - shown.left * bw * k
    val ft = dt - shown.top * bh * k
    fullRect.set(fl, ft, fl + bw * k, ft + bh * k)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val bm = bitmap ?: return
    computeRects()
    val st = host.state()
    val f = fullRect
    val short = shortSide()
    canvas.save()
    canvas.clipRect(cropRect)
    canvas.drawBitmap(bm, null, f, bmPaint)
    for (s in st.strokes) MEDraw.drawStroke(canvas, s, f.left, f.top, f.width(), f.height(), short, strokePaint)
    liveStroke?.let { MEDraw.drawStroke(canvas, it, f.left, f.top, f.width(), f.height(), short, strokePaint) }
    for ((i, o) in st.objs.withIndex()) {
      MEDraw.drawObj(canvas, o, f.left + o.u * f.width(), f.top + o.v * f.height(), short, highlight = i == activeObj && moved)
    }
    canvas.restore()
    if (mode == MODE_CROP) drawCropUi(canvas)
  }

  private fun editRectPx(): RectF {
    val f = fullRect
    return RectF(
      f.left + editCrop.left * f.width(), f.top + editCrop.top * f.height(),
      f.left + editCrop.right * f.width(), f.top + editCrop.bottom * f.height(),
    )
  }

  private fun drawCropUi(c: Canvas) {
    val e = editRectPx()
    val d = cropRect
    c.drawRect(d.left, d.top, d.right, e.top, dimPaint)
    c.drawRect(d.left, e.bottom, d.right, d.bottom, dimPaint)
    c.drawRect(d.left, e.top, e.left, e.bottom, dimPaint)
    c.drawRect(e.right, e.top, d.right, e.bottom, dimPaint)
    gridPaint.strokeWidth = 1f * density
    for (i in 1..2) {
      val x = e.left + e.width() * i / 3f
      val y = e.top + e.height() * i / 3f
      c.drawLine(x, e.top, x, e.bottom, gridPaint)
      c.drawLine(e.left, y, e.right, y, gridPaint)
    }
    framePaint.strokeWidth = 1.5f * density
    c.drawRect(e, framePaint)
    val L = 18f * density
    val t = 3f * density
    handlePaint.strokeWidth = t
    val o = t / 2f
    // cantos em L
    c.drawLine(e.left - o, e.top - o, e.left - o + L, e.top - o, handlePaint)
    c.drawLine(e.left - o, e.top - o, e.left - o, e.top - o + L, handlePaint)
    c.drawLine(e.right + o, e.top - o, e.right + o - L, e.top - o, handlePaint)
    c.drawLine(e.right + o, e.top - o, e.right + o, e.top - o + L, handlePaint)
    c.drawLine(e.right + o, e.bottom + o, e.right + o - L, e.bottom + o, handlePaint)
    c.drawLine(e.right + o, e.bottom + o, e.right + o, e.bottom + o - L, handlePaint)
    c.drawLine(e.left - o, e.bottom + o, e.left - o + L, e.bottom + o, handlePaint)
    c.drawLine(e.left - o, e.bottom + o, e.left - o, e.bottom + o - L, handlePaint)
  }

  // ─── proporção do recorte ─────────────────────────────────────────────────

  /** r: 0 livre · −1 original · > 0 largura/altura (px). Recentra a moldura. */
  fun applyRatio(r: Float) {
    val bm = bitmap ?: return
    val bw = bm.width.toFloat()
    val bh = bm.height.toFloat()
    val ratio = if (r < 0f) bw / bh else r
    cropRatio = if (r == 0f) 0f else ratio
    if (r == 0f) { invalidate(); return }
    // largura/altura normalizadas com w*bw/(h*bh) = ratio, maior possível
    var w: Float
    var h: Float
    if (ratio >= bw / bh) { w = 1f; h = bw / (ratio * bh) } else { h = 1f; w = ratio * bh / bw }
    w = min(1f, w); h = min(1f, h)
    val cx = 0.5f
    val cy = 0.5f
    editCrop.set(cx - w / 2f, cy - h / 2f, cx + w / 2f, cy + h / 2f)
    invalidate()
  }

  // ─── toque ────────────────────────────────────────────────────────────────

  private fun hitObj(x: Float, y: Float): Int {
    val st = host.state()
    val f = fullRect
    val short = shortSide()
    val extra = 10f * density
    for (i in st.objs.indices.reversed()) {
      val o = st.objs[i]
      val l = MEDraw.layout(o, short)
      val (hw, hh) = MEDraw.halfBox(l)
      val cx = f.left + o.u * f.width()
      val cy = f.top + o.v * f.height()
      val dx = x - cx
      val dy = y - cy
      val c = cos(-o.rot)
      val s = sin(-o.rot)
      val lx = dx * c - dy * s
      val ly = dx * s + dy * c
      if (abs(lx) <= hw + extra && abs(ly) <= hh + extra) return i
    }
    return -1
  }

  fun trashCenterY(): Float = height - 64f * density
  private fun overTrash(x: Float, y: Float): Boolean =
    hypot(x - width / 2f, y - trashCenterY()) < 52f * density

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(e: MotionEvent): Boolean {
    if (bitmap == null) return false
    computeRects()
    return when (mode) {
      MODE_DRAW -> touchDraw(e)
      MODE_CROP -> touchCrop(e)
      else -> touchObjects(e)
    }
  }

  private fun norm(x: Float, y: Float): Pair<Float, Float> {
    val f = fullRect
    return Pair((x - f.left) / max(1f, f.width()), (y - f.top) / max(1f, f.height()))
  }

  private fun touchDraw(e: MotionEvent): Boolean {
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        val short = max(1f, shortSide())
        val s = MEStroke(host.brushColor(), host.brushWidthPx() / short)
        val (u, v) = norm(e.x, e.y)
        s.pts.add(u); s.pts.add(v)
        liveStroke = s
        parent?.requestDisallowInterceptTouchEvent(true)
        invalidate()
      }
      MotionEvent.ACTION_MOVE -> {
        val s = liveStroke ?: return true
        for (h in 0 until e.historySize) {
          val (u, v) = norm(e.getHistoricalX(0, h), e.getHistoricalY(0, h))
          s.pts.add(u); s.pts.add(v)
        }
        val (u, v) = norm(e.x, e.y)
        s.pts.add(u); s.pts.add(v)
        invalidate()
      }
      MotionEvent.ACTION_UP -> {
        val s = liveStroke
        liveStroke = null
        if (s != null) {
          host.beginMutation()
          host.state().strokes.add(s)
          host.changed()
        }
        invalidate()
      }
      MotionEvent.ACTION_CANCEL -> { liveStroke = null; invalidate() }
    }
    return true
  }

  private fun rebaseSingle(x: Float, y: Float) {
    val st = host.state()
    if (activeObj !in st.objs.indices) return
    val o = st.objs[activeObj]
    downX = x; downY = y
    o0u = o.u; o0v = o.v; o0s = o.scale; o0r = o.rot
  }

  private fun rebasePinch(e: MotionEvent) {
    val st = host.state()
    if (activeObj !in st.objs.indices || e.pointerCount < 2) return
    val o = st.objs[activeObj]
    val x0 = e.getX(0); val y0 = e.getY(0); val x1 = e.getX(1); val y1 = e.getY(1)
    p0dist = max(1f, hypot(x1 - x0, y1 - y0))
    p0ang = atan2(y1 - y0, x1 - x0)
    p0cx = (x0 + x1) / 2f; p0cy = (y0 + y1) / 2f
    o0u = o.u; o0v = o.v; o0s = o.scale; o0r = o.rot
  }

  private fun touchObjects(e: MotionEvent): Boolean {
    val st = host.state()
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        moved = false
        pinching = false
        downAt = SystemClock.uptimeMillis()
        val hit = hitObj(e.x, e.y)
        if (hit < 0) { activeObj = -1; return false }
        host.beginMutation()
        // traz para a frente
        val o = st.objs.removeAt(hit)
        st.objs.add(o)
        activeObj = st.objs.size - 1
        rebaseSingle(e.x, e.y)
        parent?.requestDisallowInterceptTouchEvent(true)
        invalidate()
      }
      MotionEvent.ACTION_POINTER_DOWN -> {
        if (activeObj >= 0 && e.pointerCount >= 2) { pinching = true; moved = true; rebasePinch(e) }
      }
      MotionEvent.ACTION_POINTER_UP -> {
        if (activeObj >= 0) {
          pinching = false
          val keep = if (e.actionIndex == 0) 1 else 0
          if (keep < e.pointerCount) rebaseSingle(e.getX(keep), e.getY(keep))
        }
      }
      MotionEvent.ACTION_MOVE -> {
        if (activeObj !in st.objs.indices) return false
        val o = st.objs[activeObj]
        val f = fullRect
        if (pinching && e.pointerCount >= 2) {
          val x0 = e.getX(0); val y0 = e.getY(0); val x1 = e.getX(1); val y1 = e.getY(1)
          val d = max(1f, hypot(x1 - x0, y1 - y0))
          val a = atan2(y1 - y0, x1 - x0)
          val cx = (x0 + x1) / 2f; val cy = (y0 + y1) / 2f
          o.scale = (o0s * d / p0dist).coerceIn(0.015f, 1.6f)
          o.rot = o0r + (a - p0ang)
          o.u = o0u + (cx - p0cx) / max(1f, f.width())
          o.v = o0v + (cy - p0cy) / max(1f, f.height())
          host.objDragging(true, false)
        } else {
          val dx = e.x - downX
          val dy = e.y - downY
          if (!moved && hypot(dx, dy) > slop) moved = true
          if (moved) {
            o.u = o0u + dx / max(1f, f.width())
            o.v = o0v + dy / max(1f, f.height())
            host.objDragging(true, overTrash(e.x, e.y))
          }
        }
        invalidate()
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val idx = activeObj
        val wasMoved = moved
        val trash = e.actionMasked == MotionEvent.ACTION_UP && wasMoved && !pinching && overTrash(e.x, e.y)
        activeObj = -1
        moved = false
        pinching = false
        host.objDragging(false, false)
        if (idx in st.objs.indices) {
          if (trash) {
            st.objs.removeAt(idx)
            host.changed()
          } else if (!wasMoved) {
            host.cancelMutation()
            if (e.actionMasked == MotionEvent.ACTION_UP && SystemClock.uptimeMillis() - downAt < 350) host.objTapped(idx)
          } else {
            host.changed()
          }
        }
        invalidate()
      }
    }
    return true
  }

  private fun touchCrop(e: MotionEvent): Boolean {
    val f = fullRect
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        val r = editRectPx()
        val hit = 30f * density
        val x = e.x; val y = e.y
        cropHandle = when {
          hypot(x - r.left, y - r.top) < hit -> 1
          hypot(x - r.right, y - r.top) < hit -> 2
          hypot(x - r.right, y - r.bottom) < hit -> 3
          hypot(x - r.left, y - r.bottom) < hit -> 4
          abs(x - r.left) < hit * 0.8f && y in r.top..r.bottom -> 5
          abs(y - r.top) < hit * 0.8f && x in r.left..r.right -> 6
          abs(x - r.right) < hit * 0.8f && y in r.top..r.bottom -> 7
          abs(y - r.bottom) < hit * 0.8f && x in r.left..r.right -> 8
          r.contains(x, y) -> 9
          else -> 0
        }
        if (cropRatio > 0f && cropHandle in 5..8) cropHandle = 9
        crop0.set(editCrop)
        downX = x; downY = y
        parent?.requestDisallowInterceptTouchEvent(true)
        return cropHandle != 0
      }
      MotionEvent.ACTION_MOVE -> {
        if (cropHandle == 0) return true
        val du = (e.x - downX) / max(1f, f.width())
        val dv = (e.y - downY) / max(1f, f.height())
        val minU = 64f * density / max(1f, f.width())
        val minV = 64f * density / max(1f, f.height())
        val r = RectF(crop0)
        if (cropHandle == 9) {
          val w = r.width(); val h = r.height()
          val l = (r.left + du).coerceIn(0f, 1f - w)
          val t = (r.top + dv).coerceIn(0f, 1f - h)
          r.set(l, t, l + w, t + h)
        } else if (cropRatio > 0f) {
          // canto com proporção fixa: largura manda, altura segue
          val pxRatio = f.width() / max(1f, f.height()) // u→px / v→px
          val sign = if (cropHandle == 1 || cropHandle == 4) -1f else 1f
          var w = (crop0.width() + sign * du).coerceAtLeast(minU)
          var h = w * pxRatio / cropRatio
          val ax = if (cropHandle == 1 || cropHandle == 4) crop0.right else crop0.left
          val ay = if (cropHandle == 1 || cropHandle == 2) crop0.bottom else crop0.top
          val maxW = if (sign < 0) ax else 1f - ax
          val maxH = if (cropHandle == 1 || cropHandle == 2) ay else 1f - ay
          if (w > maxW) { w = maxW; h = w * pxRatio / cropRatio }
          if (h > maxH) { h = maxH; w = h * cropRatio / pxRatio }
          val l = if (sign < 0) ax - w else ax
          val t = if (cropHandle == 1 || cropHandle == 2) ay - h else ay
          r.set(l, t, l + w, t + h)
        } else {
          if (cropHandle == 1 || cropHandle == 4 || cropHandle == 5) r.left = (crop0.left + du).coerceIn(0f, crop0.right - minU)
          if (cropHandle == 2 || cropHandle == 3 || cropHandle == 7) r.right = (crop0.right + du).coerceIn(crop0.left + minU, 1f)
          if (cropHandle == 1 || cropHandle == 2 || cropHandle == 6) r.top = (crop0.top + dv).coerceIn(0f, crop0.bottom - minV)
          if (cropHandle == 3 || cropHandle == 4 || cropHandle == 8) r.bottom = (crop0.bottom + dv).coerceIn(crop0.top + minV, 1f)
        }
        editCrop.set(r)
        invalidate()
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        cropHandle = 0
        host.changed()
      }
    }
    return true
  }
}
