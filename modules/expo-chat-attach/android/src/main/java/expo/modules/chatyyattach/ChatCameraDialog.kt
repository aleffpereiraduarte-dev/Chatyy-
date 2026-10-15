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
import android.view.OrientationEventListener
import android.view.ScaleGestureDetector
import android.view.Surface
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.MirrorMode
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
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
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

/**
 * [2026-10-15 native-attach] Câmera do chat (WhatsApp) em CameraX:
 *  • toque no obturador = foto; segurar (>250 ms) = vídeo enquanto segura,
 *    deslizar p/ cima = zoom; soltar = para (limite maxVideoSec, anel);
 *  • duplo toque no preview = troca câmera; toque = foco; pinça = zoom;
 *  • flash off/auto/on (frontal = flash de tela); faixa de recentes.
 * Resultados iguais ao iOS: capture | pick | gallery | cancel.
 */
@SuppressLint("ViewConstructor")
class ChatCameraDialog(
  private val host: Activity,
  private val cfg: CAConfig,
  private val askPermissions: (perms: Array<String>, done: () -> Unit) -> Unit,
  private val onResult: (Map<String, Any?>) -> Unit,
) : Dialog(host, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {

  companion object { private const val TAG = "ChatyyAttach" }

  private val ctx: Context = host
  private fun dp(v: Float) = CAUtil.dp(ctx, v)

  private var finished = false
  private val life = CALifecycle()
  private var provider: ProcessCameraProvider? = null
  private var camera: Camera? = null
  private var preview: Preview? = null
  private var imageCapture: ImageCapture? = null
  private var videoCapture: VideoCapture<Recorder>? = null
  private var videoBound = false
  private var front = false
  private var flashMode = ImageCapture.FLASH_MODE_OFF
  private var capturing = false
  private var recording: Recording? = null
  private var recordingActive = false
  private var holdPending = false
  private var holdStartY = 0f
  private var zoomBaseLinear = 0f
  private var rotation = Surface.ROTATION_0
  private var exporting = false
  private var recentLoaded = false
  // [2026-10-15 native-status-studio] statusModes: 0 Texto · 1 Normal · 2 Boomerang
  private var camMode = 1
  private var boomerangRec = false
  private val modeBar = LinearLayout(ctx)
  private val modeViews = ArrayList<TextView>()
  private val boomerangStop = Runnable { if (boomerangRec && recordingActive) stopRecordingIfAny() }

  // recentes
  private var recent: List<CAMedia> = emptyList()
  private var multi = false
  private val picked = ArrayList<String>()
  private val pickedMedia = HashMap<String, CAMedia>()

  // views
  private val root = FrameLayout(ctx)
  private val previewView = PreviewView(ctx)
  private val screenFlash = View(ctx)
  private val focusRing = View(ctx)
  private val closeBtn = ImageButton(ctx)
  private val flashBtn = ImageButton(ctx)
  private val timerPill = LinearLayout(ctx)
  private val timerDot = View(ctx)
  private val timerText = TextView(ctx)
  private val zoomText = TextView(ctx)
  private val strip = RecyclerView(ctx)
  private val stripSend = FrameLayout(ctx)
  private val stripCount = TextView(ctx)
  private val shutter = ShutterView(ctx)
  private val galleryBtn = ImageButton(ctx)
  private val flipBtn = ImageButton(ctx)
  private val hint = TextView(ctx)
  private val bottom = LinearLayout(ctx)
  private val permView = LinearLayout(ctx)
  private val adapter = StripAdapter()

  private val holdRunnable = Runnable {
    if (holdPending) { holdPending = false; startRecording() }
  }

  private val orientationListener = object : OrientationEventListener(ctx) {
    override fun onOrientationChanged(o: Int) {
      if (o == ORIENTATION_UNKNOWN) return
      val r = when (o) {
        in 45 until 135 -> Surface.ROTATION_270
        in 135 until 225 -> Surface.ROTATION_180
        in 225 until 315 -> Surface.ROTATION_90
        else -> Surface.ROTATION_0
      }
      if (r != rotation) {
        rotation = r
        imageCapture?.targetRotation = r
        videoCapture?.targetRotation = r
      }
    }
  }

  private val lifecycleCb = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(a: Activity, b: Bundle?) {}
    override fun onActivityStarted(a: Activity) {}
    override fun onActivityResumed(a: Activity) { if (a === host) life.resume() }
    override fun onActivityPaused(a: Activity) {
      if (a === host) { stopRecordingIfAny(); life.pause() }
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
    try { orientationListener.enable() } catch (_: Throwable) {}
    startFlow()
  }

  override fun onStart() {
    super.onStart()
    window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    if (recordingActive || holdPending) { stopRecordingIfAny(); return }
    finish(mapOf("action" to "cancel"))
  }

  override fun dismiss() {
    if (!finished) finish(mapOf("action" to "cancel")) else realDismiss()
  }

  private fun realDismiss() {
    releaseCamera()
    try { orientationListener.disable() } catch (_: Throwable) {}
    try { host.application.unregisterActivityLifecycleCallbacks(lifecycleCb) } catch (_: Throwable) {}
    try { super.dismiss() } catch (_: Throwable) {}
  }

  private fun setupWindow() {
    val w = window ?: return
    ScreenProtectBridge.protect(w, false) // [2026-10-15 screen-protect-all]
    w.setBackgroundDrawable(ColorDrawable(Color.BLACK))
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
    val ctl = WindowInsetsControllerCompat(w, w.decorView)
    ctl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    ctl.hide(WindowInsetsCompat.Type.statusBars())
    ctl.isAppearanceLightNavigationBars = false
  }

  // ─── UI ─────────────────────────────────────────────────────────────────

  private fun roundBtn(b: ImageButton, icon: Int, label: String, size: Float) {
    b.setImageResource(icon)
    b.setColorFilter(Color.WHITE)
    b.background = caCircleBg(0x47000000)
    b.contentDescription = label
    b.scaleType = ImageView.ScaleType.CENTER
    val pad = dp((size - 24f) / 2f)
    b.setPadding(pad, pad, pad, pad)
  }

  @SuppressLint("ClickableViewAccessibility")
  private fun buildUi() {
    root.setBackgroundColor(Color.BLACK)
    previewView.implementationMode = PreviewView.ImplementationMode.PERFORMANCE
    previewView.scaleType = PreviewView.ScaleType.FILL_CENTER
    root.addView(previewView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    focusRing.background = GradientDrawable().apply {
      cornerRadius = dp(6f).toFloat(); setStroke(dp(1.5f), Color.WHITE); setColor(Color.TRANSPARENT)
    }
    focusRing.alpha = 0f
    root.addView(focusRing, FrameLayout.LayoutParams(dp(72f), dp(72f)))

    val gd = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
      override fun onDown(e: MotionEvent): Boolean = true
      override fun onSingleTapConfirmed(e: MotionEvent): Boolean { focusAt(e.x, e.y); return true }
      override fun onDoubleTap(e: MotionEvent): Boolean { flip(); return true }
      override fun onFling(e1: MotionEvent?, e2: MotionEvent, vx: Float, vy: Float): Boolean {
        if (!cfg.statusModes || Math.abs(vx) < 600f || Math.abs(vx) < Math.abs(vy) * 1.4f) return false
        // Dedo para a esquerda → próximo modo (à direita na barra).
        selectMode(if (vx < 0) camMode + 1 else camMode - 1)
        return true
      }
    })
    val sd = ScaleGestureDetector(ctx, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
      override fun onScale(d: ScaleGestureDetector): Boolean {
        val cam = camera ?: return false
        val zs = cam.cameraInfo.zoomState.value ?: return false
        val z = (zs.zoomRatio * d.scaleFactor).coerceIn(zs.minZoomRatio, min(zs.maxZoomRatio, 10f))
        cam.cameraControl.setZoomRatio(z)
        showZoom(z)
        return true
      }
    })
    previewView.setOnTouchListener { _, ev ->
      sd.onTouchEvent(ev)
      if (!sd.isInProgress) gd.onTouchEvent(ev)
      true
    }

    screenFlash.setBackgroundColor(Color.WHITE)
    screenFlash.alpha = 0f
    screenFlash.isClickable = false

    // Topo.
    roundBtn(closeBtn, R.drawable.ca_ic_close, cfg.t("close", "Fechar"), 44f)
    closeBtn.setOnClickListener { if (!recordingActive) finish(mapOf("action" to "cancel")) }
    roundBtn(flashBtn, R.drawable.ca_ic_flash_off, cfg.t("flashOff", "Flash desligado"), 44f)
    flashBtn.setOnClickListener { cycleFlash() }
    root.addView(closeBtn, FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.TOP or Gravity.START))
    root.addView(flashBtn, FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.TOP or Gravity.END))

    timerPill.orientation = LinearLayout.HORIZONTAL
    timerPill.gravity = Gravity.CENTER_VERTICAL
    timerPill.setPadding(dp(12f), 0, dp(12f), 0)
    timerPill.background = GradientDrawable().apply { cornerRadius = dp(15f).toFloat(); setColor(0x73000000) }
    timerPill.visibility = View.GONE
    timerDot.background = caCircleBg(0xFFEF4444.toInt())
    timerPill.addView(timerDot, LinearLayout.LayoutParams(dp(9f), dp(9f)))
    timerText.setTextColor(Color.WHITE)
    timerText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    timerText.typeface = android.graphics.Typeface.create(android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.BOLD)
    timerText.text = "0:00"
    val ttlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    ttlp.leftMargin = dp(7f)
    timerPill.addView(timerText, ttlp)
    root.addView(timerPill, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(30f), Gravity.TOP or Gravity.CENTER_HORIZONTAL))

    // Rodapé: faixa + linha do obturador + dica.
    bottom.orientation = LinearLayout.VERTICAL
    bottom.gravity = Gravity.CENTER_HORIZONTAL
    zoomText.setTextColor(Color.WHITE)
    zoomText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    zoomText.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
    zoomText.gravity = Gravity.CENTER
    zoomText.background = GradientDrawable().apply { cornerRadius = dp(14f).toFloat(); setColor(0x66000000) }
    zoomText.alpha = 0f
    val zlp = LinearLayout.LayoutParams(dp(58f), dp(28f))
    zlp.bottomMargin = dp(10f)
    bottom.addView(zoomText, zlp)

    val stripRow = FrameLayout(ctx)
    strip.layoutManager = LinearLayoutManager(ctx, LinearLayoutManager.HORIZONTAL, false)
    strip.adapter = adapter
    strip.itemAnimator = null
    strip.clipToPadding = false
    strip.setPadding(dp(10f), 0, dp(10f), 0)
    strip.overScrollMode = View.OVER_SCROLL_NEVER
    stripRow.addView(strip, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(62f)))
    stripSend.background = caCircleBg(Color.WHITE)
    stripSend.contentDescription = cfg.t("send", "Enviar")
    stripSend.visibility = View.GONE
    stripSend.isClickable = true
    stripSend.setOnClickListener { onStripSend() }
    val si = ImageView(ctx)
    si.setImageResource(R.drawable.ca_ic_send)
    si.setColorFilter(Color.BLACK)
    stripSend.addView(si, FrameLayout.LayoutParams(dp(20f), dp(20f), Gravity.CENTER))
    stripCount.setTextColor(Color.WHITE)
    stripCount.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    stripCount.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
    stripCount.gravity = Gravity.CENTER
    stripCount.minWidth = dp(20f)
    stripCount.background = GradientDrawable().apply { cornerRadius = dp(10f).toFloat(); setColor(Color.BLACK); setStroke(dp(1.5f), Color.WHITE) }
    stripSend.clipChildren = false
    stripSend.addView(stripCount, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(20f), Gravity.TOP or Gravity.END))
    val sslp = FrameLayout.LayoutParams(dp(48f), dp(48f), Gravity.END or Gravity.CENTER_VERTICAL)
    sslp.rightMargin = dp(12f)
    stripRow.addView(stripSend, sslp)
    stripRow.clipChildren = false
    bottom.addView(stripRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(62f)))

    val row = FrameLayout(ctx)
    roundBtn(galleryBtn, R.drawable.ca_ic_gallery, cfg.t("gallery", "Galeria"), 48f)
    galleryBtn.setOnClickListener { if (!recordingActive) finish(mapOf("action" to "gallery")) }
    roundBtn(flipBtn, R.drawable.ca_ic_flip, cfg.t("flip", "Trocar câmera"), 48f)
    flipBtn.setOnClickListener { flip() }
    val glp = FrameLayout.LayoutParams(dp(48f), dp(48f), Gravity.START or Gravity.CENTER_VERTICAL)
    glp.leftMargin = dp(32f)
    row.addView(galleryBtn, glp)
    val flp = FrameLayout.LayoutParams(dp(48f), dp(48f), Gravity.END or Gravity.CENTER_VERTICAL)
    flp.rightMargin = dp(32f)
    row.addView(flipBtn, flp)
    shutter.contentDescription = cfg.t("shutter", "Toque para foto, segure para vídeo")
    shutter.setOnTouchListener { _, ev -> onShutterTouch(ev); true }
    row.addView(shutter, FrameLayout.LayoutParams(dp(102f), dp(102f), Gravity.CENTER))
    val rlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(102f))
    rlp.topMargin = dp(6f)
    bottom.addView(row, rlp)

    if (cfg.statusModes) {
      // [2026-10-15 native-status-studio] Seletor de modo (estilo Instagram) sob o obturador.
      modeBar.orientation = LinearLayout.HORIZONTAL
      modeBar.gravity = Gravity.CENTER
      val titles = listOf(cfg.t("modeText", "Texto"), cfg.t("modeNormal", "Normal"), cfg.t("modeBoomerang", "Boomerang"))
      titles.forEachIndexed { i, title ->
        val tv = TextView(ctx)
        tv.text = title.uppercase()
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        tv.setShadowLayer(3f, 0f, 0f, 0x80000000.toInt())
        tv.gravity = Gravity.CENTER
        tv.setPadding(dp(11f), 0, dp(11f), 0)
        tv.isClickable = true
        tv.setOnClickListener { selectMode(i) }
        modeBar.addView(tv, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(30f)))
        modeViews.add(tv)
      }
      val mlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(30f))
      mlp.topMargin = dp(4f)
      bottom.addView(modeBar, mlp)
    }

    hint.text = cfg.t("hint", "Segure para vídeo, toque para foto")
    hint.setTextColor(0xD9FFFFFF.toInt())
    hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    hint.setShadowLayer(3f, 0f, 0f, 0x80000000.toInt())
    val hlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    hlp.topMargin = dp(2f)
    bottom.addView(hint, hlp)
    root.addView(bottom, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
    if (cfg.statusModes) refreshModeBar()

    buildPermission()
    root.addView(screenFlash, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    ViewCompat.setOnApplyWindowInsetsListener(root) { _, ins ->
      val sys = ins.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val top = sys.top + dp(8f)
      (closeBtn.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = top; it.leftMargin = dp(12f); closeBtn.layoutParams = it }
      (flashBtn.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = top; it.rightMargin = dp(12f); flashBtn.layoutParams = it }
      (timerPill.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = top + dp(7f); timerPill.layoutParams = it }
      bottom.setPadding(0, 0, 0, sys.bottom + dp(10f))
      ins
    }
  }

  private fun buildPermission() {
    permView.orientation = LinearLayout.VERTICAL
    permView.gravity = Gravity.CENTER
    permView.setBackgroundColor(Color.BLACK)
    permView.setPadding(dp(32f), 0, dp(32f), 0)
    permView.visibility = View.GONE
    permView.isClickable = true
    val icon = ImageView(ctx)
    icon.setImageResource(R.drawable.ca_ic_camera)
    icon.setColorFilter(0xD9FFFFFF.toInt())
    permView.addView(icon, LinearLayout.LayoutParams(dp(44f), dp(44f)))
    val t = TextView(ctx)
    t.text = cfg.t("permCamTitle", "Permita o acesso à câmera")
    t.setTextColor(Color.WHITE)
    t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19f)
    t.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
    t.gravity = Gravity.CENTER
    val tlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    tlp.topMargin = dp(16f)
    permView.addView(t, tlp)
    val b = TextView(ctx)
    b.text = cfg.t("permCamBody", "Para tirar fotos e gravar vídeos no chat, ative a câmera nos Ajustes.")
    b.setTextColor(0xB3FFFFFF.toInt())
    b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    b.gravity = Gravity.CENTER
    val blp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    blp.topMargin = dp(8f)
    permView.addView(b, blp)
    val btn = TextView(ctx)
    btn.text = cfg.t("permSettings", "Abrir Ajustes")
    btn.setTextColor(Color.BLACK)
    btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    btn.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
    btn.gravity = Gravity.CENTER
    btn.setPadding(dp(24f), 0, dp(24f), 0)
    btn.background = GradientDrawable().apply { cornerRadius = dp(22f).toFloat(); setColor(Color.WHITE) }
    btn.setOnClickListener {
      try {
        val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
      } catch (_: Throwable) {}
    }
    val btlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(44f))
    btlp.topMargin = dp(20f)
    permView.addView(btn, btlp)
    // Abaixo do botão fechar (que continua clicável por cima).
    root.addView(permView, root.indexOfChild(closeBtn), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
  }

  // ─── permissão / sessão ─────────────────────────────────────────────────

  private fun startFlow() {
    loadRecents()
    val need = ArrayList<String>()
    if (!CAUtil.hasCamera(ctx)) need.add(Manifest.permission.CAMERA)
    if (cfg.withAudio && !CAUtil.hasMic(ctx)) need.add(Manifest.permission.RECORD_AUDIO)
    if (need.isEmpty()) { bind(); return }
    askPermissions(need.toTypedArray()) {
      if (finished) return@askPermissions
      if (CAUtil.hasCamera(ctx)) bind() else showPermission()
    }
  }

  private fun showPermission() {
    permView.visibility = View.VISIBLE
    shutter.visibility = View.INVISIBLE
    flipBtn.visibility = View.INVISIBLE
    flashBtn.visibility = View.INVISIBLE
  }

  private fun bind() {
    life.start()
    CameraHub.withProvider(ctx) { p ->
      if (finished) return@withProvider
      if (p == null) { showPermission(); return@withProvider }
      provider = p
      bindUseCases()
    }
  }

  private fun selector() = if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA

  private fun bindUseCases() {
    val p = provider ?: return
    try { unbindOurs() } catch (_: Throwable) {}
    val pv = Preview.Builder().build()
    pv.setSurfaceProvider(previewView.surfaceProvider)
    val ic = ImageCapture.Builder()
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
      .setFlashMode(flashMode)
      .setTargetRotation(rotation)
      .build()
    val recorder = Recorder.Builder()
      .setQualitySelector(QualitySelector.from(Quality.FHD, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
      .build()
    val vc = VideoCapture.Builder(recorder)
      // [2026-10-15 espelho] Vídeo enviado NÃO espelhado (padrão câmera do
      // sistema/WhatsApp); só a prévia (PreviewView) espelha a frontal.
      .setMirrorMode(MirrorMode.MIRROR_MODE_OFF)
      .setTargetRotation(rotation)
      .build()
    preview = pv
    imageCapture = ic
    videoCapture = vc
    camera = try {
      videoBound = true
      p.bindToLifecycle(life, selector(), pv, ic, vc)
    } catch (t: Throwable) {
      // Aparelho LEGACY/LIMITED: sem os 3 juntos → foto agora, vídeo sob demanda.
      Log.w(TAG, "bind 3 use cases failed: ${t.message}")
      videoBound = false
      try { p.bindToLifecycle(life, selector(), pv, ic) } catch (t2: Throwable) {
        Log.w(TAG, "bind failed: ${t2.message}"); null
      }
    }
    if (camera == null) { showPermission(); return }
    refreshFlashUi()
  }

  /** Só p/ aparelhos que não aguentam foto+vídeo juntos. */
  private fun ensureVideoBound(): Boolean {
    if (videoBound) return true
    val p = provider ?: return false
    val vc = videoCapture ?: return false
    return try {
      imageCapture?.let { p.unbind(it) }
      camera = p.bindToLifecycle(life, selector(), vc)
      videoBound = true
      true
    } catch (t: Throwable) {
      Log.w(TAG, "video bind failed: ${t.message}")
      false
    }
  }

  private fun unbindOurs() {
    val p = provider ?: return
    val list = listOfNotNull(preview, imageCapture, videoCapture)
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

  private fun cycleFlash() {
    flashMode = when (flashMode) {
      ImageCapture.FLASH_MODE_OFF -> ImageCapture.FLASH_MODE_AUTO
      ImageCapture.FLASH_MODE_AUTO -> ImageCapture.FLASH_MODE_ON
      else -> ImageCapture.FLASH_MODE_OFF
    }
    try { imageCapture?.flashMode = if (front) ImageCapture.FLASH_MODE_OFF else flashMode } catch (_: Throwable) {}
    CAUtil.haptic(flashBtn, "select")
    refreshFlashUi()
  }

  private fun refreshFlashUi() {
    val (icon, label) = when (flashMode) {
      ImageCapture.FLASH_MODE_ON -> R.drawable.ca_ic_flash_on to cfg.t("flashOn", "Flash ligado")
      ImageCapture.FLASH_MODE_AUTO -> R.drawable.ca_ic_flash_auto to cfg.t("flashAuto", "Flash automático")
      else -> R.drawable.ca_ic_flash_off to cfg.t("flashOff", "Flash desligado")
    }
    flashBtn.setImageResource(icon)
    flashBtn.contentDescription = label
  }

  private fun flip() {
    if (recordingActive || holdPending || capturing || camera == null) return
    CAUtil.haptic(flipBtn)
    front = !front
    previewView.animate().alpha(0f).setDuration(90).withEndAction {
      bindUseCases()
      try { imageCapture?.flashMode = if (front) ImageCapture.FLASH_MODE_OFF else flashMode } catch (_: Throwable) {}
      previewView.animate().alpha(1f).setDuration(180).start()
    }.start()
    flipBtn.animate().rotationBy(180f).setDuration(250).start()
  }

  private fun focusAt(x: Float, y: Float) {
    val cam = camera ?: return
    try {
      val pt = previewView.meteringPointFactory.createPoint(x, y)
      val action = FocusMeteringAction.Builder(pt, FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE)
        .setAutoCancelDuration(4, TimeUnit.SECONDS)
        .build()
      cam.cameraControl.startFocusAndMetering(action)
    } catch (_: Throwable) {}
    focusRing.translationX = x - dp(36f)
    focusRing.translationY = y - dp(36f)
    focusRing.scaleX = 1.4f; focusRing.scaleY = 1.4f
    focusRing.alpha = 1f
    focusRing.animate().scaleX(1f).scaleY(1f).setDuration(220).withEndAction {
      focusRing.animate().alpha(0f).setStartDelay(700).setDuration(300).start()
    }.start()
  }

  private val hideZoom = Runnable { zoomText.animate().alpha(0f).setDuration(250).start() }

  private fun showZoom(ratio: Float) {
    zoomText.text = String.format("%.1f×", ratio)
    zoomText.animate().cancel()
    zoomText.alpha = 1f
    CAUtil.main.removeCallbacks(hideZoom)
    CAUtil.main.postDelayed(hideZoom, 900)
  }

  // ─── modos do status ────────────────────────────────────────────────────

  private fun refreshModeBar() {
    modeViews.forEachIndexed { i, tv ->
      val on = i == camMode
      tv.setTextColor(if (on) Color.WHITE else 0x99FFFFFF.toInt())
      tv.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, if (on) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
      tv.isSelected = on
    }
    if (camMode == 2) {
      hint.text = cfg.t("boomerangHint", "Toque para gravar um boomerang")
      shutter.contentDescription = cfg.t("modeBoomerang", "Boomerang")
    } else {
      hint.text = cfg.t("hint", "Segure para vídeo, toque para foto")
      shutter.contentDescription = cfg.t("shutter", "Toque para foto, segure para vídeo")
    }
  }

  private fun selectMode(m: Int) {
    if (!cfg.statusModes || recordingActive || holdPending || capturing || m < 0 || m > 2 || m == camMode) return
    CAUtil.haptic(modeBar, "select")
    if (m == 0) { finish(mapOf("action" to "text")); return }
    camMode = m
    refreshModeBar()
  }

  // ─── obturador ──────────────────────────────────────────────────────────

  private fun onShutterTouch(ev: MotionEvent) {
    if (camera == null || exporting) return
    if (cfg.statusModes && camMode == 2) {
      // Boomerang: toque (ou segurar) grava um clipe curto que para sozinho.
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          if (capturing || recordingActive) return
          startRecording(boomerang = true)
        }
        else -> {}
      }
      return
    }
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (capturing || recordingActive) return
        shutter.animate().scaleX(0.9f).scaleY(0.9f).setDuration(90).start()
        holdPending = true
        holdStartY = ev.rawY
        CAUtil.main.postDelayed(holdRunnable, 250)
      }
      MotionEvent.ACTION_MOVE -> {
        if (!recordingActive) return
        val cam = camera ?: return
        val dy = holdStartY - ev.rawY
        val travel = max(dp(120f).toFloat(), root.height * 0.45f)
        val p = (dy / travel).coerceIn(0f, 1f)
        val lin = zoomBaseLinear + (1f - zoomBaseLinear) * p
        try { cam.cameraControl.setLinearZoom(lin) } catch (_: Throwable) {}
        if (p > 0f) cam.cameraInfo.zoomState.value?.let { showZoom(it.zoomRatio) }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (!recordingActive) shutter.animate().scaleX(1f).scaleY(1f).setDuration(120).start()
        if (holdPending) {
          holdPending = false
          CAUtil.main.removeCallbacks(holdRunnable)
          if (ev.actionMasked == MotionEvent.ACTION_UP) takePhoto()
        } else {
          stopRecordingIfAny()
        }
      }
    }
  }

  private fun takePhoto() {
    val ic = imageCapture ?: return
    if (capturing) return
    // Aparelho no modo "um de cada vez" que acabou de gravar: religa a foto.
    val p = provider
    if (p != null && !p.isBound(ic)) {
      try {
        videoCapture?.let { if (p.isBound(it)) p.unbind(it) }
        camera = p.bindToLifecycle(life, selector(), ic)
        videoBound = false
      } catch (_: Throwable) {}
    }
    capturing = true
    CAUtil.haptic(shutter)
    val f = File(CAMediaStore.outDir(ctx), UUID.randomUUID().toString() + ".jpg")
    // [2026-10-15 espelho] Foto frontal salva NÃO espelhada (texto legível),
    // como a câmera do sistema/WhatsApp; a prévia segue espelhada.
    val meta = ImageCapture.Metadata().apply { isReversedHorizontal = false }
    val opts = ImageCapture.OutputFileOptions.Builder(f).setMetadata(meta).build()
    val screen = front && flashMode != ImageCapture.FLASH_MODE_OFF
    val shoot = Runnable {
      try {
        ic.takePicture(opts, ContextCompat.getMainExecutor(ctx), object : ImageCapture.OnImageSavedCallback {
          override fun onImageSaved(output: ImageCapture.OutputFileResults) {
            endScreenFlash()
            capturing = false
            if (finished) return
            finish(mapOf("action" to "capture", "items" to listOf(CAMediaStore.cameraPhotoItem(f))))
          }

          override fun onError(exc: ImageCaptureException) {
            Log.w(TAG, "photo failed: ${exc.message}")
            endScreenFlash()
            capturing = false
            CAUtil.haptic(shutter, "warn")
          }
        })
      } catch (t: Throwable) {
        Log.w(TAG, "takePicture threw: ${t.message}")
        endScreenFlash()
        capturing = false
      }
      // "Piscada" de captura.
      previewView.alpha = 0.25f
      previewView.animate().alpha(1f).setDuration(220).start()
    }
    if (screen) {
      screenFlash.alpha = 1f
      setBrightness(1f)
      CAUtil.main.postDelayed(shoot, 220)
    } else {
      shoot.run()
    }
  }

  private fun setBrightness(v: Float) {
    try {
      val w = window ?: return
      val a = w.attributes
      a.screenBrightness = v
      w.attributes = a
    } catch (_: Throwable) {}
  }

  private fun endScreenFlash() {
    if (screenFlash.alpha > 0f) screenFlash.animate().alpha(0f).setDuration(200).start()
    setBrightness(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE)
  }

  @SuppressLint("MissingPermission")
  private fun startRecording(boomerang: Boolean = false) {
    val cam = camera ?: return
    if (recordingActive || capturing) return
    if (!ensureVideoBound()) { CAUtil.haptic(shutter, "warn"); return }
    val vc = videoCapture ?: return
    val f = File(CAMediaStore.outDir(ctx), UUID.randomUUID().toString() + ".mp4")
    val limitMs = ((if (boomerang) cfg.boomerangSec else cfg.maxVideoSec) * 1000).toLong()
    boomerangRec = boomerang
    val opts = FileOutputOptions.Builder(f)
      .setDurationLimitMillis(limitMs)
      .build()
    try {
      zoomBaseLinear = camera?.cameraInfo?.zoomState?.value?.linearZoom ?: 0f
      var pending = vc.output.prepareRecording(ctx, opts)
      if (cfg.withAudio && CAUtil.hasMic(ctx)) pending = pending.withAudioEnabled()
      if (flashMode == ImageCapture.FLASH_MODE_ON && !front) {
        try { cam.cameraControl.enableTorch(true) } catch (_: Throwable) {}
      }
      recordingActive = true
      setRecordingUi(true)
      CAUtil.haptic(shutter, "heavy")
      recording = pending.start(ContextCompat.getMainExecutor(ctx)) { ev ->
        when (ev) {
          is VideoRecordEvent.Start -> {
            shutter.startProgress(limitMs)
            if (boomerang) {
              // Rede de segurança além do limite de duração: para sozinho.
              CAUtil.main.removeCallbacks(boomerangStop)
              CAUtil.main.postDelayed(boomerangStop, limitMs + 350)
            }
          }
          is VideoRecordEvent.Status -> {
            val sec = TimeUnit.NANOSECONDS.toSeconds(ev.recordingStats.recordedDurationNanos)
            timerText.text = CAUtil.fmtDur(sec.toDouble())
            timerDot.alpha = if (timerDot.alpha > 0.5f) 0.3f else 1f
          }
          is VideoRecordEvent.Finalize -> onRecordingFinalized(ev, f)
          else -> {}
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "record failed: ${t.message}")
      boomerangRec = false
      recordingActive = false
      setRecordingUi(false)
      try { cam.cameraControl.enableTorch(false) } catch (_: Throwable) {}
    }
  }

  private fun stopRecordingIfAny() {
    holdPending = false
    CAUtil.main.removeCallbacks(holdRunnable)
    val r = recording ?: return
    recording = null
    try { r.stop() } catch (_: Throwable) {}
  }

  private fun onRecordingFinalized(ev: VideoRecordEvent.Finalize, f: File) {
    val wasBoomerang = boomerangRec
    boomerangRec = false
    CAUtil.main.removeCallbacks(boomerangStop)
    recordingActive = false
    recording = null
    try { camera?.cameraControl?.enableTorch(false) } catch (_: Throwable) {}
    try { camera?.cameraControl?.setLinearZoom(0f) } catch (_: Throwable) {}
    setRecordingUi(false)
    val err = ev.error
    val okErr = err == VideoRecordEvent.Finalize.ERROR_NONE ||
      err == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED ||
      err == VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED
    val durMs = TimeUnit.NANOSECONDS.toMillis(ev.recordingStats.recordedDurationNanos)
    if (finished) { try { f.delete() } catch (_: Throwable) {}; return }
    if (!okErr || durMs < 600 || !f.exists() || f.length() == 0L) {
      try { f.delete() } catch (_: Throwable) {}
      hint.animate().scaleX(1.12f).scaleY(1.12f).setDuration(120).withEndAction {
        hint.animate().scaleX(1f).scaleY(1f).setDuration(200).start()
      }.start()
      return
    }
    val item = CAMediaStore.cameraVideoItem(f).toMutableMap()
    if (wasBoomerang) item["boomerang"] = true
    finish(mapOf("action" to "capture", "items" to listOf(item)))
  }

  private fun setRecordingUi(on: Boolean) {
    timerPill.visibility = if (on) View.VISIBLE else View.GONE
    val vis = if (on) View.INVISIBLE else View.VISIBLE
    hint.visibility = vis
    strip.visibility = if (on || recent.isEmpty()) View.INVISIBLE else View.VISIBLE
    stripSend.visibility = if (on || picked.isEmpty()) View.GONE else View.VISIBLE
    galleryBtn.visibility = vis
    flipBtn.visibility = vis
    flashBtn.visibility = vis
    closeBtn.visibility = vis
    if (cfg.statusModes) modeBar.visibility = vis
    shutter.setRecording(on)
    shutter.animate().scaleX(if (on) 1.3f else 1f).scaleY(if (on) 1.3f else 1f).setDuration(220).start()
    if (!on) timerText.text = "0:00"
  }

  // ─── recentes ───────────────────────────────────────────────────────────

  private fun loadRecents() {
    if (recentLoaded) return
    recentLoaded = true
    if (CAUtil.mediaAccess(ctx) == "none") { strip.visibility = View.INVISIBLE; return }
    CAMediaStore.io.execute {
      val list = try { CAMediaStore.queryRecent(ctx, 40) } catch (_: Throwable) { emptyList() }
      CAUtil.main.post {
        if (finished) return@post
        recent = list
        strip.visibility = if (list.isEmpty()) View.INVISIBLE else View.VISIBLE
        adapter.notifyDataSetChanged()
      }
    }
  }

  private fun togglePick(m: CAMedia) {
    val k = m.key
    val i = picked.indexOf(k)
    if (i >= 0) { picked.removeAt(i); pickedMedia.remove(k) } else {
      if (picked.size >= cfg.maxSelect) { CAUtil.haptic(strip, "warn"); return }
      picked.add(k); pickedMedia[k] = m
    }
    CAUtil.haptic(strip, "select")
    for (c in 0 until strip.childCount) {
      val cell = strip.getChildAt(c) as? CAMediaCell ?: continue
      val idx = picked.indexOf(cell.key)
      cell.setSelectedNumber(if (idx >= 0) idx + 1 else null, cell.key == k)
    }
    stripCount.text = picked.size.toString()
    stripSend.visibility = if (picked.isEmpty()) View.GONE else View.VISIBLE
    val pad = if (picked.isEmpty()) dp(10f) else dp(72f)
    strip.setPadding(dp(10f), 0, pad, 0)
  }

  private fun onStripSend() {
    val list = picked.mapNotNull { pickedMedia[it] }
    if (list.isNotEmpty()) exportPicks(list)
  }

  private fun exportPicks(list: List<CAMedia>) {
    if (exporting) return
    exporting = true
    CAMediaStore.materializeAll(ctx, list) { items ->
      exporting = false
      if (finished) return@materializeAll
      if (items.isEmpty()) { CAUtil.haptic(strip, "warn"); return@materializeAll }
      finish(mapOf("action" to "pick", "items" to items))
    }
  }

  private inner class Holder(v: View) : RecyclerView.ViewHolder(v)

  private inner class StripAdapter : RecyclerView.Adapter<Holder>() {
    override fun getItemCount(): Int = recent.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
      val cell = CAMediaCell(ctx)
      val s = dp(62f)
      val lp = RecyclerView.LayoutParams(s, s)
      lp.rightMargin = dp(4f)
      cell.layoutParams = lp
      cell.clipToOutline = true
      cell.outlineProvider = object : ViewOutlineProvider() {
        override fun getOutline(view: View, outline: Outline) {
          outline.setRoundRect(0, 0, view.width, view.height, dp(6f).toFloat())
        }
      }
      return Holder(cell)
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
      val cell = holder.itemView as CAMediaCell
      val m = recent.getOrNull(position) ?: return
      cell.key = m.key
      cell.badge.fill = Color.WHITE
      cell.badge.ink = Color.BLACK
      cell.badge.visibility = if (multi) View.VISIBLE else View.GONE
      val idx = picked.indexOf(m.key)
      cell.setSelectedNumber(if (idx >= 0) idx + 1 else null, false)
      if (m.isVideo) { cell.dur.visibility = View.VISIBLE; cell.dur.text = CAUtil.fmtDur(m.durationMs / 1000.0) } else cell.dur.visibility = View.GONE
      cell.contentDescription = if (m.isVideo) cfg.t("video", "Vídeo") else cfg.t("photo", "Foto")
      val s = dp(62f)
      try {
        Glide.with(cell.image).load(m.uri).override(s, s).centerCrop().dontAnimate()
          .diskCacheStrategy(DiskCacheStrategy.RESOURCE).into(cell.image)
      } catch (_: Throwable) {}
      cell.setOnClickListener {
        if (exporting || recordingActive) return@setOnClickListener
        if (multi) togglePick(m) else { CAUtil.haptic(cell); exportPicks(listOf(m)) }
      }
      cell.setOnLongClickListener {
        if (exporting || recordingActive) return@setOnLongClickListener true
        CAUtil.haptic(cell, "heavy")
        if (!multi) {
          multi = true
          notifyDataSetChanged()
        }
        if (!picked.contains(m.key)) togglePick(m)
        true
      }
    }

    override fun onViewRecycled(holder: Holder) {
      val v = holder.itemView as? CAMediaCell ?: return
      try { Glide.with(v.image).clear(v.image) } catch (_: Throwable) {}
    }
  }

  // ─── fim ────────────────────────────────────────────────────────────────

  fun finish(result: Map<String, Any?>) {
    if (finished) return
    finished = true
    releaseCamera()
    realDismiss()
    try { onResult(result) } catch (t: Throwable) { Log.w(TAG, "result: ${t.message}") }
  }

  fun finishSilently() {
    if (finished) return
    finished = true
    releaseCamera()
    realDismiss()
    try { onResult(mapOf("action" to "cancel")) } catch (_: Throwable) {}
  }

  // ─── obturador (desenho) ────────────────────────────────────────────────

  private class ShutterView(c: Context) : View(c) {
    private val d = c.resources.displayMetrics.density
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.WHITE; strokeWidth = 5 * d }
    private val red = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = 0xFFEF4444.toInt() }
    private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE; color = 0xFFEF4444.toInt(); strokeWidth = 5 * d; strokeCap = Paint.Cap.ROUND
    }
    private var rec = false
    private var progressStart = 0L
    private var progressTotal = 0L
    private val rect = RectF()

    init {
      isClickable = true
      isFocusable = true
    }

    fun setRecording(on: Boolean) {
      rec = on
      if (!on) { progressStart = 0L; progressTotal = 0L }
      ring.color = if (on) 0xD9FFFFFF.toInt() else Color.WHITE
      invalidate()
    }

    fun startProgress(totalMs: Long) {
      progressStart = System.currentTimeMillis()
      progressTotal = totalMs
      invalidate()
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      val cx = width / 2f
      val cy = height / 2f
      val r = 39 * d - 2.5f * d
      canvas.drawCircle(cx, cy, r, ring)
      if (rec) {
        val s = 15 * d
        rect.set(cx - s, cy - s, cx + s, cy + s)
        canvas.drawRoundRect(rect, 8 * d, 8 * d, red)
        if (progressTotal > 0) {
          val p = ((System.currentTimeMillis() - progressStart).toFloat() / progressTotal).coerceIn(0f, 1f)
          rect.set(cx - r, cy - r, cx + r, cy + r)
          canvas.drawArc(rect, -90f, 360f * p, false, arc)
          if (p < 1f) postInvalidateOnAnimation()
        }
      }
    }
  }
}
