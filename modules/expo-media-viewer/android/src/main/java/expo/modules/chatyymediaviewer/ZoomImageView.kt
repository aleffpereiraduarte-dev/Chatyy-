package expo.modules.chatyymediaviewer

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Matrix
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.ViewConfiguration
import android.view.animation.DecelerateInterpolator
import android.widget.ImageView
import android.widget.OverScroller
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * [2026-10-14 native-viewer] ImageView com zoom por Matrix (sem PhotoView):
 * pinça 1…4×, duplo toque amplia no ponto (2.5×) / volta a 1×, arrasto com
 * fling quando ampliada. Na borda da foto ampliada libera o ViewPager2
 * (requestDisallowInterceptTouchEvent(false)) — comportamento do Google Fotos.
 * Em 1× não segura o toque: o pager pagina e o MVPageView detecta o arrasto
 * vertical de fechar.
 */
class ZoomImageView(context: Context) : ImageView(context) {

  var maxScale = 4f
  var onSingleTap: (() -> Unit)? = null
  var onZoomChanged: ((Boolean) -> Unit)? = null

  private val baseMatrix = Matrix()
  private val suppMatrix = Matrix()
  private val drawMatrix = Matrix()
  private val values = FloatArray(9)
  private val rect = RectF()
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private val scroller = OverScroller(context)
  private var animator: ValueAnimator? = null
  private var lastX = 0f
  private var lastY = 0f
  private var downX = 0f
  private var downY = 0f
  private var panning = false
  private var wasZoomed = false

  private val flingRunnable = object : Runnable {
    private var lastFx = 0
    private var lastFy = 0
    fun start(vx: Int, vy: Int) {
      val r = displayRect() ?: return
      val w = viewW()
      val h = viewH()
      val startX = (-r.left).roundToInt()
      val startY = (-r.top).roundToInt()
      val maxX = max(0, (r.width() - w).roundToInt())
      val maxY = max(0, (r.height() - h).roundToInt())
      lastFx = startX
      lastFy = startY
      if (maxX == 0 && maxY == 0) return
      scroller.fling(startX, startY, -vx, -vy, 0, maxX, 0, maxY)
      postOnAnimation(this)
    }

    override fun run() {
      if (scroller.isFinished) return
      if (scroller.computeScrollOffset()) {
        val nx = scroller.currX
        val ny = scroller.currY
        suppMatrix.postTranslate((lastFx - nx).toFloat(), (lastFy - ny).toFloat())
        lastFx = nx
        lastFy = ny
        checkBounds()
        applyMatrix()
        postOnAnimation(this)
      }
    }
  }

  private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
    override fun onScale(detector: ScaleGestureDetector): Boolean {
      if (drawable == null) return false
      val cur = currentScale()
      var f = detector.scaleFactor
      if (!f.isFinite() || f <= 0f) return false
      val target = cur * f
      // Deixa passar um pouco do limite (elástico) — volta no fim.
      if (target > maxScale * 1.25f) f = (maxScale * 1.25f) / cur
      if (target < 0.7f) f = 0.7f / cur
      suppMatrix.postScale(f, f, detector.focusX, detector.focusY)
      checkBounds()
      applyMatrix()
      return true
    }

    override fun onScaleEnd(detector: ScaleGestureDetector) {
      val cur = currentScale()
      if (cur < 1f) animateZoom(1f, viewW() / 2f, viewH() / 2f)
      else if (cur > maxScale) animateZoom(maxScale, detector.focusX, detector.focusY)
    }
  })

  private val gestureDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(e: MotionEvent): Boolean = true

    override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
      onSingleTap?.invoke()
      return true
    }

    override fun onDoubleTap(e: MotionEvent): Boolean {
      if (drawable == null) return true
      if (isZoomed()) animateZoom(1f, e.x, e.y) else animateZoom(2.5f, e.x, e.y)
      return true
    }

    override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
      if (!isZoomed() || scaleDetector.isInProgress) return false
      flingRunnable.start(velocityX.roundToInt(), velocityY.roundToInt())
      return true
    }
  })

  // false enquanto o construtor do ImageView roda (campos ainda nulos).
  private var ready = false

  init {
    scaleType = ScaleType.MATRIX
    isClickable = true
    ready = true
  }

  fun isZoomed(): Boolean = currentScale() > 1.01f

  fun resetZoom() {
    animator?.cancel()
    scroller.forceFinished(true)
    suppMatrix.reset()
    applyMatrix()
  }

  override fun setImageDrawable(drawable: Drawable?) {
    super.setImageDrawable(drawable)
    if (!ready) return
    // Troca miniatura → foto grande: base recalculada pelo tamanho novo; o
    // zoom/pan do usuário (suppMatrix, em coordenadas da view) é mantido.
    updateBaseMatrix()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (!ready) return
    suppMatrix.reset()
    updateBaseMatrix()
  }

  private fun viewW(): Float = (width - paddingLeft - paddingRight).toFloat()
  private fun viewH(): Float = (height - paddingTop - paddingBottom).toFloat()

  private fun updateBaseMatrix() {
    val d = drawable ?: run { applyMatrix(); return }
    val vw = viewW()
    val vh = viewH()
    val dw = d.intrinsicWidth.toFloat()
    val dh = d.intrinsicHeight.toFloat()
    baseMatrix.reset()
    if (vw > 0 && vh > 0 && dw > 0 && dh > 0) {
      val s = min(vw / dw, vh / dh)
      baseMatrix.postScale(s, s)
      baseMatrix.postTranslate((vw - dw * s) / 2f, (vh - dh * s) / 2f)
    }
    checkBounds()
    applyMatrix()
  }

  private fun currentScale(): Float {
    suppMatrix.getValues(values)
    return values[Matrix.MSCALE_X]
  }

  private fun displayRect(): RectF? {
    val d = drawable ?: return null
    if (d.intrinsicWidth <= 0 || d.intrinsicHeight <= 0) return null
    drawMatrix.set(baseMatrix)
    drawMatrix.postConcat(suppMatrix)
    rect.set(0f, 0f, d.intrinsicWidth.toFloat(), d.intrinsicHeight.toFloat())
    drawMatrix.mapRect(rect)
    return rect
  }

  private fun checkBounds() {
    val r = displayRect() ?: return
    val w = viewW()
    val h = viewH()
    var dx = 0f
    var dy = 0f
    if (r.height() <= h) {
      dy = (h - r.height()) / 2f - r.top
    } else if (r.top > 0) {
      dy = -r.top
    } else if (r.bottom < h) {
      dy = h - r.bottom
    }
    if (r.width() <= w) {
      dx = (w - r.width()) / 2f - r.left
    } else if (r.left > 0) {
      dx = -r.left
    } else if (r.right < w) {
      dx = w - r.right
    }
    if (dx != 0f || dy != 0f) suppMatrix.postTranslate(dx, dy)
  }

  private fun applyMatrix() {
    drawMatrix.set(baseMatrix)
    drawMatrix.postConcat(suppMatrix)
    imageMatrix = drawMatrix
    val z = isZoomed()
    if (z != wasZoomed) {
      wasZoomed = z
      onZoomChanged?.invoke(z)
    }
  }

  private fun animateZoom(target: Float, fx: Float, fy: Float) {
    animator?.cancel()
    scroller.forceFinished(true)
    val start = currentScale()
    if (abs(start - target) < 0.001f) return
    val a = ValueAnimator.ofFloat(start, target)
    a.duration = 220
    a.interpolator = DecelerateInterpolator()
    a.addUpdateListener { va ->
      val s = va.animatedValue as Float
      val cur = currentScale()
      if (cur > 0f) {
        val f = s / cur
        suppMatrix.postScale(f, f, fx, fy)
        checkBounds()
        applyMatrix()
      }
    }
    animator = a
    a.start()
  }

  /** Foto ampliada encostada na borda na direção do arrasto → o pager pode assumir. */
  private fun atEdge(dx: Float): Boolean {
    val r = displayRect() ?: return true
    val w = viewW()
    if (r.width() <= w + 1f) return true
    return (dx > 0 && r.left >= -1f) || (dx < 0 && r.right <= w + 1f)
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    scaleDetector.onTouchEvent(ev)
    gestureDetector.onTouchEvent(ev)
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        animator?.cancel()
        scroller.forceFinished(true)
        lastX = ev.x
        lastY = ev.y
        downX = ev.x
        downY = ev.y
        panning = false
        // Ampliada: o toque é da foto (até chegar na borda).
        parent?.requestDisallowInterceptTouchEvent(isZoomed())
      }
      MotionEvent.ACTION_POINTER_DOWN -> {
        parent?.requestDisallowInterceptTouchEvent(true)
      }
      MotionEvent.ACTION_MOVE -> {
        if (!scaleDetector.isInProgress && ev.pointerCount == 1 && isZoomed()) {
          val dx = ev.x - lastX
          val dy = ev.y - lastY
          if (!panning && (abs(ev.x - downX) > touchSlop || abs(ev.y - downY) > touchSlop)) panning = true
          if (panning) {
            if (abs(dx) > abs(dy) && atEdge(dx)) {
              parent?.requestDisallowInterceptTouchEvent(false)
            } else {
              parent?.requestDisallowInterceptTouchEvent(true)
            }
            suppMatrix.postTranslate(dx, dy)
            checkBounds()
            applyMatrix()
          }
        }
        lastX = ev.x
        lastY = ev.y
      }
      MotionEvent.ACTION_POINTER_UP -> {
        // Continua o arrasto com o dedo que ficou, sem pulo.
        val upIdx = ev.actionIndex
        val keep = if (upIdx == 0) 1 else 0
        if (keep < ev.pointerCount) {
          lastX = ev.getX(keep)
          lastY = ev.getY(keep)
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        panning = false
        if (currentScale() < 1f && !scaleDetector.isInProgress) animateZoom(1f, viewW() / 2f, viewH() / 2f)
      }
    }
    return true
  }
}
