package expo.modules.chatyyemail

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Editable
import android.text.Layout
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.LeadingMarginSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.URLSpan
import android.text.style.UnderlineSpan

/**
 * [2026-10-15 native-email] Modelo do editor rico do e-mail (Android) — mesmo
 * conjunto do iOS (ios/CRERich.swift): negrito, itálico, sublinhado, tachado,
 * link; lista com marcador ("• "), numerada ("1. ") e citação. A lista vive no
 * próprio texto (prefixo); a citação é o span CyQuote no parágrafo.
 *
 * Só os spans DESTAS classes são exportados — sublinhado de composição do
 * teclado (Samsung/Gboard) e spans colados de fora nunca viram HTML.
 */
class CyBold : StyleSpan(Typeface.BOLD)
class CyItalic : StyleSpan(Typeface.ITALIC)
class CyUnderline : UnderlineSpan()
class CyStrike : StrikethroughSpan()
class CyLink(url: String) : URLSpan(url)

/** Barra vertical + recuo da citação. */
class CyQuote(private val barColor: Int, private val barWidth: Int, private val gap: Int) : LeadingMarginSpan {
  override fun getLeadingMargin(first: Boolean): Int = barWidth + gap
  override fun drawLeadingMargin(
    c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int,
    text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?
  ) {
    val style = p.style
    val color = p.color
    p.style = Paint.Style.FILL
    p.color = barColor
    c.drawRect(x.toFloat(), top.toFloat(), (x + dir * barWidth).toFloat(), bottom.toFloat(), p)
    p.style = style
    p.color = color
  }
}

/** Recuo das linhas quebradas de um item de lista (alinha com o texto). */
class CyIndent(val rest: Int) : LeadingMarginSpan.Standard(0, rest)

enum class CREBlock { NONE, UL, OL, QUOTE }

data class CREFlags(
  var bold: Boolean = false,
  var italic: Boolean = false,
  var underline: Boolean = false,
  var strike: Boolean = false,
  var link: String? = null,
)

object CRERich {
  const val BULLET = "\u2022 "
  private val OL_RE = Regex("^[0-9]{1,3}\\. ")

  fun listPrefix(para: CharSequence): Pair<CREBlock, Int> {
    if (para.startsWith(BULLET)) return CREBlock.UL to BULLET.length
    val head = para.subSequence(0, minOf(para.length, 6)).toString()
    val m = OL_RE.find(head)
    if (m != null) return CREBlock.OL to m.value.length
    return CREBlock.NONE to 0
  }

  /** Parágrafo (sem o "\n") que contém `loc`. */
  fun paragraph(s: CharSequence, loc: Int): IntRange {
    val total = s.length
    val l = loc.coerceIn(0, total)
    var a = l
    while (a > 0 && s[a - 1] != '\n') a--
    var b = l
    while (b < total && s[b] != '\n') b++
    return a until b
  }

  fun paragraphs(s: CharSequence): List<IntRange> {
    val out = ArrayList<IntRange>()
    var a = 0
    for (i in 0 until s.length) {
      if (s[i] == '\n') { out.add(a until i); a = i + 1 }
    }
    out.add(a until s.length)
    return out
  }

  // ── HTML → texto com spans ────────────────────────────────────────────────

  class Para(var block: CREBlock = CREBlock.NONE, val runs: MutableList<Pair<String, CREFlags>> = ArrayList()) {
    val isEmpty: Boolean get() = runs.all { it.first.isEmpty() }
  }

  private class Frame(
    val name: String,
    var bold: Boolean = false,
    var italic: Boolean = false,
    var underline: Boolean = false,
    var strike: Boolean = false,
    var link: String? = null,
    var list: CREBlock? = null,
    var quote: Boolean = false,
  )

  private val BLOCK_TAGS = setOf(
    "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "blockquote",
    "pre", "table", "tr", "section", "article", "header", "footer", "hr", "dl", "dt", "dd",
  )
  private val VOID_TAGS = setOf("br", "img", "hr", "meta", "link", "input", "wbr", "col", "area", "base", "source", "embed")
  private val SKIP_TAGS = setOf("style", "script", "head", "title", "template", "noscript", "svg", "math")
  private val TAG_RE = Regex("<[a-zA-Z!/][^>]*>")
  private val WS_RE = Regex("[\\t\\n\\r\\u000C ]+")

  fun looksLikeHtml(s: String): Boolean = TAG_RE.containsMatchIn(s)

  fun parse(input: String): List<Para> {
    if (!looksLikeHtml(input)) {
      return input.replace("\r\n", "\n").split("\n").map { line ->
        Para(listPrefix(line).first, mutableListOf(line to CREFlags()))
      }
    }
    val paras = ArrayList<Para>()
    var cur = Para()
    val stack = ArrayList<Frame>()
    var skipUntil: String? = null

    fun ctx(): CREFlags {
      val f = CREFlags()
      for (fr in stack) {
        if (fr.bold) f.bold = true
        if (fr.italic) f.italic = true
        if (fr.underline) f.underline = true
        if (fr.strike) f.strike = true
        if (fr.link != null) f.link = fr.link
      }
      return f
    }
    fun inQuote() = stack.any { it.quote }
    fun endPara() {
      paras.add(cur)
      cur = Para(if (inQuote()) CREBlock.QUOTE else CREBlock.NONE)
    }
    fun ensureBreak() {
      if (!cur.isEmpty) endPara() else cur.block = if (inQuote()) CREBlock.QUOTE else CREBlock.NONE
    }
    fun appendText(raw: String) {
      var t = raw.replace(WS_RE, " ")
      if (cur.isEmpty) t = t.trimStart(' ')
      if (t.isEmpty()) return
      cur.runs.add(t to ctx())
    }

    val n = input.length
    var i = 0
    val textBuf = StringBuilder()
    while (i < n) {
      val c = input[i]
      if (c != '<') { textBuf.append(c); i++; continue }
      if (skipUntil == null && textBuf.isNotEmpty()) appendText(decodeEntities(textBuf.toString()))
      textBuf.setLength(0)
      if (input.startsWith("<!--", i)) {
        val e = input.indexOf("-->", i + 4)
        i = if (e < 0) n else e + 3
        continue
      }
      var j = i + 1
      var q: Char? = null
      while (j < n) {
        val d = input[j]
        if (q != null) { if (d == q) q = null }
        else if (d == '"' || d == '\'') q = d
        else if (d == '>') break
        j++
      }
      if (j >= n) { textBuf.append(input, i, n); break }
      val tagSrc = input.substring(i + 1, j)
      i = j + 1
      val closing = tagSrc.startsWith("/")
      val body = if (closing) tagSrc.substring(1) else tagSrc
      val name = body.takeWhile { it.isLetterOrDigit() }.lowercase()
      if (name.isEmpty()) continue
      val su = skipUntil
      if (su != null) {
        if (closing && name == su) skipUntil = null
        continue
      }
      if (!closing && name in SKIP_TAGS) {
        if (!body.endsWith("/")) skipUntil = name
        continue
      }
      if (closing) {
        if (name in BLOCK_TAGS) ensureBreak()
        val idx = stack.indexOfLast { it.name == name }
        if (idx >= 0) while (stack.size > idx) stack.removeAt(stack.size - 1)
        if (name == "blockquote" || name == "ul" || name == "ol") cur.block = if (inQuote()) CREBlock.QUOTE else CREBlock.NONE
        continue
      }
      when (name) {
        "br" -> { endPara(); continue }
        "hr" -> { ensureBreak(); continue }
        "img" -> { attr(body, "alt")?.let { if (it.isNotEmpty()) appendText(it) }; continue }
      }
      if (name in BLOCK_TAGS) ensureBreak()
      val fr = Frame(name)
      when (name) {
        "b", "strong", "h1", "h2", "h3", "h4", "h5", "h6", "th" -> fr.bold = true
        "i", "em", "cite" -> fr.italic = true
        "u", "ins" -> fr.underline = true
        "s", "strike", "del" -> fr.strike = true
        "a" -> fr.link = attr(body, "href")?.let { sanitizeHref(it) }
        "ul" -> fr.list = CREBlock.UL
        "ol" -> fr.list = CREBlock.OL
        "blockquote" -> fr.quote = true
      }
      attr(body, "style")?.lowercase()?.let { st ->
        if (Regex("font-weight\\s*:\\s*(bold|[6-9]00)").containsMatchIn(st)) fr.bold = true
        if (Regex("font-style\\s*:\\s*italic").containsMatchIn(st)) fr.italic = true
        if (Regex("text-decoration[^;]*underline").containsMatchIn(st)) fr.underline = true
        if (Regex("text-decoration[^;]*line-through").containsMatchIn(st)) fr.strike = true
      }
      if (name == "li") {
        cur.block = stack.lastOrNull { it.list != null }?.list ?: CREBlock.UL
      } else if (name == "blockquote") {
        cur.block = CREBlock.QUOTE
      }
      if (name !in VOID_TAGS && !body.endsWith("/")) stack.add(fr)
    }
    if (skipUntil == null && textBuf.isNotEmpty()) appendText(decodeEntities(textBuf.toString()))
    if (!cur.isEmpty || paras.isEmpty()) paras.add(cur)
    while (paras.size > 1 && paras.last().isEmpty && paras.last().block == CREBlock.NONE) paras.removeAt(paras.size - 1)
    return paras
  }

  fun build(paras: List<Para>, quoteColor: Int, density: Float): SpannableStringBuilder {
    val out = SpannableStringBuilder()
    var olN = 0
    paras.forEachIndexed { idx, p ->
      val pStart = out.length
      var prefix = ""
      when (p.block) {
        CREBlock.UL -> { olN = 0; if (!(p.runs.firstOrNull()?.first ?: "").startsWith(BULLET)) prefix = BULLET }
        CREBlock.OL -> { olN++; if (listPrefix(p.runs.firstOrNull()?.first ?: "").first != CREBlock.OL) prefix = "$olN. " }
        else -> olN = 0
      }
      out.append(prefix)
      for ((t, f) in p.runs) {
        if (t.isEmpty()) continue
        val s = out.length
        out.append(t)
        applyFlags(out, s, out.length, f)
      }
      if (idx < paras.size - 1) out.append("\n")
      if (p.block == CREBlock.QUOTE) {
        out.setSpan(newQuote(quoteColor, density), pStart, out.length, Spanned.SPAN_EXCLUSIVE_INCLUSIVE)
      }
    }
    return out
  }

  fun newQuote(color: Int, density: Float) = CyQuote(color, (3 * density).toInt().coerceAtLeast(2), (11 * density).toInt())

  fun applyFlags(e: Spannable, s: Int, en: Int, f: CREFlags) {
    if (en <= s) return
    val fl = Spanned.SPAN_EXCLUSIVE_INCLUSIVE
    if (f.bold) e.setSpan(CyBold(), s, en, fl)
    if (f.italic) e.setSpan(CyItalic(), s, en, fl)
    if (f.underline) e.setSpan(CyUnderline(), s, en, fl)
    if (f.strike) e.setSpan(CyStrike(), s, en, fl)
    f.link?.let { e.setSpan(CyLink(it), s, en, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
  }

  fun attr(tagBody: String, name: String): String? {
    val re = Regex("(?i)(?:^|\\s)$name\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))")
    val m = re.find(tagBody) ?: return null
    for (g in 2..4) {
      val v = m.groups[g]?.value
      if (v != null) return decodeEntities(v)
    }
    return null
  }

  fun sanitizeHref(h: String): String? {
    val t = h.trim()
    val low = t.lowercase()
    return if (low.startsWith("http://") || low.startsWith("https://") || low.startsWith("mailto:") || low.startsWith("tel:")) t else null
  }

  fun decodeEntities(s: String): String {
    if (!s.contains('&')) return s
    val out = StringBuilder(s.length)
    var i = 0
    while (i < s.length) {
      val c = s[i]
      if (c == '&') {
        val semi = s.indexOf(';', i)
        if (semi > i && semi - i <= 10) {
          val ent = s.substring(i + 1, semi)
          val rep: String? = when (ent.lowercase()) {
            "amp" -> "&"
            "lt" -> "<"
            "gt" -> ">"
            "quot" -> "\""
            "apos", "#39" -> "'"
            "nbsp" -> "\u00A0"
            else -> try {
              when {
                ent.startsWith("#x") || ent.startsWith("#X") -> String(Character.toChars(ent.substring(2).toInt(16)))
                ent.startsWith("#") -> String(Character.toChars(ent.substring(1).toInt()))
                else -> null
              }
            } catch (_: Throwable) { null }
          }
          if (rep != null) { out.append(rep); i = semi + 1; continue }
        }
      }
      out.append(c)
      i++
    }
    return out.toString()
  }

  // ── texto com spans → HTML / texto ────────────────────────────────────────

  fun escape(s: String): String {
    val o = StringBuilder(s.length + 16)
    for (ch in s) {
      when (ch) {
        '&' -> o.append("&amp;")
        '<' -> o.append("&lt;")
        '>' -> o.append("&gt;")
        '"' -> o.append("&quot;")
        '\u00A0' -> o.append("&nbsp;")
        else -> o.append(ch)
      }
    }
    return o.toString().replace("  ", " &nbsp;")
  }

  private fun covers(e: Spanned, span: Any, a: Int, b: Int): Boolean = e.getSpanStart(span) <= a && e.getSpanEnd(span) >= b

  fun flagsAt(e: Spanned, a: Int, b: Int): CREFlags {
    val f = CREFlags()
    for (sp in e.getSpans(a, b, Any::class.java)) {
      if (!covers(e, sp, a, b)) continue
      when (sp) {
        is CyBold -> f.bold = true
        is CyItalic -> f.italic = true
        is CyUnderline -> f.underline = true
        is CyStrike -> f.strike = true
        is CyLink -> f.link = sp.url
      }
    }
    return f
  }

  fun isQuote(e: Spanned, para: IntRange): Boolean {
    val a = para.first
    val b = if (para.isEmpty()) a else para.last + 1
    val probeEnd = if (b < e.length) b + 1 else b
    for (q in e.getSpans(a, maxOf(probeEnd, a), CyQuote::class.java)) {
      val qs = e.getSpanStart(q); val qe = e.getSpanEnd(q)
      if (qs <= a && (qe > a || (qe == a && a == e.length))) return true
    }
    return false
  }

  data class Export(val html: String, val text: String, val empty: Boolean)

  fun export(e: Spanned): Export {
    if (e.isEmpty()) return Export("", "", true)
    val html = StringBuilder()
    val lines = ArrayList<String>()
    var open = CREBlock.NONE
    var any = false
    fun close() {
      when (open) {
        CREBlock.UL -> html.append("</ul>")
        CREBlock.OL -> html.append("</ol>")
        CREBlock.QUOTE -> html.append("</blockquote>")
        else -> {}
      }
      open = CREBlock.NONE
    }
    for (p in paragraphs(e)) {
      val paraText = e.subSequence(p.first, p.last + 1)
      val (kind, plen) = listPrefix(paraText)
      val quote = isQuote(e, p)
      val block = if (kind != CREBlock.NONE) kind else if (quote) CREBlock.QUOTE else CREBlock.NONE
      if (block != open) {
        close()
        when (block) {
          CREBlock.UL -> html.append("<ul>")
          CREBlock.OL -> html.append("<ol>")
          CREBlock.QUOTE -> html.append("<blockquote style=\"margin:0 0 0 2px;padding-left:12px;border-left:3px solid #cccccc;color:#555555\">")
          else -> {}
        }
        open = block
      }
      val cs = p.first + plen
      val ce = p.last + 1
      val inner = StringBuilder()
      if (ce > cs) {
        // pontos de corte = início/fim de qualquer span nosso dentro do parágrafo
        val cuts = sortedSetOf(cs, ce)
        for (sp in e.getSpans(cs, ce, Any::class.java)) {
          if (sp !is CyBold && sp !is CyItalic && sp !is CyUnderline && sp !is CyStrike && sp !is CyLink) continue
          val a = e.getSpanStart(sp); val b = e.getSpanEnd(sp)
          if (a in (cs + 1) until ce) cuts.add(a)
          if (b in (cs + 1) until ce) cuts.add(b)
        }
        val pts = cuts.toList()
        for (k in 0 until pts.size - 1) {
          val a = pts[k]; val b = pts[k + 1]
          if (b <= a) continue
          val f = flagsAt(e, a, b)
          var piece = escape(e.subSequence(a, b).toString())
          if (f.strike) piece = "<s>$piece</s>"
          if (f.underline) piece = "<u>$piece</u>"
          if (f.italic) piece = "<i>$piece</i>"
          if (f.bold) piece = "<b>$piece</b>"
          f.link?.let { piece = "<a href=\"${escape(it)}\">$piece</a>" }
          inner.append(piece)
        }
      }
      val plain = if (ce > cs) e.subSequence(cs, ce).toString() else ""
      if (plain.isNotBlank()) any = true
      val content = if (inner.isEmpty()) "<br>" else inner.toString()
      when (block) {
        CREBlock.UL, CREBlock.OL -> html.append("<li>").append(content).append("</li>")
        else -> html.append("<div>").append(content).append("</div>")
      }
      lines.add((if (quote && kind == CREBlock.NONE) "> " else "") + paraText.toString())
    }
    close()
    if (!any) return Export("", "", true)
    return Export(html.toString(), lines.joinToString("\n"), false)
  }

  /** Remove o estilo `cls` de [a, b) partindo spans que atravessam o trecho. */
  fun <T : Any> removeStyle(e: Editable, cls: Class<T>, a: Int, b: Int, factory: () -> T) {
    for (sp in e.getSpans(a, b, cls)) {
      val s = e.getSpanStart(sp); val en = e.getSpanEnd(sp)
      if (en <= a || s >= b) {
        if (!(s == en && s in a..b)) continue
      }
      val flags = e.getSpanFlags(sp)
      e.removeSpan(sp)
      if (s < a) e.setSpan(factory(), s, a, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      if (en > b) e.setSpan(factory(), b, en, flags)
    }
  }
}
