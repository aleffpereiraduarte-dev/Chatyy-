package expo.modules.chatyyconversationlist

// [2026-10-15 native-search-notifs] Peças da lista de RESULTADOS nativa
// (Android): cabeçalho de seção (caixa alta + "Ver todos"/"Limpar"), linha de
// resultado/notificação (avatar | miniatura | glifo + selo da ação, título e
// trecho com o termo DESTACADO em spans, hora, miniatura à direita, botões
// inline "Seguir de volta"/"Mensagem", ponto de não lida), "carregando" e
// aviso centralizado. Mesmo visual do iOS (ios/RLCells.swift).

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewOutlineProvider
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.model.GlideUrl
import com.bumptech.glide.load.model.LazyHeaders
import java.io.File

/** Estilo compartilhado (cores + termo + flags da lista). */
internal class RLStyle(
  val colors: CTColors = CTColors(),
  val unreadBg: Int = Color.argb(10, 0, 0, 0),
  val tokens: List<String> = emptyList()
)

internal fun rlBlend(top: Int, bottom: Int): Int {
  val a = Color.alpha(top) / 255f
  val r = (Color.red(top) * a + Color.red(bottom) * (1 - a)).toInt()
  val g = (Color.green(top) * a + Color.green(bottom) * (1 - a)).toInt()
  val b = (Color.blue(top) * a + Color.blue(bottom) * (1 - a)).toInt()
  return Color.argb(255, r, g, b)
}

internal object RLImages {
  fun model(u: String, auth: Boolean): Any? {
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

  fun load(iv: ImageView, url: String, auth: Boolean) {
    val app = iv.context.applicationContext
    try { Glide.with(app).clear(iv) } catch (_: Throwable) {}
    iv.setImageDrawable(null)
    val m = model(url, auth) ?: return
    try {
      Glide.with(app).load(m).centerCrop().diskCacheStrategy(DiskCacheStrategy.AUTOMATIC).into(iv)
    } catch (_: Throwable) {}
  }

  fun clear(iv: ImageView) {
    try { Glide.with(iv.context.applicationContext).clear(iv) } catch (_: Throwable) {}
    iv.setImageDrawable(null)
  }
}

private fun View.roundCorners(radiusDp: Float) {
  val r = radiusDp * resources.displayMetrics.density
  outlineProvider = object : ViewOutlineProvider() {
    override fun getOutline(view: View, outline: Outline) {
      outline.setRoundRect(0, 0, view.width, view.height, r)
    }
  }
  clipToOutline = true
}

/** Texto com o termo destacado (peso 700 + cor do texto). */
internal fun rlHighlighted(text: String, tokens: List<String>, color: Int): CharSequence {
  if (tokens.isEmpty() || text.isEmpty()) return text
  val rs = RLHighlight.ranges(text, tokens)
  if (rs.isEmpty()) return text
  val sb = SpannableStringBuilder(text)
  val bold = CLType.weight(700)
  for (r in rs) {
    val s = r[0].coerceIn(0, text.length)
    val e = r[1].coerceIn(s, text.length)
    if (e <= s) continue
    sb.setSpan(CLTypefaceSpan(bold), s, e, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    sb.setSpan(ForegroundColorSpan(color), s, e, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }
  return sb
}

// ─── Seção ─────────────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class RLSectionView(ctx: Context) : LinearLayout(ctx) {
  var onAction: ((String) -> Unit)? = null
  private val label = ctLabel(ctx, 12f, 600)
  private val action = ctLabel(ctx, 13f, 600)
  var row = RLRow()
    private set

  init {
    orientation = HORIZONTAL
    gravity = Gravity.BOTTOM
    addView(label, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    action.setPadding(ctPx(8f), ctPx(4f), 0, ctPx(4f))
    action.isClickable = true
    action.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      onAction?.invoke(row.id)
    }
    addView(action, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    setPadding(ctPx(16f), ctPx(18f), ctPx(16f), ctPx(6f))
    label.accessibilityHeading()
  }

  private fun TextView.accessibilityHeading() {
    if (android.os.Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
  }

  fun bind(r: RLRow, s: RLStyle) {
    row = r
    setBackgroundColor(s.colors.bg)
    label.text = r.title.uppercase()
    label.setTextColor(s.colors.sub)
    label.letterSpacing = 0.05f
    action.visibility = if (r.action.isEmpty()) GONE else VISIBLE
    action.text = r.action
    action.setTextColor(s.colors.text)
    action.contentDescription = r.action
  }
}

// ─── Carregando ────────────────────────────────────────────────────────────

internal class RLLoadingView(ctx: Context) : LinearLayout(ctx) {
  private val spinner = ProgressBar(ctx)
  private val label = ctLabel(ctx, 13f, 400)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER
    spinner.isIndeterminate = true
    addView(spinner, LayoutParams(ctPx(20f), ctPx(20f)))
    addView(label, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = ctPx(8f) })
    minimumHeight = ctPx(52f)
  }

  fun bind(r: RLRow, s: RLStyle) {
    setBackgroundColor(s.colors.bg)
    spinner.indeterminateTintList = ColorStateList.valueOf(s.colors.sub)
    label.visibility = if (r.title.isEmpty()) GONE else VISIBLE
    label.text = r.title
    label.setTextColor(s.colors.sub)
  }
}

// ─── Aviso (vazio / erro / dica) ───────────────────────────────────────────

internal class RLNoteView(ctx: Context) : LinearLayout(ctx) {
  var onPress: ((String) -> Unit)? = null
  private val circle = ImageView(ctx)
  private val circleBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
  private val label = TextView(ctx)
  var row = RLRow()
    private set

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    circle.scaleType = ImageView.ScaleType.CENTER
    circle.background = circleBg
    addView(circle, LayoutParams(ctPx(64f), ctPx(64f)).apply { bottomMargin = ctPx(14f) })
    label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    label.gravity = Gravity.CENTER
    label.setLineSpacing(ctPx(3f).toFloat(), 1f)
    addView(label, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    setOnClickListener { if (row.tap) onPress?.invoke(row.id) }
  }

  fun bind(r: RLRow, s: RLStyle) {
    row = r
    setBackgroundColor(s.colors.bg)
    circle.visibility = if (r.glyph.isEmpty()) GONE else VISIBLE
    if (r.glyph.isNotEmpty()) {
      circleBg.setColor(s.colors.chipBg)
      val d = tintedIcon(context, RLGlyphs.res(r.glyph), s.colors.sub)
      d?.setBounds(0, 0, ctPx(24f), ctPx(24f))
      circle.setImageDrawable(d)
    }
    label.text = r.title
    label.setTextColor(s.colors.sub)
    setPadding(ctPx(32f), ctPx(if (r.glyph.isEmpty()) 40f else 48f), ctPx(32f), ctPx(32f))
    isClickable = r.tap
    contentDescription = r.title
  }
}

// ─── Linha de resultado / notificação ──────────────────────────────────────

internal class RLRowView(ctx: Context) : LinearLayout(ctx) {
  interface Listener {
    fun onPress(id: String)
    fun onAction(id: String, action: String)
  }

  var listener: Listener? = null
  var row = RLRow()
    private set
  private var style = RLStyle()
  private var separator = false
  private var thumbUrl = ""
  private var rthumbUrl = ""

  private val lead = FrameLayout(ctx)
  private val avatar = CLAvatarView(ctx)
  private val thumb = ImageView(ctx)
  private val glyph = ImageView(ctx)
  private val glyphBg = GradientDrawable()
  private val play = ImageView(ctx)
  private val playBg = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.argb(140, 0, 0, 0)) }
  private val badge = ImageView(ctx)
  private val badgeBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }

  private val info = LinearLayout(ctx)
  private val line1 = LinearLayout(ctx)
  private val title = ctLabel(ctx, 15f, 500)
  private val time = ctLabel(ctx, 12f, 400)
  private val sub = ctLabel(ctx, 13.5f, 400)
  private val buttons = LinearLayout(ctx)
  private val b1 = ctLabel(ctx, 13f, 700)
  private val b1Bg = GradientDrawable()
  private val b2 = ctLabel(ctx, 13f, 600)
  private val b2Bg = GradientDrawable()

  private val rthumb = ImageView(ctx)
  private val chevron = ImageView(ctx)

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    clipChildren = false
    clipToPadding = false
    setWillNotDraw(false)
    setPadding(ctPx(16f), ctPx(11f), ctPx(16f), ctPx(11f))

    val L = ctPx(44f)
    lead.clipChildren = false
    lead.clipToPadding = false
    avatar.setBoxDp(44f)
    lead.addView(avatar, FrameLayout.LayoutParams(L, L))
    thumb.scaleType = ImageView.ScaleType.CENTER_CROP
    thumb.roundCorners(8f)
    lead.addView(thumb, FrameLayout.LayoutParams(L, L))
    glyph.scaleType = ImageView.ScaleType.CENTER
    glyph.background = glyphBg
    lead.addView(glyph, FrameLayout.LayoutParams(L, L))
    play.scaleType = ImageView.ScaleType.CENTER
    play.background = playBg
    lead.addView(play, FrameLayout.LayoutParams(ctPx(20f), ctPx(20f), Gravity.BOTTOM or Gravity.END).apply {
      rightMargin = ctPx(2f); bottomMargin = ctPx(2f)
    })
    badge.scaleType = ImageView.ScaleType.CENTER
    badge.background = badgeBg
    lead.addView(badge, FrameLayout.LayoutParams(ctPx(20f), ctPx(20f), Gravity.BOTTOM or Gravity.END).apply {
      rightMargin = -ctPx(3f); bottomMargin = -ctPx(3f)
    })
    addView(lead, LayoutParams(L, L).apply { marginEnd = ctPx(12f) })

    info.orientation = VERTICAL
    line1.orientation = HORIZONTAL
    line1.gravity = Gravity.TOP
    line1.addView(title, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    time.setPadding(ctPx(8f), ctPx(1f), 0, 0)
    line1.addView(time, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    info.addView(line1, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    info.addView(sub, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = ctPx(2f) })
    buttons.orientation = HORIZONTAL
    b1Bg.cornerRadius = ctPx(8f).toFloat()
    b1.background = b1Bg
    b1.gravity = Gravity.CENTER
    b1.setPadding(ctPx(14f), 0, ctPx(14f), 0)
    b1.minWidth = ctPx(72f)
    b1.isClickable = true
    b1.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      if (!row.b1Busy) listener?.onAction(row.id, "b1")
    }
    buttons.addView(b1, LayoutParams(LayoutParams.WRAP_CONTENT, ctPx(30f)).apply { marginEnd = ctPx(8f) })
    b2Bg.cornerRadius = ctPx(8f).toFloat()
    b2.background = b2Bg
    b2.gravity = Gravity.CENTER
    b2.setPadding(ctPx(14f), 0, ctPx(14f), 0)
    b2.minWidth = ctPx(72f)
    b2.isClickable = true
    b2.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      listener?.onAction(row.id, "b2")
    }
    buttons.addView(b2, LayoutParams(LayoutParams.WRAP_CONTENT, ctPx(30f)))
    info.addView(buttons, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = ctPx(8f) })
    addView(info, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))

    rthumb.scaleType = ImageView.ScaleType.CENTER_CROP
    rthumb.roundCorners(8f)
    addView(rthumb, LayoutParams(L, L).apply { marginStart = ctPx(10f) })
    chevron.scaleType = ImageView.ScaleType.CENTER_INSIDE
    addView(chevron, LayoutParams(ctPx(14f), ctPx(14f)).apply { marginStart = ctPx(8f) })

    setOnClickListener { if (row.tap) listener?.onPress(row.id) }
  }

  fun bind(r: RLRow, s: RLStyle, sep: Boolean) {
    val prevId = row.id
    row = r
    style = s
    separator = sep
    val c = s.colors

    // Fundo (não lida = leve tinta) + ripple de toque
    val base = if (r.unread) rlBlend(s.unreadBg, c.bg) else c.bg
    background = RippleDrawable(ColorStateList.valueOf(c.press), ColorDrawable(base), null)

    // Líder
    avatar.visibility = if (r.hasTiles) VISIBLE else GONE
    val showThumb = !r.hasTiles && r.thumb.isNotEmpty()
    thumb.visibility = if (showThumb) VISIBLE else GONE
    glyph.visibility = if (!r.hasTiles && r.thumb.isEmpty()) VISIBLE else GONE
    if (r.hasTiles) avatar.bind(r.avatarRow(), c.theme, base)
    if (showThumb) {
      thumb.setBackgroundColor(c.chipBg)
      if (r.thumb != thumbUrl || prevId != r.id) {
        thumbUrl = r.thumb
        RLImages.load(thumb, r.thumb, r.thumbAuth)
      }
    } else if (thumbUrl.isNotEmpty()) {
      thumbUrl = ""
      RLImages.clear(thumb)
    }
    play.visibility = if (showThumb && r.play) VISIBLE else GONE
    if (play.visibility == VISIBLE) play.setImageDrawable(sized(tintedIcon(context, RLGlyphs.res("play"), Color.WHITE), 9f))
    if (glyph.visibility == VISIBLE) {
      if (r.glyphRound) {
        glyphBg.shape = GradientDrawable.RECTANGLE
        glyphBg.cornerRadius = ctPx(10f).toFloat()
      } else {
        glyphBg.shape = GradientDrawable.OVAL
      }
      glyphBg.setColor(c.chipBg)
      glyph.setImageDrawable(sized(tintedIcon(context, RLGlyphs.res(r.glyph.ifEmpty { "search" }), c.text), 20f))
    }

    // Selo da ação no canto do avatar
    badge.visibility = if (r.badge.isEmpty()) GONE else VISIBLE
    if (r.badge.isNotEmpty()) {
      badgeBg.setColor(c.text)
      badgeBg.setStroke(ctPx(2f), base)
      badge.setImageDrawable(sized(tintedIcon(context, RLGlyphs.res(r.badge), c.bg), 10f))
    }

    // Título (+ hora inline quando quebra linha) e trecho, com destaque
    title.typeface = CLType.weight(if (r.unread) 600 else 500)
    // setSingleLine(false) zera o maxLines → singleLine ANTES do maxLines.
    title.isSingleLine = r.titleLines == 1
    title.maxLines = r.titleLines
    title.setTextColor(c.text)
    val tText: CharSequence = if (r.highlight) rlHighlighted(r.title, s.tokens, c.text) else r.title
    if (r.titleLines > 1 && r.time.isNotEmpty()) {
      val sb = SpannableStringBuilder(tText)
      val st = sb.length
      sb.append("  · ").append(r.time)
      sb.setSpan(ForegroundColorSpan(c.sub), st, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      sb.setSpan(AbsoluteSizeSpan(12, true), st, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      sb.setSpan(CLTypefaceSpan(CLType.weight(400)), st, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      title.text = sb
    } else {
      title.text = tText
    }
    time.visibility = if (r.time.isEmpty() || r.titleLines > 1) GONE else VISIBLE
    time.text = r.time
    time.setTextColor(c.faint)
    sub.visibility = if (r.sub.isEmpty()) GONE else VISIBLE
    sub.isSingleLine = r.subLines == 1
    sub.maxLines = r.subLines
    sub.setTextColor(c.sub)
    sub.text = if (r.highlight) rlHighlighted(r.sub, s.tokens, c.text) else r.sub

    // Botões inline
    buttons.visibility = if (r.hasButtons) VISIBLE else GONE
    b1.visibility = if (r.b1.isEmpty()) GONE else VISIBLE
    if (r.b1.isNotEmpty()) {
      b1.text = if (r.b1Busy) "…" else r.b1
      b1.alpha = if (r.b1Busy) 0.6f else 1f
      if (r.b1Filled) {
        b1Bg.setColor(c.primary)
        b1Bg.setStroke(0, Color.TRANSPARENT)
        b1.setTextColor(c.onPrimary)
      } else {
        b1Bg.setColor(Color.TRANSPARENT)
        b1Bg.setStroke(ctPx(1f), c.border)
        b1.setTextColor(c.text)
      }
      b1.contentDescription = r.b1
    }
    b2.visibility = if (r.b2.isEmpty()) GONE else VISIBLE
    if (r.b2.isNotEmpty()) {
      b2.text = r.b2
      b2Bg.setColor(Color.TRANSPARENT)
      b2Bg.setStroke(ctPx(1f), c.border)
      b2.setTextColor(c.text)
      b2.contentDescription = r.b2
    }
    // Avatar no topo quando há botões (estilo Instagram); senão centralizado.
    gravity = if (r.hasButtons) Gravity.TOP else Gravity.CENTER_VERTICAL

    // Miniatura à direita
    rthumb.visibility = if (r.rightThumb.isEmpty()) GONE else VISIBLE
    if (r.rightThumb.isNotEmpty()) {
      rthumb.setBackgroundColor(c.chipBg)
      if (r.rightThumb != rthumbUrl) {
        rthumbUrl = r.rightThumb
        RLImages.load(rthumb, r.rightThumb, false)
      }
    } else if (rthumbUrl.isNotEmpty()) {
      rthumbUrl = ""
      RLImages.clear(rthumb)
    }
    chevron.visibility = if (r.chevron) VISIBLE else GONE
    if (r.chevron) chevron.setImageDrawable(tintedIcon(context, R.drawable.cst_ic_chevron, c.faint))

    // Acessibilidade
    contentDescription = r.a11y.ifEmpty { listOf(r.title, r.sub, r.time).filter { it.isNotEmpty() }.joinToString(", ") }
    isClickable = r.tap
    invalidate()
  }

  private fun sized(d: Drawable?, dp: Float): Drawable? {
    if (d == null) return null
    val s = ctPx(dp)
    return object : android.graphics.drawable.LayerDrawable(arrayOf(d)) {
      override fun getIntrinsicWidth(): Int = s
      override fun getIntrinsicHeight(): Int = s
    }
  }

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    if (row.b1.isNotEmpty()) info.addAction(AccessibilityNodeInfo.AccessibilityAction(R_ID_B1, row.b1))
    if (row.b2.isNotEmpty()) info.addAction(AccessibilityNodeInfo.AccessibilityAction(R_ID_B2, row.b2))
    if (row.swipe.isNotEmpty()) info.addAction(AccessibilityNodeInfo.AccessibilityAction(R_ID_DEL, row.swipe))
  }

  override fun performAccessibilityAction(action: Int, arguments: android.os.Bundle?): Boolean {
    when (action) {
      R_ID_B1 -> { listener?.onAction(row.id, "b1"); return true }
      R_ID_B2 -> { listener?.onAction(row.id, "b2"); return true }
      R_ID_DEL -> { listener?.onAction(row.id, "delete"); return true }
    }
    return super.performAccessibilityAction(action, arguments)
  }

  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    val d = resources.displayMetrics.density
    if (row.unread) {
      paint.color = style.colors.text
      val cy = lead.top + lead.height / 2f
      canvas.drawCircle(8f * d, cy, 3f * d, paint)
    }
    if (separator) {
      paint.color = style.colors.hair
      val x = (lead.right + 12f * d)
      val h = maxOf(1f, d * 0.5f)
      canvas.drawRect(x, height - h, width.toFloat(), height.toFloat(), paint)
    }
  }

  companion object {
    private const val R_ID_B1 = 0x7f0e1001
    private const val R_ID_B2 = 0x7f0e1002
    private const val R_ID_DEL = 0x7f0e1003
  }
}
