package expo.modules.chatyyconversationlist

// [2026-10-15 native-pins] Fileira de conversas FIXADAS em nativo (Android).
// Mesmo contrato do iOS (ios/ChatyyPinnedStripView.swift):
//   RecyclerView horizontal + DiffUtil; avatares grandes (mesmo CLAvatarView
//   da lista: foto/colagem, anel de status, online), contador, "digitando",
//   entrada com spring escalonado.
//   Toque longo = levanta (haptic) e já dá para ARRASTAR (ItemTouchHelper: os
//   outros abrem espaço); soltar sem arrastar = MESMO menu da lista (CLMenu).
//   Modo reorganizar (menu → "Reorganizar fixados"): tremem, × desafixa,
//   toque sai do modo.
//
// Props:  items, dark, labels, folders, peek (sem uso no Android), avatarSize,
//         reorderMode, selectionMode, menuEnabled, authToken
// Events: onPinPress, onPinPressIn, onPinAction, onPinLongPress, onPeekRequest,
//         onPeekOpen, onReorder {ids}, onReorderDone, onNativeError

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.OvershootInterpolator
import android.widget.ImageView
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

/** "×" redondo do modo reorganizar (desafixa). */
internal class CLUnpinView(ctx: Context) : View(ctx) {
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
  }
  var dark = false
    set(v) { field = v; invalidate() }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val d = resources.displayMetrics.density
    val r = min(width, height) / 2f
    val cx = width / 2f
    val cy = height / 2f
    fill.color = if (dark) 0x33FFFFFF else 0x1F000000
    canvas.drawCircle(cx, cy, r, fill)
    fill.color = if (dark) 0xFF1C1C1E.toInt() else 0xFFFFFFFF.toInt()
    canvas.drawCircle(cx, cy, r - 1.5f * d, fill)
    line.color = if (dark) 0xFFF5F5F5.toInt() else 0xFF0B0B0B.toInt()
    line.strokeWidth = 2f * d
    val k = r * 0.36f
    canvas.drawLine(cx - k, cy - k, cx + k, cy + k, line)
    canvas.drawLine(cx + k, cy - k, cx - k, cy + k, line)
  }
}

/** Caixa do avatar + enfeites (contador, digitando, brilho, ×, seleção). Escala junto. */
@SuppressLint("ViewConstructor")
internal class CLPinAvatarWrap(ctx: Context) : ViewGroup(ctx) {
  private val d = ctx.resources.displayMetrics.density
  var sizePx = 0
  val avatar = CLAvatarView(ctx)
  val selRing = View(ctx)
  private val selBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
  val badge = TextView(ctx)
  private val badgeBg = GradientDrawable()
  val typing = object : ViewGroup(ctx) {
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      val c = getChildAt(0) ?: return
      val x = (width - c.measuredWidth) / 2
      val y = (height - c.measuredHeight) / 2
      c.layout(x, y, x + c.measuredWidth, y + c.measuredHeight)
    }
  }
  private val typingBg = GradientDrawable()
  val dots = CLTypingDots(ctx)
  val smart = ImageView(ctx)
  private val smartBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
  val unpin = CLUnpinView(ctx)

  init {
    clipChildren = false
    clipToPadding = false
    selRing.background = selBg
    selRing.visibility = GONE
    addView(selRing)
    addView(avatar)
    smart.background = smartBg
    smart.scaleType = ImageView.ScaleType.CENTER
    smart.visibility = GONE
    addView(smart)
    typing.background = typingBg
    typing.addView(dots)
    typing.visibility = GONE
    addView(typing)
    badge.background = badgeBg
    badge.gravity = Gravity.CENTER
    badge.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 12f)
    badge.typeface = CLType.weight(700)
    badge.includeFontPadding = false
    badge.setPadding((7 * d).toInt(), 0, (7 * d).toInt(), 0)
    badge.visibility = GONE
    addView(badge)
    unpin.visibility = GONE
    addView(unpin)
  }

  fun style(t: CLTheme, muted: Boolean) {
    val border = (2 * d).toInt()
    badgeBg.cornerRadius = 11 * d
    badgeBg.setColor(if (muted) t.mutedPillBg else t.pillBg)
    badgeBg.setStroke(border, t.bg)
    badge.setTextColor(if (muted) t.mutedPillTxt else t.pillTxt)
    typingBg.cornerRadius = 10 * d
    typingBg.setColor(t.card)
    typingBg.setStroke(border, t.bg)
    dots.color = t.text
    smartBg.setColor(t.pillBg)
    smartBg.setStroke(border, t.bg)
    smart.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_sparkles, t.pillTxt))
    selBg.setColor(0)
    selBg.setStroke((2.5f * d).toInt(), t.text)
    unpin.dark = t.dark
  }

  private fun exact(v: Int) = MeasureSpec.makeMeasureSpec(max(0, v), MeasureSpec.EXACTLY)

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val s = sizePx
    avatar.measure(exact(s), exact(s))
    selRing.measure(exact(s + (8 * d).toInt()), exact(s + (8 * d).toInt()))
    badge.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), exact((22 * d).toInt()))
    typing.measure(exact((34 * d).toInt()), exact((20 * d).toInt()))
    dots.measure(exact((18 * d).toInt()), exact((8 * d).toInt()))
    smart.measure(exact((22 * d).toInt()), exact((22 * d).toInt()))
    unpin.measure(exact((24 * d).toInt()), exact((24 * d).toInt()))
    setMeasuredDimension(s, s)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val s = sizePx
    avatar.layout(0, 0, s, s)
    val o = (4 * d).toInt()
    selRing.layout(-o, -o, s + o, s + o)
    val bh = (22 * d).toInt()
    val bw = max(bh, badge.measuredWidth)
    val bx = s - bw + (6 * d).toInt()
    badge.layout(bx, -o, bx + bw, -o + bh)
    val tw = typing.measuredWidth
    val th = typing.measuredHeight
    typing.layout(-(6 * d).toInt(), -o, -(6 * d).toInt() + tw, -o + th)
    val sb = smart.measuredWidth
    smart.layout(-(2 * d).toInt(), s - sb + (2 * d).toInt(), -(2 * d).toInt() + sb, s + (2 * d).toInt())
    val ub = unpin.measuredWidth
    unpin.layout(-(6 * d).toInt(), -(6 * d).toInt(), -(6 * d).toInt() + ub, -(6 * d).toInt() + ub)
  }
}

@SuppressLint("ViewConstructor")
internal class CLPinCellView(ctx: Context) : ViewGroup(ctx) {
  private val d = ctx.resources.displayMetrics.density
  val wrap = CLPinAvatarWrap(ctx)
  val name = TextView(ctx)
  var rowId = ""
    private set
  private var lastUnread = 0
  private var wasTyping = false
  private var lifted = false
  private var wiggle: ObjectAnimator? = null
  var onUnpin: ((String) -> Unit)? = null

  init {
    clipChildren = false
    clipToPadding = false
    addView(wrap)
    name.gravity = Gravity.CENTER_HORIZONTAL
    name.maxLines = 1
    name.ellipsize = TextUtils.TruncateAt.END
    name.includeFontPadding = false
    // Fonte do sistema com teto (1.2×), como o maxFontSizeMultiplier do JS.
    name.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 12f * min(max(resources.configuration.fontScale, 0.85f), 1.2f))
    addView(name)
    wrap.unpin.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      onUnpin?.invoke(rowId)
    }
    isClickable = true
    isFocusable = true
  }

  fun bind(r: CLRow, t: CLTheme, l: CLLabels, sizeDp: Float, reorder: Boolean) {
    val same = r.id == rowId
    rowId = r.id
    val sizePx = (sizeDp * d).toInt()
    if (wrap.sizePx != sizePx) { wrap.sizePx = sizePx; requestLayout() }
    wrap.avatar.setBoxDp(sizeDp)
    wrap.avatar.bind(r.copy(note = ""), t, t.bg)
    wrap.style(t, r.muted)

    val count = r.unread
    if (count > 0 || r.mention) {
      wrap.badge.visibility = VISIBLE
      wrap.badge.text = if (count > 0) (if (count > 99) "99+" else count.toString()) else "@"
      if (same && count > lastUnread && isAttachedToWindow) pop(wrap.badge)
    } else {
      wrap.badge.visibility = GONE
    }
    lastUnread = count

    val typing = r.typing.isNotEmpty() && !r.locked
    wrap.dots.setActive(typing)
    if (typing) {
      if (wrap.typing.visibility != VISIBLE || !(same && wasTyping)) {
        wrap.typing.visibility = VISIBLE
        if (isAttachedToWindow) {
          wrap.typing.scaleX = 0.3f; wrap.typing.scaleY = 0.3f; wrap.typing.alpha = 0f
          wrap.typing.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(380)
            .setInterpolator(OvershootInterpolator(2f)).start()
        }
      }
    } else {
      wrap.typing.animate().cancel()
      wrap.typing.visibility = GONE
      wrap.typing.scaleX = 1f; wrap.typing.scaleY = 1f; wrap.typing.alpha = 1f
    }
    wasTyping = typing

    wrap.smart.visibility = if (r.smart) VISIBLE else GONE
    wrap.selRing.visibility = if (r.selected) VISIBLE else GONE
    wrap.unpin.visibility = if (reorder) VISIBLE else GONE
    wrap.unpin.contentDescription = l.get("unpin", "Desafixar")

    name.text = r.title
    name.setTextColor(t.text)
    name.typeface = CLType.weight(if (count > 0 && !r.muted) 600 else 500)
    contentDescription = r.a11y.ifEmpty { r.title }
    setWiggle(reorder)
  }

  private fun pop(v: View) {
    v.animate().cancel()
    v.scaleX = 0.8f; v.scaleY = 0.8f
    v.animate().scaleX(1f).scaleY(1f).setDuration(320).setInterpolator(OvershootInterpolator(3f)).start()
  }

  override fun setPressed(pressed: Boolean) {
    val was = isPressed
    super.setPressed(pressed)
    if (was == pressed || lifted) return
    wrap.animate().cancel()
    val s = if (pressed) 0.92f else 1f
    wrap.animate().scaleX(s).scaleY(s).setDuration(if (pressed) 120 else 320)
      .setInterpolator(if (pressed) null else OvershootInterpolator(2.5f)).start()
  }

  fun setLifted(on: Boolean) {
    if (lifted == on) return
    lifted = on
    wrap.animate().cancel()
    val s = if (on) 1.12f else 1f
    wrap.animate().scaleX(s).scaleY(s).setDuration(260).setInterpolator(OvershootInterpolator(2f)).start()
  }

  fun setWiggle(on: Boolean) {
    if (on) {
      if (wiggle != null) return
      val amp = 1.8f + (Math.random() * 0.6).toFloat()
      val a = ObjectAnimator.ofFloat(this, "rotation", -amp, amp)
      a.duration = 130L + (Math.random() * 30).toLong()
      a.repeatCount = ValueAnimator.INFINITE
      a.repeatMode = ValueAnimator.REVERSE
      a.startDelay = (Math.random() * 120).toLong()
      wiggle = a
      a.start()
    } else {
      wiggle?.cancel()
      wiggle = null
      rotation = 0f
    }
  }

  fun playEntrance(delayMs: Long) {
    wrap.scaleX = 0.6f; wrap.scaleY = 0.6f; wrap.alpha = 0f; wrap.translationY = 10 * d
    name.alpha = 0f
    wrap.animate().scaleX(1f).scaleY(1f).alpha(1f).translationY(0f).setStartDelay(delayMs).setDuration(520)
      .setInterpolator(OvershootInterpolator(1.6f)).start()
    name.animate().alpha(1f).setStartDelay(delayMs + 80).setDuration(300).start()
  }

  override fun onDetachedFromWindow() {
    wiggle?.cancel()
    wiggle = null
    rotation = 0f
    super.onDetachedFromWindow()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (wrap.unpin.visibility == VISIBLE) setWiggle(true)
  }

  private fun exact(v: Int) = MeasureSpec.makeMeasureSpec(max(0, v), MeasureSpec.EXACTLY)

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = MeasureSpec.getSize(heightMeasureSpec)
    wrap.measure(exact(wrap.sizePx), exact(wrap.sizePx))
    name.measure(exact(max(0, w - (6 * d).toInt())), MeasureSpec.makeMeasureSpec((18 * d).toInt(), MeasureSpec.AT_MOST))
    setMeasuredDimension(w, h)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val s = wrap.sizePx
    val top = (TOP_PAD * d).toInt()
    val x = (w - s) / 2
    wrap.layout(x, top, x + s, top + s)
    val ny = top + s + (6 * d).toInt()
    name.layout((3 * d).toInt(), ny, (3 * d).toInt() + name.measuredWidth, ny + name.measuredHeight)
  }

  companion object {
    const val TOP_PAD = 8f
  }
}

@SuppressLint("ViewConstructor")
class ChatyyPinnedStripView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onPinPress by EventDispatcher()
  val onPinPressIn by EventDispatcher()
  val onPinAction by EventDispatcher()
  val onPinLongPress by EventDispatcher()
  val onPeekRequest by EventDispatcher()
  val onPeekOpen by EventDispatcher()
  val onReorder by EventDispatcher()
  val onReorderDone by EventDispatcher()
  val onNativeError by EventDispatcher()

  private val density = context.resources.displayMetrics.density

  private var ids: MutableList<String> = ArrayList()
  private val rows = HashMap<String, CLRow>()
  private var pendingItems: List<Any?>? = null
  private var theme = CLTheme(false)
  private var themeDirty = true
  private var labels = CLLabels()
  private var folders: List<CLFolder> = emptyList()
  private var avatarSizeDp = 72f
  private var sizeDirty = false
  private var reorderMode = false
  private var selectionMode = false
  private var modeDirty = false
  var menuEnabled = true
  private var dragging = false
  private var movedDuringDrag = false
  private var dragDx = 0f
  private val entered = HashSet<String>()
  private val stableIds = HashMap<String, Long>()
  private var nextStable = 1L

  private val recycler = RecyclerView(context)
  private val layoutManager = LinearLayoutManager(context, LinearLayoutManager.HORIZONTAL, false)
  private val adapter = Adapter()
  private val touchHelper = ItemTouchHelper(DragCallback())

  // ─── Props ───────────────────────────────────────────────────────────────

  fun setItemsProp(list: List<Any?>?) { pendingItems = list ?: emptyList() }

  fun setDark(dark: Boolean) {
    if (dark == theme.dark && !themeDirty) return
    theme = CLTheme(dark)
    themeDirty = true
  }

  fun setLabelsProp(m: Map<String, Any?>?) { labels = CLLabels(m) }

  fun setFoldersProp(list: List<Any?>?) {
    folders = (list ?: emptyList()).mapNotNull { CLVal.map(it)?.let { m -> CLFolder.from(m) } }
      .filter { it.id.isNotEmpty() && it.name.isNotEmpty() }
  }

  fun setAvatarSize(v: Double) {
    val s = v.toFloat().coerceIn(40f, 96f)
    if (abs(s - avatarSizeDp) < 0.5f) return
    avatarSizeDp = s
    sizeDirty = true
  }

  fun setReorderModeProp(on: Boolean) {
    if (on == reorderMode) return
    reorderMode = on
    modeDirty = true
  }

  fun setSelectionModeProp(on: Boolean) {
    if (on == selectionMode) return
    selectionMode = on
    modeDirty = true
  }

  fun setAuthToken(t: String?) { if (!t.isNullOrEmpty()) CLAuth.token = t }

  fun commitProps() {
    try {
      applyItems()
      if (themeDirty || sizeDirty || modeDirty) {
        val wasMode = modeDirty
        themeDirty = false
        sizeDirty = false
        modeDirty = false
        if (wasMode && reorderMode) recycler.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        adapter.notifyItemRangeChanged(0, ids.size, PAYLOAD_BIND)
        if (wasMode) recycler.requestLayout()
      }
    } catch (e: Throwable) {
      onNativeError(mapOf("message" to ("pins: " + (e.message ?: e.javaClass.simpleName))))
    }
  }

  // ─── Dados ───────────────────────────────────────────────────────────────

  private fun stableId(id: String): Long = stableIds.getOrPut(id) { nextStable++ }

  private fun applyItems() {
    val list = pendingItems ?: return
    if (dragging) return // a ordem é nossa até soltar
    pendingItems = null
    val nextRows = HashMap<String, CLRow>()
    val nextIds = ArrayList<String>()
    for (it in list) {
      val m = CLVal.map(it) ?: continue
      val r = CLRow.from(m)
      if (r.id.isEmpty() || nextRows.containsKey(r.id)) continue
      nextRows[r.id] = r
      nextIds.add(r.id)
    }
    val old = ArrayList(ids)
    val changed = HashSet<String>()
    for (id in nextIds) if (rows[id] != nextRows[id]) changed.add(id)
    rows.clear()
    rows.putAll(nextRows)
    entered.retainAll(nextIds.toSet())
    val columnsChanged = (old.size <= 4) != (nextIds.size <= 4)
    if (old.isEmpty() || columnsChanged) {
      ids = nextIds
      adapter.notifyDataSetChanged()
      return
    }
    val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
      override fun getOldListSize() = old.size
      override fun getNewListSize() = nextIds.size
      override fun areItemsTheSame(o: Int, n: Int): Boolean = old[o] == nextIds[n]
      override fun areContentsTheSame(o: Int, n: Int): Boolean = !changed.contains(nextIds[n])
      override fun getChangePayload(o: Int, n: Int): Any = PAYLOAD_BIND
    }, true)
    ids = nextIds
    diff.dispatchUpdatesTo(adapter)
  }

  // ─── Adapter ─────────────────────────────────────────────────────────────

  private class Holder(val cell: CLPinCellView) : RecyclerView.ViewHolder(cell)

  private fun cellWidthPx(): Int {
    val w = if (recycler.width > 0) recycler.width else width
    val n = ids.size
    return if (n <= 4) {
      max(((avatarSizeDp + 8) * density).toInt(), (w - (2 * sideInsetDp() * density).toInt()) / 4)
    } else {
      ((avatarSizeDp + 22) * density).toInt()
    }
  }

  private fun sideInsetDp(): Float = if (ids.size <= 4) 8f else 10f

  private inner class Adapter : RecyclerView.Adapter<Holder>() {
    override fun getItemCount(): Int = ids.size
    override fun getItemId(position: Int): Long = stableId(ids[position])

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
      val cell = CLPinCellView(parent.context)
      cell.layoutParams = RecyclerView.LayoutParams(cellWidthPx(), ViewGroup.LayoutParams.MATCH_PARENT)
      val h = Holder(cell)
      cell.setOnClickListener {
        val pos = h.bindingAdapterPosition
        if (pos == RecyclerView.NO_POSITION || pos >= ids.size) return@setOnClickListener
        if (reorderMode) {
          cell.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
          onReorderDone(mapOf("id" to ids[pos]))
          return@setOnClickListener
        }
        onPinPress(mapOf("id" to ids[pos]))
      }
      @Suppress("ClickableViewAccessibility")
      cell.setOnTouchListener { _, ev ->
        if (ev.actionMasked == MotionEvent.ACTION_DOWN && !selectionMode && !reorderMode) {
          val pos = h.bindingAdapterPosition
          if (pos != RecyclerView.NO_POSITION && pos < ids.size) onPinPressIn(mapOf("id" to ids[pos]))
        }
        false
      }
      return h
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
      bind(holder, position)
    }

    override fun onBindViewHolder(holder: Holder, position: Int, payloads: MutableList<Any>) {
      bind(holder, position)
    }

    private fun bind(holder: Holder, position: Int) {
      if (position >= ids.size) return
      val id = ids[position]
      val row = rows[id] ?: return
      val lp = holder.cell.layoutParams
      val w = cellWidthPx()
      if (lp == null || lp.width != w) {
        holder.cell.layoutParams = RecyclerView.LayoutParams(w, ViewGroup.LayoutParams.MATCH_PARENT)
      }
      val reorder = reorderMode && !selectionMode
      holder.cell.bind(row, theme, labels, avatarSizeDp, reorder)
      holder.cell.onUnpin = { rid -> onPinAction(mapOf("id" to rid, "action" to "pin", "source" to "reorder")) }
      if (selectionMode) {
        holder.cell.setOnLongClickListener {
          val p = holder.bindingAdapterPosition
          if (p != RecyclerView.NO_POSITION && p < ids.size) onPinLongPress(mapOf("id" to ids[p]))
          true
        }
      } else {
        holder.cell.setOnLongClickListener(null)
        holder.cell.isLongClickable = false
      }
    }

    override fun onViewAttachedToWindow(holder: Holder) {
      val pos = holder.bindingAdapterPosition
      if (pos == RecyclerView.NO_POSITION || pos >= ids.size) return
      val id = ids[pos]
      if (entered.add(id)) holder.cell.playEntrance(min(320L, 50L * pos))
    }
  }

  // ─── Toque longo: arrastar (ou menu ao soltar sem arrastar) ──────────────

  private inner class DragCallback : ItemTouchHelper.Callback() {
    override fun getMovementFlags(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int {
      if (selectionMode || ids.size < 1) return 0
      return makeMovementFlags(ItemTouchHelper.LEFT or ItemTouchHelper.RIGHT, 0)
    }

    override fun isLongPressDragEnabled(): Boolean = !selectionMode
    override fun isItemViewSwipeEnabled(): Boolean = false

    override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean {
      val from = vh.bindingAdapterPosition
      val to = target.bindingAdapterPosition
      if (from == RecyclerView.NO_POSITION || to == RecyclerView.NO_POSITION || from >= ids.size || to >= ids.size) return false
      if (from == to) return false
      val id = ids.removeAt(from)
      ids.add(to, id)
      adapter.notifyItemMoved(from, to)
      movedDuringDrag = true
      vh.itemView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      return true
    }

    override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {}

    override fun onSelectedChanged(vh: RecyclerView.ViewHolder?, actionState: Int) {
      super.onSelectedChanged(vh, actionState)
      if (actionState == ItemTouchHelper.ACTION_STATE_DRAG && vh != null) {
        dragging = true
        movedDuringDrag = false
        dragDx = 0f
        (vh.itemView as? CLPinCellView)?.setLifted(true)
        vh.itemView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      }
    }

    override fun onChildDraw(c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder, dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      if (isCurrentlyActive) dragDx = max(dragDx, abs(dX))
      // Só desliza no eixo da fileira.
      super.onChildDraw(c, rv, vh, dX, 0f, actionState, isCurrentlyActive)
    }

    override fun clearView(rv: RecyclerView, vh: RecyclerView.ViewHolder) {
      super.clearView(rv, vh)
      val cell = vh.itemView as? CLPinCellView
      cell?.setLifted(false)
      dragging = false
      val moved = movedDuringDrag || dragDx > 12 * density
      movedDuringDrag = false
      if (moved) {
        onReorder(mapOf("ids" to ArrayList(ids)))
      } else if (!reorderMode && menuEnabled && !selectionMode && cell != null) {
        // Soltou sem arrastar = menu (o mesmo da lista + "Reorganizar fixados").
        val id = cell.rowId
        val row = rows[id]
        if (row != null) {
          val extra = if (row.pinned && ids.size > 1) listOf(CLMenu.Extra("reorder", labels.get("reorderPinned", "Reorganizar fixados"))) else emptyList()
          val shown = CLMenu.show(context, cell, id, row, labels, folders, extra) { body -> onPinAction(body) }
          if (!shown) onPinLongPress(mapOf("id" to id))
        }
      }
      recycler.post {
        try { applyItems() } catch (_: Throwable) {}
      }
    }
  }

  init {
    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.clipToPadding = false
    recycler.clipChildren = false
    clipChildren = false
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.isHorizontalScrollBarEnabled = false
    recycler.itemAnimator = DefaultItemAnimator().apply {
      supportsChangeAnimations = false
      moveDuration = 260
      addDuration = 0 // a entrada é a nossa (spring) em onViewAttachedToWindow
      removeDuration = 160
    }
    recycler.addItemDecoration(object : RecyclerView.ItemDecoration() {
      override fun getItemOffsets(outRect: android.graphics.Rect, view: View, parent: RecyclerView, state: RecyclerView.State) {
        val pos = parent.getChildAdapterPosition(view)
        val inset = (sideInsetDp() * density).toInt()
        outRect.left = if (pos == 0) inset else 0
        outRect.right = if (pos == ids.size - 1) inset else 0
      }
    })
    addView(recycler, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.MATCH_PARENT))
    touchHelper.attachToRecyclerView(recycler)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w != oldw) post { adapter.notifyItemRangeChanged(0, ids.size, PAYLOAD_BIND) }
  }

  companion object {
    private val PAYLOAD_BIND = Any()
  }
}
