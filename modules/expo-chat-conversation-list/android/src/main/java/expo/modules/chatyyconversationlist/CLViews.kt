package expo.modules.chatyyconversationlist

// [2026-10-14 native-home] Peças desenhadas em Canvas da linha (Android):
// avatar (foto/colagem/iniciais + anel de status + online + nota), recibo
// ✓/✓✓, pontinhos de "digitando", bolinha de seleção e spans da prévia.
// Avatares via Glide (já no binário: expo-image → Glide 5.0.5) com cache em
// disco do próprio Glide; get_avatar restrito leva Authorization.

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Build
import android.text.TextPaint
import android.text.style.MetricAffectingSpan
import android.text.style.ReplacementSpan
import android.view.View
import android.view.animation.LinearInterpolator
import androidx.core.content.ContextCompat
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.model.GlideUrl
import com.bumptech.glide.load.model.LazyHeaders
import com.bumptech.glide.request.target.CustomTarget
import com.bumptech.glide.request.transition.Transition
import java.io.File
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

internal object CLAuth {
  /** Bearer da sessão (prop `authToken`). Só vai para tiles marcados `a`. */
  @Volatile var token: String = ""
}

internal fun Context.dp(v: Float): Float = v * resources.displayMetrics.density

internal object CLType {
  fun weight(w: Int): Typeface {
    if (Build.VERSION.SDK_INT >= 28) return Typeface.create(Typeface.DEFAULT, w, false)
    return when {
      w >= 650 -> Typeface.DEFAULT_BOLD
      w >= 500 -> Typeface.create("sans-serif-medium", Typeface.NORMAL)
      else -> Typeface.DEFAULT
    }
  }
}

/** Troca a fonte de um trecho (peso 500/600 em API < 28 também). */
internal class CLTypefaceSpan(private val tf: Typeface) : MetricAffectingSpan() {
  override fun updateDrawState(tp: TextPaint) { tp.typeface = tf }
  override fun updateMeasureState(tp: TextPaint) { tp.typeface = tf }
}

/** Ícone inline centrado na altura do texto (glifo da prévia). */
internal class CLIconSpan(private val d: Drawable, private val size: Int, private val gap: Int) : ReplacementSpan() {
  override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int = size + gap

  override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
    val fm = paint.fontMetrics
    val center = y + (fm.ascent + fm.descent) / 2f
    val t = (center - size / 2f).toInt()
    d.setBounds(0, 0, size, size)
    canvas.save()
    canvas.translate(x, t.toFloat())
    d.draw(canvas)
    canvas.restore()
  }
}

internal fun tintedIcon(ctx: Context, res: Int, color: Int): Drawable? {
  if (res == 0) return null
  val d = ContextCompat.getDrawable(ctx, res)?.mutate() ?: return null
  d.setTint(color)
  return d
}

// ─── Avatar ────────────────────────────────────────────────────────────────

internal class CLAvatarView(ctx: Context) : View(ctx) {
  private var box = ctx.dp(54f)
  private val baseBox = ctx.dp(54f)

  /** [2026-10-15 native-pins] Lado da caixa em dp (54 na linha; fixados = maior). */
  fun setBoxDp(v: Float) {
    val nb = context.dp(v)
    if (abs(nb - box) < 0.5f) return
    box = nb
    tilesKey = "" // recarrega as fotos no tamanho novo no próximo bind
    requestLayout()
    invalidate()
  }

  /** Margem do anel: 4 dp na linha; cresce junto nos avatares maiores. */
  private fun ringGap(): Float = max(context.dp(4f), Math.round(box * 0.075f).toFloat())
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = 0xFFFFFFFF.toInt()
    textAlign = Paint.Align.CENTER
    typeface = CLType.weight(700)
  }
  private val noteText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textAlign = Paint.Align.CENTER
    typeface = CLType.weight(600)
    textSize = ctx.dp(9f)
  }
  private val shaderMatrix = Matrix()
  private val circle = Path()
  private val tmpPath = Path()
  private val rect = RectF()

  private var row = CLRow()
  private var theme = CLTheme(false)
  private var rowBg = 0xFFFFFFFF.toInt()
  private var tilesKey = ""
  private val bitmaps = arrayOfNulls<Bitmap>(4)
  private val targets = arrayOfNulls<CustomTarget<Bitmap>>(4)
  private var channelIcon: Drawable? = null
  private var channelIconDark: Boolean? = null

  fun bind(r: CLRow, t: CLTheme, background: Int) {
    val keyChanged = r.tilesKey != tilesKey
    row = r
    theme = t
    rowBg = background
    if (keyChanged) {
      tilesKey = r.tilesKey
      loadTiles()
    }
    contentDescription = null
    invalidate()
  }

  fun setRowBackground(c: Int) {
    if (c != rowBg) { rowBg = c; invalidate() }
  }

  private val tiles: List<CLTile>
    get() = if (row.tiles.isEmpty()) listOf(CLTile("", false, "", 0)) else row.tiles.take(4)

  private fun tileRects(inner: Float, off: Float): List<RectF> {
    val n = tiles.size
    val h = inner / 2f
    val l = off
    val tp = off
    return when (n) {
      1 -> listOf(RectF(l, tp, l + inner, tp + inner))
      2 -> listOf(RectF(l, tp, l + h, tp + inner), RectF(l + h, tp, l + inner, tp + inner))
      3 -> listOf(RectF(l, tp, l + h, tp + inner), RectF(l + h, tp, l + inner, tp + h), RectF(l + h, tp + h, l + inner, tp + inner))
      else -> listOf(
        RectF(l, tp, l + h, tp + h), RectF(l + h, tp, l + inner, tp + h),
        RectF(l, tp + h, l + h, tp + inner), RectF(l + h, tp + h, l + inner, tp + inner)
      )
    }
  }

  private fun hasRing(): Boolean = row.ring.isNotEmpty() && !row.isGroupish

  private fun loadTiles() {
    val app = context.applicationContext
    for (i in 0 until 4) {
      val old = targets[i]
      if (old != null) {
        try { Glide.with(app).clear(old) } catch (_: Throwable) {}
      }
      targets[i] = null
      bitmaps[i] = null
    }
    if (row.kind == "channel") return
    val inner = if (hasRing()) box - ringGap() * 2f else box
    val rects = tileRects(inner, 0f)
    val key = tilesKey
    tiles.forEachIndexed { i, tile ->
      if (tile.url.isEmpty() || i >= 4) return@forEachIndexed
      val w = max(1, rects[i].width().toInt())
      val h = max(1, rects[i].height().toInt())
      val model: Any? = modelFor(tile)
      if (model == null) return@forEachIndexed
      val target = object : CustomTarget<Bitmap>(w, h) {
        override fun onResourceReady(resource: Bitmap, transition: Transition<in Bitmap>?) {
          if (tilesKey != key) return
          bitmaps[i] = resource
          invalidate()
        }

        override fun onLoadCleared(placeholder: Drawable?) {
          bitmaps[i] = null
          invalidate()
        }
      }
      targets[i] = target
      try {
        Glide.with(app)
          .asBitmap()
          .load(model)
          .override(w, h)
          .centerCrop()
          .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
          .into(target)
      } catch (_: Throwable) {
        targets[i] = null
      }
    }
  }

  private fun modelFor(tile: CLTile): Any? {
    val u = tile.url
    if (u.startsWith("http://") || u.startsWith("https://")) {
      val tok = CLAuth.token
      if (tile.auth && tok.isNotEmpty()) {
        return GlideUrl(u, LazyHeaders.Builder().addHeader("Authorization", "Bearer $tok").build())
      }
      return u
    }
    if (u.startsWith("file://") || u.startsWith("content://")) return Uri.parse(u)
    if (u.startsWith("/")) return File(u)
    if (u.startsWith("data:")) return u
    return null
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val ring = hasRing()
    val inner = if (ring) box - ringGap() * 2f else box
    val off = if (ring) ringGap() else 0f
    val cx = off + inner / 2f
    val cy = off + inner / 2f
    circle.reset()
    circle.addCircle(cx, cy, inner / 2f, Path.Direction.CW)

    if (row.kind == "channel") {
      fill.shader = null
      fill.color = theme.card
      canvas.drawCircle(cx, cy, inner / 2f, fill)
      if (channelIcon == null || channelIconDark != theme.dark) {
        channelIcon = tintedIcon(context, R.drawable.ccl_ic_megaphone, theme.text)
        channelIconDark = theme.dark
      }
      channelIcon?.let {
        val s = context.dp(24f).toInt()
        it.setBounds((cx - s / 2f).toInt(), (cy - s / 2f).toInt(), (cx + s / 2f).toInt(), (cy + s / 2f).toInt())
        it.draw(canvas)
      }
    } else {
      val rects = tileRects(inner, off)
      tiles.forEachIndexed { i, tile ->
        if (i >= rects.size) return@forEachIndexed
        val r = rects[i]
        tmpPath.reset()
        tmpPath.addRect(r, Path.Direction.CW)
        tmpPath.op(circle, Path.Op.INTERSECT)
        val bmp = bitmaps[i]
        if (bmp != null && !bmp.isRecycled) {
          val sh = BitmapShader(bmp, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
          shaderMatrix.reset()
          val sx = r.width() / max(1, bmp.width)
          val sy = r.height() / max(1, bmp.height)
          val sc = max(sx, sy)
          shaderMatrix.setScale(sc, sc)
          shaderMatrix.postTranslate(r.left + (r.width() - bmp.width * sc) / 2f, r.top + (r.height() - bmp.height * sc) / 2f)
          sh.setLocalMatrix(shaderMatrix)
          fill.shader = sh
          canvas.drawPath(tmpPath, fill)
          fill.shader = null
        } else {
          val g = CLTheme.gradient(tile.grad)
          fill.shader = LinearGradient(r.left, r.top, r.right, r.bottom, g[0], g[1], Shader.TileMode.CLAMP)
          canvas.drawPath(tmpPath, fill)
          fill.shader = null
          if (tile.initials.isNotEmpty()) {
            val side = min(r.width(), r.height())
            textPaint.textSize = max(context.dp(9f), side * 0.38f)
            val fm = textPaint.fontMetrics
            canvas.save()
            canvas.clipPath(tmpPath)
            canvas.drawText(tile.initials, r.centerX(), r.centerY() - (fm.ascent + fm.descent) / 2f, textPaint)
            canvas.restore()
          }
        }
      }
    }

    // Anel segmentado (port do AvatarStatusRing.js)
    if (ring) {
      val viewed = row.ring.map { it == '1' }
      val n = max(1, min(viewed.size, 30))
      val sw = context.dp(2.5f)
      val outer = box
      val radius = (outer - sw) / 2f
      val circ = (2.0 * PI * radius).toFloat()
      val gapLen = if (n > 1) min(circ * 0.04f, context.dp(6f)) else 0f
      val seg = circ / n - gapLen
      rect.set(outer / 2f - radius, outer / 2f - radius, outer / 2f + radius, outer / 2f + radius)
      stroke.strokeCap = if (n > 1) Paint.Cap.ROUND else Paint.Cap.BUTT
      for (i in 0 until n) {
        val v = if (i < viewed.size) viewed[i] else true
        stroke.color = if (v) theme.ringCold else theme.ringHot
        stroke.strokeWidth = if (v) context.dp(1.5f) else sw
        val startDeg = -90f + ((i * (seg + gapLen)) / radius) * (180f / PI.toFloat())
        val sweep = if (n > 1) (seg / radius) * (180f / PI.toFloat()) else 360f
        canvas.drawArc(rect, startDeg, sweep, false, stroke)
      }
    }

    // Bolinha online (14 com borda 2.5 na cor do fundo da linha)
    if (row.online) {
      val big = box > baseBox + 0.5f
      val r = if (big) Math.round(box * 0.22f) / 2f else context.dp(7f)
      val c = if (big) box / 2f + box / 2f * 0.7071f else box - context.dp(1f) - r
      fill.shader = null
      fill.color = rowBg
      canvas.drawCircle(c, c, r, fill)
      fill.color = theme.online
      canvas.drawCircle(c, c, r - context.dp(2.5f), fill)
    }

    // Nota (balão acima do avatar; a linha não recorta os filhos)
    if (row.note.isNotEmpty()) {
      val h = context.dp(18f)
      val l = -context.dp(4f)
      val tp = -context.dp(6f)
      rect.set(l, tp, box + context.dp(4f), tp + h)
      fill.shader = null
      fill.color = rowBg
      canvas.drawRoundRect(rect, h / 2f, h / 2f, fill)
      rect.inset(context.dp(1.5f), context.dp(1.5f))
      fill.color = theme.card
      canvas.drawRoundRect(rect, h / 2f, h / 2f, fill)
      noteText.color = theme.text
      val avail = rect.width() - context.dp(8f)
      var txt = row.note
      if (noteText.measureText(txt) > avail) {
        while (txt.isNotEmpty() && noteText.measureText("$txt…") > avail) txt = txt.dropLast(1)
        txt = "$txt…"
      }
      val fm = noteText.fontMetrics
      canvas.drawText(txt, rect.centerX(), rect.centerY() - (fm.ascent + fm.descent) / 2f, noteText)
    }
  }
}

// ─── Recibo ✓ / ✓✓ ─────────────────────────────────────────────────────────

internal class CLReceiptView(ctx: Context) : View(ctx) {
  var receiptState = 0
    private set
  private var blend = 0f // 0 = cinza, 1 = azul
  private var anim: ValueAnimator? = null
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val path = Path()
  var sentColor = 0
  var grayColor = 0
  var readColor = 0

  val contentWidth: Int
    get() = when (receiptState) {
      1 -> context.dp(15f).toInt()
      2, 3 -> context.dp(22f).toInt()
      else -> 0
    }

  fun update(s: Int, animated: Boolean) {
    val old = receiptState
    receiptState = s
    visibility = if (s > 0) VISIBLE else GONE
    anim?.cancel()
    if (animated && old == 2 && s == 3) {
      val a = ValueAnimator.ofFloat(0f, 1f)
      a.duration = 280
      a.addUpdateListener {
        blend = it.animatedValue as Float
        val p = blend
        val sc = if (p < 0.5f) 1f + 0.36f * p else 1.18f - 0.36f * (p - 0.5f)
        scaleX = sc
        scaleY = sc
        invalidate()
      }
      anim = a
      a.start()
    } else {
      blend = if (s == 3) 1f else 0f
      scaleX = 1f
      scaleY = 1f
      invalidate()
    }
  }

  private fun check(dx: Float) {
    val s = context.dp(15f) / 24f
    val oy = (height - context.dp(15f)) / 2f
    path.moveTo(dx + 20 * s, oy + 6 * s)
    path.lineTo(dx + 9 * s, oy + 17 * s)
    path.lineTo(dx + 4 * s, oy + 12 * s)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (receiptState <= 0) return
    path.reset()
    check(0f)
    if (receiptState >= 2) check(context.dp(7f))
    if (blend < 1f) {
      paint.color = if (receiptState == 1) sentColor else grayColor
      paint.alpha = ((1f - blend) * (paint.color ushr 24)).toInt()
      paint.strokeWidth = context.dp(2f)
      canvas.drawPath(path, paint)
    }
    if (blend > 0f) {
      paint.color = readColor
      paint.alpha = (blend * 255).toInt()
      paint.strokeWidth = context.dp(2.6f)
      canvas.drawPath(path, paint)
    }
  }
}

// ─── Digitando… ────────────────────────────────────────────────────────────

internal class CLTypingDots(ctx: Context) : View(ctx) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private var phase = 0f
  private var anim: ValueAnimator? = null
  var color: Int = 0xFF000000.toInt()
    set(v) { field = v; invalidate() }

  fun setActive(on: Boolean) {
    visibility = if (on) VISIBLE else GONE
    if (on && isAttachedToWindow) start() else stop()
  }

  private fun start() {
    if (anim != null) return
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 1000
    a.repeatCount = ValueAnimator.INFINITE
    a.interpolator = LinearInterpolator()
    a.addUpdateListener { phase = it.animatedValue as Float; invalidate() }
    anim = a
    a.start()
  }

  private fun stop() {
    anim?.cancel()
    anim = null
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (visibility == VISIBLE) start()
  }

  override fun onDetachedFromWindow() {
    stop()
    super.onDetachedFromWindow()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val r = context.dp(2f)
    val cy = height / 2f
    for (i in 0 until 3) {
      var p = (phase - i * 0.16f) % 1f
      if (p < 0) p += 1f
      val a = if (p < 0.5f) 0.25f + 1.5f * p else 1f - 1.5f * (p - 0.5f)
      paint.color = color
      paint.alpha = (a.coerceIn(0.25f, 1f) * 255).toInt()
      canvas.drawCircle(context.dp(3f) + i * context.dp(6f), cy, r, paint)
    }
  }
}

// ─── Seleção ───────────────────────────────────────────────────────────────

internal class CLCheckView(ctx: Context) : View(ctx) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  var checked = false
    set(v) { field = v; invalidate() }
  var onColor = 0xFF000000.toInt()
  var tickColor = 0xFFFFFFFF.toInt()
  var borderTint = 0x40000000

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    val c = w / 2f
    val bw = context.dp(2f)
    if (checked) {
      paint.style = Paint.Style.FILL
      paint.color = onColor
      canvas.drawCircle(c, c, c, paint)
      val k = (w * 16f / 26f) / 24f
      val o = (w - w * 16f / 26f) / 2f
      path.reset()
      path.moveTo(o + 20 * k, o + 6 * k)
      path.lineTo(o + 9 * k, o + 17 * k)
      path.lineTo(o + 4 * k, o + 12 * k)
      paint.style = Paint.Style.STROKE
      paint.strokeWidth = bw
      paint.strokeCap = Paint.Cap.ROUND
      paint.strokeJoin = Paint.Join.ROUND
      paint.color = tickColor
      canvas.drawPath(path, paint)
    } else {
      paint.style = Paint.Style.STROKE
      paint.strokeWidth = bw
      paint.color = borderTint
      canvas.drawCircle(c, c, c - bw / 2f, paint)
    }
  }
}
