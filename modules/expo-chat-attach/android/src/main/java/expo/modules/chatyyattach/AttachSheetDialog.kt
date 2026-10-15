package expo.modules.chatyyattach

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.FloatValueHolder
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * [2026-10-15 native-attach] Folha de anexos nativa (Telegram) — Dialog sobre
 * a Activity do RN:
 *  • sobe com spring (dynamicanimation); arrastar p/ cima expande p/ tela
 *    cheia, p/ baixo recolhe/fecha; expandida, a grade rola e só solta a folha
 *    quando está no topo;
 *  • grade 3 colunas (MediaStore + Glide em miniatura), 1º quadrado = câmera
 *    ao vivo (CameraX Preview com LifecycleOwner próprio);
 *  • toque seleciona (numerado), toque longo = prévia/edição no JS;
 *  • seleção → legenda + Enviar + chips HD / "Enviar como arquivo";
 *  • permissão: cartão "Permitir acesso"/"Abrir Ajustes"; Android 14 com
 *    acesso parcial → faixa "Gerenciar" (pede de novo = seletor do sistema).
 * Posição: um único `pos` (0 = expandida, collapsedPos = recolhida, além
 * disso = arrastando para fechar).
 */
@SuppressLint("ViewConstructor")
class AttachSheetDialog(
  private val host: Activity,
  private val cfg: CAConfig,
  private val askMediaPermission: (done: () -> Unit) -> Unit,
  private val onResult: (Map<String, Any?>) -> Unit,
) : Dialog(host, android.R.style.Theme_Translucent_NoTitleBar) {

  companion object { private const val TAG = "ChatyyAttach" }

  private val ctx: Context = host
  private fun dp(v: Float) = CAUtil.dp(ctx, v)

  private var finished = false
  private var exporting = false
  private var hd = cfg.hdDefault
  private var asFile = false

  private var media: List<CAMedia> = emptyList()
  private val selected = ArrayList<String>()
  private val selectedMedia = HashMap<String, CAMedia>()

  // geometria
  private var winH = 0
  private var statusInset = 0
  private var navInset = 0
  private var imeInset = 0
  private var pos = 0f
  private var laidOut = false
  private val headerH get() = dp(52f)
  private val barH get() = dp(96f)
  private val spacing get() = dp(2f)

  // câmera
  private val camLife = CALifecycle()
  private var cameraCell: CACameraCell? = null
  private var cameraBound = false
  private var previewUseCase: Preview? = null

  // views
  private val root = FrameLayout(ctx)
  private val dim = View(ctx)
  private val sheet = SheetFrame(ctx)
  private val sheetBg = GradientDrawable()
  private val content = LinearLayout(ctx)
  private val grabber = View(ctx)
  private val title = TextView(ctx)
  private val closeBtn = ImageButton(ctx)
  private val banner = LinearLayout(ctx)
  private val gridHost = FrameLayout(ctx)
  private val recycler = RecyclerView(ctx)
  private val permView = LinearLayout(ctx)
  private val permText = TextView(ctx)
  private val permBtn = TextView(ctx)
  private val bar = FrameLayout(ctx)
  private val actionsScroll = HorizontalScrollView(ctx)
  private val actionsRow = LinearLayout(ctx)
  private val selBar = LinearLayout(ctx)
  private lateinit var hdChip: CAChip
  private lateinit var fileChip: CAChip
  private val caption = EditText(ctx)
  private val sendBtn = FrameLayout(ctx)
  private val sendIcon = ImageView(ctx)
  private val sendSpin = ProgressBar(ctx)
  private val countBadge = TextView(ctx)

  private var spring: SpringAnimation? = null
  private val holder = FloatValueHolder(0f)

  private val adapter = GridAdapter()
  private val layoutManager = object : GridLayoutManager(ctx, 3) {
    override fun canScrollVertically(): Boolean = pos <= 0.5f && super.canScrollVertically()
  }

  private val lifecycleCb = object : android.app.Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(a: Activity, b: Bundle?) {}
    override fun onActivityStarted(a: Activity) {}
    override fun onActivityResumed(a: Activity) { if (a === host) camLife.resume() }
    override fun onActivityPaused(a: Activity) { if (a === host) camLife.pause() }
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
    root.addOnLayoutChangeListener { _, _, top, _, bottom, _, oldTop, _, oldBottom ->
      if (bottom - top != oldBottom - oldTop || !laidOut) onRootSized(bottom - top)
    }
    refreshAuthorization()
    refreshSelectionUi(false)
  }

  override fun onStart() {
    super.onStart()
    window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    if (imeInset > 0) { hideKeyboard(); return }
    finish(mapOf("action" to "cancel"))
  }

  override fun dismiss() {
    if (!finished) finish(mapOf("action" to "cancel")) else realDismiss()
  }

  private fun realDismiss() {
    stopCamera()
    try { host.application.unregisterActivityLifecycleCallbacks(lifecycleCb) } catch (_: Throwable) {}
    try { super.dismiss() } catch (_: Throwable) {}
  }

  private fun setupWindow() {
    val w = window ?: return
    w.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
    w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
    w.setWindowAnimations(0)
    @Suppress("DEPRECATION")
    w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN)
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
    if (Build.VERSION.SDK_INT >= 29) {
      w.isStatusBarContrastEnforced = false
      w.isNavigationBarContrastEnforced = false
    }
    val ctl = WindowInsetsControllerCompat(w, w.decorView)
    ctl.isAppearanceLightStatusBars = false
    ctl.isAppearanceLightNavigationBars = !cfg.dark
  }

  // ─── UI ─────────────────────────────────────────────────────────────────

  private fun buildUi() {
    root.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    dim.setBackgroundColor(0x6B000000)
    dim.alpha = 0f
    dim.contentDescription = cfg.t("close", "Fechar")
    dim.setOnClickListener {
      if (imeInset > 0) hideKeyboard() else finish(mapOf("action" to "cancel"))
    }
    root.addView(dim, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    // Folha (grade). Altura = janela; posicionada por translationY.
    sheetBg.setColor(cfg.bg)
    sheet.background = sheetBg
    sheet.clipToOutline = true
    sheet.translationY = 10000f
    root.addView(sheet, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    content.orientation = LinearLayout.VERTICAL
    sheet.addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    // Cabeçalho.
    val header = FrameLayout(ctx)
    grabber.background = GradientDrawable().apply {
      cornerRadius = dp(2.5f).toFloat()
      setColor((cfg.textSecondary and 0x00FFFFFF) or 0x59000000)
    }
    val glp = FrameLayout.LayoutParams(dp(36f), dp(5f), Gravity.TOP or Gravity.CENTER_HORIZONTAL)
    glp.topMargin = dp(6f)
    header.addView(grabber, glp)
    title.text = cfg.t("recents", "Recentes")
    title.setTextColor(cfg.text)
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
    title.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
    title.maxLines = 1
    title.ellipsize = TextUtils.TruncateAt.END
    val tlp = FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.START or Gravity.CENTER_VERTICAL)
    tlp.leftMargin = dp(16f)
    tlp.topMargin = dp(4f)
    header.addView(title, tlp)
    closeBtn.setImageResource(R.drawable.ca_ic_close)
    closeBtn.setColorFilter(cfg.text)
    closeBtn.background = null
    closeBtn.contentDescription = cfg.t("close", "Fechar")
    closeBtn.alpha = 0f
    closeBtn.setOnClickListener { finish(mapOf("action" to "cancel")) }
    val clp = FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.END or Gravity.CENTER_VERTICAL)
    clp.rightMargin = dp(6f)
    clp.topMargin = dp(4f)
    header.addView(closeBtn, clp)
    content.addView(header, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, headerH))

    // Faixa de acesso parcial (Android 14).
    banner.orientation = LinearLayout.HORIZONTAL
    banner.gravity = Gravity.CENTER_VERTICAL
    banner.setBackgroundColor(cfg.surface)
    banner.setPadding(dp(16f), 0, dp(8f), 0)
    banner.visibility = View.GONE
    val bText = TextView(ctx)
    bText.text = cfg.t("limited", "Você permitiu acesso a algumas fotos.")
    bText.setTextColor(cfg.textSecondary)
    bText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    bText.maxLines = 2
    banner.addView(bText, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    val bBtn = TextView(ctx)
    bBtn.text = cfg.t("manage", "Gerenciar")
    bBtn.setTextColor(cfg.text)
    bBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    bBtn.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
    bBtn.gravity = Gravity.CENTER
    bBtn.setPadding(dp(12f), 0, dp(12f), 0)
    bBtn.minHeight = dp(44f)
    bBtn.setOnClickListener { askMediaPermission { refreshAuthorization() } }
    banner.addView(bBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(44f)))
    content.addView(banner, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44f)))

    // Grade.
    recycler.layoutManager = layoutManager
    recycler.adapter = adapter
    recycler.setHasFixedSize(true)
    recycler.itemAnimator = null
    recycler.clipToPadding = false
    recycler.overScrollMode = View.OVER_SCROLL_NEVER
    recycler.addItemDecoration(object : RecyclerView.ItemDecoration() {
      override fun getItemOffsets(out: android.graphics.Rect, view: View, parent: RecyclerView, state: RecyclerView.State) {
        val p = parent.getChildAdapterPosition(view)
        if (p < 0) return
        val col = p % 3
        val s = spacing
        out.left = col * s / 3
        out.right = s - (col + 1) * s / 3
        out.bottom = s
      }
    })
    gridHost.addView(recycler, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    buildPermissionView()
    content.addView(gridHost, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

    // Barra inferior (fora da folha: fica presa ao rodapé).
    buildBar()
    root.addView(bar, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
    bar.translationY = 10000f

    ViewCompat.setOnApplyWindowInsetsListener(root) { _, ins ->
      val sys = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = ins.getInsets(WindowInsetsCompat.Type.ime())
      statusInset = sys.top
      navInset = sys.bottom
      val newIme = max(0, ime.bottom - sys.bottom)
      val opened = newIme > 0 && imeInset == 0
      imeInset = newIme
      bar.setPadding(0, 0, 0, max(navInset, dp(12f)))
      recycler.setPadding(0, 0, 0, barH + max(navInset, dp(12f)) + statusInset + dp(8f))
      applyPos()
      if (opened && pos > 0.5f) animateTo(0f, 0f)
      ins
    }
  }

  private fun buildPermissionView() {
    permView.orientation = LinearLayout.VERTICAL
    permView.gravity = Gravity.CENTER
    permView.visibility = View.GONE
    permView.setPadding(dp(32f), 0, dp(32f), 0)
    permView.isClickable = true
    val icon = ImageView(ctx)
    icon.setImageResource(R.drawable.ca_ic_gallery)
    icon.setColorFilter(cfg.textSecondary)
    permView.addView(icon, LinearLayout.LayoutParams(dp(36f), dp(36f)))
    permText.setTextColor(cfg.textSecondary)
    permText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    permText.gravity = Gravity.CENTER
    val plp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    plp.topMargin = dp(12f)
    permView.addView(permText, plp)
    permBtn.setTextColor(cfg.bg)
    permBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    permBtn.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
    permBtn.gravity = Gravity.CENTER
    permBtn.setPadding(dp(22f), 0, dp(22f), 0)
    permBtn.background = GradientDrawable().apply { cornerRadius = dp(22f).toFloat(); setColor(cfg.text) }
    permBtn.setOnClickListener { onPermButton() }
    val blp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(44f))
    blp.topMargin = dp(16f)
    permView.addView(permBtn, blp)
    gridHost.addView(permView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
  }

  private fun buildBar() {
    bar.setBackgroundColor(cfg.bg)
    bar.isClickable = true
    val hair = View(ctx)
    hair.setBackgroundColor(cfg.border)
    bar.addView(hair, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, max(1, dp(0.5f)), Gravity.TOP))
    val inner = FrameLayout(ctx)
    bar.addView(inner, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, barH))

    // Ações.
    actionsScroll.isHorizontalScrollBarEnabled = false
    actionsScroll.overScrollMode = View.OVER_SCROLL_NEVER
    actionsRow.orientation = LinearLayout.HORIZONTAL
    actionsRow.setPadding(dp(8f), 0, dp(8f), 0)
    val acts = cfg.actions.filter { !(cfg.allowCamera && it.key == "camera") }
    for (a in acts) {
      val b = CAActionButton(ctx, a.key, a.label, cfg)
      b.setOnClickListener {
        if (exporting) return@setOnClickListener
        CAUtil.haptic(b)
        finish(mapOf("action" to "action", "key" to a.key))
      }
      actionsRow.addView(b, LinearLayout.LayoutParams(dp(74f), dp(80f)))
    }
    actionsScroll.addView(actionsRow, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.MATCH_PARENT))
    val alp = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(84f), Gravity.TOP)
    alp.topMargin = dp(8f)
    inner.addView(actionsScroll, alp)
    // Poucas ações → distribui na largura (como a grade do iOS).
    actionsScroll.post {
      val total = acts.size * dp(74f) + dp(16f)
      if (acts.isNotEmpty() && total < actionsScroll.width) {
        val w = (actionsScroll.width - dp(16f)) / acts.size
        for (i in 0 until actionsRow.childCount) {
          val lp = actionsRow.getChildAt(i).layoutParams as LinearLayout.LayoutParams
          lp.width = w
          actionsRow.getChildAt(i).layoutParams = lp
        }
      }
    }

    // Seleção.
    selBar.orientation = LinearLayout.VERTICAL
    selBar.alpha = 0f
    selBar.visibility = View.INVISIBLE
    val chips = LinearLayout(ctx)
    chips.orientation = LinearLayout.HORIZONTAL
    chips.gravity = Gravity.CENTER_VERTICAL
    chips.setPadding(dp(12f), 0, dp(12f), 0)
    hdChip = CAChip(ctx, cfg.t("hd", "HD"), cfg)
    hdChip.on = hd
    hdChip.setOnClickListener { hd = !hd; hdChip.on = hd; CAUtil.haptic(hdChip, "select") }
    fileChip = CAChip(ctx, cfg.t("asFile", "Enviar como arquivo"), cfg)
    fileChip.setOnClickListener {
      asFile = !asFile
      fileChip.on = asFile
      hdChip.visibility = if (asFile) View.GONE else View.VISIBLE
      CAUtil.haptic(fileChip, "select")
    }
    val c1 = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(30f))
    c1.rightMargin = dp(8f)
    chips.addView(hdChip, c1)
    chips.addView(fileChip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(30f)))
    val chlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(30f))
    chlp.topMargin = dp(8f)
    selBar.addView(chips, chlp)

    val row = LinearLayout(ctx)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    row.setPadding(dp(12f), 0, dp(12f), 0)
    caption.hint = cfg.t("caption", "Adicionar legenda...")
    caption.setHintTextColor(cfg.textSecondary)
    caption.setTextColor(cfg.text)
    caption.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    caption.isSingleLine = true
    caption.imeOptions = EditorInfo.IME_ACTION_SEND
    caption.setPadding(dp(14f), 0, dp(14f), 0)
    caption.background = GradientDrawable().apply { cornerRadius = dp(20f).toFloat(); setColor(cfg.chip) }
    caption.setOnEditorActionListener { _, id, ev ->
      if (id == EditorInfo.IME_ACTION_SEND || (ev != null && ev.keyCode == KeyEvent.KEYCODE_ENTER)) { onSend(); true } else false
    }
    row.addView(caption, LinearLayout.LayoutParams(0, dp(40f), 1f))

    sendBtn.background = caCircleBg(cfg.text)
    sendBtn.contentDescription = cfg.t("send", "Enviar")
    sendBtn.isClickable = true
    sendBtn.setOnClickListener { onSend() }
    sendIcon.setImageResource(R.drawable.ca_ic_send)
    sendIcon.setColorFilter(cfg.bg)
    sendBtn.addView(sendIcon, FrameLayout.LayoutParams(dp(20f), dp(20f), Gravity.CENTER))
    sendSpin.isIndeterminate = true
    sendSpin.indeterminateTintList = android.content.res.ColorStateList.valueOf(cfg.bg)
    sendSpin.visibility = View.GONE
    sendBtn.addView(sendSpin, FrameLayout.LayoutParams(dp(22f), dp(22f), Gravity.CENTER))
    val slp = LinearLayout.LayoutParams(dp(44f), dp(44f))
    slp.leftMargin = dp(10f)
    val sendWrap = FrameLayout(ctx)
    sendWrap.clipChildren = false
    sendWrap.addView(sendBtn, FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.CENTER))
    countBadge.setTextColor(cfg.text)
    countBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    countBadge.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
    countBadge.gravity = Gravity.CENTER
    countBadge.minWidth = dp(20f)
    countBadge.setPadding(dp(4f), 0, dp(4f), 0)
    countBadge.background = GradientDrawable().apply {
      cornerRadius = dp(10f).toFloat(); setColor(cfg.bg); setStroke(dp(1.5f), cfg.text)
    }
    countBadge.visibility = View.GONE
    sendWrap.addView(countBadge, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(20f), Gravity.TOP or Gravity.END))
    row.clipChildren = false
    row.addView(sendWrap, slp)
    val rlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(50f))
    rlp.topMargin = dp(4f)
    selBar.addView(row, rlp)
    inner.clipChildren = false
    bar.clipChildren = false
    inner.addView(selBar, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
  }

  // ─── geometria ──────────────────────────────────────────────────────────

  private val expandedTop: Float get() = (statusInset + dp(6f)).toFloat()

  private val cellSide: Int get() = (root.width - spacing * 2) / 3

  private val collapsedPos: Float
    get() {
      if (winH <= 0) return 0f
      val want = headerH + cellSide * 2.3f + barH + max(navInset, dp(12f))
      val top = max(expandedTop, winH - want)
      return top - expandedTop
    }

  private fun onRootSized(h: Int) {
    if (h <= 0) return
    winH = h
    val lp = (permView.layoutParams as FrameLayout.LayoutParams)
    lp.topMargin = if (cfg.allowCamera) cellSide + spacing else 0
    permView.layoutParams = lp
    if (!laidOut) {
      laidOut = true
      pos = winH.toFloat()
      applyPos()
      root.post {
        CAUtil.haptic(root, "select")
        animateTo(collapsedPos, 0f)
        startCameraIfPossible()
      }
    } else {
      applyPos()
    }
  }

  private fun applyPos() {
    if (winH <= 0) return
    val cp = collapsedPos
    val topPart = min(pos, cp)
    val dismiss = max(0f, pos - cp)
    sheet.translationY = expandedTop + topPart + dismiss
    bar.translationY = dismiss - imeInset
    val p = if (cp > 0f) 1f - (topPart / cp) else 1f // 0 recolhida … 1 expandida
    closeBtn.alpha = p
    grabber.alpha = 1f - p * 0.6f
    val r = dp(14f) * (1f - p * 0.6f)
    sheetBg.cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
    val travel = max(1f, winH - (expandedTop + cp))
    dim.alpha = max(0f, 1f - dismiss / travel)
  }

  private fun animateTo(target: Float, velocity: Float, end: (() -> Unit)? = null) {
    spring?.cancel()
    holder.value = pos
    val s = SpringAnimation(holder)
    s.spring = SpringForce(target).apply {
      dampingRatio = 0.86f
      stiffness = 700f
    }
    s.setStartVelocity(velocity)
    s.addUpdateListener { _, v, _ -> pos = v; applyPos() }
    s.addEndListener { _, canceled, _, _ -> if (!canceled) { pos = target; applyPos(); end?.invoke() } }
    spring = s
    s.start()
  }

  private fun settle(vy: Float) {
    val cp = collapsedPos
    val fast = dp(500f).toFloat()
    if (pos > cp + 1f) {
      if (pos - cp > dp(110f) || vy > fast * 1.8f) { finish(mapOf("action" to "cancel")); return }
      animateTo(cp, vy)
      return
    }
    if (vy > fast * 3f && pos >= cp - 1f) { finish(mapOf("action" to "cancel")); return }
    val target = when {
      vy < -fast -> 0f
      vy > fast -> cp
      else -> if (pos < cp / 2f) 0f else cp
    }
    animateTo(target, vy)
  }

  // ─── arrastar ───────────────────────────────────────────────────────────

  inner class SheetFrame(c: Context) : FrameLayout(c) {
    private val slop = ViewConfiguration.get(c).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var lastY = 0f
    private var dragging = false
    private var vt: VelocityTracker? = null

    private fun track(ev: MotionEvent) {
      if (vt == null) vt = VelocityTracker.obtain()
      vt?.addMovement(ev)
    }

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
      if (exporting || finished) return false
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = ev.rawX; downY = ev.rawY; lastY = ev.rawY; dragging = false
          vt?.recycle(); vt = null
          track(ev)
          spring?.cancel()
        }
        MotionEvent.ACTION_MOVE -> {
          track(ev)
          val dy = ev.rawY - downY
          val dx = ev.rawX - downX
          if (!dragging && abs(dy) > slop && abs(dy) > abs(dx)) {
            val inGrid = isInGrid(downX, downY)
            val expanded = pos <= 0.5f
            dragging = !expanded || !inGrid || (dy > 0 && !recycler.canScrollVertically(-1))
            if (dragging) { lastY = ev.rawY; hideKeyboard(); return true }
          }
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          vt?.recycle(); vt = null
        }
      }
      return false
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(ev: MotionEvent): Boolean {
      if (exporting || finished) return false
      track(ev)
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = ev.rawX; downY = ev.rawY; lastY = ev.rawY; dragging = false
          spring?.cancel()
          return true
        }
        MotionEvent.ACTION_MOVE -> {
          if (!dragging) {
            if (abs(ev.rawY - downY) > slop) { dragging = true; lastY = ev.rawY; hideKeyboard() } else return true
          }
          val d = ev.rawY - lastY
          lastY = ev.rawY
          pos = max(0f, pos + d)
          applyPos()
          return true
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          val v = vt
          var vy = 0f
          if (v != null) { v.computeCurrentVelocity(1000); vy = v.yVelocity }
          vt?.recycle(); vt = null
          if (dragging) { dragging = false; settle(vy) } else if (pos > collapsedPos + 1f) settle(0f)
          return true
        }
      }
      return true
    }

    private fun isInGrid(x: Float, y: Float): Boolean {
      val loc = IntArray(2)
      recycler.getLocationOnScreen(loc)
      return x >= loc[0] && x <= loc[0] + recycler.width && y >= loc[1] && y <= loc[1] + recycler.height
    }
  }

  // ─── permissão / dados ──────────────────────────────────────────────────

  private fun refreshAuthorization() {
    val access = CAUtil.mediaAccess(ctx)
    if (access == "none") {
      permText.text = cfg.t("permPrompt", "Permita o acesso às fotos para enviar as mais recentes com um toque.")
      permBtn.text = cfg.t("permAllow", "Permitir acesso")
      permView.visibility = View.VISIBLE
      banner.visibility = View.GONE
      media = emptyList()
      adapter.notifyDataSetChanged()
      return
    }
    permView.visibility = View.GONE
    banner.visibility = if (access == "partial") View.VISIBLE else View.GONE
    CAMediaStore.io.execute {
      val list = try { CAMediaStore.queryRecent(ctx, 1500) } catch (t: Throwable) { Log.w(TAG, "query: ${t.message}"); emptyList() }
      CAUtil.main.post {
        if (finished) return@post
        media = list
        // Seleção que deixou de existir (acesso parcial reduzido).
        val keys = list.map { it.key }.toHashSet()
        val before = selected.size
        selected.retainAll { keys.contains(it) }
        if (selected.size != before) refreshSelectionUi(true)
        adapter.notifyDataSetChanged()
      }
    }
  }

  private var askedOnce = false

  private fun onPermButton() {
    if (!askedOnce) {
      askedOnce = true
      askMediaPermission {
        if (CAUtil.mediaAccess(ctx) == "none") {
          permText.text = cfg.t("permDenied", "O acesso às fotos está desativado. Ative nos Ajustes para ver suas fotos aqui.")
          permBtn.text = cfg.t("permSettings", "Abrir Ajustes")
        }
        refreshAuthorization()
      }
      return
    }
    try {
      val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(i)
    } catch (_: Throwable) {}
  }

  // ─── câmera ao vivo ─────────────────────────────────────────────────────

  private fun startCameraIfPossible() {
    if (!cfg.allowCamera || !CAUtil.hasCamera(ctx) || cameraBound || finished) return
    val cell = cameraCell ?: return
    cameraBound = true
    camLife.start()
    CameraHub.withProvider(ctx) { provider ->
      if (provider == null || finished || !cameraBound) return@withProvider
      try {
        val p = Preview.Builder().build()
        p.setSurfaceProvider(cell.preview.surfaceProvider)
        provider.bindToLifecycle(camLife, CameraSelector.DEFAULT_BACK_CAMERA, p)
        previewUseCase = p
        cell.preview.animate().alpha(1f).setStartDelay(150).setDuration(220).start()
      } catch (t: Throwable) {
        Log.w(TAG, "tile bind failed: ${t.message}")
      }
    }
  }

  private fun stopCamera() {
    if (!cameraBound) return
    cameraBound = false
    val p = previewUseCase
    previewUseCase = null
    if (p != null) {
      CameraHub.withProvider(ctx) { provider -> try { provider?.unbind(p) } catch (_: Throwable) {} }
    }
    camLife.destroy()
  }

  // ─── seleção ────────────────────────────────────────────────────────────

  private fun toggle(m: CAMedia, cell: CAMediaCell?) {
    val k = m.key
    val i = selected.indexOf(k)
    if (i >= 0) {
      selected.removeAt(i)
      selectedMedia.remove(k)
    } else {
      if (selected.size >= cfg.maxSelect) { CAUtil.haptic(cell, "warn"); return }
      selected.add(k)
      selectedMedia[k] = m
    }
    CAUtil.haptic(cell, "select")
    refreshVisibleBadges(k)
    refreshSelectionUi(true)
  }

  private fun refreshVisibleBadges(changed: String?) {
    for (i in 0 until recycler.childCount) {
      val c = recycler.getChildAt(i) as? CAMediaCell ?: continue
      val idx = selected.indexOf(c.key)
      c.setSelectedNumber(if (idx >= 0) idx + 1 else null, c.key == changed)
    }
  }

  private fun refreshSelectionUi(animate: Boolean) {
    val n = selected.size
    val show = n > 0
    title.text = if (show) cfg.t("selectedCount", "{count} selecionados").replace("{count}", n.toString())
                 else cfg.t("recents", "Recentes")
    countBadge.text = n.toString()
    countBadge.visibility = if (n >= 2) View.VISIBLE else View.GONE
    val dy = dp(14f).toFloat()
    if (show) {
      selBar.visibility = View.VISIBLE
      if (animate) {
        selBar.translationY = dy
        selBar.animate().alpha(1f).translationY(0f).setDuration(220).start()
        actionsScroll.animate().alpha(0f).translationY(dy).setDuration(180).withEndAction {
          if (selected.isNotEmpty()) actionsScroll.visibility = View.INVISIBLE
        }.start()
      } else {
        selBar.alpha = 1f; actionsScroll.alpha = 0f; actionsScroll.visibility = View.INVISIBLE
      }
    } else {
      actionsScroll.visibility = View.VISIBLE
      hideKeyboard()
      if (animate) {
        actionsScroll.animate().alpha(1f).translationY(0f).setDuration(220).start()
        selBar.animate().alpha(0f).translationY(dy).setDuration(180).withEndAction {
          if (selected.isEmpty()) selBar.visibility = View.INVISIBLE
        }.start()
      } else {
        actionsScroll.alpha = 1f; selBar.alpha = 0f; selBar.visibility = View.INVISIBLE
      }
    }
  }

  private fun setExporting(on: Boolean) {
    exporting = on
    sendIcon.visibility = if (on) View.GONE else View.VISIBLE
    sendSpin.visibility = if (on) View.VISIBLE else View.GONE
    sendBtn.isEnabled = !on
    caption.isEnabled = !on
    hdChip.isEnabled = !on
    fileChip.isEnabled = !on
  }

  private fun onSend() {
    if (exporting || selected.isEmpty()) return
    CAUtil.haptic(sendBtn)
    exportAndFinish(selected.mapNotNull { selectedMedia[it] }, "send")
  }

  private fun exportAndFinish(list: List<CAMedia>, action: String) {
    if (list.isEmpty()) return
    setExporting(true)
    val cap = caption.text?.toString()?.trim() ?: ""
    CAMediaStore.materializeAll(ctx, list) { items ->
      if (finished) return@materializeAll
      setExporting(false)
      val r = HashMap<String, Any?>()
      r["action"] = action
      r["items"] = items
      if (action == "send") {
        r["caption"] = cap
        r["hd"] = hd
        r["asFile"] = asFile
      }
      finish(r)
    }
  }

  private fun hideKeyboard() {
    try {
      val imm = ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
      imm.hideSoftInputFromWindow(caption.windowToken, 0)
      caption.clearFocus()
    } catch (_: Throwable) {}
  }

  // ─── fim ────────────────────────────────────────────────────────────────

  fun finish(result: Map<String, Any?>) {
    if (finished) return
    finished = true
    hideKeyboard()
    stopCamera()
    spring?.cancel()
    val target = winH.toFloat() + dp(40f)
    val start = pos
    val anim = android.animation.ValueAnimator.ofFloat(0f, 1f)
    anim.duration = 220
    anim.interpolator = android.view.animation.AccelerateInterpolator(1.4f)
    anim.addUpdateListener { a ->
      pos = start + (target - start) * (a.animatedValue as Float)
      applyPos()
    }
    anim.addListener(object : android.animation.AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: android.animation.Animator) {
        realDismiss()
        try { onResult(result) } catch (t: Throwable) { Log.w(TAG, "result: ${t.message}") }
      }
    })
    anim.start()
  }

  fun finishSilently() {
    if (finished) return
    finished = true
    stopCamera()
    realDismiss()
    try { onResult(mapOf("action" to "cancel")) } catch (_: Throwable) {}
  }

  // ─── adapter ────────────────────────────────────────────────────────────

  private inner class Holder(v: View) : RecyclerView.ViewHolder(v)

  private inner class GridAdapter : RecyclerView.Adapter<Holder>() {
    private val camOffset get() = if (cfg.allowCamera) 1 else 0

    override fun getItemCount(): Int = camOffset + media.size

    override fun getItemViewType(position: Int): Int = if (cfg.allowCamera && position == 0) 1 else 0

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
      val side = max(1, cellSide)
      val v: View = if (viewType == 1) CACameraCell(ctx) else CAMediaCell(ctx)
      v.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, side)
      return Holder(v)
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
      val side = max(1, cellSide)
      if (holder.itemView.layoutParams.height != side) {
        holder.itemView.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, side)
      }
      if (holder.itemView is CACameraCell) {
        val cell = holder.itemView as CACameraCell
        cameraCell = cell
        cell.contentDescription = cfg.t("camera", "Câmera")
        cell.setOnClickListener {
          if (exporting) return@setOnClickListener
          CAUtil.haptic(cell)
          finish(mapOf("action" to "action", "key" to "camera"))
        }
        if (laidOut) cell.post { startCameraIfPossible() }
        return
      }
      val cell = holder.itemView as CAMediaCell
      val m = media.getOrNull(position - camOffset) ?: return
      cell.key = m.key
      cell.badge.fill = cfg.text
      cell.badge.ink = cfg.bg
      if (m.isVideo) {
        cell.dur.visibility = View.VISIBLE
        cell.dur.text = CAUtil.fmtDur(m.durationMs / 1000.0)
        cell.contentDescription = cfg.t("video", "Vídeo") + " " + cell.dur.text
      } else {
        cell.dur.visibility = View.GONE
        cell.contentDescription = cfg.t("photo", "Foto")
      }
      val idx = selected.indexOf(m.key)
      cell.setSelectedNumber(if (idx >= 0) idx + 1 else null, false)
      try {
        Glide.with(cell.image).load(m.uri)
          .override(side, side)
          .centerCrop()
          .dontAnimate()
          .diskCacheStrategy(DiskCacheStrategy.RESOURCE)
          .into(cell.image)
      } catch (_: Throwable) {}
      cell.setOnClickListener { if (!exporting) toggle(m, cell) }
      cell.setOnLongClickListener {
        if (exporting) return@setOnLongClickListener true
        CAUtil.haptic(cell, "heavy")
        val list = ArrayList(selected.mapNotNull { selectedMedia[it] })
        if (list.none { it.key == m.key }) { if (list.size < cfg.maxSelect) list.add(m) else { list.clear(); list.add(m) } }
        exportAndFinish(list, "preview")
        true
      }
    }

    override fun onViewRecycled(holder: Holder) {
      val v = holder.itemView
      if (v is CAMediaCell) {
        try { Glide.with(v.image).clear(v.image) } catch (_: Throwable) {}
      }
    }
  }
}
