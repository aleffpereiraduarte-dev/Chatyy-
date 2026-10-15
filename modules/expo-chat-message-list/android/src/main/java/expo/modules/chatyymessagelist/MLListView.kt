package expo.modules.chatyymessagelist

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.InputMethodManager
import android.graphics.Bitmap
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import java.io.File
import java.io.FileOutputStream
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.chatyychatstore.ChatyyStoreDB
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** [native-store] linhas mais novas gravadas por conversa no store nativo. */
private const val STORE_WINDOW = 60

// [2026-10-14 native-list] ChatyyMessageList (Android) — RecyclerView com
// LinearLayoutManager(reverseLayout = true): posição 0 = mensagem mais nova,
// embaixo. Layout (StaticLayout) num executor de fundo, altura cacheada por
// chave; diff por chave (DiffUtil) aplicado na main; inserção no fim animada
// pelo ItemAnimator; lendo acima, o LayoutManager mantém a âncora.

@SuppressLint("ViewConstructor")
class MLListView(context: Context, appContext: AppContext) : ExpoView(context, appContext), MLTransferObserver {
  // RN (ReactViewGroup) engole requestLayout: sem isto o RecyclerView não
  // remede/relayouta ao mudar o adapter fora de um passe do Yoga.
  override val shouldUseAndroidLayout: Boolean = true

  val onReady by EventDispatcher()
  val onNativeError by EventDispatcher()
  val onRowPress by EventDispatcher()
  val onRowLongPress by EventDispatcher()
  val onSwipeReply by EventDispatcher()
  val onLoadOlder by EventDispatcher()
  val onScrollState by EventDispatcher()
  val onDragState by EventDispatcher()
  val onVisible by EventDispatcher()
  // [native-ctxmenu] menu de contexto nativo (apiVersion 3)
  val onMenuAction by EventDispatcher()
  val onReact by EventDispatcher()
  val onMenuDismiss by EventDispatcher()
  // [native-store] foto da conversa lida do store nativo (apiVersion 4)
  val onStore by EventDispatcher()
  // [native-media-dl] download nativo de mídia (apiVersion 5)
  val onMediaTransfer by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "chatyy-msglist-layout").apply { priority = Thread.NORM_PRIORITY + 1 } }

  private val rows = HashMap<String, MLRow>()
  private val layouts = HashMap<String, MLRowLayout>()
  private var target: List<String> = emptyList()   // mais nova primeiro
  private var applied: List<String> = emptyList()
  private val changedSinceApply = HashSet<String>()
  private var pendingAnim = false

  private var themeMap: Map<String, Any?> = emptyMap()
  private var theme = MLTheme()
  private var fontSize = 16f
  private var lineHeight = 21f
  private var radius = 18f
  private var styleVersion = 0
  private var style: MLStyle? = null
  private var styleDirty = true
  private var bottomInsetDp = 8f
  private var topInsetDp = 0f
  private var dismissMode = "interactive"
  private var generation = 0
  private var readySent = false
  private var audioState: MLAudioState? = null
  private var pendingFlash: String? = null
  private var destroyed = false

  // [2026-10-15 native-store] Foto da conversa no store nativo (modules/
  // expo-chat-store) — espelho do CMLListView.swift. Prop `store` {a,c,r,n}: na
  // montagem lê a última janela desta conversa e PINTA sem esperar o JS; o 1º
  // applyRows do JS substitui (linha idêntica mantém o layout); depois de cada
  // applyRows a janela mais nova é regravada direto no store (debounce).
  private class StoreCfg(val a: String, val c: String, val r: String, val n: String)
  private var storeCfg: StoreCfg? = null
  private var storeLoadStarted = false
  private var jsApplied = false
  private val storeDicts = HashMap<String, Map<String, Any?>>()
  private val rawDicts = HashMap<String, Map<String, Any?>>()
  private var jsVersion = 0
  private var persistedVersion = 0
  private val persistRunnable = Runnable { persistNow() }
  private val storeInteractive: Boolean get() = jsApplied || storeDicts.isEmpty()

  // [fase 2]
  private var liftedKey = ""
  // [native-ctxmenu]
  private var ctxMenuOn = false
  private var darkHint: Boolean? = null
  private var ctxOverlay: MLCtxOverlay? = null
  private var popKey: String? = null
  private var popSig = ""
  private var popUntil = 0L
  private val revealedKeys = HashSet<String>()
  private val vnPlayer = MLVideoNotePlayer(context.applicationContext) { k, what ->
    main.post { if (!destroyed) onRowPress(mapOf("key" to k, "part" to "vnote", "url" to what)) }
  }
  private var stickyOn = false
  private var stickyTopDp = 8f
  private val sticky = TextView(context)
  private var stickyVisible = false
  private val stickyHide = Runnable { hideSticky() }

  private val lm = LinearLayoutManager(context, LinearLayoutManager.VERTICAL, true)
  private val rv = RecyclerView(context)
  private val frame = FrameLayout(context)
  private val adapter = Adapter()

  // rolagem
  private var lastScrollEmit = 0L
  private var lastDistClass = -1
  private var lastOlderAt = 0L
  private var olderArmed = true
  private var visibleScheduled = false
  private var lastVisibleSig = ""

  init {
    clipChildren = true
    rv.layoutManager = lm
    rv.adapter = adapter
    rv.clipToPadding = false
    rv.overScrollMode = View.OVER_SCROLL_NEVER
    rv.isVerticalScrollBarEnabled = true
    rv.setHasFixedSize(true)
    rv.setItemViewCacheSize(8)
    rv.recycledViewPool.setMaxRecycledViews(0, 24)
    rv.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      addDuration = 180
      moveDuration = 200
      removeDuration = 120
    }
    addView(frame, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    frame.addView(rv, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    rv.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
        if (dy != 0) updateSticky()
        emitScroll(false)
        scheduleVisible()
        maybeLoadOlder()
      }

      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        when (newState) {
          RecyclerView.SCROLL_STATE_DRAGGING -> {
            onDragState(mapOf("dragging" to true))
            if (dismissMode == "on-drag") hideKeyboard()
          }
          RecyclerView.SCROLL_STATE_IDLE -> {
            scheduleStickyHide()
            onDragState(mapOf("dragging" to false))
            emitScroll(true)
            scheduleVisible()
          }
        }
      }
    })
    rv.addOnItemTouchListener(Touch())
    rv.addRecyclerListener { h -> (h.itemView as? MLCellView)?.let { vnPlayer.stopIf(it) } }
    MLEmojiCache.appContext = context.applicationContext
    // pílula de data flutuante (estilo do JS: pad 14/6, raio 14, 12sp 700, sombra)
    sticky.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12f)
    sticky.typeface = MLFonts.of(700, false, false)
    sticky.includeFontPadding = false
    sticky.setPadding(dp(14f).toInt(), dp(6f).toInt(), dp(14f).toInt(), dp(6f).toInt())
    sticky.gravity = Gravity.CENTER
    sticky.elevation = dp(4f)
    sticky.alpha = 0f
    sticky.visibility = View.GONE
    sticky.isClickable = false
    sticky.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    frame.addView(sticky, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply {
      gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
      topMargin = dp(stickyTopDp).toInt()
    })
    applyInsets()
    MLTransfers.addObserver(this, context)
  }

  // ─── [2026-10-15 native-media-dl] transferências ─────────────────────────
  override fun transferChanged(key: String) {
    if (destroyed) return
    for (i in 0 until rv.childCount) {
      val c = rv.getChildAt(i) as? MLCellView ?: continue
      if (key in c.transferKeys) c.applyTransfers()
    }
    // toque do usuário concluído → tique leve
    val x = MLTransfers.item(key)
    if (x != null && x.state == MLXferState.DONE && x.user && !x.external) {
      x.user = false
      try { rv.performHapticFeedback(if (android.os.Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.KEYBOARD_TAP) } catch (_: Throwable) {}
    }
  }

  override fun transferEvent(body: Map<String, Any>) {
    if (destroyed) return
    onMediaTransfer(body)
  }

  fun setTransfers(list: List<Map<String, Any?>>) { MLTransfers.setExternal(list) }

  // ─── [fase 2] props/comandos ─────────────────────────────────────────────
  fun setStickyDate(m: Map<String, Any?>?) {
    val on = m != null && MLRow.bool(m["on"])
    stickyOn = on
    if (!on) { hideSticky(); return }
    m!!
    stickyTopDp = (MLRow.num(m["top"]) ?: 8.0).toFloat()
    val bg = MLRow.color(m["bg"]) ?: 0xF2FFFFFF.toInt()
    val fg = MLRow.color(m["fg"]) ?: 0xB3000000.toInt()
    val d = GradientDrawable()
    d.cornerRadius = dp(14f)
    d.setColor(bg)
    sticky.background = d
    sticky.setTextColor(fg)
    val sh = m["shadow"]
    sticky.elevation = if (sh != null && !MLRow.bool(sh)) 0f else dp(4f)
    (sticky.layoutParams as? FrameLayout.LayoutParams)?.let { it.topMargin = dp(stickyTopDp).toInt(); sticky.layoutParams = it }
  }

  fun setLiftedKey(key: String) {
    val prev = liftedKey
    liftedKey = key
    for (i in 0 until rv.childCount) {
      val c = rv.getChildAt(i) as? MLCellView ?: continue
      if (c.key == key && key.isNotEmpty()) c.setLifted(true)
      else if (c.key == prev || c.lifted) c.setLifted(false)
    }
  }

  private fun updateSticky() {
    if (!stickyOn || applied.isEmpty()) return
    var dates = 0
    for (k in applied) { if (rows[k]?.kind == MLKind.DATE) { dates++; if (dates > 1) break } }
    if (dates <= 1) { hideSticky(); return }
    val top = lm.findLastVisibleItemPosition()
    if (top == RecyclerView.NO_POSITION) return
    var label = ""
    var i = top
    while (i < applied.size) {
      val r = rows[applied[i]]
      if (r != null && r.kind == MLKind.DATE) { label = r.text; break }
      i++
    }
    if (label.isEmpty()) return
    if (sticky.text?.toString() != label) sticky.text = label
    if (!stickyVisible) {
      stickyVisible = true
      sticky.visibility = View.VISIBLE
      sticky.animate().cancel()
      sticky.animate().alpha(1f).setDuration(180).start()
    }
    main.removeCallbacks(stickyHide)
  }

  private fun scheduleStickyHide() {
    main.removeCallbacks(stickyHide)
    if (stickyVisible) main.postDelayed(stickyHide, 1500)
  }

  private fun hideSticky() {
    main.removeCallbacks(stickyHide)
    if (!stickyVisible) return
    stickyVisible = false
    sticky.animate().cancel()
    sticky.animate().alpha(0f).setDuration(400).withEndAction { if (!stickyVisible) sticky.visibility = View.GONE }.start()
  }

  // ─── [hero] frame da miniatura (mesmas coords do anchor: dp, relativo à raiz React)
  private fun frameOf(c: MLCellView, i: Int): Map<String, Any>? {
    val (f, rad) = c.mediaRectInCell(i) ?: return null
    val loc = IntArray(2)
    c.getLocationInWindow(loc)
    val rl = IntArray(2)
    reactRoot()?.getLocationInWindow(rl)
    val d = resources.displayMetrics.density
    return mapOf(
      "x" to ((loc[0] - rl[0] + f.left) / d).toDouble(), "y" to ((loc[1] - rl[1] + f.top) / d).toDouble(),
      "w" to (f.width() / d).toDouble(), "h" to (f.height() / d).toDouble(), "radius" to (rad / d).toDouble(),
    )
  }

  /** Miniatura da mensagem `mid` visível agora (null = fora da tela). */
  fun mediaFrame(mid: String): Map<String, Any>? {
    if (mid.isEmpty()) return null
    for (i in 0 until rv.childCount) {
      val c = rv.getChildAt(i) as? MLCellView ?: continue
      val r = c.row ?: continue
      if (r.kind != MLKind.MSG) continue
      var idx = -1
      if (r.album.isNotEmpty()) {
        val a = r.album.indexOfFirst { it.id == mid }
        val b = r.albumIds.indexOf(mid)
        idx = if (a >= 0) a else if (b >= 0) min(b, r.album.size - 1) else if (r.id == mid) 0 else -1
      } else if (r.id == mid && r.media != null) idx = 0
      if (idx < 0) continue
      // fora da área visível da lista → sem hero
      val (f, _) = c.mediaRectInCell(idx) ?: return null
      val top = c.top + f.top
      val bottom = c.top + f.bottom
      if (bottom <= 0f || top >= rv.height.toFloat()) return null
      return frameOf(c, idx)
    }
    return null
  }

  // ─── [native-ctxmenu] menu de contexto nativo ───────────────────────────
  fun setCtxMenu(on: Boolean) {
    ctxMenuOn = on
    if (!on) ctxOverlay?.dismiss("off", false)
  }

  fun setDarkHint(v: Boolean?) { darkHint = v }

  private fun findCell(key: String): MLCellView? {
    for (i in 0 until rv.childCount) {
      val c = rv.getChildAt(i) as? MLCellView ?: continue
      if (c.key == key) return c
    }
    return null
  }

  /** Balão (snapshot) em coordenadas da janela. */
  private fun bubbleWindowRect(c: MLCellView, rect: RectF): RectF {
    val loc = IntArray(2)
    c.getLocationInWindow(loc)
    return RectF(loc[0] + rect.left, loc[1] + rect.top, loc[0] + rect.right, loc[1] + rect.bottom)
  }

  private fun currentBubbleRect(key: String): RectF? {
    val c = findCell(key) ?: return null
    if (!c.isAttachedToWindow) return null
    val r = c.bubbleRectInCell() ?: return null
    return bubbleWindowRect(c, r)
  }

  private fun openCtxOverlay(c: MLCellView, key: String, own: Boolean): Boolean {
    val act = MLCtxOverlay.activityOf(context) ?: appContext.currentActivity ?: return false
    val shot = c.snapshotBubble() ?: return false
    val (bmp, rect) = shot
    val win = bubbleWindowRect(c, rect)
    val dark = darkHint ?: ((resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES)
    val ov = MLCtxOverlay(act, key, bmp, win, own, dark)
    ov.sourceRectProvider = { currentBubbleRect(key) }
    ov.onAction = { d, action -> onMenuAction(mapOf("key" to d.key, "messageId" to d.messageId, "action" to action)) }
    ov.onReact = { d, emoji ->
      popKey = d.key
      popSig = reactSig(d.key)
      popUntil = SystemClock.uptimeMillis() + 4000
      onReact(mapOf("key" to d.key, "messageId" to d.messageId, "emoji" to emoji))
    }
    ov.onDismissed = { reason ->
      if (ctxOverlay === ov) ctxOverlay = null
      if (liftedKey == key) setLiftedKey("")
      if (!destroyed) {
        onMenuDismiss(mapOf("key" to key, "reason" to reason))
        checkPendingPop()
      }
    }
    if (!ov.present()) { try { bmp.recycle() } catch (_: Throwable) {}; return false }
    ctxOverlay = ov
    setLiftedKey(key)
    return true
  }

  /** JS → nativo: lista de ações/reações. Abre o overlay se o long-press não abriu. */
  fun showContextMenu(payload: Map<String, Any?>): Boolean {
    val d = MLCtxMenuData(payload)
    if (d.key.isEmpty()) return false
    val cur = ctxOverlay
    if (cur != null && !cur.dismissing) {
      if (cur.key == d.key) { if (cur.data == null) cur.setMenu(d); return true }
      cur.dismiss("replaced", false)
    }
    val c = findCell(d.key) ?: return false
    val r = c.row ?: return false
    if (r.kind != MLKind.MSG) return false
    if (!openCtxOverlay(c, d.key, r.own)) return false
    ctxOverlay?.setMenu(d)
    return true
  }

  fun dismissContextMenu() { ctxOverlay?.dismiss("js") }

  private fun reactSig(k: String): String = rows[k]?.reacts?.joinToString(",") { "${it.emoji}:${it.count}:${if (it.mine) 1 else 0}" } ?: ""

  private fun checkPendingPop() {
    val k = popKey ?: return
    if (SystemClock.uptimeMillis() > popUntil) { popKey = null; return }
    val ov = ctxOverlay
    if (ov != null && ov.key == k) return
    if (reactSig(k) == popSig) return
    popKey = null
    val r = rows[k] ?: return
    if (r.reacts.isEmpty()) return
    findCell(k)?.popReactions()
  }

  /** Raiz React (Fabric mede relativo a ela). */
  private fun reactRoot(): View? {
    var p = parent
    var last: View? = null
    while (p is View) {
      val n = p.javaClass.name
      if (n.contains("ReactRootView") || n.contains("ReactSurfaceView")) return p
      last = p
      p = p.parent
    }
    return last
  }

  private fun anchorFor(c: MLCellView, cb: (Map<String, Any>?) -> Unit) {
    val shot = c.snapshotBubble() ?: run { cb(null); return }
    val (bmp, rect) = shot
    val loc = IntArray(2)
    c.getLocationInWindow(loc)
    val rl = IntArray(2)
    reactRoot()?.getLocationInWindow(rl)
    val d = resources.displayMetrics.density
    val x = (loc[0] - rl[0] + rect.left) / d
    val y = (loc[1] - rl[1] + rect.top) / d
    val w = rect.width() / d
    val h = rect.height() / d
    val dir = File(context.cacheDir, "chatyy-lift")
    worker.execute {
      var uri: String? = null
      try {
        if (!dir.exists()) dir.mkdirs()
        // limpa snapshots antigos (>30 s)
        dir.listFiles()?.forEach { f -> if (System.currentTimeMillis() - f.lastModified() > 30_000) f.delete() }
        val f = File(dir, "lift_" + System.nanoTime() + ".png")
        FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        uri = "file://" + f.absolutePath
      } catch (_: Throwable) { uri = null }
      try { bmp.recycle() } catch (_: Throwable) {}
      main.post {
        if (destroyed) return@post
        cb(uri?.let { mapOf("uri" to it, "x" to x.toDouble(), "y" to y.toDouble(), "w" to w.toDouble(), "h" to h.toDouble()) })
      }
    }
  }

  // ─── props ───────────────────────────────────────────────────────────────
  fun setTheme(m: Map<String, Any?>) { themeMap = m; theme = MLTheme(m); markStyleDirty() }
  fun setFontSize(v: Double?) { val n = (v ?: 16.0).toFloat(); if (n != fontSize) { fontSize = n; markStyleDirty() } }
  fun setLineHeight(v: Double?) { val n = (v ?: 21.0).toFloat(); if (n != lineHeight) { lineHeight = n; markStyleDirty() } }
  fun setRadius(v: Double?) { val n = (v ?: 18.0).toFloat(); if (n != radius) { radius = n; markStyleDirty() } }
  fun setKeyboardDismissMode(v: String?) { dismissMode = v ?: "interactive" }
  fun setInsets(bottom: Double?, top: Double?) {
    if (bottom != null) bottomInsetDp = bottom.toFloat()
    if (top != null) topInsetDp = top.toFloat()
    applyInsets()
  }

  private fun dp(v: Float): Float = v * resources.displayMetrics.density

  private fun applyInsets() {
    // reverseLayout: paddingBottom = espaço sob a mais nova
    rv.setPadding(0, dp(topInsetDp + 6f).toInt(), 0, dp(bottomInsetDp).toInt())
  }

  private fun markStyleDirty() {
    styleDirty = true
    ensureStyle()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w != oldw) styleDirty = true
    ensureStyle()
  }

  private fun ensureStyle() {
    val w = width
    if (w <= 10) return
    val cur = style
    if (!styleDirty && cur != null && abs(cur.width - w) < 1f) return
    styleDirty = false
    styleVersion += 1
    val dm = resources.displayMetrics
    style = MLStyle(w.toFloat(), dm.density, resources.configuration.fontScale, fontSize, lineHeight, radius, theme, styleVersion)
    layouts.clear()
    changedSinceApply.addAll(target)
    scheduleLayout()
  }

  // ─── dados (JS → nativo) ─────────────────────────────────────────────────
  fun applyRows(payload: Map<String, Any?>) {
    val firstJS = !jsApplied
    jsApplied = true
    applyRowsCore(payload, false)
    if (firstJS) { storeDicts.clear(); unwatchStore() }
    jsVersion += 1
    schedulePersist()
  }

  private fun applyRowsCore(payload: Map<String, Any?>, fromStore: Boolean) {
    try {
      (payload["rows"] as? List<*>)?.forEach { d ->
        @Suppress("UNCHECKED_CAST")
        val m = d as? Map<String, Any?> ?: return@forEach
        val k0 = m["k"] as? String
        if (k0 != null) {
          if (fromStore) {
            storeDicts[k0] = m
          } else {
            if (storeCfg != null) rawDicts[k0] = m
            // mesma linha que a foto já pintou → mantém linha + layout
            val sd = storeDicts[k0]
            if (sd != null && rows.containsKey(k0) && sameRow(sd, m)) return@forEach
          }
        }
        val r = MLRow(m)
        if (!r.isValid) return@forEach
        rows[r.key] = r
        layouts.remove(r.key)
        changedSinceApply.add(r.key)
      }
      (payload["keys"] as? List<*>)?.let { keys ->
        val seen = HashSet<String>()
        val disp = ArrayList<String>(keys.size)
        for (i in keys.indices.reversed()) {
          val k = keys[i] as? String ?: continue
          if (k in seen || !rows.containsKey(k)) continue
          seen.add(k)
          disp.add(k)
        }
        target = disp
        if (rows.size > disp.size + 300) {
          rows.keys.retainAll(seen)
          layouts.keys.retainAll(seen)
          rawDicts.keys.retainAll(seen)
        }
        olderArmed = true
      }
      if (MLRow.bool(payload["anim"])) pendingAnim = true
      scheduleLayout()
    } catch (t: Throwable) {
      onNativeError(mapOf("message" to ("apply: " + (t.message ?: t.javaClass.simpleName))))
    }
  }

  private fun scheduleLayout() {
    val s = style ?: return
    generation += 1
    val gen = generation
    val todo = ArrayList<Pair<String, MLRow>>()
    for (k in target) if (!layouts.containsKey(k)) rows[k]?.let { todo.add(Pair(k, it)) }
    if (todo.isEmpty()) { applySnapshot(); return }
    worker.execute {
      val out = ArrayList<Triple<String, MLRow, MLRowLayout>>(todo.size)
      var err: Throwable? = null
      for ((k, r) in todo) {
        try { out.add(Triple(k, r, MLLayoutBuilder.build(r, s))) } catch (t: Throwable) { err = t }
      }
      main.post {
        if (destroyed || style !== s) return@post
        for ((k, r, l) in out) if (rows[k] === r) layouts[k] = l
        err?.let { onNativeError(mapOf("message" to ("layout: " + (it.message ?: it.javaClass.simpleName)))) }
        if (gen == generation) applySnapshot()
      }
    }
  }

  /** Distância (px) entre o fim visível e a mensagem mais nova. */
  private fun distanceFromLatest(): Float {
    if (applied.isEmpty()) return 0f
    val first = lm.findFirstVisibleItemPosition()
    if (first == RecyclerView.NO_POSITION) return 0f
    val v = lm.findViewByPosition(first) ?: return 0f
    var d = (v.bottom - (rv.height - rv.paddingBottom)).toFloat()
    for (i in 0 until first) {
      if (i >= applied.size) break
      d += layouts[applied[i]]?.height ?: 0f
    }
    return max(0f, d)
  }

  private fun applySnapshot() {
    if (style == null) return
    for (k in target) if (!layouts.containsKey(k)) return
    val newKeys = target
    val old = applied
    val oldSet = old.toHashSet()
    val changed = HashSet(changedSinceApply)
    val orderSame = newKeys == old
    val reconf = changed.filter { it in oldSet }
    if (orderSame && reconf.isEmpty()) { changedSinceApply.clear(); pendingAnim = false; sendReady(); return }
    var insertedBottom = 0
    var insertedElsewhere = 0
    if (!orderSame) {
      for ((i, k) in newKeys.withIndex()) if (k !in oldSet) { if (i < 4) insertedBottom++ else insertedElsewhere++ }
    }
    val atBottom = old.isEmpty() || distanceFromLatest() < dp(3f)
    val animate = pendingAnim && atBottom && old.isNotEmpty() && insertedBottom in 1..3 && insertedElsewhere == 0
    val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
      override fun getOldListSize() = old.size
      override fun getNewListSize() = newKeys.size
      override fun areItemsTheSame(o: Int, n: Int) = old[o] == newKeys[n]
      override fun areContentsTheSame(o: Int, n: Int) = !changed.contains(newKeys[n])
    }, false)
    applied = newKeys
    changedSinceApply.clear()
    pendingAnim = false
    val animator = rv.itemAnimator
    if (!animate) rv.itemAnimator = null
    diff.dispatchUpdatesTo(adapter)
    if (atBottom) rv.scrollToPosition(0)
    if (!animate) rv.post { if (!destroyed) rv.itemAnimator = animator }
    rv.post {
      if (destroyed) return@post
      sendReady()
      emitScroll(true)
      scheduleVisible()
      checkPendingPop()
    }
  }

  private fun sendReady() {
    if (readySent) return
    readySent = true
    onReady(mapOf("count" to applied.size, "src" to if (jsApplied) "js" else "store"))
  }

  // ─── [native-store] foto da conversa ─────────────────────────────────────
  /** Igualdade numérica tolerante (JS manda Double; JSON volta Int/Long). */
  private fun sameRow(a: Any?, b: Any?): Boolean {
    if (a is Number && b is Number) return a.toDouble() == b.toDouble()
    if (a is Map<*, *> && b is Map<*, *>) {
      if (a.size != b.size) return false
      for ((k, v) in a) { if (!b.containsKey(k) || !sameRow(v, b[k])) return false }
      return true
    }
    if (a is List<*> && b is List<*>) {
      if (a.size != b.size) return false
      for (i in a.indices) if (!sameRow(a[i], b[i])) return false
      return true
    }
    return a == b
  }

  fun setStore(v: Map<String, Any?>?) {
    if (v == null) { storeCfg = null; return }
    val a = MLRow.str(v["a"]); val c = MLRow.str(v["c"]); val r = MLRow.str(v["r"]); val n = MLRow.str(v["n"])
    if (a.isEmpty() || c.isEmpty() || r.isEmpty()) { storeCfg = null; return }
    val p = storeCfg
    if (p != null && (p.a != a || p.c != c)) {
      main.removeCallbacks(persistRunnable)
      rawDicts.clear()
      persistedVersion = jsVersion
    }
    storeCfg = StoreCfg(a, c, r, n)
    if (jsApplied || storeLoadStarted) return
    storeLoadStarted = true
    val db = try { ChatyyStoreDB.get(context) } catch (_: Throwable) { null } ?: return
    // [fase 1.5] pré-carga do pressIn da home: pinta SÍNCRONO no set da prop.
    val mem = try { db.cachedThread(a, c, r) } catch (_: Throwable) { null }
    if (mem != null && (n.isEmpty() || mem.newest == n)) {
      applyRowsCore(mapOf("rows" to mem.rows, "keys" to mem.keys, "anim" to 0), true)
      onStore(mapOf("hit" to 1, "why" to "mem", "ms" to 0, "readMs" to mem.readMs.toLong(), "rows" to mem.keys.size))
      watchStore(db, a, c)
      return
    }
    loadStoreSnapshot(db, a, c, r, "hit")
    watchStore(db, a, c)
  }

  private var storeObsToken: Int? = null

  private fun loadStoreSnapshot(db: ChatyyStoreDB, a: String, c: String, r: String, reason: String) {
    val t0 = SystemClock.uptimeMillis()
    db.loadThread(a, c, r) { snap, why ->
      if (destroyed) return@loadThread
      val ms = SystemClock.uptimeMillis() - t0
      if (snap == null) { onStore(mapOf("hit" to 0, "why" to why, "ms" to ms)); return@loadThread }
      if (jsApplied) { onStore(mapOf("hit" to 0, "why" to "late", "ms" to ms, "rows" to snap.keys.size)); return@loadThread }
      val cur = storeCfg
      if (cur == null || cur.a != a || cur.c != c) { onStore(mapOf("hit" to 0, "why" to "moved", "ms" to ms)); return@loadThread }
      // o JS tem mensagem mais nova que a foto → não pinta algo velho (a fase 2
      // anexa as novas na foto pelo sync — services/nativeStoreRows)
      if (cur.n.isNotEmpty() && snap.newest != cur.n) { onStore(mapOf("hit" to 0, "why" to "stale", "ms" to ms, "rows" to snap.keys.size)); return@loadThread }
      applyRowsCore(mapOf("rows" to snap.rows, "keys" to snap.keys, "anim" to if (reason == "hit") 0 else 1), true)
      onStore(mapOf("hit" to 1, "why" to reason, "ms" to ms, "readMs" to snap.readMs.toLong(), "rows" to snap.keys.size))
    }
  }

  /** [fase 2] só a foto na tela (casca leve): lote do sync nesta conversa → relê. */
  private fun watchStore(db: ChatyyStoreDB, a: String, c: String) {
    unwatchStore()
    storeObsToken = db.addObserver(a, c) {
      val cfg = storeCfg
      if (!destroyed && !jsApplied && cfg != null && cfg.a == a && cfg.c == c) {
        storeCfg = StoreCfg(cfg.a, cfg.c, cfg.r, "")
        loadStoreSnapshot(db, a, c, cfg.r, "live")
      }
    }
  }

  private fun unwatchStore() {
    val t = storeObsToken ?: return
    storeObsToken = null
    try { ChatyyStoreDB.get(context).removeObserver(t) } catch (_: Throwable) {}
  }

  private fun schedulePersist() {
    if (storeCfg == null || !jsApplied) return
    main.removeCallbacks(persistRunnable)
    main.postDelayed(persistRunnable, 1200)
  }

  /** Regrava a janela mais nova (até STORE_WINDOW) como o JS mandou, sem estado transitório. */
  private fun persistNow() {
    main.removeCallbacks(persistRunnable)
    val cfg = storeCfg ?: return
    if (!jsApplied || persistedVersion == jsVersion) return
    persistedVersion = jsVersion
    val keys = ArrayList<String>()
    val out = ArrayList<Map<String, Any?>>()
    for (k in target) { // mais nova primeiro
      if (keys.size >= STORE_WINDOW) break
      val d0 = rawDicts[k] ?: continue
      if (d0["kind"] == "unread") continue
      val id = d0["id"] as? String
      if (id != null && id.startsWith("tmp")) continue
      val d = HashMap(d0)
      d.remove("sel")
      (d["media"] as? Map<*, *>)?.let { m0 ->
        if (m0.containsKey("up")) { val m = HashMap<Any?, Any?>(m0); m.remove("up"); d["media"] = m }
      }
      keys.add(k); out.add(d)
    }
    keys.reverse(); out.reverse()
    try { ChatyyStoreDB.get(context).saveThread(cfg.a, cfg.c, cfg.r, keys, out) } catch (_: Throwable) {}
  }

  // ─── comandos ────────────────────────────────────────────────────────────
  fun scrollToLatest(animated: Boolean) {
    if (applied.isEmpty()) return
    if (animated && distanceFromLatest() < rv.height * 2f) rv.smoothScrollToPosition(0) else rv.scrollToPosition(0)
    rv.post { emitScroll(true); scheduleVisible() }
  }

  fun scrollToKey(key: String, viewPosition: Double, animated: Boolean): Boolean {
    val pos = applied.indexOf(key)
    if (pos < 0) return false
    val h = layouts[key]?.height ?: 0f
    val avail = (rv.height - rv.paddingTop - rv.paddingBottom).toFloat()
    val p = viewPosition.coerceIn(0.0, 1.0).toFloat()
    // reverseLayout: offset é medido a partir de baixo (paddingBottom)
    val fromBottom = ((1f - p) * max(0f, avail - h)).toInt()
    lm.scrollToPositionWithOffset(pos, fromBottom)
    rv.post { emitScroll(true); scheduleVisible() }
    return true
  }

  fun flashKey(key: String) {
    val pos = applied.indexOf(key)
    val v = if (pos >= 0) lm.findViewByPosition(pos) as? MLCellView else null
    if (v != null) v.flash() else pendingFlash = key
  }

  fun setAudioState(d: Map<String, Any?>) {
    val id = MLRow.str(d["id"])
    val prev = audioState?.id
    audioState = if (id.isEmpty()) null else MLAudioState(id, MLRow.bool(d["playing"]), MLRow.bool(d["loading"]), MLRow.num(d["pos"]), MLRow.num(d["dur"]))
    for (i in 0 until rv.childCount) {
      val c = rv.getChildAt(i) as? MLCellView ?: continue
      val r = c.row ?: continue
      if (r.audio != null && (r.id == id || r.id == prev)) c.setAudio(audioState)
    }
  }

  fun destroy() {
    persistNow() // [native-store] (idempotente: só grava se mudou desde a última)
    main.removeCallbacks(persistRunnable)
    destroyed = true
    MLTransfers.removeObserver(this)
    unwatchStore()
    ctxOverlay?.dismiss("destroy", false)
    try { vnPlayer.stop() } catch (_: Throwable) {}
    main.removeCallbacks(stickyHide)
    try { worker.shutdownNow() } catch (_: Throwable) {}
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    persistNow() // [native-store] saiu da conversa → grava já
    ctxOverlay?.dismiss("detach", false)
    try { vnPlayer.stop() } catch (_: Throwable) {}
  }

  // ─── eventos de rolagem ──────────────────────────────────────────────────
  private fun emitScroll(force: Boolean) {
    val d = distanceFromLatest()
    val dd = d / resources.displayMetrics.density
    val cls = if (dd <= 6) 0 else if (dd <= 120) 1 else if (dd <= 300) 2 else 3
    val now = SystemClock.uptimeMillis()
    if (!force && cls == lastDistClass && now - lastScrollEmit < 66) return
    lastDistClass = cls
    lastScrollEmit = now
    val density = resources.displayMetrics.density
    var total = 0f
    for (k in applied) total += layouts[k]?.height ?: 0f
    val vh = rv.height.toFloat()
    onScrollState(mapOf(
      "dist" to (d / density).toDouble(),
      "ch" to (max(total + rv.paddingTop + rv.paddingBottom, vh) / density).toDouble(),
      "vh" to (vh / density).toDouble(),
    ))
  }

  private fun maybeLoadOlder() {
    if (applied.isEmpty() || !olderArmed) return
    val last = lm.findLastVisibleItemPosition()
    if (last == RecyclerView.NO_POSITION) return
    if (last >= applied.size - 8) {
      val now = SystemClock.uptimeMillis()
      if (now - lastOlderAt > 800) {
        lastOlderAt = now
        olderArmed = false
        onLoadOlder(mapOf<String, Any>())
      }
    }
  }

  private fun scheduleVisible() {
    if (visibleScheduled) return
    visibleScheduled = true
    main.postDelayed({ visibleScheduled = false; if (!destroyed) emitVisible() }, 120)
  }

  private fun emitVisible() {
    if (!isAttachedToWindow) return
    val keys = ArrayList<String>()
    val top = rv.paddingTop
    val bottom = rv.height - rv.paddingBottom
    for (i in 0 until rv.childCount) {
      val c = rv.getChildAt(i) as? MLCellView ?: continue
      val h = c.height
      if (h <= 0) continue
      val vis = min(c.bottom, bottom) - max(c.top, top)
      if (vis >= min(h, bottom - top) * 0.3f && c.key.isNotEmpty()) keys.add(c.key)
    }
    val sig = keys.joinToString("|")
    if (sig == lastVisibleSig) return
    lastVisibleSig = sig
    if (keys.isNotEmpty()) onVisible(mapOf("keys" to keys))
  }

  private fun hideKeyboard() {
    try {
      val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
      imm?.hideSoftInputFromWindow(windowToken, 0)
    } catch (_: Throwable) {}
  }

  // ─── adapter ─────────────────────────────────────────────────────────────
  private inner class Holder(val cell: MLCellView) : RecyclerView.ViewHolder(cell)

  private inner class Adapter : RecyclerView.Adapter<Holder>() {
    init { setHasStableIds(false) }
    override fun getItemCount(): Int = applied.size
    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
      val v = MLCellView(parent.context)
      v.layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      return Holder(v)
    }
    override fun onBindViewHolder(holder: Holder, position: Int) {
      val k = applied.getOrNull(position) ?: return
      val r = rows[k] ?: return
      val l = layouts[k] ?: return
      val s = style ?: return
      holder.cell.onRecycled = { c -> vnPlayer.stopIf(c) }
      holder.cell.bind(k, r, l, s, audioState, liftedKey, k in revealedKeys)
      if (pendingFlash == k) { pendingFlash = null; holder.cell.post { holder.cell.flash() } }
      // [native-media-dl] auto-download (política) das mídias que entram na tela
      if (holder.cell.transferKeys.isNotEmpty()) holder.cell.autoStartTransfers(this@MLListView)
    }
    override fun onViewRecycled(holder: Holder) { holder.cell.recycle() }
  }

  // ─── toques: tocar / segurar / arrastar-p/-responder ─────────────────────
  private inner class Touch : RecyclerView.OnItemTouchListener {
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var cell: MLCellView? = null
    private var swiping = false
    private var dir = 1f
    private var armed = false
    private val threshold = dp(64f)
    private val detector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
      override fun onDown(e: MotionEvent): Boolean = true
      override fun onSingleTapUp(e: MotionEvent): Boolean { tapAt(e.x, e.y); return true }
      override fun onLongPress(e: MotionEvent) { longAt(e.x, e.y) }
    })

    override fun onInterceptTouchEvent(rv: RecyclerView, e: MotionEvent): Boolean {
      if (!storeInteractive) return false // [native-store] só a foto na tela: JS ainda não conhece os itens
      if (!swiping) detector.onTouchEvent(e)
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = e.x; downY = e.y; swiping = false; armed = false
          cell = rv.findChildViewUnder(e.x, e.y) as? MLCellView
          cell?.let { c -> if ((c.row?.sel ?: 0) == 0) c.pressedAction = c.actionIndexAt(e.x - c.left, e.y - c.top) }
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          cell?.let { c -> c.postDelayed({ c.pressedAction = -1 }, 90) }
        }
        MotionEvent.ACTION_MOVE -> {
          if (swiping) return true
          val dx = e.x - downX
          val dy = e.y - downY
          if (abs(dx) > slop || abs(dy) > slop) cell?.pressedAction = -1
          val c = cell ?: return false
          val r = c.row ?: return false
          if (abs(dx) > slop && abs(dx) > abs(dy) * 1.3f && downX > dp(28f) && r.kind == MLKind.MSG && r.sel == 0) {
            if (dx < 0 && (!r.own || r.deleted)) return false
            dir = if (dx > 0) 1f else -1f
            swiping = true
            rv.parent?.requestDisallowInterceptTouchEvent(true)
            val cancel = MotionEvent.obtain(e).apply { action = MotionEvent.ACTION_CANCEL }
            detector.onTouchEvent(cancel)
            cancel.recycle()
            return true
          }
        }
      }
      return false
    }

    override fun onTouchEvent(rv: RecyclerView, e: MotionEvent) {
      val c = cell ?: return
      when (e.actionMasked) {
        MotionEvent.ACTION_MOVE -> {
          val raw = max(0f, (e.x - downX) * dir)
          var x = if (raw <= threshold) raw else threshold + (raw - threshold) * 0.35f
          x = min(x, dp(110f))
          c.swipeX = x * dir
          val armedNow = raw >= threshold
          if (armedNow && !armed) {
            // [reply-v2] haptic de limiar (API 34: GESTURE_THRESHOLD_ACTIVATE=23) + estalo do ícone
            try { c.performHapticFeedback(if (android.os.Build.VERSION.SDK_INT >= 34) 23 else HapticFeedbackConstants.KEYBOARD_TAP) } catch (_: Throwable) {}
            c.popReplyIcon()
          }
          armed = armedNow
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          c.pressedAction = -1
          val fire = e.actionMasked == MotionEvent.ACTION_UP && armed
          val from = c.swipeX
          val a = ValueAnimator.ofFloat(from, 0f)
          a.duration = 340
          a.interpolator = android.view.animation.OvershootInterpolator(0.8f) // [reply-v2] volta com mola
          a.addUpdateListener { c.swipeX = it.animatedValue as Float }
          a.start()
          if (fire) onSwipeReply(mapOf("key" to c.key, "dir" to if (dir > 0) "reply" else "info"))
          swiping = false
          armed = false
          cell = null
        }
      }
    }

    override fun onRequestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {}

    private fun tapAt(x: Float, y: Float) {
      if (!storeInteractive) return
      val c = rv.findChildViewUnder(x, y) as? MLCellView ?: return
      val r = c.row ?: return
      val part = c.partAt(x - c.left, y - c.top)
      val body = HashMap<String, Any>()
      body["key"] = c.key
      when (part) {
        is MLCellView.Part.Media -> {
          body["part"] = "media"; body["index"] = part.index
          // [hero] miniatura tocada → viewer anima a foto saindo dela
          frameOf(c, part.index)?.let { body["frame"] = it }
        }
        is MLCellView.Part.Reply -> body["part"] = "reply"
        is MLCellView.Part.Link -> { body["part"] = "link"; body["url"] = part.url }
        is MLCellView.Part.Audio -> body["part"] = "audio"
        is MLCellView.Part.File -> body["part"] = "file"
        is MLCellView.Part.Reaction -> {
          body["part"] = "reaction"; body["index"] = part.index
          if (part.index < r.reacts.size) body["url"] = r.reacts[part.index].emoji
        }
        is MLCellView.Part.Action -> { body["part"] = "action"; body["url"] = part.action; body["index"] = part.index }
        is MLCellView.Part.Retry -> body["part"] = "retry"
        is MLCellView.Part.VNote -> {
          if (r.sel == 0) {
            val o = c.lay?.vnote
            if (o != null) vnPlayer.toggle(c, c.key, o.uri)
            return
          }
          body["part"] = "bubble"
        }
        is MLCellView.Part.Spoiler -> {
          if (r.sel == 0) { revealedKeys.add(c.key); c.revealSpoilers(); return }
          body["part"] = "bubble"
        }
        is MLCellView.Part.Bubble -> body["part"] = "bubble"
        is MLCellView.Part.Xfer -> {
          if (r.sel > 0) { body["part"] = "bubble" } else {
            // [native-media-dl] baixar / cancelar no próprio nativo; envio → JS
            val (dl, up) = c.xferInfo(part.slot)
            if (up != null) {
              body["part"] = "xfer"; body["url"] = "cancel-up"; body["index"] = max(0, part.slot)
              onRowPress(body)
              return
            }
            val d = dl ?: return
            val x = MLTransfers.probe(d)
            try { c.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) } catch (_: Throwable) {}
            when (x.state) {
              MLXferState.DONE -> {
                when (part.slot) {
                  MLCellView.XFER_AUDIO -> body["part"] = "audio"
                  MLCellView.XFER_FILE -> body["part"] = "file"
                  else -> { body["part"] = "media"; body["index"] = max(0, part.slot); frameOf(c, max(0, part.slot))?.let { body["frame"] = it } }
                }
              }
              MLXferState.RUNNING, MLXferState.QUEUED -> {
                if (x.external) { body["part"] = "xfer"; body["url"] = "cancel-js"; body["k"] = d.key; onRowPress(body) }
                else MLTransfers.cancel(d.key)
                return
              }
              else -> {
                if (d.js && x.state == MLXferState.NONE) { body["part"] = "xfer"; body["url"] = "cancel-js"; body["k"] = d.key; onRowPress(body); return }
                MLTransfers.start(d, true, this@MLListView)
                return
              }
            }
          }
        }
        is MLCellView.Part.None -> { if (r.sel > 0) body["part"] = "bubble" else return }
      }
      if (r.sel > 0 && r.kind == MLKind.MSG) body["part"] = "bubble"
      onRowPress(body)
    }

    private fun longAt(x: Float, y: Float) {
      if (swiping || !storeInteractive) return
      val c = rv.findChildViewUnder(x, y) as? MLCellView ?: return
      val r = c.row ?: return
      if (r.kind != MLKind.MSG && r.kind != MLKind.SYSTEM) return
      val part = c.partAt(x - c.left, y - c.top)
      if (part is MLCellView.Part.None) return
      val idx = if (part is MLCellView.Part.Media) part.index else 0
      c.pressedAction = -1
      try { c.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) } catch (_: Throwable) {}
      val key = c.key
      if (r.kind != MLKind.MSG || r.sel > 0) {
        onRowLongPress(mapOf("key" to key, "index" to idx))
        return
      }
      // [native-ctxmenu] menu 100% nativo: o balão sai da lista já; o JS manda
      // a lista de ações via showContextMenu(payload).
      if (ctxMenuOn && ctxOverlay == null && openCtxOverlay(c, key, r.own)) {
        onRowLongPress(mapOf("key" to key, "index" to idx, "native" to 1))
        return
      }
      // [fase 2] snapshot ANTES do "lift" (o draw não aplica a escala da view)
      anchorFor(c) { anchor ->
        val body = HashMap<String, Any>()
        body["key"] = key
        body["index"] = idx
        if (anchor != null) body["anchor"] = anchor
        onRowLongPress(body)
      }
      val L = c.lay
      if (L != null) { c.pivotX = L.bubble.centerX() + c.swipeX; c.pivotY = L.bubble.centerY() }
      c.animate().scaleX(1.03f).scaleY(1.03f).setDuration(110).withEndAction {
        c.animate().scaleX(1f).scaleY(1f).setDuration(160).start()
      }.start()
    }
  }
}
