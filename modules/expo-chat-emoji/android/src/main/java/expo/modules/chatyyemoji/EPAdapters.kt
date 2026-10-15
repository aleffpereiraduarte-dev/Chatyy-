package expo.modules.chatyyemoji

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import kotlin.math.max
import kotlin.math.roundToInt

/** [2026-10-15 native-emoji] Itens/adapters das grades e faixas do painel. */
sealed class EPItem {
  class Header(val title: String) : EPItem()
  class Emo(val display: String, val base: String, val tone: Boolean) : EPItem()
  class Spinner(val section: String) : EPItem()
  class Sticker(val key: String, val uri: String, val section: String) : EPItem()
  class Gif(val key: String, val uri: String, val w: Double, val h: Double) : EPItem()
  class Tab(val key: String, val icon: String, val cover: String?, val title: String) : EPItem()
}

class EPTheme {
  var dark = false
  var background = Color.WHITE
  var surface = 0xFFF0F0F2.toInt()
  var text = 0xFF111111.toInt()
  var secondary = 0xFF6E6E73.toInt()
  var icon = 0xFF6E6E73.toInt()
  var iconActive = 0xFF111111.toInt()
  var accent = 0xFF111111.toInt()
  var hairline = 0x1A000000
  var selection = 0x14000000

  fun apply(m: Map<String, Any?>) {
    dark = (m["dark"] as? Boolean) ?: false
    background = epColor(m["background"], if (dark) Color.BLACK else Color.WHITE)
    surface = epColor(m["surface"], if (dark) 0xFF1C1C1E.toInt() else 0xFFF0F0F2.toInt())
    text = epColor(m["text"], if (dark) Color.WHITE else 0xFF111111.toInt())
    secondary = epColor(m["secondaryText"], if (dark) 0xFFA1A1A6.toInt() else 0xFF6E6E73.toInt())
    icon = epColor(m["icon"], secondary)
    iconActive = epColor(m["iconActive"], text)
    accent = epColor(m["accent"], text)
    hairline = epColor(m["hairline"], if (dark) 0xFF262628.toInt() else 0x1A000000)
    selection = epColor(m["selection"], if (dark) 0x26FFFFFF else 0x14000000)
  }
}

interface EPHost {
  val theme: EPTheme
  fun newEmojiTouch(): View.OnTouchListener
  fun onStickerTap(v: View, item: EPItem.Sticker)
  fun onGifTap(v: View, item: EPItem.Gif)
  fun onTabTap(item: EPItem.Tab)
  fun isTabSelected(key: String): Boolean
}

/** Célula quadrada (largura da coluna da grade). */
internal class EPSquareFrame(context: Context) : FrameLayout(context) {
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(widthMeasureSpec, widthMeasureSpec)
  }
}

internal fun epDp(context: Context, v: Float): Int = (v * context.resources.displayMetrics.density + 0.5f).toInt()

internal fun epRound(v: View, radiusPx: Float) {
  v.outlineProvider = object : ViewOutlineProvider() {
    override fun getOutline(view: View, outline: Outline) {
      outline.setRoundRect(0, 0, view.width, view.height, radiusPx)
    }
  }
  v.clipToOutline = true
}

internal class EPHolder(v: View, val type: Int) : RecyclerView.ViewHolder(v) {
  var text: TextView? = null
  var image: ImageView? = null
  var bg: View? = null
}

internal class EPAdapter(private val host: EPHost, private val strip: Boolean) : RecyclerView.Adapter<EPHolder>() {
  companion object {
    const val T_HEADER = 0
    const val T_EMOJI = 1
    const val T_EMOJI_STRIP = 2
    const val T_SPINNER = 3
    const val T_STICKER = 4
    const val T_GIF = 5
    const val T_GIF_STRIP = 6
    const val T_TAB = 7
  }

  var items: List<EPItem> = emptyList()
    private set

  fun submit(list: List<EPItem>) {
    items = list
    notifyDataSetChanged()
  }

  override fun getItemCount(): Int = items.size

  override fun getItemViewType(position: Int): Int = when (items[position]) {
    is EPItem.Header -> T_HEADER
    is EPItem.Emo -> if (strip) T_EMOJI_STRIP else T_EMOJI
    is EPItem.Spinner -> T_SPINNER
    is EPItem.Sticker -> T_STICKER
    is EPItem.Gif -> if (strip) T_GIF_STRIP else T_GIF
    is EPItem.Tab -> T_TAB
  }

  fun isFullSpan(position: Int): Boolean {
    val it = items.getOrNull(position) ?: return true
    return it is EPItem.Header || it is EPItem.Spinner
  }

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): EPHolder {
    val c = parent.context
    val th = host.theme
    return when (viewType) {
      T_HEADER -> {
        val tv = TextView(c)
        tv.layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, epDp(c, 30f))
        tv.setPadding(epDp(c, 12f), epDp(c, 8f), epDp(c, 12f), 0)
        tv.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 13f)
        tv.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        tv.maxLines = 1
        EPHolder(tv, viewType).also { it.text = tv }
      }
      T_EMOJI, T_EMOJI_STRIP -> {
        val tv = TextView(c)
        val w = if (viewType == T_EMOJI_STRIP) epDp(c, 46f) else ViewGroup.LayoutParams.MATCH_PARENT
        val h = if (viewType == T_EMOJI_STRIP) ViewGroup.LayoutParams.MATCH_PARENT else epDp(c, 44f)
        tv.layoutParams = RecyclerView.LayoutParams(w, h)
        tv.gravity = Gravity.CENTER
        tv.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 29f)
        tv.includeFontPadding = false
        tv.setTextColor(Color.BLACK)
        tv.setOnTouchListener(host.newEmojiTouch())
        tv.isClickable = true
        EPHolder(tv, viewType).also { it.text = tv }
      }
      T_SPINNER -> {
        val f = FrameLayout(c)
        f.layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, epDp(c, 72f))
        val pb = ProgressBar(c, null, android.R.attr.progressBarStyleSmall)
        pb.indeterminateTintList = ColorStateList.valueOf(th.secondary)
        f.addView(pb, FrameLayout.LayoutParams(epDp(c, 22f), epDp(c, 22f), Gravity.CENTER))
        EPHolder(f, viewType)
      }
      T_STICKER, T_GIF -> {
        val f = EPSquareFrame(c)
        f.layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        val iv = ImageView(c)
        val pad = if (viewType == T_STICKER) epDp(c, 5f) else epDp(c, 1.5f)
        val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        lp.setMargins(pad, pad, pad, pad)
        iv.scaleType = if (viewType == T_STICKER) ImageView.ScaleType.FIT_CENTER else ImageView.ScaleType.CENTER_CROP
        if (viewType == T_GIF) epRound(iv, epDp(c, 6f).toFloat())
        f.addView(iv, lp)
        EPHolder(f, viewType).also { it.image = iv }
      }
      T_GIF_STRIP -> {
        val f = FrameLayout(c)
        f.layoutParams = RecyclerView.LayoutParams(epDp(c, 96f), ViewGroup.LayoutParams.MATCH_PARENT)
        val iv = ImageView(c)
        iv.scaleType = ImageView.ScaleType.CENTER_CROP
        epRound(iv, epDp(c, 6f).toFloat())
        val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        lp.setMargins(epDp(c, 2f), epDp(c, 4f), epDp(c, 2f), epDp(c, 4f))
        f.addView(iv, lp)
        EPHolder(f, viewType).also { it.image = iv }
      }
      else -> { // T_TAB
        val f = FrameLayout(c)
        f.layoutParams = RecyclerView.LayoutParams(epDp(c, 44f), ViewGroup.LayoutParams.MATCH_PARENT)
        val bg = View(c)
        val bgd = GradientDrawable()
        bgd.cornerRadius = epDp(c, 10f).toFloat()
        bg.background = bgd
        f.addView(bg, FrameLayout.LayoutParams(epDp(c, 36f), epDp(c, 36f), Gravity.CENTER))
        val iv = ImageView(c)
        iv.scaleType = ImageView.ScaleType.FIT_CENTER
        f.addView(iv, FrameLayout.LayoutParams(epDp(c, 26f), epDp(c, 26f), Gravity.CENTER))
        EPHolder(f, viewType).also { it.image = iv; it.bg = bg }
      }
    }
  }

  override fun onBindViewHolder(h: EPHolder, position: Int) {
    val item = items[position]
    val th = host.theme
    val c = h.itemView.context
    when (item) {
      is EPItem.Header -> {
        h.text?.text = item.title
        h.text?.setTextColor(th.secondary)
      }
      is EPItem.Emo -> {
        h.text?.text = item.display
        h.itemView.tag = item
        h.itemView.contentDescription = item.display
        h.itemView.scaleX = 1f; h.itemView.scaleY = 1f
      }
      is EPItem.Spinner -> {}
      is EPItem.Sticker -> {
        val iv = h.image ?: return
        h.itemView.tag = item
        h.itemView.scaleX = 1f; h.itemView.scaleY = 1f
        h.itemView.setOnClickListener { v -> host.onStickerTap(v, item) }
        load(iv, item.uri, max(1, epDp(c, 110f)))
      }
      is EPItem.Gif -> {
        val iv = h.image ?: return
        iv.setBackgroundColor(th.surface)
        if (h.type == T_GIF_STRIP) {
          val ratio = if (item.w > 0 && item.h > 0) (item.w / item.h).coerceIn(0.5, 2.2) else 1.0
          val lp = h.itemView.layoutParams
          lp.width = (epDp(c, 96f) * ratio).roundToInt()
          h.itemView.layoutParams = lp
        }
        h.itemView.setOnClickListener { v -> host.onGifTap(v, item) }
        load(iv, item.uri, epDp(c, 160f))
      }
      is EPItem.Tab -> {
        val iv = h.image ?: return
        val sel = host.isTabSelected(item.key)
        (h.bg?.background as? GradientDrawable)?.setColor(if (sel) th.selection else Color.TRANSPARENT)
        h.itemView.contentDescription = item.title
        h.itemView.setOnClickListener { host.onTabTap(item) }
        val res = when (item.icon) {
          "recent" -> R.drawable.ep_ic_clock
          "favorites" -> R.drawable.ep_ic_star
          "mine" -> R.drawable.ep_ic_palette
          else -> 0
        }
        if (res != 0 || item.cover.isNullOrEmpty()) {
          try { Glide.with(c).clear(iv) } catch (_: Throwable) {}
          iv.setImageResource(if (res != 0) res else R.drawable.ep_ic_sticker)
          iv.imageTintList = ColorStateList.valueOf(if (sel) th.iconActive else th.icon)
          val p = epDp(c, 2f); iv.setPadding(p, p, p, p)
        } else {
          iv.imageTintList = null
          iv.setPadding(0, 0, 0, 0)
          load(iv, item.cover, epDp(c, 52f))
        }
      }
    }
  }

  override fun onViewRecycled(holder: EPHolder) {
    val iv = holder.image ?: return
    try { Glide.with(iv.context).clear(iv) } catch (_: Throwable) {}
  }

  private fun load(iv: ImageView, uri: String, sizePx: Int) {
    try {
      Glide.with(iv.context).load(uri).override(sizePx, sizePx).into(iv)
    } catch (_: Throwable) {}
  }
}
