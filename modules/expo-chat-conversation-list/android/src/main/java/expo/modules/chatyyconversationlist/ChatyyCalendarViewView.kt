package expo.modules.chatyyconversationlist

// [2026-10-15 native-apps] CALENDÁRIO nativo (Android): grade do mês + agenda.
// RecyclerView + DiffUtil: item 0 = grade (CAMonthGridView), item 1 = filho RN
// (resumo do dia/avisos, CLChildHost), depois a agenda do dia. Swipe Editar
// (→) / Apagar (←) via ItemTouchHelper só em linhas com `sw`;
// SwipeRefreshLayout. Patches por id (createPatcher do nativeAdapter).
// Mesmo contrato do iOS (ios/ChatyyCalendarViewView.swift).

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
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
class ChatyyCalendarViewView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onSelectDate by EventDispatcher()
  val onLongPressDate by EventDispatcher()
  val onMonthChange by EventDispatcher()
  val onRowPress by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  // Dados da agenda
  private val rows = HashMap<String, CARow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private val dirty = HashSet<String>()
  private var pendingReset = false
  private var needsApply = false
  private var firstPaintSent = false

  // Grade
  private var year = 2026
  private var month = 0
  private var firstWeekday = 0
  private var selected = ""
  private var today = ""
  private var marks: Map<String, CAMark> = emptyMap()
  private var showGrid = true
  private var gridDirty = true

  // Aparência
  private var style = CAStyle()
  private var styleDirty = true
  private var labels = CALabels()
  private var bottomInsetPx = 0

  // Filho RN
  private val rnChildren = ArrayList<View>()
  private val host = CLChildHost(context) { 0 }
  private val grid = CAMonthGridView(context)

  private val refresh = SwipeRefreshLayout(context)
  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()
  private val touchHelper: ItemTouchHelper = ItemTouchHelper(SwipeCallback())

  // ─── Props ───────────────────────────────────────────────────────────────

  fun setMonthProp(m: Map<String, Any?>?) {
    if (m == null) return
    val y = CLVal.int(m["y"])
    val mm = CLVal.int(m["m"]).coerceIn(0, 11)
    if (y <= 0 || (y == year && mm == month)) return
    year = y; month = mm
    gridDirty = true
  }

  fun setSelectedProp(v: String?) { val s = v ?: ""; if (s != selected) { selected = s; gridDirty = true } }
  fun setTodayProp(v: String?) { val s = v ?: ""; if (s != today) { today = s; gridDirty = true } }

  fun setFirstWeekdayProp(v: Int) {
    val n = ((v % 7) + 7) % 7
    if (n != firstWeekday) { firstWeekday = n; gridDirty = true }
  }

  fun setMarksProp(m: Map<String, Any?>?) {
    val out = HashMap<String, CAMark>()
    m?.forEach { (k, v) -> out[k] = CAMark(v) }
    marks = out
    gridDirty = true
  }

  fun setShowGridProp(on: Boolean) {
    if (on == showGrid) return
    showGrid = on
    needsApply = true
  }

  fun setColorsProp(m: Map<String, Any?>?) {
    style = CAStyle(m)
    styleDirty = true
    gridDirty = true
  }

  fun setLabelsProp(m: Map<String, Any?>?) {
    labels = CALabels(m)
    gridDirty = true
  }

  fun setRefreshingProp(on: Boolean) {
    if (refresh.isRefreshing != on) refresh.isRefreshing = on
  }

  fun setBottomInset(v: Double) {
    val px = (max(0.0, v) * density).toInt()
    if (px != bottomInsetPx) {
      bottomInsetPx = px
      recycler.setPadding(0, 0, 0, bottomInsetPx + (16 * density).toInt())
    }
  }

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
          val r = CARow.from(m)
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
        val r = CARow.from(m)
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

  fun commitProps() {
    try {
      var rebindAll = false
      if (styleDirty) {
        styleDirty = false
        val c = style.colors
        setBackgroundColor(c.bg)
        recycler.setBackgroundColor(c.bg)
        refresh.setColorSchemeColors(c.text)
        refresh.setProgressBackgroundColorSchemeColor(if (c.dark) 0xFF1C1C1E.toInt() else 0xFFFFFFFF.toInt())
        rebindAll = true
      }
      if (gridDirty) {
        gridDirty = false
        grid.update(year, month, firstWeekday, selected, today, marks, style, labels)
      }
      applyData(rebindAll)
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("commit: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  // ─── Dados → adapter ─────────────────────────────────────────────────────

  private var items: List<String> = emptyList()
  private val stableIds = HashMap<String, Long>()
  private var nextStable = 10L

  private fun stableId(id: String): Long = when (id) {
    ID_GRID -> 1L
    ID_HOST -> 2L
    else -> stableIds.getOrPut(id) { nextStable++ }
  }

  private fun applyData(rebindAll: Boolean) {
    if (!needsApply && !rebindAll && firstPaintSent) return
    needsApply = false
    val seen = HashSet<String>()
    val ids = ArrayList<String>(order.size + 2)
    if (showGrid) ids.add(ID_GRID)
    ids.add(ID_HOST)
    val rowIds = ArrayList<String>(order.size)
    for (id in order) if (rows.containsKey(id) && seen.add(id)) rowIds.add(id)
    if (rowIds.size < rows.size) for (id in rows.keys.sorted()) if (seen.add(id)) rowIds.add(id)
    order = rowIds
    ids.addAll(rowIds)

    val old = items
    val changed = if (rebindAll || pendingReset) HashSet(rowIds) else HashSet(dirty)
    dirty.clear()
    val reset = pendingReset
    pendingReset = false
    if (reset && old.isEmpty()) {
      items = ids
      adapter.notifyDataSetChanged()
    } else {
      val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
        override fun getOldListSize() = old.size
        override fun getNewListSize() = ids.size
        override fun areItemsTheSame(o: Int, n: Int): Boolean = old[o] == ids[n]
        override fun areContentsTheSame(o: Int, n: Int): Boolean = !changed.contains(ids[n])
        override fun getChangePayload(o: Int, n: Int): Any = PAYLOAD_BIND
      }, ids.size < 400)
      items = ids
      diff.dispatchUpdatesTo(adapter)
    }
    if (!firstPaintSent) {
      firstPaintSent = true
      recycler.post { onFirstPaint(mapOf("count" to rowIds.size)) }
    }
  }

  // ─── Filho RN ────────────────────────────────────────────────────────────

  fun addRnChild(child: View, index: Int) {
    val i = index.coerceIn(0, rnChildren.size)
    rnChildren.add(i, child)
    host.attach(child)
    host.requestLayout()
  }

  fun rnChildCount(): Int = rnChildren.size

  fun rnChildAt(index: Int): View? = rnChildren.getOrNull(index)

  fun removeRnChild(child: View) {
    host.detach(child)
    rnChildren.remove(child)
    host.requestLayout()
  }

  fun removeRnChildAt(index: Int) {
    val c = rnChildren.getOrNull(index) ?: return
    removeRnChild(c)
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class FixedHolder(v: View) : RecyclerView.ViewHolder(v)
  private class HeaderHolder(val view: CAHeaderRowView) : RecyclerView.ViewHolder(view)
  private class EventHolder(val view: CAEventRowView) : RecyclerView.ViewHolder(view)
  private class EmptyHolder(val view: CAEmptyRowView) : RecyclerView.ViewHolder(view)

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int {
      val id = items[position]
      if (id == ID_GRID) return TYPE_GRID
      if (id == ID_HOST) return TYPE_HOST
      return when (rows[id]?.kind) {
        "h" -> TYPE_HEADER
        "n" -> TYPE_EMPTY
        else -> TYPE_EVENT
      }
    }

    override fun getItemId(position: Int): Long = stableId(items[position])

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val lp = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
      return when (viewType) {
        TYPE_GRID, TYPE_HOST -> {
          val v: View = if (viewType == TYPE_GRID) grid else host
          (v.parent as? ViewGroup)?.removeView(v)
          v.layoutParams = lp
          // Uma instância só (a grade e o filho RN moram nelas).
          FixedHolder(v).also { it.setIsRecyclable(false) }
        }
        TYPE_HEADER -> HeaderHolder(CAHeaderRowView(parent.context).also { it.layoutParams = lp })
        TYPE_EMPTY -> {
          val v = CAEmptyRowView(parent.context)
          v.layoutParams = lp
          v.onAction = { id, action -> onRowAction(mapOf("id" to id, "action" to action, "source" to "tap")) }
          EmptyHolder(v)
        }
        else -> {
          val v = CAEventRowView(parent.context)
          v.layoutParams = lp
          v.onPress = { id -> onRowPress(mapOf("id" to id)) }
          v.onAction = { id, action -> onRowAction(mapOf("id" to id, "action" to action, "source" to "tap")) }
          EventHolder(v)
        }
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      bind(holder, position)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
      bind(holder, position)
    }

    private fun bind(holder: RecyclerView.ViewHolder, position: Int) {
      val id = items.getOrNull(position) ?: return
      val row = rows[id] ?: return
      try {
        when (holder) {
          is HeaderHolder -> holder.view.bind(row, style)
          is EventHolder -> holder.view.bind(row, style)
          is EmptyHolder -> holder.view.bind(row, style)
        }
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  // ─── Swipe (Editar → / Apagar ←) ─────────────────────────────────────────

  private val swipePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val swipeText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textAlign = Paint.Align.CENTER
    textSize = 12f * density
    typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
  }
  private val swipeRect = RectF()

  private inner class SwipeCallback : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.LEFT or ItemTouchHelper.RIGHT) {
    override fun getSwipeDirs(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int {
      if (vh !is EventHolder || !vh.view.row.swipe) return 0
      return super.getSwipeDirs(rv, vh)
    }

    override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean = false

    override fun getSwipeThreshold(vh: RecyclerView.ViewHolder): Float = 0.4f

    override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {
      val holder = vh as? EventHolder ?: return
      val id = holder.view.row.id
      holder.view.performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
      val action = if (direction == ItemTouchHelper.RIGHT) "edit" else "delete"
      onRowAction(mapOf("id" to id, "action" to action, "source" to "swipe"))
      // A linha volta (Apagar pede confirmação na tela; Editar abre outra tela).
      main.postDelayed({
        val p = items.indexOf(id)
        if (p >= 0) adapter.notifyItemChanged(p, PAYLOAD_BIND)
      }, 300L)
    }

    override fun onChildDraw(c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder, dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      if (actionState == ItemTouchHelper.ACTION_STATE_SWIPE && vh is EventHolder && dX != 0f) {
        val v = vh.itemView
        val edit = dX > 0f
        val colors = style.colors
        swipePaint.color = if (edit) colors.primary else colors.error
        val pad = 8 * density
        if (edit) swipeRect.set(v.left + pad, v.top.toFloat(), v.left + dX, v.bottom - 6 * density)
        else swipeRect.set(v.right + dX, v.top.toFloat(), v.right - pad, v.bottom - 6 * density)
        c.drawRoundRect(swipeRect, 16 * density, 16 * density, swipePaint)
        val w = 84f * density
        val cx = if (edit) v.left + pad + min(abs(dX), w) / 2f else v.right - pad - min(abs(dX), w) / 2f
        val cy = v.top + (v.height - 6 * density) / 2f
        val alpha = (min(1f, abs(dX) / w) * 255).toInt()
        val ink = if (edit) colors.onPrimary else Color.WHITE
        tintedIcon(context, if (edit) R.drawable.ca_ic_edit else R.drawable.ccl_ic_trash, ink)?.let { d ->
          val s = (18 * density).toInt()
          d.alpha = alpha
          d.setBounds((cx - s / 2f).toInt(), (cy - s - 2 * density).toInt(), (cx + s / 2f).toInt(), (cy - 2 * density).toInt())
          d.draw(c)
        }
        swipeText.color = ink
        swipeText.alpha = alpha
        c.drawText(if (edit) labels.edit else labels.delete, cx, cy + 14 * density, swipeText)
      }
      super.onChildDraw(c, rv, vh, dX, dY, actionState, isCurrentlyActive)
    }
  }

  // init no FIM: todas as propriedades acima já estão inicializadas.
  init {
    grid.onSelect = { key -> onSelectDate(mapOf("date" to key)) }
    grid.onLongPress = { key -> onLongPressDate(mapOf("date" to key)) }
    grid.onMonthSwipe = { dir -> onMonthChange(mapOf("dir" to dir)) }
    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.setPadding(0, 0, 0, (16 * density).toInt())
    recycler.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 160
      addDuration = 120
      removeDuration = 100
    }
    refresh.addView(recycler, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    refresh.setOnRefreshListener { onRefresh(mapOf<String, Any>()) }
    addView(refresh, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    touchHelper.attachToRecyclerView(recycler)
    setBackgroundColor(style.colors.bg)
  }

  override fun onDetachedFromWindow() {
    main.removeCallbacksAndMessages(null)
    super.onDetachedFromWindow()
  }

  companion object {
    private const val ID_GRID = "\u0000grid"
    private const val ID_HOST = "\u0000host"
    private const val TYPE_GRID = 1
    private const val TYPE_HOST = 2
    private const val TYPE_HEADER = 3
    private const val TYPE_EVENT = 4
    private const val TYPE_EMPTY = 5
    private val PAYLOAD_BIND = Any()
  }
}
