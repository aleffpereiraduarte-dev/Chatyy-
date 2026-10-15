package expo.modules.chatyyconversationlist

// [2026-10-15 native-contacts] Lista de CONTATOS nativa (Android) — telas
// Contatos (app/contacts.js, aba "Meus contatos") e Nova conversa
// (app/chat-new.js, lista padrão). RecyclerView + DiffUtil (payload),
// cabeçalho de seção FIXO sobreposto (empurrado pelo seguinte, como a
// SectionList com stickySectionHeadersEnabled), índice A–Z lateral com arrasto,
// balão e haptic, swipe "Apagar" (só linhas com `sw`), puxar p/ atualizar leve
// (sem dependência nova) e teclado fechando ao arrastar. Mesmo contrato do iOS
// (ios/ChatyyContactListView.swift).
//
// Filhos RN: 0 = header (atalhos, favoritos…) que rola junto; 1 = rodapé.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

@SuppressLint("ViewConstructor")
class ChatyyContactListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onRowLongPress by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onEndReached by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  // Dados
  private val rows = HashMap<String, CTRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private val dirty = HashSet<String>()
  private var pendingReset = false
  private var needsApply = false
  private var firstPaintSent = false

  // Aparência / modos
  private var colors = CTColors()
  private var metrics = CTMetrics()
  private var styleDirty = true
  var swipeEnabled = true
  private var indexEnabled = true
  private var indexMin = 6
  private var refreshEnabled = false
  private var refreshing = false
  private var bottomInsetPx = 0
  private var headerHintPx = 0
  private var footerHintPx = 0
  private var scrollTopSeq = 0.0
  private var endReachedFor = -1

  // Seções / índice
  private var sectionPositions: IntArray = IntArray(0)   // posições (adapter) das seções
  private var letterPos = LinkedHashMap<String, Int>()     // letra → posição da seção

  // Filhos RN
  private val rnChildren = ArrayList<View>()
  private val headerHost = CLChildHost(context) { headerHintPx }
  private val footerHost = CLChildHost(context) { footerHintPx }

  private val root = FrameLayout(context)
  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()
  private val touchHelper: ItemTouchHelper = ItemTouchHelper(SwipeCallback())
  private val sticky = CTSectionView(context)
  private var stickyId = ""
  private val indexBar = CTIndexBar(context)
  private val bubble = TextView(context)
  private val bubbleBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
  private val spinner = ProgressBar(context)
  private val spinnerBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }

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
          val r = CTRow.from(m)
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
        val r = CTRow.from(m)
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
    colors = CTColors(m)
    styleDirty = true
  }

  fun setMetricsProp(m: Map<String, Any?>?) {
    metrics = CTMetrics(m)
    styleDirty = true
  }

  fun setIndexEnabled(on: Boolean) {
    indexEnabled = on
    main.post { updateOverlays() }
  }

  fun setIndexMin(v: Double) { indexMin = max(1, v.toInt()) }

  fun setRefreshEnabledProp(on: Boolean) { refreshEnabled = on }

  fun setRefreshingProp(on: Boolean) {
    if (on == refreshing) return
    refreshing = on
    if (on) showSpinnerAt(restSpinnerY(), 1f) else hideSpinner()
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
      main.post { updateOverlays() }
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
    if (styleDirty) {
      styleDirty = false
      setBackgroundColor(colors.bg)
      recycler.setBackgroundColor(colors.bg)
      indexBar.color = colors.indexText
      bubbleBg.setColor(colors.primary)
      bubble.setTextColor(colors.onPrimary)
      spinnerBg.setColor(if (colors.dark) Color.parseColor("#2C2C2E") else Color.WHITE)
      spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(colors.text)
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
      if (ids.size < rows.size) for (id in rows.keys.sorted()) if (seen.add(id)) ids.add(id)
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
      // Seções + letras do índice
      val secs = ArrayList<Int>()
      val letters = LinkedHashMap<String, Int>()
      next.forEachIndexed { pos, it ->
        if (it is Item.Row) {
          val r = rows[it.id]
          if (r != null && r.isSection) {
            secs.add(pos)
            if (r.ix.isNotEmpty() && !letters.containsKey(r.ix)) letters[r.ix] = pos
          }
        }
      }
      sectionPositions = secs.toIntArray()
      letterPos = letters
      indexBar.letters = letters.keys.toList()
      if (stickyId.isNotEmpty()) rows[stickyId]?.let { sticky.bind(it, colors) }
      recycler.post { updateOverlays() }
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

  // ─── Cabeçalho fixo + índice ─────────────────────────────────────────────

  private fun rowAt(pos: Int): CTRow? {
    val it = items.getOrNull(pos) as? Item.Row ?: return null
    return rows[it.id]
  }

  private fun updateOverlays() {
    try {
      updateSticky()
      updateIndex()
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("overlay: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  private fun updateSticky() {
    val first = layoutManager.findFirstVisibleItemPosition()
    if (first == RecyclerView.NO_POSITION || sectionPositions.isEmpty()) { sticky.visibility = GONE; return }
    // Seção corrente = última seção com posição ≤ first.
    var cur = -1
    var next = -1
    for (sp in sectionPositions) {
      if (sp <= first) cur = sp else { next = sp; break }
    }
    if (cur < 0) { sticky.visibility = GONE; return }
    val curView = layoutManager.findViewByPosition(cur)
    if (curView != null && curView.top >= 0) { sticky.visibility = GONE; return }
    val r = rowAt(cur) ?: run { sticky.visibility = GONE; return }
    if (r.id != stickyId || sticky.visibility != VISIBLE) {
      stickyId = r.id
      sticky.bind(r, colors)
    }
    if (sticky.visibility != VISIBLE) sticky.visibility = VISIBLE
    val h = if (sticky.height > 0) sticky.height else (curView?.height ?: 0)
    var ty = 0f
    if (next >= 0) {
      val nv = layoutManager.findViewByPosition(next)
      if (nv != null && h > 0 && nv.top < h) ty = (nv.top - h).toFloat()
    }
    sticky.translationY = min(0f, ty)
  }

  private fun headerVisibleBottom(): Int {
    val v = layoutManager.findViewByPosition(0) ?: return 0
    return max(0, v.bottom)
  }

  private fun updateIndex() {
    val letters = indexBar.letters
    val want = indexEnabled && letters.size >= indexMin
    if (!want) { indexBar.visibility = GONE; return }
    indexBar.rangeTop = headerVisibleBottom()
    indexBar.rangeBottom = max(0, height - bottomInsetPx)
    indexBar.visibility = if (indexBar.fits()) VISIBLE else GONE
  }

  private fun jumpTo(letter: String, y: Float) {
    val pos = letterPos[letter] ?: return
    layoutManager.scrollToPositionWithOffset(pos, 0)
    bubble.text = letter
    val s = bubble.layoutParams.height
    bubble.translationY = (y - s / 2f).coerceIn(0f, max(0f, (height - s).toFloat()))
    if (bubble.visibility != VISIBLE) {
      bubble.alpha = 0f
      bubble.visibility = VISIBLE
      bubble.animate().alpha(1f).setDuration(90).start()
    }
    recycler.post { updateOverlays() }
  }

  private fun releaseIndex() {
    bubble.animate().alpha(0f).setDuration(160).withEndAction { bubble.visibility = GONE }.start()
  }

  // ─── Puxar p/ atualizar (leve, sem SwipeRefreshLayout) ───────────────────

  private var pullStartY = -1f
  private var pulling = false
  private val pullThreshold get() = 72f * density
  private fun restSpinnerY(): Float = 14f * density

  private fun showSpinnerAt(y: Float, a: Float) {
    spinner.visibility = VISIBLE
    spinner.alpha = a
    spinner.translationY = y
  }

  private fun hideSpinner() {
    spinner.animate().alpha(0f).translationY(-40f * density).setDuration(180)
      .withEndAction { if (!refreshing) spinner.visibility = GONE }.start()
  }

  private fun handlePull(e: MotionEvent) {
    if (!refreshEnabled || refreshing) { pullStartY = -1f; pulling = false; return }
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        pullStartY = if (!recycler.canScrollVertically(-1)) e.rawY else -1f
        pulling = false
      }
      MotionEvent.ACTION_MOVE -> {
        if (pullStartY < 0f) {
          if (!recycler.canScrollVertically(-1)) pullStartY = e.rawY
          return
        }
        val dy = e.rawY - pullStartY
        if (dy > 8f * density && !recycler.canScrollVertically(-1)) {
          pulling = true
          spinner.animate().cancel()
          val d = min(dy * 0.5f, pullThreshold * 1.3f)
          showSpinnerAt(d - 40f * density, min(1f, d / pullThreshold))
          spinner.rotation = d * 2f
        } else if (pulling && dy <= 0f) {
          pulling = false
          hideSpinner()
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (pulling) {
          val d = min((e.rawY - pullStartY) * 0.5f, pullThreshold * 1.3f)
          if (d >= pullThreshold && e.actionMasked == MotionEvent.ACTION_UP) {
            refreshing = true
            recycler.performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
            spinner.animate().translationY(restSpinnerY()).alpha(1f).setDuration(160).start()
            onRefresh(mapOf<String, Any>())
            // Rede: se o JS nunca baixar `refreshing`, não fica girando.
            main.postDelayed({ if (refreshing) { refreshing = false; hideSpinner() } }, 10_000L)
          } else {
            hideSpinner()
          }
        }
        pulling = false
        pullStartY = -1f
      }
    }
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class HostHolder(v: View) : RecyclerView.ViewHolder(v)
  private class RowHolder(val rowView: CTRowView) : RecyclerView.ViewHolder(rowView)
  private class SectionHolder(val sectionView: CTSectionView) : RecyclerView.ViewHolder(sectionView)

  private val rowListener = object : CTRowView.Listener {
    override fun onPress(id: String) { onRowPress(mapOf("id" to id)) }
    override fun onLongPress(id: String) { onRowLongPress(mapOf("id" to id)) }
    override fun onAction(id: String, action: String) {
      onRowAction(mapOf("id" to id, "action" to action, "source" to "tap"))
    }
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
      if (viewType == TYPE_HEADER || viewType == TYPE_FOOTER) {
        val host = if (viewType == TYPE_HEADER) headerHost else footerHost
        (host.parent as? ViewGroup)?.removeView(host)
        host.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
        val h = HostHolder(host)
        h.setIsRecyclable(false)
        return h
      }
      if (viewType == TYPE_SECTION) {
        val v = CTSectionView(parent.context)
        v.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
        return SectionHolder(v)
      }
      val v = CTRowView(parent.context)
      v.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
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
      val item = items.getOrNull(position) as? Item.Row ?: return
      val row = rows[item.id] ?: return
      try {
        when (holder) {
          is RowHolder -> holder.rowView.bind(row, colors, metrics)
          is SectionHolder -> holder.sectionView.bind(row, colors)
        }
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  // ─── Swipe (Apagar) ──────────────────────────────────────────────────────

  private val swipePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val swipeText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = 0xFFFFFFFF.toInt()
    textAlign = Paint.Align.CENTER
    textSize = 12f * density
    typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
  }
  private val swipeRect = RectF()

  private inner class SwipeCallback : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.LEFT) {
    override fun getSwipeDirs(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int {
      if (vh !is RowHolder || !swipeEnabled || vh.rowView.row.swipe.isEmpty()) return 0
      return super.getSwipeDirs(rv, vh)
    }

    override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean = false

    override fun getSwipeThreshold(vh: RecyclerView.ViewHolder): Float = 0.4f

    override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {
      val holder = vh as? RowHolder ?: return
      val id = holder.rowView.row.id
      holder.rowView.performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
      onRowAction(mapOf("id" to id, "action" to "delete", "source" to "swipe"))
      // Volta a linha (o JS confirma e remove pelo patch; cancelado → fica).
      main.postDelayed({
        val p = items.indexOfFirst { it is Item.Row && it.id == id }
        if (p >= 0) adapter.notifyItemChanged(p, PAYLOAD_BIND)
      }, 350L)
    }

    override fun onChildDraw(c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder, dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      if (actionState == ItemTouchHelper.ACTION_STATE_SWIPE && vh is RowHolder && dX < 0f) {
        val v = vh.itemView
        swipePaint.color = colors.error
        swipeRect.set(v.right + dX, v.top.toFloat(), v.right.toFloat(), v.bottom.toFloat())
        c.drawRect(swipeRect, swipePaint)
        val w = 84f * density
        val cx = v.right - min(abs(dX), w) / 2f
        val cy = v.top + v.height / 2f
        val alpha = (min(1f, abs(dX) / w) * 255).toInt()
        tintedIcon(context, R.drawable.ccl_ic_trash, Color.WHITE)?.let { d ->
          val s = (18 * density).toInt()
          d.alpha = alpha
          d.setBounds((cx - s / 2f).toInt(), (cy - s - 2 * density).toInt(), (cx + s / 2f).toInt(), (cy - 2 * density).toInt())
          d.draw(c)
        }
        swipeText.alpha = alpha
        c.drawText(vh.rowView.row.swipe, cx, cy + 14 * density, swipeText)
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
    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.setItemViewCacheSize(10)
    recycler.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 200
      addDuration = 160
      removeDuration = 140
    }
    root.addView(recycler, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    sticky.visibility = GONE
    sticky.isClickable = true // não deixa o toque "atravessar" para a linha de baixo
    root.addView(sticky, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP))

    indexBar.visibility = GONE
    indexBar.onLetter = { l, y -> jumpTo(l, y) }
    indexBar.onRelease = { releaseIndex() }
    root.addView(indexBar, FrameLayout.LayoutParams((22 * density).toInt(), FrameLayout.LayoutParams.MATCH_PARENT, Gravity.END))

    val bs = (56 * density).toInt()
    bubble.background = bubbleBg
    bubble.gravity = Gravity.CENTER
    bubble.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
    bubble.typeface = CLType.weight(700)
    bubble.visibility = GONE
    bubble.elevation = 6f * density
    root.addView(bubble, FrameLayout.LayoutParams(bs, bs, Gravity.END or Gravity.TOP).apply { marginEnd = (44 * density).toInt() })

    val ss = (36 * density).toInt()
    spinner.isIndeterminate = true
    spinner.background = spinnerBg
    val sp = (8 * density).toInt()
    spinner.setPadding(sp, sp, sp, sp)
    spinner.elevation = 4f * density
    spinner.visibility = GONE
    root.addView(spinner, FrameLayout.LayoutParams(ss, ss, Gravity.CENTER_HORIZONTAL or Gravity.TOP))

    addView(root, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    touchHelper.attachToRecyclerView(recycler)
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
        updateOverlays()
        val last = layoutManager.findLastVisibleItemPosition()
        val count = adapter.itemCount
        if (count > 2 && last >= count - 6 && endReachedFor != count && dy > 0) {
          endReachedFor = count
          onEndReached(mapOf("count" to count))
        }
      }
      override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_DRAGGING) hideKeyboard()
      }
    })
    recycler.addOnItemTouchListener(object : RecyclerView.SimpleOnItemTouchListener() {
      override fun onInterceptTouchEvent(rv: RecyclerView, e: MotionEvent): Boolean {
        handlePull(e)
        return false
      }
    })
    recycler.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> updateOverlays() }
    setBackgroundColor(colors.bg)
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
