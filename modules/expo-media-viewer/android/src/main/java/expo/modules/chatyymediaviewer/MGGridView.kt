package expo.modules.chatyymediaviewer

// [2026-10-16 native-media-grid] Grade NATIVA genérica de miniaturas por URL
// (Android) — mesmo contrato do iOS (ios/MGGridView.swift): RecyclerView +
// GridLayoutManager, seções por mês, selos, 1º quadro de vídeo
// (MediaMetadataRetriever, cache memória+disco), seleção nativa, filhos RN
// 0 = cabeçalho / 1 = rodapé (contêiner que NÃO refaz o layout do Fabric).
// Props idempotentes: lista igual → nada de notifyDataSetChanged; célula
// mantém a imagem do mesmo URI (sem piscar).

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.bumptech.glide.RequestManager
import com.bumptech.glide.load.DataSource
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.engine.GlideException
import com.bumptech.glide.load.model.GlideUrl
import com.bumptech.glide.request.RequestListener
import com.bumptech.glide.request.target.Target
import android.graphics.drawable.Drawable
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

// ─── Modelo ────────────────────────────────────────────────────────────────

internal data class MGItem(
  val key: String,
  val uri: String,
  val videoUri: String,
  val isVideo: Boolean,
  val tl: String,
  val tlDot: Boolean,
  val tr: String,
  val bl: String,
  val blPlay: Boolean,
  val br: String,
  val autoDuration: Boolean,
  val ts: Double,
  val isCreate: Boolean,
  val createLabel: String,
  val a11y: String,
) {
  companion object {
    private fun s(m: Map<*, *>, k: String): String = when (val v = m[k]) {
      null -> ""
      is String -> v
      // número do JS chega Double: 1e14.toString() = "1.0E14" (chave errada p/ ids Snowflake)
      is Double -> if (v == Math.floor(v) && Math.abs(v) < 9.2E18) v.toLong().toString() else v.toString()
      is Number -> v.toString()
      else -> v.toString()
    }

    private fun b(m: Map<*, *>, k: String): Boolean = when (val v = m[k]) {
      is Boolean -> v
      is Number -> v.toInt() != 0
      else -> false
    }

    fun from(m: Map<*, *>): MGItem? {
      val key = s(m, "k")
      if (key.isEmpty()) return null
      return MGItem(
        key = key,
        uri = s(m, "u"),
        videoUri = s(m, "vu"),
        isVideo = b(m, "v"),
        tl = s(m, "tl"),
        tlDot = b(m, "tld"),
        tr = s(m, "tr"),
        bl = s(m, "bl"),
        blPlay = b(m, "blp"),
        br = s(m, "br"),
        autoDuration = b(m, "ad"),
        ts = (m["t"] as? Number)?.toDouble() ?: 0.0,
        isCreate = b(m, "create"),
        createLabel = s(m, "cl"),
        a11y = s(m, "a"),
      )
    }
  }
}

internal sealed class MGEntry {
  object Header : MGEntry()
  object Footer : MGEntry()
  data class Section(val title: String) : MGEntry()
  data class Cell(val item: MGItem, val flatIndex: Int) : MGEntry()
}

internal object MGColor {
  fun parse(v: Any?): Int? {
    val s0 = (v as? String)?.trim() ?: return null
    var s = if (s0.startsWith("#")) s0.substring(1) else s0
    if (s.length == 3) s = s.map { "$it$it" }.joinToString("")
    return try {
      when (s.length) {
        6 -> (0xff shl 24) or s.toLong(16).toInt()
        8 -> { val n = s.toLong(16); ((n and 0xff).toInt() shl 24) or ((n shr 8).toInt() and 0xffffff) }
        else -> null
      }
    } catch (_: Throwable) { null }
  }
}

/** Chave de cache do Glide sem `exp`/`sig` (URL assinada do CDN muda a cada janela). */
internal class MGGlideUrl(url: String) : GlideUrl(url) {
  private val ck: String = stable(url)
  override fun getCacheKey(): String = ck

  companion object {
    fun stable(u: String): String {
      val q = u.indexOf('?')
      if (!u.startsWith("http") || q < 0) return u
      val params = u.substring(q + 1).split('&').filter { !it.startsWith("exp=") && !it.startsWith("sig=") }
      return if (params.isEmpty()) u.substring(0, q) else u.substring(0, q) + "?" + params.joinToString("&")
    }
  }
}

// ─── 1º quadro + duração de vídeo ──────────────────────────────────────────

internal object MGVideoFrames {
  private val main = Handler(Looper.getMainLooper())
  private val pool = Executors.newFixedThreadPool(2)
  private val memory = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
    override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
  }
  private val durations = HashMap<String, Double>() // só na main
  private val waiters = HashMap<String, MutableList<(Bitmap?, Double) -> Unit>>() // só na main

  fun cachedBitmap(url: String): Bitmap? = memory.get(url)
  fun cachedDuration(url: String): Double? = durations[url]

  private fun hash(s: String): String {
    val d = MessageDigest.getInstance("SHA-256").digest(MGGlideUrl.stable(s).toByteArray())
    return d.take(16).joinToString("") { String.format("%02x", it) }
  }

  fun load(ctx: Context, url: String, maxPx: Int, done: (Bitmap?, Double) -> Unit) {
    if (url.isEmpty()) { done(null, 0.0); return }
    memory.get(url)?.let { done(it, durations[url] ?: 0.0); return }
    waiters[url]?.let { it.add(done); return }
    waiters[url] = mutableListOf(done)
    val app = ctx.applicationContext
    pool.execute {
      var bmp: Bitmap? = null
      var dur = 0.0
      try {
        val dir = File(app.cacheDir, "chatyy-media-grid").apply { mkdirs() }
        val h = hash(url)
        val jf = File(dir, "$h.jpg")
        val df = File(dir, "$h.dur")
        if (jf.exists()) {
          bmp = BitmapFactory.decodeFile(jf.absolutePath)
          dur = try { df.readText().toDouble() } catch (_: Throwable) { 0.0 }
        }
        if (bmp == null) {
          val r = MediaMetadataRetriever()
          try {
            when {
              url.startsWith("http") -> r.setDataSource(url, HashMap())
              url.startsWith("content:") -> r.setDataSource(app, Uri.parse(url))
              url.startsWith("file:") -> r.setDataSource(Uri.parse(url).path)
              else -> r.setDataSource(url)
            }
            val raw = if (Build.VERSION.SDK_INT >= 27) {
              r.getScaledFrameAtTime(100_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, maxPx, maxPx)
            } else {
              r.getFrameAtTime(100_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            }
            bmp = raw?.let { scaleDown(it, maxPx) }
            dur = (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull() ?: 0.0) / 1000.0
          } finally {
            try { r.release() } catch (_: Throwable) {}
          }
          bmp?.let { b ->
            try { FileOutputStream(jf).use { b.compress(Bitmap.CompressFormat.JPEG, 80, it) } } catch (_: Throwable) {}
            if (dur > 0) try { df.writeText(dur.toString()) } catch (_: Throwable) {}
          }
        }
      } catch (_: Throwable) {}
      val fb = bmp
      val fd = dur
      main.post {
        if (fb != null) memory.put(url, fb)
        if (fd > 0) durations[url] = fd
        val list = waiters.remove(url) ?: emptyList()
        for (cb in list) cb(fb, fd)
      }
    }
  }

  private fun scaleDown(b: Bitmap, maxPx: Int): Bitmap {
    val m = max(b.width, b.height)
    if (m <= maxPx || maxPx <= 0) return b
    val k = maxPx.toFloat() / m
    return Bitmap.createScaledBitmap(b, max(1, (b.width * k).toInt()), max(1, (b.height * k).toInt()), true)
  }

  fun format(secs: Double): String {
    val t = Math.round(secs).toInt()
    return if (t >= 3600) String.format(Locale.US, "%d:%02d:%02d", t / 3600, (t % 3600) / 60, t % 60)
    else String.format(Locale.US, "%d:%02d", t / 60, t % 60)
  }
}

// ─── Glifos desenhados (sem recursos) ──────────────────────────────────────

internal class MGGlyph(ctx: Context) : View(ctx) {
  var kind: String = ""
    set(v) { if (field != v) { field = v; invalidate() } }
  var color: Int = Color.WHITE
    set(v) { if (field != v) { field = v; paint.color = v; invalidate() } }
  var accent: Int = Color.rgb(0, 122, 255)

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
  private val path = Path()
  private val rect = RectF()

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    val h = height.toFloat()
    val cx = w / 2f
    val cy = h / 2f
    val s = min(w, h)
    path.reset()
    when (kind) {
      "play" -> {
        paint.style = Paint.Style.FILL
        val r = s * 0.30f
        path.moveTo(cx - r * 0.75f, cy - r)
        path.lineTo(cx + r, cy)
        path.lineTo(cx - r * 0.75f, cy + r)
        path.close()
        canvas.drawPath(path, paint)
      }
      "video" -> {
        paint.style = Paint.Style.FILL
        rect.set(cx - s * 0.30f, cy - s * 0.18f, cx + s * 0.10f, cy + s * 0.18f)
        canvas.drawRoundRect(rect, s * 0.06f, s * 0.06f, paint)
        path.moveTo(cx + s * 0.12f, cy - s * 0.04f)
        path.lineTo(cx + s * 0.30f, cy - s * 0.15f)
        path.lineTo(cx + s * 0.30f, cy + s * 0.15f)
        path.lineTo(cx + s * 0.12f, cy + s * 0.04f)
        path.close()
        canvas.drawPath(path, paint)
      }
      "multi" -> {
        paint.style = Paint.Style.FILL
        rect.set(cx - s * 0.18f, cy - s * 0.26f, cx + s * 0.26f, cy + s * 0.18f)
        canvas.drawRoundRect(rect, s * 0.05f, s * 0.05f, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = s * 0.07f
        rect.set(cx - s * 0.28f, cy - s * 0.12f, cx + s * 0.12f, cy + s * 0.28f)
        canvas.drawRoundRect(rect, s * 0.05f, s * 0.05f, paint)
      }
      "plus" -> {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = s * 0.08f
        paint.strokeCap = Paint.Cap.ROUND
        canvas.drawLine(cx - s * 0.3f, cy, cx + s * 0.3f, cy, paint)
        canvas.drawLine(cx, cy - s * 0.3f, cx, cy + s * 0.3f, paint)
      }
      "photo" -> {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = s * 0.06f
        rect.set(cx - s * 0.32f, cy - s * 0.24f, cx + s * 0.32f, cy + s * 0.24f)
        canvas.drawRoundRect(rect, s * 0.06f, s * 0.06f, paint)
        paint.style = Paint.Style.FILL
        canvas.drawCircle(cx + s * 0.14f, cy - s * 0.08f, s * 0.05f, paint)
      }
      "check" -> {
        paint.style = Paint.Style.FILL
        val c = paint.color
        paint.color = accent
        canvas.drawCircle(cx, cy, s * 0.46f, paint)
        paint.color = Color.WHITE
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = s * 0.09f
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        path.moveTo(cx - s * 0.20f, cy)
        path.lineTo(cx - s * 0.05f, cy + s * 0.15f)
        path.lineTo(cx + s * 0.22f, cy - s * 0.14f)
        canvas.drawPath(path, paint)
        paint.color = c
      }
      "circle" -> {
        paint.style = Paint.Style.FILL
        val c = paint.color
        paint.color = Color.argb(60, 0, 0, 0)
        canvas.drawCircle(cx, cy, s * 0.44f, paint)
        paint.color = Color.WHITE
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = s * 0.07f
        canvas.drawCircle(cx, cy, s * 0.42f, paint)
        paint.color = c
      }
    }
  }
}

// ─── Célula ────────────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class MGCellView(ctx: Context, private val glide: RequestManager) : FrameLayout(ctx) {
  private val density = resources.displayMetrics.density
  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()

  val thumb = ImageView(ctx)
  private val placeholderGlyph = MGGlyph(ctx)
  private val gradient = View(ctx)
  private val tlChip = FrameLayout(ctx)
  private val tlDot = View(ctx)
  private val tlLabel = TextView(ctx)
  private val trBadge = FrameLayout(ctx)
  private val trGlyph = MGGlyph(ctx)
  private val blGlyph = MGGlyph(ctx)
  private val blLabel = TextView(ctx)
  private val brLabel = TextView(ctx)
  private val dim = View(ctx)
  private val check = MGGlyph(ctx)
  private val createGlyph = MGGlyph(ctx)
  private val createLabel = TextView(ctx)

  var key: String = ""
    private set
  private var currentSrc = ""
  private var item: MGItem? = null
  private var selectionOn = false
  private var selectedOn = false
  private var autoBr = ""
  private var radiusPx = 0f

  init {
    thumb.scaleType = ImageView.ScaleType.CENTER_CROP
    addView(thumb, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    placeholderGlyph.kind = "photo"
    placeholderGlyph.color = Color.argb(150, 255, 255, 255)
    addView(placeholderGlyph, LayoutParams(dp(30f), dp(30f), Gravity.CENTER))

    gradient.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(Color.TRANSPARENT, Color.argb(128, 0, 0, 0)))
    addView(gradient, LayoutParams(LayoutParams.MATCH_PARENT, 0, Gravity.BOTTOM))

    val chipBg = GradientDrawable().apply { cornerRadius = dp(4f).toFloat(); setColor(Color.argb(140, 0, 0, 0)) }
    tlChip.background = chipBg
    tlChip.setPadding(dp(6f), dp(2f), dp(6f), dp(2f))
    val dotBg = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.rgb(239, 68, 68)) }
    tlDot.background = dotBg
    tlChip.addView(tlDot, LayoutParams(dp(6f), dp(6f), Gravity.CENTER_VERTICAL or Gravity.START))
    tlLabel.setTextColor(Color.WHITE)
    tlLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
    tlLabel.typeface = Typeface.DEFAULT_BOLD
    tlLabel.maxLines = 1
    tlChip.addView(tlLabel, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER_VERTICAL))
    addView(tlChip, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
      leftMargin = dp(6f); topMargin = dp(6f)
    })

    trBadge.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.argb(97, 0, 0, 0)) }
    trBadge.addView(trGlyph, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(trBadge, LayoutParams(dp(22f), dp(22f), Gravity.TOP or Gravity.END).apply { rightMargin = dp(6f); topMargin = dp(6f) })

    blGlyph.kind = "play"
    addView(blGlyph, LayoutParams(dp(12f), dp(14f), Gravity.BOTTOM or Gravity.START).apply { leftMargin = dp(5f); bottomMargin = dp(7f) })
    blLabel.setTextColor(Color.WHITE)
    blLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    blLabel.typeface = Typeface.DEFAULT_BOLD
    blLabel.setShadowLayer(3f, 0f, 0f, Color.argb(128, 0, 0, 0))
    blLabel.maxLines = 1
    addView(blLabel, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
      leftMargin = dp(18f); bottomMargin = dp(5f)
    })

    brLabel.background = GradientDrawable().apply { cornerRadius = dp(4f).toFloat(); setColor(Color.argb(140, 0, 0, 0)) }
    brLabel.setPadding(dp(5f), dp(1f), dp(5f), dp(1f))
    brLabel.setTextColor(Color.WHITE)
    brLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10.5f)
    brLabel.typeface = Typeface.DEFAULT_BOLD
    brLabel.maxLines = 1
    addView(brLabel, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
      rightMargin = dp(6f); bottomMargin = dp(6f)
    })

    dim.setBackgroundColor(Color.argb(72, 255, 255, 255))
    addView(dim, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(check, LayoutParams(dp(24f), dp(24f), Gravity.TOP or Gravity.END).apply { rightMargin = dp(6f); topMargin = dp(6f) })

    createGlyph.kind = "plus"
    addView(createGlyph, LayoutParams(dp(30f), dp(30f), Gravity.CENTER).apply { bottomMargin = dp(14f) })
    createLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    createLabel.typeface = Typeface.DEFAULT_BOLD
    createLabel.gravity = Gravity.CENTER
    addView(createLabel, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply { topMargin = dp(20f) })

    clipToOutline = true
    isClickable = true
    isLongClickable = true
    isFocusable = true
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    // célula quadrada
    super.onMeasure(widthMeasureSpec, widthMeasureSpec)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    (gradient.layoutParams as? LayoutParams)?.let {
      val gh = (h * 0.4f).toInt()
      if (it.height != gh) { it.height = gh; gradient.layoutParams = it }
    }
  }

  fun setRadius(px: Float) {
    if (px == radiusPx) return
    radiusPx = px
    outlineProvider = object : android.view.ViewOutlineProvider() {
      override fun getOutline(view: View, outline: android.graphics.Outline) {
        outline.setRoundRect(0, 0, view.width, view.height, radiusPx)
      }
    }
    invalidateOutline()
  }

  fun bind(it: MGItem, cellPx: Int, placeholder: Int, createBg: Int, createFg: Int, selOn: Boolean, selected: Boolean) {
    item = it
    key = it.key
    selectionOn = selOn
    selectedOn = selected
    contentDescription = it.a11y.ifEmpty { null }

    if (it.isCreate) {
      setBackgroundColor(createBg)
      clearImage()
      thumb.visibility = View.GONE
      placeholderGlyph.visibility = View.GONE
      createGlyph.visibility = View.VISIBLE
      createLabel.visibility = View.VISIBLE
      createGlyph.color = createFg
      createLabel.setTextColor(createFg)
      createLabel.text = it.createLabel
      listOf<View>(gradient, tlChip, trBadge, blGlyph, blLabel, brLabel, dim, check).forEach { v -> v.visibility = View.GONE }
      return
    }
    createGlyph.visibility = View.GONE
    createLabel.visibility = View.GONE
    thumb.visibility = View.VISIBLE
    setBackgroundColor(placeholder)

    val useFrame = it.uri.isEmpty() && it.isVideo && it.videoUri.isNotEmpty()
    val src = if (useFrame) "vf:" + it.videoUri else it.uri
    autoBr = ""
    if (src != currentSrc || thumb.drawable == null) {
      currentSrc = src
      when {
        src.isEmpty() -> clearImage()
        useFrame -> loadFrame(it.videoUri, cellPx, src)
        else -> {
          val want = src
          val model: Any = if (src.startsWith("http")) MGGlideUrl(src) else src
          try {
            glide.load(model)
              .override(cellPx, cellPx)
              .centerCrop()
              .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
              .listener(object : RequestListener<Drawable> {
                override fun onLoadFailed(e: GlideException?, model: Any?, target: Target<Drawable>, isFirstResource: Boolean): Boolean {
                  val cur = item
                  if (cur != null && currentSrc == want && cur.isVideo && cur.videoUri.isNotEmpty()) {
                    post { loadFrame(cur.videoUri, cellPx, want) }
                  }
                  return false
                }

                override fun onResourceReady(resource: Drawable, model: Any, target: Target<Drawable>?, dataSource: DataSource, isFirstResource: Boolean): Boolean {
                  placeholderGlyph.visibility = View.GONE
                  return false
                }
              })
              .into(thumb)
          } catch (_: Throwable) {}
        }
      }
    }
    if (useFrame && it.autoDuration && it.br.isEmpty()) {
      MGVideoFrames.cachedDuration(it.videoUri)?.let { d -> if (d > 0) autoBr = MGVideoFrames.format(d) }
    }
    placeholderGlyph.visibility = if (thumb.drawable == null) View.VISIBLE else View.GONE
    applyBadges()
  }

  private fun clearImage() {
    try { glide.clear(thumb) } catch (_: Throwable) {}
    thumb.setImageDrawable(null)
  }

  private fun loadFrame(videoUri: String, cellPx: Int, want: String) {
    val cached = MGVideoFrames.cachedBitmap(videoUri)
    if (cached != null) {
      try { glide.clear(thumb) } catch (_: Throwable) {}
      thumb.setImageBitmap(cached)
      placeholderGlyph.visibility = View.GONE
      return
    }
    if (currentSrc != want) return
    try { glide.clear(thumb) } catch (_: Throwable) {}
    thumb.setImageDrawable(null)
    MGVideoFrames.load(context, videoUri, cellPx) { bmp, dur ->
      if (currentSrc != want) return@load
      if (bmp != null) {
        thumb.setImageBitmap(bmp)
        thumb.alpha = 0f
        thumb.animate().alpha(1f).setDuration(140).start()
        placeholderGlyph.visibility = View.GONE
      }
      val cur = item
      if (dur > 0 && cur != null && cur.autoDuration && cur.br.isEmpty()) {
        autoBr = MGVideoFrames.format(dur)
        applyBadges()
      }
    }
  }

  fun setSelection(on: Boolean, selected: Boolean) {
    // [2026-10-16 motion] Marcou agora (modo já ligado) → check em mola. Kill switch: __chatyy_motion_grid.
    val pop = on && selectionOn && selected && !selectedOn && isAttachedToWindow
      && MVMotion.gridSpring && !MVMotion.reduceMotion
    selectionOn = on
    selectedOn = selected
    applyBadges()
    check.animate().cancel()
    if (pop) {
      val sp = MVSpring(0.55f, 20f)
      check.scaleX = 0.55f; check.scaleY = 0.55f
      check.animate().scaleX(1f).scaleY(1f).setInterpolator(sp).setDuration(sp.durationMs).start()
    } else {
      check.scaleX = 1f; check.scaleY = 1f
    }
  }

  private fun vis(b: Boolean) = if (b) View.VISIBLE else View.GONE

  private fun applyBadges() {
    val it = item ?: return
    if (it.isCreate) return
    tlChip.visibility = vis(it.tl.isNotEmpty())
    tlLabel.text = it.tl
    tlDot.visibility = vis(it.tlDot)
    (tlLabel.layoutParams as? LayoutParams)?.let { lp ->
      val m = if (it.tlDot) dp(10f) else 0
      if (lp.leftMargin != m) { lp.leftMargin = m; tlLabel.layoutParams = lp }
    }
    val trKind = when (it.tr) { "video", "play", "multi" -> it.tr; else -> "" }
    trGlyph.kind = trKind
    trBadge.visibility = vis(trKind.isNotEmpty() && !selectionOn)
    blLabel.text = it.bl
    blLabel.visibility = vis(it.bl.isNotEmpty())
    blGlyph.visibility = vis(it.bl.isNotEmpty() && it.blPlay)
    (blLabel.layoutParams as? LayoutParams)?.let { lp ->
      val m = if (it.blPlay) dp(18f) else dp(6f)
      if (lp.leftMargin != m) { lp.leftMargin = m; blLabel.layoutParams = lp }
    }
    val br = it.br.ifEmpty { autoBr }
    brLabel.text = br
    brLabel.visibility = vis(br.isNotEmpty())
    gradient.visibility = vis(it.bl.isNotEmpty() || br.isNotEmpty())
    check.visibility = vis(selectionOn)
    check.kind = if (selectedOn) "check" else "circle"
    dim.visibility = vis(selectionOn && selectedOn)
    isSelected = selectionOn && selectedOn
  }

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    animate().alpha(if (pressed) 0.82f else 1f).setDuration(if (pressed) 60 else 180).start()
  }
}

/** Contêiner do filho RN: mede pela altura que o Fabric deu ao filho e não o reposiciona. */
@SuppressLint("ViewConstructor")
internal class MGChildHost(ctx: Context) : ViewGroup(ctx) {
  private val relayout = View.OnLayoutChangeListener { _, _, top, _, bottom, _, oldTop, _, oldBottom ->
    if (bottom - top != oldBottom - oldTop) post { requestLayout() }
  }

  init {
    clipChildren = false
    clipToPadding = false
  }

  fun attach(child: View) {
    if (child.parent === this) return
    (child.parent as? ViewGroup)?.removeView(child)
    addView(child)
    child.addOnLayoutChangeListener(relayout)
  }

  fun detach(child: View) {
    child.removeOnLayoutChangeListener(relayout)
    if (child.parent === this) removeView(child)
  }

  fun contentHeight(): Int {
    var h = 0
    for (i in 0 until childCount) h = max(h, getChildAt(i).bottom)
    return h
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), contentHeight())
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    // no-op: o Fabric chama layout() nos filhos RN.
  }
}

// ─── Grade ─────────────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
class MGGridView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onItemPress by EventDispatcher()
  val onItemLongPress by EventDispatcher()
  val onSelectionChange by EventDispatcher()
  val onEndReached by EventDispatcher()
  val onScrollBegin by EventDispatcher()
  val onReady by EventDispatcher()

  private val density = context.resources.displayMetrics.density
  private val glide: RequestManager = Glide.with(context.applicationContext)

  private var rawItems: List<MGItem> = emptyList()
  private var itemsSig = ""
  private var entries: List<MGEntry> = emptyList()
  private var flatCount = 0

  private var columns = 3
  private var gapPx = 1
  private var radiusPx = 0f
  private var useSections = false
  private var localeId = ""
  private var bottomInsetPx = 0
  private var bg = Color.WHITE
  private var placeholder = Color.rgb(142, 142, 147)
  private var sectionText = Color.rgb(17, 17, 17)
  private var createBg = Color.rgb(250, 250, 250)
  private var createFg = Color.rgb(17, 17, 17)

  private var selectionOn = false
  private val selected = LinkedHashSet<String>()

  private val rnChildren = ArrayList<View>()
  private val headerHost = MGChildHost(context)
  private val footerHost = MGChildHost(context)

  private var endReachedFor = -1
  private var readySent = false

  private val recycler = RecyclerView(context)
  private val layoutManager = GridLayoutManager(context, 3)
  private val adapter = Adapter()

  init {
    layoutManager.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
      override fun getSpanSize(position: Int): Int =
        if (entries.getOrNull(position) is MGEntry.Cell) 1 else columns
    }
    recycler.layoutManager = layoutManager
    adapter.setHasStableIds(true)
    recycler.adapter = adapter
    recycler.itemAnimator = null
    recycler.clipToPadding = false
    recycler.setItemViewCacheSize(12)
    recycler.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    recycler.addItemDecoration(object : RecyclerView.ItemDecoration() {
      override fun getItemOffsets(outRect: Rect, view: View, parent: RecyclerView, state: RecyclerView.State) {
        val pos = parent.getChildAdapterPosition(view)
        if (entries.getOrNull(pos) !is MGEntry.Cell) { outRect.set(0, 0, 0, 0); return }
        val lp = view.layoutParams as? GridLayoutManager.LayoutParams
        val col = lp?.spanIndex ?: 0
        outRect.left = col * gapPx / columns
        outRect.right = gapPx - (col + 1) * gapPx / columns
        outRect.top = 0
        outRect.bottom = gapPx
      }
    })
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_DRAGGING) onScrollBegin(mapOf<String, Any>())
      }

      override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) { checkEnd() }
    })
    addView(recycler, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    setBackgroundColor(bg)
  }

  // ─── props (idempotentes) ───────────────────────────────────────────────

  fun setItems(list: List<*>?) {
    val parsed = (list ?: emptyList<Any?>()).mapNotNull { (it as? Map<*, *>)?.let { m -> MGItem.from(m) } }
    val sb = StringBuilder(parsed.size * 48).append(parsed.size)
    for (it in parsed) {
      sb.append('\u0002').append(it.key).append('\u0001').append(it.uri).append('\u0001').append(it.videoUri)
        .append('\u0001').append(it.isVideo).append(it.tl).append(it.tlDot).append(it.tr).append('\u0001').append(it.bl)
        .append(it.blPlay).append('\u0001').append(it.br).append(it.autoDuration).append((it.ts / 86_400_000).toLong())
        .append(it.isCreate).append(it.createLabel).append('\u0001').append(it.a11y)
    }
    val sig = sb.toString()
    if (sig == itemsSig) return
    itemsSig = sig
    rawItems = parsed
    rebuild()
  }

  fun setColumns(v: Int?) {
    val c = (v ?: 3).coerceIn(1, 8)
    if (c == columns) return
    columns = c
    layoutManager.spanCount = c
    recycler.invalidateItemDecorations()
  }

  fun setSpacing(v: Double?) {
    val g = max(0, Math.round((v ?: 1.0) * density).toInt())
    if (g == gapPx) return
    gapPx = g
    recycler.invalidateItemDecorations()
  }

  fun setRadius(v: Double?) {
    val r = ((v ?: 0.0) * density).toFloat()
    if (r == radiusPx) return
    radiusPx = r
    adapter.notifyItemRangeChanged(0, entries.size, PAYLOAD_RADIUS)
  }

  fun setSections(v: Boolean?) {
    val s = v ?: false
    if (s == useSections) return
    useSections = s
    rebuild()
  }

  fun setLocale(v: String?) {
    val l = v ?: ""
    if (l == localeId) return
    localeId = l
    if (useSections) rebuild()
  }

  fun setMaxContentWidth(@Suppress("UNUSED_PARAMETER") v: Double?) {
    // Android: celulares — a grade usa a largura toda (tablet: TODO).
  }

  fun setContentInsetBottom(v: Double?) {
    val b = Math.round((v ?: 0.0) * density).toInt()
    if (b == bottomInsetPx) return
    bottomInsetPx = b
    recycler.setPadding(0, 0, 0, b)
  }

  fun setTheme(t: Map<String, Any?>?) {
    val m = t ?: emptyMap()
    var changed = false
    MGColor.parse(m["bg"])?.let { if (it != bg) { bg = it; changed = true } }
    MGColor.parse(m["placeholder"])?.let { if (it != placeholder) { placeholder = it; changed = true } }
    MGColor.parse(m["sectionText"])?.let { if (it != sectionText) { sectionText = it; changed = true } }
    MGColor.parse(m["createBg"])?.let { if (it != createBg) { createBg = it; changed = true } }
    MGColor.parse(m["createText"])?.let { if (it != createFg) { createFg = it; changed = true } }
    if (!changed) return
    setBackgroundColor(bg)
    recycler.setBackgroundColor(bg)
    @SuppressLint("NotifyDataSetChanged")
    adapter.notifyDataSetChanged()
  }

  // ─── seleção (dona = nativo) ────────────────────────────────────────────

  fun setSelectionMode(on: Boolean) {
    if (on == selectionOn && (on || selected.isEmpty())) return
    selectionOn = on
    if (!on) selected.clear()
    refreshSelection()
    emitSelection()
  }

  fun beginSelection(key: String?) {
    selectionOn = true
    if (!key.isNullOrEmpty()) selected.add(key)
    refreshSelection()
    emitSelection()
  }

  fun clearSelection() {
    selected.clear()
    selectionOn = false
    refreshSelection()
    emitSelection()
  }

  fun getSelection(): List<String> = selected.toList()

  /**
   * [2026-10-18 tg-viewer] Frame da célula `key` (dp, relativo à área visível da
   * janela — mesmo referencial do sourceRect do viewer) p/ o "voltar voando".
   * Fora da tela + reveal: rola até ela e mede depois do layout. null = não achou.
   */
  fun frameOfKey(key: String, reveal: Boolean, done: (Map<String, Double>?) -> Unit) {
    val pos = entries.indexOfFirst { e -> e is MGEntry.Cell && e.item.key == key }
    if (pos < 0 || key.isEmpty() || !isAttachedToWindow) { done(null); return }
    fun measure(): Map<String, Double>? {
      val v = layoutManager.findViewByPosition(pos) ?: return null
      if (v.width < 2 || v.height < 2) return null
      val loc = IntArray(2)
      v.getLocationOnScreen(loc)
      val vis = Rect()
      v.getWindowVisibleDisplayFrame(vis)
      return mapOf(
        "x" to ((loc[0] - vis.left) / density).toDouble(),
        "y" to ((loc[1] - vis.top) / density).toDouble(),
        "width" to (v.width / density).toDouble(),
        "height" to (v.height / density).toDouble(),
      )
    }
    val first = layoutManager.findFirstCompletelyVisibleItemPosition()
    val last = layoutManager.findLastCompletelyVisibleItemPosition()
    val visible = first != RecyclerView.NO_POSITION && pos in first..last
    if (visible || !reveal) { done(if (visible) measure() else null); return }
    val cellH = layoutManager.findViewByPosition(first)?.height ?: 0
    layoutManager.scrollToPositionWithOffset(pos, max(0, (recycler.height - cellH) / 2))
    recycler.postDelayed({
      val r = try { measure() } catch (_: Throwable) { null }
      done(r)
    }, 48)
  }

  fun scrollToTop(animated: Boolean) {
    if (animated) recycler.smoothScrollToPosition(0) else recycler.scrollToPosition(0)
  }

  private fun toggle(key: String) {
    if (!selected.remove(key)) selected.add(key)
    performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    refreshSelection()
    emitSelection()
  }

  private fun refreshSelection() {
    for (i in 0 until recycler.childCount) {
      val v = recycler.getChildAt(i) as? MGCellView ?: continue
      v.setSelection(selectionOn, selected.contains(v.key))
    }
  }

  private fun emitSelection() {
    val keys = selected.toList()
    onSelectionChange(mapOf("active" to selectionOn, "keys" to keys, "count" to keys.size))
  }

  // ─── dados ──────────────────────────────────────────────────────────────

  private fun rebuild() {
    val out = ArrayList<MGEntry>(rawItems.size + 8)
    out.add(MGEntry.Header)
    if (useSections) {
      val loc = if (localeId.isEmpty()) Locale.getDefault() else Locale.forLanguageTag(localeId.replace('_', '-'))
      val same = SimpleDateFormat("LLLL", loc)
      val other = SimpleDateFormat("LLLL yyyy", loc)
      val cal = Calendar.getInstance()
      val nowYear = cal.get(Calendar.YEAR)
      var lastKey = Int.MIN_VALUE
      rawItems.forEachIndexed { i, it ->
        if (it.ts > 0) {
          cal.timeInMillis = it.ts.toLong()
          val y = cal.get(Calendar.YEAR)
          val m = cal.get(Calendar.MONTH)
          val k = y * 100 + m
          if (k != lastKey) {
            val raw = (if (y == nowYear) same else other).format(Date(it.ts.toLong()))
            out.add(MGEntry.Section(raw.replaceFirstChar { c -> if (c.isLowerCase()) c.titlecase(loc) else c.toString() }))
            lastKey = k
          }
        }
        out.add(MGEntry.Cell(it, i))
      }
    } else {
      rawItems.forEachIndexed { i, it -> out.add(MGEntry.Cell(it, i)) }
    }
    out.add(MGEntry.Footer)
    entries = out
    flatCount = rawItems.size
    val keys = rawItems.mapTo(HashSet()) { it.key }
    if (selected.any { !keys.contains(it) }) {
      selected.retainAll(keys)
      emitSelection()
    }
    endReachedFor = -1
    @SuppressLint("NotifyDataSetChanged")
    adapter.notifyDataSetChanged()
    if (!readySent) {
      readySent = true
      post { onReady(mapOf("count" to flatCount)) }
    }
  }

  private fun checkEnd() {
    if (flatCount <= 0) return
    val last = layoutManager.findLastVisibleItemPosition()
    if (last >= entries.size - 1 - columns * 3 && endReachedFor != flatCount) {
      endReachedFor = flatCount
      onEndReached(mapOf("count" to flatCount))
    }
  }

  private fun cellPx(): Int {
    val w = if (recycler.width > 0) recycler.width else resources.displayMetrics.widthPixels
    return min(640, max(64, w / columns))
  }

  // ─── filhos RN ──────────────────────────────────────────────────────────

  fun addRnChild(child: View, index: Int) {
    val i = index.coerceIn(0, rnChildren.size)
    rnChildren.add(i, child)
    reattachChildren()
  }

  fun rnChildCount(): Int = rnChildren.size

  fun rnChildAt(index: Int): View? = rnChildren.getOrNull(index)

  fun removeRnChild(child: View) {
    headerHost.detach(child)
    footerHost.detach(child)
    rnChildren.remove(child)
    reattachChildren()
  }

  fun removeRnChildAt(index: Int) {
    val c = rnChildren.getOrNull(index) ?: return
    removeRnChild(c)
  }

  private fun reattachChildren() {
    rnChildren.forEachIndexed { i, v -> if (i == 0) headerHost.attach(v) else footerHost.attach(v) }
    headerHost.requestLayout()
    footerHost.requestLayout()
  }

  fun destroy() {
    try { glide.onStop() } catch (_: Throwable) {}
  }

  // ─── adapter ────────────────────────────────────────────────────────────

  private class HostHolder(v: View) : RecyclerView.ViewHolder(v)
  private class SectionHolder(val label: TextView) : RecyclerView.ViewHolder(label)
  private class CellHolder(val cell: MGCellView) : RecyclerView.ViewHolder(cell)

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = entries.size

    override fun getItemViewType(position: Int): Int = when (entries[position]) {
      is MGEntry.Header -> TYPE_HEADER
      is MGEntry.Footer -> TYPE_FOOTER
      is MGEntry.Section -> TYPE_SECTION
      is MGEntry.Cell -> TYPE_CELL
    }

    override fun getItemId(position: Int): Long = when (val e = entries[position]) {
      is MGEntry.Header -> 1L
      is MGEntry.Footer -> 2L
      is MGEntry.Section -> ("s:" + e.title).hashCode().toLong() shl 1
      is MGEntry.Cell -> (("c:" + e.item.key).hashCode().toLong() shl 1) or 1L
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      when (viewType) {
        TYPE_HEADER, TYPE_FOOTER -> {
          val host = if (viewType == TYPE_HEADER) headerHost else footerHost
          (host.parent as? ViewGroup)?.removeView(host)
          host.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
          val h = HostHolder(host)
          h.setIsRecyclable(false)
          return h
        }
        TYPE_SECTION -> {
          val tv = TextView(parent.context)
          tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
          tv.typeface = Typeface.DEFAULT_BOLD
          tv.gravity = Gravity.CENTER_VERTICAL
          val p = (14 * density).toInt()
          tv.setPadding(p, 0, p, 0)
          tv.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, (38 * density).toInt())
          return SectionHolder(tv)
        }
        else -> {
          val cell = MGCellView(parent.context, glide)
          cell.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
          val holder = CellHolder(cell)
          cell.setOnClickListener {
            val pos = holder.bindingAdapterPosition
            val e = entries.getOrNull(pos) as? MGEntry.Cell ?: return@setOnClickListener
            onCellPress(cell, e)
          }
          cell.setOnLongClickListener {
            val pos = holder.bindingAdapterPosition
            val e = entries.getOrNull(pos) as? MGEntry.Cell ?: return@setOnLongClickListener false
            if (e.item.isCreate) return@setOnLongClickListener false
            cell.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            onItemLongPress(mapOf("key" to e.item.key, "index" to e.flatIndex, "selectionActive" to selectionOn))
            true
          }
          return holder
        }
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
      if (payloads.contains(PAYLOAD_RADIUS) && holder is CellHolder) {
        holder.cell.setRadius(radiusPx)
        return
      }
      onBindViewHolder(holder, position)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      when (val e = entries[position]) {
        is MGEntry.Section -> {
          val tv = (holder as SectionHolder).label
          tv.text = e.title
          tv.setTextColor(sectionText)
          tv.setBackgroundColor(bg)
          tv.visibility = if (e.title.isEmpty()) View.GONE else View.VISIBLE
        }
        is MGEntry.Cell -> {
          val c = (holder as CellHolder).cell
          c.setRadius(radiusPx)
          c.bind(e.item, cellPx(), placeholder, createBg, createFg, selectionOn, selected.contains(e.item.key))
        }
        else -> {}
      }
    }
  }

  private fun onCellPress(cell: MGCellView, e: MGEntry.Cell) {
    if (selectionOn && !e.item.isCreate) {
      toggle(e.item.key)
      return
    }
    val loc = IntArray(2)
    cell.getLocationInWindow(loc)
    onItemPress(mapOf(
      "key" to e.item.key,
      "index" to e.flatIndex,
      "create" to e.item.isCreate,
      "x" to loc[0] / density,
      "y" to loc[1] / density,
      "width" to cell.width / density,
      "height" to cell.height / density,
    ))
  }

  companion object {
    private const val TYPE_HEADER = 1
    private const val TYPE_FOOTER = 2
    private const val TYPE_SECTION = 3
    private const val TYPE_CELL = 4
    private const val PAYLOAD_RADIUS = "radius"
  }
}
