package expo.modules.chatyyconversationlist

// [2026-10-15 native-calls] Histórico da aba Ligações em NATIVO (Android):
// RecyclerView + DiffUtil (payload), cabeçalhos de seção (Hoje, Ontem…),
// cartões arredondados por seção, ItemTouchHelper (arrastar à esquerda =
// apagar), PopupMenu no toque longo. Mesmo contrato do iOS
// (ios/ChatyyCallListView.swift). O cabeçalho JS (título grande, chips,
// cartões) é o filho RN 0 e mora no item 0 do RecyclerView.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.Menu
import android.view.View
import android.view.ViewGroup
import android.widget.PopupMenu
import android.widget.TextView
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

@SuppressLint("ViewConstructor")
class ChatyyCallListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onCollapsedChange by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  private val rows = HashMap<String, KLRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private val dirty = HashSet<String>()
  private var pendingReset = false
  private var needsApply = false
  private var firstPaintSent = false

  private var theme = KLTheme(false)
  private var themeDirty = true
  private var labels = CLLabels()
  private var labelsDirty = false
  var swipeEnabled = true
  var menuEnabled = true
  var collapseOffsetDp = 34f
  private var collapsed = false
  private var bottomInsetPx = 0
  private var headerHintPx = 0

  private val rnChildren = ArrayList<View>()
  private val headerHost = CLChildHost(context) { headerHintPx }
  private val footerHost = CLChildHost(context) { 0 }

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
          val r = KLRow.from(m)
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
        val r = KLRow.from(m)
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

  fun setDark(dark: Boolean) {
    if (dark == theme.dark && !themeDirty) return
    theme = KLTheme(dark)
    themeDirty = true
  }

  fun setLabelsProp(m: Map<String, Any?>?) {
    labels = CLLabels(m)
    labelsDirty = true
  }

  fun setAuthToken(t: String?) { CLAuth.token = t ?: "" }

  fun setHeaderHeightHint(v: Double) {
    headerHintPx = (max(0.0, v) * density).toInt()
    headerHost.requestLayout()
  }

  fun setBottomInset(v: Double) {
    val px = (max(0.0, v) * density).toInt()
    if (px != bottomInsetPx) {
      bottomInsetPx = px
      recycler.setPadding(0, 0, 0, px)
    }
  }

  fun commitProps() {
    var rebindAll = false
    if (themeDirty) {
      setBackgroundColor(theme.bg)
      recycler.setBackgroundColor(theme.bg)
      themeDirty = false
      rebindAll = true
    }
    if (labelsDirty) {
      labelsDirty = false
      rebindAll = true
    }
    applyData(rebindAll)
  }

  // ─── Dados → adapter ─────────────────────────────────────────────────────

  private sealed class Item {
    object Header : Item()
    object Footer : Item()
    data class Section(val key: String, val title: String) : Item()
    data class Row(val id: String, val first: Boolean, val last: Boolean) : Item()
  }

  private var items: List<Item> = listOf(Item.Header, Item.Footer)
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
      if (ids.size < rows.size) for (id in rows.keys.sorted()) if (seen.add(id)) ids.add(id)
      order = ids
      // Seções = trechos contíguos com o mesmo rótulo.
      val next = ArrayList<Item>(ids.size + 8)
      next.add(Item.Header)
      var i = 0
      var n = 0
      while (i < ids.size) {
        val sec = rows[ids[i]]?.sec ?: ""
        var j = i
        while (j < ids.size && (rows[ids[j]]?.sec ?: "") == sec) j++
        next.add(Item.Section("$n|$sec", sec))
        for (k in i until j) next.add(Item.Row(ids[k], k == i, k == j - 1))
        n++
        i = j
      }
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
          override fun areItemsTheSame(o: Int, nn: Int): Boolean {
            val a = old[o]
            val b = next[nn]
            return when {
              a is Item.Row && b is Item.Row -> a.id == b.id
              a is Item.Section && b is Item.Section -> a.key == b.key
              else -> a === b
            }
          }
          override fun areContentsTheSame(o: Int, nn: Int): Boolean {
            val a = old[o]
            val b = next[nn]
            if (b is Item.Row) return a == b && !changed.contains(b.id)
            if (b is Item.Section) return !rebindAll
            return true
          }
          override fun getChangePayload(o: Int, nn: Int): Any = PAYLOAD_BIND
        }, true)
        val atTop = !recycler.canScrollVertically(-1)
        items = next
        diff.dispatchUpdatesTo(adapter)
        if (atTop) recycler.scrollToPosition(0)
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
    if (!menuEnabled) return
    val L = labels
    val actions = ArrayList<String>()
    fun reg(a: String): Int { actions.add(a); return actions.size - 1 }
    fun red(text: String): CharSequence {
      val sp = android.text.SpannableString(text)
      sp.setSpan(android.text.style.ForegroundColorSpan(CLTheme.SWIPE_DELETE), 0, sp.length, 0)
      return sp
    }
    try {
      val pm = PopupMenu(context, anchor, Gravity.END)
      val menu = pm.menu
      var o = 0
      menu.add(Menu.NONE, reg("callBack"), o++, L.get("callBack", "Ligar de volta"))
      menu.add(Menu.NONE, reg("info"), o++, L.get("info", "Info"))
      menu.add(Menu.NONE, reg("addContact"), o++, L.get("addContact", "Adicionar aos contatos"))
      menu.add(Menu.NONE, reg("copyNumber"), o++, L.get("copyNumber", "Copiar número"))
      menu.add(Menu.NONE, reg("block"), o++, red(L.get("block", "Bloquear contato")))
      menu.add(Menu.NONE, reg("report"), o++, red(L.get("report", "Denunciar spam")))
      menu.add(Menu.NONE, reg("delete"), o++, red(L.get("delete", "Apagar")))
      pm.setOnMenuItemClickListener { mi ->
        val a = actions.getOrNull(mi.itemId)
        if (a != null) onRowAction(mapOf("id" to row.id, "action" to a, "source" to "menu"))
        true
      }
      pm.show()
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("menu: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class HostHolder(v: View) : RecyclerView.ViewHolder(v)
  private class SectionHolder(val tv: TextView) : RecyclerView.ViewHolder(tv)
  private class RowHolder(val rowView: KLRowView) : RecyclerView.ViewHolder(rowView)

  private val rowListener = object : KLRowView.Listener {
    override fun onPress(id: String) { onRowPress(mapOf("id" to id)) }
    override fun onAction(id: String, action: String) {
      onRowAction(mapOf("id" to id, "action" to action, "source" to "button"))
    }
    override fun onLongPress(id: String, anchor: View) { showMenu(id, anchor) }
  }

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (items[position]) {
      is Item.Header -> TYPE_HEADER
      is Item.Footer -> TYPE_FOOTER
      is Item.Section -> TYPE_SECTION
      is Item.Row -> TYPE_ROW
    }

    override fun getItemId(position: Int): Long = when (val it = items[position]) {
      is Item.Header -> 1L
      is Item.Footer -> 2L
      is Item.Section -> stableId("s:" + it.key)
      is Item.Row -> stableId("r:" + it.id)
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
      if (viewType == TYPE_SECTION) {
        val tv = TextView(parent.context)
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        tv.typeface = CLType.weight(600)
        tv.letterSpacing = 0.05f
        tv.maxLines = 1
        tv.ellipsize = TextUtils.TruncateAt.END
        tv.includeFontPadding = false
        val d = density
        tv.setPadding((32 * d).toInt(), (24 * d).toInt(), (32 * d).toInt(), (8 * d).toInt())
        tv.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
        tv.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        return SectionHolder(tv)
      }
      val v = KLRowView(parent.context)
      val lp = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
      val m = (16 * density).toInt()
      lp.leftMargin = m
      lp.rightMargin = m
      v.layoutParams = lp
      v.listener = rowListener
      return RowHolder(v)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      bind(holder, position)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
      bind(holder, position)
    }

    private fun bind(holder: RecyclerView.ViewHolder, position: Int) {
      try {
        when (val it = items.getOrNull(position)) {
          is Item.Section -> {
            val sh = holder as? SectionHolder ?: return
            sh.tv.text = it.title.uppercase(Locale.getDefault())
            sh.tv.setTextColor(theme.sub)
          }
          is Item.Row -> {
            val rh = holder as? RowHolder ?: return
            val row = rows[it.id] ?: return
            rh.rowView.bind(row, theme, labels, it.first, it.last)
          }
          else -> {}
        }
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  // ─── Swipe (arrastar à esquerda = apagar) ────────────────────────────────

  private val swipePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = SWIPE_RED }
  private val swipeRect = RectF()

  private inner class SwipeCallback : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.LEFT) {
    override fun getSwipeDirs(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int {
      if (vh !is RowHolder || !swipeEnabled) return 0
      return super.getSwipeDirs(rv, vh)
    }

    override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean = false

    override fun getSwipeThreshold(vh: RecyclerView.ViewHolder): Float = 0.4f

    override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {
      val holder = vh as? RowHolder ?: return
      val id = holder.rowView.row.id
      holder.rowView.performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
      onRowAction(mapOf("id" to id, "action" to "delete", "source" to "swipe"))
      // O patch do JS remove a linha; se não remover (falhou), ela volta.
      main.postDelayed({
        val p = items.indexOfFirst { it is Item.Row && it.id == id }
        if (p >= 0) adapter.notifyItemChanged(p, PAYLOAD_BIND)
      }, 700L)
    }

    override fun onChildDraw(c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder, dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      if (actionState == ItemTouchHelper.ACTION_STATE_SWIPE && vh is RowHolder && dX < 0f) {
        val v = vh.itemView
        swipeRect.set(v.right + dX, v.top.toFloat(), v.right.toFloat(), v.bottom.toFloat())
        c.drawRect(swipeRect, swipePaint)
        val w = 80f * density
        val cx = v.right - min(abs(dX), w) / 2f
        val cy = v.top + v.height / 2f
        val alpha = (min(1f, abs(dX) / w) * 255).toInt()
        tintedIcon(context, R.drawable.ccl_ic_trash, 0xFFFFFFFF.toInt())?.let { d ->
          val s = (20 * density).toInt()
          d.alpha = alpha
          d.setBounds((cx - s / 2f).toInt(), (cy - s / 2f).toInt(), (cx + s / 2f).toInt(), (cy + s / 2f).toInt())
          d.draw(c)
        }
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
    recycler.isVerticalScrollBarEnabled = false
    recycler.setItemViewCacheSize(8)
    recycler.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 220
      addDuration = 180
      removeDuration = 160
    }
    addView(recycler, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    touchHelper.attachToRecyclerView(recycler)
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) { onListScrolled() }
    })
    setBackgroundColor(theme.bg)
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
    private const val SWIPE_RED = 0xFFEF4444.toInt()
  }
}
