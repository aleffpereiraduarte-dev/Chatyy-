package expo.modules.chatyymediaviewer

import android.annotation.SuppressLint
import android.content.Context
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.bumptech.glide.RequestManager
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.model.GlideUrl
import com.bumptech.glide.request.RequestOptions
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** GlideUrl com chave de cache SEM a query (exp/sig mudam a cada 6h). */
class PGGlideUrl(url: String, private val ck: String) : GlideUrl(url) {
  override fun getCacheKey(): String = ck
}

/**
 * [2026-10-15 native-photos] Grade de Fotos nativa (Android).
 * RecyclerView + GridLayoutManager; cabeçalhos por dia/mês/ano (grudados via
 * decoration), pinça entre níveis com crossfade, barra de rolagem rápida com
 * balão de data, seleção por long-press + arrastar, selos de backup.
 * Contrato: scratchpad photos/SPEC.md (parte A).
 */
@SuppressLint("ViewConstructor", "NotifyDataSetChanged", "ClickableViewAccessibility")
class PGGridView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {

  val onReady by EventDispatcher()
  val onPress by EventDispatcher()
  val onZoomChange by EventDispatcher()
  val onScrollState by EventDispatcher()
  val onNativeError by EventDispatcher()
  val onSelectionChange by EventDispatcher()
  val onSelectionMode by EventDispatcher()

  private val d = context.resources.displayMetrics.density
  private val main = Handler(Looper.getMainLooper())
  private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "pg-grid").apply { priority = Thread.NORM_PRIORITY - 1 } }
  private val glide: RequestManager = Glide.with(context.applicationContext)

  // ── estado de dados ────────────────────────────────────────────────
  private var localItems: List<PGItem> = emptyList()
  private var cloudItems: List<PGItem> = emptyList()
  private var items: Array<PGItem> = emptyArray()
  private var mergeSeq = 0
  private var localSeq = 0
  private var permission = "notDetermined"
  private val statuses = HashMap<String, Int>()

  // linhas do nível atual
  private var rowRef = IntArray(0)          // >=0 item; <0 = -(seção+1)
  private var rowCount = 0
  private var posSection = IntArray(0)
  private var posGroup = IntArray(0)
  private var posCol = IntArray(0)
  private var itemPos = IntArray(0)
  private var secHeaderPos = IntArray(0)
  private var secFirst = IntArray(0)
  private var secCount = IntArray(0)
  private var secTitles = arrayOf<String>()
  private var sectionCount = 0

  // ── props ──────────────────────────────────────────────────────────
  private val theme = PGTheme()
  private var darkHint: Boolean? = null
  private var themeRaw: Map<String, Any?>? = null
  private var localeTag: String? = null
  private var labelToday = "Hoje"
  private var labelYesterday = "Ontem"
  private var fmt = PGDateFmt(null, labelToday, labelYesterday)
  private var insetTop = 0
  private var insetBottom = 0
  private var includeLocal = true
  private var backupEnabled = false
  private var showBadges = true
  private var levels: List<PGZoomLevel> = PGZoomLevel.DEFAULTS
  private var level = 3
  private var levelFromProp: Int? = null
  private var started = false
  private var destroyed = false

  // ── seleção ────────────────────────────────────────────────────────
  private var selectionMode = false
  private val selected = HashSet<String>()
  private var dragSelecting = false
  private var dragAnchor = -1
  private var dragLo = -1
  private var dragHi = -1
  private var dragAdd = true
  private var dragBase: HashSet<String>? = null
  private var lastTouchX = 0f
  private var lastTouchY = 0f
  private var lastSelEmit = 0L

  // ── views ──────────────────────────────────────────────────────────
  private val rv = RecyclerView(context)
  private val glm: GridLayoutManager
  private val adapter = Adapter()
  private val overlay = ImageView(context)
  private var overlayBitmap: Bitmap? = null

  // tamanho atual da célula (px) p/ override do Glide
  private var cellPx = 0
  private var localOpts: RequestOptions? = null
  private var cloudOpts: RequestOptions? = null

  // ── barra de rolagem rápida ────────────────────────────────────────
  private var fsVisible = false
  private var fsAlpha = 0f
  private var fsDragging = false
  private var fsLabel = ""
  private val fsThumbH = 44 * d
  private val fsThumbW = 28 * d
  private val fsPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val fsTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = 14f * d; typeface = Typeface.DEFAULT_BOLD; color = Color.WHITE
  }
  private val fsRect = RectF()
  private val fsHide = Runnable { fadeScroller(false) }
  private var fsAnimStart = 0L
  private var fsAnimFrom = 0f
  private var fsAnimTo = 0f

  // ── cabeçalho grudado ──────────────────────────────────────────────
  private val stickyBg = Paint()
  private val stickyText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = 15f * d; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  }
  private val stRing = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.5f * d }
  private val stFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val stCheck = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 2f * d
    strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
  }
  private val stPath = Path()
  private var stickyTop = 0f
  private var stickySection = -1

  // ── pinça ──────────────────────────────────────────────────────────
  private var scaling = false
  private var scaleAcc = 1f
  private val scaleDetector: ScaleGestureDetector
  private val gestureDetector: GestureDetector

  private var lastScrollEmit = 0L
  private var observer: ContentObserver? = null
  private val reloadDebounce = Runnable { reloadLocal() }

  init {
    setWillNotDraw(false)
    clipChildren = true
    glm = GridLayoutManager(context, levels[level].cols)
    glm.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
      override fun getSpanSize(position: Int): Int =
        if (position < rowCount && rowRef[position] < 0) glm.spanCount else 1
      override fun getSpanIndex(position: Int, spanCount: Int): Int =
        if (position < rowCount) posCol[position] else 0
      override fun getSpanGroupIndex(adapterPosition: Int, spanCount: Int): Int =
        if (adapterPosition < rowCount) posGroup[adapterPosition] else 0
    }
    glm.initialPrefetchItemCount = 12
    rv.layoutManager = glm
    rv.adapter = adapter
    rv.setHasFixedSize(true)
    rv.itemAnimator = null
    rv.clipToPadding = false
    rv.isVerticalScrollBarEnabled = false
    rv.overScrollMode = View.OVER_SCROLL_NEVER
    rv.setItemViewCacheSize(24)
    rv.recycledViewPool.setMaxRecycledViews(VT_CELL, 120)
    rv.recycledViewPool.setMaxRecycledViews(VT_HEADER, 16)
    rv.addItemDecoration(Decoration())
    rv.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        val scrolling = newState != RecyclerView.SCROLL_STATE_IDLE
        emitScroll(scrolling, true)
        if (scrolling) showScroller() else if (!fsDragging) scheduleHideScroller()
      }
      override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
        if (dy != 0) { emitScroll(true, false); if (fsVisible) invalidate() }
      }
    })
    addView(rv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    overlay.scaleType = ImageView.ScaleType.FIT_XY
    overlay.visibility = View.GONE
    addView(overlay, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

    gestureDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
      override fun onDown(e: MotionEvent): Boolean = true
      override fun onSingleTapUp(e: MotionEvent): Boolean { handleTap(e.x, e.y); return true }
      override fun onLongPress(e: MotionEvent) { handleLongPress(e.x, e.y) }
    })
    gestureDetector.setIsLongpressEnabled(true)
    rv.addOnItemTouchListener(object : RecyclerView.OnItemTouchListener {
      override fun onInterceptTouchEvent(rv: RecyclerView, e: MotionEvent): Boolean {
        if (scaling) return false
        gestureDetector.onTouchEvent(e)
        lastTouchX = e.x; lastTouchY = e.y
        return dragSelecting
      }
      override fun onTouchEvent(rv: RecyclerView, e: MotionEvent) {
        lastTouchX = e.x; lastTouchY = e.y
        when (e.actionMasked) {
          MotionEvent.ACTION_MOVE -> { updateDrag(e.x, e.y); ensureAutoScroll() }
          MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> endDrag()
        }
      }
      override fun onRequestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {}
    })

    scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
      override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
        if (dragSelecting || fsDragging) return false
        scaling = true; scaleAcc = 1f
        parent?.requestDisallowInterceptTouchEvent(true)
        return true
      }
      override fun onScale(detector: ScaleGestureDetector): Boolean {
        scaleAcc *= detector.scaleFactor
        if (scaleAcc > 1.18f && level < levels.size - 1) {
          setLevel(level + 1, detector.focusX, detector.focusY, true, true); scaleAcc = 1f
        } else if (scaleAcc < 0.85f && level > 0) {
          setLevel(level - 1, detector.focusX, detector.focusY, true, true); scaleAcc = 1f
        }
        return true
      }
      override fun onScaleEnd(detector: ScaleGestureDetector) { scaleAcc = 1f }
    })
    scaleDetector.isQuickScaleEnabled = false

    applyTheme()
    post { if (!started && !destroyed) start() }
  }

  // ════════════════════════════════════════════════════════════════════
  // Props
  // ════════════════════════════════════════════════════════════════════
  fun setTheme(m: Map<String, Any?>?) { themeRaw = m; applyTheme() }
  fun setDark(v: Boolean?) { darkHint = v; applyTheme() }
  fun setLocale(v: String?) { if (v != localeTag) { localeTag = v; rebuildFmt() } }
  fun setLabels(m: Map<String, Any?>?) {
    labelToday = (m?.get("today") as? String) ?: "Hoje"
    labelYesterday = (m?.get("yesterday") as? String) ?: "Ontem"
    rebuildFmt()
  }
  fun setInsets(top: Double?, bottom: Double?) {
    if (top != null) insetTop = (top * d).toInt()
    if (bottom != null) insetBottom = (bottom * d).toInt()
    rv.setPadding(0, insetTop, 0, insetBottom)
    invalidate()
  }
  fun setIncludeLocal(v: Boolean?) {
    val nv = v ?: true
    if (nv == includeLocal) return
    includeLocal = nv
    if (started) reloadLocal()
  }
  fun setBackupEnabled(v: Boolean?) {
    val nv = v ?: false
    if (nv == backupEnabled) return
    backupEnabled = nv
    refreshVisibleCells()
  }
  fun setShowBadges(v: Boolean?) { showBadges = v ?: true; refreshVisibleCells() }
  fun setZoomLevels(raw: List<*>?) {
    levels = PGZoomLevel.parse(raw)
    level = level.coerceIn(0, levels.size - 1)
    glm.spanCount = levels[level].cols
    if (started) applyRowsKeepingAnchor()
  }
  fun setZoomLevelProp(v: Int?) {
    if (v == null) return
    val nv = v.coerceIn(0, levels.size - 1)
    if (levelFromProp == nv) return
    levelFromProp = nv
    if (nv != level) {
      if (started && rowCount > 0) setLevel(nv, width / 2f, height / 3f, false, false)
      else { level = nv; glm.spanCount = levels[level].cols }
    }
  }

  private fun rebuildFmt() {
    fmt = PGDateFmt(localeTag, labelToday, labelYesterday)
    if (started && items.isNotEmpty()) applyRowsKeepingAnchor()
  }

  private fun applyTheme() {
    theme.apply(themeRaw, darkHint)
    setBackgroundColor(theme.background)
    rv.setBackgroundColor(theme.background)
    stickyBg.color = theme.header
    stickyText.color = theme.text
    for (i in 0 until rv.childCount) {
      val v = rv.getChildAt(i)
      if (v is PGHeaderView) { v.textPaint.color = theme.text; v.accent = theme.accent; v.invalidate() }
      if (v is PGCellView) { v.accent = theme.accent; v.invalidate() }
    }
    invalidate()
  }

  // ════════════════════════════════════════════════════════════════════
  // Carga
  // ════════════════════════════════════════════════════════════════════
  private fun start() {
    started = true
    registerObserver()
    reloadLocal()
  }

  fun reloadLocal() {
    if (destroyed) return
    permission = PGUtil.permission(context)
    val seq = ++localSeq
    if (!includeLocal || permission == "denied") {
      localItems = emptyList()
      remerge()
      return
    }
    val ctx = context.applicationContext
    exec.execute {
      val list = try { PGLocalSource.load(ctx) } catch (t: Throwable) {
        main.post { emitError("local: ${t.message}") }; ArrayList()
      }
      main.post {
        if (destroyed || seq != localSeq) return@post
        localItems = list
        remerge()
      }
    }
  }

  /** Chamado fora da main (fila do módulo). */
  fun setCloudItemsAsync(raw: List<*>, replace: Boolean) {
    val parsed = try { PGLocalSource.parseCloud(raw) } catch (t: Throwable) {
      main.post { emitError("cloud: ${t.message}") }; return
    }
    main.post {
      if (destroyed) return@post
      if (replace) cloudItems = parsed
      else {
        val keys = HashSet<String>(cloudItems.size * 2)
        for (c in cloudItems) keys.add(c.key)
        val merged = ArrayList<PGItem>(cloudItems.size + parsed.size)
        merged.addAll(cloudItems)
        for (p in parsed) if (keys.add(p.key)) merged.add(p)
        cloudItems = merged
      }
      remerge()
    }
  }

  private fun remerge() {
    val l = localItems; val c = cloudItems
    val seq = ++mergeSeq
    exec.execute {
      val merged = try { PGLocalSource.merge(l, c) } catch (t: Throwable) {
        main.post { emitError("merge: ${t.message}") }; return@execute
      }
      main.post {
        if (destroyed || seq != mergeSeq) return@post
        items = merged
        applyRowsKeepingAnchor()
        var lc = 0
        for (it in merged) if (it.local) lc++
        onReady(mapOf("total" to merged.size, "local" to lc, "cloud" to merged.size - lc, "permission" to permission))
      }
    }
  }

  private fun registerObserver() {
    if (observer != null) return
    val o = object : ContentObserver(main) {
      override fun onChange(selfChange: Boolean) { onChange(selfChange, null) }
      override fun onChange(selfChange: Boolean, uri: Uri?) {
        main.removeCallbacks(reloadDebounce)
        main.postDelayed(reloadDebounce, 1000)
      }
    }
    try {
      context.contentResolver.registerContentObserver(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, o)
      context.contentResolver.registerContentObserver(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true, o)
      observer = o
    } catch (_: Throwable) {}
  }

  fun destroy() {
    destroyed = true
    main.removeCallbacksAndMessages(null)
    observer?.let { try { context.contentResolver.unregisterContentObserver(it) } catch (_: Throwable) {} }
    observer = null
    exec.shutdownNow()
    for (i in 0 until rv.childCount) {
      val v = rv.getChildAt(i)
      if (v is PGCellView) try { glide.clear(v) } catch (_: Throwable) {}
    }
    overlay.setImageDrawable(null)
    overlayBitmap?.recycle(); overlayBitmap = null
  }

  // ════════════════════════════════════════════════════════════════════
  // Linhas / seções
  // ════════════════════════════════════════════════════════════════════
  private fun buildRows() {
    val its = items
    val lv = levels[level]
    val cols = lv.cols
    val group = lv.group
    val tz = fmt.timeZone()
    val cap = its.size * 2 + 2
    val ref = IntArray(cap); val sec = IntArray(cap); val grp = IntArray(cap); val col = IntArray(cap)
    val iPos = IntArray(its.size)
    val hPos = ArrayList<Int>(); val first = ArrayList<Int>(); val cnt = ArrayList<Int>(); val titles = ArrayList<String>()
    var n = 0
    var g = -1
    var lastKey = Long.MIN_VALUE
    var lastDay = Long.MIN_VALUE
    var lastDayKey = 0L
    var s = -1
    var inSec = 0
    for (i in its.indices) {
      val t = its[i].time
      val day = PGUtil.localEpochDay(t, tz)
      val key: Long = if (day == lastDay) lastDayKey else {
        val k = when (group) {
          PGZoomLevel.G_DAY -> day
          PGZoomLevel.G_MONTH -> { val c = PGUtil.civil(day); c[0] * 100L + c[1] }
          else -> PGUtil.civil(day)[0].toLong()
        }
        lastDay = day; lastDayKey = k; k
      }
      if (key != lastKey) {
        if (s >= 0) cnt[s] = inSec
        s++
        lastKey = key; inSec = 0
        g++
        ref[n] = -(s + 1); sec[n] = s; grp[n] = g; col[n] = 0
        hPos.add(n); first.add(i); cnt.add(0); titles.add(fmt.title(group, key, t))
        n++
      }
      val c = inSec % cols
      if (c == 0) g++
      ref[n] = i; sec[n] = s; grp[n] = g; col[n] = c
      iPos[i] = n
      n++; inSec++
    }
    if (s >= 0) cnt[s] = inSec
    rowRef = ref; posSection = sec; posGroup = grp; posCol = col; itemPos = iPos; rowCount = n
    secHeaderPos = hPos.toIntArray(); secFirst = first.toIntArray(); secCount = cnt.toIntArray()
    secTitles = titles.toTypedArray(); sectionCount = secTitles.size
    computeCellPx()
  }

  private fun spacingPx(): Int = if (levels[level].group == PGZoomLevel.G_YEAR) max(1, d.toInt()) else max(1, (2 * d).toInt())

  private fun computeCellPx() {
    val w = if (rv.width > 0) rv.width else resources.displayMetrics.widthPixels
    val cols = levels[level].cols
    val px = max(32, (w - spacingPx() * (cols - 1)) / cols)
    if (px != cellPx) {
      cellPx = px
      localOpts = RequestOptions().override(px, px).centerCrop().diskCacheStrategy(DiskCacheStrategy.AUTOMATIC).dontAnimate()
      cloudOpts = RequestOptions().override(px, px).centerCrop().diskCacheStrategy(DiskCacheStrategy.RESOURCE).dontAnimate()
    }
  }

  private fun headerHeightPx(): Int = if (levels[level].group == PGZoomLevel.G_YEAR) (40 * d).toInt() else (44 * d).toInt()

  /** Reconstrói as linhas mantendo o 1º item visível no mesmo lugar. */
  private fun applyRowsKeepingAnchor() {
    var anchorKey: String? = null
    var anchorOff = 0
    if (rowCount > 0) {
      val fp = glm.findFirstVisibleItemPosition()
      if (fp != RecyclerView.NO_POSITION && fp < rowCount) {
        var p = fp
        while (p < rowCount && rowRef[p] < 0) p++
        if (p < rowCount) {
          anchorKey = items.getOrNull(rowRef[p])?.key
          val vh = rv.findViewHolderForAdapterPosition(p)
          anchorOff = (vh?.itemView?.top ?: 0) - rv.paddingTop
        }
      }
    }
    val oldItemsAtTop = rowCount == 0 || glm.findFirstCompletelyVisibleItemPosition() <= 0
    glm.spanCount = levels[level].cols
    buildRows()
    adapter.notifyDataSetChanged()
    if (!oldItemsAtTop && anchorKey != null) {
      val idx = indexOfKeyInternal(anchorKey)
      if (idx >= 0) glm.scrollToPositionWithOffset(itemPos[idx], anchorOff)
    }
    invalidate()
  }

  private fun setLevel(nl: Int, fx: Float, fy: Float, animate: Boolean, fromGesture: Boolean) {
    val newLevel = nl.coerceIn(0, levels.size - 1)
    if (newLevel == level || rowCount == 0) { level = newLevel; return }
    // âncora: item sob o ponto focal
    var anchorIdx = -1
    var anchorTop = 0
    val child = rv.findChildViewUnder(fx, fy)
    if (child != null) {
      val p = rv.getChildAdapterPosition(child)
      if (p in 0 until rowCount && rowRef[p] >= 0) { anchorIdx = rowRef[p]; anchorTop = child.top }
    }
    if (anchorIdx < 0) {
      val fp = glm.findFirstVisibleItemPosition()
      if (fp in 0 until rowCount) {
        var p = fp
        while (p < rowCount && rowRef[p] < 0) p++
        if (p < rowCount) {
          anchorIdx = rowRef[p]
          anchorTop = rv.findViewHolderForAdapterPosition(p)?.itemView?.top ?: rv.paddingTop
        }
      }
    }
    if (animate && width > 0 && height > 0) {
      try {
        val bmp = overlayBitmap?.takeIf { !it.isRecycled && it.width == width && it.height == height }
          ?: Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { overlayBitmap?.recycle(); overlayBitmap = it }
        bmp.eraseColor(theme.background)
        rv.draw(Canvas(bmp))
        overlay.animate().cancel()
        overlay.setImageBitmap(bmp)
        overlay.alpha = 1f
        overlay.visibility = View.VISIBLE
      } catch (_: Throwable) { overlay.visibility = View.GONE }
    }
    level = newLevel
    glm.spanCount = levels[level].cols
    buildRows()
    adapter.notifyDataSetChanged()
    if (anchorIdx >= 0 && anchorIdx < itemPos.size) {
      val off = (anchorTop - rv.paddingTop).coerceIn(0, max(0, rv.height - rv.paddingTop - cellPx))
      glm.scrollToPositionWithOffset(itemPos[anchorIdx], off)
    }
    if (animate && overlay.visibility == View.VISIBLE) {
      overlay.animate().alpha(0f).setDuration(220).withEndAction {
        overlay.visibility = View.GONE
        overlay.setImageDrawable(null)
      }.start()
    }
    if (fromGesture) performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    levelFromProp = if (fromGesture) levelFromProp else newLevel
    onZoomChange(mapOf("level" to level))
    invalidate()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w != oldw) post { if (!destroyed) { val old = cellPx; computeCellPx(); if (old != cellPx) adapter.notifyDataSetChanged() } }
  }

  // ════════════════════════════════════════════════════════════════════
  // Adapter
  // ════════════════════════════════════════════════════════════════════
  private class CellHolder(val cell: PGCellView) : RecyclerView.ViewHolder(cell)
  private class HeaderHolder(val header: PGHeaderView) : RecyclerView.ViewHolder(header)

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = rowCount
    override fun getItemViewType(position: Int): Int = if (rowRef[position] < 0) VT_HEADER else VT_CELL

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      return if (viewType == VT_HEADER) {
        val h = PGHeaderView(parent.context)
        h.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
        HeaderHolder(h)
      } else {
        val c = PGCellView(parent.context)
        c.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
        CellHolder(c)
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
      if (payloads.isNotEmpty() && holder is CellHolder) { bindOverlay(holder.cell, rowRef[position]); return }
      onBindViewHolder(holder, position)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      val r = rowRef[position]
      if (holder is HeaderHolder) {
        val s = -r - 1
        val h = holder.header
        h.title = secTitles.getOrElse(s) { "" }
        h.heightPx = headerHeightPx()
        h.textPaint.color = theme.text
        h.textPaint.textSize = (if (levels[level].group == PGZoomLevel.G_YEAR) 17f else 15f) * d
        h.accent = theme.accent
        h.showSelect = selectionMode && levels[level].group != PGZoomLevel.G_YEAR
        h.allSelected = h.showSelect && sectionAllSelected(s)
        h.requestLayout()
        h.invalidate()
        return
      }
      val cell = (holder as CellHolder).cell
      val it = items[r]
      val tiny = levels[level].group == PGZoomLevel.G_YEAR
      cell.tiny = tiny
      cell.accent = theme.accent
      cell.item = it
      bindOverlay(cell, r)
      // imagem
      val src = it.thumb
      if (src.isEmpty()) {
        glide.clear(cell)
        cell.setImageDrawable(null)
      } else if (it.local) {
        glide.load(Uri.parse(src)).apply(localOpts!!).into(cell)
      } else {
        glide.load(PGGlideUrl(src, PGUtil.stripQuery(src))).apply(cloudOpts!!).into(cell)
      }
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
      if (holder is CellHolder) {
        glide.clear(holder.cell)
        holder.cell.item = null
      }
    }
  }

  private fun bindOverlay(cell: PGCellView, idx: Int) {
    val it = items.getOrNull(idx) ?: return
    cell.status = statusOf(it)
    cell.showBadges = showBadges && levels[level].group != PGZoomLevel.G_YEAR
    cell.selectionMode = selectionMode
    cell.setSelectedAnimated(selectionMode && selected.contains(it.key), false)
    cell.invalidate()
  }

  private fun statusOf(it: PGItem): Int {
    if (!it.local) return PGStatus.CLOUD_ONLY
    if (it.cloudMatched) return PGStatus.CLOUD
    val s = statuses[it.localId]
    if (s != null && s != PGStatus.NONE) return s
    return if (backupEnabled) PGStatus.PENDING else PGStatus.LOCAL
  }

  private fun refreshVisibleCells() {
    for (i in 0 until rv.childCount) {
      val v = rv.getChildAt(i)
      val p = rv.getChildAdapterPosition(v)
      if (p < 0 || p >= rowCount) continue
      if (v is PGCellView) bindOverlay(v, rowRef[p])
      else if (v is PGHeaderView) {
        val s = -rowRef[p] - 1
        v.showSelect = selectionMode && levels[level].group != PGZoomLevel.G_YEAR
        v.allSelected = v.showSelect && sectionAllSelected(s)
        v.invalidate()
      }
    }
    invalidate()
  }

  // ════════════════════════════════════════════════════════════════════
  // Decoration: espaçamento + cabeçalho grudado
  // ════════════════════════════════════════════════════════════════════
  private inner class Decoration : RecyclerView.ItemDecoration() {
    override fun getItemOffsets(outRect: Rect, view: View, parent: RecyclerView, state: RecyclerView.State) {
      val p = parent.getChildAdapterPosition(view)
      if (p < 0 || p >= rowCount || rowRef[p] < 0) { outRect.set(0, 0, 0, 0); return }
      val n = levels[level].cols
      val sp = spacingPx()
      val c = posCol[p]
      outRect.left = c * sp / n
      outRect.right = sp - (c + 1) * sp / n
      outRect.top = 0
      outRect.bottom = sp
    }

    override fun onDrawOver(c: Canvas, parent: RecyclerView, state: RecyclerView.State) {
      stickySection = -1
      if (rowCount == 0) return
      val fp = glm.findFirstVisibleItemPosition()
      if (fp == RecyclerView.NO_POSITION || fp >= rowCount) return
      val s = posSection[fp]
      val top = parent.paddingTop.toFloat()
      val hh = headerHeightPx().toFloat()
      // primeiro visível já é o cabeçalho real, encostado no topo → não duplica
      if (rowRef[fp] < 0) {
        val v = parent.findViewHolderForAdapterPosition(fp)?.itemView
        if (v != null && v.top >= top) { stickySection = -1; return }
      }
      var y = top
      if (s + 1 < sectionCount) {
        val nv = parent.findViewHolderForAdapterPosition(secHeaderPos[s + 1])?.itemView
        if (nv != null && nv.top < top + hh) y = nv.top - hh
      }
      stickyTop = y
      stickySection = s
      val showSel = selectionMode && levels[level].group != PGZoomLevel.G_YEAR
      stickyText.textSize = (if (levels[level].group == PGZoomLevel.G_YEAR) 17f else 15f) * d
      c.save()
      c.translate(0f, y)
      c.clipRect(0f, top - y, parent.width.toFloat(), hh)
      PGHeaderView.drawHeader(c, parent.width.toFloat(), hh, d, secTitles[s], stickyText, showSel,
        showSel && sectionAllSelected(s), theme.accent, stRing, stFill, stCheck, stPath, stickyBg)
      c.restore()
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Toques: tap / long-press / arrastar-seleção / pinça / scroller
  // ════════════════════════════════════════════════════════════════════
  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    // barra rápida tem prioridade quando o toque começa na alça
    if (ev.actionMasked == MotionEvent.ACTION_DOWN && fsVisible && fsAlpha > 0.2f && hitScroller(ev.x, ev.y)) {
      fsDragging = true
      parent?.requestDisallowInterceptTouchEvent(true)
      rv.stopScroll()
      main.removeCallbacks(fsHide)
      dragScroller(ev.y)
      return true
    }
    if (fsDragging) {
      when (ev.actionMasked) {
        MotionEvent.ACTION_MOVE -> dragScroller(ev.y)
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          fsDragging = false; fsLabel = ""; scheduleHideScroller(); invalidate()
        }
      }
      return true
    }
    scaleDetector.onTouchEvent(ev)
    if (scaling) {
      if (ev.actionMasked == MotionEvent.ACTION_UP || ev.actionMasked == MotionEvent.ACTION_CANCEL) {
        scaling = false
      }
      // cancela o que os filhos estavam fazendo (scroll/long-press) uma vez
      if (!cancelSent) {
        cancelSent = true
        val cancel = MotionEvent.obtain(ev); cancel.action = MotionEvent.ACTION_CANCEL
        super.dispatchTouchEvent(cancel); cancel.recycle()
      }
      return true
    }
    cancelSent = false
    return super.dispatchTouchEvent(ev)
  }
  private var cancelSent = false

  private fun childPos(x: Float, y: Float): Int {
    val v = rv.findChildViewUnder(x, y) ?: return -1
    val p = rv.getChildAdapterPosition(v)
    return if (p in 0 until rowCount) p else -1
  }

  private fun handleTap(x: Float, y: Float) {
    // cabeçalho grudado (selecionar dia)
    if (selectionMode && stickySection >= 0 && y >= stickyTop && y < stickyTop + headerHeightPx()) {
      if (x > width - 52 * d) toggleSection(stickySection)
      return
    }
    val p = childPos(x, y)
    if (p < 0) return
    val r = rowRef[p]
    if (r < 0) {
      if (selectionMode && x > width - 52 * d) toggleSection(-r - 1)
      return
    }
    val it = items[r]
    if (selectionMode) {
      if (!selected.remove(it.key)) selected.add(it.key)
      refreshVisibleCells()
      emitSelection(true)
      return
    }
    val v = rv.findViewHolderForAdapterPosition(p)?.itemView
    val ev = HashMap<String, Any>()
    ev["key"] = it.key; ev["index"] = r; ev["kind"] = if (it.local) "local" else "cloud"
    if (v != null) ev["frame"] = frameOf(v)
    onPress(ev)
  }

  private fun handleLongPress(x: Float, y: Float) {
    if (scaling) return
    val p = childPos(x, y)
    if (p < 0 || rowRef[p] < 0) return
    val idx = rowRef[p]
    performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    if (!selectionMode) setSelectionModeInternal(true, true)
    val key = items[idx].key
    dragAdd = !selected.contains(key)
    dragBase = HashSet(selected)
    dragAnchor = idx
    dragLo = -1; dragHi = -1
    dragSelecting = true
    parent?.requestDisallowInterceptTouchEvent(true)
    applyDragRange(idx, idx)
  }

  private fun updateDrag(x: Float, y: Float) {
    if (!dragSelecting) return
    val cy = y.coerceIn(rv.paddingTop.toFloat() + 1, (rv.height - rv.paddingBottom - 1).toFloat())
    var p = childPos(x.coerceIn(1f, rv.width - 1f), cy)
    if (p < 0) return
    if (rowRef[p] < 0) {
      // sobre um cabeçalho: usa o 1º item da seção
      val s = -rowRef[p] - 1
      p = itemPos[secFirst[s]]
    }
    val idx = rowRef[p]
    applyDragRange(min(dragAnchor, idx), max(dragAnchor, idx))
  }

  private fun applyDragRange(lo: Int, hi: Int) {
    val base = dragBase ?: return
    if (lo == dragLo && hi == dragHi) return
    // desfaz índices que saíram da faixa
    if (dragLo >= 0) {
      for (i in dragLo..dragHi) {
        if (i in lo..hi) continue
        val k = items[i].key
        if (base.contains(k)) selected.add(k) else selected.remove(k)
      }
    }
    for (i in lo..hi) {
      if (dragLo >= 0 && i in dragLo..dragHi) continue
      val k = items[i].key
      if (dragAdd) selected.add(k) else selected.remove(k)
    }
    dragLo = lo; dragHi = hi
    refreshVisibleCells()
    emitSelection(false)
  }

  private fun endDrag() {
    if (!dragSelecting) return
    dragSelecting = false
    dragBase = null
    main.removeCallbacks(autoScroll)
    emitSelection(true)
  }

  private val autoScroll = object : Runnable {
    override fun run() {
      if (!dragSelecting) return
      val edge = 64 * d
      val top = rv.paddingTop + edge
      val bottom = rv.height - rv.paddingBottom - edge
      val dy = when {
        lastTouchY < top -> -((top - lastTouchY) / edge * 22 * d + 4 * d)
        lastTouchY > bottom -> ((lastTouchY - bottom) / edge * 22 * d + 4 * d)
        else -> 0f
      }
      if (dy != 0f) {
        rv.scrollBy(0, dy.toInt())
        updateDrag(lastTouchX, lastTouchY)
        main.postDelayed(this, 16)
      }
    }
  }

  private fun ensureAutoScroll() {
    main.removeCallbacks(autoScroll)
    val edge = 64 * d
    if (lastTouchY < rv.paddingTop + edge || lastTouchY > rv.height - rv.paddingBottom - edge) main.post(autoScroll)
  }

  private fun sectionAllSelected(s: Int): Boolean {
    if (s < 0 || s >= sectionCount || selected.isEmpty()) return false
    val f = secFirst[s]; val n = secCount[s]
    for (i in f until f + n) if (!selected.contains(items[i].key)) return false
    return n > 0
  }

  private fun toggleSection(s: Int) {
    if (s < 0 || s >= sectionCount) return
    val all = sectionAllSelected(s)
    val f = secFirst[s]; val n = secCount[s]
    for (i in f until f + n) { val k = items[i].key; if (all) selected.remove(k) else selected.add(k) }
    performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    refreshVisibleCells()
    emitSelection(true)
  }

  private fun setSelectionModeInternal(on: Boolean, emit: Boolean) {
    if (selectionMode == on) return
    selectionMode = on
    if (!on) selected.clear()
    // anima as células visíveis
    for (i in 0 until rv.childCount) {
      val v = rv.getChildAt(i)
      if (v is PGCellView) {
        v.selectionMode = on
        val k = v.item?.key
        v.setSelectedAnimated(on && k != null && selected.contains(k), true)
      }
    }
    refreshVisibleCells()
    if (emit) {
      onSelectionMode(mapOf("active" to on))
      emitSelection(true)
    }
  }

  private fun emitSelection(force: Boolean) {
    val now = SystemClock.uptimeMillis()
    if (!force && now - lastSelEmit < 100) return
    lastSelEmit = now
    val keys = ArrayList<String>(min(selected.size, 5000))
    for (k in selected) { if (keys.size >= 5000) break; keys.add(k) }
    onSelectionChange(mapOf("count" to selected.size, "keys" to keys))
  }

  // ── barra de rolagem rápida ───────────────────────────────────────
  private fun scrollerEligible(): Boolean {
    val range = rv.computeVerticalScrollRange()
    val extent = rv.computeVerticalScrollExtent()
    return rowCount > 0 && extent > 0 && range > extent * 3
  }

  private fun showScroller() {
    main.removeCallbacks(fsHide)
    if (!scrollerEligible()) return
    if (!fsVisible || fsAnimTo < 1f) fadeScroller(true)
  }

  private fun scheduleHideScroller() {
    main.removeCallbacks(fsHide)
    main.postDelayed(fsHide, 1500)
  }

  private fun fadeScroller(show: Boolean) {
    if (show) fsVisible = true
    fsAnimFrom = fsAlpha; fsAnimTo = if (show) 1f else 0f
    fsAnimStart = SystemClock.uptimeMillis()
    invalidate()
  }

  private fun thumbTop(): Float {
    val range = rv.computeVerticalScrollRange()
    val extent = rv.computeVerticalScrollExtent()
    val off = rv.computeVerticalScrollOffset()
    val frac = if (range - extent > 0) off.toFloat() / (range - extent) else 0f
    val top = insetTop + 8 * d
    val avail = height - insetBottom - 8 * d - fsThumbH - top
    return top + frac.coerceIn(0f, 1f) * max(0f, avail)
  }

  private fun hitScroller(x: Float, y: Float): Boolean {
    val t = thumbTop()
    return x > width - fsThumbW - 24 * d && y > t - 12 * d && y < t + fsThumbH + 12 * d
  }

  private fun dragScroller(y: Float) {
    if (rowCount == 0) return
    val top = insetTop + 8 * d
    val avail = height - insetBottom - 8 * d - fsThumbH - top
    val frac = if (avail > 0) ((y - top - fsThumbH / 2f) / avail).coerceIn(0f, 1f) else 0f
    val pos = (frac * (rowCount - 1)).toInt().coerceIn(0, rowCount - 1)
    glm.scrollToPositionWithOffset(pos, 0)
    var p = pos
    while (p < rowCount && rowRef[p] < 0) p++
    if (p >= rowCount) p = rowCount - 1
    val r = rowRef[p]
    val label = if (r >= 0) fmt.bubble(items[r].time, levels[level].group) else fsLabel
    if (label != fsLabel) {
      if (fsLabel.isNotEmpty()) performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      fsLabel = label
    }
    fsAlpha = 1f; fsVisible = true; fsAnimTo = 1f
    invalidate()
  }

  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    if (!fsVisible) return
    // anima alpha
    if (fsAlpha != fsAnimTo) {
      val t = ((SystemClock.uptimeMillis() - fsAnimStart) / 180f).coerceIn(0f, 1f)
      fsAlpha = fsAnimFrom + (fsAnimTo - fsAnimFrom) * t
      if (t < 1f) postInvalidateOnAnimation() else if (fsAnimTo == 0f) { fsVisible = false; return }
    }
    if (fsAlpha <= 0f) return
    val a = (fsAlpha * 255).toInt()
    val t = thumbTop()
    val right = width - 6 * d
    fsRect.set(right - fsThumbW, t, right, t + fsThumbH)
    fsPaint.color = if (theme.dark) Color.rgb(58, 58, 60) else Color.rgb(242, 242, 247)
    fsPaint.alpha = a
    fsPaint.setShadowLayer(4 * d, 0f, 1 * d, Color.argb((a * 0.3f).toInt(), 0, 0, 0))
    canvas.drawRoundRect(fsRect, fsThumbW / 2f, fsThumbW / 2f, fsPaint)
    fsPaint.clearShadowLayer()
    // grip: duas setas (cima/baixo)
    fsPaint.color = theme.textSecondary; fsPaint.alpha = a
    fsPaint.style = Paint.Style.STROKE; fsPaint.strokeWidth = 1.8f * d; fsPaint.strokeCap = Paint.Cap.ROUND
    val cx = fsRect.centerX(); val cy = fsRect.centerY()
    canvas.drawLine(cx - 4 * d, cy - 4 * d, cx, cy - 8 * d, fsPaint)
    canvas.drawLine(cx, cy - 8 * d, cx + 4 * d, cy - 4 * d, fsPaint)
    canvas.drawLine(cx - 4 * d, cy + 4 * d, cx, cy + 8 * d, fsPaint)
    canvas.drawLine(cx, cy + 8 * d, cx + 4 * d, cy + 4 * d, fsPaint)
    fsPaint.style = Paint.Style.FILL
    if (fsDragging && fsLabel.isNotEmpty()) {
      val tw = fsTextPaint.measureText(fsLabel)
      val bh = 36 * d
      val bRight = fsRect.left - 12 * d
      val bTop = (cy - bh / 2f).coerceAtLeast(insetTop.toFloat())
      fsRect.set(bRight - tw - 32 * d, bTop, bRight, bTop + bh)
      fsPaint.color = theme.accent; fsPaint.alpha = a
      canvas.drawRoundRect(fsRect, bh / 2f, bh / 2f, fsPaint)
      fsTextPaint.alpha = a
      val fm = fsTextPaint.fontMetrics
      canvas.drawText(fsLabel, fsRect.left + 16 * d, fsRect.centerY() - (fm.ascent + fm.descent) / 2f, fsTextPaint)
    }
  }

  private fun emitScroll(scrolling: Boolean, force: Boolean) {
    val now = SystemClock.uptimeMillis()
    if (!force && now - lastScrollEmit < 100) return
    lastScrollEmit = now
    onScrollState(mapOf("scrolling" to scrolling, "offset" to rv.computeVerticalScrollOffset() / d))
  }

  private fun emitError(msg: String) {
    try { onNativeError(mapOf("message" to msg)) } catch (_: Throwable) {}
  }

  private fun frameOf(v: View): Map<String, Any> {
    val loc = IntArray(2)
    v.getLocationInWindow(loc)
    // getLocationInWindow já aplica a escala (célula selecionada = 0.88)
    val w = v.width * v.scaleX; val h = v.height * v.scaleY
    return mapOf("x" to loc[0] / d, "y" to loc[1] / d, "width" to w / d, "height" to h / d)
  }

  // ════════════════════════════════════════════════════════════════════
  // Funções (main)
  // ════════════════════════════════════════════════════════════════════
  fun setStatuses(payload: Map<String, Any?>, replace: Boolean) {
    if (replace) statuses.clear()
    fun put(list: Any?, st: Int) {
      val l = list as? List<*> ?: return
      for (x in l) {
        val id = x?.toString() ?: continue
        if (replace) {
          val cur = statuses[id]
          if (cur == null || PGStatus.rank(st) > PGStatus.rank(cur)) statuses[id] = st
        } else statuses[id] = st
      }
    }
    // ordem crescente de prioridade: no merge incremental o último vence
    put(payload["local"], PGStatus.LOCAL)
    put(payload["pending"], PGStatus.PENDING)
    put(payload["failed"], PGStatus.FAILED)
    put(payload["uploading"], PGStatus.UPLOADING)
    put(payload["cloud"], PGStatus.CLOUD)
    refreshVisibleCells()
  }

  private fun indexOfKeyInternal(key: String): Int {
    val its = items
    for (i in its.indices) if (its[i].key == key) return i
    return -1
  }

  fun indexOfKey(key: String): Int = indexOfKeyInternal(key)

  fun getItems(from: Int, count: Int): List<Map<String, Any?>> {
    val its = items
    val s = from.coerceAtLeast(0)
    val e = min(its.size, s + count.coerceAtLeast(0))
    val out = ArrayList<Map<String, Any?>>(max(0, e - s))
    for (i in s until e) {
      val it = its[i]
      out.add(mapOf(
        "key" to it.key, "uri" to it.uri, "thumbUri" to it.thumb,
        "type" to (if (it.video) "video" else "image"), "createdAt" to it.time,
        "width" to it.width, "height" to it.height, "local" to it.local,
        "cloudId" to it.cloudId, "name" to it.name, "status" to PGStatus.name(statusOf(it)),
        "duration" to it.durationSec, "unavailable" to it.unavailable,
        "localId" to it.localId, "index" to i
      ))
    }
    return out
  }

  fun frameForKey(key: String): Map<String, Any>? {
    val idx = indexOfKeyInternal(key)
    if (idx < 0 || idx >= itemPos.size) return null
    val v = rv.findViewHolderForAdapterPosition(itemPos[idx])?.itemView ?: return null
    if (!v.isAttachedToWindow) return null
    return frameOf(v)
  }

  fun scrollToKey(key: String, animated: Boolean): Boolean {
    val idx = indexOfKeyInternal(key)
    if (idx < 0 || idx >= itemPos.size) return false
    val pos = itemPos[idx]
    val fp = glm.findFirstVisibleItemPosition()
    if (animated && fp != RecyclerView.NO_POSITION && abs(fp - pos) < 60) rv.smoothScrollToPosition(pos)
    else glm.scrollToPositionWithOffset(pos, max(0, (rv.height - rv.paddingTop) / 3 - cellPx / 2))
    return true
  }

  fun scrollToTop(animated: Boolean) {
    if (rowCount == 0) return
    if (animated && glm.findFirstVisibleItemPosition() < 80) rv.smoothScrollToPosition(0)
    else glm.scrollToPositionWithOffset(0, 0)
  }

  fun setSelectionMode(on: Boolean) = setSelectionModeInternal(on, true)

  fun clearSelection() {
    if (selected.isEmpty()) return
    selected.clear()
    refreshVisibleCells()
    emitSelection(true)
  }

  fun selectAll() {
    if (!selectionMode) setSelectionModeInternal(true, true)
    for (it in items) selected.add(it.key)
    refreshVisibleCells()
    emitSelection(true)
  }

  fun getSelection(): List<String> = ArrayList(selected)

  companion object {
    const val VT_HEADER = 1
    const val VT_CELL = 2
  }
}
