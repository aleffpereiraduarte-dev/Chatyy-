package expo.modules.chatyyconversationlist

// [2026-10-14 native-home] Lista de conversas NATIVA (Android): RecyclerView +
// DiffUtil (payload → atualiza a célula no lugar, sem o crossfade que "pisca"),
// swipe com pílulas iguais ao iOS (SwipeController), PopupMenu no toque longo,
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
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.chatyychatstore.ChatyyStoreDB
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs
import kotlin.math.ceil
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
  // [2026-10-18 tg-list] puxar a lista p/ baixo no topo além do limiar
  // (Telegram: "puxe para ver as Arquivadas"). Um evento por gesto.
  val onPullReveal by EventDispatcher()

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
  private var compactDensity = false // [2026-10-18 compact-list] prop `density`
  private var tgDensity = false      // [2026-10-19 tg-list] density "telegram"
  private var accentColor: Int? = null // [2026-10-19 tg-list] prop `accent` ("#RRGGBB")
  // [2026-10-21 lista-viva, apiVersion 12] prop `vivo`: fixadas num cartão
  // (decoração com cabeçalho "FIXADAS"), sem separadores, entrada leve.
  // false = exatamente como antes.
  private var vivo = false
  private var pinnedIds: Set<String> = emptySet()
  private var pinFirstId: String? = null
  private var pinLastId: String? = null
  private var entranceArmed = false
  private var entranceUntil = 0L
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
  /** [2026-10-17 peek-fixed] fração da tela p/ o cartão da prévia (0 = padrão). */
  var peekHeight: Double = 0.0

  // Filhos RN
  private val rnChildren = ArrayList<View>()
  private val headerHost = CLChildHost(context) { headerHintPx }
  private val footerHost = CLChildHost(context) { footerHintPx }

  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()
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
      d["typing"] = ""; d["typingKind"] = ""; d["selected"] = false; d["online"] = false; d["activity"] = ""
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
    theme = CLTheme(dark, palette)
    themeDirty = true
  }

  // [2026-10-20 grafite, apiVersion 11] prop `palette` (ver CLTheme).
  private var palette: Map<String, Any?>? = null
  fun setPaletteProp(p: Map<String, Any?>?) {
    val next = if (p.isNullOrEmpty()) null else p
    if (next == palette) return
    palette = next
    theme = CLTheme(theme.dark, palette)
    themeDirty = true
  }

  fun setSelectionModeProp(on: Boolean) {
    if (on == selectionMode) return
    selectionMode = on
    selectionDirty = true
  }

  // [2026-10-18 compact-list] "compact" = linha 72 / avatar 52 (WhatsApp);
  // qualquer outro valor = regular 76 / 54. Rebind de tudo (mesmo caminho dos rótulos).
  fun setDensityProp(v: String?) {
    // [2026-10-19 tg-list] "telegram" = linha 78 / avatar 58 / prévia 2 linhas.
    val t = v == "telegram"
    val c = v == "compact"
    if (c == compactDensity && t == tgDensity) return
    compactDensity = c
    tgDensity = t
    labelsDirty = true
  }

  // [2026-10-19 tg-list] cor de destaque ("#RRGGBB"; vazio = cor do texto) —
  // "digitando…" no modo Telegram.
  fun setAccentProp(v: String?) {
    val hex = (v ?: "").trim()
    val c: Int? = if (Regex("^#[0-9A-Fa-f]{6}$").matches(hex)) {
      try { android.graphics.Color.parseColor(hex) } catch (_: Throwable) { null }
    } else null
    if (c == accentColor) return
    accentColor = c
    labelsDirty = true
  }

  // [2026-10-21 lista-viva, apiVersion 12]
  fun setVivoProp(on: Boolean) {
    if (on == vivo) return
    vivo = on
    if (!on) entranceUntil = 0L
    labelsDirty = true   // rebind de tudo
    needsApply = true    // re-separa fixadas / resto
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
    // [2026-10-16 topbar-hairline] NÃO calcular aqui: o padding acabou de mudar
    // e o RecyclerView ainda não refez o layout (v.top velho → rel = topInset →
    // progresso 1 → hairline + vidro "presos" sob o header com o título grande
    // na tela; sem scroll nada recalculava). Recalcula depois do layout (e o
    // onDrawOver abaixo mantém em dia a cada quadro).
    recycler.post { onListScrolled() }
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
    if (selectionDirty || photoActive) swipe.close(false)
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
      val firstRows = !entranceArmed && ids.isNotEmpty()
      if (firstRows) entranceArmed = true
      // [lista-viva] fixadas primeiro (no cartão), depois o resto.
      var shown: List<String> = ids
      val oldPins = pinnedIds
      val oldFirst = pinFirstId
      val oldLast = pinLastId
      if (vivo) {
        val pins = ids.filter { rows[it]?.pinned == true }
        if (pins.isNotEmpty()) shown = pins + ids.filter { rows[it]?.pinned != true }
        pinnedIds = pins.toHashSet()
        pinFirstId = pins.firstOrNull()
        pinLastId = pins.lastOrNull()
        if (firstRows && !CLMotion.reduced(context)) entranceUntil = SystemClock.uptimeMillis() + 900L
      } else {
        pinnedIds = emptySet()
        pinFirstId = null
        pinLastId = null
      }
      val decoChanged = oldFirst != pinFirstId || oldLast != pinLastId || oldPins != pinnedIds || rebindAll
      val next = ArrayList<Item>(shown.size + 2)
      next.add(Item.Header)
      for (id in shown) next.add(Item.Row(id))
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
      if (decoChanged && (vivo || oldPins.isNotEmpty() || oldFirst != null)) recycler.invalidateItemDecorations()
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
    if (first == RecyclerView.NO_POSITION) return 0 // ainda sem layout: trata como topo
    if (first != 0) return Int.MAX_VALUE / 2
    val v = layoutManager.findViewByPosition(0) ?: return 0
    return recycler.paddingTop - v.top
  }

  private fun updateTopBarProgress() {
    val rel = headerOffsetPx().toFloat()
    val c = collapseOffsetDp * density
    val start = c * 0.45f
    val span = max(8f * density, c - start)
    topBar.setProgress((rel - start) / span)
  }

  private fun updateTopBar() {
    if (topInsetPx <= 0) return
    updateTopBarProgress()
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
      onClosed = { if (peekDialog?.convId == id) peekDialog = null },
      heightFraction = peekHeight)
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

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
      if (holder is RowHolder) {
        holder.rowView.resetEntrance()
        swipe.onRecycled(holder.rowView)
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
      bind(holder, position, payloads.isNotEmpty())
    }

    private fun bind(holder: RecyclerView.ViewHolder, position: Int, animate: Boolean) {
      if (holder !is RowHolder) return
      val item = items.getOrNull(position) as? Item.Row ?: return
      val row = rows[item.id] ?: return
      try {
        val inCard = vivo && pinnedIds.contains(item.id)
        holder.rowView.bind(row, theme, labels, selectionMode, animate && holder.rowView.isAttachedToWindow, compactDensity, tgDensity, if (tgDensity) accentColor else null,
          vivo, if (inCard) theme.pinnedCard else null)
        swipe.onBound(holder.rowView)
        // [lista-viva] entrada leve na 1ª pintura (defasada 40 ms por linha).
        if (!animate && vivo && entranceUntil > 0L) {
          if (SystemClock.uptimeMillis() < entranceUntil) {
            holder.rowView.playEntrance(min(500L, max(0, position - 1) * 40L))
          } else entranceUntil = 0L
        }
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  // ─── Swipe ───────────────────────────────────────────────────────────────

  /** Uma ação do swipe (mesmas do iOS, mesma ordem: da borda para dentro). */
  private class SwipeAct(val action: String, val label: String, val icon: Int, val color: Int)

  /**
   * [2026-10-16 wave13 swipe-ios] Swipe IGUAL ao iOS (UISwipeActionsConfiguration
   * de ios/ChatyyConversationListView.swift → swipeConfiguration):
   *  - "leading" (arrastar para a direita no LTR): Marcar como (não) lida,
   *    Silenciar, Fixar, E-mail (se o JS mandar o rótulo `email`);
   *    "trailing" (para a esquerda): Arquivar (borda) + Apagar (vermelho);
   *  - cada ação = PÍLULA arredondada com ícone + rótulo embaixo (cinza), a
   *    linha arrastada fica cinza com cantos arredondados (isSwiped do iOS);
   *  - revelação proporcional ao arrasto (pílulas crescem/abrem com o dedo);
   *    soltar no meio → abre (mola) ou fecha; toque numa pílula executa;
   *    toque fora / rolar a lista fecha;
   *  - arrastar além do limiar = swipe completo da 1ª ação (lida à esquerda,
   *    arquivar à direita): a pílula primária toma o espaço todo, vibra uma
   *    vez ao armar (tique ao desarmar); soltar armado executa;
   *  - rótulos nunca truncam: encolhem a fonte (13→10.5sp) e depois quebram
   *    em 2 linhas; RTL espelha (leading vira o lado direito);
   *  - Reduzir movimento ("Remover animações"): sem mola/expansão animada.
   */
  private inner class SwipeController : RecyclerView.ItemDecoration(), RecyclerView.OnItemTouchListener {
    private val slop = android.view.ViewConfiguration.get(context).scaledTouchSlop
    private val minFling = 650f * density
    private var vt: android.view.VelocityTracker? = null

    // Gesto
    private var downX = 0f
    private var downY = 0f
    private var tracking = false
    private var dragging = false
    private var vertical = false
    private var swallow = false
    private var pendingTap = -1
    private var startTx = 0f
    private var trackId: String? = null

    // Linha ativa (arrastando / aberta / animando) — só uma por vez.
    private var activeId: String? = null
    private var tx = 0f
    private var anim: android.animation.ValueAnimator? = null
    private var committing = false

    // Swipe completo
    private var armed = false
    private var armT = 0f
    private var armAnim: android.animation.ValueAnimator? = null

    // Layout das pílulas do lado aberto (recalculado quando o lado muda)
    private var side = 0               // +1 = linha andou p/ direita, -1 = esquerda
    private var acts: List<SwipeAct> = emptyList()
    private var slots = FloatArray(0)  // largura de cada coluna (pílula/rótulo)
    private var labelsLay: Array<android.text.StaticLayout?> = arrayOf()
    private var revealW = 0f
    private var layoutW = 0
    private var layoutRowId: String? = null
    private val hit = ArrayList<RectF>()
    private val labelPaint = android.text.TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val pillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val hairPaint = Paint()
    private val rect = RectF()

    private val margin get() = 8f * density
    private val gap get() = 8f * density
    private val pillMin get() = 60f * density

    fun enabled(): Boolean = swipeEnabled && !selectionMode && !photoActive

    private fun rtl(): Boolean = recycler.layoutDirection == View.LAYOUT_DIRECTION_RTL

    private fun reduced(): Boolean = CLMotion.reduced(context)

    private fun viewFor(id: String?): CLRowView? {
      if (id == null) return null
      for (i in 0 until recycler.childCount) {
        val h = recycler.getChildViewHolder(recycler.getChildAt(i)) as? RowHolder ?: continue
        if (h.rowView.row.id == id) return h.rowView
      }
      return null
    }

    // ── Ações (espelho do Swift) ──

    private fun actsFor(row: CLRow, leading: Boolean): List<SwipeAct> {
      val L = labels
      val out = ArrayList<SwipeAct>(4)
      if (leading) {
        val unread = row.unread > 0
        out.add(SwipeAct("toggleRead",
          if (unread) L.get("markRead", "Marcar como lida") else L.get("markUnread", "Marcar como não lida"),
          if (unread) R.drawable.ccl_ic_check else R.drawable.ccl_ic_message, 0xFF1C1C1E.toInt()))
        out.add(SwipeAct("mute",
          if (row.muted) L.get("unmute", "Reativar") else L.get("mute", "Silenciar"),
          if (row.muted) R.drawable.ccl_ic_bell else R.drawable.ccl_ic_bell_off, 0xFF3A3A3C.toInt()))
        out.add(SwipeAct("pin",
          if (row.pinned) L.get("unpin", "Desafixar") else L.get("pin", "Fixar"),
          R.drawable.ccl_ic_pin, 0xFF636366.toInt()))
        if (L.has("email")) out.add(SwipeAct("email", L.get("email", "E-mail"), R.drawable.ccl_ic_mail, 0xFF8E8E93.toInt()))
      } else {
        out.add(SwipeAct("archive",
          if (row.archived) L.get("unarchive", "Desarquivar") else L.get("archive", "Arquivar"),
          R.drawable.ccl_ic_archive, CLTheme.SWIPE_ARCHIVE))
        out.add(SwipeAct("delete", L.get("delete", "Apagar"), R.drawable.ccl_ic_trash, CLTheme.SWIPE_DELETE))
      }
      return out
    }

    /** Mede colunas: fonte 13sp → 10.5sp e, se ainda não couber, 2 linhas. */
    private fun layoutSide(v: CLRowView, s: Int) {
      val w = v.width
      if (s == side && w == layoutW && layoutRowId == v.row.id && acts.isNotEmpty()) return
      side = s
      layoutW = w
      layoutRowId = v.row.id
      val leading = (s > 0) != rtl()
      acts = actsFor(v.row, leading)
      val n = acts.size
      val fs = min(max(context.resources.configuration.fontScale, 0.85f), 1.25f)
      // Deixa à mostra pelo menos o avatar da linha (como o iOS).
      val avail = max(pillMin * n + margin + gap * n, w - 76f * density)
      labelPaint.typeface = CLType.weight(500)
      var size = 11.5f * density * fs // [2026-10-17 wa-cells] rótulo 11,5 medium (WhatsApp)
      val minSize = 10.5f * density * fs
      val tw = FloatArray(n)
      fun measure() {
        labelPaint.textSize = size
        for (i in 0 until n) tw[i] = labelPaint.measureText(acts[i].label)
      }
      fun total(sl: FloatArray): Float = margin + sl.sum() + gap * n
      measure()
      var sl = FloatArray(n) { max(pillMin, tw[it]) }
      while (total(sl) > avail && size > minSize) {
        size -= 0.5f * density
        measure()
        sl = FloatArray(n) { max(pillMin, tw[it]) }
      }
      if (total(sl) > avail) {
        // 2 linhas: coluna ~ metade do texto, nunca menor que a maior palavra.
        sl = FloatArray(n) { i ->
          val words = acts[i].label.split(' ')
          val widest = words.maxOfOrNull { labelPaint.measureText(it) } ?: 0f
          max(pillMin, max(widest, tw[i] * 0.55f))
        }
        val t = total(sl)
        if (t > avail) {
          val k = (avail - margin - gap * n) / sl.sum()
          for (i in 0 until n) sl[i] = max(44f * density, sl[i] * k)
        }
      }
      slots = sl
      labelsLay = Array(n) { i ->
        val lw = max(1, ceil(sl[i] + 2f * density).toInt())
        val txt = acts[i].label
        android.text.StaticLayout.Builder.obtain(txt, 0, txt.length, labelPaint, lw)
          .setAlignment(android.text.Layout.Alignment.ALIGN_NORMAL)
          .setMaxLines(2)
          .setEllipsize(android.text.TextUtils.TruncateAt.END)
          .setIncludePad(false)
          .setLineSpacing(0f, 1f)
          .build()
      }
      revealW = margin + sl.sum() + gap * n
    }

    private fun fullThreshold(w: Float): Float =
      min(w - 28f * density, max(w * 0.55f, revealW + 36f * density))

    // ── Estado ──

    private fun setTx(v: CLRowView, value: Float, live: Boolean) {
      tx = value
      val s = if (value > 0f) 1 else if (value < 0f) -1 else side
      if (value != 0f) layoutSide(v, s)
      v.translationX = value
      v.setSwiped(value != 0f)
      if (live) {
        val w = v.width.toFloat()
        val now = abs(value) >= fullThreshold(w)
        if (now != armed) setArmed(v, now)
      }
      recycler.invalidate()
    }

    private fun setArmed(v: View, on: Boolean) {
      armed = on
      v.performHapticFeedback(if (on) android.view.HapticFeedbackConstants.CONTEXT_CLICK else android.view.HapticFeedbackConstants.CLOCK_TICK)
      armAnim?.cancel()
      if (reduced()) { armT = if (on) 1f else 0f; recycler.invalidate(); return }
      val a = android.animation.ValueAnimator.ofFloat(armT, if (on) 1f else 0f)
      a.duration = if (on) 220L else 160L
      a.interpolator = android.view.animation.DecelerateInterpolator(1.6f)
      a.addUpdateListener { armT = it.animatedValue as Float; recycler.invalidate() }
      armAnim = a
      a.start()
    }

    private fun resetVisual(v: CLRowView?) {
      if (v == null) return
      v.translationX = 0f
      v.setSwiped(false)
    }

    private fun clearActive() {
      anim?.cancel(); anim = null
      armAnim?.cancel(); armAnim = null
      activeId = null
      tx = 0f
      armed = false
      armT = 0f
      committing = false
      layoutRowId = null
      hit.clear()
      recycler.invalidate()
    }

    /** Anima a linha ativa até `to`; `end` roda no fim (ou se a linha sumir). */
    private fun animateTo(to: Float, kind: Int, end: (() -> Unit)? = null) {
      val id = activeId ?: return
      anim?.cancel()
      val v0 = viewFor(id)
      if (v0 == null || reduced()) {
        if (v0 != null) setTx(v0, to, false)
        if (to == 0f && !committing) { resetVisual(v0); clearActive() }
        end?.invoke()
        return
      }
      val a = android.animation.ValueAnimator.ofFloat(tx, to)
      when (kind) {
        0 -> { a.duration = 340L; a.interpolator = android.view.animation.OvershootInterpolator(0.9f) } // abrir (mola)
        1 -> { a.duration = 280L; a.interpolator = android.view.animation.DecelerateInterpolator(2f) }  // fechar
        else -> { a.duration = 200L; a.interpolator = android.view.animation.AccelerateInterpolator(1.4f) } // sair da tela
      }
      var cancelled = false
      a.addUpdateListener {
        val v = viewFor(id)
        if (v == null || activeId != id) {
          it.cancel()
          if (v == null && activeId == id && !committing) clearActive() // linha saiu da tela
          return@addUpdateListener
        }
        setTx(v, it.animatedValue as Float, false)
      }
      a.addListener(object : android.animation.AnimatorListenerAdapter() {
        override fun onAnimationCancel(animation: android.animation.Animator) { cancelled = true }
        override fun onAnimationEnd(animation: android.animation.Animator) {
          if (anim === a) anim = null
          if (!cancelled && to == 0f && activeId == id && !committing) { resetVisual(viewFor(id)); clearActive() }
          if (!cancelled || viewFor(id) == null) end?.invoke()
        }
      })
      anim = a
      a.start()
    }

    fun close(animated: Boolean = true) {
      val id = activeId ?: return
      if (committing) return
      if (armed) { armed = false; armAnim?.cancel(); armT = 0f }
      if (!animated) { anim?.cancel(); resetVisual(viewFor(id)); clearActive(); return }
      animateTo(0f, 1)
    }

    private fun emit(id: String, action: String) {
      onRowAction(mapOf("id" to id, "action" to action, "source" to "swipe"))
    }

    private fun fire(index: Int) {
      val id = activeId ?: return
      val act = acts.getOrNull(index) ?: return
      viewFor(id)?.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY)
      emit(id, act.action)
      close()
    }

    /** Swipe completo: lida volta para o lugar; arquivar leva a linha embora. */
    private fun commitPrimary(v: CLRowView) {
      val id = activeId ?: return
      val act = acts.firstOrNull() ?: return
      if (act.action == "archive") {
        committing = true
        val w = v.width.toFloat()
        animateTo(if (tx < 0) -w else w, 2) {
          emit(id, act.action)
          // Some com o patch do JS; se não sumir (falhou / filtro), volta.
          main.postDelayed({
            if (activeId != id) return@postDelayed
            committing = false
            armed = false; armT = 0f
            if (viewFor(id) == null) { clearActive() } else animateTo(0f, 1)
          }, 700L)
        }
      } else {
        emit(id, act.action)
        armed = false
        armAnim?.cancel()
        val from = armT
        if (!reduced() && from > 0f) {
          val a = android.animation.ValueAnimator.ofFloat(from, 0f)
          a.duration = 260L
          a.addUpdateListener { armT = it.animatedValue as Float; recycler.invalidate() }
          armAnim = a
          a.start()
        } else armT = 0f
        animateTo(0f, 1)
      }
    }

    /** Chamado no bind: linha reciclada para outra conversa não herda o arrasto. */
    fun onBound(v: CLRowView) {
      if (v.row.id == activeId) {
        v.translationX = tx
        v.setSwiped(tx != 0f)
      } else if (v.translationX != 0f) {
        resetVisual(v)
      }
    }

    fun onRecycled(v: CLRowView) {
      if (v.row.id == activeId && !committing) { anim?.cancel(); clearActive() }
      resetVisual(v)
    }

    // ── Toque ──

    private fun hitIndex(x: Float, y: Float): Int {
      for (i in hit.indices) if (hit[i].contains(x, y)) return i
      return -1
    }

    override fun onInterceptTouchEvent(rv: RecyclerView, e: android.view.MotionEvent): Boolean {
      when (e.actionMasked) {
        android.view.MotionEvent.ACTION_DOWN -> {
          tracking = false; dragging = false; vertical = false; swallow = false; pendingTap = -1; trackId = null
          downX = e.x; downY = e.y
          vt?.recycle(); vt = android.view.VelocityTracker.obtain(); vt?.addMovement(e)
          if (committing) { swallow = true; return false }
          val child = rv.findChildViewUnder(e.x, e.y)
          val holder = child?.let { rv.getChildViewHolder(it) } as? RowHolder
          if (activeId != null) {
            val hi = hitIndex(e.x, e.y)
            if (hi >= 0 && !armed) { pendingTap = hi; return true }
            if (holder != null && holder.rowView.row.id == activeId && enabled()) {
              // Arrastar a linha aberta de novo (ou tocar nela = fechar).
              anim?.cancel(); anim = null
              tracking = true; trackId = activeId; startTx = tx
              swallow = true
              return false
            }
            close()
            swallow = true
            return false
          }
          if (holder != null && enabled() && rv.scrollState == RecyclerView.SCROLL_STATE_IDLE) {
            tracking = true; trackId = holder.rowView.row.id; startTx = 0f
          }
          return false
        }
        android.view.MotionEvent.ACTION_MOVE -> {
          vt?.addMovement(e)
          if (pendingTap >= 0) return true
          if (!tracking || dragging || vertical) return false
          val dx = e.x - downX
          val dy = e.y - downY
          if (abs(dy) > slop && abs(dy) > abs(dx)) { vertical = true; tracking = false; return false }
          if (abs(dx) > slop && abs(dx) > abs(dy) * 1.2f) {
            val v = viewFor(trackId) ?: return false
            if (activeId != null && activeId != trackId) close(false)
            activeId = trackId
            dragging = true
            downX = e.x // segue do ponto atual (sem pulo do slop)
            rv.parent?.requestDisallowInterceptTouchEvent(true)
            setTx(v, startTx, true)
            return true
          }
          return false
        }
        android.view.MotionEvent.ACTION_UP -> {
          // Toque (sem rolar) que só fechou a linha aberta: não abre conversa.
          val moved = abs(e.x - downX) > slop || abs(e.y - downY) > slop
          if (swallow && !dragging && !moved && rv.scrollState == RecyclerView.SCROLL_STATE_IDLE) {
            if (activeId != null && trackId == activeId) close()
            tracking = false
            return true
          }
          tracking = false
          return false
        }
        android.view.MotionEvent.ACTION_CANCEL -> { tracking = false; return false }
      }
      return false
    }

    override fun onTouchEvent(rv: RecyclerView, e: android.view.MotionEvent) {
      vt?.addMovement(e)
      when (e.actionMasked) {
        android.view.MotionEvent.ACTION_MOVE -> {
          if (!dragging) return
          val v = viewFor(activeId) ?: return
          val w = v.width.toFloat()
          var raw = startTx + (e.x - downX)
          // Só abre lados que têm ações; além da largura vem com resistência.
          val lim = w
          if (abs(raw) > lim) raw = if (raw > 0) lim + (raw - lim) * 0.2f else -lim + (raw + lim) * 0.2f
          setTx(v, raw, true)
        }
        android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
          if (pendingTap >= 0) {
            val idx = pendingTap
            pendingTap = -1
            if (e.actionMasked == android.view.MotionEvent.ACTION_UP && hitIndex(e.x, e.y) == idx) fire(idx)
            return
          }
          if (!dragging) return
          dragging = false
          val v = viewFor(activeId)
          if (v == null) { clearActive(); return }
          vt?.computeCurrentVelocity(1000)
          val vx = vt?.xVelocity ?: 0f
          if (armed && e.actionMasked == android.view.MotionEvent.ACTION_UP) { commitPrimary(v); return }
          if (armed) setArmed(v, false)
          val s = if (tx > 0) 1f else -1f
          val open = tx != 0f && (
            (vx * s > minFling) ||
            (abs(tx) > revealW * 0.42f && vx * s > -minFling))
          if (open) {
            v.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
            animateTo(s * revealW, 0)
          } else animateTo(0f, 1)
        }
      }
    }

    override fun onRequestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {
      if (disallowIntercept && !dragging) { tracking = false }
    }

    // ── Desenho (por baixo da linha) ──

    // Separadores POR CIMA (o fundo da linha é opaco), como o UICollectionView.
    override fun onDrawOver(c: Canvas, parent: RecyclerView, state: RecyclerView.State) {
      drawSeparators(c, parent)
    }

    override fun onDraw(c: Canvas, parent: RecyclerView, state: RecyclerView.State) {
      hit.clear()
      val id = activeId ?: return
      val v = viewFor(id) ?: return
      if (tx == 0f || acts.isEmpty()) return
      val n = acts.size
      val w = v.width.toFloat()
      val atx = abs(tx)
      val p = atx / max(1f, revealW)
      val right = tx > 0                       // pílulas na esquerda (linha foi p/ direita)
      val top = v.top.toFloat() + v.translationY
      val h = v.height.toFloat()
      // Altura do bloco pílula + rótulo
      var labH = 0f
      for (l in labelsLay) if (l != null) labH = max(labH, l.height.toFloat())
      val lgap = 5f * density
      val pillH = min(46f * density, max(30f * density, h - labH - lgap - 12f * density))
      val groupH = pillH + lgap + labH
      val gy = top + (h - groupH) / 2f
      val extra = max(0f, atx - revealW)
      val grow = (p).coerceIn(0f, 1f)
      val reduced = reduced()
      c.save()
      if (right) c.clipRect(v.left.toFloat(), top, v.left + atx, top + h)
      else c.clipRect(v.right - atx, top, v.right.toFloat(), top + h)
      var off = margin * grow
      for (i in 0 until n) {
        val slotW = slots[i] + extra / n
        val start = off
        off += (slotW + gap) * grow
        var cx = start + slotW * grow / 2f
        val pw = slotW // pílula = largura da coluna
        var alpha = ((p - 0.12f) / 0.55f).coerceIn(0f, 1f)
        val sc = if (reduced) 1f else (0.55f + 0.45f * grow)
        var drawW = pw * sc
        var drawH = pillH * sc
        if (i == 0 && armT > 0f) {
          // Swipe completo: a 1ª pílula toma o espaço revelado inteiro.
          val fullW = atx - margin - gap
          val fcx = margin + fullW / 2f
          cx += (fcx - cx) * armT
          drawW += (fullW - drawW) * armT
          drawH += (pillH - drawH) * armT
          alpha = alpha + (1f - alpha) * armT
        } else if (armT > 0f) {
          alpha *= (1f - armT)
        }
        if (alpha <= 0.01f) continue
        val absCx = if (right) v.left + cx else v.right - cx
        val pcy = gy + pillH / 2f
        rect.set(absCx - drawW / 2f, pcy - drawH / 2f, absCx + drawW / 2f, pcy + drawH / 2f)
        val act = acts[i]
        pillPaint.color = act.color
        pillPaint.alpha = (alpha * 255).toInt()
        val rad = drawH / 2f
        c.drawRoundRect(rect, rad, rad, pillPaint)
        tintedIcon(context, act.icon, 0xFFFFFFFF.toInt())?.let { d ->
          val s = 21f * density * sc
          d.alpha = (alpha * 255).toInt()
          d.setBounds((absCx - s / 2f).toInt(), (pcy - s / 2f).toInt(), (absCx + s / 2f).toInt(), (pcy + s / 2f).toInt())
          d.draw(c)
        }
        val lay = labelsLay.getOrNull(i)
        if (lay != null) {
          labelPaint.color = theme.sub
          labelPaint.alpha = (alpha * 255).toInt()
          // Centraliza cada linha (StaticLayout ALIGN_NORMAL + deslocamento por linha).
          for (ln in 0 until lay.lineCount) {
            val lw = lay.getLineWidth(ln)
            val ls = lay.getLineStart(ln)
            val le = lay.getLineEnd(ln)
            val baseY = gy + pillH + lgap + lay.getLineBaseline(ln)
            val txt = lay.text.subSequence(ls, le).toString().trimEnd()
            val ell = lay.getEllipsisCount(ln)
            val shown = if (ell > 0) txt.substring(0, max(0, txt.length - ell)).trimEnd() + "…" else txt
            c.drawText(shown, absCx - min(lw, labelPaint.measureText(shown)) / 2f, baseY, labelPaint)
          }
        }
        // Área de toque: coluna inteira (pílula + rótulo).
        if (p >= 0.98f && armT == 0f) {
          val hw = slotW / 2f
          hit.add(RectF(absCx - hw, gy - 6f * density, absCx + hw, gy + groupH + 6f * density))
        } else hit.add(RectF())
      }
      c.restore()
      if (anim?.isRunning == true || armAnim?.isRunning == true) parent.postInvalidateOnAnimation()
    }

    /** Linha fina a partir do nome (16 + 54 + 14 dp), como o iOS (sep inset). */
    private fun drawSeparators(c: Canvas, parent: RecyclerView) {
      if (vivo) return // [lista-viva] sem linhas entre as conversas
      hairPaint.color = theme.hair
      val hh = max(1f, density * 0.5f)
      // [2026-10-19 tg-list] Telegram: 12 + 58 + 10 = 80 (x do texto).
      val lead = ((if (selectionMode) 36f else 0f) + (if (tgDensity) 12f + 58f + 10f else 16f + (if (compactDensity) 52f + 12f else 54f + 14f))) * density
      val rtl = rtl()
      for (i in 0 until parent.childCount) {
        val ch = parent.getChildAt(i)
        val h = parent.getChildViewHolder(ch) as? RowHolder ?: continue
        if (ch.translationX != 0f || h.rowView.row.id == activeId) continue
        val b = ch.bottom + ch.translationY
        if (rtl) c.drawRect(ch.left.toFloat(), b - hh, ch.right - lead, b, hairPaint)
        else c.drawRect(ch.left + lead, b - hh, ch.right.toFloat(), b, hairPaint)
      }
    }
  }

  private val swipe = SwipeController()

  /**
   * [2026-10-21 lista-viva] Cartão das fixadas (raio 22, margem 0 12 10, respiro
   * 4 em cima/embaixo, sombra dupla suave só no claro) + cabeçalho "FIXADAS"
   * com alfinete (12 sp, 700, caixa alta). Desenhado por baixo das linhas;
   * as linhas fixadas ficam com fundo transparente (CLRowView no cartão).
   */
  private inner class PinnedCardDecoration : RecyclerView.ItemDecoration() {
    private val cardPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val textPaint = android.text.TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      typeface = CLType.weight(700)
      letterSpacing = 0.05f
    }
    private val rect = RectF()
    private var pinIcon: android.graphics.drawable.Drawable? = null
    private var pinIconColor = 0
    private val fontScale = context.resources.configuration.fontScale

    private fun textSize(): Float = 12f * density * min(max(fontScale, 0.85f), 1.3f)

    private fun headerH(): Int {
      textPaint.textSize = textSize()
      val fm = textPaint.fontMetrics
      return ceil(fm.descent - fm.ascent).toInt() + (16f * density).toInt()
    }

    private fun idOf(view: View, parent: RecyclerView): String? {
      val pos = parent.getChildAdapterPosition(view)
      val it = if (pos != RecyclerView.NO_POSITION) items.getOrNull(pos) else null
      if (it is Item.Row) return it.id
      return (view as? CLRowView)?.row?.id
    }

    override fun getItemOffsets(outRect: android.graphics.Rect, view: View, parent: RecyclerView, state: RecyclerView.State) {
      outRect.set(0, 0, 0, 0)
      if (!vivo || pinnedIds.isEmpty() || view !is CLRowView) return
      val id = idOf(view, parent) ?: return
      if (!pinnedIds.contains(id)) return
      val side = (12f * density).toInt()
      outRect.left = side
      outRect.right = side
      // O rótulo "FIXADAS" + alfinete é do header JS (logo acima da 1ª linha).
      // [2026-10-21 ajustes 2] respiro interno do cartão 4 → 2 (em cima/embaixo).
      if (id == pinFirstId) outRect.top = (2f * density).toInt()
      if (id == pinLastId) outRect.bottom = (12f * density).toInt()
    }

    override fun onDraw(c: Canvas, parent: RecyclerView, state: RecyclerView.State) {
      if (!vivo || pinnedIds.isEmpty()) return
      var top = Float.NaN
      var bottom = Float.NaN
      var firstTop = Float.NaN
      var lastBottom = Float.NaN
      for (i in 0 until parent.childCount) {
        val ch = parent.getChildAt(i) as? CLRowView ?: continue
        val id = idOf(ch, parent) ?: continue
        if (!pinnedIds.contains(id)) continue
        val t = ch.top + ch.translationY
        val b = ch.bottom + ch.translationY
        if (top.isNaN() || t < top) top = t
        if (bottom.isNaN() || b > bottom) bottom = b
        if (id == pinFirstId) firstTop = t
        if (id == pinLastId) lastBottom = b
      }
      if (top.isNaN()) return
      val pad = 2f * density
      val cardTop = if (!firstTop.isNaN()) firstTop - pad else top - 60f * density
      val cardBottom = if (!lastBottom.isNaN()) lastBottom + pad else bottom + 60f * density
      val side = 12f * density
      rect.set(side, cardTop, parent.width - side, cardBottom)
      val rad = 22f * density
      cardPaint.color = theme.pinnedCard
      if (!theme.dark && Build.VERSION.SDK_INT >= 28) {
        // 0 8 24 /4,5% (longe) + 0 1 2 /3,5% (perto) — sombra do cartão do JS.
        cardPaint.setShadowLayer(12f * density, 0f, 8f * density, 0x0B000000)
        c.drawRoundRect(rect, rad, rad, cardPaint)
        cardPaint.setShadowLayer(1f * density, 0f, 1f * density, 0x09000000)
        c.drawRoundRect(rect, rad, rad, cardPaint)
        cardPaint.clearShadowLayer()
      }
      c.drawRoundRect(rect, rad, rad, cardPaint)
      if (firstTop.isNaN() || !DRAW_NATIVE_HEADER) return
      // Cabeçalho "FIXADAS" acima do cartão.
      textPaint.textSize = textSize()
      textPaint.color = theme.sub
      val fm = textPaint.fontMetrics
      val baseline = cardTop - 6f * density - fm.descent
      val title = labels.get("pinnedHeader", "Fixadas").uppercase()
      val rtl = parent.layoutDirection == View.LAYOUT_DIRECTION_RTL
      val iconS = (13f * density).toInt()
      if (pinIcon == null || pinIconColor != theme.sub) {
        pinIcon = tintedIcon(context, R.drawable.ccl_ic_pin, theme.sub)
        pinIconColor = theme.sub
      }
      val midY = baseline + (fm.ascent + fm.descent) / 2f
      val x0 = 18f * density
      val tw = textPaint.measureText(title)
      val iconX = if (rtl) parent.width - x0 - iconS else x0
      val textX = if (rtl) parent.width - x0 - iconS - 6f * density - tw else x0 + iconS + 6f * density
      pinIcon?.let {
        it.setBounds(iconX.toInt(), (midY - iconS / 2f).toInt(), iconX.toInt() + iconS, (midY - iconS / 2f).toInt() + iconS)
        it.draw(c)
      }
      c.drawText(title, textX, baseline, textPaint)
    }
  }

  private val pinnedCard = PinnedCardDecoration()

  /**
   * [2026-10-18 tg-list] Detector do puxão no topo: só observa (nunca
   * intercepta). Com a lista no topo, arrastar o dedo p/ baixo mais que
   * 64 dp (e mais vertical que horizontal) dispara onPullReveal uma vez por gesto.
   */
  private val pullDetector = object : RecyclerView.OnItemTouchListener {
    private var startY = Float.NaN
    private var startX = 0f
    private var fired = false
    override fun onInterceptTouchEvent(rv: RecyclerView, e: android.view.MotionEvent): Boolean {
      when (e.actionMasked) {
        android.view.MotionEvent.ACTION_DOWN -> {
          fired = false
          startY = if (!rv.canScrollVertically(-1)) e.y else Float.NaN
          startX = e.x
        }
        android.view.MotionEvent.ACTION_MOVE -> {
          if (fired) return false
          if (rv.canScrollVertically(-1)) { startY = Float.NaN; return false }
          if (startY.isNaN()) { startY = e.y; startX = e.x; return false }
          val dy = e.y - startY
          val dx = abs(e.x - startX)
          if (dy > 64f * density && dy > dx * 1.5f) {
            fired = true
            try { onPullReveal(mapOf("distance" to (dy / density).toDouble())) } catch (_: Throwable) {}
          }
        }
        android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> { startY = Float.NaN }
      }
      return false
    }
    override fun onTouchEvent(rv: RecyclerView, e: android.view.MotionEvent) {}
    override fun onRequestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {}
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
    recycler.itemAnimator = CLSpringItemAnimator().apply {
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
    // [wave13 swipe-ios] swipe próprio (pílulas iOS) no lugar do ItemTouchHelper.
    // [lista-viva] cartão das fixadas por baixo de tudo (antes do swipe).
    recycler.addItemDecoration(pinnedCard)
    recycler.addItemDecoration(swipe)
    recycler.addOnItemTouchListener(swipe)
    recycler.addOnItemTouchListener(pullDetector)
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) { onListScrolled() }
      override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_DRAGGING) swipe.close()
        if (newState == RecyclerView.SCROLL_STATE_IDLE) snapHeader()
      }
    })
    // Animações de itens (sobe/desce) também mudam o que fica sob o vidro.
    recycler.addItemDecoration(object : RecyclerView.ItemDecoration() {
      override fun onDrawOver(c: Canvas, parent: RecyclerView, state: RecyclerView.State) {
        if (topInsetPx <= 0 || topBar.recording) return
        // [2026-10-16 topbar-hairline] progresso do vidro sempre do layout atual
        // (padding/altura do header mudam sem evento de scroll).
        updateTopBarProgress()
        if (parent.itemAnimator?.isRunning == true) topBar.contentChanged()
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
    /** [lista-viva] cabeçalho "FIXADAS" nativo desligado: quem desenha é o header JS. */
    private const val DRAW_NATIVE_HEADER = false
    private val PAYLOAD_BIND = Any()
  }
}

/**
 * [2026-10-16 motion-nav] ItemAnimator com MOLA (Telegram): o DefaultItemAnimator
 * força AccelerateDecelerate em resetAnimation(); aqui, logo depois do super
 * enfileirar a animação (que só começa em runPendingAnimations), o
 * ViewPropertyAnimator da linha recebe a mola criticamente amortecida — a
 * conversa que recebeu mensagem sobe "lançada" e assenta, sem curva linear.
 * CLSpring.enabled=false → curva padrão.
 */
internal class CLSpringItemAnimator : DefaultItemAnimator() {
  private val spring = CLSpring.Critical()

  override fun animateMove(holder: RecyclerView.ViewHolder, fromX: Int, fromY: Int, toX: Int, toY: Int): Boolean {
    val r = super.animateMove(holder, fromX, fromY, toX, toY)
    if (r && CLSpring.enabled) holder.itemView.animate().interpolator = spring
    return r
  }

  override fun animateAdd(holder: RecyclerView.ViewHolder): Boolean {
    val r = super.animateAdd(holder)
    if (r && CLSpring.enabled) holder.itemView.animate().interpolator = spring
    return r
  }

  override fun animateRemove(holder: RecyclerView.ViewHolder): Boolean {
    val r = super.animateRemove(holder)
    if (r && CLSpring.enabled) holder.itemView.animate().interpolator = spring
    return r
  }
}
