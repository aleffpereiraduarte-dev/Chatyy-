package expo.modules.chatyyconversationlist

// [2026-10-15 settings-native] Raiz das Configurações em NATIVO (Android):
// RecyclerView + DiffUtil, cartões arredondados por seção (STRowView),
// cabeçalhos em caixa alta, puxar p/ atualizar. O hero/cartões especiais
// (JS) são o filho RN 0 e moram no item 0. Busca: prop `query` filtra as
// linhas de resultado ("q") aqui. Mesmo contrato do iOS
// (ios/ChatyySettingsListView.swift).

import android.annotation.SuppressLint
import android.content.Context
import android.text.SpannableString
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.Locale
import kotlin.math.max

@SuppressLint("ViewConstructor")
class ChatyySettingsListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onToggle by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val density = context.resources.displayMetrics.density
  private fun px(v: Float): Int = (v * density + 0.5f).toInt()

  private val rows = HashMap<String, STRow>()
  private var order: List<String> = emptyList()
  private var seq = 0.0
  private var resyncAskedFor = -1.0
  private var needsApply = false
  private var firstPaintSent = false

  private var query = ""
  private var dark = false
  private var colorsRaw: Map<String, Any?>? = null
  private var palette = STPalette.defaults(false)
  private var paletteDirty = true
  private var labels = CLLabels()
  private var maxContentWidthDp = 0f
  private var hInsetPx = 0
  private var bottomInsetPx = 0
  private var headerHintPx = 0
  // [2026-10-18 settings-sub-native] rolar até uma linha (âncora da busca).
  private var pendingScrollId = ""
  private var lastScrollToken = ""

  private val rnChildren = ArrayList<View>()
  private val headerHost = CLChildHost(context) { headerHintPx }

  private val refresher = SwipeRefreshLayout(context)
  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()

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
          val r = STRow.from(m)
          if (r.id.isEmpty()) continue
          if (!rows.containsKey(r.id)) ids.add(r.id)
          rows[r.id] = r
        }
        order = CLVal.list(p["order"])?.map { CLVal.str(it) } ?: ids
        seq = pseq
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
        val r = STRow.from(m)
        if (r.id.isEmpty()) return@forEach
        if (!rows.containsKey(r.id) && !hasOrder) appended.add(r.id)
        rows[r.id] = r
      }
      val ord = CLVal.list(p["order"])
      order = if (ord != null) ord.map { CLVal.str(it) } else order + appended
      seq = pseq
      needsApply = true
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("patch: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  fun setQuery(q: String?) {
    val n = STText.normalize(q ?: "")
    if (n == query) return
    query = n
    needsApply = true
  }

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

  fun setHeaderHeightHint(v: Double) {
    headerHintPx = (max(0.0, v) * density).toInt()
    headerHost.requestLayout()
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

  /** "id|token": rola até a linha `id` uma vez por token. */
  fun setScrollToId(v: String?) {
    val s = v ?: ""
    if (s.isEmpty() || s == lastScrollToken) return
    lastScrollToken = s
    val cut = s.lastIndexOf('|')
    pendingScrollId = if (cut >= 0) s.substring(0, cut) else s
    if (firstPaintSent) recycler.post { performPendingScroll() }
  }

  private fun performPendingScroll() {
    val id = pendingScrollId
    if (id.isEmpty()) return
    val pos = items.indexOfFirst { it is Item.Row && it.row.id == id }
    if (pos < 0) return
    pendingScrollId = ""
    try { layoutManager.scrollToPositionWithOffset(pos, max(0, height / 3)) } catch (_: Throwable) {}
  }

  fun setRefreshing(v: Boolean) {
    if (!v && refresher.isRefreshing) refresher.isRefreshing = false
  }

  fun commitProps() {
    var rebindAll = false
    if (paletteDirty) {
      paletteDirty = false
      palette = STPalette.from(dark, colorsRaw)
      setBackgroundColor(palette.pageBg)
      recycler.setBackgroundColor(palette.pageBg)
      refresher.setColorSchemeColors(palette.text)
      refresher.setProgressBackgroundColorSchemeColor(palette.cardBg)
      rebindAll = true
    }
    applyData(rebindAll)
  }

  // ─── Dados → itens ───────────────────────────────────────────────────────

  private sealed class Item {
    object Header : Item()
    data class Section(val key: String, val title: String) : Item()
    data class Row(val row: STRow, val first: Boolean, val last: Boolean, val inset: Int, val gapBelow: Boolean = last) : Item()
    data class Footer(val key: String, val text: String, val inset: Int) : Item()
    data class Empty(val text: String) : Item()
  }

  private var items: List<Item> = listOf(Item.Header)
  private val stableIds = HashMap<String, Long>()
  private var nextStable = 10L
  private fun stableId(key: String): Long = stableIds.getOrPut(key) { nextStable++ }

  private fun applyData(rebindAll: Boolean) {
    if (!needsApply && !rebindAll && firstPaintSent) return
    needsApply = false
    try {
      val seen = HashSet<String>()
      val ids = ArrayList<String>(order.size)
      for (id in order) if (rows.containsKey(id) && seen.add(id)) ids.add(id)
      if (ids.size < rows.size) for (id in rows.keys.sorted()) if (seen.add(id)) ids.add(id)
      order = ids

      val next = ArrayList<Item>(ids.size + 10)
      next.add(Item.Header)
      fun addCard(key: String, header: String, list: List<STRow>, footer: String = "") {
        if (list.isEmpty()) return
        if (header.isNotEmpty()) next.add(Item.Section(key, header))
        list.forEachIndexed { i, r ->
          val last = i == list.size - 1
          next.add(Item.Row(r, i == 0, last, hInsetPx, last && footer.isEmpty()))
        }
        if (footer.isNotEmpty()) next.add(Item.Footer(key, footer, hInsetPx))
      }
      if (query.isEmpty()) {
        var curSid: String? = null
        var curHeader = ""
        var curFooter = ""
        val bucket = ArrayList<STRow>()
        var n = 0
        for (id in ids) {
          val r = rows[id] ?: continue
          if (r.kind == "q") continue
          if (curSid == null || curSid != r.sid) {
            addCard("$n|${curSid ?: ""}", curHeader, ArrayList(bucket), curFooter)
            n++
            bucket.clear()
            curSid = r.sid
            curHeader = r.header
            curFooter = ""
          }
          if (curFooter.isEmpty() && r.footer.isNotEmpty()) curFooter = r.footer
          bucket.add(r)
        }
        addCard("$n|${curSid ?: ""}", curHeader, ArrayList(bucket), curFooter)
      } else {
        val hits = ids.mapNotNull { rows[it] }.filter { it.kind == "q" && it.hay.contains(query) }
        if (hits.isEmpty()) next.add(Item.Empty(labels.get("noResults", "Nenhum resultado")))
        else addCard("results", "${labels.get("results", "Resultados")} (${hits.size})", hits)
      }

      val old = items
      val forceRebind = rebindAll
      val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
        override fun getOldListSize() = old.size
        override fun getNewListSize() = next.size
        override fun areItemsTheSame(o: Int, nn: Int): Boolean {
          val a = old[o]
          val b = next[nn]
          return when {
            a is Item.Row && b is Item.Row -> a.row.id == b.row.id
            a is Item.Section && b is Item.Section -> a.key == b.key
            a is Item.Footer && b is Item.Footer -> a.key == b.key
            a is Item.Empty && b is Item.Empty -> true
            else -> a === b
          }
        }
        override fun areContentsTheSame(o: Int, nn: Int): Boolean {
          val b = next[nn]
          if (b is Item.Header) return true
          return !forceRebind && old[o] == b
        }
        override fun getChangePayload(o: Int, nn: Int): Any = PAYLOAD_BIND
      }, false)
      val atTop = !recycler.canScrollVertically(-1)
      items = next
      diff.dispatchUpdatesTo(adapter)
      if (atTop) recycler.scrollToPosition(0)
      if (!firstPaintSent) {
        firstPaintSent = true
        recycler.post { onFirstPaint(mapOf("count" to ids.size)) }
      }
      if (pendingScrollId.isNotEmpty()) recycler.post { performPendingScroll() }
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

  // ─── Filho RN (hero) ─────────────────────────────────────────────────────

  fun addRnChild(child: View, index: Int) {
    val i = index.coerceIn(0, rnChildren.size)
    rnChildren.add(i, child)
    headerHost.attach(child)
    headerHost.requestLayout()
  }

  fun rnChildCount(): Int = rnChildren.size

  fun rnChildAt(index: Int): View? = rnChildren.getOrNull(index)

  fun removeRnChild(child: View) {
    headerHost.detach(child)
    rnChildren.remove(child)
    headerHost.requestLayout()
  }

  fun removeRnChildAt(index: Int) {
    val c = rnChildren.getOrNull(index) ?: return
    removeRnChild(c)
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class HostHolder(v: View) : RecyclerView.ViewHolder(v)
  private class SectionHolder(val tv: TextView) : RecyclerView.ViewHolder(tv)
  private class EmptyHolder(val tv: TextView) : RecyclerView.ViewHolder(tv)
  private class FooterHolder(val tv: TextView) : RecyclerView.ViewHolder(tv)
  private class RowHolder(val rowView: STRowView) : RecyclerView.ViewHolder(rowView)

  private val rowListener = object : STRowView.Listener {
    override fun onPress(id: String) { onRowPress(mapOf("id" to id)) }
    override fun onToggle(id: String, value: Boolean) {
      rows[id]?.let { rows[id] = it.copy(on = value) }
      this@ChatyySettingsListView.onToggle(mapOf("id" to id, "value" to value))
    }
  }

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (items[position]) {
      is Item.Header -> TYPE_HEADER
      is Item.Section -> TYPE_SECTION
      is Item.Row -> TYPE_ROW
      is Item.Empty -> TYPE_EMPTY
      is Item.Footer -> TYPE_FOOTER
    }

    override fun getItemId(position: Int): Long = when (val it = items[position]) {
      is Item.Header -> 1L
      is Item.Empty -> 2L
      is Item.Section -> stableId("s:" + it.key)
      is Item.Row -> stableId("r:" + it.row.id)
      is Item.Footer -> stableId("f:" + it.key)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      when (viewType) {
        TYPE_HEADER -> {
          (headerHost.parent as? ViewGroup)?.removeView(headerHost)
          headerHost.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
          val h = HostHolder(headerHost)
          h.setIsRecyclable(false)
          return h
        }
        TYPE_SECTION -> {
          val tv = TextView(parent.context)
          // [2026-10-17 wa-cells] cabeçalho de seção 13 (WhatsApp)
          tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
          tv.typeface = CLType.weight(500)
          tv.letterSpacing = 0.3f / 13f
          tv.maxLines = 1
          tv.ellipsize = TextUtils.TruncateAt.END
          tv.includeFontPadding = false
          tv.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
          return SectionHolder(tv)
        }
        TYPE_FOOTER -> {
          val tv = TextView(parent.context)
          tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
          tv.typeface = CLType.weight(400)
          tv.includeFontPadding = false
          tv.setLineSpacing(px(2f).toFloat(), 1f)
          tv.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
          return FooterHolder(tv)
        }
        TYPE_EMPTY -> {
          val tv = TextView(parent.context)
          tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
          tv.gravity = Gravity.CENTER
          tv.setPadding(px(16f), px(32f), px(16f), px(32f))
          tv.compoundDrawablePadding = px(10f)
          tv.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
          return EmptyHolder(tv)
        }
        else -> {
          val v = STRowView(parent.context)
          v.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
          v.listener = rowListener
          return RowHolder(v)
        }
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) { bind(holder, position) }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) { bind(holder, position) }

    private fun bind(holder: RecyclerView.ViewHolder, position: Int) {
      try {
        when (val it = items.getOrNull(position)) {
          is Item.Section -> {
            val sh = holder as? SectionHolder ?: return
            sh.tv.text = SpannableString(it.title.uppercase(Locale.getDefault()))
            sh.tv.setTextColor(palette.header)
            sh.tv.setPadding(hInsetPx + px(18f), 0, hInsetPx + px(18f), px(8f))
            sh.tv.contentDescription = it.title
          }
          is Item.Row -> {
            val rh = holder as? RowHolder ?: return
            val lp = rh.rowView.layoutParams as? RecyclerView.LayoutParams
            if (lp != null) {
              lp.leftMargin = it.inset
              lp.rightMargin = it.inset
              lp.bottomMargin = if (it.gapBelow) px(24f) else 0
              rh.rowView.layoutParams = lp
            }
            rh.rowView.bind(it.row, palette, it.first, it.last)
          }
          is Item.Footer -> {
            val fh = holder as? FooterHolder ?: return
            fh.tv.text = it.text
            fh.tv.setTextColor(palette.header)
            fh.tv.setPadding(it.inset + px(18f), px(8f), it.inset + px(18f), px(24f))
            fh.tv.contentDescription = it.text
          }
          is Item.Empty -> {
            val eh = holder as? EmptyHolder ?: return
            eh.tv.text = it.text
            eh.tv.setTextColor(palette.secondary)
            val icon = tintedIcon(context, R.drawable.cst_ic_search, palette.tertiary)
            icon?.setBounds(0, 0, px(28f), px(28f))
            eh.tv.setCompoundDrawables(null, icon, null, null)
          }
          else -> {}
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
    recycler.isVerticalScrollBarEnabled = false
    recycler.itemAnimator = null
    refresher.addView(recycler, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    refresher.setOnRefreshListener { onRefresh(mapOf<String, Any>()) }
    addView(refresher, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    hInsetPx = px(16f)
    setBackgroundColor(palette.pageBg)
  }

  companion object {
    private const val TYPE_HEADER = 0
    private const val TYPE_ROW = 1
    private const val TYPE_SECTION = 2
    private const val TYPE_EMPTY = 3
    private const val TYPE_FOOTER = 4
    private val PAYLOAD_BIND = Any()
  }
}
