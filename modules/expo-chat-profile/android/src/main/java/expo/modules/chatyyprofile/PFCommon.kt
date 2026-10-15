package expo.modules.chatyyprofile

// [2026-10-15 native-profile] Utilitários comuns das 3 views do perfil nativo
// (tema, conversão de props Map/List vindas do JS, imagens via Glide com
// headers, ícones tingidos).

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.util.TypedValue
import android.view.View
import android.widget.ImageView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.model.GlideUrl
import com.bumptech.glide.load.model.LazyHeaders
import com.bumptech.glide.request.RequestOptions

internal fun pfDp(ctx: Context, v: Float): Int = (v * ctx.resources.displayMetrics.density + 0.5f).toInt()
internal fun pfDpF(ctx: Context, v: Float): Float = v * ctx.resources.displayMetrics.density

/** processColor() do RN = Int ARGB (chega como Double/Number). */
internal fun pfColor(v: Any?, fallback: Int): Int {
  val n = v as? Number ?: return fallback
  val d = n.toDouble()
  if (d.isNaN() || d.isInfinite()) return fallback
  return n.toLong().toInt()
}

internal fun pfStr(v: Any?): String = when (v) {
  null -> ""
  is String -> v
  is Number -> {
    val d = v.toDouble()
    if (d == Math.floor(d) && !d.isInfinite()) d.toLong().toString() else d.toString()
  }
  else -> v.toString()
}

internal fun pfBool(v: Any?, fallback: Boolean = false): Boolean = when (v) {
  is Boolean -> v
  is Number -> v.toDouble() != 0.0
  else -> fallback
}

internal fun pfNum(v: Any?, fallback: Double = 0.0): Double = (v as? Number)?.toDouble() ?: fallback

@Suppress("UNCHECKED_CAST")
internal fun pfMap(v: Any?): Map<String, Any?>? = v as? Map<String, Any?>

internal fun pfList(v: Any?): List<Map<String, Any?>> {
  val l = v as? List<*> ?: return emptyList()
  return l.mapNotNull { pfMap(it) }
}

internal fun pfAlpha(color: Int, alpha: Float): Int {
  val a = (Color.alpha(color) * alpha).toInt().coerceIn(0, 255)
  return (color and 0x00FFFFFF) or (a shl 24)
}

/** Imagem `{uri, headers}` vinda do JS. */
internal data class PFImage(val uri: String, val headers: Map<String, String>) {
  companion object {
    fun from(v: Any?): PFImage? {
      val m = pfMap(v) ?: return null
      val uri = pfStr(m["uri"])
      if (uri.isEmpty()) return null
      val h = HashMap<String, String>()
      pfMap(m["headers"])?.forEach { (k, value) -> if (value != null) h[k] = pfStr(value) }
      return PFImage(uri, h)
    }
  }

  fun model(): Any {
    if ((uri.startsWith("http://") || uri.startsWith("https://")) && headers.isNotEmpty()) {
      val b = LazyHeaders.Builder()
      headers.forEach { (k, v) -> b.addHeader(k, v) }
      return GlideUrl(uri, b.build())
    }
    return uri
  }
}

internal fun pfLoad(iv: ImageView, img: PFImage?, circle: Boolean) {
  try {
    if (img == null) {
      Glide.with(iv).clear(iv)
      iv.setImageDrawable(null)
      return
    }
    var req = Glide.with(iv).load(img.model())
    if (circle) req = req.apply(RequestOptions.circleCropTransform())
    else req = req.apply(RequestOptions.centerCropTransform())
    req.into(iv)
  } catch (_: Throwable) {}
}

/** Tema comum (cores ARGB). */
internal class PFTheme(m: Map<String, Any?>?) {
  val dark = pfBool(m?.get("dark"), false)
  val background = pfColor(m?.get("background"), if (dark) Color.BLACK else 0xFFF0F2F5.toInt())
  val surface = pfColor(m?.get("surface"), if (dark) 0xFF0B0B0B.toInt() else Color.WHITE)
  val card = pfColor(m?.get("card"), if (dark) 0xFF1C1C1E.toInt() else 0xFFF4F4F5.toInt())
  val cardBorder = pfColor(m?.get("cardBorder"), if (dark) 0x14FFFFFF else 0x14000000)
  val text = pfColor(m?.get("text"), if (dark) Color.WHITE else 0xFF111111.toInt())
  val secondaryText = pfColor(m?.get("secondaryText"), if (dark) 0xFFA1A1A6.toInt() else 0xFF6E6E73.toInt())
  val tertiaryText = pfColor(m?.get("tertiaryText"), if (dark) 0xFF8E8E93.toInt() else 0xFF8E8E93.toInt())
  val accent = pfColor(m?.get("accent"), if (dark) Color.WHITE else 0xFF111111.toInt())
  val hairline = pfColor(m?.get("hairline"), if (dark) 0xFF262628.toInt() else 0x1A000000)
  val destructive = pfColor(m?.get("destructive"), 0xFFDC2626.toInt())
}

internal fun pfIconRes(name: String): Int = when (name) {
  "message" -> R.drawable.pf_ic_message
  "call" -> R.drawable.pf_ic_call
  "video" -> R.drawable.pf_ic_video
  "search" -> R.drawable.pf_ic_search
  "mute" -> R.drawable.pf_ic_mute
  "unmute" -> R.drawable.pf_ic_unmute
  "more" -> R.drawable.pf_ic_more
  "camera" -> R.drawable.pf_ic_camera
  "link" -> R.drawable.pf_ic_link
  "leave" -> R.drawable.pf_ic_leave
  "close" -> R.drawable.pf_ic_close
  "back" -> R.drawable.pf_ic_back
  "play" -> R.drawable.pf_ic_play
  "chevron" -> R.drawable.pf_ic_chevron
  "file" -> R.drawable.pf_ic_file
  "x" -> R.drawable.pf_ic_x
  else -> R.drawable.pf_ic_more
}

internal fun pfTintedIcon(iv: ImageView, name: String, color: Int) {
  iv.setImageResource(pfIconRes(name))
  iv.imageTintList = ColorStateList.valueOf(color)
}

internal fun pfRounded(color: Int, radiusPx: Float, strokeColor: Int = 0, strokePx: Int = 0): GradientDrawable {
  val g = GradientDrawable()
  g.setColor(color)
  g.cornerRadius = radiusPx
  if (strokePx > 0) g.setStroke(strokePx, strokeColor)
  return g
}

internal fun pfOval(color: Int): GradientDrawable {
  val g = GradientDrawable()
  g.shape = GradientDrawable.OVAL
  g.setColor(color)
  return g
}

/** Destaque ao tocar (ripple) com cor do hairline. */
internal fun pfRipple(color: Int, radiusPx: Float = 0f): RippleDrawable {
  val mask = if (radiusPx > 0f) pfRounded(Color.WHITE, radiusPx) else ColorDrawable(Color.WHITE)
  return RippleDrawable(ColorStateList.valueOf(pfAlpha(color, 0.9f)), null, mask)
}

internal fun pfTextSize(tv: android.widget.TextView, sp: Float, bold: Int = 0) {
  tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
  tv.typeface = when (bold) {
    2 -> Typeface.DEFAULT_BOLD
    1 -> Typeface.create("sans-serif-medium", Typeface.NORMAL)
    else -> Typeface.DEFAULT
  }
}

internal fun View.pfExactly(w: Int, h: Int) {
  measure(View.MeasureSpec.makeMeasureSpec(maxOf(0, w), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(maxOf(0, h), View.MeasureSpec.EXACTLY))
}

internal fun View.pfPlace(x: Int, y: Int, w: Int, h: Int) {
  pfExactly(w, h)
  layout(x, y, x + maxOf(0, w), y + maxOf(0, h))
}

/** Iniciais + foto circular (foto por cima quando carrega). */
internal class PFAvatar(context: Context) : android.widget.FrameLayout(context) {
  val initials = android.widget.TextView(context)
  val image = ImageView(context)
  private var lastKey: String? = null

  init {
    initials.gravity = android.view.Gravity.CENTER
    initials.setTextColor(Color.WHITE)
    initials.includeFontPadding = false
    addView(initials, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    image.scaleType = ImageView.ScaleType.CENTER_CROP
    addView(image, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun bind(img: PFImage?, text: String, bg: Int, sizePx: Int) {
    initials.background = pfOval(bg)
    initials.text = text
    initials.setTextSize(TypedValue.COMPLEX_UNIT_PX, sizePx * 0.38f)
    initials.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    val key = img?.uri
    if (key != lastKey) {
      lastKey = key
      pfLoad(image, img, true)
    }
  }
}
