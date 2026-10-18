package expo.modules.chatyyconversationlist

// [2026-10-18 chat-info-native] "Dados do contato" / "Dados do grupo" em
// NATIVO (Android): RecyclerView + DiffUtil. Hero, cartões agrupados
// (linhas, recado/descrição, faixa de mídia) e a lista de MEMBROS
// virtualizada na mesma lista (paginação por onMembersEnd, busca por
// onMemberQuery com debounce). Mesmo contrato do iOS
// (ios/ChatyyChatInfoView.swift).

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.TypedValue
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs
import kotlin.math.max

@SuppressLint("ViewConstructor")
class ChatyyChatInfoView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onToggle by EventDispatcher()
  val onAction by EventDispatcher()
  val onAvatarPress by EventDispatcher()
  val onMediaPress by EventDispatcher()
  val onMemberPress by EventDispatcher()
  val onMembersEnd by EventDispatcher()
  val onMemberQuery by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()
  val onClose by EventDispatcher()
  // [2026-10-18 profile-edit-native] apiVersion 4: modo edição do perfil próprio.
  val onEdit by EventDispatcher()

  private var editPanel: CIEditPanel? = null
  private var editState = CIEditState()
  private var editDirty = false

  private val density = context.resources.displayMetrics.density
  private fun px(v: Float): Int = (v * density + 0.5f).toInt()

  private var hero = CIHero()
  private val rows = HashMap<String, CIRow>()
  private var rowOrder: List<String> = emptyList()
  private var media: List<CIMedia> = emptyList()
  private var members = CIMembers()

  private var needsApply = true
  private var firstPaintSent = false
  private var dark = false
  private var colorsRaw: Map<String, Any?>? = null
  private var palette = STPalette.defaults(false)
  private var paletteDirty = true
  private var labels = CLLabels()
  private var maxContentWidthDp = 0f
  private var hInsetPx = 0
  private var bottomInsetPx = 0

  private var memberQuery = ""
  private var endAskedAt = -1
  private val mainHandler = Handler(Looper.getMainLooper())
  private val queryRunnable = Runnable {
    endAskedAt = -1
    onMemberQuery(mapOf("q" to memberQuery))
  }

  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()

  // [2026-10-18 elegance] Cabeçalho que encolhe (headerMode = "collapse").
  // A lista fica num FrameLayout p/ o overlay poder ficar POR CIMA dela.
  private val stack = FrameLayout(context)
  private var collapsing = false
  private var header: CIHeaderOverlay? = null
  private var spacerView: CIHeroSpacer? = null
  private var heroBaseH = 0
  private var expandValue = 0f
  private var expandTarget = 0f
  private var expandAnim: ValueAnimator? = null
  private var stretch = 0f
  private var stretchAnim: ValueAnimator? = null
  private var pulling = false
  private var downX = 0f
  private var downY = 0f
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop

  // ─── Props ───────────────────────────────────────────────────────────────

  fun setHeroProp(m: Map<String, Any?>?) {
    try {
      hero = CIHero.from(m)
      needsApply = true
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("hero: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  fun setRowsProp(list: List<Any?>?) {
    try {
      rows.clear()
      val ids = ArrayList<String>()
      list?.forEach { x ->
        val m = CLVal.map(x) ?: return@forEach
        val r = CIRow.from(m)
        if (r.id.isEmpty() || rows.containsKey(r.id)) return@forEach
        rows[r.id] = r
        ids.add(r.id)
      }
      rowOrder = ids
      needsApply = true
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("rows: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  fun setMediaProp(list: List<Any?>?) {
    try {
      val seen = HashSet<String>()
      val next = ArrayList<CIMedia>()
      list?.forEach { x ->
        val m = CLVal.map(x) ?: return@forEach
        val it2 = CIMedia.from(m)
        if (it2.key.isEmpty() || !seen.add(it2.key)) return@forEach
        next.add(it2)
      }
      media = next
      needsApply = true
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("media: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  fun setMembersProp(m: Map<String, Any?>?) {
    try {
      val next = CIMembers.from(m)
      if (next.items.size != members.items.size || next.hasMore != members.hasMore) endAskedAt = -1
      members = next
      needsApply = true
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("members: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  /** [2026-10-18 profile-edit-native] Editar perfil nativo (CIEditPanel.kt). */
  fun setEditProp(m: Map<String, Any?>?) {
    try {
      val s = CIEditState.from(m)
      if (s == editState && editPanel != null) return
      editState = s
      editDirty = true
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("edit: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  private fun applyEdit(force: Boolean) {
    if (!editDirty && !force) return
    editDirty = false
    try {
      if (editPanel == null) {
        if (!editState.on) return
        val p = CIEditPanel(context)
        p.onEvent = { ev -> onEdit(ev) }
        stack.addView(p, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        editPanel = p
      }
      val p = editPanel ?: return
      p.bringToFront()
      p.configure(editState, palette, bottomInsetPx)
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("edit: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  private fun editShowing(): Boolean = editPanel?.visibility == View.VISIBLE

  fun setDark(v: Boolean) {
    if (v == dark) return
    dark = v
    paletteDirty = true
  }

  fun setColors(m: Map<String, Any?>?) {
    colorsRaw = m
    paletteDirty = true
  }

  fun setLabelsProp(m: Map<String, Any?>?) {
    labels = CLLabels(m)
    needsApply = true
  }

  fun setBottomInset(v: Double) {
    val p = (max(0.0, v) * density).toInt()
    if (p != bottomInsetPx) {
      bottomInsetPx = p
      recycler.setPadding(0, 0, 0, p)
    }
  }

  fun setMaxContentWidth(v: Double) {
    val dp = max(0.0, v).toFloat()
    if (dp == maxContentWidthDp) return
    maxContentWidthDp = dp
    updateInset(width)
  }

  /** [2026-10-18 elegance] "collapse" = cabeçalho Telegram; outro valor = hero estático. */
  fun setHeaderMode(v: String) {
    val on = v == "collapse"
    if (on == collapsing) return
    collapsing = on
    if (on) {
      val h = CIHeaderOverlay(context)
      h.onClose = { onClose(mapOf<String, Any>()) }
      h.onNav = { key ->
        h.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        onAction(mapOf("key" to key))
      }
      stack.addView(h, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      header = h
    } else {
      expandAnim?.cancel()
      stretchAnim?.cancel()
      expandValue = 0f
      expandTarget = 0f
      setStretch(0f)
      header?.let { stack.removeView(it) }
      header = null
      spacerView = null
    }
    needsApply = true
    headerDirty = true
  }

  private var headerDirty = true

  fun commitProps() {
    var rebindAll = false
    if (paletteDirty) {
      paletteDirty = false
      palette = STPalette.from(dark, colorsRaw)
      setBackgroundColor(palette.pageBg)
      recycler.setBackgroundColor(palette.pageBg)
      rebindAll = true
      headerDirty = true
    }
    val h = header
    if (h != null && (headerDirty || needsApply)) {
      headerDirty = false
      try {
        h.configure(hero, palette, labels)
        heroBaseH = h.heroHeight
        if (expandTarget > 0f && !h.hasPhoto) animateExpand(0f)
        updateSpacerHeight()
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("header: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
    applyData(rebindAll)
    recycler.post { updateHeader() }
    applyEdit(rebindAll)
  }

  // ─── Cabeçalho que encolhe ───────────────────────────────────────────────

  /** Rolagem relativa ao repouso (px): 0 = topo; < 0 = puxando; grande = longe. */
  private fun currentRel(): Float {
    val first = recycler.findViewHolderForAdapterPosition(0)?.itemView
    val scrolled = if (first != null) (recycler.paddingTop - first.top).toFloat() else 100000f
    return scrolled - stretch
  }

  private fun updateHeader() {
    val h = header ?: return
    h.apply(currentRel(), expandValue)
  }

  private fun updateSpacerHeight() {
    val h = header ?: return
    val sv = spacerView ?: return
    val extra = (h.photoExtra * ciClamp01(expandValue)).toInt()
    sv.heightPx = max(1, heroBaseH + extra)
  }

  private fun animateExpand(target: Float) {
    if (expandTarget == target) return
    expandTarget = target
    if (target == 0f) header?.resetPhoto()
    expandAnim?.cancel()
    val a = ValueAnimator.ofFloat(expandValue, target)
    a.duration = 380
    a.interpolator = PathInterpolator(0.2f, 0.9f, 0.1f, 1f)
    a.addUpdateListener {
      expandValue = it.animatedValue as Float
      updateSpacerHeight()
      updateHeader()
    }
    expandAnim = a
    a.start()
  }

  private fun setStretch(v: Float) {
    stretch = max(0f, v)
    recycler.translationY = stretch
    updateHeader()
  }

  private fun releaseStretch() {
    val from = stretch
    stretchAnim?.cancel()
    if (from <= 0f) return
    val a = ValueAnimator.ofFloat(from, 0f)
    a.duration = 320
    a.interpolator = DecelerateInterpolator(1.8f)
    a.addUpdateListener { setStretch(it.animatedValue as Float) }
    stretchAnim = a
    a.start()
  }

  private fun heroTouch(phase: Int, x: Float, y: Float) {
    val h = header ?: return
    val sv = spacerView ?: return
    // Espaçador → coordenadas do overlay (o overlay cobre a pilha inteira).
    val ox = x + sv.left + recycler.left + recycler.translationX
    val oy = y + sv.top + recycler.top + recycler.translationY
    when (phase) {
      0 -> h.setPressed(h.hit(ox, oy))
      1 -> {
        val target = h.hit(ox, oy)
        h.setPressed(null)
        if (target == "avatar") {
          onAvatarPress(mapOf<String, Any>("index" to h.photoIndex))
        } else if (target != null && target.startsWith("p:")) {
          // [2026-10-18 profile-native] carrossel da foto expandida.
          val dir = if (target == "p:-1") -1 else 1
          if (h.cycle(dir)) sv.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        } else if (target != null && target.startsWith("a:")) {
          sv.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
          onAction(mapOf("key" to target.substring(2)))
        }
      }
      else -> h.setPressed(null)
    }
  }

  private fun notifyNativeGesture(ev: MotionEvent) {
    try {
      val cls = Class.forName("com.facebook.react.uimanager.events.NativeGestureUtil")
      val m = cls.getMethod("notifyNativeGestureStarted", View::class.java, MotionEvent::class.java)
      val target: Any? = if (java.lang.reflect.Modifier.isStatic(m.modifiers)) null else cls.getField("INSTANCE").get(null)
      m.invoke(target, this, ev)
    } catch (_: Throwable) {}
  }

  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
    if (editShowing()) {
      pulling = false
      return false
    }
    if (!collapsing || header == null) return super.onInterceptTouchEvent(ev)
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = ev.x
        downY = ev.y
        pulling = false
        if (stretchAnim?.isRunning == true) stretchAnim?.cancel()
        if (stretch > 0f) {
          // Pegou o elástico no meio da volta: continua o puxão de onde está.
          pulling = true
          downY = ev.y - stretchToDrag(stretch)
          return true
        }
      }
      MotionEvent.ACTION_MOVE -> {
        if (pulling) return true
        val dy = ev.y - downY
        val dx = ev.x - downX
        if (dy > touchSlop && dy > abs(dx) * 1.2f && !recycler.canScrollVertically(-1)) {
          pulling = true
          downY = ev.y
          parent?.requestDisallowInterceptTouchEvent(true)
          notifyNativeGesture(ev)
          return true
        }
      }
    }
    return pulling
  }

  private val pullDim: Float get() = 400f * density

  private fun dragToStretch(dy: Float): Float = (1f - 1f / (max(0f, dy) * 0.55f / pullDim + 1f)) * pullDim

  private fun stretchToDrag(s: Float): Float {
    val q = 1f - (s / pullDim)
    if (q <= 0.01f) return pullDim * 100f
    return (1f / q - 1f) * pullDim / 0.55f
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    if (!pulling) return super.onTouchEvent(ev)
    when (ev.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        setStretch(dragToStretch(ev.y - downY))
        val h = header
        if (h != null && expandTarget == 0f && stretch > 72f * density && h.hasPhoto) {
          performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
          animateExpand(1f)
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        pulling = false
        releaseStretch()
      }
    }
    return true
  }

  /** Parou no meio do encolhimento → assenta aberto ou com o nome na barra. */
  private fun maybeSnap() {
    val h = header ?: return
    if (expandTarget > 0f || pulling || stretch > 0f) return
    val rel = currentRel()
    val dock = h.dockRel
    if (rel <= 0.5f || rel >= dock - 0.5f) return
    if (!recycler.canScrollVertically(1) && rel < dock) {
      // Conteúdo curto demais p/ encaixar: volta ao topo.
      recycler.smoothScrollBy(0, (-rel).toInt())
      return
    }
    val target = if (rel < dock / 2f) 0f else dock
    recycler.smoothScrollBy(0, (target - rel).toInt())
  }

  // ─── Dados → itens ───────────────────────────────────────────────────────

  private sealed class Item {
    abstract val key: String

    data class Hero(val hero: CIHero, val inset: Int) : Item() { override val key = "hero" }
    data class HeroSpacer(val base: Int) : Item() { override val key = "hero2" }
    data class Caption(override val key: String, val text: String, val footer: Boolean, val inset: Int, val gap: Int) : Item()
    data class Row(override val key: String, val row: CIRow, val first: Boolean, val last: Boolean, val inset: Int, val gap: Int) : Item()
    data class About(override val key: String, val row: CIRow, val first: Boolean, val last: Boolean, val inset: Int, val gap: Int) : Item()
    data class Media(override val key: String, val row: CIRow, val items: List<CIMedia>, val first: Boolean, val last: Boolean, val inset: Int, val gap: Int) : Item()
    data class Member(override val key: String, val member: CIMember, val index: Int, val first: Boolean, val last: Boolean, val inset: Int, val gap: Int) : Item()
    data class Search(override val key: String, val placeholder: String, val first: Boolean, val last: Boolean, val inset: Int, val gap: Int) : Item()
    data class State(override val key: String, val text: String, val loading: Boolean, val first: Boolean, val last: Boolean, val inset: Int, val gap: Int) : Item()
  }

  private var items: List<Item> = emptyList()
  private val stableIds = HashMap<String, Long>()
  private var nextStable = 10L
  private fun stableId(key: String): Long = stableIds.getOrPut(key) { nextStable++ }

  /** Uma entrada de cartão antes de saber a posição (1ª/última). */
  private class Pending(val key: String, val make: (first: Boolean, last: Boolean, gap: Int) -> Item)

  private fun applyData(rebindAll: Boolean) {
    if (!needsApply && !rebindAll && firstPaintSent) return
    needsApply = false
    try {
      val ins = hInsetPx
      val gapCard = px(28f)
      val next = ArrayList<Item>(rowOrder.size + members.items.size + 16)
      val seen = HashSet<String>()
      if (collapsing && header != null) {
        next.add(Item.HeroSpacer(heroBaseH))
        seen.add("hero2")
      } else {
        next.add(Item.Hero(hero, ins))
        seen.add("hero")
      }

      fun addCard(key: String, header: String, footer: String, list: List<Pending>) {
        val uniq = list.filter { seen.add(it.key) }
        if (uniq.isEmpty()) return
        if (header.isNotEmpty()) next.add(Item.Caption("h|$key", header, false, ins, 0))
        uniq.forEachIndexed { i, pd ->
          val last = i == uniq.size - 1
          val gap = if (last && footer.isEmpty()) gapCard else 0
          next.add(pd.make(i == 0, last, gap))
        }
        if (footer.isNotEmpty()) next.add(Item.Caption("f|$key", footer, true, ins, gapCard))
      }

      fun pendingFor(r: CIRow): Pending {
        val k = "r|" + r.id
        return when (r.kind) {
          "about" -> Pending(k) { f, l, g -> Item.About(k, r, f, l, ins, g) }
          "media" -> Pending(k) { f, l, g -> Item.Media(k, r, media, f, l, ins, g) }
          else -> Pending(k) { f, l, g -> Item.Row(k, r, f, l, ins, g) }
        }
      }

      var n = 0
      var curSid: String? = null
      var curHeader = ""
      var curFooter = ""
      val bucket = ArrayList<Pending>()
      fun flush() {
        addCard("$n|${curSid ?: ""}", curHeader, curFooter, ArrayList(bucket))
        n++
        bucket.clear()
        curSid = null
        curHeader = ""
        curFooter = ""
      }

      for (id in rowOrder) {
        val r = rows[id] ?: continue
        if (r.kind == "members") {
          flush()
          val list = ArrayList<Pending>()
          val mm = members
          if (mm.search.isNotEmpty()) {
            val ph = mm.search
            list.add(Pending("ms") { f, l, g -> Item.Search("ms", ph, f, l, ins, g) })
          }
          for (a in mm.actions) {
            val k = "ma|" + a.id
            val ar = CIRow(id = a.id, kind = "a", title = a.title, icon = a.icon)
            list.add(Pending(k) { f, l, g -> Item.Row(k, ar, f, l, ins, g) })
          }
          mm.items.forEachIndexed { i, m ->
            val k = "m|" + m.id
            list.add(Pending(k) { f, l, g -> Item.Member(k, m, i, f, l, ins, g) })
          }
          if (mm.loading || (mm.items.isEmpty() && mm.empty.isNotEmpty())) {
            val txt = mm.empty
            val ld = mm.loading
            list.add(Pending("mx") { f, l, g -> Item.State("mx", txt, ld, f, l, ins, g) })
          }
          val header = if (mm.header.isEmpty()) r.header else mm.header
          addCard("$n|members", header, r.footer, list)
          n++
          continue
        }
        if (curSid == null || curSid != r.sid) {
          flush()
          curSid = r.sid
          curHeader = r.header
          curFooter = r.footer
        } else if (curFooter.isEmpty() && r.footer.isNotEmpty()) {
          curFooter = r.footer
        }
        bucket.add(pendingFor(r))
      }
      flush()

      val old = items
      val forceRebind = rebindAll
      val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
        override fun getOldListSize() = old.size
        override fun getNewListSize() = next.size
        override fun areItemsTheSame(o: Int, nn: Int): Boolean = old[o].key == next[nn].key && old[o].javaClass == next[nn].javaClass
        override fun areContentsTheSame(o: Int, nn: Int): Boolean = !forceRebind && old[o] == next[nn]
        override fun getChangePayload(o: Int, nn: Int): Any = PAYLOAD_BIND
      }, false)
      items = next
      diff.dispatchUpdatesTo(adapter)
      if (!firstPaintSent) {
        firstPaintSent = true
        recycler.post { onFirstPaint(mapOf("count" to rows.size)) }
      }
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("apply: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  private fun updateInset(w: Int) {
    var inset = px(16f)
    val maxPx = (maxContentWidthDp * density).toInt()
    if (maxPx > 0 && w > maxPx) inset = max(inset, (w - maxPx) / 2 + px(16f))
    if (inset != hInsetPx) {
      hInsetPx = inset
      needsApply = true
      applyData(true)
    }
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w != oldw) post { updateInset(w) }
  }

  override fun onDetachedFromWindow() {
    mainHandler.removeCallbacks(queryRunnable)
    super.onDetachedFromWindow()
  }

  private fun queryChanged(text: String) {
    memberQuery = text
    mainHandler.removeCallbacks(queryRunnable)
    mainHandler.postDelayed(queryRunnable, 250)
  }

  private fun maybeAskMore(index: Int) {
    val count = members.items.size
    if (index >= count - 12 && members.hasMore && !members.loading && endAskedAt != count) {
      endAskedAt = count
      recycler.post { onMembersEnd(mapOf("count" to count)) }
    }
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class Holder(v: View) : RecyclerView.ViewHolder(v)

  private val rowListener = object : CIRowView.Listener {
    override fun onPress(id: String) { onRowPress(mapOf("id" to id)) }
    override fun onToggle(id: String, value: Boolean) {
      rows[id]?.let { rows[id] = it.copy(on = value) }
      this@ChatyyChatInfoView.onToggle(mapOf("id" to id, "value" to value))
    }
  }

  private fun lp(): RecyclerView.LayoutParams =
    RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)

  private fun margins(v: View, inset: Int, gap: Int) {
    val p = v.layoutParams as? RecyclerView.LayoutParams ?: lp()
    p.leftMargin = inset
    p.rightMargin = inset
    p.bottomMargin = gap
    v.layoutParams = p
  }

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (items[position]) {
      is Item.Hero -> TYPE_HERO
      is Item.HeroSpacer -> TYPE_SPACER
      is Item.Caption -> TYPE_CAPTION
      is Item.Row -> TYPE_ROW
      is Item.About -> TYPE_ABOUT
      is Item.Media -> TYPE_MEDIA
      is Item.Member -> TYPE_MEMBER
      is Item.Search -> TYPE_SEARCH
      is Item.State -> TYPE_STATE
    }

    override fun getItemId(position: Int): Long = stableId(items[position].key)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val ctx = parent.context
      val v: View = when (viewType) {
        TYPE_HERO -> CIHeroView(ctx).also { h ->
          h.onAvatar = { onAvatarPress(mapOf<String, Any>()) }
          h.onAction = { key -> onAction(mapOf("key" to key)) }
        }
        TYPE_CAPTION -> {
          val tv = TextView(ctx)
          tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
          tv.typeface = CLType.weight(400)
          tv.includeFontPadding = false
          tv.ellipsize = TextUtils.TruncateAt.END
          tv
        }
        TYPE_SPACER -> CIHeroSpacer(ctx).also { sp ->
          sp.onTouch = { phase, x, y -> heroTouch(phase, x, y) }
        }
        TYPE_ABOUT -> CIAboutView(ctx)
        TYPE_MEDIA -> CIMediaView(ctx).also { m ->
          m.onSeeAll = { onMediaPress(mapOf("key" to "")) }
          m.onItem = { key -> onMediaPress(mapOf("key" to key)) }
        }
        TYPE_MEMBER -> CIMemberView(ctx)
        TYPE_SEARCH -> CISearchView(ctx).also { s ->
          s.onChange = { text -> queryChanged(text) }
        }
        TYPE_STATE -> CIStateView(ctx)
        else -> CIRowView(ctx).also { r -> r.listener = rowListener }
      }
      v.layoutParams = lp()
      return Holder(v)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) { bind(holder, position) }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) { bind(holder, position) }

    private fun bind(holder: RecyclerView.ViewHolder, position: Int) {
      try {
        val v = holder.itemView
        when (val it = items.getOrNull(position)) {
          is Item.Hero -> {
            margins(v, it.inset, 0)
            v.setPadding(0, px(12f), 0, px(24f))
            (v as? CIHeroView)?.bind(it.hero, palette, labels.get("photo", "Ver foto"))
          }
          is Item.HeroSpacer -> {
            margins(v, 0, 0)
            val sp = v as? CIHeroSpacer ?: return
            spacerView = sp
            updateSpacerHeight()
          }
          is Item.Caption -> {
            margins(v, it.inset, it.gap)
            val tv = v as? TextView ?: return
            tv.text = it.text
            tv.setTextColor(if (it.footer) palette.secondary else palette.header)
            if (it.footer) tv.setPadding(px(16f), px(8f), px(16f), 0)
            else tv.setPadding(px(16f), 0, px(16f), px(8f))
            tv.contentDescription = it.text
          }
          is Item.Row -> {
            margins(v, it.inset, it.gap)
            (v as? CIRowView)?.bind(it.row, palette, it.first, it.last)
          }
          is Item.About -> {
            margins(v, it.inset, it.gap)
            val av = v as? CIAboutView ?: return
            val id = it.row.id
            av.onPress = { onRowPress(mapOf("id" to id)) }
            av.bind(it.row, palette, it.first, it.last)
          }
          is Item.Media -> {
            margins(v, it.inset, it.gap)
            (v as? CIMediaView)?.bind(it.row, it.items, palette, it.first, it.last)
          }
          is Item.Member -> {
            margins(v, it.inset, it.gap)
            val mv = v as? CIMemberView ?: return
            val id = it.member.id
            mv.onPress = { onMemberPress(mapOf("id" to id)) }
            mv.bind(it.member, palette, it.first, it.last)
            maybeAskMore(it.index)
          }
          is Item.Search -> {
            margins(v, it.inset, it.gap)
            (v as? CISearchView)?.bind(it.placeholder, memberQuery, palette, it.first, it.last)
          }
          is Item.State -> {
            margins(v, it.inset, it.gap)
            (v as? CIStateView)?.bind(it.text, it.loading, palette, it.first, it.last)
          }
          null -> {}
        }
      } catch (e: Throwable) {
        onNativeError(mapOf("message" to ("bind: " + (e.message ?: e.javaClass.simpleName))))
      }
    }
  }

  init {
    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.isVerticalScrollBarEnabled = true
    recycler.itemAnimator = null
    recycler.setItemViewCacheSize(12)
    stack.addView(recycler, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    addView(stack, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
        if (!collapsing) return
        if (expandTarget > 0f && currentRel() > 28f * density) animateExpand(0f)
        updateHeader()
      }

      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        if (collapsing && newState == RecyclerView.SCROLL_STATE_IDLE) maybeSnap()
      }
    })
    hInsetPx = px(16f)
    setBackgroundColor(palette.pageBg)
  }

  companion object {
    private const val TYPE_HERO = 0
    private const val TYPE_CAPTION = 1
    private const val TYPE_ROW = 2
    private const val TYPE_ABOUT = 3
    private const val TYPE_MEDIA = 4
    private const val TYPE_MEMBER = 5
    private const val TYPE_SEARCH = 6
    private const val TYPE_STATE = 7
    private const val TYPE_SPACER = 8
    private val PAYLOAD_BIND = Any()
  }
}
