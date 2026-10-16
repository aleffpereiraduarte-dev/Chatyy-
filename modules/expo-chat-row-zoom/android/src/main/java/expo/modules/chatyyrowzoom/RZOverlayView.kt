package expo.modules.chatyyrowzoom

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * [wave8 row-zoom] Overlay da transição linha → conversa.
 * Desenha a lista (bitmap do PixelCopy) com parallax −30 % e escurecida FORA de
 * um buraco arredondado que cresce do retângulo da linha até a tela; dentro do
 * buraco aparece a conversa REAL (viva, por baixo). O recorte da linha
 * acompanha o buraco e some nos primeiros 35 %. Mola ζ 0.86 ~420 ms.
 */
@SuppressLint("ViewConstructor")
@TargetApi(26)
class RZOverlayView(
  ctx: Context,
  private val bmp: Bitmap,
  private val from: RectF,
  private val bgColor: Int,
  private val radiusPx: Float,
  private val dimMax: Float
) : View(ctx) {

  var progress = 0f

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val path = Path()
  private val hole = RectF()
  private val dst = RectF()
  private val src = Rect(
    max(0, from.left.toInt()),
    max(0, from.top.toInt()),
    min(bmp.width, from.right.toInt()),
    min(bmp.height, from.bottom.toInt())
  )

  init {
    isClickable = true
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean = true // engole toques durante a transição

  private fun lerp(a: Float, b: Float, p: Float) = a + (b - a) * p

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    val q = progress.coerceIn(0f, 1f)
    hole.set(lerp(from.left, 0f, q), lerp(from.top, 0f, q), lerp(from.right, w, q), lerp(from.bottom, h, q))
    val r = radiusPx * (1f - q)
    path.reset()
    path.addRoundRect(hole, r, r, Path.Direction.CW)

    canvas.save()
    canvas.clipOutPath(path)
    canvas.drawColor(bgColor)
    canvas.save()
    canvas.translate(-0.3f * w * q, 0f)
    paint.alpha = 255
    canvas.drawBitmap(bmp, 0f, 0f, paint)
    canvas.restore()
    val da = (dimMax * q * 255f).toInt().coerceIn(0, 255)
    if (da > 0) canvas.drawColor(Color.argb(da, 0, 0, 0))
    canvas.restore()

    val ra = (1f - q / 0.35f).coerceIn(0f, 1f)
    if (ra > 0f && src.width() > 0 && src.height() > 0) {
      val s = hole.width() / max(1f, from.width())
      dst.set(hole.left, hole.top, hole.right, hole.top + from.height() * s)
      paint.alpha = (ra * 255f).toInt()
      canvas.save()
      canvas.clipPath(path)
      canvas.drawBitmap(bmp, src, dst, paint)
      canvas.restore()
      paint.alpha = 255
    }
  }

  companion object {
    private val main = Handler(Looper.getMainLooper())
    private var cur: RZOverlayView? = null
    private var anim: ValueAnimator? = null
    private var started = false
    private var endCb: ((Boolean) -> Unit)? = null
    private var gen = 0

    private const val DURATION_MS = 420L
    private const val ZETA = 0.86
    private const val RESPONSE_S = 0.42

    private fun num(v: Any?): Float = when (v) {
      is Number -> v.toFloat()
      is String -> v.toFloatOrNull() ?: Float.NaN
      else -> Float.NaN
    }

    private fun spring(t: Double): Float {
      val omega = 2.0 * Math.PI / RESPONSE_S
      val wd = omega * sqrt(1.0 - ZETA * ZETA)
      val e = exp(-ZETA * omega * t)
      return (1.0 - e * (cos(wd * t) + (ZETA * omega / wd) * sin(wd * t))).toFloat()
    }

    private fun animationsOff(a: Activity): Boolean = try {
      Settings.Global.getFloat(a.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    } catch (_: Throwable) { false }

    fun begin(activity: Activity?, o: Map<String, Any?>, resolve: (Boolean) -> Unit, onEnd: (Boolean) -> Unit) {
      teardown(false)
      if (activity == null || Build.VERSION.SDK_INT < 26 || activity.isFinishing || animationsOff(activity)) {
        resolve(false); return
      }
      val window = activity.window
      val decor = window?.decorView as? ViewGroup
      if (window == null || decor == null || decor.width <= 0 || decor.height <= 0) { resolve(false); return }
      val x = num(o["x"]); val y = num(o["y"]); val w = num(o["w"]); val h = num(o["h"])
      val dens = activity.resources.displayMetrics.density
      if (!x.isFinite() || !y.isFinite() || !w.isFinite() || !h.isFinite() ||
        w < 40f * dens || h < 24f * dens || h > decor.height * 0.5f) { resolve(false); return }
      val r = RectF(x, y, x + w, y + h)
      val visTop = max(r.top, 0f); val visBot = min(r.bottom, decor.height.toFloat())
      if (visBot - visTop < h * 0.5f) { resolve(false); return }
      val dark = o["dark"] == true
      val rad = num(o["radius"]).let { if (it.isFinite()) it.coerceIn(0f, 24f) else 10f } * dens
      val dim = num(o["dim"]).let { if (it.isFinite()) it.coerceIn(0f, 0.6f) else if (dark) 0.4f else 0.28f }
      val waitMs = num(o["maxWait"]).let { if (it.isFinite()) it.coerceIn(30f, 400f).toLong() else 220L }

      val bmp = try {
        Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
      } catch (_: Throwable) { null }
      if (bmp == null) { resolve(false); return }
      val g = ++gen
      try {
        PixelCopy.request(window, bmp, { res ->
          if (g != gen || res != PixelCopy.SUCCESS || activity.isFinishing || decor.width <= 0) {
            resolve(false)
          } else {
            try {
              val v = RZOverlayView(activity, bmp, r, if (dark) Color.BLACK else Color.WHITE, rad, dim)
              decor.addView(v, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
              cur = v
              started = false
              endCb = onEnd
              main.postDelayed({ if (g == gen) go() }, waitMs)
              // teto absoluto: nunca deixa o overlay preso na tela
              main.postDelayed({ if (g == gen && cur != null) teardown(true) }, 2000L)
              resolve(true)
            } catch (_: Throwable) {
              teardown(false)
              resolve(false)
            }
          }
        }, main)
      } catch (_: Throwable) {
        resolve(false)
      }
    }

    fun ready() {
      if (cur == null || started) return
      go()
    }

    private fun go() {
      val v = cur ?: return
      if (started) return
      started = true
      val g = gen
      val a = ValueAnimator.ofFloat(0f, 1f)
      a.duration = DURATION_MS
      a.interpolator = TimeInterpolator { f -> spring(f.toDouble() * RESPONSE_S) }
      a.addUpdateListener { va ->
        v.progress = va.animatedValue as Float
        v.invalidate()
      }
      a.addListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) {
          if (g == gen && cur === v) {
            v.progress = 1f
            teardown(true)
          }
        }
      })
      anim = a
      a.start()
    }

    fun cancel() {
      val v = cur ?: return
      val cb = endCb
      endCb = null
      gen++
      try { anim?.cancel() } catch (_: Throwable) {}
      anim = null
      cur = null
      started = false
      try {
        v.animate().alpha(0f).setDuration(140L).withEndAction {
          try { (v.parent as? ViewGroup)?.removeView(v) } catch (_: Throwable) {}
        }.start()
      } catch (_: Throwable) {
        try { (v.parent as? ViewGroup)?.removeView(v) } catch (_: Throwable) {}
      }
      try { cb?.invoke(false) } catch (_: Throwable) {}
    }

    private fun teardown(notify: Boolean) {
      val v = cur
      val cb = endCb
      endCb = null
      cur = null
      started = false
      val a = anim
      anim = null
      gen++
      try { a?.cancel() } catch (_: Throwable) {}
      // bitmap NÃO é reciclado à mão (o RenderThread pode ainda referenciar o
      // último frame) — o GC solta quando a view sai.
      try { (v?.parent as? ViewGroup)?.removeView(v) } catch (_: Throwable) {}
      if (notify && v != null) { try { cb?.invoke(true) } catch (_: Throwable) {} }
    }
  }
}
