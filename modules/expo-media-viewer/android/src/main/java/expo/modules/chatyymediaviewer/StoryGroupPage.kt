package expo.modules.chatyymediaviewer

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.TextureView
import android.view.View
import android.view.ViewConfiguration
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.bumptech.glide.Glide
import com.bumptech.glide.RequestBuilder
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.resource.bitmap.DownsampleStrategy
import com.bumptech.glide.request.target.CustomTarget
import com.bumptech.glide.request.transition.Transition
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** [2026-10-15 native-story] Barras de progresso dos segmentos (onDraw). */
class SVProgressBarsView(context: Context) : View(context) {
  private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(90, 255, 255, 255) }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
  private val rect = RectF()
  private var count = 0
  private var index = 0
  private var fraction = 0f

  fun setCount(n: Int) {
    if (n != count) { count = n; invalidate() }
  }

  fun set(index: Int, fraction: Float) {
    val f = fraction.coerceIn(0f, 1f)
    if (index == this.index && abs(f - this.fraction) < 0.001f) return
    this.index = index
    this.fraction = f
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (count <= 0) return
    val d = resources.displayMetrics.density
    val gap = (if (count > 30) 2f else 4f) * d
    val w = (width - gap * (count - 1)) / count
    val h = height.toFloat()
    val r = h / 2
    for (i in 0 until count) {
      val x = i * (w + gap)
      rect.set(x, 0f, x + max(1f, w), h)
      canvas.drawRoundRect(rect, r, r, track)
      val frac = if (i < index) 1f else if (i == index) fraction else 0f
      if (frac > 0f) {
        rect.set(x, 0f, x + max(1f, w) * frac, h)
        canvas.drawRoundRect(rect, r, r, fill)
      }
    }
  }
}

/**
 * [2026-10-15 native-story] Página de UMA pessoa (ViewPager2): mídia, texto
 * com auto-ajuste medido (StaticLayout), barras, cabeçalho e barra inferior.
 * Relógio, ExoPlayer e gestos de navegação ficam no StoryViewerDialog.
 */
@SuppressLint("ViewConstructor")
class SVGroupPage(context: Context, private val labels: SVLabels) : FrameLayout(context) {

  interface Host {
    fun onPageTap(page: SVGroupPage, x: Float)
    fun onPageHold(page: SVGroupPage, start: Boolean)
    fun onItemReady(page: SVGroupPage, item: SVItem)
    fun onItemFinished(page: SVGroupPage, item: SVItem)
    fun onTapClose(page: SVGroupPage)
    fun onTapMenu(page: SVGroupPage, anchor: View)
    fun onTapReply(page: SVGroupPage)
    fun onTapLike(page: SVGroupPage)
    fun onTapViewers(page: SVGroupPage)
    fun onTapLink(page: SVGroupPage, url: String)
    fun onTapMute(page: SVGroupPage)
    fun isMuted(): Boolean
    fun attachVideo(page: SVGroupPage, item: SVItem)
    fun detachVideo(page: SVGroupPage)
    fun prefetch(item: SVItem)
    /** [v2] Bloco interativo tocado (enquete/quiz/pergunta/slider/menção). */
    fun onSticker(page: SVGroupPage, overlay: SVOverlay, info: Map<String, Any?>)
    /** [v2] Toque com coordenadas (duplo toque = curtir). */
    fun onPageTapAt(page: SVGroupPage, x: Float, y: Float) { onPageTap(page, x) }
    /** [v2] true = o player de áudio do dialog controla o progresso/fim da voz. */
    fun voiceDriven(page: SVGroupPage, item: SVItem): Boolean = false
  }

  var host: Host? = null
  var group: SVGroup? = null
    private set
  var position = -1

  private val media = FrameLayout(context)
  private val imageView = ImageView(context)
  val textureView = TextureView(context)
  private val textBg = View(context)
  private val textView = TextView(context)
  private val spinner = ProgressBar(context)
  private val errorText = TextView(context)
  private val touchLayer = View(context)
  val overlayLayer = SVOverlayLayer(context)
  private val voiceView = SVVoiceView(context)
  private var textAnimPlayed = false
  private var typeRevealed = -1
  private var shownText = ""

  private val chrome = FrameLayout(context)
  private val topScrim = View(context)
  private val bottomScrim = View(context)
  private val bars = SVProgressBarsView(context)
  private val header = LinearLayout(context)
  private val avatarBox = FrameLayout(context)
  private val avatar = ImageView(context)
  private val avatarInitial = TextView(context)
  private val nameView = TextView(context)
  private val timeView = TextView(context)
  private val muteBtn = ImageButton(context)
  private val menuBtn = ImageButton(context)
  private val closeBtn = ImageButton(context)
  private val pauseIcon = ImageView(context)
  private val bottom = LinearLayout(context)
  private val captionView = TextView(context)
  private val musicPill = LinearLayout(context)
  private val musicText = TextView(context)
  private val linkPill = LinearLayout(context)
  private val linkText = TextView(context)
  private val viewersPill = LinearLayout(context)
  private val viewersText = TextView(context)
  private val replyRow = LinearLayout(context)
  private val replyPill = TextView(context)
  private val likeBtn = ImageButton(context)

  var index = 0
    private set
  var active = false
    private set
  private var paused = false
  var ready = false
    private set
  private var failed = false
  private var elapsedMs = 0.0
  private var token = 0
  private var targets = ArrayList<CustomTarget<Drawable>>()
  private var topInset = 0
  private var bottomInset = 0

  // Gestos de toque (navegação / segurar)
  private val slop = ViewConfiguration.get(context).scaledTouchSlop
  private var downX = 0f
  private var downY = 0f
  private var holding = false
  private var downAt = 0L
  private val holdRunnable = Runnable {
    holding = true
    host?.onPageHold(this, true)
  }

  val currentItem: SVItem?
    get() {
      val g = group ?: return null
      return if (index in g.items.indices) g.items[index] else null
    }

  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

  private fun borderless(v: View) {
    val tv = TypedValue()
    if (context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true) && tv.resourceId != 0) {
      v.setBackgroundResource(tv.resourceId)
    } else {
      v.background = null
    }
  }

  private fun iconButton(res: Int, desc: String): ImageButton {
    val b = ImageButton(context)
    b.setImageResource(res)
    b.setColorFilter(Color.WHITE)
    b.scaleType = ImageView.ScaleType.CENTER
    b.contentDescription = desc
    borderless(b)
    return b
  }

  private fun pill(container: LinearLayout, iconRes: Int, text: TextView) {
    container.orientation = LinearLayout.HORIZONTAL
    container.gravity = Gravity.CENTER_VERTICAL
    container.setPadding(dp(12f), 0, dp(14f), 0)
    container.background = GradientDrawable().apply {
      cornerRadius = dp(18f).toFloat()
      setColor(Color.argb(115, 0, 0, 0))
    }
    val ic = ImageView(context)
    ic.setImageResource(iconRes)
    ic.setColorFilter(Color.WHITE)
    container.addView(ic, LinearLayout.LayoutParams(dp(16f), dp(16f)).apply { rightMargin = dp(6f) })
    text.setTextColor(Color.WHITE)
    text.textSize = 13f
    text.setTypeface(text.typeface, Typeface.BOLD)
    text.maxLines = 1
    text.ellipsize = TextUtils.TruncateAt.END
    container.addView(text, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
  }

  init {
    setBackgroundColor(Color.BLACK)
    val mp = FrameLayout.LayoutParams.MATCH_PARENT
    val wc = FrameLayout.LayoutParams.WRAP_CONTENT
    addView(media, FrameLayout.LayoutParams(mp, mp))
    textBg.visibility = View.GONE
    media.addView(textBg, FrameLayout.LayoutParams(mp, mp))
    textView.setTextColor(Color.WHITE)
    textView.gravity = Gravity.CENTER
    textView.visibility = View.GONE
    media.addView(textView, FrameLayout.LayoutParams(mp, wc, Gravity.CENTER).apply { leftMargin = dp(24f); rightMargin = dp(24f) })
    imageView.scaleType = ImageView.ScaleType.FIT_CENTER
    media.addView(imageView, FrameLayout.LayoutParams(mp, mp))
    textureView.visibility = View.GONE
    media.addView(textureView, FrameLayout.LayoutParams(mp, mp, Gravity.CENTER))
    spinner.isIndeterminate = true
    spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
    spinner.visibility = View.GONE
    media.addView(spinner, FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.CENTER))
    errorText.setTextColor(Color.argb(220, 255, 255, 255))
    errorText.textSize = 15f
    errorText.gravity = Gravity.CENTER
    errorText.visibility = View.GONE
    media.addView(errorText, FrameLayout.LayoutParams(mp, wc, Gravity.CENTER).apply { leftMargin = dp(32f); rightMargin = dp(32f) })

    voiceView.visibility = View.GONE
    media.addView(voiceView, FrameLayout.LayoutParams(mp, mp))

    addView(touchLayer, FrameLayout.LayoutParams(mp, mp))
    touchLayer.setOnTouchListener { _, ev -> onTouchLayer(ev) }
    // [v2] Blocos acima da camada de toque: só os interativos consomem.
    overlayLayer.onAction = { ov, info -> host?.onSticker(this, ov, info) }
    addView(overlayLayer, FrameLayout.LayoutParams(mp, mp))

    // Chrome
    addView(chrome, FrameLayout.LayoutParams(mp, mp))
    chrome.isClickable = false
    topScrim.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(Color.argb(128, 0, 0, 0), Color.TRANSPARENT))
    chrome.addView(topScrim, FrameLayout.LayoutParams(mp, dp(130f), Gravity.TOP))
    bottomScrim.background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(Color.argb(140, 0, 0, 0), Color.TRANSPARENT))
    chrome.addView(bottomScrim, FrameLayout.LayoutParams(mp, dp(200f), Gravity.BOTTOM))

    chrome.addView(bars, FrameLayout.LayoutParams(mp, max(2, dp(2.5f)), Gravity.TOP).apply { leftMargin = dp(8f); rightMargin = dp(8f) })

    header.orientation = LinearLayout.HORIZONTAL
    header.gravity = Gravity.CENTER_VERTICAL
    avatar.scaleType = ImageView.ScaleType.CENTER_CROP
    avatar.clipToOutline = true
    val avBg = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.rgb(64, 64, 64)); setStroke(dp(1f), Color.argb(230, 255, 255, 255)) }
    avatarBox.background = avBg
    avatar.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.TRANSPARENT) }
    avatarInitial.setTextColor(Color.WHITE)
    avatarInitial.textSize = 15f
    avatarInitial.setTypeface(avatarInitial.typeface, Typeface.BOLD)
    avatarInitial.gravity = Gravity.CENTER
    avatarBox.addView(avatarInitial, FrameLayout.LayoutParams(mp, mp))
    avatarBox.addView(avatar, FrameLayout.LayoutParams(mp, mp))
    header.addView(avatarBox, LinearLayout.LayoutParams(dp(36f), dp(36f)).apply { leftMargin = dp(12f) })
    nameView.setTextColor(Color.WHITE)
    nameView.textSize = 15f
    nameView.setTypeface(nameView.typeface, Typeface.BOLD)
    nameView.maxLines = 1
    nameView.ellipsize = TextUtils.TruncateAt.END
    nameView.setShadowLayer(3f, 0f, 1f, Color.argb(90, 0, 0, 0))
    header.addView(nameView, LinearLayout.LayoutParams(wc, wc).apply { leftMargin = dp(10f) })
    timeView.setTextColor(Color.argb(190, 255, 255, 255))
    timeView.textSize = 13f
    timeView.maxLines = 1
    header.addView(timeView, LinearLayout.LayoutParams(0, wc, 1f).apply { leftMargin = dp(8f) })
    muteBtn.setImageResource(R.drawable.sv_ic_volume_on)
    muteBtn.setColorFilter(Color.WHITE)
    muteBtn.scaleType = ImageView.ScaleType.CENTER
    borderless(muteBtn)
    muteBtn.setOnClickListener { host?.onTapMute(this) }
    header.addView(muteBtn, LinearLayout.LayoutParams(dp(42f), dp(42f)))
    menuBtn.setImageResource(R.drawable.sv_ic_more)
    menuBtn.setColorFilter(Color.WHITE)
    menuBtn.scaleType = ImageView.ScaleType.CENTER
    menuBtn.contentDescription = labels.get("more", "Mais")
    borderless(menuBtn)
    menuBtn.setOnClickListener { host?.onTapMenu(this, menuBtn) }
    header.addView(menuBtn, LinearLayout.LayoutParams(dp(42f), dp(42f)))
    val close = iconButton(R.drawable.mv_ic_close, labels.get("close", "Fechar"))
    close.setOnClickListener { host?.onTapClose(this) }
    header.addView(close, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { rightMargin = dp(4f) })
    chrome.addView(header, FrameLayout.LayoutParams(mp, dp(48f), Gravity.TOP))

    pauseIcon.setImageResource(R.drawable.mv_ic_pause)
    pauseIcon.setColorFilter(Color.WHITE)
    pauseIcon.alpha = 0f
    addView(pauseIcon, FrameLayout.LayoutParams(dp(16f), dp(16f), Gravity.TOP or Gravity.END).apply { rightMargin = dp(14f) })

    // Inferior
    bottom.orientation = LinearLayout.VERTICAL
    bottom.gravity = Gravity.CENTER_HORIZONTAL
    captionView.setTextColor(Color.WHITE)
    captionView.textSize = 15f
    captionView.gravity = Gravity.CENTER
    captionView.maxLines = 5
    captionView.ellipsize = TextUtils.TruncateAt.END
    captionView.setShadowLayer(4f, 0f, 1f, Color.argb(130, 0, 0, 0))
    bottom.addView(captionView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, wc).apply {
      leftMargin = dp(20f); rightMargin = dp(20f); bottomMargin = dp(10f)
    })
    pill(musicPill, R.drawable.sv_ic_music, musicText)
    bottom.addView(musicPill, LinearLayout.LayoutParams(wc, dp(30f)).apply { bottomMargin = dp(10f); leftMargin = dp(24f); rightMargin = dp(24f) })
    pill(linkPill, R.drawable.sv_ic_link, linkText)
    linkPill.isClickable = true
    linkPill.setOnClickListener {
      val u = currentItem?.linkUrl ?: ""
      if (u.isNotEmpty()) host?.onTapLink(this, u)
    }
    bottom.addView(linkPill, LinearLayout.LayoutParams(wc, dp(34f)).apply { bottomMargin = dp(12f); leftMargin = dp(24f); rightMargin = dp(24f) })
    pill(viewersPill, R.drawable.sv_ic_eye, viewersText)
    viewersPill.isClickable = true
    viewersPill.setOnClickListener { host?.onTapViewers(this) }
    bottom.addView(viewersPill, LinearLayout.LayoutParams(wc, dp(36f)).apply { bottomMargin = dp(8f) })

    replyRow.orientation = LinearLayout.HORIZONTAL
    replyRow.gravity = Gravity.CENTER_VERTICAL
    replyPill.setTextColor(Color.argb(230, 255, 255, 255))
    replyPill.textSize = 15f
    replyPill.maxLines = 1
    replyPill.ellipsize = TextUtils.TruncateAt.END
    replyPill.gravity = Gravity.CENTER_VERTICAL
    replyPill.setPadding(dp(18f), 0, dp(18f), 0)
    replyPill.background = GradientDrawable().apply {
      cornerRadius = dp(23f).toFloat()
      setColor(Color.TRANSPARENT)
      setStroke(dp(1f), Color.argb(140, 255, 255, 255))
    }
    replyPill.isClickable = true
    replyPill.setOnClickListener { host?.onTapReply(this) }
    replyRow.addView(replyPill, LinearLayout.LayoutParams(0, dp(46f), 1f))
    likeBtn.setImageResource(R.drawable.sv_ic_heart_outline)
    likeBtn.scaleType = ImageView.ScaleType.CENTER
    likeBtn.contentDescription = labels.get("like", "Curtir")
    borderless(likeBtn)
    likeBtn.setOnClickListener {
      likeBtn.animate().scaleX(1.3f).scaleY(1.3f).setDuration(110).withEndAction {
        likeBtn.animate().scaleX(1f).scaleY(1f).setDuration(160).start()
      }.start()
      host?.onTapLike(this)
    }
    replyRow.addView(likeBtn, LinearLayout.LayoutParams(dp(48f), dp(48f)).apply { leftMargin = dp(6f) })
    bottom.addView(replyRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(48f)).apply {
      leftMargin = dp(12f); rightMargin = dp(8f); bottomMargin = dp(4f)
    })
    chrome.addView(bottom, FrameLayout.LayoutParams(mp, wc, Gravity.BOTTOM))
    applyInsets(0, 0)
  }

  fun applyInsets(top: Int, bottomPx: Int) {
    topInset = max(top, dp(8f))
    bottomInset = max(bottomPx, dp(12f))
    (bars.layoutParams as FrameLayout.LayoutParams).topMargin = topInset + dp(6f)
    (header.layoutParams as FrameLayout.LayoutParams).topMargin = topInset + dp(14f)
    (pauseIcon.layoutParams as FrameLayout.LayoutParams).topMargin = topInset + dp(16f)
    (topScrim.layoutParams as FrameLayout.LayoutParams).height = topInset + dp(100f)
    (bottom.layoutParams as FrameLayout.LayoutParams).bottomMargin = bottomInset + dp(4f)
    requestLayout()
  }

  // ─── Toques: esquerda/direita, segurar ───────────────────────────────────

  private fun onTouchLayer(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = ev.x
        downY = ev.y
        downAt = SystemClock.uptimeMillis()
        holding = false
        removeCallbacks(holdRunnable)
        postDelayed(holdRunnable, 200)
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        if (!holding && (abs(ev.x - downX) > slop || abs(ev.y - downY) > slop)) removeCallbacks(holdRunnable)
      }
      MotionEvent.ACTION_UP -> {
        removeCallbacks(holdRunnable)
        if (holding) {
          holding = false
          host?.onPageHold(this, false)
        } else if (abs(ev.x - downX) <= slop && abs(ev.y - downY) <= slop && SystemClock.uptimeMillis() - downAt < 500) {
          host?.onPageTapAt(this, ev.x, ev.y)
        }
      }
      MotionEvent.ACTION_CANCEL -> {
        removeCallbacks(holdRunnable)
        if (holding) {
          holding = false
          host?.onPageHold(this, false)
        }
      }
    }
    return true
  }

  // ─── Bind ────────────────────────────────────────────────────────────────

  fun bind(g: SVGroup, pos: Int) {
    if (group === g && position == pos) return
    clearTargets()
    group = g
    position = pos
    nameView.text = g.ownerName
    val initial = (g.ownerName.ifEmpty { g.ownerEmail }).trim().firstOrNull()?.uppercaseChar()?.toString() ?: ""
    avatarInitial.text = initial
    avatar.setImageDrawable(null)
    MVItem.glideModel(g.avatar)?.let { model ->
      try {
        Glide.with(context.applicationContext).load(model).override(160, 160).circleCrop().into(avatar)
      } catch (_: Throwable) {}
    }
    replyPill.text = labels.get("replyTo", "Responder").replace("{name}", g.ownerName)
    replyRow.visibility = if (g.isSelf) View.GONE else View.VISIBLE
    viewersPill.visibility = if (g.isSelf) View.VISIBLE else View.GONE
    bars.setCount(g.items.size)
    active = false
    paused = false
    chrome.alpha = 1f
    pauseIcon.alpha = 0f
    showItem(g.index, false)
  }

  private fun clearTargets() {
    token += 1
    val gl = try { Glide.with(context.applicationContext) } catch (_: Throwable) { null }
    for (t in targets) { try { gl?.clear(t) } catch (_: Throwable) {} }
    targets.clear()
  }

  private fun request(model: Any, px: Int): RequestBuilder<Drawable> =
    Glide.with(context.applicationContext)
      .load(model)
      .override(px, px)
      .downsample(DownsampleStrategy.CENTER_INSIDE)
      .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)

  fun showItem(i: Int, autoplay: Boolean) {
    val g = group ?: return
    if (g.items.isEmpty()) return
    val idx = i.coerceIn(0, g.items.size - 1)
    host?.detachVideo(this)
    clearTargets()
    index = idx
    g.index = idx
    elapsedMs = 0.0
    ready = false
    failed = false
    bars.setCount(g.items.size)
    bars.set(idx, 0f)
    val it = g.items[idx]
    textAnimPlayed = false
    typeRevealed = if (it.textAnim == "typewriter") 0 else -1
    textView.animate().cancel()
    textView.alpha = 1f
    textView.scaleX = 1f
    textView.scaleY = 1f
    updateMenuButton()
    overlayLayer.render(it)
    voiceView.visibility = if (it.type == SVType.VOICE) View.VISIBLE else View.GONE
    timeView.text = it.timeLabel
    errorText.visibility = View.GONE
    spinner.visibility = View.GONE
    captionView.text = it.caption
    captionView.visibility = if (it.caption.isEmpty()) View.GONE else View.VISIBLE
    if (it.musicTitle.isNotEmpty()) {
      musicText.text = if (it.musicArtist.isEmpty()) it.musicTitle else "${it.musicTitle} — ${it.musicArtist}"
      musicPill.visibility = View.VISIBLE
    } else {
      musicPill.visibility = View.GONE
    }
    if (it.linkUrl.isNotEmpty()) {
      linkText.text = it.linkLabel.ifEmpty { it.linkUrl }
      linkPill.visibility = View.VISIBLE
    } else {
      linkPill.visibility = View.GONE
    }
    muteBtn.visibility = if (it.type == SVType.VIDEO || it.musicUrl.isNotEmpty()) View.VISIBLE else View.GONE
    setMuted(host?.isMuted() ?: false)
    refreshCounters()
    when (it.type) {
      SVType.VOICE -> {
        imageView.visibility = View.GONE
        imageView.setImageDrawable(null)
        textureView.visibility = View.GONE
        textView.visibility = View.GONE
        textBg.visibility = View.VISIBLE
        textBg.background = GradientDrawable().apply { setColor(it.bg) }
        captionView.visibility = View.GONE
        voiceView.configure(labels.get("voice", "Mensagem de voz"), it.caption)
        markReady()
      }
      SVType.TEXT -> {
        imageView.visibility = View.GONE
        imageView.setImageDrawable(null)
        textureView.visibility = View.GONE
        textBg.visibility = View.VISIBLE
        textView.visibility = View.VISIBLE
        textBg.background = if (it.bgColors.size >= 2) {
          GradientDrawable(GradientDrawable.Orientation.TL_BR, it.bgColors)
        } else {
          GradientDrawable().apply { setColor(it.bg) }
        }
        layoutText()
        markReady()
      }
      SVType.IMAGE -> {
        textBg.visibility = View.GONE
        textView.visibility = View.GONE
        textureView.visibility = View.GONE
        imageView.visibility = View.VISIBLE
        loadImage(it)
      }
      SVType.VIDEO -> {
        textBg.visibility = View.GONE
        textView.visibility = View.GONE
        imageView.visibility = View.VISIBLE
        imageView.setImageDrawable(null)
        textureView.visibility = View.VISIBLE
        textureView.alpha = 0f
        loadPoster(it)
        if (autoplay && active) host?.attachVideo(this, it)
      }
    }
    if (autoplay && active) playTextAnim()
  }

  private fun updateMenuButton() {
    val g = group ?: return
    val it = currentItem
    menuBtn.visibility = if (if (it == null) g.menu.isEmpty() else g.menu.none { e -> e.visible(it) }) View.GONE else View.VISIBLE
  }

  /** [v2] Entrada do texto (fade / bounce; typewriter no tick). */
  private fun playTextAnim() {
    val it = currentItem ?: return
    if (textAnimPlayed || it.type != SVType.TEXT) return
    textAnimPlayed = true
    when (it.textAnim) {
      "fade" -> { textView.alpha = 0f; textView.animate().alpha(1f).setDuration(600).start() }
      "bounce" -> {
        textView.scaleX = 0.5f; textView.scaleY = 0.5f
        textView.animate().scaleX(1f).scaleY(1f).setDuration(650).setInterpolator(android.view.animation.OvershootInterpolator(2.2f)).start()
      }
    }
  }

  /** [v2] Legenda traduzida / original vinda do JS. */
  fun refreshCaption() {
    val it = currentItem ?: return
    if (it.type == SVType.VOICE) {
      voiceView.configure(labels.get("voice", "Mensagem de voz"), it.caption)
    } else if (it.type != SVType.TEXT) {
      captionView.text = it.caption
      captionView.visibility = if (it.caption.isEmpty()) View.GONE else View.VISIBLE
    }
    updateMenuButton()
  }

  /** [v2] Progresso do áudio do status de voz (dialog → página). */
  fun audioProgress(positionMs: Long, durationMs: Long) {
    if (durationMs <= 0) return
    val f = min(1f, positionMs.toFloat() / durationMs)
    bars.set(index, f)
    voiceView.setProgress(f)
  }

  fun refreshCounters() {
    val g = group ?: return
    val it = currentItem ?: return
    if (g.isSelf) {
      viewersText.text = labels.views(it.viewsCount)
    } else {
      val liked = it.myReaction.isNotEmpty()
      if (liked) {
        likeBtn.setImageResource(R.drawable.sv_rx_heart)
        likeBtn.clearColorFilter()
      } else {
        likeBtn.setImageResource(R.drawable.sv_ic_heart_outline)
        likeBtn.setColorFilter(Color.WHITE)
      }
    }
  }

  fun setMuted(m: Boolean) {
    muteBtn.setImageResource(if (m) R.drawable.sv_ic_volume_off else R.drawable.sv_ic_volume_on)
    muteBtn.contentDescription = if (m) labels.get("soundOn", "Ativar som") else labels.get("soundOff", "Desativar som")
  }

  // ─── Texto (auto-ajuste medido) ──────────────────────────────────────────

  private fun typefaceFor(id: String): Typeface = when (id) {
    "serif" -> Typeface.create(Typeface.SERIF, Typeface.BOLD)
    "mono" -> Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
    "script" -> Typeface.create("cursive", Typeface.BOLD)
    "condensed" -> Typeface.create("sans-serif-condensed", Typeface.BOLD)
    else -> Typeface.DEFAULT_BOLD
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (currentItem?.type == SVType.TEXT) post { layoutText() }
  }

  private fun layoutText() {
    val it = currentItem ?: return
    if (it.type != SVType.TEXT) return
    val w = width
    val h = height
    if (w <= 0 || h <= 0) return
    val maxW = w - dp(48f)
    val maxH = (h * 0.7f).toInt()
    val tf = typefaceFor(it.font)
    val shown = if (it.font == "condensed") it.text.uppercase() else it.text
    val layoutAlign = when (it.textAlign) { "left" -> Layout.Alignment.ALIGN_NORMAL; "right" -> Layout.Alignment.ALIGN_OPPOSITE; else -> Layout.Alignment.ALIGN_CENTER }
    textView.gravity = when (it.textAlign) {
      "left" -> Gravity.START or Gravity.CENTER_VERTICAL
      "right" -> Gravity.END or Gravity.CENTER_VERTICAL
      else -> Gravity.CENTER
    }
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    paint.typeface = tf
    val dm = resources.displayMetrics
    fun heightFor(sp: Float): Int {
      paint.textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, dm)
      val l = StaticLayout.Builder.obtain(shown, 0, shown.length, paint, max(1, maxW))
        .setAlignment(layoutAlign)
        .setLineSpacing(0f, 1.12f)
        .setIncludePad(false)
        .build()
      return l.height
    }
    var lo = 14f
    var hi = 44f
    var best = 14f
    if (heightFor(hi) <= maxH) {
      best = hi
    } else {
      while (hi - lo > 0.5f) {
        val mid = (lo + hi) / 2
        if (heightFor(mid) <= maxH) { best = mid; lo = mid } else hi = mid
      }
    }
    textView.typeface = tf
    textView.setTextSize(TypedValue.COMPLEX_UNIT_SP, kotlin.math.floor(best))
    textView.setLineSpacing(0f, 1.12f)
    textView.includeFontPadding = false
    if (it.font == "condensed") textView.letterSpacing = -0.02f else textView.letterSpacing = 0f
    shownText = shown
    applyTypewriter()
  }

  private fun applyTypewriter() {
    val n = shownText.length
    if (typeRevealed in 0 until n) {
      // Revela por cor: layout final fixo (sem pular de linha).
      val sp = android.text.SpannableString(shownText)
      sp.setSpan(android.text.style.ForegroundColorSpan(Color.TRANSPARENT), typeRevealed, n, android.text.Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
      textView.text = sp
    } else {
      textView.text = shownText
    }
  }

  // ─── Mídia ───────────────────────────────────────────────────────────────

  private fun applyScale(dw: Int, dh: Int) {
    val vw = width.toFloat()
    val vh = height.toFloat()
    if (dw <= 0 || dh <= 0 || vw <= 0 || vh <= 0) {
      imageView.scaleType = ImageView.ScaleType.FIT_CENTER
      return
    }
    val ar = dw.toFloat() / dh
    val vr = vw / vh
    imageView.scaleType = if (abs(ar - vr) / vr < 0.18f) ImageView.ScaleType.CENTER_CROP else ImageView.ScaleType.FIT_CENTER
  }

  private fun loadImage(it: SVItem) {
    val t = token
    val sources = ArrayList<Any>()
    MVItem.glideModel(it.localUri)?.let { m -> sources.add(m) }
    MVItem.glideModel(it.uri)?.let { m -> if (sources.none { s -> s == m }) sources.add(m) }
    MVItem.glideModel(it.thumb)?.let { thumb ->
      val tt = object : CustomTarget<Drawable>() {
        override fun onResourceReady(resource: Drawable, transition: Transition<in Drawable>?) {
          if (token != t || ready) return
          applyScale(resource.intrinsicWidth, resource.intrinsicHeight)
          imageView.setImageDrawable(resource)
        }
        override fun onLoadCleared(placeholder: Drawable?) {}
      }
      targets.add(tt)
      request(thumb, MVPageView.THUMB_PX).into(tt)
    }
    postDelayed({ if (token == t && !ready && !failed) spinner.visibility = View.VISIBLE }, 350)
    loadFull(sources, 0, t)
  }

  private fun loadFull(sources: List<Any>, i: Int, t: Int) {
    if (i >= sources.size) {
      if (token == t && !ready) showError(labels.get("unavailable", "Mídia indisponível"))
      return
    }
    val target = object : CustomTarget<Drawable>() {
      override fun onResourceReady(resource: Drawable, transition: Transition<in Drawable>?) {
        if (token != t) return
        applyScale(resource.intrinsicWidth, resource.intrinsicHeight)
        imageView.setImageDrawable(resource)
        if (resource is android.graphics.drawable.Animatable) {
          try { resource.start() } catch (_: Throwable) {}
        }
        spinner.visibility = View.GONE
        markReady()
      }
      override fun onLoadFailed(errorDrawable: Drawable?) {
        if (token != t) return
        post { loadFull(sources, i + 1, t) }
      }
      override fun onLoadCleared(placeholder: Drawable?) {}
    }
    targets.add(target)
    request(sources[i], MVPageView.FULL_PX).into(target)
  }

  private fun loadPoster(it: SVItem) {
    val model = MVItem.glideModel(it.thumb) ?: return
    val t = token
    val target = object : CustomTarget<Drawable>() {
      override fun onResourceReady(resource: Drawable, transition: Transition<in Drawable>?) {
        if (token != t || ready) return
        applyScale(resource.intrinsicWidth, resource.intrinsicHeight)
        imageView.setImageDrawable(resource)
      }
      override fun onLoadCleared(placeholder: Drawable?) {}
    }
    targets.add(target)
    request(model, MVPageView.THUMB_PX * 2).into(target)
  }

  fun showError(msg: String) {
    failed = true
    spinner.visibility = View.GONE
    errorText.text = msg
    errorText.visibility = View.VISIBLE
  }

  fun setLoading(on: Boolean) {
    spinner.visibility = if (on && !ready && !failed) View.VISIBLE else View.GONE
  }

  /** Primeiro quadro do vídeo desenhado (dialog → página). */
  fun onVideoFirstFrame(vw: Int, vh: Int) {
    fitVideo(vw, vh)
    textureView.alpha = 1f
    imageView.visibility = View.GONE
    spinner.visibility = View.GONE
    markReady()
  }

  /** Ajuste do TextureView: preenche se o aspecto ~ tela, senão cabe inteiro. */
  fun fitVideo(vw: Int, vh: Int) {
    if (vw <= 0 || vh <= 0) return
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0 || h <= 0) { post { fitVideo(vw, vh) }; return }
    val aspect = vw.toFloat() / vh
    val fill = abs(aspect - w / h) / (w / h) < 0.18f
    var tw = w
    var th = w / aspect
    if (fill) {
      if (th < h) { th = h; tw = h * aspect }
    } else if (th > h) {
      th = h; tw = h * aspect
    }
    val lp = textureView.layoutParams as FrameLayout.LayoutParams
    lp.width = tw.toInt()
    lp.height = th.toInt()
    lp.gravity = Gravity.CENTER
    textureView.layoutParams = lp
  }

  fun resetVideo() {
    val lp = textureView.layoutParams as FrameLayout.LayoutParams
    lp.width = FrameLayout.LayoutParams.MATCH_PARENT
    lp.height = FrameLayout.LayoutParams.MATCH_PARENT
    textureView.layoutParams = lp
    textureView.alpha = 0f
    if (currentItem?.type == SVType.VIDEO) {
      imageView.visibility = View.VISIBLE
      ready = false
    }
  }

  private fun markReady() {
    if (ready) return
    ready = true
    spinner.visibility = View.GONE
    val it = currentItem ?: return
    if (active) {
      host?.onItemReady(this, it)
      nextItem()?.let { n -> host?.prefetch(n) }
    }
  }

  fun nextItem(): SVItem? {
    val g = group ?: return null
    val n = index + 1
    return if (n < g.items.size) g.items[n] else null
  }

  // ─── Ciclo ───────────────────────────────────────────────────────────────

  fun activate() {
    active = true
    paused = false
    val it = currentItem ?: return
    if (it.type == SVType.VIDEO) host?.attachVideo(this, it)
    playTextAnim()
    if (ready) {
      host?.onItemReady(this, it)
      nextItem()?.let { n -> host?.prefetch(n) }
    }
  }

  fun deactivate() {
    if (!active) return
    active = false
    host?.detachVideo(this)
    elapsedMs = 0.0
    bars.set(index, 0f)
    if (holding) { holding = false; removeCallbacks(holdRunnable) }
    chrome.alpha = 1f
    pauseIcon.alpha = 0f
  }

  fun setPaused(p: Boolean) {
    paused = p
  }

  fun setChromeHidden(hidden: Boolean) {
    chrome.animate().alpha(if (hidden) 0f else 1f).setDuration(180).start()
    pauseIcon.animate().alpha(if (hidden) 0.9f else 0f).setDuration(180).start()
  }

  /** Foto/texto (e vídeo com erro): avança pelo tempo. */
  fun tick(dtMs: Double) {
    if (!active) return
    val it = currentItem ?: return
    overlayLayer.tick()
    // Vídeo comum e voz com áudio: progresso pelo player (dialog). Boomerang: por tempo.
    if (it.type == SVType.VIDEO && !failed && !it.loop) return
    if (paused || (!ready && !failed)) return
    elapsedMs += dtMs
    if (it.type == SVType.VOICE && host?.voiceDriven(this, it) == true) return
    if (it.type == SVType.TEXT && typeRevealed >= 0) {
      val want = min(shownText.length, (elapsedMs * 0.028).toInt())
      if (want != typeRevealed) {
        typeRevealed = if (want >= shownText.length) -1 else want
        applyTypewriter()
      }
    }
    val total = if (failed) 4000.0 else it.durationMs.toDouble()
    val f = elapsedMs / max(500.0, total)
    bars.set(index, f.toFloat())
    if (f >= 1.0) host?.onItemFinished(this, it)
  }

  /** Vídeo: progresso pela posição real do player. */
  fun videoProgress(positionMs: Long, durationMs: Long) {
    if (currentItem?.loop == true) return
    if (durationMs > 0) bars.set(index, min(1f, positionMs.toFloat() / durationMs))
  }

  fun replaceItems(items: MutableList<SVItem>) {
    val g = group ?: return
    g.items = items
    bars.setCount(items.size)
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    removeCallbacks(holdRunnable)
  }
}
