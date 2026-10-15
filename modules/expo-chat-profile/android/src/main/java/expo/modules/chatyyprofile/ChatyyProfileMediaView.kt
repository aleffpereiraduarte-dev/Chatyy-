package expo.modules.chatyyprofile

// [2026-10-15 native-profile] Abas Mídia | Links | Arquivos com grade nativa
// (Android). Auto-dimensionada: calcula a própria altura → setStyleSize +
// onHeightChange. Fundo transparente (o JS envolve num card).

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.max
import kotlin.math.min

@SuppressLint("ViewConstructor")
class ChatyyProfileMediaView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  internal val onHeightChange by EventDispatcher()
  internal val onItem by EventDispatcher()
  internal val onSeeAll by EventDispatcher()
  internal val onTabChange by EventDispatcher()

  private val density = resources.displayMetrics.density
  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()
  private fun dpf(v: Float): Float = v * density

  private var theme = PFTheme(null)
  private var tabs: List<Pair<String, String>> = emptyList()
  private var selected = ""
  private var media: List<Map<String, Any?>> = emptyList()
  private var links: List<Map<String, Any?>> = emptyList()
  private var files: List<Map<String, Any?>> = emptyList()
  private var labels: Map<String, String> = emptyMap()
  private var maxItems = 9

  private val tabViews = ArrayList<TextView>()
  private val underline = View(context)
  private val tabHairline = View(context)
  private val content = FrameLayout(context)
  private val footer = FrameLayout(context)
  private val footerLabel = TextView(context)
  private val footerChevron = ImageView(context)
  private var lastHeightDp = -1.0
  private var underX = 0f
  private var underW = 0f
  private var underAnim: ValueAnimator? = null
  private var dirty = true
  private var builtKey = ""

  init {
    addView(tabHairline)
    addView(underline)
    addView(content)
    footerLabel.setSingleLine(true)
    footerLabel.gravity = Gravity.CENTER_VERTICAL
    pfTextSize(footerLabel, 15f, 1)
    footer.addView(footerLabel, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).also { it.leftMargin = dp(14f) })
    footerChevron.scaleType = ImageView.ScaleType.CENTER_INSIDE
    footer.addView(footerChevron, FrameLayout.LayoutParams(dp(18f), dp(18f), Gravity.END or Gravity.CENTER_VERTICAL).also { it.rightMargin = dp(14f) })
    footer.setOnClickListener { onSeeAll(mapOf("tab" to currentTab())) }
    addView(footer)
    applyTheme()
  }

  private fun currentTab(): String = if (tabs.any { it.first == selected }) selected else tabs.firstOrNull()?.first ?: "media"

  private fun itemsFor(tab: String): List<Map<String, Any?>> = when (tab) {
    "links" -> links
    "files" -> files
    else -> media
  }

  private fun isGrid(tab: String) = tab != "links" && tab != "files"

  // ───────── props ─────────
  fun setTheme(m: Map<String, Any?>?) { theme = PFTheme(m); applyTheme(); markDirty() }
  fun setTabs(l: List<Map<String, Any?>>?) {
    tabs = (l ?: emptyList()).map { pfStr(it["key"]) to pfStr(it["label"]) }.filter { it.first.isNotEmpty() }
    rebuildTabs(); markDirty()
  }
  fun setSelected(v: String) { if (v != selected) { selected = v; markDirty() } }
  fun setMedia(l: List<Map<String, Any?>>?) { media = l ?: emptyList(); markDirty() }
  fun setLinks(l: List<Map<String, Any?>>?) { links = l ?: emptyList(); markDirty() }
  fun setFiles(l: List<Map<String, Any?>>?) { files = l ?: emptyList(); markDirty() }
  fun setLabels(m: Map<String, String>?) { labels = m ?: emptyMap(); footerLabel.text = labels["seeAll"] ?: ""; markDirty() }
  fun setMaxItems(v: Int?) { maxItems = (v ?: 9).coerceIn(1, 60); markDirty() }
  fun didUpdateProps() { if (dirty) rebuild(false) }

  private fun markDirty() { dirty = true }

  private fun applyTheme() {
    underline.background = pfRounded(theme.text, dpf(1f))
    tabHairline.setBackgroundColor(theme.hairline)
    footerLabel.setTextColor(theme.text)
    pfTintedIcon(footerChevron, "chevron", theme.tertiaryText)
    footer.background = pfRipple(theme.hairline)
    for (tv in tabViews) tv.setTextColor(if (tv.tag == currentTab()) theme.text else theme.secondaryText)
  }

  private fun rebuildTabs() {
    for (tv in tabViews) removeView(tv)
    tabViews.clear()
    for ((k, label) in tabs) {
      val tv = TextView(context)
      tv.text = label
      tv.tag = k
      tv.setSingleLine(true)
      tv.gravity = Gravity.CENTER
      pfTextSize(tv, 15f, 1)
      tv.setOnClickListener {
        if (selected != k) {
          selected = k
          onTabChange(mapOf("tab" to k))
          rebuild(true)
        }
      }
      tabViews.add(tv)
      addView(tv)
    }
  }

  private fun rebuild(animated: Boolean) {
    dirty = false
    val tab = currentTab()
    val items = itemsFor(tab)
    val key = "$tab|${items.size}|" + items.joinToString(",") { pfStr(it["key"]) + pfStr(it["uri"]) + pfStr(it["title"]) } + "|${theme.text}|$maxItems|${labels["empty"]}"
    for (tv in tabViews) {
      val on = tv.tag == tab
      tv.setTextColor(if (on) theme.text else theme.secondaryText)
      tv.typeface = if (on) android.graphics.Typeface.DEFAULT_BOLD else android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
    }
    if (key != builtKey) {
      builtKey = key
      content.removeAllViews()
      val list = items.take(if (isGrid(tab)) maxItems else min(maxItems, 5))
      if (list.isEmpty()) {
        val tv = TextView(context)
        tv.text = labels["empty"] ?: ""
        tv.gravity = Gravity.CENTER
        tv.setTextColor(theme.tertiaryText)
        pfTextSize(tv, 14f, 0)
        content.addView(tv)
      } else if (isGrid(tab)) {
        for (it in list) content.addView(makeCell(tab, it))
      } else {
        for (it in list) content.addView(makeRow(tab, it))
      }
      if (animated) {
        content.alpha = 0f
        content.animate().alpha(1f).setDuration(180).start()
      }
    }
    footer.visibility = if (items.isNotEmpty()) View.VISIBLE else View.GONE
    requestLayout()
    if (width > 0) post { reportHeight() }
  }

  private fun makeCell(tab: String, m: Map<String, Any?>): View {
    val cell = FrameLayout(context)
    cell.setBackgroundColor(theme.hairline)
    val iv = ImageView(context)
    iv.scaleType = ImageView.ScaleType.CENTER_CROP
    cell.addView(iv, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    pfLoad(iv, PFImage.from(m), false)
    if (pfBool(m["video"])) {
      val badge = android.widget.LinearLayout(context)
      badge.orientation = android.widget.LinearLayout.HORIZONTAL
      badge.gravity = Gravity.CENTER_VERTICAL
      badge.background = pfRounded(0x8C000000.toInt(), dpf(8f))
      badge.setPadding(dp(5f), dp(2f), dp(6f), dp(2f))
      val play = ImageView(context)
      pfTintedIcon(play, "play", Color.WHITE)
      badge.addView(play, android.widget.LinearLayout.LayoutParams(dp(10f), dp(10f)))
      val dur = pfStr(m["duration"])
      if (dur.isNotEmpty()) {
        val tv = TextView(context)
        tv.text = dur
        tv.setTextColor(Color.WHITE)
        pfTextSize(tv, 11f, 1)
        badge.addView(tv, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT).also { it.leftMargin = dp(3f) })
      }
      cell.addView(badge, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).also { it.leftMargin = dp(5f); it.bottomMargin = dp(5f) })
    }
    cell.foreground = pfRipple(0x40FFFFFF)
    val k = pfStr(m["key"])
    cell.setOnClickListener { onItem(mapOf("tab" to tab, "key" to k)) }
    return cell
  }

  private fun makeRow(tab: String, m: Map<String, Any?>): View {
    val row = FrameLayout(context)
    row.background = pfRipple(theme.hairline)
    val iconBox = FrameLayout(context)
    iconBox.background = pfRounded(theme.hairline, dpf(8f))
    if (tab == "files") {
      val ext = TextView(context)
      ext.text = pfStr(m["ext"]).uppercase().take(4)
      ext.gravity = Gravity.CENTER
      ext.setTextColor(theme.text)
      pfTextSize(ext, 11f, 2)
      iconBox.addView(ext, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      if (ext.text.isNullOrEmpty()) {
        val iv = ImageView(context); pfTintedIcon(iv, "file", theme.text)
        iconBox.addView(iv, FrameLayout.LayoutParams(dp(20f), dp(20f), Gravity.CENTER))
      }
    } else {
      val iv = ImageView(context); pfTintedIcon(iv, "link", theme.text)
      iconBox.addView(iv, FrameLayout.LayoutParams(dp(20f), dp(20f), Gravity.CENTER))
    }
    row.addView(iconBox, FrameLayout.LayoutParams(dp(40f), dp(40f), Gravity.CENTER_VERTICAL or Gravity.START).also { it.leftMargin = dp(14f) })
    val col = android.widget.LinearLayout(context)
    col.orientation = android.widget.LinearLayout.VERTICAL
    col.gravity = Gravity.CENTER_VERTICAL
    val t = TextView(context)
    t.text = pfStr(m["title"]); t.setSingleLine(true); t.ellipsize = TextUtils.TruncateAt.END
    t.setTextColor(theme.text); pfTextSize(t, 15f, 1)
    col.addView(t)
    val sub = pfStr(m["subtitle"])
    if (sub.isNotEmpty()) {
      val s = TextView(context)
      s.text = sub; s.setSingleLine(true); s.ellipsize = TextUtils.TruncateAt.MIDDLE
      s.setTextColor(theme.secondaryText); pfTextSize(s, 13f, 0)
      col.addView(s)
    }
    row.addView(col, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).also { it.leftMargin = dp(14f + 40f + 12f); it.rightMargin = dp(14f) })
    val k = pfStr(m["key"])
    row.setOnClickListener { onItem(mapOf("tab" to tab, "key" to k)) }
    return row
  }

  // ───────── layout ─────────
  private fun desiredHeightPx(w: Int): Int {
    val tab = currentTab()
    val items = itemsFor(tab)
    val n = content.childCount
    var h = dp(44f)
    h += if (items.isEmpty()) dp(64f) else if (isGrid(tab)) {
      val gap = dp(2f)
      val cell = (w - gap * 2) / 3
      val rows = (n + 2) / 3
      rows * cell + max(0, rows - 1) * gap
    } else n * dp(56f)
    if (items.isNotEmpty()) h += dp(44f)
    return h
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.UNSPECIFIED) desiredHeightPx(w) else MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(w, h)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    if (w <= 0) return
    // abas
    var x = dp(14f)
    val tab = currentTab()
    var selX = 0; var selW = 0
    for (tv in tabViews) {
      tv.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(dp(44f), MeasureSpec.EXACTLY))
      val tw = tv.measuredWidth
      tv.layout(x, 0, x + tw, dp(44f))
      if (tv.tag == tab) { selX = x; selW = tw }
      x += tw + dp(18f)
    }
    tabHairline.pfPlace(0, dp(44f) - max(1, (density * 0.5f).toInt()), w, max(1, (density * 0.5f).toInt()))
    underline.pfPlace(0, dp(44f) - dp(2f), max(1, w), dp(2f))
    moveUnderline(selX.toFloat(), selW.toFloat(), w)
    // conteúdo
    val items = itemsFor(tab)
    val top = dp(44f)
    val contentH = desiredHeightPx(w) - top - (if (items.isNotEmpty()) dp(44f) else 0)
    content.pfExactly(w, contentH)
    content.layout(0, top, w, top + contentH)
    if (items.isEmpty()) {
      content.getChildAt(0)?.pfPlace(0, 0, w, contentH)
    } else if (isGrid(tab)) {
      val gap = dp(2f)
      val cell = (w - gap * 2) / 3
      for (i in 0 until content.childCount) {
        val c = content.getChildAt(i)
        val col = i % 3; val row = i / 3
        val cx = col * (cell + gap)
        val cw = if (col == 2) w - cx else cell
        c.pfPlace(cx, row * (cell + gap), cw, cell)
      }
    } else {
      for (i in 0 until content.childCount) content.getChildAt(i).pfPlace(0, i * dp(56f), w, dp(56f))
    }
    if (footer.visibility == View.VISIBLE) footer.pfPlace(0, top + contentH, w, dp(44f))
    reportHeight()
  }

  private fun moveUnderline(x: Float, wSel: Float, w: Int) {
    if (wSel <= 0f) { underline.visibility = View.INVISIBLE; return }
    underline.visibility = View.VISIBLE
    val fromX = underX; val fromW = underW
    underX = x; underW = wSel
    fun apply(cx: Float, cw: Float) {
      underline.pivotX = 0f
      underline.scaleX = cw / max(1, w).toFloat()
      underline.translationX = cx
    }
    if (fromW <= 0f || (fromX == x && fromW == wSel)) { underAnim?.cancel(); apply(x, wSel); return }
    underAnim?.cancel()
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 340
    a.interpolator = OvershootInterpolator(1.4f)
    a.addUpdateListener { val f = it.animatedValue as Float; apply(fromX + (x - fromX) * f, fromW + (wSel - fromW) * f) }
    underAnim = a
    a.start()
  }

  private fun reportHeight() {
    val w = width
    if (w <= 0) return
    val hDp = Math.round(desiredHeightPx(w) / density * 2.0) / 2.0
    if (abs(hDp - lastHeightDp) < 0.5) return
    lastHeightDp = hDp
    try { shadowNodeProxy.setStyleSize(null, hDp) } catch (t: Throwable) { Log.w("ChatyyProfileMedia", "setStyleSize: ${t.message}") }
    onHeightChange(mapOf("height" to hDp))
  }

  private fun abs(v: Double) = Math.abs(v)
}
