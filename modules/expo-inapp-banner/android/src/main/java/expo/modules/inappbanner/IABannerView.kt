package expo.modules.inappbanner

import android.animation.LayoutTransition
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.AccelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.bumptech.glide.Glide
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

// [2026-10-16 native-toast] Banner nativo (Android). Ver ChatyyInAppBannerModule.kt.

data class IABannerOptions(
  val id: String,
  val title: String,
  val body: String,
  val meta: String,
  val avatarUrl: String,
  val initials: String,
  val avatarColor: Int,
  val accent: Int,
  val dark: Boolean,
  val urgent: Boolean,
  val durationMs: Long,
  val canReply: Boolean,
  val replyPlaceholder: String,
  val actionLabel: String,
  val closeLabel: String,
) {
  companion object {
    private fun str(v: Any?): String = when (v) {
      null -> ""
      is String -> v
      is Number -> v.toString()
      else -> v.toString()
    }

    fun color(v: Any?, fallback: Int): Int {
      val s0 = (v as? String)?.trim() ?: return fallback
      var s = if (s0.startsWith("#")) s0.substring(1) else s0
      if (s.length == 3) s = s.map { "$it$it" }.joinToString("")
      return try {
        when (s.length) {
          6 -> (0xff shl 24) or s.toLong(16).toInt()
          8 -> { val n = s.toLong(16); val a = (n and 0xff).toInt(); ((a shl 24) or ((n shr 8).toInt() and 0xffffff)) }
          else -> fallback
        }
      } catch (_: Throwable) { fallback }
    }

    fun from(m: Map<String, Any?>): IABannerOptions {
      val d = (m["durationMs"] as? Number)?.toLong() ?: 4000L
      return IABannerOptions(
        id = str(m["id"]),
        title = str(m["title"]),
        body = str(m["body"]),
        meta = str(m["meta"]),
        avatarUrl = str(m["avatarUrl"]),
        initials = str(m["initials"]),
        avatarColor = color(m["avatarColor"], Color.rgb(92, 92, 92)),
        accent = color(m["accent"], Color.rgb(16, 185, 129)),
        dark = (m["dark"] as? Boolean) ?: false,
        urgent = (m["urgent"] as? Boolean) ?: false,
        durationMs = if (d < 1000) 4000L else min(d, 15000L),
        canReply = (m["canReply"] as? Boolean) ?: false,
        replyPlaceholder = str(m["replyPlaceholder"]),
        actionLabel = str(m["actionLabel"]),
        closeLabel = str(m["closeLabel"]),
      )
    }
  }
}

@SuppressLint("ViewConstructor")
class IABannerView(
  private val activity: Activity,
  val options: IABannerOptions,
  private val listener: Listener,
) : FrameLayout(activity) {

  interface Listener {
    fun onPress(v: IABannerView)
    fun onSwipeAway(v: IABannerView)
    fun onClose(v: IABannerView)
    fun onTimeout(v: IABannerView)
    fun onExpand(v: IABannerView)
    fun onReply(v: IABannerView, text: String)
  }

  private val density = resources.displayMetrics.density
  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()
  private val main = Handler(Looper.getMainLooper())
  private val slop = ViewConfiguration.get(activity).scaledTouchSlop

  private val textColor = if (options.dark) Color.rgb(247, 247, 247) else Color.rgb(18, 18, 18)
  private val secondaryColor = if (options.dark) Color.rgb(190, 190, 190) else Color.rgb(82, 82, 82)

  private val card = LinearLayout(activity)
  private val avatarFrame = FrameLayout(activity)
  private val avatarImage = ImageView(activity)
  private val initialsView = TextView(activity)
  private val nameView = TextView(activity)
  private val metaView = TextView(activity)
  private val previewView = TextView(activity)
  private val grabber = View(activity)
  private val replyRow = LinearLayout(activity)
  private val replyField = EditText(activity)
  private val sendView = TextView(activity)
  private var actionView: TextView? = null

  private var expanded = false
  private var dragging = false
  private var leaving = false
  private var downX = 0f
  private var downY = 0f
  private var velocity: VelocityTracker? = null

  private val timeout = Runnable { if (!expanded && !dragging && !leaving) listener.onTimeout(this) }

  init {
    clipChildren = false
    clipToPadding = false
    build()
  }

  fun makeLayoutParams(decor: ViewGroup): FrameLayout.LayoutParams {
    val screenW = decor.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels
    val w = min(screenW - dp(16f), dp(520f))
    val lp = FrameLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT)
    lp.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
    var top = 0
    try {
      val ins = ViewCompat.getRootWindowInsets(decor)
        ?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      top = ins?.top ?: 0
    } catch (_: Throwable) {}
    if (top <= 0) {
      val id = resources.getIdentifier("status_bar_height", "dimen", "android")
      if (id > 0) top = resources.getDimensionPixelSize(id)
    }
    lp.topMargin = top + dp(6f)
    return lp
  }

  private fun build() {
    // ── cartão ──
    card.orientation = LinearLayout.VERTICAL
    val bg = GradientDrawable()
    bg.cornerRadius = dp(24f).toFloat()
    bg.setColor(if (options.dark) Color.argb(250, 30, 30, 32) else Color.argb(250, 255, 255, 255))
    if (options.urgent) bg.setStroke(dp(1.5f), Color.rgb(220, 38, 38))
    else bg.setStroke(max(1, dp(0.5f)), if (options.dark) Color.argb(22, 255, 255, 255) else Color.argb(16, 0, 0, 0))
    card.background = bg
    card.elevation = dp(12f).toFloat()
    card.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        outline.setRoundRect(0, 0, view.width, view.height, dp(24f).toFloat())
      }
    }
    card.clipToOutline = true
    card.setPadding(dp(12f), dp(12f), dp(12f), dp(if (options.canReply) 8f else 12f))
    card.layoutTransition = LayoutTransition().apply {
      enableTransitionType(LayoutTransition.CHANGING)
      setDuration(240)
    }
    addView(card, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

    val row = LinearLayout(activity)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    card.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    // ── avatar ──
    val side = dp(40f)
    val avBg = GradientDrawable()
    avBg.shape = GradientDrawable.OVAL
    avBg.setColor(options.avatarColor)
    avatarFrame.background = avBg
    avatarFrame.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) { outline.setOval(0, 0, view.width, view.height) }
    }
    avatarFrame.clipToOutline = true
    initialsView.text = options.initials.ifEmpty { "?" }
    initialsView.setTextColor(Color.WHITE)
    initialsView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    initialsView.typeface = Typeface.DEFAULT_BOLD
    initialsView.gravity = Gravity.CENTER
    avatarFrame.addView(initialsView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    avatarImage.scaleType = ImageView.ScaleType.CENTER_CROP
    avatarFrame.addView(avatarImage, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    val avLp = LinearLayout.LayoutParams(side, side)
    avLp.marginEnd = dp(10f)
    row.addView(avatarFrame, avLp)
    if (options.avatarUrl.isNotEmpty()) {
      try {
        Glide.with(avatarImage).load(options.avatarUrl).circleCrop().override(dp(80f)).into(avatarImage)
      } catch (_: Throwable) {}
    }

    // ── textos ──
    val col = LinearLayout(activity)
    col.orientation = LinearLayout.VERTICAL
    row.addView(col, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

    val top = LinearLayout(activity)
    top.orientation = LinearLayout.HORIZONTAL
    top.gravity = Gravity.CENTER_VERTICAL
    col.addView(top, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    nameView.text = options.title
    nameView.setTextColor(textColor)
    nameView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    nameView.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    nameView.maxLines = 1
    nameView.ellipsize = TextUtils.TruncateAt.END
    top.addView(nameView, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

    if (options.meta.isNotEmpty()) {
      metaView.text = options.meta
      metaView.setTextColor(secondaryColor)
      metaView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      metaView.maxLines = 1
      val mlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
      mlp.marginStart = dp(6f)
      top.addView(metaView, mlp)
    }

    if (options.body.isNotEmpty()) {
      previewView.text = options.body
      previewView.setTextColor(secondaryColor)
      previewView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f)
      previewView.maxLines = 2
      previewView.ellipsize = TextUtils.TruncateAt.END
      val plp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
      plp.topMargin = dp(2f)
      col.addView(previewView, plp)
    }

    // ── ação (ex.: "ENTRAR" numa live) ──
    if (options.actionLabel.isNotEmpty()) {
      val a = TextView(activity)
      a.text = options.actionLabel.uppercase()
      a.setTextColor(Color.WHITE)
      a.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      a.typeface = Typeface.DEFAULT_BOLD
      a.gravity = Gravity.CENTER
      a.setPadding(dp(12f), dp(6f), dp(12f), dp(6f))
      val abg = GradientDrawable()
      abg.cornerRadius = dp(14f).toFloat()
      abg.setColor(options.accent)
      a.background = abg
      a.setOnClickListener { if (!leaving) listener.onPress(this) }
      val alp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
      alp.marginStart = dp(8f)
      row.addView(a, alp)
      actionView = a
    }

    // ── resposta rápida (escondida até expandir) ──
    replyRow.orientation = LinearLayout.HORIZONTAL
    replyRow.gravity = Gravity.CENTER_VERTICAL
    replyRow.visibility = View.GONE
    val rlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(42f))
    rlp.topMargin = dp(10f)
    card.addView(replyRow, rlp)

    val fbg = GradientDrawable()
    fbg.cornerRadius = dp(21f).toFloat()
    fbg.setColor(if (options.dark) Color.argb(26, 255, 255, 255) else Color.argb(13, 0, 0, 0))
    replyField.background = fbg
    replyField.setPadding(dp(14f), 0, dp(14f), 0)
    replyField.hint = options.replyPlaceholder
    replyField.setHintTextColor(secondaryColor)
    replyField.setTextColor(textColor)
    replyField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    replyField.maxLines = 3
    replyField.imeOptions = EditorInfo.IME_ACTION_SEND
    replyField.inputType = android.text.InputType.TYPE_CLASS_TEXT or
      android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
      android.text.InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    replyField.setOnEditorActionListener { _, actionId, ev ->
      if (actionId == EditorInfo.IME_ACTION_SEND || (ev != null && ev.keyCode == KeyEvent.KEYCODE_ENTER && ev.action == KeyEvent.ACTION_DOWN)) {
        sendReply(); true
      } else false
    }
    replyField.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        sendView.alpha = if ((s?.toString() ?: "").isBlank()) 0.4f else 1f
      }
    })
    replyRow.addView(replyField, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))

    val sbg = GradientDrawable()
    sbg.shape = GradientDrawable.OVAL
    sbg.setColor(options.accent)
    sendView.background = sbg
    sendView.text = "↑"
    sendView.setTextColor(Color.WHITE)
    sendView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
    sendView.typeface = Typeface.DEFAULT_BOLD
    sendView.gravity = Gravity.CENTER
    sendView.alpha = 0.4f
    sendView.contentDescription = options.replyPlaceholder
    sendView.setOnClickListener { sendReply() }
    val slp = LinearLayout.LayoutParams(dp(36f), dp(36f))
    slp.marginStart = dp(8f)
    replyRow.addView(sendView, slp)

    // ── alça (só quando dá para expandir) ──
    if (options.canReply) {
      val gbg = GradientDrawable()
      gbg.cornerRadius = dp(2.5f).toFloat()
      gbg.setColor(if (options.dark) Color.argb(56, 255, 255, 255) else Color.argb(36, 0, 0, 0))
      grabber.background = gbg
      val glp = LinearLayout.LayoutParams(dp(36f), dp(5f))
      glp.gravity = Gravity.CENTER_HORIZONTAL
      glp.topMargin = dp(8f)
      card.addView(grabber, glp)
    }

    isClickable = true
    contentDescription = listOf(options.title, options.body).filter { it.isNotEmpty() }.joinToString(", ")
    ViewCompat.replaceAccessibilityAction(this,
      androidx.core.view.accessibility.AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_DISMISS,
      options.closeLabel.ifEmpty { null }) { _, _ -> listener.onClose(this); true }
  }

  // ── animações ──

  private fun offscreen(): Float {
    val lp = layoutParams as? MarginLayoutParams
    val h = if (height > 0) height else dp(96f)
    return -((lp?.topMargin ?: 0) + h + dp(40f)).toFloat()
  }

  fun present() {
    translationY = -dp(220f).toFloat()
    post {
      translationY = offscreen()
      animate().translationY(0f).setDuration(460).setInterpolator(OvershootInterpolator(0.9f)).start()
      if (contentDescription != null) announceForAccessibility(contentDescription)
    }
    schedule(options.durationMs)
  }

  fun slideAway(fast: Boolean, done: () -> Unit) {
    if (leaving) return
    leaving = true
    main.removeCallbacks(timeout)
    hideKeyboard()
    isEnabled = false
    animate().cancel()
    val anim = animate().translationY(offscreen()).setDuration(if (fast) 180 else 260)
      .setInterpolator(AccelerateInterpolator(1.4f))
    if (fast) anim.alpha(0f)
    anim.withEndAction {
      removeNow()
      done()
    }.start()
  }

  fun removeNow() {
    main.removeCallbacks(timeout)
    hideKeyboard()
    try { Glide.with(avatarImage).clear(avatarImage) } catch (_: Throwable) {}
    (parent as? ViewGroup)?.removeView(this)
  }

  private fun snapBack() {
    animate().translationY(0f).setDuration(320).setInterpolator(OvershootInterpolator(1.1f)).start()
  }

  private fun schedule(ms: Long) {
    main.removeCallbacks(timeout)
    main.postDelayed(timeout, ms)
  }

  private fun expand() {
    if (!options.canReply || expanded || leaving) return
    expanded = true
    main.removeCallbacks(timeout)
    performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    listener.onExpand(this)
    animate().translationY(0f).setDuration(260).setInterpolator(DecelerateInterpolator()).start()
    previewView.maxLines = 6
    grabber.visibility = View.GONE
    replyRow.visibility = View.VISIBLE
    replyRow.alpha = 0f
    replyRow.animate().alpha(1f).setDuration(200).start()
    replyField.requestFocus()
    replyField.post {
      try {
        val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(replyField, InputMethodManager.SHOW_IMPLICIT)
      } catch (_: Throwable) {}
    }
  }

  private fun hideKeyboard() {
    if (!replyField.hasFocus()) return
    try {
      val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
      imm?.hideSoftInputFromWindow(replyField.windowToken, 0)
    } catch (_: Throwable) {}
    replyField.clearFocus()
  }

  private fun sendReply() {
    val text = replyField.text?.toString()?.trim() ?: ""
    if (text.isEmpty() || leaving) return
    performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    listener.onReply(this, text)
  }

  // ── gestos (arrastar vertical; toque = abrir) ──

  private fun rubber(d: Float): Float {
    val limit = dp(70f).toFloat()
    return limit * (1f - 1f / (d / limit * 0.6f + 1f))
  }

  private fun isInside(v: View?, ev: MotionEvent): Boolean {
    if (v == null || v.visibility != View.VISIBLE) return false
    val loc = IntArray(2)
    v.getLocationOnScreen(loc)
    val x = ev.rawX
    val y = ev.rawY
    return x >= loc[0] && x <= loc[0] + v.width && y >= loc[1] && y <= loc[1] + v.height
  }

  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
    if (leaving) return true
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = ev.rawX
        downY = ev.rawY
        dragging = false
        velocity?.recycle()
        velocity = VelocityTracker.obtain()
        velocity?.addMovement(ev)
      }
      MotionEvent.ACTION_MOVE -> {
        velocity?.addMovement(ev)
        val dy = ev.rawY - downY
        val dx = ev.rawX - downX
        if (abs(dy) > slop && abs(dy) > abs(dx)) {
          beginDrag()
          return true
        }
      }
    }
    // Toque fora do campo/botões → nós tratamos (toque = abrir).
    return false
  }

  private fun beginDrag() {
    if (dragging) return
    dragging = true
    main.removeCallbacks(timeout)
    animate().cancel()
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    if (leaving) return true
    if (velocity == null) velocity = VelocityTracker.obtain()
    velocity?.addMovement(ev)
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = ev.rawX
        downY = ev.rawY
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        val dy = ev.rawY - downY
        if (!dragging && abs(dy) > slop) beginDrag()
        if (dragging) translationY = if (dy < 0) dy else rubber(dy)
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val dy = ev.rawY - downY
        velocity?.computeCurrentVelocity(1000)
        val vy = velocity?.yVelocity ?: 0f
        velocity?.recycle()
        velocity = null
        val wasDragging = dragging
        dragging = false
        if (ev.actionMasked == MotionEvent.ACTION_CANCEL) {
          snapBack()
          if (!expanded) schedule(max(1500L, options.durationMs / 2))
          return true
        }
        if (!wasDragging) {
          // toque simples (sem mexer) no cartão = abrir
          if (!isInside(replyRow, ev) && !isInside(actionView, ev)) {
            performClick()
            listener.onPress(this)
          }
          return true
        }
        val up = -dp(32f).toFloat()
        val down = dp(40f).toFloat()
        if (dy < up || vy < -1200f * density / 2.75f) {
          performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
          listener.onSwipeAway(this)
        } else if (options.canReply && !expanded && (dy > down || vy > 1800f * density / 2.75f)) {
          expand()
        } else {
          snapBack()
          if (!expanded) schedule(max(1500L, options.durationMs / 2))
        }
        return true
      }
    }
    return super.onTouchEvent(ev)
  }

  override fun performClick(): Boolean {
    super.performClick()
    return true
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    main.removeCallbacks(timeout)
    velocity?.recycle()
    velocity = null
  }
}
