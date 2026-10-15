package expo.modules.chatyyreelsfeed

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.TextureView
import android.view.View
import android.view.ViewConfiguration
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.AccelerateInterpolator
import android.view.animation.LinearInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.DecodeFormat
import com.bumptech.glide.load.engine.DiskCacheStrategy
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

// [2026-10-15 native-reels] Página do feed (Android): TextureView (recebe o
// ExoPlayer do pool) + capa (Glide) + degradês + trilho de ações + legenda/
// autor/música + barra fina de progresso (arrastar = buscar). Gestos: toque =
// mudo/som, duplo toque = curtir (coração animado), segurar = pausa com tela
// limpa. O RecyclerView continua interceptando o arrasto vertical.

private const val PINK = 0xFFFF2B55.toInt()
private const val LIVE_RED = 0xFFFF3B30.toInt()

@SuppressLint("ViewConstructor")
class RFRailButton(context: Context, path: String) : LinearLayout(context) {
  val icon = ImageView(context)
  val drawable = RFIconDrawable(path, Color.WHITE)
  val count = TextView(context)

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    isClickable = true
    isFocusable = true
    val d = resources.displayMetrics.density
    icon.setImageDrawable(drawable)
    addView(icon, LayoutParams((34 * d).toInt(), (34 * d).toInt()))
    count.setTextColor(Color.WHITE)
    count.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
    count.typeface = Typeface.DEFAULT_BOLD
    count.gravity = Gravity.CENTER
    count.setShadowLayer(3f, 0f, 1f, 0x80000000.toInt())
    count.maxLines = 1
    addView(count, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = (2 * d).toInt() })
  }

  fun set(color: Int, text: String) {
    drawable.color = color
    count.text = text
    count.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
  }

  override fun dispatchSetPressed(pressed: Boolean) {
    super.dispatchSetPressed(pressed)
    icon.animate().scaleX(if (pressed) 0.88f else 1f).scaleY(if (pressed) 0.88f else 1f).setDuration(if (pressed) 80 else 160).start()
  }

  fun pop() {
    icon.animate().cancel()
    icon.scaleX = 1f
    icon.scaleY = 1f
    icon.animate().scaleX(1.3f).scaleY(1.3f).setDuration(120).withEndAction {
      icon.animate().scaleX(1f).scaleY(1f).setInterpolator(OvershootInterpolator(3f)).setDuration(220).start()
    }.start()
  }
}

@SuppressLint("ViewConstructor")
class RFPageView(context: Context, private val host: Host) : FrameLayout(context) {
  interface Host {
    fun onPageAction(page: RFPageView, action: String)
    fun onPageTap(page: RFPageView)
    fun onPageDoubleTap(page: RFPageView, x: Float, y: Float)
    fun onPageHold(page: RFPageView, holding: Boolean)
    /** phase: 0 começou, 1 moveu, 2 terminou. */
    fun onPageScrub(page: RFPageView, phase: Int, fraction: Float)
  }

  private val d = resources.displayMetrics.density
  private fun dp(v: Float): Int = (v * d).toInt()

  val texture = TextureView(context)
  private val poster = ImageView(context)
  private val topShade = View(context)
  private val bottomShade = View(context)

  private val rail = LinearLayout(context)
  private val avatarBox = FrameLayout(context)
  private val avatar = ImageView(context)
  private val followBtn = FrameLayout(context)
  val likeBtn = RFRailButton(context, RFIconPaths.HEART)
  private val commentBtn = RFRailButton(context, RFIconPaths.COMMENT)
  private val giftBtn = RFRailButton(context, RFIconPaths.GIFT)
  private val shareBtn = RFRailButton(context, RFIconPaths.SHARE)
  val saveBtn = RFRailButton(context, RFIconPaths.BOOKMARK)
  private val moreBtn = RFRailButton(context, RFIconPaths.MORE)
  // [2026-10-15 reels-gaps] disco girando (capa = avatar) → "Usar este som"
  private val disc = FrameLayout(context)
  private val discAvatar = ImageView(context)
  private var discAnim: ObjectAnimator? = null
  // anel pulsante + selo "AO VIVO" (LiveBadgeRing do JS)
  private val liveRing = View(context)
  private val livePill = TextView(context)
  private var liveAnim: ObjectAnimator? = null

  private val info = LinearLayout(context)
  private val authorText = TextView(context)
  private val creditText = TextView(context)
  private val captionText = TextView(context)
  private val musicRow = LinearLayout(context)
  private val musicText = TextView(context)
  private val subtitle = TextView(context)

  private val progressTrack = FrameLayout(context)
  private val progressFill = View(context)
  private val spinner = ProgressBar(context)
  private val errorBox = LinearLayout(context)
  private val errorText = TextView(context)
  private val retryText = TextView(context)
  private val flash = ImageView(context)
  private val flashDrawableOff = RFIconDrawable(RFIconPaths.VOLUME_OFF, Color.WHITE, false)
  private val flashDrawableOn = RFIconDrawable(RFIconPaths.VOLUME_ON, Color.WHITE, false)

  var item: RFItem? = null
    private set
  var slot: RFSlot? = null
  private var labels = RFLabels()
  private var bottomInsetPx = 0
  private var captionExpanded = false
  private var thumbUrl = ""
  private var avatarUrl = ""
  private var progress = 0f
  private var scrubbing = false
  private var scrubCandidate = false
  private var holding = false
  private var downX = 0f
  private var downY = 0f
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private var videoW = 0
  private var videoH = 0

  private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(e: MotionEvent): Boolean = true

    override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
      host.onPageTap(this@RFPageView)
      return true
    }

    override fun onDoubleTap(e: MotionEvent): Boolean {
      host.onPageDoubleTap(this@RFPageView, e.x, e.y)
      return true
    }

    override fun onLongPress(e: MotionEvent) {
      if (scrubbing) return
      holding = true
      parent?.requestDisallowInterceptTouchEvent(true)
      host.onPageHold(this@RFPageView, true)
    }
  })

  init {
    setBackgroundColor(Color.BLACK)
    clipChildren = false
    addView(texture, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    poster.scaleType = ImageView.ScaleType.CENTER_CROP
    addView(poster, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

    topShade.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0x80000000.toInt(), 0))
    addView(topShade, LayoutParams(LayoutParams.MATCH_PARENT, dp(150f), Gravity.TOP))
    bottomShade.background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0x9E000000.toInt(), 0))
    addView(bottomShade, LayoutParams(LayoutParams.MATCH_PARENT, dp(320f), Gravity.BOTTOM))

    // ── trilho ──
    rail.orientation = LinearLayout.VERTICAL
    rail.gravity = Gravity.CENTER_HORIZONTAL
    rail.clipChildren = false
    avatarBox.clipChildren = false
    avatar.scaleType = ImageView.ScaleType.CENTER_CROP
    avatar.background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(0xFF404040.toInt())
      setStroke(dp(1.5f), Color.WHITE)
    }
    avatar.setPadding(dp(1.5f), dp(1.5f), dp(1.5f), dp(1.5f))
    avatarBox.addView(avatar, LayoutParams(dp(50f), dp(50f), Gravity.TOP or Gravity.CENTER_HORIZONTAL))
    // anel AO VIVO atrás do avatar (avatar 50dp no topo → anel 56dp, 3dp p/ fora)
    liveRing.background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(Color.TRANSPARENT)
      setStroke(dp(2.5f), LIVE_RED)
    }
    liveRing.visibility = View.GONE
    avatarBox.addView(liveRing, 0, LayoutParams(dp(56f), dp(56f), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = -dp(3f) })
    // P&B como o JS (profileFollowBadge): selo branco, "+" preto, borda preta.
    followBtn.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE); setStroke(dp(1.5f), Color.BLACK) }
    val plus = ImageView(context).apply { setImageDrawable(RFIconDrawable(RFIconPaths.PLUS, Color.BLACK, false)) }
    followBtn.addView(plus, LayoutParams(dp(14f), dp(14f), Gravity.CENTER))
    followBtn.isClickable = true
    avatarBox.addView(followBtn, LayoutParams(dp(22f), dp(22f), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
    livePill.setTextColor(Color.WHITE)
    livePill.setTextSize(TypedValue.COMPLEX_UNIT_SP, 8f)
    livePill.typeface = Typeface.DEFAULT_BOLD
    livePill.gravity = Gravity.CENTER
    livePill.maxLines = 1
    livePill.setPadding(dp(6f), 0, dp(6f), 0)
    livePill.background = GradientDrawable().apply { cornerRadius = 4 * d; setColor(LIVE_RED); setStroke(dp(1.5f), Color.BLACK) }
    livePill.visibility = View.GONE
    avatarBox.addView(livePill, LayoutParams(LayoutParams.WRAP_CONTENT, dp(14f), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(44f) })
    avatar.isClickable = true
    rail.addView(avatarBox, LinearLayout.LayoutParams(dp(56f), dp(61f)).apply { bottomMargin = dp(14f) })
    for (b in listOf(likeBtn, commentBtn, giftBtn, shareBtn, saveBtn, moreBtn)) {
      rail.addView(b, LinearLayout.LayoutParams(dp(64f), LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12f) })
    }
    // número de curtidas = alvo próprio (abre a lista de quem curtiu); o ícone segue = curtir
    likeBtn.count.isClickable = true
    likeBtn.count.setPadding(dp(10f), dp(2f), dp(10f), dp(4f))
    // disco (JS albumArt: 40dp, aro #333 de 8dp, miolo #222 de 24dp, avatar 18dp)
    disc.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFF1A1A1A.toInt()); setStroke(dp(8f), 0xFF333333.toInt()) }
    val discInner = FrameLayout(context).apply {
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFF222222.toInt()) }
    }
    discAvatar.scaleType = ImageView.ScaleType.CENTER_CROP
    discAvatar.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFF404040.toInt()) }
    discInner.addView(discAvatar, LayoutParams(dp(18f), dp(18f), Gravity.CENTER))
    disc.addView(discInner, LayoutParams(dp(24f), dp(24f), Gravity.CENTER))
    disc.isClickable = true
    rail.addView(disc, LinearLayout.LayoutParams(dp(40f), dp(40f)).apply { topMargin = dp(2f) })
    addView(rail, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply { rightMargin = dp(6f) })

    // ── informações ──
    info.orientation = LinearLayout.VERTICAL
    for (t in listOf(authorText, creditText, captionText, musicText)) {
      t.setTextColor(Color.WHITE)
      t.setShadowLayer(4f, 0f, 1.5f, 0xBF000000.toInt())
    }
    authorText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    authorText.typeface = Typeface.DEFAULT_BOLD
    authorText.maxLines = 1
    authorText.ellipsize = TextUtils.TruncateAt.END
    authorText.isClickable = true
    creditText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    creditText.setTextColor(0xBFFFFFFF.toInt())
    creditText.maxLines = 1
    creditText.ellipsize = TextUtils.TruncateAt.END
    creditText.isClickable = true
    captionText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f)
    captionText.maxLines = 2
    captionText.ellipsize = TextUtils.TruncateAt.END
    captionText.isClickable = true
    musicText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    // letreiro: o MARQUEE nativo só rola quando o texto não cabe (igual ao MusicMarquee do JS)
    musicText.setSingleLine(true)
    musicText.ellipsize = TextUtils.TruncateAt.MARQUEE
    musicText.marqueeRepeatLimit = -1
    musicText.isSelected = true
    musicRow.orientation = LinearLayout.HORIZONTAL
    musicRow.gravity = Gravity.CENTER_VERTICAL
    musicRow.isClickable = true
    val note = ImageView(context).apply { setImageDrawable(RFIconDrawable(RFIconPaths.MUSIC, Color.WHITE)) }
    musicRow.addView(note, LinearLayout.LayoutParams(dp(15f), dp(15f)).apply { rightMargin = dp(5f) })
    musicRow.addView(musicText, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    info.addView(authorText, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    info.addView(creditText, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2f) })
    info.addView(captionText, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f) })
    info.addView(musicRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(22f)).apply { topMargin = dp(8f) })
    addView(info, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
      leftMargin = dp(14f)
      rightMargin = dp(84f)
    })

    subtitle.setTextColor(Color.WHITE)
    subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    subtitle.typeface = Typeface.DEFAULT_BOLD
    subtitle.gravity = Gravity.CENTER
    subtitle.maxLines = 3
    subtitle.setPadding(dp(8f), dp(4f), dp(8f), dp(4f))
    subtitle.background = GradientDrawable().apply { cornerRadius = 6 * d; setColor(0x73000000) }
    subtitle.visibility = View.GONE
    addView(subtitle, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL))

    // ── progresso ──
    progressTrack.setBackgroundColor(0x38FFFFFF)
    progressFill.setBackgroundColor(0xEBFFFFFF.toInt())
    progressFill.pivotX = 0f
    progressFill.scaleX = 0f
    progressTrack.addView(progressFill, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(progressTrack, LayoutParams(LayoutParams.MATCH_PARENT, dp(2f), Gravity.BOTTOM))

    spinner.isIndeterminate = true
    spinner.indeterminateTintList = ColorStateList.valueOf(Color.WHITE)
    spinner.visibility = View.GONE
    addView(spinner, LayoutParams(dp(44f), dp(44f), Gravity.CENTER))

    errorBox.orientation = LinearLayout.VERTICAL
    errorBox.gravity = Gravity.CENTER
    errorBox.setBackgroundColor(0x59000000)
    errorBox.setPadding(dp(32f), 0, dp(32f), 0)
    errorText.setTextColor(Color.WHITE)
    errorText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    errorText.typeface = Typeface.DEFAULT_BOLD
    errorText.gravity = Gravity.CENTER
    retryText.setTextColor(Color.WHITE)
    retryText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    retryText.typeface = Typeface.DEFAULT_BOLD
    retryText.setPadding(dp(22f), dp(10f), dp(22f), dp(10f))
    retryText.background = GradientDrawable().apply {
      cornerRadius = 22 * d
      setColor(0x2EFFFFFF)
      setStroke(dp(1f), 0x99FFFFFF.toInt())
    }
    retryText.isClickable = true
    errorBox.addView(errorText, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    errorBox.addView(retryText, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14f) })
    errorBox.visibility = View.GONE
    addView(errorBox, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

    flash.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x66000000) }
    flash.setPadding(dp(20f), dp(20f), dp(20f), dp(20f))
    flash.alpha = 0f
    addView(flash, LayoutParams(dp(72f), dp(72f), Gravity.CENTER))

    val wire = listOf<Pair<View, String>>(
      avatar to "author", followBtn to "follow", likeBtn to "like", likeBtn.count to "likers", commentBtn to "comment",
      giftBtn to "gift", shareBtn to "share", saveBtn to "save", moreBtn to "more",
      authorText to "author", creditText to "credit", musicRow to "music", disc to "music", retryText to "retry",
    )
    for ((v, name) in wire) v.setOnClickListener { host.onPageAction(this, name) }
    captionText.setOnClickListener {
      captionExpanded = !captionExpanded
      captionText.maxLines = if (captionExpanded) 12 else 2
    }
  }

  // ─── dados ─────────────────────────────────────────────────────────────────
  fun bind(it: RFItem, labels: RFLabels, bottomInset: Int) {
    val changed = item?.id != it.id
    item = it
    this.labels = labels
    if (changed) {
      captionExpanded = false
      captionText.maxLines = 2
      setProgress(0f)
      showPoster()
      showError(false)
      setBuffering(false)
      setSubtitle("")
      setOverlayHidden(false)
      videoW = 0
      videoH = 0
    }
    if (bottomInset != bottomInsetPx) {
      bottomInsetPx = bottomInset
      applyInsets()
    }
    if (changed || thumbUrl != it.thumb) loadThumb(it.thumb)
    if (changed || avatarUrl != it.avatar) loadAvatar(it.avatar)
    if (it.width > 0 && it.height > 0 && videoW <= 0) setAspectFromItem(it.width, it.height)
    refresh()
  }

  fun refresh() {
    val it = item ?: return
    likeBtn.set(if (it.liked) PINK else Color.WHITE, RFFormat.compact(it.likes))
    likeBtn.contentDescription = labels.like
    likeBtn.count.contentDescription = labels.likers
    commentBtn.set(Color.WHITE, RFFormat.compact(it.comments))
    commentBtn.alpha = if (it.commentsDisabled) 0.4f else 1f
    commentBtn.contentDescription = labels.comment
    giftBtn.set(Color.WHITE, "")
    giftBtn.visibility = if (it.canGift) View.VISIBLE else View.GONE
    giftBtn.contentDescription = labels.gift
    shareBtn.set(Color.WHITE, "")
    shareBtn.contentDescription = labels.share
    // P&B igual ao JS: salvo = marcador cheio branco; não salvo = vazado branco (antes: amarelo).
    saveBtn.drawable.setPathData(if (it.saved) RFIconPaths.BOOKMARK else RFIconPaths.BOOKMARK_OUTLINE)
    saveBtn.set(Color.WHITE, "")
    saveBtn.contentDescription = if (it.saved) labels.saved else labels.save
    moreBtn.set(Color.WHITE, "")
    moreBtn.contentDescription = labels.more
    followBtn.visibility = if (it.canFollow) View.VISIBLE else View.GONE
    followBtn.contentDescription = labels.follow
    avatar.contentDescription = it.author
    authorText.text = it.author
    creditText.text = it.credit
    creditText.visibility = if (it.credit.isEmpty()) View.GONE else View.VISIBLE
    captionText.text = it.caption
    captionText.visibility = if (it.caption.isEmpty()) View.GONE else View.VISIBLE
    if (musicText.text.toString() != it.music) musicText.text = it.music
    musicRow.visibility = if (it.music.isEmpty()) View.GONE else View.VISIBLE
    disc.contentDescription = labels.sound
    livePill.text = labels.live
    setLive(it.live)
    errorText.text = labels.error
    retryText.text = labels.retry
  }

  private fun applyInsets() {
    (rail.layoutParams as LayoutParams).bottomMargin = bottomInsetPx + dp(20f)
    (info.layoutParams as LayoutParams).bottomMargin = bottomInsetPx + dp(18f)
    (progressTrack.layoutParams as LayoutParams).bottomMargin = bottomInsetPx + dp(1f)
    requestLayout()
  }

  private fun glide() = try { Glide.with(context.applicationContext) } catch (_: Throwable) { null }

  private fun loadThumb(url: String) {
    thumbUrl = url
    val g = glide() ?: return
    try {
      g.clear(poster)
      if (url.isEmpty()) {
        poster.setImageDrawable(null)
        return
      }
      g.load(url)
        .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
        .format(DecodeFormat.PREFER_RGB_565)
        .dontAnimate()
        .into(poster)
    } catch (_: Throwable) {}
  }

  private fun loadAvatar(url: String) {
    avatarUrl = url
    val g = glide() ?: return
    try {
      g.clear(avatar)
      if (url.isEmpty()) {
        avatar.setImageDrawable(null)
        return
      }
      g.load(RFImageAuth.model(url)).circleCrop().override(dp(50f)).dontAnimate().into(avatar)
    } catch (_: Throwable) {}
    try {
      g.clear(discAvatar)
      if (url.isEmpty()) {
        discAvatar.setImageDrawable(null)
      } else {
        g.load(RFImageAuth.model(url)).circleCrop().override(dp(18f)).dontAnimate().into(discAvatar)
      }
    } catch (_: Throwable) {}
  }

  // ─── disco / ao vivo ───────────────────────────────────────────────────────
  private fun startDisc() {
    if (discAnim?.isStarted == true) return
    discAnim?.cancel()
    discAnim = ObjectAnimator.ofFloat(disc, View.ROTATION, disc.rotation % 360f, disc.rotation % 360f + 360f).apply {
      duration = 3000
      repeatCount = ValueAnimator.INFINITE
      interpolator = LinearInterpolator()
      start()
    }
  }

  private fun stopDisc() {
    discAnim?.cancel()
    discAnim = null
  }

  private fun setLive(on: Boolean) {
    val v = if (on) View.VISIBLE else View.GONE
    if (liveRing.visibility != v) liveRing.visibility = v
    if (livePill.visibility != v) livePill.visibility = v
    val flp = followBtn.layoutParams as LayoutParams
    val g = if (on) Gravity.TOP or Gravity.END else Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
    val top = if (on) dp(28f) else 0
    if (flp.gravity != g || flp.topMargin != top) {
      flp.gravity = g
      flp.topMargin = top
      followBtn.layoutParams = flp
    }
    if (on && isAttachedToWindow) startLivePulse() else if (!on) stopLivePulse()
  }

  /** Pulso do LiveBadgeRing do JS: escala 1→1,07 e opacidade 0,55→1 em 0,9 s, vai-e-volta. */
  private fun startLivePulse() {
    if (liveAnim?.isStarted == true) return
    liveAnim = ObjectAnimator.ofPropertyValuesHolder(
      liveRing,
      PropertyValuesHolder.ofFloat(View.ALPHA, 0.55f, 1f),
      PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.07f),
      PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.07f),
    ).apply {
      duration = 900
      repeatCount = ValueAnimator.INFINITE
      repeatMode = ValueAnimator.REVERSE
      interpolator = AccelerateDecelerateInterpolator()
      start()
    }
  }

  private fun stopLivePulse() {
    liveAnim?.cancel()
    liveAnim = null
    liveRing.alpha = 1f
    liveRing.scaleX = 1f
    liveRing.scaleY = 1f
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    startDisc()
    if (item?.live == true) startLivePulse()
    musicText.isSelected = true
  }

  override fun onDetachedFromWindow() {
    stopDisc()
    stopLivePulse()
    super.onDetachedFromWindow()
  }

  fun recycle() {
    val g = glide()
    try {
      g?.clear(poster)
      g?.clear(avatar)
      g?.clear(discAvatar)
    } catch (_: Throwable) {}
    stopLivePulse()
    thumbUrl = ""
    avatarUrl = ""
    item = null
    holding = false
    scrubbing = false
  }

  // ─── vídeo ─────────────────────────────────────────────────────────────────
  fun showPoster() {
    poster.animate().cancel()
    poster.alpha = 1f
  }

  fun onFirstFrame() {
    if (poster.alpha == 0f) return
    poster.animate().alpha(0f).setDuration(120).start()
  }

  private fun setAspectFromItem(w: Double, h: Double) {
    val fill = h / w >= 1.2
    poster.scaleType = if (fill) ImageView.ScaleType.CENTER_CROP else ImageView.ScaleType.FIT_CENTER
  }

  /** TextureView estica o quadro para a view → corrige com matriz (preencher retrato / caber paisagem). */
  fun applyVideoTransform(vw: Int, vh: Int) {
    if (vw > 0 && vh > 0) {
      videoW = vw
      videoH = vh
    }
    val w = texture.width.toFloat()
    val h = texture.height.toFloat()
    if (w <= 0f || h <= 0f || videoW <= 0 || videoH <= 0) return
    val fill = videoH.toDouble() / videoW >= 1.2
    poster.scaleType = if (fill) ImageView.ScaleType.CENTER_CROP else ImageView.ScaleType.FIT_CENTER
    val scale = if (fill) max(w / videoW, h / videoH) else min(w / videoW, h / videoH)
    val sx = videoW * scale / w
    val sy = videoH * scale / h
    val m = Matrix()
    m.setScale(sx, sy, w / 2f, h / 2f)
    texture.setTransform(m)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    (bottomShade.layoutParams as LayoutParams).height = (h * 0.45f).toInt().coerceAtLeast(dp(200f))
    post { applyVideoTransform(0, 0) }
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    if (subtitle.visibility == View.VISIBLE) {
      val sw = subtitle.measuredWidth
      val sh = subtitle.measuredHeight
      val l = (width - sw) / 2
      val t = info.top - dp(14f) - sh
      subtitle.layout(l, t, l + sw, t + sh)
    }
  }

  fun setProgress(p: Float) {
    if (scrubbing) return
    val v = p.coerceIn(0f, 1f)
    if (abs(v - progress) < 0.001f && v != 0f) return
    progress = v
    progressFill.scaleX = v
  }

  fun setScrubbing(on: Boolean, fraction: Float?) {
    if (fraction != null) {
      progress = fraction.coerceIn(0f, 1f)
      progressFill.scaleX = progress
    }
    if (on != scrubbing) {
      scrubbing = on
      progressTrack.pivotY = progressTrack.height.toFloat()
      progressTrack.animate().scaleY(if (on) 2f else 1f).setDuration(150).start()
    }
  }

  fun setSubtitle(text: String) {
    if (text.isEmpty()) {
      if (subtitle.visibility != View.GONE) subtitle.visibility = View.GONE
      return
    }
    if (subtitle.text.toString() != text) subtitle.text = text
    if (subtitle.visibility != View.VISIBLE) subtitle.visibility = View.VISIBLE
  }

  fun setBuffering(on: Boolean) {
    val v = if (on) View.VISIBLE else View.GONE
    if (spinner.visibility != v) spinner.visibility = v
  }

  fun showError(on: Boolean) {
    errorBox.visibility = if (on) View.VISIBLE else View.GONE
    if (on) setBuffering(false)
  }

  fun setOverlayHidden(hidden: Boolean) {
    val a = if (hidden) 0f else 1f
    for (v in listOf(rail, info, topShade, bottomShade)) v.animate().alpha(a).setDuration(180).start()
  }

  fun flash(muted: Boolean) {
    flash.setImageDrawable(if (muted) flashDrawableOff else flashDrawableOn)
    flash.animate().cancel()
    flash.alpha = 1f
    flash.scaleX = 0.8f
    flash.scaleY = 0.8f
    flash.animate().scaleX(1f).scaleY(1f).setDuration(160).withEndAction {
      flash.animate().alpha(0f).setStartDelay(500).setDuration(300).start()
    }.start()
  }

  /** Coração do duplo toque: nasce no dedo, cresce com mola, inclina, sobe e some. */
  fun burstHeart(x: Float, y: Float) {
    val size = dp(104f)
    val iv = ImageView(context)
    iv.setImageDrawable(RFIconDrawable(RFIconPaths.HEART, PINK))
    addView(iv, LayoutParams(size, size))
    iv.x = x - size / 2f
    iv.y = y - size / 2f
    iv.alpha = 0f
    iv.scaleX = 0.2f
    iv.scaleY = 0.2f
    iv.rotation = (Math.random() * 36 - 18).toFloat()
    iv.animate().alpha(1f).scaleX(1f).scaleY(1f).setInterpolator(OvershootInterpolator(2.2f)).setDuration(260).withEndAction {
      iv.animate().translationYBy(-dp(90f).toFloat()).alpha(0f).scaleX(1.3f).scaleY(1.3f)
        .setStartDelay(320).setDuration(380).setInterpolator(AccelerateInterpolator())
        .withEndAction { removeView(iv) }.start()
    }.start()
  }

  // ─── toques ────────────────────────────────────────────────────────────────
  private fun inProgressStrip(y: Float): Boolean {
    val bottomLine = height - bottomInsetPx
    return y >= bottomLine - dp(28f) && y <= bottomLine + dp(6f)
  }

  private fun fractionAt(x: Float): Float = if (width > 0) (x / width).coerceIn(0f, 1f) else 0f

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        scrubCandidate = inProgressStrip(ev.y)
        downX = ev.x
        downY = ev.y
      }
      MotionEvent.ACTION_MOVE -> {
        if (scrubCandidate && !scrubbing && !holding) {
          val dx = ev.x - downX
          val dy = ev.y - downY
          if (abs(dx) > touchSlop && abs(dx) > abs(dy)) {
            parent?.requestDisallowInterceptTouchEvent(true)
            val cancel = MotionEvent.obtain(ev)
            cancel.action = MotionEvent.ACTION_CANCEL
            gestures.onTouchEvent(cancel)
            cancel.recycle()
            host.onPageScrub(this, 0, fractionAt(ev.x))
            scrubbing = true
          }
        } else if (scrubbing) {
          host.onPageScrub(this, 1, fractionAt(ev.x))
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (scrubbing) {
          host.onPageScrub(this, 2, fractionAt(ev.x))
          scrubbing = false
          scrubCandidate = false
          return true
        }
      }
    }
    if (!scrubbing) gestures.onTouchEvent(ev)
    val a = ev.actionMasked
    if ((a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) && holding) {
      holding = false
      host.onPageHold(this, false)
    }
    return true
  }
}
