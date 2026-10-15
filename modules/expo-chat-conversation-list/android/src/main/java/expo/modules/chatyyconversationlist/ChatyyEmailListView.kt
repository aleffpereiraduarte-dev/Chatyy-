package expo.modules.chatyyconversationlist

// [2026-10-15 native-inbox] Caixa de entrada do e-mail NATIVA (Android):
// RecyclerView + DiffUtil (payload), ItemTouchHelper (→ arquivar, ← excluir —
// mesmas cores do SwipeableRow JS), PopupMenu no toque longo (mesmas ações do
// emailMenuItems.js), SwipeRefreshLayout e paginação (onEndReached + spinner
// no rodapé). Mesmo contrato de props/eventos do iOS
// (ios/ChatyyEmailListView.swift). Cabeçalho/barra de seleção/vazio = JS.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.Menu
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
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
class ChatyyEmailListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onLeftPress by EventDispatcher()
  val onStarPress by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onLongPress by EventDispatcher()
  val onPeekRequest by EventDispatcher()
  val onPeekOpen by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onEndReached by EventDispatcher()
  val onVisibleIds by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  // Dados
  private val rows = HashMap<String, ELRow>()
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
  private var palette = ELPalette(false)
  private var paletteDirty = true
  private var dens = ELDensity()
  private var densDirty = false
  private var labels = CLLabels()
  private var labelsDirty = false
  private var selectionMode = false
  private var selectionDirty = false
  var swipeEnabled = true
  var menuEnabled = true
  private var loadingMore = false
  private var bottomInsetPx = 0
  private var scrollTopSeq = 0.0
  private var endReachedFor = -1

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
          val r = ELRow.from(m)
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
        val r = ELRow.from(m)
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

  fun setDark(v: Boolean) {
    if (v == dark && !paletteDirty) return
    dark = v
    paletteDirty = true
  }

  fun setPaletteProp(m: Map<String, Any?>?) {
    paletteMap = m
    paletteDirty = true
  }

  fun setDensityProp(m: Map<String, Any?>?) {
    dens = ELDensity(m)
    densDirty = true
  }

  fun setLabelsProp(m: Map<String, Any?>?) {
    labels = CLLabels(m)
    labelsDirty = true
  }

  fun setSelectionModeProp(on: Boolean) {
    if (on == selectionMode) return
    selectionMode = on
    selectionDirty = true
  }

  fun setAuthToken(t: String?) {
    if (!t.isNullOrEmpty()) CLAuth.token = t
  }

  @Suppress("UNUSED_PARAMETER")
  fun setPeekProp(m: Map<String, Any?>?) {
    // Android: sem "peek" (convenção da plataforma = menu no toque longo).
  }

  fun setRefreshingProp(on: Boolean) {
    if (refresh.isRefreshing != on) refresh.isRefreshing = on
  }

  fun setLoadingMoreProp(on: Boolean) {
    if (on == loadingMore) return
    loadingMore = on
    val p = items.indexOf(Item.Footer)
    if (p >= 0) adapter.notifyItemChanged(p)
  }

  fun setBottomInset(v: Double) {
    val px = (max(0.0, v) * density).toInt()
    if (px != bottomInsetPx) {
      bottomInsetPx = px
      recycler.setPadding(0, 0, 0, px)
    }
  }

  fun setScrollToTopSeqProp(v: Double) {
    if (v <= scrollTopSeq) { scrollTopSeq = max(scrollTopSeq, v); return }
    val first = scrollTopSeq == 0.0
    scrollTopSeq = v
    if (first && !firstPaintSent) return
    recycler.smoothScrollToPosition(0)
  }

  fun commitProps() {
    var rebindAll = false
    if (paletteDirty || selectionDirty) {
      palette = ELPalette(dark, paletteMap)
      setBackgroundColor(palette.bg)
      recycler.setBackgroundColor(palette.bg)
      refresh.setColorSchemeColors(palette.primary)
      refresh.setProgressBackgroundColorSchemeColor(if (palette.dark) 0xFF1C1C1E.toInt() else 0xFFFFFFFF.toInt())
      paletteDirty = false
      selectionDirty = false
      rebindAll = true
    }
    if (labelsDirty || densDirty) {
      labelsDirty = false
      densDirty = false
      rebindAll = true
    }
    applyData(rebindAll)
  }

  // ─── Dados → adapter ─────────────────────────────────────────────────────

  private sealed class Item {
    object Footer : Item()
    data class Row(val id: String) : Item()
  }

  private var items: List<Item> = listOf(Item.Footer)
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
      val next = ArrayList<Item>(ids.size + 1)
      for (id in ids) next.add(Item.Row(id))
      next.add(Item.Footer)
      val old = items
      val changed = if (rebindAll || pendingReset) HashSet(ids) else HashSet(dirty)
      dirty.clear()
      val reset = pendingReset
      pendingReset = false
      if (reset && old.size <= 1) {
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
        val atTop = !recycler.canScrollVertically(-1)
        items = next
        diff.dispatchUpdatesTo(adapter)
        if (atTop) recycler.scrollToPosition(0)
      }
      if (!firstPaintSent) {
        firstPaintSent = true
        recycler.post {
          onFirstPaint(mapOf("count" to ids.size))
          emitVisible()
        }
      }
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("apply: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  // ─── Scroll ──────────────────────────────────────────────────────────────

  private fun onListScrolled() {
    val last = layoutManager.findLastVisibleItemPosition()
    val count = adapter.itemCount
    if (count > 1 && last >= count - 6 && endReachedFor != count) {
      endReachedFor = count
      onEndReached(mapOf("count" to count))
    }
  }

  private fun emitVisible() {
    val first = layoutManager.findFirstVisibleItemPosition()
    val last = layoutManager.findLastVisibleItemPosition()
    if (first < 0 || last < first) return
    val ids = ArrayList<String>()
    for (i in first..min(last, items.size - 1)) {
      val it = items[i] as? Item.Row ?: continue
      val r = rows[it.id] ?: continue
      if (!r.isSection) ids.add(it.id)
    }
    if (ids.isNotEmpty()) onVisibleIds(mapOf("ids" to ids))
  }

  // ─── Menu (toque longo) — mesmas ações do emailMenuItems.js ─────────────

  private fun showMenu(id: String, anchor: View) {
    val row = rows[id] ?: return
    if (selectionMode || !menuEnabled) {
      onLongPress(mapOf("id" to id))
      return
    }
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
      val m = pm.menu
      var o = 0
      val read = !row.unread
      m.add(Menu.NONE, reg("reply"), o++, L.get("reply", "Responder"))
      m.add(Menu.NONE, reg("replyAll"), o++, L.get("replyAll", "Responder a todos"))
      m.add(Menu.NONE, reg("forward"), o++, L.get("forward", "Encaminhar"))
      m.add(Menu.NONE, reg(if (read) "markUnread" else "markRead"), o++,
        if (read) L.get("markUnread", "Marcar como não lido") else L.get("markRead", "Marcar como lido"))
      m.add(Menu.NONE, reg("star"), o++, if (row.starred) L.get("unstar", "Remover estrela") else L.get("star", "Adicionar estrela"))
      m.add(Menu.NONE, reg("snooze"), o++, L.get("snooze", "Adiar"))
      m.add(Menu.NONE, reg("mute"), o++, if (row.muted) L.get("unmute", "Reativar") else L.get("mute", "Silenciar"))
      m.add(Menu.NONE, reg("moveTo"), o++, L.get("moveTo", "Mover para"))
      m.add(Menu.NONE, reg("archive"), o++, L.get("archive", "Arquivar"))
      m.add(Menu.NONE, reg("select"), o++, L.get("select", "Selecionar"))
      m.add(Menu.NONE, reg("spam"), o++, red(L.get("spam", "Spam")))
      m.add(Menu.NONE, reg("delete"), o++, red(L.get("delete", "Excluir")))
      pm.setOnMenuItemClickListener { mi ->
        val a = actions.getOrNull(mi.itemId)
        if (a != null) onRowAction(mapOf("id" to id, "action" to a, "source" to "menu"))
        true
      }
      pm.show()
    } catch (_: Throwable) {
      onLongPress(mapOf("id" to id))
    }
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class RowHolder(val rowView: ELRowView) : RecyclerView.ViewHolder(rowView)
  private class SectionHolder(val sectionView: ELSectionView) : RecyclerView.ViewHolder(sectionView)
  private class FooterHolder(val box: FrameLayout, val spinner: ProgressBar) : RecyclerView.ViewHolder(box)

  private val rowListener = object : ELRowView.Listener {
    override fun onPress(id: String) { onRowPress(mapOf("id" to id)) }
    override fun onLeft(id: String) { onLeftPress(mapOf("id" to id)) }
    override fun onStar(id: String) { onStarPress(mapOf("id" to id)) }
    override fun onLongPress(id: String, anchor: View) { showMenu(id, anchor) }
    override fun onA11yAction(id: String, action: String) {
      onRowAction(mapOf("id" to id, "action" to action, "source" to "a11y"))
    }
  }

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (val it = items[position]) {
      is Item.Footer -> TYPE_FOOTER
      is Item.Row -> if (rows[it.id]?.isSection == true) TYPE_SECTION else TYPE_ROW
    }

    override fun getItemId(position: Int): Long = when (val it = items[position]) {
      is Item.Footer -> 2L
      is Item.Row -> stableId(it.id)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val lp = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
      return when (viewType) {
        TYPE_FOOTER -> {
          val box = FrameLayout(parent.context)
          box.layoutParams = lp
          val sp = ProgressBar(parent.context)
          sp.isIndeterminate = true
          val s = (24 * density).toInt()
          box.addView(sp, FrameLayout.LayoutParams(s, s, Gravity.CENTER))
          FooterHolder(box, sp)
        }
        TYPE_SECTION -> {
          val v = ELSectionView(parent.context)
          v.layoutParams = lp
          SectionHolder(v)
        }
        else -> {
          val v = ELRowView(parent.context)
          v.layoutParams = lp
          v.listener = rowListener
          RowHolder(v)
        }
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      try {
        when (holder) {
          is FooterHolder -> {
            val h = if (loadingMore) (56 * density).toInt() else 0
            holder.box.layoutParams = (holder.box.layoutParams ?: RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, h)).also { it.height = h }
            holder.spinner.visibility = if (loadingMore) View.VISIBLE else View.GONE
            holder.spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(palette.sub)
          }
          is SectionHolder -> {
            val item = items.getOrNull(position) as? Item.Row ?: return
            val row = rows[item.id] ?: return
            holder.sectionView.bind(row, palette, dens.padH)
          }
          is RowHolder -> {
            val item = items.getOrNull(position) as? Item.Row ?: return
            val row = rows[item.id] ?: return
            holder.rowView.bind(row, palette, dens, labels, selectionMode)
          }
        }
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  // ─── Swipe (→ arquivar verde, ← excluir vermelho; como o SwipeableRow JS) ──

  private val swipePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val swipeText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = 0xFFFFFFFF.toInt()
    textAlign = Paint.Align.CENTER
    textSize = 11.5f * density
    typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
  }
  private val swipeRect = RectF()

  private inner class SwipeCallback : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.LEFT or ItemTouchHelper.RIGHT) {
    override fun getSwipeDirs(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int {
      if (vh !is RowHolder || !swipeEnabled || selectionMode) return 0
      return super.getSwipeDirs(rv, vh)
    }

    override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean = false

    override fun getSwipeThreshold(vh: RecyclerView.ViewHolder): Float = 0.35f

    override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {
      val holder = vh as? RowHolder ?: return
      val id = holder.rowView.row.id
      val pos = holder.bindingAdapterPosition
      val action = if (direction == ItemTouchHelper.RIGHT) "archive" else "delete"
      holder.rowView.performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
      onRowAction(mapOf("id" to id, "action" to action, "source" to "swipe"))
      // O patch do JS remove a linha; se não remover (falhou/cancelou), volta.
      main.postDelayed({
        val p = items.indexOfFirst { it is Item.Row && it.id == id }
        if (p >= 0) adapter.notifyItemChanged(p)
        else if (pos != RecyclerView.NO_POSITION && pos < adapter.itemCount) adapter.notifyItemChanged(pos)
      }, 700L)
    }

    override fun onChildDraw(c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder, dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      if (actionState == ItemTouchHelper.ACTION_STATE_SWIPE && vh is RowHolder && dX != 0f) {
        val v = vh.itemView
        val right = dX > 0
        swipePaint.color = if (right) SWIPE_ARCHIVE else SWIPE_DELETE
        if (right) swipeRect.set(v.left.toFloat(), v.top.toFloat(), v.left + dX, v.bottom.toFloat())
        else swipeRect.set(v.right + dX, v.top.toFloat(), v.right.toFloat(), v.bottom.toFloat())
        c.drawRect(swipeRect, swipePaint)
        val label = if (right) labels.get("archive", "Arquivar") else labels.get("delete", "Excluir")
        val iconRes = if (right) R.drawable.ccl_ic_archive else R.drawable.ccl_ic_trash
        val w = 74f * density
        val cx = if (right) v.left + min(abs(dX), w) / 2f else v.right - min(abs(dX), w) / 2f
        val cy = v.top + v.height / 2f
        val alpha = (min(1f, abs(dX) / w) * 255).toInt()
        tintedIcon(context, iconRes, 0xFFFFFFFF.toInt())?.let { d ->
          val s = (20 * density).toInt()
          d.alpha = alpha
          d.setBounds((cx - s / 2f).toInt(), (cy - s - 2 * density).toInt(), (cx + s / 2f).toInt(), (cy - 2 * density).toInt())
          d.draw(c)
        }
        swipeText.alpha = alpha
        var txt = label
        val maxW = w - 6 * density
        while (txt.length > 3 && swipeText.measureText(txt) > maxW) txt = txt.dropLast(1)
        if (txt != label) txt = txt.dropLast(1) + "…"
        c.drawText(txt, cx, cy + 14 * density, swipeText)
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
    refresh.setOnRefreshListener { onRefresh(mapOf<String, Any>()) }
    addView(refresh, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    touchHelper.attachToRecyclerView(recycler)
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) { onListScrolled() }
      override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_IDLE) emitVisible()
      }
    })
    setBackgroundColor(palette.bg)
  }

  override fun onDetachedFromWindow() {
    main.removeCallbacksAndMessages(null)
    super.onDetachedFromWindow()
  }

  companion object {
    private const val TYPE_ROW = 1
    private const val TYPE_SECTION = 3
    private const val TYPE_FOOTER = 2
    private val PAYLOAD_BIND = Any()
    private val SWIPE_ARCHIVE = 0xFF2DA84E.toInt()
    private val SWIPE_DELETE = 0xFFE5392E.toInt()
  }
}
