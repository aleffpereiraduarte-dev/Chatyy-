package expo.modules.chatyyconversationlist

// [2026-10-15 native-apps] Grade do MÊS do calendário nativo (Android).
// Canvas próprio (P&B do app): número tabular, hoje = círculo cheio na tinta
// do tema, selecionado = círculo neutro, até 3 pontos coloridos (+N), ponto
// vermelho "ao vivo", faixas finas de eventos de vários dias. Toque = seleciona;
// toque longo = criar no dia; arrastar p/ os lados = troca o mês (segue o dedo;
// solta >50dp ou rápido → próximo/anterior). Acessibilidade: uma célula virtual
// por dia (AccessibilityNodeProvider do framework). Mesmo desenho do iOS
// (ios/CAMonthGridView.swift).

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Bundle
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeProvider
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

@SuppressLint("ViewConstructor")
internal class CAMonthGridView(ctx: Context) : View(ctx) {
  var onSelect: ((String) -> Unit)? = null
  var onLongPress: ((String) -> Unit)? = null
  var onMonthSwipe: ((Int) -> Unit)? = null

  private val density = ctx.resources.displayMetrics.density
  private fun dp(v: Float): Float = v * density

  private var year = 2026
  private var month = 0
  private var firstWeekday = 0
  private var cells: List<CACell> = emptyList()
  private var selected = ""
  private var today = ""
  private var marks: Map<String, CAMark> = emptyMap()
  private var style = CAStyle()
  private var labels = CALabels()
  private var lastMonthIndex = -1

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val num = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textAlign = Paint.Align.CENTER
    textSize = 16f * ctx.resources.displayMetrics.scaledDensity.coerceAtMost(density * 1.3f)
    fontFeatureSettings = "tnum"
    letterSpacing = -0.012f
  }
  private val more = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = 9f * density
    typeface = Typeface.DEFAULT_BOLD
    fontFeatureSettings = "tnum"
  }
  private val regularTf = Typeface.create("sans-serif-medium", Typeface.NORMAL)
  private val boldTf = Typeface.create("sans-serif", Typeface.BOLD)
  private val rect = RectF()
  private val path = Path()

  val weeks: Int get() = max(1, cells.size / 7)

  fun preferredHeightPx(): Int = ceil(dp(PAD_TOP + weeks * ROW_H + PAD_BOTTOM)).toInt()

  /** true quando o número de semanas mudou (altura nova). */
  fun update(y: Int, m: Int, fw: Int, sel: String, td: String, mk: Map<String, CAMark>, st: CAStyle, lb: CALabels): Boolean {
    val oldWeeks = if (cells.isEmpty()) 0 else weeks
    val monthIdx = y * 12 + m
    val monthChanged = monthIdx != lastMonthIndex || fw != firstWeekday || cells.isEmpty()
    year = y; month = m; firstWeekday = fw
    selected = sel; today = td; marks = mk; style = st; labels = lb
    if (monthChanged) {
      cells = CAGrid.cells(y, m, fw)
      if (lastMonthIndex >= 0 && isAttachedToWindow) animateIn(if (monthIdx > lastMonthIndex) 1 else -1)
      lastMonthIndex = monthIdx
    }
    contentDescription = "${labels.month(month)} $year"
    invalidate()
    if (oldWeeks != weeks) requestLayout()
    return oldWeeks != weeks
  }

  private fun animateIn(dir: Int) {
    animate().cancel()
    alpha = 0.2f
    translationX = dir * dp(36f)
    animate().alpha(1f).translationX(0f).setDuration(260)
      .setInterpolator(android.view.animation.DecelerateInterpolator(1.6f)).start()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), preferredHeightPx())
  }

  // ─── Geometria ───────────────────────────────────────────────────────────

  private fun cellW(): Float = (width - dp(PAD_H) * 2) / 7f

  private fun cellRect(i: Int, out: RectF) {
    val w = cellW()
    val col = i % 7
    val row = i / 7
    val l = dp(PAD_H) + col * w
    val t = dp(PAD_TOP) + row * dp(ROW_H)
    out.set(l, t, l + w, t + dp(ROW_H))
  }

  private fun indexAt(x: Float, y: Float): Int {
    val w = cellW()
    if (w <= 0f) return -1
    val col = floor((x - dp(PAD_H)) / w).toInt()
    val row = floor((y - dp(PAD_TOP)) / dp(ROW_H)).toInt()
    if (col < 0 || col > 6 || row < 0) return -1
    val i = row * 7 + col
    return if (i < cells.size) i else -1
  }

  // ─── Desenho ─────────────────────────────────────────────────────────────

  private fun withAlpha(c: Int, a: Float): Int {
    val base = (c ushr 24) and 0xFF
    val na = (base * a).toInt().coerceIn(0, 255)
    return (c and 0x00FFFFFF) or (na shl 24)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val c = style.colors
    val r = RectF()
    for ((i, cell) in cells.withIndex()) {
      cellRect(i, r)
      val isToday = cell.key == today
      val isSel = cell.key == selected
      val other = !cell.current
      val cx = r.centerX()
      val cy = r.top + dp(4f) + dp(16f)
      if (isToday) {
        fill.color = c.text
        canvas.drawCircle(cx, cy, dp(16f), fill)
      } else if (isSel) {
        fill.color = style.selBg
        canvas.drawCircle(cx, cy, dp(16f), fill)
      }
      num.typeface = if (isToday || isSel) boldTf else regularTf
      num.color = when {
        isToday -> c.bg
        other -> withAlpha(c.faint, 0.55f)
        else -> c.text
      }
      val fm = num.fontMetrics
      canvas.drawText(cell.day.toString(), cx, cy - (fm.ascent + fm.descent) / 2f, num)

      val mk = marks[cell.key] ?: continue
      val dotsY = cy + dp(16f) + dp(3f) + dp(5f)
      if (mk.live) {
        fill.color = withAlpha(0xFFDC2626.toInt(), if (other) 0.4f else 1f)
        canvas.drawCircle(cx, dotsY, dp(3f), fill)
      } else if (mk.dots.isNotEmpty() || mk.count > 0) {
        val dots: List<Int> = if (mk.dots.isEmpty()) listOf(c.text) else mk.dots
        val extra = if (mk.count > 3) "+${mk.count - 3}" else null
        more.color = c.faint
        val moreW = if (extra != null) more.measureText(extra) else 0f
        val total = dots.size * dp(5f) + max(0, dots.size - 1) * dp(3f) + (if (extra != null) dp(4f) + moreW else 0f)
        var x = cx - total / 2f
        for (d in dots) {
          fill.color = withAlpha(d, if (other) 0.4f else 1f)
          canvas.drawCircle(x + dp(2.5f), dotsY, dp(2.5f), fill)
          x += dp(8f)
        }
        if (extra != null) {
          val mfm = more.fontMetrics
          canvas.drawText(extra, x - dp(3f) + dp(1f), dotsY - (mfm.ascent + mfm.descent) / 2f, more)
        }
      }
      var sy = r.bottom - dp(2f) - dp(3f)
      for (st in mk.stripes) {
        val x0 = if (st.first) r.left + dp(4f) else r.left
        val x1 = if (st.last) r.right - dp(4f) else r.right
        rect.set(x0, sy, max(x0, x1), sy + dp(3f))
        val rr = dp(1.5f)
        val radii = floatArrayOf(
          if (st.first) rr else 0f, if (st.first) rr else 0f,
          if (st.last) rr else 0f, if (st.last) rr else 0f,
          if (st.last) rr else 0f, if (st.last) rr else 0f,
          if (st.first) rr else 0f, if (st.first) rr else 0f
        )
        path.reset()
        path.addRoundRect(rect, radii, Path.Direction.CW)
        fill.color = withAlpha(st.color, if (other) 0.3f else 0.75f)
        canvas.drawPath(path, fill)
        sy -= dp(5f)
      }
    }
  }

  // ─── Gestos ──────────────────────────────────────────────────────────────

  private val touchSlop = ViewConfiguration.get(ctx).scaledTouchSlop
  private var downX = 0f
  private var downY = 0f
  private var dragging = false
  private var velocity: VelocityTracker? = null

  private val detector = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(e: MotionEvent): Boolean = true

    override fun onSingleTapUp(e: MotionEvent): Boolean {
      if (dragging) return false
      val i = indexAt(e.x, e.y)
      if (i < 0) return false
      performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      onSelect?.invoke(cells[i].key)
      return true
    }

    override fun onLongPress(e: MotionEvent) {
      if (dragging) return
      val i = indexAt(e.x, e.y)
      if (i < 0 || !cells[i].current) return
      performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      onLongPress?.invoke(cells[i].key)
    }
  })

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (velocity == null) velocity = VelocityTracker.obtain()
    velocity?.addMovement(event)
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.x; downY = event.y
        dragging = false
        animate().cancel()
      }
      MotionEvent.ACTION_MOVE -> {
        val dx = event.x - downX
        val dy = event.y - downY
        if (!dragging && abs(dx) > touchSlop && abs(dx) > abs(dy) * 1.8f) {
          dragging = true
          detector.setIsLongpressEnabled(false)
          parent?.requestDisallowInterceptTouchEvent(true)
        }
        if (dragging) translationX = dx * 0.4f
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (dragging) {
          val dx = event.x - downX
          velocity?.computeCurrentVelocity(1000)
          val vx = (velocity?.xVelocity ?: 0f) / density
          val cancel = event.actionMasked == MotionEvent.ACTION_CANCEL
          when {
            !cancel && (dx < -dp(50f) || vx < -600f) -> { swipe(1) }
            !cancel && (dx > dp(50f) || vx > 600f) -> { swipe(-1) }
            else -> springBack()
          }
          parent?.requestDisallowInterceptTouchEvent(false)
        }
        velocity?.recycle()
        velocity = null
        detector.setIsLongpressEnabled(true)
        if (dragging) {
          dragging = false
          // Não deixa o detector gerar toque com o UP do arrasto.
          val cancelEv = MotionEvent.obtain(event)
          cancelEv.action = MotionEvent.ACTION_CANCEL
          detector.onTouchEvent(cancelEv)
          cancelEv.recycle()
          return true
        }
      }
    }
    detector.onTouchEvent(event)
    return true
  }

  private fun swipe(dir: Int) {
    performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    val idx = lastMonthIndex
    onMonthSwipe?.invoke(dir)
    // Se o JS não trocar o mês, a grade volta ao lugar.
    postDelayed({ if (lastMonthIndex == idx && translationX != 0f) springBack() }, 400)
  }

  private fun springBack() {
    animate().translationX(0f).alpha(1f).setDuration(220)
      .setInterpolator(android.view.animation.OvershootInterpolator(1.2f)).start()
  }

  // ─── Acessibilidade (uma célula virtual por dia) ─────────────────────────

  private var hovered = -1

  private fun cellLabel(i: Int): String {
    val cell = cells[i]
    var s = "${cell.day} ${labels.month(cell.month)} ${cell.year}"
    val n = marks[cell.key]?.count ?: 0
    if (n > 0) s += ", $n"
    return s
  }

  private val provider = object : AccessibilityNodeProvider() {
    override fun createAccessibilityNodeInfo(virtualViewId: Int): AccessibilityNodeInfo? {
      if (virtualViewId == View.NO_ID) {
        val info = AccessibilityNodeInfo.obtain(this@CAMonthGridView)
        onInitializeAccessibilityNodeInfo(info)
        for (i in cells.indices) info.addChild(this@CAMonthGridView, i)
        return info
      }
      if (virtualViewId < 0 || virtualViewId >= cells.size) return null
      val info = AccessibilityNodeInfo.obtain(this@CAMonthGridView, virtualViewId)
      info.setParent(this@CAMonthGridView)
      info.packageName = context.packageName
      info.className = "android.widget.Button"
      info.contentDescription = cellLabel(virtualViewId)
      if (labels.hint.isNotEmpty() && android.os.Build.VERSION.SDK_INT >= 26) info.hintText = labels.hint
      info.isClickable = true
      info.isLongClickable = cells[virtualViewId].current
      info.isSelected = cells[virtualViewId].key == selected
      info.isEnabled = true
      info.isVisibleToUser = true
      info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK)
      if (cells[virtualViewId].current) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_LONG_CLICK)
      val rf = RectF()
      cellRect(virtualViewId, rf)
      val rb = Rect(rf.left.toInt(), rf.top.toInt(), rf.right.toInt(), rf.bottom.toInt())
      @Suppress("DEPRECATION")
      info.setBoundsInParent(rb)
      val loc = IntArray(2)
      getLocationOnScreen(loc)
      rb.offset(loc[0], loc[1])
      info.setBoundsInScreen(rb)
      return info
    }

    override fun performAction(virtualViewId: Int, action: Int, arguments: Bundle?): Boolean {
      if (virtualViewId == View.NO_ID) return performAccessibilityAction(action, arguments)
      if (virtualViewId < 0 || virtualViewId >= cells.size) return false
      return when (action) {
        AccessibilityNodeInfo.ACTION_CLICK -> { onSelect?.invoke(cells[virtualViewId].key); true }
        AccessibilityNodeInfo.ACTION_LONG_CLICK -> {
          if (!cells[virtualViewId].current) false else { onLongPress?.invoke(cells[virtualViewId].key); true }
        }
        else -> false
      }
    }
  }

  override fun getAccessibilityNodeProvider(): AccessibilityNodeProvider = provider

  override fun dispatchHoverEvent(event: MotionEvent): Boolean {
    val am = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? android.view.accessibility.AccessibilityManager
    if (am == null || !am.isTouchExplorationEnabled) return super.dispatchHoverEvent(event)
    when (event.actionMasked) {
      MotionEvent.ACTION_HOVER_ENTER, MotionEvent.ACTION_HOVER_MOVE -> {
        val i = indexAt(event.x, event.y)
        if (i != hovered) {
          val prev = hovered
          hovered = i
          if (i >= 0) sendVirtualEvent(i, AccessibilityEvent.TYPE_VIEW_HOVER_ENTER)
          if (prev >= 0) sendVirtualEvent(prev, AccessibilityEvent.TYPE_VIEW_HOVER_EXIT)
        }
        return true
      }
      MotionEvent.ACTION_HOVER_EXIT -> {
        if (hovered >= 0) sendVirtualEvent(hovered, AccessibilityEvent.TYPE_VIEW_HOVER_EXIT)
        hovered = -1
        return true
      }
    }
    return super.dispatchHoverEvent(event)
  }

  private fun sendVirtualEvent(id: Int, type: Int) {
    val p = parent ?: return
    @Suppress("DEPRECATION")
    val ev = AccessibilityEvent.obtain(type)
    ev.packageName = context.packageName
    ev.className = "android.widget.Button"
    ev.setSource(this, id)
    ev.contentDescription = cellLabel(id)
    try { p.requestSendAccessibilityEvent(this, ev) } catch (_: Throwable) {}
  }

  companion object {
    const val ROW_H = 56f
    const val PAD_H = 6f
    const val PAD_TOP = 6f
    const val PAD_BOTTOM = 4f
  }
}
