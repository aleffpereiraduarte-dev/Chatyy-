package expo.modules.chatyyconversationlist

// [2026-10-15 native-notes] Lista/grade de NOTAS nativa (Android) — app/notes.js
// via components/native/NativeNotesList.js. RecyclerView + GridLayoutManager
// (1 coluna na lista; 2 na grade, 3 em telas largas; seções ocupam a linha),
// DiffUtil com payload (sem piscar), swipe ← Apagar / → Fixar
// (ItemTouchHelper, só na lista), PopupMenu no toque longo, SwipeRefreshLayout.
// Mesmo contrato do iOS (ios/ChatyyNotesListView.swift). O nativo só desenha:
// ações voltam por id e a tela usa os handlers JS que já existem.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.text.SpannableString
import android.text.style.ForegroundColorSpan
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.Menu
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.PopupMenu
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

@SuppressLint("ViewConstructor")
class ChatyyNotesListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  // Dados
  private val rows = HashMap<String, NTRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private val dirty = HashSet<String>()
  private var pendingReset = false
  private var needsApply = false
  private var firstPaintSent = false

  // Aparência / modos
  private var colorsMap: Map<String, Any?>? = null
  private var style = NTStyle()
  private var styleDirty = true
  private var highlightRaw = ""
  private var highlightDirty = false
  private var grid = false
  private var gridDirty = false
  var swipeEnabled = true
  var menuEnabled = true
  private var menuItems: List<NTMenuItem> = emptyList()
  private var labels: Map<String, String> = emptyMap()
  private var topInsetPx = 0
  private var bottomInsetPx = 0
  private var scrollTopSeq = 0.0

  private val refresh = SwipeRefreshLayout(context)
  private val recycler = RecyclerView(context)
  private val layoutManager = GridLayoutManager(context, 1)
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
          val r = NTRow.from(m)
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
        val r = NTRow.from(m)
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

  fun setColorsProp(m: Map<String, Any?>?) {
    colorsMap = m
    styleDirty = true
  }

  fun setHighlightProp(q: String?) {
    val v = q ?: ""
    if (v == highlightRaw) return
    highlightRaw = v
    highlightDirty = true
  }

  fun setLayoutModeProp(mode: String?) {
    val g = mode == "grid"
    if (g == grid) return
    grid = g
    gridDirty = true
  }

  fun setLabelsProp(m: Map<String, Any?>?) {
    labels = m?.mapValues { CLVal.str(it.value) } ?: emptyMap()
  }

  fun setMenuProp(list: List<Any?>?) {
    menuItems = list?.mapNotNull { CLVal.map(it)?.let { m -> NTMenuItem(m) } }
      ?.filter { it.action.isNotEmpty() && it.title.isNotEmpty() } ?: emptyList()
  }

  fun setRefreshEnabledProp(on: Boolean) {
    refresh.isEnabled = on
  }

  fun setRefreshingProp(on: Boolean) {
    if (refresh.isRefreshing != on) refresh.isRefreshing = on
  }

  fun setTopInset(v: Double) {
    val px = (max(0.0, v) * density).toInt()
    if (px != topInsetPx) {
      topInsetPx = px
      applyPadding()
    }
  }

  fun setBottomInset(v: Double) {
    val px = (max(0.0, v) * density).toInt()
    if (px != bottomInsetPx) {
      bottomInsetPx = px
      applyPadding()
    }
  }

  private fun applyPadding() {
    val h = (NTMetrics.outerH * density).toInt()
    recycler.setPadding(h, topInsetPx, h, bottomInsetPx)
  }

  fun setScrollToTopSeqProp(v: Double) {
    if (v <= scrollTopSeq) { scrollTopSeq = max(scrollTopSeq, v); return }
    val first = scrollTopSeq == 0.0
    scrollTopSeq = v
    if (first && !firstPaintSent) return
    recycler.scrollToPosition(0)
  }

  fun commitProps() {
    var rebindAll = false
    if (styleDirty || highlightDirty || gridDirty) {
      val colors = CTColors(colorsMap)
      val card = CTColor.of(colorsMap?.get("card")) ?: if (colors.dark) Color.parseColor("#1C1C1E") else Color.WHITE
      val border = CTColor.of(colorsMap?.get("cardBorder")) ?: if (colors.dark) Color.argb(15, 255, 255, 255) else Color.argb(10, 0, 0, 0)
      style = NTStyle(colors, card, border, RLHighlight.tokens(highlightRaw), grid)
      if (styleDirty) {
        setBackgroundColor(colors.bg)
        recycler.setBackgroundColor(colors.bg)
        refresh.setColorSchemeColors(colors.text)
        refresh.setProgressBackgroundColorSchemeColor(if (colors.dark) 0xFF1C1C1E.toInt() else 0xFFFFFFFF.toInt())
      }
      if (gridDirty) updateSpanCount()
      styleDirty = false
      highlightDirty = false
      gridDirty = false
      rebindAll = true
    }
    applyData(rebindAll)
  }

  private fun updateSpanCount() {
    val wDp = if (width > 0) width / density else context.resources.configuration.screenWidthDp.toFloat()
    val n = if (!grid) 1 else if (wDp >= 700f) 3 else 2
    if (layoutManager.spanCount != n) layoutManager.spanCount = n
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w != oldw) main.post { updateSpanCount() }
  }

  // ─── Dados → adapter ─────────────────────────────────────────────────────

  private var items: List<String> = emptyList()
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
      if (ids.size < rows.size) for (id in rows.keys.sorted()) if (seen.add(id)) ids.add(id)
      order = ids

      val old = items
      val changed = if (rebindAll || pendingReset) HashSet(ids) else HashSet(dirty)
      dirty.clear()
      val reset = pendingReset
      pendingReset = false
      if (reset && (old.isEmpty() || ids.size > 300)) {
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
        recycler.post { onFirstPaint(mapOf("count" to ids.size)) }
      }
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("apply: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class NoteHolder(val card: NTCardView) : RecyclerView.ViewHolder(card)
  private class SectionHolder(val section: NTSectionView) : RecyclerView.ViewHolder(section)

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int =
      if (rows[items[position]]?.kind == "s") TYPE_SECTION else TYPE_NOTE

    override fun getItemId(position: Int): Long = stableId(items[position])

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val lp = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
      if (viewType == TYPE_SECTION) {
        val v = NTSectionView(parent.context)
        v.layoutParams = lp
        return SectionHolder(v)
      }
      val v = NTCardView(parent.context)
      v.layoutParams = lp
      v.setOnClickListener { onRowPress(mapOf("id" to v.row.id)) }
      v.setOnLongClickListener { showMenu(v) }
      return NoteHolder(v)
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
          is NoteHolder -> holder.card.bind(row, style)
          is SectionHolder -> holder.section.bind(row, style)
        }
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  // ─── Menu do toque longo ─────────────────────────────────────────────────

  private fun showMenu(v: NTCardView): Boolean {
    if (!menuEnabled || menuItems.isEmpty()) return false
    val row = v.row
    if (row.id.isEmpty()) return false
    return try {
      v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      val pm = PopupMenu(context, v, Gravity.END)
      val normal = menuItems.filter { !it.destructive }
      val destructive = menuItems.filter { it.destructive }
      val all = normal + destructive
      all.forEachIndexed { i, item ->
        val title: CharSequence = if (item.destructive) {
          SpannableString(item.titleFor(row)).apply {
            setSpan(ForegroundColorSpan(style.colors.error), 0, length, 0)
          }
        } else item.titleFor(row)
        val group = if (item.destructive) 2 else 1
        pm.menu.add(group, i, i, title)
      }
      try { pm.menu.setGroupDividerEnabled(true) } catch (_: Throwable) {}
      pm.setOnMenuItemClickListener { mi ->
        val item = all.getOrNull(mi.itemId) ?: return@setOnMenuItemClickListener false
        onRowAction(mapOf("id" to row.id, "action" to item.action, "source" to "menu"))
        true
      }
      pm.show()
      true
    } catch (_: Throwable) {
      false
    }
  }

  // ─── Swipe (← Apagar · → Fixar) ──────────────────────────────────────────

  private val swipePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val swipeText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textAlign = Paint.Align.CENTER
    textSize = 12f * density
    typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
  }
  private val swipeRect = RectF()

  private inner class SwipeCallback : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.LEFT or ItemTouchHelper.RIGHT) {
    override fun getSwipeDirs(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int {
      if (vh !is NoteHolder || !swipeEnabled || grid) return 0
      return super.getSwipeDirs(rv, vh)
    }

    override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean = false

    override fun getSwipeThreshold(vh: RecyclerView.ViewHolder): Float = 0.4f

    override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {
      val holder = vh as? NoteHolder ?: return
      val id = holder.card.row.id
      holder.card.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
      val action = if (direction == ItemTouchHelper.LEFT) "delete" else "pin"
      onRowAction(mapOf("id" to id, "action" to action, "source" to "swipe"))
      // Volta o card se o JS não remover (fixar sempre volta; apagar some pelo patch).
      main.postDelayed({
        val p = items.indexOf(id)
        if (p >= 0) adapter.notifyItemChanged(p, PAYLOAD_BIND)
      }, if (action == "pin") 0L else 350L)
    }

    override fun onChildDraw(c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder, dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      if (actionState == ItemTouchHelper.ACTION_STATE_SWIPE && vh is NoteHolder && dX != 0f) {
        val card = vh.card
        card.cardBounds(swipeRect)
        val left = dX < 0f
        val isPinned = card.row.pinned
        swipePaint.color = if (left) style.colors.error else style.colors.primary
        val fg = if (left) Color.WHITE else style.colors.onPrimary
        val rad = NTMetrics.radius * density
        c.drawRoundRect(swipeRect, rad, rad, swipePaint)
        val w = 96f * density
        val cx = if (left) swipeRect.right - min(abs(dX), w) / 2f else swipeRect.left + min(abs(dX), w) / 2f
        val cy = swipeRect.centerY()
        val alpha = (min(1f, abs(dX) / w) * 255).toInt()
        val icon = if (left) R.drawable.ccl_ic_trash else R.drawable.ccl_ic_pin
        tintedIcon(context, icon, fg)?.let { d ->
          val s = (18 * density).toInt()
          d.alpha = alpha
          d.setBounds((cx - s / 2f).toInt(), (cy - s - 2 * density).toInt(), (cx + s / 2f).toInt(), (cy - 2 * density).toInt())
          d.draw(c)
        }
        val label = if (left) labels["delete"] ?: "Apagar"
          else if (isPinned) labels["unpin"] ?: "Desafixar" else labels["pin"] ?: "Fixar"
        swipeText.color = fg
        swipeText.alpha = alpha
        c.drawText(label, cx, cy + 14 * density, swipeText)
      }
      super.onChildDraw(c, rv, vh, dX, dY, actionState, isCurrentlyActive)
    }
  }

  private fun hideKeyboard() {
    try {
      val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
      if (imm.isAcceptingText) imm.hideSoftInputFromWindow(windowToken, 0)
    } catch (_: Throwable) {}
  }

  // init no FIM: todas as propriedades acima já estão inicializadas.
  init {
    layoutManager.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
      override fun getSpanSize(position: Int): Int {
        val id = items.getOrNull(position) ?: return layoutManager.spanCount
        return if (rows[id]?.kind == "s") layoutManager.spanCount else 1
      }
    }
    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.setItemViewCacheSize(8)
    recycler.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 160
      addDuration = 120
      removeDuration = 120
    }
    applyPadding()
    refresh.isEnabled = false
    refresh.addView(recycler, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    refresh.setOnRefreshListener { onRefresh(mapOf<String, Any>()) }
    addView(refresh, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    touchHelper.attachToRecyclerView(recycler)
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_DRAGGING) hideKeyboard()
      }
    })
    setBackgroundColor(style.colors.bg)
  }

  override fun onDetachedFromWindow() {
    main.removeCallbacksAndMessages(null)
    super.onDetachedFromWindow()
  }

  companion object {
    private const val TYPE_NOTE = 1
    private const val TYPE_SECTION = 2
    private val PAYLOAD_BIND = Any()
  }
}
