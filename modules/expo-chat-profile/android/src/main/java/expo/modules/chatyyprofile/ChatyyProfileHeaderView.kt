package expo.modules.chatyyprofile

// [2026-10-15 native-profile] Cabeçalho do perfil estilo Telegram (Android).
//
// Container: o ÚNICO filho RN é o ScrollView da folha (paddingTop =
// expandedHeight). Os filhos RN ficam ANTES do overlay nativo (que é sempre o
// último filho); o GroupView do módulo expõe só os filhos RN ao Fabric, então
// os índices do RN nunca enxergam o overlay. O nativo NÃO muda a geometria do
// ScrollView (measure do Fabric continua batendo) — exceção: durante o puxão
// interceptado (toques JS já cancelados) ele é transladado e volta a 0.
//
//   rolar p/ cima → avatar encolhe e vai p/ a barra ao lado do título; ações
//   somem; parou no meio → assenta (smoothScrollTo) após 140 ms ocioso.
//   puxar p/ baixo no topo → rubber band (avatar cresce); soltou além de 80dp
//   com fotos → galeria em tela cheia (PFGallery).

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** Overlay com layout manual: o onLayout delega ao cabeçalho. */
@SuppressLint("ViewConstructor")
internal class PFHeaderOverlay(context: Context, private val owner: ChatyyProfileHeaderView) : ViewGroup(context) {
  private var posted = false
  /** Só a faixa visível do cabeçalho recebe toques; o resto vai p/ o ScrollView RN. */
  var visibleHeight = Int.MAX_VALUE

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) { owner.layoutHeader() }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
  }

  override fun requestLayout() {
    super.requestLayout()
    // O RN não refaz o layout de views nativas: refaz aqui (1x por frame).
    if (posted) return
    posted = true
    post {
      posted = false
      if (width > 0 && height > 0) {
        pfExactly(width, height)
        layout(left, top, right, bottom)
      }
    }
  }

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    if (ev.actionMasked == MotionEvent.ACTION_DOWN && ev.y > visibleHeight) return false
    return super.dispatchTouchEvent(ev)
  }
}

@SuppressLint("ViewConstructor")
class ChatyyProfileHeaderView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  internal val onClose by EventDispatcher()
  internal val onAction by EventDispatcher()
  internal val onAvatarPress by EventDispatcher()
  internal val onGallery by EventDispatcher()

  private val density = resources.displayMetrics.density
  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()
  private fun dpf(v: Float): Float = v * density

  // ── Filhos RN (ordem do Fabric) ──
  private val rnChildren = ArrayList<View>()

  // ── Overlay nativo ──
  private val overlay = PFHeaderOverlay(context, this)
  private val bg = View(context)
  private val hairline = View(context)
  private val closeButton = ImageView(context)
  private val avatarBox = FrameLayout(context)
  private val avatar = PFAvatar(context)
  private val badge = FrameLayout(context)
  private val badgeIcon = ImageView(context)
  private val badgeSpinner = ProgressBar(context, null, android.R.attr.progressBarStyleSmall)
  private val titleView = TextView(context)
  private val subtitleView = TextView(context)
  private val actionsRow = LinearLayout(context)

  // ── Props ──
  private var theme = PFTheme(null)
  private var title = ""
  private var subtitle = ""
  private var avatarImage: PFImage? = null
  private var initials = ""
  private var avatarColor = 0xFF8E8E93.toInt()
  private var photos: List<PFImage> = emptyList()
  private var actions: List<Map<String, Any?>> = emptyList()
  private var actionsKey = ""
  private var expandedHeightDp = 264.0
  private var compactHeightDp = 56.0
  private var topInsetDp = 0.0
  private var avatarBadge = ""
  private var avatarBusy = false
  private var labels: Map<String, String> = emptyMap()
  private var closeStyle = "close"

  // ── Estado de rolagem / puxão ──
  private var scrollView: ScrollView? = null
  private var scrollY = 0
  private var stretch = 0f
  private var pulling = false
  private var touching = false
  private var downX = 0f
  private var downY = 0f
  private val slop = ViewConfiguration.get(context).scaledTouchSlop
  private var stretchAnim: ValueAnimator? = null
  private var gallery: PFGallery? = null
  private val handler = Handler(Looper.getMainLooper())
  private val snapRunnable = Runnable { maybeSnap() }
  private val scrollListener = ViewTreeObserver.OnScrollChangedListener { onScrolled() }
  private var listening = false

  init {
    clipChildren = true
    overlay.clipChildren = false

    overlay.addView(bg)
    overlay.addView(hairline)

    closeButton.scaleType = ImageView.ScaleType.CENTER
    closeButton.setOnClickListener { onClose(emptyMap<String, Any>()) }
    overlay.addView(closeButton)

    avatarBox.clipChildren = false
    avatarBox.addView(avatar, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    badgeIcon.scaleType = ImageView.ScaleType.CENTER_INSIDE
    val bp = dp(7f)
    badgeIcon.setPadding(bp, bp, bp, bp)
    badge.addView(badgeIcon, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    badge.addView(badgeSpinner, FrameLayout.LayoutParams(dp(16f), dp(16f), Gravity.CENTER))
    avatarBox.addView(badge, FrameLayout.LayoutParams(dp(30f), dp(30f), Gravity.BOTTOM or Gravity.END))
    avatarBox.setOnClickListener { avatarTapped() }
    overlay.addView(avatarBox)

    titleView.setSingleLine(true)
    titleView.ellipsize = TextUtils.TruncateAt.END
    titleView.gravity = Gravity.CENTER
    titleView.includeFontPadding = false
    pfTextSize(titleView, 22f, 1)
    overlay.addView(titleView)

    subtitleView.setSingleLine(true)
    subtitleView.ellipsize = TextUtils.TruncateAt.END
    subtitleView.gravity = Gravity.CENTER
    subtitleView.includeFontPadding = false
    pfTextSize(subtitleView, 15f, 0)
    overlay.addView(subtitleView)

    actionsRow.orientation = LinearLayout.HORIZONTAL
    overlay.addView(actionsRow)

    super.addView(overlay, -1, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    applyTheme()
  }

  // ───────────────────────── filhos RN (GroupView) ─────────────────────────
  internal fun rnChildCount(): Int = rnChildren.size
  internal fun rnChildAt(index: Int): View? = rnChildren.getOrNull(index)

  internal fun addRnChild(child: View, index: Int) {
    val i = index.coerceIn(0, rnChildren.size)
    rnChildren.add(i, child)
    // overlay é sempre o último: o índice RN i é o índice real i.
    super.addView(child, i)
    if (overlay.parent === this && indexOfChild(overlay) != childCount - 1) overlay.bringToFront()
    scrollView = null
    post { attachScroll() }
  }

  internal fun removeRnChildAt(index: Int) {
    val c = rnChildren.getOrNull(index) ?: return
    rnChildren.removeAt(index)
    super.removeView(c)
    scrollView = null
  }

  internal fun removeRnChild(child: View) {
    rnChildren.remove(child)
    super.removeView(child)
    scrollView = null
  }

  // ───────────────────────── layout ─────────────────────────
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(w, h)
    overlay.pfExactly(w, h)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    // Filhos RN são posicionados pelo Fabric (não chamar o LinearLayout).
    // [toques RN] o overlay só ocupa a faixa VISÍVEL do cabeçalho: o
    // TouchTargetHelper do RN não pode achá-lo sobre as linhas do ScrollView
    // (senão o alvo JS vira esta view e os Pressable da folha não recebem toque).
    overlay.layout(0, 0, r - l, min(b - t, overlay.visibleHeight))
  }

  private val expandedPx get() = dpf(expandedHeightDp.toFloat())
  private val compactPx get() = max(dpf(compactHeightDp.toFloat()), dpf(topInsetDp.toFloat()) + dpf(44f))
  private val y0 get() = dpf(topInsetDp.toFloat())

  /** Posições EXPANDIDAS (sem transformações); applyProgress() anima por cima. */
  internal fun layoutHeader() {
    val w = overlay.width
    val h = overlay.height
    if (w <= 0 || h <= 0) return
    val y0i = y0.toInt()
    val bgExtra = max(h, dp(400f)) * 2
    bg.pfPlace(0, -bgExtra, w, expandedPx.toInt() + bgExtra)
    hairline.pfPlace(0, 0, w, max(1, (density * 0.5f).toInt()))
    closeButton.pfPlace(dp(6f), y0i + dp(6f), dp(44f), dp(44f))
    val a = dp(96f)
    avatarBox.pfPlace((w - a) / 2, y0i + dp(12f), a, a)
    titleView.pfPlace(dp(24f), y0i + dp(120f), w - dp(48f), dp(28f))
    subtitleView.pfPlace(dp(24f), y0i + dp(150f), w - dp(48f), dp(20f))
    actionsRow.visibility = if (actions.isEmpty()) View.GONE else View.VISIBLE
    actionsRow.pfPlace(dp(16f), y0i + dp(186f), w - dp(32f), dp(62f))
    applyProgress()
  }

  private fun lerp(a: Float, b: Float, t: Float) = a + (b - a) * t

  private fun applyProgress() {
    val w = overlay.width.toFloat()
    if (w <= 0f) return
    val offset = if (stretch > 0f) -stretch else scrollY.toFloat()
    val range = max(1f, expandedPx - compactPx)
    val p = (offset / range).coerceIn(0f, 1f)
    val visibleH = max(compactPx, expandedPx - offset)
    overlay.visibleHeight = visibleH.toInt()
    if (height > 0) overlay.bottom = min(height, visibleH.toInt())
    overlay.clipBounds = Rect(0, 0, w.toInt(), visibleH.toInt())
    bg.translationY = visibleH - expandedPx
    hairline.translationY = visibleH - hairline.height
    hairline.alpha = p

    val barCenter = y0 + (compactPx - y0) / 2f
    val over = max(0f, -offset)

    // Avatar
    val a = dpf(96f)
    val ex = w / 2f
    val ey = y0 + dpf(12f) + a / 2f
    if (over > 0f) {
      val s = 1f + min(0.6f, over / dpf(160f))
      avatarBox.scaleX = s; avatarBox.scaleY = s
      avatarBox.translationX = 0f
      avatarBox.translationY = over / 2f
    } else {
      val cx = lerp(ex, dpf(6f + 44f + 8f + 17f), p)
      val cy = lerp(ey, barCenter, p)
      val s = lerp(1f, 34f / 96f, p)
      avatarBox.scaleX = s; avatarBox.scaleY = s
      avatarBox.translationX = cx - ex
      avatarBox.translationY = cy - ey
    }

    // Título / subtítulo
    val hasSub = subtitle.isNotEmpty()
    placeText(titleView, title, over, p, 17f / 22f, dpf(134f) + y0, if (hasSub) barCenter - dpf(9f) else barCenter)
    placeText(subtitleView, subtitle, over, p, 13f / 15f, dpf(160f) + y0, barCenter + dpf(10f))

    // Ações
    if (over > 0f) {
      actionsRow.alpha = 1f
      actionsRow.translationY = over
    } else {
      actionsRow.alpha = 1f - min(1f, p * 2.2f)
      actionsRow.translationY = -offset * 0.5f
    }
  }

  private fun placeText(tv: TextView, text: String, over: Float, p: Float, minScale: Float, expandedCY: Float, targetCY: Float) {
    val boxW = tv.width.toFloat()
    if (boxW <= 0f) return
    val textW = min(tv.paint.measureText(text), boxW)
    val pivot = (boxW - textW) / 2f
    tv.pivotX = pivot
    tv.pivotY = tv.height / 2f
    if (over > 0f) {
      tv.scaleX = 1f; tv.scaleY = 1f
      tv.translationX = 0f
      tv.translationY = over
      return
    }
    val expandedLeft = tv.left + pivot
    val collapsedLeft = dpf(6f + 44f + 8f + 34f + 10f)
    val s = lerp(1f, minScale, p)
    tv.scaleX = s; tv.scaleY = s
    tv.translationX = lerp(0f, collapsedLeft - expandedLeft, p)
    tv.translationY = lerp(0f, targetCY - expandedCY, p)
  }

  // ───────────────────────── rolagem ─────────────────────────
  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (!listening) {
      try { viewTreeObserver.addOnScrollChangedListener(scrollListener); listening = true } catch (_: Throwable) {}
    }
    post { attachScroll() }
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    if (listening) {
      try { viewTreeObserver.removeOnScrollChangedListener(scrollListener) } catch (_: Throwable) {}
      listening = false
    }
    handler.removeCallbacks(snapRunnable)
    stretchAnim?.cancel()
  }

  private fun findScroll(v: View): ScrollView? {
    if (v is ScrollView) return v
    if (v is ViewGroup) {
      for (i in 0 until v.childCount) {
        val f = findScroll(v.getChildAt(i))
        if (f != null) return f
      }
    }
    return null
  }

  private fun locateScroll(): ScrollView? {
    scrollView?.let { if (it.isAttachedToWindow) return it }
    scrollView = null
    for (c in rnChildren) {
      val f = findScroll(c)
      if (f != null) { scrollView = f; break }
    }
    return scrollView
  }

  private fun attachScroll() {
    if (locateScroll() != null) onScrolled()
  }

  private fun onScrolled() {
    val sv = locateScroll() ?: return
    val y = max(0, sv.scrollY)
    if (y == scrollY) return
    scrollY = y
    applyProgress()
    handler.removeCallbacks(snapRunnable)
    handler.postDelayed(snapRunnable, 140)
  }

  private fun maybeSnap() {
    if (touching || pulling || gallery != null) return
    val sv = scrollView ?: return
    val range = max(1f, expandedPx - compactPx)
    val p = scrollY / range
    if (p <= 0.02f || p >= 0.98f) return
    val target = if (p < 0.5f) 0 else range.toInt()
    try { sv.smoothScrollTo(0, target) } catch (_: Throwable) {}
  }

  // ───────────────────────── toques / puxão ─────────────────────────
  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> { touching = true; handler.removeCallbacks(snapRunnable) }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        touching = false
        handler.removeCallbacks(snapRunnable)
        handler.postDelayed(snapRunnable, 140)
      }
    }
    return super.dispatchTouchEvent(ev)
  }

  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = ev.x; downY = ev.y; pulling = false
        if (stretchAnim?.isRunning == true) stretchAnim?.cancel()
      }
      MotionEvent.ACTION_MOVE -> {
        if (pulling) return true
        if (gallery != null) return false
        val dy = ev.y - downY
        val dx = ev.x - downX
        val sv = locateScroll()
        if (dy > slop && dy > abs(dx) * 1.2f && sv != null && !sv.canScrollVertically(-1) && scrollY <= 0) {
          pulling = true
          downY = ev.y
          notifyNativeGesture(ev)
          return true
        }
      }
    }
    return pulling
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    if (!pulling) return false
    when (ev.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        val dy = max(0f, ev.y - downY)
        val dim = dpf(400f)
        setStretch((1f - 1f / (dy * 0.55f / dim + 1f)) * dim)
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        pulling = false
        release()
      }
    }
    return true
  }

  private fun setStretch(v: Float) {
    stretch = max(0f, v)
    for (c in rnChildren) c.translationY = stretch
    applyProgress()
  }

  private fun release() {
    val from = stretch
    if (from > dpf(80f) && photos.isNotEmpty()) openGallery()
    stretchAnim?.cancel()
    val a = ValueAnimator.ofFloat(from, 0f)
    a.duration = 320
    a.interpolator = DecelerateInterpolator(1.8f)
    a.addUpdateListener { setStretch(it.animatedValue as Float) }
    stretchAnim = a
    a.start()
  }

  private fun notifyNativeGesture(ev: MotionEvent) {
    try {
      val cls = Class.forName("com.facebook.react.uimanager.events.NativeGestureUtil")
      val m = cls.getMethod("notifyNativeGestureStarted", View::class.java, MotionEvent::class.java)
      val target: Any? = if (java.lang.reflect.Modifier.isStatic(m.modifiers)) null else cls.getField("INSTANCE").get(null)
      m.invoke(target, this, ev)
    } catch (_: Throwable) {}
  }

  // ───────────────────────── avatar / galeria ─────────────────────────
  private fun avatarTapped() {
    when {
      avatarBadge.isNotEmpty() -> onAvatarPress(emptyMap<String, Any>())
      photos.isNotEmpty() -> openGallery()
      else -> onAvatarPress(emptyMap<String, Any>())
    }
  }

  private fun openGallery() {
    if (gallery != null || photos.isEmpty()) return
    val act = appContext.currentActivity ?: return
    val loc = IntArray(2)
    avatarBox.getLocationOnScreen(loc)
    val sw = avatarBox.width * avatarBox.scaleX
    val sh = avatarBox.height * avatarBox.scaleY
    // getLocationOnScreen já inclui translation; scale com pivô no centro.
    val cx = loc[0] + avatarBox.width * avatarBox.scaleX / 2f
    val cy = loc[1] + avatarBox.height * avatarBox.scaleY / 2f
    val rect = Rect((cx - sw / 2f).toInt(), (cy - sh / 2f).toInt(), (cx + sw / 2f).toInt(), (cy + sh / 2f).toInt())
    avatarBox.alpha = 0f
    val g = PFGallery(act, photos, rect, labels["close"] ?: "") {
      gallery = null
      avatarBox.animate().alpha(1f).setDuration(120).start()
      onGallery(mapOf("open" to false))
    }
    gallery = g
    onGallery(mapOf("open" to true))
    g.show()
  }

  // ───────────────────────── props ─────────────────────────
  fun setTheme(m: Map<String, Any?>?) { theme = PFTheme(m); applyTheme(); rebuildActions(true) }
  fun setTitleProp(v: String) { title = v; titleView.text = v; applyProgress() }
  fun setSubtitleProp(v: String) { subtitle = v; subtitleView.text = v; applyProgress() }
  fun setAvatarProp(m: Map<String, Any?>?) { avatarImage = PFImage.from(m); bindAvatar() }
  fun setInitialsProp(v: String) { initials = v; bindAvatar() }
  fun setAvatarColorProp(v: Double?) { avatarColor = pfColor(v, 0xFF8E8E93.toInt()); bindAvatar() }
  fun setPhotosProp(l: List<Map<String, Any?>>?) { photos = (l ?: emptyList()).mapNotNull { PFImage.from(it) } }
  fun setActionsProp(l: List<Map<String, Any?>>?) { actions = l ?: emptyList(); rebuildActions(false) }
  fun setExpandedHeight(v: Double?) { expandedHeightDp = max(60.0, v ?: 264.0); overlay.requestLayout() }
  fun setCompactHeight(v: Double?) { compactHeightDp = max(44.0, v ?: 56.0); overlay.requestLayout() }
  fun setTopInset(v: Double?) { topInsetDp = max(0.0, v ?: 0.0); overlay.requestLayout() }
  fun setAvatarBadgeProp(v: String) { avatarBadge = v; bindBadge() }
  fun setAvatarBusyProp(v: Boolean) { avatarBusy = v; bindBadge() }
  fun setLabelsProp(m: Map<String, String>?) {
    labels = m ?: emptyMap()
    closeButton.contentDescription = labels["close"] ?: ""
    avatarBox.contentDescription = labels["photo"] ?: ""
  }
  fun setCloseStyleProp(v: String) { closeStyle = if (v == "back") "back" else "close"; applyTheme() }

  fun didUpdateProps() {
    overlay.requestLayout()
  }

  private fun bindAvatar() {
    avatar.bind(avatarImage, initials, avatarColor, dp(96f))
  }

  private fun bindBadge() {
    badge.visibility = if (avatarBadge.isEmpty()) View.GONE else View.VISIBLE
    badge.background = pfOval(theme.text).also { it.setStroke(dp(2.5f), theme.surface) }
    pfTintedIcon(badgeIcon, if (avatarBadge.isEmpty()) "camera" else avatarBadge, theme.surface)
    badgeIcon.visibility = if (avatarBusy) View.INVISIBLE else View.VISIBLE
    badgeSpinner.visibility = if (avatarBusy) View.VISIBLE else View.GONE
    try { badgeSpinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(theme.surface) } catch (_: Throwable) {}
  }

  private fun applyTheme() {
    bg.setBackgroundColor(theme.surface)
    hairline.setBackgroundColor(theme.hairline)
    pfTintedIcon(closeButton, closeStyle, theme.text)
    closeButton.background = pfRipple(theme.hairline, dpf(22f))
    titleView.setTextColor(theme.text)
    subtitleView.setTextColor(theme.secondaryText)
    bindBadge()
  }

  private fun rebuildActions(force: Boolean) {
    val key = actions.joinToString("|") { "${pfStr(it["key"])}:${pfStr(it["label"])}:${pfStr(it["icon"])}:${pfBool(it["active"])}" }
    if (!force && key == actionsKey) return
    actionsKey = key
    actionsRow.removeAllViews()
    actions.forEachIndexed { i, a ->
      val k = pfStr(a["key"])
      val card = LinearLayout(context)
      card.orientation = LinearLayout.VERTICAL
      card.gravity = Gravity.CENTER
      card.background = pfRounded(theme.card, dpf(12f), theme.cardBorder, max(1, (density * 0.5f).toInt()))
      card.foreground = pfRipple(theme.hairline, dpf(12f))
      card.contentDescription = pfStr(a["label"])
      val icon = ImageView(context)
      pfTintedIcon(icon, pfStr(a["icon"]), theme.text)
      icon.scaleType = ImageView.ScaleType.FIT_CENTER
      card.addView(icon, LinearLayout.LayoutParams(dp(22f), dp(22f)))
      val label = TextView(context)
      label.text = pfStr(a["label"])
      label.setSingleLine(true)
      label.ellipsize = TextUtils.TruncateAt.END
      label.gravity = Gravity.CENTER
      label.setTextColor(theme.text)
      pfTextSize(label, 12f, if (pfBool(a["active"])) 2 else 1)
      val llp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
      llp.topMargin = dp(5f)
      llp.leftMargin = dp(4f); llp.rightMargin = dp(4f)
      card.addView(label, llp)
      card.setOnClickListener {
        card.animate().scaleX(0.94f).scaleY(0.94f).setDuration(70).withEndAction {
          card.animate().scaleX(1f).scaleY(1f).setDuration(160).setInterpolator(android.view.animation.OvershootInterpolator(2f)).start()
        }.start()
        onAction(mapOf("key" to k))
      }
      val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f)
      if (i > 0) lp.leftMargin = dp(8f)
      actionsRow.addView(card, lp)
    }
    overlay.requestLayout()
  }
}
