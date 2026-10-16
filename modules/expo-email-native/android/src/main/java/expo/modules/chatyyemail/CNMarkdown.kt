package expo.modules.chatyyemail

/**
 * [2026-10-16 native-notes-editor] Classificação das linhas da nota — MESMAS
 * regras do renderPreview de app/notes.js e do iOS (ChatyyNotesEditorModule.swift).
 * Puro Kotlin (sem Android) p/ poder testar na JVM. A nota é texto
 * markdown-leve; o editor NUNCA reescreve caracteres ao carregar/estilizar.
 */
enum class CNKind(val key: String) {
  PLAIN("plain"), H1("h1"), H2("h2"), H3("h3"), BULLET("bullet"), NUMBER("number"),
  TODO("todo"), DONE("done"), QUOTE("quote"), DIVIDER("divider"), FENCE("fence"),
  CODE("code"), TOGGLE("toggle"), IMAGE("image");

  /** Chave do bloco p/ a toolbar (tarefa feita = tarefa). */
  val block: String get() = if (this == DONE) "todo" else key
}

data class CNLineInfo(val kind: CNKind, val marker: Int)

data class CNInline(val style: String, val start: Int, val end: Int, val open: Int, val close: Int)

object CNMarkdown {
  private val reTodo = Regex("^\\s*(?:[-*]\\s+)?\\[\\s*\\]\\s*")
  private val reDone = Regex("^\\s*(?:[-*]\\s+)?\\[[xX]\\]\\s*")
  private val reH = Regex("^(#{1,3})\\s+")
  private val reBullet = Regex("^\\s*[-*]\\s+")
  private val reNumber = Regex("^\\s*\\d{1,4}\\.\\s+")
  private val reQuote = Regex("^>\\s+")
  private val reDivider = Regex("^---+\\s*$")
  private val reToggle = Regex("^▸\\s+")
  private val reImage = Regex("^!\\[[^\\]]*\\]\\([^)]*\\)\\s*$")
  val reSlash = Regex("(?:^|\\s)/([\\w-]{0,24})$")
  val reBox = Regex("\\[(?:\\s*|[xX])\\]")

  private val inline = listOf(
    Triple("code", Regex("`([^`\\n]+)`"), 1),
    Triple("bold", Regex("\\*\\*(?=\\S)(.+?)(?<=\\S)\\*\\*"), 2),
    Triple("italic", Regex("(?<![*\\w])\\*(?=[^\\s*])([^*\\n]+?)(?<=[^\\s*])\\*(?![*\\w])"), 1),
    Triple("underline", Regex("__(?=\\S)(.+?)(?<=\\S)__"), 2),
    Triple("strike", Regex("~~(?=\\S)(.+?)(?<=\\S)~~"), 2),
    Triple("mark", Regex("==(?=\\S)(.+?)(?<=\\S)=="), 2),
  )
  private val reLink = Regex("\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)")

  fun classify(line: CharSequence, inFence: Boolean): CNLineInfo {
    val s = line.toString()
    if (s.trim { it == ' ' || it == '\t' }.startsWith("```")) return CNLineInfo(CNKind.FENCE, 0)
    if (inFence) return CNLineInfo(CNKind.CODE, 0)
    if (s.isEmpty()) return CNLineInfo(CNKind.PLAIN, 0)
    reTodo.find(s)?.let { return CNLineInfo(CNKind.TODO, it.value.length) }
    reDone.find(s)?.let { return CNLineInfo(CNKind.DONE, it.value.length) }
    reH.find(s)?.let {
      val n = it.groupValues[1].length
      return CNLineInfo(if (n == 1) CNKind.H1 else if (n == 2) CNKind.H2 else CNKind.H3, it.value.length)
    }
    if (reDivider.containsMatchIn(s)) return CNLineInfo(CNKind.DIVIDER, 0)
    reBullet.find(s)?.let { return CNLineInfo(CNKind.BULLET, it.value.length) }
    reNumber.find(s)?.let { return CNLineInfo(CNKind.NUMBER, it.value.length) }
    reQuote.find(s)?.let { return CNLineInfo(CNKind.QUOTE, it.value.length) }
    reToggle.find(s)?.let { return CNLineInfo(CNKind.TOGGLE, it.value.length) }
    if (reImage.containsMatchIn(s)) return CNLineInfo(CNKind.IMAGE, 0)
    return CNLineInfo(CNKind.PLAIN, 0)
  }

  /** [início, fim) da linha que contém `loc` (sem o "\n"). Separador = só "\n". */
  fun lineRange(s: CharSequence, loc: Int): IntRange {
    val total = s.length
    val l = loc.coerceIn(0, total)
    var start = l
    while (start > 0 && s[start - 1] != '\n') start--
    var end = l
    while (end < total && s[end] != '\n') end++
    return start until end
  }

  /** Bloco de código aberto antes da linha que começa em `lineStart`? */
  fun fenceOpen(s: CharSequence, lineStart: Int): Boolean {
    var open = false
    var p = 0
    val stop = lineStart.coerceIn(0, s.length)
    while (p < stop) {
      var end = p
      while (end < stop && s[end] != '\n') end++
      var a = p
      while (a < end && (s[a] == ' ' || s[a] == '\t')) a++
      if (end - a >= 3 && s[a] == '`' && s[a + 1] == '`' && s[a + 2] == '`') open = !open
      p = end + 1
    }
    return open
  }

  /** Estilos inline dentro de [start, end) do texto. */
  fun inlineRuns(s: CharSequence, start: Int, end: Int): List<CNInline> {
    if (end - start < 2) return emptyList()
    val sub = s.subSequence(start, end).toString()
    val out = ArrayList<CNInline>()
    for ((style, re, d) in inline) {
      for (m in re.findAll(sub)) {
        val g = m.groups[1] ?: continue
        if (g.value.isEmpty()) continue
        out.add(CNInline(style, start + g.range.first, start + g.range.last + 1, d, d))
      }
    }
    for (m in reLink.findAll(sub)) {
      val g = m.groups[1] ?: continue
      val labelEnd = start + g.range.last + 1
      out.add(CNInline("link", start + g.range.first, labelEnd, 1, start + m.range.last + 1 - labelEnd))
    }
    return out
  }
}
