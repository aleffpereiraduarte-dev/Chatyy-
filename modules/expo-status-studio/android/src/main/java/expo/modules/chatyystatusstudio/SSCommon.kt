package expo.modules.chatyystatusstudio

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.View
import androidx.core.graphics.PathParser

// [2026-10-15 native-status-studio] Estúdio de status nativo (Android).
// Contrato: modules/expo-status-studio/index.ts (mesmo JSON do estúdio JS e dos viewers).

class SSFilter(val id: String, val label: String, val m: FloatArray?) {
  /** Matriz 4x5 do Android (translação ×255). null = identidade. */
  fun androidMatrix(): FloatArray? {
    val src = m ?: return null
    if (src.size != 20) return null
    val out = src.copyOf()
    out[4] *= 255f; out[9] *= 255f; out[14] *= 255f; out[19] *= 255f
    return out
  }
}

class SSBackground(val value: String, val colors: IntArray)

class SSFont(val id: String, val label: String)

class SSTrack(
  val id: String,
  val title: String,
  val artist: String,
  val previewUrl: String,
  val coverUrl: String,
  val durationSec: Double,
  val startMs: Long = 0,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "title" to title, "artist" to artist, "previewUrl" to previewUrl, "coverUrl" to coverUrl, "startMs" to startMs,
  )
}

class SSContact(val email: String, val name: String)

class SSMediaIn(val uri: String, val isVideo: Boolean, val width: Int, val height: Int, val filter: String?, val boomerang: Boolean)

class SSOptions(
  val textMode: Boolean,
  val items: List<SSMediaIn>,
  val labels: Map<String, String>,
  val filters: List<SSFilter>,
  val backgrounds: List<SSBackground>,
  val bgIndex: Int,
  val fonts: List<SSFont>,
  val textMax: Int,
  val palette: IntArray,
  val paletteHex: List<String>,
  val emojis: List<String>,
  val contacts: List<SSContact>,
  val catalog: List<SSTrack>,
  val music: SSTrack?,
  val audience: String,
  val closeFriendsCount: Int,
  val exceptCount: Int,
  val canCamera: Boolean,
  val canGallery: Boolean,
) {
  fun t(key: String, fallback: String): String = labels[key]?.takeIf { it.isNotEmpty() } ?: fallback
}

object SSUtil {
  fun parseColor(s: String?, def: Int): Int {
    if (s.isNullOrBlank()) return def
    var h = s.trim()
    if (h.startsWith("#")) h = h.substring(1)
    return try {
      when (h.length) {
        3 -> { val r = h[0].toString().repeat(2); val g = h[1].toString().repeat(2); val b = h[2].toString().repeat(2); Color.rgb(r.toInt(16), g.toInt(16), b.toInt(16)) }
        6 -> Color.rgb(h.substring(0, 2).toInt(16), h.substring(2, 4).toInt(16), h.substring(4, 6).toInt(16))
        8 -> Color.argb(h.substring(6, 8).toInt(16), h.substring(0, 2).toInt(16), h.substring(2, 4).toInt(16), h.substring(4, 6).toInt(16))
        else -> def
      }
    } catch (_: Throwable) { def }
  }

  fun hex(c: Int): String = String.format("#%02X%02X%02X", Color.red(c), Color.green(c), Color.blue(c))

  /** Mesmo limiar do contrastOn() do StatusStudio.js (luma 0.299/0.587/0.114 > 160). */
  fun contrastOn(c: Int): Int {
    val l = 0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)
    return if (l > 160) Color.BLACK else Color.WHITE
  }

  /** Fontes do viewer Android (StoryGroupPage.typefaceFor). */
  fun typeface(id: String): Typeface = when (id) {
    "serif" -> Typeface.create(Typeface.SERIF, Typeface.BOLD)
    "mono" -> Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
    "script" -> Typeface.create("cursive", Typeface.BOLD)
    "condensed" -> Typeface.create("sans-serif-condensed", Typeface.BOLD)
    else -> Typeface.DEFAULT_BOLD
  }

  fun round(color: Int, radiusPx: Float, strokeColor: Int? = null, strokePx: Int = 1): GradientDrawable =
    GradientDrawable().apply {
      cornerRadius = radiusPx
      setColor(color)
      if (strokeColor != null) setStroke(strokePx, strokeColor)
    }

  fun bgDrawable(bg: SSBackground?): GradientDrawable {
    val cols = bg?.colors ?: intArrayOf(Color.rgb(17, 17, 17))
    return if (cols.size >= 2) GradientDrawable(GradientDrawable.Orientation.TL_BR, cols)
    else GradientDrawable().apply { setColor(cols.firstOrNull() ?: Color.rgb(17, 17, 17)) }
  }

  fun newId(): String = "${System.currentTimeMillis()}${(Math.random() * 46656).toInt().toString(36)}"
}

/** Ícones vetoriais (traço lucide/Feather, viewBox 24) — nunca emoji na UI. */
object SSIcons {
  private fun line(x1: Float, y1: Float, x2: Float, y2: Float) = "M$x1 ${y1}L$x2 $y2"
  private fun circle(cx: Float, cy: Float, r: Float) = "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 ${-2 * r} 0"

  val paths: Map<String, String> = mapOf(
    "close" to line(18f, 6f, 6f, 18f) + line(6f, 6f, 18f, 18f),
    "undo" to "M3 7v6h6M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13",
    "text" to "M4 7L4 4L20 4L20 7" + line(9f, 20f, 15f, 20f) + line(12f, 4f, 12f, 20f),
    "sticker" to circle(12f, 12f, 10f) + "M8 14s1.5 2 4 2 4-2 4-2" + line(9f, 9f, 9.01f, 9f) + line(15f, 9f, 15.01f, 9f),
    "draw" to "M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z",
    "filter" to circle(12f, 9f, 5.5f) + circle(8.5f, 15f, 5.5f) + circle(15.5f, 15f, 5.5f),
    "music" to "M9 18V5l12-2v13" + circle(6f, 18f, 3f) + circle(18f, 16f, 3f),
    "image" to "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" + circle(8.5f, 8.5f, 1.5f) + "M21 15L16 10L5 21",
    "camera" to "M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" + circle(12f, 13f, 4f),
    "trash" to "M3 6L5 6L21 6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
    "check" to "M20 6L9 17L4 12",
    "send" to line(22f, 2f, 11f, 13f) + "M22 2L15 22L11 13L2 9L22 2z",
    "chevronDown" to "M6 9l6 6 6-6",
    "globe" to circle(12f, 12f, 10f) + line(2f, 12f, 22f, 12f) + "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
    "users" to "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" + circle(9f, 7f, 4f) + "M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    "star" to "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
    "eyeOff" to "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" + line(1f, 1f, 23f, 23f),
    "alignLeft" to line(17f, 10f, 3f, 10f) + line(21f, 6f, 3f, 6f) + line(21f, 14f, 3f, 14f) + line(17f, 18f, 3f, 18f),
    "alignCenter" to line(18f, 10f, 6f, 10f) + line(21f, 6f, 3f, 6f) + line(21f, 14f, 3f, 14f) + line(18f, 18f, 6f, 18f),
    "alignRight" to line(21f, 10f, 7f, 10f) + line(21f, 6f, 3f, 6f) + line(21f, 14f, 3f, 14f) + line(21f, 18f, 7f, 18f),
    "textBg" to "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" + "M8 15L12 8L16 15M9.5 12.5L14.5 12.5",
    "palette" to circle(13.5f, 6.5f, 0.5f) + circle(17.5f, 10.5f, 0.5f) + circle(8.5f, 7.5f, 0.5f) + circle(6.5f, 12.5f, 0.5f) +
      "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z",
    "at" to circle(12f, 12f, 4f) + "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94",
    "pin" to "M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" + circle(12f, 10f, 3f),
    "link" to "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    "poll" to line(18f, 20f, 18f, 10f) + line(12f, 20f, 12f, 4f) + line(6f, 20f, 6f, 14f),
    "question" to circle(12f, 12f, 10f) + "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" + line(12f, 17f, 12.01f, 17f),
    "clock" to circle(12f, 12f, 10f) + "M12 6L12 12L16 14",
    "pen" to "M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.586 7.586" + circle(11f, 11f, 2f),
    "marker" to "M9 11l-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4",
    "neon" to "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
    "eraser" to "M20 20H7L3 16a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4L13 19M9 10l6 6",
    "plus" to line(12f, 5f, 12f, 19f) + line(5f, 12f, 19f, 12f),
    "search" to circle(11f, 11f, 8f) + line(21f, 21f, 16.65f, 16.65f),
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

class SSIconView(ctx: Context, name: String, private val sizeDp: Float = 22f) : View(ctx) {
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
    val p = SSIcons.path(icon) ?: return
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
