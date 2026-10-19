package expo.modules.chatyyconversationlist

// [2026-10-18 elegance] Cabeçalho que encolhe (Telegram) da tela "Dados do
// contato/grupo" (Android). Mesmo desenho do iOS (ios/CICells.swift →
// CIHeaderOverlay). Modo `headerMode = "collapse"` (apiVersion ≥ 2):
//   • a 1ª linha da lista vira um ESPAÇADOR (CIHeroSpacer) da altura do
//     cabeçalho; o desenho fica neste overlay, por cima do RecyclerView, e é
//     reposicionado a cada onScrolled só com translation/scale/alpha (sem
//     layout → 60/120 fps, sem ponte);
//   • rolar p/ cima → avatar encolhe e some sob a barra; nome/subtítulo
//     assentam no título da barra; ladrilhos esmaecem; barra + hairline
//     aparecem quando o nome encaixa;
//   • puxar p/ baixo (ChatyyChatInfoView intercepta no topo) → avatar cresce;
//     além de 72 dp com foto → a foto vira retângulo de largura total, nome em
//     branco no canto inferior esquerdo sobre degradê.
// O overlay só consome toque no X (e na barra quando opaca); avatar/ladrilhos
// são resolvidos pelo espaçador (os toques passam pela lista → rolar de
// qualquer ponto continua funcionando).

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.request.target.CustomTarget
import com.bumptech.glide.request.transition.Transition
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

internal fun ciLerp(a: Float, b: Float, t: Float): Float = a + (b - a) * t

internal fun ciClamp01(v: Float): Float = if (v < 0f) 0f else if (v > 1f) 1f else v

internal fun ciSmooth(e0: Float, e1: Float, x: Float): Float {
  if (e1 <= e0) return if (x >= e1) 1f else 0f
  val t = ciClamp01((x - e0) / (e1 - e0))
  return t * t * (3f - 2f * t)
}

internal fun ciMixColor(a: Int, b: Int, t: Float): Int {
  val u = ciClamp01(t)
  if (u <= 0f) return a
  if (u >= 1f) return b
  val ca = Color.alpha(a) + ((Color.alpha(b) - Color.alpha(a)) * u).toInt()
  val cr = Color.red(a) + ((Color.red(b) - Color.red(a)) * u).toInt()
  val cg = Color.green(a) + ((Color.green(b) - Color.green(a)) * u).toInt()
  val cb = Color.blue(a) + ((Color.blue(b) - Color.blue(a)) * u).toInt()
  return Color.argb(ca, cr, cg, cb)
}

private fun ciExactly(v: Int): Int = View.MeasureSpec.makeMeasureSpec(max(0, v), View.MeasureSpec.EXACTLY)

/** Linha vazia do topo no modo "collapse": reserva a altura e repassa os toques
 *  (fase 0 = começou, 1 = terminou, 2 = cancelou; x/y no próprio espaçador). */
@SuppressLint("ViewConstructor")
internal class CIHeroSpacer(ctx: Context) : View(ctx) {
  var onTouch: ((Int, Float, Float) -> Unit)? = null
  var heightPx = 0
    set(v) {
      if (v == field) return
      field = v
      requestLayout()
    }

  init {
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), max(1, heightPx))
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> onTouch?.invoke(0, ev.x, ev.y)
      MotionEvent.ACTION_UP -> onTouch?.invoke(1, ev.x, ev.y)
      MotionEvent.ACTION_CANCEL -> onTouch?.invoke(2, ev.x, ev.y)
    }
    return true
  }
}

/** [2026-10-18 profile-native] Tracinhos do carrossel no topo da foto expandida. */
@SuppressLint("ViewConstructor")
internal class CISegments(ctx: Context) : View(ctx) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val rect = RectF()
  private val gap = 4f * ctx.resources.displayMetrics.density
  var count = 0
    set(v) {
      if (v == field) return
      field = v
      invalidate()
    }
  var index = 0
    set(v) {
      if (v == field) return
      field = v
      invalidate()
    }

  init {
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val n = count
    if (n < 2) return
    val w = width.toFloat()
    val h = height.toFloat()
    val bw = max(2f, (w - gap * (n - 1)) / n)
    val r = h / 2f
    for (i in 0 until n) {
      val x = i * (bw + gap)
      rect.set(x, 0f, x + bw, h)
      paint.color = if (i == index) 0xF2FFFFFF.toInt() else 0x66FFFFFF
      canvas.drawRoundRect(rect, r, r, paint)
    }
  }
}

/** [2026-10-19 profile-cover-hero] Anel de status/destaque: arco com degradê
 *  diagonal (LinearGradient no Paint) — um drawCircle, sem bitmap/SVG. */
@SuppressLint("ViewConstructor")
internal class CIRingView(ctx: Context) : View(ctx) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private var c0 = Color.BLACK
  private var c1 = Color.BLACK
  private var shaderW = -1
  var strokePx = 2f * ctx.resources.displayMetrics.density
    set(v) {
      if (v == field) return
      field = v
      invalidate()
    }

  init {
    paint.style = Paint.Style.STROKE
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun setColors(a: Int, b: Int) {
    if (a == c0 && b == c1) return
    c0 = a
    c1 = b
    shaderW = -1
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    if (shaderW != width) {
      shaderW = width
      paint.shader = android.graphics.LinearGradient(0f, 0f, w, h, intArrayOf(c0, c0, c1), floatArrayOf(0f, 0.5f, 1f), android.graphics.Shader.TileMode.CLAMP)
    }
    paint.strokeWidth = strokePx
    val r = min(w, h) / 2f - strokePx / 2f
    canvas.drawCircle(w / 2f, h / 2f, r, paint)
  }
}

@SuppressLint("ViewConstructor")
internal class CIHeaderOverlay(ctx: Context) : ViewGroup(ctx) {
  private val d = ctx.resources.displayMetrics.density
  private fun dp(v: Float): Float = v * d

  val navH: Float get() = dp(56f)
  private val side: Float get() = dp(104f)
  // [2026-10-19 profile-cover-hero] com capa, o avatar desce 64 dp.
  private val avatarTop: Float get() = dp(8f) + (if (hasCover) dp(64f) else 0f)
  private val actionsH: Float get() = dp(64f)
  private val coverH: Float get() = avatarTop + side * 0.5f + dp(22f)

  // [2026-10-19 profile-cover-hero] apiVersion 5: capa + degradê + disco + anel.
  private val cover = ImageView(ctx)
  private val coverFade = View(ctx)
  private val coverTop = View(ctx)
  private val coverFadeBg = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0x00000000, 0x00000000, 0xFF000000.toInt()))
  private var coverKey = ""
  private var hasCover = false
  private var coverTarget: CustomTarget<Bitmap>? = null
  private val disc = View(ctx)
  private val discBg = GradientDrawable()
  private val ring = CIRingView(ctx)
  private var ringMode = ""
  private var lastBtnMix = -1f

  private val avatar = CLAvatarView(ctx)
  private val photo = ImageView(ctx)
  private val scrim = View(ctx)
  private val scrimBg = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0x00000000, 0x00000000, 0x8C000000.toInt()))
  private val badge = FrameLayout(ctx)
  private val badgeBg = GradientDrawable()
  private val badgeIcon = ImageView(ctx)
  private val badgeSpin = ProgressBar(ctx)
  private val actionsRow = LinearLayout(ctx)
  private val tiles = ArrayList<LinearLayout>()
  private val tileBgs = ArrayList<GradientDrawable>()
  private var keys: List<String> = emptyList()
  private val navBg = View(ctx)
  private val hairline = View(ctx)
  private val titleTv = TextView(ctx)
  private val subTv = TextView(ctx)
  val closeBtn = ImageView(ctx)
  // [2026-10-18 profile-native] botão de texto da barra ("Editar") + carrossel.
  private val navBtn = TextView(ctx)
  private val segments = CISegments(ctx)
  private var photoList: List<CIPic> = emptyList()
  var photoIndex = 0
    private set
  private var isBack = false
  private var navKey = ""
  private var prevPhotoTarget: CustomTarget<Bitmap>? = null

  var onClose: (() -> Unit)? = null
  var onNav: ((String) -> Unit)? = null
  /** Opacidade atual da barra (barra opaca bloqueia toques nas linhas por baixo). */
  var navAlpha = 0f
    private set

  private var palette = STPalette.defaults(false)
  private var hasSub = false
  private var hasActions = false
  private var showBadge = false
  private var photoKey = ""
  private var photoReady = false
  private var photoTarget: CustomTarget<Bitmap>? = null
  private var photoRadius = 0f
  private var lastColorE = -1f
  private var pressedKey: String? = null
  private var lastRel = 0f
  private var lastE = 0f
  // Retângulo atual do avatar (p/ o toque).
  private var avL = 0f
  private var avT = 0f
  private var avR = 0f
  private var avB = 0f
  private var avAlpha = 1f

  val hasPhoto: Boolean get() = photoKey.isNotEmpty() && photoReady

  init {
    clipChildren = true
    setWillNotDraw(true)

    cover.scaleType = ImageView.ScaleType.CENTER_CROP
    cover.visibility = View.GONE
    cover.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(cover)
    coverTop.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0x47000000, 0x00000000))
    coverTop.visibility = View.GONE
    coverTop.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(coverTop)
    coverFadeBg.gradientType = GradientDrawable.LINEAR_GRADIENT
    coverFade.background = coverFadeBg
    coverFade.visibility = View.GONE
    coverFade.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(coverFade)
    ring.visibility = View.GONE
    addView(ring)
    discBg.shape = GradientDrawable.OVAL
    disc.background = discBg
    disc.visibility = View.GONE
    disc.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(disc)

    avatar.setBoxDp(104f)
    avatar.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    addView(avatar)

    photo.scaleType = ImageView.ScaleType.CENTER_CROP
    photo.visibility = View.INVISIBLE
    photo.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        outline.setRoundRect(0, 0, view.width, view.height, photoRadius)
      }
    }
    photo.clipToOutline = true
    photo.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(photo)

    scrimBg.gradientType = GradientDrawable.LINEAR_GRADIENT
    scrim.background = scrimBg
    scrim.alpha = 0f
    scrim.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(scrim)

    badgeBg.shape = GradientDrawable.OVAL
    badge.background = badgeBg
    badgeSpin.isIndeterminate = true
    val ic = dp(16f).toInt()
    badge.addView(badgeIcon, FrameLayout.LayoutParams(ic, ic, Gravity.CENTER))
    badge.addView(badgeSpin, FrameLayout.LayoutParams(ic, ic, Gravity.CENTER))
    badge.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    addView(badge)

    actionsRow.orientation = LinearLayout.HORIZONTAL
    addView(actionsRow)

    navBg.alpha = 0f
    addView(navBg)
    hairline.alpha = 0f
    addView(hairline)

    for (tv in listOf(titleTv, subTv)) {
      tv.includeFontPadding = false
      tv.maxLines = 1
      tv.setSingleLine(true)
      tv.ellipsize = TextUtils.TruncateAt.END
      tv.gravity = Gravity.CENTER
    }
    titleTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
    titleTv.typeface = CLType.weight(600)
    titleTv.letterSpacing = -0.35f / 22f
    subTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    subTv.typeface = CLType.weight(400)
    addView(titleTv)
    addView(subTv)

    closeBtn.scaleType = ImageView.ScaleType.CENTER
    closeBtn.setImageDrawable(tintedIcon(ctx, R.drawable.cci_ic_close, palette.text))
    // [2026-10-18 haptics] same VIRTUAL_KEY tick as the rest of chat info.
    closeBtn.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      onClose?.invoke()
    }
    closeBtn.isClickable = true
    closeBtn.isFocusable = true
    addView(closeBtn)

    navBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    navBtn.typeface = CLType.weight(500)
    navBtn.includeFontPadding = false
    navBtn.maxLines = 1
    navBtn.setSingleLine(true)
    navBtn.ellipsize = TextUtils.TruncateAt.END
    navBtn.gravity = Gravity.CENTER
    val np = dp(8f).toInt()
    navBtn.setPadding(np, 0, np, 0)
    navBtn.isClickable = true
    navBtn.isFocusable = true
    navBtn.visibility = View.GONE
    navBtn.setOnClickListener {
      if (navKey.isNotEmpty()) {
        it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        onNav?.invoke(navKey)
      }
    }
    addView(navBtn)

    segments.alpha = 0f
    segments.visibility = View.GONE
    addView(segments)
  }

  // ─── Geometria (px, conteúdo em repouso) ────────────────────────────────

  private val titleY0: Float get() = avatarTop + side + dp(28f)
  private val subY0: Float get() = titleY0 + dp(28f)
  private val textBottom0: Float get() = if (hasSub) subY0 + dp(10f) else titleY0 + dp(14f)
  private val actionsTop0: Float get() = textBottom0 + dp(20f)
  private val navTitleY: Float get() = if (hasSub) dp(19f) else navH / 2f

  /** Altura do espaçador (foto + nome + subtítulo + ações). */
  val heroHeight: Int get() = ((if (hasActions) actionsTop0 + actionsH else textBottom0) + dp(24f)).toInt()

  /** Rolagem em que o nome encaixa no título da barra. */
  val dockRel: Float get() = max(1f, titleY0 - navTitleY)

  private val photoH: Float
    get() {
      val w = width.toFloat()
      val h = height.toFloat()
      return max(dp(200f), min(w, max(dp(260f), h * 0.52f)))
    }

  /** Quanto o espaçador cresce no modo foto. */
  val photoExtra: Int
    get() {
      val zone = photoH + (if (hasActions) dp(12f) + actionsH + dp(24f) else dp(24f))
      return max(0f, zone - heroHeight).toInt()
    }

  private fun rowWidth(w: Int): Int = max(1, min(w - dp(32f).toInt(), dp(460f).toInt()))

  // ─── Dados ──────────────────────────────────────────────────────────────

  fun configure(h: CIHero, p: STPalette, labels: CLLabels) {
    palette = p
    lastColorE = -1f
    avatar.bind(CLRow(id = "hero", kind = "direct", title = h.title, tiles = listOf(h.pic.tile())), CLTheme(p.dark), p.pageBg)
    avatar.contentDescription = labels.get("photo", "Ver foto")
    val list = ArrayList<CIPic>()
    if (h.pic.url.isNotEmpty()) list.add(h.pic)
    list.addAll(h.photos)
    val curUrl = photoList.getOrNull(photoIndex)?.url ?: ""
    photoList = list
    val keepAt = if (curUrl.isNotEmpty()) list.indexOfFirst { it.url == curUrl } else -1
    photoIndex = if (keepAt >= 0) keepAt else 0
    loadPhoto(list.getOrNull(photoIndex) ?: h.pic, false)
    segments.count = if (list.size > 1) list.size else 0
    segments.index = photoIndex
    segments.visibility = if (list.size > 1) View.VISIBLE else View.GONE

    configureCover(h.cover, p)
    ringMode = if (h.ring == "seen" || h.ring == "unseen") h.ring else ""
    ring.visibility = if (ringMode.isEmpty()) View.GONE else View.VISIBLE
    if (ringMode == "seen") {
      ring.setColors(p.tertiary, p.tertiary)
      ring.strokePx = dp(2f)
    } else {
      ring.setColors(p.text, 0xFFF97316.toInt())
      ring.strokePx = dp(3f)
    }
    discBg.setColor(p.pageBg)
    disc.visibility = if (hasCover || ringMode.isNotEmpty()) View.VISIBLE else View.GONE
    lastBtnMix = -1f

    titleTv.text = h.title
    subTv.text = h.sub
    hasSub = h.sub.isNotEmpty()
    subTv.visibility = if (hasSub) View.VISIBLE else View.GONE

    showBadge = h.badge == "camera" || h.busy
    badge.visibility = if (showBadge) View.VISIBLE else View.GONE
    badgeBg.setColor(p.text)
    badgeBg.setStroke(dp(3f).toInt(), p.pageBg)
    badgeIcon.visibility = if (h.busy) View.GONE else View.VISIBLE
    badgeSpin.visibility = if (h.busy) View.VISIBLE else View.GONE
    badgeIcon.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_camera, p.pageBg))
    badgeSpin.indeterminateTintList = ColorStateList.valueOf(p.pageBg)

    while (tiles.size < h.actions.size) {
      val t = makeTile()
      tiles.add(t)
      val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f)
      if (tiles.size > 1) lp.leftMargin = dp(8f).toInt()
      actionsRow.addView(t, lp)
    }
    while (tiles.size > h.actions.size) {
      val t = tiles.removeAt(tiles.size - 1)
      tileBgs.removeAt(tileBgs.size - 1)
      actionsRow.removeView(t)
    }
    keys = h.actions.map { it.key }
    h.actions.forEachIndexed { i, a ->
      val t = tiles[i]
      tileBgs[i].setColor(p.cardBg)
      val icon = t.getChildAt(0) as? ImageView
      val label = t.getChildAt(1) as? TextView
      icon?.setImageDrawable(tintedIcon(context, CIText.drawable(a.icon), p.text))
      label?.text = a.label
      label?.setTextColor(p.text)
      label?.typeface = CLType.weight(if (a.active) 600 else 500)
      t.contentDescription = a.label
      t.scaleX = 1f
      t.scaleY = 1f
    }
    hasActions = h.actions.isNotEmpty()
    actionsRow.visibility = if (hasActions) View.VISIBLE else View.GONE

    navBg.setBackgroundColor(p.pageBg)
    hairline.setBackgroundColor(p.separator)
    closeBtn.contentDescription = labels.get("close", "Fechar")
    isBack = h.back
    closeBtn.setImageDrawable(tintedIcon(context, if (isBack) R.drawable.cci_ic_back else R.drawable.cci_ic_close, palette.text))
    navKey = h.navKey
    navBtn.text = h.navLabel
    navBtn.contentDescription = h.navLabel
    navBtn.visibility = if (h.navKey.isNotEmpty() && h.navLabel.isNotEmpty()) View.VISIBLE else View.GONE
    pressedKey = null
    requestLayout()
  }

  // ─── Capa (apiVersion 5) ────────────────────────────────────────────────

  private fun configureCover(c: CIPic, p: STPalette) {
    coverFadeBg.colors = intArrayOf(p.pageBg and 0x00FFFFFF, p.pageBg and 0x00FFFFFF, p.pageBg)
    cover.setBackgroundColor(p.chipBg)
    val had = hasCover
    hasCover = c.url.isNotEmpty()
    val vis = if (hasCover) View.VISIBLE else View.GONE
    cover.visibility = vis
    coverFade.visibility = vis
    coverTop.visibility = vis
    if (had != hasCover) requestLayout()
    if (c.url == coverKey) return
    val app = context.applicationContext
    coverTarget?.let { old -> try { Glide.with(app).clear(old) } catch (_: Throwable) {} }
    coverTarget = null
    coverKey = c.url
    cover.setImageDrawable(null)
    if (c.url.isEmpty()) return
    val model = CICard.glideModel(c.url, c.auth) ?: return
    val px = min(1080, max(320, resources.displayMetrics.widthPixels))
    val key = c.url
    val target = object : CustomTarget<Bitmap>(px, px) {
      override fun onResourceReady(resource: Bitmap, transition: Transition<in Bitmap>?) {
        if (coverKey != key) return
        cover.setImageBitmap(resource)
      }

      override fun onLoadCleared(placeholder: Drawable?) {
        if (coverKey != key) return
        cover.setImageDrawable(null)
      }
    }
    coverTarget = target
    try {
      Glide.with(app)
        .asBitmap()
        .load(model)
        .override(px, px)
        .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
        .into(target)
    } catch (_: Throwable) {
      coverTarget = null
    }
  }

  // ─── Carrossel (foto expandida) ─────────────────────────────────────────

  /** Avança/volta uma foto; false = não há para onde ir. */
  fun cycle(dir: Int): Boolean {
    val n = photoList.size
    if (n < 2) return false
    val next = photoIndex + (if (dir < 0) -1 else 1)
    if (next < 0 || next >= n) return false
    photoIndex = next
    segments.index = next
    loadPhoto(photoList[next], true)
    return true
  }

  /** Volta para a foto principal (ao recolher a foto expandida). */
  fun resetPhoto() {
    if (photoIndex == 0 || photoList.isEmpty()) return
    photoIndex = 0
    segments.index = 0
    loadPhoto(photoList[0], true)
  }

  private fun makeTile(): LinearLayout {
    val ctx = context
    val t = LinearLayout(ctx)
    t.orientation = LinearLayout.VERTICAL
    t.gravity = Gravity.CENTER
    val bg = GradientDrawable()
    bg.cornerRadius = dp(12f)
    t.background = bg
    tileBgs.add(bg)
    val icon = ImageView(ctx)
    icon.scaleType = ImageView.ScaleType.FIT_CENTER
    t.addView(icon, LinearLayout.LayoutParams(dp(22f).toInt(), dp(22f).toInt()))
    val label = TextView(ctx)
    label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    label.includeFontPadding = false
    label.maxLines = 1
    label.ellipsize = TextUtils.TruncateAt.END
    label.gravity = Gravity.CENTER_HORIZONTAL
    t.addView(label, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
      topMargin = dp(5f).toInt()
      leftMargin = dp(4f).toInt()
      rightMargin = dp(4f).toInt()
    })
    // Só desenho: o toque vem do espaçador (a lista continua rolando daqui).
    t.isClickable = false
    t.isFocusable = false
    return t
  }

  /** keep = true (carrossel): a foto atual continua na tela até a próxima
   *  chegar; o alvo antigo só é liberado depois (bitmap nunca reciclado em uso). */
  private fun loadPhoto(pic: CIPic, keep: Boolean) {
    if (pic.url == photoKey) return
    val app = context.applicationContext
    val keeping = keep && photoReady && photoTarget != null
    prevPhotoTarget?.let { old -> try { Glide.with(app).clear(old) } catch (_: Throwable) {} }
    prevPhotoTarget = null
    if (keeping) {
      prevPhotoTarget = photoTarget
    } else {
      photoTarget?.let { old -> try { Glide.with(app).clear(old) } catch (_: Throwable) {} }
    }
    photoTarget = null
    photoKey = pic.url
    if (!keeping) {
      photoReady = false
      photo.setImageDrawable(null)
    }
    if (pic.url.isEmpty()) return
    val model = CICard.glideModel(pic.url, pic.auth) ?: return
    val px = min(1080, max(320, resources.displayMetrics.widthPixels))
    val key = pic.url
    val target = object : CustomTarget<Bitmap>(px, px) {
      override fun onResourceReady(resource: Bitmap, transition: Transition<in Bitmap>?) {
        if (photoKey != key) return
        photo.setImageBitmap(resource)
        photoReady = true
        // Foto anterior do carrossel já saiu da tela → agora pode ser liberada.
        val prev = prevPhotoTarget
        prevPhotoTarget = null
        if (prev != null) { try { Glide.with(app).clear(prev) } catch (_: Throwable) {} }
      }

      override fun onLoadCleared(placeholder: Drawable?) {
        if (photoKey != key) return
        photo.setImageDrawable(null)
        photoReady = false
      }
    }
    photoTarget = target
    try {
      Glide.with(app)
        .asBitmap()
        .load(model)
        .override(px, px)
        .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
        .into(target)
    } catch (_: Throwable) {
      photoTarget = null
    }
  }

  // ─── Medida / layout em repouso (o resto é translation/scale) ───────────

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(w, h)
    val box = side.toInt()
    avatar.measure(ciExactly(box), ciExactly(box))
    val textMax = MeasureSpec.makeMeasureSpec(max(1, w - dp(48f).toInt()), MeasureSpec.AT_MOST)
    val free = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
    titleTv.measure(textMax, free)
    subTv.measure(textMax, free)
    actionsRow.measure(ciExactly(rowWidth(w)), ciExactly(actionsH.toInt()))
    navBg.measure(ciExactly(w), ciExactly(navH.toInt()))
    hairline.measure(ciExactly(w), ciExactly(max(1, (d * 0.5f).toInt())))
    val cb = dp(44f).toInt()
    closeBtn.measure(ciExactly(cb), ciExactly(cb))
    val bs = dp(34f).toInt()
    badge.measure(ciExactly(bs), ciExactly(bs))
    navBtn.measure(MeasureSpec.makeMeasureSpec(dp(140f).toInt(), MeasureSpec.AT_MOST), ciExactly(cb))
    segments.measure(ciExactly(max(1, w - dp(16f).toInt())), ciExactly(max(1, dp(3f).toInt())))
    photo.measure(ciExactly(max(1, photo.width)), ciExactly(max(1, photo.height)))
    disc.measure(ciExactly((side + dp(8f)).toInt()), ciExactly((side + dp(8f)).toInt()))
    ring.measure(ciExactly((side + dp(16f)).toInt()), ciExactly((side + dp(16f)).toInt()))
    cover.measure(ciExactly(max(1, cover.width)), ciExactly(max(1, cover.height)))
    coverFade.measure(ciExactly(max(1, coverFade.width)), ciExactly(max(1, coverFade.height)))
    coverTop.measure(ciExactly(max(1, coverTop.width)), ciExactly(max(1, coverTop.height)))
    scrim.measure(ciExactly(max(1, scrim.width)), ciExactly(max(1, scrim.height)))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    for (v in listOf<View>(avatar, titleTv, subTv, actionsRow, navBg, badge, disc, ring)) {
      v.layout(0, 0, v.measuredWidth, v.measuredHeight)
    }
    val hl = hairline.measuredHeight
    hairline.layout(0, navH.toInt() - hl, w, navH.toInt())
    val cb = closeBtn.measuredWidth
    val cx = if (isBack) dp(4f).toInt() else w - dp(8f).toInt() - cb
    val cy = ((navH - cb) / 2f).toInt()
    closeBtn.layout(cx, cy, cx + cb, cy + cb)
    val nw = navBtn.measuredWidth
    val nh = navBtn.measuredHeight
    val nx = if (isBack) w - dp(8f).toInt() - nw else dp(8f).toInt()
    val ny = ((navH - nh) / 2f).toInt()
    navBtn.layout(nx, ny, nx + nw, ny + nh)
    segments.layout(0, 0, segments.measuredWidth, segments.measuredHeight)
    apply(lastRel, lastE)
  }

  // ─── Quadro a quadro ────────────────────────────────────────────────────

  /** rel = rolagem relativa ao repouso (px; < 0 = puxando p/ baixo). e = 0…1 foto. */
  fun apply(rel: Float, eIn: Float) {
    lastRel = rel
    lastE = eIn
    val w = width.toFloat()
    if (w <= 0f) return
    val e = ciClamp01(eIn)
    val st = max(0f, -rel)
    val up = max(0f, rel)
    val dock = dockRel
    val k = min(1f, up / dock)

    // Avatar.
    var nSide = side
    var nCY = avatarTop + side / 2f
    var nAlpha = 1f
    if (st > 0f) {
      nSide = side * (1f + min(0.3f, st / dp(260f)))
      nCY += st * 0.5f
    } else {
      nSide = side * ciLerp(1f, 0.35f, k)
      nCY -= up * 0.6f
      nAlpha = 1f - ciSmooth(0.35f, 0.85f, k)
    }
    val s = nSide / side
    val aw = avatar.width.toFloat()
    val ah = avatar.height.toFloat()
    avatar.pivotX = aw / 2f
    avatar.pivotY = ah / 2f
    avatar.translationX = w / 2f - aw / 2f
    avatar.translationY = nCY - ah / 2f
    avatar.scaleX = s
    avatar.scaleY = s
    val usePhoto = e > 0.001f && photoReady
    var l = w / 2f - nSide / 2f
    var t = nCY - nSide / 2f
    var r = w / 2f + nSide / 2f
    var b = nCY + nSide / 2f
    if (usePhoto) {
      val pTop = -up
      l = ciLerp(l, 0f, e)
      t = ciLerp(t, pTop, e)
      r = ciLerp(r, w, e)
      b = ciLerp(b, pTop + photoH + st, e)
      avatar.alpha = 0f
      photo.visibility = View.VISIBLE
      photo.alpha = ciLerp(nAlpha, 1f, e)
      photo.layout(l.toInt(), t.toInt(), r.toInt(), b.toInt())
      photoRadius = min(r - l, b - t) / 2f * (1f - e)
      photo.invalidateOutline()
      scrim.layout(l.toInt(), t.toInt(), r.toInt(), b.toInt())
      scrim.alpha = e
      if (segments.count > 1) {
        segments.translationX = dp(8f)
        segments.translationY = t + dp(6f)
        segments.alpha = ciSmooth(0.6f, 1f, e)
      }
    } else {
      avatar.alpha = nAlpha
      if (photo.visibility != View.INVISIBLE) photo.visibility = View.INVISIBLE
      scrim.alpha = 0f
      segments.alpha = 0f
    }
    avL = l
    avT = t
    avR = r
    avB = b
    avAlpha = if (usePhoto) 1f else nAlpha

    // [2026-10-19 profile-cover-hero] capa anda com o conteúdo, estica ao puxar,
    // some na foto expandida; disco + anel acompanham o avatar (só scale/alpha).
    if (hasCover) {
      val ct = (-up).toInt()
      val cb = (-up + coverH + st).toInt()
      val wi = w.toInt()
      cover.layout(0, ct, wi, cb)
      coverFade.layout(0, ct, wi, cb)
      coverTop.layout(0, ct, wi, ct + min(cb - ct, (navH + dp(36f)).toInt()))
      cover.alpha = 1f - e
      coverFade.alpha = 1f - e
      coverTop.alpha = 1f - e
    }
    val fadeA = nAlpha * (1f - e)
    if (disc.visibility == View.VISIBLE) {
      val dw = disc.width.toFloat()
      disc.pivotX = dw / 2f
      disc.pivotY = dw / 2f
      disc.translationX = w / 2f - dw / 2f
      disc.translationY = nCY - dw / 2f
      disc.scaleX = s
      disc.scaleY = s
      disc.alpha = fadeA
    }
    if (ring.visibility == View.VISIBLE) {
      val rw = ring.width.toFloat()
      ring.pivotX = rw / 2f
      ring.pivotY = rw / 2f
      ring.translationX = w / 2f - rw / 2f
      ring.translationY = nCY - rw / 2f
      ring.scaleX = s
      ring.scaleY = s
      ring.alpha = fadeA
    }

    if (showBadge) {
      val bw = badge.width.toFloat()
      val bs = max(0.5f, min(1.2f, s))
      badge.pivotX = bw / 2f
      badge.pivotY = bw / 2f
      badge.scaleX = bs
      badge.scaleY = bs
      val off = dp(14f) * bs
      badge.translationX = r - off - bw / 2f
      badge.translationY = b - off - bw / 2f
      badge.alpha = nAlpha * (1f - e) * (1f - ciSmooth(0.1f, 0.4f, k))
    }

    // Nome / subtítulo.
    val tDock = ciClamp01((up - (dock - dp(40f))) / dp(40f))
    val nTitleY = max(navTitleY, titleY0 - rel)
    val nTitleS = ciLerp(1f, 17f / 22f, tDock)
    val nSubY = nTitleY + ciLerp(subY0 - titleY0, dp(20f), tDock)
    val nSubS = ciLerp(1f, 13f / 15f, tDock)
    val pBottom = -up + photoH + st
    val pTitleY = pBottom - dp(16f) - (if (hasSub) dp(22f) else 0f) - dp(14f)
    val pSubY = pBottom - dp(16f) - dp(10f)
    val tw = titleTv.width.toFloat()
    val th = titleTv.height.toFloat()
    val sw = subTv.width.toFloat()
    val sh = subTv.height.toFloat()
    val tcx = ciLerp(w / 2f, dp(16f) + tw / 2f, e)
    val tcy = ciLerp(nTitleY, pTitleY, e)
    val scx = ciLerp(w / 2f, dp(16f) + sw / 2f, e)
    val scy = ciLerp(nSubY, pSubY, e)
    titleTv.pivotX = tw / 2f
    titleTv.pivotY = th / 2f
    titleTv.translationX = tcx - tw / 2f
    titleTv.translationY = tcy - th / 2f
    val ts = ciLerp(nTitleS, 1f, e)
    titleTv.scaleX = ts
    titleTv.scaleY = ts
    subTv.pivotX = sw / 2f
    subTv.pivotY = sh / 2f
    subTv.translationX = scx - sw / 2f
    subTv.translationY = scy - sh / 2f
    val ss = ciLerp(nSubS, 1f, e)
    subTv.scaleX = ss
    subTv.scaleY = ss
    if (abs(e - lastColorE) > 0.004f) {
      lastColorE = e
      titleTv.setTextColor(ciMixColor(palette.text, Color.WHITE, e))
      subTv.setTextColor(ciMixColor(palette.secondary, 0xDBFFFFFF.toInt(), e))
    }
    // Seta/X e "Editar": brancos sobre a foto expandida e sobre a capa (até a barra aparecer).
    val coverMix = if (hasCover) 1f - ciSmooth(dock - dp(30f), dock, up) else 0f
    val bm = max(e, coverMix)
    if (abs(bm - lastBtnMix) > 0.004f) {
      lastBtnMix = bm
      closeBtn.setColorFilter(ciMixColor(palette.text, Color.WHITE, bm))
      navBtn.setTextColor(ciMixColor(palette.text, Color.WHITE, bm))
      navBtn.setShadowLayer(dp(3f), 0f, dp(1f), Color.argb((90f * bm).toInt(), 0, 0, 0))
    }

    // Ladrilhos: andam com o conteúdo e somem antes da barra.
    if (hasActions) {
      val top = ciLerp(actionsTop0 - rel, photoH + dp(12f) - rel, e)
      val a = ciClamp01((top - navH) / dp(40f))
      val rw = actionsRow.width.toFloat()
      val rh = actionsRow.height.toFloat()
      actionsRow.pivotX = rw / 2f
      actionsRow.pivotY = rh / 2f
      actionsRow.translationX = w / 2f - rw / 2f
      actionsRow.translationY = top
      val sc = ciLerp(0.92f, 1f, a)
      actionsRow.scaleX = sc
      actionsRow.scaleY = sc
      actionsRow.alpha = a
    }

    // Barra.
    val barA = ciSmooth(dock - dp(30f), dock, up) * (1f - e)
    navAlpha = barA
    navBg.alpha = barA
    hairline.alpha = barA
  }

  // ─── Toques ─────────────────────────────────────────────────────────────

  /** "a:<key>" (ladrilho), "avatar" ou null. x/y nas coordenadas do overlay. */
  fun hit(x: Float, y: Float): String? {
    if (hasActions && actionsRow.visibility == View.VISIBLE && actionsRow.alpha > 0.5f) {
      val sc = max(0.01f, actionsRow.scaleX)
      val rw = actionsRow.width / 2f
      val rh = actionsRow.height / 2f
      val lx = (x - (actionsRow.translationX + rw)) / sc + rw
      val ly = (y - (actionsRow.translationY + rh)) / sc + rh
      for (i in tiles.indices) {
        val t = tiles[i]
        if (lx >= t.left && lx <= t.right && ly >= t.top && ly <= t.bottom) {
          return if (i < keys.size) "a:" + keys[i] else null
        }
      }
    }
    val pad = dp(6f)
    if (avAlpha > 0.4f && x >= avL - pad && x <= avR + pad && y >= avT - pad && y <= avB + pad && y > navH * navAlpha) {
      // Foto expandida com várias fotos: terços laterais trocam a foto (Telegram).
      if (photoList.size > 1 && lastE > 0.5f && photoReady) {
        val w = max(1f, avR - avL)
        val lx = x - avL
        if (lx < w * 0.3f) return "p:-1"
        if (lx > w * 0.7f) return "p:1"
      }
      return "avatar"
    }
    return null
  }

  fun setPressed(key: String?) {
    if (key == pressedKey) return
    pressedKey = key
    val pressFill = ciMixColor(palette.cardBg, palette.text, 0.08f)
    for (i in tiles.indices) {
      val on = i < keys.size && key == "a:" + keys[i]
      val t = tiles[i]
      tileBgs.getOrNull(i)?.setColor(if (on) pressFill else palette.cardBg)
      t.animate().cancel()
      t.animate().scaleX(if (on) 0.94f else 1f).scaleY(if (on) 0.94f else 1f).setDuration(if (on) 110L else 260L).start()
    }
  }

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    val handled = super.dispatchTouchEvent(ev)
    if (handled) return true
    // Barra opaca: não deixa o toque cair na linha que rolou por baixo dela.
    if (ev.actionMasked == MotionEvent.ACTION_DOWN && navAlpha > 0.5f && ev.y < navH) return true
    return false
  }

  override fun onDetachedFromWindow() {
    coverTarget?.let { old -> try { Glide.with(context.applicationContext).clear(old) } catch (_: Throwable) {} }
    coverTarget = null
    coverKey = ""
    photoTarget?.let { old -> try { Glide.with(context.applicationContext).clear(old) } catch (_: Throwable) {} }
    photoTarget = null
    prevPhotoTarget?.let { old -> try { Glide.with(context.applicationContext).clear(old) } catch (_: Throwable) {} }
    prevPhotoTarget = null
    photoKey = ""
    photoReady = false
    super.onDetachedFromWindow()
  }
}
