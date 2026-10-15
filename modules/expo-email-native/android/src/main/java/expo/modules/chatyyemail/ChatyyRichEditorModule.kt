package expo.modules.chatyyemail

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * [2026-10-15 native-email] Editor rico NATIVO do compositor (Android). Mesmo
 * contrato do iOS (ios/ChatyyRichEditorModule.swift):
 *
 * Props:  initialHtml, placeholder, fontSize, theme {text, placeholder, link,
 *         quoteBar, tint}, labels {linkTitle, linkPlaceholder, ok, cancel,
 *         removeLink}, editable, autoFocus, padding
 * Eventos: onChange {html, text, empty}, onSelectionChange {formats[]},
 *          onHeightChange {height}, onFocusChange {focused}
 * Métodos: setHtml(html), exec(command, arg?), focus(), blur(), getHtml()
 */
class CREThemeRecord : Record {
  @Field val text: Double? = null
  @Field val placeholder: Double? = null
  @Field val link: Double? = null
  @Field val quoteBar: Double? = null
  @Field val tint: Double? = null
}

internal fun creColor(v: Double?, fallback: Int): Int {
  if (v == null || v.isNaN() || v.isInfinite()) return fallback
  return v.toLong().toInt()
}

class ChatyyRichEditorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyRichEditor")

    Function("apiVersion") { 1 }

    View(ChatyyRichEditorView::class) {
      Events("onChange", "onSelectionChange", "onHeightChange", "onFocusChange")

      Prop("initialHtml") { view: ChatyyRichEditorView, v: String? -> view.initialHtml = v }
      Prop("placeholder") { view: ChatyyRichEditorView, v: String? -> view.placeholderText = v ?: "" }
      Prop("fontSize") { view: ChatyyRichEditorView, v: Double? -> view.fontSizeSp = (v ?: 16.0).coerceIn(10.0, 30.0).toFloat() }
      Prop("theme") { view: ChatyyRichEditorView, v: CREThemeRecord? -> view.theme = v ?: CREThemeRecord() }
      Prop("labels") { view: ChatyyRichEditorView, v: Map<String, String>? -> view.labels = v ?: emptyMap() }
      Prop("editable") { view: ChatyyRichEditorView, v: Boolean? -> view.editableProp = v ?: true }
      Prop("autoFocus") { view: ChatyyRichEditorView, v: Boolean? -> view.autoFocus = v ?: false }
      Prop("padding") { view: ChatyyRichEditorView, v: Double? -> view.paddingDp = (v ?: 12.0).coerceAtLeast(0.0).toFloat() }

      OnViewDidUpdateProps { view: ChatyyRichEditorView -> view.didUpdateProps() }

      AsyncFunction("setHtml") { view: ChatyyRichEditorView, html: String -> view.setHtml(html) }.runOnQueue(Queues.MAIN)
      AsyncFunction("exec") { view: ChatyyRichEditorView, command: String, arg: String? -> view.exec(command, arg) }.runOnQueue(Queues.MAIN)
      AsyncFunction("focus") { view: ChatyyRichEditorView -> view.focusEditor() }.runOnQueue(Queues.MAIN)
      AsyncFunction("blur") { view: ChatyyRichEditorView -> view.blurEditor() }.runOnQueue(Queues.MAIN)
      AsyncFunction("getHtml") { view: ChatyyRichEditorView -> view.currentExport().html }.runOnQueue(Queues.MAIN)
    }
  }
}

/** EditText que avisa seleção e cola SEMPRE como texto puro. */
@SuppressLint("ViewConstructor")
internal class CREEditText(ctx: Context) : EditText(ctx) {
  var onSel: ((Int, Int) -> Unit)? = null

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    onSel?.invoke(selStart, selEnd)
  }

  override fun onTextContextMenuItem(id: Int): Boolean {
    if (id == android.R.id.paste) return super.onTextContextMenuItem(android.R.id.pasteAsPlainText)
    return super.onTextContextMenuItem(id)
  }
}

@SuppressLint("ViewConstructor")
class ChatyyRichEditorView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  internal val onChange by EventDispatcher()
  internal val onSelectionChange by EventDispatcher()
  internal val onHeightChange by EventDispatcher()
  internal val onFocusChange by EventDispatcher()

  var initialHtml: String? = null
  var placeholderText: String = ""
  var fontSizeSp: Float = 16f
  var theme = CREThemeRecord()
  var labels: Map<String, String> = emptyMap()
  var editableProp = true
  var autoFocus = false
  var paddingDp = 12f

  private val density = resources.displayMetrics.density
  private val main = Handler(Looper.getMainLooper())
  private val edit = CREEditText(context)

  private var initialApplied = false
  private var autoFocused = false
  private var applying = false
  private var lastHeight = -1
  private var lastFormats: List<String> = emptyList()

  // estilos pendentes no cursor (toolbar com seleção vazia)
  private val pendingOn = HashSet<String>()
  private val pendingOff = HashSet<String>()

  // último trecho inserido (TextWatcher)
  private var editingAt = 0L
  private var insStart = 0
  private var insCount = 0
  private var delCount = 0

  // histórico próprio (desfazer/refazer da toolbar)
  private data class Snap(val text: SpannableStringBuilder, val selStart: Int, val selEnd: Int)
  private val history = ArrayList<Snap>()
  private var historyIndex = -1
  private val snapshotRunnable = Runnable { commitSnapshot() }
  private val heightRunnable = Runnable { reportHeight() }

  init {
    setBackgroundColor(Color.TRANSPARENT)
    edit.background = null
    edit.gravity = Gravity.TOP or Gravity.START
    edit.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
      InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    edit.isSingleLine = false
    edit.setHorizontallyScrolling(false)
    edit.isVerticalScrollBarEnabled = false
    edit.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSizeSp)
    edit.setLineSpacing(0f, 1.15f)
    edit.onSel = { _, _ ->
      if (!applying) {
        // cursor movido pelo usuário (não pela digitação) → estilos pendentes caducam
        if (android.os.SystemClock.uptimeMillis() - editingAt > 40) { pendingOn.clear(); pendingOff.clear() }
        emitFormats(false)
      }
    }
    edit.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
        editingAt = android.os.SystemClock.uptimeMillis()
      }
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
        if (applying) return
        insStart = start
        insCount = count
        delCount = before
      }
      override fun afterTextChanged(e: Editable?) {
        if (applying || e == null) return
        applying = true
        try {
          handleEdit(e)
        } catch (_: Throwable) {
        } finally {
          applying = false
        }
        afterEdit(true)
      }
    })
    edit.setOnFocusChangeListener { _, has ->
      if (!has) commitSnapshot()
      onFocusChange(mapOf("focused" to has))
    }
    edit.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> scheduleHeight() }
    addView(edit, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  private fun quoteColor() = creColor(theme.quoteBar, Color.parseColor("#C8C8C8"))

  fun didUpdateProps() {
    edit.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSizeSp)
    edit.setTextColor(creColor(theme.text, Color.BLACK))
    edit.setHintTextColor(creColor(theme.placeholder, Color.GRAY))
    edit.setLinkTextColor(creColor(theme.link, Color.parseColor("#2563EB")))
    edit.hint = placeholderText
    val p = (paddingDp * density).toInt()
    edit.setPadding(p, p, p, p)
    edit.isEnabled = editableProp
    try {
      val tint = theme.tint
      if (tint != null && android.os.Build.VERSION.SDK_INT >= 29) {
        edit.textCursorDrawable?.setTint(creColor(tint, Color.BLACK))
        edit.highlightColor = (creColor(tint, Color.BLACK) and 0x00FFFFFF) or 0x40000000
      }
    } catch (_: Throwable) {}
    if (!initialApplied) {
      initialApplied = true
      setHtml(initialHtml ?: "", false)
    }
    if (autoFocus && !autoFocused) {
      autoFocused = true
      main.post { focusEditor() }
    }
    scheduleHeight()
  }

  // ── HTML in/out ───────────────────────────────────────────────────────────

  fun setHtml(html: String, emitHeight: Boolean = true) {
    applying = true
    try {
      val wasFocused = edit.hasFocus()
      val built = CRERich.build(CRERich.parse(html), quoteColor(), density)
      edit.setText(built, android.widget.TextView.BufferType.EDITABLE)
      val e = edit.text
      if (e != null) {
        restyle(e)
        // focado → fim (IA/sugestão anexada); senão começo (assinatura ao abrir)
        edit.setSelection(if (wasFocused) e.length else 0)
      }
    } catch (_: Throwable) {
    } finally {
      applying = false
    }
    pendingOn.clear(); pendingOff.clear()
    history.clear()
    edit.text?.let { history.add(Snap(SpannableStringBuilder(it), edit.selectionStart, edit.selectionEnd)) }
    historyIndex = history.size - 1
    if (emitHeight) scheduleHeight()
    emitFormats(true)
  }

  fun currentExport(): CRERich.Export = edit.text?.let { CRERich.export(it) } ?: CRERich.Export("", "", true)

  private fun emitChange() {
    val ex = currentExport()
    onChange(mapOf("html" to ex.html, "text" to ex.text, "empty" to ex.empty))
  }

  private fun scheduleHeight() {
    main.removeCallbacks(heightRunnable)
    main.post(heightRunnable)
  }

  private fun reportHeight() {
    val w = width
    if (w <= 0) return
    val ws = View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY)
    val hs = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
    edit.measure(ws, hs)
    val hDp = Math.ceil(edit.measuredHeight / density.toDouble()).toInt()
    if (Math.abs(hDp - lastHeight) >= 1) {
      lastHeight = hDp
      onHeightChange(mapOf("height" to hDp.toDouble()))
    }
    // devolve o layout do EditText ao tamanho real da view
    edit.measure(ws, View.MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), View.MeasureSpec.EXACTLY))
    edit.layout(0, 0, w, height.coerceAtLeast(0))
  }

  // ── edição (TextWatcher) ───────────────────────────────────────────────────

  private fun handleEdit(e: Editable) {
    // 1) estilos pendentes aplicados ao trecho recém-digitado
    if (insCount > 0 && (pendingOn.isNotEmpty() || pendingOff.isNotEmpty())) {
      val a = insStart
      val b = (insStart + insCount).coerceAtMost(e.length)
      for (k in pendingOff) removeInline(e, k, a, b)
      val f = CREFlags(
        bold = "bold" in pendingOn, italic = "italic" in pendingOn,
        underline = "underline" in pendingOn, strike = "strikeThrough" in pendingOn,
      )
      CRERich.applyFlags(e, a, b, f)
      // depois do 1º caractere o próprio span (EXCLUSIVE_INCLUSIVE) continua
      pendingOn.clear(); pendingOff.clear()
    }
    // 2) Enter dentro de lista / citação
    if (insCount == 1 && delCount == 0 && insStart < e.length && e[insStart] == '\n') {
      val prev = CRERich.paragraph(e, insStart)
      val paraText = e.subSequence(prev.first, prev.last + 1)
      val (kind, plen) = CRERich.listPrefix(paraText)
      if (kind != CREBlock.NONE) {
        if (paraText.length == plen) {
          // item vazio + Enter → sai da lista (remove o prefixo e o "\n")
          e.delete(prev.first, insStart + 1)
          edit.setSelection(prev.first.coerceAtMost(e.length))
        } else {
          val next = if (kind == CREBlock.UL) CRERich.BULLET else {
            val num = paraText.subSequence(0, plen).toString().trim().trimEnd('.').toIntOrNull() ?: 0
            "${num + 1}. "
          }
          e.insert(insStart + 1, next)
          // prefixo sem estilo inline
          for (k in listOf("bold", "italic", "underline", "strikeThrough")) removeInline(e, k, insStart + 1, insStart + 1 + next.length)
          for (l in e.getSpans(insStart + 1, insStart + 1 + next.length, CyLink::class.java)) {
            val ls = e.getSpanStart(l); val le = e.getSpanEnd(l)
            if (le > insStart) { e.removeSpan(l); if (ls < insStart) e.setSpan(CyLink(l.url), ls, insStart, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
          }
          edit.setSelection((insStart + 1 + next.length).coerceAtMost(e.length))
        }
      } else if (paraText.isEmpty() && CRERich.isQuote(e, prev)) {
        // citação vazia + Enter → sai da citação
        e.delete(insStart, insStart + 1)
        val at = insStart.coerceAtMost(e.length)
        for (q in e.getSpans(prev.first, at, CyQuote::class.java)) {
          val qs = e.getSpanStart(q)
          e.removeSpan(q)
          if (qs < prev.first - 1) e.setSpan(CRERich.newQuote(quoteColor(), density), qs, prev.first - 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        edit.setSelection(at)
      }
    }
    // 3) apagar dentro do prefixo da lista → apaga o resto do prefixo
    if (insCount == 0 && delCount > 0) {
      val p = CRERich.paragraph(e, insStart)
      val t = e.subSequence(p.first, p.last + 1).toString()
      if (insStart == p.first + 1 && t.startsWith("•") && !t.startsWith(CRERich.BULLET)) {
        e.delete(p.first, p.first + 1)
        edit.setSelection(p.first)
      } else {
        val m = Regex("^[0-9]{1,3}\\.(?! )").find(t)
        if (m != null && insStart == p.first + m.value.length) {
          e.delete(p.first, p.first + m.value.length)
          edit.setSelection(p.first)
        }
      }
    }
    restyle(e)
  }

  /** Recuo das linhas quebradas nos itens de lista + renumeração. */
  private fun restyle(e: Editable) {
    val paint = edit.paint
    var olN = 0
    val edits = ArrayList<Triple<Int, Int, String>>()
    val want = ArrayList<Triple<Int, Int, Int>>()
    for (p in CRERich.paragraphs(e)) {
      val t = e.subSequence(p.first, p.last + 1)
      val (kind, plen) = CRERich.listPrefix(t)
      if (kind != CREBlock.NONE) {
        val w = paint.measureText(t, 0, plen).toInt()
        val end = (p.last + 1).coerceAtMost(e.length)
        if (end > p.first) want.add(Triple(p.first, end, w))
      }
      if (kind == CREBlock.OL) {
        olN++
        val want = "$olN. "
        if (t.subSequence(0, plen).toString() != want) edits.add(Triple(p.first, p.first + plen, want))
      } else {
        olN = 0
      }
    }
    // recuos: só mexe nos spans se mudou (evita relayout a cada tecla)
    val have = e.getSpans(0, e.length, CyIndent::class.java)
    val haveT = have.map { Triple(e.getSpanStart(it), e.getSpanEnd(it), it.rest) }.sortedBy { it.first }
    if (haveT != want) {
      for (sp in have) e.removeSpan(sp)
      for ((a, b, w) in want) e.setSpan(CyIndent(w), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    if (edits.isNotEmpty()) {
      val selS = edit.selectionStart; val selE = edit.selectionEnd
      var shiftS = 0; var shiftE = 0
      for ((a, b, s) in edits.asReversed()) {
        e.replace(a, b, s)
        val d = s.length - (b - a)
        if (a < selS) shiftS += d
        if (a < selE) shiftE += d
      }
      val ns = (selS + shiftS).coerceIn(0, e.length)
      val ne = (selE + shiftE).coerceIn(0, e.length)
      edit.setSelection(ns, ne)
    }
  }

  private fun afterEdit(snapshot: Boolean) {
    emitChange()
    scheduleHeight()
    emitFormats(false)
    if (snapshot) {
      main.removeCallbacks(snapshotRunnable)
      main.postDelayed(snapshotRunnable, 450)
    }
  }

  // ── histórico ─────────────────────────────────────────────────────────────

  private fun commitSnapshot() {
    main.removeCallbacks(snapshotRunnable)
    val e = edit.text ?: return
    val cur = SpannableStringBuilder(e)
    if (historyIndex in history.indices && history[historyIndex].text.toString() == cur.toString() &&
      CRERich.export(history[historyIndex].text).html == CRERich.export(cur).html) return
    while (history.size > historyIndex + 1) history.removeAt(history.size - 1)
    history.add(Snap(cur, edit.selectionStart, edit.selectionEnd))
    while (history.size > 80) history.removeAt(0)
    historyIndex = history.size - 1
  }

  private fun restore(i: Int) {
    if (i !in history.indices) return
    historyIndex = i
    val s = history[i]
    applying = true
    try {
      edit.setText(SpannableStringBuilder(s.text), android.widget.TextView.BufferType.EDITABLE)
      val len = edit.text?.length ?: 0
      edit.setSelection(s.selStart.coerceIn(0, len), s.selEnd.coerceIn(0, len))
      edit.text?.let { restyle(it) }
    } catch (_: Throwable) {
    } finally {
      applying = false
    }
    afterEdit(false)
  }

  // ── comandos (toolbar) ────────────────────────────────────────────────────

  private fun spansOf(e: Spanned, k: String, a: Int, b: Int): Array<out Any> = when (k) {
    "bold" -> e.getSpans(a, b, CyBold::class.java)
    "italic" -> e.getSpans(a, b, CyItalic::class.java)
    "underline" -> e.getSpans(a, b, CyUnderline::class.java)
    "strikeThrough" -> e.getSpans(a, b, CyStrike::class.java)
    else -> emptyArray()
  }

  private fun removeInline(e: Editable, k: String, a: Int, b: Int) {
    when (k) {
      "bold" -> CRERich.removeStyle(e, CyBold::class.java, a, b) { CyBold() }
      "italic" -> CRERich.removeStyle(e, CyItalic::class.java, a, b) { CyItalic() }
      "underline" -> CRERich.removeStyle(e, CyUnderline::class.java, a, b) { CyUnderline() }
      "strikeThrough" -> CRERich.removeStyle(e, CyStrike::class.java, a, b) { CyStrike() }
    }
  }

  private fun hasInline(e: Spanned, k: String, a: Int, b: Int): Boolean {
    if (a == b) {
      if (a == 0) return false
      return spansOf(e, k, a - 1, a).any { e.getSpanStart(it) <= a - 1 && e.getSpanEnd(it) >= a }
    }
    // coberto do início ao fim (une os intervalos)
    val iv = spansOf(e, k, a, b).map { e.getSpanStart(it) to e.getSpanEnd(it) }.sortedBy { it.first }
    var reach = a
    for ((s, en) in iv) {
      if (s > reach) return false
      if (en > reach) reach = en
      if (reach >= b) return true
    }
    return reach >= b
  }

  fun exec(command: String, arg: String?) {
    val e = edit.text ?: return
    commitSnapshot()
    val a = minOf(edit.selectionStart, edit.selectionEnd).coerceAtLeast(0)
    val b = maxOf(edit.selectionStart, edit.selectionEnd).coerceAtLeast(0)
    when (command) {
      "bold", "italic", "underline", "strikeThrough" -> {
        if (a == b) {
          val on = if (command in pendingOn) false else if (command in pendingOff) true else !hasInline(e, command, a, a)
          pendingOn.remove(command); pendingOff.remove(command)
          if (on) pendingOn.add(command) else pendingOff.add(command)
          emitFormats(true)
          haptic()
          return
        }
        applying = true
        try {
          if (hasInline(e, command, a, b)) removeInline(e, command, a, b)
          else {
            removeInline(e, command, a, b)
            CRERich.applyFlags(e, a, b, CREFlags(
              bold = command == "bold", italic = command == "italic",
              underline = command == "underline", strike = command == "strikeThrough",
            ))
          }
        } finally { applying = false }
      }
      "insertUnorderedList", "insertOrderedList" -> {
        val kind = if (command == "insertUnorderedList") CREBlock.UL else CREBlock.OL
        applying = true
        try { toggleList(e, kind, a, b) } finally { applying = false }
      }
      "formatBlock" -> {
        applying = true
        try { toggleQuote(e, a, b) } finally { applying = false }
      }
      "createLink" -> {
        if (!arg.isNullOrBlank()) applyLink(arg) else promptLink()
        return
      }
      "unlink" -> {
        applying = true
        try { for (l in e.getSpans(a, b, CyLink::class.java)) e.removeSpan(l) } finally { applying = false }
      }
      "removeFormat" -> {
        pendingOn.clear(); pendingOff.clear()
        if (a == b) { emitFormats(true); return }
        applying = true
        try {
          for (k in listOf("bold", "italic", "underline", "strikeThrough")) removeInline(e, k, a, b)
          for (l in e.getSpans(a, b, CyLink::class.java)) e.removeSpan(l)
        } finally { applying = false }
      }
      "undo" -> { if (historyIndex > 0) restore(historyIndex - 1); return }
      "redo" -> { if (historyIndex < history.size - 1) restore(historyIndex + 1); return }
      else -> return
    }
    applying = true
    try { restyle(e) } finally { applying = false }
    haptic()
    afterEdit(true)
  }

  private fun haptic() {
    try { performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) } catch (_: Throwable) {}
  }

  private fun selectedParagraphs(e: Editable, a: Int, b: Int): List<IntRange> {
    val all = CRERich.paragraphs(e)
    val out = ArrayList<IntRange>()
    for (p in all) {
      val pe = p.last + 1
      if (a == b) {
        if (p.first <= a && a <= pe) { out.add(p); break }
      } else if (p.first < b && pe >= a) {
        if (p.first == b && pe > p.first) continue
        out.add(p)
      }
    }
    if (out.isEmpty()) out.add(all.last())
    return out
  }

  private fun toggleList(e: Editable, kind: CREBlock, a: Int, b: Int) {
    val paras = selectedParagraphs(e, a, b)
    val allKind = paras.all { CRERich.listPrefix(e.subSequence(it.first, it.last + 1)).first == kind }
    var n = 0
    var delta = 0
    for (p in paras.asReversed()) {
      val t = e.subSequence(p.first, p.last + 1)
      val (k, plen) = CRERich.listPrefix(t)
      val newPrefix = if (allKind) "" else { n++; if (kind == CREBlock.UL) CRERich.BULLET else "${paras.size - n + 1}. " }
      val end = p.first + (if (k != CREBlock.NONE) plen else 0)
      e.replace(p.first, end, newPrefix)
      for (k2 in listOf("bold", "italic", "underline", "strikeThrough")) removeInline(e, k2, p.first, p.first + newPrefix.length)
      delta += newPrefix.length - (end - p.first)
    }
    if (paras.size == 1) {
      edit.setSelection((a + delta).coerceIn(0, e.length))
    }
  }

  private fun toggleQuote(e: Editable, a: Int, b: Int) {
    val paras = selectedParagraphs(e, a, b)
    val all = paras.all { CRERich.isQuote(e, it) }
    val start = paras.first().first
    val endPara = paras.last()
    var end = endPara.last + 1
    if (end < e.length) end += 1 // inclui o "\n"
    if (all) {
      for (q in e.getSpans(start, maxOf(start, end), CyQuote::class.java)) {
        val qs = e.getSpanStart(q); val qe = e.getSpanEnd(q)
        e.removeSpan(q)
        if (qs < start) e.setSpan(CRERich.newQuote(quoteColor(), density), qs, start, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (qe > end) e.setSpan(CRERich.newQuote(quoteColor(), density), end, qe, Spanned.SPAN_EXCLUSIVE_INCLUSIVE)
      }
    } else {
      // une com citações vizinhas
      var s = start; var en = end
      for (q in e.getSpans(start, maxOf(start, end), CyQuote::class.java)) {
        s = minOf(s, e.getSpanStart(q)); en = maxOf(en, e.getSpanEnd(q))
        e.removeSpan(q)
      }
      e.setSpan(CRERich.newQuote(quoteColor(), density), s, en, Spanned.SPAN_EXCLUSIVE_INCLUSIVE)
    }
  }

  private fun normalizeUrl(raw: String): String? {
    val t = raw.trim()
    if (t.isEmpty()) return null
    val low = t.lowercase()
    if (low.startsWith("http://") || low.startsWith("https://") || low.startsWith("mailto:") || low.startsWith("tel:")) return t
    if (low.startsWith("javascript:") || low.startsWith("data:") || low.startsWith("file:") || low.startsWith("content:")) return null
    if (t.contains('@') && !t.contains('/')) return "mailto:$t"
    return "https://$t"
  }

  private fun applyLink(raw: String?) {
    val e = edit.text ?: return
    val a = minOf(edit.selectionStart, edit.selectionEnd).coerceAtLeast(0)
    val b = maxOf(edit.selectionStart, edit.selectionEnd).coerceAtLeast(0)
    applying = true
    try {
      if (raw == null) {
        for (l in e.getSpans(a, b, CyLink::class.java)) e.removeSpan(l)
      } else {
        val url = normalizeUrl(raw) ?: return
        if (b > a) {
          for (l in e.getSpans(a, b, CyLink::class.java)) e.removeSpan(l)
          e.setSpan(CyLink(url), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          edit.setSelection(b)
        } else {
          val shown = raw.trim()
          e.insert(a, "$shown ")
          e.setSpan(CyLink(url), a, a + shown.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          edit.setSelection((a + shown.length + 1).coerceAtMost(e.length))
        }
      }
      restyle(e)
    } finally {
      applying = false
    }
    haptic()
    afterEdit(true)
  }

  private fun promptLink() {
    val act = appContext.currentActivity ?: return
    val e = edit.text ?: return
    val a = minOf(edit.selectionStart, edit.selectionEnd).coerceAtLeast(0)
    val b = maxOf(edit.selectionStart, edit.selectionEnd).coerceAtLeast(0)
    val probeA = if (a == b && a > 0) a - 1 else a
    val existing = e.getSpans(probeA, maxOf(probeA, b), CyLink::class.java).firstOrNull()
    var seed = existing?.url ?: ""
    if (seed.isEmpty() && b > a) {
      val s = e.subSequence(a, b).toString().trim()
      if (Regex("^(https?://|www\\.)\\S+$", RegexOption.IGNORE_CASE).matches(s)) seed = s
    }
    val input = EditText(act)
    input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
    input.hint = labels["linkPlaceholder"] ?: "https://"
    input.setText(seed)
    input.setSelection(input.text.length)
    val pad = (20 * density).toInt()
    val box = FrameLayout(act)
    box.setPadding(pad, (8 * density).toInt(), pad, 0)
    box.addView(input)
    val dlg = AlertDialog.Builder(act)
      .setTitle(labels["linkTitle"] ?: "Inserir link")
      .setView(box)
      .setPositiveButton(labels["ok"] ?: "OK") { _, _ ->
        edit.requestFocus()
        edit.setSelection(a.coerceAtMost(e.length), b.coerceAtMost(e.length))
        applyLink(input.text.toString())
      }
      .setNegativeButton(labels["cancel"] ?: "Cancelar") { _, _ -> edit.requestFocus() }
    if (existing != null) {
      dlg.setNeutralButton(labels["removeLink"] ?: "Remover link") { _, _ ->
        val ls = e.getSpanStart(existing); val le = e.getSpanEnd(existing)
        edit.requestFocus()
        if (ls >= 0 && le >= ls) edit.setSelection(ls, le)
        applyLink(null)
      }
    }
    dlg.show()
  }

  // ── foco ──────────────────────────────────────────────────────────────────

  fun focusEditor() {
    edit.requestFocus()
    try {
      val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
      imm?.showSoftInput(edit, InputMethodManager.SHOW_IMPLICIT)
    } catch (_: Throwable) {}
  }

  fun blurEditor() {
    try {
      val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
      imm?.hideSoftInputFromWindow(edit.windowToken, 0)
    } catch (_: Throwable) {}
    edit.clearFocus()
  }

  // ── estado (toolbar ativa) ────────────────────────────────────────────────

  private fun emitFormats(force: Boolean) {
    val e = edit.text ?: return
    val a = minOf(edit.selectionStart, edit.selectionEnd).coerceAtLeast(0)
    val b = maxOf(edit.selectionStart, edit.selectionEnd).coerceAtLeast(0)
    val f = ArrayList<String>()
    for (k in listOf("bold", "italic", "underline", "strikeThrough")) {
      val on = if (a == b) {
        if (k in pendingOn) true else if (k in pendingOff) false else hasInline(e, k, a, a)
      } else hasInline(e, k, a, b)
      if (on) f.add(k)
    }
    val probe = if (a == b && a > 0) a - 1 else a
    if (e.getSpans(probe, maxOf(probe, b), CyLink::class.java).isNotEmpty()) f.add("createLink")
    val p = CRERich.paragraph(e, a)
    when (CRERich.listPrefix(e.subSequence(p.first, p.last + 1)).first) {
      CREBlock.UL -> f.add("insertUnorderedList")
      CREBlock.OL -> f.add("insertOrderedList")
      else -> {}
    }
    if (CRERich.isQuote(e, p)) f.add("formatBlock")
    if (force || f != lastFormats) {
      lastFormats = f
      onSelectionChange(mapOf("formats" to f))
    }
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    main.removeCallbacksAndMessages(null)
  }
}
