package expo.modules.chatyyconversationlist

// [2026-10-15 native-lists] Aba STATUS em NATIVO (Android): RecyclerView +
// DiffUtil (payload, sem piscar), SwipeRefreshLayout (puxar p/ atualizar),
// ItemTouchHelper (arrastar p/ a esquerda → silenciar/reativar), PopupMenu
// no toque longo. Mesmo contrato do iOS (ios/ChatyyStatusListView.swift).
// Filhos RN: item 0 = topo da aba (título grande, busca, carrossel, "Meu
// status"), último = rodapé (estado vazio) — CLChildHost da lista da home.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.view.Menu
import android.view.View
import android.view.ViewGroup
import android.widget.PopupMenu
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

@SuppressLint("ViewConstructor")
class ChatyyStatusListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onRowPressIn by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onLongPress by EventDispatcher()
  val onPeekOpen by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onCollapsedChange by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  // Dados
  private val rows = HashMap<String, SLRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private val dirty = HashSet<String>()
  private var pendingReset = false
  private var needsApply = false
  private var firstPaintSent = false

  // Aparência
  private var dark = false
  private var paletteMap: Map<String, Any?>? = null
  private var palette = SLPalette(false)
  private var paletteDirty = true
  private var labels = CLLabels()
  var collapseOffsetDp = 34f
  private var collapsed = false
  private var bottomInsetPx = 0
  private var headerHintPx = 0
  private var footerHintPx = 0

  // Filhos RN
  private val rnChildren = ArrayList<View>()
  private val headerHost = CLChildHost(context) { headerHintPx }
  private val footerHost = CLChildHost(context) { footerHintPx }

  private val refresh = SwipeRefreshLayout(context)
  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()
  private val touchHelper: ItemTouchHelper = ItemTouchHelper(SwipeCallback())

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
          val r = SLRow.from(m)
          if (r.id.isEmpty()) continue
          if (!rows.containsKey(r.id)) ids.add(r.id)
          rows[r.id] = r
        }
        order = CLVal.list(p["order"])?.map { CLVal.str(it) } ?: ids
        seq = pseq
        pendingReset = true
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
        val r = SLRow.from(m)
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

  fun setLabelsProp(m: Map<String, Any?>?) { labels = CLLabels(m) }

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

  fun setRefreshingProp(on: Boolean) {
    if (!on && refresh.isRefreshing) refresh.isRefreshing = false
  }

  fun setRefreshTint(hex: String?) {
    val c = SLColor.parse(hex ?: "") ?: return
    refresh.setColorSchemeColors(c)
  }

  fun commitProps() {
    var rebindAll = false
    if (paletteDirty) {
      palette = SLPalette(dark, paletteMap)
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
      // Linha fora do `order` não tem posição: descarta.
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
        recycler.post { onFirstPaint(mapOf("count" to ids.size)) }
      }
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("apply: " + (e.message ?: e.javaClass.simpleName))))
    }
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
    rnChildren.forEachIndexed { i, v ->
      if (i == 0) headerHost.attach(v) else footerHost.attach(v)
    }
    headerHost.requestLayout()
    footerHost.requestLayout()
  }

  // ─── Scroll ──────────────────────────────────────────────────────────────

  private fun onListScrolled() {
    val first = layoutManager.findFirstVisibleItemPosition()
    val offsetPx: Int = if (first == 0) {
      val v = layoutManager.findViewByPosition(0)
      if (v != null) -v.top else 0
    } else Int.MAX_VALUE / 2
    val c = offsetPx > (collapseOffsetDp * density)
    if (c != collapsed) {
      collapsed = c
      onCollapsedChange(mapOf("collapsed" to c))
    }
  }

  // ─── Menu (toque longo) ──────────────────────────────────────────────────

  private fun showMenu(id: String, anchor: View) {
    val row = rows[id] ?: return
    try {
      val L = labels
      val pm = PopupMenu(context, anchor, android.view.Gravity.END)
      val acts = ArrayList<String>()
      fun add(action: String, title: String, checked: Boolean = false) {
        val item = pm.menu.add(Menu.NONE, acts.size, acts.size, title)
        if (checked) { item.isCheckable = true; item.isChecked = true }
        acts.add(action)
      }
      add("open", L.get("open", "Ver status"))
      add("preview", L.get("preview", "Visualizar"))
      if (!row.mine) {
        if (row.muted) add("unmute", L.get("unmute", "Reativar")) else add("mute", L.get("mute", "Silenciar"))
        add("notify", if (row.notify) L.get("notifying", "Notificando") else L.get("notify", "Notificar"), row.notify)
        add("share", L.get("share", "Compartilhar"))
        add("report", L.get("report", "Reportar"))
      }
      pm.setOnMenuItemClickListener { mi ->
        val a = acts.getOrNull(mi.itemId)
        if (a != null) onRowAction(mapOf("id" to id, "action" to a, "source" to "menu"))
        true
      }
      pm.show()
    } catch (_: Throwable) {
      onLongPress(mapOf("id" to id))
    }
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class HostHolder(v: View) : RecyclerView.ViewHolder(v)
  private class RowHolder(val rowView: SLRowView) : RecyclerView.ViewHolder(rowView)
  private class SectionHolder(val sectionView: SLSectionView) : RecyclerView.ViewHolder(sectionView)

  private val rowListener = object : SLRowView.Listener {
    override fun onPress(id: String) { onRowPress(mapOf("id" to id)) }
    override fun onPressIn(id: String) { onRowPressIn(mapOf("id" to id)) }
    override fun onLongPress(id: String, anchor: View) { showMenu(id, anchor) }
  }

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (val it = items[position]) {
      is Item.Header -> TYPE_HEADER
      is Item.Footer -> TYPE_FOOTER
      is Item.Row -> if (rows[it.id]?.isSection == true) TYPE_SECTION else TYPE_ROW
    }

    override fun getItemId(position: Int): Long = when (val it = items[position]) {
      is Item.Header -> 1L
      is Item.Footer -> 2L
      is Item.Row -> stableId(it.id)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val lp = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
      if (viewType == TYPE_HEADER || viewType == TYPE_FOOTER) {
        val host = if (viewType == TYPE_HEADER) headerHost else footerHost
        (host.parent as? ViewGroup)?.removeView(host)
        host.layoutParams = lp
        val h = HostHolder(host)
        h.setIsRecyclable(false)
        return h
      }
      if (viewType == TYPE_SECTION) {
        val v = SLSectionView(parent.context)
        v.layoutParams = lp
        v.listener = rowListener
        return SectionHolder(v)
      }
      val v = SLRowView(parent.context)
      v.layoutParams = lp
      v.listener = rowListener
      return RowHolder(v)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      val item = items.getOrNull(position) as? Item.Row ?: return
      val row = rows[item.id] ?: return
      try {
        when (holder) {
          is RowHolder -> holder.rowView.bind(row, palette)
          is SectionHolder -> holder.sectionView.bind(row, palette)
        }
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  // ─── Swipe (← silenciar / reativar) ──────────────────────────────────────

  private val swipePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val swipeText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = 0xFFFFFFFF.toInt()
    textAlign = Paint.Align.CENTER
    textSize = 11.5f * density
    typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
  }
  private val swipeRect = RectF()

  private inner class SwipeCallback : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.LEFT) {
    override fun getSwipeDirs(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int {
      if (vh !is RowHolder || vh.rowView.row.mine) return 0
      return super.getSwipeDirs(rv, vh)
    }

    override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean = false

    override fun getSwipeThreshold(vh: RecyclerView.ViewHolder): Float = 0.35f

    override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {
      val holder = vh as? RowHolder ?: return
      val row = holder.rowView.row
      val pos = holder.bindingAdapterPosition
      holder.rowView.performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
      onRowAction(mapOf("id" to row.id, "action" to (if (row.muted) "unmute" else "mute"), "source" to "swipe"))
      // A linha volta ao lugar (o patch do JS a move para a seção certa).
      main.postDelayed({
        val p = items.indexOfFirst { it is Item.Row && it.id == row.id }
        if (p >= 0) adapter.notifyItemChanged(p, PAYLOAD_BIND)
        else if (pos != RecyclerView.NO_POSITION && pos < adapter.itemCount) adapter.notifyItemChanged(pos)
      }, 400L)
    }

    override fun onChildDraw(c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder, dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      if (actionState == ItemTouchHelper.ACTION_STATE_SWIPE && vh is RowHolder && dX < 0f) {
        val v = vh.itemView
        val row = vh.rowView.row
        val bottom = v.bottom - 6f * density
        swipePaint.color = CLTheme.SWIPE_ARCHIVE
        swipeRect.set(v.right + dX, v.top.toFloat(), v.right - 16f * density, bottom)
        if (swipeRect.width() > 0) c.drawRoundRect(swipeRect, 14f * density, 14f * density, swipePaint)
        val label = if (row.muted) labels.get("unmute", "Reativar") else labels.get("mute", "Silenciar")
        val iconRes = if (row.muted) R.drawable.ccl_ic_bell else R.drawable.ccl_ic_bell_off
        val w = 84f * density
        val cx = v.right - 16f * density - min(abs(dX), w) / 2f
        val cy = (v.top + bottom) / 2f
        val alpha = (min(1f, abs(dX) / w) * 255).toInt()
        tintedIcon(context, iconRes, 0xFFFFFFFF.toInt())?.let { d ->
          val s = (20 * density).toInt()
          d.alpha = alpha
          d.setBounds((cx - s / 2f).toInt(), (cy - s - 2 * density).toInt(), (cx + s / 2f).toInt(), (cy - 2 * density).toInt())
          d.draw(c)
        }
        swipeText.alpha = alpha
        c.drawText(label, cx, cy + 14 * density, swipeText)
      }
      super.onChildDraw(c, rv, vh, dX, dY, actionState, isCurrentlyActive)
    }
  }

  init {
    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.setItemViewCacheSize(8)
    recycler.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 220
      addDuration = 180
      removeDuration = 160
    }
    refresh.addView(recycler, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    refresh.setOnRefreshListener {
      onRefresh(mapOf<String, Any>())
      // Se o JS não desligar `refreshing`, não gira para sempre.
      main.postDelayed({ if (refresh.isRefreshing) refresh.isRefreshing = false }, 8000L)
    }
    addView(refresh, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    touchHelper.attachToRecyclerView(recycler)
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) { onListScrolled() }
    })
    setBackgroundColor(palette.bg)
  }

  override fun onDetachedFromWindow() {
    main.removeCallbacksAndMessages(null)
    super.onDetachedFromWindow()
  }

  companion object {
    private const val TYPE_HEADER = 0
    private const val TYPE_ROW = 1
    private const val TYPE_FOOTER = 2
    private const val TYPE_SECTION = 3
    private val PAYLOAD_BIND = Any()
  }
}
