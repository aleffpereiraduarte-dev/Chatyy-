package expo.modules.chatyyemoji

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs
import kotlin.math.max

/**
 * [2026-10-15 native-emoji] Painel Emoji | Figurinhas | GIF do composer.
 * Contrato: modules/expo-chat-emoji/index.ts (mesmo do iOS).
 *
 * Árvore: ExpoView → rootFrame → column[pages(weight 1) + bottomBar]
 *   pages = emojiPage | stickerPage | gifPage (troca com fade + deslize).
 * compact (busca com teclado aberto): só campo + faixa horizontal; sem barra.
 */
@SuppressLint("ViewConstructor")
class ChatyyEmojiPanelView(context: Context, appContext: AppContext) : ExpoView(context, appContext), EPHost {
  override val shouldUseAndroidLayout: Boolean = true

  internal val onEmoji by EventDispatcher()
  internal val onBackspace by EventDispatcher()
  internal val onSticker by EventDispatcher()
  internal val onGif by EventDispatcher()
  internal val onGifQuery by EventDispatcher()
  internal val onSection by EventDispatcher()
  internal val onTabChange by EventDispatcher()
  internal val onMore by EventDispatcher()
  internal val onSearchFocus by EventDispatcher()

  override val theme: EPTheme = EPTheme()
  private var labels: Map<String, String> = emptyMap()
  private val prefs = EPPrefs(context)
  private val main = Handler(Looper.getMainLooper())
  private val density = resources.displayMetrics.density
  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop

  // ── estado ──
  private var tab = "emoji"
  private var tabApplied = false
  private var compact = false
  private var showStickers = true
  private var showGifs = true
  private var bottomInsetPx = 0
  private var sections: List<Map<String, Any?>> = emptyList()
  private var gifList: List<Map<String, Any?>> = emptyList()
  private var gifLoading = false
  private var themeDirty = true
  private var labelsDirty = true
  private var stickersDirty = false
  private var gifsDirty = false
  private var dataReady = false
  private var emojiQuery = ""
  private var gifQuery = ""
  private var selectedCat = 0
  private var selectedStickerSection: String? = null
  private val requestedSections = HashSet<String>()
  private var sectionStart = IntArray(EPEmojiData.CATEGORY_COUNT + 1) { -1 }
  private var stickerSectionStart = LinkedHashMap<String, Int>()

  // ── views ──
  private val rootFrame = FrameLayout(context)
  private val column = LinearLayout(context)
  private val pages = FrameLayout(context)
  private val emojiPage = LinearLayout(context)
  private val stickerPage = LinearLayout(context)
  private val gifPage = LinearLayout(context)

  private val emojiSearch = EPSearchField(context)
  private val catStrip = FrameLayout(context)
  private val catPill = View(context)
  private val catRow = LinearLayout(context)
  private val catIcons = ArrayList<ImageView>()
  private val emojiGridFrame = FrameLayout(context)
  private val emojiGrid = RecyclerView(context)
  private val emojiAdapter = EPAdapter(this, false)
  private val emojiLayout = GridLayoutManager(context, 8)
  private val emojiEmpty = TextView(context)
  private val emojiStrip = RecyclerView(context)
  private val emojiStripAdapter = EPAdapter(this, true)

  private val stickerTop = FrameLayout(context)
  private val stickerTabs = RecyclerView(context)
  private val stickerTabsAdapter = EPAdapter(this, true)
  private val stickerMore = ImageView(context)
  private val stickerTopLine = View(context)
  private val stickerGrid = RecyclerView(context)
  private val stickerAdapter = EPAdapter(this, false)
  private val stickerLayout = GridLayoutManager(context, 4)

  private val gifSearch = EPSearchField(context)
  private val gifFrame = FrameLayout(context)
  private val gifGrid = RecyclerView(context)
  private val gifAdapter = EPAdapter(this, false)
  private val gifSpinner = ProgressBar(context, null, android.R.attr.progressBarStyleSmall)
  private val gifEmpty = TextView(context)
  private val gifStrip = RecyclerView(context)
  private val gifStripAdapter = EPAdapter(this, true)

  private val bottomBar = FrameLayout(context)
  private val bottomLine = View(context)
  private val segment = FrameLayout(context)
  private val segPill = View(context)
  private val segRow = LinearLayout(context)
  private val segEmoji = ImageView(context)
  private val segSticker = ImageView(context)
  private val segGif = TextView(context)
  private val backspace = ImageView(context)

  private var tonePopup: PopupWindow? = null
  private var toneRow: LinearLayout? = null
  private var toneVariants: List<String> = emptyList()
  private var toneSel = -1

  private val gifDebounce = Runnable { onGifQuery(mapOf("query" to gifQuery)) }

  init {
    orientation = VERTICAL
    clipChildren = true
    addView(rootFrame, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    column.orientation = LinearLayout.VERTICAL
    rootFrame.addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    column.addView(pages, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
    column.addView(bottomBar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44f)))

    for (p in listOf(emojiPage, stickerPage, gifPage)) {
      p.orientation = LinearLayout.VERTICAL
      pages.addView(p, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }
    stickerPage.visibility = View.INVISIBLE
    gifPage.visibility = View.INVISIBLE

    buildEmojiPage()
    buildStickerPage()
    buildGifPage()
    buildBottomBar()
    applyTheme()

    EPEmojiData.load(context) {
      dataReady = true
      rebuildEmoji()
    }
  }

  // ───────────────────────── construção ─────────────────────────

  private fun searchLp(): LinearLayout.LayoutParams {
    val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36f))
    lp.setMargins(dp(10f), dp(8f), dp(10f), dp(4f))
    return lp
  }

  private fun buildEmojiPage() {
    emojiSearch.onText = { q ->
      emojiQuery = q
      rebuildEmoji()
      if (q.isEmpty()) emojiGrid.scrollToPosition(0)
    }
    emojiSearch.onFocus = { f -> emitSearchFocus(f) }
    emojiPage.addView(emojiSearch, searchLp())

    // categorias: relógio + 8
    val icons = intArrayOf(
      R.drawable.ep_ic_clock, R.drawable.ep_ic_smile, R.drawable.ep_ic_paw, R.drawable.ep_ic_food,
      R.drawable.ep_ic_ball, R.drawable.ep_ic_car, R.drawable.ep_ic_bulb, R.drawable.ep_ic_heart, R.drawable.ep_ic_flag
    )
    val pillBg = GradientDrawable()
    pillBg.cornerRadius = dp(9f).toFloat()
    catPill.background = pillBg
    catStrip.addView(catPill, FrameLayout.LayoutParams(dp(34f), dp(30f), Gravity.CENTER_VERTICAL))
    catRow.orientation = LinearLayout.HORIZONTAL
    catStrip.addView(catRow, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    for ((i, r) in icons.withIndex()) {
      val iv = ImageView(context)
      iv.setImageResource(r)
      iv.scaleType = ImageView.ScaleType.CENTER
      iv.setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
      iv.scaleType = ImageView.ScaleType.FIT_CENTER
      iv.setOnClickListener { scrollToCategory(i) }
      catRow.addView(iv, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
      catIcons.add(iv)
    }
    catRow.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> moveCatPill(selectedCat, false) }
    val csLp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36f))
    csLp.setMargins(dp(6f), 0, dp(6f), 0)
    emojiPage.addView(catStrip, csLp)

    emojiLayout.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
      override fun getSpanSize(position: Int): Int = if (emojiAdapter.isFullSpan(position)) emojiLayout.spanCount else 1
    }
    emojiGrid.layoutManager = emojiLayout
    emojiGrid.adapter = emojiAdapter
    emojiGrid.itemAnimator = null
    emojiGrid.setHasFixedSize(true)
    emojiGrid.clipToPadding = false
    emojiGrid.setPadding(dp(6f), 0, dp(6f), dp(6f))
    emojiGrid.isVerticalScrollBarEnabled = false
    emojiGrid.overScrollMode = View.OVER_SCROLL_NEVER
    emojiGrid.addOnLayoutChangeListener { v, l, _, r, _, ol, _, or2, _ ->
      if (r - l != or2 - ol) {
        val w = v.width - v.paddingLeft - v.paddingRight
        val span = max(6, w / dp(44f))
        if (span != emojiLayout.spanCount) post { emojiLayout.spanCount = span }
      }
    }
    emojiGrid.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
        if (emojiQuery.isNotEmpty()) return
        val first = emojiLayout.findFirstVisibleItemPosition()
        if (first < 0) return
        var s = selectedCat
        for (i in sectionStart.indices) if (sectionStart[i] in 0..first) s = i
        if (s != selectedCat) { selectedCat = s; moveCatPill(s, true) }
      }
    })
    emojiGridFrame.addView(emojiGrid, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    emojiEmpty.gravity = Gravity.CENTER
    emojiEmpty.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 14f)
    emojiEmpty.visibility = View.GONE
    emojiGridFrame.addView(emojiEmpty, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(80f), Gravity.TOP))
    emojiPage.addView(emojiGridFrame, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

    emojiStrip.layoutManager = LinearLayoutManager(context, LinearLayoutManager.HORIZONTAL, false)
    emojiStrip.adapter = emojiStripAdapter
    emojiStrip.itemAnimator = null
    emojiStrip.clipToPadding = false
    emojiStrip.setPadding(dp(6f), 0, dp(6f), 0)
    emojiStrip.overScrollMode = View.OVER_SCROLL_NEVER
    emojiStrip.visibility = View.GONE
    emojiPage.addView(emojiStrip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(48f)))
  }

  private fun buildStickerPage() {
    stickerTabs.layoutManager = LinearLayoutManager(context, LinearLayoutManager.HORIZONTAL, false)
    stickerTabs.adapter = stickerTabsAdapter
    stickerTabs.itemAnimator = null
    stickerTabs.clipToPadding = false
    stickerTabs.setPadding(dp(6f), 0, dp(6f), 0)
    stickerTabs.overScrollMode = View.OVER_SCROLL_NEVER
    val tlp = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
    tlp.rightMargin = dp(44f)
    stickerTop.addView(stickerTabs, tlp)
    stickerMore.setImageResource(R.drawable.ep_ic_more)
    stickerMore.scaleType = ImageView.ScaleType.FIT_CENTER
    stickerMore.setPadding(dp(11f), dp(11f), dp(11f), dp(11f))
    stickerMore.setOnClickListener { onMore(mapOf("tab" to "stickers")) }
    stickerTop.addView(stickerMore, FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.END or Gravity.CENTER_VERTICAL))
    stickerTop.addView(stickerTopLine, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, max(1, dp(0.5f)), Gravity.BOTTOM))
    stickerPage.addView(stickerTop, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(46f)))

    stickerLayout.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
      override fun getSpanSize(position: Int): Int = if (stickerAdapter.isFullSpan(position)) stickerLayout.spanCount else 1
    }
    stickerGrid.layoutManager = stickerLayout
    stickerGrid.adapter = stickerAdapter
    stickerGrid.itemAnimator = null
    stickerGrid.clipToPadding = false
    stickerGrid.setPadding(dp(6f), 0, dp(6f), dp(6f))
    stickerGrid.overScrollMode = View.OVER_SCROLL_NEVER
    stickerGrid.addOnLayoutChangeListener { v, l, _, r, _, ol, _, or2, _ ->
      if (r - l != or2 - ol) {
        val span = if (v.width / density > 500f) 5 else 4
        if (span != stickerLayout.spanCount) post { stickerLayout.spanCount = span }
      }
    }
    stickerGrid.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
        val first = stickerLayout.findFirstVisibleItemPosition()
        if (first < 0) return
        var cur: String? = null
        for ((k, start) in stickerSectionStart) if (start <= first) cur = k
        if (cur != null && cur != selectedStickerSection) {
          selectedStickerSection = cur
          stickerTabsAdapter.notifyDataSetChanged()
          val idx = sections.indexOfFirst { (it["key"] as? String) == cur }
          if (idx >= 0) stickerTabs.smoothScrollToPosition(idx)
        }
        // seção visível sem itens → pede ao JS (uma vez por chave)
        val last = stickerLayout.findLastVisibleItemPosition()
        for (s in sections) {
          val k = s["key"] as? String ?: continue
          val start = stickerSectionStart[k] ?: continue
          if (start in first..max(first, last) && itemsOf(s).isEmpty() && requestedSections.add(k)) onSection(mapOf("key" to k))
        }
      }
    })
    stickerPage.addView(stickerGrid, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
  }

  private fun buildGifPage() {
    gifSearch.onText = { q ->
      gifQuery = q
      main.removeCallbacks(gifDebounce)
      main.postDelayed(gifDebounce, 300)
      updateGifState()
    }
    gifSearch.onFocus = { f -> emitSearchFocus(f) }
    gifPage.addView(gifSearch, searchLp())

    gifGrid.layoutManager = GridLayoutManager(context, 3)
    gifGrid.adapter = gifAdapter
    gifGrid.itemAnimator = null
    gifGrid.clipToPadding = false
    gifGrid.setPadding(dp(6f), dp(2f), dp(6f), dp(6f))
    gifGrid.overScrollMode = View.OVER_SCROLL_NEVER
    gifFrame.addView(gifGrid, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    gifFrame.addView(gifSpinner, FrameLayout.LayoutParams(dp(24f), dp(24f), Gravity.CENTER))
    gifSpinner.visibility = View.GONE
    gifEmpty.gravity = Gravity.CENTER
    gifEmpty.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 14f)
    gifEmpty.visibility = View.GONE
    gifFrame.addView(gifEmpty, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(80f), Gravity.TOP))
    gifPage.addView(gifFrame, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

    gifStrip.layoutManager = LinearLayoutManager(context, LinearLayoutManager.HORIZONTAL, false)
    gifStrip.adapter = gifStripAdapter
    gifStrip.itemAnimator = null
    gifStrip.clipToPadding = false
    gifStrip.setPadding(dp(8f), 0, dp(8f), 0)
    gifStrip.overScrollMode = View.OVER_SCROLL_NEVER
    gifStrip.visibility = View.GONE
    gifPage.addView(gifStrip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(104f)))
  }

  @SuppressLint("ClickableViewAccessibility")
  private fun buildBottomBar() {
    bottomBar.addView(bottomLine, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, max(1, dp(0.5f)), Gravity.TOP))
    val pillBg = GradientDrawable()
    pillBg.cornerRadius = dp(16f).toFloat()
    segPill.background = pillBg
    segment.addView(segPill, FrameLayout.LayoutParams(dp(56f), dp(32f), Gravity.CENTER_VERTICAL))
    segRow.orientation = LinearLayout.HORIZONTAL
    segment.addView(segRow, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(32f), Gravity.CENTER_VERTICAL))
    segEmoji.setImageResource(R.drawable.ep_ic_smile)
    segSticker.setImageResource(R.drawable.ep_ic_sticker)
    for (iv in listOf(segEmoji, segSticker)) {
      iv.scaleType = ImageView.ScaleType.FIT_CENTER
      iv.setPadding(dp(16f), dp(5f), dp(16f), dp(5f))
    }
    segGif.text = "GIF"
    segGif.gravity = Gravity.CENTER
    segGif.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 13f)
    segGif.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    segGif.letterSpacing = 0.04f
    segEmoji.setOnClickListener { selectTab("emoji", animated = true, fromUser = true) }
    segSticker.setOnClickListener { selectTab("stickers", animated = true, fromUser = true) }
    segGif.setOnClickListener { selectTab("gif", animated = true, fromUser = true) }
    for (v in listOf<View>(segEmoji, segSticker, segGif)) segRow.addView(v, LinearLayout.LayoutParams(dp(56f), dp(32f)))
    segRow.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> moveSegPill(false) }
    bottomBar.addView(segment, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(44f), Gravity.START or Gravity.TOP).also { it.leftMargin = dp(8f) })

    backspace.setImageResource(R.drawable.ep_ic_backspace)
    backspace.scaleType = ImageView.ScaleType.FIT_CENTER
    backspace.setPadding(dp(11f), dp(11f), dp(11f), dp(11f))
    backspace.isClickable = true
    val repeat = object : Runnable {
      override fun run() {
        onBackspace(emptyMap<String, Any>())
        main.postDelayed(this, 100)
      }
    }
    backspace.setOnTouchListener { v, ev ->
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          v.animate().scaleX(0.85f).scaleY(0.85f).setDuration(80).start()
          v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
          onBackspace(emptyMap<String, Any>())
          main.postDelayed(repeat, 400)
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          main.removeCallbacks(repeat)
          v.animate().scaleX(1f).scaleY(1f).setDuration(160).setInterpolator(OvershootInterpolator(2f)).start()
        }
      }
      true
    }
    bottomBar.addView(backspace, FrameLayout.LayoutParams(dp(48f), dp(44f), Gravity.END or Gravity.TOP).also { it.rightMargin = dp(6f) })
  }

  // ───────────────────────── props ─────────────────────────

  fun setTheme(m: Map<String, Any?>) { theme.apply(m); themeDirty = true }
  fun setLabels(m: Map<String, String>) { if (m != labels) { labels = m; labelsDirty = true } }
  fun setTabProp(v: String) {
    val t = if (v == "stickers" || v == "gif") v else "emoji"
    if (!tabApplied) { tabApplied = true; selectTab(t, animated = false, fromUser = false); return }
    if (t != tab) selectTab(t, animated = true, fromUser = false)
  }
  fun setBottomInsetDp(v: Double) {
    val px = (v * density).toInt()
    if (px == bottomInsetPx) return
    bottomInsetPx = px
    bottomBar.setPadding(0, 0, 0, px)
    val lp = bottomBar.layoutParams as LinearLayout.LayoutParams
    lp.height = dp(44f) + px
    bottomBar.layoutParams = lp
  }
  fun setCompact(v: Boolean) { if (v != compact) { compact = v; applyCompact() } }
  fun setShowStickers(v: Boolean) { if (v != showStickers) { showStickers = v; segSticker.visibility = if (v) View.VISIBLE else View.GONE; post { moveSegPill(false) } } }
  fun setShowGifs(v: Boolean) { if (v != showGifs) { showGifs = v; segGif.visibility = if (v) View.VISIBLE else View.GONE; post { moveSegPill(false) } } }
  fun setStickerSections(v: List<Map<String, Any?>>) { sections = v; stickersDirty = true }
  fun setGifs(v: List<Map<String, Any?>>) { gifList = v; gifsDirty = true }
  fun setGifLoading(v: Boolean) { if (v != gifLoading) { gifLoading = v; gifsDirty = true } }

  fun didUpdateProps() {
    if (labelsDirty) {
      labelsDirty = false
      emojiSearch.setHint(labels["search"] ?: "")
      gifSearch.setHint(labels["gifSearch"] ?: "")
      emojiEmpty.text = labels["noResults"] ?: ""
      gifEmpty.text = labels["noResults"] ?: ""
      segEmoji.contentDescription = labels["emoji"]
      segSticker.contentDescription = labels["stickers"]
      segGif.contentDescription = labels["gif"]
      backspace.contentDescription = labels["backspace"]
      stickerMore.contentDescription = labels["more"]
      for ((i, iv) in catIcons.withIndex()) iv.contentDescription = if (i == 0) labels["recent"] else labels["cat${i - 1}"]
      rebuildEmoji()
    }
    if (themeDirty) { themeDirty = false; applyTheme() }
    if (stickersDirty) { stickersDirty = false; rebuildStickers() }
    if (gifsDirty) { gifsDirty = false; rebuildGifs() }
  }

  fun blurSearch() {
    for (f in listOf(emojiSearch, gifSearch)) if (f.edit.hasFocus()) f.blur()
  }

  fun resetSearch() {
    blurSearch()
    emojiSearch.setText("")
    gifSearch.setText("")
  }

  // ───────────────────────── tema ─────────────────────────

  private fun applyTheme() {
    val th = theme
    setBackgroundColor(th.background)
    rootFrame.setBackgroundColor(th.background)
    emojiSearch.applyTheme(th)
    gifSearch.applyTheme(th)
    (catPill.background as? GradientDrawable)?.setColor(th.selection)
    tintCats()
    emojiEmpty.setTextColor(th.secondary)
    gifEmpty.setTextColor(th.secondary)
    gifSpinner.indeterminateTintList = ColorStateList.valueOf(th.secondary)
    stickerTopLine.setBackgroundColor(th.hairline)
    stickerMore.imageTintList = ColorStateList.valueOf(th.icon)
    bottomBar.setBackgroundColor(th.background)
    bottomLine.setBackgroundColor(th.hairline)
    (segPill.background as? GradientDrawable)?.setColor(th.selection)
    tintSegment()
    backspace.imageTintList = ColorStateList.valueOf(th.icon)
    for (a in listOf(emojiAdapter, emojiStripAdapter, stickerAdapter, stickerTabsAdapter, gifAdapter, gifStripAdapter)) a.notifyDataSetChanged()
  }

  private fun tintCats() {
    for ((i, iv) in catIcons.withIndex()) iv.imageTintList = ColorStateList.valueOf(if (i == selectedCat) theme.iconActive else theme.icon)
  }

  private fun tintSegment() {
    segEmoji.imageTintList = ColorStateList.valueOf(if (tab == "emoji") theme.iconActive else theme.icon)
    segSticker.imageTintList = ColorStateList.valueOf(if (tab == "stickers") theme.iconActive else theme.icon)
    segGif.setTextColor(if (tab == "gif") theme.iconActive else theme.icon)
  }

  // ───────────────────────── abas ─────────────────────────

  private fun pageFor(t: String): View = when (t) { "stickers" -> stickerPage; "gif" -> gifPage; else -> emojiPage }
  private fun tabIndex(t: String): Int = when (t) { "stickers" -> 1; "gif" -> 2; else -> 0 }

  private fun selectTab(t: String, animated: Boolean, fromUser: Boolean) {
    if (t == "stickers" && !showStickers) return
    if (t == "gif" && !showGifs) return
    val old = tab
    if (t == old && pageFor(t).visibility == View.VISIBLE) { if (fromUser) onTabChange(mapOf("tab" to t)); return }
    blurSearch()
    tab = t
    val newPage = pageFor(t)
    val oldPage = pageFor(old)
    val dir = if (tabIndex(t) >= tabIndex(old)) 1 else -1
    if (animated && oldPage !== newPage) {
      newPage.animate().cancel(); oldPage.animate().cancel()
      newPage.visibility = View.VISIBLE
      newPage.alpha = 0f
      newPage.translationX = dp(28f).toFloat() * dir
      newPage.animate().alpha(1f).translationX(0f).setDuration(230).setInterpolator(DecelerateInterpolator(2f)).start()
      oldPage.animate().alpha(0f).translationX(-dp(28f).toFloat() * dir).setDuration(180)
        .withEndAction { if (tab != old) { oldPage.visibility = View.INVISIBLE; oldPage.translationX = 0f; oldPage.alpha = 1f } }
        .start()
    } else {
      for (p in listOf(emojiPage, stickerPage, gifPage)) {
        p.animate().cancel()
        p.alpha = 1f; p.translationX = 0f
        p.visibility = if (p === newPage) View.VISIBLE else View.INVISIBLE
      }
    }
    val showBs = t == "emoji"
    backspace.animate().cancel()
    if (showBs) { backspace.visibility = View.VISIBLE; backspace.animate().alpha(1f).setDuration(150).start() }
    else backspace.animate().alpha(0f).setDuration(120).withEndAction { if (tab != "emoji") backspace.visibility = View.INVISIBLE }.start()
    moveSegPill(animated)
    tintSegment()
    if (t == "stickers") requestFirstStickerSection()
    if (fromUser) onTabChange(mapOf("tab" to t))
  }

  private fun moveSegPill(animated: Boolean) {
    val target = when (tab) { "stickers" -> segSticker; "gif" -> segGif; else -> segEmoji }
    if (target.visibility != View.VISIBLE || target.width == 0) return
    val x = target.left.toFloat()
    if (animated) segPill.animate().translationX(x).setDuration(320).setInterpolator(OvershootInterpolator(1.1f)).start()
    else { segPill.animate().cancel(); segPill.translationX = x }
  }

  private fun moveCatPill(i: Int, animated: Boolean) {
    val iv = catIcons.getOrNull(i) ?: return
    if (iv.width == 0) return
    val x = iv.left + (iv.width - dp(34f)) / 2f
    if (animated) catPill.animate().translationX(x).setDuration(280).setInterpolator(OvershootInterpolator(1.0f)).start()
    else { catPill.animate().cancel(); catPill.translationX = x }
    tintCats()
  }

  private fun scrollToCategory(i: Int) {
    if (emojiQuery.isNotEmpty()) emojiSearch.setText("")
    val pos = sectionStart.getOrNull(i) ?: -1
    selectedCat = i
    moveCatPill(i, true)
    if (pos >= 0) emojiLayout.scrollToPositionWithOffset(pos, 0)
    else if (i == 0) emojiLayout.scrollToPositionWithOffset(0, 0)
  }

  private fun applyCompact() {
    emojiSearch.visibility = View.VISIBLE
    catStrip.visibility = if (compact) View.GONE else View.VISIBLE
    emojiGridFrame.visibility = if (compact) View.GONE else View.VISIBLE
    emojiStrip.visibility = if (compact) View.VISIBLE else View.GONE
    gifFrame.visibility = if (compact) View.GONE else View.VISIBLE
    gifStrip.visibility = if (compact) View.VISIBLE else View.GONE
    bottomBar.visibility = if (compact) View.GONE else View.VISIBLE
    if (compact) rebuildEmojiStrip()
  }

  private fun emitSearchFocus(f: Boolean) {
    onSearchFocus(mapOf("focused" to f, "tab" to tab))
  }

  // ───────────────────────── emoji ─────────────────────────

  private fun rebuildEmoji() {
    if (!dataReady) return
    val items = ArrayList<EPItem>(2100)
    val starts = IntArray(EPEmojiData.CATEGORY_COUNT + 1) { -1 }
    if (emojiQuery.isNotEmpty()) {
      for (e in EPEmojiData.search(emojiQuery)) items.add(emoItem(e))
      emojiEmpty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
    } else {
      emojiEmpty.visibility = View.GONE
      if (prefs.recents.isNotEmpty()) {
        starts[0] = items.size
        items.add(EPItem.Header(labels["recent"] ?: ""))
        for (r in prefs.recents) items.add(EPItem.Emo(r, r, false))
      }
      for (c in 0 until EPEmojiData.CATEGORY_COUNT) {
        val list = EPEmojiData.category(c)
        if (list.isEmpty()) continue
        starts[c + 1] = items.size
        items.add(EPItem.Header(labels["cat$c"] ?: ""))
        for (e in list) items.add(emoItem(e))
      }
    }
    sectionStart = starts
    emojiAdapter.submit(items)
    if (compact) rebuildEmojiStrip()
  }

  private fun emoItem(e: EPEmoji): EPItem.Emo =
    EPItem.Emo(if (e.tone) prefs.preferred(e.emoji) else e.emoji, e.emoji, e.tone)

  private fun rebuildEmojiStrip() {
    if (!dataReady) return
    val list: List<EPItem> = if (emojiQuery.isNotEmpty()) EPEmojiData.search(emojiQuery, 120).map { emoItem(it) }
    else if (prefs.recents.isNotEmpty()) prefs.recents.map { EPItem.Emo(it, it, false) }
    else EPEmojiData.category(0).take(40).map { emoItem(it) }
    emojiStripAdapter.submit(list)
  }

  private fun pick(item: EPItem.Emo, emoji: String) {
    prefs.pushRecent(emoji)
    onEmoji(mapOf("emoji" to emoji))
  }

  private fun pop(v: View) {
    v.animate().cancel()
    v.scaleX = 0.8f; v.scaleY = 0.8f
    v.animate().scaleX(1f).scaleY(1f).setDuration(260).setInterpolator(OvershootInterpolator(3f)).start()
  }

  override fun newEmojiTouch(): View.OnTouchListener = EmojiTouch()

  private inner class EmojiTouch : View.OnTouchListener {
    private var downX = 0f
    private var downY = 0f
    private var longFired = false
    private var target: View? = null
    private val longRunnable = Runnable {
      val v = target ?: return@Runnable
      val item = v.tag as? EPItem.Emo ?: return@Runnable
      if (!item.tone) return@Runnable
      longFired = true
      v.parent?.requestDisallowInterceptTouchEvent(true)
      v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      showTones(v, item)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouch(v: View, ev: MotionEvent): Boolean {
      val item = v.tag as? EPItem.Emo ?: return false
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = ev.rawX; downY = ev.rawY
          longFired = false
          target = v
          v.animate().scaleX(0.84f).scaleY(0.84f).setDuration(90).start()
          if (item.tone) main.postDelayed(longRunnable, 330)
          return true
        }
        MotionEvent.ACTION_MOVE -> {
          if (longFired) { trackTones(ev.rawX); return true }
          if (abs(ev.rawX - downX) > touchSlop || abs(ev.rawY - downY) > touchSlop) {
            main.removeCallbacks(longRunnable)
            v.animate().scaleX(1f).scaleY(1f).setDuration(120).start()
          }
          return true
        }
        MotionEvent.ACTION_UP -> {
          main.removeCallbacks(longRunnable)
          if (longFired) {
            val chosen = toneVariants.getOrNull(toneSel)
            dismissTones()
            v.animate().scaleX(1f).scaleY(1f).setDuration(120).start()
            if (chosen != null) {
              prefs.setPreferred(item.base, chosen)
              pick(item, chosen)
              rebuildEmojiKeepScroll()
            }
          } else if (abs(ev.rawX - downX) <= touchSlop && abs(ev.rawY - downY) <= touchSlop) {
            pop(v)
            pick(item, item.display)
          } else {
            v.animate().scaleX(1f).scaleY(1f).setDuration(120).start()
          }
          longFired = false
          return true
        }
        MotionEvent.ACTION_CANCEL -> {
          main.removeCallbacks(longRunnable)
          if (longFired) dismissTones()
          longFired = false
          v.animate().scaleX(1f).scaleY(1f).setDuration(120).start()
          return true
        }
      }
      return true
    }
  }

  private fun rebuildEmojiKeepScroll() {
    val first = emojiLayout.findFirstVisibleItemPosition()
    val top = emojiLayout.findViewByPosition(first)?.top ?: 0
    rebuildEmoji()
    if (first >= 0 && emojiQuery.isEmpty()) emojiLayout.scrollToPositionWithOffset(first, top - emojiGrid.paddingTop)
  }

  private fun showTones(anchor: View, item: EPItem.Emo) {
    dismissTones()
    val variants = EPEmojiData.variants(item.base)
    toneVariants = variants
    val cur = variants.indexOf(prefs.preferred(item.base))
    toneSel = if (cur >= 0) cur else 0
    val cell = dp(44f)
    val pad = dp(4f)
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.setPadding(pad, pad, pad, pad)
    val bg = GradientDrawable()
    bg.cornerRadius = dp(14f).toFloat()
    bg.setColor(if (theme.dark) 0xFF2C2C2E.toInt() else Color.WHITE)
    bg.setStroke(max(1, dp(0.5f)), theme.hairline)
    row.background = bg
    row.elevation = dp(10f).toFloat()
    for ((i, s) in variants.withIndex()) {
      val tv = TextView(context)
      tv.text = s
      tv.gravity = Gravity.CENTER
      tv.includeFontPadding = false
      tv.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 28f)
      val b = GradientDrawable()
      b.cornerRadius = dp(10f).toFloat()
      b.setColor(if (i == toneSel) theme.selection else Color.TRANSPARENT)
      tv.background = b
      row.addView(tv, LinearLayout.LayoutParams(cell, dp(48f)))
    }
    val w = cell * variants.size + pad * 2
    val h = dp(48f) + pad * 2
    val loc = IntArray(2)
    anchor.getLocationInWindow(loc)
    val rootW = rootView?.width ?: resources.displayMetrics.widthPixels
    val x = (loc[0] + anchor.width / 2 - w / 2).coerceIn(dp(4f), max(dp(4f), rootW - w - dp(4f)))
    val y = max(0, loc[1] - h - dp(6f))
    // margem extra (10dp) p/ a sombra (elevation) não ser cortada
    val wrap = FrameLayout(context)
    wrap.addView(row, FrameLayout.LayoutParams(w, h, Gravity.CENTER))
    val pw = PopupWindow(wrap, w + dp(20f), h + dp(20f), false)
    pw.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
    pw.isTouchable = false
    pw.isOutsideTouchable = false
    pw.isClippingEnabled = false
    try {
      pw.showAtLocation(this, Gravity.NO_GRAVITY, x - dp(10f), y - dp(10f))
    } catch (_: Throwable) { return }
    row.pivotX = (loc[0] + anchor.width / 2f - x).coerceIn(0f, w.toFloat())
    row.pivotY = h.toFloat()
    row.scaleX = 0.5f; row.scaleY = 0.5f; row.alpha = 0f
    row.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(220).setInterpolator(OvershootInterpolator(1.6f)).start()
    tonePopup = pw
    toneRow = row
  }

  private fun trackTones(rawX: Float) {
    val row = toneRow ?: return
    val loc = IntArray(2)
    row.getLocationOnScreen(loc)
    val cell = dp(44f)
    val idx = ((rawX - loc[0] - row.paddingLeft) / cell).toInt().coerceIn(0, toneVariants.size - 1)
    if (idx == toneSel) return
    toneSel = idx
    row.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    for (i in 0 until row.childCount) {
      val c = row.getChildAt(i)
      (c.background as? GradientDrawable)?.setColor(if (i == idx) theme.selection else Color.TRANSPARENT)
      c.animate().scaleX(if (i == idx) 1.15f else 1f).scaleY(if (i == idx) 1.15f else 1f).setDuration(120).start()
    }
  }

  private fun dismissTones() {
    try { tonePopup?.dismiss() } catch (_: Throwable) {}
    tonePopup = null
    toneRow = null
  }

  // ───────────────────────── figurinhas ─────────────────────────

  @Suppress("UNCHECKED_CAST")
  private fun itemsOf(s: Map<String, Any?>): List<Map<String, Any?>> =
    (s["items"] as? List<*>)?.mapNotNull { it as? Map<String, Any?> } ?: emptyList()

  private fun rebuildStickers() {
    val tabs = ArrayList<EPItem>()
    val grid = ArrayList<EPItem>()
    val starts = LinkedHashMap<String, Int>()
    for (s in sections) {
      val key = s["key"] as? String ?: continue
      val title = s["title"] as? String ?: ""
      tabs.add(EPItem.Tab(key, s["icon"] as? String ?: "pack", s["coverUri"] as? String, title))
      starts[key] = grid.size
      grid.add(EPItem.Header(title))
      val its = itemsOf(s)
      if (its.isEmpty() && (s["loading"] as? Boolean) == true) grid.add(EPItem.Spinner(key))
      for (it in its) {
        val uri = it["uri"] as? String ?: continue
        grid.add(EPItem.Sticker(it["key"] as? String ?: uri, uri, key))
      }
    }
    stickerSectionStart = starts
    if (selectedStickerSection == null || !starts.containsKey(selectedStickerSection)) selectedStickerSection = starts.keys.firstOrNull()
    stickerTabsAdapter.submit(tabs)
    stickerAdapter.submit(grid)
    if (tab == "stickers") requestFirstStickerSection()
  }

  private fun requestFirstStickerSection() {
    val k = selectedStickerSection ?: return
    val s = sections.firstOrNull { (it["key"] as? String) == k } ?: return
    if (itemsOf(s).isEmpty() && requestedSections.add(k)) onSection(mapOf("key" to k))
  }

  override fun isTabSelected(key: String): Boolean = key == selectedStickerSection

  override fun onTabTap(item: EPItem.Tab) {
    selectedStickerSection = item.key
    stickerTabsAdapter.notifyDataSetChanged()
    val pos = stickerSectionStart[item.key]
    if (pos != null) stickerLayout.scrollToPositionWithOffset(pos, 0)
    onSection(mapOf("key" to item.key))
    requestedSections.add(item.key)
  }

  override fun onStickerTap(v: View, item: EPItem.Sticker) {
    pop(v)
    onSticker(mapOf("key" to item.key, "uri" to item.uri, "section" to item.section))
  }

  // ───────────────────────── GIF ─────────────────────────

  private fun rebuildGifs() {
    val list = ArrayList<EPItem>(gifList.size)
    for (g in gifList) {
      val uri = g["uri"] as? String ?: continue
      list.add(EPItem.Gif(g["key"] as? String ?: uri, uri, (g["width"] as? Number)?.toDouble() ?: 0.0, (g["height"] as? Number)?.toDouble() ?: 0.0))
    }
    gifAdapter.submit(list)
    gifStripAdapter.submit(list)
    updateGifState()
  }

  private fun updateGifState() {
    val empty = gifAdapter.itemCount == 0
    gifSpinner.visibility = if (gifLoading && empty) View.VISIBLE else View.GONE
    gifEmpty.visibility = if (!gifLoading && empty && gifQuery.isNotEmpty()) View.VISIBLE else View.GONE
  }

  override fun onGifTap(v: View, item: EPItem.Gif) {
    pop(v)
    onGif(mapOf("key" to item.key))
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    main.removeCallbacksAndMessages(null)
    dismissTones()
  }
}

/** Campo de busca arredondado (lupa + EditText + limpar). */
internal class EPSearchField(context: Context) : FrameLayout(context) {
  private val density = resources.displayMetrics.density
  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()
  private val bg = GradientDrawable()
  private val icon = ImageView(context)
  private val clear = ImageView(context)
  val edit: EditText = object : EditText(context) {
    override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
      if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP && hasFocus()) {
        post { blur() }
      }
      return super.onKeyPreIme(keyCode, event)
    }
  }
  var onText: ((String) -> Unit)? = null
  var onFocus: ((Boolean) -> Unit)? = null
  private var suppress = false

  init {
    bg.cornerRadius = dp(10f).toFloat()
    background = bg
    icon.setImageResource(R.drawable.ep_ic_search)
    icon.scaleType = ImageView.ScaleType.FIT_CENTER
    addView(icon, LayoutParams(dp(18f), dp(18f), Gravity.START or Gravity.CENTER_VERTICAL).also { it.leftMargin = dp(10f) })
    edit.background = null
    edit.setPadding(0, 0, 0, 0)
    edit.setSingleLine(true)
    edit.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 15f)
    edit.imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    edit.gravity = Gravity.CENTER_VERTICAL
    addView(edit, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).also { it.leftMargin = dp(36f); it.rightMargin = dp(34f) })
    clear.setImageResource(R.drawable.ep_ic_clear)
    clear.scaleType = ImageView.ScaleType.FIT_CENTER
    clear.setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
    clear.visibility = View.GONE
    clear.setOnClickListener { setText("") }
    addView(clear, LayoutParams(dp(34f), dp(34f), Gravity.END or Gravity.CENTER_VERTICAL))
    edit.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        val t = s?.toString() ?: ""
        clear.visibility = if (t.isEmpty()) View.GONE else View.VISIBLE
        if (!suppress) onText?.invoke(t.trim())
      }
    })
    edit.setOnFocusChangeListener { _, f -> onFocus?.invoke(f) }
    edit.setOnEditorActionListener { _, _, _ -> blur(); true }
  }

  fun setHint(h: String) { edit.hint = h }

  fun setText(t: String) {
    if (edit.text?.toString() == t) return
    edit.setText(t)
  }

  fun blur() {
    // Foco vai p/ o próprio campo-pai (focável) — sem isso, em touch mode
    // (Android < 9) o sistema daria foco ao 1º EditText da janela (composer).
    try {
      isFocusableInTouchMode = true
      requestFocus()
    } catch (_: Throwable) {}
    try {
      val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
      imm?.hideSoftInputFromWindow(edit.windowToken, 0)
    } catch (_: Throwable) {}
    edit.clearFocus()
  }

  fun applyTheme(th: EPTheme) {
    bg.setColor(th.surface)
    icon.imageTintList = ColorStateList.valueOf(th.secondary)
    clear.imageTintList = ColorStateList.valueOf(th.secondary)
    edit.setTextColor(th.text)
    edit.setHintTextColor(th.secondary)
  }
}
