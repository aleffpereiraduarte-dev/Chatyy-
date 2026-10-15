package expo.modules.chatyymediaviewer

import android.app.Activity
import android.app.Application
import android.app.Dialog
import android.content.res.ColorStateList
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.ExoPlayer
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.MarginPageTransformer
import androidx.viewpager2.widget.ViewPager2
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.resource.bitmap.DownsampleStrategy
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

data class MVFlags(
  val allowShare: Boolean = true,
  val allowSave: Boolean = true,
  val allowForward: Boolean = true,
  val allowStar: Boolean = true,
  // [2026-10-14 adv-privacy] Conversa com privacidade avançada / view-once:
  // FLAG_SECURE na janela do Dialog (o FLAG_SECURE da Activity NÃO cobre o
  // Dialog, que é outra janela) → print/gravação saem pretos.
  val secure: Boolean = false,
)

/**
 * [2026-10-14 native-viewer] Viewer de mídia em tela cheia (Dialog sobre a
 * Activity do RN — Alert/compartilhar do JS continuam aparecendo por cima).
 * ViewPager2 (12 dp entre páginas) + MVPageView (zoom Matrix / vídeo Media3,
 * um único ExoPlayer preso à página atual) + barras que somem no toque.
 */
class MediaViewerDialog(
  private val host: Activity,
  private val items: MutableList<MVItem>,
  startIndex: Int,
  private val labels: Map<String, String>,
  private val flags: MVFlags,
  private val listener: Listener,
) : Dialog(host, android.R.style.Theme_Translucent_NoTitleBar), MVPageView.Host {

  interface Listener {
    fun onIndexChange(index: Int)
    fun onAction(action: String, index: Int, extra: Map<String, Any?>)
    fun onClose(index: Int, reason: String)
  }

  private var current = startIndex.coerceIn(0, max(0, items.size - 1))
  private var chromeVisible = true
  private var closed = false
  private var faded = false

  private lateinit var root: FrameLayout
  private lateinit var backdrop: View
  private lateinit var pager: ViewPager2
  private lateinit var topBar: LinearLayout
  private lateinit var bottomBar: LinearLayout
  private lateinit var titleView: TextView
  private lateinit var subtitleView: TextView
  private lateinit var counterView: TextView
  private lateinit var captionView: TextView
  private lateinit var videoBar: LinearLayout
  private lateinit var seek: SeekBar
  private lateinit var timeView: TextView
  private lateinit var durView: TextView
  private lateinit var barPlay: ImageButton
  private val actionButtons = HashMap<String, ImageButton>()
  private val actionSpinners = HashMap<String, ProgressBar>()
  private val actionResets = HashMap<String, Runnable>()

  private var player: ExoPlayer? = null
  private var playerPage: MVPageView? = null
  private val handler = Handler(Looper.getMainLooper())
  private var scrubbing = false
  private var wasPlaying = false
  private var settleRetries = 0

  // [2026-10-15 hero] Transição bolha ↔ viewer: a foto sai do frame da
  // miniatura (coordenadas do RN: dp, relativas à área visível da janela —
  // RootViewUtil.getViewportOffset) e volta à bolha da página atual ao fechar.
  private var heroSource: RectF? = null
  private var heroSourceRadius = 0f
  private val returnRects = HashMap<Int, RectF>()
  private val returnRadii = HashMap<Int, Float>()
  private var heroView: MVHeroView? = null
  private var heroAnim: ValueAnimator? = null
  private var heroPolls = 0

  /** Antes do show(). rect/radius em dp do RN. */
  fun setHeroSource(rect: RectF, radiusDp: Float) {
    heroSource = RectF(rect)
    heroSourceRadius = max(0f, radiusDp)
    returnRects[current] = RectF(rect)
    returnRadii[current] = max(0f, radiusDp)
  }

  fun setReturnRect(index: Int, rect: RectF?, radiusDp: Float) {
    if (rect != null) {
      returnRects[index] = RectF(rect)
      returnRadii[index] = max(0f, radiusDp)
    } else {
      returnRects.remove(index)
      returnRadii.remove(index)
    }
  }

  private val progressLoop = object : Runnable {
    override fun run() {
      updateProgress()
      handler.postDelayed(this, 250)
    }
  }

  private val lifecycleCb = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityResumed(activity: Activity) {}
    override fun onActivityPaused(activity: Activity) {
      if (activity === host) player?.playWhenReady = false
    }
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {
      if (activity === host) finish("destroyed", false)
    }
  }

  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, context.resources.displayMetrics).toInt()

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    buildUi()
    setContentView(root)
    setupWindow()
    setCancelable(true)
    setCanceledOnTouchOutside(false)
    try { host.application.registerActivityLifecycleCallbacks(lifecycleCb) } catch (_: Throwable) {}
  }

  override fun onStart() {
    super.onStart()
    window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    if (!faded) {
      faded = true
      if (heroSource != null) {
        // Hero: tudo invisível até a foto sair da bolha (que segue visível atrás).
        backdrop.alpha = 0f
        pager.alpha = 0f
        topBar.alpha = 0f
        bottomBar.alpha = 0f
        root.post { runHeroOpen() }
      } else {
        root.alpha = 0f
        root.animate().alpha(1f).setDuration(180).start()
      }
    }
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    finish("back", true)
  }

  override fun dismiss() {
    if (!closed) finish("dismiss", false) else realDismiss()
  }

  private fun realDismiss() {
    try { super.dismiss() } catch (_: Throwable) {}
  }

  private fun setupWindow() {
    val w = window ?: return
    w.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
    w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
    // [2026-10-15 screen-protect-all] app inteiro protegido (hub) + secure local da conversa.
    ScreenProtectBridge.protect(w, flags.secure)
    w.setWindowAnimations(0)
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
    ctl.isAppearanceLightNavigationBars = false
  }

  // ─── UI ──────────────────────────────────────────────────────────────────

  private fun borderlessBg(v: View) {
    val tv = TypedValue()
    if (context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true) && tv.resourceId != 0) {
      v.setBackgroundResource(tv.resourceId)
    } else {
      v.background = null
    }
  }

  private fun iconButton(res: Int, desc: String?): ImageButton {
    val b = ImageButton(context)
    b.setImageResource(res)
    b.setColorFilter(Color.WHITE)
    b.scaleType = android.widget.ImageView.ScaleType.CENTER
    b.contentDescription = desc
    borderlessBg(b)
    return b
  }

  private fun label(size: Float, bold: Boolean, alpha: Int = 255): TextView {
    val t = TextView(context)
    t.setTextColor(Color.argb(alpha, 255, 255, 255))
    t.textSize = size
    if (bold) t.paint.isFakeBoldText = true
    t.maxLines = 1
    t.ellipsize = TextUtils.TruncateAt.END
    return t
  }

  private fun buildUi() {
    root = FrameLayout(context)
    root.setBackgroundColor(Color.TRANSPARENT)
    root.clipChildren = false

    backdrop = View(context)
    backdrop.setBackgroundColor(Color.BLACK)
    root.addView(backdrop, FrameLayout.LayoutParams(-1, -1))

    pager = ViewPager2(context)
    pager.offscreenPageLimit = 1
    pager.setPageTransformer(MarginPageTransformer(dp(12f)))
    pager.adapter = PageAdapter()
    (pager.getChildAt(0) as? RecyclerView)?.let { rv ->
      rv.overScrollMode = View.OVER_SCROLL_NEVER
      rv.clipChildren = false
    }
    root.addView(pager, FrameLayout.LayoutParams(-1, -1))
    if (current > 0) pager.setCurrentItem(current, false)
    pager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
      override fun onPageSelected(position: Int) {
        if (closed || position == current || position < 0 || position >= items.size) return
        current = position
        updateChrome()
        detachPlayer()
        listener.onIndexChange(position)
      }

      override fun onPageScrollStateChanged(state: Int) {
        if (state == ViewPager2.SCROLL_STATE_IDLE) settle()
      }
    })

    // Top bar
    topBar = LinearLayout(context)
    topBar.orientation = LinearLayout.HORIZONTAL
    topBar.gravity = Gravity.CENTER_VERTICAL
    topBar.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(Color.argb(160, 0, 0, 0), Color.TRANSPARENT))
    val close = iconButton(R.drawable.mv_ic_close, labels["close"])
    close.setOnClickListener { finish("close", true) }
    topBar.addView(close, LinearLayout.LayoutParams(dp(48f), dp(48f)))
    val titles = LinearLayout(context)
    titles.orientation = LinearLayout.VERTICAL
    titleView = label(16f, true)
    subtitleView = label(12f, false, 190)
    titles.addView(titleView)
    titles.addView(subtitleView)
    topBar.addView(titles, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(6f) })
    counterView = label(15f, true)
    topBar.addView(counterView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(8f) })
    root.addView(topBar, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))

    // Bottom bar: legenda + barra de vídeo + ações
    bottomBar = LinearLayout(context)
    bottomBar.orientation = LinearLayout.VERTICAL
    bottomBar.background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(Color.argb(160, 0, 0, 0), Color.TRANSPARENT))

    captionView = TextView(context)
    captionView.setTextColor(Color.WHITE)
    captionView.textSize = 15f
    captionView.maxLines = 4
    captionView.ellipsize = TextUtils.TruncateAt.END
    captionView.setOnClickListener {
      captionView.maxLines = if (captionView.maxLines == 4) 14 else 4
    }
    bottomBar.addView(captionView, LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8f) })

    videoBar = LinearLayout(context)
    videoBar.orientation = LinearLayout.HORIZONTAL
    videoBar.gravity = Gravity.CENTER_VERTICAL
    barPlay = iconButton(R.drawable.mv_ic_play, labels["play"])
    barPlay.setOnClickListener { playerPage?.let { togglePlay(it) } ?: currentPage()?.let { togglePlay(it) } }
    videoBar.addView(barPlay, LinearLayout.LayoutParams(dp(40f), dp(40f)))
    timeView = label(12f, false)
    timeView.text = "0:00"
    videoBar.addView(timeView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(4f) })
    seek = SeekBar(context)
    seek.max = 1000
    seek.progressTintList = ColorStateList.valueOf(Color.WHITE)
    seek.thumbTintList = ColorStateList.valueOf(Color.WHITE)
    seek.progressBackgroundTintList = ColorStateList.valueOf(Color.argb(90, 255, 255, 255))
    seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
      override fun onStartTrackingTouch(sb: SeekBar) {
        val p = player ?: return
        scrubbing = true
        wasPlaying = p.playWhenReady
        p.playWhenReady = false
      }

      override fun onProgressChanged(sb: SeekBar, progress: Int, fromUser: Boolean) {
        if (!fromUser) return
        val p = player ?: return
        val dur = p.duration
        if (dur == C.TIME_UNSET || dur <= 0) return
        val pos = dur * progress / 1000L
        p.seekTo(pos)
        timeView.text = fmt(pos)
      }

      override fun onStopTrackingTouch(sb: SeekBar) {
        scrubbing = false
        if (wasPlaying) player?.playWhenReady = true
      }
    })
    videoBar.addView(seek, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    durView = label(12f, false)
    durView.text = "0:00"
    videoBar.addView(durView)
    bottomBar.addView(videoBar, LinearLayout.LayoutParams(-1, dp(40f)))

    val actions = LinearLayout(context)
    actions.orientation = LinearLayout.HORIZONTAL
    val acts = ArrayList<String>()
    if (flags.allowShare) acts.add("share")
    if (flags.allowSave) acts.add("save")
    if (flags.allowForward) acts.add("forward")
    if (flags.allowStar) acts.add("star")
    for (a in acts) {
      val cell = FrameLayout(context)
      val b = iconButton(iconFor(a), labels[a])
      b.setOnClickListener { onActionTap(a) }
      cell.addView(b, FrameLayout.LayoutParams(dp(48f), dp(48f), Gravity.CENTER))
      val sp = ProgressBar(context)
      sp.isIndeterminate = true
      sp.indeterminateTintList = ColorStateList.valueOf(Color.WHITE)
      sp.visibility = View.GONE
      cell.addView(sp, FrameLayout.LayoutParams(dp(24f), dp(24f), Gravity.CENTER))
      actionButtons[a] = b
      actionSpinners[a] = sp
      actions.addView(cell, LinearLayout.LayoutParams(0, dp(48f), 1f))
    }
    actions.visibility = if (acts.isEmpty()) View.GONE else View.VISIBLE
    bottomBar.addView(actions, LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT))
    root.addView(bottomBar, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))

    ViewCompat.setOnApplyWindowInsetsListener(root) { _, ins ->
      val bars = ins.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      topBar.setPadding(dp(4f) + bars.left, bars.top + dp(4f), dp(16f) + bars.right, dp(22f))
      bottomBar.setPadding(dp(16f) + bars.left, dp(28f), dp(16f) + bars.right, bars.bottom + dp(4f))
      ins
    }

    updateChrome()
    pager.post { settle() }
  }

  private fun iconFor(a: String): Int = when (a) {
    "share" -> R.drawable.mv_ic_share
    "save" -> R.drawable.mv_ic_save
    "forward" -> R.drawable.mv_ic_forward
    "star" -> if (current in items.indices && items[current].starred) R.drawable.mv_ic_star else R.drawable.mv_ic_star_border
    "done" -> R.drawable.mv_ic_check
    else -> R.drawable.mv_ic_close
  }

  private fun updateChrome() {
    if (current !in items.indices) return
    val it = items[current]
    titleView.text = it.senderName
    titleView.visibility = if (it.senderName.isEmpty()) View.GONE else View.VISIBLE
    subtitleView.text = it.dateLabel
    subtitleView.visibility = if (it.dateLabel.isEmpty()) View.GONE else View.VISIBLE
    counterView.text = if (items.size > 1) "${current + 1} / ${items.size}" else ""
    captionView.text = it.caption
    captionView.maxLines = 4
    captionView.visibility = if (it.caption.isEmpty()) View.GONE else View.VISIBLE
    videoBar.visibility = if (it.isVideo) View.VISIBLE else View.GONE
    actionButtons["star"]?.let { b ->
      if (actionSpinners["star"]?.visibility != View.VISIBLE) b.setImageResource(iconFor("star"))
      b.contentDescription = if (it.starred) (labels["unstar"] ?: labels["star"]) else labels["star"]
    }
    for ((a, r) in actionResets) {
      handler.removeCallbacks(r)
      restoreAction(a)
    }
    actionResets.clear()
    seek.progress = 0
    timeView.text = "0:00"
    durView.text = "0:00"
    barPlay.setImageResource(R.drawable.mv_ic_play)
  }

  private fun setChrome(visible: Boolean) {
    chromeVisible = visible
    for (bar in arrayOf<View>(topBar, bottomBar)) {
      bar.animate().cancel()
      if (visible) {
        bar.visibility = View.VISIBLE
        bar.animate().alpha(1f).setDuration(180).start()
      } else {
        // INVISIBLE no fim: barra escondida não pode engolir o toque que a traz de volta.
        bar.animate().alpha(0f).setDuration(180).withEndAction {
          if (!chromeVisible) bar.visibility = View.INVISIBLE
        }.start()
      }
    }
    val w = window ?: return
    val ctl = WindowInsetsControllerCompat(w, w.decorView)
    if (visible) {
      ctl.show(WindowInsetsCompat.Type.systemBars())
    } else {
      ctl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      ctl.hide(WindowInsetsCompat.Type.systemBars())
    }
  }

  // ─── Ações ───────────────────────────────────────────────────────────────

  private fun onActionTap(a: String) {
    if (closed || !chromeVisible) return
    val idx = current
    when (a) {
      "forward" -> finish("forward", true) { listener.onAction("forward", idx, emptyMap()) }
      "star" -> {
        if (idx !in items.indices) return
        items[idx].starred = !items[idx].starred
        val starred = items[idx].starred
        actionButtons["star"]?.let { b ->
          b.setImageResource(iconFor("star"))
          b.contentDescription = if (starred) (labels["unstar"] ?: labels["star"]) else labels["star"]
        }
        listener.onAction("star", idx, mapOf("starred" to starred))
      }
      else -> listener.onAction(a, idx, emptyMap())
    }
  }

  fun setActionState(action: String, state: String) {
    val b = actionButtons[action] ?: return
    val sp = actionSpinners[action] ?: return
    actionResets.remove(action)?.let { handler.removeCallbacks(it) }
    when (state) {
      "busy" -> {
        b.isEnabled = false
        b.visibility = View.INVISIBLE
        sp.visibility = View.VISIBLE
      }
      "done" -> {
        sp.visibility = View.GONE
        b.visibility = View.VISIBLE
        b.isEnabled = true
        b.setImageResource(R.drawable.mv_ic_check)
        val r = Runnable {
          restoreAction(action)
          actionResets.remove(action)
        }
        actionResets[action] = r
        handler.postDelayed(r, 1600)
      }
      else -> restoreAction(action)
    }
  }

  private fun restoreAction(action: String) {
    val b = actionButtons[action] ?: return
    actionSpinners[action]?.visibility = View.GONE
    b.visibility = View.VISIBLE
    b.isEnabled = true
    b.setImageResource(iconFor(action))
  }

  // ─── Fechar ──────────────────────────────────────────────────────────────

  fun closeFromJS() = finish("js", true)

  fun closeSilently() = finish("replaced", false)

  private fun teardownForClose() {
    handler.removeCallbacksAndMessages(null)
    heroAnim?.cancel()
    heroAnim = null
    detachPlayer()
    try { player?.release() } catch (_: Throwable) {}
    player = null
    try { host.application.unregisterActivityLifecycleCallbacks(lifecycleCb) } catch (_: Throwable) {}
  }

  private fun finish(reason: String, animate: Boolean, then: (() -> Unit)? = null) {
    if (closed) return
    if (animate && startHeroClose(reason, then)) return
    closed = true
    teardownForClose()
    val idx = current
    val done = {
      realDismiss()
      try { then?.invoke() } catch (_: Throwable) {}
      listener.onClose(idx, reason)
    }
    if (animate && this::root.isInitialized && root.isAttachedToWindow) {
      root.animate().alpha(0f).setDuration(160).withEndAction { done() }.start()
    } else {
      done()
    }
  }

  // ─── Páginas ─────────────────────────────────────────────────────────────

  private class Holder(val page: MVPageView) : RecyclerView.ViewHolder(page)

  private inner class PageAdapter : RecyclerView.Adapter<Holder>() {
    override fun getItemCount(): Int = items.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
      val v = MVPageView(context, labels)
      v.host = this@MediaViewerDialog
      return Holder(v)
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
      if (holder.page === playerPage) detachPlayer()
      holder.page.bind(items[position], position)
    }

    override fun onViewRecycled(holder: Holder) {
      if (holder.page === playerPage) detachPlayer()
      holder.page.recycle()
    }
  }

  private fun recycler(): RecyclerView? = pager.getChildAt(0) as? RecyclerView

  private fun currentPage(): MVPageView? {
    val rv = recycler() ?: return null
    return (rv.findViewHolderForAdapterPosition(current) as? Holder)?.page
  }

  /** Página assentada: vídeo toca, vizinhas voltam a 1×, pré-carrega vizinhas. */
  private fun settle() {
    if (closed) return
    val page = currentPage()
    if (page == null) {
      if (settleRetries++ < 10) pager.postDelayed({ settle() }, 50)
      return
    }
    settleRetries = 0
    recycler()?.let { rv ->
      for (i in 0 until rv.childCount) {
        val h = rv.getChildViewHolder(rv.getChildAt(i)) as? Holder ?: continue
        if (h.page !== page) {
          h.page.zoomView.resetZoom()
          h.page.resetTransform()
        }
      }
    }
    val it = items[current]
    if (it.isVideo) {
      if (playerPage !== page && !page.isErrorShown()) attachPlayer(page)
    } else {
      detachPlayer()
    }
    prefetchNeighbors()
  }

  private fun prefetchNeighbors() {
    val g = Glide.with(context.applicationContext)
    for (j in intArrayOf(current + 1, current - 1, current + 2)) {
      if (j !in items.indices) continue
      val it = items[j]
      val model = if (it.isVideo) MVItem.glideModel(it.thumbUri) else (MVItem.glideModel(it.localUri) ?: MVItem.glideModel(it.uri))
      model ?: continue
      val px = if (it.isVideo) MVPageView.THUMB_PX * 2 else MVPageView.FULL_PX
      try {
        g.load(model).override(px, px).downsample(DownsampleStrategy.CENTER_INSIDE)
          .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC).preload()
      } catch (_: Throwable) {}
    }
  }

  // ─── Vídeo ───────────────────────────────────────────────────────────────

  private val playerListener = object : Player.Listener {
    override fun onRenderedFirstFrame() {
      playerPage?.posterView?.visibility = View.GONE
      playerPage?.setLoading(false)
    }

    override fun onVideoSizeChanged(videoSize: VideoSize) {
      playerPage?.fitVideo(videoSize.width, videoSize.height, videoSize.pixelWidthHeightRatio)
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
      val p = player ?: return
      when (playbackState) {
        Player.STATE_BUFFERING -> playerPage?.setLoading(true)
        Player.STATE_READY -> playerPage?.setLoading(false)
        Player.STATE_ENDED -> {
          p.playWhenReady = false
          p.seekTo(0)
        }
        else -> {}
      }
      updatePlayUi()
      updateProgress()
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      updatePlayUi()
    }

    override fun onPlayerError(error: PlaybackException) {
      playerPage?.showError()
    }
  }

  private fun ensurePlayer(): ExoPlayer {
    player?.let { return it }
    val attrs = AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
      .build()
    val p = ExoPlayer.Builder(context).setAudioAttributes(attrs, true).build()
    p.addListener(playerListener)
    player = p
    return p
  }

  private fun videoUri(it: MVItem): Uri? {
    MVItem.existingFile(it.localUri)?.let { f -> return Uri.fromFile(f) }
    MVItem.existingFile(it.uri)?.let { f -> return Uri.fromFile(f) }
    if (it.uri.startsWith("http://") || it.uri.startsWith("https://") || it.uri.startsWith("content://")) return Uri.parse(it.uri)
    return null
  }

  private fun attachPlayer(page: MVPageView) {
    val it = page.item ?: return
    if (!it.isVideo) return
    detachPlayer()
    val uri = videoUri(it)
    if (uri == null) {
      page.showError()
      return
    }
    val p = ensurePlayer()
    p.setVideoTextureView(page.textureView)
    val b = MediaItem.Builder().setUri(uri.toString())
    if (uri.toString().lowercase().contains(".m3u8")) b.setMimeType("application/x-mpegURL")
    p.setMediaItem(b.build())
    p.prepare()
    p.playWhenReady = true
    playerPage = page
    page.hideError()
    page.setLoading(true)
    page.bigPlay.visibility = View.GONE
    handler.removeCallbacks(progressLoop)
    handler.post(progressLoop)
  }

  private fun detachPlayer() {
    handler.removeCallbacks(progressLoop)
    val page = playerPage ?: return
    playerPage = null
    val p = player
    if (p != null) {
      p.playWhenReady = false
      try { p.stop() } catch (_: Throwable) {}
      try { p.clearVideoTextureView(page.textureView) } catch (_: Throwable) {}
    }
    page.resetVideoLayout()
    page.setLoading(false)
    if (page.item?.isVideo == true && !page.isErrorShown()) page.bigPlay.visibility = View.VISIBLE
    barPlay.setImageResource(R.drawable.mv_ic_play)
  }

  private fun togglePlay(page: MVPageView) {
    if (page.item?.isVideo != true) return
    val p = player
    if (p == null || playerPage !== page) {
      attachPlayer(page)
      return
    }
    if (p.playWhenReady && p.playbackState != Player.STATE_ENDED) {
      p.playWhenReady = false
    } else {
      if (p.playbackState == Player.STATE_ENDED) p.seekTo(0)
      if (p.playbackState == Player.STATE_IDLE) p.prepare()
      p.playWhenReady = true
    }
    updatePlayUi()
  }

  private fun updatePlayUi() {
    val p = player
    val page = playerPage
    val playing = p != null && p.playWhenReady && p.playbackState != Player.STATE_ENDED
    barPlay.setImageResource(if (playing) R.drawable.mv_ic_pause else R.drawable.mv_ic_play)
    barPlay.contentDescription = if (playing) labels["pause"] else labels["play"]
    if (page != null && !page.isErrorShown()) page.bigPlay.visibility = if (playing) View.GONE else View.VISIBLE
  }

  private fun updateProgress() {
    val p = player ?: return
    if (scrubbing || playerPage == null) return
    val dur = p.duration
    val pos = p.currentPosition
    if (dur != C.TIME_UNSET && dur > 0) {
      seek.progress = ((pos * 1000L) / dur).toInt().coerceIn(0, 1000)
      durView.text = fmt(dur)
    }
    timeView.text = fmt(max(0L, pos))
  }

  private fun fmt(ms: Long): String {
    val s = (ms / 1000L).toInt()
    return if (s >= 3600) String.format(java.util.Locale.US, "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
    else String.format(java.util.Locale.US, "%d:%02d", s / 60, s % 60)
  }

  // ─── MVPageView.Host ─────────────────────────────────────────────────────

  override fun onPageTap() {
    if (closed) return
    setChrome(!chromeVisible)
  }

  override fun onPageDoubleTapVideo(page: MVPageView) {
    togglePlay(page)
  }

  override fun onPlayTap(page: MVPageView) {
    togglePlay(page)
  }

  override fun onRetry(page: MVPageView) {
    val pos = page.position
    if (pos !in items.indices) return
    page.bind(items[pos], pos)
    if (pos == current && items[pos].isVideo) attachPlayer(page)
  }

  override fun onDismissDrag(page: MVPageView, dx: Float, dy: Float) {
    if (closed) return
    val h = max(1, root.height).toFloat()
    val p = min(1f, abs(dy) / (h * 0.35f))
    val s = 1f - 0.22f * p
    page.content.translationX = dx
    page.content.translationY = dy
    page.content.scaleX = s
    page.content.scaleY = s
    backdrop.alpha = 1f - 0.9f * p
    val ca = if (chromeVisible) max(0f, 1f - p * 3f) else 0f
    topBar.alpha = ca
    bottomBar.alpha = ca
  }

  override fun onDismissRelease(page: MVPageView, dx: Float, dy: Float, vy: Float) {
    if (closed) return
    val sameDir = (dy >= 0f) == (vy >= 0f) || abs(vy) < dp(250f)
    val shouldClose = sameDir && (abs(dy) > dp(110f) || abs(vy) > dp(900f))
    if (shouldClose && startHeroClose("swipe", null)) return
    if (shouldClose) {
      val h = max(1, root.height).toFloat()
      val dir = if ((if (abs(dy) > dp(4f)) dy else vy) >= 0f) 1f else -1f
      player?.playWhenReady = false
      page.content.animate()
        .translationY(dir * h)
        .scaleX(0.78f).scaleY(0.78f)
        .setDuration(200)
        .setInterpolator(DecelerateInterpolator())
        .start()
      topBar.animate().alpha(0f).setDuration(160).start()
      bottomBar.animate().alpha(0f).setDuration(160).start()
      backdrop.animate().alpha(0f).setDuration(200).withEndAction { finish("swipe", false) }.start()
    } else {
      page.content.animate()
        .translationX(0f).translationY(0f).scaleX(1f).scaleY(1f)
        .setDuration(220)
        .setInterpolator(DecelerateInterpolator())
        .start()
      backdrop.animate().alpha(1f).setDuration(220).start()
      val a = if (chromeVisible) 1f else 0f
      topBar.animate().alpha(a).setDuration(220).start()
      bottomBar.animate().alpha(a).setDuration(220).start()
    }
  }
  // ─── Hero (bolha ↔ viewer) ───────────────────────────────────────────────

  /** rect do RN (dp, relativo à área visível da janela da Activity) → px em `root`. */
  private fun rnToLocal(r: RectF): RectF {
    val d = context.resources.displayMetrics.density
    val vis = Rect()
    try { host.window?.decorView?.getWindowVisibleDisplayFrame(vis) } catch (_: Throwable) {}
    val rl = IntArray(2)
    try { root.getLocationOnScreen(rl) } catch (_: Throwable) {}
    val ox = vis.left - rl[0]
    val oy = vis.top - rl[1]
    return RectF(r.left * d + ox, r.top * d + oy, r.right * d + ox, r.bottom * d + oy)
  }

  private fun pageDrawable(page: MVPageView?): Drawable? {
    val p = page ?: return null
    val it = p.item ?: return null
    return if (it.isVideo) p.posterView.drawable else p.zoomView.drawable
  }

  /** Cópia (mesmo bitmap) — os bounds do original pertencem ao ImageView. */
  private fun copyDrawable(d: Drawable?): Drawable? {
    if (d == null || d.intrinsicWidth <= 0 || d.intrinsicHeight <= 0) return null
    return try { d.constantState?.newDrawable(context.resources)?.mutate() } catch (_: Throwable) { null }
  }

  private fun fitRect(cw: Float, ch: Float, nw: Float, nh: Float): RectF {
    if (cw <= 0f || ch <= 0f || nw <= 0f || nh <= 0f) return RectF(0f, 0f, cw, ch)
    val s = min(cw / nw, ch / nh)
    val w = nw * s
    val h = nh * s
    return RectF((cw - w) / 2f, (ch - h) / 2f, (cw + w) / 2f, (ch + h) / 2f)
  }

  /** Frame visível da mídia da página em coordenadas de `root` (zoom + arrasto). */
  private fun pageMediaRect(page: MVPageView, d: Drawable): RectF? {
    val it = page.item ?: return null
    val c = page.content
    if (c.width <= 0 || c.height <= 0) return null
    val r: RectF
    if (!it.isVideo) {
      val z = page.zoomView
      r = RectF(0f, 0f, d.intrinsicWidth.toFloat(), d.intrinsicHeight.toFloat())
      z.imageMatrix.mapRect(r)
      r.offset((z.left + z.paddingLeft).toFloat(), (z.top + z.paddingTop).toFloat())
    } else {
      val tv = page.textureView
      val lp = tv.layoutParams
      r = if (tv.visibility == View.VISIBLE && lp != null && lp.width > 0 && lp.height > 0 && tv.width > 0) {
        RectF(tv.left.toFloat(), tv.top.toFloat(), tv.right.toFloat(), tv.bottom.toFloat())
      } else {
        val nw = if (it.width > 0 && it.height > 0) it.width.toFloat() else d.intrinsicWidth.toFloat()
        val nh = if (it.width > 0 && it.height > 0) it.height.toFloat() else d.intrinsicHeight.toFloat()
        fitRect(c.width.toFloat(), c.height.toFloat(), nw, nh)
      }
    }
    // content-local → page-local (translação/escala do arrasto de fechar)
    c.matrix.mapRect(r)
    r.offset(c.left.toFloat(), c.top.toFloat())
    val pl = IntArray(2)
    val rl = IntArray(2)
    page.getLocationOnScreen(pl)
    root.getLocationOnScreen(rl)
    r.offset((pl[0] - rl[0]).toFloat(), (pl[1] - rl[1]).toFloat())
    return r
  }

  private fun runHeroOpen() {
    if (closed) return
    val d = copyDrawable(pageDrawable(currentPage()))
    if (d != null) {
      animateHeroIn(d)
      return
    }
    // Miniatura ainda decodificando (Glide): espera até ~300 ms.
    if (heroPolls++ < 10) {
      root.postDelayed({ runHeroOpen() }, 30)
      return
    }
    fadeInPlain()
  }

  private fun fadeInPlain() {
    if (closed) return
    backdrop.animate().alpha(1f).setDuration(180).start()
    pager.animate().alpha(1f).setDuration(180).start()
    val a = if (chromeVisible) 1f else 0f
    topBar.animate().alpha(a).setDuration(180).start()
    bottomBar.animate().alpha(a).setDuration(180).start()
  }

  private fun addHeroView(d: Drawable): MVHeroView {
    heroView?.let { old -> try { root.removeView(old) } catch (_: Throwable) {} }
    val hv = MVHeroView(context)
    hv.image = d
    hv.isClickable = true // engole toques durante a animação
    root.addView(hv, root.indexOfChild(pager) + 1, FrameLayout.LayoutParams(-1, -1))
    heroView = hv
    return hv
  }

  private fun animateHeroIn(d: Drawable) {
    val src = heroSource
    if (closed || src == null || root.width <= 0 || root.height <= 0) { fadeInPlain(); return }
    val start = rnToLocal(src)
    val it = items.getOrNull(current)
    val nw = if (it != null && it.width > 0 && it.height > 0) it.width.toFloat() else d.intrinsicWidth.toFloat()
    val nh = if (it != null && it.width > 0 && it.height > 0) it.height.toFloat() else d.intrinsicHeight.toFloat()
    val pr = currentPage()?.let { p -> IntArray(2).also { a -> p.getLocationOnScreen(a) } }
    val rl = IntArray(2).also { a -> root.getLocationOnScreen(a) }
    val cw = (currentPage()?.content?.width ?: root.width).toFloat().let { w -> if (w > 0f) w else root.width.toFloat() }
    val ch = (currentPage()?.content?.height ?: root.height).toFloat().let { h -> if (h > 0f) h else root.height.toFloat() }
    val target = fitRect(cw, ch, nw, nh)
    if (pr != null) target.offset((pr[0] - rl[0]).toFloat(), (pr[1] - rl[1]).toFloat())
    val r0 = heroSourceRadius * context.resources.displayMetrics.density
    val hv = addHeroView(d)
    hv.set(start, r0)
    pager.alpha = 0f
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 340
    a.interpolator = PathInterpolator(0.2f, 0.9f, 0.25f, 1f)
    a.addUpdateListener { va ->
      val f = va.animatedValue as Float
      hv.lerp(start, target, f, r0 * (1f - f))
      backdrop.alpha = min(1f, f * 1.4f)
    }
    a.addListener(object : android.animation.AnimatorListenerAdapter() {
      private var cancelled = false
      override fun onAnimationCancel(animation: android.animation.Animator) { cancelled = true }
      override fun onAnimationEnd(animation: android.animation.Animator) {
        if (cancelled || closed) return
        backdrop.alpha = 1f
        pager.alpha = 1f
        if (heroView === hv) { root.removeView(hv); heroView = null }
      }
    })
    heroAnim = a
    a.start()
    // (sem setStartDelay: o ViewPropertyAnimator guardaria o atraso p/ o setChrome)
    root.postDelayed({
      if (!closed) {
        val ca = if (chromeVisible) 1f else 0f
        topBar.animate().alpha(ca).setDuration(200).start()
        bottomBar.animate().alpha(ca).setDuration(200).start()
      }
    }, 140)
  }

  /** Fecha encolhendo até a bolha; false = sem destino/imagem → fechamento normal. */
  private fun startHeroClose(reason: String, then: (() -> Unit)?): Boolean {
    if (closed || !this::root.isInitialized || !root.isAttachedToWindow) return false
    val ret = returnRects[current] ?: return false
    val page = currentPage() ?: return false
    val orig = pageDrawable(page) ?: return false
    val d = copyDrawable(orig) ?: return false
    val start = pageMediaRect(page, orig) ?: return false
    val target = rnToLocal(ret)
    if (target.width() < 2f || target.height() < 2f) return false
    if (!RectF.intersects(target, RectF(0f, 0f, root.width.toFloat(), root.height.toFloat()))) return false
    closed = true
    teardownForClose()
    val idx = current
    val r1 = (returnRadii[current] ?: 0f) * context.resources.displayMetrics.density
    val hv = addHeroView(d)
    hv.set(start, 0f)
    pager.alpha = 0f
    page.resetTransform()
    val b0 = backdrop.alpha
    val t0 = topBar.alpha
    val bt0 = bottomBar.alpha
    topBar.animate().cancel()
    bottomBar.animate().cancel()
    backdrop.animate().cancel()
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 300
    a.interpolator = PathInterpolator(0.25f, 0.8f, 0.25f, 1f)
    a.addUpdateListener { va ->
      val f = va.animatedValue as Float
      hv.lerp(start, target, f, r1 * f)
      backdrop.alpha = b0 * (1f - f)
      topBar.alpha = t0 * max(0f, 1f - f * 2f)
      bottomBar.alpha = bt0 * max(0f, 1f - f * 2f)
    }
    a.addListener(object : android.animation.AnimatorListenerAdapter() {
      private var ended = false
      override fun onAnimationEnd(animation: android.animation.Animator) {
        if (ended) return
        ended = true
        realDismiss()
        try { then?.invoke() } catch (_: Throwable) {}
        listener.onClose(idx, reason)
      }
    })
    a.start()
    return true
  }
}

/**
 * [2026-10-15 hero] Desenha a mídia em `rect` com center-crop e cantos
 * arredondados — interpola do recorte da bolha (cover) ao fit da tela.
 */
class MVHeroView(context: Context) : View(context) {
  var image: Drawable? = null
  private val rect = RectF()
  private var radius = 0f
  private val path = Path()
  private val bounds = Rect()

  fun set(r: RectF, rad: Float) {
    rect.set(r)
    radius = rad
    invalidate()
  }

  fun lerp(a: RectF, b: RectF, f: Float, rad: Float) {
    rect.set(
      a.left + (b.left - a.left) * f,
      a.top + (b.top - a.top) * f,
      a.right + (b.right - a.right) * f,
      a.bottom + (b.bottom - a.bottom) * f,
    )
    radius = rad
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val d = image ?: return
    val w = rect.width()
    val h = rect.height()
    if (w < 1f || h < 1f) return
    val iw = d.intrinsicWidth.toFloat()
    val ih = d.intrinsicHeight.toFloat()
    canvas.save()
    if (radius > 0.5f) {
      path.reset()
      path.addRoundRect(rect, radius, radius, Path.Direction.CW)
      canvas.clipPath(path)
    } else {
      canvas.clipRect(rect)
    }
    if (iw > 0f && ih > 0f) {
      val s = max(w / iw, h / ih)
      val dw = iw * s
      val dh = ih * s
      bounds.set(
        (rect.centerX() - dw / 2f).toInt(),
        (rect.centerY() - dh / 2f).toInt(),
        (rect.centerX() + dw / 2f).toInt() + 1,
        (rect.centerY() + dh / 2f).toInt() + 1,
      )
    } else {
      rect.roundOut(bounds)
    }
    d.bounds = bounds
    d.draw(canvas)
    canvas.restore()
  }
}

