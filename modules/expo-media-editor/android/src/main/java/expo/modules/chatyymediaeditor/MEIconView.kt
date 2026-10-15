package expo.modules.chatyymediaeditor

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.view.View
import androidx.core.graphics.PathParser

/**
 * [2026-10-15 native-editor] Ícones vetoriais (mesmos traços Feather/lucide do
 * components/Icons.js, viewBox 24, traço 2). Regra do app: nunca emoji na UI.
 */
object MEIcons {
  private fun line(x1: Float, y1: Float, x2: Float, y2: Float) = "M${x1} ${y1}L${x2} ${y2}"
  private fun circle(cx: Float, cy: Float, r: Float) =
    "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 ${-2 * r} 0"

  val paths: Map<String, String> = mapOf(
    "close" to line(18f, 6f, 6f, 18f) + line(6f, 6f, 18f, 18f),
    "undo" to "M1 4L1 10L7 10M3.51 15a9 9 0 1 0 2.13-9.36L1 10",
    "crop" to "M6.13 1L6 16a2 2 0 0 0 2 2h15M1 6.13L16 6a2 2 0 0 1 2 2v15",
    "draw" to "M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z",
    "text" to "M4 7L4 4L20 4L20 7" + line(9f, 20f, 15f, 20f) + line(12f, 4f, 12f, 20f),
    "sticker" to circle(12f, 12f, 10f) + "M8 14s1.5 2 4 2 4-2 4-2" + line(9f, 9f, 9.01f, 9f) + line(15f, 9f, 15.01f, 9f),
    "filter" to circle(12f, 9f, 5.5f) + circle(8.5f, 15f, 5.5f) + circle(15.5f, 15f, 5.5f),
    "rotate" to "M23 4L23 10L17 10M20.49 15a9 9 0 1 1-2.12-9.36L23 10",
    "send" to line(22f, 2f, 11f, 13f) + "M22 2L15 22L11 13L2 9L22 2z",
    "check" to "M20 6L9 17L4 12",
    "soundOn" to "M11 5L6 9L2 9L2 15L6 15L11 19L11 5zM19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07",
    "soundOff" to "M11 5L6 9L2 9L2 15L6 15L11 19L11 5z" + line(23f, 9f, 17f, 15f) + line(17f, 9f, 23f, 15f),
    "trash" to "M3 6L5 6L21 6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
    "cover" to "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" + circle(8.5f, 8.5f, 1.5f) + "M21 15L16 10L5 21",
    "font" to "M4 20L10 4L16 20M6.5 14L13.5 14M17 20L17 13M20.5 16.5a3.5 3.5 0 1 1-7 0a3.5 3.5 0 1 1 7 0",
    "bg" to "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" + "M8 15L12 8L16 15M9.5 12.5L14.5 12.5",
    "flip" to "M12 3L12 21M8 7L3 12L8 17L8 7zM16 7L21 12L16 17L16 7z",
  )

  private val cache = HashMap<String, Path?>()

  fun path(name: String): Path? {
    if (cache.containsKey(name)) return cache[name]
    val d = paths[name]
    val p = try { if (d != null) PathParser.createPathFromPathData(d) else null } catch (_: Throwable) { null }
    cache[name] = p
    return p
  }
}

class MEIconView(ctx: Context, name: String, private val sizeDp: Float = 22f) : View(ctx) {
  var icon: String = name
    set(v) { field = v; invalidate() }
  var color: Int = Color.WHITE
    set(v) { field = v; invalidate() }
  var filled: Boolean = false
    set(v) { field = v; invalidate() }

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val m = Matrix()
  private val tmp = Path()

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val p = MEIcons.path(icon) ?: return
    val px = sizeDp * resources.displayMetrics.density
    val s = px / 24f
    m.reset()
    m.setScale(s, s)
    m.postTranslate((width - px) / 2f, (height - px) / 2f)
    tmp.reset()
    p.transform(m, tmp)
    paint.color = color
    paint.strokeWidth = 2f * s
    paint.style = if (filled) Paint.Style.FILL_AND_STROKE else Paint.Style.STROKE
    canvas.drawPath(tmp, paint)
  }
}
