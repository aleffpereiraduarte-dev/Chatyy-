package expo.modules.chatyymediaeditor

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * [2026-10-15 native-editor] Trilho de corte do vídeo (estilo WhatsApp/
 * Telegram): miniaturas de quadros, alças laterais brancas, fora do corte
 * escurecido, cursor de reprodução. Em modo capa, arrastar escolhe o quadro.
 */
@SuppressLint("ViewConstructor")
class TrimRailView(ctx: Context, private val listener: Listener) : View(ctx) {

  interface Listener {
    fun rangeChanging(startMs: Long, endMs: Long, editingStart: Boolean)
    fun rangeChanged(startMs: Long, endMs: Long)
    fun coverChanging(ms: Long)
    fun coverChanged(ms: Long)
    fun seek(ms: Long)
  }

  var durationMs = 0L
  var startMs = 0L
  var endMs = 0L
  var playheadMs = -1L
    set(v) { field = v; invalidate() }
  var coverMs = -1L
  var coverMode = false
    set(v) { field = v; invalidate() }
  var minRangeMs = 1000L
  val thumbs = ArrayList<Bitmap?>()

  private val d = resources.displayMetrics.density
  private val handleW = 14f * d
  private val thumbPaint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val placeholder = Paint().apply { color = Color.rgb(34, 34, 34) }
  private val dim = Paint().apply { color = Color.argb(165, 0, 0, 0) }
  private val white = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
  private val grip = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; strokeWidth = 2f * d; strokeCap = Paint.Cap.ROUND }
  private val frame = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.STROKE }
  private var dragging = 0 // 1 início · 2 fim · 3 capa

  private fun trackLeft() = handleW
  private fun trackRight() = width - handleW
  private fun trackW() = max(1f, trackRight() - trackLeft())
  private fun xOf(ms: Long): Float = trackLeft() + trackW() * (if (durationMs > 0) ms.toFloat() / durationMs else 0f)
  private fun msOf(x: Float): Long = if (durationMs <= 0) 0 else (((x - trackLeft()) / trackW()).coerceIn(0f, 1f) * durationMs).toLong()

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val top = 4f * d
    val bottom = height - 4f * d
    val l = trackLeft()
    val r = trackRight()
    val tw = trackW()
    val th = bottom - top
    // miniaturas
    val n = max(1, thumbs.size)
    val cell = tw / n
    canvas.save()
    canvas.clipRect(RectF(l, top, r, bottom))
    for (i in 0 until n) {
      val dst = RectF(l + i * cell, top, l + (i + 1) * cell + 1, bottom)
      val b = thumbs.getOrNull(i)
      if (b != null && !b.isRecycled) {
        // center-crop
        val sr = b.width.toFloat() / b.height
        val dr = dst.width() / dst.height()
        val src = if (sr > dr) {
          val w = b.height * dr
          android.graphics.Rect(((b.width - w) / 2).toInt(), 0, ((b.width + w) / 2).toInt(), b.height)
        } else {
          val h = b.width / dr
          android.graphics.Rect(0, ((b.height - h) / 2).toInt(), b.width, ((b.height + h) / 2).toInt())
        }
        canvas.drawBitmap(b, src, dst, thumbPaint)
      } else {
        canvas.drawRect(dst, placeholder)
      }
    }
    canvas.restore()

    if (coverMode) {
      val cx = xOf(max(0L, coverMs))
      frame.strokeWidth = 2.5f * d
      val half = min(th * 0.42f, 22f * d)
      canvas.drawRoundRect(RectF(cx - half, top - 2f * d, cx + half, bottom + 2f * d), 6f * d, 6f * d, frame)
      return
    }

    val sx = xOf(startMs)
    val ex = xOf(endMs)
    canvas.drawRect(l, top, sx, bottom, dim)
    canvas.drawRect(ex, top, r, bottom, dim)
    // moldura: barras superior/inferior + alças
    val bar = 2.5f * d
    canvas.drawRect(sx, top - bar / 2, ex, top + bar / 2, white)
    canvas.drawRect(sx, bottom - bar / 2, ex, bottom + bar / 2, white)
    val rad = 5f * d
    val lh = RectF(sx - handleW, top - bar / 2, sx, bottom + bar / 2)
    val rh = RectF(ex, top - bar / 2, ex + handleW, bottom + bar / 2)
    val pl = Path().apply { addRoundRect(lh, floatArrayOf(rad, rad, 0f, 0f, 0f, 0f, rad, rad), Path.Direction.CW) }
    val pr = Path().apply { addRoundRect(rh, floatArrayOf(0f, 0f, rad, rad, rad, rad, 0f, 0f), Path.Direction.CW) }
    canvas.drawPath(pl, white)
    canvas.drawPath(pr, white)
    val gh = th * 0.18f
    canvas.drawLine(lh.centerX(), lh.centerY() - gh, lh.centerX(), lh.centerY() + gh, grip)
    canvas.drawLine(rh.centerX(), rh.centerY() - gh, rh.centerX(), rh.centerY() + gh, grip)
    if (playheadMs in startMs..endMs) {
      val px = xOf(playheadMs)
      canvas.drawRoundRect(RectF(px - 1.5f * d, top, px + 1.5f * d, bottom), 1.5f * d, 1.5f * d, white)
    }
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(e: MotionEvent): Boolean {
    if (durationMs <= 0) return false
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        parent?.requestDisallowInterceptTouchEvent(true)
        if (coverMode) {
          dragging = 3
          coverMs = msOf(e.x)
          listener.coverChanging(coverMs)
          invalidate()
          return true
        }
        val sx = xOf(startMs)
        val ex = xOf(endMs)
        val ds = abs(e.x - (sx - handleW / 2))
        val de = abs(e.x - (ex + handleW / 2))
        val hit = 28f * d
        dragging = when {
          ds < hit && ds <= de -> 1
          de < hit -> 2
          else -> 0
        }
        if (dragging == 0) {
          // toque no meio: só move o cursor
          val ms = msOf(e.x).coerceIn(startMs, endMs)
          playheadMs = ms
          listener.seek(ms)
          return true
        }
      }
      MotionEvent.ACTION_MOVE -> {
        when (dragging) {
          1 -> {
            val x = e.x + handleW / 2
            startMs = msOf(x).coerceIn(0L, max(0L, endMs - minRangeMs))
            listener.rangeChanging(startMs, endMs, true)
          }
          2 -> {
            val x = e.x - handleW / 2
            endMs = msOf(x).coerceIn(min(durationMs, startMs + minRangeMs), durationMs)
            listener.rangeChanging(startMs, endMs, false)
          }
          3 -> {
            coverMs = msOf(e.x)
            listener.coverChanging(coverMs)
          }
        }
        invalidate()
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        when (dragging) {
          1, 2 -> listener.rangeChanged(startMs, endMs)
          3 -> listener.coverChanged(coverMs)
        }
        dragging = 0
        invalidate()
      }
    }
    return true
  }
}
