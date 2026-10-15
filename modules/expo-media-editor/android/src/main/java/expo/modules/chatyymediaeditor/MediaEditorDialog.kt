package expo.modules.chatyymediaeditor

import android.app.Activity
import android.app.AlertDialog
import android.app.Application
import android.app.Dialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.widget.VideoView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

class MEOptions(
  val uri: String,
  val isVideo: Boolean,
  val compose: Boolean,
  val caption: String,
  val captionMax: Int,
  val viewOnce: Boolean,
  val allowViewOnce: Boolean,
  val hd: Boolean,
  val allowHd: Boolean,
  val filters: List<MEFilter>,
  val stickers: List<String>,
  val labels: Map<String, String>,
  val maxDim: Int,
  val hdMaxDim: Int,
  val quality: Int,
  val secure: Boolean,
  val allowCrop: Boolean,
  val allowDraw: Boolean,
  val allowText: Boolean,
  val allowStickers: Boolean,
  val allowFilters: Boolean,
  val allowTrim: Boolean,
  val allowMute: Boolean,
  val allowCover: Boolean,
)

/**
 * [2026-10-15 native-editor] Editor de foto/vídeo antes de enviar (chat e
 * status) — Dialog tela cheia sobre a Activity do RN, estética P&B, ícones
 * vetoriais. Foto: recortar/girar (proporções), desenhar, texto, figurinhas,
 * filtros ColorMatrix. Vídeo: aparar (trilho de miniaturas), mudo, capa.
 * Modo "compose": legenda + ver uma vez + HD + enviar. Modo "edit": Concluir.
 * Resultado entregue UMA vez via [onResult].
 */
class MediaEditorDialog(
  private val host: Activity,
  private val opts: MEOptions,
  private val onResult: (Map<String, Any?>) -> Unit,
) : Dialog(host, android.R.style.Theme_Black_NoTitleBar), PhotoCanvasView.Host, TrimRailView.Listener {

  companion object {
    private const val TAG = "ChatyyMediaEditor"
    private const val T_NONE = 0
    private const val T_CROP = 1
    private const val T_DRAW = 2
    private const val T_FILTER = 3
    private const val T_STICKER = 4
    val PALETTE = intArrayOf(
      Color.WHITE, Color.BLACK, Color.rgb(255, 59, 48), Color.rgb(255, 149, 0),
      Color.rgb(255, 204, 0), Color.rgb(52, 199, 89), Color.rgb(10, 132, 255), Color.rgb(175, 82, 222),
    )
    val PEN_DP = floatArrayOf(4f, 8f, 14f)
    val DEFAULT_STICKERS = listOf(
      "😀", "😂", "😍", "🥳", "🔥", "✨", "❤️", "👍",
      "👏", "🎉", "💯", "⭐", "😎", "🤩", "🙌", "😘",
      "😭", "😱", "🤔", "🙄", "🙏", "💪", "🌹", "🎈",
    )
  }

  private val main = Handler(Looper.getMainLooper())
  private var finished = false
  private var busy = false

  // ── estado foto ──
  private var st = MEState()
  private val history = ArrayList<MEState>()
  private var baseBitmap: Bitmap? = null
  private var displayBitmap: Bitmap? = null
  private var displayRotQ = 0
  private var tool = T_NONE
  private var brushColor = Color.WHITE
  private var brushIdx = 1
  private var editingObj = -1
  private var txtColor = Color.WHITE
  private var txtFont = 0
  private var txtBg = 0

  // ── estado vídeo ──
  private var vInfo: EditorExport.VideoInfo? = null
  private var trimStart = 0L
  private var trimEnd = 0L
  private var muted = false
  private var coverMs = -1L
  private var player: MediaPlayer? = null
  private var userPaused = false
  private var coverMode = false

  // ── compose ──
  private var viewOnce = opts.viewOnce
  private var hd = opts.hd

  // ── views ──
  private lateinit var root: FrameLayout
  private lateinit var column: LinearLayout
  private lateinit var topBar: LinearLayout
  private lateinit var stage: FrameLayout
  private lateinit var panel: FrameLayout
  private lateinit var bottomBar: LinearLayout
  private var canvasView: PhotoCanvasView? = null
  private var videoView: VideoView? = null
  private var rail: TrimRailView? = null
  private var timeLabel: TextView? = null
  private var coverThumb: ImageView? = null
  private var coverBtn: LinearLayout? = null
  private lateinit var trash: FrameLayout
  private lateinit var trashIcon: MEIconView
  private var undoBtn: View? = null
  private val toolButtons = HashMap<Int, MEIconView>()
  private var hdChip: TextView? = null
  private var soundBtn: MEIconView? = null
  private var captionInput: EditText? = null
  private var viewOnceBtn: TextView? = null
  private var viewOnceHint: TextView? = null
  private var sendBtn: FrameLayout? = null
  private lateinit var busyView: FrameLayout
  private var textOverlay: FrameLayout? = null
  private var textInput: EditText? = null
  private var fontBtn: TextView? = null
  private var bgBtn: MEIconView? = null
  private var textPalette: LinearLayout? = null
  private var filterRow: LinearLayout? = null
  private var ratioRow: LinearLayout? = null
  private var ratioSel = "free"
  private var drawRow: LinearLayout? = null
  private var progressRunning = false

  private val progressLoop = object : Runnable {
    override fun run() {
      tickVideo()
      if (progressRunning) main.postDelayed(this, 40)
    }
  }

  private val lifecycleCb = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityResumed(activity: Activity) {}
    override fun onActivityPaused(activity: Activity) {
      if (activity === host) try { videoView?.pause() } catch (_: Throwable) {}
    }
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {
      if (activity === host) finishWith(mapOf("action" to "cancel"), dismissNow = true)
    }
  }

  private fun L(key: String, fallback: String): String = opts.labels[key]?.takeIf { it.isNotEmpty() } ?: fallback
  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, context.resources.displayMetrics).toInt()
  private fun dpf(v: Float): Float = v * context.resources.displayMetrics.density

  // ─── ciclo de vida ────────────────────────────────────────────────────────

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    buildUi()
    setContentView(root)
    setupWindow()
    setCancelable(true)
    setCanceledOnTouchOutside(false)
    try { host.application.registerActivityLifecycleCallbacks(lifecycleCb) } catch (_: Throwable) {}
    if (opts.isVideo) loadVideo() else loadPhoto()
  }

  override fun onStart() {
    super.onStart()
    window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    if (busy) return
    if (textOverlay?.visibility == View.VISIBLE) { closeTextEditor(commit = true); return }
    if (coverMode) { setCoverMode(false); return }
    if (tool != T_NONE) { setTool(T_NONE); return }
    requestClose()
  }

  private fun setupWindow() {
    val w = window ?: return
    w.setBackgroundDrawable(ColorDrawable(Color.BLACK))
    w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    // [2026-10-15 screen-protect-all] app inteiro protegido (hub) + secure local da conversa.
    ScreenProtectBridge.protect(w, opts.secure)
    @Suppress("DEPRECATION")
    w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN)
    WindowCompat.setDecorFitsSystemWindows(w, false)
    @Suppress("DEPRECATION")
    run {
      w.statusBarColor = Color.TRANSPARENT
      w.navigationBarColor = Color.BLACK
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

  private fun finishWith(result: Map<String, Any?>, dismissNow: Boolean = true) {
    if (finished) return
    finished = true
    progressRunning = false
    main.removeCallbacksAndMessages(null)
    try { videoView?.stopPlayback() } catch (_: Throwable) {}
    try { host.application.unregisterActivityLifecycleCallbacks(lifecycleCb) } catch (_: Throwable) {}
    hideKeyboard()
    try { onResult(result) } catch (t: Throwable) { Log.w(TAG, "onResult: ${t.message}") }
    if (dismissNow) try { super.dismiss() } catch (_: Throwable) {}
    main.postDelayed({
      try { if (displayBitmap !== baseBitmap) displayBitmap?.recycle() } catch (_: Throwable) {}
      try { baseBitmap?.recycle() } catch (_: Throwable) {}
      for (b in rail?.thumbs ?: arrayListOf()) try { b?.recycle() } catch (_: Throwable) {}
    }, 600)
  }

  override fun dismiss() {
    if (!finished) finishWith(mapOf("action" to "cancel")) else try { super.dismiss() } catch (_: Throwable) {}
  }

  fun closeFromJS() {
    finishWith(mapOf("action" to "cancel", "reason" to "js"))
  }

  private fun hasChanges(): Boolean {
    if (opts.isVideo) {
      val dur = vInfo?.durationMs ?: 0L
      return muted || coverMs >= 0 || trimStart > 0 || (dur > 0 && trimEnd in 1 until dur - 50)
    }
    return !st.isPristine()
  }

  private fun requestClose() {
    val dirty = hasChanges() || (captionInput?.text?.isNotBlank() == true && opts.caption.isBlank())
    if (!dirty) { finishWith(mapOf("action" to "cancel")); return }
    try {
      AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert)
        .setTitle(L("discardTitle", "Descartar alterações?"))
        .setPositiveButton(L("discard", "Descartar")) { _, _ -> finishWith(mapOf("action" to "cancel")) }
        .setNegativeButton(L("cancel", "Cancelar"), null)
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
    } catch (_: Throwable) {}
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────

  private fun borderless(v: View) {
    val tv = TypedValue()
    if (context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true) && tv.resourceId != 0) {
      v.setBackgroundResource(tv.resourceId)
    }
  }

  private fun iconBtn(name: String, desc: String, sizeDp: Float = 22f, onClick: () -> Unit): MEIconView {
    val b = MEIconView(context, name, sizeDp)
    b.contentDescription = desc
    b.isClickable = true
    b.isFocusable = true
    borderless(b)
    b.setOnClickListener { if (!busy) onClick() }
    b.layoutParams = LinearLayout.LayoutParams(dp(42f), dp(44f))
    return b
  }

  private fun pill(bg: Int, radiusDp: Float, stroke: Int = 0): GradientDrawable {
    val g = GradientDrawable()
    g.cornerRadius = dpf(radiusDp)
    g.setColor(bg)
    if (stroke != 0) g.setStroke(dp(1f), stroke)
    return g
  }

  private fun text(sizeSp: Float, color: Int = Color.WHITE, bold: Boolean = false): TextView {
    val t = TextView(context)
    t.setTextColor(color)
    t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
    if (bold) t.typeface = Typeface.DEFAULT_BOLD
    t.includeFontPadding = false
    return t
  }

  // ─── construção ───────────────────────────────────────────────────────────

  private fun buildUi() {
    root = FrameLayout(context)
    root.setBackgroundColor(Color.BLACK)
    column = LinearLayout(context)
    column.orientation = LinearLayout.VERTICAL
    root.addView(column, FrameLayout.LayoutParams(-1, -1))

    topBar = LinearLayout(context)
    topBar.orientation = LinearLayout.HORIZONTAL
    topBar.gravity = Gravity.CENTER_VERTICAL
    topBar.setPadding(dp(4f), 0, dp(4f), 0)
    column.addView(topBar, LinearLayout.LayoutParams(-1, dp(52f)))

    stage = FrameLayout(context)
    stage.clipChildren = true
    column.addView(stage, LinearLayout.LayoutParams(-1, 0, 1f))

    panel = FrameLayout(context)
    column.addView(panel, LinearLayout.LayoutParams(-1, -2))

    bottomBar = LinearLayout(context)
    bottomBar.orientation = LinearLayout.VERTICAL
    bottomBar.setPadding(dp(10f), dp(8f), dp(10f), dp(10f))
    column.addView(bottomBar, LinearLayout.LayoutParams(-1, -2))

    buildTopBar()
    if (opts.isVideo) buildVideoStage() else buildPhotoStage()
    buildBottom()

    busyView = FrameLayout(context)
    busyView.setBackgroundColor(Color.argb(150, 0, 0, 0))
    busyView.isClickable = true
    val bl = LinearLayout(context)
    bl.orientation = LinearLayout.VERTICAL
    bl.gravity = Gravity.CENTER_HORIZONTAL
    val pb = ProgressBar(context)
    pb.indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
    bl.addView(pb, LinearLayout.LayoutParams(dp(40f), dp(40f)))
    val bt = text(14f)
    bt.text = L("processing", "Preparando…")
    bt.setPadding(0, dp(12f), 0, 0)
    bl.addView(bt)
    busyView.addView(bl, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
    busyView.visibility = View.GONE
    root.addView(busyView, FrameLayout.LayoutParams(-1, -1))

    ViewCompat.setOnApplyWindowInsetsListener(root) { _, ins ->
      val bars = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = ins.getInsets(WindowInsetsCompat.Type.ime())
      column.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
      textOverlay?.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
      ins
    }
  }

  private fun buildTopBar() {
    topBar.removeAllViews()
    toolButtons.clear()
    topBar.addView(iconBtn("close", L("close", "Fechar"), 24f) { requestClose() })
    if (!opts.isVideo) {
      val u = iconBtn("undo", L("undo", "Desfazer")) { undo() }
      u.visibility = View.INVISIBLE
      undoBtn = u
      topBar.addView(u)
    }
    topBar.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    if (opts.compose && opts.allowHd) {
      val chip = text(11f, bold = true)
      chip.text = "HD"
      chip.gravity = Gravity.CENTER
      chip.letterSpacing = 0.05f
      chip.setPadding(dp(6f), dp(2f), dp(6f), dp(2f))
      chip.setOnClickListener { if (!busy) { hd = !hd; paintHd() } }
      val wrap = FrameLayout(context)
      wrap.addView(chip, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
      wrap.setOnClickListener { if (!busy) { hd = !hd; paintHd() } }
      topBar.addView(wrap, LinearLayout.LayoutParams(dp(46f), dp(44f)))
      hdChip = chip
      paintHd()
    }
    if (opts.isVideo) {
      if (opts.allowMute) {
        val s = iconBtn("soundOn", L("soundOn", "Som ativado")) { toggleMute() }
        soundBtn = s
        topBar.addView(s)
      }
      return
    }
    fun tb(id: Int, name: String, label: String, enabled: Boolean, onClick: () -> Unit) {
      if (!enabled) return
      val b = iconBtn(name, label, 22f, onClick)
      toolButtons[id] = b
      topBar.addView(b)
    }
    tb(T_CROP, "crop", L("crop", "Recortar"), opts.allowCrop) { setTool(if (tool == T_CROP) T_NONE else T_CROP) }
    tb(T_FILTER, "filter", L("filters", "Filtros"), opts.allowFilters && opts.filters.size > 1) { setTool(if (tool == T_FILTER) T_NONE else T_FILTER) }
    tb(T_STICKER, "sticker", L("stickers", "Figurinhas"), opts.allowStickers) { setTool(if (tool == T_STICKER) T_NONE else T_STICKER) }
    if (opts.allowText) {
      val b = iconBtn("text", L("text", "Texto")) { setTool(T_NONE); openTextEditor(-1) }
      topBar.addView(b)
    }
    tb(T_DRAW, "draw", L("draw", "Desenhar"), opts.allowDraw) { setTool(if (tool == T_DRAW) T_NONE else T_DRAW) }
  }

  private fun paintHd() {
    val c = hdChip ?: return
    c.background = if (hd) pill(Color.WHITE, 5f) else pill(Color.TRANSPARENT, 5f, Color.argb(200, 255, 255, 255))
    c.setTextColor(if (hd) Color.BLACK else Color.argb(230, 255, 255, 255))
    c.contentDescription = if (hd) L("hdOn", "Qualidade HD") else L("hdOff", "Qualidade padrão")
  }

  private fun paintTools() {
    for ((id, b) in toolButtons) {
      val on = id == tool
      b.color = if (on) Color.BLACK else Color.WHITE
      b.background = if (on) pill(Color.WHITE, 20f) else null
      if (!on) borderless(b)
    }
  }

  private fun buildPhotoStage() {
    val cv = PhotoCanvasView(context, this)
    canvasView = cv
    stage.addView(cv, FrameLayout.LayoutParams(-1, -1))
    trash = FrameLayout(context)
    trash.background = pill(Color.argb(150, 0, 0, 0), 30f, Color.argb(90, 255, 255, 255))
    trashIcon = MEIconView(context, "trash", 24f)
    trash.addView(trashIcon, FrameLayout.LayoutParams(-1, -1))
    trash.visibility = View.GONE
    val lp = FrameLayout.LayoutParams(dp(60f), dp(60f), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
    lp.bottomMargin = dp(34f)
    stage.addView(trash, lp)
  }

  private fun buildVideoStage() {
    val vv = VideoView(context)
    videoView = vv
    stage.addView(vv, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
    // ícone de play desenhado à mão (triângulo) — sem emoji
    val play = object : View(context) {
      private val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
      override fun onDraw(c: android.graphics.Canvas) {
        p.color = Color.argb(120, 0, 0, 0)
        val r = min(width, height) / 2f
        c.drawCircle(width / 2f, height / 2f, r, p)
        p.color = Color.WHITE
        val path = android.graphics.Path()
        val s = r * 0.42f
        path.moveTo(width / 2f - s * 0.7f, height / 2f - s)
        path.lineTo(width / 2f + s, height / 2f)
        path.lineTo(width / 2f - s * 0.7f, height / 2f + s)
        path.close()
        c.drawPath(path, p)
      }
    }
    play.visibility = View.GONE
    stage.addView(play, FrameLayout.LayoutParams(dp(64f), dp(64f), Gravity.CENTER))
    stage.setOnClickListener {
      if (coverMode || busy) return@setOnClickListener
      val v = videoView ?: return@setOnClickListener
      if (v.isPlaying) { v.pause(); userPaused = true; play.visibility = View.VISIBLE }
      else { userPaused = false; play.visibility = View.GONE; startPlayback() }
    }
    stage.tag = play

    // painel de corte
    val box = LinearLayout(context)
    box.orientation = LinearLayout.VERTICAL
    box.setPadding(dp(12f), dp(6f), dp(12f), dp(2f))
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    if (opts.allowCover) {
      val cb = LinearLayout(context)
      cb.orientation = LinearLayout.HORIZONTAL
      cb.gravity = Gravity.CENTER_VERTICAL
      cb.setPadding(dp(8f), dp(4f), dp(10f), dp(4f))
      cb.background = pill(Color.argb(40, 255, 255, 255), 14f)
      val th = ImageView(context)
      th.scaleType = ImageView.ScaleType.CENTER_CROP
      th.visibility = View.GONE
      val thLp = LinearLayout.LayoutParams(dp(20f), dp(20f))
      thLp.rightMargin = dp(6f)
      cb.addView(th, thLp)
      coverThumb = th
      val ci = MEIconView(context, "cover", 16f)
      cb.addView(ci, LinearLayout.LayoutParams(dp(20f), dp(20f)))
      val ct = text(13f, bold = true)
      ct.text = L("cover", "Capa")
      ct.setPadding(dp(6f), 0, 0, 0)
      cb.addView(ct)
      cb.contentDescription = L("cover", "Capa")
      cb.setOnClickListener { if (!busy) setCoverMode(!coverMode) }
      coverBtn = cb
      row.addView(cb, LinearLayout.LayoutParams(-2, dp(30f)))
    }
    row.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    val tl = text(12f, Color.argb(220, 255, 255, 255))
    tl.typeface = Typeface.create(Typeface.MONOSPACE, Typeface.NORMAL)
    timeLabel = tl
    row.addView(tl)
    box.addView(row, LinearLayout.LayoutParams(-1, dp(34f)))
    val r = TrimRailView(context, this)
    rail = r
    val rlp = LinearLayout.LayoutParams(-1, dp(56f))
    rlp.topMargin = dp(6f)
    box.addView(r, rlp)
    if (!opts.allowTrim) r.visibility = View.GONE
    panel.addView(box, FrameLayout.LayoutParams(-1, -2))
  }

  private fun buildBottom() {
    bottomBar.removeAllViews()
    if (!opts.compose) {
      val row = LinearLayout(context)
      row.orientation = LinearLayout.HORIZONTAL
      row.gravity = Gravity.CENTER_VERTICAL or Gravity.END
      val done = text(15f, Color.BLACK, bold = true)
      done.text = L("done", "Concluir")
      done.gravity = Gravity.CENTER
      done.setPadding(dp(22f), 0, dp(22f), 0)
      done.background = pill(Color.WHITE, 22f)
      done.setOnClickListener { if (!busy) export("done") }
      row.addView(done, LinearLayout.LayoutParams(-2, dp(44f)))
      bottomBar.addView(row, LinearLayout.LayoutParams(-1, -2))
      return
    }
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    val et = EditText(context)
    et.setTextColor(Color.WHITE)
    et.setHintTextColor(Color.argb(128, 255, 255, 255))
    et.hint = L("captionPlaceholder", "Adicionar legenda...")
    et.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    et.background = pill(Color.argb(26, 255, 255, 255), 22f, Color.argb(41, 255, 255, 255))
    et.setPadding(dp(16f), dp(10f), dp(16f), dp(10f))
    et.minHeight = dp(44f)
    et.maxLines = 5
    et.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    et.filters = arrayOf(InputFilter.LengthFilter(max(1, opts.captionMax)))
    et.setText(opts.caption)
    captionInput = et
    row.addView(et, LinearLayout.LayoutParams(0, -2, 1f))
    if (opts.allowViewOnce) {
      val vo = text(16f, bold = true)
      vo.text = "1"
      vo.gravity = Gravity.CENTER
      vo.contentDescription = L("viewOnce", "Visualização única")
      vo.setOnClickListener { if (!busy) { viewOnce = !viewOnce; paintViewOnce() } }
      val lp = LinearLayout.LayoutParams(dp(36f), dp(36f))
      lp.leftMargin = dp(8f)
      row.addView(vo, lp)
      viewOnceBtn = vo
    }
    val sb = FrameLayout(context)
    sb.background = pill(Color.rgb(17, 17, 17), 25f, Color.argb(60, 255, 255, 255))
    sb.addView(MEIconView(context, "send", 22f), FrameLayout.LayoutParams(-1, -1))
    sb.contentDescription = L("send", "Enviar")
    sb.setOnClickListener { if (!busy) export("send") }
    val slp = LinearLayout.LayoutParams(dp(50f), dp(50f))
    slp.leftMargin = dp(8f)
    row.addView(sb, slp)
    sendBtn = sb
    bottomBar.addView(row, LinearLayout.LayoutParams(-1, -2))
    val hint = text(12f, Color.argb(200, 255, 255, 255))
    hint.text = L("viewOnceHint", "Foto/vídeo só pode ser visto uma vez")
    hint.gravity = Gravity.CENTER
    hint.setPadding(0, dp(6f), 0, 0)
    viewOnceHint = hint
    bottomBar.addView(hint, LinearLayout.LayoutParams(-1, -2))
    paintViewOnce()
  }

  private fun paintViewOnce() {
    val v = viewOnceBtn ?: return
    v.background = if (viewOnce) pill(Color.WHITE, 18f) else pill(Color.TRANSPARENT, 18f, Color.argb(128, 255, 255, 255)).also { it.setStroke(dp(2f), Color.argb(128, 255, 255, 255)) }
    v.setTextColor(if (viewOnce) Color.BLACK else Color.argb(128, 255, 255, 255))
    viewOnceHint?.visibility = if (viewOnce) View.VISIBLE else View.GONE
  }

  // ─── foto ─────────────────────────────────────────────────────────────────

  private fun loadPhoto() {
    showBusy(true)
    val dm = context.resources.displayMetrics
    val prevDim = min(2048, max(1280, (max(dm.widthPixels, dm.heightPixels) * 1.1f).toInt()))
    Thread {
      val b = try { EditorExport.decode(context, opts.uri, prevDim) } catch (_: Throwable) { null }
      main.post {
        if (finished) { b?.recycle(); return@post }
        showBusy(false)
        if (b == null) {
          // não abriu → JS cai no editor antigo
          finishWith(mapOf("action" to "error", "error" to "load_failed"))
          return@post
        }
        baseBitmap = b
        refreshDisplayBitmap()
        buildPhotoPanels()
      }
    }.start()
  }

  private fun refreshDisplayBitmap() {
    val base = baseBitmap ?: return
    if (displayBitmap != null && displayRotQ == st.rotQ) return
    val old = displayBitmap
    displayBitmap = if (st.rotQ % 4 == 0) base else EditorExport.rotated(base, st.rotQ)
    displayRotQ = st.rotQ
    canvasView?.bitmap = displayBitmap
    if (old != null && old !== base && old !== displayBitmap) main.postDelayed({ try { old.recycle() } catch (_: Throwable) {} }, 300)
  }

  private fun applyFilterToCanvas() {
    val f = opts.filters.getOrNull(st.filterIdx)
    canvasView?.filterMatrix = f?.androidMatrix()
    paintFilterRow()
  }

  private fun buildPhotoPanels() {
    // filtros
    if (opts.allowFilters && opts.filters.size > 1) {
      val sc = HorizontalScrollView(context)
      sc.isHorizontalScrollBarEnabled = false
      val row = LinearLayout(context)
      row.orientation = LinearLayout.HORIZONTAL
      row.setPadding(dp(8f), dp(8f), dp(8f), dp(6f))
      val thumb = baseBitmap?.let { b ->
        val k = 140f / max(b.width, b.height)
        try { Bitmap.createScaledBitmap(b, max(1, (b.width * k).toInt()), max(1, (b.height * k).toInt()), true) } catch (_: Throwable) { null }
      }
      for ((i, f) in opts.filters.withIndex()) {
        val cell = LinearLayout(context)
        cell.orientation = LinearLayout.VERTICAL
        cell.gravity = Gravity.CENTER_HORIZONTAL
        val iv = ImageView(context)
        iv.scaleType = ImageView.ScaleType.CENTER_CROP
        if (thumb != null) iv.setImageBitmap(thumb)
        f.androidMatrix()?.let { iv.colorFilter = ColorMatrixColorFilter(ColorMatrix(it)) }
        iv.clipToOutline = true
        iv.background = pill(Color.DKGRAY, 10f)
        iv.outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
        val fr = FrameLayout(context)
        fr.setPadding(dp(2f), dp(2f), dp(2f), dp(2f))
        fr.addView(iv, FrameLayout.LayoutParams(-1, -1))
        cell.addView(fr, LinearLayout.LayoutParams(dp(62f), dp(62f)))
        val lb = text(11f)
        lb.text = f.label
        lb.gravity = Gravity.CENTER
        lb.maxLines = 1
        lb.setPadding(0, dp(5f), 0, 0)
        cell.addView(lb, LinearLayout.LayoutParams(dp(66f), -2))
        cell.contentDescription = f.label
        cell.setOnClickListener {
          if (busy || st.filterIdx == i) return@setOnClickListener
          beginMutation()
          st.filterIdx = i
          applyFilterToCanvas()
          changed()
        }
        val lp = LinearLayout.LayoutParams(-2, -2)
        lp.rightMargin = dp(4f)
        row.addView(cell, lp)
      }
      sc.addView(row)
      filterRow = row
      sc.visibility = View.GONE
      sc.tag = "filter"
      panel.addView(sc, FrameLayout.LayoutParams(-1, -2))
    }
    // desenho
    if (opts.allowDraw) {
      val row = LinearLayout(context)
      row.orientation = LinearLayout.HORIZONTAL
      row.gravity = Gravity.CENTER_VERTICAL
      row.setPadding(dp(12f), dp(8f), dp(12f), dp(8f))
      row.tag = "draw"
      row.visibility = View.GONE
      drawRow = row
      panel.addView(row, FrameLayout.LayoutParams(-1, -2))
      paintDrawRow()
    }
    // recorte
    if (opts.allowCrop) {
      val box = LinearLayout(context)
      box.orientation = LinearLayout.VERTICAL
      box.tag = "crop"
      box.visibility = View.GONE
      val sc = HorizontalScrollView(context)
      sc.isHorizontalScrollBarEnabled = false
      val rr = LinearLayout(context)
      rr.orientation = LinearLayout.HORIZONTAL
      rr.setPadding(dp(10f), dp(8f), dp(10f), dp(4f))
      ratioRow = rr
      sc.addView(rr)
      box.addView(sc, LinearLayout.LayoutParams(-1, -2))
      val actions = LinearLayout(context)
      actions.orientation = LinearLayout.HORIZONTAL
      actions.gravity = Gravity.CENTER_VERTICAL
      actions.setPadding(dp(6f), 0, dp(6f), dp(4f))
      actions.addView(iconBtn("rotate", L("rotate", "Girar")) { rotateCW() })
      val reset = text(14f, bold = true)
      reset.text = L("reset", "Redefinir")
      reset.setPadding(dp(10f), dp(8f), dp(10f), dp(8f))
      reset.setOnClickListener { if (!busy) resetCrop() }
      actions.addView(reset)
      actions.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
      actions.addView(iconBtn("check", L("done", "Concluir"), 24f) { setTool(T_NONE) })
      box.addView(actions, LinearLayout.LayoutParams(-1, -2))
      panel.addView(box, FrameLayout.LayoutParams(-1, -2))
      paintRatioRow()
    }
    // figurinhas
    if (opts.allowStickers) {
      val list = if (opts.stickers.isNotEmpty()) opts.stickers else DEFAULT_STICKERS
      val sc = ScrollView(context)
      sc.tag = "sticker"
      sc.visibility = View.GONE
      val grid = LinearLayout(context)
      grid.orientation = LinearLayout.VERTICAL
      grid.setPadding(dp(8f), dp(6f), dp(8f), dp(6f))
      val perRow = 8
      var row: LinearLayout? = null
      for ((i, s) in list.withIndex()) {
        if (i % perRow == 0) {
          row = LinearLayout(context)
          row.orientation = LinearLayout.HORIZONTAL
          grid.addView(row, LinearLayout.LayoutParams(-1, dp(48f)))
        }
        val t = TextView(context)
        t.text = s
        t.gravity = Gravity.CENTER
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
        t.setOnClickListener { if (!busy) addSticker(s) }
        row?.addView(t, LinearLayout.LayoutParams(0, -1, 1f))
      }
      if (list.size % perRow != 0) {
        for (k in 0 until perRow - list.size % perRow) row?.addView(View(context), LinearLayout.LayoutParams(0, -1, 1f))
      }
      sc.addView(grid)
      panel.addView(sc, FrameLayout.LayoutParams(-1, dp(min(3, (list.size + perRow - 1) / perRow) * 48f + 14f)))
    }
    applyFilterToCanvas()
    paintTools()
  }

  private fun paintDrawRow() {
    val row = drawRow ?: return
    row.removeAllViews()
    for (c in PALETTE) {
      val v = View(context)
      val sel = c == brushColor
      val g = GradientDrawable()
      g.shape = GradientDrawable.OVAL
      g.setColor(c)
      g.setStroke(dp(if (sel) 3f else 1.5f), if (sel) Color.WHITE else Color.argb(150, 255, 255, 255))
      v.background = g
      v.setOnClickListener { brushColor = c; paintDrawRow() }
      val lp = LinearLayout.LayoutParams(dp(if (sel) 30f else 26f), dp(if (sel) 30f else 26f))
      lp.rightMargin = dp(8f)
      row.addView(v, lp)
    }
    row.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    for ((i, w) in PEN_DP.withIndex()) {
      val fr = FrameLayout(context)
      val dot = View(context)
      val g = GradientDrawable()
      g.shape = GradientDrawable.OVAL
      g.setColor(if (i == brushIdx) Color.WHITE else Color.argb(120, 255, 255, 255))
      dot.background = g
      val s = dp(w + 4f)
      fr.addView(dot, FrameLayout.LayoutParams(s, s, Gravity.CENTER))
      fr.contentDescription = L("brushSize", "Espessura") + " ${i + 1}"
      fr.setOnClickListener { brushIdx = i; paintDrawRow() }
      row.addView(fr, LinearLayout.LayoutParams(dp(32f), dp(32f)))
    }
  }

  private val ratios: List<Pair<String, Float>> = listOf(
    "free" to 0f, "orig" to -1f, "1:1" to 1f, "4:3" to 4f / 3f, "3:4" to 3f / 4f, "16:9" to 16f / 9f, "9:16" to 9f / 16f,
  )

  private fun paintRatioRow() {
    val rr = ratioRow ?: return
    rr.removeAllViews()
    for ((key, r) in ratios) {
      val t = text(13f, bold = true)
      t.text = when (key) { "free" -> L("ratioFree", "Livre"); "orig" -> L("ratioOriginal", "Original"); else -> key }
      t.gravity = Gravity.CENTER
      t.setPadding(dp(12f), 0, dp(12f), 0)
      val sel = key == ratioSel
      t.background = if (sel) pill(Color.WHITE, 15f) else pill(Color.argb(36, 255, 255, 255), 15f)
      t.setTextColor(if (sel) Color.BLACK else Color.WHITE)
      t.setOnClickListener {
        if (busy) return@setOnClickListener
        ratioSel = key
        canvasView?.applyRatio(r)
        paintRatioRow()
      }
      val lp = LinearLayout.LayoutParams(-2, dp(30f))
      lp.rightMargin = dp(8f)
      rr.addView(t, lp)
    }
  }

  private fun paintFilterRow() {
    val row = filterRow ?: return
    for (i in 0 until row.childCount) {
      val cell = row.getChildAt(i) as? LinearLayout ?: continue
      val fr = cell.getChildAt(0) as? FrameLayout ?: continue
      fr.background = if (i == st.filterIdx) pill(Color.TRANSPARENT, 12f).also { it.setStroke(dp(2f), Color.WHITE) } else null
      (cell.getChildAt(1) as? TextView)?.setTextColor(if (i == st.filterIdx) Color.WHITE else Color.argb(170, 255, 255, 255))
    }
  }

  private fun setTool(t: Int) {
    val cv = canvasView ?: return
    if (tool == T_CROP && t != T_CROP) {
      // fecha o recorte: grava a moldura se mudou
      val e = RectF(cv.editCrop)
      val c = st.crop
      if (abs(e.left - c.left) > 1e-4 || abs(e.top - c.top) > 1e-4 || abs(e.right - c.right) > 1e-4 || abs(e.bottom - c.bottom) > 1e-4) {
        beginMutation()
        st.crop = e
      }
    }
    tool = t
    for (i in 0 until panel.childCount) {
      val v = panel.getChildAt(i)
      val want = when (t) { T_CROP -> "crop"; T_DRAW -> "draw"; T_FILTER -> "filter"; T_STICKER -> "sticker"; else -> "" }
      v.visibility = if (v.tag == want) View.VISIBLE else View.GONE
    }
    cv.mode = when (t) { T_CROP -> PhotoCanvasView.MODE_CROP; T_DRAW -> PhotoCanvasView.MODE_DRAW; else -> PhotoCanvasView.MODE_OBJECTS }
    if (t == T_CROP) {
      cv.editCrop.set(st.crop)
      ratioSel = "free"
      cv.cropRatio = 0f
      paintRatioRow()
    }
    bottomBar.visibility = if (t == T_NONE || t == T_FILTER) View.VISIBLE else View.GONE
    if (t != T_NONE) hideKeyboard()
    paintTools()
    changed()
  }

  private fun rotateCW() {
    val cv = canvasView ?: return
    beginMutation()
    st.crop = RectF(cv.editCrop)
    st.rotateCW()
    cv.editCrop.set(st.crop)
    if (cv.cropRatio > 0f) cv.cropRatio = 1f / cv.cropRatio
    refreshDisplayBitmap()
    cv.invalidate()
    changed()
  }

  private fun resetCrop() {
    val cv = canvasView ?: return
    if (st.rotQ % 4 != 0 || st.crop.width() < 0.999f || st.crop.height() < 0.999f || cv.editCrop.width() < 0.999f || cv.editCrop.height() < 0.999f) {
      beginMutation()
      while (st.rotQ % 4 != 0) st.rotateCW()
      st.crop = RectF(0f, 0f, 1f, 1f)
    }
    cv.editCrop.set(0f, 0f, 1f, 1f)
    cv.cropRatio = 0f
    ratioSel = "free"
    paintRatioRow()
    refreshDisplayBitmap()
    cv.invalidate()
    changed()
  }

  private fun addSticker(s: String) {
    beginMutation()
    val c = st.crop
    st.objs.add(MEObj("sticker", s, Color.WHITE, 0, 0, c.centerX(), c.centerY(), 0.16f, 0f))
    setTool(T_NONE)
    canvasView?.invalidate()
    changed()
  }

  private fun undo() {
    if (history.isEmpty() || busy) return
    st = history.removeAt(history.size - 1)
    val cv = canvasView
    if (tool == T_CROP && cv != null) cv.editCrop.set(st.crop)
    refreshDisplayBitmap()
    applyFilterToCanvas()
    cv?.invalidate()
    changed()
  }

  // ── PhotoCanvasView.Host ──
  override fun state(): MEState = st
  override fun beginMutation() {
    history.add(st.copy())
    if (history.size > 60) history.removeAt(0)
  }
  override fun cancelMutation() {
    if (history.isNotEmpty()) history.removeAt(history.size - 1)
    changed()
  }
  override fun changed() {
    undoBtn?.visibility = if (history.isNotEmpty()) View.VISIBLE else View.INVISIBLE
  }
  override fun objTapped(index: Int) {
    val o = st.objs.getOrNull(index) ?: return
    if (o.kind == "text") openTextEditor(index)
  }
  override fun objDragging(active: Boolean, overTrash: Boolean) {
    if (!::trash.isInitialized) return
    trash.visibility = if (active) View.VISIBLE else View.GONE
    val s = if (overTrash) 1.25f else 1f
    trash.scaleX = s; trash.scaleY = s
    trash.background = pill(if (overTrash) Color.WHITE else Color.argb(150, 0, 0, 0), 30f, Color.argb(90, 255, 255, 255))
    trashIcon.color = if (overTrash) Color.BLACK else Color.WHITE
    topBar.alpha = if (active) 0.2f else 1f
    bottomBar.alpha = if (active) 0.2f else 1f
  }
  override fun brushColor(): Int = brushColor
  override fun brushWidthPx(): Float = dpf(PEN_DP[brushIdx.coerceIn(0, PEN_DP.size - 1)])

  // ─── editor de texto ──────────────────────────────────────────────────────

  private val fontKeys = listOf("fontClassic" to "Clássico", "fontModern" to "Moderno", "fontSerif" to "Serifa", "fontMono" to "Máquina", "fontStrong" to "Forte")

  private fun openTextEditor(index: Int) {
    editingObj = index
    val o = st.objs.getOrNull(index)
    txtColor = o?.color ?: Color.WHITE
    txtFont = o?.font ?: 0
    txtBg = o?.bg ?: 0
    if (textOverlay == null) buildTextOverlay()
    val ov = textOverlay ?: return
    val et = textInput ?: return
    et.setText(o?.text ?: "")
    et.setSelection(et.text.length)
    paintTextStyle()
    ov.visibility = View.VISIBLE
    ov.alpha = 0f
    ov.animate().alpha(1f).setDuration(140).start()
    et.requestFocus()
    main.postDelayed({
      try {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(et, InputMethodManager.SHOW_IMPLICIT)
      } catch (_: Throwable) {}
    }, 120)
  }

  private fun buildTextOverlay() {
    val ov = FrameLayout(context)
    ov.setBackgroundColor(Color.argb(150, 0, 0, 0))
    ov.isClickable = true
    val col = LinearLayout(context)
    col.orientation = LinearLayout.VERTICAL
    ov.addView(col, FrameLayout.LayoutParams(-1, -1))

    val top = LinearLayout(context)
    top.orientation = LinearLayout.HORIZONTAL
    top.gravity = Gravity.CENTER_VERTICAL
    top.setPadding(dp(8f), 0, dp(8f), 0)
    val fb = text(14f, bold = true)
    fb.gravity = Gravity.CENTER
    fb.setPadding(dp(14f), 0, dp(14f), 0)
    fb.background = pill(Color.argb(46, 255, 255, 255), 16f)
    fb.contentDescription = L("font", "Fonte")
    fb.setOnClickListener { txtFont = (txtFont + 1) % fontKeys.size; paintTextStyle() }
    fontBtn = fb
    top.addView(fb, LinearLayout.LayoutParams(-2, dp(32f)))
    val bg = MEIconView(context, "bg", 22f)
    bg.contentDescription = L("textBackground", "Fundo do texto")
    bg.setOnClickListener { txtBg = (txtBg + 1) % 3; paintTextStyle() }
    val bgLp = LinearLayout.LayoutParams(dp(44f), dp(44f))
    bgLp.leftMargin = dp(6f)
    top.addView(bg, bgLp)
    bgBtn = bg
    top.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    val done = text(15f, Color.BLACK, bold = true)
    done.text = L("done", "Concluir")
    done.gravity = Gravity.CENTER
    done.setPadding(dp(16f), 0, dp(16f), 0)
    done.background = pill(Color.WHITE, 16f)
    done.setOnClickListener { closeTextEditor(commit = true) }
    top.addView(done, LinearLayout.LayoutParams(-2, dp(32f)))
    col.addView(top, LinearLayout.LayoutParams(-1, dp(52f)))

    val mid = FrameLayout(context)
    val et = EditText(context)
    et.gravity = Gravity.CENTER
    et.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
    et.hint = L("textPlaceholder", "Digite um texto")
    et.setHintTextColor(Color.argb(110, 255, 255, 255))
    et.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    et.filters = arrayOf(InputFilter.LengthFilter(500))
    et.setPadding(dp(14f), dp(8f), dp(14f), dp(8f))
    et.maxWidth = (context.resources.displayMetrics.widthPixels * 0.88f).toInt()
    textInput = et
    mid.addView(et, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
    mid.setOnClickListener { closeTextEditor(commit = true) }
    col.addView(mid, LinearLayout.LayoutParams(-1, 0, 1f))

    val pal = LinearLayout(context)
    pal.orientation = LinearLayout.HORIZONTAL
    pal.gravity = Gravity.CENTER
    pal.setPadding(dp(10f), dp(8f), dp(10f), dp(10f))
    textPalette = pal
    col.addView(pal, LinearLayout.LayoutParams(-1, -2))

    ov.visibility = View.GONE
    textOverlay = ov
    root.addView(ov, FrameLayout.LayoutParams(-1, -1))
    ViewCompat.requestApplyInsets(root)
  }

  private fun paintTextStyle() {
    val et = textInput ?: return
    et.typeface = MEDraw.typeface(txtFont)
    val (k, fb) = fontKeys[txtFont.coerceIn(0, fontKeys.size - 1)]
    fontBtn?.text = L(k, fb)
    when (txtBg) {
      1 -> { et.background = pill(txtColor, 14f); et.setTextColor(MEDraw.contrastOn(txtColor)) }
      2 -> { et.background = pill(Color.argb(140, 0, 0, 0), 14f); et.setTextColor(txtColor) }
      else -> { et.background = null; et.setTextColor(txtColor) }
    }
    bgBtn?.filled = false
    bgBtn?.background = if (txtBg != 0) pill(Color.WHITE, 22f) else null
    bgBtn?.color = if (txtBg != 0) Color.BLACK else Color.WHITE
    val pal = textPalette ?: return
    pal.removeAllViews()
    for (c in PALETTE) {
      val v = View(context)
      val sel = c == txtColor
      val g = GradientDrawable()
      g.shape = GradientDrawable.OVAL
      g.setColor(c)
      g.setStroke(dp(if (sel) 3f else 1.5f), if (sel) Color.WHITE else Color.argb(150, 255, 255, 255))
      v.background = g
      v.setOnClickListener { txtColor = c; paintTextStyle() }
      val lp = LinearLayout.LayoutParams(dp(if (sel) 32f else 28f), dp(if (sel) 32f else 28f))
      lp.leftMargin = dp(5f); lp.rightMargin = dp(5f)
      pal.addView(v, lp)
    }
  }

  private fun closeTextEditor(commit: Boolean) {
    val ov = textOverlay ?: return
    val txt = textInput?.text?.toString()?.trimEnd() ?: ""
    if (commit) {
      val o = st.objs.getOrNull(editingObj)
      if (o != null) {
        beginMutation()
        val cur = st.objs[editingObj]
        if (txt.isBlank()) st.objs.removeAt(editingObj)
        else { cur.text = txt; cur.color = txtColor; cur.font = txtFont; cur.bg = txtBg }
      } else if (txt.isNotBlank()) {
        beginMutation()
        val c = st.crop
        st.objs.add(MEObj("text", txt, txtColor, txtFont, txtBg, c.centerX(), c.centerY(), 0.075f, 0f))
      }
      changed()
    }
    editingObj = -1
    hideKeyboard()
    ov.visibility = View.GONE
    canvasView?.invalidate()
  }

  // ─── vídeo ────────────────────────────────────────────────────────────────

  private fun fmt(ms: Long): String {
    val s = max(0L, ms) / 1000L
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
  }

  private fun paintTime() {
    val tl = timeLabel ?: return
    tl.text = if (coverMode) L("coverHint", "Escolha o quadro da capa")
    else "${fmt(trimStart)} – ${fmt(trimEnd)}  ·  ${fmt(trimEnd - trimStart)}"
    if (coverMode) tl.typeface = Typeface.DEFAULT else tl.typeface = Typeface.create(Typeface.MONOSPACE, Typeface.NORMAL)
  }

  private fun loadVideo() {
    val vv = videoView ?: return
    Thread {
      val info = try { EditorExport.videoInfo(context, opts.uri) } catch (_: Throwable) { null }
      main.post {
        if (finished) return@post
        if (info == null || info.durationMs <= 0) {
          finishWith(mapOf("action" to "error", "error" to "load_failed"))
          return@post
        }
        vInfo = info
        trimStart = 0L
        trimEnd = info.durationMs
        rail?.let { r ->
          r.durationMs = info.durationMs
          r.startMs = 0L
          r.endMs = info.durationMs
          r.minRangeMs = min(1000L, info.durationMs)
          r.invalidate()
        }
        if (!info.hasAudio) soundBtn?.visibility = View.GONE
        paintTime()
        loadThumbs(info)
        try {
          vv.setOnPreparedListener { mp ->
            player = mp
            mp.isLooping = false
            applyVolume()
            if (!userPaused && !coverMode) startPlayback()
          }
          vv.setOnCompletionListener { if (!userPaused && !coverMode) { seekTo(trimStart); vv.start() } }
          vv.setOnErrorListener { _, _, _ -> true }
          vv.setVideoURI(Uri.parse(opts.uri))
        } catch (t: Throwable) {
          Log.w(TAG, "video: ${t.message}")
        }
        progressRunning = true
        main.post(progressLoop)
      }
    }.start()
  }

  private fun loadThumbs(info: EditorExport.VideoInfo) {
    val n = 10
    val r = rail ?: return
    r.thumbs.clear()
    for (i in 0 until n) r.thumbs.add(null)
    Thread {
      val mmr = EditorExport.retriever(context, opts.uri) ?: return@Thread
      try {
        for (i in 0 until n) {
          if (finished) break
          val t = (info.durationMs * (i + 0.5f) / n).toLong()
          val b = EditorExport.frameAt(mmr, t, 180, exact = false)
          main.post {
            if (finished) { b?.recycle(); return@post }
            if (i < r.thumbs.size) r.thumbs[i] = b
            r.invalidate()
          }
        }
      } finally {
        try { mmr.release() } catch (_: Throwable) {}
      }
    }.start()
  }

  private fun seekTo(ms: Long) {
    val mp = player
    try {
      if (mp != null && Build.VERSION.SDK_INT >= 26) mp.seekTo(ms, MediaPlayer.SEEK_CLOSEST)
      else videoView?.seekTo(ms.toInt())
    } catch (_: Throwable) {
      try { videoView?.seekTo(ms.toInt()) } catch (_: Throwable) {}
    }
  }

  private fun startPlayback() {
    val vv = videoView ?: return
    try {
      val pos = vv.currentPosition.toLong()
      if (pos < trimStart || pos >= trimEnd - 80) seekTo(trimStart)
      vv.start()
      (stage.tag as? View)?.visibility = View.GONE
    } catch (_: Throwable) {}
  }

  private fun applyVolume() {
    val v = if (muted) 0f else 1f
    try { player?.setVolume(v, v) } catch (_: Throwable) {}
  }

  private fun toggleMute() {
    muted = !muted
    applyVolume()
    soundBtn?.icon = if (muted) "soundOff" else "soundOn"
    soundBtn?.contentDescription = if (muted) L("soundOff", "Sem som") else L("soundOn", "Som ativado")
    try {
      Toast.makeText(context, if (muted) L("soundOff", "Sem som") else L("soundOn", "Som ativado"), Toast.LENGTH_SHORT).show()
    } catch (_: Throwable) {}
  }

  private fun tickVideo() {
    val vv = videoView ?: return
    if (vInfo == null) return
    try {
      val pos = vv.currentPosition.toLong()
      if (vv.isPlaying && !coverMode && pos >= trimEnd) {
        seekTo(trimStart)
      }
      if (!coverMode) rail?.playheadMs = pos
    } catch (_: Throwable) {}
  }

  private fun setCoverMode(on: Boolean) {
    coverMode = on
    val r = rail ?: return
    r.coverMode = on
    if (on) {
      if (coverMs < 0) coverMs = trimStart
      r.coverMs = coverMs
      try { videoView?.pause() } catch (_: Throwable) {}
      seekTo(coverMs)
      coverBtn?.background = pill(Color.WHITE, 14f)
      setCoverBtnColors(Color.BLACK)
    } else {
      coverBtn?.background = pill(Color.argb(40, 255, 255, 255), 14f)
      setCoverBtnColors(Color.WHITE)
      if (!userPaused) startPlayback()
    }
    paintTime()
  }

  private fun setCoverBtnColors(c: Int) {
    val cb = coverBtn ?: return
    for (i in 0 until cb.childCount) {
      val v = cb.getChildAt(i)
      if (v is MEIconView) v.color = c
      if (v is TextView) v.setTextColor(c)
    }
  }

  private fun refreshCoverThumb() {
    val ms = coverMs
    if (ms < 0) return
    Thread {
      val mmr = EditorExport.retriever(context, opts.uri) ?: return@Thread
      val b = try { EditorExport.frameAt(mmr, ms, 96, exact = false) } finally { try { mmr.release() } catch (_: Throwable) {} }
      main.post {
        if (finished || b == null) return@post
        coverThumb?.setImageBitmap(b)
        coverThumb?.visibility = View.VISIBLE
      }
    }.start()
  }

  // ── TrimRailView.Listener ──
  override fun rangeChanging(startMs: Long, endMs: Long, editingStart: Boolean) {
    trimStart = startMs
    trimEnd = endMs
    try { videoView?.pause() } catch (_: Throwable) {}
    seekTo(if (editingStart) startMs else endMs)
    paintTime()
  }
  override fun rangeChanged(startMs: Long, endMs: Long) {
    trimStart = startMs
    trimEnd = endMs
    if (coverMs >= 0 && (coverMs < startMs || coverMs > endMs)) coverMs = startMs
    paintTime()
    if (!userPaused) startPlayback()
  }
  override fun coverChanging(ms: Long) {
    if (ms < 0) return
    coverMs = ms
    seekTo(ms)
  }
  override fun coverChanged(ms: Long) {
    coverMs = ms
    seekTo(ms)
    refreshCoverThumb()
  }
  override fun seek(ms: Long) {
    seekTo(ms)
  }

  // ─── exportação ───────────────────────────────────────────────────────────

  private fun showBusy(on: Boolean) {
    busy = on
    if (::busyView.isInitialized) busyView.visibility = if (on) View.VISIBLE else View.GONE
  }

  private fun baseResult(action: String): HashMap<String, Any?> {
    val m = HashMap<String, Any?>()
    m["action"] = action
    m["caption"] = captionInput?.text?.toString() ?: opts.caption
    m["viewOnce"] = viewOnce
    m["hd"] = hd
    return m
  }

  private fun export(action: String) {
    if (busy) return
    if (tool == T_CROP) setTool(T_NONE)
    if (textOverlay?.visibility == View.VISIBLE) closeTextEditor(commit = true)
    hideKeyboard()
    if (opts.isVideo) exportVideo(action) else exportPhoto(action)
  }

  private fun exportPhoto(action: String) {
    val res = baseResult(action)
    val snapshot = st.copy()
    val edits = HashMap<String, Any?>()
    edits["rotate"] = (snapshot.rotQ % 4) * 90
    edits["crop"] = mapOf("x" to snapshot.crop.left.toDouble(), "y" to snapshot.crop.top.toDouble(), "w" to snapshot.crop.width().toDouble(), "h" to snapshot.crop.height().toDouble())
    edits["filter"] = opts.filters.getOrNull(snapshot.filterIdx)?.id ?: "original"
    edits["strokes"] = snapshot.strokes.size
    edits["objects"] = snapshot.objs.size
    edits["texts"] = snapshot.objs.count { it.kind == "text" }
    edits["stickers"] = snapshot.objs.count { it.kind == "sticker" }
    res["type"] = "image"
    if (snapshot.isPristine()) {
      edits["changed"] = false
      res["edits"] = edits
      res["uri"] = opts.uri
      val sz = EditorExport.imageSize(context, opts.uri)
      res["width"] = sz?.first ?: 0
      res["height"] = sz?.second ?: 0
      finishWith(res)
      return
    }
    edits["changed"] = true
    showBusy(true)
    val filter = opts.filters.getOrNull(snapshot.filterIdx)?.androidMatrix()
    val maxDim = if (hd) opts.hdMaxDim else opts.maxDim
    Thread {
      val out = try { EditorExport.renderPhoto(context, opts.uri, snapshot, filter, maxDim, opts.quality) } catch (_: Throwable) { null }
      main.post {
        if (finished) return@post
        showBusy(false)
        if (out == null) {
          try { Toast.makeText(context, L("saveFailed", "Não foi possível salvar"), Toast.LENGTH_SHORT).show() } catch (_: Throwable) {}
          return@post
        }
        res["uri"] = out.uri
        res["width"] = out.width
        res["height"] = out.height
        res["size"] = out.size
        res["mimeType"] = "image/jpeg"
        res["edits"] = edits
        finishWith(res)
      }
    }.start()
  }

  private fun exportVideo(action: String) {
    val info = vInfo ?: run { finishWith(baseResult(action).also { it["uri"] = opts.uri; it["type"] = "video" }); return }
    try { videoView?.pause() } catch (_: Throwable) {}
    val res = baseResult(action)
    res["type"] = "video"
    val dur = info.durationMs
    val trimmed = trimStart > 0 || trimEnd < dur - 50
    val needRemux = trimmed || (muted && info.hasAudio)
    val edits = HashMap<String, Any?>()
    edits["trimStartMs"] = trimStart
    edits["trimEndMs"] = trimEnd
    edits["muted"] = muted
    edits["changed"] = needRemux || coverMs >= 0
    val cover = coverMs
    showBusy(true)
    Thread {
      var outUri = opts.uri
      var outDur = dur
      var outSize: Long? = null
      var startUsed = 0L
      var ok = true
      if (needRemux) {
        val r = try { EditorExport.remux(context, opts.uri, if (trimmed) trimStart else 0L, if (trimmed) trimEnd else 0L, muted, info.rotation) } catch (_: Throwable) { null }
        if (r != null) { outUri = r.uri; outDur = r.durationMs; outSize = r.size; startUsed = if (trimmed) trimStart else 0L }
        else ok = false
      }
      var coverUri: String? = null
      if (cover >= 0) {
        val mmr = EditorExport.retriever(context, opts.uri)
        if (mmr != null) {
          try {
            val b = EditorExport.frameAt(mmr, cover, 1280, exact = true)
            if (b != null) {
              val f = File(context.cacheDir, "cover_${System.currentTimeMillis()}.jpg")
              if (EditorExport.saveJpeg(b, f, 88)) coverUri = "file://${f.absolutePath}"
              b.recycle()
            }
          } finally { try { mmr.release() } catch (_: Throwable) {} }
        }
      }
      main.post {
        if (finished) return@post
        showBusy(false)
        if (!ok) {
          try { Toast.makeText(context, L("saveFailed", "Não foi possível salvar"), Toast.LENGTH_SHORT).show() } catch (_: Throwable) {}
          edits["exportFailed"] = true
          // segue com o original (o servidor/JS ainda pode cortar)
        }
        res["uri"] = outUri
        res["durationMs"] = outDur
        res["width"] = info.width
        res["height"] = info.height
        if (outSize != null) res["size"] = outSize
        res["mimeType"] = "video/mp4"
        if (coverUri != null) {
          res["coverUri"] = coverUri
          res["coverMs"] = max(0L, cover - startUsed)
        }
        res["edits"] = edits
        finishWith(res)
      }
    }.start()
  }
}
