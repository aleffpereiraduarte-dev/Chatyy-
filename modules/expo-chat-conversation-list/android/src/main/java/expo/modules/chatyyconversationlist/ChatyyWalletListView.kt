package expo.modules.chatyyconversationlist

// [2026-10-15 native-wallet] CARTEIRA em NATIVO (Android): RecyclerView +
// DiffUtil. Item 0 = herói nativo (WLHeroView, saldo em contagem rolando +
// botões → onHeroAction) seguido do filho RN 0 (blocos JS). Depois o
// histórico: dias + transações em cartões arredondados por grupo (`sid`),
// vazio com botão, carregando, notas. Puxar p/ atualizar + onEndReached.
// Mesmo contrato do iOS (ios/ChatyyWalletListView.swift).

import android.annotation.SuppressLint
import android.content.Context
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.max

@SuppressLint("ViewConstructor")
class ChatyyWalletListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onHeroAction by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onEndReached by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val density = context.resources.displayMetrics.density
  private fun px(v: Float): Int = (v * density + 0.5f).toInt()

  private val rows = HashMap<String, WLRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private var needsApply = false
  private var firstPaintSent = false

  private var dark = false
  private var colorsRaw: Map<String, Any?>? = null
  private var palette = WLPalette(false)
  private var paletteDirty = true
  private var maxContentWidthDp = 0f
  private var hInsetPx = 0
  private var headerHintPx = 0

  private var heroOn = false
  private var heroModel = WLHero()
  private var heroDirty = false
  private var heroTopPx = 0
  private var heroGapPx = 0

  private val rnChildren = ArrayList<View>()
  private val headerHost = CLChildHost(context) { headerHintPx }
  private val heroView = WLHeroView(context)
  private val topBlock = LinearLayout(context)

  private val refresher = SwipeRefreshLayout(context)
  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()
  private var endReachedForCount = -1

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
          val r = WLRow.from(m)
          if (r.id.isEmpty()) continue
          if (!rows.containsKey(r.id)) ids.add(r.id)
          rows[r.id] = r
        }
        order = CLVal.list(p["order"])?.map { CLVal.str(it) } ?: ids
        seq = pseq
        needsApply = true
        return
      }
      if (pseq <= seq) return
      val base = CLVal.double(p["base"])
      if (base != seq) {
        if (resyncAskedFor != seq) {
          resyncAskedFor = seq
          onResync(mapOf("seq" to seq))
        }
        return
      }
      CLVal.list(p["remove"])?.forEach { rows.remove(CLVal.str(it)) }
      val hasOrder = p["order"] != null
      val appended = ArrayList<String>()
      CLVal.list(p["upsert"])?.forEach { item ->
        val m = CLVal.map(item) ?: return@forEach
        val r = WLRow.from(m)
        if (r.id.isEmpty()) return@forEach
        if (!rows.containsKey(r.id) && !hasOrder) appended.add(r.id)
        rows[r.id] = r
      }
      val ord = CLVal.list(p["order"])
      order = if (ord != null) ord.map { CLVal.str(it) } else order + appended
      seq = pseq
      needsApply = true
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("patch: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  fun setHero(m: Map<String, Any?>?) {
    try {
      if (m != null && m.isNotEmpty()) {
        heroModel = WLHero.from(m)
        heroOn = true
      } else {
        heroOn = false
      }
      heroDirty = true
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("hero: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  fun setDark(v: Boolean) {
    if (v == dark) return
    dark = v
    paletteDirty = true
    heroDirty = true
  }

  fun setColors(m: Map<String, Any?>?) {
    colorsRaw = m
    paletteDirty = true
  }

  fun setHeaderHeightHint(v: Double) {
    headerHintPx = (max(0.0, v) * density).toInt()
    headerHost.requestLayout()
  }

  fun setHeroInsets(top: Double, gap: Double) {
    val t = (max(0.0, top) * density).toInt()
    val g = (max(0.0, gap) * density).toInt()
    if (t == heroTopPx && g == heroGapPx) return
    heroTopPx = t
    heroGapPx = g
    heroDirty = true
  }

  fun setBottomInset(v: Double) {
    val p = (max(0.0, v) * density).toInt()
    recycler.setPadding(0, 0, 0, p)
  }

  fun setMaxContentWidth(v: Double) {
    val dp = max(0.0, v).toFloat()
    if (dp == maxContentWidthDp) return
    maxContentWidthDp = dp
    updateInset(width)
  }

  fun setRefreshEnabled(v: Boolean) {
    refresher.isEnabled = v
  }

  fun setRefreshing(v: Boolean) {
    if (!v && refresher.isRefreshing) refresher.isRefreshing = false
  }

  fun commitProps() {
    var rebindAll = false
    if (paletteDirty) {
      paletteDirty = false
      palette = WLPalette(dark, colorsRaw)
      setBackgroundColor(palette.pageBg)
      recycler.setBackgroundColor(palette.pageBg)
      refresher.setColorSchemeColors(palette.text)
      refresher.setProgressBackgroundColorSchemeColor(palette.cardBg)
      rebindAll = true
    }
    if (heroDirty) {
      heroDirty = false
      try {
        heroView.visibility = if (heroOn) VISIBLE else GONE
        if (heroOn) heroView.configure(heroModel, dark)
        layoutTopBlock()
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("hero: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
    applyData(rebindAll)
  }

  private fun layoutTopBlock() {
    val lp = heroView.layoutParams as? LinearLayout.LayoutParams
      ?: LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    lp.leftMargin = hInsetPx
    lp.rightMargin = hInsetPx
    lp.topMargin = heroTopPx
    lp.bottomMargin = heroGapPx
    heroView.layoutParams = lp
    topBlock.requestLayout()
  }

  // ─── Dados → itens ───────────────────────────────────────────────────────

  private sealed class Item {
    object Top : Item()
    data class Row(val row: WLRow, val first: Boolean, val last: Boolean, val inset: Int) : Item()
  }

  private var items: List<Item> = listOf(Item.Top)
  private val stableIds = HashMap<String, Long>()
  private var nextStable = 10L
  private fun stableId(key: String): Long = stableIds.getOrPut(key) { nextStable++ }

  private fun applyData(rebindAll: Boolean) {
    if (!needsApply && !rebindAll && firstPaintSent) return
    needsApply = false
    try {
      val seen = HashSet<String>()
      val ids = ArrayList<String>(order.size)
      for (id in order) if (rows.containsKey(id) && seen.add(id)) ids.add(id)
      order = ids

      val next = ArrayList<Item>(ids.size + 1)
      next.add(Item.Top)
      val bucket = ArrayList<WLRow>()
      fun flush() {
        bucket.forEachIndexed { i, r -> next.add(Item.Row(r, i == 0, i == bucket.size - 1, hInsetPx)) }
        bucket.clear()
      }
      for (id in ids) {
        val r = rows[id] ?: continue
        if (r.kind == "x") {
          if (bucket.isNotEmpty() && bucket[0].sid != r.sid) flush()
          bucket.add(r)
        } else {
          flush()
          next.add(Item.Row(r, true, true, hInsetPx))
        }
      }
      flush()

      val old = items
      val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
        override fun getOldListSize() = old.size
        override fun getNewListSize() = next.size
        override fun areItemsTheSame(o: Int, nn: Int): Boolean {
          val a = old[o]
          val b = next[nn]
          return when {
            a is Item.Row && b is Item.Row -> a.row.id == b.row.id
            else -> a === b
          }
        }
        override fun areContentsTheSame(o: Int, nn: Int): Boolean {
          val b = next[nn]
          if (b is Item.Top) return true
          return !rebindAll && old[o] == b
        }
        override fun getChangePayload(o: Int, nn: Int): Any = PAYLOAD_BIND
      }, false)
      val atTop = !recycler.canScrollVertically(-1)
      items = next
      endReachedForCount = -1
      diff.dispatchUpdatesTo(adapter)
      if (atTop) recycler.scrollToPosition(0)
      if (!firstPaintSent) {
        firstPaintSent = true
        recycler.post { onFirstPaint(mapOf("count" to ids.size)) }
      }
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("apply: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  private fun updateInset(w: Int) {
    var inset = px(16f)
    val maxPx = (maxContentWidthDp * density).toInt()
    if (maxPx > 0 && w > maxPx) inset = max(inset, (w - maxPx) / 2 + px(16f))
    if (inset != hInsetPx) {
      hInsetPx = inset
      layoutTopBlock()
      needsApply = true
      applyData(true)
    }
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w != oldw) post { updateInset(w) }
  }

  // ─── Filho RN ────────────────────────────────────────────────────────────

  fun addRnChild(child: View, index: Int) {
    val i = index.coerceIn(0, rnChildren.size)
    rnChildren.add(i, child)
    headerHost.attach(child)
    headerHost.requestLayout()
  }

  fun rnChildCount(): Int = rnChildren.size

  fun rnChildAt(index: Int): View? = rnChildren.getOrNull(index)

  fun removeRnChild(child: View) {
    headerHost.detach(child)
    rnChildren.remove(child)
    headerHost.requestLayout()
  }

  fun removeRnChildAt(index: Int) {
    val c = rnChildren.getOrNull(index) ?: return
    removeRnChild(c)
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class HostHolder(v: View) : RecyclerView.ViewHolder(v)
  private class TxHolder(val v: WLTxRowView) : RecyclerView.ViewHolder(v)
  private class DayHolder(val tv: TextView) : RecyclerView.ViewHolder(tv)
  private class EmptyHolder(val v: WLEmptyView) : RecyclerView.ViewHolder(v)
  private class NoteHolder(val tv: TextView) : RecyclerView.ViewHolder(tv)
  private class LoadHolder(v: View) : RecyclerView.ViewHolder(v)

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (val it = items[position]) {
      is Item.Top -> TYPE_TOP
      is Item.Row -> when (it.row.kind) {
        "d" -> TYPE_DAY
        "e" -> TYPE_EMPTY
        "l" -> TYPE_LOAD
        "n" -> TYPE_NOTE
        else -> TYPE_TX
      }
    }

    override fun getItemId(position: Int): Long = when (val it = items[position]) {
      is Item.Top -> 1L
      is Item.Row -> stableId(it.row.id)
    }

    private fun lp(): RecyclerView.LayoutParams =
      RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      when (viewType) {
        TYPE_TOP -> {
          (topBlock.parent as? ViewGroup)?.removeView(topBlock)
          topBlock.layoutParams = lp()
          val h = HostHolder(topBlock)
          h.setIsRecyclable(false)
          return h
        }
        TYPE_DAY -> { val tv = WLSimpleViews.day(parent.context); tv.layoutParams = lp(); return DayHolder(tv) }
        TYPE_NOTE -> { val tv = WLSimpleViews.note(parent.context); tv.layoutParams = lp(); return NoteHolder(tv) }
        TYPE_LOAD -> {
          val f = FrameLayout(parent.context)
          val pb = WLSimpleViews.loading(parent.context)
          f.addView(pb, FrameLayout.LayoutParams(px(28f), px(28f), Gravity.CENTER))
          f.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, px(56f))
          return LoadHolder(f)
        }
        TYPE_EMPTY -> {
          val v = WLEmptyView(parent.context)
          v.layoutParams = lp()
          v.onAction = { id, action -> onRowAction(mapOf("id" to id, "action" to action)) }
          return EmptyHolder(v)
        }
        else -> {
          val v = WLTxRowView(parent.context)
          v.layoutParams = lp()
          v.onPress = { id -> onRowPress(mapOf("id" to id)) }
          return TxHolder(v)
        }
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) { bind(holder, position) }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) { bind(holder, position) }

    private fun margins(v: View, inset: Int, top: Int = 0) {
      val l = v.layoutParams as? RecyclerView.LayoutParams ?: return
      if (l.leftMargin == inset && l.rightMargin == inset && l.topMargin == top) return
      l.leftMargin = inset
      l.rightMargin = inset
      l.topMargin = top
      v.layoutParams = l
    }

    private fun bind(holder: RecyclerView.ViewHolder, position: Int) {
      try {
        val it = items.getOrNull(position) as? Item.Row ?: return
        when (holder) {
          is TxHolder -> { margins(holder.v, it.inset); holder.v.bind(it.row, palette, it.first, it.last) }
          is DayHolder -> {
            margins(holder.tv, it.inset)
            holder.tv.text = it.row.title
            holder.tv.setTextColor(palette.secondary)
            holder.tv.setPadding(px(4f), px(16f), px(4f), px(8f))
            holder.tv.contentDescription = it.row.title
            if (android.os.Build.VERSION.SDK_INT >= 28) holder.tv.isAccessibilityHeading = true
          }
          is EmptyHolder -> { margins(holder.v, it.inset, px(12f)); holder.v.bind(it.row, palette) }
          is NoteHolder -> {
            margins(holder.tv, it.inset)
            holder.tv.text = it.row.title
            holder.tv.setTextColor(if (it.row.credit) palette.secondary else palette.tertiary)
            holder.tv.textSize = if (it.row.credit) 13f else 12f
            holder.tv.setPadding(px(16f), px(12f), px(16f), px(4f))
          }
          else -> {}
        }
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  init {
    topBlock.orientation = LinearLayout.VERTICAL
    topBlock.clipChildren = false
    topBlock.clipToPadding = false
    heroView.visibility = GONE
    heroView.onAction = { id -> onHeroAction(mapOf("id" to id)) }
    topBlock.addView(heroView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    topBlock.addView(headerHost, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    hInsetPx = px(16f)
    heroTopPx = px(16f)
    heroGapPx = px(16f)
    layoutTopBlock()

    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.isVerticalScrollBarEnabled = false
    recycler.itemAnimator = null
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
        val last = layoutManager.findLastVisibleItemPosition()
        val n = adapter.itemCount
        if (n > 1 && last >= n - 4 && endReachedForCount != n) {
          endReachedForCount = n
          onEndReached(mapOf<String, Any>())
        }
      }
    })
    refresher.addView(recycler, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    refresher.setOnRefreshListener { onRefresh(mapOf<String, Any>()) }
    addView(refresher, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT))
    setBackgroundColor(palette.pageBg)
  }

  companion object {
    private const val TYPE_TOP = 0
    private const val TYPE_TX = 1
    private const val TYPE_DAY = 2
    private const val TYPE_EMPTY = 3
    private const val TYPE_LOAD = 4
    private const val TYPE_NOTE = 5
    private val PAYLOAD_BIND = Any()
  }
}
