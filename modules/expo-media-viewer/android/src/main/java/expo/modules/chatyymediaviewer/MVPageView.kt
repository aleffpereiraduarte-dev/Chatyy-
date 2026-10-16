package expo.modules.chatyymediaviewer

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.TextureView
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
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
import java.io.File
import kotlin.math.abs

data class MVItem(
  val uri: String,
  val localUri: String,
  val thumbUri: String,
  val isVideo: Boolean,
  val messageId: String,
  val caption: String,
  val senderName: String,
  val dateLabel: String,
  val width: Int,
  val height: Int,
  var starred: Boolean,
) {
  companion object {
    fun from(m: Map<*, *>): MVItem {
      fun s(k: String): String = (m[k] as? String) ?: ""
      fun n(k: String): Int = when (val v = m[k]) {
        is Number -> v.toInt()
        is String -> v.toDoubleOrNull()?.toInt() ?: 0
        else -> 0
      }
      val mid = when (val v = m["messageId"]) {
        is String -> v
        is Number -> {
          val d = v.toDouble()
          if (d == Math.floor(d) && abs(d) < 9.2E18) d.toLong().toString() else d.toString()
        }
        else -> ""
      }
      var date = s("dateLabel")
      if (date.isEmpty()) date = formatDate(m["createdAt"])
      return MVItem(
        uri = s("uri"),
        localUri = s("localUri"),
        thumbUri = s("thumbUri"),
        isVideo = s("type") == "video",
        messageId = mid,
        caption = s("caption"),
        senderName = s("senderName"),
        dateLabel = date,
        width = n("width"),
        height = n("height"),
        starred = (m["starred"] as? Boolean) ?: false,
      )
    }

    private fun formatDate(v: Any?): String {
      val ms: Long = when (v) {
        is Number -> {
          val d = v.toDouble()
          if (d <= 0) return ""
          if (d > 1e12) d.toLong() else (d * 1000).toLong()
        }
        is String -> {
          if (v.isEmpty()) return ""
          parseIso(v) ?: return ""
        }
        else -> return ""
      }
      return try {
        val f = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT)
        f.format(java.util.Date(ms))
      } catch (_: Throwable) {
        ""
      }
    }

    private fun parseIso(v: String): Long? {
      // "2026-10-14T12:30:00.123Z" / "...+00:00" / "2026-10-14 12:30:00" (UTC)
      var norm = v.trim().replace(' ', 'T')
      val hasZone = norm.endsWith("Z") || norm.lastIndexOf('+') > 10 || norm.lastIndexOf('-') > 10
      if (!hasZone) norm += "Z"
      // Frações > 3 dígitos (PG: microssegundos) viram milissegundos.
      norm = norm.replace(Regex("\\.(\\d{3})\\d+"), ".$1")
      val patterns = arrayOf("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX")
      for (p in patterns) {
        try {
          val f = java.text.SimpleDateFormat(p, java.util.Locale.US)
          f.isLenient = false
          f.timeZone = java.util.TimeZone.getTimeZone("UTC")
          val d = f.parse(norm)
          if (d != null) return d.time
        } catch (_: Throwable) {}
      }
      return null
    }

    /** file:// / caminho absoluto existente → File; senão null. */
    fun existingFile(s: String): File? {
      if (s.isEmpty()) return null
      val path = when {
        s.startsWith("file://") -> Uri.parse(s).path
        s.startsWith("/") -> s
        else -> null
      } ?: return null
      val f = File(path)
      return if (f.exists() && f.length() > 0) f else null
    }

    /** Modelo do Glide p/ uma fonte (File / content Uri / data: / http). */
    fun glideModel(s: String): Any? {
      if (s.isEmpty()) return null
      existingFile(s)?.let { return it }
      if (s.startsWith("file://") || s.startsWith("/")) return null
      if (s.startsWith("content://")) return Uri.parse(s)
      if (s.startsWith("data:") || s.startsWith("http://") || s.startsWith("https://")) return s
      return null
    }
  }
}

/**
 * Página do pager. `content` é o que o arrasto de fechar move/escala (a
 * própria página leva o translationX do MarginPageTransformer).
 */
@SuppressLint("ViewConstructor")
class MVPageView(context: Context, private val labels: Map<String, String>) : FrameLayout(context) {

  interface Host {
    fun onPageTap()
    fun onPageDoubleTapVideo(page: MVPageView)
    fun onDismissDrag(page: MVPageView, dx: Float, dy: Float)
    fun onDismissRelease(page: MVPageView, dx: Float, dy: Float, vy: Float)
    fun onRetry(page: MVPageView)
    fun onPlayTap(page: MVPageView)
  }

  var host: Host? = null
  val content = FrameLayout(context)
  val zoomView = ZoomImageView(context)
  val posterView = ImageView(context)
  val textureView = TextureView(context)
  private val spinner = ProgressBar(context)
  val bigPlay = ImageButton(context)
  private val errorBox = LinearLayout(context)

  var item: MVItem? = null
    private set
  var position: Int = -1
  private var hasFull = false
  private var token = 0
  private var fullTarget: CustomTarget<Drawable>? = null
  private var thumbTarget: CustomTarget<Drawable>? = null
  private var posterTarget: CustomTarget<Drawable>? = null

  private val slop = ViewConfiguration.get(context).scaledTouchSlop
  private var downRawX = 0f
  private var downRawY = 0f
  private var dragging = false
  private var velocity: VelocityTracker? = null

  private val tapDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(e: MotionEvent): Boolean = true
    override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
      host?.onPageTap()
      return true
    }
    override fun onDoubleTap(e: MotionEvent): Boolean {
      host?.onPageDoubleTapVideo(this@MVPageView)
      return true
    }
  })

  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

  init {
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    clipChildren = false
    addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    zoomView.onSingleTap = { host?.onPageTap() }
    content.addView(zoomView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    posterView.scaleType = ImageView.ScaleType.FIT_CENTER
    content.addView(posterView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    content.addView(textureView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))

    bigPlay.setImageResource(R.drawable.mv_ic_play)
    bigPlay.setColorFilter(Color.WHITE)
    bigPlay.background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(Color.argb(115, 0, 0, 0))
    }
    bigPlay.scaleType = ImageView.ScaleType.CENTER_INSIDE
    bigPlay.setPadding(dp(18f), dp(18f), dp(18f), dp(18f))
    bigPlay.contentDescription = labels["play"]
    bigPlay.setOnClickListener { host?.onPlayTap(this) }
    content.addView(bigPlay, FrameLayout.LayoutParams(dp(72f), dp(72f), Gravity.CENTER))

    spinner.isIndeterminate = true
    spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
    spinner.visibility = View.GONE
    content.addView(spinner, FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.CENTER))

    errorBox.orientation = LinearLayout.VERTICAL
    errorBox.gravity = Gravity.CENTER
    val msg = TextView(context).apply {
      text = labels["loadFailed"] ?: ""
      setTextColor(Color.argb(220, 255, 255, 255))
      textSize = 15f
      gravity = Gravity.CENTER
    }
    val retry = TextView(context).apply {
      text = labels["retry"] ?: ""
      setTextColor(Color.WHITE)
      textSize = 15f
      setPadding(dp(18f), dp(8f), dp(18f), dp(8f))
      background = GradientDrawable().apply {
        cornerRadius = dp(18f).toFloat()
        setColor(Color.argb(46, 255, 255, 255))
      }
      isClickable = true
      setOnClickListener { host?.onRetry(this@MVPageView) }
    }
    errorBox.addView(msg)
    errorBox.addView(retry, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12f) })
    errorBox.visibility = View.GONE
    content.addView(errorBox, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply {
      leftMargin = dp(24f); rightMargin = dp(24f)
    })
  }

  // ─── Bind ────────────────────────────────────────────────────────────────

  fun bind(it: MVItem, pos: Int) {
    recycle()
    item = it
    position = pos
    token += 1
    hasFull = false
    resetTransform()
    errorBox.visibility = View.GONE
    spinner.visibility = View.GONE
    zoomView.visibility = if (it.isVideo) View.GONE else View.VISIBLE
    posterView.visibility = if (it.isVideo) View.VISIBLE else View.GONE
    textureView.visibility = if (it.isVideo) View.VISIBLE else View.GONE
    bigPlay.visibility = if (it.isVideo) View.VISIBLE else View.GONE
    if (it.isVideo) loadPoster() else loadImage()
  }

  fun recycle() {
    token += 1
    val g = Glide.with(context.applicationContext)
    fullTarget?.let { t -> try { g.clear(t) } catch (_: Throwable) {} }
    thumbTarget?.let { t -> try { g.clear(t) } catch (_: Throwable) {} }
    posterTarget?.let { t -> try { g.clear(t) } catch (_: Throwable) {} }
    fullTarget = null
    thumbTarget = null
    posterTarget = null
    zoomView.setImageDrawable(null)
    zoomView.resetZoom()
    posterView.setImageDrawable(null)
  }

  fun resetTransform() {
    content.translationX = 0f
    content.translationY = 0f
    content.scaleX = 1f
    content.scaleY = 1f
  }

  fun showError() {
    spinner.visibility = View.GONE
    bigPlay.visibility = View.GONE
    errorBox.visibility = View.VISIBLE
  }

  fun hideError() {
    errorBox.visibility = View.GONE
  }

  fun setLoading(on: Boolean) {
    spinner.visibility = if (on) View.VISIBLE else View.GONE
  }

  fun isErrorShown(): Boolean = errorBox.visibility == View.VISIBLE

  private fun delayedSpinner(t: Int) {
    postDelayed({
      if (token == t && !hasFull && errorBox.visibility != View.VISIBLE) spinner.visibility = View.VISIBLE
    }, 250)
  }

  private fun request(model: Any, maxPx: Int): RequestBuilder<Drawable> {
    return Glide.with(context.applicationContext)
      .load(model)
      .override(maxPx, maxPx)
      .downsample(DownsampleStrategy.CENTER_INSIDE)
      .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
  }

  private fun loadImage() {
    val it = item ?: return
    val t = token
    val sources = ArrayList<Any>()
    MVItem.glideModel(it.localUri)?.let { m -> sources.add(m) }
    MVItem.glideModel(it.uri)?.let { m -> if (sources.none { s -> s == m }) sources.add(m) }
    val thumb = MVItem.glideModel(it.thumbUri)
    if (thumb != null) {
      val tt = object : CustomTarget<Drawable>() {
        override fun onResourceReady(resource: Drawable, transition: Transition<in Drawable>?) {
          if (token != t || hasFull) return
          zoomView.setImageDrawable(resource)
        }
        override fun onLoadCleared(placeholder: Drawable?) {}
      }
      thumbTarget = tt
      request(thumb, THUMB_PX).into(tt)
    }
    delayedSpinner(t)
    loadFull(sources, 0, t)
  }

  private fun loadFull(sources: List<Any>, i: Int, t: Int) {
    if (i >= sources.size) {
      if (token == t && !hasFull) showError()
      return
    }
    val target = object : CustomTarget<Drawable>() {
      override fun onResourceReady(resource: Drawable, transition: Transition<in Drawable>?) {
        if (token != t) return
        hasFull = true
        spinner.visibility = View.GONE
        errorBox.visibility = View.GONE
        zoomView.setImageDrawable(resource)
        if (resource is android.graphics.drawable.Animatable) {
          try { resource.start() } catch (_: Throwable) {}
        }
      }
      override fun onLoadFailed(errorDrawable: Drawable?) {
        if (token != t) return
        post { loadFull(sources, i + 1, t) }
      }
      override fun onLoadCleared(placeholder: Drawable?) {}
    }
    fullTarget = target
    request(sources[i], FULL_PX).into(target)
  }

  private fun loadPoster() {
    val it = item ?: return
    val model = MVItem.glideModel(it.thumbUri) ?: return
    val t = token
    val target = object : CustomTarget<Drawable>() {
      override fun onResourceReady(resource: Drawable, transition: Transition<in Drawable>?) {
        if (token != t) return
        posterView.setImageDrawable(resource)
      }
      override fun onLoadCleared(placeholder: Drawable?) {}
    }
    posterTarget = target
    request(model, THUMB_PX * 2).into(target)
  }

  /** Ajusta o TextureView ao aspecto do vídeo (fit-center). */
  fun fitVideo(vw: Int, vh: Int, ratio: Float) {
    if (vw <= 0 || vh <= 0) return
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0 || h <= 0) {
      post { fitVideo(vw, vh, ratio) }
      return
    }
    val aspect = (vw * (if (ratio > 0f) ratio else 1f)) / vh.toFloat()
    var tw = w
    var th = w / aspect
    if (th > h) {
      th = h
      tw = h * aspect
    }
    val lp = textureView.layoutParams as FrameLayout.LayoutParams
    lp.width = tw.toInt()
    lp.height = th.toInt()
    lp.gravity = Gravity.CENTER
    textureView.layoutParams = lp
  }

  fun resetVideoLayout() {
    val lp = textureView.layoutParams as FrameLayout.LayoutParams
    lp.width = FrameLayout.LayoutParams.MATCH_PARENT
    lp.height = FrameLayout.LayoutParams.MATCH_PARENT
    textureView.layoutParams = lp
    posterView.visibility = if (item?.isVideo == true) View.VISIBLE else View.GONE
  }

  // ─── Arrasto vertical de fechar ──────────────────────────────────────────

  private fun startsDismiss(ev: MotionEvent): Boolean {
    if (ev.pointerCount != 1) return false
    if (item?.isVideo != true && zoomView.isZoomed()) return false
    val dx = ev.rawX - downRawX
    val dy = ev.rawY - downRawY
    return abs(dy) > slop && abs(dy) > abs(dx) * 1.2f
  }

  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downRawX = ev.rawX
        downRawY = ev.rawY
        dragging = false
        velocity?.recycle()
        velocity = VelocityTracker.obtain()
        velocity?.addMovement(ev)
      }
      MotionEvent.ACTION_MOVE -> {
        velocity?.addMovement(ev)
        if (!dragging && startsDismiss(ev)) {
          dragging = true
          parent?.requestDisallowInterceptTouchEvent(true)
          return true
        }
      }
    }
    return dragging
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    // Só chega aqui quando nenhum filho consumiu (vídeo) ou após interceptar.
    if (!dragging) tapDetector.onTouchEvent(ev)
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downRawX = ev.rawX
        downRawY = ev.rawY
        dragging = false
        velocity?.recycle()
        velocity = VelocityTracker.obtain()
        velocity?.addMovement(ev)
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        velocity?.addMovement(ev)
        if (!dragging && startsDismiss(ev)) {
          dragging = true
          parent?.requestDisallowInterceptTouchEvent(true)
        }
        if (dragging) host?.onDismissDrag(this, ev.rawX - downRawX, ev.rawY - downRawY)
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (dragging) {
          velocity?.addMovement(ev)
          velocity?.computeCurrentVelocity(1000)
          val vy = if (ev.actionMasked == MotionEvent.ACTION_CANCEL) 0f else (velocity?.yVelocity ?: 0f)
          val dx = ev.rawX - downRawX
          val dy = ev.rawY - downRawY
          dragging = false
          parent?.requestDisallowInterceptTouchEvent(false)
          host?.onDismissRelease(this, dx, if (ev.actionMasked == MotionEvent.ACTION_CANCEL) 0f else dy, vy)
        }
        velocity?.recycle()
        velocity = null
        return true
      }
    }
    return true
  }

  companion object {
    const val FULL_PX = 2560
    const val THUMB_PX = 640
  }
}
