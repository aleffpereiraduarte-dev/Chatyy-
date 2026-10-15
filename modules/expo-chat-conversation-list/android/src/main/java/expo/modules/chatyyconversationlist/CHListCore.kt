package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] Núcleo comum das views da aba CANAIS (Android):
// RecyclerView + DiffUtil (payload, sem piscar), SwipeRefreshLayout,
// onEndReached, patches por id com seq/base + onResync (mesmo contrato da
// home/Status), filhos RN: 0 = header (rola junto), 1 = rodapé.
// As views (ChatyyChannelListView / ChatyyChannelFeedView) só guardam os
// EventDispatcher e encaminham via `emit`. Espelha ios/CHListCore.swift.

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlin.math.max

internal class CHListCore(
  private val context: Context,
  private val emit: (String, Map<String, Any?>) -> Unit
) : CHHost {
  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  private val rows = HashMap<String, CHRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private val dirty = HashSet<String>()
  private var pendingReset = false
  private var needsApply = false
  private var firstPaintSent = false
  private var endReachedFor = -1

  private var dark = false
  private var paletteMap: Map<String, Any?>? = null
  private var palette = CHPalette(false)
  private var paletteDirty = true
  private var labels = CLLabels()
  private var labelsDirty = false
  private var quick: List<String> = emptyList()
  private var quickDirty = false
  private var bottomInsetPx = 0
  private var headerHintPx = 0
  private var footerHintPx = 0

  private val rnChildren = ArrayList<View>()
  private val headerHost = CLChildHost(context) { headerHintPx }
  private val footerHost = CLChildHost(context) { footerHintPx }

  val refresh = SwipeRefreshLayout(context)
  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()

  // ─── Props ───────────────────────────────────────────────────────────────

  fun setRowsPatch(p: Map<String, Any?>?) {
    if (p == null) return
    try {
      val pseq = CLVal.double(p["seq"])
      val reset = CLVal.list(p["reset"])
      if (reset != null) {
        if (pseq == seq && firstPaintSent) return
        rows.clear()
        val ids = ArrayList<String>()
        for (item in reset) {
          val m = CLVal.map(item) ?: continue
          val r = CHRow.from(m)
          if (r.id.isEmpty()) continue
          if (!rows.containsKey(r.id)) ids.add(r.id)
          rows[r.id] = r
        }
        order = CLVal.list(p["order"])?.map { CLVal.str(it) } ?: ids
        seq = pseq
        pendingReset = true
        needsApply = true
        endReachedFor = -1
        return
      }
      if (pseq <= seq) return
      val base = CLVal.double(p["base"])
      if (base != seq) {
        if (resyncAskedFor != seq) {
          resyncAskedFor = seq
          emit("onResync", mapOf("seq" to seq))
        }
        return
      }
      CLVal.list(p["remove"])?.forEach { rows.remove(CLVal.str(it)) }
      val hasOrder = p["order"] != null
      val appended = ArrayList<String>()
      CLVal.list(p["upsert"])?.forEach { item ->
        val m = CLVal.map(item) ?: return@forEach
        val r = CHRow.from(m)
        if (r.id.isEmpty()) return@forEach
        if (!rows.containsKey(r.id) && !hasOrder) appended.add(r.id)
        rows[r.id] = r
        dirty.add(r.id)
      }
      val ord = CLVal.list(p["order"])
      order = if (ord != null) ord.map { CLVal.str(it) } else order + appended
      seq = pseq
      needsApply = true
    } catch (e: Throwable) {
      emit("onNativeError", mapOf("message" to ("patch: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  fun setDark(d: Boolean) {
    if (d == dark && !paletteDirty) return
    dark = d
    paletteDirty = true
  }

  fun setPalette(m: Map<String, Any?>?) {
    paletteMap = m
    paletteDirty = true
  }

  fun setLabels(m: Map<String, Any?>?) {
    labels = CLLabels(m)
    labelsDirty = true
  }

  fun setQuick(q: List<String>?) {
    val n = q ?: emptyList()
    if (n != quick) { quick = n; quickDirty = true }
  }

  fun setAuthToken(t: String?) { if (!t.isNullOrEmpty()) CLAuth.token = t }

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

  fun setRefreshing(on: Boolean) {
    if (!on && refresh.isRefreshing) refresh.isRefreshing = false
  }

  fun setRefreshTint(hex: String?) {
    val c = SLColor.parse(hex ?: "") ?: return
    refresh.setColorSchemeColors(c)
  }

  fun commitProps(owner: View) {
    var rebindAll = false
    if (paletteDirty) {
      palette = CHPalette(dark, paletteMap)
      owner.setBackgroundColor(palette.bg)
      recycler.setBackgroundColor(palette.bg)
      refresh.setProgressBackgroundColorSchemeColor(if (dark) 0xFF1A1A1A.toInt() else 0xFFFFFFFF.toInt())
      paletteDirty = false
      rebindAll = true
    }
    if (labelsDirty || quickDirty) {
      labelsDirty = false
      quickDirty = false
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
        recycler.post { emit("onFirstPaint", mapOf("count" to ids.size)) }
      }
    } catch (e: Throwable) {
      emit("onNativeError", mapOf("message" to ("apply: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  // ─── Filhos RN ───────────────────────────────────────────────────────────

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
    rnChildren.forEachIndexed { i, v ->
      if (i == 0) headerHost.attach(v) else footerHost.attach(v)
    }
    headerHost.requestLayout()
    footerHost.requestLayout()
  }

  // ─── Eventos das linhas ──────────────────────────────────────────────────

  override fun chPress(id: String) {
    emit("onRowPress", mapOf("id" to id))
  }

  override fun chAction(id: String, action: String, extra: Map<String, Any?>) {
    val m = HashMap<String, Any?>(extra)
    m["id"] = id
    m["action"] = action
    emit("onRowAction", m)
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class HostHolder(v: View) : RecyclerView.ViewHolder(v)
  private class RowHolder(val v: CHRowView) : RecyclerView.ViewHolder(v)
  private class CardHolder(val v: CHCardView) : RecyclerView.ViewHolder(v)
  private class PostHolder(val v: CHPostView) : RecyclerView.ViewHolder(v)

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (val it = items[position]) {
      is Item.Header -> TYPE_HEADER
      is Item.Footer -> TYPE_FOOTER
      is Item.Row -> when (rows[it.id]?.kind) {
        "card" -> TYPE_CARD
        "post" -> TYPE_POST
        else -> TYPE_ROW
      }
    }

    override fun getItemId(position: Int): Long = when (val it = items[position]) {
      is Item.Header -> 1L
      is Item.Footer -> 2L
      is Item.Row -> stableId(it.id)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val lp = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
      when (viewType) {
        TYPE_HEADER, TYPE_FOOTER -> {
          val host = if (viewType == TYPE_HEADER) headerHost else footerHost
          (host.parent as? ViewGroup)?.removeView(host)
          host.layoutParams = lp
          val h = HostHolder(host)
          h.setIsRecyclable(false)
          return h
        }
        TYPE_CARD -> {
          val v = CHCardView(parent.context)
          v.layoutParams = lp
          v.host = this@CHListCore
          return CardHolder(v)
        }
        TYPE_POST -> {
          val v = CHPostView(parent.context)
          v.layoutParams = lp
          v.host = this@CHListCore
          return PostHolder(v)
        }
        else -> {
          val v = CHRowView(parent.context)
          v.layoutParams = lp
          v.host = this@CHListCore
          return RowHolder(v)
        }
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      val item = items.getOrNull(position) as? Item.Row ?: return
      val row = rows[item.id] ?: return
      try {
        when (holder) {
          is RowHolder -> holder.v.bind(row, palette)
          is CardHolder -> holder.v.bind(row, labels)
          is PostHolder -> holder.v.bind(row, palette, quick)
        }
      } catch (e: Throwable) {
        emit("onNativeError", mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  private fun checkEnd() {
    val n = order.size
    if (n == 0 || endReachedFor == n) return
    val last = layoutManager.findLastVisibleItemPosition()
    if (last >= items.size - 4) {
      endReachedFor = n
      emit("onEndReached", mapOf("count" to n))
    }
  }

  init {
    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.setItemViewCacheSize(6)
    recycler.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 220
      addDuration = 180
      removeDuration = 160
    }
    refresh.addView(recycler, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    refresh.setOnRefreshListener {
      emit("onRefresh", emptyMap())
      main.postDelayed({ if (refresh.isRefreshing) refresh.isRefreshing = false }, 8000L)
    }
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) { if (dy > 0) checkEnd() }
    })
  }

  fun dispose() {
    main.removeCallbacksAndMessages(null)
  }

  companion object {
    private const val TYPE_HEADER = 0
    private const val TYPE_ROW = 1
    private const val TYPE_FOOTER = 2
    private const val TYPE_CARD = 3
    private const val TYPE_POST = 4
    private val PAYLOAD_BIND = Any()
  }
}
