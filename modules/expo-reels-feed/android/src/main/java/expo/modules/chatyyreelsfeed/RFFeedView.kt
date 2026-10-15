package expo.modules.chatyyreelsfeed

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.SeekParameters
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.PagerSnapHelper
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.Collections
import java.util.WeakHashMap

// [2026-10-15 native-reels] ChatyyReelsFeed (Android) — RecyclerView vertical
// + PagerSnapHelper (1 reel por tela) + pool FIXO de 3 ExoPlayer (Media3) com
// pré-buffer do anterior/próximo e SimpleCache em disco. A LayoutManager
// mantém a página de cima/de baixo montadas (extra layout space = 1 tela) →
// o TextureView do próximo já recebeu o 1º quadro quando o dedo solta.
// Eventos/props/métodos idênticos ao iOS (ver ios/RFFeedView.swift).

@OptIn(UnstableApi::class)
@SuppressLint("ViewConstructor")
class RFFeedView(context: Context, appContext: AppContext) : ExpoView(context, appContext), RFPlayerPool.Listener, RFPageView.Host {
  override val shouldUseAndroidLayout = true

  val onReady by EventDispatcher()
  val onNativeError by EventDispatcher()
  val onIndexChange by EventDispatcher()
  val onLike by EventDispatcher()
  val onComment by EventDispatcher()
  val onGift by EventDispatcher()
  val onShare by EventDispatcher()
  val onSave by EventDispatcher()
  val onFollow by EventDispatcher()
  val onAuthorPress by EventDispatcher()
  val onMore by EventDispatcher()
  val onMusicPress by EventDispatcher()
  val onCreditPress by EventDispatcher()
  val onLikersPress by EventDispatcher()
  val onNeedMore by EventDispatcher()
  val onViewProgress by EventDispatcher()
  val onMuteChange by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onPlaybackError by EventDispatcher()

  companion object {
    /** Views vivas (só main thread) — o módulo repassa 1º/2º plano da Activity. */
    val live: MutableSet<RFFeedView> = Collections.newSetFromMap(WeakHashMap())
  }

  private val main = Handler(Looper.getMainLooper())
  private val density = resources.displayMetrics.density
  private val swipe = SwipeRefreshLayout(context)
  private val rv = RecyclerView(context)
  private val lm = object : LinearLayoutManager(context, RecyclerView.VERTICAL, false) {
    override fun calculateExtraLayoutSpace(state: RecyclerView.State, extraLayoutSpace: IntArray) {
      val h = height
      extraLayoutSpace[0] = h
      extraLayoutSpace[1] = h
    }
  }
  private val snap = PagerSnapHelper()
  private val adapter = Adapter()
  private val pool = RFPlayerPool(context, this)

  private val items = ArrayList<RFItem>()
  private val stableIds = HashMap<String, Long>()
  private var nextStableId = 1L
  private var index = 0
  private var currentId = ""
  private var needMoreAt = -1
  private var readySent = false
  private var destroyed = false

  // props
  private var labels = RFLabels()
  private var muted = false
  private var propPaused = false
  private var methodPaused = false
  private var holding = false
  private var scrubbing = false
  private var inBackground = false
  private var rate = 1f
  private var captionsEnabled = true
  private var bottomInsetPx = 0
  private var topInsetPx = 0
  private var refreshEnabled = false

  // impressão / relógio
  private var tickerOn = false
  private var lastTick = 0L
  private var stallSince = 0L
  private var impId = ""
  private var impMs = 0.0
  private var impCompleted = false
  private var impLoops = 0
  private var lastScrubSeek = 0L

  private val ticker = object : Runnable {
    override fun run() {
      if (!tickerOn || destroyed) return
      tick()
      main.postDelayed(this, 33)
    }
  }

  init {
    setBackgroundColor(Color.BLACK)
    rv.layoutManager = lm
    rv.adapter = adapter
    rv.setHasFixedSize(true)
    rv.itemAnimator = null
    rv.overScrollMode = android.view.View.OVER_SCROLL_NEVER
    rv.setItemViewCacheSize(1)
    snap.attachToRecyclerView(rv)
    rv.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_IDLE) settle(false)
      }
    })
    swipe.isEnabled = false
    swipe.setOnRefreshListener { onRefresh(mapOf<String, Any>()) }
    swipe.addView(rv, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    addView(swipe, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    live.add(this)
  }

  private fun dp(v: Float): Int = (v * density).toInt()

  // ─── props ────────────────────────────────────────────────────────────────
  fun setLabels(m: Map<String, Any?>?) {
    labels = RFLabels(m)
    rebindAllVisible()
  }

  fun setMuted(v: Boolean) {
    if (v == muted) return
    muted = v
    updatePlayback()
  }

  fun setPaused(v: Boolean) {
    if (v == propPaused) return
    propPaused = v
    updatePlayback()
  }

  fun setRate(v: Double?) {
    val r = (v ?: 1.0).coerceIn(0.25, 3.0).toFloat()
    if (r == rate) return
    rate = r
    updatePlayback()
  }

  fun setCaptionsEnabled(v: Boolean) {
    captionsEnabled = v
    if (!v) forEachPage { it.setSubtitle("") }
  }

  fun setInsets(m: Map<String, Any?>?) {
    val b = dp(RFItem.num(m?.get("bottom")).toFloat().coerceAtLeast(0f))
    val t = dp(RFItem.num(m?.get("top")).toFloat().coerceAtLeast(0f))
    if (b == bottomInsetPx && t == topInsetPx) return
    bottomInsetPx = b
    topInsetPx = t
    swipe.setProgressViewOffset(false, t, t + dp(64f))
    rebindAllVisible()
  }

  fun setImageHeaders(m: Map<String, Any?>?) {
    val h = HashMap<String, String>()
    m?.forEach { (k, v) -> if (v is String && v.isNotEmpty()) h[k] = v }
    RFImageAuth.headers = h
  }

  fun setRefreshEnabled(v: Boolean) {
    refreshEnabled = v
    swipe.isEnabled = v && index == 0
  }

  fun setRefreshing(v: Boolean) {
    if (swipe.isRefreshing != v) swipe.isRefreshing = v
  }

  // ─── métodos (JS) ─────────────────────────────────────────────────────────
  fun play() {
    methodPaused = false
    updatePlayback()
  }

  fun pause() {
    methodPaused = true
    updatePlayback()
  }

  fun scrollTo(i: Int, animated: Boolean) {
    if (items.isEmpty()) return
    val t = i.coerceIn(0, items.size - 1)
    if (animated) {
      rv.smoothScrollToPosition(t)
    } else {
      lm.scrollToPositionWithOffset(t, 0)
      rv.post { settle(false) }
    }
  }

  fun applyItems(payload: Map<String, Any?>) {
    if (destroyed) return
    try {
      val op = payload["op"] as? String ?: "reset"
      val raw = payload["items"] as? List<*> ?: emptyList<Any?>()
      when (op) {
        "append" -> {
          val seen = items.map { it.id }.toHashSet()
          val add = ArrayList<RFItem>()
          for (r in raw) {
            val it = (r as? Map<*, *>)?.let { m -> RFItem.from(m) } ?: continue
            if (!seen.add(it.id)) continue
            add.add(it)
          }
          if (add.isEmpty()) return
          val start = items.size
          items.addAll(add)
          adapter.notifyItemRangeInserted(start, add.size)
          if (start == 0) {
            lm.scrollToPositionWithOffset(index.coerceIn(0, items.size - 1), 0)
            rv.post { settle(true) }
          } else {
            settle(false)
          }
        }
        "update" -> {
          for (r in raw) {
            val m = r as? Map<*, *> ?: continue
            val id = RFItem.str(m["id"])
            val it = items.firstOrNull { x -> x.id == id } ?: continue
            val oldKey = it.mediaKey
            it.apply(m)
            pageFor(id)?.let { p -> p.bind(it, labels, bottomInsetPx) }
            if (it.mediaKey != oldKey && pool.slotFor(id) != null) {
              pool.reload(it)
              rebindVisible()
              if (id == currentId) updatePlayback()
            }
          }
        }
        "remove" -> {
          val ids = (payload["ids"] as? List<*>)?.map { RFItem.str(it) }?.filter { it.isNotEmpty() }?.toHashSet() ?: return
          if (ids.isEmpty()) return
          if (currentId in ids) {
            endImpression()
            currentId = ""
          }
          val keptId = items.getOrNull(index)?.id?.takeIf { it !in ids }
          val removedBefore = items.take(index).count { it.id in ids }
          items.removeAll { it.id in ids }
          for (s in pool.slots) if (s.itemId in ids) {
            detachSlot(s)
            pool.clear(s)
          }
          index = if (keptId != null) items.indexOfFirst { it.id == keptId }.coerceAtLeast(0) else (index - removedBefore)
          index = if (items.isEmpty()) 0 else index.coerceIn(0, items.size - 1)
          adapter.notifyDataSetChanged()
          lm.scrollToPositionWithOffset(index, 0)
          rv.post { settle(true) }
        }
        else -> {
          endImpression()
          val seen = HashSet<String>()
          val list = ArrayList<RFItem>()
          for (r in raw) {
            val it = (r as? Map<*, *>)?.let { m -> RFItem.from(m) } ?: continue
            if (!seen.add(it.id)) continue
            list.add(it)
          }
          items.clear()
          items.addAll(list)
          pool.pauseAll()
          for (s in pool.slots) if (s.itemId.isNotEmpty() && s.itemId !in seen) {
            detachSlot(s)
            pool.clear(s)
          }
          currentId = ""
          needMoreAt = -1
          val start = RFItem.num(payload["startIndex"]).toInt()
          index = if (items.isEmpty()) 0 else start.coerceIn(0, items.size - 1)
          adapter.notifyDataSetChanged()
          lm.scrollToPositionWithOffset(index, 0)
          rv.post { settle(true) }
        }
      }
    } catch (t: Throwable) {
      onNativeError(mapOf("message" to ("applyItems: " + (t.message ?: t.javaClass.simpleName))))
    }
  }

  fun destroy() {
    if (destroyed) return
    endImpression()
    destroyed = true
    stopTicker()
    for (s in pool.slots) detachSlot(s)
    pool.release()
    RFCache.cancel(emptySet())
    live.remove(this)
  }

  fun enterBackground() {
    inBackground = true
    updatePlayback()
  }

  fun enterForeground() {
    inBackground = false
    updatePlayback()
  }

  // ─── ciclo de vida da view ────────────────────────────────────────────────
  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (destroyed) return
    if (!readySent) {
      readySent = true
      onReady(mapOf("width" to (width / density).toDouble(), "height" to (height / density).toDouble()))
    }
    startTicker()
    updatePlayback()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    stopTicker()
    endImpression()
    pool.pauseAll()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w <= 0 || h <= 0) return
    if (!readySent) {
      readySent = true
      onReady(mapOf("width" to (w / density).toDouble(), "height" to (h / density).toDouble()))
    }
    if (items.isNotEmpty()) {
      main.post {
        lm.scrollToPositionWithOffset(index.coerceIn(0, items.size - 1), 0)
        rv.post { settle(true) }
      }
    }
  }

  // ─── página atual ─────────────────────────────────────────────────────────
  private fun snappedPosition(): Int {
    val v = snap.findSnapView(lm) ?: return index
    val p = lm.getPosition(v)
    return if (p == RecyclerView.NO_POSITION) index else p
  }

  private fun settle(force: Boolean) {
    if (destroyed) return
    if (items.isEmpty()) {
      endImpression()
      pool.pauseAll()
      currentId = ""
      return
    }
    val i = snappedPosition().coerceIn(0, items.size - 1)
    val id = items[i].id
    if (!force && id == currentId) {
      index = i
      updatePlayback()
      return
    }
    val changed = id != currentId
    if (changed) {
      endImpression()
      leaveCurrent()
    }
    index = i
    currentId = id
    val window = listOf(i, i + 1, i - 1).filter { it in items.indices }.map { items[it] }
    pool.assign(window, id)
    rebindVisible()
    pool.slotFor(id)?.let { s -> pageFor(id)?.showError(s.failed) }
    if (changed) onIndexChange(mapOf("index" to i, "id" to id))
    updatePlayback()
    prefetchAhead()
    checkNeedMore()
    swipe.isEnabled = refreshEnabled && i == 0
  }

  private fun leaveCurrent() {
    val s = pool.slotFor(currentId) ?: return
    s.player.playWhenReady = false
    pool.setAudible(s, false)
    s.player.seekTo(0)
    pageFor(currentId)?.let {
      it.setProgress(0f)
      it.setBuffering(false)
      it.setSubtitle("")
    }
  }

  private val externallyPaused: Boolean
    get() = propPaused || methodPaused || inBackground || !isAttachedToWindow

  private fun updatePlayback() {
    if (destroyed) return
    val s = pool.slotFor(currentId) ?: return
    val play = !externallyPaused && !holding && !scrubbing && !s.failed
    pool.setAudible(s, !muted && !externallyPaused)
    if (s.player.playbackParameters.speed != rate) s.player.setPlaybackSpeed(rate)
    if (play) {
      if (!s.player.playWhenReady) s.player.playWhenReady = true
      startTicker()
    } else {
      if (s.player.playWhenReady) s.player.playWhenReady = false
      if (externallyPaused) endImpression()
    }
  }

  private fun prefetchAhead() {
    val keep = HashSet<String>()
    for (k in 2..3) {
      val it = items.getOrNull(index + k) ?: continue
      if (it.hlsUrl.isEmpty() && RFCache.isCacheable(it.videoUrl)) keep.add(it.videoUrl)
    }
    RFCache.cancel(keep)
    for (u in keep) RFCache.prefetch(context, u)
    try {
      val g = com.bumptech.glide.Glide.with(context.applicationContext)
      for (k in 1..3) {
        val it = items.getOrNull(index + k) ?: break
        if (it.thumb.isNotEmpty()) g.downloadOnly().load(it.thumb).submit()
        if (it.avatar.isNotEmpty()) g.downloadOnly().load(RFImageAuth.model(it.avatar)).submit()
      }
    } catch (_: Throwable) {}
  }

  private fun checkNeedMore() {
    if (items.isEmpty()) return
    if (index >= items.size - 4 && needMoreAt != items.size) {
      needMoreAt = items.size
      onNeedMore(mapOf("index" to index, "count" to items.size))
    }
  }

  // ─── player ↔ página ──────────────────────────────────────────────────────
  private fun detachSlot(s: RFSlot) {
    val p = s.page ?: return
    try { s.player.clearVideoTextureView(p.texture) } catch (_: Throwable) {}
    if (p.slot === s) p.slot = null
    s.page = null
    p.showPoster()
  }

  private fun bindPlayer(page: RFPageView) {
    if (destroyed) return
    val id = page.item?.id ?: return
    val s = pool.slotFor(id)
    if (s != null && page.slot === s && s.page === page) return
    page.slot?.let { old -> if (old.page === page) detachSlot(old) }
    page.slot = null
    page.showPoster()
    if (s == null) return
    s.page?.let { other -> if (other !== page) detachSlot(s) }
    s.firstFrame = false
    s.player.setVideoTextureView(page.texture)
    s.page = page
    page.slot = s
    page.applyVideoTransform(s.videoW, s.videoH)
    // Pausado com o quadro já decodificado: re-renderiza na superfície nova.
    if (s.ready && !s.player.isPlaying) s.player.seekTo(s.player.currentPosition)
  }

  private fun rebindVisible() {
    forEachPage { bindPlayer(it) }
  }

  private fun rebindAllVisible() {
    forEachPage { p -> p.item?.let { p.bind(it, labels, bottomInsetPx) } }
  }

  private inline fun forEachPage(fn: (RFPageView) -> Unit) {
    for (i in 0 until rv.childCount) {
      val v = rv.getChildAt(i)
      if (v is RFPageView) fn(v)
    }
  }

  private fun pageFor(id: String): RFPageView? {
    for (i in 0 until rv.childCount) {
      val v = rv.getChildAt(i)
      if (v is RFPageView && v.item?.id == id) return v
    }
    return null
  }

  // ─── RFPlayerPool.Listener ────────────────────────────────────────────────
  override fun onSlotReady(s: RFSlot) {
    if (s.itemId == currentId) updatePlayback()
  }

  override fun onSlotLooped(s: RFSlot) {
    if (s.itemId == currentId && impId == s.itemId) {
      impCompleted = true
      impLoops += 1
    }
    if (s.itemId != currentId) s.player.playWhenReady = false
  }

  override fun onSlotFailed(s: RFSlot) {
    pageFor(s.itemId)?.showError(true)
    if (s.itemId == currentId) {
      endImpression()
      onPlaybackError(mapOf("id" to s.itemId))
    }
  }

  override fun onSlotFirstFrame(s: RFSlot) {
    val p = s.page ?: return
    if (p.item?.id == s.itemId) p.onFirstFrame()
  }

  override fun onSlotVideoSize(s: RFSlot) {
    items.firstOrNull { it.id == s.itemId }?.let {
      if (it.width <= 0) {
        it.width = s.videoW.toDouble()
        it.height = s.videoH.toDouble()
      }
    }
    s.page?.applyVideoTransform(s.videoW, s.videoH)
  }

  // ─── relógio ──────────────────────────────────────────────────────────────
  private fun startTicker() {
    if (tickerOn || destroyed || !isAttachedToWindow) return
    tickerOn = true
    lastTick = 0L
    main.post(ticker)
  }

  private fun stopTicker() {
    tickerOn = false
    main.removeCallbacks(ticker)
  }

  private fun tick() {
    val now = SystemClock.uptimeMillis()
    val dt = if (lastTick > 0) now - lastTick else 0L
    lastTick = now
    val s = pool.slotFor(currentId) ?: return
    val page = s.page ?: return
    val it = page.item ?: return
    if (it.id != currentId) return
    val p = s.player
    val dur = p.duration
    val pos = p.currentPosition
    if (dur != C.TIME_UNSET && dur > 0) page.setProgress(pos.toFloat() / dur.toFloat())
    if (p.isPlaying) {
      if (impId != currentId) {
        impId = currentId
        impMs = 0.0
        impCompleted = false
        impLoops = 0
      }
      if (dt in 1..499) impMs += dt.toDouble()
      stallSince = 0L
      page.setBuffering(false)
    } else if (p.playWhenReady && p.playbackState == Player.STATE_BUFFERING && !s.failed) {
      if (stallSince == 0L) stallSince = now
      page.setBuffering(now - stallSince > 450)
    } else {
      stallSince = 0L
      page.setBuffering(false)
    }
    page.setSubtitle(if (captionsEnabled) it.subtitleAt(pos / 1000.0) else "")
  }

  private fun endImpression() {
    if (impId.isEmpty() || destroyed) return
    val id = impId
    val ms = impMs
    val done = impCompleted
    val loops = impLoops
    impId = ""
    impMs = 0.0
    impCompleted = false
    impLoops = 0
    if (ms < 1 && !done) return
    var dur = items.firstOrNull { it.id == id }?.durationMs ?: 0.0
    if (dur <= 0) {
      val d = pool.slotFor(id)?.player?.duration ?: C.TIME_UNSET
      if (d != C.TIME_UNSET && d > 0) dur = d.toDouble()
    }
    onViewProgress(mapOf("id" to id, "watchedMs" to Math.round(ms).toInt(), "completed" to done, "loops" to loops, "durationMs" to Math.round(dur).toInt()))
  }

  // ─── RFPageView.Host ──────────────────────────────────────────────────────
  override fun onPageTap(page: RFPageView) {
    muted = !muted
    updatePlayback()
    page.flash(muted)
    onMuteChange(mapOf("muted" to muted))
  }

  override fun onPageDoubleTap(page: RFPageView, x: Float, y: Float) {
    val it = page.item ?: return
    page.burstHeart(x, y)
    page.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    if (!it.liked) {
      it.liked = true
      it.likes += 1
      page.refresh()
      page.likeBtn.pop()
      onLike(mapOf("id" to it.id, "liked" to true, "likes" to it.likes, "source" to "double_tap", "index" to items.indexOf(it)))
    }
  }

  override fun onPageHold(page: RFPageView, holding: Boolean) {
    if (page.item?.id != currentId) return
    this.holding = holding
    page.setOverlayHidden(holding)
    updatePlayback()
  }

  override fun onPageScrub(page: RFPageView, phase: Int, fraction: Float) {
    val s = page.slot ?: return
    if (page.item?.id != currentId) return
    val dur = s.player.duration
    when (phase) {
      0 -> {
        scrubbing = true
        page.setScrubbing(true, fraction)
        updatePlayback()
      }
      1 -> {
        page.setScrubbing(true, fraction)
        val now = SystemClock.uptimeMillis()
        if (dur != C.TIME_UNSET && dur > 0 && now - lastScrubSeek > 120) {
          lastScrubSeek = now
          s.player.setSeekParameters(SeekParameters.CLOSEST_SYNC)
          s.player.seekTo((fraction * dur).toLong())
        }
      }
      else -> {
        if (dur != C.TIME_UNSET && dur > 0) {
          s.player.setSeekParameters(SeekParameters.EXACT)
          s.player.seekTo((fraction * dur).toLong())
        }
        scrubbing = false
        page.setScrubbing(false, null)
        updatePlayback()
      }
    }
  }

  override fun onPageAction(page: RFPageView, action: String) {
    val it = page.item ?: return
    val body = HashMap<String, Any>()
    body["id"] = it.id
    body["index"] = items.indexOf(it)
    when (action) {
      "like" -> {
        it.liked = !it.liked
        it.likes = (it.likes + if (it.liked) 1 else -1).coerceAtLeast(0)
        page.refresh()
        page.likeBtn.pop()
        if (it.liked) page.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        body["liked"] = it.liked
        body["likes"] = it.likes
        body["source"] = "button"
        onLike(body)
      }
      "save" -> {
        it.saved = !it.saved
        page.refresh()
        page.saveBtn.pop()
        body["saved"] = it.saved
        onSave(body)
      }
      "comment" -> if (!it.commentsDisabled) onComment(body)
      "gift" -> onGift(body)
      "share" -> onShare(body)
      "more" -> onMore(body)
      "author" -> onAuthorPress(body)
      "follow" -> {
        it.canFollow = false
        page.refresh()
        page.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        onFollow(body)
      }
      "music" -> onMusicPress(body)
      "credit" -> onCreditPress(body)
      "likers" -> if (it.likes > 0) onLikersPress(body)
      "retry" -> {
        page.showError(false)
        val s = pool.slotFor(it.id)
        if (s != null) {
          pool.load(s, it)
          bindPlayer(page)
        } else {
          settle(true)
        }
        if (it.id == currentId) updatePlayback()
      }
    }
  }

  // ─── adapter ──────────────────────────────────────────────────────────────
  private inner class VH(val page: RFPageView) : RecyclerView.ViewHolder(page)

  private inner class Adapter : RecyclerView.Adapter<VH>() {
    init {
      setHasStableIds(true)
    }

    override fun getItemCount(): Int = items.size

    override fun getItemId(position: Int): Long {
      val id = items.getOrNull(position)?.id ?: return RecyclerView.NO_ID
      return stableIds.getOrPut(id) { nextStableId++ }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
      val p = RFPageView(parent.context, this@RFFeedView)
      p.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.MATCH_PARENT)
      return VH(p)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
      val it = items.getOrNull(position) ?: return
      holder.page.bind(it, labels, bottomInsetPx)
      bindPlayer(holder.page)
    }

    override fun onViewAttachedToWindow(holder: VH) {
      bindPlayer(holder.page)
    }

    override fun onViewRecycled(holder: VH) {
      holder.page.slot?.let { s -> if (s.page === holder.page) detachSlot(s) }
      holder.page.slot = null
      holder.page.recycle()
    }
  }
}
