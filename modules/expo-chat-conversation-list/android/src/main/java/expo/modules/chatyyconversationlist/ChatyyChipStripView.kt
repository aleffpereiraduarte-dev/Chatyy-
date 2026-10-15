package expo.modules.chatyyconversationlist

// [2026-10-15 native-group-create] Fileira de membros SELECIONADOS do Novo
// grupo (estilo WhatsApp) — Android. RecyclerView horizontal + DiffUtil.
// Chip = avatar (mesmo CLAvatarView da lista) + bolinha "x" + primeiro nome.
// Entrada com mola (Overshoot), saída encolhendo (DefaultItemAnimator), rola
// até o novo. Toque = haptic + onChipPress {id}; o JS tira da seleção.
// Mesmo contrato do iOS (ios/ChatyyChipStripView.swift).

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.TextView
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

internal data class CTChip(val id: String, val title: String, val tiles: List<CLTile>)

/** Bolinha cinza com "x" (desenhada; sem drawable novo). */
internal class CTChipBadge(ctx: Context) : View(ctx) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  var fill = Color.parseColor("#8E8E93")
  var ring = Color.WHITE
  var mark = Color.WHITE

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    val c = w / 2f
    val d = resources.displayMetrics.density
    paint.style = Paint.Style.FILL
    paint.color = ring
    canvas.drawCircle(c, c, c, paint)
    paint.color = fill
    canvas.drawCircle(c, c, c - 2f * d, paint)
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 1.8f * d
    paint.strokeCap = Paint.Cap.ROUND
    paint.color = mark
    val k = 3.2f * d
    canvas.drawLine(c - k, c - k, c + k, c + k, paint)
    canvas.drawLine(c + k, c - k, c - k, c + k, paint)
  }
}

@SuppressLint("ViewConstructor")
internal class CTChipCellView(ctx: Context) : FrameLayout(ctx) {
  val inner = FrameLayout(ctx)
  private val avatar = CLAvatarView(ctx)
  private val badge = CTChipBadge(ctx)
  private val name = TextView(ctx)
  var chipId = ""
    private set

  private fun px(v: Float): Int = Math.round(v * resources.displayMetrics.density)

  init {
    clipChildren = false
    inner.clipChildren = false
    addView(inner, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    avatar.setBoxDp(52f)
    inner.addView(avatar, LayoutParams(px(52f), px(52f), Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = px(6f) })
    inner.addView(badge, LayoutParams(px(22f), px(22f), Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply {
      topMargin = px(6f + 52f - 20f)
      leftMargin = px(19f) // centrado + 19 dp = canto inferior direito do avatar
    })
    name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    name.maxLines = 1
    name.ellipsize = TextUtils.TruncateAt.END
    name.gravity = Gravity.CENTER_HORIZONTAL
    name.includeFontPadding = false
    inner.addView(name, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.TOP).apply {
      topMargin = px(6f + 52f + 4f)
      leftMargin = px(2f)
      rightMargin = px(2f)
    })
    isClickable = true
    isFocusable = true
  }

  fun bind(c: CTChip, theme: CLTheme, bg: Int, text: Int, badgeBg: Int, badgeFg: Int, removeLabel: String) {
    chipId = c.id
    avatar.bind(CLRow(id = c.id, kind = "direct", title = c.title, tiles = c.tiles), theme, bg)
    badge.fill = badgeBg
    badge.ring = bg
    badge.mark = badgeFg
    badge.invalidate()
    name.setTextColor(text)
    name.text = firstName(c.title)
    contentDescription = if (removeLabel.isEmpty()) c.title else "$removeLabel ${c.title}"
  }

  fun playEntrance() {
    inner.animate().cancel()
    inner.scaleX = 0.3f
    inner.scaleY = 0.3f
    inner.alpha = 0f
    inner.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(360)
      .setInterpolator(OvershootInterpolator(1.8f)).start()
  }

  fun resetAnim() {
    inner.animate().cancel()
    inner.scaleX = 1f
    inner.scaleY = 1f
    inner.alpha = 1f
  }

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    inner.animate().scaleX(if (pressed) 0.92f else 1f).scaleY(if (pressed) 0.92f else 1f).setDuration(110).start()
  }

  companion object {
    fun firstName(s: String): String {
      val t = s.trim()
      if (t.isEmpty()) return ""
      val local = if (t.contains("@")) t.substringBefore("@") else t
      return local.split(" ").firstOrNull { it.isNotEmpty() } ?: local
    }
  }
}

class ChatyyChipStripView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onChipPress by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val density = context.resources.displayMetrics.density
  private var chips: List<CTChip> = emptyList()
  private var pendingItems: List<Any?>? = null
  private var dark = false
  private var theme = CLTheme(false)
  private var colorsMap: Map<String, Any?>? = null
  private var bg = Color.WHITE
  private var text = Color.parseColor("#111111")
  private var badgeBg = Color.parseColor("#8E8E93")
  private var badgeFg = Color.WHITE
  private var removeLabel = ""
  private var styleDirty = true
  private var appliedOnce = false
  private val justAdded = HashSet<String>()
  private val stableIds = HashMap<String, Long>()
  private var nextStable = 1L

  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context, LinearLayoutManager.HORIZONTAL, false)
  private val adapter = Adapter()

  fun setItemsProp(list: List<Any?>?) { pendingItems = list ?: emptyList() }

  fun setColorsProp(m: Map<String, Any?>?) {
    colorsMap = m
    styleDirty = true
  }

  fun setDark(v: Boolean) {
    if (v == dark && appliedOnce) return
    dark = v
    styleDirty = true
  }

  fun commitProps() {
    try {
      var rebindAll = false
      if (styleDirty) {
        styleDirty = false
        theme = CLTheme(dark)
        val m = colorsMap
        bg = CTColor.of(m?.get("bg")) ?: if (dark) Color.BLACK else Color.WHITE
        text = CTColor.of(m?.get("text")) ?: if (dark) Color.parseColor("#F5F5F7") else Color.parseColor("#111111")
        badgeBg = CTColor.of(m?.get("badgeBg")) ?: if (dark) Color.parseColor("#48484A") else Color.parseColor("#8E8E93")
        badgeFg = CTColor.of(m?.get("badgeFg")) ?: Color.WHITE
        removeLabel = CLVal.str(m?.get("removeLabel"))
        setBackgroundColor(bg)
        rebindAll = appliedOnce
      }
      applyItems()
      if (rebindAll) adapter.notifyItemRangeChanged(0, chips.size, PAYLOAD_BIND)
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("chips: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  private fun stableId(id: String): Long = stableIds.getOrPut(id) { nextStable++ }

  private fun applyItems() {
    val list = pendingItems ?: return
    pendingItems = null
    val next = ArrayList<CTChip>()
    val seen = HashSet<String>()
    for (it in list) {
      val m = CLVal.map(it) ?: continue
      val id = CLVal.str(m["id"])
      if (id.isEmpty() || !seen.add(id)) continue
      val tiles = ArrayList<CLTile>()
      CLVal.list(m["tiles"])?.forEach { t -> CLVal.map(t)?.let { tiles.add(CLTile.from(it)) } }
      next.add(CTChip(id, CLVal.str(m["t"]), tiles))
    }
    val old = chips
    val oldIds = old.map { it.id }.toHashSet()
    val added = next.filter { !oldIds.contains(it.id) }.map { it.id }
    val animate = appliedOnce && isAttachedToWindow
    appliedOnce = true
    if (animate) justAdded.addAll(added)
    if (old.isEmpty()) {
      chips = next
      adapter.notifyDataSetChanged()
    } else {
      val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
        override fun getOldListSize() = old.size
        override fun getNewListSize() = next.size
        override fun areItemsTheSame(o: Int, n: Int): Boolean = old[o].id == next[n].id
        override fun areContentsTheSame(o: Int, n: Int): Boolean = old[o] == next[n]
        override fun getChangePayload(o: Int, n: Int): Any = PAYLOAD_BIND
      }, true)
      chips = next
      diff.dispatchUpdatesTo(adapter)
    }
    if (animate && added.isNotEmpty() && added.last() == next.lastOrNull()?.id) {
      recycler.post { try { recycler.smoothScrollToPosition(chips.size - 1) } catch (_: Throwable) {} }
    }
  }

  private class Holder(val cell: CTChipCellView) : RecyclerView.ViewHolder(cell)

  private inner class Adapter : RecyclerView.Adapter<Holder>() {
    override fun getItemCount(): Int = chips.size
    override fun getItemId(position: Int): Long = stableId(chips[position].id)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
      val cell = CTChipCellView(parent.context)
      cell.layoutParams = RecyclerView.LayoutParams((66 * density).toInt(), ViewGroup.LayoutParams.MATCH_PARENT)
      val h = Holder(cell)
      cell.setOnClickListener {
        val pos = h.bindingAdapterPosition
        if (pos == RecyclerView.NO_POSITION || pos >= chips.size) return@setOnClickListener
        cell.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        onChipPress(mapOf("id" to chips[pos].id))
      }
      return h
    }

    override fun onBindViewHolder(holder: Holder, position: Int) = bind(holder, position)

    override fun onBindViewHolder(holder: Holder, position: Int, payloads: MutableList<Any>) = bind(holder, position)

    private fun bind(holder: Holder, position: Int) {
      if (position >= chips.size) return
      holder.cell.bind(chips[position], theme, bg, text, badgeBg, badgeFg, removeLabel)
    }

    override fun onViewAttachedToWindow(holder: Holder) {
      val pos = holder.bindingAdapterPosition
      if (pos == RecyclerView.NO_POSITION || pos >= chips.size) return
      if (justAdded.remove(chips[pos].id)) holder.cell.playEntrance()
    }

    override fun onViewRecycled(holder: Holder) {
      holder.cell.resetAnim()
    }
  }

  init {
    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.clipChildren = false
    recycler.setPadding((10 * density).toInt(), 0, (10 * density).toInt(), 0)
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.isHorizontalScrollBarEnabled = false
    recycler.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 220
      addDuration = 0 // entrada = a nossa (mola) em onViewAttachedToWindow
      removeDuration = 160
    }
    addView(recycler, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
  }

  companion object {
    private val PAYLOAD_BIND = Any()
  }
}
