package expo.modules.chatyycomposer

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.Spanned
import android.text.TextUtils
import android.text.TextWatcher
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.view.animation.PathInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.core.view.inputmethod.InputConnectionCompat
import com.bumptech.glide.Glide
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.util.regex.Pattern
import kotlin.math.max
import kotlin.math.min

private const val TAG = "ChatyyComposer"
private val IMAGE_MIMES = arrayOf("image/*")
private val MENTION_RE: Pattern = Pattern.compile("@[\\w.\\-]+")

internal class NCMentionColorSpan(color: Int) : ForegroundColorSpan(color)
internal class NCMentionBoldSpan : StyleSpan(Typeface.BOLD)

internal fun ncDp(ctx: Context, v: Float): Int = (v * ctx.resources.displayMetrics.density + 0.5f).toInt()

/** Ícone clicável com ripple sem borda (vetor 24dp escalado p/ iconDp via padding). */
@SuppressLint("ViewConstructor")
internal class NCIconButton(ctx: Context, iconRes: Int, iconDp: Float) : ImageView(ctx) {
  private val iconPx: Int = ncDp(ctx, iconDp)

  init {
    setImageResource(iconRes)
    scaleType = ScaleType.FIT_CENTER
    isClickable = true
    isFocusable = true
    background = RippleDrawable(ColorStateList.valueOf(0x22888888), null, null)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    val ph = max(0, (w - iconPx) / 2)
    val pv = max(0, (h - iconPx) / 2)
    setPadding(ph, pv, ph, pv)
  }

  fun tint(color: Int) {
    imageTintList = ColorStateList.valueOf(color)
  }
}

/** EditText com colar imagem (menu + GIF/figurinha do teclado) e callback de seleção. */
internal class NCEditText(ctx: Context) : EditText(ctx) {
  var onSelection: ((Int, Int) -> Unit)? = null
  var onImageUri: ((Uri, String?) -> Unit)? = null

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    onSelection?.invoke(selStart, selEnd)
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val ic = super.onCreateInputConnection(outAttrs) ?: return null
    if (onImageUri == null) return ic
    EditorInfoCompat.setContentMimeTypes(outAttrs, IMAGE_MIMES)
    return InputConnectionCompat.createWrapper(this, ic, outAttrs)
  }

  override fun onTextContextMenuItem(id: Int): Boolean {
    // API 31+: o colar da plataforma já passa pelo OnReceiveContentListener.
    if ((id == android.R.id.paste || id == android.R.id.pasteAsPlainText) &&
      Build.VERSION.SDK_INT < Build.VERSION_CODES.S && onImageUri != null) {
      try {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val clip: ClipData? = cm?.primaryClip
        val desc = clip?.description
        if (clip != null && desc != null && desc.hasMimeType("image/*") && clip.itemCount > 0) {
          val uri = clip.getItemAt(0).uri
          if (uri != null) {
            onImageUri?.invoke(uri, desc.getMimeType(0))
            return true
          }
        }
      } catch (t: Throwable) {
        Log.w(TAG, "paste image: ${t.message}")
      }
    }
    return super.onTextContextMenuItem(id)
  }
}

/** Botão redondo enviar ⇄ microfone com morph (escala + giro + fade). */
@SuppressLint("ViewConstructor")
internal class NCActionButton(ctx: Context) : FrameLayout(ctx) {
  enum class Mode { MIC, SEND }

  private val circleBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
  val micIcon = ImageView(ctx)
  val sendIcon = ImageView(ctx)
  val spinner = ProgressBar(ctx, null, android.R.attr.progressBarStyleSmall)
  var mode = Mode.MIC
    private set

  init {
    background = circleBg
    isClickable = true
    isFocusable = true
    val icon = ncDp(ctx, 22f)
    for ((iv, res) in listOf(micIcon to R.drawable.nc_ic_mic, sendIcon to R.drawable.nc_ic_send)) {
      iv.setImageResource(res)
      iv.scaleType = ImageView.ScaleType.FIT_CENTER
      addView(iv, LayoutParams(icon, icon, Gravity.CENTER))
    }
    sendIcon.alpha = 0f
    sendIcon.scaleX = 0.4f
    sendIcon.scaleY = 0.4f
    sendIcon.rotation = -60f
    spinner.visibility = View.GONE
    val sp = ncDp(ctx, 20f)
    addView(spinner, LayoutParams(sp, sp, Gravity.CENTER))
  }

  fun apply(bg: Int, icon: Int) {
    circleBg.setColor(bg)
    micIcon.imageTintList = ColorStateList.valueOf(icon)
    sendIcon.imageTintList = ColorStateList.valueOf(icon)
    spinner.indeterminateTintList = ColorStateList.valueOf(icon)
  }

  fun setSending(on: Boolean) {
    spinner.visibility = if (on) View.VISIBLE else View.GONE
    micIcon.visibility = if (on) View.INVISIBLE else View.VISIBLE
    sendIcon.visibility = if (on) View.INVISIBLE else View.VISIBLE
  }

  fun setMode(m: Mode, animated: Boolean) {
    if (m == mode) return
    mode = m
    val incoming = if (m == Mode.SEND) sendIcon else micIcon
    val outgoing = if (m == Mode.SEND) micIcon else sendIcon
    val dirIn = if (m == Mode.SEND) -1f else 1f
    incoming.animate().cancel()
    outgoing.animate().cancel()
    if (!animated) {
      incoming.alpha = 1f; incoming.scaleX = 1f; incoming.scaleY = 1f; incoming.rotation = 0f
      outgoing.alpha = 0f; outgoing.scaleX = 0.4f; outgoing.scaleY = 0.4f; outgoing.rotation = -dirIn * 60f
      return
    }
    incoming.alpha = 0f; incoming.scaleX = 0.4f; incoming.scaleY = 0.4f; incoming.rotation = dirIn * 60f
    incoming.animate().alpha(1f).scaleX(1f).scaleY(1f).rotation(0f)
      .setDuration(300).setInterpolator(OvershootInterpolator(1.6f)).start()
    outgoing.animate().alpha(0f).scaleX(0.4f).scaleY(0.4f).rotation(-dirIn * 60f)
      .setDuration(180).setInterpolator(DecelerateInterpolator()).start()
  }

  fun press(down: Boolean) {
    animate().scaleX(if (down) 0.88f else 1f).scaleY(if (down) 0.88f else 1f)
      .setDuration(if (down) 120 else 220)
      .setInterpolator(if (down) DecelerateInterpolator() else OvershootInterpolator(2f)).start()
  }
}

/** [reply-v2] Ícone do tipo da mensagem citada (paths SVG do mesmo ícone do app). */
internal class NCPathIcon(ctx: Context) : View(ctx) {
  private val paths = ArrayList<Pair<android.graphics.Path, Boolean>>()
  private var vb = 24f
  private var sw = 2f
  private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
    strokeCap = android.graphics.Paint.Cap.ROUND; strokeJoin = android.graphics.Paint.Join.ROUND
  }
  var color: Int = Color.GRAY
    set(v) { field = v; invalidate() }
  val hasPaths get() = paths.isNotEmpty()

  fun set(list: List<NCIconPathRecord>?, viewBox: Double) {
    paths.clear()
    vb = if (viewBox > 0) viewBox.toFloat() else 24f
    sw = 2f
    for (p in list ?: emptyList()) {
      if (p.d.isEmpty()) continue
      try {
        val path = androidx.core.graphics.PathParser.createPathFromPathData(p.d) ?: continue
        paths.add(path to (p.fill != 0))
        if (p.w > 0) sw = p.w.toFloat()
      } catch (_: Throwable) {}
    }
    invalidate()
  }

  override fun onDraw(canvas: android.graphics.Canvas) {
    if (paths.isEmpty() || width <= 0) return
    val sc = width / vb
    canvas.save()
    canvas.scale(sc, sc)
    paint.color = color
    for ((p, fill) in paths) {
      paint.style = if (fill) android.graphics.Paint.Style.FILL else android.graphics.Paint.Style.STROKE
      paint.strokeWidth = sw
      canvas.drawPath(p, paint)
    }
    canvas.restore()
  }
}

/** Cartão de resposta/edição acima do campo. */
@SuppressLint("ViewConstructor")
internal class NCReplyCard(ctx: Context) : ViewGroup(ctx) {
  private val bg = GradientDrawable()
  val line = View(ctx)
  val title = TextView(ctx)
  val body = TextView(ctx)
  val thumb = ImageView(ctx)
  val close = NCIconButton(ctx, R.drawable.nc_ic_close, 14f)
  private val closeBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
  private val closeDot = View(ctx)
  var hasThumb = false
  private var thumbToken = ""
  // [reply-v2]
  val kindIcon = NCPathIcon(ctx)
  private var hasIcon = false
  private var baseInk: Int = Color.BLACK
  private var accentInk: Int? = null

  private fun applyInk() {
    val ink = accentInk ?: baseInk
    (line.background as? GradientDrawable)?.setColor(ink)
    title.setTextColor(ink)
  }

  init {
    bg.cornerRadius = ncDp(ctx, 16f).toFloat()
    background = bg
    elevation = ncDp(ctx, 1f).toFloat()
    line.background = GradientDrawable().apply { cornerRadius = ncDp(ctx, 1.5f).toFloat() }
    addView(line)
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    title.typeface = Typeface.DEFAULT_BOLD
    title.maxLines = 1
    title.ellipsize = TextUtils.TruncateAt.END
    addView(title)
    body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
    body.maxLines = 3
    body.ellipsize = TextUtils.TruncateAt.END
    addView(body)
    thumb.scaleType = ImageView.ScaleType.CENTER_CROP
    thumb.clipToOutline = true
    thumb.visibility = View.GONE
    addView(thumb)
    kindIcon.visibility = View.GONE
    addView(kindIcon)
    closeDot.background = closeBg
    addView(closeDot)
    addView(close)
  }

  fun applyColors(card: Int, border: Int, text: Int, secondary: Int, dark: Boolean) {
    bg.setColor(card)
    bg.setStroke(ncDp(context, 1f), border)
    baseInk = text
    applyInk()
    body.setTextColor(secondary)
    kindIcon.color = secondary
    close.tint(secondary)
    closeBg.setColor(if (dark) 0x1AFFFFFF else 0x0F000000)
  }

  fun configure(r: NCReplyRecord) {
    title.text = r.title
    body.text = r.text
    body.maxLines = if (r.lines > 0) r.lines else if (r.italic) 1 else 3
    body.setTypeface(null, if (r.italic) Typeface.ITALIC else Typeface.NORMAL)
    accentInk = r.color?.let { ncColor(it, baseInk) }
    applyInk()
    kindIcon.set(r.iconPaths, r.iconVb)
    hasIcon = kindIcon.hasPaths
    kindIcon.visibility = if (hasIcon) View.VISIBLE else View.GONE
    val uri = r.thumbUri ?: ""
    hasThumb = uri.isNotEmpty()
    thumb.visibility = if (hasThumb) View.VISIBLE else View.GONE
    thumb.background = GradientDrawable().apply {
      if (r.thumbRound) shape = GradientDrawable.OVAL else cornerRadius = ncDp(context, 6f).toFloat()
      setColor(0x38808080)
    }
    if (uri != thumbToken) {
      thumbToken = uri
      if (hasThumb) {
        try {
          Glide.with(thumb).load(uri).centerCrop().into(thumb)
        } catch (t: Throwable) {
          Log.w(TAG, "thumb: ${t.message}")
        }
      } else {
        try { Glide.with(thumb).clear(thumb) } catch (_: Throwable) {}
        thumb.setImageDrawable(null)
      }
    }
    requestLayout()
  }

  private fun textWidth(w: Int): Int {
    var tw = w - ncDp(context, 12f + 3f + 10f + 44f + 4f)
    if (hasThumb) tw -= ncDp(context, 50f)
    return max(ncDp(context, 40f), tw)
  }

  private fun iconW(): Int = if (hasIcon) ncDp(context, 18f) else 0

  fun preferredHeight(w: Int): Int {
    val tw = textWidth(w)
    title.measure(MeasureSpec.makeMeasureSpec(tw, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    body.measure(MeasureSpec.makeMeasureSpec(tw - iconW(), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val h = ncDp(context, 10f) + title.measuredHeight + ncDp(context, 2f) + body.measuredHeight + ncDp(context, 10f)
    return max(ncDp(context, 54f), h)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(w, h)
    val tw = textWidth(w)
    title.measure(MeasureSpec.makeMeasureSpec(tw, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    body.measure(MeasureSpec.makeMeasureSpec(tw - iconW(), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val ex = { s: Int -> MeasureSpec.makeMeasureSpec(s, MeasureSpec.EXACTLY) }
    kindIcon.measure(ex(ncDp(context, 14f)), ex(ncDp(context, 14f)))
    line.measure(ex(ncDp(context, 3f)), ex(max(ncDp(context, 34f), h - ncDp(context, 20f))))
    thumb.measure(ex(ncDp(context, 42f)), ex(ncDp(context, 42f)))
    close.measure(ex(ncDp(context, 44f)), ex(ncDp(context, 44f)))
    closeDot.measure(ex(ncDp(context, 24f)), ex(ncDp(context, 24f)))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    val d10 = ncDp(context, 10f)
    line.layout(ncDp(context, 12f), d10, ncDp(context, 15f), d10 + line.measuredHeight)
    val tx = ncDp(context, 25f)
    val block = title.measuredHeight + ncDp(context, 2f) + body.measuredHeight
    val y0 = max(d10, (h - block) / 2)
    title.layout(tx, y0, tx + title.measuredWidth, y0 + title.measuredHeight)
    val by = y0 + title.measuredHeight + ncDp(context, 2f)
    val bx = tx + iconW()
    body.layout(bx, by, bx + body.measuredWidth, by + body.measuredHeight)
    if (hasIcon) {
      val lh = min(body.measuredHeight, body.lineHeight)
      val iy = by + max(0, (lh - ncDp(context, 14f)) / 2)
      kindIcon.layout(tx, iy, tx + ncDp(context, 14f), iy + ncDp(context, 14f))
    }
    val closeX = w - ncDp(context, 4f) - ncDp(context, 44f)
    val cy = (h - ncDp(context, 44f)) / 2
    close.layout(closeX, cy, closeX + ncDp(context, 44f), cy + ncDp(context, 44f))
    val dx = closeX + ncDp(context, 10f)
    val dy = (h - ncDp(context, 24f)) / 2
    closeDot.layout(dx, dy, dx + ncDp(context, 24f), dy + ncDp(context, 24f))
    if (hasThumb) {
      val tX = closeX - ncDp(context, 42f)
      val tY = (h - ncDp(context, 42f)) / 2
      thumb.layout(tX, tY, tX + ncDp(context, 42f), tY + ncDp(context, 42f))
    }
  }
}

@SuppressLint("ViewConstructor")
class ChatyyComposerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  internal val onChangeText by EventDispatcher()
  internal val onSend by EventDispatcher()
  internal val onAttach by EventDispatcher()
  internal val onCamera by EventDispatcher()
  internal val onEmoji by EventDispatcher()
  internal val onVideoNote by EventDispatcher()
  internal val onVoiceRecorded by EventDispatcher()
  internal val onVoiceState by EventDispatcher()
  internal val onHeightChange by EventDispatcher()
  internal val onSelectionChange by EventDispatcher()
  internal val onPasteImage by EventDispatcher()
  internal val onFocusChange by EventDispatcher()
  internal val onReplyCancel by EventDispatcher()
  internal val onSendMenu by EventDispatcher()
  internal val onKeyboardFrame by EventDispatcher()

  private val density = resources.displayMetrics.density
  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()

  // ── Subviews (todas filhas diretas; layout manual ancorado no rodapé) ──
  internal val replyCard = NCReplyCard(context)
  private val barBg = View(context)
  private val hairline = View(context)
  private val plusButton = NCIconButton(context, R.drawable.nc_ic_plus, 26f)
  private val plusSpinner = ProgressBar(context, null, android.R.attr.progressBarStyleSmall)
  private val pillBgDrawable = GradientDrawable()
  private val pill = View(context)
  private val emojiButton = NCIconButton(context, R.drawable.nc_ic_smile, 22f)
  internal val edit = NCEditText(context)
  private val cameraButton = NCIconButton(context, R.drawable.nc_ic_camera, 22f)
  private val videoNoteButton = NCIconButton(context, R.drawable.nc_ic_video, 22f)
  internal val actionButton = NCActionButton(context)
  internal val voice = NCVoiceController(this)

  // ── Props / estado ──
  internal var pendingTheme: NCThemeRecord? = null
  private var pendingReplySet = false
  private var pendingReply: NCReplyRecord? = null
  internal var theme = NCResolved()
    private set
  private var labels: Map<String, String> = emptyMap()
  internal var sendMenuItems: List<NCMenuItemRecord> = emptyList()
  private var bottomInsetPx = 0
  private var sending = false
  private var uploading = false
  private var enterSends = false
  private var autocorrect = true
  private var maxLength = 5000
  private var maxLinesProp = 6
  private var showEmoji = true
  private var emojiActive = false
  private var showCamera = true
  private var showVideoNote = false
  internal var voiceEnabled = true
  internal var voiceBlocked = false
  internal var disabledProp = false
    private set
  internal var changeDebounceMs = 60L
  private var keyboardTracking = "none"

  private var replyVisible = false
  private var replyRecord: NCReplyRecord? = null
  private var mentionMap: Map<String, String> = emptyMap()
  private var lastEmittedText = ""
  private var lastHeightPx = -1
  private var defaultTextApplied = false
  private var applyingStyle = false
  private var suppressWatcher = false
  private var cameraVisible = true
  private val handler = Handler(Looper.getMainLooper())
  private val flushRunnable = Runnable { flushChange() }
  private var frames = Frames()
  private var kbLastLift = -1

  // [2026-10-16 motion-composer] Campo cresce/encolhe por linha animado
  // (Telegram). A altura reportada ao RN muda já (a lista acompanha no mesmo
  // frame, como no iOS); só o desenho da pílula/fundo/cartão interpola do
  // tamanho antigo ao novo, ancorado no rodapé. Kill switch: prop motion=false.
  internal var motionEnabled = true
    private set
  private var rowAnimTarget = -1
  private var rowAnimShown = -1f
  private var rowAnim: ValueAnimator? = null

  fun setMotion(v: Boolean) {
    if (v == motionEnabled) return
    motionEnabled = v
    if (!v) stopRowAnim()
  }

  private fun stopRowAnim() {
    val old = rowAnim
    rowAnim = null
    rowAnimShown = -1f
    old?.cancel()
  }

  private fun trackRowAnim(target: Int) {
    val prev = rowAnimTarget
    rowAnimTarget = target
    if (prev < 0 || prev == target) return
    val from = if (rowAnim != null && rowAnimShown >= 0f) rowAnimShown else prev.toFloat()
    stopRowAnim()
    val enabled = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ValueAnimator.areAnimatorsEnabled()
    if (!motionEnabled || !enabled || !isAttachedToWindow || voice.isActive || kotlin.math.abs(target - from) < 1f) return
    rowAnimShown = from
    val a = ValueAnimator.ofFloat(from, target.toFloat())
    a.duration = 260
    a.interpolator = PathInterpolator(0.2f, 0.9f, 0.25f, 1f)
    a.addUpdateListener { va ->
      if (rowAnim !== va) return@addUpdateListener
      rowAnimShown = va.animatedValue as Float
      relayoutChildrenNow()
    }
    a.addListener(object : AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: Animator) {
        if (rowAnim !== animation) return
        rowAnim = null
        rowAnimShown = -1f
        relayoutChildrenNow()
      }
    })
    rowAnim = a
    a.start()
  }

  private fun relayoutChildrenNow() {
    if (width <= 0 || height <= 0) return
    try { onLayout(false, left, top, right, bottom) } catch (t: Throwable) { Log.w(TAG, "rowAnim: ${t.message}") }
    clampEditScroll()
  }

  /** O EditText pode ter rolado enquanto estava mais baixo que o conteúdo. */
  private fun clampEditScroll() {
    val l = edit.layout ?: return
    val maxY = max(0, l.height + edit.totalPaddingTop + edit.totalPaddingBottom - edit.height)
    if (edit.scrollY > maxY) edit.scrollTo(edit.scrollX, maxY)
  }

  private data class Frames(
    var total: Int = 0, var replyH: Int = 0, var cardH: Int = 0, var barH: Int = 0,
    var rowH: Int = 0, var textH: Int = 0, var pillX: Int = 0, var pillW: Int = 0,
    var textX: Int = 0, var textW: Int = 0, var camera: Boolean = false, var videoNote: Boolean = false,
    var actionX: Int = 0
  )

  init {
    clipChildren = false
    clipToPadding = false
    setWillNotDraw(true)

    replyCard.visibility = View.GONE
    replyCard.close.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
      // [reply-v2] fecha já (animação local), sem esperar o JS limpar a prop.
      if (replyRecord?.pop == true) setReply(null)
      onReplyCancel(emptyMap<String, Any>())
    }
    addView(replyCard)
    addView(barBg)
    addView(hairline)

    plusButton.setOnClickListener {
      hideKeyboard()
      onAttach(emptyMap<String, Any>())
    }
    addView(plusButton)
    plusSpinner.visibility = View.GONE
    addView(plusSpinner)

    pillBgDrawable.cornerRadius = dp(22f).toFloat()
    pill.background = pillBgDrawable
    addView(pill)

    emojiButton.setOnClickListener { onEmoji(emptyMap<String, Any>()) }
    addView(emojiButton)

    setupEdit()
    addView(edit)

    cameraButton.setOnClickListener { onCamera(emptyMap<String, Any>()) }
    addView(cameraButton)
    videoNoteButton.setOnClickListener { onVideoNote(emptyMap<String, Any>()) }
    videoNoteButton.visibility = View.GONE
    addView(videoNoteButton)

    actionButton.setOnClickListener { actionTapped() }
    actionButton.setOnLongClickListener { showSendMenu() }
    actionButton.setOnTouchListener(voice.touchListener)
    addView(actionButton)

    addView(voice.panel)
    applyTheme()
  }

  private fun setupEdit() {
    edit.background = null
    edit.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    edit.setPadding(dp(4f), dp(10f), dp(4f), dp(10f))
    edit.minHeight = dp(42f)
    edit.gravity = Gravity.TOP or Gravity.START
    edit.maxLines = maxLinesProp
    edit.isVerticalScrollBarEnabled = true
    edit.filters = arrayOf<InputFilter>(InputFilter.LengthFilter(maxLength))
    applyInputType()
    edit.onSelection = { s, e ->
      onSelectionChange(mapOf("start" to s, "end" to e))
    }
    edit.onImageUri = { uri, mime -> copyPastedImage(uri, mime) }
    ViewCompat.setOnReceiveContentListener(edit, IMAGE_MIMES, object : OnReceiveContentListener {
      override fun onReceiveContent(view: View, payload: ContentInfoCompat): ContentInfoCompat? {
        val split = payload.partition { item -> item.uri != null }
        val uriContent = split.first
        val remaining = split.second
        if (uriContent != null) {
          val clip = uriContent.clip
          val mime = if (clip.description.mimeTypeCount > 0) clip.description.getMimeType(0) else null
          for (i in 0 until clip.itemCount) {
            val u = clip.getItemAt(i).uri ?: continue
            if (mime != null && !mime.startsWith("image/")) continue
            copyPastedImage(u, mime)
            break
          }
        }
        return remaining
      }
    })
    edit.setOnEditorActionListener { _, actionId, _ ->
      if (enterSends && (actionId == EditorInfo.IME_ACTION_SEND || actionId == EditorInfo.IME_NULL)) {
        if (hasText() && !sending) actionTapped()
        true
      } else false
    }
    edit.setOnFocusChangeListener { _, has ->
      if (!has) flushChange()
      onFocusChange(mapOf("focused" to has))
    }
    edit.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        if (applyingStyle) return
        if (s != null && enterSends) {
          // Teclado físico / colar com \n no modo "Enter envia": remove a quebra e envia.
          val idx = TextUtils.indexOf(s, '\n')
          if (idx >= 0 && s.length > 0 && !suppressWatcher) {
            suppressWatcher = true
            s.delete(idx, idx + 1)
            suppressWatcher = false
            if (hasText() && !sending) handler.post { actionTapped() }
          }
        }
        applyMentionStyling(s)
        if (!suppressWatcher) textChanged(emit = true)
      }
    })
  }

  private fun applyInputType() {
    var type = InputType.TYPE_CLASS_TEXT
    type = type or if (autocorrect) (InputType.TYPE_TEXT_FLAG_AUTO_CORRECT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
    else InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    if (!enterSends) type = type or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    val sel = edit.selectionStart
    edit.inputType = type
    edit.setHorizontallyScrolling(false)
    edit.maxLines = maxLinesProp
    edit.imeOptions = if (enterSends) EditorInfo.IME_ACTION_SEND else EditorInfo.IME_ACTION_NONE
    if (sel >= 0 && sel <= (edit.text?.length ?: 0)) edit.setSelection(sel)
  }

  // ── Props ──

  fun setPlaceholder(s: String) {
    edit.hint = s
  }

  fun setLabels(m: Map<String, String>) {
    labels = m
    plusButton.contentDescription = m["attach"]
    emojiButton.contentDescription = m["emoji"]
    cameraButton.contentDescription = m["camera"]
    videoNoteButton.contentDescription = m["videoNote"]
    replyCard.close.contentDescription = m["cancel"]
    voice.setLabels(m)
    updateActionA11y()
  }

  internal fun label(key: String): String? = labels[key]

  fun setPendingReply(r: NCReplyRecord?) {
    pendingReplySet = true
    pendingReply = r
  }

  fun setMentionCandidates(list: List<NCMentionRecord>) {
    val m = HashMap<String, String>()
    for (c in list) {
      var tok = c.token.trim().lowercase()
      if (tok.startsWith("@")) tok = tok.substring(1)
      if (tok.isNotEmpty()) m[tok] = c.email
    }
    if (m != mentionMap) {
      mentionMap = m
      applyMentionStyling(edit.text)
    }
  }

  fun applyDefaultText(s: String) {
    if (defaultTextApplied) return
    defaultTextApplied = true
    if (s.isNotEmpty()) setTextFromJS(s)
  }

  fun setBottomInsetDp(v: Double) {
    val px = (v * density).toInt()
    if (px != bottomInsetPx) { bottomInsetPx = px; requestLayout() }
  }

  fun setSending(v: Boolean) {
    if (v == sending) return
    sending = v
    actionButton.setSending(sending && actionButton.mode == NCActionButton.Mode.SEND)
  }

  fun setUploading(v: Boolean) {
    if (v == uploading) return
    uploading = v
    plusButton.visibility = if (v) View.INVISIBLE else View.VISIBLE
    plusSpinner.visibility = if (v) View.VISIBLE else View.GONE
    plusButton.isEnabled = !v
  }

  fun setEnterSends(v: Boolean) {
    if (v == enterSends) return
    enterSends = v
    applyInputType()
  }

  fun setAutocorrect(v: Boolean) {
    if (v == autocorrect) return
    autocorrect = v
    applyInputType()
  }

  fun setMaxLength(v: Int) {
    if (v == maxLength) return
    maxLength = v
    edit.filters = arrayOf<InputFilter>(InputFilter.LengthFilter(v))
  }

  fun setMaxLinesProp(v: Int) {
    if (v == maxLinesProp) return
    maxLinesProp = v
    edit.maxLines = v
    requestLayout()
  }

  fun setShowEmoji(v: Boolean) { if (v != showEmoji) { showEmoji = v; requestLayout() } }
  fun setEmojiActive(v: Boolean) { if (v != emojiActive) { emojiActive = v; tintIcons() } }
  fun setShowCamera(v: Boolean) { if (v != showCamera) { showCamera = v; requestLayout() } }
  fun setShowVideoNote(v: Boolean) { if (v != showVideoNote) { showVideoNote = v; requestLayout() } }

  fun setDisabledProp(v: Boolean) {
    if (v == disabledProp) return
    disabledProp = v
    alpha = if (v) 0.4f else 1f
    for (c in listOf<View>(plusButton, emojiButton, edit, cameraButton, videoNoteButton, actionButton)) c.isEnabled = !v
  }

  fun didUpdateProps() {
    pendingTheme?.let {
      pendingTheme = null
      theme = NCResolved.from(it)
      applyTheme()
    }
    if (pendingReplySet) {
      pendingReplySet = false
      setReply(pendingReply)
      pendingReply = null
    }
  }

  private fun applyTheme() {
    val c = theme
    barBg.setBackgroundColor(c.surface)
    hairline.setBackgroundColor(c.hairline)
    pillBgDrawable.setColor(c.pill)
    pillBgDrawable.setStroke(dp(1f), c.pillBorder)
    edit.setTextColor(c.text)
    edit.setHintTextColor(c.placeholder)
    edit.highlightColor = (c.accent and 0x00FFFFFF) or 0x55000000
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      try {
        edit.textCursorDrawable = GradientDrawable().apply {
          setColor(c.accent)
          setSize(dp(2f), dp(20f))
        }
      } catch (_: Throwable) {}
    }
    plusButton.tint(c.text)
    plusSpinner.indeterminateTintList = ColorStateList.valueOf(c.text)
    cameraButton.tint(c.icon)
    videoNoteButton.tint(c.text)
    actionButton.apply(c.action, c.actionIcon)
    replyCard.applyColors(c.replyCard, c.replyCardBorder, c.text, c.secondaryText, c.dark)
    voice.applyTheme(c)
    tintIcons()
    applyMentionStyling(edit.text)
  }

  private fun tintIcons() {
    emojiButton.tint(if (emojiActive) theme.iconActive else theme.icon)
  }

  private fun updateActionA11y() {
    actionButton.contentDescription = if (actionButton.mode == NCActionButton.Mode.SEND) labels["send"] else labels["record"]
  }

  // ── Resposta / edição ──

  private fun setReply(r: NCReplyRecord?) {
    if (r != null) {
      val was = replyVisible
      val keyChanged = replyRecord?.key != r.key
      replyRecord = r
      replyCard.configure(r)
      replyVisible = true
      replyCard.visibility = View.VISIBLE
      requestLayout()
      if (!was) {
        replyCard.animate().cancel()
        replyCard.alpha = 0f
        // [reply-v2] entra com mola de baixo (Telegram)
        replyCard.translationY = dp(if (r.pop) 26f else 12f).toFloat()
        if (r.pop) { replyCard.scaleX = 0.97f; replyCard.scaleY = 0.97f }
        replyCard.animate().alpha(1f).translationY(0f).scaleX(1f).scaleY(1f).setDuration(if (r.pop) 340 else 260)
          .setInterpolator(OvershootInterpolator(if (r.pop) 1.1f else 0.8f)).start()
      } else if (replyCard.alpha < 1f || replyCard.translationY != 0f) {
        // estava saindo (X/limpo) e voltou → reverte a saída
        replyCard.animate().cancel()
        replyCard.animate().alpha(1f).translationY(0f).scaleX(1f).scaleY(1f).setDuration(220)
          .setInterpolator(OvershootInterpolator(0.8f)).start()
      } else if (keyChanged && r.pop) {
        replyCard.animate().cancel()
        replyCard.scaleX = 0.97f; replyCard.scaleY = 0.97f
        replyCard.animate().scaleX(1f).scaleY(1f).setDuration(260).setInterpolator(OvershootInterpolator(2f)).start()
      }
      // [reply-v2] responder abre o teclado sozinho
      if (r.focus && r.kind == "reply" && keyChanged && !voice.isActive && !emojiActive && isAttachedToWindow) focusInput()
    } else if (replyVisible) {
      replyRecord = null
      replyCard.animate().cancel()
      replyCard.animate().alpha(0f).translationY(dp(8f).toFloat()).setDuration(150)
        .withEndAction {
          if (replyRecord == null) {
            replyVisible = false
            replyCard.visibility = View.GONE
            replyCard.translationY = 0f
            requestLayout()
          }
        }.start()
    }
  }

  // ── Botões ──

  private fun actionTapped() {
    if (voice.isLocked) {
      voice.finishLocked()
      return
    }
    if (actionButton.mode == NCActionButton.Mode.SEND) {
      if (sending) return
      flushChange()
      val text = edit.text?.toString() ?: ""
      actionButton.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
      onSend(mapOf("text" to text, "mentions" to mentionsIn(text)))
    } else {
      voice.tapWithoutHold()
    }
  }

  private fun showSendMenu(): Boolean {
    if (actionButton.mode != NCActionButton.Mode.SEND || voice.isActive || sendMenuItems.isEmpty()) return false
    val pm = PopupMenu(context, actionButton, Gravity.END)
    sendMenuItems.forEachIndexed { i, item -> pm.menu.add(0, i, i, item.label) }
    pm.setOnMenuItemClickListener { mi ->
      val item = sendMenuItems.getOrNull(mi.itemId)
      if (item != null) onSendMenu(mapOf("key" to item.key))
      true
    }
    actionButton.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    pm.show()
    return true
  }

  private fun mentionsIn(text: String): List<String> {
    if (mentionMap.isEmpty()) return emptyList()
    val out = ArrayList<String>()
    val m = MENTION_RE.matcher(text)
    while (m.find()) {
      var tok = text.substring(m.start() + 1, m.end()).lowercase()
      while (tok.endsWith(".") || tok.endsWith("-")) tok = tok.dropLast(1)
      val email = mentionMap[tok] ?: continue
      if (!out.contains(email)) out.add(email)
    }
    return out
  }

  // ── Texto ──

  internal fun hasText(): Boolean = (edit.text?.toString() ?: "").isNotBlank()

  fun setTextFromJS(s: String) {
    lastEmittedText = s
    val cur = edit.text?.toString() ?: ""
    if (cur == s) return
    handler.removeCallbacks(flushRunnable)
    suppressWatcher = true
    edit.setText(s)
    suppressWatcher = false
    try { edit.setSelection(edit.text?.length ?: 0) } catch (_: Throwable) {}
    applyMentionStyling(edit.text)
    textChanged(emit = false)
  }

  fun setSelectionFromJS(start: Int, end: Int) {
    val len = edit.text?.length ?: 0
    val s = start.coerceIn(0, len)
    val e = end.coerceIn(s, len)
    try { edit.setSelection(s, e) } catch (_: Throwable) {}
  }

  fun focusInput() {
    edit.requestFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    edit.post { imm?.showSoftInput(edit, InputMethodManager.SHOW_IMPLICIT) }
  }

  fun blurInput() {
    hideKeyboard()
    edit.clearFocus()
  }

  private fun hideKeyboard() {
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.hideSoftInputFromWindow(edit.windowToken, 0)
  }

  fun cancelVoiceFromJS() {
    voice.cancel("js")
  }

  private fun textChanged(emit: Boolean) {
    val filled = hasText()
    actionButton.setMode(if (filled) NCActionButton.Mode.SEND else NCActionButton.Mode.MIC, isAttachedToWindow)
    actionButton.setSending(sending && filled)
    updateActionA11y()
    requestLayout()
    if (!emit) return
    val text = edit.text?.toString() ?: ""
    val wasEmpty = lastEmittedText.isEmpty()
    if (changeDebounceMs <= 0L || text.isEmpty() || wasEmpty) {
      flushChange()
    } else {
      handler.removeCallbacks(flushRunnable)
      handler.postDelayed(flushRunnable, changeDebounceMs)
    }
  }

  private fun flushChange() {
    handler.removeCallbacks(flushRunnable)
    val text = edit.text?.toString() ?: ""
    if (text == lastEmittedText) return
    lastEmittedText = text
    onChangeText(mapOf("text" to text))
  }

  private fun applyMentionStyling(s: Editable?) {
    if (s == null) return
    applyingStyle = true
    try {
      for (sp in s.getSpans(0, s.length, NCMentionColorSpan::class.java)) s.removeSpan(sp)
      for (sp in s.getSpans(0, s.length, NCMentionBoldSpan::class.java)) s.removeSpan(sp)
      if (mentionMap.isEmpty() || s.isEmpty()) return
      val str = s.toString()
      val m = MENTION_RE.matcher(str)
      while (m.find()) {
        var end = m.end()
        var tok = str.substring(m.start() + 1, end).lowercase()
        while (tok.endsWith(".") || tok.endsWith("-")) { tok = tok.dropLast(1); end -= 1 }
        if (mentionMap.containsKey(tok)) {
          s.setSpan(NCMentionColorSpan(theme.mention), m.start(), end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          s.setSpan(NCMentionBoldSpan(), m.start(), end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "mention style: ${t.message}")
    } finally {
      applyingStyle = false
    }
  }

  private fun copyPastedImage(uri: Uri, mime: String?) {
    val ctx = context.applicationContext
    Thread {
      try {
        val cr = ctx.contentResolver
        val type = mime?.takeIf { it.startsWith("image/") && !it.contains("*") } ?: (cr.getType(uri) ?: "image/png")
        val ext = when {
          type.contains("gif") -> "gif"
          type.contains("webp") -> "webp"
          type.contains("jpeg") || type.contains("jpg") -> "jpg"
          else -> "png"
        }
        val dir = File(ctx.cacheDir, "chatyy-paste").apply { mkdirs() }
        val name = "paste_${System.currentTimeMillis()}.$ext"
        val out = File(dir, name)
        cr.openInputStream(uri)?.use { input -> out.outputStream().use { input.copyTo(it) } } ?: return@Thread
        val opts = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(out.absolutePath, opts)
        val payload = mapOf(
          "uri" to Uri.fromFile(out).toString(),
          "mimeType" to type,
          "name" to name,
          "width" to opts.outWidth.coerceAtLeast(0),
          "height" to opts.outHeight.coerceAtLeast(0),
          "size" to out.length()
        )
        handler.post {
          performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
          onPasteImage(payload)
        }
      } catch (t: Throwable) {
        Log.w(TAG, "copyPastedImage: ${t.message}")
      }
    }.start()
  }

  // ── Layout ──

  private fun computeFrames(W: Int): Frames {
    val f = Frames()
    val empty = !hasText()
    f.camera = showCamera && empty
    f.videoNote = showVideoNote && empty
    f.actionX = W - dp(8f) - dp(44f)
    var right = f.actionX - dp(4f)
    if (f.videoNote) right -= dp(40f) + dp(2f)
    val left = dp(4f) + dp(40f) + dp(4f)
    f.pillX = left
    f.pillW = max(dp(80f), right - left)
    val emojiW = if (showEmoji) dp(36f) else dp(8f)
    f.textX = dp(4f) + emojiW
    val rightPad = if (f.camera) dp(44f) else dp(4f)
    f.textW = max(dp(40f), f.pillW - f.textX - rightPad)
    edit.measure(MeasureSpec.makeMeasureSpec(f.textW, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    f.textH = max(dp(42f), edit.measuredHeight)
    f.rowH = if (voice.isActive) dp(44f) else max(dp(44f), f.textH + dp(2f))
    f.barH = dp(6f) + f.rowH + max(dp(8f), bottomInsetPx)
    if (replyVisible) {
      f.cardH = replyCard.preferredHeight(W - dp(16f))
      f.replyH = f.cardH + dp(6f)
    }
    f.total = f.replyH + f.barH
    return f
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(w, h)
    if (w <= 0) return
    val f = computeFrames(w)
    frames = f
    val ex = { s: Int -> MeasureSpec.makeMeasureSpec(max(0, s), MeasureSpec.EXACTLY) }
    if (replyVisible) replyCard.measure(ex(w - dp(16f)), ex(f.cardH))
    barBg.measure(ex(w), ex(max(f.barH, h - f.replyH)))
    hairline.measure(ex(w), ex(max(1, (density * 0.5f).toInt())))
    plusButton.measure(ex(dp(40f)), ex(dp(44f)))
    plusSpinner.measure(ex(dp(20f)), ex(dp(20f)))
    pill.measure(ex(f.pillW), ex(f.rowH))
    emojiButton.measure(ex(dp(36f)), ex(dp(42f)))
    edit.measure(ex(f.textW), ex(f.textH))
    cameraButton.measure(ex(dp(40f)), ex(dp(42f)))
    videoNoteButton.measure(ex(dp(40f)), ex(dp(44f)))
    actionButton.measure(ex(dp(44f)), ex(dp(44f)))
    voice.panel.measure(ex(max(0, f.actionX - dp(4f) - dp(4f))), ex(dp(44f)))
    reportHeight(f.total)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val f = frames
    val W = r - l
    val H = b - t
    if (W <= 0) return
    trackRowAnim(f.rowH)
    // >0 crescendo (desenha ainda mais baixo), <0 encolhendo.
    val dRow = if (rowAnim != null && rowAnimShown >= 0f) (f.rowH - rowAnimShown).toInt() else 0
    val top = H - f.total
    if (replyVisible) replyCard.layout(dp(8f), top + dRow, W - dp(8f), top + dRow + f.cardH)
    val barTop = top + f.replyH
    barBg.layout(0, barTop + dRow, W, barTop + barBg.measuredHeight)
    hairline.layout(0, barTop + dRow, W, barTop + dRow + hairline.measuredHeight)
    val rowTop = barTop + dp(6f)
    val rowBottom = rowTop + f.rowH
    plusButton.layout(dp(4f), rowBottom - dp(44f), dp(44f), rowBottom)
    val spX = dp(4f) + (dp(40f) - dp(20f)) / 2
    val spY = rowBottom - dp(44f) + (dp(44f) - dp(20f)) / 2
    plusSpinner.layout(spX, spY, spX + dp(20f), spY + dp(20f))
    actionButton.layout(f.actionX, rowBottom - dp(44f), f.actionX + dp(44f), rowBottom)
    val vnX = f.actionX - dp(2f) - dp(40f)
    videoNoteButton.layout(vnX, rowBottom - dp(44f), vnX + dp(40f), rowBottom)
    val recording = voice.isActive
    videoNoteButton.visibility = if (f.videoNote && !recording) View.VISIBLE else View.GONE
    pill.layout(f.pillX, rowTop + dRow, f.pillX + f.pillW, rowTop + f.rowH)
    val inBottom = rowBottom - dp(1f)
    emojiButton.visibility = if (showEmoji) View.VISIBLE else View.GONE
    emojiButton.layout(f.pillX + dp(4f), inBottom - dp(42f), f.pillX + dp(40f), inBottom)
    val camX = f.pillX + f.pillW - dp(4f) - dp(40f)
    cameraButton.layout(camX, inBottom - dp(42f), camX + dp(40f), inBottom)
    if (cameraVisible != f.camera) {
      cameraVisible = f.camera
      cameraButton.animate().cancel()
      if (f.camera) {
        cameraButton.visibility = View.VISIBLE
        cameraButton.alpha = 0f
        cameraButton.animate().alpha(1f).setDuration(160).start()
      } else {
        cameraButton.animate().alpha(0f).setDuration(120).withEndAction {
          if (!cameraVisible) cameraButton.visibility = View.GONE
        }.start()
      }
    }
    val tx = f.pillX + f.textX
    edit.layout(tx, inBottom - max(dp(20f), f.textH - dRow), tx + f.textW, inBottom)
    val panelW = max(0, f.actionX - dp(4f) - dp(4f))
    voice.panel.layout(dp(4f), rowTop, dp(4f) + panelW, rowTop + dp(44f))
  }

  private fun reportHeight(totalPx: Int) {
    if (totalPx == lastHeightPx) return
    lastHeightPx = totalPx
    val hDp = totalPx / density
    post {
      try { shadowNodeProxy.setStyleSize(null, hDp.toDouble()) } catch (t: Throwable) { Log.w(TAG, "setStyleSize: ${t.message}") }
      onHeightChange(mapOf("height" to hDp.toDouble()))
    }
  }

  override fun onDetachedFromWindow() {
    flushChange()
    voice.cancel("unmount")
    super.onDetachedFromWindow()
  }

  // ── Hooks da gravação ──

  internal fun voiceDidChangeActive() {
    val active = voice.isActive
    val a = if (active) 0f else 1f
    for (v in listOf<View>(plusButton, pill, emojiButton, edit, cameraButton)) {
      v.animate().alpha(a).setDuration(160).start()
      v.isEnabled = !active && !disabledProp && !(v === plusButton && uploading)
    }
    requestLayout()
  }

  internal fun voiceDidLock() {
    actionButton.setMode(NCActionButton.Mode.SEND, true)
    actionButton.contentDescription = labels["sendVoice"] ?: labels["send"]
  }

  internal fun voiceDidEnd() {
    actionButton.setMode(if (hasText()) NCActionButton.Mode.SEND else NCActionButton.Mode.MIC, true)
    updateActionA11y()
  }

  internal fun emitVoiceState(state: String, reason: String? = null) {
    val m = HashMap<String, Any>()
    m["state"] = state
    if (reason != null) m["reason"] = reason
    onVoiceState(m)
  }

  internal fun emitVoiceRecorded(payload: Map<String, Any>) {
    onVoiceRecorded(payload)
  }

  // ── Teclado (opt-in 'translate'; padrão 'none' = KC levanta a tela) ──

  private val kbCallback = object : WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
    override fun onProgress(insets: WindowInsetsCompat, runningAnimations: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat {
      applyKeyboardInsets(insets)
      return insets
    }

    override fun onEnd(animation: WindowInsetsAnimationCompat) {
      ViewCompat.getRootWindowInsets(this@ChatyyComposerView)?.let { applyKeyboardInsets(it) }
    }
  }

  fun setKeyboardTracking(mode: String) {
    if (mode == keyboardTracking) return
    keyboardTracking = mode
    if (mode == "translate") {
      ViewCompat.setWindowInsetsAnimationCallback(this, kbCallback)
      ViewCompat.getRootWindowInsets(this)?.let { applyKeyboardInsets(it) }
    } else {
      ViewCompat.setWindowInsetsAnimationCallback(this, null)
      translationY = 0f
      kbLastLift = -1
    }
  }

  private fun applyKeyboardInsets(insets: WindowInsetsCompat) {
    if (keyboardTracking != "translate") return
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
    val lift = max(0, ime - bottomInsetPx)
    if (lift == kbLastLift) return
    kbLastLift = lift
    translationY = -lift.toFloat()
    onKeyboardFrame(mapOf("height" to (ime / density).toDouble(), "lift" to (lift / density).toDouble()))
  }
}

internal data class NCResolved(
  val dark: Boolean = false,
  val surface: Int = Color.WHITE,
  val pill: Int = Color.WHITE,
  val pillBorder: Int = 0x24000000,
  val text: Int = 0xFF111111.toInt(),
  val secondaryText: Int = 0xFF6E6E73.toInt(),
  val placeholder: Int = 0xFF6E6E73.toInt(),
  val icon: Int = 0xFF6E6E73.toInt(),
  val iconActive: Int = 0xFF111111.toInt(),
  val action: Int = 0xFF111111.toInt(),
  val actionIcon: Int = Color.WHITE,
  val hairline: Int = 0x1A000000,
  val accent: Int = 0xFF111111.toInt(),
  val mention: Int = 0xFF1E6FD9.toInt(),
  val replyCard: Int = Color.WHITE,
  val replyCardBorder: Int = 0x1A000000,
  val recording: Int = 0xFFFF3B30.toInt()
) {
  companion object {
    fun from(t: NCThemeRecord): NCResolved {
      val d = NCResolved()
      val text = ncColor(t.text, d.text)
      val accent = ncColor(t.accent, d.accent)
      return NCResolved(
        dark = t.dark,
        surface = ncColor(t.surface, d.surface),
        pill = ncColor(t.pill, d.pill),
        pillBorder = ncColor(t.pillBorder, d.pillBorder),
        text = text,
        secondaryText = ncColor(t.secondaryText, d.secondaryText),
        placeholder = ncColor(t.placeholder, d.placeholder),
        icon = ncColor(t.icon, d.icon),
        iconActive = ncColor(t.iconActive, text),
        action = ncColor(t.action, d.action),
        actionIcon = ncColor(t.actionIcon, d.actionIcon),
        hairline = ncColor(t.hairline, d.hairline),
        accent = accent,
        mention = ncColor(t.mention, accent),
        replyCard = ncColor(t.replyCard, ncColor(t.surface, d.surface)),
        replyCardBorder = ncColor(t.replyCardBorder, d.replyCardBorder),
        recording = ncColor(t.recording, d.recording)
      )
    }
  }
}
