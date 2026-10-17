package expo.modules.chatyyconversationlist

// [2026-10-15 native-lists] Linha da aba STATUS (Android) desenhada em Canvas:
// cartão arredondado (16 dp de margem, raio 14, 80 dp), avatar 52 com anel
// segmentado (visto/não visto; verde = melhores amigos) ou miniatura do status
// de texto, nome 16 semibold, hora 13 + pílula de contagem. Cabeçalho de
// seção = SLSectionView (MAIÚSCULAS, contagem, chevron em "Silenciados").

import android.annotation.SuppressLint
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
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.MotionEvent
import android.view.View
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.model.GlideUrl
import com.bumptech.glide.load.model.LazyHeaders
import com.bumptech.glide.request.target.CustomTarget
import com.bumptech.glide.request.transition.Transition
import java.io.File
import kotlin.math.max
import kotlin.math.min

@SuppressLint("ViewConstructor")
internal class SLRowView(ctx: Context) : View(ctx) {
  interface Listener {
    fun onPress(id: String)
    fun onPressIn(id: String)
    fun onLongPress(id: String, anchor: View)
  }

  var listener: Listener? = null
  var row = SLRow()
    private set
  private var palette = SLPalette(false)

  private val d = ctx.resources.displayMetrics.density
  private fun dp(v: Float) = v * d

  private val cardPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val namePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(16f); typeface = CLType.weight(600) }
  private val timePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(13f) }
  private val pillText = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = dp(11f); typeface = CLType.weight(700); textAlign = Paint.Align.CENTER
  }
  private val initialsPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = 0xFFFFFFFF.toInt(); textAlign = Paint.Align.CENTER; typeface = CLType.weight(700)
  }
  private val thumbPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
  private val cardRect = RectF()
  private val tmp = RectF()
  private val circle = Path()
  private val starPath = Path() // [2026-10-16 P&B] selo de estrela dos Melhores amigos
  private val shaderMatrix = Matrix()

  private var bitmap: Bitmap? = null
  private var target: CustomTarget<Bitmap>? = null
  private var loadedUrl = ""
  private var pressed = false
  private var thumbLayout: StaticLayout? = null
  private var thumbKey = ""

  private val avatarBox = dp(52f)
  private val cardH = dp(80f)
  private val gap = dp(6f)

  init {
    isClickable = true
    isLongClickable = true
    isFocusable = true
    setOnClickListener { listener?.onPress(row.id) }
    setOnLongClickListener {
      performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
      listener?.onLongPress(row.id, this)
      true
    }
  }

  /**
   * [2026-10-16 motion] Frame do avatar/anel em dp, coordenadas de janela no
   * padrão do measureInWindow do RN (tela − getWindowVisibleDisplayFrame) —
   * o StoryViewerDialog.rnToLocal desfaz exatamente isso. null se não anexado.
   */
  fun avatarWindowRect(): Map<String, Double>? {
    if (!isAttachedToWindow || width <= 0) return null
    return try {
      val loc = IntArray(2)
      getLocationOnScreen(loc)
      val vis = android.graphics.Rect()
      getWindowVisibleDisplayFrame(vis)
      // mesma geometria do onDraw: cartão a 16 dp, avatar a +18 dp, centrado em cardH
      val left = loc[0] - vis.left + dp(16f) + dp(18f)
      val top = loc[1] - vis.top + (cardH - avatarBox) / 2f
      mapOf(
        "x" to (left / d).toDouble(),
        "y" to (top / d).toDouble(),
        "width" to (avatarBox / d).toDouble(),
        "height" to (avatarBox / d).toDouble(),
      )
    } catch (_: Throwable) { null }
  }

  fun bind(r: SLRow, p: SLPalette) {
    row = r
    palette = p
    contentDescription = r.a11y.ifEmpty { r.title }
    if (r.thumbText.isEmpty()) {
      if (r.tileUrl != loadedUrl) loadAvatar(r.tileUrl, r.tileAuth)
    } else {
      clearAvatar()
    }
    invalidate()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), (cardH + gap).toInt())
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { setPressedState(true); listener?.onPressIn(row.id) }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> setPressedState(false)
    }
    return super.onTouchEvent(event)
  }

  private fun setPressedState(on: Boolean) {
    if (pressed == on) return
    pressed = on
    animate().scaleX(if (on) 0.985f else 1f).scaleY(if (on) 0.985f else 1f).setDuration(if (on) 60 else 180).start()
    invalidate()
  }

  // ─── avatar ────────────────────────────────────────────────────────────

  private fun clearAvatar() {
    val old = target
    if (old != null) {
      try { Glide.with(context.applicationContext).clear(old) } catch (_: Throwable) {}
    }
    target = null
    bitmap = null
    loadedUrl = ""
  }

  private fun modelFor(u: String, auth: Boolean): Any? {
    if (u.startsWith("http://") || u.startsWith("https://")) {
      val tok = CLAuth.token
      if (auth && tok.isNotEmpty()) {
        return GlideUrl(u, LazyHeaders.Builder().addHeader("Authorization", "Bearer $tok").build())
      }
      return u
    }
    if (u.startsWith("file://") || u.startsWith("content://")) return Uri.parse(u)
    if (u.startsWith("/")) return File(u)
    if (u.startsWith("data:")) return u
    return null
  }

  private fun loadAvatar(url: String, auth: Boolean) {
    clearAvatar()
    loadedUrl = url
    if (url.isEmpty()) return
    val model = modelFor(url, auth) ?: return
    val s = avatarBox.toInt()
    val t = object : CustomTarget<Bitmap>(s, s) {
      override fun onResourceReady(resource: Bitmap, transition: Transition<in Bitmap>?) {
        if (loadedUrl != url) return
        bitmap = resource
        invalidate()
      }

      override fun onLoadCleared(placeholder: Drawable?) {
        bitmap = null
        invalidate()
      }
    }
    target = t
    try {
      Glide.with(context.applicationContext)
        .asBitmap()
        .load(model)
        .override(s, s)
        .centerCrop()
        .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
        .into(t)
    } catch (_: Throwable) {
      target = null
    }
  }

  private fun thumbTypeface(id: String): Typeface = when (id) {
    "serif" -> Typeface.create(Typeface.SERIF, Typeface.BOLD)
    "mono" -> Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
    "script" -> Typeface.create("cursive", Typeface.BOLD)
    else -> CLType.weight(700)
  }

  // ─── desenho ───────────────────────────────────────────────────────────

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val p = palette
    val w = width.toFloat()
    cardRect.set(dp(16f), 0f, w - dp(16f), cardH)
    cardPaint.color = if (pressed) blend(p.card, p.press) else p.card
    canvas.drawRoundRect(cardRect, dp(14f), dp(14f), cardPaint)

    // Avatar: 18 dp da borda do cartão, centrado na vertical.
    val left = cardRect.left + dp(18f)
    val cx = left + avatarBox / 2f
    val cy = cardRect.centerY()
    val r = avatarBox / 2f
    circle.reset()
    circle.addCircle(cx, cy, r, Path.Direction.CW)
    if (row.thumbText.isNotEmpty()) {
      fill.shader = null
      fill.color = SLColor.parse(row.thumbBg) ?: 0xFF111111.toInt()
      canvas.drawCircle(cx, cy, r, fill)
      val key = row.thumbText + "|" + row.thumbFont
      if (thumbLayout == null || key != thumbKey) {
        thumbKey = key
        thumbPaint.textSize = max(dp(7f), Math.round(avatarBox / d * 0.15f) * d)
        thumbPaint.typeface = thumbTypeface(row.thumbFont)
        val tw = (avatarBox * 0.8f).toInt()
        thumbLayout = StaticLayout.Builder.obtain(row.thumbText, 0, row.thumbText.length, thumbPaint, tw)
          .setAlignment(Layout.Alignment.ALIGN_CENTER)
          .setMaxLines(3)
          .setEllipsize(TextUtils.TruncateAt.END)
          .build()
      }
      thumbLayout?.let { l ->
        canvas.save()
        canvas.clipPath(circle)
        canvas.translate(cx - l.width / 2f, cy - l.height / 2f)
        l.draw(canvas)
        canvas.restore()
      }
    } else {
      val bmp = bitmap
      if (bmp != null && !bmp.isRecycled) {
        val sh = BitmapShader(bmp, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
        shaderMatrix.reset()
        val sc = max(avatarBox / max(1, bmp.width), avatarBox / max(1, bmp.height))
        shaderMatrix.setScale(sc, sc)
        shaderMatrix.postTranslate(cx - bmp.width * sc / 2f, cy - bmp.height * sc / 2f)
        sh.setLocalMatrix(shaderMatrix)
        fill.shader = sh
        canvas.drawCircle(cx, cy, r, fill)
        fill.shader = null
      } else {
        val g = CLTheme.gradient(row.tileGrad)
        fill.shader = LinearGradient(cx - r, cy - r, cx + r, cy + r, g[0], g[1], Shader.TileMode.CLAMP)
        canvas.drawCircle(cx, cy, r, fill)
        fill.shader = null
        if (row.tileInitials.isNotEmpty()) {
          initialsPaint.textSize = max(dp(9f), avatarBox * 0.38f)
          val fm = initialsPaint.fontMetrics
          canvas.drawText(row.tileInitials, cx, cy - (fm.ascent + fm.descent) / 2f, initialsPaint)
        }
      }
    }

    // Anel segmentado (SegmentedRing do JS: raio 28, traço 3, 6° entre partes).
    val viewed = if (row.ring.isEmpty()) listOf(true) else row.ring.map { it == '1' }
    val n = max(1, min(viewed.size, 30))
    val rr = dp(28f)
    tmp.set(cx - rr, cy - rr, cx + rr, cy + rr)
    val gapDeg = if (n > 1) 6f else 0f
    val seg = (360f - gapDeg * n) / n
    ringPaint.strokeWidth = dp(3f)
    ringPaint.strokeCap = if (n > 1) Paint.Cap.ROUND else Paint.Cap.BUTT
    for (i in 0 until n) {
      val v = viewed.getOrElse(i) { true }
      ringPaint.color = if (v) p.ringViewed else p.ink // [2026-10-16 P&B] sem verde nos Melhores amigos
      canvas.drawArc(tmp, -90f + i * (seg + gapDeg), if (n > 1) seg else 360f, false, ringPaint)
    }
    // [2026-10-16 P&B] Melhores amigos: selinho (tinta P&B) com estrela no canto
    // inferior direito do anel — só enquanto houver parte não vista (igual ao JS).
    if (row.closeFriends && viewed.any { !it }) {
      val bx = cx + rr * 0.7071f
      val by = cy + rr * 0.7071f
      val br = dp(9f)
      fill.shader = null
      fill.color = p.card
      canvas.drawCircle(bx, by, br + dp(2f), fill)
      fill.color = p.ink
      canvas.drawCircle(bx, by, br, fill)
      val outer = br * 0.62f
      val inner = outer * 0.45f
      starPath.reset()
      for (k in 0 until 10) {
        val rad = if (k % 2 == 0) outer else inner
        val a = Math.toRadians((-90.0 + k * 36.0))
        val sx = bx + (rad * Math.cos(a)).toFloat()
        val sy = by + (rad * Math.sin(a)).toFloat()
        if (k == 0) starPath.moveTo(sx, sy) else starPath.lineTo(sx, sy)
      }
      starPath.close()
      fill.color = p.card
      canvas.drawPath(starPath, fill)
    }

    // Textos
    val tx = left + avatarBox + dp(16f)
    val maxW = cardRect.right - dp(18f) - tx
    namePaint.color = p.text
    val name = TextUtils.ellipsize(row.title, namePaint, max(0f, maxW), TextUtils.TruncateAt.END).toString()
    val nfm = namePaint.fontMetrics
    val nameBase = cy - dp(1.5f) - nfm.descent
    canvas.drawText(name, tx, nameBase, namePaint)
    timePaint.color = p.sub
    val tfm = timePaint.fontMetrics
    val timeBase = cy + dp(3f) - tfm.ascent
    canvas.drawText(row.time, tx, timeBase, timePaint)
    if (row.count > 1) {
      val label = row.count.toString()
      val pw = max(dp(16f), pillText.measureText(label) + dp(14f))
      val px = tx + timePaint.measureText(row.time) + dp(8f)
      val pcy = timeBase + (tfm.ascent + tfm.descent) / 2f
      tmp.set(px, pcy - dp(8f), px + pw, pcy + dp(8f))
      fill.color = p.pillBg
      canvas.drawRoundRect(tmp, dp(8f), dp(8f), fill)
      pillText.color = p.sub
      val pfm = pillText.fontMetrics
      canvas.drawText(label, tmp.centerX(), pcy - (pfm.ascent + pfm.descent) / 2f, pillText)
    }
  }

  private fun blend(base: Int, over: Int): Int {
    val a = ((over ushr 24) and 0xFF) / 255f
    fun ch(s: Int) = (((base shr s) and 0xFF) * (1 - a) + ((over shr s) and 0xFF) * a).toInt()
    return (0xFF shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    animate().cancel()
    scaleX = 1f; scaleY = 1f
    pressed = false
  }
}

/** Cabeçalho de seção (14 dp de respiro + 36 dp). */
@SuppressLint("ViewConstructor")
internal class SLSectionView(ctx: Context) : View(ctx) {
  var listener: SLRowView.Listener? = null
  var row = SLRow()
    private set
  private var palette = SLPalette(false)
  private val d = ctx.resources.displayMetrics.density
  private fun dp(v: Float) = v * d
  private val title = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = dp(12f); typeface = CLType.weight(600); letterSpacing = 0.05f
  }
  private val count = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(11f); typeface = CLType.weight(600) }
  private val chev = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE; strokeWidth = dp(2f); strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
  }
  private val path = Path()

  init {
    setOnClickListener {
      if (row.collapsible) {
        performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
        listener?.onPress(row.id)
      }
    }
  }

  fun bind(r: SLRow, p: SLPalette) {
    row = r
    palette = p
    isClickable = r.collapsible
    isFocusable = r.collapsible
    contentDescription = "${r.title}, ${r.count}"
    invalidate()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), dp(50f).toInt())
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    val base = height - dp(10f) - title.fontMetrics.descent
    title.color = palette.sub
    count.color = palette.sub
    var right = w - dp(34f)
    if (row.collapsible) {
      val cx = right - dp(8f)
      val cy = base + (title.fontMetrics.ascent + title.fontMetrics.descent) / 2f
      val s = dp(4f)
      path.reset()
      if (row.expanded) {
        path.moveTo(cx - s, cy + s / 2f); path.lineTo(cx, cy - s / 2f); path.lineTo(cx + s, cy + s / 2f)
      } else {
        path.moveTo(cx - s, cy - s / 2f); path.lineTo(cx, cy + s / 2f); path.lineTo(cx + s, cy - s / 2f)
      }
      chev.color = palette.sub
      canvas.drawPath(path, chev)
      right -= dp(16f) + dp(16f)
    }
    val c = if (row.count > 0) row.count.toString() else ""
    val cw = count.measureText(c)
    canvas.drawText(c, right - cw, base, count)
    val maxW = right - cw - dp(8f) - dp(34f)
    val t = TextUtils.ellipsize(row.title.uppercase(), title, max(0f, maxW), TextUtils.TruncateAt.END).toString()
    canvas.drawText(t, dp(34f), base, title)
  }
}
