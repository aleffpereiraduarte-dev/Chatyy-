package expo.modules.chatyyattach

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.MirrorMode
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.ExperimentalPersistentRecording
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** [2026-10-15 native-vnote] Opções do gravador de vídeo-recado (vindas do JS). */
class VNConfig(o: Map<String, Any?>) {
  val labels: Map<String, String>
  val maxSec: Double
  val size: Int
  val autoStart: Boolean
  val withAudio: Boolean
  val bitrate: Int

  init {
    val l = HashMap<String, String>()
    (o["labels"] as? Map<*, *>)?.forEach { (k, v) -> if (k is String && v is String) l[k] = v }
    labels = l
    maxSec = ((o["maxSec"] as? Number)?.toDouble() ?: 60.0).coerceIn(3.0, 120.0)
    size = (((o["size"] as? Number)?.toInt() ?: 640).coerceIn(240, 1080)) and 1.inv()
    autoStart = (o["autoStart"] as? Boolean) ?: true
    withAudio = (o["withAudio"] as? Boolean) ?: true
    bitrate = ((o["bitrate"] as? Number)?.toInt() ?: 1_200_000).coerceIn(300_000, 6_000_000)
  }

  fun t(key: String, fallback: String): String {
    val v = labels[key]
    return if (v.isNullOrEmpty()) fallback else v
  }
}

/**
 * [2026-10-15 native-vnote] Gravador de VÍDEO-RECADO redondo (nível Telegram).
 *  • preview CameraX recortado em círculo + anel de progresso (máx. maxSec);
 *  • autoStart: começa a gravar travado (mãos livres) → Enviar / Lixeira;
 *    senão: segurar = grava, ↑ trava, ← cancela, soltar ≥1 s envia;
 *  • duplo toque no círculo = troca câmera (inclusive gravando: gravação
 *    persistente do CameraX); flash: traseira = lanterna, frontal = tela branca;
 *  • saída: MP4 quadrado H.264 size×size + AAC (VNTranscoder); falhou → original.
 * Resultado: {action:'send', item} | {action:'cancel'} | {action:'error', message}.
 */
@SuppressLint("ViewConstructor")
class VideoNoteDialog(
  private val host: Activity,
  private val cfg: VNConfig,
  private val askPermissions: (perms: Array<String>, done: () -> Unit) -> Unit,
  private val onResult: (Map<String, Any?>) -> Unit,
) : Dialog(host, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {

  companion object {
    private const val TAG = "ChatyyVNote"
    private const val LOCK_DP = 60f
    private const val CANCEL_DP = 90f
    private const val BG_DIM = 0xD9000000.toInt()
  }

  private enum class Pending { NONE, SEND, DISCARD }

  private val ctx: Context = host
  private fun dp(v: Float) = CAUtil.dp(ctx, v)

  private var finished = false
  private val life = CALifecycle()
  private var provider: ProcessCameraProvider? = null
  private var camera: Camera? = null
  private var preview: Preview? = null
  private var videoCapture: VideoCapture<Recorder>? = null
  private var front = true
  private var flashOn = false
  private var recording: Recording? = null
  private var recordingActive = false
  private var recordFile: File? = null
  private var recStartMs = 0L
  private var locked = false
  private var holding = false
  private var cancelIntent = false
  private var downRawX = 0f
  private var downRawY = 0f
  private var downAt = 0L
  private var pending = Pending.NONE
  private var processing = false
  private var permDenied = false
  private var autoStarted = false
  private var lastWarnSec = -1
  private var savedBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
  private var circleD = 0
  private var insetTop = 0
  private var insetBottom = 0

  // views
  private val root = FrameLayout(ctx)
  private val circle = FrameLayout(ctx)
  private val previewView = PreviewView(ctx)
  private val ring = RingView(ctx)
  private val spinner = ProgressBar(ctx)
  private val processingText = TextView(ctx)
  private val closeBtn = ImageButton(ctx)
  private val flashBtn = ImageButton(ctx)
  private val flipBtn = ImageButton(ctx)
  private val timerPill = LinearLayout(ctx)
  private val timerDot = View(ctx)
  private val timerText = TextView(ctx)
  private val recBtn = FrameLayout(ctx)
  private val recDot = View(ctx)
  private val recArrow = ImageView(ctx)
  private val lockPill = LinearLayout(ctx)
  private val lockChevron = ImageView(ctx)
  private val trashBtn = ImageButton(ctx)
  private val hint = TextView(ctx)
  private val permCard = LinearLayout(ctx)
  private val permTitle = TextView(ctx)
  private val permBody = TextView(ctx)
  private val permBtn = TextView(ctx)

  private val tick = object : Runnable {
    override fun run() {
      if (!recordingActive || finished) return
      val el = System.currentTimeMillis() - recStartMs
      val maxMs = (cfg.maxSec * 1000).toLong()
      val p = (el.toFloat() / maxMs).coerceIn(0f, 1f)
      val warn = el >= maxMs - 10_000
      ring.set(p, warn)
      timerText.text = CAUtil.fmtDur(Math.floor(el / 1000.0))
      timerDot.alpha = if ((el / 500) % 2L == 0L) 1f else 0.3f
      if (warn) {
        val s = (el / 1000).toInt()
        if (s != lastWarnSec) { lastWarnSec = s; CAUtil.haptic(recBtn, "warn") }
      }
      if (el >= maxMs) { requestSend(); return }
      CAUtil.main.postDelayed(this, 100)
    }
  }

  private val lifecycleCb = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(a: Activity, b: Bundle?) {}
    override fun onActivityStarted(a: Activity) {}
    override fun onActivityResumed(a: Activity) {
      if (a !== host) return
      life.resume()
      // Voltou dos Ajustes com a permissão concedida.
      if (!finished && permCard.visibility == View.VISIBLE && allGranted()) {
        permCard.visibility = View.GONE
        bind()
      }
    }
    override fun onActivityPaused(a: Activity) {
      if (a !== host) return
      if (recordingActive) { discardAndClose(); return }
      life.pause()
    }
    override fun onActivityStopped(a: Activity) {}
    override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
    override fun onActivityDestroyed(a: Activity) { if (a === host) finishSilently() }
  }

  // ─── ciclo de vida ──────────────────────────────────────────────────────

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    buildUi()
    setContentView(root)
    setupWindow()
    setCancelable(true)
    setCanceledOnTouchOutside(false)
    try { host.application.registerActivityLifecycleCallbacks(lifecycleCb) } catch (_: Throwable) {}
    startFlow()
  }

  override fun onStart() {
    super.onStart()
    window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    if (processing) return
    if (recordingActive) { discardAndClose(); return }
    finish(mapOf("action" to "cancel"))
  }

  override fun dismiss() {
    if (!finished) finish(mapOf("action" to "cancel")) else realDismiss()
  }

  private fun realDismiss() {
    CAUtil.main.removeCallbacks(tick)
    releaseCamera()
    setBrightness(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE)
    try { host.application.unregisterActivityLifecycleCallbacks(lifecycleCb) } catch (_: Throwable) {}
    try { super.dismiss() } catch (_: Throwable) {}
  }

  private fun setupWindow() {
    val w = window ?: return
    ScreenProtectBridge.protect(w, false) // [2026-10-15 screen-protect-all]
    w.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
    w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    w.setWindowAnimations(android.R.style.Animation_Dialog)
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
    w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    savedBrightness = w.attributes.screenBrightness
    val ctl = WindowInsetsControllerCompat(w, w.decorView)
    ctl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    ctl.isAppearanceLightStatusBars = false
    ctl.isAppearanceLightNavigationBars = false
  }

  // ─── UI ─────────────────────────────────────────────────────────────────

  private fun roundBtn(b: ImageButton, icon: Int, label: String, size: Float) {
    b.setImageResource(icon)
    b.setColorFilter(Color.WHITE)
    b.background = caCircleBg(0x47FFFFFF)
    b.contentDescription = label
    b.scaleType = ImageView.ScaleType.CENTER
    val pad = dp((size - 24f) / 2f)
    b.setPadding(pad, pad, pad, pad)
  }

  private fun text(v: TextView, sp: Float, color: Int, bold: Boolean = false) {
    v.setTextColor(color)
    v.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    if (bold) v.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  }

  @SuppressLint("ClickableViewAccessibility")
  private fun buildUi() {
    root.setBackgroundColor(BG_DIM)
    root.isClickable = true

    // Círculo do preview.
    previewView.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    previewView.scaleType = PreviewView.ScaleType.FILL_CENTER
    circle.setBackgroundColor(0xFF1A1A1A.toInt())
    circle.addView(previewView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    circle.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) { outline.setOval(0, 0, view.width, view.height) }
    }
    circle.clipToOutline = true
    val gd = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
      override fun onDown(e: MotionEvent): Boolean = true
      override fun onDoubleTap(e: MotionEvent): Boolean { flip(); return true }
    })
    previewView.setOnTouchListener { _, ev -> gd.onTouchEvent(ev); true }
    root.addView(circle, FrameLayout.LayoutParams(dp(300f), dp(300f), Gravity.TOP or Gravity.START))
    ring.isClickable = false
    root.addView(ring, FrameLayout.LayoutParams(dp(316f), dp(316f), Gravity.TOP or Gravity.START))

    spinner.isIndeterminate = true
    try { spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE) } catch (_: Throwable) {}
    spinner.visibility = View.GONE
    root.addView(spinner, FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.TOP or Gravity.START))
    text(processingText, 14f, 0xE6FFFFFF.toInt(), true)
    processingText.text = cfg.t("processing", "Preparando vídeo…")
    processingText.gravity = Gravity.CENTER
    processingText.visibility = View.GONE
    root.addView(processingText, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP))

    // Timer acima do círculo.
    timerPill.orientation = LinearLayout.HORIZONTAL
    timerPill.gravity = Gravity.CENTER_VERTICAL
    timerPill.setPadding(dp(12f), 0, dp(12f), 0)
    timerPill.background = GradientDrawable().apply { cornerRadius = dp(15f).toFloat(); setColor(0x73000000) }
    timerPill.visibility = View.INVISIBLE
    timerDot.background = caCircleBg(0xFFEF4444.toInt())
    timerPill.addView(timerDot, LinearLayout.LayoutParams(dp(9f), dp(9f)))
    text(timerText, 15f, Color.WHITE)
    timerText.typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
    timerText.text = "0:00"
    val ttlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    ttlp.leftMargin = dp(7f)
    timerPill.addView(timerText, ttlp)
    root.addView(timerPill, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(30f), Gravity.TOP or Gravity.START))

    // Topo.
    roundBtn(closeBtn, R.drawable.ca_ic_close, cfg.t("close", "Fechar"), 44f)
    closeBtn.setOnClickListener {
      if (processing) return@setOnClickListener
      if (recordingActive) discardAndClose() else finish(mapOf("action" to "cancel"))
    }
    roundBtn(flashBtn, R.drawable.ca_ic_flash_off, cfg.t("flashOff", "Flash desligado"), 44f)
    flashBtn.setOnClickListener { toggleFlash() }
    roundBtn(flipBtn, R.drawable.ca_ic_flip, cfg.t("flip", "Trocar câmera"), 44f)
    flipBtn.setOnClickListener { flip() }
    root.addView(closeBtn, FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.TOP or Gravity.START))
    root.addView(flashBtn, FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.TOP or Gravity.END))
    root.addView(flipBtn, FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.TOP or Gravity.END))

    // Dica (embaixo, à esquerda do botão).
    text(hint, 14f, 0xD9FFFFFF.toInt())
    hint.text = cfg.t("hold", "Segure para gravar")
    hint.setShadowLayer(3f, 0f, 0f, 0x80000000.toInt())
    hint.gravity = Gravity.CENTER_VERTICAL or Gravity.START
    hint.maxLines = 2
    root.addView(hint, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(72f), Gravity.BOTTOM or Gravity.START))

    // Lixeira (esquerda).
    roundBtn(trashBtn, R.drawable.ca_ic_trash, cfg.t("cancel", "Descartar"), 52f)
    trashBtn.visibility = View.INVISIBLE
    trashBtn.setOnClickListener { if (recordingActive && locked) discardAndClose() }
    root.addView(trashBtn, FrameLayout.LayoutParams(dp(52f), dp(52f), Gravity.BOTTOM or Gravity.START))

    // Pílula do cadeado (acima do botão, enquanto segura).
    lockPill.orientation = LinearLayout.VERTICAL
    lockPill.gravity = Gravity.CENTER_HORIZONTAL
    lockPill.setPadding(0, dp(10f), 0, dp(8f))
    lockPill.background = GradientDrawable().apply { cornerRadius = dp(22f).toFloat(); setColor(0x99000000.toInt()); setStroke(dp(1f), 0x33FFFFFF) }
    val li = ImageView(ctx)
    li.setImageResource(R.drawable.ca_ic_lock)
    li.setColorFilter(Color.WHITE)
    lockPill.addView(li, LinearLayout.LayoutParams(dp(20f), dp(20f)))
    lockChevron.setImageResource(R.drawable.ca_ic_chevron_up)
    lockChevron.setColorFilter(0xB3FFFFFF.toInt())
    val clp = LinearLayout.LayoutParams(dp(20f), dp(20f))
    clp.topMargin = dp(6f)
    lockPill.addView(lockChevron, clp)
    lockPill.visibility = View.INVISIBLE
    root.addView(lockPill, FrameLayout.LayoutParams(dp(44f), dp(86f), Gravity.BOTTOM or Gravity.END))

    // Botão gravar/enviar.
    recBtn.contentDescription = cfg.t("hold", "Segure para gravar")
    recDot.background = caCircleBg(0xFFEF4444.toInt())
    recBtn.addView(recDot, FrameLayout.LayoutParams(dp(54f), dp(54f), Gravity.CENTER))
    recArrow.setImageResource(R.drawable.ca_ic_arrow_up)
    recArrow.setColorFilter(Color.BLACK)
    recArrow.visibility = View.GONE
    recBtn.addView(recArrow, FrameLayout.LayoutParams(dp(28f), dp(28f), Gravity.CENTER))
    recBtn.setOnTouchListener { _, ev -> onRecTouch(ev); true }
    root.addView(recBtn, FrameLayout.LayoutParams(dp(72f), dp(72f), Gravity.BOTTOM or Gravity.END))
    setRecUi()

    buildPermCard()

    root.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or_, ob ->
      if (r - l != or_ - ol || b - t != ob - ot) root.post { layoutCircle() }
    }
    ViewCompat.setOnApplyWindowInsetsListener(root) { _, ins ->
      val sys = ins.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      insetTop = sys.top
      insetBottom = sys.bottom
      val top = sys.top + dp(8f)
      (closeBtn.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = top; it.leftMargin = dp(12f); closeBtn.layoutParams = it }
      (flashBtn.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = top; it.rightMargin = dp(12f); flashBtn.layoutParams = it }
      (flipBtn.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = top; it.rightMargin = dp(12f + 44f + 10f); flipBtn.layoutParams = it }
      val bottom = sys.bottom + dp(24f)
      (recBtn.layoutParams as FrameLayout.LayoutParams).let { it.bottomMargin = bottom; it.rightMargin = dp(24f); recBtn.layoutParams = it }
      (lockPill.layoutParams as FrameLayout.LayoutParams).let { it.bottomMargin = bottom + dp(72f + 18f); it.rightMargin = dp(24f + 14f); lockPill.layoutParams = it }
      (trashBtn.layoutParams as FrameLayout.LayoutParams).let { it.bottomMargin = bottom + dp(10f); it.leftMargin = dp(24f); trashBtn.layoutParams = it }
      (hint.layoutParams as FrameLayout.LayoutParams).let { it.bottomMargin = bottom; it.leftMargin = dp(24f); it.rightMargin = dp(24f + 72f + 16f); hint.layoutParams = it }
      root.post { layoutCircle() }
      ins
    }
  }

  private fun layoutCircle() {
    val w = root.width
    val h = root.height
    if (w <= 0 || h <= 0) return
    val d = min(w - dp(48f), dp(320f))
    val cx = w / 2
    val cy = (h * 0.40f).toInt().coerceAtLeast(insetTop + dp(70f) + d / 2)
    if (d == circleD && (circle.layoutParams as FrameLayout.LayoutParams).topMargin == cy - d / 2) return
    circleD = d
    fun place(v: View, size: Int, top: Int, left: Int) {
      val lp = v.layoutParams as FrameLayout.LayoutParams
      lp.width = size; lp.height = size; lp.topMargin = top; lp.leftMargin = left
      lp.gravity = Gravity.TOP or Gravity.START
      v.layoutParams = lp
    }
    place(circle, d, cy - d / 2, cx - d / 2)
    val rs = d + dp(16f)
    place(ring, rs, cy - rs / 2, cx - rs / 2)
    val ss = dp(44f)
    place(spinner, ss, cy - ss / 2, cx - ss / 2)
    (processingText.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = cy + d / 2 + dp(20f); processingText.layoutParams = it }
    timerPill.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.makeMeasureSpec(dp(30f), View.MeasureSpec.EXACTLY))
    (timerPill.layoutParams as FrameLayout.LayoutParams).let {
      it.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
      it.topMargin = cy - d / 2 - dp(14f + 30f)
      timerPill.layoutParams = it
    }
  }

  private fun buildPermCard() {
    permCard.orientation = LinearLayout.VERTICAL
    permCard.gravity = Gravity.CENTER_HORIZONTAL
    permCard.setPadding(dp(24f), dp(24f), dp(24f), dp(20f))
    permCard.background = GradientDrawable().apply { cornerRadius = dp(20f).toFloat(); setColor(0xFF1C1C1E.toInt()) }
    permCard.visibility = View.GONE
    permCard.isClickable = true
    val icon = ImageView(ctx)
    icon.setImageResource(R.drawable.ca_ic_camera)
    icon.setColorFilter(Color.WHITE)
    permCard.addView(icon, LinearLayout.LayoutParams(dp(36f), dp(36f)))
    text(permTitle, 18f, Color.WHITE, true)
    permTitle.gravity = Gravity.CENTER
    permTitle.text = cfg.t("permTitle", "Vídeo-recado")
    val tlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    tlp.topMargin = dp(12f)
    permCard.addView(permTitle, tlp)
    text(permBody, 15f, 0xB3FFFFFF.toInt())
    permBody.gravity = Gravity.CENTER
    val blp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    blp.topMargin = dp(8f)
    permCard.addView(permBody, blp)
    text(permBtn, 16f, Color.BLACK, true)
    permBtn.gravity = Gravity.CENTER
    permBtn.setPadding(dp(24f), 0, dp(24f), 0)
    permBtn.background = GradientDrawable().apply { cornerRadius = dp(22f).toFloat(); setColor(Color.WHITE) }
    permBtn.setOnClickListener { onPermButton() }
    val btlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(44f))
    btlp.topMargin = dp(18f)
    permCard.addView(permBtn, btlp)
    val lp = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER)
    lp.leftMargin = dp(32f); lp.rightMargin = dp(32f)
    root.addView(permCard, lp)
  }

  private fun setRecUi() {
    val idle = !recordingActive
    when {
      recordingActive && locked -> {
        recBtn.background = caCircleBg(Color.WHITE)
        recDot.visibility = View.GONE
        recArrow.visibility = View.VISIBLE
        recBtn.contentDescription = cfg.t("send", "Enviar")
        recBtn.animate().scaleX(1f).scaleY(1f).translationX(0f).translationY(0f).setDuration(180).start()
      }
      recordingActive -> {
        recBtn.background = caCircleBg(0xFFEF4444.toInt())
        recDot.visibility = View.GONE
        recArrow.visibility = View.GONE
        recBtn.animate().scaleX(1.3f).scaleY(1.3f).setDuration(160).start()
      }
      else -> {
        recBtn.background = caCircleBg(0x00000000, Color.WHITE, dp(4f))
        recDot.visibility = View.VISIBLE
        recArrow.visibility = View.GONE
        recBtn.contentDescription = cfg.t("hold", "Segure para gravar")
        recBtn.animate().scaleX(1f).scaleY(1f).translationX(0f).translationY(0f).setDuration(160).start()
      }
    }
    timerPill.visibility = if (recordingActive) View.VISIBLE else View.INVISIBLE
    trashBtn.visibility = if (recordingActive && (locked || holding)) View.VISIBLE else View.INVISIBLE
    trashBtn.isClickable = recordingActive && locked
    lockPill.visibility = if (recordingActive && holding && !locked) View.VISIBLE else View.INVISIBLE
    if (lockPill.visibility == View.VISIBLE) startChevron() else lockChevron.animate().cancel()
    hint.visibility = if (locked && recordingActive) View.INVISIBLE else View.VISIBLE
    hint.text = when {
      cancelIntent -> cfg.t("releaseToCancel", "Solte para cancelar")
      recordingActive && holding -> cfg.t("slideHints", "Deslize ↑ travar • ← cancelar")
      else -> cfg.t("hold", "Segure para gravar")
    }
    if (idle) { ring.set(0f, false); timerText.text = "0:00" }
    flipBtn.alpha = if (processing) 0.4f else 1f
  }

  private fun startChevron() {
    lockChevron.translationY = 0f
    lockChevron.animate().translationY(-dp(5f).toFloat()).setDuration(600).withEndAction {
      lockChevron.animate().translationY(0f).setDuration(600).withEndAction {
        if (lockPill.visibility == View.VISIBLE && !finished) startChevron()
      }.start()
    }.start()
  }

  // ─── permissão / sessão ─────────────────────────────────────────────────

  private fun neededPerms(): Array<String> {
    val l = ArrayList<String>()
    if (!CAUtil.hasCamera(ctx)) l.add(Manifest.permission.CAMERA)
    if (cfg.withAudio && !CAUtil.hasMic(ctx)) l.add(Manifest.permission.RECORD_AUDIO)
    return l.toTypedArray()
  }

  private fun allGranted() = neededPerms().isEmpty()

  private fun startFlow() {
    if (allGranted()) { bind(); return }
    showPermCard(denied = false)
  }

  private fun showPermCard(denied: Boolean) {
    permDenied = denied
    permBody.text = if (denied) cfg.t("permDeniedBody", "A câmera ou o microfone estão bloqueados. Ative nos Ajustes.")
      else cfg.t("permBody", "Para gravar, o Chatyy precisa da câmera e do microfone.")
    permBtn.text = if (denied) cfg.t("permSettings", "Abrir Ajustes") else cfg.t("permAllow", "Continuar")
    permCard.visibility = View.VISIBLE
    recBtn.visibility = View.INVISIBLE
    hint.visibility = View.INVISIBLE
    flashBtn.visibility = View.INVISIBLE
    flipBtn.visibility = View.INVISIBLE
  }

  private fun onPermButton() {
    if (permDenied) {
      try {
        val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
      } catch (_: Throwable) {}
      return
    }
    val need = neededPerms()
    if (need.isEmpty()) { permCard.visibility = View.GONE; bind(); return }
    askPermissions(need) {
      if (finished) return@askPermissions
      if (allGranted()) { permCard.visibility = View.GONE; bind() } else showPermCard(denied = true)
    }
  }

  private fun bind() {
    permCard.visibility = View.GONE
    recBtn.visibility = View.VISIBLE
    hint.visibility = View.VISIBLE
    flashBtn.visibility = View.VISIBLE
    flipBtn.visibility = View.VISIBLE
    life.start()
    CameraHub.withProvider(ctx) { p ->
      if (finished) return@withProvider
      if (p == null) { finish(mapOf("action" to "error", "message" to cfg.t("error", "Não foi possível gravar o vídeo"))); return@withProvider }
      provider = p
      if (!bindUseCases()) {
        finish(mapOf("action" to "error", "message" to cfg.t("error", "Não foi possível gravar o vídeo")))
        return@withProvider
      }
      if (cfg.autoStart && !autoStarted) {
        autoStarted = true
        CAUtil.main.postDelayed({
          if (!finished && !recordingActive && !processing) { locked = true; startRecording() }
        }, 350)
      }
    }
  }

  private fun selector() = if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA

  private fun bindUseCases(): Boolean {
    val p = provider ?: return false
    try { unbindOurs() } catch (_: Throwable) {}
    val pv = Preview.Builder().build()
    pv.setSurfaceProvider(previewView.surfaceProvider)
    val recorder = Recorder.Builder()
      .setQualitySelector(QualitySelector.from(Quality.HD, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
      .build()
    // [2026-10-15 espelho] ESCOLHA: o vídeo-recado redondo sai IGUAL ao
    // preview (frontal espelhada), como a nota circular do WhatsApp/Telegram;
    // iOS idem (CAEngine.setFrontOutputMirrored(true)). Câmera do chat/status
    // (ChatCameraDialog) envia NÃO espelhado. CameraX aplica o espelho no
    // pipeline (pixels) → independe de metadado/aparelho.
    val vc = VideoCapture.Builder(recorder)
      .setMirrorMode(MirrorMode.MIRROR_MODE_ON_FRONT_ONLY)
      .build()
    preview = pv
    videoCapture = vc
    camera = try {
      p.bindToLifecycle(life, selector(), pv, vc)
    } catch (t: Throwable) {
      Log.w(TAG, "bind failed: ${t.message}")
      // Sem câmera frontal? tenta a outra.
      try { front = !front; p.bindToLifecycle(life, selector(), pv, vc) } catch (t2: Throwable) { null }
    }
    applyFlash()
    return camera != null
  }

  private fun unbindOurs() {
    val p = provider ?: return
    val list = listOfNotNull(preview, videoCapture)
    if (list.isNotEmpty()) p.unbind(*list.toTypedArray())
  }

  private fun releaseCamera() {
    stopRecordingIfAny()
    try { camera?.cameraControl?.enableTorch(false) } catch (_: Throwable) {}
    try { unbindOurs() } catch (_: Throwable) {}
    camera = null
    life.destroy()
  }

  // ─── controles ──────────────────────────────────────────────────────────

  /** Troca câmera; gravando = gravação persistente segue na outra câmera. */
  private fun flip() {
    if (processing || finished) return
    val p = provider ?: return
    val pv = preview ?: return
    val vc = videoCapture ?: return
    val old = front
    front = !front
    try {
      p.unbind(pv, vc)
      camera = p.bindToLifecycle(life, selector(), pv, vc)
    } catch (t: Throwable) {
      Log.w(TAG, "flip failed: ${t.message}")
      front = old
      try { camera = p.bindToLifecycle(life, selector(), pv, vc) } catch (_: Throwable) {}
    }
    CAUtil.haptic(flipBtn, "select")
    flipBtn.animate().rotationBy(180f).setDuration(250).start()
    previewView.alpha = 0.3f
    previewView.animate().alpha(1f).setDuration(220).start()
    applyFlash()
  }

  private fun toggleFlash() {
    flashOn = !flashOn
    CAUtil.haptic(flashBtn, "select")
    applyFlash()
  }

  private fun applyFlash() {
    flashBtn.setImageResource(if (flashOn) R.drawable.ca_ic_flash_on else R.drawable.ca_ic_flash_off)
    flashBtn.contentDescription = if (flashOn) cfg.t("flashOn", "Flash ligado") else cfg.t("flashOff", "Flash desligado")
    val screen = flashOn && front
    try { camera?.cameraControl?.enableTorch(flashOn && !front) } catch (_: Throwable) {}
    root.setBackgroundColor(if (screen) Color.WHITE else BG_DIM)
    val iconTint = if (screen) Color.BLACK else Color.WHITE
    for (b in listOf(closeBtn, flashBtn, flipBtn, trashBtn)) {
      b.setColorFilter(iconTint)
      b.background = caCircleBg(if (screen) 0x1F000000 else 0x47FFFFFF)
    }
    hint.setTextColor(if (screen) 0xD9000000.toInt() else 0xD9FFFFFF.toInt())
    processingText.setTextColor(if (screen) 0xE6000000.toInt() else 0xE6FFFFFF.toInt())
    ring.track = if (screen) 0x33000000 else 0x33FFFFFF
    ring.ink = if (screen) Color.BLACK else Color.WHITE
    ring.invalidate()
    if (!recordingActive) recBtn.background = caCircleBg(0x00000000, iconTint, dp(4f))
    setBrightness(if (screen) 1f else savedBrightness)
  }

  private fun setBrightness(v: Float) {
    try {
      val w = window ?: return
      val a = w.attributes
      a.screenBrightness = v
      w.attributes = a
    } catch (_: Throwable) {}
  }

  // ─── gesto do botão ─────────────────────────────────────────────────────

  private fun onRecTouch(ev: MotionEvent) {
    if (processing || finished || permCard.visibility == View.VISIBLE) return
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (recordingActive && locked) {
          recBtn.animate().scaleX(0.9f).scaleY(0.9f).setDuration(80).start()
          return
        }
        if (recordingActive) return
        downRawX = ev.rawX; downRawY = ev.rawY; downAt = System.currentTimeMillis()
        holding = true
        locked = false
        cancelIntent = false
        startRecording()
      }
      MotionEvent.ACTION_MOVE -> {
        if (!holding || locked || !recordingActive) return
        val dx = ev.rawX - downRawX
        val dy = ev.rawY - downRawY
        if (-dy > abs(dx) && -dy > 0) {
          recBtn.translationY = max(dy, -dp(110f).toFloat())
          recBtn.translationX = 0f
          if (-dy >= dp(LOCK_DP)) {
            locked = true
            holding = false
            cancelIntent = false
            CAUtil.haptic(recBtn, "heavy")
            setRecUi()
          } else if (cancelIntent) { cancelIntent = false; setTrash(false); setRecUi() }
          return
        }
        if (dx < 0 && -dx > abs(dy)) {
          recBtn.translationX = max(dx, -dp(160f).toFloat())
          recBtn.translationY = 0f
          val past = -dx >= dp(CANCEL_DP)
          if (past != cancelIntent) {
            cancelIntent = past
            if (past) CAUtil.haptic(recBtn, "light")
            setTrash(past)
            setRecUi()
          }
          return
        }
        recBtn.translationX = 0f
        recBtn.translationY = 0f
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (recordingActive && locked && !holding) {
          recBtn.animate().scaleX(1f).scaleY(1f).setDuration(120).start()
          if (ev.actionMasked == MotionEvent.ACTION_UP) requestSend()
          return
        }
        if (!holding) return
        holding = false
        if (cancelIntent || ev.actionMasked == MotionEvent.ACTION_CANCEL) {
          discardAndClose()
          return
        }
        if (System.currentTimeMillis() - downAt < 1000) {
          // Toque rápido = mãos livres (igual ao JS).
          locked = true
          CAUtil.haptic(recBtn, "heavy")
          setRecUi()
        } else {
          requestSend()
        }
      }
    }
  }

  private fun setTrash(big: Boolean) {
    trashBtn.animate().scaleX(if (big) 1.3f else 1f).scaleY(if (big) 1.3f else 1f).setDuration(160).start()
    trashBtn.setColorFilter(if (big) 0xFFEF4444.toInt() else (if (flashOn && front) Color.BLACK else Color.WHITE))
  }

  // ─── gravação ───────────────────────────────────────────────────────────

  @SuppressLint("MissingPermission")
  @androidx.annotation.OptIn(markerClass = [ExperimentalPersistentRecording::class])
  private fun startRecording() {
    if (recordingActive || processing || finished) return
    val vc = videoCapture ?: return
    if (camera == null) return
    val f = File(CAMediaStore.outDir(ctx), "vnraw_" + UUID.randomUUID().toString() + ".mp4")
    val opts = FileOutputOptions.Builder(f)
      .setDurationLimitMillis((cfg.maxSec * 1000).toLong() + 400)
      .build()
    try {
      var pr = vc.output.prepareRecording(ctx, opts)
      if (cfg.withAudio && CAUtil.hasMic(ctx)) pr = pr.withAudioEnabled()
      pr = try { pr.asPersistentRecording() } catch (_: Throwable) { pr }
      recordFile = f
      pending = Pending.NONE
      recordingActive = true
      recStartMs = System.currentTimeMillis()
      lastWarnSec = -1
      CAUtil.haptic(recBtn, "heavy")
      setRecUi()
      recording = pr.start(ContextCompat.getMainExecutor(ctx)) { ev ->
        when (ev) {
          is VideoRecordEvent.Start -> {
            recStartMs = System.currentTimeMillis()
            CAUtil.main.removeCallbacks(tick)
            CAUtil.main.post(tick)
          }
          is VideoRecordEvent.Finalize -> onFinalized(ev, f)
          else -> {}
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "record failed: ${t.message}")
      recordingActive = false
      recording = null
      holding = false
      locked = false
      setRecUi()
      flashHint()
    }
  }

  private fun stopRecordingIfAny() {
    CAUtil.main.removeCallbacks(tick)
    val r = recording ?: return
    recording = null
    try { r.stop() } catch (_: Throwable) {}
    try { r.close() } catch (_: Throwable) {}
  }

  private fun requestSend() {
    if (!recordingActive || pending != Pending.NONE) return
    pending = Pending.SEND
    holding = false
    CAUtil.haptic(recBtn, "light")
    stopRecordingIfAny()
  }

  private fun discardAndClose() {
    if (finished) return
    pending = Pending.DISCARD
    CAUtil.haptic(recBtn, "heavy")
    finish(mapOf("action" to "cancel"))
  }

  private fun onFinalized(ev: VideoRecordEvent.Finalize, f: File) {
    CAUtil.main.removeCallbacks(tick)
    recordingActive = false
    recording = null
    val act = pending
    pending = Pending.NONE
    if (finished || act == Pending.DISCARD) { try { f.delete() } catch (_: Throwable) {}; return }
    val err = ev.error
    val durMs = TimeUnit.NANOSECONDS.toMillis(ev.recordingStats.recordedDurationNanos)
    val okErr = err == VideoRecordEvent.Finalize.ERROR_NONE ||
      err == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED ||
      err == VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED
    val limit = err == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED
    val shouldSend = act == Pending.SEND || limit
    if (!okErr || !f.exists() || f.length() == 0L) {
      Log.w(TAG, "finalize error=$err cause=${ev.cause?.message}")
      try { f.delete() } catch (_: Throwable) {}
      locked = false; holding = false; cancelIntent = false
      setRecUi()
      flashHint()
      return
    }
    if (!shouldSend || durMs < 600) {
      try { f.delete() } catch (_: Throwable) {}
      locked = false; holding = false; cancelIntent = false
      setRecUi()
      flashHint()
      return
    }
    process(f, durMs / 1000.0)
  }

  private fun flashHint() {
    hint.visibility = View.VISIBLE
    hint.animate().scaleX(1.08f).scaleY(1.08f).setDuration(120).withEndAction {
      hint.animate().scaleX(1f).scaleY(1f).setDuration(200).start()
    }.start()
  }

  private fun process(raw: File, durSec: Double) {
    processing = true
    locked = false; holding = false
    setRecUi()
    recBtn.visibility = View.INVISIBLE
    trashBtn.visibility = View.INVISIBLE
    hint.visibility = View.INVISIBLE
    timerPill.visibility = View.INVISIBLE
    spinner.visibility = View.VISIBLE
    processingText.visibility = View.VISIBLE
    ring.set(1f, false)
    // Solta a câmera já (libera o hardware enquanto transcodifica).
    try { camera?.cameraControl?.enableTorch(false) } catch (_: Throwable) {}
    try { unbindOurs() } catch (_: Throwable) {}
    val ts = System.currentTimeMillis()
    val name = "video_note_$ts.mp4"
    val out = File(CAMediaStore.outDir(ctx), name)
    CAMediaStore.io.execute {
      val ok = try { VNTranscoder.transcode(raw, out, cfg.size, cfg.bitrate) } catch (t: Throwable) { Log.w(TAG, "transcode: ${t.message}"); false }
      val item: Map<String, Any?> = if (ok) {
        try { raw.delete() } catch (_: Throwable) {}
        val meta = CAMediaStore.videoMeta(out)
        hashMapOf(
          "uri" to Uri.fromFile(out).toString(),
          "name" to name,
          "type" to "video/mp4",
          "size" to out.length(),
          "width" to cfg.size,
          "height" to cfg.size,
          "duration" to (meta?.third?.takeIf { it > 0 } ?: durSec),
          "mediaType" to "video",
        )
      } else {
        // Nunca perde a gravação: manda o original do CameraX.
        val dst = if (raw.renameTo(out)) out else raw
        val meta = CAMediaStore.videoMeta(dst)
        hashMapOf(
          "uri" to Uri.fromFile(dst).toString(),
          "name" to name,
          "type" to "video/mp4",
          "size" to dst.length(),
          "width" to (meta?.first ?: 0),
          "height" to (meta?.second ?: 0),
          "duration" to (meta?.third?.takeIf { it > 0 } ?: durSec),
          "mediaType" to "video",
        )
      }
      CAUtil.main.post {
        if (finished) {
          try { File(Uri.parse(item["uri"] as String).path ?: "").delete() } catch (_: Throwable) {}
          return@post
        }
        CAUtil.haptic(root, "select")
        finish(mapOf("action" to "send", "item" to item))
      }
    }
  }

  // ─── fim ────────────────────────────────────────────────────────────────

  fun finish(result: Map<String, Any?>) {
    if (finished) return
    finished = true
    realDismiss()
    try { onResult(result) } catch (t: Throwable) { Log.w(TAG, "result: ${t.message}") }
  }

  fun finishSilently() {
    if (finished) return
    pending = Pending.DISCARD
    finished = true
    realDismiss()
    try { onResult(mapOf("action" to "cancel")) } catch (_: Throwable) {}
  }

  // ─── anel de progresso ──────────────────────────────────────────────────

  private class RingView(c: Context) : View(c) {
    private val d = c.resources.displayMetrics.density
    var track = 0x33FFFFFF
    var ink = Color.WHITE
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 4 * d; strokeCap = Paint.Cap.ROUND }
    private var p = 0f
    private var warn = false
    private val rect = RectF()

    fun set(progress: Float, w: Boolean) {
      if (progress == p && w == warn) return
      p = progress; warn = w
      invalidate()
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      val inset = 2 * d + 2f
      rect.set(inset, inset, width - inset, height - inset)
      paint.color = track
      canvas.drawOval(rect, paint)
      if (p > 0f) {
        paint.color = if (warn) 0xFFEF4444.toInt() else ink
        canvas.drawArc(rect, -90f, 360f * p, false, paint)
      }
    }
  }
}
