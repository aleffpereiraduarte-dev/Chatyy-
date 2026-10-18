package expo.modules.chatyyconversationlist

// [2026-10-18 native-apps-grid] Painel "Apps" nativo (Android):
//   • busca fixa no topo (EditText; filtra ao vivo sem acento/caixa — mesma
//     regra do JS: título da seção casa → seção inteira);
//   • RecyclerView + GridLayoutManager(4) com spanSizeLookup:
//       cartão da Bia (só sem busca) · cabeçalho · faixa "Recentes" (RecyclerView
//       horizontal aninhado: fixados + MRU, até 8) · ladrilhos 1 coluna · respiro
//       · "sem resultados";
//   • segurar um app = modo editar (tremor); tocar fixa/tira; segurar um fixado
//     e arrastar reordena (ItemTouchHelper, só dentro de "Fixados");
//   • puxar p/ baixo no topo e soltar = onPullDismiss (o JS fecha a folha);
//   • altura do conteúdo (dp) → onContentHeight (a folha JS se ajusta).
// Mesmo contrato do iOS (ios/ChatyyAppsGridView.swift).
// Regra do projeto: try só em forma de statement (nunca try-expressão).

import android.content.Context
import android.provider.Settings
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.graphics.Color
import android.graphics.PorterDuff
import android.graphics.drawable.GradientDrawable
import android.view.animation.DecelerateInterpolator
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

internal data class APRow(
  val type: Int,
  val key: String,
  val appId: String = "",
  val title: String = "",
  val fav: Boolean = false
)

class ChatyyAppsGridView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onAppPress by EventDispatcher()
  val onEditingChange by EventDispatcher()
  val onPinnedChange by EventDispatcher()
  val onQueryChange by EventDispatcher()
  val onContentHeight by EventDispatcher()
  val onPullDismiss by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val density = context.resources.displayMetrics.density

  // Props
  private var sections: List<APSection> = emptyList()
  private var itemById: Map<String, APItem> = emptyMap()
  private var recent: List<String> = emptyList()
  private var pinned: MutableList<String> = ArrayList()
  private var badges: Map<String, Int> = emptyMap()
  private var labels: Map<String, String> = emptyMap()
  private var dark = false
  private var theme = APTheme(false)
  private var editing = false
  private var query = ""
  private var bottomInsetDp = 0.0
  private var resetSeq = Int.MIN_VALUE
  private var searchEnabled = true

  // Estado
  private var dirty = true
  private var styleDirty = true
  private var labelsDirty = true
  private var appliedOnce = false
  private var pendingIntro = false
  private var rows: MutableList<APRow> = ArrayList()
  private var stripIds: List<String> = emptyList()
  private var stripSet: Set<String> = emptySet()
  private var lastContentDp = -1.0
  private var dragging = false
  private var dragMoved = false
  private var dirtyDuringDrag = false
  private var muteWatcher = false
  private val stableIds = HashMap<String, Long>()
  private var nextStable = 1L
  private var reduceMotion = false

  private val searchBox = FrameLayout(context)
  private val searchIcon = ImageView(context)
  private val field = EditText(context)
  private val clearBtn = ImageView(context)
  private val recycler = APRecycler(context)
  private val grid = GridLayoutManager(context, 4)
  private val adapter = Adapter()
  private val touchHelper = ItemTouchHelper(DragCallback())

  private fun px(dp: Float): Int = Math.round(dp * density)

  init {
    orientation = LinearLayout.VERTICAL
    clipChildren = true
    var scale = 1f
    try {
      scale = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    } catch (_: Throwable) {
    }
    reduceMotion = scale == 0f

    // Busca
    searchIcon.setImageResource(R.drawable.ap_ic_search)
    searchIcon.scaleType = ImageView.ScaleType.FIT_CENTER
    searchBox.addView(searchIcon, FrameLayout.LayoutParams(px(17f), px(17f), Gravity.CENTER_VERTICAL or Gravity.START).apply {
      leftMargin = px(12f)
    })
    field.background = null
    field.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    field.isSingleLine = true
    field.maxLines = 1
    field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    field.imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    field.setPadding(0, 0, 0, 0)
    field.includeFontPadding = false
    field.gravity = Gravity.CENTER_VERTICAL or Gravity.START
    searchBox.addView(field, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply {
      leftMargin = px(12f + 17f + 8f)
      rightMargin = px(36f)
    })
    clearBtn.setImageResource(R.drawable.ap_ic_close)
    clearBtn.scaleType = ImageView.ScaleType.FIT_CENTER
    clearBtn.setPadding(px(4.5f), px(4.5f), px(4.5f), px(4.5f))
    clearBtn.visibility = View.GONE
    clearBtn.isClickable = true
    searchBox.addView(clearBtn, FrameLayout.LayoutParams(px(20f), px(20f), Gravity.CENTER_VERTICAL or Gravity.END).apply {
      rightMargin = px(12f)
    })
    addView(searchBox, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(44f)).apply {
      leftMargin = px(16f)
      rightMargin = px(16f)
      bottomMargin = px(14f)
    })
    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        if (muteWatcher) return
        onQueryText(s?.toString() ?: "")
      }
    })
    field.setOnEditorActionListener { _, actionId, _ ->
      if (actionId == EditorInfo.IME_ACTION_SEARCH || actionId == EditorInfo.IME_ACTION_DONE) {
        hideKeyboard()
        true
      } else false
    }
    clearBtn.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      field.setText("")
    }

    // Lista
    grid.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
      override fun getSpanSize(position: Int): Int {
        if (position < 0 || position >= rows.size) return 4
        return if (rows[position].type == T_TILE) 1 else 4
      }
    }
    recycler.layoutManager = grid
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.clipChildren = false
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.isVerticalScrollBarEnabled = false
    recycler.setPadding(px(16f), 0, px(16f), px(20f))
    recycler.itemAnimator = if (reduceMotion) null else DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 220
      addDuration = 180
      removeDuration = 120
    }
    recycler.onPullDismiss = {
      hideKeyboard()
      recycler.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      onPullDismiss(mapOf<String, Any>())
    }
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_DRAGGING) hideKeyboard()
      }
    })
    touchHelper.attachToRecyclerView(recycler)
    addView(recycler, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
  }

  // ── Props ──────────────────────────────────────────────────────────────────

  fun setSectionsProp(list: List<Any?>?) {
    val secs = APText.parseSections(list)
    val map = HashMap<String, APItem>()
    for (s in secs) for (it in s.items) if (!map.containsKey(it.id)) map[it.id] = it
    sections = secs
    itemById = map
    dirty = true
  }

  private fun strList(list: List<Any?>?): List<String> {
    val out = ArrayList<String>()
    list?.forEach { v -> val s = CLVal.str(v); if (s.isNotEmpty()) out.add(s) }
    return out
  }

  fun setRecentProp(list: List<Any?>?) {
    val v = strList(list)
    if (v == recent) return
    recent = v
    dirty = true
  }

  fun setPinnedProp(list: List<Any?>?) {
    if (dragging) return
    val v = strList(list)
    if (v == pinned) return
    pinned = ArrayList(v)
    dirty = true
  }

  fun setBadgesProp(m: Map<String, Any?>?) {
    val out = HashMap<String, Int>()
    m?.forEach { (k, v) -> val n = CLVal.int(v); if (n > 0) out[k] = n }
    if (out == badges) return
    badges = out
    dirty = true
  }

  fun setLabelsProp(m: Map<String, Any?>?) {
    val out = HashMap<String, String>()
    m?.forEach { (k, v) -> out[k] = CLVal.str(v) }
    if (out == labels) return
    labels = out
    labelsDirty = true
    dirty = true
  }

  fun setDark(v: Boolean) {
    if (v == dark && appliedOnce) return
    dark = v
    styleDirty = true
  }

  fun setEditingProp(v: Boolean) {
    if (v == editing) return
    editing = v
    dirty = true
  }

  fun setBottomInset(v: Double) {
    val c = Math.max(0.0, v)
    if (Math.abs(c - bottomInsetDp) < 0.5) return
    bottomInsetDp = c
    recycler.setPadding(px(16f), 0, px(16f), px((c + 20.0).toFloat()))
    dirty = true
  }

  fun setResetSeq(v: Double) {
    val n = if (v.isNaN() || v.isInfinite()) 0 else v.coerceIn(-1e9, 1e9).toInt()
    if (n == resetSeq) return
    resetSeq = n
    muteWatcher = true
    field.setText("")
    muteWatcher = false
    query = ""
    clearBtn.visibility = View.GONE
    hideKeyboard()
    recycler.scrollToPosition(0)
    pendingIntro = true
    dirty = true
  }

  fun setSearchEnabled(v: Boolean) {
    if (v == searchEnabled) return
    searchEnabled = v
    searchBox.visibility = if (v) View.VISIBLE else View.GONE
    if (!v) hideKeyboard()
    lastContentDp = -1.0
    dirty = true
  }

  fun commitProps() {
    try {
      if (styleDirty) {
        styleDirty = false
        theme = APTheme(dark)
        setBackgroundColor(theme.bg)
        val sb = GradientDrawable()
        sb.cornerRadius = px(14f).toFloat()
        sb.setColor(theme.fieldBg)
        searchBox.background = sb
        searchIcon.setColorFilter(theme.muted, PorterDuff.Mode.SRC_IN)
        field.setTextColor(theme.text)
        field.setHintTextColor(theme.muted)
        val cb = GradientDrawable()
        cb.shape = GradientDrawable.OVAL
        cb.setColor(if (dark) Color.argb(71, 255, 255, 255) else Color.argb(64, 0, 0, 0))
        clearBtn.background = cb
        clearBtn.setColorFilter(if (dark) Color.BLACK else Color.WHITE, PorterDuff.Mode.SRC_IN)
        labelsDirty = true
        dirty = true
      }
      if (labelsDirty) {
        labelsDirty = false
        val ph = labels["search"] ?: ""
        field.hint = ph
        field.contentDescription = ph
        clearBtn.contentDescription = labels["clear"] ?: ""
      }
      applyRows()
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("apps: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  // ── Linhas ─────────────────────────────────────────────────────────────────

  private fun stableId(key: String): Long = stableIds.getOrPut(key) { nextStable++ }

  private fun applyRows() {
    if (!dirty) return
    if (dragging) { dirtyDuringDrag = true; return }
    dirty = false
    val q = query
    val next = ArrayList<APRow>()
    var strip: List<String> = emptyList()
    if (q.isEmpty() && itemById["one"]?.featured == true) next.add(APRow(T_BIA, "bia"))
    if (q.isEmpty()) {
      if (editing) {
        val fav = ArrayList<String>()
        for (k in pinned) if (itemById.containsKey(k) && !fav.contains(k)) fav.add(k)
        if (fav.isNotEmpty()) {
          next.add(APRow(T_HEADER, "h:fav", title = labels["pinned"] ?: ""))
          for (k in fav) next.add(APRow(T_TILE, "f:$k", appId = k, fav = true))
          next.add(APRow(T_GAP, "gap:fav"))
        }
      } else {
        val out = ArrayList<String>()
        val seen = HashSet<String>()
        for (k in pinned + recent) {
          if (!itemById.containsKey(k) || !seen.add(k)) continue
          out.add(k)
          if (out.size >= STRIP_MAX) break
        }
        if (out.isNotEmpty()) {
          next.add(APRow(T_HEADER, "h:strip", title = labels["recent"] ?: ""))
          next.add(APRow(T_STRIP, "strip"))
          next.add(APRow(T_GAP, "gap:strip"))
          strip = out
        }
      }
    }
    var anyGrid = false
    for (s in sections) {
      val secHit = q.isNotEmpty() && s.norm.contains(q)
      val items = s.items.filter { if (q.isEmpty()) !it.featured else (secHit || it.norm.contains(q)) }
      if (items.isEmpty()) continue
      next.add(APRow(T_HEADER, "h:${s.key}", title = s.title))
      for (it in items) next.add(APRow(T_TILE, "g:${s.key}:${it.id}", appId = it.id))
      next.add(APRow(T_GAP, "gap:${s.key}"))
      anyGrid = true
    }
    if (q.isNotEmpty() && !anyGrid) next.add(APRow(T_EMPTY, "empty"))

    stripIds = strip
    stripSet = strip.toHashSet()
    val old: List<APRow> = rows
    val animate = appliedOnce && isAttachedToWindow && !pendingIntro
    appliedOnce = true
    if (!animate || old.isEmpty()) {
      rows = next
      adapter.notifyDataSetChanged()
    } else {
      val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
        override fun getOldListSize() = old.size
        override fun getNewListSize() = next.size
        override fun areItemsTheSame(o: Int, n: Int): Boolean = old[o].key == next[n].key
        override fun areContentsTheSame(o: Int, n: Int): Boolean = false
        override fun getChangePayload(o: Int, n: Int): Any = PAYLOAD_BIND
      }, true)
      rows = next
      diff.dispatchUpdatesTo(adapter)
    }
    reportContentHeight()
    if (pendingIntro) {
      pendingIntro = false
      recycler.post { playIntro() }
    }
  }

  private fun reportContentHeight() {
    var dp = 0.0
    var i = 0
    while (i < rows.size) {
      val r = rows[i]
      when (r.type) {
        T_HEADER -> dp += 24.0
        T_BIA -> dp += 98.0
        T_STRIP -> dp += 98.0
        T_GAP -> dp += 12.0
        T_EMPTY -> dp += 170.0
        T_TILE -> {
          var n = 0
          while (i < rows.size && rows[i].type == T_TILE) { n++; i++ }
          dp += Math.ceil(n / 4.0) * 110.0
          continue
        }
      }
      i++
    }
    if (searchEnabled) dp += 44.0 + 14.0
    dp += bottomInsetDp + 20.0
    if (Math.abs(dp - lastContentDp) > 0.5) {
      lastContentDp = dp
      onContentHeight(mapOf("height" to dp))
    }
  }

  private fun playIntro() {
    if (reduceMotion || !isAttachedToWindow) return
    val cellW = Math.max(1, (recycler.width - recycler.paddingLeft - recycler.paddingRight) / 4)
    val rowH = 90f * density
    for (i in 0 until recycler.childCount) {
      val c = recycler.getChildAt(i) ?: continue
      val row = Math.max(0, (c.top / rowH).toInt())
      val col = Math.max(0, Math.min(3, (c.left - recycler.paddingLeft) / cellW))
      val delay = Math.min(520L, 30L + row * 55L + col * 22L)
      c.animate().cancel()
      c.alpha = 0f
      c.scaleX = 0.92f
      c.scaleY = 0.92f
      c.translationY = 8f * density
      c.animate().alpha(1f).scaleX(1f).scaleY(1f).translationY(0f)
        .setStartDelay(delay).setDuration(420).setInterpolator(DecelerateInterpolator(1.6f)).start()
    }
  }

  // ── Ações ──────────────────────────────────────────────────────────────────

  private fun hideKeyboard() {
    try {
      if (field.hasFocus()) {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(field.windowToken, 0)
        field.clearFocus()
      }
    } catch (_: Throwable) {
    }
  }

  private fun onQueryText(raw: String) {
    clearBtn.visibility = if (raw.isEmpty()) View.GONE else View.VISIBLE
    val n = APText.norm(raw.trim())
    if (n == query) return
    query = n
    if (editing && n.isNotEmpty()) {
      editing = false
      onEditingChange(mapOf("editing" to false))
    }
    dirty = true
    try {
      applyRows()
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("apps query: " + (e.message ?: e.javaClass.simpleName))))
    }
    onQueryChange(mapOf("q" to raw))
  }

  private fun setEditingInternal(v: Boolean, from: View?) {
    if (v == editing) return
    editing = v
    if (v) {
      from?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      hideKeyboard()
    }
    dirty = true
    applyRows()
    onEditingChange(mapOf("editing" to v))
  }

  private fun togglePin(id: String, from: View?) {
    from?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    val i = pinned.indexOf(id)
    if (i >= 0) {
      pinned.removeAt(i)
    } else {
      pinned.add(id)
      while (pinned.size > STRIP_MAX) pinned.removeAt(0)
    }
    dirty = true
    applyRows()
    onPinnedChange(mapOf("ids" to ArrayList(pinned)))
  }

  private fun onTileTap(appId: String, v: View) {
    if (appId.isEmpty()) return
    if (editing) { togglePin(appId, v); return }
    v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    hideKeyboard()
    onAppPress(mapOf("id" to appId))
  }

  private fun onTileLong(appId: String, fav: Boolean, v: View): Boolean {
    if (appId.isEmpty()) return false
    if (!editing) { setEditingInternal(true, v); return true }
    if (fav) return false // ItemTouchHelper assume o arrasto
    togglePin(appId, v)
    return true
  }

  private fun cellWidth(): Int {
    val w = recycler.width - recycler.paddingLeft - recycler.paddingRight
    return if (w > 0) w / 4 else px(84f)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w != oldw) {
      val idx = rows.indexOfFirst { it.type == T_STRIP }
      if (idx >= 0) recycler.post { adapter.notifyItemChanged(idx, PAYLOAD_BIND) }
    }
  }

  private fun bindTile(cell: APTileView, appId: String, fav: Boolean, strip: Boolean) {
    val item = itemById[appId] ?: return
    var badge = badges[appId] ?: 0
    // Badge só UMA vez: na faixa Recentes se o app estiver lá; senão na grade.
    if (!strip && !fav && stripSet.contains(appId)) badge = 0
    val seed = Math.abs(appId.hashCode() % 97)
    cell.bind(item, theme, badge, editing, pinned.contains(appId), strip, seed, labels, reduceMotion)
  }

  // ── Adapters ───────────────────────────────────────────────────────────────

  private class Holder(v: View) : RecyclerView.ViewHolder(v) {
    var strip: StripAdapter? = null
  }

  private inner class StripAdapter : RecyclerView.Adapter<Holder>() {
    override fun getItemCount(): Int = stripIds.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
      val cell = APTileView(parent.context)
      cell.layoutParams = RecyclerView.LayoutParams(cellWidth(), px(98f))
      val h = Holder(cell)
      cell.setOnClickListener { v ->
        val p = h.bindingAdapterPosition
        if (p == RecyclerView.NO_POSITION || p >= stripIds.size) return@setOnClickListener
        onTileTap(stripIds[p], v)
      }
      cell.setOnLongClickListener { v ->
        val p = h.bindingAdapterPosition
        if (p == RecyclerView.NO_POSITION || p >= stripIds.size) return@setOnLongClickListener false
        onTileLong(stripIds[p], false, v)
      }
      return h
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
      if (position >= stripIds.size) return
      val cell = holder.itemView as? APTileView ?: return
      val lp = cell.layoutParams
      val w = cellWidth()
      if (lp != null && lp.width != w) { lp.width = w; cell.layoutParams = lp }
      bindTile(cell, stripIds[position], false, true)
    }

    override fun onViewRecycled(holder: Holder) {
      (holder.itemView as? APTileView)?.resetAnim()
    }
  }

  private inner class Adapter : RecyclerView.Adapter<Holder>() {
    override fun getItemCount(): Int = rows.size
    override fun getItemId(position: Int): Long = stableId(rows[position].key)
    override fun getItemViewType(position: Int): Int = rows[position].type

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
      val mw = ViewGroup.LayoutParams.MATCH_PARENT
      when (viewType) {
        T_HEADER -> {
          val v = APHeaderView(parent.context)
          v.layoutParams = RecyclerView.LayoutParams(mw, px(24f))
          return Holder(v)
        }
        T_BIA -> {
          val v = APBiaView(parent.context)
          v.layoutParams = RecyclerView.LayoutParams(mw, px(98f))
          v.setPadding(0, 0, 0, px(20f))
          val h = Holder(v)
          v.setOnClickListener { view ->
            if (editing) { setEditingInternal(false, view); return@setOnClickListener }
            view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
            hideKeyboard()
            onAppPress(mapOf("id" to "one"))
          }
          v.voice.setOnClickListener { view ->
            if (editing) return@setOnClickListener
            view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
            hideKeyboard()
            onAppPress(mapOf("id" to "one", "voice" to true))
          }
          return h
        }
        T_STRIP -> {
          val rv = RecyclerView(parent.context)
          rv.layoutParams = RecyclerView.LayoutParams(mw, px(98f))
          rv.layoutManager = LinearLayoutManager(parent.context, LinearLayoutManager.HORIZONTAL, false)
          rv.clipChildren = false
          rv.clipToPadding = false
          rv.overScrollMode = View.OVER_SCROLL_NEVER
          rv.isHorizontalScrollBarEnabled = false
          rv.itemAnimator = null
          val h = Holder(rv)
          val sa = StripAdapter()
          rv.adapter = sa
          h.strip = sa
          return h
        }
        T_TILE -> {
          val cell = APTileView(parent.context)
          cell.layoutParams = RecyclerView.LayoutParams(mw, px(110f))
          val h = Holder(cell)
          cell.setOnClickListener { v ->
            val p = h.bindingAdapterPosition
            if (p == RecyclerView.NO_POSITION || p >= rows.size) return@setOnClickListener
            onTileTap(rows[p].appId, v)
          }
          cell.setOnLongClickListener { v ->
            val p = h.bindingAdapterPosition
            if (p == RecyclerView.NO_POSITION || p >= rows.size) return@setOnLongClickListener false
            onTileLong(rows[p].appId, rows[p].fav, v)
          }
          return h
        }
        T_EMPTY -> {
          val v = APEmptyView(parent.context)
          v.layoutParams = RecyclerView.LayoutParams(mw, px(170f))
          return Holder(v)
        }
        else -> {
          val v = View(parent.context)
          v.layoutParams = RecyclerView.LayoutParams(mw, px(12f))
          return Holder(v)
        }
      }
    }

    override fun onBindViewHolder(holder: Holder, position: Int) = bind(holder, position)

    override fun onBindViewHolder(holder: Holder, position: Int, payloads: MutableList<Any>) = bind(holder, position)

    private fun bind(holder: Holder, position: Int) {
      if (position < 0 || position >= rows.size) return
      val r = rows[position]
      val v = holder.itemView
      when (r.type) {
        T_HEADER -> (v as? APHeaderView)?.bind(r.title, theme)
        T_BIA -> (v as? APBiaView)?.bind(theme, labels, reduceMotion)
        T_STRIP -> holder.strip?.notifyDataSetChanged()
        T_TILE -> (v as? APTileView)?.let { bindTile(it, r.appId, r.fav, false) }
        T_EMPTY -> (v as? APEmptyView)?.bind(theme, labels["noResults"] ?: "")
      }
    }

    override fun onViewRecycled(holder: Holder) {
      val v = holder.itemView
      v.animate().cancel()
      v.alpha = 1f
      v.scaleX = 1f
      v.scaleY = 1f
      v.translationY = 0f
      (v as? APTileView)?.resetAnim()
    }
  }

  // ── Reordenar fixados (modo editar) ────────────────────────────────────────

  private inner class DragCallback : ItemTouchHelper.Callback() {
    private fun isFav(p: Int): Boolean = p != RecyclerView.NO_POSITION && p >= 0 && p < rows.size && rows[p].fav

    override fun getMovementFlags(recyclerView: RecyclerView, viewHolder: RecyclerView.ViewHolder): Int {
      if (!editing || !isFav(viewHolder.bindingAdapterPosition)) return 0
      val drag = ItemTouchHelper.UP or ItemTouchHelper.DOWN or ItemTouchHelper.LEFT or ItemTouchHelper.RIGHT
      return makeMovementFlags(drag, 0)
    }

    override fun isLongPressDragEnabled(): Boolean = editing

    override fun isItemViewSwipeEnabled(): Boolean = false

    override fun canDropOver(recyclerView: RecyclerView, current: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean =
      isFav(target.bindingAdapterPosition)

    override fun onMove(recyclerView: RecyclerView, viewHolder: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean {
      val from = viewHolder.bindingAdapterPosition
      val to = target.bindingAdapterPosition
      if (!isFav(from) || !isFav(to) || from == to) return false
      val r = rows.removeAt(from)
      rows.add(to, r)
      adapter.notifyItemMoved(from, to)
      dragMoved = true
      return true
    }

    override fun onSwiped(viewHolder: RecyclerView.ViewHolder, direction: Int) {}

    override fun onSelectedChanged(viewHolder: RecyclerView.ViewHolder?, actionState: Int) {
      super.onSelectedChanged(viewHolder, actionState)
      if (actionState == ItemTouchHelper.ACTION_STATE_DRAG && viewHolder != null) {
        dragging = true
        recycler.blocked = true
        val cell = viewHolder.itemView as? APTileView
        cell?.setLifted(true)
        cell?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      }
    }

    override fun clearView(recyclerView: RecyclerView, viewHolder: RecyclerView.ViewHolder) {
      super.clearView(recyclerView, viewHolder)
      (viewHolder.itemView as? APTileView)?.setLifted(false)
      dragging = false
      recycler.blocked = false
      if (dragMoved) {
        dragMoved = false
        val next = ArrayList<String>()
        for (r in rows) if (r.fav && r.appId.isNotEmpty()) next.add(r.appId)
        for (k in pinned) if (!next.contains(k)) next.add(k)
        if (next != pinned) {
          pinned = next
          viewHolder.itemView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
          onPinnedChange(mapOf("ids" to ArrayList(pinned)))
        }
      }
      if (dirtyDuringDrag) {
        dirtyDuringDrag = false
        recycler.post {
          try {
            applyRows()
          } catch (e: Throwable) {
            onNativeError(mapOf("message" to ("apps drag: " + (e.message ?: e.javaClass.simpleName))))
          }
        }
      }
    }
  }

  companion object {
    private const val STRIP_MAX = 8
    private const val T_HEADER = 0
    private const val T_BIA = 1
    private const val T_STRIP = 2
    private const val T_TILE = 3
    private const val T_EMPTY = 4
    private const val T_GAP = 5
    private val PAYLOAD_BIND = Any()
  }
}
