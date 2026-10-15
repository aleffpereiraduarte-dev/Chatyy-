package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] Linhas da aba CANAIS (Android) desenhadas em
// Canvas — espelham ios/CHCells.swift:
//   CHRowView  — canal seguido (avatar 50, nome + selo, prévia, hora,
//                não lidos / seguidores, separador)
//   CHCardView — cartão 180 do Descobrir (fundo escuro + esmaecido, selo de
//                membros, nome, descrição, meta, botão Inscrever)
//   CHPostView — post em bolha (mídia 4:3, texto, hora/visualizações, chips
//                de reação, barra rápida)

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
import android.graphics.drawable.Drawable
import android.net.Uri
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
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

internal interface CHHost {
  fun chPress(id: String)
  fun chAction(id: String, action: String, extra: Map<String, Any?> = emptyMap())
}

/** Um bitmap carregado pelo Glide para uma view (com troca segura de URL). */
internal class CHImageSlot(private val owner: View) {
  var bitmap: Bitmap? = null
    private set
  private var target: CustomTarget<Bitmap>? = null
  private var url = ""

  fun clear() {
    val old = target
    if (old != null) {
      try { Glide.with(owner.context.applicationContext).clear(old) } catch (_: Throwable) {}
    }
    target = null
    bitmap = null
    url = ""
  }

  fun load(u: String, auth: Boolean, w: Int, h: Int) {
    if (u == url && (bitmap != null || target != null)) return
    clear()
    url = u
    if (u.isEmpty() || w <= 0 || h <= 0) return
    val model = modelFor(u, auth) ?: return
    val t = object : CustomTarget<Bitmap>(w, h) {
      override fun onResourceReady(resource: Bitmap, transition: Transition<in Bitmap>?) {
        if (url != u) return
        bitmap = resource
        owner.invalidate()
      }

      override fun onLoadCleared(placeholder: Drawable?) {
        bitmap = null
        owner.invalidate()
      }
    }
    target = t
    try {
      Glide.with(owner.context.applicationContext)
        .asBitmap()
        .load(model)
        .override(w, h)
        .centerCrop()
        .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
        .into(t)
    } catch (_: Throwable) {
      target = null
    }
  }

  companion object {
    fun modelFor(u: String, auth: Boolean): Any? {
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
  }
}

private val shaderMatrix = Matrix()

/** Desenha o bitmap em "cover" dentro de `rect`, recortado por `clip`. */
internal fun chDrawCover(canvas: Canvas, bmp: Bitmap, rect: RectF, clip: Path, paint: Paint) {
  if (bmp.isRecycled) return
  val sh = BitmapShader(bmp, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
  shaderMatrix.reset()
  val sc = max(rect.width() / max(1, bmp.width), rect.height() / max(1, bmp.height))
  shaderMatrix.setScale(sc, sc)
  shaderMatrix.postTranslate(rect.centerX() - bmp.width * sc / 2f, rect.centerY() - bmp.height * sc / 2f)
  sh.setLocalMatrix(shaderMatrix)
  paint.shader = sh
  canvas.drawPath(clip, paint)
  paint.shader = null
}

internal fun chBlend(base: Int, over: Int): Int {
  val a = (over ushr 24) / 255f
  fun ch(s: Int) = (((base shr s) and 0xFF) * (1 - a) + ((over shr s) and 0xFF) * a).toInt() and 0xFF
  return (0xFF shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
}

/** Selo de verificado (círculo cheio + check vazado). */
internal fun chDrawSeal(canvas: Canvas, cx: Float, cy: Float, r: Float, color: Int, bg: Int, paint: Paint) {
  paint.style = Paint.Style.FILL
  paint.color = color
  canvas.drawCircle(cx, cy, r, paint)
  paint.style = Paint.Style.STROKE
  paint.strokeWidth = r * 0.28f
  paint.strokeCap = Paint.Cap.ROUND
  paint.strokeJoin = Paint.Join.ROUND
  paint.color = bg
  val p = Path()
  p.moveTo(cx - r * 0.45f, cy + r * 0.02f)
  p.lineTo(cx - r * 0.1f, cy + r * 0.36f)
  p.lineTo(cx + r * 0.48f, cy - r * 0.3f)
  canvas.drawPath(p, paint)
  paint.style = Paint.Style.FILL
}

// ─── Canal seguido ───────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CHRowView(ctx: Context) : View(ctx) {
  var host: CHHost? = null
  var row = CHRow()
    private set
  private var palette = CHPalette(false)
  private val d = ctx.resources.displayMetrics.density
  private fun dp(v: Float) = v * d

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val namePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(16f); typeface = CLType.weight(600) }
  private val subPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(13f) }
  private val smallPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(11f); textAlign = Paint.Align.RIGHT }
  private val pillText = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = dp(11f); typeface = CLType.weight(700); textAlign = Paint.Align.CENTER
  }
  private val initialsPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = 0xFFFFFFFF.toInt(); textAlign = Paint.Align.CENTER; typeface = CLType.weight(700)
  }
  private val avatar = CHImageSlot(this)
  private val circle = Path()
  private val tmp = RectF()
  private var pressed = false
  private val rowH = dp(78f)
  private val box = dp(50f)

  init {
    isClickable = true
    isFocusable = true
    setOnClickListener {
      performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      host?.chPress(row.id)
    }
  }

  fun bind(r: CHRow, p: CHPalette) {
    row = r
    palette = p
    contentDescription = r.a11y.ifEmpty { r.title }
    avatar.load(r.tileUrl, r.tileAuth, box.toInt(), box.toInt())
    invalidate()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), rowH.toInt())
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { pressed = true; invalidate() }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { pressed = false; invalidate() }
    }
    return super.onTouchEvent(event)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val p = palette
    val w = width.toFloat()
    if (pressed) { fill.color = p.press; canvas.drawRect(0f, 0f, w, rowH, fill) }
    // avatar
    val cx = dp(16f) + box / 2f
    val cy = rowH / 2f
    val r = box / 2f
    circle.reset()
    circle.addCircle(cx, cy, r, Path.Direction.CW)
    val bmp = avatar.bitmap
    if (bmp != null) {
      tmp.set(cx - r, cy - r, cx + r, cy + r)
      chDrawCover(canvas, bmp, tmp, circle, fill)
    } else if (row.tileUrl.isNotEmpty()) {
      val g = CLTheme.gradient(row.tileGrad)
      fill.shader = LinearGradient(cx - r, cy - r, cx + r, cy + r, g[0], g[1], Shader.TileMode.CLAMP)
      canvas.drawCircle(cx, cy, r, fill)
      fill.shader = null
      if (row.tileInitials.isNotEmpty()) {
        initialsPaint.textSize = box * 0.38f
        val fm = initialsPaint.fontMetrics
        canvas.drawText(row.tileInitials, cx, cy - (fm.ascent + fm.descent) / 2f, initialsPaint)
      }
    } else {
      fill.color = p.pill
      canvas.drawCircle(cx, cy, r, fill)
      tintedIcon(context, R.drawable.ccl_ic_megaphone, p.text)?.let { dr ->
        val s = dp(24f).toInt()
        dr.setBounds((cx - s / 2f).toInt(), (cy - s / 2f).toInt(), (cx + s / 2f).toInt(), (cy + s / 2f).toInt())
        dr.draw(canvas)
      }
    }
    // coluna direita
    val right = w - dp(16f)
    smallPaint.color = if (row.unread > 0) p.text else p.sub
    val timeW = smallPaint.measureText(row.time)
    canvas.drawText(row.time, right, dp(30f), smallPaint)
    var colW = timeW
    if (row.unread > 0) {
      val t = if (row.unread > 999) "999+" else row.unread.toString()
      val pw = max(dp(18f), pillText.measureText(t) + dp(10f))
      tmp.set(right - pw, dp(40f), right, dp(58f))
      fill.color = p.ink
      canvas.drawRoundRect(tmp, dp(9f), dp(9f), fill)
      pillText.color = p.inkText
      val fm = pillText.fontMetrics
      canvas.drawText(t, tmp.centerX(), tmp.centerY() - (fm.ascent + fm.descent) / 2f, pillText)
      colW = max(colW, pw)
    } else if (row.meta.isNotEmpty()) {
      smallPaint.color = p.sub
      val mw = min(dp(96f), smallPaint.measureText(row.meta))
      val meta = TextUtils.ellipsize(row.meta, smallPaint, dp(96f), TextUtils.TruncateAt.END).toString()
      canvas.drawText(meta, right, dp(53f), smallPaint)
      colW = max(colW, mw)
    }
    // textos
    val x0 = dp(16f + 50f + 12f)
    val textRight = right - colW - dp(8f)
    val seal = if (row.verified) dp(18f) else 0f
    namePaint.color = p.text
    val name = TextUtils.ellipsize(row.title, namePaint, max(0f, textRight - x0 - seal), TextUtils.TruncateAt.END).toString()
    canvas.drawText(name, x0, dp(33f), namePaint)
    if (row.verified) {
      val nx = x0 + namePaint.measureText(name) + dp(4f) + dp(7f)
      chDrawSeal(canvas, nx, dp(27f), dp(7f), p.text, p.bg, fill)
    }
    subPaint.color = p.sub
    val sub = TextUtils.ellipsize(row.sub.replace('\n', ' '), subPaint, max(0f, textRight - x0), TextUtils.TruncateAt.END).toString()
    canvas.drawText(sub, x0, dp(54f), subPaint)
    // separador
    fill.color = p.line
    canvas.drawRect(dp(16f), rowH - max(1f, d * 0.5f), w, rowH, fill)
  }
}

// ─── Cartão do Descobrir ─────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CHCardView(ctx: Context) : View(ctx) {
  var host: CHHost? = null
  var row = CHRow()
    private set
  var labels = CLLabels()
  private val d = ctx.resources.displayMetrics.density
  private fun dp(v: Float) = v * d

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val titlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = dp(18f); typeface = CLType.weight(700); color = 0xFFFFFFFF.toInt()
    setShadowLayer(dp(3f), 0f, dp(1f), 0x80000000.toInt())
  }
  private val descPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(13f); color = 0xD9FFFFFF.toInt() }
  private val metaPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(11f); typeface = CLType.weight(600); color = 0xC7FFFFFF.toInt() }
  private val btnPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = dp(12f); typeface = CLType.weight(700); color = 0xFFFFFFFF.toInt(); textAlign = Paint.Align.CENTER
  }
  private val badgePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(11f); typeface = CLType.weight(700); color = 0xFFFFFFFF.toInt() }
  private val card = RectF()
  private val btn = RectF()
  private val tmp = RectF()
  private var descLayout: StaticLayout? = null
  private var descKey = ""
  private var pressed = false
  private val cardH = dp(180f)

  init {
    isClickable = true
    isFocusable = true
  }

  fun bind(r: CHRow, l: CLLabels) {
    row = r
    labels = l
    contentDescription = r.a11y.ifEmpty { r.title }
    invalidate()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), (cardH + dp(12f)).toInt())
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        pressed = true
        animate().scaleX(0.98f).scaleY(0.98f).setDuration(60).start()
      }
      MotionEvent.ACTION_UP -> {
        pressed = false
        animate().scaleX(1f).scaleY(1f).setDuration(180).start()
        tmp.set(btn); tmp.inset(-dp(8f), -dp(8f))
        if (tmp.contains(event.x, event.y)) {
          performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
          host?.chAction(row.id, "follow")
        } else if (card.contains(event.x, event.y)) {
          host?.chPress(row.id)
        }
        return true
      }
      MotionEvent.ACTION_CANCEL -> {
        pressed = false
        animate().scaleX(1f).scaleY(1f).setDuration(180).start()
      }
    }
    return true
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    card.set(dp(12f), 0f, w - dp(12f), cardH)
    val rad = dp(18f)
    fill.shader = null
    fill.color = 0xFF111111.toInt()
    canvas.drawRoundRect(card, rad, rad, fill)
    fill.shader = LinearGradient(0f, card.top, 0f, card.bottom,
      intArrayOf(0x0D000000, 0x59000000, 0xC7000000.toInt()), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
    canvas.drawRoundRect(card, rad, rad, fill)
    fill.shader = null
    // selo de membros (canto superior direito)
    val bw = badgePaint.measureText(row.badge)
    val badgeW = dp(9f + 12f + 4f + 9f) + bw
    tmp.set(card.right - dp(12f) - badgeW, card.top + dp(12f), card.right - dp(12f), card.top + dp(36f))
    fill.color = 0x73000000
    canvas.drawRoundRect(tmp, dp(12f), dp(12f), fill)
    tintedIcon(context, R.drawable.ccl_ic_user, 0xFFFFFFFF.toInt())?.let { dr ->
      val s = dp(12f).toInt()
      val ix = tmp.left + dp(9f)
      val iy = tmp.centerY() - s / 2f
      dr.setBounds(ix.toInt(), iy.toInt(), (ix + s).toInt(), (iy + s).toInt())
      dr.draw(canvas)
    }
    val bfm = badgePaint.fontMetrics
    canvas.drawText(row.badge, tmp.left + dp(25f), tmp.centerY() - (bfm.ascent + bfm.descent) / 2f, badgePaint)
    // botão Inscrever / Inscrito
    val label = if (row.member) labels.get("joined", "Inscrito") else labels.get("join", "Inscrever")
    val jw = btnPaint.measureText(label) + dp(28f)
    val bottom = card.bottom - dp(12f)
    btn.set(card.right - dp(14f) - jw, bottom - dp(30f), card.right - dp(14f), bottom)
    if (row.member) {
      stroke.color = 0xB3FFFFFF.toInt()
      stroke.strokeWidth = dp(1.5f)
      canvas.drawRoundRect(btn, dp(15f), dp(15f), stroke)
    } else {
      fill.color = 0xFF111111.toInt()
      canvas.drawRoundRect(btn, dp(15f), dp(15f), fill)
    }
    val fm = btnPaint.fontMetrics
    canvas.drawText(label, btn.centerX(), btn.centerY() - (fm.ascent + fm.descent) / 2f, btnPaint)
    // meta
    val metaW = max(0f, btn.left - dp(8f) - (card.left + dp(14f)))
    val meta = TextUtils.ellipsize(row.meta, metaPaint, metaW, TextUtils.TruncateAt.END).toString()
    val mfm = metaPaint.fontMetrics
    canvas.drawText(meta, card.left + dp(14f), btn.centerY() - (mfm.ascent + mfm.descent) / 2f, metaPaint)
    // descrição (2 linhas) + título, de baixo p/ cima
    var y = btn.top - dp(6f)
    val inner = (card.width() - dp(28f)).toInt()
    if (row.desc.isNotEmpty() && inner > 0) {
      val key = row.desc + "|" + inner
      if (descLayout == null || key != descKey) {
        descKey = key
        descLayout = StaticLayout.Builder.obtain(row.desc, 0, row.desc.length, descPaint, inner)
          .setMaxLines(2)
          .setEllipsize(TextUtils.TruncateAt.END)
          .setLineSpacing(0f, 1f)
          .build()
      }
      descLayout?.let { l ->
        y -= l.height
        canvas.save()
        canvas.translate(card.left + dp(14f), y)
        l.draw(canvas)
        canvas.restore()
        y -= dp(4f)
      }
    }
    val title = TextUtils.ellipsize(row.title, titlePaint, (card.width() - dp(28f)), TextUtils.TruncateAt.END).toString()
    canvas.drawText(title, card.left + dp(14f), y - titlePaint.fontMetrics.descent, titlePaint)
  }
}

// ─── Post de canal ───────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CHPostView(ctx: Context) : View(ctx) {
  var host: CHHost? = null
  var row = CHRow()
    private set
  private var palette = CHPalette(false)
  private var quick: List<String> = emptyList()
  private val d = ctx.resources.displayMetrics.density
  private fun dp(v: Float) = v * d

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(15f) }
  private val footPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(11f); textAlign = Paint.Align.RIGHT }
  private val emojiPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(14f) }
  private val countPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(12f); typeface = CLType.weight(500) }
  private val quickPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(18f); textAlign = Paint.Align.CENTER }
  private val media = CHImageSlot(this)
  private val clip = Path()
  private val tmp = RectF()

  // layout calculado
  private var lw = -1
  private val bubble = RectF()
  private val mediaRect = RectF()
  private var textLayout: StaticLayout? = null
  private var textTop = 0f
  private var footY = 0f
  private val chips = ArrayList<RectF>()
  private val quickRects = ArrayList<RectF>()
  private var totalH = 0
  private var popIndex = -1
  private var popKind = 0
  private var popAt = 0L

  private val gestures = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(e: MotionEvent): Boolean = true
    override fun onSingleTapUp(e: MotionEvent): Boolean {
      handleTap(e.x, e.y)
      return true
    }
    override fun onLongPress(e: MotionEvent) {
      if (!bubble.contains(e.x, e.y)) return
      performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      host?.chAction(row.id, "longpress")
    }
  })

  fun bind(r: CHRow, p: CHPalette, q: List<String>) {
    val sizeChanged = r.text != row.text || r.rx != row.rx || r.quick != row.quick || r.hasMedia != row.hasMedia || q != quick
    row = r
    palette = p
    quick = q
    contentDescription = listOf(r.text, r.time).filter { it.isNotEmpty() }.joinToString(", ")
    if (sizeChanged) { lw = -1; requestLayout() }
    if (r.hasMedia && r.mediaKind == "image") {
      val mw = max(1, resources.displayMetrics.widthPixels - dp(32f).toInt())
      media.load(r.mediaUrl, false, mw, (mw * 3 / 4))
    } else {
      media.clear()
    }
    invalidate()
  }

  private fun computeLayout(width: Int) {
    if (width == lw) return
    lw = width
    val bw = max(dp(60f), width - dp(24f))
    val pad = dp(12f)
    val inner = bw - pad * 2
    if (row.hasMedia) {
      val mw = bw - dp(8f)
      mediaRect.set(dp(16f), dp(10f), dp(16f) + mw, dp(10f) + mw * 3f / 4f)
    } else {
      mediaRect.setEmpty()
    }
    // y relativo à bolha (topo da bolha = 6 dp)
    var y = if (row.hasMedia) mediaRect.bottom - dp(6f) + dp(8f) else pad - dp(2f)
    if (row.text.isNotEmpty() && inner > 0) {
      textPaint.color = palette.text
      textLayout = StaticLayout.Builder.obtain(row.text, 0, row.text.length, textPaint, inner.toInt())
        .setLineSpacing(dp(22f) - textPaint.fontSpacing, 1f)
        .setIncludePad(false)
        .build()
      textTop = y
      y += max(dp(22f), textLayout!!.height.toFloat()) + dp(4f)
    } else {
      textLayout = null
    }
    footY = y
    y += dp(14f)
    chips.clear()
    val rx = row.reactions
    if (rx.isNotEmpty()) {
      y += dp(8f)
      var x = pad
      var rowY = y
      for (r in rx) {
        val cw = dp(8f) + emojiPaint.measureText(r.emoji) + dp(4f) + countPaint.measureText(r.count.toString()) + dp(8f)
        if (x > pad && x + cw > pad + inner) { x = pad; rowY += dp(28f + 6f) }
        chips.add(RectF(x, rowY, x + cw, rowY + dp(28f)))
        x += cw + dp(6f)
      }
      y = rowY + dp(28f)
    }
    quickRects.clear()
    if (row.quick && quick.isNotEmpty()) {
      y += dp(6f)
      var x = pad - dp(4f)
      for (i in quick.indices) {
        quickRects.add(RectF(x, y, x + dp(34f), y + dp(34f)))
        x += dp(38f)
        if (x + dp(34f) > pad + inner + dp(4f)) break
      }
      y += dp(34f)
    }
    y += dp(10f)
    bubble.set(dp(12f), dp(6f), dp(12f) + bw, dp(6f) + y)
    totalH = (bubble.bottom + dp(6f)).toInt()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    lw = -1
    computeLayout(w)
    setMeasuredDimension(w, totalH)
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    gestures.onTouchEvent(event)
    return true
  }

  private fun handleTap(x: Float, y: Float) {
    val bx = x - bubble.left
    val by = y - bubble.top
    chips.forEachIndexed { i, r ->
      tmp.set(r); tmp.inset(-dp(3f), -dp(3f))
      if (tmp.contains(bx, by)) {
        val e = row.reactions.getOrNull(i) ?: return
        pop(1, i)
        host?.chAction(row.id, "react", mapOf("emoji" to e.emoji))
        return
      }
    }
    quickRects.forEachIndexed { i, r ->
      if (r.contains(bx, by)) {
        val e = quick.getOrNull(i) ?: return
        pop(2, i)
        host?.chAction(row.id, "react", mapOf("emoji" to e))
        return
      }
    }
    if (!mediaRect.isEmpty && mediaRect.contains(x, y)) {
      host?.chAction(row.id, "media")
    }
  }

  private fun pop(kind: Int, i: Int) {
    performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    popKind = kind
    popIndex = i
    popAt = System.currentTimeMillis()
    invalidate()
  }

  private fun popScale(kind: Int, i: Int): Float {
    if (kind != popKind || i != popIndex) return 1f
    val t = (System.currentTimeMillis() - popAt) / 220f
    if (t >= 1f) { popIndex = -1; return 1f }
    postInvalidateOnAnimation()
    return 0.85f + 0.15f * t
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    computeLayout(width)
    val p = palette
    val rad = dp(16f)
    fill.color = p.card
    canvas.drawRoundRect(bubble, rad, rad, fill)
    if (!p.dark) {
      stroke.color = 0x14000000
      stroke.strokeWidth = max(1f, d * 0.5f)
      canvas.drawRoundRect(bubble, rad, rad, stroke)
    }
    // mídia
    if (!mediaRect.isEmpty) {
      clip.reset()
      clip.addRoundRect(mediaRect, dp(12f), dp(12f), Path.Direction.CW)
      val bmp = media.bitmap
      if (bmp != null && row.mediaKind == "image") {
        chDrawCover(canvas, bmp, mediaRect, clip, fill)
      } else {
        fill.color = if (row.mediaKind == "video") 0xFF000000.toInt() else p.pill
        canvas.drawPath(clip, fill)
      }
      if (row.mediaKind == "video") {
        val cx = mediaRect.centerX()
        val cy = mediaRect.centerY()
        fill.color = 0x8C000000.toInt()
        canvas.drawCircle(cx, cy, dp(26f), fill)
        fill.color = 0xFFFFFFFF.toInt()
        val tri = Path()
        tri.moveTo(cx - dp(6f), cy - dp(9f))
        tri.lineTo(cx + dp(10f), cy)
        tri.lineTo(cx - dp(6f), cy + dp(9f))
        tri.close()
        canvas.drawPath(tri, fill)
      }
    }
    canvas.save()
    canvas.translate(bubble.left, bubble.top)
    val pad = dp(12f)
    val inner = bubble.width() - pad * 2
    textLayout?.let { l ->
      textPaint.color = p.text
      canvas.save()
      canvas.translate(pad, textTop)
      l.draw(canvas)
      canvas.restore()
    }
    // rodapé: [olho visualizações]   hora
    footPaint.color = p.sub
    val fm = footPaint.fontMetrics
    val baseY = footY + dp(7f) - (fm.ascent + fm.descent) / 2f
    var fx = pad + inner
    canvas.drawText(row.time, fx, baseY, footPaint)
    if (row.views.isNotEmpty()) {
      fx -= footPaint.measureText(row.time) + dp(10f)
      canvas.drawText(row.views, fx, baseY, footPaint)
      fx -= footPaint.measureText(row.views) + dp(4f)
      drawEye(canvas, fx - dp(6f), footY + dp(7f), p.sub)
    }
    // chips
    val rx = row.reactions
    chips.forEachIndexed { i, r ->
      val e = rx.getOrNull(i) ?: return@forEachIndexed
      val mine = e.emoji == row.mine
      val s = popScale(1, i)
      canvas.save()
      canvas.scale(s, s, r.centerX(), r.centerY())
      fill.color = if (mine) chBlend(p.card, p.mineChip) else p.pill
      canvas.drawRoundRect(r, dp(12f), dp(12f), fill)
      if (mine) {
        stroke.color = p.text
        stroke.strokeWidth = dp(1f)
        canvas.drawRoundRect(r, dp(12f), dp(12f), stroke)
      }
      val efm = emojiPaint.fontMetrics
      canvas.drawText(e.emoji, r.left + dp(8f), r.centerY() - (efm.ascent + efm.descent) / 2f, emojiPaint)
      countPaint.color = p.sub
      val cfm = countPaint.fontMetrics
      canvas.drawText(e.count.toString(), r.left + dp(8f) + emojiPaint.measureText(e.emoji) + dp(4f), r.centerY() - (cfm.ascent + cfm.descent) / 2f, countPaint)
      canvas.restore()
    }
    // barra rápida
    quickRects.forEachIndexed { i, r ->
      val e = quick.getOrNull(i) ?: return@forEachIndexed
      val s = popScale(2, i)
      quickPaint.alpha = if (e == row.mine) 255 else 128
      canvas.save()
      canvas.scale(s, s, r.centerX(), r.centerY())
      val qfm = quickPaint.fontMetrics
      canvas.drawText(e, r.centerX(), r.centerY() - (qfm.ascent + qfm.descent) / 2f, quickPaint)
      canvas.restore()
    }
    canvas.restore()
  }

  private fun drawEye(canvas: Canvas, cx: Float, cy: Float, color: Int) {
    stroke.color = color
    stroke.strokeWidth = dp(1.2f)
    val w = dp(6f)
    val h = dp(3.6f)
    val path = Path()
    path.moveTo(cx - w, cy)
    path.quadTo(cx, cy - h * 2f, cx + w, cy)
    path.quadTo(cx, cy + h * 2f, cx - w, cy)
    canvas.drawPath(path, stroke)
    fill.color = color
    canvas.drawCircle(cx, cy, dp(1.8f), fill)
  }
}
