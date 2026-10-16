package expo.modules.chatyystatusstudio

import android.app.Activity
import android.app.AlertDialog
import android.app.Application
import android.app.DatePickerDialog
import android.app.Dialog
import android.app.TimePickerDialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.SpannableString
import android.text.Spanned
import android.text.TextUtils
import android.text.TextWatcher
import android.text.format.DateFormat as AndroidDateFormat
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class SSItemState(val src: SSMediaIn) {
  var filterIdx = 0
  val layers = ArrayList<SSLayer>()
  val strokes = ArrayList<SSStroke>()
  var preview: Bitmap? = null
  var thumb: Bitmap? = null
  var bgColor = Color.rgb(11, 11, 11)
  var previewLoading = false
  var thumbLoading = false
}

/**
 * [2026-10-15 native-status-studio] Estúdio de status (Android) — Dialog tela
 * cheia, P&B premium. Modo TEXTO (fundo cor/gradiente, 5 fontes, auto-ajuste
 * idêntico ao viewer, alinhamento, fundo da letra) e modo MÍDIA (palco 9:16,
 * filtros ColorMatrix, camadas, figurinhas interativas, desenho, legenda,
 * público). Resultado entregue UMA vez via [onResult].
 */
class StatusStudioDialog(
  private val host: Activity,
  private val opts: SSOptions,
  private val request: (String, String?, (Map<String, Any?>?) -> Unit) -> Unit,
  private val onResult: (Map<String, Any?>) -> Unit,
) : Dialog(host, android.R.style.Theme_Black_NoTitleBar), SSStageView.Host {

  companion object {
    private const val TAG = "ChatyyStatusStudio"
    private const val GLASS = 0x5C000000
  }

  private val main = Handler(Looper.getMainLooper())
  private var finished = false
  private var busy = false
  private var textMode = opts.textMode
  private var audience = opts.audience

  private lateinit var root: FrameLayout
  private lateinit var content: FrameLayout
  private lateinit var busyView: FrameLayout
  private var insTop = 0
  private var insBottom = 0
  private var insLeft = 0
  private var insRight = 0
  private var ime = 0

  // overlays (folhas, editor de texto) — voltar fecha o do topo
  private class Overlay(val view: FrameLayout, val card: View?, val padBase: Int, val onClose: (() -> Unit)?)
  private val overlays = ArrayList<Overlay>()

  // ── modo texto ──
  private var bgIdx = opts.bgIndex
  private var fontIdx = 0
  private var align = "center"
  private var letterBg = 0
  private var textBgView: View? = null
  private var textEdit: EditText? = null
  private var textPreview: TextView? = null
  private var textTop: LinearLayout? = null
  private var textBottom: LinearLayout? = null
  private var editArea: FrameLayout? = null
  private var counter: TextView? = null
  private var fontFlash: TextView? = null
  private var alignBtn: SSIconView? = null
  private var letterBtn: SSIconView? = null
  private var sendRound: FrameLayout? = null

  // ── modo mídia ──
  private val items = ArrayList<SSItemState>()
  private var cur = 0
  private var stage: SSStageView? = null
  private var stageW = 0
  private var stageH = 0
  private var stageLeft = 0
  private var stageTop = 0
  private var closeBtn: View? = null
  private var toolsCol: LinearLayout? = null
  private var filterToolBtn: View? = null
  private var drawBar: LinearLayout? = null
  private var drawPalette: HorizontalScrollView? = null
  private var sizeSlider: SSVSlider? = null
  private val brushBtns = HashMap<String, SSIconView>()
  private var filterStrip: HorizontalScrollView? = null
  private var filterRow: LinearLayout? = null
  private var filterOpen = false
  private var bottomPanel: LinearLayout? = null
  private var itemStrip: HorizontalScrollView? = null
  private var captionInput: EditText? = null
  private var audPill: LinearLayout? = null
  private var audIcon: SSIconView? = null
  private var audText: TextView? = null
  private var caption = ""
  private val factory by lazy { SSLayerViews(context, opts) }

  private var drawingOn = false
  private var bColor = Color.WHITE
  private var bWidthDp = 8f
  private var bType = "pen"
  private var dirtyMedia = false

  private val ticker = object : Runnable {
    override fun run() {
      stage?.tick()
      if (!finished) main.postDelayed(this, 1000)
    }
  }

  private val lifecycleCb = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityResumed(activity: Activity) { if (activity === host) stage?.resumeVideo() }
    override fun onActivityPaused(activity: Activity) { if (activity === host) stage?.pauseVideo() }
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {
      if (activity === host) finishWith(mapOf("action" to "cancel"))
    }
  }

  private fun L(key: String, fb: String): String = opts.t(key, fb)
  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, context.resources.displayMetrics).toInt()
  private fun dpf(v: Float): Float = v * context.resources.displayMetrics.density
  private fun haptic() { try { root.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY) } catch (_: Throwable) {} }

  // ─── ciclo de vida ────────────────────────────────────────────────────────

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    for (m in opts.items) {
      val st = SSItemState(m)
      st.filterIdx = m.filter?.let { id -> opts.filters.indexOfFirst { it.id == id } }?.takeIf { it > 0 } ?: 0
      items.add(st)
    }
    if (opts.music != null && items.isNotEmpty()) {
      val l = SSLayer(SSUtil.newId(), "music")
      l.track = opts.music
      l.u = -1f; l.v = 0.1f
      items[0].layers.add(l)
    }
    root = FrameLayout(context)
    root.setBackgroundColor(Color.BLACK)
    content = FrameLayout(context)
    root.addView(content, FrameLayout.LayoutParams(-1, -1))
    buildBusy()
    setContentView(root)
    setupWindow()
    setCancelable(true)
    setCanceledOnTouchOutside(false)
    try { host.application.registerActivityLifecycleCallbacks(lifecycleCb) } catch (_: Throwable) {}
    ViewCompat.setOnApplyWindowInsetsListener(root) { _, ins ->
      val bars = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val im = ins.getInsets(WindowInsetsCompat.Type.ime())
      val changed = bars.top != insTop || bars.bottom != insBottom || im.bottom != ime
      insTop = bars.top; insBottom = bars.bottom; insLeft = bars.left; insRight = bars.right
      ime = im.bottom
      if (changed) onInsets()
      ins
    }
    root.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, orr, ob ->
      if (r - l != orr - ol || b - t != ob - ot) main.post { onInsets(sizeChanged = true) }
    }
    if (textMode) buildTextMode() else buildMediaMode()
    main.postDelayed(ticker, 1000)
  }

  override fun onStart() {
    super.onStart()
    window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }

  private fun setupWindow() {
    val w = window ?: return
    w.setBackgroundDrawable(ColorDrawable(Color.BLACK))
    w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    ScreenProtectBridge.protect(w, false)
    @Suppress("DEPRECATION")
    w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING or WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN)
    WindowCompat.setDecorFitsSystemWindows(w, false)
    @Suppress("DEPRECATION")
    run {
      w.statusBarColor = Color.TRANSPARENT
      w.navigationBarColor = Color.TRANSPARENT
    }
    if (Build.VERSION.SDK_INT >= 28) {
      val a = w.attributes
      a.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      w.attributes = a
    }
    val ctl = WindowInsetsControllerCompat(w, w.decorView)
    ctl.isAppearanceLightStatusBars = false
    ctl.isAppearanceLightNavigationBars = false
  }

  private fun finishWith(result: Map<String, Any?>) {
    if (finished) return
    finished = true
    main.removeCallbacksAndMessages(null)
    try { stage?.setVideo(null) } catch (_: Throwable) {}
    try { host.application.unregisterActivityLifecycleCallbacks(lifecycleCb) } catch (_: Throwable) {}
    hideKeyboard()
    try { onResult(result) } catch (t: Throwable) { Log.w(TAG, "onResult: ${t.message}") }
    try { super.dismiss() } catch (_: Throwable) {}
  }

  override fun dismiss() {
    if (!finished) finishWith(mapOf("action" to "cancel")) else try { super.dismiss() } catch (_: Throwable) {}
  }

  fun closeFromJS() = finishWith(mapOf("action" to "cancel", "reason" to "js"))

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    if (busy) return
    if (overlays.isNotEmpty()) { closeOverlay(overlays.last()); return }
    if (drawingOn) { setDrawing(false); return }
    if (filterOpen) { setFilterOpen(false); return }
    if (textMode && ime > 0) { hideKeyboard(); return }
    requestClose()
  }

  private fun isDirty(): Boolean {
    if (textMode) return textEdit?.text?.isNotBlank() == true
    return items.isNotEmpty()
  }

  private fun requestClose() {
    if (!isDirty()) { finishWith(mapOf("action" to "cancel")); return }
    try {
      AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert)
        .setTitle(L("discardTitle", "Descartar status?"))
        .setPositiveButton(L("discard", "Descartar")) { _, _ -> finishWith(mapOf("action" to "cancel")) }
        .setNegativeButton(L("keep", "Continuar editando"), null)
        .show()
    } catch (_: Throwable) {
      finishWith(mapOf("action" to "cancel"))
    }
  }

  private fun hideKeyboard() {
    try {
      val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
      val v = window?.currentFocus ?: root
      imm?.hideSoftInputFromWindow(v.windowToken, 0)
      v.clearFocus()
    } catch (_: Throwable) {}
  }

  private fun showKeyboard(v: View) {
    v.post {
      v.requestFocus()
      try { (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(v, InputMethodManager.SHOW_IMPLICIT) } catch (_: Throwable) {}
    }
  }

  private fun onInsets(sizeChanged: Boolean = false) {
    for (o in overlays) {
      if (o.card != null) o.card.setPadding(o.card.paddingLeft, o.card.paddingTop, o.card.paddingRight, o.padBase + max(insBottom, ime))
      else o.view.setPadding(insLeft, insTop, insRight, max(insBottom, ime))
    }
    if (textMode) layoutTextMode() else layoutMedia(sizeChanged)
  }

  // ─── helpers de UI ────────────────────────────────────────────────────────

  private fun tv(sp: Float, color: Int = Color.WHITE, bold: Boolean = false): TextView {
    val t = TextView(context)
    t.setTextColor(color)
    t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    if (bold) t.typeface = Typeface.DEFAULT_BOLD
    t.includeFontPadding = false
    return t
  }

  private fun glassBtn(icon: String, desc: String, sizeDp: Float = 20f, boxDp: Float = 42f, onClick: () -> Unit): SSIconView {
    val b = SSIconView(context, icon, sizeDp)
    b.background = SSUtil.round(GLASS, dpf(boxDp / 2f))
    b.contentDescription = desc
    b.isClickable = true
    b.setOnClickListener { if (!busy) onClick() }
    b.layoutParams = LinearLayout.LayoutParams(dp(boxDp), dp(boxDp))
    return b
  }

  private fun glassText(text: String, desc: String, typeface: Typeface? = null, onClick: () -> Unit): TextView {
    val t = tv(16f, Color.WHITE, true)
    t.text = text
    if (typeface != null) t.typeface = typeface
    t.gravity = Gravity.CENTER
    t.background = SSUtil.round(GLASS, dpf(21f))
    t.contentDescription = desc
    t.setOnClickListener { if (!busy) onClick() }
    t.layoutParams = LinearLayout.LayoutParams(dp(42f), dp(42f))
    return t
  }

  private fun edit(hint: String, value: String, maxLen: Int, singleLine: Boolean = true): EditText {
    val e = EditText(context)
    e.setTextColor(Color.WHITE)
    e.setHintTextColor(Color.argb(120, 255, 255, 255))
    e.hint = hint
    e.setText(value)
    e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    e.background = SSUtil.round(Color.argb(26, 255, 255, 255), dpf(12f), Color.argb(36, 255, 255, 255), max(1, dp(1f)))
    e.setPadding(dp(14f), dp(11f), dp(14f), dp(11f))
    e.filters = arrayOf(InputFilter.LengthFilter(maxLen))
    e.inputType = if (singleLine) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    if (singleLine) e.maxLines = 1
    return e
  }

  private fun primaryBtn(text: String, onClick: () -> Unit): TextView {
    val b = tv(15f, Color.BLACK, true)
    b.text = text
    b.gravity = Gravity.CENTER
    b.background = SSUtil.round(Color.WHITE, dpf(22f))
    b.setOnClickListener { if (!busy) onClick() }
    return b
  }

  private fun buildBusy() {
    busyView = FrameLayout(context)
    busyView.setBackgroundColor(Color.argb(150, 0, 0, 0))
    busyView.isClickable = true
    val bl = LinearLayout(context)
    bl.orientation = LinearLayout.VERTICAL
    bl.gravity = Gravity.CENTER_HORIZONTAL
    val pb = ProgressBar(context)
    pb.indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
    bl.addView(pb, LinearLayout.LayoutParams(dp(40f), dp(40f)))
    val bt = tv(14f)
    bt.text = L("processing", "Preparando…")
    bt.setPadding(0, dp(12f), 0, 0)
    bl.addView(bt)
    busyView.addView(bl, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
    busyView.visibility = View.GONE
    root.addView(busyView, FrameLayout.LayoutParams(-1, -1))
  }

  private fun setBusy(b: Boolean) {
    busy = b
    busyView.visibility = if (b) View.VISIBLE else View.GONE
    busyView.bringToFront()
  }

  // ─── overlays (folhas) ────────────────────────────────────────────────────

  /** Folha inferior escura; build recebe o cartão (LinearLayout vertical). */
  private fun sheet(title: String?, onClose: (() -> Unit)? = null, build: (LinearLayout) -> Unit): FrameLayout {
    hideKeyboardIfNotSheet()
    val ov = FrameLayout(context)
    ov.setBackgroundColor(Color.argb(110, 0, 0, 0))
    ov.isClickable = true
    val card = LinearLayout(context)
    card.orientation = LinearLayout.VERTICAL
    card.isClickable = true
    val bg = GradientDrawable()
    bg.setColor(Color.rgb(28, 28, 30))
    val r = dpf(22f)
    bg.cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
    card.background = bg
    val padBase = dp(14f)
    card.setPadding(dp(16f), dp(8f), dp(16f), padBase + max(insBottom, ime))
    val handle = View(context)
    handle.background = SSUtil.round(Color.argb(70, 255, 255, 255), dpf(2.5f))
    card.addView(handle, LinearLayout.LayoutParams(dp(38f), dp(5f)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(12f) })
    if (!title.isNullOrEmpty()) {
      val t = tv(16f, Color.WHITE, true)
      t.text = title
      t.gravity = Gravity.CENTER
      card.addView(t, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12f) })
    }
    build(card)
    ov.addView(card, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
    val o = Overlay(ov, card, padBase, onClose)
    ov.setOnClickListener { closeOverlay(o) }
    root.addView(ov, FrameLayout.LayoutParams(-1, -1))
    busyView.bringToFront()
    overlays.add(o)
    card.translationY = dpf(400f)
    card.animate().translationY(0f).setDuration(220).start()
    return ov
  }

  private fun hideKeyboardIfNotSheet() { if (overlays.isEmpty()) hideKeyboard() }

  private fun closeOverlay(o: Overlay) {
    if (!overlays.remove(o)) return
    hideKeyboard()
    try { root.removeView(o.view) } catch (_: Throwable) {}
    try { o.onClose?.invoke() } catch (_: Throwable) {}
  }

  private fun closeTopOverlay() { overlays.lastOrNull()?.let { closeOverlay(it) } }

  private fun listScroll(card: LinearLayout, heightFrac: Float): LinearLayout {
    val sc = ScrollView(context)
    sc.isVerticalScrollBarEnabled = false
    val list = LinearLayout(context)
    list.orientation = LinearLayout.VERTICAL
    sc.addView(list, FrameLayout.LayoutParams(-1, -2))
    val h = (max(root.height, context.resources.displayMetrics.heightPixels) * heightFrac).toInt()
    card.addView(sc, LinearLayout.LayoutParams(-1, h))
    return list
  }

  // ─── público ──────────────────────────────────────────────────────────────

  private fun audienceIcon(a: String) = when (a) { "close_friends" -> "star"; "contacts" -> "users"; "except" -> "eyeOff"; else -> "globe" }
  private fun audienceLabel(a: String) = when (a) {
    "contacts" -> L("audContacts", "Meus contatos")
    "close_friends" -> L("audClose", "Melhores amigos")
    "except" -> L("audExcept", "Ocultar de…")
    else -> L("audAll", "Todos")
  }

  private fun makeAudPill(): LinearLayout {
    val p = LinearLayout(context)
    p.orientation = LinearLayout.HORIZONTAL
    p.gravity = Gravity.CENTER_VERTICAL
    p.setPadding(dp(12f), 0, dp(10f), 0)
    p.background = SSUtil.round(Color.argb(56, 0, 0, 0), dpf(20f), Color.argb(46, 255, 255, 255), max(1, dp(1f)))
    val ic = SSIconView(context, audienceIcon(audience), 15f)
    p.addView(ic, LinearLayout.LayoutParams(dp(18f), dp(18f)))
    val t = tv(14f, Color.WHITE, true)
    t.text = audienceLabel(audience)
    t.maxLines = 1
    p.addView(t, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(7f); rightMargin = dp(4f) })
    val ch = SSIconView(context, "chevronDown", 14f)
    ch.color = Color.argb(180, 255, 255, 255)
    p.addView(ch, LinearLayout.LayoutParams(dp(16f), dp(16f)))
    p.contentDescription = L("audienceTitle", "Quem pode ver")
    p.setOnClickListener { if (!busy) openAudience(false) }
    audIcon = ic
    audText = t
    return p
  }

  private fun paintAudience() {
    audIcon?.icon = audienceIcon(audience)
    audText?.text = audienceLabel(audience)
  }

  private fun openAudience(warn: Boolean) {
    hideKeyboard()
    sheet(L("audienceTitle", "Quem pode ver")) { card ->
      val rows = listOf(
        Triple("all", L("audAll", "Todos"), L("audAllSub", "Seus contatos e conversas")),
        Triple("contacts", L("audContacts", "Meus contatos"), L("audContactsSub", "Só quem está na sua agenda")),
        Triple("close_friends", L("audClose", "Melhores amigos"), L("audCloseSub", "Anel verde, só a sua lista")),
        Triple("except", L("audExcept", "Ocultar de…"), L("audExceptSub", "Todos, menos quem você escolher")),
      )
      for ((id, title, sub) in rows) {
        val row = LinearLayout(context)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(dp(4f), dp(10f), dp(4f), dp(10f))
        val ic = SSIconView(context, audienceIcon(id), 18f)
        ic.background = SSUtil.round(Color.argb(30, 255, 255, 255), dpf(18f))
        row.addView(ic, LinearLayout.LayoutParams(dp(36f), dp(36f)))
        val col = LinearLayout(context)
        col.orientation = LinearLayout.VERTICAL
        val t1 = tv(15f, Color.WHITE, true); t1.text = title
        val t2 = tv(12.5f, Color.argb(160, 255, 255, 255)); t2.text = sub
        col.addView(t1)
        col.addView(t2, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(3f) })
        if (id == "close_friends" && opts.closeFriendsCount == 0) {
          val wtxt = tv(12.5f, if (warn) Color.WHITE else Color.argb(200, 255, 255, 255), warn)
          wtxt.text = L("closeFriendsEmpty", "Sua lista está vazia. Toque em Editar para adicionar pessoas.")
          col.addView(wtxt, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(5f) })
        }
        row.addView(col, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(12f) })
        if (id == "close_friends" || (id == "except" && audience == "except")) {
          val ed = tv(13f, Color.WHITE, true)
          ed.text = L("audEdit", "Editar")
          ed.setPadding(dp(12f), dp(7f), dp(12f), dp(7f))
          ed.background = SSUtil.round(Color.argb(36, 255, 255, 255), dpf(14f))
          ed.setOnClickListener { finishWith(mapOf("action" to "editAudience", "which" to id)) }
          row.addView(ed, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(8f) })
        }
        val ck = SSIconView(context, "check", 18f)
        ck.visibility = if (audience == id) View.VISIBLE else View.INVISIBLE
        row.addView(ck, LinearLayout.LayoutParams(dp(24f), dp(24f)))
        row.setOnClickListener {
          audience = id
          haptic()
          paintAudience()
          closeTopOverlay()
        }
        card.addView(row, LinearLayout.LayoutParams(-1, -2))
      }
    }
    if (warn) try { root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) } catch (_: Throwable) {}
  }

  private fun audienceBlocked(): Boolean {
    if (audience == "close_friends" && opts.closeFriendsCount == 0) { openAudience(true); return true }
    return false
  }

  // ═══════════════════════════════ MODO TEXTO ═══════════════════════════════

  private fun curFont(): String = opts.fonts.getOrNull(fontIdx)?.id ?: "sans"

  private fun buildTextMode() {
    content.removeAllViews()
    stage = null
    val bgv = View(context)
    bgv.background = SSUtil.bgDrawable(opts.backgrounds.getOrNull(bgIdx))
    content.addView(bgv, FrameLayout.LayoutParams(-1, -1))
    textBgView = bgv

    val pv = TextView(context)
    pv.setTextColor(Color.WHITE)
    pv.gravity = Gravity.CENTER
    pv.includeFontPadding = false
    content.addView(pv, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER).apply { leftMargin = dp(24f); rightMargin = dp(24f) })
    textPreview = pv

    val area = FrameLayout(context)
    content.addView(area, FrameLayout.LayoutParams(-1, -1))
    editArea = area
    val et = EditText(context)
    et.background = null
    et.setPadding(0, 0, 0, 0)
    et.setTextColor(Color.WHITE)
    et.setHintTextColor(Color.argb(150, 255, 255, 255))
    et.hint = L("typeStatus", "Digite um status")
    et.gravity = Gravity.CENTER
    et.includeFontPadding = false
    et.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    et.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
    et.isVerticalScrollBarEnabled = false
    et.filters = arrayOf(InputFilter.LengthFilter(opts.textMax))
    try { et.textCursorDrawable = null } catch (_: Throwable) {}
    et.highlightColor = Color.argb(90, 255, 255, 255)
    et.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { applyLetterSpan(s); layoutTextMode() }
    })
    area.addView(et, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER).apply { leftMargin = dp(24f); rightMargin = dp(24f) })
    textEdit = et

    val ff = tv(22f, Color.WHITE, true)
    ff.setShadowLayer(dpf(6f), 0f, dpf(1f), Color.argb(150, 0, 0, 0))
    ff.alpha = 0f
    content.addView(ff, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL or Gravity.TOP))
    fontFlash = ff

    // topo
    val top = LinearLayout(context)
    top.orientation = LinearLayout.HORIZONTAL
    top.gravity = Gravity.CENTER_VERTICAL
    top.setPadding(dp(12f), 0, dp(12f), 0)
    top.addView(glassBtn("close", L("close", "Fechar")) { requestClose() })
    top.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    fun gap(v: View) { top.addView(v, LinearLayout.LayoutParams(dp(42f), dp(42f)).apply { leftMargin = dp(8f) }) }
    gap(glassText("Aa", L("font", "Trocar fonte")) { cycleFont() })
    gap(glassBtn("palette", L("color", "Trocar cor"), 19f) { cycleBg() })
    alignBtn = glassBtn("alignCenter", L("align", "Alinhamento"), 19f) { cycleAlign() }.also { gap(it) }
    letterBtn = glassBtn("textBg", L("textBg", "Fundo da letra"), 19f) { cycleLetterBg() }.also { gap(it) }
    if (opts.canGallery) gap(glassBtn("image", L("gallery", "Galeria"), 19f) { requestGallery() })
    if (opts.canCamera) gap(glassBtn("camera", L("camera", "Câmera"), 19f) { finishWith(mapOf("action" to "camera")) })
    content.addView(top, FrameLayout.LayoutParams(-1, dp(56f), Gravity.TOP))
    textTop = top

    // rodapé
    val bot = LinearLayout(context)
    bot.orientation = LinearLayout.HORIZONTAL
    bot.gravity = Gravity.CENTER_VERTICAL
    bot.setPadding(dp(14f), 0, dp(14f), 0)
    audPill = makeAudPill()
    bot.addView(audPill, LinearLayout.LayoutParams(-2, dp(38f)))
    bot.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    val cn = tv(13f, Color.argb(200, 255, 255, 255))
    bot.addView(cn, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(12f) })
    counter = cn
    val sr = FrameLayout(context)
    sr.background = SSUtil.round(Color.WHITE, dpf(25f))
    val si = SSIconView(context, "send", 21f)
    si.color = Color.BLACK
    sr.addView(si, FrameLayout.LayoutParams(-1, -1))
    sr.contentDescription = L("share", "Seu status")
    sr.setOnClickListener { if (!busy) publishText() }
    bot.addView(sr, LinearLayout.LayoutParams(dp(50f), dp(50f)))
    sendRound = sr
    content.addView(bot, FrameLayout.LayoutParams(-1, dp(66f), Gravity.BOTTOM))
    textBottom = bot

    content.setOnClickListener {
      if (busy) return@setOnClickListener
      if (ime > 0) hideKeyboard() else if (et.text.isNullOrEmpty()) showKeyboard(et) else cycleBg()
    }
    area.setOnTouchListener { _, ev ->
      // toque fora do texto cai no fundo (troca cor / fecha teclado)
      if (ev.actionMasked == MotionEvent.ACTION_UP) content.performClick()
      true
    }
    paintTextButtons()
    layoutTextMode()
    main.postDelayed({ if (!finished && textMode) showKeyboard(et) }, 250)
  }

  private fun shownText(): String {
    val s = textEdit?.text?.toString() ?: ""
    return if (curFont() == "condensed") s.uppercase() else s
  }

  private fun letterSpanColors(): Pair<Int, Int>? = when (letterBg) {
    1 -> Pair(Color.BLACK, Color.WHITE)
    2 -> Pair(Color.WHITE, Color.argb(115, 0, 0, 0))
    else -> null
  }

  private fun applyLetterSpan(s: Editable?) {
    if (s == null) return
    for (sp in s.getSpans(0, s.length, SSLineBgSpan::class.java)) s.removeSpan(sp)
    val c = letterSpanColors() ?: return
    if (s.isEmpty()) return
    val span = SSLineBgSpan(c.second, dpf(9f), dpf(2f), dpf(7f))
    span.alignment = SSText.alignment(align)
    s.setSpan(span, 0, s.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
  }

  private fun layoutTextMode() {
    val et = textEdit ?: return
    val pv = textPreview ?: return
    val w = root.width
    val h = root.height
    if (w <= 0 || h <= 0) { root.post { if (textMode) layoutTextMode() }; return }
    textTop?.let { it.layoutParams = (it.layoutParams as FrameLayout.LayoutParams).apply { topMargin = insTop }; it.requestLayout() }
    textBottom?.let { it.layoutParams = (it.layoutParams as FrameLayout.LayoutParams).apply { bottomMargin = max(insBottom, ime) }; it.requestLayout() }
    fontFlash?.let { (it.layoutParams as FrameLayout.LayoutParams).topMargin = insTop + dp(70f); it.requestLayout() }
    val font = curFont()
    val tf = SSUtil.typeface(font)
    val al = SSText.alignment(align)
    val colors = letterSpanColors()
    val len = et.text?.length ?: 0
    counter?.text = L("counter", "{n}/{max}").replace("{n}", len.toString()).replace("{max}", opts.textMax.toString())
    sendRound?.alpha = if (et.text.isNullOrBlank()) 0.45f else 1f
    val editing = ime > 0
    // campo de edição: cabe acima do teclado
    val areaTop = insTop + dp(56f)
    val areaBottom = max(insBottom, ime) + dp(66f)
    editArea?.setPadding(0, areaTop, 0, areaBottom)
    val areaH = max(dp(80f), h - areaTop - areaBottom)
    val raw = et.text?.toString() ?: ""
    val sp = SSText.fitSp(context, raw.ifEmpty { "x" }, font, w - dp(48f), (areaH * 0.92f).toInt(), al)
    et.typeface = tf
    et.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    et.setLineSpacing(0f, 1.12f)
    et.letterSpacing = if (font == "condensed") -0.02f else 0f
    et.gravity = SSText.gravity(align)
    et.setTextColor(colors?.first ?: Color.WHITE)
    et.maxHeight = areaH
    // prévia = layout do viewer (tela cheia, 70% da altura, 44→14)
    val shown = shownText()
    if (shown.isEmpty()) {
      pv.text = L("typeStatus", "Digite um status")
      pv.setTextColor(Color.argb(150, 255, 255, 255))
      pv.typeface = tf
      pv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 32f)
    } else {
      val psp = SSText.fitSp(context, shown, font, w - dp(48f), (h * 0.7f).toInt(), al)
      pv.typeface = tf
      pv.setTextSize(TypedValue.COMPLEX_UNIT_SP, psp)
      pv.setTextColor(colors?.first ?: Color.WHITE)
      if (colors != null) {
        val ss = SpannableString(shown)
        val span = SSLineBgSpan(colors.second, dpf(9f), dpf(2f), dpf(7f))
        span.alignment = al
        ss.setSpan(span, 0, shown.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        pv.text = ss
      } else {
        pv.text = shown
      }
    }
    pv.setLineSpacing(0f, 1.12f)
    pv.letterSpacing = if (font == "condensed") -0.02f else 0f
    pv.gravity = SSText.gravity(align)
    pv.visibility = if (editing) View.INVISIBLE else View.VISIBLE
    et.alpha = if (editing) 1f else 0f
  }

  private fun paintTextButtons() {
    alignBtn?.icon = when (align) { "left" -> "alignLeft"; "right" -> "alignRight"; else -> "alignCenter" }
    letterBtn?.let {
      it.background = SSUtil.round(if (letterBg != 0) Color.WHITE else GLASS, dpf(21f))
      it.color = if (letterBg != 0) Color.BLACK else Color.WHITE
    }
  }

  private fun cycleFont() {
    fontIdx = (fontIdx + 1) % max(1, opts.fonts.size)
    haptic()
    fontFlash?.let { f ->
      f.text = opts.fonts.getOrNull(fontIdx)?.label ?: ""
      f.typeface = SSUtil.typeface(curFont())
      f.animate().cancel()
      f.alpha = 1f
      f.animate().alpha(0f).setStartDelay(650).setDuration(250).start()
    }
    layoutTextMode()
  }

  private fun cycleBg() {
    bgIdx = (bgIdx + 1) % max(1, opts.backgrounds.size)
    haptic()
    textBgView?.background = SSUtil.bgDrawable(opts.backgrounds.getOrNull(bgIdx))
  }

  private fun cycleAlign() {
    align = when (align) { "center" -> "left"; "left" -> "right"; else -> "center" }
    haptic()
    applyLetterSpan(textEdit?.text)
    paintTextButtons()
    layoutTextMode()
  }

  private fun cycleLetterBg() {
    letterBg = (letterBg + 1) % 3
    haptic()
    applyLetterSpan(textEdit?.text)
    paintTextButtons()
    layoutTextMode()
  }

  private fun baseResult(): HashMap<String, Any?> = hashMapOf("action" to "publish", "audience" to audience)

  private fun publishText() {
    val txt = textEdit?.text?.toString() ?: ""
    if (txt.isBlank() || busy) return
    if (audienceBlocked()) return
    val bg = opts.backgrounds.getOrNull(bgIdx) ?: SSBackground("#111111", intArrayOf(Color.rgb(17, 17, 17)))
    // [status-texto 2026-10-16] alinhamento vai como meta.text_align (servidor + viewers entendem);
    // só o "fundo da letra" ainda precisa virar imagem.
    if (letterBg == 0) {
      val r = baseResult()
      r["caption"] = ""
      r["music"] = null
      r["text"] = mapOf("text" to txt.trim(), "bg" to bg.value, "font" to curFont(), "align" to align)
      finishWith(r)
      return
    }
    // alinhamento / fundo da letra → imagem idêntica à prévia
    setBusy(true)
    hideKeyboard()
    main.postDelayed({
      if (finished) return@postDelayed
      layoutTextMode()
      textPreview?.visibility = View.VISIBLE
      textPreview?.post { renderTextImage(bg) }
    }, 350)
  }

  private fun renderTextImage(bg: SSBackground) {
    val pv = textPreview ?: return
    val w = root.width
    val h = root.height
    if (w <= 0 || h <= 0) { setBusy(false); return }
    val outW = 1080
    val outH = (1080f * h / w).roundToInt()
    val bmp = try { Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888) } catch (_: Throwable) { null }
    if (bmp == null) { setBusy(false); return }
    val c = Canvas(bmp)
    val k = outW.toFloat() / w
    c.scale(k, k)
    val d = SSUtil.bgDrawable(bg)
    d.setBounds(0, 0, w, h)
    d.draw(c)
    c.save()
    c.translate(pv.left.toFloat(), pv.top.toFloat())
    pv.draw(c)
    c.restore()
    Thread {
      val f = SSExport.outFile(context, "jpg")
      val ok = SSExport.saveJpeg(bmp, f, 92)
      bmp.recycle()
      main.post {
        if (finished) return@post
        if (!ok) { setBusy(false); finishWith(mapOf("action" to "error", "error" to "export_failed")); return@post }
        val r = baseResult()
        r["caption"] = ""
        r["music"] = null
        r["items"] = listOf(mapOf(
          "kind" to "image", "uri" to "file://" + f.absolutePath, "width" to outW, "height" to outH, "mime" to "image/jpeg",
          "stickers" to emptyList<Any>(), "textOverlays" to emptyList<Any>(), "drawPaths" to emptyList<Any>(), "mentions" to emptyList<Any>(),
        ))
        finishWith(r)
      }
    }.start()
  }

  private fun requestGallery() {
    if (busy) return
    hideKeyboard()
    request("gallery", null) { data ->
      if (finished) return@request
      val list = (data?.get("items") as? List<*>) ?: emptyList<Any>()
      val add = ArrayList<SSMediaIn>()
      for (raw in list) {
        val m = raw as? Map<*, *> ?: continue
        val uri = m["uri"] as? String ?: continue
        if (uri.isEmpty()) continue
        add.add(SSMediaIn(uri, (m["type"] as? String) == "video", (m["width"] as? Number)?.toInt() ?: 0, (m["height"] as? Number)?.toInt() ?: 0, null, false))
      }
      val room = max(0, 10 - items.size)
      val acc = add.take(room)
      if (acc.isEmpty()) return@request
      val start = items.size
      for (m in acc) items.add(SSItemState(m))
      if (textMode) {
        textMode = false
        cur = start
        buildMediaMode()
      } else {
        rebuildItemStrip()
        selectItem(start)
      }
    }
  }

  // ═══════════════════════════════ MODO MÍDIA ═══════════════════════════════

  private val curItem: SSItemState? get() = items.getOrNull(cur)

  override val layers: MutableList<SSLayer> get() = curItem?.layers ?: ArrayList()
  override val strokes: MutableList<SSStroke> get() = curItem?.strokes ?: ArrayList()
  override val drawing: Boolean get() = drawingOn
  override val brushColor: Int get() = bColor
  override val brushWidthPx: Float get() = dpf(bWidthDp)
  override val brushType: String get() = bType

  override fun canSwipeFilter(): Boolean = curItem?.src?.isVideo == false && curItem?.preview != null && opts.filters.size > 1

  override fun neighborMatrix(dir: Int): Pair<Boolean, FloatArray?> {
    val it = curItem ?: return Pair(false, null)
    val n = it.filterIdx + dir
    if (n < 0 || n >= opts.filters.size) return Pair(false, null)
    return Pair(true, opts.filters[n].androidMatrix())
  }

  override fun onSwipeFilter(dir: Int) {
    val it = curItem ?: return
    val n = (it.filterIdx + dir).coerceIn(0, opts.filters.size - 1)
    if (n == it.filterIdx) return
    pickFilter(n)
  }

  override fun onTapEmpty() {
    if (filterOpen) { setFilterOpen(false); return }
    if (captionInput?.hasFocus() == true || ime > 0) { hideKeyboard(); return }
    openTextEditor(null)
  }

  override fun onTapLayer(l: SSLayer) {
    when (l.kind) {
      "text" -> openTextEditor(l)
      "poll" -> openPollForm(l)
      "question" -> openQuestionForm(l)
      "countdown" -> openCountdownForm(l)
      "link" -> openLinkForm(l)
      "location" -> openLocationForm(l)
      "mention" -> openMentionPicker(l)
      "music" -> openMusicPicker()
    }
  }

  override fun onDragState(active: Boolean) {
    val a = if (active) 0f else 1f
    toolsCol?.animate()?.alpha(a)?.setDuration(120)?.start()
    closeBtn?.animate()?.alpha(a)?.setDuration(120)?.start()
    bottomPanel?.animate()?.alpha(if (active) 0.25f else 1f)?.setDuration(120)?.start()
    dirtyMedia = true
  }

  override fun onLayerDeleted(l: SSLayer) {
    curItem?.layers?.remove(l)
    stage?.removeLayerView(l)
    try { root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) } catch (_: Throwable) {}
  }

  override fun onStrokeAdded() { dirtyMedia = true }

  private fun buildMediaMode() {
    content.removeAllViews()
    content.setOnClickListener(null)
    textEdit = null; textPreview = null; textTop = null; textBottom = null; editArea = null
    val st = SSStageView(context, this, factory)
    st.clipToOutline = true
    st.background = SSUtil.round(Color.BLACK, dpf(16f))
    st.outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
    content.addView(st, FrameLayout.LayoutParams(dp(100f), dp(178f), Gravity.TOP or Gravity.START))
    stage = st

    // fechar
    val cb = glassBtn("close", L("close", "Fechar")) { requestClose() }
    content.addView(cb, FrameLayout.LayoutParams(dp(42f), dp(42f), Gravity.TOP or Gravity.START))
    closeBtn = cb

    // coluna de ferramentas (direita, estilo Instagram)
    val col = LinearLayout(context)
    col.orientation = LinearLayout.VERTICAL
    col.gravity = Gravity.CENTER_HORIZONTAL
    fun add(v: View) { col.addView(v, LinearLayout.LayoutParams(dp(42f), dp(42f)).apply { bottomMargin = dp(10f) }) }
    add(glassText("Aa", L("text", "Texto")) { openTextEditor(null) })
    add(glassBtn("sticker", L("stickers", "Figurinhas")) { openStickerTray() })
    add(glassBtn("draw", L("draw", "Desenhar")) { setDrawing(true) })
    val fb = glassBtn("filter", L("filters", "Filtros")) { setFilterOpen(!filterOpen) }
    add(fb)
    filterToolBtn = fb
    add(glassBtn("music", L("music", "Música")) { openMusicPicker() })
    content.addView(col, FrameLayout.LayoutParams(dp(42f), -2, Gravity.TOP or Gravity.START))
    toolsCol = col

    buildDrawBar()
    buildFilterStrip()
    buildBottomPanel()
    layoutMedia(true)
    selectItem(cur.coerceIn(0, max(0, items.size - 1)))
  }

  private fun layoutMedia(sizeChanged: Boolean) {
    val st = stage ?: return
    val w = root.width
    val h = root.height
    if (w <= 0 || h <= 0) { root.post { if (!textMode) layoutMedia(true) }; return }
    val stripH = if (items.size > 1) dp(60f) else 0
    val panelH = dp(52f) + dp(58f) + stripH
    val top = insTop + dp(6f)
    val availH = h - top - panelH - insBottom - dp(6f)
    var sh = min(availH, (w * 16f / 9f).toInt())
    var sw = (sh * 9f / 16f).toInt()
    if (sw > w) { sw = w; sh = (w * 16f / 9f).toInt() }
    val left = (w - sw) / 2
    val changed = sw != stageW || sh != stageH
    stageW = sw; stageH = sh; stageLeft = left; stageTop = top
    st.k = sw.toFloat() / w
    (st.layoutParams as FrameLayout.LayoutParams).let { it.width = sw; it.height = sh; it.leftMargin = left; it.topMargin = top }
    st.requestLayout()
    (closeBtn?.layoutParams as? FrameLayout.LayoutParams)?.let { it.leftMargin = left + dp(10f); it.topMargin = top + dp(10f) }
    (toolsCol?.layoutParams as? FrameLayout.LayoutParams)?.let { it.leftMargin = left + sw - dp(52f); it.topMargin = top + dp(10f) }
    (drawBar?.layoutParams as? FrameLayout.LayoutParams)?.let { it.width = sw; it.leftMargin = left; it.topMargin = top + dp(8f) }
    (drawPalette?.layoutParams as? FrameLayout.LayoutParams)?.let { it.width = sw; it.leftMargin = left; it.topMargin = top + sh - dp(56f) }
    (sizeSlider?.layoutParams as? FrameLayout.LayoutParams)?.let { it.leftMargin = left + dp(6f); it.topMargin = top + sh / 2 - dp(110f) }
    (filterStrip?.layoutParams as? FrameLayout.LayoutParams)?.let { it.width = sw; it.leftMargin = left; it.topMargin = top + sh - dp(104f) }
    bottomPanel?.let { bp ->
      (bp.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = top + sh + dp(4f); it.height = panelH }
      itemStrip?.visibility = if (items.size > 1) View.VISIBLE else View.GONE
      // legenda focada: painel sobe acima do teclado
      val lift = if (ime > 0 && captionInput?.hasFocus() == true) {
        val bottomOfPanel = top + sh + dp(4f) + panelH
        max(0, bottomOfPanel - (h - ime))
      } else 0
      bp.translationY = -lift.toFloat()
      bp.requestLayout()
    }
    content.requestLayout()
    if (changed && sizeChanged) st.post { st.rebuildLayers() }
  }

  private fun buildBottomPanel() {
    val bp = LinearLayout(context)
    bp.orientation = LinearLayout.VERTICAL
    bp.setPadding(dp(12f), 0, dp(12f), 0)
    bp.setBackgroundColor(Color.BLACK)

    val strip = HorizontalScrollView(context)
    strip.isHorizontalScrollBarEnabled = false
    bp.addView(strip, LinearLayout.LayoutParams(-1, dp(60f)))
    itemStrip = strip

    val cap = LinearLayout(context)
    cap.orientation = LinearLayout.HORIZONTAL
    cap.gravity = Gravity.CENTER_VERTICAL
    if (opts.canGallery) {
      val g = glassBtn("image", L("gallery", "Galeria"), 19f, 40f) { if (items.size < 10) requestGallery() }
      g.background = SSUtil.round(Color.argb(36, 255, 255, 255), dpf(20f))
      cap.addView(g, LinearLayout.LayoutParams(dp(40f), dp(40f)).apply { rightMargin = dp(8f) })
    }
    val ci = EditText(context)
    ci.setTextColor(Color.WHITE)
    ci.setHintTextColor(Color.argb(140, 255, 255, 255))
    ci.hint = L("captionPlaceholder", "Adicionar legenda…")
    ci.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    ci.background = SSUtil.round(Color.argb(26, 255, 255, 255), dpf(20f), Color.argb(40, 255, 255, 255), max(1, dp(1f)))
    ci.setPadding(dp(16f), dp(8f), dp(16f), dp(8f))
    ci.maxLines = 2
    ci.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    ci.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
    ci.filters = arrayOf(InputFilter.LengthFilter(500))
    ci.setText(caption)
    ci.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { caption = s?.toString() ?: "" }
    })
    ci.setOnFocusChangeListener { _, _ -> main.post { layoutMedia(false) } }
    cap.addView(ci, LinearLayout.LayoutParams(0, -2, 1f))
    captionInput = ci
    bp.addView(cap, LinearLayout.LayoutParams(-1, dp(52f)))

    val act = LinearLayout(context)
    act.orientation = LinearLayout.HORIZONTAL
    act.gravity = Gravity.CENTER_VERTICAL
    audPill = makeAudPill()
    act.addView(audPill, LinearLayout.LayoutParams(-2, dp(38f)))
    act.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    val share = LinearLayout(context)
    share.orientation = LinearLayout.HORIZONTAL
    share.gravity = Gravity.CENTER_VERTICAL
    share.setPadding(dp(18f), 0, dp(16f), 0)
    share.background = SSUtil.round(Color.WHITE, dpf(21f))
    val stx = tv(15f, Color.BLACK, true)
    stx.text = L("share", "Seu status")
    share.addView(stx)
    val si = SSIconView(context, "send", 16f)
    si.color = Color.BLACK
    share.addView(si, LinearLayout.LayoutParams(dp(20f), dp(20f)).apply { leftMargin = dp(8f) })
    share.contentDescription = L("share", "Seu status")
    share.setOnClickListener { if (!busy) publishMedia() }
    act.addView(share, LinearLayout.LayoutParams(-2, dp(42f)))
    bp.addView(act, LinearLayout.LayoutParams(-1, dp(58f)))

    content.addView(bp, FrameLayout.LayoutParams(-1, dp(110f), Gravity.TOP))
    bottomPanel = bp
    rebuildItemStrip()
  }

  private fun rebuildItemStrip() {
    val strip = itemStrip ?: return
    strip.removeAllViews()
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    for ((i, it) in items.withIndex()) {
      val fr = FrameLayout(context)
      fr.background = SSUtil.round(Color.argb(40, 255, 255, 255), dpf(8f), if (i == cur) Color.WHITE else Color.TRANSPARENT, dp(2f))
      fr.setPadding(dp(2f), dp(2f), dp(2f), dp(2f))
      val iv = ImageView(context)
      iv.scaleType = ImageView.ScaleType.CENTER_CROP
      iv.clipToOutline = true
      iv.background = SSUtil.round(Color.DKGRAY, dpf(6f))
      iv.outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
      it.thumb?.let { b -> iv.setImageBitmap(b) }
      opts.filters.getOrNull(it.filterIdx)?.androidMatrix()?.let { m -> iv.colorFilter = ColorMatrixColorFilter(ColorMatrix(m)) }
      fr.addView(iv, FrameLayout.LayoutParams(-1, -1))
      fr.setOnClickListener { if (!busy && i != cur) selectItem(i) }
      row.addView(fr, LinearLayout.LayoutParams(dp(40f), dp(50f)).apply { rightMargin = dp(8f) })
    }
    if (opts.canGallery && items.size < 10) {
      val plus = SSIconView(context, "plus", 20f)
      plus.background = SSUtil.round(Color.argb(36, 255, 255, 255), dpf(8f))
      plus.setOnClickListener { if (!busy) requestGallery() }
      row.addView(plus, LinearLayout.LayoutParams(dp(40f), dp(50f)))
    }
    strip.addView(row)
  }

  private fun selectItem(i: Int) {
    val st = stage ?: return
    if (items.isEmpty()) return
    cur = i.coerceIn(0, items.size - 1)
    val it = items[cur]
    setFilterOpen(false)
    filterToolBtn?.visibility = if (it.src.isVideo || opts.filters.size <= 1) View.GONE else View.VISIBLE
    st.bgView.setBackgroundColor(it.bgColor)
    if (it.src.isVideo) {
      st.bitmap = null
      st.setFilter(null)
      st.setVideo(it.src.uri)
    } else {
      st.setVideo(null)
      st.bitmap = it.preview
      st.setFilter(opts.filters.getOrNull(it.filterIdx)?.androidMatrix())
    }
    st.rebuildLayers()
    st.redrawStrokes()
    rebuildItemStrip()
    layoutMedia(false)
    ensureLoaded(cur)
    for (k in items.indices) if (k != cur) ensureThumb(items[k])
  }

  /** Prévia (tela) só da mídia atual — as outras soltam a prévia e ficam com miniatura (memória). */
  private fun ensureLoaded(i: Int) {
    for ((k, other) in items.withIndex()) if (k != i && other.preview != null) { other.preview = null; other.previewLoading = false }
    val it = items.getOrNull(i) ?: return
    if (it.src.isVideo) { if (it.thumb == null) ensureThumb(it); return }
    if (it.preview != null || it.previewLoading) return
    it.previewLoading = true
    val dm = context.resources.displayMetrics
    val prevDim = min(2048, max(1280, (max(dm.widthPixels, dm.heightPixels) * 1.05f).toInt()))
    Thread {
      val b = SSExport.decode(context, it.src.uri, prevDim)
      val th = b?.let { bb ->
        val k = 160f / max(bb.width, bb.height)
        try { Bitmap.createScaledBitmap(bb, max(1, (bb.width * k).toInt()), max(1, (bb.height * k).toInt()), true) } catch (_: Throwable) { null }
      }
      val bg = SSExport.stageBackground(th)
      main.post {
        if (finished) return@post
        it.previewLoading = false
        if (items.getOrNull(cur) !== it) return@post
        it.preview = b
        if (it.thumb == null) it.thumb = th
        it.bgColor = bg
        if (stage != null) {
          stage?.bgView?.setBackgroundColor(bg)
          stage?.bitmap = b
          if (filterOpen) rebuildFilterRow()
        }
        rebuildItemStrip()
      }
    }.start()
  }

  private fun ensureThumb(it: SSItemState) {
    if (it.thumb != null || it.thumbLoading) return
    it.thumbLoading = true
    Thread {
      val th = if (it.src.isVideo) SSExport.videoFrame(context, it.src.uri, 200) else SSExport.decode(context, it.src.uri, 200)
      val bg = if (it.src.isVideo) Color.BLACK else SSExport.stageBackground(th)
      main.post {
        if (finished) return@post
        it.thumbLoading = false
        it.thumb = th
        it.bgColor = bg
        if (items.getOrNull(cur) === it) stage?.bgView?.setBackgroundColor(bg)
        rebuildItemStrip()
      }
    }.start()
  }

  // ─── filtros ──────────────────────────────────────────────────────────────

  private fun buildFilterStrip() {
    val sc = HorizontalScrollView(context)
    sc.isHorizontalScrollBarEnabled = false
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.setPadding(dp(8f), dp(4f), dp(8f), dp(4f))
    sc.addView(row)
    sc.visibility = View.GONE
    content.addView(sc, FrameLayout.LayoutParams(dp(100f), dp(96f), Gravity.TOP or Gravity.START))
    filterStrip = sc
    filterRow = row
  }

  private fun setFilterOpen(open: Boolean) {
    filterOpen = open && curItem?.src?.isVideo == false
    filterStrip?.visibility = if (filterOpen) View.VISIBLE else View.GONE
    (filterToolBtn as? SSIconView)?.let {
      it.background = SSUtil.round(if (filterOpen) Color.WHITE else GLASS, dpf(21f))
      it.color = if (filterOpen) Color.BLACK else Color.WHITE
    }
    if (filterOpen) rebuildFilterRow()
  }

  private fun rebuildFilterRow() {
    val row = filterRow ?: return
    row.removeAllViews()
    val it = curItem ?: return
    val thumb = it.thumb
    for ((i, f) in opts.filters.withIndex()) {
      val cell = LinearLayout(context)
      cell.orientation = LinearLayout.VERTICAL
      cell.gravity = Gravity.CENTER_HORIZONTAL
      val fr = FrameLayout(context)
      fr.setPadding(dp(2f), dp(2f), dp(2f), dp(2f))
      fr.background = SSUtil.round(Color.TRANSPARENT, dpf(12f), if (i == it.filterIdx) Color.WHITE else Color.TRANSPARENT, dp(2f))
      val iv = ImageView(context)
      iv.scaleType = ImageView.ScaleType.CENTER_CROP
      if (thumb != null) iv.setImageBitmap(thumb)
      f.androidMatrix()?.let { m -> iv.colorFilter = ColorMatrixColorFilter(ColorMatrix(m)) }
      iv.clipToOutline = true
      iv.background = SSUtil.round(Color.DKGRAY, dpf(10f))
      iv.outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
      fr.addView(iv, FrameLayout.LayoutParams(-1, -1))
      cell.addView(fr, LinearLayout.LayoutParams(dp(58f), dp(58f)))
      val lb = tv(11f, Color.WHITE, i == it.filterIdx)
      lb.text = f.label
      lb.gravity = Gravity.CENTER
      lb.maxLines = 1
      lb.setShadowLayer(dpf(3f), 0f, 0f, Color.BLACK)
      lb.setPadding(0, dp(4f), 0, 0)
      cell.addView(lb, LinearLayout.LayoutParams(dp(64f), -2))
      cell.contentDescription = f.label
      cell.setOnClickListener { pickFilter(i) }
      row.addView(cell, LinearLayout.LayoutParams(dp(66f), -2))
    }
  }

  private fun pickFilter(i: Int) {
    val it = curItem ?: return
    it.filterIdx = i.coerceIn(0, opts.filters.size - 1)
    stage?.setFilter(opts.filters[it.filterIdx].androidMatrix())
    stage?.showFlash(opts.filters[it.filterIdx].label)
    try { root.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) } catch (_: Throwable) {}
    dirtyMedia = true
    if (filterOpen) rebuildFilterRow()
    rebuildItemStrip()
  }

  // ─── desenho ──────────────────────────────────────────────────────────────

  private fun buildDrawBar() {
    val bar = LinearLayout(context)
    bar.orientation = LinearLayout.HORIZONTAL
    bar.gravity = Gravity.CENTER_VERTICAL
    bar.setPadding(dp(10f), 0, dp(10f), 0)
    bar.addView(glassBtn("undo", L("undo", "Desfazer"), 19f, 40f) {
      val s = curItem?.strokes ?: return@glassBtn
      if (s.isNotEmpty()) { s.removeAt(s.size - 1); stage?.redrawStrokes(); haptic() }
    }, LinearLayout.LayoutParams(dp(40f), dp(40f)))
    bar.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    val video = curItem?.src?.isVideo == true
    for ((id, icon, lab) in listOf(
      Triple("pen", "pen", L("brushPen", "Caneta")),
      Triple("marker", "marker", L("brushMarker", "Marca-texto")),
      Triple("neon", "neon", L("brushNeon", "Neon")),
      Triple("eraser", "eraser", L("brushEraser", "Borracha")),
    )) {
      if (video && id == "eraser") continue
      val b = glassBtn(icon, lab, 18f, 38f) { bType = id; paintBrushes(); haptic() }
      brushBtns[id] = b
      bar.addView(b, LinearLayout.LayoutParams(dp(38f), dp(38f)).apply { leftMargin = dp(6f) })
    }
    bar.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    val done = primaryBtn(L("done", "Concluir")) { setDrawing(false) }
    done.setPadding(dp(16f), 0, dp(16f), 0)
    bar.addView(done, LinearLayout.LayoutParams(-2, dp(38f)))
    bar.visibility = View.GONE
    content.addView(bar, FrameLayout.LayoutParams(dp(100f), dp(48f), Gravity.TOP or Gravity.START))
    drawBar = bar

    val pal = paletteRow(bColor) { c -> bColor = c; if (bType == "eraser") bType = "pen"; paintBrushes() }
    pal.visibility = View.GONE
    content.addView(pal, FrameLayout.LayoutParams(dp(100f), dp(48f), Gravity.TOP or Gravity.START))
    drawPalette = pal

    val sl = SSVSlider(context)
    sl.value = (bWidthDp - 3f) / 27f
    sl.onChange = { v -> bWidthDp = 3f + v * 27f }
    sl.visibility = View.GONE
    content.addView(sl, FrameLayout.LayoutParams(dp(34f), dp(220f), Gravity.TOP or Gravity.START))
    sizeSlider = sl
    paintBrushes()
  }

  private fun paintBrushes() {
    for ((id, b) in brushBtns) {
      val on = id == bType
      b.background = SSUtil.round(if (on) Color.WHITE else GLASS, dpf(19f))
      b.color = if (on) Color.BLACK else Color.WHITE
    }
  }

  private fun setDrawing(on: Boolean) {
    drawingOn = on
    if (on) { hideKeyboard(); setFilterOpen(false) }
    val v = if (on) View.VISIBLE else View.GONE
    drawBar?.visibility = v
    drawPalette?.visibility = v
    sizeSlider?.visibility = v
    toolsCol?.visibility = if (on) View.GONE else View.VISIBLE
    closeBtn?.visibility = if (on) View.GONE else View.VISIBLE
    bottomPanel?.alpha = if (on) 0.3f else 1f
    bottomPanel?.isEnabled = !on
    // vídeo não tem borracha (draw_paths do viewer = traço simples)
    if (on && curItem?.src?.isVideo == true && bType == "eraser") { bType = "pen"; paintBrushes() }
    brushBtns["eraser"]?.visibility = if (curItem?.src?.isVideo == true) View.GONE else View.VISIBLE
  }

  private fun paletteRow(selected: Int, onPick: (Int) -> Unit): HorizontalScrollView {
    val sc = HorizontalScrollView(context)
    sc.isHorizontalScrollBarEnabled = false
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    row.setPadding(dp(10f), 0, dp(10f), 0)
    val dots = ArrayList<View>()
    fun paint(sel: Int) {
      for ((i, d) in dots.withIndex()) {
        val c = opts.palette[i]
        val on = c == sel
        val g = GradientDrawable()
        g.shape = GradientDrawable.OVAL
        g.setColor(c)
        g.setStroke(dp(if (on) 3f else 2f), if (on) Color.WHITE else Color.argb(160, 255, 255, 255))
        d.background = g
        d.scaleX = if (on) 1.15f else 1f
        d.scaleY = d.scaleX
      }
    }
    for (c in opts.palette) {
      val d = View(context)
      d.setOnClickListener { onPick(c); paint(c); haptic() }
      dots.add(d)
      row.addView(d, LinearLayout.LayoutParams(dp(28f), dp(28f)).apply { rightMargin = dp(10f) })
    }
    paint(selected)
    sc.addView(row, FrameLayout.LayoutParams(-2, -1))
    return sc
  }

  // ─── editor de texto (camada) ─────────────────────────────────────────────

  private fun openTextEditor(existing: SSLayer?) {
    if (drawingOn) return
    hideKeyboard()
    var font = existing?.font ?: "sans"
    var color = existing?.color ?: Color.WHITE
    var bg = existing?.bg ?: 0
    var al = existing?.align ?: "center"
    existing?.let { stage?.layerView(it)?.visibility = View.INVISIBLE }

    val ov = FrameLayout(context)
    ov.setBackgroundColor(Color.argb(166, 0, 0, 0))
    ov.isClickable = true
    val col = LinearLayout(context)
    col.orientation = LinearLayout.VERTICAL
    ov.addView(col, FrameLayout.LayoutParams(-1, -1))

    val et = EditText(context)
    lateinit var o: Overlay
    val chips = ArrayList<TextView>()
    val alignB = glassBtn("alignCenter", L("align", "Alinhamento"), 18f, 40f) {}
    val bgB = glassBtn("textBg", L("textBg", "Fundo da letra"), 18f, 40f) {}

    fun restyle() {
      et.typeface = SSUtil.typeface(font)
      et.gravity = SSText.gravity(al)
      et.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
      when (bg) {
        1 -> { et.setTextColor(SSUtil.contrastOn(color)); et.background = SSUtil.round(color, dpf(8f)); et.setShadowLayer(0f, 0f, 0f, 0) }
        2 -> { et.setTextColor(color); et.background = SSUtil.round(Color.argb(115, 0, 0, 0), dpf(8f)); et.setShadowLayer(0f, 0f, 0f, 0) }
        else -> { et.setTextColor(color); et.background = null; et.setShadowLayer(dpf(4f), 0f, dpf(1f), Color.argb(140, 0, 0, 0)) }
      }
      et.setPadding(dp(12f), dp(6f), dp(12f), dp(6f))
      for ((i, c) in chips.withIndex()) {
        val on = opts.fonts.getOrNull(i)?.id == font
        c.background = SSUtil.round(if (on) Color.WHITE else Color.argb(46, 255, 255, 255), dpf(15f))
        c.setTextColor(if (on) Color.BLACK else Color.WHITE)
      }
      alignB.icon = when (al) { "left" -> "alignLeft"; "right" -> "alignRight"; else -> "alignCenter" }
      bgB.background = SSUtil.round(if (bg != 0) Color.WHITE else GLASS, dpf(20f))
      bgB.color = if (bg != 0) Color.BLACK else Color.WHITE
    }

    var committed = false
    fun commit() {
      if (committed) return
      committed = true
      val text = et.text?.toString()?.trim() ?: ""
      closeOverlay(o)
      val stg = stage ?: return
      if (existing != null) {
        stg.layerView(existing)?.visibility = View.VISIBLE
        if (text.isEmpty()) { onLayerDeleted(existing); return }
        existing.text = text; existing.font = font; existing.color = color; existing.bg = bg; existing.align = al
        stg.refreshLayer(existing)
      } else if (text.isNotEmpty()) {
        val l = SSLayer(SSUtil.newId(), "text")
        l.text = text; l.font = font; l.color = color; l.bg = bg; l.align = al
        val n = curItem?.layers?.count { it.burnable } ?: 0
        l.u = 0.5f; l.v = 0.36f + 0.06f * (n % 5)
        curItem?.layers?.add(l)
        stg.addLayerView(l)
      }
      dirtyMedia = true
    }

    // topo: fontes + concluir
    val top = LinearLayout(context)
    top.orientation = LinearLayout.HORIZONTAL
    top.gravity = Gravity.CENTER_VERTICAL
    top.setPadding(dp(10f), 0, dp(10f), 0)
    val fsc = HorizontalScrollView(context)
    fsc.isHorizontalScrollBarEnabled = false
    val frow = LinearLayout(context)
    frow.orientation = LinearLayout.HORIZONTAL
    for (f in opts.fonts) {
      val c = tv(14f, Color.WHITE)
      c.text = f.label
      c.typeface = SSUtil.typeface(f.id)
      c.gravity = Gravity.CENTER
      c.setPadding(dp(12f), 0, dp(12f), 0)
      c.setOnClickListener { font = f.id; restyle(); haptic() }
      chips.add(c)
      frow.addView(c, LinearLayout.LayoutParams(-2, dp(30f)).apply { rightMargin = dp(6f) })
    }
    fsc.addView(frow)
    top.addView(fsc, LinearLayout.LayoutParams(0, -2, 1f))
    val done = primaryBtn(L("done", "Concluir")) { commit() }
    done.setPadding(dp(16f), 0, dp(16f), 0)
    top.addView(done, LinearLayout.LayoutParams(-2, dp(36f)).apply { leftMargin = dp(8f) })
    col.addView(top, LinearLayout.LayoutParams(-1, dp(52f)))

    val row2 = LinearLayout(context)
    row2.orientation = LinearLayout.HORIZONTAL
    row2.gravity = Gravity.CENTER
    alignB.setOnClickListener { al = when (al) { "center" -> "left"; "left" -> "right"; else -> "center" }; restyle(); haptic() }
    bgB.setOnClickListener { bg = (bg + 1) % 3; restyle(); haptic() }
    row2.addView(alignB, LinearLayout.LayoutParams(dp(40f), dp(40f)).apply { rightMargin = dp(12f) })
    row2.addView(bgB, LinearLayout.LayoutParams(dp(40f), dp(40f)))
    col.addView(row2, LinearLayout.LayoutParams(-1, dp(48f)))

    val mid = FrameLayout(context)
    et.setText(existing?.text ?: "")
    et.hint = L("textPlaceholder", "Digite algo…")
    et.setHintTextColor(Color.argb(140, 255, 255, 255))
    et.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    et.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
    et.filters = arrayOf(InputFilter.LengthFilter(300))
    et.maxWidth = (max(stageW, dp(200f)) * 0.9f).toInt()
    mid.addView(et, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
    mid.setOnClickListener { commit() }
    col.addView(mid, LinearLayout.LayoutParams(-1, 0, 1f))

    val pal = paletteRow(color) { c -> color = c; restyle() }
    col.addView(pal, LinearLayout.LayoutParams(-1, dp(52f)))

    // voltar / toque fora = concluir
    o = Overlay(ov, null, 0) { commit() }
    ov.setPadding(insLeft, insTop, insRight, max(insBottom, ime))
    root.addView(ov, FrameLayout.LayoutParams(-1, -1))
    overlays.add(o)
    busyView.bringToFront()
    restyle()
    if (existing != null) et.setSelection(et.text?.length ?: 0)
    showKeyboard(et)
  }

  // ─── figurinhas ───────────────────────────────────────────────────────────

  private fun openStickerTray() {
    if (drawingOn) return
    sheet(null) { card ->
      val tiles = listOf(
        Triple("mention", "at", L("mention", "Menção")),
        Triple("location", "pin", L("location", "Local")),
        Triple("link", "link", L("link", "Link")),
        Triple("poll", "poll", L("poll", "Enquete")),
        Triple("question", "question", L("question", "Pergunta")),
        Triple("countdown", "clock", L("countdown", "Contagem")),
        Triple("music", "music", L("music", "Música")),
      )
      var row: LinearLayout? = null
      for ((i, t) in tiles.withIndex()) {
        if (i % 4 == 0) {
          row = LinearLayout(context)
          row.orientation = LinearLayout.HORIZONTAL
          card.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8f) })
        }
        val chip = LinearLayout(context)
        chip.orientation = LinearLayout.HORIZONTAL
        chip.gravity = Gravity.CENTER
        chip.setPadding(dp(8f), 0, dp(8f), 0)
        chip.background = SSUtil.round(Color.argb(30, 255, 255, 255), dpf(12f))
        val ic = SSIconView(context, t.second, 16f)
        chip.addView(ic, LinearLayout.LayoutParams(dp(18f), dp(18f)))
        val lb = tv(12.5f, Color.WHITE, true)
        lb.text = t.third
        lb.maxLines = 1
        lb.ellipsize = TextUtils.TruncateAt.END
        chip.addView(lb, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(5f) })
        chip.setOnClickListener {
          closeTopOverlay()
          when (t.first) {
            "mention" -> openMentionPicker(null)
            "location" -> openLocationForm(null)
            "link" -> openLinkForm(null)
            "poll" -> openPollForm(null)
            "question" -> openQuestionForm(null)
            "countdown" -> openCountdownForm(null)
            "music" -> openMusicPicker()
          }
        }
        row!!.addView(chip, LinearLayout.LayoutParams(0, dp(40f), 1f).apply { rightMargin = if (i % 4 == 3) 0 else dp(8f) })
      }
      // completa a última linha
      val rem = tiles.size % 4
      if (rem != 0) for (k in 0 until 4 - rem) row!!.addView(View(context), LinearLayout.LayoutParams(0, dp(40f), 1f).apply { if (k < 3 - rem) rightMargin = dp(8f) })
      val list = listScroll(card, 0.32f)
      var er: LinearLayout? = null
      for ((i, e) in opts.emojis.withIndex()) {
        if (i % 8 == 0) {
          er = LinearLayout(context)
          er.orientation = LinearLayout.HORIZONTAL
          list.addView(er, LinearLayout.LayoutParams(-1, dp(50f)))
        }
        val t = TextView(context)
        t.text = e
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
        t.gravity = Gravity.CENTER
        t.setOnClickListener {
          closeTopOverlay()
          val l = SSLayer(SSUtil.newId(), "emoji")
          l.text = e
          val n = curItem?.layers?.size ?: 0
          l.u = 0.5f; l.v = 0.42f + 0.05f * (n % 4)
          addLayer(l)
        }
        er!!.addView(t, LinearLayout.LayoutParams(0, -1, 1f))
      }
      val rem2 = opts.emojis.size % 8
      if (rem2 != 0) for (k in 0 until 8 - rem2) er?.addView(View(context), LinearLayout.LayoutParams(0, -1, 1f))
    }
  }

  private fun addLayer(l: SSLayer) {
    curItem?.layers?.add(l)
    stage?.addLayerView(l)
    dirtyMedia = true
    haptic()
  }

  private fun upsertWidget(existing: SSLayer?, kind: String, fill: (SSLayer) -> Unit) {
    if (existing != null) {
      fill(existing)
      stage?.refreshLayer(existing)
      return
    }
    val l = SSLayer(SSUtil.newId(), kind)
    fill(l)
    l.u = -1f
    val n = curItem?.layers?.count { !it.burnable } ?: 0
    l.v = 0.22f + 0.1f * (n % 5)
    addLayer(l)
  }

  private fun formField(card: LinearLayout, hint: String, value: String, max: Int): EditText {
    val e = edit(hint, value, max)
    card.addView(e, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10f) })
    return e
  }

  private fun formDone(card: LinearLayout, label: String, onDone: () -> Unit) {
    val b = primaryBtn(label, onDone)
    card.addView(b, LinearLayout.LayoutParams(-1, dp(46f)).apply { topMargin = dp(4f) })
  }

  private fun openPollForm(existing: SSLayer?) {
    sheet(L("poll", "Enquete")) { card ->
      val q = formField(card, L("pollQuestion", "Faça uma pergunta…"), existing?.question ?: L("pollDefault", "Sim ou não?"), 200)
      val a = formField(card, L("optionA", "Opção 1"), existing?.optionA ?: L("yes", "Sim"), 80)
      val b = formField(card, L("optionB", "Opção 2"), existing?.optionB ?: L("no", "Não"), 80)
      formDone(card, L("done", "Concluir")) {
        val oa = a.text.toString().trim().ifEmpty { L("yes", "Sim") }
        val ob = b.text.toString().trim().ifEmpty { L("no", "Não") }
        closeTopOverlay()
        upsertWidget(existing, "poll") { it.question = q.text.toString().trim(); it.optionA = oa; it.optionB = ob }
      }
      showKeyboard(q)
    }
  }

  private fun openQuestionForm(existing: SSLayer?) {
    sheet(L("question", "Pergunta")) { card ->
      val p = formField(card, L("questionDefault", "Me pergunte algo…"), existing?.prompt ?: L("questionDefault", "Me pergunte algo…"), 200)
      formDone(card, L("done", "Concluir")) {
        val v = p.text.toString().trim().ifEmpty { L("questionDefault", "Me pergunte algo…") }
        closeTopOverlay()
        upsertWidget(existing, "question") { it.prompt = v }
      }
      showKeyboard(p)
    }
  }

  private fun openCountdownForm(existing: SSLayer?) {
    val cal = Calendar.getInstance()
    if (existing != null && existing.targetMs > 0) cal.timeInMillis = existing.targetMs
    else { cal.add(Calendar.DAY_OF_MONTH, 1); cal.set(Calendar.MINUTE, 0); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0) }
    sheet(L("countdown", "Contagem")) { card ->
      val lab = formField(card, L("countdownLabel", "Nome do evento"), existing?.label ?: L("countdownDefault", "Evento"), 60)
      val dateBtn = tv(15f, Color.WHITE, true)
      dateBtn.gravity = Gravity.CENTER_VERTICAL
      dateBtn.setPadding(dp(14f), 0, dp(14f), 0)
      dateBtn.background = SSUtil.round(Color.argb(26, 255, 255, 255), dpf(12f), Color.argb(36, 255, 255, 255), max(1, dp(1f)))
      fun paintDate() { dateBtn.text = L("countdownDate", "Termina em") + ": " + DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(cal.time) }
      paintDate()
      dateBtn.setOnClickListener {
        hideKeyboard()
        try {
          val dp0 = DatePickerDialog(context, android.R.style.Theme_DeviceDefault_Dialog_Alert, { _, y, m, d ->
            cal.set(Calendar.YEAR, y); cal.set(Calendar.MONTH, m); cal.set(Calendar.DAY_OF_MONTH, d)
            try {
              TimePickerDialog(context, android.R.style.Theme_DeviceDefault_Dialog_Alert, { _, hh, mm ->
                cal.set(Calendar.HOUR_OF_DAY, hh); cal.set(Calendar.MINUTE, mm); cal.set(Calendar.SECOND, 0)
                paintDate()
              }, cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE), AndroidDateFormat.is24HourFormat(context)).show()
            } catch (_: Throwable) { paintDate() }
          }, cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH))
          dp0.datePicker.minDate = System.currentTimeMillis() - 1000
          dp0.show()
        } catch (_: Throwable) {}
      }
      card.addView(dateBtn, LinearLayout.LayoutParams(-1, dp(46f)).apply { bottomMargin = dp(10f) })
      formDone(card, L("done", "Concluir")) {
        val name = lab.text.toString().trim().ifEmpty { L("countdownDefault", "Evento") }
        if (cal.timeInMillis < System.currentTimeMillis() + 60_000) cal.timeInMillis = System.currentTimeMillis() + 3_600_000
        closeTopOverlay()
        upsertWidget(existing, "countdown") { it.label = name; it.targetMs = cal.timeInMillis }
      }
    }
  }

  private fun openLinkForm(existing: SSLayer?) {
    sheet(L("link", "Link")) { card ->
      val u = formField(card, L("linkUrl", "https://"), existing?.url ?: "", 500)
      u.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
      val lb = formField(card, L("linkLabel", "Texto do botão (opcional)"), existing?.label ?: "", 40)
      formDone(card, L("done", "Concluir")) {
        var url = u.text.toString().trim()
        if (!Regex("^(https?://)?[^\\s.]+\\.[^\\s]{2,}", RegexOption.IGNORE_CASE).containsMatchIn(url)) {
          u.background = SSUtil.round(Color.argb(26, 255, 255, 255), dpf(12f), Color.rgb(239, 68, 68), dp(1f))
          return@formDone
        }
        if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url)) url = "https://$url"
        val label = lb.text.toString().trim().ifEmpty { url.replace(Regex("^https?://", RegexOption.IGNORE_CASE), "").take(32) }
        closeTopOverlay()
        upsertWidget(existing, "link") { it.url = url; it.label = label }
      }
      showKeyboard(u)
    }
  }

  private fun openLocationForm(existing: SSLayer?) {
    sheet(L("location", "Local")) { card ->
      val row = LinearLayout(context)
      row.orientation = LinearLayout.HORIZONTAL
      row.gravity = Gravity.CENTER_VERTICAL
      val f = edit(L("locationPlaceholder", "Onde você está?"), existing?.label ?: "", 60)
      row.addView(f, LinearLayout.LayoutParams(0, -2, 1f))
      val pb = ProgressBar(context)
      pb.indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
      pb.visibility = View.GONE
      val me = glassBtn("pin", L("useMyLocation", "Usar minha localização"), 18f, 44f) {}
      me.background = SSUtil.round(Color.argb(30, 255, 255, 255), dpf(12f))
      me.setOnClickListener {
        me.visibility = View.GONE; pb.visibility = View.VISIBLE
        request("location", null) { data ->
          me.visibility = View.VISIBLE; pb.visibility = View.GONE
          val label = (data?.get("label") as? String)?.trim() ?: ""
          if (label.isNotEmpty()) { f.setText(label); f.setSelection(label.length) }
        }
      }
      row.addView(me, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { leftMargin = dp(8f) })
      row.addView(pb, LinearLayout.LayoutParams(dp(44f), dp(28f)).apply { leftMargin = dp(8f) })
      card.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10f) })
      formDone(card, L("done", "Concluir")) {
        val v = f.text.toString().trim()
        if (v.isEmpty()) return@formDone
        closeTopOverlay()
        if (existing != null) { existing.label = v; stage?.refreshLayer(existing) }
        else {
          val l = SSLayer(SSUtil.newId(), "location")
          l.label = v
          l.u = 0.5f; l.v = 0.3f
          addLayer(l)
        }
      }
      if (existing == null) me.performClick()
    }
  }

  private fun openMentionPicker(existing: SSLayer?) {
    sheet(L("mention", "Menção")) { card ->
      val q = edit(L("searchContacts", "Buscar contato"), "", 60)
      card.addView(q, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8f) })
      val list = listScroll(card, 0.42f)
      fun fill() {
        list.removeAllViews()
        val s = q.text.toString().trim().lowercase()
        val res = opts.contacts.filter { s.isEmpty() || it.name.lowercase().contains(s) || it.email.lowercase().contains(s) }.take(80)
        for (c in res) {
          val row = LinearLayout(context)
          row.orientation = LinearLayout.HORIZONTAL
          row.gravity = Gravity.CENTER_VERTICAL
          row.setPadding(dp(4f), dp(10f), dp(4f), dp(10f))
          val av = tv(15f, Color.WHITE, true)
          av.text = (c.name.trim().firstOrNull() ?: '@').uppercaseChar().toString()
          av.gravity = Gravity.CENTER
          av.background = SSUtil.round(Color.argb(46, 255, 255, 255), dpf(18f))
          row.addView(av, LinearLayout.LayoutParams(dp(36f), dp(36f)))
          val colv = LinearLayout(context)
          colv.orientation = LinearLayout.VERTICAL
          val t1 = tv(15f, Color.WHITE, true); t1.text = c.name; t1.maxLines = 1; t1.ellipsize = TextUtils.TruncateAt.END
          val t2 = tv(12f, Color.argb(150, 255, 255, 255)); t2.text = c.email; t2.maxLines = 1; t2.ellipsize = TextUtils.TruncateAt.END
          colv.addView(t1)
          colv.addView(t2, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(3f) })
          row.addView(colv, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(12f) })
          row.setOnClickListener {
            val uname = (c.name.ifEmpty { c.email.substringBefore("@") }).replace(Regex("\\s+"), "").lowercase()
            closeTopOverlay()
            upsertWidget(existing, "mention") { it.username = uname; it.email = c.email }
          }
          list.addView(row, LinearLayout.LayoutParams(-1, -2))
        }
        if (res.isEmpty()) {
          val e = tv(14f, Color.argb(150, 255, 255, 255))
          e.text = "—"
          e.gravity = Gravity.CENTER
          list.addView(e, LinearLayout.LayoutParams(-1, dp(60f)))
        }
      }
      q.addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: Editable?) { fill() }
      })
      fill()
    }
  }

  private fun openMusicPicker() {
    if (drawingOn) return
    sheet(L("music", "Música")) { card ->
      val q = edit(L("searchMusic", "Buscar música…"), "", 80)
      card.addView(q, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8f) })
      val list = listScroll(card, 0.45f)
      var seq = 0
      fun fill(tracks: List<SSTrack>, loading: Boolean) {
        list.removeAllViews()
        if (loading) {
          val pb = ProgressBar(context)
          pb.indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
          list.addView(pb, LinearLayout.LayoutParams(-1, dp(60f)))
          return
        }
        for (t in tracks) {
          val row = LinearLayout(context)
          row.orientation = LinearLayout.HORIZONTAL
          row.gravity = Gravity.CENTER_VERTICAL
          row.setPadding(dp(4f), dp(8f), dp(4f), dp(8f))
          val cover = FrameLayout(context)
          cover.background = SSUtil.round(Color.argb(46, 255, 255, 255), dpf(8f))
          cover.clipToOutline = true
          cover.outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
          cover.addView(SSIconView(context, "music", 18f), FrameLayout.LayoutParams(-1, -1))
          val iv = ImageView(context)
          iv.scaleType = ImageView.ScaleType.CENTER_CROP
          cover.addView(iv, FrameLayout.LayoutParams(-1, -1))
          if (t.coverUrl.isNotEmpty()) SSNet.loadBitmap(t.coverUrl, 120) { b -> if (b != null) iv.setImageBitmap(b) }
          row.addView(cover, LinearLayout.LayoutParams(dp(44f), dp(44f)))
          val colv = LinearLayout(context)
          colv.orientation = LinearLayout.VERTICAL
          val t1 = tv(15f, Color.WHITE, true); t1.text = t.title; t1.maxLines = 1; t1.ellipsize = TextUtils.TruncateAt.END
          val t2 = tv(12f, Color.argb(150, 255, 255, 255)); t2.text = t.artist; t2.maxLines = 1; t2.ellipsize = TextUtils.TruncateAt.END
          colv.addView(t1)
          colv.addView(t2, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(3f) })
          row.addView(colv, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(12f) })
          row.setOnClickListener {
            closeTopOverlay()
            // uma música por status: remove a anterior de todas as mídias
            for (it2 in items) {
              val old = it2.layers.filter { it.kind == "music" }
              for (o in old) { it2.layers.remove(o); if (it2 === curItem) stage?.removeLayerView(o) }
            }
            val l = SSLayer(SSUtil.newId(), "music")
            l.track = t
            l.u = -1f; l.v = 0.1f
            addLayer(l)
          }
          list.addView(row, LinearLayout.LayoutParams(-1, -2))
        }
        if (tracks.isEmpty()) {
          val e = tv(14f, Color.argb(150, 255, 255, 255))
          e.text = L("noTracks", "Nenhuma faixa encontrada")
          e.gravity = Gravity.CENTER
          list.addView(e, LinearLayout.LayoutParams(-1, dp(60f)))
        }
      }
      val search = Runnable {
        val s = q.text.toString().trim()
        if (s.isEmpty()) { fill(opts.catalog, false); return@Runnable }
        seq += 1
        val my = seq
        fill(emptyList(), true)
        request("musicSearch", s) { data ->
          if (my != seq) return@request
          val tr = (data?.get("tracks") as? List<*>)?.mapNotNull { raw ->
            val m = raw as? Map<*, *> ?: return@mapNotNull null
            val title = (m["title"] as? String) ?: ""
            val url = (m["previewUrl"] as? String) ?: (m["preview_url"] as? String) ?: ""
            if (title.isEmpty() && url.isEmpty()) null else SSTrack(
              (m["id"] ?: "").toString(), title, (m["artist"] as? String) ?: "", url,
              (m["coverUrl"] as? String) ?: (m["image_url"] as? String) ?: "", (m["durationSec"] as? Number)?.toDouble() ?: 0.0,
            )
          } ?: emptyList()
          fill(tr, false)
        }
      }
      q.addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: Editable?) { main.removeCallbacks(search); main.postDelayed(search, 400) }
      })
      fill(opts.catalog, false)
    }
  }

  // ─── publicar ─────────────────────────────────────────────────────────────

  private val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }

  private fun publishMedia() {
    if (busy || items.isEmpty()) return
    if (audienceBlocked()) return
    if (drawingOn) setDrawing(false)
    hideKeyboard()
    val st = stage ?: return
    val sw = st.width.toFloat()
    val sh = st.height.toFloat()
    if (sw <= 0 || sh <= 0) return
    setBusy(true)
    st.pauseVideo()
    val d = context.resources.displayMetrics.density
    val scrW = root.width / d
    val scrH = root.height / d
    val out = ArrayList<Map<String, Any?>>()
    var music: SSTrack? = null
    for (it in items) for (l in it.layers) if (l.kind == "music" && music == null) music = l.track

    fun next(i: Int) {
      if (finished) return
      if (i >= items.size) {
        val r = baseResult()
        r["caption"] = caption.trim()
        r["music"] = music?.toMap()
        r["items"] = out
        finishWith(r)
        return
      }
      exportItem(items[i], sw, sh, scrW, scrH) { m ->
        if (m == null) {
          setBusy(false)
          st.resumeVideo()
          try { android.widget.Toast.makeText(context, L("publishFailed", "Não foi possível publicar o status."), android.widget.Toast.LENGTH_SHORT).show() } catch (_: Throwable) {}
          return@exportItem
        }
        out.add(m)
        next(i + 1)
      }
    }
    next(0)
  }

  /** Caixa (sem giro) de uma camada queimável em px do palco: left, top. */
  private fun burnBox(l: SSLayer, sw: Float, sh: Float): Pair<Float, Float> {
    val v = factory.make(l, sw.toInt())
    factory.measureLoose(v)
    val w = v.measuredWidth * l.scale
    val h = v.measuredHeight * l.scale
    return Pair(l.u * sw - w / 2f, l.v * sh - h / 2f)
  }

  private fun exportItem(it: SSItemState, sw: Float, sh: Float, scrW: Float, scrH: Float, cb: (Map<String, Any?>?) -> Unit) {
    val stickers = ArrayList<Map<String, Any?>>()
    val mentions = LinkedHashSet<String>()
    for (l in it.layers) {
      if (l.burnable || l.kind == "music") continue
      val x = (l.u.coerceAtLeast(0f) * scrW).roundToInt()
      val y = (l.v.coerceAtLeast(0f) * scrH).roundToInt()
      when (l.kind) {
        "mention" -> {
          stickers.add(mapOf("type" to "mention", "id" to l.id, "username" to "@" + l.username.removePrefix("@"), "email" to l.email, "x" to x, "y" to y))
          if (l.email.isNotEmpty()) mentions.add(l.email)
        }
        "link" -> stickers.add(mapOf("type" to "link", "id" to l.id, "url" to l.url, "label" to l.label, "x" to x, "y" to y))
        "poll" -> stickers.add(mapOf("type" to "poll", "id" to l.id, "question" to l.question, "optionA" to l.optionA, "optionB" to l.optionB, "x" to x, "y" to y))
        "question" -> stickers.add(mapOf("type" to "question", "id" to l.id, "prompt" to l.prompt, "x" to x, "y" to y))
        "countdown" -> stickers.add(mapOf("type" to "countdown", "id" to l.id, "label" to l.label, "targetDate" to iso.format(Date(l.targetMs)), "x" to x, "y" to y))
      }
    }
    val base = hashMapOf<String, Any?>(
      "mentions" to mentions.toList(),
      "boomerang" to it.src.boomerang,
    )
    if (it.src.isVideo) {
      val texts = ArrayList<Map<String, Any?>>()
      for (l in it.layers) {
        if (!l.burnable) continue
        val (lx, ly) = burnBox(l, sw, sh)
        val x = (lx.coerceAtLeast(0f) / sw * scrW).roundToInt()
        val y = (ly.coerceAtLeast(0f) / sh * scrH).roundToInt()
        when (l.kind) {
          "text" -> texts.add(mapOf("text" to l.text, "x" to x, "y" to y, "color" to SSUtil.hex(if (l.bg == 1) SSUtil.contrastOn(l.color) else l.color)))
          "location" -> texts.add(mapOf("text" to l.label.uppercase(), "x" to x, "y" to y, "color" to "#FFFFFF"))
          "emoji" -> stickers.add(mapOf("type" to "emoji", "id" to l.id, "emoji" to l.text, "x" to x, "y" to y))
        }
      }
      val paths = ArrayList<Map<String, Any?>>()
      for (s in it.strokes) {
        if (s.type == "eraser" || s.pts.isEmpty()) continue
        paths.add(mapOf("color" to SSUtil.hex(s.color), "points" to s.pts.map { p -> mapOf("x" to (p.x * scrW).roundToInt(), "y" to (p.y * scrH).roundToInt()) }))
      }
      val lower = it.src.uri.lowercase()
      base.putAll(mapOf(
        "kind" to "video", "uri" to it.src.uri, "width" to it.src.width, "height" to it.src.height,
        "mime" to if (lower.endsWith(".mov")) "video/quicktime" else "video/mp4",
        "stickers" to stickers, "textOverlays" to texts, "drawPaths" to paths,
      ))
      cb(base)
      return
    }
    // foto
    base["stickers"] = stickers
    base["textOverlays"] = emptyList<Any>()
    base["drawPaths"] = emptyList<Any>()
    val filter = opts.filters.getOrNull(it.filterIdx)
    if (it.filterIdx > 0 && filter != null) base["filter"] = filter.id
    val m = filter?.androidMatrix()
    val burn = it.layers.any { l -> l.burnable } || it.strokes.isNotEmpty()
    if (!burn && m == null) {
      val w = if (it.src.width > 0) it.src.width else it.preview?.width ?: 0
      val h = if (it.src.height > 0) it.src.height else it.preview?.height ?: 0
      base.putAll(mapOf("kind" to "image", "uri" to it.src.uri, "width" to w, "height" to h, "mime" to "image/jpeg"))
      cb(base)
      return
    }
    Thread {
      val full = SSExport.decode(context, it.src.uri, 2560)
      main.post {
        if (finished) { full?.recycle(); return@post }
        if (full == null) { cb(null); return@post }
        try {
          val res: Bitmap
          if (burn) {
            val ow = 1080
            val oh = 1920
            res = Bitmap.createBitmap(ow, oh, Bitmap.Config.ARGB_8888)
            val c = Canvas(res)
            c.drawColor(it.bgColor)
            SSExport.drawFit(c, full, ow.toFloat(), oh.toFloat(), m)
            val k = ow / sw
            if (it.strokes.isNotEmpty()) {
              val sb = Bitmap.createBitmap(ow, oh, Bitmap.Config.ARGB_8888)
              val cs = Canvas(sb)
              cs.scale(k, oh / sh)
              SSDraw.drawStrokes(cs, it.strokes, null, sw, sh)
              c.drawBitmap(sb, 0f, 0f, Paint(Paint.FILTER_BITMAP_FLAG))
              sb.recycle()
            }
            c.save()
            c.scale(k, oh / sh)
            for (l in it.layers) {
              if (!l.burnable) continue
              val v = factory.make(l, sw.toInt())
              factory.measureLoose(v)
              c.save()
              c.concat(SSDraw.layerMatrix(l, v.measuredWidth, v.measuredHeight, sw, sh, 1f))
              v.draw(c)
              c.restore()
            }
            c.restore()
            full.recycle()
          } else {
            res = SSExport.filtered(full, m)
            if (res !== full) full.recycle()
          }
          Thread {
            val f = SSExport.outFile(context, "jpg")
            val ok = SSExport.saveJpeg(res, f, 90)
            val rw = res.width
            val rh = res.height
            res.recycle()
            main.post {
              if (!ok) { cb(null); return@post }
              base.putAll(mapOf("kind" to "image", "uri" to "file://" + f.absolutePath, "width" to rw, "height" to rh, "mime" to "image/jpeg"))
              cb(base)
            }
          }.start()
        } catch (t: Throwable) {
          Log.w(TAG, "export: ${t.message}")
          cb(null)
        }
      }
    }.start()
  }
}

/** Slider vertical da espessura do pincel (estilo Instagram: cunha). */
class SSVSlider(ctx: Context) : View(ctx) {
  var value = 0.2f
    set(v) { field = v.coerceIn(0f, 1f); invalidate() }
  var onChange: ((Float) -> Unit)? = null
  private val p = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = android.graphics.Path()
  private val r = RectF()

  override fun onDraw(c: Canvas) {
    val w = width.toFloat()
    val h = height.toFloat()
    val top = w / 2f
    val bot = h - w / 2f
    path.reset()
    path.moveTo(w / 2f - w * 0.38f, top)
    path.lineTo(w / 2f + w * 0.38f, top)
    path.lineTo(w / 2f + w * 0.06f, bot)
    path.lineTo(w / 2f - w * 0.06f, bot)
    path.close()
    p.style = Paint.Style.FILL
    p.color = Color.argb(110, 255, 255, 255)
    c.drawPath(path, p)
    val y = bot - (bot - top) * value
    val rad = w * 0.18f + w * 0.24f * value
    p.color = Color.WHITE
    c.drawCircle(w / 2f, y, rad, p)
    p.style = Paint.Style.STROKE
    p.strokeWidth = 2f
    p.color = Color.argb(120, 0, 0, 0)
    r.set(w / 2f - rad, y - rad, w / 2f + rad, y + rad)
    c.drawOval(r, p)
  }

  @android.annotation.SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    val w = width.toFloat()
    val top = w / 2f
    val bot = height - w / 2f
    value = ((bot - ev.y) / max(1f, bot - top))
    onChange?.invoke(value)
    if (ev.actionMasked == MotionEvent.ACTION_DOWN) parent?.requestDisallowInterceptTouchEvent(true)
    return true
  }
}
