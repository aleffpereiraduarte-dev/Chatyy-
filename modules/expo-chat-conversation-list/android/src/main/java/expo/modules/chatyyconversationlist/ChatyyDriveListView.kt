package expo.modules.chatyyconversationlist

// [2026-10-15 native-drive] Lista/grade de ARQUIVOS nativa (Android) —
// app/drive.js e app/files.js. RecyclerView + GridLayoutManager (lista = 1
// coluna; seções ocupam a linha inteira) + DiffUtil (payload, sem piscar),
// miniaturas Glide com cache em disco, seleção múltipla controlada pelo JS
// (selectionMode + selectedIds), swipe dos dois lados na lista
// (ItemTouchHelper → 1ª ação de `sw`/`sl`), toque longo → PopupMenu com as
// ações de `mn` (sem menu → onLongPress), barra de envio com progresso no topo,
// SwipeRefreshLayout e fim da lista. Mesmo contrato do iOS
// (ios/ChatyyDriveListView.swift). O nativo só desenha: as ações voltam por id
// e a tela roda os fluxos JS de sempre (confirmações, modais, toasts).

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
import android.widget.FrameLayout
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
class ChatyyDriveListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onLongPress by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onEndReached by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  // Dados
  private val rows = HashMap<String, DVRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private val dirty = HashSet<String>()
  private var pendingReset = false
  private var needsApply = false
  private var firstPaintSent = false

  // Aparência / modos
  private var colorsMap: Map<String, Any?>? = null
  private var style = DVStyle()
  private var labels = DVLabels()
  private var styleDirty = true
  private var highlightRaw = ""
  private var highlightDirty = false
  private var mode = "list"
  private var columns = 0
  private var modeDirty = false
  private var selectionMode = false
  private var selected: Set<String> = emptySet()
  private var selectionDirty = false
  private var uploads: List<DVUpload> = emptyList()
  private var uploadsDirty = false
  var swipeEnabled = true
  private var topInsetPx = 0
  private var bottomInsetPx = 0
  private var barPx = 0
  private var scrollTopSeq = 0.0
  private var endReachedFor = -1

  private val frame = FrameLayout(context)
  private val refresh = SwipeRefreshLayout(context)
  private val recycler = RecyclerView(context)
  private val layoutManager = GridLayoutManager(context, 1)
  private val adapter = Adapter()
  private val uploadBar = DVUploadBar(context)
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
          val r = DVRow.from(m)
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
        val r = DVRow.from(m)
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

  fun setLabelsProp(m: Map<String, Any?>?) {
    labels = DVLabels(m)
    uploadsDirty = true
  }

  fun setHighlightProp(q: String?) {
    val v = q ?: ""
    if (v == highlightRaw) return
    highlightRaw = v
    highlightDirty = true
  }

  fun setModeProp(m: String?) {
    val n = if (m == "grid") "grid" else "list"
    if (n == mode) return
    mode = n
    modeDirty = true
  }

  fun setColumnsProp(c: Int) {
    val n = c.coerceIn(0, 8)
    if (n == columns) return
    columns = n
    if (mode == "grid") modeDirty = true
  }

  fun setSelectionModeProp(on: Boolean) {
    if (on == selectionMode) return
    selectionMode = on
    selectionDirty = true
  }

  fun setSelectedIdsProp(ids: List<String>?) {
    val n = ids?.toHashSet() ?: emptySet<String>()
    if (n == selected) return
    for (id in n) if (!selected.contains(id)) dirty.add(id)
    for (id in selected) if (!n.contains(id)) dirty.add(id)
    selected = n
    selectionDirty = true
  }

  fun setUploadsProp(v: List<Any?>?) {
    uploads = DVUpload.parse(v)
    uploadsDirty = true
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

  fun setScrollToTopSeqProp(v: Double) {
    if (v <= scrollTopSeq) { scrollTopSeq = max(scrollTopSeq, v); return }
    val first = scrollTopSeq == 0.0
    scrollTopSeq = v
    if (first && !firstPaintSent) return
    recycler.scrollToPosition(0)
  }

  fun setAuthToken(t: String?) {
    if (!t.isNullOrEmpty()) CLAuth.token = t
  }

  private fun gridPadPx(): Int = if (mode == "grid") (12 * density).toInt() - (5 * density).toInt() else 0

  private fun applyPadding() {
    val extra = if (barPx > 0) barPx + (16 * density).toInt() else 0
    val side = gridPadPx()
    recycler.setPadding(side, topInsetPx + extra + (if (mode == "grid") (2 * density).toInt() else 0), side, bottomInsetPx)
    val lp = uploadBar.layoutParams as? FrameLayout.LayoutParams
    if (lp != null) {
      val m = (12 * density).toInt()
      lp.setMargins(m, topInsetPx + (8 * density).toInt(), m, 0)
      uploadBar.layoutParams = lp
    }
    // Progress do puxar-p/-atualizar abaixo do inset (header sólido por cima).
    refresh.setProgressViewOffset(false, topInsetPx, topInsetPx + (64 * density).toInt())
  }

  private fun effectiveColumns(): Int {
    if (mode != "grid") return 1
    if (columns > 0) return columns
    val wDp = (if (width > 0) width else resources.displayMetrics.widthPixels) / density
    return if (wDp >= 700) 4 else if (wDp >= 500) 3 else 2
  }

  fun commitProps() {
    var rebindAll = false
    if (styleDirty || highlightDirty || selectionDirty) {
      val colors = CTColors(colorsMap)
      val card = CTColor.of(colorsMap?.get("card")) ?: if (colors.dark) Color.parseColor("#111113") else Color.WHITE
      val selBg = CTColor.of(colorsMap?.get("selBg")) ?: if (colors.dark) Color.argb(26, 255, 255, 255) else Color.argb(15, 0, 0, 0)
      val modeChanged = style.selectionMode != selectionMode
      style = DVStyle(colors, card, selBg, RLHighlight.tokens(highlightRaw), selectionMode, selected)
      if (styleDirty) {
        setBackgroundColor(colors.bg)
        recycler.setBackgroundColor(colors.bg)
        refresh.setColorSchemeColors(colors.text)
        refresh.setProgressBackgroundColorSchemeColor(if (colors.dark) 0xFF1C1C1E.toInt() else 0xFFFFFFFF.toInt())
        uploadsDirty = true
      }
      rebindAll = styleDirty || highlightDirty || modeChanged
      if (selectionDirty && !rebindAll) needsApply = true
      styleDirty = false
      highlightDirty = false
      selectionDirty = false
    }
    if (modeDirty) {
      modeDirty = false
      layoutManager.spanCount = effectiveColumns()
      applyPadding()
      // Lista ↔ grade troca o tipo da view: recria tudo.
      if (firstPaintSent) {
        adapter.notifyDataSetChanged()
      }
    }
    if (uploadsDirty) {
      uploadsDirty = false
      applyUploads()
    }
    applyData(rebindAll)
  }

  private fun applyUploads() {
    val wasShown = barPx > 0
    if (uploads.isEmpty()) {
      if (wasShown) {
        barPx = 0
        uploadBar.animate().alpha(0f).setDuration(180L).withEndAction {
          if (barPx == 0) uploadBar.visibility = View.GONE
        }.start()
        applyPadding()
      }
      return
    }
    uploadBar.bind(uploads, style, labels)
    uploadBar.visibility = View.VISIBLE
    val w = if (width > 0) width - (24 * density).toInt() else resources.displayMetrics.widthPixels - (24 * density).toInt()
    uploadBar.measure(
      View.MeasureSpec.makeMeasureSpec(max(1, w), View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
    )
    val h = uploadBar.measuredHeight
    if (!wasShown) {
      uploadBar.alpha = 0f
      uploadBar.translationY = -8 * density
      uploadBar.animate().alpha(1f).translationY(0f).setDuration(200L).start()
    }
    if (h != barPx) {
      barPx = h
      applyPadding()
    }
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
      endReachedFor = -1
      if (!firstPaintSent) {
        firstPaintSent = true
        recycler.post { onFirstPaint(mapOf("count" to ids.size)) }
      }
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("apply: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class ListHolder(val rowView: DVListRowView) : RecyclerView.ViewHolder(rowView)
  private class GridHolder(val cardView: DVGridCardView) : RecyclerView.ViewHolder(cardView)
  private class SectionHolder(val sectionView: DVSectionView) : RecyclerView.ViewHolder(sectionView)

  private fun idAt(holder: RecyclerView.ViewHolder): String? {
    val p = holder.bindingAdapterPosition
    return if (p == RecyclerView.NO_POSITION) null else items.getOrNull(p)
  }

  private fun press(holder: RecyclerView.ViewHolder) {
    val id = idAt(holder) ?: return
    if (style.selectionMode) holder.itemView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    onRowPress(mapOf("id" to id))
  }

  private fun longPress(holder: RecyclerView.ViewHolder): Boolean {
    val id = idAt(holder) ?: return false
    val row = rows[id] ?: return false
    if (style.selectionMode) return false
    holder.itemView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    if (row.menu.isEmpty() || !showMenu(holder.itemView, row)) {
      onLongPress(mapOf("id" to id))
    }
    return true
  }

  private fun showMenu(anchor: View, row: DVRow): Boolean {
    return try {
      val pm = PopupMenu(context, anchor, Gravity.END)
      row.menu.forEachIndexed { i, a ->
        val t = labels.action(a, row.starred)
        val title: CharSequence = if (DVGlyphs.isDestructive(a)) {
          SpannableString(t).apply { setSpan(ForegroundColorSpan(style.colors.error), 0, length, 0) }
        } else t
        pm.menu.add(Menu.NONE, i, i, title)
      }
      pm.setOnMenuItemClickListener { item ->
        val a = row.menu.getOrNull(item.itemId)
        if (a != null) onRowAction(mapOf("id" to row.id, "action" to a, "source" to "menu"))
        true
      }
      pm.show()
      true
    } catch (_: Throwable) { false }
  }

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when {
      rows[items[position]]?.kind == "s" -> TYPE_SECTION
      mode == "grid" -> TYPE_GRID
      else -> TYPE_LIST
    }

    override fun getItemId(position: Int): Long = stableId(items[position])

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      return when (viewType) {
        TYPE_SECTION -> {
          val v = DVSectionView(parent.context)
          v.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
          SectionHolder(v)
        }
        TYPE_GRID -> {
          val v = DVGridCardView(parent.context)
          v.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, gridItemHeight(parent))
          val h = GridHolder(v)
          v.setOnClickListener { press(h) }
          v.setOnLongClickListener { longPress(h) }
          h
        }
        else -> {
          val v = DVListRowView(parent.context)
          v.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
          val h = ListHolder(v)
          v.setOnClickListener { press(h) }
          v.setOnLongClickListener { longPress(h) }
          h
        }
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      bind(holder, position)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
      bind(holder, position)
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
      when (holder) {
        is ListHolder -> holder.rowView.recycle()
        is GridHolder -> holder.cardView.recycle()
      }
    }

    private fun bind(holder: RecyclerView.ViewHolder, position: Int) {
      val id = items.getOrNull(position) ?: return
      val row = rows[id] ?: return
      try {
        when (holder) {
          is ListHolder -> holder.rowView.bind(row, style)
          is GridHolder -> {
            val want = gridItemHeight(recycler)
            val lp = holder.cardView.layoutParams
            if (lp != null && lp.height != want) { lp.height = want; holder.cardView.layoutParams = lp }
            holder.cardView.bind(row, style)
          }
          is SectionHolder -> holder.sectionView.bind(row, style)
        }
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  /** Altura do cartão: área da miniatura (0,78 × largura) + texto + vão. */
  private fun gridItemHeight(parent: View): Int {
    val cols = max(1, layoutManager.spanCount)
    val total = (if (parent.width > 0) parent.width else resources.displayMetrics.widthPixels) - 2 * gridPadPx()
    val cell = total / cols
    val inner = cell - (10 * density).toInt()
    return (inner * 0.78f).toInt() + (58 * density).toInt() + (10 * density).toInt()
  }

  // ─── Swipe (lista) ───────────────────────────────────────────────────────

  private val swipePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val swipeText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = 0xFFFFFFFF.toInt()
    textAlign = Paint.Align.CENTER
    textSize = 12f * density
    typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
  }
  private val swipeRect = RectF()

  private fun swipeColor(a: String): Int {
    if (DVGlyphs.isDestructive(a)) return style.colors.error
    return if (style.colors.dark) Color.parseColor("#48484A") else Color.parseColor("#48484A")
  }

  private inner class SwipeCallback : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.LEFT or ItemTouchHelper.RIGHT) {
    override fun getSwipeDirs(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int {
      if (vh !is ListHolder || !swipeEnabled || style.selectionMode || mode != "list") return 0
      val r = vh.rowView.row
      var dirs = 0
      if (r.swipe.isNotEmpty()) dirs = dirs or ItemTouchHelper.LEFT
      if (r.swipeLeft.isNotEmpty()) dirs = dirs or ItemTouchHelper.RIGHT
      return dirs
    }

    override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean = false

    override fun getSwipeThreshold(vh: RecyclerView.ViewHolder): Float = 0.4f

    override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {
      val holder = vh as? ListHolder ?: return
      val r = holder.rowView.row
      val a = (if (direction == ItemTouchHelper.LEFT) r.swipe else r.swipeLeft).firstOrNull()
      holder.rowView.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
      if (a != null) onRowAction(mapOf("id" to r.id, "action" to a, "source" to "swipe"))
      // Volta a linha se o JS não remover (o patch de remoção chega antes).
      val id = r.id
      main.postDelayed({
        val p = items.indexOf(id)
        if (p >= 0) adapter.notifyItemChanged(p, PAYLOAD_BIND)
      }, 350L)
    }

    override fun onChildDraw(c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder, dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      if (actionState == ItemTouchHelper.ACTION_STATE_SWIPE && vh is ListHolder && dX != 0f) {
        val v = vh.itemView
        val r = vh.rowView.row
        val left = dX < 0f
        val a = (if (left) r.swipe else r.swipeLeft).firstOrNull()
        if (a != null) {
          swipePaint.color = swipeColor(a)
          if (left) swipeRect.set(v.right + dX, v.top.toFloat(), v.right.toFloat(), v.bottom.toFloat())
          else swipeRect.set(v.left.toFloat(), v.top.toFloat(), v.left + dX, v.bottom.toFloat())
          c.drawRect(swipeRect, swipePaint)
          val w = 84f * density
          val cx = if (left) v.right - min(abs(dX), w) / 2f else v.left + min(abs(dX), w) / 2f
          val cy = v.top + v.height / 2f
          val alpha = (min(1f, abs(dX) / w) * 255).toInt()
          tintedIcon(context, DVGlyphs.actionRes(a, r.starred), Color.WHITE)?.let { d ->
            val s = (18 * density).toInt()
            d.alpha = alpha
            d.setBounds((cx - s / 2f).toInt(), (cy - s - 2 * density).toInt(), (cx + s / 2f).toInt(), (cy - 2 * density).toInt())
            d.draw(c)
          }
          swipeText.alpha = alpha
          c.drawText(labels.action(a, r.starred), cx, cy + 14 * density, swipeText)
        }
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

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w != oldw && mode == "grid") {
      main.post {
        layoutManager.spanCount = effectiveColumns()
        adapter.notifyDataSetChanged()
      }
    }
    if (w != oldw && uploads.isNotEmpty()) main.post { applyUploads() }
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
    recycler.setItemViewCacheSize(10)
    recycler.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 160
      addDuration = 120
      removeDuration = 100
    }
    refresh.isEnabled = true
    refresh.addView(recycler, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    refresh.setOnRefreshListener { onRefresh(mapOf<String, Any>()) }
    frame.addView(refresh, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    uploadBar.visibility = View.GONE
    uploadBar.elevation = 2f * density
    frame.addView(uploadBar, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP))
    addView(frame, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    touchHelper.attachToRecyclerView(recycler)
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
        val last = layoutManager.findLastVisibleItemPosition()
        val count = adapter.itemCount
        if (count > 0 && last >= count - 6 && endReachedFor != count && dy > 0) {
          endReachedFor = count
          onEndReached(mapOf("count" to count))
        }
      }
      override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_DRAGGING) hideKeyboard()
      }
    })
    applyPadding()
    setBackgroundColor(style.colors.bg)
  }

  override fun onDetachedFromWindow() {
    main.removeCallbacksAndMessages(null)
    super.onDetachedFromWindow()
  }

  companion object {
    private const val TYPE_LIST = 1
    private const val TYPE_GRID = 2
    private const val TYPE_SECTION = 3
    private val PAYLOAD_BIND = Any()
  }
}
