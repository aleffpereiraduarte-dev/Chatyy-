package expo.modules.chatyymediaviewer

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.Application
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.text.TextUtils
import android.util.TypedValue
import android.view.Choreographer
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.HapticFeedbackConstants
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
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.ScrollView
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
import androidx.viewpager2.widget.ViewPager2
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.resource.bitmap.DownsampleStrategy
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * [2026-10-15 native-story] Visualizador de STATUS nativo (Android): Dialog
 * tela cheia sobre a Activity do RN + ViewPager2 entre PESSOAS (cubo 3D via
 * PageTransformer) + SVGroupPage por pessoa. Um ExoPlayer principal preso à
 * página atual + um de pré-buffer (próximo vídeo). Relógio = Choreographer.
 * Gestos: toque esquerda/direita, segurar pausa (some a UI), arrastar p/ baixo
 * fecha (fundo acompanha), p/ cima abre "visto por" (próprio) ou resposta.
 */
@SuppressLint("ViewConstructor")
class StoryViewerDialog(
  private val host: Activity,
  private val groups: MutableList<SVGroup>,
  startGroup: Int,
  private val labels: SVLabels,
  private val reactions: List<SVReaction>,
  private val cube: Boolean,
  private var hasMoreNext: Boolean,
  private var hasMorePrev: Boolean,
  private val listener: Listener,
) : Dialog(host, android.R.style.Theme_Translucent_NoTitleBar), SVGroupPage.Host {

  interface Listener {
    fun emit(name: String, body: Map<String, Any?>)
    fun onFinished()
  }

  private var currentGroup = startGroup.coerceIn(0, max(0, groups.size - 1))
  private var closed = false
  private var muted = false
  private val pauseReasons = HashSet<String>()
  private val shownIds = HashSet<String>()
  private val handler = Handler(Looper.getMainLooper())

  private lateinit var root: RootLayout
  private lateinit var backdrop: View
  private lateinit var stage: FrameLayout
  private lateinit var pager: ViewPager2
  private lateinit var adapter: PageAdapter

  // Composer
  private lateinit var composer: FrameLayout
  private lateinit var composerReactions: LinearLayout
  private lateinit var composerBar: LinearLayout
  private lateinit var field: EditText
  private var composerOpen = false
  /** [v2] Composer respondendo a figurinha de PERGUNTA (null = resposta DM). */
  private var composerQuestion: SVOverlay? = null

  // [v2] Duplo toque = curtir (zona central).
  private var lastTapAt = 0L
  private var pendingTap: Runnable? = null
  private var musicEnded = false

  // Folha "Visualizações"
  private lateinit var sheet: FrameLayout
  private lateinit var sheetDim: View
  private lateinit var sheetPanel: LinearLayout
  private lateinit var sheetTitle: TextView
  private lateinit var sheetList: LinearLayout
  private lateinit var sheetScroll: ScrollView
  private lateinit var sheetSpinner: ProgressBar
  private lateinit var sheetEmpty: TextView
  private var sheetOpen = false
  private var sheetItemId = ""
  private var sheetRows: List<Map<String, Any?>> = emptyList()
  private val viewersCache = HashMap<String, List<Map<String, Any?>>>()

  private lateinit var toast: TextView
  private val toastHide = Runnable { if (::toast.isInitialized) toast.animate().alpha(0f).setDuration(220).start() }

  private var topInset = 0
  private var bottomInset = 0
  private var imeBottom = 0

  // Vídeo
  private var player: ExoPlayer? = null
  private var videoPage: SVGroupPage? = null
  private var videoItemId: String? = null
  private var preload: ExoPlayer? = null
  private var preloadId: String? = null
  private var music: ExoPlayer? = null
  private var musicItemId: String? = null

  // onNeedMore
  private var pendingMore: String? = null
  private var pendingMoreCloses = false
  private val pendingMoreTimeout = Runnable { resolveMore(false) }

  private var started = false
  private var lastFrameNs = 0L
  private val frameCb = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      if (closed) return
      val dt = if (lastFrameNs == 0L) 0.0 else min(100.0, (frameTimeNanos - lastFrameNs) / 1_000_000.0)
      lastFrameNs = frameTimeNanos
      if (pauseReasons.isEmpty()) {
        val pg = currentPage()
        if (pg != null) {
          pg.tick(dt)
          val p = player
          if (p != null && videoPage === pg) pg.videoProgress(p.currentPosition, p.duration)
          val it = pg.currentItem
          val m = music
          if (it != null && it.type == SVType.VOICE && m != null && musicItemId == it.id) {
            val dur = m.duration
            if (dur > 0 && dur != C.TIME_UNSET) pg.audioProgress(m.currentPosition, dur)
            if (musicEnded) { musicEnded = false; onItemFinished(pg, it) }
          }
        }
      }
      Choreographer.getInstance().postFrameCallback(this)
    }
  }

  private val lifecycleCb = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityResumed(activity: Activity) {
      if (activity === host) removePause("background")
    }
    override fun onActivityPaused(activity: Activity) {
      if (activity === host) addPause("background")
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
    if (!started && !closed) {
      started = true
      stage.alpha = 0f
      stage.scaleX = 0.94f
      stage.scaleY = 0.94f
      stage.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(220).start()
      Choreographer.getInstance().postFrameCallback(frameCb)
    }
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    when {
      composerOpen -> closeComposer()
      sheetOpen -> closeSheet()
      else -> finish("back", true)
    }
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
    ctl.isAppearanceLightNavigationBars = false
    ctl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    ctl.hide(WindowInsetsCompat.Type.statusBars())
  }

  // ─── UI ──────────────────────────────────────────────────────────────────

  private fun borderless(v: View) {
    val tv = TypedValue()
    if (context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true) && tv.resourceId != 0) {
      v.setBackgroundResource(tv.resourceId)
    } else {
      v.background = null
    }
  }

  private fun buildUi() {
    val mp = FrameLayout.LayoutParams.MATCH_PARENT
    val wc = FrameLayout.LayoutParams.WRAP_CONTENT
    root = RootLayout(context)
    root.setBackgroundColor(Color.TRANSPARENT)

    backdrop = View(context)
    backdrop.setBackgroundColor(Color.BLACK)
    root.addView(backdrop, FrameLayout.LayoutParams(mp, mp))

    stage = FrameLayout(context)
    stage.setBackgroundColor(Color.BLACK)
    stage.clipToOutline = true
    root.addView(stage, FrameLayout.LayoutParams(mp, mp))

    pager = ViewPager2(context)
    pager.offscreenPageLimit = 1
    adapter = PageAdapter()
    pager.adapter = adapter
    (pager.getChildAt(0) as? RecyclerView)?.let { rv ->
      rv.overScrollMode = View.OVER_SCROLL_NEVER
      rv.setItemViewCacheSize(0)
    }
    val density = context.resources.displayMetrics.density
    pager.setPageTransformer { page, position ->
      if (!cube) {
        page.rotationY = 0f
        return@setPageTransformer
      }
      val p = position.coerceIn(-1f, 1f)
      page.cameraDistance = 9000f * density
      page.pivotX = if (p < 0f) page.width.toFloat() else 0f
      page.pivotY = page.height * 0.5f
      page.rotationY = 90f * p
    }
    stage.addView(pager, FrameLayout.LayoutParams(mp, mp))
    if (currentGroup > 0) pager.setCurrentItem(currentGroup, false)
    pager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
      override fun onPageSelected(position: Int) {
        if (closed || position == currentGroup || position < 0 || position >= groups.size) return
        val old = currentPage()
        old?.deactivate()
        currentGroup = position
        root.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        val pg = currentPage()
        if (pg != null) {
          pg.setChromeHidden(false)
          pg.activate()
        }
        applyPause()
        val g = groups[position]
        listener.emit("onGroupChange", mapOf("groupIndex" to position, "ownerEmail" to g.ownerEmail, "key" to g.key))
        prefetchGroup(position + 1)
        prefetchGroup(position - 1)
        syncMusic()
      }

      override fun onPageScrollStateChanged(state: Int) {
        if (state == ViewPager2.SCROLL_STATE_IDLE) removePause("drag") else addPause("drag")
      }
    })

    buildComposer()
    buildSheet()

    toast = TextView(context)
    toast.setTextColor(Color.WHITE)
    toast.textSize = 14f
    toast.setTypeface(toast.typeface, Typeface.BOLD)
    toast.gravity = Gravity.CENTER
    toast.setPadding(dp(18f), dp(9f), dp(18f), dp(9f))
    toast.background = GradientDrawable().apply { cornerRadius = dp(18f).toFloat(); setColor(Color.argb(235, 31, 31, 31)) }
    toast.alpha = 0f
    root.addView(toast, FrameLayout.LayoutParams(wc, wc, Gravity.CENTER).apply { bottomMargin = dp(80f) })

    ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
      val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      topInset = max(sys.top, insets.getInsets(WindowInsetsCompat.Type.displayCutout()).top)
      bottomInset = sys.bottom
      imeBottom = ime.bottom
      forEachPage { it.applyInsets(topInset, bottomInset) }
      layoutComposer()
      layoutSheet()
      insets
    }
  }

  private fun forEachPage(fn: (SVGroupPage) -> Unit) {
    val rv = pager.getChildAt(0) as? RecyclerView ?: return
    for (i in 0 until rv.childCount) {
      (rv.getChildAt(i) as? SVGroupPage)?.let(fn)
    }
  }

  private fun pageAt(pos: Int): SVGroupPage? {
    val rv = pager.getChildAt(0) as? RecyclerView ?: return null
    return rv.findViewHolderForAdapterPosition(pos)?.itemView as? SVGroupPage
  }

  private fun currentPage(): SVGroupPage? = pageAt(currentGroup)

  inner class PageVH(val page: SVGroupPage) : RecyclerView.ViewHolder(page)

  inner class PageAdapter : RecyclerView.Adapter<PageVH>() {
    override fun getItemCount(): Int = groups.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): PageVH {
      val p = SVGroupPage(context, labels)
      p.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.MATCH_PARENT)
      p.host = this@StoryViewerDialog
      return PageVH(p)
    }

    override fun onBindViewHolder(holder: PageVH, position: Int) {
      val page = holder.page
      if (page.active) page.deactivate()
      page.bind(groups[position], position)
      page.applyInsets(topInset, bottomInset)
      if (position == currentGroup && !closed) {
        page.post {
          if (!closed && pageAt(currentGroup) === page && !page.active) {
            page.activate()
            applyPause()
            syncMusic()
          }
        }
      }
    }

    override fun onViewRecycled(holder: PageVH) {
      holder.page.deactivate()
    }
  }

  // ─── Toque global (arrasto vertical / bordas) ────────────────────────────

  inner class RootLayout(ctx: Context) : FrameLayout(ctx) {
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var startGroup = 0
    private var vDrag = false
    private var tracker: VelocityTracker? = null

    private fun canVertical(): Boolean = !composerOpen && !sheetOpen && !closed && pendingMore == null

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = ev.rawX
          downY = ev.rawY
          startGroup = currentGroup
        }
        MotionEvent.ACTION_UP -> {
          // Bordas: arrastar além da última/primeira pessoa pede mais ao JS.
          val dx = ev.rawX - downX
          val dy = ev.rawY - downY
          if (!vDrag && canVertical() && abs(dx) > width * 0.18f && abs(dx) > abs(dy) && currentGroup == startGroup) {
            if (dx < 0 && currentGroup == groups.size - 1 && hasMoreNext) requestMore("next", false)
            else if (dx > 0 && currentGroup == 0 && hasMorePrev) requestMore("prev", false)
          }
        }
      }
      return super.dispatchTouchEvent(ev)
    }

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          vDrag = false
          tracker?.recycle()
          tracker = VelocityTracker.obtain()
          tracker?.addMovement(ev)
        }
        MotionEvent.ACTION_MOVE -> {
          tracker?.addMovement(ev)
          if (!vDrag && canVertical() && pager.scrollState == ViewPager2.SCROLL_STATE_IDLE) {
            val dx = ev.rawX - downX
            val dy = ev.rawY - downY
            if (abs(dy) > slop && abs(dy) > abs(dx) * 1.2f) {
              vDrag = true
              addPause("dismiss")
              return true
            }
          }
        }
      }
      return false
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(ev: MotionEvent): Boolean {
      if (!vDrag) return false
      tracker?.addMovement(ev)
      val dy = ev.rawY - downY
      val dx = ev.rawX - downX
      val h = max(1, height).toFloat()
      when (ev.actionMasked) {
        MotionEvent.ACTION_MOVE -> {
          if (dy >= 0) {
            val p = min(1f, dy / h)
            val s = 1f - p * 0.18f
            stage.translationY = dy
            stage.translationX = dx * 0.35f
            stage.scaleX = s
            stage.scaleY = s
            backdrop.alpha = 1f - p * 1.3f
          } else {
            stage.translationY = dy * 0.25f
            stage.translationX = 0f
          }
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          tracker?.computeCurrentVelocity(1000)
          val vy = tracker?.yVelocity ?: 0f
          tracker?.recycle()
          tracker = null
          vDrag = false
          val up = ev.actionMasked == MotionEvent.ACTION_UP
          if (up && dy > 0 && (dy > dp(130f) || vy > dp(900f))) {
            dismissBySwipe()
            return true
          }
          val openUp = up && dy < 0 && (dy < -dp(60f) || vy < -dp(650f))
          stage.animate().translationX(0f).translationY(0f).scaleX(1f).scaleY(1f).setDuration(220).start()
          backdrop.animate().alpha(1f).setDuration(220).start()
          removePause("dismiss")
          if (openUp) {
            if (groups.getOrNull(currentGroup)?.isSelf == true) openViewers() else openComposer()
          }
        }
      }
      return true
    }
  }

  private fun dismissBySwipe() {
    val h = root.height.toFloat()
    stage.animate().translationY(stage.translationY + h * 0.6f).alpha(0f).setDuration(200).start()
    backdrop.animate().alpha(0f).setDuration(200).withEndAction { finish("swipe", false) }.start()
  }

  // ─── Navegação ───────────────────────────────────────────────────────────

  private fun goNext() {
    if (closed) return
    val pg = currentPage() ?: return
    val g = pg.group ?: return
    if (pg.index < g.items.size - 1) {
      pg.showItem(pg.index + 1, true)
      applyPause()
      syncMusic()
      return
    }
    if (currentGroup < groups.size - 1) {
      pager.setCurrentItem(currentGroup + 1, true)
      return
    }
    if (hasMoreNext) {
      requestMore("next", true)
      return
    }
    finish("end", true)
  }

  private fun goPrev() {
    if (closed) return
    val pg = currentPage() ?: return
    if (pg.index > 0) {
      pg.showItem(pg.index - 1, true)
      applyPause()
      syncMusic()
      return
    }
    if (currentGroup > 0) {
      pager.setCurrentItem(currentGroup - 1, true)
      return
    }
    if (hasMorePrev) {
      requestMore("prev", false)
      return
    }
    pg.showItem(0, true)
    applyPause()
    syncMusic()
  }

  private fun requestMore(dir: String, closeOnFail: Boolean) {
    if (pendingMore != null) return
    pendingMore = dir
    pendingMoreCloses = closeOnFail
    addPause("more")
    listener.emit("onNeedMore", mapOf("direction" to dir, "groupIndex" to currentGroup, "ownerEmail" to (groups.getOrNull(currentGroup)?.ownerEmail ?: "")))
    handler.removeCallbacks(pendingMoreTimeout)
    handler.postDelayed(pendingMoreTimeout, 2500)
  }

  private fun resolveMore(appended: Boolean) {
    if (pendingMore == null) return
    val closes = pendingMoreCloses
    pendingMore = null
    handler.removeCallbacks(pendingMoreTimeout)
    removePause("more")
    if (!appended && closes) finish("end", true)
  }

  private fun prefetchGroup(i: Int) {
    val g = groups.getOrNull(i) ?: return
    g.items.getOrNull(g.index)?.let { prefetch(it) }
  }

  // ─── Pausa ───────────────────────────────────────────────────────────────

  private fun addPause(r: String) {
    pauseReasons.add(r)
    applyPause()
  }

  private fun removePause(r: String) {
    pauseReasons.remove(r)
    applyPause()
  }

  private fun applyPause() {
    val paused = pauseReasons.isNotEmpty()
    val pg = currentPage()
    pg?.setPaused(paused)
    player?.let { p -> if (videoPage != null) p.playWhenReady = !paused }
    music?.let { m -> m.playWhenReady = !paused }
    // Vídeo terminou enquanto pausado (menu/teclado…) → avança ao retomar.
    val p = player
    if (!paused && pg != null && p != null && videoPage === pg && p.playbackState == Player.STATE_ENDED) {
      val it = pg.currentItem
      if (it != null && it.id == videoItemId) handler.post { if (videoPage === pg && pg.currentItem?.id == it.id) onItemFinished(pg, it) }
    }
  }

  // ─── SVGroupPage.Host ────────────────────────────────────────────────────

  override fun onPageTap(page: SVGroupPage, x: Float) {
    if (closed || pendingMore != null || page !== currentPage()) return
    if (x < page.width * 0.3f) goPrev() else goNext()
  }

  override fun onPageTapAt(page: SVGroupPage, x: Float, y: Float) {
    if (closed || pendingMore != null || page !== currentPage()) return
    val w = page.width
    pendingTap?.let { handler.removeCallbacks(it) }
    if (x < w * 0.3f) { pendingTap = null; goPrev(); return }
    val canLike = page.group?.isSelf == false
    if (!canLike || x > w * 0.72f) { pendingTap = null; goNext(); return }
    val now = android.os.SystemClock.uptimeMillis()
    if (pendingTap != null && now - lastTapAt < 280) {
      pendingTap = null
      lastTapAt = 0L
      doubleTapLike(page, x, y)
      return
    }
    lastTapAt = now
    val r = Runnable {
      pendingTap = null
      if (!closed && pendingMore == null && page === currentPage()) goNext()
    }
    pendingTap = r
    handler.postDelayed(r, 260)
  }

  private fun doubleTapLike(page: SVGroupPage, x: Float, y: Float) {
    val item = page.currentItem ?: return
    if (page.group?.isSelf != false) return
    val heart = reactions.firstOrNull { it.kind == "heart" }?.emoji ?: "❤️"
    page.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    burst("heart", x, y)
    if (item.myReaction == heart) return // duplo toque nunca descurte
    item.myReaction = heart
    page.refreshCounters()
    listener.emit("onReact", mapOf("id" to item.id, "ownerEmail" to (page.group?.ownerEmail ?: ""), "emoji" to heart, "active" to true))
  }

  override fun voiceDriven(page: SVGroupPage, item: SVItem): Boolean {
    val m = music ?: return false
    if (musicItemId != item.id) return false
    return m.playerError == null && m.duration > 0 && m.duration != C.TIME_UNSET
  }

  override fun onSticker(page: SVGroupPage, overlay: SVOverlay, info: Map<String, Any?>) {
    if (closed || page !== currentPage()) return
    val item = page.currentItem ?: return
    val kind = (info["kind"] as? String) ?: overlay.kind
    if (kind == "question") { openComposer(overlay); return }
    val body = HashMap<String, Any?>()
    body["id"] = item.id
    body["ownerEmail"] = page.group?.ownerEmail ?: ""
    body["kind"] = kind
    body["stickerId"] = overlay.id
    for ((k, v) in info) if (k != "kind") body[k] = v
    listener.emit("onSticker", body)
  }

  override fun onPageHold(page: SVGroupPage, start: Boolean) {
    if (page !== currentPage()) return
    if (start) {
      page.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      addPause("hold")
      page.setChromeHidden(true)
    } else if (pauseReasons.contains("hold")) {
      removePause("hold")
      page.setChromeHidden(false)
    }
  }

  override fun onItemReady(page: SVGroupPage, item: SVItem) {
    if (closed || page !== currentPage()) return
    item.viewed = true
    if (shownIds.add(item.id)) {
      val g = page.group
      listener.emit("onItemShown", mapOf(
        "id" to item.id,
        "ownerEmail" to (g?.ownerEmail ?: ""),
        "groupIndex" to currentGroup,
        "itemIndex" to page.index,
        "isSelf" to (g?.isSelf ?: false),
      ))
    }
    syncMusic()
  }

  override fun onItemFinished(page: SVGroupPage, item: SVItem) {
    if (closed || page !== currentPage() || pauseReasons.isNotEmpty()) return
    listener.emit("onItemCompleted", mapOf("id" to item.id, "ownerEmail" to (page.group?.ownerEmail ?: "")))
    goNext()
  }

  override fun onTapClose(page: SVGroupPage) {
    finish("close", true)
  }

  override fun onTapMenu(page: SVGroupPage, anchor: View) {
    val g = page.group ?: return
    val item = page.currentItem ?: return
    val entries = g.menu.filter { it.visible(item) }
    if (entries.isEmpty()) return
    addPause("menu")
    val pm = PopupMenu(ContextThemeWrapper(host, android.R.style.Theme_DeviceDefault), anchor)
    entries.forEachIndexed { i, e -> pm.menu.add(0, i, i, e.title(item)) }
    var picked = false
    pm.setOnMenuItemClickListener { mi ->
      picked = true
      val e = entries.getOrNull(mi.itemId)
      if (e == null) {
        removePause("menu")
      } else if (e.confirm.isNotEmpty()) {
        try {
          AlertDialog.Builder(host, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setMessage(e.confirm)
            .setNegativeButton(labels.get("cancel", "Cancelar")) { _, _ -> removePause("menu") }
            .setPositiveButton(e.label) { _, _ ->
              removePause("menu")
              listener.emit("onMenu", mapOf("id" to item.id, "action" to e.id, "ownerEmail" to g.ownerEmail))
            }
            .setOnCancelListener { removePause("menu") }
            .show()
        } catch (_: Throwable) {
          removePause("menu")
        }
      } else {
        removePause("menu")
        listener.emit("onMenu", mapOf("id" to item.id, "action" to e.id, "ownerEmail" to g.ownerEmail))
      }
      true
    }
    pm.setOnDismissListener { if (!picked) removePause("menu") }
    try { pm.show() } catch (_: Throwable) { removePause("menu") }
  }

  override fun onTapReply(page: SVGroupPage) {
    openComposer()
  }

  override fun onTapLike(page: SVGroupPage) {
    val item = page.currentItem ?: return
    val heart = reactions.firstOrNull { it.kind == "heart" }?.emoji ?: "❤️"
    page.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    if (item.myReaction == heart) {
      item.myReaction = ""
    } else {
      item.myReaction = heart
      burst("heart")
    }
    page.refreshCounters()
    listener.emit("onReact", mapOf("id" to item.id, "ownerEmail" to (page.group?.ownerEmail ?: ""), "emoji" to heart, "active" to item.myReaction.isNotEmpty()))
  }

  override fun onTapViewers(page: SVGroupPage) {
    openViewers()
  }

  override fun onTapLink(page: SVGroupPage, url: String) {
    listener.emit("onLink", mapOf("url" to url, "id" to (page.currentItem?.id ?: "")))
    if (!(url.startsWith("https://") || url.startsWith("http://"))) return
    try {
      val i = android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url))
      host.startActivity(i)
    } catch (_: Throwable) {}
  }

  override fun onTapMute(page: SVGroupPage) {
    muted = !muted
    forEachPage { it.setMuted(muted) }
    player?.volume = if (muted) 0f else 1f
    music?.volume = if (muted) 0f else 1f
    page.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
  }

  override fun isMuted(): Boolean = muted

  // ─── Vídeo (ExoPlayer) ───────────────────────────────────────────────────

  private fun makePlayer(): ExoPlayer {
    val attrs = AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
      .build()
    val p = ExoPlayer.Builder(context).setAudioAttributes(attrs, true).build()
    p.addListener(object : Player.Listener {
      override fun onRenderedFirstFrame() {
        if (p !== player) return
        val vs = p.videoSize
        videoPage?.onVideoFirstFrame(vs.width, vs.height)
      }

      override fun onVideoSizeChanged(videoSize: VideoSize) {
        if (p !== player) return
        videoPage?.fitVideo(videoSize.width, videoSize.height)
      }

      override fun onPlaybackStateChanged(playbackState: Int) {
        if (p !== player) return
        val pg = videoPage ?: return
        when (playbackState) {
          Player.STATE_BUFFERING -> pg.setLoading(true)
          Player.STATE_READY -> pg.setLoading(false)
          Player.STATE_ENDED -> {
            val it = pg.currentItem
            if (it != null && it.id == videoItemId) onItemFinished(pg, it)
          }
          else -> {}
        }
      }

      override fun onPlayerError(error: PlaybackException) {
        if (p !== player) return
        videoPage?.showError(labels.get("videoUnavailable", "Vídeo indisponível"))
      }
    })
    return p
  }

  private fun videoUri(it: SVItem): Uri? {
    MVItem.existingFile(it.localUri)?.let { f -> return Uri.fromFile(f) }
    MVItem.existingFile(it.uri)?.let { f -> return Uri.fromFile(f) }
    if (it.uri.startsWith("http://") || it.uri.startsWith("https://") || it.uri.startsWith("content://")) return Uri.parse(it.uri)
    return null
  }

  private fun mediaItem(uri: Uri): MediaItem {
    val b = MediaItem.Builder().setUri(uri.toString())
    if (uri.toString().lowercase().contains(".m3u8")) b.setMimeType("application/x-mpegURL")
    return b.build()
  }

  override fun attachVideo(page: SVGroupPage, item: SVItem) {
    if (closed) return
    if (videoPage === page && videoItemId == item.id && player != null) {
      applyPause()
      return
    }
    detachVideoFrom(videoPage)
    val uri = videoUri(item)
    if (uri == null) {
      page.showError(labels.get("videoUnavailable", "Vídeo indisponível"))
      return
    }
    val pre = preload
    val p: ExoPlayer
    if (pre != null && preloadId == item.id) {
      // Pré-buffer vira o player principal.
      preload = null
      preloadId = null
      try { player?.release() } catch (_: Throwable) {}
      player = pre
      p = pre
    } else {
      p = player ?: makePlayer().also { player = it }
      p.setMediaItem(mediaItem(uri))
      p.prepare()
    }
    p.volume = if (muted) 0f else 1f
    // Boomerang: repete; o fim vem do relógio da página (duration).
    p.repeatMode = if (item.loop) Player.REPEAT_MODE_ALL else Player.REPEAT_MODE_OFF
    videoPage = page
    videoItemId = item.id
    p.setVideoTextureView(page.textureView)
    if (p.playbackState == Player.STATE_IDLE) p.prepare()
    if (p.playbackState == Player.STATE_ENDED) p.seekTo(0)
    page.setLoading(true)
    // Pré-buffer já tinha o 1º quadro: o callback não repete.
    if (p.playbackState == Player.STATE_READY && p.videoSize.width > 0) {
      page.post { if (videoPage === page) page.onVideoFirstFrame(p.videoSize.width, p.videoSize.height) }
    }
    applyPause()
  }

  override fun detachVideo(page: SVGroupPage) {
    detachVideoFrom(page)
  }

  private fun detachVideoFrom(page: SVGroupPage?) {
    val pg = page ?: return
    if (videoPage !== pg) return
    videoPage = null
    videoItemId = null
    val p = player
    if (p != null) {
      p.playWhenReady = false
      try { p.stop() } catch (_: Throwable) {}
      try { p.clearVideoTextureView(pg.textureView) } catch (_: Throwable) {}
    }
    pg.resetVideo()
  }

  override fun prefetch(item: SVItem) {
    when (item.type) {
      SVType.IMAGE -> {
        val g = try { Glide.with(context.applicationContext) } catch (_: Throwable) { null } ?: return
        val src = MVItem.glideModel(item.localUri) ?: MVItem.glideModel(item.uri) ?: return
        try {
          g.load(src).override(MVPageView.FULL_PX, MVPageView.FULL_PX)
            .downsample(DownsampleStrategy.CENTER_INSIDE)
            .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
            .preload()
        } catch (_: Throwable) {}
      }
      SVType.VIDEO -> {
        if (preloadId == item.id || videoItemId == item.id) return
        val uri = videoUri(item) ?: return
        try { preload?.release() } catch (_: Throwable) {}
        val p = makePlayer()
        p.volume = 0f
        p.setMediaItem(mediaItem(uri))
        p.playWhenReady = false
        p.prepare()
        preload = p
        preloadId = item.id
      }
      SVType.TEXT, SVType.VOICE -> {}
    }
  }

  private fun syncMusic() {
    val pg = currentPage()
    val it = pg?.currentItem
    val want = if (pg != null && pg.active && it != null && it.type != SVType.VIDEO && it.musicUrl.isNotEmpty()) it else null
    if (want?.id == musicItemId) return
    try { music?.release() } catch (_: Throwable) {}
    music = null
    musicItemId = null
    if (want == null) return
    val uri = MVItem.existingFile(want.musicUrl)?.let { f -> Uri.fromFile(f) }
      ?: if (want.musicUrl.startsWith("http")) Uri.parse(want.musicUrl) else null
    if (uri == null) return
    val attrs = AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build()
    val m = ExoPlayer.Builder(context).setAudioAttributes(attrs, true).build()
    musicEnded = false
    if (want.type == SVType.VOICE) {
      m.addListener(object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
          if (m === music && playbackState == Player.STATE_ENDED) musicEnded = true
        }
      })
    }
    m.setMediaItem(MediaItem.fromUri(uri))
    if (want.musicStartMs > 0) m.seekTo(want.musicStartMs)
    m.volume = if (muted) 0f else 1f
    m.prepare()
    m.playWhenReady = pauseReasons.isEmpty()
    music = m
    musicItemId = want.id
  }

  // ─── Composer ────────────────────────────────────────────────────────────

  private fun buildComposer() {
    val mp = FrameLayout.LayoutParams.MATCH_PARENT
    val wc = FrameLayout.LayoutParams.WRAP_CONTENT
    composer = FrameLayout(context)
    composer.visibility = View.GONE
    composer.alpha = 0f
    val dim = View(context)
    dim.setBackgroundColor(Color.argb(140, 0, 0, 0))
    dim.setOnClickListener { closeComposer() }
    composer.addView(dim, FrameLayout.LayoutParams(mp, mp))

    composerReactions = LinearLayout(context)
    composerReactions.orientation = LinearLayout.HORIZONTAL
    composerReactions.gravity = Gravity.CENTER
    reactions.forEachIndexed { i, r ->
      val b = ImageButton(context)
      b.setImageResource(r.drawable())
      b.scaleType = ImageView.ScaleType.FIT_CENTER
      b.setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
      b.contentDescription = r.emoji
      borderless(b)
      b.setOnClickListener { tapReaction(i) }
      composerReactions.addView(b, LinearLayout.LayoutParams(dp(54f), dp(54f)))
    }
    composer.addView(composerReactions, FrameLayout.LayoutParams(wc, wc, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))

    composerBar = LinearLayout(context)
    composerBar.orientation = LinearLayout.HORIZONTAL
    composerBar.gravity = Gravity.CENTER_VERTICAL
    field = EditText(context)
    field.setTextColor(Color.WHITE)
    field.setHintTextColor(Color.argb(160, 255, 255, 255))
    field.textSize = 16f
    field.maxLines = 4
    field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    field.imeOptions = EditorInfo.IME_ACTION_SEND
    field.setHorizontallyScrolling(false)
    field.setPadding(dp(18f), dp(10f), dp(18f), dp(10f))
    field.background = GradientDrawable().apply {
      cornerRadius = dp(23f).toFloat()
      setColor(Color.argb(90, 0, 0, 0))
      setStroke(dp(1f), Color.argb(150, 255, 255, 255))
    }
    field.setOnEditorActionListener { _, actionId, ev ->
      if (actionId == EditorInfo.IME_ACTION_SEND || (ev != null && ev.keyCode == KeyEvent.KEYCODE_ENTER && ev.action == KeyEvent.ACTION_DOWN)) {
        sendReply()
        true
      } else false
    }
    composerBar.addView(field, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { gravity = Gravity.CENTER_VERTICAL })
    val send = ImageButton(context)
    send.setImageResource(R.drawable.sv_ic_send)
    send.setColorFilter(Color.WHITE)
    send.scaleType = ImageView.ScaleType.CENTER
    send.contentDescription = labels.get("send", "Enviar")
    borderless(send)
    send.setOnClickListener { sendReply() }
    composerBar.addView(send, LinearLayout.LayoutParams(dp(48f), dp(48f)).apply { leftMargin = dp(4f) })
    composer.addView(composerBar, FrameLayout.LayoutParams(mp, wc, Gravity.BOTTOM).apply { leftMargin = dp(12f); rightMargin = dp(8f) })
    root.addView(composer, FrameLayout.LayoutParams(mp, mp))
    layoutComposer()
  }

  private fun layoutComposer() {
    if (!::composerBar.isInitialized) return
    val lift = max(imeBottom, bottomInset) + dp(8f)
    (composerBar.layoutParams as FrameLayout.LayoutParams).bottomMargin = lift
    (composerReactions.layoutParams as FrameLayout.LayoutParams).bottomMargin = lift + dp(70f)
    composerBar.requestLayout()
    composerReactions.requestLayout()
  }

  private fun openComposer(question: SVOverlay? = null) {
    val g = groups.getOrNull(currentGroup) ?: return
    if (closed || composerOpen || g.isSelf || currentPage()?.currentItem == null) return
    composerOpen = true
    composerQuestion = question
    composerReactions.visibility = if (question != null) View.GONE else View.VISIBLE
    addPause("composer")
    field.hint = if (question != null) question.text.ifEmpty { question.hint } else labels.get("replyTo", "Responder").replace("{name}", g.ownerName)
    field.setText("")
    composer.visibility = View.VISIBLE
    composer.animate().alpha(1f).setDuration(180).start()
    field.requestFocus()
    field.post {
      try {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
      } catch (_: Throwable) {}
    }
  }

  private fun hideKeyboard() {
    try {
      val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
      imm.hideSoftInputFromWindow(field.windowToken, 0)
    } catch (_: Throwable) {}
    field.clearFocus()
  }

  private fun closeComposer() {
    if (!composerOpen) return
    composerOpen = false
    composerQuestion = null
    hideKeyboard()
    composer.animate().alpha(0f).setDuration(160).withEndAction {
      if (!composerOpen) composer.visibility = View.GONE
    }.start()
    removePause("composer")
  }

  private fun sendReply() {
    val text = field.text?.toString()?.trim() ?: ""
    val pg = currentPage()
    val item = pg?.currentItem
    if (text.isEmpty() || pg == null || item == null) {
      if (text.isEmpty()) closeComposer()
      return
    }
    val q = composerQuestion
    if (q != null) {
      listener.emit("onSticker", mapOf("id" to item.id, "ownerEmail" to (pg.group?.ownerEmail ?: ""), "kind" to "question", "stickerId" to q.id, "text" to text))
    } else {
      listener.emit("onReply", mapOf("id" to item.id, "ownerEmail" to (pg.group?.ownerEmail ?: ""), "text" to text))
    }
    root.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    field.setText("")
    closeComposer()
    showToast(if (q != null) labels.get("answerSent", "Resposta enviada") else labels.get("replySent", "Resposta enviada"))
  }

  private fun tapReaction(i: Int) {
    val r = reactions.getOrNull(i) ?: return
    val pg = currentPage() ?: return
    val item = pg.currentItem ?: return
    root.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    item.myReaction = if (item.myReaction == r.emoji) "" else r.emoji
    pg.refreshCounters()
    listener.emit("onReact", mapOf("id" to item.id, "ownerEmail" to (pg.group?.ownerEmail ?: ""), "emoji" to r.emoji, "active" to item.myReaction.isNotEmpty()))
    closeComposer()
    if (item.myReaction.isNotEmpty()) burst(r.kind)
  }

  private fun burst(kind: String, atX: Float? = null, atY: Float? = null) {
    val iv = ImageView(context)
    iv.setImageResource(SVReaction.drawableFor(kind))
    val size = dp(110f)
    if (atX != null && atY != null) {
      root.addView(iv, FrameLayout.LayoutParams(size, size, Gravity.TOP or Gravity.START))
      iv.translationX = atX - size / 2f
      iv.translationY = atY - size / 2f
    } else {
      root.addView(iv, FrameLayout.LayoutParams(size, size, Gravity.CENTER))
    }
    iv.scaleX = 0.3f
    iv.scaleY = 0.3f
    iv.animate().scaleX(1.1f).scaleY(1.1f).setDuration(260).withEndAction {
      iv.animate().alpha(0f).translationY(-dp(120f).toFloat()).scaleX(0.8f).scaleY(0.8f).setStartDelay(220).setDuration(420)
        .withEndAction { root.removeView(iv) }.start()
    }.start()
  }

  // ─── Folha "Visualizações" ───────────────────────────────────────────────

  private fun buildSheet() {
    val mp = FrameLayout.LayoutParams.MATCH_PARENT
    val wc = FrameLayout.LayoutParams.WRAP_CONTENT
    sheet = FrameLayout(context)
    sheet.visibility = View.GONE
    sheetDim = View(context)
    sheetDim.setBackgroundColor(Color.argb(128, 0, 0, 0))
    sheetDim.alpha = 0f
    sheetDim.setOnClickListener { closeSheet() }
    sheet.addView(sheetDim, FrameLayout.LayoutParams(mp, mp))

    sheetPanel = LinearLayout(context)
    sheetPanel.orientation = LinearLayout.VERTICAL
    sheetPanel.isClickable = true
    sheetPanel.background = GradientDrawable().apply {
      val r = dp(20f).toFloat()
      cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
      setColor(Color.rgb(28, 28, 30))
    }
    val handleBox = FrameLayout(context)
    val handle = View(context)
    handle.background = GradientDrawable().apply { cornerRadius = dp(3f).toFloat(); setColor(Color.argb(64, 255, 255, 255)) }
    handleBox.addView(handle, FrameLayout.LayoutParams(dp(40f), dp(5f), Gravity.CENTER))
    sheetPanel.addView(handleBox, LinearLayout.LayoutParams(mp, dp(20f)))
    val headerRow = LinearLayout(context)
    headerRow.orientation = LinearLayout.HORIZONTAL
    headerRow.gravity = Gravity.CENTER_VERTICAL
    sheetTitle = TextView(context)
    sheetTitle.setTextColor(Color.WHITE)
    sheetTitle.textSize = 17f
    sheetTitle.setTypeface(sheetTitle.typeface, Typeface.BOLD)
    headerRow.addView(sheetTitle, LinearLayout.LayoutParams(0, wc, 1f).apply { leftMargin = dp(20f) })
    val close = ImageButton(context)
    close.setImageResource(R.drawable.mv_ic_close)
    close.setColorFilter(Color.argb(180, 255, 255, 255))
    close.contentDescription = labels.get("close", "Fechar")
    borderless(close)
    close.setOnClickListener { closeSheet() }
    headerRow.addView(close, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { rightMargin = dp(8f) })
    sheetPanel.addView(headerRow, LinearLayout.LayoutParams(mp, dp(44f)))
    // Arrastar o cabeçalho p/ baixo fecha.
    val dragHeader = object : View.OnTouchListener {
      var y0 = 0f
      @SuppressLint("ClickableViewAccessibility")
      override fun onTouch(v: View, ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
          MotionEvent.ACTION_DOWN -> { y0 = ev.rawY; return true }
          MotionEvent.ACTION_MOVE -> { sheetPanel.translationY = max(0f, ev.rawY - y0); return true }
          MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
            if (ev.rawY - y0 > dp(100f)) closeSheet() else sheetPanel.animate().translationY(0f).setDuration(200).start()
            return true
          }
        }
        return false
      }
    }
    handleBox.setOnTouchListener(dragHeader)
    headerRow.setOnTouchListener(dragHeader)

    val content = FrameLayout(context)
    sheetScroll = ScrollView(context)
    sheetScroll.isVerticalScrollBarEnabled = false
    sheetList = LinearLayout(context)
    sheetList.orientation = LinearLayout.VERTICAL
    sheetScroll.addView(sheetList, FrameLayout.LayoutParams(mp, wc))
    content.addView(sheetScroll, FrameLayout.LayoutParams(mp, mp))
    sheetSpinner = ProgressBar(context)
    sheetSpinner.isIndeterminate = true
    sheetSpinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
    sheetSpinner.visibility = View.GONE
    content.addView(sheetSpinner, FrameLayout.LayoutParams(dp(36f), dp(36f), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(32f) })
    sheetEmpty = TextView(context)
    sheetEmpty.setTextColor(Color.argb(140, 255, 255, 255))
    sheetEmpty.textSize = 14f
    sheetEmpty.gravity = Gravity.CENTER
    sheetEmpty.text = labels.get("noViews", "Ninguém viu ainda")
    sheetEmpty.visibility = View.GONE
    content.addView(sheetEmpty, FrameLayout.LayoutParams(mp, wc, Gravity.TOP).apply { topMargin = dp(36f) })
    sheetPanel.addView(content, LinearLayout.LayoutParams(mp, 0, 1f))
    sheet.addView(sheetPanel, FrameLayout.LayoutParams(mp, dp(420f), Gravity.BOTTOM))
    root.addView(sheet, FrameLayout.LayoutParams(mp, mp))
  }

  private fun layoutSheet() {
    if (!::sheetPanel.isInitialized) return
    val h = root.height
    val lp = sheetPanel.layoutParams as FrameLayout.LayoutParams
    val want = if (h > 0) min((h * 0.62f).toInt(), dp(560f)) else dp(420f)
    if (lp.height != want) {
      lp.height = want
      sheetPanel.layoutParams = lp
    }
    sheetScroll.setPadding(0, 0, 0, bottomInset + dp(8f))
    sheetScroll.clipToPadding = false
  }

  private fun updateSheetTitle() {
    if (!sheetOpen) return
    var count = sheetRows.size
    for (g in groups) g.items.firstOrNull { it.id == sheetItemId }?.let { count = max(count, it.viewsCount) }
    sheetTitle.text = "${labels.get("seenBy", "Visualizações")} · $count"
  }

  private fun openViewers() {
    val g = groups.getOrNull(currentGroup) ?: return
    val item = currentPage()?.currentItem ?: return
    if (closed || sheetOpen || !g.isSelf) return
    sheetOpen = true
    sheetItemId = item.id
    sheetRows = viewersCache[item.id] ?: emptyList()
    addPause("sheet")
    renderRows()
    sheetEmpty.visibility = View.GONE
    sheetSpinner.visibility = if (sheetRows.isEmpty()) View.VISIBLE else View.GONE
    updateSheetTitle()
    layoutSheet()
    sheet.visibility = View.VISIBLE
    sheetPanel.translationY = dp(600f).toFloat()
    sheetPanel.animate().translationY(0f).setDuration(260).start()
    sheetDim.animate().alpha(1f).setDuration(220).start()
    listener.emit("onOpenViewers", mapOf("id" to item.id))
  }

  private fun closeSheet() {
    if (!sheetOpen) return
    sheetOpen = false
    sheetDim.animate().alpha(0f).setDuration(200).start()
    sheetPanel.animate().translationY(sheetPanel.height.toFloat() + dp(40f)).setDuration(200).withEndAction {
      if (!sheetOpen) sheet.visibility = View.GONE
    }.start()
    removePause("sheet")
    listener.emit("onCloseViewers", mapOf("id" to sheetItemId))
  }

  private fun renderRows() {
    sheetList.removeAllViews()
    val wc = LinearLayout.LayoutParams.WRAP_CONTENT
    for (row in sheetRows) {
      val email = (row["email"] as? String) ?: ""
      val name = ((row["name"] as? String)?.ifEmpty { null }) ?: email
      val r = LinearLayout(context)
      r.orientation = LinearLayout.HORIZONTAL
      r.gravity = Gravity.CENTER_VERTICAL
      r.setPadding(dp(16f), dp(8f), dp(16f), dp(8f))
      r.isClickable = true
      r.setOnClickListener { listener.emit("onViewerPress", mapOf("id" to sheetItemId, "email" to email)) }
      val avBox = FrameLayout(context)
      avBox.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.rgb(77, 77, 77)) }
      val initial = TextView(context)
      initial.text = name.firstOrNull()?.uppercaseChar()?.toString() ?: ""
      initial.setTextColor(Color.WHITE)
      initial.textSize = 16f
      initial.setTypeface(initial.typeface, Typeface.BOLD)
      initial.gravity = Gravity.CENTER
      avBox.addView(initial, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      val av = ImageView(context)
      av.scaleType = ImageView.ScaleType.CENTER_CROP
      avBox.addView(av, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      MVItem.glideModel((row["avatar"] as? String) ?: "")?.let { m ->
        try { Glide.with(context.applicationContext).load(m).override(160, 160).circleCrop().into(av) } catch (_: Throwable) {}
      }
      r.addView(avBox, LinearLayout.LayoutParams(dp(42f), dp(42f)))
      val texts = LinearLayout(context)
      texts.orientation = LinearLayout.VERTICAL
      val n = TextView(context)
      n.text = name
      n.setTextColor(Color.WHITE)
      n.textSize = 15f
      n.setTypeface(n.typeface, Typeface.BOLD)
      n.maxLines = 1
      n.ellipsize = TextUtils.TruncateAt.END
      texts.addView(n)
      val tm = (row["time"] as? String) ?: ""
      if (tm.isNotEmpty()) {
        val tv = TextView(context)
        tv.text = tm
        tv.setTextColor(Color.argb(140, 255, 255, 255))
        tv.textSize = 12f
        texts.addView(tv)
      }
      r.addView(texts, LinearLayout.LayoutParams(0, wc, 1f).apply { leftMargin = dp(12f) })
      val kind = (row["reaction"] as? String) ?: ""
      if (kind.isNotEmpty()) {
        val rv = ImageView(context)
        rv.setImageResource(SVReaction.drawableFor(kind))
        r.addView(rv, LinearLayout.LayoutParams(dp(24f), dp(24f)).apply { leftMargin = dp(8f) })
      }
      sheetList.addView(r, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, wc))
    }
  }

  // ─── Toast ───────────────────────────────────────────────────────────────

  fun showToast(text: String) {
    if (text.isEmpty() || closed) return
    handler.removeCallbacks(toastHide)
    toast.text = text
    toast.bringToFront()
    toast.animate().alpha(1f).setDuration(160).start()
    handler.postDelayed(toastHide, 1600)
  }

  // ─── API do JS ───────────────────────────────────────────────────────────

  fun setPausedFromJS(p: Boolean) {
    if (p) addPause("js") else removePause("js")
  }

  fun setHasMore(next: Boolean, prev: Boolean) {
    hasMoreNext = next
    hasMorePrev = prev
    val d = pendingMore
    if (d != null && ((d == "next" && !next) || (d == "prev" && !prev))) resolveMore(false)
  }

  fun appendGroup(g: SVGroup, direction: String) {
    if (closed) return
    if (g.items.isEmpty() || groups.any { it.key == g.key }) {
      if (pendingMore == direction) resolveMore(false)
      return
    }
    val wasPending = pendingMore == direction
    if (direction == "prev") {
      groups.add(0, g)
      currentGroup += 1
      adapter.notifyItemInserted(0)
    } else {
      groups.add(g)
      adapter.notifyItemInserted(groups.size - 1)
    }
    if (wasPending) {
      resolveMore(true)
      val target = if (direction == "prev") currentGroup - 1 else currentGroup + 1
      pager.post { if (!closed) pager.setCurrentItem(target, true) }
    }
  }

  fun setViewers(id: String, rows: List<Map<String, Any?>>, loading: Boolean) {
    viewersCache[id] = rows
    if (!sheetOpen || sheetItemId != id) return
    sheetRows = rows
    renderRows()
    sheetSpinner.visibility = if (loading && rows.isEmpty()) View.VISIBLE else View.GONE
    sheetEmpty.visibility = if (!loading && rows.isEmpty()) View.VISIBLE else View.GONE
    updateSheetTitle()
  }

  fun updateItem(id: String, patch: Map<String, Any?>) {
    groups.forEachIndexed { gi, g ->
      val it = g.items.firstOrNull { x -> x.id == id } ?: return@forEachIndexed
      (patch["viewed"] as? Boolean)?.let { v -> it.viewed = v }
      SVItem.num(patch["viewsCount"])?.let { n -> it.viewsCount = n.toInt() }
      if (patch.containsKey("myReaction")) it.myReaction = (patch["myReaction"] as? String) ?: ""
      var captionChanged = false
      (patch["caption"] as? String)?.let { c -> it.caption = c; captionChanged = true }
      (patch["translated"] as? Boolean)?.let { t -> it.translated = t; captionChanged = true }
      val op = patch["overlay"] as? Map<*, *>
      val oid = op?.get("id") as? String
      if (op != null && oid != null) {
        it.overlays.firstOrNull { o -> o.id == oid }?.let { o ->
          (op["counts"] as? List<*>)?.let { c -> o.counts = c.map { n -> SVItem.num(n)?.toInt() ?: 0 }.toMutableList() }
          SVItem.num(op["myVote"])?.let { v -> o.myVote = v.toInt() }
          SVItem.num(op["value"])?.let { v -> o.value = v }
          SVItem.num(op["avg"])?.let { v -> o.avg = v }
        }
      }
      val pg = pageAt(gi)
      if (pg != null && pg.currentItem?.id == id) {
        if (captionChanged) pg.refreshCaption()
        if (oid != null) pg.overlayLayer.refresh(oid)
        pg.refreshCounters()
      }
      if (sheetOpen && sheetItemId == id) updateSheetTitle()
    }
  }

  fun removeItem(id: String) {
    val gi = groups.indexOfFirst { g -> g.items.any { it.id == id } }
    if (gi < 0) return
    val g = groups[gi]
    val ii = g.items.indexOfFirst { it.id == id }
    if (ii < 0) return
    if (sheetOpen && sheetItemId == id) closeSheet()
    val items = g.items.toMutableList()
    items.removeAt(ii)
    if (items.isEmpty()) {
      if (groups.size == 1) {
        finish("empty", true)
        return
      }
      currentPage()?.deactivate()
      groups.removeAt(gi)
      if (currentGroup >= groups.size || gi < currentGroup) currentGroup = max(0, currentGroup - 1)
      adapter.notifyDataSetChanged()
      pager.setCurrentItem(currentGroup, false)
      pager.post {
        val pg = currentPage()
        if (pg != null && !pg.active && !closed) { pg.activate(); applyPause(); syncMusic() }
      }
      return
    }
    if (g.index > ii || (g.index == ii && ii >= items.size)) g.index -= 1
    g.index = g.index.coerceIn(0, items.size - 1)
    val pg = pageAt(gi)
    val wasCurrent = gi == currentGroup
    if (pg != null) {
      pg.replaceItems(items)
      pg.showItem(g.index, wasCurrent)
      if (wasCurrent) { pg.activate(); applyPause(); syncMusic() }
    } else {
      g.items = items
    }
  }

  fun closeFromJS() {
    finish("js", true)
  }

  fun closeSilently() {
    finish("replaced", false)
  }

  private fun finish(reason: String, animated: Boolean) {
    if (closed) return
    closed = true
    Choreographer.getInstance().removeFrameCallback(frameCb)
    handler.removeCallbacksAndMessages(null)
    try { hideKeyboard() } catch (_: Throwable) {}
    try { host.application.unregisterActivityLifecycleCallbacks(lifecycleCb) } catch (_: Throwable) {}
    val g = groups.getOrNull(currentGroup)
    val item = g?.items?.getOrNull(g.index)
    forEachPage { it.deactivate() }
    try { player?.release() } catch (_: Throwable) {}
    try { preload?.release() } catch (_: Throwable) {}
    try { music?.release() } catch (_: Throwable) {}
    player = null
    preload = null
    music = null
    val body = mapOf(
      "reason" to reason,
      "groupIndex" to currentGroup,
      "itemIndex" to (g?.index ?: 0),
      "id" to (item?.id ?: ""),
      "ownerEmail" to (g?.ownerEmail ?: ""),
    )
    val done = {
      listener.emit("onClose", body)
      listener.onFinished()
      realDismiss()
    }
    if (animated && ::stage.isInitialized) {
      stage.animate().alpha(0f).scaleX(0.94f).scaleY(0.94f).setDuration(180).start()
      backdrop.animate().alpha(0f).setDuration(180).withEndAction { done() }.start()
    } else {
      done()
    }
  }
}
