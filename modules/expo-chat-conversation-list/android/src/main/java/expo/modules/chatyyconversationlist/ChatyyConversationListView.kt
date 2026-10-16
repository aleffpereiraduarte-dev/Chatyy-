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
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.Shader
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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

/**
 * [2026-10-16 wave8-list] Faixa de VIDRO no topo da lista (header do app por
 * cima, prop `topInset`): transparente com o título grande na tela e borrada +
 * hairline quando ele termina de passar por baixo. Android 12+ = blur de
 * verdade (RenderNode + RenderEffect sobre o que a lista desenha nessa faixa);
 * abaixo disso = cor sólida translúcida. Não recebe toques.
 */
@SuppressLint("ViewConstructor")
internal class CLTopBar(ctx: Context, private val source: View) : View(ctx) {
  private var progress = 0f
  private var tint = 0xFFFFFFFF.toInt()
  private var hair = 0x1F000000
  private val paint = Paint()
  private var node: RenderNode? = null
  private var effectRadius = 0f
  /** true enquanto a lista é regravada para o blur (ignora pedidos de redesenho). */
  var recording = false
    private set

  init {
    isClickable = false
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    setWillNotDraw(false)
  }

  fun setColors(bg: Int, dark: Boolean) {
    tint = bg
    hair = if (dark) 0x1FFFFFFF else 0x1F000000
    invalidate()
  }

  fun setProgress(p: Float) {
    val v = p.coerceIn(0f, 1f)
    if (abs(v - progress) < 0.003f) return
    progress = v
    invalidate()
  }

  /** O conteúdo da lista mudou embaixo da faixa (scroll/animação). */
  fun contentChanged() {
    if (recording || progress <= 0f || visibility != VISIBLE) return
    postInvalidateOnAnimation()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width
    val h = height
    if (progress <= 0f || w <= 0 || h <= 0) return
    var blurred = false
    if (Build.VERSION.SDK_INT >= 31 && canvas.isHardwareAccelerated) {
      blurred = try { drawBlur(canvas, w, h) } catch (_: Throwable) { false }
    }
    paint.color = tint
    paint.alpha = ((if (blurred) 0.62f else 0.94f) * 255f * progress).toInt()
    canvas.drawRect(0f, 0f, w.toFloat(), h.toFloat(), paint)
    paint.color = hair
    paint.alpha = ((hair ushr 24) * progress).toInt()
    val hh = max(1f, resources.displayMetrics.density * 0.5f)
    canvas.drawRect(0f, h - hh, w.toFloat(), h.toFloat(), paint)
  }

  @androidx.annotation.RequiresApi(31)
  private fun drawBlur(canvas: Canvas, w: Int, h: Int): Boolean {
    val n = node ?: RenderNode("chatyyListTopBlur").also { node = it }
    val r = resources.displayMetrics.density * 20f
    if (r != effectRadius) {
      effectRadius = r
      n.setRenderEffect(RenderEffect.createBlurEffect(r, r, Shader.TileMode.CLAMP))
    }
    n.setPosition(0, 0, w, h)
    val rc = n.beginRecording(w, h)
    recording = true
    try {
      rc.drawColor(tint)
      rc.translate((source.left - left).toFloat(), (source.top - top).toFloat())
      source.draw(rc)
    } finally {
      recording = false
      n.endRecording()
    }
    n.setAlpha(progress)
    canvas.drawRenderNode(n)
    return true
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
  // [2026-10-16 wave8-list] header do app por cima (vidro) + snap do título
  // grande + prévia do toque longo ("peek") opcional.
  private var topInsetPx = 0
  private var snapPx = 0
  private var peekMode = "menu"
  private var peekDialog: CLPeekDialog? = null
  private var lastPeek: Map<String, Any?>? = null

  // Filhos RN
  private val rnChildren = ArrayList<View>()
  private val headerHost = CLChildHost(context) { headerHintPx }
  private val footerHost = CLChildHost(context) { footerHintPx }

  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()
  private val touchHelper: ItemTouchHelper = ItemTouchHelper(SwipeCallback())
  private val topBar = CLTopBar(context, recycler)

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
      recycler.setPadding(0, topInsetPx, 0, px)
    }
  }

  fun setTopInset(v: Double) {
    val px = (max(0.0, v) * density).toInt()
    if (px == topInsetPx) return
    val delta = px - topInsetPx
    val atTop = !recycler.canScrollVertically(-1)
    topInsetPx = px
    recycler.setPadding(0, px, 0, bottomInsetPx)
    topBar.visibility = if (px > 0) VISIBLE else GONE
    topBar.layoutParams = android.widget.FrameLayout.LayoutParams(android.widget.FrameLayout.LayoutParams.MATCH_PARENT, max(1, px), Gravity.TOP)
    if (atTop) {
      layoutManager.scrollToPositionWithOffset(0, 0)
    } else {
      // Ligou/desligou longe do topo: o conteúdo fica parado na tela.
      recycler.post { recycler.scrollBy(0, -delta) }
    }
    updateTopBar()
  }

  fun setSnapOffset(v: Double) {
    snapPx = (max(0.0, v) * density).toInt()
  }

  fun setPeekModeProp(v: String?) {
    peekMode = if (v == "peek") "peek" else "menu"
  }

  fun setScrollToTopSeqProp(v: Double) {
    if (v <= scrollTopSeq) { scrollTopSeq = max(scrollTopSeq, v); return }
    val first = scrollTopSeq == 0.0
    scrollTopSeq = v
    if (first && !firstPaintSent) return
    recycler.smoothScrollToPosition(0)
  }

  fun setPeekProp(m: Map<String, Any?>?) {
    // [wave8] prévia aberta → completa com as mensagens que o JS mandou.
    lastPeek = m
    if (m != null) peekDialog?.update(m)
  }

  fun commitProps() {
    // [native-store] foto da home lendo e o JS sem linhas: não aplica vazio.
    if (storeLoading && rows.isEmpty()) return
    var rebindAll = false
    if (themeDirty || selectionDirty) {
      setBackgroundColor(theme.bg)
      recycler.setBackgroundColor(theme.bg)
      topBar.setColors(theme.bg, theme.dark)
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
        topBar.contentChanged()
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

  /** Quanto o topo da lista (header RN) já rolou para cima; enorme se saiu da tela. */
  private fun headerOffsetPx(): Int {
    val first = layoutManager.findFirstVisibleItemPosition()
    if (first != 0) return Int.MAX_VALUE / 2
    val v = layoutManager.findViewByPosition(0) ?: return 0
    return recycler.paddingTop - v.top
  }

  private fun updateTopBar() {
    if (topInsetPx <= 0) return
    val rel = headerOffsetPx().toFloat()
    val c = collapseOffsetDp * density
    val start = c * 0.45f
    val span = max(8f * density, c - start)
    topBar.setProgress((rel - start) / span)
    topBar.contentChanged()
  }

  /** [wave8] Soltou no meio do título grande → termina aberto ou fechado. */
  private fun snapHeader() {
    if (snapPx <= 0) return
    val off = headerOffsetPx()
    if (off <= 0 || off >= snapPx) return
    val dy = if (off < snapPx / 2) -off else snapPx - off
    if (CLMotion.reduced(context)) recycler.scrollBy(0, dy) else recycler.smoothScrollBy(0, dy)
  }

  private fun onListScrolled() {
    updateTopBar()
    val offsetPx: Int = headerOffsetPx()
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
    if (peekMode == "peek" && showPeek(id, row)) return
    // Menu nativo equivalente ao do iOS (WhatsApp) — CLMenu.kt (o mesmo da
    // fileira de fixados). Confirmação das destrutivas = handlers JS.
    val shown = CLMenu.show(context, anchor, id, row, labels, folders) { body -> onRowAction(body) }
    if (!shown) onLongPress(mapOf("id" to id))
  }

  /** [2026-10-16 wave8-list] Prévia estilo Telegram (CLPeekDialog). */
  private fun showPeek(id: String, row: CLRow): Boolean {
    val act = appContext.currentActivity ?: return false
    if (act.isFinishing) return false
    peekDialog?.dismiss()
    val dlg = CLPeekDialog(act, row, theme, labels,
      onOpen = { onPeekOpen(mapOf("id" to id)) },
      onAction = { action -> onRowAction(mapOf("id" to id, "action" to action, "source" to "peek")) },
      onClosed = { if (peekDialog?.convId == id) peekDialog = null })
    peekDialog = dlg
    lastPeek?.let { if (CLVal.str(it["id"]) == id) dlg.update(it) }
    onPeekRequest(mapOf("id" to id))
    if (!dlg.show()) { peekDialog = null; return false }
    return true
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class HostHolder(v: View) : RecyclerView.ViewHolder(v)
  private class RowHolder(val rowView: CLRowView) : RecyclerView.ViewHolder(rowView)

  // [wave8 row-zoom] edição mínima (agente da transição): só lê a posição da
  // linha tocada; qualquer falha = evento sem "frame" (JS usa o push padrão).
  private fun rowZoomHint(id: String): Map<String, Any> {
    try {
      for (i in 0 until recycler.childCount) {
        val v = recycler.getChildAt(i) as? CLRowView ?: continue
        if (v.row.id != id || v.width <= 0 || v.height <= 0) continue
        val loc = IntArray(2)
        v.getLocationInWindow(loc)
        return mapOf("frame" to mapOf("x" to loc[0].toDouble(), "y" to loc[1].toDouble(),
          "w" to v.width.toDouble(), "h" to v.height.toDouble(), "unit" to "px"))
      }
    } catch (_: Throwable) {}
    return emptyMap()
  }

  private val rowListener = object : CLRowView.Listener {
    // [wave8 row-zoom] navigationHint: frame da linha (px, coords da janela) p/ a
    // transição "a conversa cresce a partir da linha" (modules/expo-chat-row-zoom).
    override fun onPress(id: String) { onRowPress(mapOf("id" to id) + rowZoomHint(id)) }
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

  private val swipeReveal = Paint(Paint.ANTI_ALIAS_FLAG)

  /**
   * [2026-10-16 wave8-list] Swipe nível Telegram:
   *  - até a largura do botão (74 dp) a linha anda 1:1; depois vem com
   *    RESISTÊNCIA (metade do dedo) — mola elástica;
   *  - ao cruzar o limiar (42% da largura) o ícone "estala" (cresce com
   *    passada e assenta), um círculo mais claro se abre atrás dele e vibra
   *    uma vez; voltar abaixo do limiar desarma (ícone encolhe);
   *  - soltar armado = ação completa (deslize total). "Lida" volta a linha
   *    para o lugar deslizando; "Arquivar" leva a linha até o fim.
   *  - um peteleco rápido NÃO dispara (só o limiar), evitando ação acidental.
   * Reduzir movimento ("Remover animações"): sem estalo/círculo, só a cor.
   */
  private inner class SwipeCallback : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.LEFT or ItemTouchHelper.RIGHT) {
    private val threshold = 0.42f
    private var armedId: String? = null
    private var armedAt = 0L
    private var disarmedId: String? = null
    private var disarmedAt = 0L
    // Última posição com o dedo na tela → a animação de soltar parte dela.
    private var relId: String? = null
    private var relRaw = 0f
    private var relVis = 0f

    override fun getSwipeDirs(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int {
      if (vh !is RowHolder || !swipeEnabled || selectionMode || photoActive) return 0
      return super.getSwipeDirs(rv, vh)
    }

    override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean = false

    override fun getSwipeThreshold(vh: RecyclerView.ViewHolder): Float = threshold

    // Só o limiar decide (peteleco não arquiva sem querer).
    override fun getSwipeEscapeVelocity(defaultValue: Float): Float = Float.MAX_VALUE

    override fun getAnimationDuration(rv: RecyclerView, animationType: Int, animateDx: Float, animateDy: Float): Long =
      if (animationType == ItemTouchHelper.ANIMATION_TYPE_SWIPE_SUCCESS || animationType == ItemTouchHelper.ANIMATION_TYPE_SWIPE_CANCEL) 300L
      else super.getAnimationDuration(rv, animationType, animateDx, animateDy)

    override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {
      val holder = vh as? RowHolder ?: return
      val id = holder.rowView.row.id
      val pos = holder.bindingAdapterPosition
      val action = if (direction == ItemTouchHelper.RIGHT) "toggleRead" else "archive"
      onRowAction(mapOf("id" to id, "action" to action, "source" to "swipe"))
      // Limpa o estado do ItemTouchHelper (a linha de "Lida" já voltou ao
      // lugar no desenho; a de arquivar some com o patch do JS — se não sumir,
      // ex. falhou, ela reaparece sozinha).
      val delay = if (action == "archive") 700L else 0L
      main.postDelayed({
        val p = items.indexOfFirst { it is Item.Row && it.id == id }
        if (p >= 0) adapter.notifyItemChanged(p, PAYLOAD_BIND)
        else if (pos != RecyclerView.NO_POSITION && pos < adapter.itemCount) adapter.notifyItemChanged(pos)
      }, delay)
    }

    override fun clearView(rv: RecyclerView, vh: RecyclerView.ViewHolder) {
      super.clearView(rv, vh)
      val id = (vh as? RowHolder)?.rowView?.row?.id
      if (id != null) {
        if (armedId == id) armedId = null
        if (disarmedId == id) disarmedId = null
        if (relId == id) relId = null
      }
    }

    private fun damp(raw: Float, button: Float): Float {
      val a = abs(raw)
      val v = if (a <= button) a else button + (a - button) * 0.5f
      return if (raw < 0) -v else v
    }

    /** Escala do "estalo": 1 → 1.32 → 1.15 ao armar; 1.15 → 1 ao desarmar. */
    private fun popScale(now: Long, armed: Boolean, since: Long, reduced: Boolean): Float {
      if (reduced) return if (armed) 1.15f else 1f
      val t = ((now - since) / 260f).coerceIn(0f, 1f)
      return if (armed) {
        if (t < 0.4f) { val u = t / 0.4f; 1f + 0.32f * (1f - (1f - u) * (1f - u)) }
        else { val u = (t - 0.4f) / 0.6f; 1.32f - 0.17f * (u * u * (3f - 2f * u)) }
      } else {
        1.15f - 0.15f * (1f - (1f - t) * (1f - t))
      }
    }

    override fun onChildDraw(c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder, dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      if (actionState != ItemTouchHelper.ACTION_STATE_SWIPE || vh !is RowHolder) {
        super.onChildDraw(c, rv, vh, dX, dY, actionState, isCurrentlyActive)
        return
      }
      val v = vh.itemView
      val row = vh.rowView.row
      val id = row.id
      val w = v.width.toFloat()
      val button = 74f * density
      val reduced = CLMotion.reduced(context)
      val now = SystemClock.uptimeMillis()
      var vis: Float
      if (isCurrentlyActive || relId != id) {
        vis = damp(dX, button)
        if (isCurrentlyActive) { relId = id; relRaw = dX; relVis = vis }
        // Armar / desarmar no limiar (vibra uma vez ao armar).
        val armedNow = isCurrentlyActive && abs(dX) >= threshold * w
        if (isCurrentlyActive) {
          if (armedNow && armedId != id) {
            armedId = id; armedAt = now
            if (disarmedId == id) disarmedId = null
            v.performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
          } else if (!armedNow && armedId == id) {
            armedId = null
            disarmedId = id; disarmedAt = now
            v.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
          }
        }
      } else {
        // Soltou: o ItemTouchHelper anima dX de relRaw até 0 (cancelou) ou
        // ±largura (completou). Mapeia isso a partir da posição VISUAL do dedo.
        val toEnd = abs(dX) > abs(relRaw) + 0.5f
        val target = if (toEnd) (if (dX > 0) w else -w) else 0f
        val p = if (abs(target - relRaw) < 1f) 1f else ((dX - relRaw) / (target - relRaw)).coerceIn(0f, 1f)
        val visTarget = if (toEnd && dX > 0) 0f else target // "Lida": volta para o lugar
        vis = relVis + (visTarget - relVis) * p
      }
      if (vis != 0f) {
        val right = vis > 0
        val armed = armedId == id
        val base = if (right) CLTheme.SWIPE_READ else CLTheme.SWIPE_ARCHIVE
        swipePaint.color = base
        if (right) swipeRect.set(v.left.toFloat(), v.top.toFloat(), v.left + vis, v.bottom.toFloat())
        else swipeRect.set(v.right + vis, v.top.toFloat(), v.right.toFloat(), v.bottom.toFloat())
        c.drawRect(swipeRect, swipePaint)
        val aw = abs(vis)
        // Ícone acompanha a borda da linha depois de abrir o botão inteiro.
        val cx = if (right) v.left + (if (aw <= button) aw / 2f else aw - button / 2f)
          else v.right - (if (aw <= button) aw / 2f else aw - button / 2f)
        val cy = v.top + v.height / 2f
        // Círculo mais claro que se abre atrás do ícone ao armar.
        val revealT = when {
          reduced -> if (armed) 1f else 0f
          armed -> ((now - armedAt) / 300f).coerceIn(0f, 1f)
          disarmedId == id -> 1f - ((now - disarmedAt) / 200f).coerceIn(0f, 1f)
          else -> 0f
        }
        if (revealT > 0f) {
          val maxR = kotlin.math.hypot(aw.toDouble(), v.height.toDouble()).toFloat()
          val eased = 1f - (1f - revealT) * (1f - revealT) * (1f - revealT)
          swipeReveal.color = 0x1FFFFFFF
          c.save()
          c.clipRect(swipeRect)
          c.drawCircle(cx, cy, maxR * eased, swipeReveal)
          c.restore()
        }
        val unread = row.unread > 0
        val label = if (right) {
          if (unread) labels.get("markRead", "Lida") else labels.get("markUnread", "Não lida")
        } else {
          if (row.archived) labels.get("unarchive", "Desarquivar") else labels.get("archive", "Arquivar")
        }
        val iconRes = if (right) (if (unread) R.drawable.ccl_ic_check else R.drawable.ccl_ic_message) else R.drawable.ccl_ic_archive
        val grow = min(1f, aw / button)
        val alpha = (grow * 255).toInt()
        val scale = (0.7f + 0.3f * grow) * when {
          armed -> popScale(now, true, armedAt, reduced)
          disarmedId == id -> popScale(now, false, disarmedAt, reduced)
          else -> 1f
        }
        tintedIcon(context, iconRes, 0xFFFFFFFF.toInt())?.let { d ->
          val s = 20 * density * scale
          d.alpha = alpha
          d.setBounds((cx - s / 2f).toInt(), (cy - s - 2 * density).toInt(), (cx + s / 2f).toInt(), (cy - 2 * density).toInt())
          d.draw(c)
        }
        swipeText.alpha = alpha
        var txt = label
        val maxW = button - 6 * density
        while (txt.length > 3 && swipeText.measureText(txt) > maxW) txt = txt.dropLast(1)
        if (txt != label) txt = txt.dropLast(1) + "…"
        c.drawText(txt, cx, cy + 14 * density, swipeText)
        val animating = !reduced && ((armed && now - armedAt < 320) || (disarmedId == id && now - disarmedAt < 260))
        if (animating) rv.postInvalidateOnAnimation()
      }
      super.onChildDraw(c, rv, vh, vis, dY, actionState, isCurrentlyActive)
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
      // [wave8] conversa que recebeu mensagem sobe um pouco mais devagar (as
      // outras deslizam junto, sem "pulo").
      moveDuration = 300
      addDuration = 200
      removeDuration = 180
    }
    // [wave8] lista + vidro do topo empilhados (o ExpoView é um LinearLayout).
    val stack = android.widget.FrameLayout(context)
    stack.addView(recycler, android.widget.FrameLayout.LayoutParams(android.widget.FrameLayout.LayoutParams.MATCH_PARENT, android.widget.FrameLayout.LayoutParams.MATCH_PARENT))
    topBar.visibility = GONE
    stack.addView(topBar, android.widget.FrameLayout.LayoutParams(android.widget.FrameLayout.LayoutParams.MATCH_PARENT, 1, Gravity.TOP))
    addView(stack, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    touchHelper.attachToRecyclerView(recycler)
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) { onListScrolled() }
      override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_IDLE) snapHeader()
      }
    })
    // Animações de itens (sobe/desce) também mudam o que fica sob o vidro.
    recycler.addItemDecoration(object : RecyclerView.ItemDecoration() {
      override fun onDrawOver(c: Canvas, parent: RecyclerView, state: RecyclerView.State) {
        if (topInsetPx > 0 && parent.itemAnimator?.isRunning == true) topBar.contentChanged()
      }
    })
    setBackgroundColor(theme.bg)
  }

  override fun onDetachedFromWindow() {
    peekDialog?.dismiss()
    peekDialog = null
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
