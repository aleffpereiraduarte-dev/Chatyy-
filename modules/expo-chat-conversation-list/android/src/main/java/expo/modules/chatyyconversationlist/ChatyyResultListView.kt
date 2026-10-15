package expo.modules.chatyyconversationlist

// [2026-10-15 native-search-notifs] Lista de RESULTADOS nativa (Android) —
// busca global (components/GlobalSearch.js, app/search.js) e central de
// notificações (app/notifications.js, NotificationsHub, notifications-feed).
// RecyclerView + DiffUtil (payload, sem piscar), destaque do termo em spans
// (sem caixa/acento), swipe "Apagar" (ItemTouchHelper, só linhas com `sw`),
// SwipeRefreshLayout, fim da lista e teclado fechando ao arrastar. Mesmo
// contrato do iOS (ios/ChatyyResultListView.swift).

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
import android.view.inputmethod.InputMethodManager
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
class ChatyyResultListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onEndReached by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  // Dados
  private val rows = HashMap<String, RLRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private val dirty = HashSet<String>()
  private var pendingReset = false
  private var needsApply = false
  private var firstPaintSent = false
  private var separatorIds: Set<String> = emptySet()

  // Aparência / modos
  private var colorsMap: Map<String, Any?>? = null
  private var style = RLStyle()
  private var styleDirty = true
  private var highlightRaw = ""
  private var highlightDirty = false
  private var separators = false
  var swipeEnabled = true
  private var refreshEnabled = false
  private var topInsetPx = 0
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
          val r = RLRow.from(m)
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
        val r = RLRow.from(m)
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

  fun setSeparatorsProp(on: Boolean) {
    if (on == separators) return
    separators = on
    needsApply = true
  }

  fun setRefreshEnabledProp(on: Boolean) {
    refreshEnabled = on
    refresh.isEnabled = on
  }

  fun setRefreshingProp(on: Boolean) {
    if (refresh.isRefreshing != on) refresh.isRefreshing = on
  }

  fun setTopInset(v: Double) {
    val px = (max(0.0, v) * density).toInt()
    if (px != topInsetPx) {
      topInsetPx = px
      recycler.setPadding(0, topInsetPx, 0, bottomInsetPx)
    }
  }

  fun setBottomInset(v: Double) {
    val px = (max(0.0, v) * density).toInt()
    if (px != bottomInsetPx) {
      bottomInsetPx = px
      recycler.setPadding(0, topInsetPx, 0, bottomInsetPx)
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

  fun commitProps() {
    var rebindAll = false
    if (styleDirty || highlightDirty) {
      val colors = CTColors(colorsMap)
      style = RLStyle(colors, rlUnreadBg(colorsMap, colors.dark), RLHighlight.tokens(highlightRaw))
      if (styleDirty) {
        setBackgroundColor(colors.bg)
        recycler.setBackgroundColor(colors.bg)
        refresh.setColorSchemeColors(colors.text)
        refresh.setProgressBackgroundColorSchemeColor(if (colors.dark) 0xFF1C1C1E.toInt() else 0xFFFFFFFF.toInt())
      }
      styleDirty = false
      highlightDirty = false
      rebindAll = true
    }
    applyData(rebindAll)
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
      val seps = HashSet<String>()
      if (separators) {
        for (i in 0 until ids.size - 1) {
          if (rows[ids[i]]?.kind == "r" && rows[ids[i + 1]]?.kind == "r") seps.add(ids[i])
        }
      }
      val sepChanged = HashSet<String>()
      for (id in seps) if (!separatorIds.contains(id)) sepChanged.add(id)
      for (id in separatorIds) if (!seps.contains(id)) sepChanged.add(id)
      separatorIds = seps

      val old = items
      val changed = if (rebindAll || pendingReset) HashSet(ids) else HashSet(dirty).apply { addAll(sepChanged) }
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

  private class RowHolder(val rowView: RLRowView) : RecyclerView.ViewHolder(rowView)
  private class SectionHolder(val sectionView: RLSectionView) : RecyclerView.ViewHolder(sectionView)
  private class LoadingHolder(val loadingView: RLLoadingView) : RecyclerView.ViewHolder(loadingView)
  private class NoteHolder(val noteView: RLNoteView) : RecyclerView.ViewHolder(noteView)

  private val rowListener = object : RLRowView.Listener {
    override fun onPress(id: String) { onRowPress(mapOf("id" to id)) }
    override fun onAction(id: String, action: String) {
      onRowAction(mapOf("id" to id, "action" to action, "source" to "tap"))
    }
  }

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (rows[items[position]]?.kind) {
      "s" -> TYPE_SECTION
      "l" -> TYPE_LOADING
      "n" -> TYPE_NOTE
      else -> TYPE_ROW
    }

    override fun getItemId(position: Int): Long = stableId(items[position])

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val lp = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
      return when (viewType) {
        TYPE_SECTION -> {
          val v = RLSectionView(parent.context)
          v.layoutParams = lp
          v.onAction = { id -> onRowAction(mapOf("id" to id, "action" to "section", "source" to "tap")) }
          SectionHolder(v)
        }
        TYPE_LOADING -> {
          val v = RLLoadingView(parent.context)
          v.layoutParams = lp
          LoadingHolder(v)
        }
        TYPE_NOTE -> {
          val v = RLNoteView(parent.context)
          v.layoutParams = lp
          v.onPress = { id -> onRowPress(mapOf("id" to id)) }
          NoteHolder(v)
        }
        else -> {
          val v = RLRowView(parent.context)
          v.layoutParams = lp
          v.listener = rowListener
          RowHolder(v)
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
          is RowHolder -> holder.rowView.bind(row, style, separatorIds.contains(id))
          is SectionHolder -> holder.sectionView.bind(row, style)
          is LoadingHolder -> holder.loadingView.bind(row, style)
          is NoteHolder -> holder.noteView.bind(row, style)
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
      // Volta a linha se o JS não remover (o patch de remoção chega antes).
      main.postDelayed({
        val p = items.indexOf(id)
        if (p >= 0) adapter.notifyItemChanged(p, PAYLOAD_BIND)
      }, 350L)
    }

    override fun onChildDraw(c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder, dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      if (actionState == ItemTouchHelper.ACTION_STATE_SWIPE && vh is RowHolder && dX < 0f) {
        val v = vh.itemView
        swipePaint.color = style.colors.error
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
    recycler.setItemViewCacheSize(8)
    recycler.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 160
      addDuration = 120
      removeDuration = 100
    }
    refresh.isEnabled = false
    refresh.addView(recycler, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    refresh.setOnRefreshListener { onRefresh(mapOf<String, Any>()) }
    addView(refresh, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
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
    setBackgroundColor(style.colors.bg)
  }

  override fun onDetachedFromWindow() {
    main.removeCallbacksAndMessages(null)
    super.onDetachedFromWindow()
  }

  companion object {
    private const val TYPE_ROW = 1
    private const val TYPE_SECTION = 2
    private const val TYPE_LOADING = 3
    private const val TYPE_NOTE = 4
    private val PAYLOAD_BIND = Any()
  }
}
