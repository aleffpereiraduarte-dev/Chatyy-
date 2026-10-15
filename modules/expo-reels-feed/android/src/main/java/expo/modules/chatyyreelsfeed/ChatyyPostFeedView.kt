package expo.modules.chatyyreelsfeed

// [2026-10-15 native-feed] Aba FEED (posts) em NATIVO (Android): RecyclerView
// + DiffUtil (payload, sem piscar) + SwipeRefreshLayout; filhos RN = topo da
// aba (busca, abas, stories, lives, sugestões) e rodapé. Vídeo: pool de 3
// ExoPlayer dos Reels (RFPlayerPool/RFCache) — só o post mais visível (≥ 60 %
// da mídia) toca, mudo por padrão (toque alterna o som), os próximos vídeos
// ficam pré-carregados. Mesmo contrato do iOS (ios/FDPostFeedView.swift).

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.max
import kotlin.math.min

/** Contêiner do filho RN (header/rodapé) dentro da lista. */
internal class FDChildHost(ctx: Context, private val hint: () -> Int) : ViewGroup(ctx) {
  private val relayout = View.OnLayoutChangeListener { _, _, top, _, bottom, _, oldTop, _, oldBottom ->
    if (bottom - top != oldBottom - oldTop) post { requestLayout() }
  }

  init {
    clipChildren = false
    clipToPadding = false
  }

  fun attach(child: View) {
    if (child.parent === this) return
    (child.parent as? ViewGroup)?.removeView(child)
    addView(child)
    child.addOnLayoutChangeListener(relayout)
  }

  fun detach(child: View) {
    child.removeOnLayoutChangeListener(relayout)
    if (child.parent === this) removeView(child)
  }

  private fun contentHeight(): Int {
    var h = 0
    for (i in 0 until childCount) h = max(h, getChildAt(i).bottom)
    return if (h > 0) h else hint()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), contentHeight())
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {}
}

@SuppressLint("ViewConstructor")
class ChatyyPostFeedView(context: Context, appContext: AppContext) : ExpoView(context, appContext),
  RFPlayerPool.Listener, FDPostView.Host {
  override val shouldUseAndroidLayout: Boolean = true

  val onPostAction by EventDispatcher()
  val onEndReached by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onScrollState by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  // Dados
  private val rows = HashMap<String, FDRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private val dirty = HashSet<String>()
  private var pendingReset = false
  private var needsApply = false
  private var firstPaintSent = false
  private val expanded = HashSet<String>()
  private val pageById = HashMap<String, Int>()

  // Aparência
  private var dark = false
  private var paletteMap: Map<String, Any?>? = null
  private var palette = FDPalette(false)
  private var paletteDirty = true
  private var labels = FDLabels()
  private var bottomInsetPx = 0
  private var headerHintPx = 0
  private var footerHintPx = 0
  private var scrollTopSeq = 0.0

  // Vídeo
  private var pool: RFPlayerPool? = null
  private var currentKey = ""
  private var currentRowId = ""
  private var muted = true
  private var paused = false
  private var destroyed = false

  // Rolagem
  private var stateTop = false
  private var stateHidden = false
  private var scrollY = 0
  private var endSentForCount = -1

  // Filhos RN
  private val rnChildren = ArrayList<View>()
  private val headerHost = FDChildHost(context) { headerHintPx }
  private val footerHost = FDChildHost(context) { footerHintPx }

  private val refresh = SwipeRefreshLayout(context)
  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()

  private fun pool(): RFPlayerPool? {
    if (destroyed) return null
    return pool ?: try { RFPlayerPool(context, this).also { pool = it } } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("pool: " + (e.message ?: e.javaClass.simpleName))))
      null
    }
  }

  // ─── Props ───────────────────────────────────────────────────────────────

  fun setRowsPatch(p: Map<String, Any?>?) {
    if (p == null) return
    try {
      val pseq = FDVal.num(p["seq"])
      val reset = FDVal.list(p["reset"])
      if (reset != null) {
        if (pseq == seq && firstPaintSent) return
        rows.clear()
        val ids = ArrayList<String>()
        for (item in reset) {
          val r = FDVal.map(item)?.let { FDRow.from(it) } ?: continue
          if (!rows.containsKey(r.id)) ids.add(r.id)
          rows[r.id] = r
        }
        order = FDVal.list(p["order"])?.map { FDVal.str(it) } ?: ids
        seq = pseq
        pendingReset = true
        needsApply = true
        return
      }
      if (pseq <= seq) return
      val base = FDVal.num(p["base"])
      if (base != seq) {
        if (resyncAskedFor != seq) {
          resyncAskedFor = seq
          onResync(mapOf("seq" to seq))
        }
        return
      }
      FDVal.list(p["remove"])?.forEach { rows.remove(FDVal.str(it)) }
      val hasOrder = p["order"] != null
      val appended = ArrayList<String>()
      FDVal.list(p["upsert"])?.forEach { item ->
        val r = FDVal.map(item)?.let { FDRow.from(it) } ?: return@forEach
        if (!rows.containsKey(r.id) && !hasOrder) appended.add(r.id)
        rows[r.id] = r
        dirty.add(r.id)
      }
      val ord = FDVal.list(p["order"])
      order = if (ord != null) ord.map { FDVal.str(it) } else order + appended
      seq = pseq
      needsApply = true
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("patch: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  fun setDark(d: Boolean) {
    if (d == dark && !paletteDirty) return
    dark = d
    paletteDirty = true
  }

  fun setPaletteProp(m: Map<String, Any?>?) {
    paletteMap = m
    paletteDirty = true
  }

  fun setLabelsProp(m: Map<String, Any?>?) {
    labels = FDLabels(m)
    paletteDirty = true
  }

  fun setImageHeaders(m: Map<String, Any?>?) {
    val h = HashMap<String, String>()
    m?.forEach { (k, v) -> if (v is String && v.isNotEmpty()) h[k] = v }
    if (h.isNotEmpty()) RFImageAuth.headers = h
  }

  fun setHeaderHeightHint(v: Double) {
    headerHintPx = (max(0.0, v) * density).toInt()
    headerHost.requestLayout()
  }

  fun setFooterHeightHint(v: Double) {
    footerHintPx = (max(0.0, v) * density).toInt()
    footerHost.requestLayout()
  }

  fun setBottomInset(v: Double) {
    val px = (max(0.0, v) * density).toInt()
    if (px != bottomInsetPx) {
      bottomInsetPx = px
      recycler.setPadding(0, 0, 0, px)
    }
  }

  fun setRefreshingProp(on: Boolean) {
    if (!on && refresh.isRefreshing) refresh.isRefreshing = false
  }

  fun setRefreshTint(hex: String?) {
    val c = FDPalette.parse(hex ?: "") ?: return
    refresh.setColorSchemeColors(c)
  }

  fun setPausedProp(p: Boolean) {
    if (p == paused) return
    paused = p
    if (p) pool?.pauseAll() else main.post { updateActive(true) }
  }

  fun setScrollToTopSeq(s: Double) {
    if (s == scrollTopSeq) return
    val first = scrollTopSeq == 0.0
    scrollTopSeq = s
    if (first && s == 0.0) return
    recycler.smoothScrollToPosition(0)
  }

  fun commitProps() {
    var rebindAll = false
    if (paletteDirty) {
      palette = FDPalette(dark, paletteMap)
      setBackgroundColor(palette.bg)
      recycler.setBackgroundColor(palette.bg)
      refresh.setProgressBackgroundColorSchemeColor(if (dark) 0xFF1A1A1A.toInt() else 0xFFFFFFFF.toInt())
      paletteDirty = false
      rebindAll = true
    }
    applyData(rebindAll)
  }

  // ─── Dados → adapter ─────────────────────────────────────────────────────

  private sealed class Item {
    object Header : Item()
    object Footer : Item()
    data class Row(val id: String) : Item()
  }

  private var items: List<Item> = listOf(Item.Header, Item.Footer)
  private val stableIds = HashMap<String, Long>()
  private var nextStable = 10L

  private fun stableId(id: String): Long = stableIds.getOrPut(id) { nextStable++ }

  private fun applyData(rebindAll: Boolean) {
    if (!needsApply && !rebindAll && firstPaintSent) return
    needsApply = false
    try {
      val seen = HashSet<String>()
      val ids = ArrayList<String>(order.size)
      for (id in order) if (rows.containsKey(id) && seen.add(id)) ids.add(id)
      if (ids.size < rows.size) rows.keys.retainAll(seen)
      order = ids
      expanded.retainAll(seen)
      pageById.keys.retainAll(seen)
      val next = ArrayList<Item>(ids.size + 2)
      next.add(Item.Header)
      for (id in ids) next.add(Item.Row(id))
      next.add(Item.Footer)
      val old = items
      val changed = if (rebindAll || pendingReset) HashSet(ids) else HashSet(dirty)
      dirty.clear()
      val reset = pendingReset
      pendingReset = false
      if (reset && old.size <= 2) {
        items = next
        adapter.notifyDataSetChanged()
      } else {
        val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
          override fun getOldListSize() = old.size
          override fun getNewListSize() = next.size
          override fun areItemsTheSame(o: Int, n: Int): Boolean = old[o] == next[n]
          override fun areContentsTheSame(o: Int, n: Int): Boolean {
            val it = next[n]
            return !(it is Item.Row && changed.contains(it.id))
          }
          override fun getChangePayload(o: Int, n: Int): Any = PAYLOAD_BIND
        }, true)
        items = next
        diff.dispatchUpdatesTo(adapter)
      }
      if (!firstPaintSent) {
        firstPaintSent = true
        recycler.post { onFirstPaint(mapOf("count" to ids.size)) }
      }
      recycler.post { updateActive(true) }
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("apply: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  private fun rebindRow(id: String) {
    val p = items.indexOfFirst { it is Item.Row && it.id == id }
    if (p >= 0) adapter.notifyItemChanged(p, PAYLOAD_BIND)
  }

  // ─── Filhos RN (GroupView) ───────────────────────────────────────────────

  fun addRnChild(child: View, index: Int) {
    val i = index.coerceIn(0, rnChildren.size)
    rnChildren.add(i, child)
    reattachChildren()
  }

  fun rnChildCount(): Int = rnChildren.size

  fun rnChildAt(index: Int): View? = rnChildren.getOrNull(index)

  fun removeRnChild(child: View) {
    headerHost.detach(child)
    footerHost.detach(child)
    rnChildren.remove(child)
    reattachChildren()
  }

  fun removeRnChildAt(index: Int) {
    val c = rnChildren.getOrNull(index) ?: return
    removeRnChild(c)
  }

  private fun reattachChildren() {
    rnChildren.forEachIndexed { i, v -> if (i == 0) headerHost.attach(v) else footerHost.attach(v) }
    headerHost.requestLayout()
    footerHost.requestLayout()
  }

  // ─── Vídeo (post ativo) ──────────────────────────────────────────────────

  private fun postViews(): List<FDPostView> {
    val out = ArrayList<FDPostView>()
    for (i in 0 until recycler.childCount) {
      val v = recycler.getChildAt(i)
      if (v is FDPostView) out.add(v)
    }
    out.sortBy { it.top }
    return out
  }

  private fun videoItem(r: FDRow, page: Int): RFItem? {
    val m = r.media.getOrNull(page) ?: return null
    if (!m.video) return null
    val it = RFItem(r.videoKey(page))
    it.apply(mapOf("videoUrl" to m.url, "thumb" to m.poster))
    return it
  }

  private val canPlay: Boolean
    get() = !paused && !destroyed && isAttachedToWindow && windowVisibility == View.VISIBLE && visibility == View.VISIBLE

  private fun updateActive(force: Boolean = false) {
    if (destroyed) return
    val h = recycler.height
    if (h <= 0) return
    var active: FDPostView? = null
    for (v in postViews()) {
      val mh = v.mediaHeight()
      if (mh <= 0) continue
      val t = v.mediaTop()
      val vis = min(h, t + mh) - max(0, t)
      if (vis.toFloat() / mh >= 0.6f) { active = v; break }
    }
    val rowId = active?.row?.id ?: ""
    var key = ""
    val wanted = ArrayList<RFItem>()
    val ar = active?.row
    if (active != null && ar != null) {
      videoItem(ar, active.page)?.let { key = it.id; wanted.add(it) }
    }
    var idx = if (rowId.isNotEmpty()) order.indexOf(rowId) + 1 else {
      val first = postViews().firstOrNull()?.row?.id
      if (first != null) max(0, order.indexOf(first)) else 0
    }
    var ahead = 0
    val glide = try { com.bumptech.glide.Glide.with(context.applicationContext) } catch (_: Throwable) { null }
    while (idx in order.indices && ahead < 4 && wanted.size < 3) {
      val r = rows[order[idx]]
      if (r != null) {
        val vp = r.media.indexOfFirst { it.video }
        val it = if (vp >= 0) videoItem(r, vp) else null
        if (it != null && it.id != key) {
          wanted.add(it)
          if (RFCache.isCacheable(it.videoUrl)) RFCache.prefetch(context, it.videoUrl)
        } else {
          r.media.firstOrNull()?.let { m ->
            val u = if (m.video) m.poster else m.url
            if (u.isNotEmpty()) try { glide?.downloadOnly()?.load(u)?.submit() } catch (_: Throwable) {}
          }
        }
      }
      idx++
      ahead++
    }
    if (!force && key == currentKey && rowId == currentRowId) return
    currentKey = key
    currentRowId = rowId
    val pl = if (wanted.isNotEmpty() || pool != null) pool() else null
    pl?.assign(wanted, key)
    val slot = if (key.isNotEmpty()) pl?.slotFor(key) else null
    for (v in postViews()) {
      if (v.row?.id == rowId && slot != null) {
        v.attach(slot)
        v.setMuted(muted)
      } else {
        v.attach(null)
      }
    }
    playCurrent()
  }

  private fun playCurrent() {
    val pl = pool ?: return
    val s = pl.slotFor(currentKey) ?: return
    if (!canPlay) {
      if (s.player.playWhenReady) s.player.playWhenReady = false
      return
    }
    pl.setAudible(s, !muted)
    if (!s.player.playWhenReady) s.player.playWhenReady = true
  }

  // RFPlayerPool.Listener
  override fun onSlotReady(s: RFSlot) { if (s.itemId == currentKey) playCurrent() }
  override fun onSlotLooped(s: RFSlot) {}
  override fun onSlotFailed(s: RFSlot) {
    if (s.itemId != currentKey) return
    postViews().firstOrNull { it.row?.id == currentRowId }?.markFailed()
  }
  override fun onSlotFirstFrame(s: RFSlot) { postViews().forEach { it.onSlotFrame(s) } }
  override fun onSlotVideoSize(s: RFSlot) { postViews().forEach { it.onSlotFrame(s) } }

  // ─── FDPostView.Host ─────────────────────────────────────────────────────

  override fun onPostAction(view: FDPostView, action: String, value: String) {
    val r = view.row ?: return
    val payload = HashMap<String, Any>()
    payload["id"] = r.id
    payload["action"] = action
    payload["value"] = value
    when (action) {
      "like" -> {
        r.liked = !r.liked
        r.likes = max(0, r.likes + if (r.liked) 1 else -1)
        view.performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
        view.applyLike(r.liked, true)
        payload["liked"] = r.liked
        payload["likes"] = r.likes
        rebindRow(r.id)
      }
      "save" -> {
        r.saved = !r.saved
        view.performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
        view.applySave(r.saved, true)
        payload["saved"] = r.saved
      }
    }
    onPostAction(payload)
  }

  override fun onDoubleTap(view: FDPostView) {
    val r = view.row ?: return
    view.burstHeart()
    if (!r.liked) onPostAction(view, "like", "double_tap")
  }

  override fun onSingleTapMedia(view: FDPostView) {
    if (!view.currentPageIsVideo) return
    muted = !muted
    view.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
    postViews().forEach { it.setMuted(muted) }
    if (view.row?.id != currentRowId) updateActive(true) else playCurrent()
  }

  override fun onPageChanged(view: FDPostView, page: Int) {
    val r = view.row ?: return
    pageById[r.id] = page
    updateActive(true)
  }

  override fun onToggleExpand(view: FDPostView) {
    val r = view.row ?: return
    if (!expanded.add(r.id)) expanded.remove(r.id)
    rebindRow(r.id)
  }

  // ─── Rolagem ─────────────────────────────────────────────────────────────

  private fun onListScrolled(dy: Int) {
    scrollY = if (layoutManager.findFirstVisibleItemPosition() == 0) {
      val v = layoutManager.findViewByPosition(0)
      if (v != null) -v.top else scrollY + dy
    } else scrollY + dy
    val y = scrollY / density
    val dyDp = dy / density
    val nearEnd = !recycler.canScrollVertically(1)
    val top = y > 800
    var hidden = stateHidden
    if (y < 80 || nearEnd) hidden = false else if (dyDp > 6) hidden = true else if (dyDp < -6) hidden = false
    if (top != stateTop || hidden != stateHidden) {
      stateTop = top
      stateHidden = hidden
      onScrollState(mapOf("top" to top, "hidden" to hidden))
    }
    val last = layoutManager.findLastVisibleItemPosition()
    if (order.isNotEmpty() && endSentForCount != order.size && last >= items.size - 4) {
      endSentForCount = order.size
      onEndReached(mapOf<String, Any>())
    }
    updateActive()
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class HostHolder(v: View) : RecyclerView.ViewHolder(v)
  private class PostHolder(val post: FDPostView) : RecyclerView.ViewHolder(post)

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (items[position]) {
      is Item.Header -> TYPE_HEADER
      is Item.Footer -> TYPE_FOOTER
      is Item.Row -> TYPE_POST
    }

    override fun getItemId(position: Int): Long = when (val it = items[position]) {
      is Item.Header -> 1L
      is Item.Footer -> 2L
      is Item.Row -> stableId(it.id)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      if (viewType == TYPE_HEADER || viewType == TYPE_FOOTER) {
        val host = if (viewType == TYPE_HEADER) headerHost else footerHost
        (host.parent as? ViewGroup)?.removeView(host)
        host.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
        val h = HostHolder(host)
        h.setIsRecyclable(false)
        return h
      }
      return PostHolder(FDPostView(parent.context, this@ChatyyPostFeedView))
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      val item = items.getOrNull(position) as? Item.Row ?: return
      val row = rows[item.id] ?: return
      try {
        (holder as? PostHolder)?.post?.bind(row, pageById[item.id] ?: 0, expanded.contains(item.id), muted, labels, palette)
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
      (holder as? PostHolder)?.post?.attach(null)
    }
  }

  init {
    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.setItemViewCacheSize(3)
    recycler.itemAnimator = null
    refresh.addView(recycler, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    refresh.setOnRefreshListener {
      onRefresh(mapOf<String, Any>())
      main.postDelayed({ if (refresh.isRefreshing) refresh.isRefreshing = false }, 8000L)
    }
    addView(refresh, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) { onListScrolled(dy) }
      override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_IDLE) updateActive(true)
      }
    })
    setBackgroundColor(palette.bg)
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    if (visibility != View.VISIBLE) pool?.pauseAll() else main.post { updateActive(true) }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    destroyed = false
  }

  override fun onDetachedFromWindow() {
    main.removeCallbacksAndMessages(null)
    postViews().forEach { it.attach(null) }
    pool?.release()
    pool = null
    currentKey = ""
    currentRowId = ""
    super.onDetachedFromWindow()
  }

  companion object {
    private const val TYPE_HEADER = 0
    private const val TYPE_POST = 1
    private const val TYPE_FOOTER = 2
    private val PAYLOAD_BIND = Any()
  }
}
