package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] COMUNIDADES em nativo (Android) — modelos.
// Mesmo contrato do iOS (ios/CMModels.swift). JS:
// components/communities/communityRows.js (linhas planas) →
// NativeCommunityList.js / NativeCommunityDetail.js.
// Regra do projeto: try só em forma de statement (nunca try-expressão).

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import androidx.core.graphics.PathParser

internal data class CMRow(
  val id: String = "",
  val kind: String = "row",       // card | group | row | text | loading | actions
  val seg: String = "",           // "" | one | top | mid | bot
  val cs: String = "c",           // c (cartão c/ borda) | b (caixa) | d (tracejado)
  val mt: Float = 0f,
  val mb: Float = 0f,
  val pb: Float = 0f,
  val px: Float = 14f,
  val hx: Float = 12f,
  val title: String = "",
  val sub: String = "",
  val body: String = "",
  val ts: String = "body",
  val tag: String = "",
  val tagBg: String = "",
  val tagFg: String = "",
  val rtag: String = "",
  val rtagBg: String = "",
  val rtagFg: String = "",
  val url: String = "",
  val auth: Boolean = false,
  val initial: String = "",
  val expanded: Boolean = false,
  val chevron: Boolean = false,
  val remove: Boolean = false,
  val div: Boolean = false,
  val center: Boolean = false,
  val tap: Boolean = false,
  val longPress: Boolean = false,
  val ink: Boolean = false,
  val b1: String = "",
  val b1k: String = "",
  val b1i: String = "",
  val b2: String = "",
  val b2k: String = "",
  val b2i: String = "",
  val a11y: String = ""
) {
  val hasCard: Boolean get() = seg.isNotEmpty()
  val topGap: Float get() = if (seg.isEmpty() || seg == "one" || seg == "top") mt else 0f
  val bottomGap: Float get() = if (seg.isEmpty() || seg == "one" || seg == "bot") mb else 0f

  companion object {
    fun from(m: Map<String, Any?>): CMRow = CMRow(
      id = CLVal.str(m["id"]),
      kind = CLVal.str(m["kind"]).ifEmpty { "row" },
      seg = CLVal.str(m["seg"]),
      cs = CLVal.str(m["cs"]).ifEmpty { "c" },
      mt = CLVal.double(m["mt"]).toFloat(),
      mb = CLVal.double(m["mb"]).toFloat(),
      pb = CLVal.double(m["pb"]).toFloat(),
      px = if (m["px"] != null) CLVal.double(m["px"]).toFloat() else 14f,
      hx = if (m["hx"] != null) CLVal.double(m["hx"]).toFloat() else 12f,
      title = CLVal.str(m["title"]),
      sub = CLVal.str(m["sub"]),
      body = CLVal.str(m["body"]),
      ts = CLVal.str(m["ts"]).ifEmpty { "body" },
      tag = CLVal.str(m["tag"]),
      tagBg = CLVal.str(m["tbg"]),
      tagFg = CLVal.str(m["tfg"]),
      rtag = CLVal.str(m["rtag"]),
      rtagBg = CLVal.str(m["rbg"]),
      rtagFg = CLVal.str(m["rfg"]),
      url = CLVal.str(m["u"]),
      auth = CLVal.bool(m["a"]),
      initial = CLVal.str(m["i"]),
      expanded = CLVal.bool(m["x"]),
      chevron = CLVal.bool(m["chev"]),
      remove = CLVal.bool(m["rm"]),
      div = CLVal.bool(m["div"]),
      center = CLVal.bool(m["center"]),
      tap = CLVal.bool(m["tap"]),
      longPress = CLVal.bool(m["lp"]),
      ink = CLVal.bool(m["ink"]),
      b1 = CLVal.str(m["b1"]), b1k = CLVal.str(m["b1k"]), b1i = CLVal.str(m["b1i"]),
      b2 = CLVal.str(m["b2"]), b2k = CLVal.str(m["b2k"]), b2i = CLVal.str(m["b2i"]),
      a11y = CLVal.str(m["a11y"])
    )
  }
}

/** Cores (fallback; o JS manda `palette` com as do tema em hex). */
internal class CMPalette(val dark: Boolean, m: Map<String, Any?>? = null) {
  var bg: Int
  var card: Int
  var border: Int
  var box: Int
  var inset: Int
  var text: Int
  var sub: Int
  var ter: Int
  var ink: Int
  var pill: Int
  var iconBg: Int
  var danger: Int = 0xFFEF4444.toInt()
  var chevron: Int

  init {
    if (dark) {
      bg = 0xFF000000.toInt()
      card = 0xFF161616.toInt()
      border = 0x0FFFFFFF
      box = 0xFF1C1C1E.toInt()
      inset = 0x0AFFFFFF
      text = 0xFFF5F5F7.toInt()
      sub = 0xFF8B8FA3.toInt()
      ter = 0xFF555555.toInt()
      ink = 0xFFF5F5F7.toInt()
      pill = 0x1AFFFFFF
      iconBg = 0x14FFFFFF
      chevron = 0xFF666666.toInt()
    } else {
      bg = 0xFFFFFFFF.toInt()
      card = 0xFFFFFFFF.toInt()
      border = 0x0F000000
      box = 0xFFF8F8FA.toInt()
      inset = 0x05000000
      text = 0xFF111111.toInt()
      sub = 0xFF6B7280.toInt()
      ter = 0xFF999999.toInt()
      ink = 0xFF111111.toInt()
      pill = 0x0F000000
      iconBg = 0x0F000000
      chevron = 0xFF999999.toInt()
    }
    if (m != null) {
      fun c(k: String): Int? = SLColor.parse(CLVal.str(m[k]))
      c("bg")?.let { bg = it }
      c("card")?.let { card = it }
      c("border")?.let { border = it }
      c("box")?.let { box = it }
      c("inset")?.let { inset = it }
      c("text")?.let { text = it }
      c("sub")?.let { sub = it }
      c("ter")?.let { ter = it }
      c("ink")?.let { ink = it }
      c("pill")?.let { pill = it }
      c("iconBg")?.let { iconBg = it }
      c("danger")?.let { danger = it }
      c("chevron")?.let { chevron = it }
    }
  }
}

/** Ícone de traço (viewBox 24) a partir de path data SVG — sem recurso XML. */
internal class CMIcon(pathData: String, color: Int, private val strokeDp: Float, private val density: Float, private val sizeDp: Float = 16f) : Drawable() {
  private val path: Path? = parse(pathData)
  private val scaled = Path()
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
    this.color = color
  }
  private val m = android.graphics.Matrix()

  override fun draw(canvas: Canvas) {
    val p = path ?: return
    val b = bounds
    if (b.width() <= 0) return
    val s = b.width() / 24f
    m.reset()
    m.setScale(s, s)
    m.postTranslate(b.left.toFloat(), b.top.toFloat())
    scaled.reset()
    p.transform(m, scaled)
    paint.strokeWidth = strokeDp * density
    canvas.drawPath(scaled, paint)
  }

  override fun getIntrinsicWidth(): Int = Math.round(sizeDp * density)
  override fun getIntrinsicHeight(): Int = Math.round(sizeDp * density)
  override fun setAlpha(alpha: Int) { paint.alpha = alpha }
  override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
  @Deprecated("Deprecated in Java")
  override fun getOpacity(): Int = PixelFormat.TRANSLUCENT

  companion object {
    const val CHEVRON_DOWN = "M6 9l6 6 6-6"
    const val X = "M18 6L6 18M6 6l12 12"
    const val PLUS = "M12 5v14M5 12h14"
    const val BELL = "M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"

    private fun parse(d: String): Path? {
      var p: Path? = null
      try { p = PathParser.createPathFromPathData(d) } catch (_: Throwable) { p = null }
      return p
    }

    fun forKey(k: String): String = when (k) {
      "plus" -> PLUS
      "bell", "megaphone" -> BELL
      else -> ""
    }
  }
}
