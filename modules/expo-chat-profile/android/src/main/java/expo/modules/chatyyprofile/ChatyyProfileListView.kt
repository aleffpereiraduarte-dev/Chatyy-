package expo.modules.chatyyprofile

// [2026-10-15 native-profile] Lista nativa (membros do grupo / grupos em
// comum) — Android. Auto-dimensionada (setStyleSize + onHeightChange), fundo
// transparente. Ações: 'row' | 'avatar' | key do botão | key do link.

import android.annotation.SuppressLint
import android.content.Context
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.max
import kotlin.math.min

@SuppressLint("ViewConstructor")
internal class PFRowView(context: Context, private val host: ChatyyProfileListView) : FrameLayout(context) {
  private val density = resources.displayMetrics.density
  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()

  val avatar = PFAvatar(context)
  val title = TextView(context)
  val badge = TextView(context)
  val subtitle = TextView(context)
  val link = TextView(context)
  val chevron = ImageView(context)
  val separator = View(context)
  val buttons = ArrayList<View>()
  var rowKey = ""
  var hasSub = false
  var hasLink = false
  var hasChevron = false
  var showSeparator = true
  var avatarSize = 42

  init {
    addView(avatar)
    title.setSingleLine(true); title.ellipsize = TextUtils.TruncateAt.END; title.includeFontPadding = false
    pfTextSize(title, 15.5f, 1)
    addView(title)
    badge.setSingleLine(true); badge.gravity = Gravity.CENTER; badge.includeFontPadding = false
    pfTextSize(badge, 10.5f, 2)
    addView(badge)
    subtitle.setSingleLine(true); subtitle.ellipsize = TextUtils.TruncateAt.END; subtitle.includeFontPadding = false
    pfTextSize(subtitle, 12.5f, 0)
    addView(subtitle)
    link.setSingleLine(true); link.includeFontPadding = false
    pfTextSize(link, 11.5f, 2)
    addView(link)
    chevron.scaleType = ImageView.ScaleType.CENTER_INSIDE
    addView(chevron)
    addView(separator)
  }

  fun rowHeight(): Int = dp(if (hasSub) 56f else 52f) + (if (hasLink) dp(18f) else 0)

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), rowHeight())
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    val a = avatarSize
    avatar.pfPlace(dp(14f), (h - a) / 2, a, a)
    val textX = dp(14f) + a + dp(12f)
    // botões à direita
    var right = w - dp(14f)
    if (hasChevron) {
      chevron.pfPlace(right - dp(18f), (h - dp(18f)) / 2, dp(18f), dp(18f))
      right -= dp(18f) + dp(8f)
    }
    for (i in buttons.indices.reversed()) {
      val bt = buttons[i]
      val isRemove = bt.tag == "remove"
      if (isRemove) {
        bt.pfPlace(right - dp(30f), (h - dp(30f)) / 2, dp(30f), dp(30f))
        right -= dp(30f) + dp(6f)
      } else {
        bt.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(dp(28f), MeasureSpec.EXACTLY))
        val bw = min(bt.measuredWidth, dp(130f))
        bt.pfPlace(right - bw, (h - dp(28f)) / 2, bw, dp(28f))
        right -= bw + dp(6f)
      }
    }
    val textW = max(0, right - textX - dp(4f))
    val lineTitle = dp(20f)
    val lineSub = dp(16f)
    val lineLink = dp(16f)
    val block = lineTitle + (if (hasSub) lineSub + dp(2f) else 0) + (if (hasLink) lineLink + dp(3f) else 0)
    var y = (h - block) / 2
    // título + selo
    var badgeW = 0
    if (badge.visibility == View.VISIBLE) {
      badge.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(dp(18f), MeasureSpec.EXACTLY))
      badgeW = badge.measuredWidth + dp(14f)
    }
    title.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(lineTitle, MeasureSpec.EXACTLY))
    val titleW = min(title.measuredWidth, max(0, textW - (if (badgeW > 0) badgeW + dp(6f) else 0)))
    title.pfPlace(textX, y, titleW, lineTitle)
    if (badgeW > 0) badge.pfPlace(textX + titleW + dp(6f), y + (lineTitle - dp(18f)) / 2, badgeW, dp(18f))
    y += lineTitle
    if (hasSub) { y += dp(2f); subtitle.pfPlace(textX, y, textW, lineSub); y += lineSub }
    if (hasLink) {
      y += dp(3f)
      link.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(lineLink, MeasureSpec.EXACTLY))
      link.pfPlace(textX, y, min(link.measuredWidth, textW), lineLink)
    }
    val sh = max(1, (density * 0.5f).toInt())
    separator.visibility = if (showSeparator) View.VISIBLE else View.GONE
    separator.pfPlace(textX, h - sh, w - textX, sh)
  }

  override fun requestLayout() {
    super.requestLayout()
    // chamado também pelo construtor do FrameLayout (host ainda nulo no JVM)
    @Suppress("SENSELESS_COMPARISON")
    val h: ChatyyProfileListView? = host
    h?.requestLayout()
  }
}

@SuppressLint("ViewConstructor")
class ChatyyProfileListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  internal val onHeightChange by EventDispatcher()
  internal val onRowAction by EventDispatcher()

  private val density = resources.displayMetrics.density
  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()
  private fun dpf(v: Float): Float = v * density

  private var theme = PFTheme(null)
  private var rows: List<Map<String, Any?>> = emptyList()
  private var avatarSizeDp = 42.0
  private var emptyText = ""
  private var dirty = true
  private var builtKey = ""
  private val rowViews = ArrayList<PFRowView>()
  private val emptyView = TextView(context)
  private var lastHeightDp = -1.0

  init {
    emptyView.gravity = Gravity.CENTER
    pfTextSize(emptyView, 14f, 0)
    emptyView.visibility = View.GONE
    addView(emptyView)
  }

  fun setTheme(m: Map<String, Any?>?) { theme = PFTheme(m); builtKey = ""; dirty = true }
  fun setRows(l: List<Map<String, Any?>>?) { rows = l ?: emptyList(); dirty = true }
  fun setAvatarSize(v: Double?) { avatarSizeDp = (v ?: 42.0).coerceIn(20.0, 80.0); builtKey = ""; dirty = true }
  fun setEmptyText(v: String) { emptyText = v; dirty = true }
  fun didUpdateProps() { if (dirty) rebuild() }

  private fun emit(key: String, action: String) { onRowAction(mapOf("key" to key, "action" to action)) }

  private fun rowSig(m: Map<String, Any?>): String {
    val sb = StringBuilder()
    for (k in listOf("key", "title", "subtitle", "initials", "avatarColor", "badge", "chevron")) sb.append(pfStr(m[k])).append('\u0001')
    sb.append(pfStr(pfMap(m["avatar"])?.get("uri"))).append('\u0001')
    pfMap(m["link"])?.let { sb.append(pfStr(it["key"])).append(pfStr(it["label"])) }
    sb.append('\u0001')
    for (b in pfList(m["buttons"])) sb.append(pfStr(b["key"])).append(':').append(pfStr(b["label"])).append(':').append(pfStr(b["style"])).append(',')
    return sb.toString()
  }

  private fun rebuild() {
    dirty = false
    val key = "${theme.text}|${theme.accent}|$avatarSizeDp|" + rows.joinToString("\u0002") { rowSig(it) }
    emptyView.text = emptyText
    emptyView.setTextColor(theme.tertiaryText)
    emptyView.visibility = if (rows.isEmpty() && emptyText.isNotEmpty()) View.VISIBLE else View.GONE
    if (key != builtKey) {
      builtKey = key
      // Reaproveita as linhas existentes (avatar não pisca).
      while (rowViews.size > rows.size) { val v = rowViews.removeAt(rowViews.size - 1); removeView(v) }
      while (rowViews.size < rows.size) { val v = PFRowView(context, this); rowViews.add(v); addView(v) }
      rows.forEachIndexed { i, m -> bindRow(rowViews[i], m, i == rows.size - 1) }
    }
    requestLayout()
    if (width > 0) post { reportHeight() }
  }

  private fun bindRow(v: PFRowView, m: Map<String, Any?>, last: Boolean) {
    val k = pfStr(m["key"])
    v.rowKey = k
    v.avatarSize = dp(avatarSizeDp.toFloat())
    v.background = pfRipple(theme.hairline)
    v.setOnClickListener { emit(k, "row") }
    v.avatar.bind(PFImage.from(m["avatar"]), pfStr(m["initials"]), pfColor(m["avatarColor"], 0xFF8E8E93.toInt()), v.avatarSize)
    v.avatar.setOnClickListener { emit(k, "avatar") }
    v.title.text = pfStr(m["title"])
    v.title.setTextColor(theme.text)
    val badge = pfStr(m["badge"])
    v.badge.visibility = if (badge.isEmpty()) View.GONE else View.VISIBLE
    v.badge.text = badge
    v.badge.setTextColor(theme.accent)
    v.badge.background = pfRounded(pfAlpha(theme.accent, 0.13f), dpf(9f))
    val sub = pfStr(m["subtitle"])
    v.hasSub = sub.isNotEmpty()
    v.subtitle.visibility = if (v.hasSub) View.VISIBLE else View.GONE
    v.subtitle.text = sub
    v.subtitle.setTextColor(theme.tertiaryText)
    val link = pfMap(m["link"])
    val linkKey = pfStr(link?.get("key"))
    v.hasLink = link != null && pfStr(link["label"]).isNotEmpty()
    v.link.visibility = if (v.hasLink) View.VISIBLE else View.GONE
    v.link.text = pfStr(link?.get("label"))
    v.link.setTextColor(theme.accent)
    v.link.setOnClickListener { emit(k, linkKey.ifEmpty { "link" }) }
    v.hasChevron = pfBool(m["chevron"])
    v.chevron.visibility = if (v.hasChevron) View.VISIBLE else View.GONE
    pfTintedIcon(v.chevron, "chevron", theme.tertiaryText)
    v.separator.setBackgroundColor(theme.hairline)
    v.showSeparator = !last
    for (b in v.buttons) v.removeView(b)
    v.buttons.clear()
    for (b in pfList(m["buttons"])) {
      val bk = pfStr(b["key"])
      val style = pfStr(b["style"]).ifEmpty { "pill" }
      val bt: View
      if (style == "remove") {
        val iv = ImageView(context)
        iv.scaleType = ImageView.ScaleType.CENTER
        pfTintedIcon(iv, "x", theme.destructive)
        iv.background = pfOval(pfAlpha(theme.destructive, 0.12f))
        iv.contentDescription = pfStr(b["label"])
        iv.tag = "remove"
        bt = iv
      } else {
        val tv = TextView(context)
        tv.text = pfStr(b["label"])
        tv.setSingleLine(true)
        tv.ellipsize = TextUtils.TruncateAt.END
        tv.gravity = Gravity.CENTER
        tv.setPadding(dp(10f), 0, dp(10f), 0)
        tv.setTextColor(theme.text)
        pfTextSize(tv, 11.5f, 2)
        tv.background = pfRounded(theme.hairline, dpf(9f))
        tv.tag = "pill"
        bt = tv
      }
      bt.foreground = pfRipple(theme.hairline, dpf(15f))
      bt.setOnClickListener { emit(k, bk) }
      v.buttons.add(bt)
      v.addView(bt)
    }
    v.requestLayout()
  }

  private fun desiredHeightPx(): Int {
    if (rowViews.isEmpty()) return if (emptyView.visibility == View.VISIBLE) dp(64f) else 0
    var h = 0
    for (r in rowViews) h += r.rowHeight()
    return h
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.UNSPECIFIED) desiredHeightPx() else MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(w, h)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    if (w <= 0) return
    var y = 0
    for (rv in rowViews) {
      val rh = rv.rowHeight()
      rv.pfPlace(0, y, w, rh)
      y += rh
    }
    if (emptyView.visibility == View.VISIBLE) emptyView.pfPlace(0, 0, w, dp(64f))
    reportHeight()
  }

  private fun reportHeight() {
    if (width <= 0) return
    val hDp = Math.round(desiredHeightPx() / density * 2.0) / 2.0
    if (Math.abs(hDp - lastHeightDp) < 0.5) return
    lastHeightDp = hDp
    try { shadowNodeProxy.setStyleSize(null, hDp) } catch (t: Throwable) { Log.w("ChatyyProfileList", "setStyleSize: ${t.message}") }
    onHeightChange(mapOf("height" to hDp))
  }
}
