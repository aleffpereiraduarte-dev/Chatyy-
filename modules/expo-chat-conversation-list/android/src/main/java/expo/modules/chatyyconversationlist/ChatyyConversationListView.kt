package expo.modules.chatyyconversationlist

// [2026-10-14 native-home] Lista de conversas NATIVA (Android): RecyclerView +
// DiffUtil (payload → atualiza a célula no lugar, sem o crossfade que "pisca"),
// ItemTouchHelper (swipe → lida/não lida e arquivar), PopupMenu no toque longo,
// Glide para avatares. Mesmo contrato de props/eventos do iOS
// (ios/ChatyyConversationListView.swift).
//
// Header/rodapé da home continuam em JS: os filhos RN desta view vão para os
// itens 0 (header) e último (rodapé) do RecyclerView, dentro de um contêiner
// que NÃO refaz o layout deles (o Fabric posiciona os filhos RN).

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
import android.widget.PopupMenu
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.chatyychatstore.ChatyyStoreDB
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** Contêiner do filho RN: mede pela altura que o Fabric deu ao filho e não o reposiciona. */
@SuppressLint("ViewConstructor")
internal class CLChildHost(ctx: Context, private val hint: () -> Int) : ViewGroup(ctx) {
  private val relayout = View.OnLayoutChangeListener { _, _, top, _, bottom, _, oldTop, _, oldBottom ->
    if (bottom - top != oldBottom - oldTop) post { requestLayout() }
  }

  init {
    clipChildren = false
    clipToPadding = false
  }

  fun attach(child: View) {
    if (child.parent === this) return
    (child.parent as? ViewGroup)?.removeView(child)
    addView(child)
    child.addOnLayoutChangeListener(relayout)
  }

  fun detach(child: View) {
    child.removeOnLayoutChangeListener(relayout)
    if (child.parent === this) removeView(child)
  }

  fun contentHeight(): Int {
    var h = 0
    for (i in 0 until childCount) {
      val c = getChildAt(i)
      h = max(h, c.bottom)
    }
    return if (h > 0) h else hint()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    // Não remede os filhos RN (o Fabric já mediu com tamanho exato).
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), contentHeight())
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    // no-op: o Fabric chama layout() nos filhos RN.
  }
}

@SuppressLint("ViewConstructor")
class ChatyyConversationListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // RecyclerView precisa do passe de layout do Android (o RN não refaz layout
  // de views nativas que pedem requestLayout).
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onRowPressIn by EventDispatcher()
  val onAvatarPress by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onLongPress by EventDispatcher()
  val onPeekRequest by EventDispatcher()
  val onPeekOpen by EventDispatcher()
  val onCollapsedChange by EventDispatcher()
  val onEndReached by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density

  // Dados
  private val rows = HashMap<String, CLRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private val dirty = HashSet<String>()
  private var pendingReset = false
  private var needsApply = false
  private var firstPaintSent = false

  // Aparência
  private var theme = CLTheme(false)
  private var themeDirty = true
  private var labels = CLLabels()
  private var labelsDirty = false
  private var selectionMode = false
  private var selectionDirty = false
  var swipeEnabled = true
  var menuEnabled = true
  var collapseOffsetDp = 34f
  private var collapsed = false
  private var bottomInsetPx = 0
  private var headerHintPx = 0
  private var footerHintPx = 0
  private var scrollTopSeq = 0.0
  private var endReachedFor = -1

  // Filhos RN
  private val rnChildren = ArrayList<View>()
  private val headerHost = CLChildHost(context) { headerHintPx }
  private val footerHost = CLChildHost(context) { footerHintPx }

  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()
  private val touchHelper: ItemTouchHelper = ItemTouchHelper(SwipeCallback())

  // ─── [2026-10-15 native-store fase 1.5] foto da HOME ──────────────────────
  // Espelho do iOS: prop `store` {a, r, n, s}; sem linhas do JS ainda → pinta a
  // foto do store; 1º reset do JS substitui; regrava as 60 primeiras sozinho.
  private var storeA = ""; private var storeR = ""; private var storeN = ""; private var storeS = "main"
  private var storeLoadStarted = false
  private var storeLoading = false
  private var photoActive = false
  private var jsHasRows = false
  private val rawRows = HashMap<String, Map<String, Any?>>()
  private var jsVersion = 0
  private var persistedVersion = 0
  private val persistRunnable = Runnable { persistNow() }

  fun setStore(v: Map<String, Any?>?) {
    if (v == null) { storeA = ""; main.removeCallbacks(persistRunnable); return }
    val a = CLVal.str(v["a"]); val r = CLVal.str(v["r"])
    if (a.isEmpty() || r.isEmpty()) { storeA = ""; return }
    if (storeA.isNotEmpty() && storeA != a) { main.removeCallbacks(persistRunnable); persistedVersion = jsVersion }
    storeA = a; storeR = r; storeN = CLVal.str(v["n"])
    storeS = CLVal.str(v["s"]).ifEmpty { "main" }
    if (jsHasRows || storeLoadStarted) return
    storeLoadStarted = true
    storeLoading = true
    val db = try { ChatyyStoreDB.get(context) } catch (_: Throwable) { null }
    if (db == null) { storeLoading = false; return }
    db.loadHome(a, storeS, r) { snap, _ ->
      storeLoading = false
      if (snap != null && !jsHasRows && storeA == a) {
        val next = HashMap<String, CLRow>(); val ids = ArrayList<String>()
        for (d in snap.rows) {
          val row = try { CLRow.from(d) } catch (_: Throwable) { continue }
          if (row.id.isEmpty() || next.containsKey(row.id)) continue
          next[row.id] = row; ids.add(row.id)
        }
        if (ids.isNotEmpty()) {
          rows.clear(); rows.putAll(next)
          order = ids
          photoActive = true
          pendingReset = true
          needsApply = true
        }
      }
      commitProps()
    }
  }

  private fun noteJSPatch() {
    jsHasRows = true
    photoActive = false
    storeLoading = false
    jsVersion += 1
    if (storeA.isNotEmpty()) { main.removeCallbacks(persistRunnable); main.postDelayed(persistRunnable, 1500) }
  }

  private fun persistNow() {
    main.removeCallbacks(persistRunnable)
    if (storeA.isEmpty() || !jsHasRows || selectionMode || persistedVersion == jsVersion) return
    persistedVersion = jsVersion
    val ids = ArrayList<String>(); val out = ArrayList<Map<String, Any?>>()
    for (id in order) {
      if (ids.size >= HOME_WINDOW) break
      val d0 = rawRows[id] ?: continue
      val d = HashMap(d0)
      d["typing"] = ""; d["selected"] = false; d["online"] = false; d["activity"] = ""
      ids.add(id); out.add(d)
    }
    try { ChatyyStoreDB.get(context).saveHome(storeA, storeS, storeR, storeN, ids, out) } catch (_: Throwable) {}
  }

  // ─── Props ───────────────────────────────────────────────────────────────

  fun setRowsPatch(p: Map<String, Any?>?) {
    if (p == null) return
    try {
      val pseq = CLVal.double(p["seq"])
      val reset = CLVal.list(p["reset"])
      if (reset != null) {
        // Reset novo é sempre aceito; o mesmo reset reenviado (o Android pode
        // reenviar todas as props) é ignorado.
        if (pseq == seq && firstPaintSent) return
        rows.clear()
        val track = true // [native-store] a prop store pode chegar depois do 1º reset
        if (track) rawRows.clear()
        val ids = ArrayList<String>()
        for (item in reset) {
          val m = CLVal.map(item) ?: continue
          val r = CLRow.from(m)
          if (r.id.isEmpty()) continue
          if (!rows.containsKey(r.id)) ids.add(r.id)
          rows[r.id] = r
          if (track) rawRows[r.id] = m
        }
        noteJSPatch()
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
      CLVal.list(p["remove"])?.forEach { rows.remove(CLVal.str(it)); rawRows.remove(CLVal.str(it)) }
      noteJSPatch()
      val hasOrder = p["order"] != null
      val appended = ArrayList<String>()
      CLVal.list(p["upsert"])?.forEach { item ->
        val m = CLVal.map(item) ?: return@forEach
        val r = CLRow.from(m)
        if (r.id.isEmpty()) return@forEach
        if (!rows.containsKey(r.id) && !hasOrder) appended.add(r.id)
        rows[r.id] = r
        rawRows[r.id] = m
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
    theme = CLTheme(dark)
    themeDirty = true
  }

  fun setSelectionModeProp(on: Boolean) {
    if (on == selectionMode) return
    selectionMode = on
    selectionDirty = true
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

  fun setScrollToTopSeqProp(v: Double) {
    if (v <= scrollTopSeq) { scrollTopSeq = max(scrollTopSeq, v); return }
    val first = scrollTopSeq == 0.0
    scrollTopSeq = v
    if (first && !firstPaintSent) return
    recycler.smoothScrollToPosition(0)
  }

  @Suppress("UNUSED_PARAMETER")
  fun setPeekProp(m: Map<String, Any?>?) {
    // Android não tem "peek" (convenção da plataforma: menu no toque longo).
  }

  fun commitProps() {
    // [native-store] foto da home lendo e o JS sem linhas: não aplica vazio.
    if (storeLoading && rows.isEmpty()) return
    var rebindAll = false
    if (themeDirty || selectionDirty) {
      setBackgroundColor(theme.bg)
      recycler.setBackgroundColor(theme.bg)
      themeDirty = false
      selectionDirty = false
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
        // Mantém o topo grudado quando a conversa nova sobe para o 1º lugar.
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
    val last = layoutManager.findLastVisibleItemPosition()
    val count = adapter.itemCount
    if (count > 2 && last >= count - 6 && endReachedFor != count) {
      endReachedFor = count
      onEndReached(mapOf("count" to count))
    }
  }

  // ─── Menu (toque longo) ──────────────────────────────────────────────────

  private var folders: List<CLFolder> = emptyList()

  fun setFoldersProp(list: List<Any?>?) {
    folders = (list ?: emptyList()).mapNotNull { CLVal.map(it)?.let { m -> CLFolder.from(m) } }
      .filter { it.id.isNotEmpty() && it.name.isNotEmpty() }
  }

  private fun showMenu(id: String, anchor: View) {
    val row = rows[id] ?: return
    if (photoActive) return // [native-store] só a foto: o JS ainda não conhece as conversas
    if (selectionMode || !menuEnabled) {
      onLongPress(mapOf("id" to id))
      return
    }
    // Menu nativo equivalente ao do iOS (WhatsApp) — CLMenu.kt (o mesmo da
    // fileira de fixados). Confirmação das destrutivas = handlers JS.
    val shown = CLMenu.show(context, anchor, id, row, labels, folders) { body -> onRowAction(body) }
    if (!shown) onLongPress(mapOf("id" to id))
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class HostHolder(v: View) : RecyclerView.ViewHolder(v)
  private class RowHolder(val rowView: CLRowView) : RecyclerView.ViewHolder(rowView)

  private val rowListener = object : CLRowView.Listener {
    override fun onPress(id: String) { onRowPress(mapOf("id" to id)) }
    override fun onPressIn(id: String) { onRowPressIn(mapOf("id" to id)) }
    override fun onAvatar(id: String) { onAvatarPress(mapOf("id" to id)) }
    override fun onLongPress(id: String, anchor: View) { showMenu(id, anchor) }
    override fun onA11yAction(id: String, action: String) {
      onRowAction(mapOf("id" to id, "action" to action, "source" to "a11y"))
    }
  }

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (items[position]) {
      is Item.Header -> TYPE_HEADER
      is Item.Footer -> TYPE_FOOTER
      is Item.Row -> TYPE_ROW
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
        // Uma instância só de cada contêiner (o filho RN mora nele).
        h.setIsRecyclable(false)
        return h
      }
      val v = CLRowView(parent.context)
      v.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
      v.listener = rowListener
      return RowHolder(v)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      bind(holder, position, false)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
      bind(holder, position, payloads.isNotEmpty())
    }

    private fun bind(holder: RecyclerView.ViewHolder, position: Int, animate: Boolean) {
      if (holder !is RowHolder) return
      val item = items.getOrNull(position) as? Item.Row ?: return
      val row = rows[item.id] ?: return
      try {
        holder.rowView.bind(row, theme, labels, selectionMode, animate && holder.rowView.isAttachedToWindow)
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  // ─── Swipe ───────────────────────────────────────────────────────────────

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
      if (vh !is RowHolder || !swipeEnabled || selectionMode || photoActive) return 0
      return super.getSwipeDirs(rv, vh)
    }

    override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean = false

    override fun getSwipeThreshold(vh: RecyclerView.ViewHolder): Float = 0.35f

    override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {
      val holder = vh as? RowHolder ?: return
      val id = holder.rowView.row.id
      val pos = holder.bindingAdapterPosition
      val action = if (direction == ItemTouchHelper.RIGHT) "toggleRead" else "archive"
      holder.rowView.performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
      onRowAction(mapOf("id" to id, "action" to action, "source" to "swipe"))
      // Volta a linha para o lugar (arquivar: o patch do JS a remove; se
      // não remover — ex. falhou —, ela reaparece sozinha).
      val delay = if (action == "archive") 700L else 0L
      main.postDelayed({
        val p = items.indexOfFirst { it is Item.Row && it.id == id }
        if (p >= 0) adapter.notifyItemChanged(p, PAYLOAD_BIND)
        else if (pos != RecyclerView.NO_POSITION && pos < adapter.itemCount) adapter.notifyItemChanged(pos)
      }, delay)
    }

    override fun onChildDraw(c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder, dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      if (actionState == ItemTouchHelper.ACTION_STATE_SWIPE && vh is RowHolder && dX != 0f) {
        val v = vh.itemView
        val row = vh.rowView.row
        val right = dX > 0
        val color = if (right) CLTheme.SWIPE_READ else CLTheme.SWIPE_ARCHIVE
        swipePaint.color = color
        if (right) swipeRect.set(v.left.toFloat(), v.top.toFloat(), v.left + dX, v.bottom.toFloat())
        else swipeRect.set(v.right + dX, v.top.toFloat(), v.right.toFloat(), v.bottom.toFloat())
        c.drawRect(swipeRect, swipePaint)
        val unread = row.unread > 0
        val label = if (right) {
          if (unread) labels.get("markRead", "Lida") else labels.get("markUnread", "Não lida")
        } else {
          if (row.archived) labels.get("unarchive", "Desarquivar") else labels.get("archive", "Arquivar")
        }
        val iconRes = if (right) (if (unread) R.drawable.ccl_ic_check else R.drawable.ccl_ic_message) else R.drawable.ccl_ic_archive
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

  // init no FIM: todas as propriedades acima já estão inicializadas.
  init {
    recycler.layoutManager = layoutManager
    // setHasStableIds ANTES de ligar o adapter (depois lança exceção).
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
    addView(recycler, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    touchHelper.attachToRecyclerView(recycler)
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) { onListScrolled() }
    })
    setBackgroundColor(theme.bg)
  }

  override fun onDetachedFromWindow() {
    persistNow() // [native-store] saiu da home → grava a foto já
    main.removeCallbacksAndMessages(null)
    super.onDetachedFromWindow()
  }

  companion object {
    private const val HOME_WINDOW = 60
    private const val TYPE_HEADER = 0
    private const val TYPE_ROW = 1
    private const val TYPE_FOOTER = 2
    private val PAYLOAD_BIND = Any()
  }
}
