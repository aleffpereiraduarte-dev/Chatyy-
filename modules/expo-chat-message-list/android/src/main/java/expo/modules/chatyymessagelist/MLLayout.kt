package expo.modules.chatyymessagelist

import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import android.text.style.BackgroundColorSpan
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

// [2026-10-14 native-list] Layout das linhas — roda num executor de fundo.
// StaticLayout é imutável depois de construído; os TextPaint do estilo nunca
// são alterados depois de criados (cor sempre por span) → seguro desenhar na
// main enquanto o fundo mede outras linhas.

/** Marcador de link/menção/hashtag (não desenha nada; só carrega a url). */
class MLLinkSpan(val url: String) : CharacterStyle() {
  override fun updateDrawState(tp: TextPaint) {}
}

class MLStyle(
  val width: Float,
  val density: Float,
  fontScale: Float,
  fontSizeDp: Float,
  lineHeightDp: Float,
  radiusDp: Float,
  val theme: MLTheme,
  val version: Int,
) {
  private val fs: Float = min(1.4f, max(0.85f, fontScale))
  fun dp(v: Float): Float = v * density
  fun sp(v: Float): Float = v * density * fs

  val fontPx = sp(max(10f, fontSizeDp))
  val lineHeightPx = max(ceil(fontPx * 1.25f), sp(lineHeightDp))
  val radius = dp(radiusDp)

  private fun paint(sizePx: Float, tf: Typeface = Typeface.DEFAULT): TextPaint =
    TextPaint(TextPaint.ANTI_ALIAS_FLAG).apply { textSize = sizePx; typeface = tf; color = 0xFF000000.toInt() }

  val body = paint(fontPx)
  val meta = paint(sp(11f))
  val name = paint(sp(13f), Typeface.create(Typeface.DEFAULT, Typeface.BOLD))
  val fwd = paint(sp(12f), Typeface.create(Typeface.DEFAULT, Typeface.ITALIC))
  val quoteName = paint(sp(13f), Typeface.create(Typeface.DEFAULT, Typeface.BOLD))
  val quoteText = paint(sp(13f))
  val pill = paint(sp(12.5f), Typeface.create(Typeface.DEFAULT, Typeface.BOLD))
  val system = paint(sp(13f))
  val unread = paint(sp(13f), Typeface.create(Typeface.DEFAULT, Typeface.BOLD))
  val react = paint(sp(13f))
  val fileName = paint(sp(14f), Typeface.create("sans-serif-medium", Typeface.NORMAL))
  val small = paint(sp(12f))
  val ext = paint(sp(10f), Typeface.create(Typeface.DEFAULT, Typeface.BOLD))
  val more = paint(sp(26f), Typeface.create(Typeface.DEFAULT, Typeface.BOLD))
  private val jumboPaints = HashMap<Int, TextPaint>()

  @Synchronized
  fun jumbo(sizeDp: Float): TextPaint = jumboPaints.getOrPut(sizeDp.toInt()) { paint(sp(sizeDp)) }

  // [fase 2] paints dos nós de texto (imutáveis depois de criados).
  private val nodePaints = HashMap<String, TextPaint>()

  @Synchronized
  fun nodePaint(fsDp: Float, weight: Int, italic: Boolean, mono: Boolean, lsDp: Float): TextPaint {
    val k = "$fsDp|$weight|$italic|$mono|$lsDp"
    return nodePaints.getOrPut(k) {
      paint(sp(max(6f, fsDp)), MLFonts.of(weight, italic, mono)).apply {
        if (lsDp != 0f && fsDp > 0f) letterSpacing = lsDp / fsDp
      }
    }
  }

  val bubbleMax: Float get() = floor(min(width, dp(620f)) * 0.78f)
}

/** StaticLayout + métricas úteis. */
class MLText(val layout: StaticLayout, val particleColor: Int = 0xFF888888.toInt()) {
  /** [fase 2] spoilers deste texto (alpha animado pelo MLCellView). */
  val spoilers: Array<MLSpoilerSpan> = (layout.text as? Spanned)?.getSpans(0, layout.text.length, MLSpoilerSpan::class.java) ?: emptyArray()
  val width: Float
  val height: Float = layout.height.toFloat()
  val lastLineWidth: Float
  val lineCount: Int = layout.lineCount

  init {
    var w = 0f
    for (i in 0 until layout.lineCount) w = max(w, layout.getLineMax(i))
    width = ceil(w)
    lastLineWidth = if (layout.lineCount > 0) layout.getLineMax(layout.lineCount - 1) else 0f
  }

  /** [fase 2] toque dentro de um spoiler ainda escondido? */
  fun spoilerAt(x: Float, y: Float): Boolean {
    if (spoilers.isEmpty() || y < 0 || y > height + 4 || x < -4) return false
    val t = layout.text as? Spanned ?: return false
    val line = layout.getLineForVertical(y.toInt())
    val off = layout.getOffsetForHorizontal(line, max(0f, x))
    for (sp in spoilers) {
      if (sp.reveal >= 1f) continue
      val a = t.getSpanStart(sp); val b = t.getSpanEnd(sp)
      if (off >= a - 1 && off <= b) return true
    }
    return false
  }

  fun linkAt(x: Float, y: Float): String? {
    if (y < 0 || y > height + 4 || x < -4) return null
    val line = layout.getLineForVertical(y.toInt())
    if (x > layout.getLineMax(line) + 8) return null
    val off = layout.getOffsetForHorizontal(line, max(0f, x))
    val t = layout.text as? Spanned ?: return null
    val a = max(0, off - 1)
    val b = min(t.length, off + 1)
    val spans = t.getSpans(a, b, MLLinkSpan::class.java)
    return spans.firstOrNull()?.url
  }

  companion object {
    fun make(text: CharSequence, paint: TextPaint, maxWidth: Float, lineHeightPx: Float, maxLines: Int = 0, align: Layout.Alignment = Layout.Alignment.ALIGN_NORMAL, particle: Int = 0xFF888888.toInt()): MLText {
      val w = max(10, ceil(maxWidth).toInt())
      val natural = paint.getFontMetricsInt(null).toFloat()
      val extra = max(0f, lineHeightPx - natural)
      val b = StaticLayout.Builder.obtain(text, 0, text.length, paint, w)
        .setAlignment(align)
        .setIncludePad(false)
        .setLineSpacing(extra, 1f)
      if (maxLines > 0) {
        b.setMaxLines(maxLines)
        b.setEllipsize(TextUtils.TruncateAt.END)
      }
      return MLText(b.build(), particle)
    }
  }
}

class MLMeta(
  val text: MLText?,
  val star: Boolean,
  val status: Double?,
  val width: Float,
  val height: Float,
  val color: Int,
  val onMedia: Boolean,
  val pinned: Boolean = false,
  val timer: Boolean = false,
)

class MLRowLayout {
  var height = 0f
  var kind = MLKind.MSG
  val bubble = RectF()
  var bubblePath: Path? = null
  var showBubble = true
  val nameFrame = RectF(); var name: MLText? = null
  val fwdFrame = RectF(); var fwd: MLText? = null
  val replyFrame = RectF(); var replyName: MLText? = null; var replyText: MLText? = null; var replyThumb = false
  val mediaFrame = RectF(); var mediaRadius = 0f
  val albumFrames = ArrayList<RectF>()
  val textFrame = RectF(); var text: MLText? = null; var deletedIcon = false
  val metaFrame = RectF(); var meta: MLMeta? = null
  val reactsFrame = RectF(); val chips = ArrayList<Pair<RectF, MLText>>()
  val audioFrame = RectF()
  val fileFrame = RectF(); var fileName: MLText? = null; var fileSize: MLText? = null; var fileExt: MLText? = null
  val selCircle = RectF()
  var replyIconX = 0f
  val pillFrame = RectF(); var pillText: MLText? = null; val pillTextFrame = RectF()
  var durText: MLText? = null
  var moreText: MLText? = null
  // [fase 2] blocos (bl/pre/post) já posicionados no balão
  val ops = ArrayList<MLOp>()
  val actions = ArrayList<MLAction>()
  var hasLoader = false
  var vnote: MLOp? = null
  var imageOps = 0
  val failFrame = RectF()
  var noMeta = false
  val spoilers = ArrayList<MLSpoilerSpan>()
}

object MLLayoutBuilder {
  private fun span(sb: SpannableStringBuilder, what: Any, a: Int, b: Int) {
    sb.setSpan(what, a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }

  fun styled(text: String, spans: List<MLSpan>, color: Int, linkColor: Int, emojiPx: Float = 0f, bubbleColor: Int = 0, underlineAll: Boolean = false, dens: Float = 2.5f): CharSequence {
    val sb = SpannableStringBuilder(text)
    val len = text.length
    if (len > 0) span(sb, ForegroundColorSpan(color), 0, len)
    if (len > 0 && underlineAll) span(sb, UnderlineSpan(), 0, len)
    val spoilers = ArrayList<IntArray>()
    for (s in spans) {
      val a = s.start.coerceIn(0, len)
      val b = s.end.coerceIn(a, len)
      if (b <= a) continue
      val f = s.flags
      if ((f and MLSpan.EMOJI) != 0 && !s.url.isNullOrEmpty()) {
        span(sb, MLEmojiSpan(s.url, if (emojiPx > 0f) emojiPx else 20f), a, b)
        continue
      }
      if ((f and MLSpan.CODE) != 0) {
        val bg = s.color ?: ((color and 0x00FFFFFF) or (0x1F shl 24))
        if (b - a <= 40 && text.indexOf('\n', a) !in a until b) span(sb, MLCodeSpan(bg, 4f * dens), a, b)
        else { span(sb, BackgroundColorSpan(bg), a, b); span(sb, TypefaceSpan("monospace"), a, b) }
      } else if (s.color != null) {
        span(sb, ForegroundColorSpan(s.color), a, b)
      }
      val bold = (f and MLSpan.BOLD) != 0 || (f and (MLSpan.MENTION or MLSpan.HASHTAG)) != 0
      val ital = (f and MLSpan.ITALIC) != 0
      when {
        (f and MLSpan.MONO) != 0 && (f and MLSpan.CODE) == 0 -> span(sb, TypefaceSpan("monospace"), a, b)
        bold && ital -> span(sb, StyleSpan(Typeface.BOLD_ITALIC), a, b)
        bold -> span(sb, StyleSpan(Typeface.BOLD), a, b)
        ital -> span(sb, StyleSpan(Typeface.ITALIC), a, b)
      }
      if ((f and MLSpan.STRIKE) != 0) span(sb, StrikethroughSpan(), a, b)
      if ((f and (MLSpan.LINK or MLSpan.MENTION or MLSpan.HASHTAG)) != 0) {
        val prefix = if ((f and MLSpan.MENTION) != 0) "mention:" else if ((f and MLSpan.HASHTAG) != 0) "hashtag:" else ""
        span(sb, MLLinkSpan(prefix + (s.url ?: text.substring(a, b))), a, b)
        span(sb, ForegroundColorSpan(s.color ?: linkColor), a, b)
        if ((f and MLSpan.LINK) != 0) span(sb, UnderlineSpan(), a, b)
      }
      if ((f and MLSpan.SPOILER) != 0) spoilers.add(intArrayOf(a, b))
    }
    // spoiler por ÚLTIMO: o alpha dele vence o ForegroundColorSpan
    for (r in spoilers) span(sb, MLSpoilerSpan(), r[0], r[1])
    return sb
  }

  fun colored(text: String, color: Int): CharSequence {
    val sb = SpannableStringBuilder(text)
    if (text.isNotEmpty()) span(sb, ForegroundColorSpan(color), 0, text.length)
    return sb
  }

  fun line(text: String, paint: TextPaint, color: Int, maxWidth: Float): MLText =
    MLText.make(colored(text, color), paint, maxWidth, 0f, 1)

  fun build(row: MLRow, s: MLStyle): MLRowLayout = when (row.kind) {
    MLKind.DATE -> buildPill(row, s, s.pill, s.theme.pillText)
    MLKind.SYSTEM -> buildPill(row, s, s.system, s.theme.systemText)
    MLKind.UNREAD -> buildUnread(row, s)
    MLKind.MSG -> buildMessage(row, s)
  }

  private fun buildPill(row: MLRow, s: MLStyle, p: TextPaint, color: Int): MLRowLayout {
    val L = MLRowLayout()
    L.kind = row.kind
    val maxW = floor(s.width * 0.8f) - s.dp(24f)
    val t = MLText.make(colored(row.text, color), p, maxW, 0f, if (row.kind == MLKind.DATE) 1 else 6)
    L.pillText = t
    val pw = min(s.width - s.dp(32f), t.width + s.dp(24f))
    val ph = max(s.dp(24f), t.height + s.dp(8f))
    val top = s.dp(if (row.kind == MLKind.DATE) 8f else 6f)
    L.pillFrame.set(floor((s.width - pw) / 2), top, floor((s.width - pw) / 2) + pw, top + ph)
    val tx = L.pillFrame.left + floor((pw - t.width) / 2)
    val ty = L.pillFrame.top + floor((ph - t.height) / 2)
    L.pillTextFrame.set(tx, ty, tx + t.width + 1, ty + t.height)
    L.height = if (row.text.isEmpty()) 1f else top + ph + s.dp(if (row.kind == MLKind.DATE) 8f else 6f)
    return L
  }

  private fun buildUnread(row: MLRow, s: MLStyle): MLRowLayout {
    val L = MLRowLayout()
    L.kind = MLKind.UNREAD
    val t = line(row.text, s.unread, s.theme.unreadText, s.width - s.dp(32f))
    L.pillText = t
    val top = s.dp(8f)
    val h = s.dp(30f)
    L.pillFrame.set(0f, top, s.width, top + h)
    val tx = floor((s.width - t.width) / 2)
    val ty = top + floor((h - t.height) / 2)
    L.pillTextFrame.set(tx, ty, tx + t.width + 1, ty + t.height)
    L.height = s.dp(46f)
    return L
  }

  fun tickWidth(s: MLStyle, st: Double?): Float = when {
    st == null -> 0f
    st >= 1.5 -> s.dp(17f)
    else -> s.dp(13f)
  }

  fun makeMeta(row: MLRow, s: MLStyle, onMedia: Boolean, withStatus: Boolean = true): MLMeta {
    val color = if (onMedia) 0xF2FFFFFF.toInt() else if (row.own) s.theme.ownMeta else s.theme.otherMeta
    val str = if (row.edited.isNotEmpty()) row.edited + "  " + row.time else row.time
    val t = line(str, s.meta, color, s.dp(160f))
    val status = if (row.own && withStatus) row.status else null
    var w = t.width
    if (row.star) w += s.dp(13f)
    if (row.pinned) w += s.dp(13f)
    if (row.timer) w += s.dp(13f)
    if (status != null) w += s.dp(3f) + tickWidth(s, status)
    return MLMeta(t, row.star, status, ceil(w), max(s.dp(14f), t.height), color, onMedia, row.pinned, row.timer)
  }

  /** [2026-10-17 fwd-label] largura reservada p/ a seta do "Encaminhada" (dupla se ≥ 5). */
  fun fwdIconW(row: MLRow, s: MLStyle): Float = s.dp(if (row.forwardedMany) 19f else 14f)

  private fun buildMessage(row: MLRow, s: MLStyle): MLRowLayout {
    val L = MLRowLayout()
    L.kind = MLKind.MSG
    val th = s.theme
    val textColor = if (row.own) th.ownText else th.otherText
    val metaColor = if (row.own) th.ownMeta else th.otherMeta
    val linkColor = if (row.own) th.ownText else th.link
    val side = s.dp(8f)
    val tail = s.dp(6f)
    val padH = s.dp(12f)
    val padV = s.dp(6f)
    val inset = s.dp(3f)
    val gap = s.dp(6f)
    val gutter = if (row.sel > 0) s.dp(38f) else 0f
    val bubbleMax = max(s.dp(120f), s.bubbleMax - (if (row.own) 0f else gutter))
    val contentMax = bubbleMax - padH * 2

    var bubbleW: Float
    var bubbleH: Float
    var y: Float
    var showBubble = !row.bare

    val nameL = if (row.name.isNotEmpty()) line(row.name, s.name, row.nameColor, contentMax) else null
    val fwdIw = fwdIconW(row, s)
    val fwdL = if (row.forwarded.isNotEmpty() && !row.deleted) line(row.forwarded, s.fwd, metaColor, max(s.dp(40f), contentMax - fwdIw)) else null
    val rp = if (row.deleted) null else row.reply
    val hasThumb = rp != null && rp.thumb.isNotEmpty()
    var rName: MLText? = null
    var rText: MLText? = null
    if (rp != null) {
      val qMax = contentMax + padH * 2 - s.dp(27f) - (if (hasThumb) s.dp(48f) else 0f)
      rName = line(rp.name, s.quoteName, rp.color, qMax)
      val tp = if (rp.italic) s.fwd else s.quoteText
      rText = line(if (rp.text.isEmpty()) " " else rp.text, tp, metaColor, qMax)
    }
    var topMinW = 0f
    nameL?.let { topMinW = max(topMinW, it.width) }
    fwdL?.let { topMinW = max(topMinW, it.width + fwdIw) }
    if (rName != null && rText != null) {
      topMinW = max(topMinW, max(rName.width, rText.width) + s.dp(11f) + (if (hasThumb) s.dp(48f) else 0f))
      topMinW = max(topMinW, s.dp(140f))
    }
    topMinW = min(topMinW, contentMax)
    val hasTop = nameL != null || fwdL != null || rName != null
    val replyH = s.dp(50f)

    var nameY = 0f
    var fwdY = 0f
    var replyY = 0f
    fun layTop(): Float {
      var yy = padV
      if (nameL != null) { nameY = yy; yy += nameL.height + s.dp(1f) }
      if (fwdL != null) { fwdY = yy; yy += fwdL.height + s.dp(2f) }
      if (rName != null) { if (yy > padV) yy += s.dp(1f); replyY = yy; yy += replyH + s.dp(5f) }
      return yy
    }

    val meta: MLMeta
    val md = row.media
    if (row.deleted) {
      val iconW = s.dp(20f)
      val t = MLText.make(colored(row.text, metaColor).let {
        val sb = SpannableStringBuilder(it); if (sb.isNotEmpty()) span(sb, StyleSpan(Typeface.ITALIC), 0, sb.length); sb
      }, s.body, contentMax - iconW, s.lineHeightPx)
      L.text = t
      L.deletedIcon = true
      meta = makeMeta(row, s, onMedia = false, withStatus = false)
      y = layTop()
      val fits = t.lastLineWidth + iconW + gap + meta.width <= contentMax
      var cw = max(t.width + iconW, topMinW)
      cw = if (fits) max(cw, t.lastLineWidth + iconW + gap + meta.width) else max(cw, meta.width)
      bubbleW = min(contentMax, ceil(cw)) + padH * 2
      L.textFrame.set(padH + iconW, y, padH + iconW + t.width + 1, y + t.height)
      y += t.height
      if (!fits) y += meta.height
      bubbleH = y + padV
      L.metaFrame.set(bubbleW - padH - meta.width, bubbleH - padV - meta.height, bubbleW - padH + s.dp(2f), bubbleH - padV)
    } else if (row.hasBlocks) {
      // ---- [fase 2] cartão em blocos (enquete, localização, contato, código…)
      val bare = row.cardBare
      val pd = row.pad?.let { floatArrayOf(s.dp(it[0]), s.dp(it[1]), s.dp(it[2]), s.dp(it[3])) }
        ?: if (bare) floatArrayOf(0f, 0f, 0f, 0f) else floatArrayOf(padV, padH, padV, padH)
      if (bare) showBubble = false
      val eng = MLNodeEngine(s, row, textColor, linkColor)
      val availC = max(s.dp(40f), (if (bare) s.bubbleMax else bubbleMax) - pd[1] - pd[3])
      val cwPx = if (row.cw > 0f) min(s.dp(row.cw), availC) else 0f
      val lastNode = row.blocks.last()
      val mp = row.metaPlace.ifEmpty { if (lastNode.t == "tx" && lastNode.mi) "in" else "below" }
      meta = makeMeta(row, s, onMedia = mp == "over" || bare)
      if (mp == "none") L.noMeta = true
      y = if (hasTop && !bare) layTop() else pd[0]
      val contentY = y
      var blk = MLBlocks()
      eng.layout(row.blocks, availC, cwPx, pd[3], contentY, blk)
      var inner = blk.width
      if (hasTop && !bare) inner = max(inner, topMinW)
      if (mp == "below" && !bare) inner = max(inner, meta.width)
      inner = min(inner, availC)
      if (cwPx <= 0f && inner > blk.width + 0.5f) blk = eng.layoutExact(row.blocks, inner, pd[3], contentY)
      bubbleW = inner + pd[1] + pd[3]
      y = contentY + blk.height
      if (bare) {
        if (mp == "over") {
          val lr = blk.lastRect ?: RectF(0f, contentY, bubbleW, y)
          val pw = meta.width + s.dp(12f)
          L.metaFrame.set(lr.right - pw - s.dp(5f), lr.bottom - s.dp(23f), lr.right - s.dp(5f), lr.bottom - s.dp(5f))
          bubbleH = y + pd[2]
        } else if (mp == "none") {
          bubbleH = y + pd[2]
        } else {
          val mw = meta.width + s.dp(12f)
          val mx = if (row.own) bubbleW - mw else 0f
          L.metaFrame.set(mx, y + s.dp(2f), mx + mw, y + s.dp(20f))
          bubbleH = y + s.dp(20f) + pd[2]
        }
      } else {
        when (mp) {
          "over" -> {
            val lr = blk.lastRect ?: RectF(0f, contentY, bubbleW, y)
            val pw = meta.width + s.dp(12f)
            L.metaFrame.set(lr.right - pw - s.dp(5f), lr.bottom - s.dp(23f), lr.right - s.dp(5f), lr.bottom - s.dp(5f))
            bubbleH = y + pd[2]
          }
          "none" -> bubbleH = y + pd[2]
          else -> {
            val lt = if (mp == "in") blk.lastText else null
            val fits = lt?.text?.let { t -> lt.rect.left + t.lastLineWidth + gap + meta.width <= bubbleW - pd[1] } ?: false
            if (!fits) y += meta.height + (if (mp == "below") s.dp(2f) else 0f)
            bubbleH = y + pd[2]
            L.metaFrame.set(bubbleW - pd[1] - meta.width, bubbleH - pd[2] - meta.height, bubbleW - pd[1] + s.dp(2f), bubbleH - pd[2])
          }
        }
      }
      L.ops.addAll(blk.ops)
      L.actions.addAll(blk.actions)
    } else if (row.jumbo > 0f) {
      showBubble = false
      val p = s.jumbo(row.jumbo)
      val t = MLText.make(colored(row.text, th.otherText), p, contentMax, s.sp(row.jumbo + 8f))
      L.text = t
      meta = makeMeta(row, s, onMedia = true)
      bubbleW = max(t.width, meta.width + s.dp(14f))
      val tx = if (row.own) bubbleW - t.width else 0f
      L.textFrame.set(tx, 0f, tx + t.width + 1, t.height)
      val mw = meta.width + s.dp(12f)
      val mx = if (row.own) bubbleW - mw else 0f
      L.metaFrame.set(mx, t.height + s.dp(2f), mx + mw, t.height + s.dp(20f))
      bubbleH = t.height + s.dp(20f)
    } else if (md != null && md.kind == "sticker") {
      showBubble = false
      val sz = s.dp(130f)
      meta = makeMeta(row, s, onMedia = true)
      bubbleW = sz
      L.mediaFrame.set(0f, 0f, sz, sz)
      L.mediaRadius = 0f
      val mw = meta.width + s.dp(12f)
      val mx = if (row.own) sz - mw else 0f
      L.metaFrame.set(mx, sz + s.dp(2f), mx + mw, sz + s.dp(20f))
      bubbleH = sz + s.dp(20f)
    } else if (md != null || row.album.isNotEmpty()) {
      val maxMediaW = min(bubbleMax - inset * 2, s.dp(280f))
      var mw = maxMediaW
      var mh = maxMediaW
      val cells = ArrayList<RectF>()
      if (md != null) {
        if (md.w > 0 && md.h > 0) {
          val ratio = md.h / md.w
          mw = maxMediaW
          mh = mw * ratio
          if (mh > s.dp(360f)) { mh = s.dp(360f); mw = max(s.dp(150f), min(maxMediaW, mh / ratio)) }
          if (mh < s.dp(110f)) mh = s.dp(110f)
        } else {
          mw = min(maxMediaW, s.dp(240f)); mh = mw
        }
        mw = max(mw, min(maxMediaW, topMinW + padH * 2 - inset * 2))
      } else {
        val n = row.album.size
        val g = s.dp(2f)
        mw = maxMediaW
        when (n) {
          1 -> { mh = mw; cells.add(RectF(0f, 0f, mw, mh)) }
          2 -> {
            val cw = floor((mw - g) / 2); mh = floor(cw * 1.3f)
            cells.add(RectF(0f, 0f, cw, mh)); cells.add(RectF(cw + g, 0f, mw, mh))
          }
          3 -> {
            val top = floor(mw * 0.62f); val cw = floor((mw - g) / 2); val bh = floor(cw * 0.8f)
            mh = top + g + bh
            cells.add(RectF(0f, 0f, mw, top)); cells.add(RectF(0f, top + g, cw, mh)); cells.add(RectF(cw + g, top + g, mw, mh))
          }
          else -> {
            val cw = floor((mw - g) / 2); mh = cw * 2 + g
            cells.add(RectF(0f, 0f, cw, cw)); cells.add(RectF(cw + g, 0f, mw, cw))
            cells.add(RectF(0f, cw + g, cw, mh)); cells.add(RectF(cw + g, cw + g, mw, mh))
          }
        }
      }
      mw = floor(mw); mh = floor(mh)
      bubbleW = mw + inset * 2
      val capMax = bubbleW - s.dp(18f)
      y = if (hasTop) {
        var yy = padV
        if (nameL != null) { nameY = yy; yy += nameL.height + s.dp(1f) }
        if (fwdL != null) { fwdY = yy; yy += fwdL.height + s.dp(2f) }
        if (rName != null) { replyY = yy; yy += replyH + s.dp(4f) }
        yy
      } else inset
      L.mediaFrame.set(inset, y, inset + mw, y + mh)
      L.mediaRadius = max(s.dp(4f), s.radius - inset)
      for (c in cells) { c.offset(inset, y); L.albumFrames.add(c) }
      y += mh
      if (row.text.isNotEmpty()) {
        val t = MLText.make(styled(row.text, row.spans, textColor, linkColor, s.fontPx * 1.2f, 0, false, s.density), s.body, capMax, s.lineHeightPx, 0, Layout.Alignment.ALIGN_NORMAL, textColor)
        L.text = t
        meta = makeMeta(row, s, onMedia = false)
        y += s.dp(5f)
        L.textFrame.set(s.dp(9f), y, s.dp(9f) + t.width + 1, y + t.height)
        y += t.height
        if (t.lastLineWidth + gap + meta.width > capMax) y += meta.height
        bubbleH = y + padV
        L.metaFrame.set(bubbleW - s.dp(9f) - meta.width, bubbleH - padV - meta.height, bubbleW - s.dp(7f), bubbleH - padV)
      } else {
        meta = makeMeta(row, s, onMedia = true)
        bubbleH = y + inset
        val pw = meta.width + s.dp(12f)
        L.metaFrame.set(L.mediaFrame.right - pw - s.dp(5f), L.mediaFrame.bottom - s.dp(23f), L.mediaFrame.right - s.dp(5f), L.mediaFrame.bottom - s.dp(5f))
      }
      if (md != null && (md.kind == "video" || md.kind == "gif") && md.dur.isNotEmpty()) L.durText = line(md.dur, s.meta, 0xFFFFFFFF.toInt(), s.dp(80f))
      if (row.more > 0) L.moreText = line("+${row.more}", s.more, 0xFFFFFFFF.toInt(), s.dp(120f))
    } else if (row.audio != null) {
      meta = makeMeta(row, s, onMedia = false)
      y = layTop()
      val cw = max(min(contentMax, s.dp(236f)), topMinW)
      bubbleW = cw + padH * 2 - s.dp(4f)
      L.audioFrame.set(padH - s.dp(4f), y, padH - s.dp(4f) + cw, y + s.dp(44f))
      y += s.dp(44f)
      bubbleH = y + padV
      L.metaFrame.set(bubbleW - padH - meta.width, bubbleH - padV - meta.height, bubbleW - padH + s.dp(2f), bubbleH - padV)
    } else if (row.file != null) {
      val f = row.file!!
      meta = makeMeta(row, s, onMedia = false)
      y = layTop()
      val cw = max(min(contentMax, s.dp(250f)), topMinW)
      val nameMax = cw - s.dp(52f)
      val nl = MLText.make(colored(f.name, textColor), s.fileName, nameMax, 0f, 2)
      val sizeStr = listOf(f.size, f.ext).filter { it.isNotEmpty() }.joinToString(" · ")
      val sl = line(sizeStr, s.small, metaColor, nameMax)
      val el = line(if (f.ext.isEmpty()) "FILE" else f.ext.take(4), s.ext, 0xFFFFFFFF.toInt(), s.dp(40f))
      L.fileName = nl; L.fileSize = sl; L.fileExt = el
      val fh = max(s.dp(46f), nl.height + s.dp(2f) + sl.height)
      bubbleW = cw + padH * 2
      L.fileFrame.set(padH, y, padH + cw, y + fh)
      y += fh
      if (row.text.isNotEmpty()) {
        val t = MLText.make(styled(row.text, row.spans, textColor, linkColor, s.fontPx * 1.2f, 0, false, s.density), s.body, cw, s.lineHeightPx, 0, Layout.Alignment.ALIGN_NORMAL, textColor)
        L.text = t
        y += s.dp(4f)
        L.textFrame.set(padH, y, padH + t.width + 1, y + t.height)
        y += t.height
        if (t.lastLineWidth + gap + meta.width > cw) y += meta.height
      } else {
        y += meta.height
      }
      bubbleH = y + padV
      L.metaFrame.set(bubbleW - padH - meta.width, bubbleH - padV - meta.height, bubbleW - padH + s.dp(2f), bubbleH - padV)
    } else {
      val t = MLText.make(styled(row.text, row.spans, textColor, linkColor, s.fontPx * 1.2f, 0, false, s.density), s.body, contentMax, s.lineHeightPx, 0, Layout.Alignment.ALIGN_NORMAL, textColor)
      L.text = t
      meta = makeMeta(row, s, onMedia = false)
      y = layTop()
      val fits = t.lastLineWidth + gap + meta.width <= contentMax
      var cw = max(t.width, topMinW)
      cw = if (fits) max(cw, t.lastLineWidth + gap + meta.width) else max(cw, meta.width)
      cw = min(contentMax, ceil(cw))
      bubbleW = cw + padH * 2
      L.textFrame.set(padH, y, padH + t.width + 1, y + t.height)
      y += t.height
      if (!fits) y += meta.height
      bubbleH = y + padV
      L.metaFrame.set(bubbleW - padH - meta.width, bubbleH - padV - meta.height, bubbleW - padH + s.dp(2f), bubbleH - padV)
    }
    var metaV = meta
    // ---- [fase 2] pre/post em volta do conteúdo padrão (texto/mídia/áudio/arquivo)
    if (!row.hasBlocks && !row.deleted && showBubble && (row.pre.isNotEmpty() || row.post.isNotEmpty())) {
      val isMedia = !L.mediaFrame.isEmpty || L.albumFrames.isNotEmpty()
      val cl = if (isMedia) s.dp(9f) else padH
      val eng = MLNodeEngine(s, row, textColor, linkColor)
      val maxInner = bubbleMax - cl * 2
      fun contentRects(): List<RectF> = listOf(L.mediaFrame, L.textFrame, L.audioFrame, L.fileFrame).filter { !it.isEmpty } + L.albumFrames
      if (row.pre.isNotEmpty()) {
        val top0 = contentRects().minOfOrNull { it.top } ?: (if (hasTop) layTop() else padV)
        val exact = if (isMedia) bubbleW - cl * 2 else 0f
        val pb = MLBlocks()
        eng.layout(row.pre, maxInner, exact, cl, top0, pb)
        val dy = pb.height + s.dp(4f)
        for (r in contentRects()) r.offset(0f, dy)
        if (!L.metaFrame.isEmpty) L.metaFrame.offset(0f, dy)
        bubbleH += dy
        if (!isMedia && pb.width + cl * 2 > bubbleW) {
          val nw = min(bubbleMax, pb.width + cl * 2)
          if (!L.metaFrame.isEmpty) L.metaFrame.offset(nw - bubbleW, 0f)
          bubbleW = nw
        }
        L.ops.addAll(pb.ops); L.actions.addAll(pb.actions)
      }
      if (row.post.isNotEmpty()) {
        val bottom0 = contentRects().maxOfOrNull { it.bottom } ?: (bubbleH - padV)
        val py = bottom0 + s.dp(4f)
        var pw = MLBlocks()
        val exact = if (isMedia) bubbleW - cl * 2 else 0f
        eng.layout(row.post, maxInner, exact, cl, py, pw)
        if (!isMedia) {
          val need = max(pw.width, bubbleW - cl * 2)
          val nw = min(bubbleMax, need + cl * 2)
          if (nw > bubbleW + 0.5f) bubbleW = nw
          if (pw.width + 0.5f < bubbleW - cl * 2) pw = eng.layoutExact(row.post, bubbleW - cl * 2, cl, py)
        }
        var yy = py + pw.height
        val lastP = row.post.last()
        val mp = row.metaPlace.ifEmpty { if (lastP.t == "tx" && lastP.mi) "in" else "below" }
        if (metaV.onMedia) metaV = makeMeta(row, s, onMedia = false)
        if (mp == "none") {
          L.noMeta = true
          bubbleH = yy + padV
        } else {
          val lt = if (mp == "in") pw.lastText else null
          val fits = lt?.text?.let { t -> lt.rect.left + t.lastLineWidth + gap + metaV.width <= bubbleW - cl } ?: false
          if (!fits) yy += metaV.height + s.dp(2f)
          bubbleH = yy + padV
          L.metaFrame.set(bubbleW - cl - metaV.width, bubbleH - padV - metaV.height, bubbleW - cl + s.dp(2f), bubbleH - padV)
        }
        L.ops.addAll(pw.ops); L.actions.addAll(pw.actions)
      }
    }
    L.meta = metaV

    if (hasTop && showBubble) {
      val inner = bubbleW - padH * 2
      if (nameL != null) { L.name = nameL; L.nameFrame.set(padH, nameY, padH + min(inner, nameL.width + 1), nameY + nameL.height) }
      if (fwdL != null) { L.fwd = fwdL; L.fwdFrame.set(padH + fwdIw, fwdY, padH + fwdIw + max(0f, min(inner - fwdIw, fwdL.width + 1)), fwdY + fwdL.height) }
      if (rName != null) {
        L.replyName = rName; L.replyText = rText; L.replyThumb = hasThumb
        L.replyFrame.set(s.dp(4f), replyY, bubbleW - s.dp(4f), replyY + replyH)
      }
    }

    val x = if (row.own) s.width - side - tail - bubbleW else side + tail + gutter
    val top = if (row.first) s.dp(2f) else 0f
    L.bubble.set(x, top, x + bubbleW, top + bubbleH)
    L.showBubble = showBubble
    var h = top + bubbleH
    if (row.reacts.isNotEmpty()) {
      var cx = 0f
      for (r in row.reacts) {
        val str = if (r.count > 1) "${r.emoji} ${r.count}" else r.emoji
        val t = line(str, s.react, th.otherText, s.dp(120f))
        val w = t.width + s.dp(14f)
        L.chips.add(Pair(RectF(cx, 0f, cx + w, s.dp(24f)), t))
        cx += w + s.dp(4f)
      }
      val total = max(0f, cx - s.dp(4f))
      val rx = if (row.own) L.bubble.right - s.dp(6f) - total else L.bubble.left + s.dp(6f)
      val rxx = max(side, rx)
      L.reactsFrame.set(rxx, L.bubble.bottom - s.dp(5f), rxx + total, L.bubble.bottom + s.dp(19f))
      h = L.reactsFrame.bottom
    }
    h += s.dp(if (row.last) 7f else 2f)
    L.height = ceil(h)
    if (row.sel > 0) {
      val cy = L.bubble.centerY()
      L.selCircle.set(s.dp(10f), cy - s.dp(11f), s.dp(32f), cy + s.dp(11f))
    }
    L.replyIconX = if (row.own) s.width - s.dp(44f) else side + gutter
    if (showBubble) L.bubblePath = bubblePath(L.bubble, row.own, row.first, row.last, s.radius, tail, s.dp(5f), s.dp(9f))
    if (row.failed) {
      val sz = s.dp(22f)
      val cy = L.bubble.centerY()
      val fx = if (row.own) L.bubble.left - s.dp(6f) - sz else L.bubble.right + s.dp(6f)
      L.failFrame.set(fx, cy - sz / 2, fx + sz, cy + sz / 2)
    }
    var imgs = 0
    for (o in L.ops) {
      when (o.kind) {
        MLOp.IMAGE, MLOp.AVATAR -> { o.slot = imgs++ }
        MLOp.VNOTE -> { o.slot = imgs++; L.vnote = o }
        MLOp.LOADER -> L.hasLoader = true
      }
      o.text?.let { L.spoilers.addAll(it.spoilers) }
    }
    L.imageOps = imgs
    L.text?.let { L.spoilers.addAll(it.spoilers) }
    return L
  }

  /** Balão com cantos por posição no grupo + rabicho na 1ª do grupo. */
  fun bubblePath(r: RectF, own: Boolean, first: Boolean, last: Boolean, radius: Float, tail: Float, smallR: Float, tailH: Float): Path {
    val big = min(radius, min(r.height() / 2, r.width() / 2))
    val small = min(smallR, big)
    val authorTop = if (first) 0f else small
    val authorBottom = if (last) big else small
    val tl = if (own) big else authorTop
    val tr = if (own) authorTop else big
    val br = if (own) authorBottom else big
    val bl = if (own) big else authorBottom
    val p = Path()
    p.moveTo(r.left + tl, r.top)
    if (own && first) {
      p.lineTo(r.right + tail, r.top)
      p.quadTo(r.right + tail * 0.15f, r.top + tailH * 0.25f, r.right, r.top + tailH)
    } else {
      p.lineTo(r.right - tr, r.top)
      if (tr > 0) p.quadTo(r.right, r.top, r.right, r.top + tr)
    }
    p.lineTo(r.right, r.bottom - br)
    if (br > 0) p.quadTo(r.right, r.bottom, r.right - br, r.bottom)
    p.lineTo(r.left + bl, r.bottom)
    if (bl > 0) p.quadTo(r.left, r.bottom, r.left, r.bottom - bl)
    if (!own && first) {
      p.lineTo(r.left, r.top + tailH)
      p.quadTo(r.left - tail * 0.15f, r.top + tailH * 0.25f, r.left - tail, r.top)
    } else {
      p.lineTo(r.left, r.top + tl)
      if (tl > 0) p.quadTo(r.left, r.top, r.left + tl, r.top)
    }
    p.close()
    return p
  }
}
