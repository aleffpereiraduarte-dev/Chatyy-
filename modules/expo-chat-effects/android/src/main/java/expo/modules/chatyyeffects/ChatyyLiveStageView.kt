package expo.modules.chatyyeffects

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.LruCache
import android.util.TypedValue
import android.view.Choreographer
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/**
 * [2026-10-15 native-live] Palco do espectador (Android). Ver ChatyyLiveStageModule.
 *
 * Ordem dos filhos: [peekPrev, peekNext, ...filhos RN..., botão mudo].
 * Corações/presentes são DESENHADOS no dispatchDraw depois dos filhos (nenhuma
 * View nativa cobre os tiles RN → TouchTargetHelper do RN continua achando-os).
 */
@SuppressLint("ViewConstructor")
class ChatyyLiveStageView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), Choreographer.FrameCallback {

  internal val onSwipe by EventDispatcher()
  internal val onStageTap by EventDispatcher()
  internal val onMuteToggle by EventDispatcher()

  private val dens = resources.displayMetrics.density
  private fun dp(v: Float) = v * dens

  // ── props
  var swipeEnabled = true
  var tapHearts = true
  private var heartColors = intArrayOf(0xFFFF4D6D.toInt(), 0xFFFF7EB9.toInt(), 0xFFFF006E.toInt(), 0xFFC70039.toInt(), 0xFFEF4444.toInt())
  private var muted = false
  private var controlsTopDp = 100f
  private var labelMute = "Mute"
  private var labelUnmute = "Unmute"
  private var hasNext = false
  private var hasPrev = false

  // ── filhos
  private val rnChildren = ArrayList<View>()
  private val peekPrev = LSPeekView(context)
  private val peekNext = LSPeekView(context)
  private val muteBtn = LSMuteButton(context)

  // ── partículas
  private val hearts = ArrayList<LSHeart>()
  private val bursts = ArrayList<LSBurstHeart>()
  private val giftQueue = ArrayDeque<LSGift>()
  private var gift: LSGift? = null
  private var ticking = false

  // ── gesto
  private val slop = ViewConfiguration.get(context).scaledTouchSlop
  private var downX = 0f
  private var downY = 0f
  private var downAt = 0L
  private var dragging = false
  private var moved = false
  private var committed = false
  private var offset = 0f
  private var vt: VelocityTracker? = null
  private var offsetAnim: ValueAnimator? = null
  private var lastTapAt = 0L

  init {
    setWillNotDraw(false)
    clipChildren = true
    peekPrev.visibility = View.INVISIBLE
    peekNext.visibility = View.INVISIBLE
    super.addView(peekPrev, 0)
    super.addView(peekNext, 1)
    muteBtn.visibility = View.GONE
    muteBtn.setOnClickListener {
      val next = !muted
      muted = next
      muteBtn.setMuted(next)
      updateMuteA11y()
      onMuteToggle(mapOf("muted" to next))
    }
    super.addView(muteBtn)
    updateMuteA11y()
  }

  // ───────────────────────── filhos RN (GroupView) ─────────────────────────
  private val nativeBase = 2

  internal fun rnChildCount(): Int = rnChildren.size
  internal fun rnChildAt(index: Int): View? = rnChildren.getOrNull(index)

  internal fun addRnChild(child: View, index: Int) {
    val i = index.coerceIn(0, rnChildren.size)
    rnChildren.add(i, child)
    super.addView(child, nativeBase + i)
    child.translationY = offset
    if (indexOfChild(muteBtn) != childCount - 1) muteBtn.bringToFront()
  }

  internal fun removeRnChildAt(index: Int) {
    val c = rnChildren.getOrNull(index) ?: return
    rnChildren.removeAt(index)
    super.removeView(c)
  }

  internal fun removeRnChild(child: View) {
    rnChildren.remove(child)
    super.removeView(child)
  }

  // ───────────────────────── layout (só nativos) ─────────────────────────
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(w, h)
    measureNative(w, h)
  }

  private fun measureNative(w: Int, h: Int) {
    val ew = MeasureSpec.makeMeasureSpec(max(0, w), MeasureSpec.EXACTLY)
    val eh = MeasureSpec.makeMeasureSpec(max(0, h), MeasureSpec.EXACTLY)
    peekPrev.measure(ew, eh)
    peekNext.measure(ew, eh)
    val b = MeasureSpec.makeMeasureSpec(dp(40f).toInt(), MeasureSpec.EXACTLY)
    muteBtn.measure(b, b)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    // Filhos RN: posicionados pelo Fabric.
    layoutNative(r - l, b - t)
  }

  private fun layoutNative(w: Int, h: Int) {
    peekPrev.layout(0, 0, w, h)
    peekNext.layout(0, 0, w, h)
    val x = dp(12f).toInt()
    val y = dp(controlsTopDp).toInt()
    val s = dp(40f).toInt()
    muteBtn.layout(x, y, x + s, y + s)
    applyOffset(offset)
  }

  /** Fabric não chama layout em filhos nativos — refaz à mão quando muda. */
  private fun relayoutNative() {
    if (width <= 0 || height <= 0) return
    measureNative(width, height)
    layoutNative(width, height)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    post { relayoutNative() }
  }

  // ───────────────────────── props ─────────────────────────
  fun setPeek(next: Boolean, v: Map<String, Any?>?) {
    val pv = if (next) peekNext else peekPrev
    if (next) hasNext = v != null else hasPrev = v != null
    if (v == null) { pv.clear(); applyOffset(offset); return }
    val title = (v["title"] as? String) ?: ""
    pv.bind(
      title,
      (v["subtitle"] as? String) ?: "",
      (v["imageUrl"] as? String)?.takeIf { it.isNotBlank() },
      ((v["initials"] as? String)?.takeIf { it.isNotBlank() } ?: initialsOf(title)),
    ) { relayoutNative() }
    relayoutNative()
  }

  fun setHeartColors(v: List<String>?) {
    val parsed = v?.mapNotNull { parseColor(it) }.orEmpty()
    if (parsed.isNotEmpty()) heartColors = parsed.toIntArray()
  }

  fun setMutedProp(v: Boolean) {
    muted = v
    muteBtn.setMuted(v)
    updateMuteA11y()
  }

  fun setShowMute(v: Boolean) {
    muteBtn.visibility = if (v) View.VISIBLE else View.GONE
  }

  fun setControlsTop(v: Double) {
    controlsTopDp = v.toFloat()
    relayoutNative()
  }

  fun setLabels(v: Map<String, Any?>?) {
    (v?.get("mute") as? String)?.takeIf { it.isNotEmpty() }?.let { labelMute = it }
    (v?.get("unmute") as? String)?.takeIf { it.isNotEmpty() }?.let { labelUnmute = it }
    updateMuteA11y()
  }

  private fun updateMuteA11y() {
    muteBtn.contentDescription = if (muted) labelUnmute else labelMute
  }

  // ───────────────────────── partículas (API JS) ─────────────────────────
  private fun animationsOff(): Boolean = try {
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
  } catch (_: Throwable) { false }

  private fun num(v: Any?): Float? {
    val d = (v as? Number)?.toFloat() ?: return null
    return if (d.isNaN() || d.isInfinite()) null else d
  }

  private fun randomColor(): Int = heartColors[Random.nextInt(heartColors.size)]

  fun spawnHearts(items: List<Map<String, Any?>>) {
    for (it in items.take(40)) {
      val x = num(it["x"])?.let { v -> dp(v) }
      val y = num(it["y"])?.let { v -> dp(v) }
      val color = (it["color"] as? String)?.let { c -> parseColor(c) }
      val emoji = (it["emoji"] as? String)?.takeIf { e -> e.isNotEmpty() }?.take(16)
      addHeart(x, y, color, emoji)
    }
  }

  fun burstFromJs(opts: Map<String, Any?>?) {
    val x = num(opts?.get("x"))?.let { dp(it) }
    val y = num(opts?.get("y"))?.let { dp(it) }
    addBurst(x, y)
  }

  fun playGift(opts: Map<String, Any?>) {
    if (animationsOff()) return
    val kind = ((opts["kind"] as? String) ?: "heart").lowercase()
    val known = kind in setOf("rose", "heart", "star", "crown", "fire", "rocket")
    val k = if (known) kind else "heart"
    val color = (opts["color"] as? String)?.let { parseColor(it) } ?: LSGift.catalogColor(k)
    val count = (num(opts["count"]) ?: 1f).toInt().coerceAtLeast(1)
    val g = LSGift(k, ((opts["title"] as? String) ?: "").take(60), ((opts["subtitle"] as? String) ?: "").take(80), count, color)
    if (gift == null) gift = g
    else if (giftQueue.size < 10) giftQueue.addLast(g)
    startTicking()
  }

  private fun addHeart(xPx: Float?, yPx: Float?, color: Int?, emoji: String?) {
    if (animationsOff() || width <= 0 || height <= 0) return
    val W = width.toFloat(); val H = height.toFloat()
    val x = xPx ?: (W - dp(56f) + rnd(-dp(12f), dp(12f)))
    val y = yPx ?: (H * 0.62f + rnd(-dp(15f), dp(15f)))
    val size = if (emoji != null) dp(30f) else dp(rnd(14f, 22f))
    val h = LSHeart(
      x, y, color ?: randomColor(), emoji, size,
      drift = rnd(-dp(55f), dp(55f)), phase = rnd(0f, PI.toFloat()),
      rise = dp(rnd(220f, 360f)), tilt = rnd(-12f, 12f),
      dur = rnd(1600f, 2600f), start = SystemClock.uptimeMillis(),
    )
    hearts.add(h)
    while (hearts.size > 40) hearts.removeAt(0)
    startTicking()
  }

  private fun addBurst(xPx: Float?, yPx: Float?) {
    if (animationsOff() || width <= 0 || height <= 0) return
    val cx = xPx ?: width / 2f
    val cy = yPx ?: height * 0.45f
    val now = SystemClock.uptimeMillis()
    for (i in 0 until 8) {
      val ang = (2 * PI * i / 8).toFloat() + rnd(0f, 0.3f)
      val d = dp(rnd(90f, 150f))
      bursts.add(LSBurstHeart(cx, cy, cos(ang) * d, sin(ang) * d, randomColor(), dp(rnd(18f, 26f)), now))
    }
    while (bursts.size > 40) bursts.removeAt(0)
    startTicking()
  }

  private fun startTicking() {
    if (!ticking && isAttachedToWindow) {
      ticking = true
      Choreographer.getInstance().postFrameCallback(this)
    }
    invalidate()
  }

  override fun doFrame(frameTimeNanos: Long) {
    if (!isAttachedToWindow || (hearts.isEmpty() && bursts.isEmpty() && gift == null)) {
      ticking = false
      invalidate()
      return
    }
    invalidate()
    Choreographer.getInstance().postFrameCallback(this)
  }

  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    if (hearts.isEmpty() && bursts.isEmpty() && gift == null) return
    val now = SystemClock.uptimeMillis()
    try {
      val hi = hearts.iterator()
      while (hi.hasNext()) if (!hi.next().draw(canvas, now)) hi.remove()
      val bi = bursts.iterator()
      while (bi.hasNext()) if (!bi.next().draw(canvas, now)) bi.remove()
      val g = gift
      if (g != null && !g.draw(canvas, now, width.toFloat(), height.toFloat(), dens)) {
        gift = giftQueue.removeFirstOrNull()
      }
    } catch (_: Throwable) {
      hearts.clear(); bursts.clear(); gift = null; giftQueue.clear()
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (hearts.isNotEmpty() || bursts.isNotEmpty() || gift != null) startTicking()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    if (ticking) Choreographer.getInstance().removeFrameCallback(this)
    ticking = false
    offsetAnim?.cancel()
    offsetAnim = null
    vt?.recycle(); vt = null
  }

  // ───────────────────────── swipe / toques ─────────────────────────
  private fun track(ev: MotionEvent) {
    if (ev.actionMasked == MotionEvent.ACTION_DOWN) {
      vt?.recycle()
      vt = VelocityTracker.obtain()
    }
    vt?.addMovement(ev)
  }

  private fun onDown(ev: MotionEvent) {
    downX = ev.x; downY = ev.y
    downAt = SystemClock.uptimeMillis()
    dragging = false
    moved = false
  }

  /** true = começou o arraste agora. */
  private fun maybeStartDrag(ev: MotionEvent): Boolean {
    if (dragging || committed || !swipeEnabled) return false
    val dx = ev.x - downX
    val dy = ev.y - downY
    if (abs(dx) > slop || abs(dy) > slop) moved = true
    if (abs(dy) <= slop || abs(dy) <= 2 * abs(dx)) return false
    val hasTarget = if (dy < 0) hasNext else hasPrev
    if (!hasTarget) return false
    dragging = true
    offsetAnim?.cancel()
    downY = ev.y - offset // continua de onde está (se pegou no meio da mola)
    notifyNativeGesture(ev)
    parent?.requestDisallowInterceptTouchEvent(true)
    return true
  }

  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
    if (committed) return true
    track(ev)
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> { onDown(ev); return false }
      MotionEvent.ACTION_MOVE -> return maybeStartDrag(ev)
    }
    return dragging
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    if (committed) return true
    if (!tapHearts && !swipeEnabled) return false
    track(ev)
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> { onDown(ev); return true }
      MotionEvent.ACTION_MOVE -> {
        if (!dragging) maybeStartDrag(ev)
        if (dragging) applyOffset(elastic(ev.y - downY))
        return true
      }
      MotionEvent.ACTION_UP -> {
        if (dragging) {
          dragging = false
          vt?.computeCurrentVelocity(1000)
          val vy = (vt?.yVelocity ?: 0f) / dens
          release(vy)
        } else if (!moved && SystemClock.uptimeMillis() - downAt < 500) {
          onTap(ev.x, ev.y)
        }
        vt?.recycle(); vt = null
        return true
      }
      MotionEvent.ACTION_CANCEL -> {
        if (dragging) { dragging = false; animateOffset(0f, 300, OvershootInterpolator(0.8f), null) }
        vt?.recycle(); vt = null
        return true
      }
    }
    return true
  }

  private fun elastic(dy: Float): Float {
    val noTarget = (dy < 0 && !hasNext) || (dy > 0 && !hasPrev)
    return if (noTarget) dy * 0.2f else dy
  }

  private fun release(vyDp: Float) {
    val H = height.toFloat()
    val off = offset
    if (hasNext && (off < -0.18f * H || (vyDp < -800f && off < 0))) commit("next")
    else if (hasPrev && (off > 0.18f * H || (vyDp > 800f && off > 0))) commit("prev")
    else animateOffset(0f, 320, OvershootInterpolator(0.8f), null)
  }

  private fun commit(direction: String) {
    committed = true
    val target = if (direction == "next") -height.toFloat() else height.toFloat()
    animateOffset(target, 220, DecelerateInterpolator(1.6f)) {
      onSwipe(mapOf("direction" to direction))
    }
  }

  fun resetSwipe() {
    committed = false
    dragging = false
    animateOffset(0f, 260, DecelerateInterpolator(1.6f), null)
  }

  private fun animateOffset(to: Float, dur: Long, interp: android.animation.TimeInterpolator, end: (() -> Unit)?) {
    offsetAnim?.cancel()
    val a = ValueAnimator.ofFloat(offset, to)
    a.duration = dur
    a.interpolator = interp
    a.addUpdateListener { applyOffset(it.animatedValue as Float) }
    a.addListener(object : AnimatorListenerAdapter() {
      private var cancelled = false
      override fun onAnimationCancel(animation: Animator) { cancelled = true }
      override fun onAnimationEnd(animation: Animator) {
        if (offsetAnim === a) offsetAnim = null
        if (!cancelled) end?.invoke()
      }
    })
    offsetAnim = a
    a.start()
  }

  private fun applyOffset(v: Float) {
    offset = v
    for (c in rnChildren) c.translationY = v
    val H = height.toFloat()
    peekNext.translationY = H + v
    peekPrev.translationY = -H + v
    peekNext.visibility = if (hasNext && v < -0.5f) View.VISIBLE else View.INVISIBLE
    peekPrev.visibility = if (hasPrev && v > 0.5f) View.VISIBLE else View.INVISIBLE
  }

  private fun onTap(x: Float, y: Float) {
    if (!tapHearts) return
    val now = SystemClock.uptimeMillis()
    val double = now - lastTapAt < 280
    lastTapAt = if (double) 0L else now
    val color = randomColor()
    if (double) {
      addBurst(x, y)
      try { performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY) } catch (_: Throwable) {}
    }
    addHeart(x, y, color, null)
    onStageTap(mapOf("x" to (x / dens).toDouble(), "y" to (y / dens).toDouble(), "color" to colorHex(color), "double" to double))
  }

  private fun notifyNativeGesture(ev: MotionEvent) {
    try {
      val cls = Class.forName("com.facebook.react.uimanager.events.NativeGestureUtil")
      val m = cls.getMethod("notifyNativeGestureStarted", View::class.java, MotionEvent::class.java)
      val target: Any? = if (java.lang.reflect.Modifier.isStatic(m.modifiers)) null else cls.getField("INSTANCE").get(null)
      m.invoke(target, this, ev)
    } catch (_: Throwable) {}
  }

  companion object {
    fun parseColor(s: String): Int? {
      var h = s.trim().removePrefix("#")
      if (h.length == 3) h = h.map { "$it$it" }.joinToString("")
      if (h.length == 8) h = h.substring(6, 8) + h.substring(0, 6) // CSS RRGGBBAA → AARRGGBB
      if (h.length != 6 && h.length != 8) return null
      return try { Color.parseColor("#$h") } catch (_: Throwable) { null }
    }

    fun colorHex(c: Int): String = String.format("#%06x", c and 0xFFFFFF)

    fun initialsOf(name: String): String {
      val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
      if (parts.isEmpty()) return "?"
      val a = parts[0].first().uppercaseChar()
      val b = if (parts.size > 1) parts[parts.size - 1].first().uppercaseChar().toString() else ""
      return "$a$b"
    }
  }
}

/** Prévia da live vizinha (pôster esmaecido + avatar + nome + dica). */
@SuppressLint("ViewConstructor")
internal class LSPeekView(ctx: Context) : FrameLayout(ctx) {
  private val image = ImageView(ctx)
  private val avatar = TextView(ctx)
  private val title = TextView(ctx)
  private val subtitle = TextView(ctx)
  private var url: String? = null
  private val dens = ctx.resources.displayMetrics.density

  init {
    setBackgroundColor(0xFF0F0F1A.toInt())
    isClickable = false
    image.scaleType = ImageView.ScaleType.CENTER_CROP
    image.alpha = 0.45f
    addView(image, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    val col = LinearLayout(ctx)
    col.orientation = LinearLayout.VERTICAL
    col.gravity = Gravity.CENTER_HORIZONTAL
    val s = (84 * dens).toInt()
    avatar.gravity = Gravity.CENTER
    avatar.setTextColor(Color.WHITE)
    avatar.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
    avatar.typeface = Typeface.DEFAULT_BOLD
    avatar.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFF2A2A3A.toInt()) }
    col.addView(avatar, LinearLayout.LayoutParams(s, s))
    title.setTextColor(Color.WHITE)
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
    title.typeface = Typeface.DEFAULT_BOLD
    title.maxLines = 1
    title.ellipsize = android.text.TextUtils.TruncateAt.END
    title.gravity = Gravity.CENTER
    col.addView(title, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
      topMargin = (12 * dens).toInt(); gravity = Gravity.CENTER_HORIZONTAL
    })
    subtitle.setTextColor(0xB3FFFFFF.toInt())
    subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    subtitle.gravity = Gravity.CENTER
    col.addView(subtitle, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
      topMargin = (4 * dens).toInt(); gravity = Gravity.CENTER_HORIZONTAL
    })
    addView(col, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply {
      leftMargin = (24 * dens).toInt(); rightMargin = (24 * dens).toInt()
    })
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
  }

  fun clear() {
    url = null
    image.setImageDrawable(null)
    title.text = ""; subtitle.text = ""; avatar.text = ""
  }

  fun bind(t: String, sub: String, imageUrl: String?, initials: String, onImage: () -> Unit) {
    title.text = t
    subtitle.text = sub
    subtitle.visibility = if (sub.isEmpty()) View.GONE else View.VISIBLE
    avatar.text = initials.take(2)
    if (imageUrl == url) return
    url = imageUrl
    image.setImageDrawable(null)
    if (imageUrl == null) return
    LSImages.load(imageUrl) { bmp ->
      if (url == imageUrl && bmp != null) { image.setImageBitmap(bmp); onImage() }
    }
  }
}

/** Download simples (sem libs novas) + cache em memória. Callback na main. */
internal object LSImages {
  private val cache = LruCache<String, Bitmap>(6)
  private val io = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())

  fun load(url: String, cb: (Bitmap?) -> Unit) {
    cache.get(url)?.let { cb(it); return }
    if (!url.startsWith("http")) { cb(null); return }
    io.execute {
      var bmp: Bitmap? = null
      try {
        val bytes = fetch(url)
        if (bytes != null) {
          val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
          BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
          var sample = 1
          while (o.outWidth / (sample * 2) >= 540 && o.outHeight / (sample * 2) >= 540) sample *= 2
          bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        }
      } catch (_: Throwable) { bmp = null }
      if (bmp != null) cache.put(url, bmp)
      main.post { cb(bmp) }
    }
  }

  private fun fetch(url: String): ByteArray? {
    val c = URL(url).openConnection() as HttpURLConnection
    return try {
      c.connectTimeout = 6000
      c.readTimeout = 8000
      c.instanceFollowRedirects = true
      if (c.responseCode !in 200..299) return null
      if (c.contentLength > 8 * 1024 * 1024) return null
      c.inputStream.use { it.readBytes() }
    } finally {
      c.disconnect()
    }
  }
}

/** Botão mudo: círculo preto 35% + alto-falante (com ondas ou cortado) em Path. */
internal class LSMuteButton(ctx: Context) : View(ctx) {
  private var mutedState = false
  private val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x59000000 }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeWidth = 1.8f
  }
  private val body = Path().apply {
    moveTo(3f, 9f); lineTo(7f, 9f); lineTo(12f, 4.5f); lineTo(12f, 19.5f); lineTo(7f, 15f); lineTo(3f, 15f); close()
  }
  private val arc = RectF()

  init {
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  fun setMuted(v: Boolean) {
    if (v == mutedState) return
    mutedState = v
    invalidate()
  }

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    animate().scaleX(if (pressed) 0.9f else 1f).scaleY(if (pressed) 0.9f else 1f).setDuration(90).start()
  }

  override fun onDraw(c: Canvas) {
    super.onDraw(c)
    val w = width.toFloat(); val h = height.toFloat()
    c.drawCircle(w / 2, h / 2, min(w, h) / 2, bg)
    val icon = 20f * resources.displayMetrics.density
    c.save()
    c.translate((w - icon) / 2, (h - icon) / 2)
    c.scale(icon / 24f, icon / 24f)
    c.drawPath(body, fill)
    if (mutedState) {
      c.drawLine(16f, 9.5f, 21f, 14.5f, stroke)
      c.drawLine(21f, 9.5f, 16f, 14.5f, stroke)
    } else {
      arc.set(12f - 4f, 12f - 4f, 12f + 4f, 12f + 4f)
      c.drawArc(arc, -50f, 100f, false, stroke)
      arc.set(12f - 7.5f, 12f - 7.5f, 12f + 7.5f, 12f + 7.5f)
      c.drawArc(arc, -50f, 100f, false, stroke)
    }
    c.restore()
  }
}
