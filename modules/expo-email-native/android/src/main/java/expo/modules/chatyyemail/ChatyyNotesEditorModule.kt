package expo.modules.chatyyemail

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.LeadingMarginSpan
import android.text.style.LineBackgroundSpan
import android.text.style.RelativeSizeSpan
import android.text.style.ReplacementSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ScrollView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * [2026-10-16 native-notes-editor] Editor NATIVO de notas (Android). Mesmo
 * contrato do iOS (ios/ChatyyNotesEditorModule.swift). O Editable guarda o
 * texto markdown-leve CRU da nota; só spans mudam (ida e volta = identidade).
 *
 * Props:  initialText, placeholder, fontSize, theme {text, secondary,
 *         placeholder, accent, onAccent, codeBg, highlight, link, tint},
 *         editable, autoFocus, padding, bottomInset
 * Eventos: onChange {text}, onSelectionChange {start, end, block},
 *          onFocusChange {focused}, onSlash {active, query}
 * Métodos: setText(text), getText(), exec(command, arg?), focus(), blur()
 */
class CNThemeRecord : Record {
  @Field val text: Double? = null
  @Field val secondary: Double? = null
  @Field val placeholder: Double? = null
  @Field val accent: Double? = null
  @Field val onAccent: Double? = null
  @Field val codeBg: Double? = null
  @Field val highlight: Double? = null
  @Field val link: Double? = null
  @Field val tint: Double? = null
}

// ── spans próprios (removíveis sem tocar nos do IME/corretor) ───────────────
internal interface CnSpan
internal class CnColor(c: Int) : ForegroundColorSpan(c), CnSpan
internal class CnBg(c: Int) : BackgroundColorSpan(c), CnSpan
internal class CnStyle(s: Int) : StyleSpan(s), CnSpan
internal class CnUnder : UnderlineSpan(), CnSpan
internal class CnStrike : StrikethroughSpan(), CnSpan
internal class CnSize(p: Float) : RelativeSizeSpan(p), CnSpan
internal class CnMono : TypefaceSpan("monospace"), CnSpan
internal class CnIndent(rest: Int) : LeadingMarginSpan.Standard(0, rest), CnSpan

/** Fundo de linha inteira (bloco de código). */
internal class CnBlockBg(private val color: Int) : LineBackgroundSpan, CnSpan {
  override fun drawBackground(
    canvas: Canvas, paint: Paint, left: Int, right: Int, top: Int, baseline: Int, bottom: Int,
    text: CharSequence, start: Int, end: Int, lineNumber: Int,
  ) {
    val old = paint.color
    paint.color = color
    canvas.drawRect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat(), paint)
    paint.color = old
  }
}

/** Divisor (---) e barra da citação. */
internal class CnLine(private val color: Int, private val stroke: Float, private val bar: Float) : LineBackgroundSpan, CnSpan {
  override fun drawBackground(
    canvas: Canvas, paint: Paint, left: Int, right: Int, top: Int, baseline: Int, bottom: Int,
    text: CharSequence, start: Int, end: Int, lineNumber: Int,
  ) {
    val old = paint.color
    val oldStyle = paint.style
    paint.color = color
    paint.style = Paint.Style.FILL
    if (bar > 0f) {
      canvas.drawRoundRect(RectF(left + bar * 0.3f, top + 1f, left + bar * 1.3f, bottom - 1f), bar / 2f, bar / 2f, paint)
    } else {
      val cy = (top + bottom) / 2f
      canvas.drawRect(left.toFloat(), cy - stroke / 2f, right.toFloat(), cy + stroke / 2f, paint)
    }
    paint.color = old
    paint.style = oldStyle
  }
}

/** Marcador transparente de largura fixa que desenha •, ○ ou ● com ✓. */
internal class CnMarker(
  val kind: String, private val widthPx: Int, val iconX: Float, val icon: Float,
  private val ink: Int, private val muted: Int, private val accent: Int, private val onAccent: Int,
) : ReplacementSpan(), CnSpan {
  private val p = Paint(Paint.ANTI_ALIAS_FLAG)

  override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
    if (fm != null) paint.getFontMetricsInt(fm)
    return widthPx
  }

  override fun draw(
    canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float,
    top: Int, y: Int, bottom: Int, paint: Paint,
  ) {
    val cy = y + (paint.ascent() + paint.descent()) / 2f
    val x0 = x + iconX
    when (kind) {
      "bullet" -> {
        val r = (icon * 0.17f).coerceAtLeast(2.5f)
        p.style = Paint.Style.FILL
        p.color = ink
        canvas.drawCircle(x0 + r + icon * 0.15f, cy, r, p)
      }
      "todo" -> {
        val sw = icon * 0.085f
        p.style = Paint.Style.STROKE
        p.strokeWidth = sw
        p.color = muted
        canvas.drawCircle(x0 + icon / 2f, cy, icon / 2f - sw / 2f, p)
      }
      "done" -> {
        p.style = Paint.Style.FILL
        p.color = accent
        canvas.drawCircle(x0 + icon / 2f, cy, icon / 2f, p)
        val top0 = cy - icon / 2f
        val path = Path()
        path.moveTo(x0 + icon * 0.28f, top0 + icon * 0.52f)
        path.lineTo(x0 + icon * 0.44f, top0 + icon * 0.68f)
        path.lineTo(x0 + icon * 0.73f, top0 + icon * 0.35f)
        p.style = Paint.Style.STROKE
        p.strokeWidth = (icon * 0.1f).coerceAtLeast(3f)
        p.strokeCap = Paint.Cap.ROUND
        p.strokeJoin = Paint.Join.ROUND
        p.color = onAccent
        canvas.drawPath(path, p)
      }
      else -> {}
    }
  }
}

internal fun cnColor(v: Double?, fallback: Int): Int {
  if (v == null || v.isNaN() || v.isInfinite()) return fallback
  return v.toLong().toInt()
}

class ChatyyNotesEditorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyNotesEditor")

    Function("apiVersion") { 1 }

    View(ChatyyNotesEditorView::class) {
      Events("onChange", "onSelectionChange", "onFocusChange", "onSlash")

      Prop("initialText") { view: ChatyyNotesEditorView, v: String? -> view.initialText = v }
      Prop("placeholder") { view: ChatyyNotesEditorView, v: String? -> view.placeholderText = v ?: "" }
      Prop("fontSize") { view: ChatyyNotesEditorView, v: Double? -> view.fontSizeSp = (v ?: 17.0).coerceIn(12.0, 28.0).toFloat() }
      Prop("theme") { view: ChatyyNotesEditorView, v: CNThemeRecord? -> view.theme = v ?: CNThemeRecord() }
      Prop("editable") { view: ChatyyNotesEditorView, v: Boolean? -> view.editableProp = v ?: true }
      Prop("autoFocus") { view: ChatyyNotesEditorView, v: Boolean? -> view.autoFocus = v ?: false }
      Prop("padding") { view: ChatyyNotesEditorView, v: Double? -> view.paddingDp = (v ?: 16.0).coerceAtLeast(0.0).toFloat() }
      Prop("bottomInset") { view: ChatyyNotesEditorView, v: Double? -> view.bottomInsetDp = (v ?: 0.0).coerceAtLeast(0.0).toFloat() }

      OnViewDidUpdateProps { view: ChatyyNotesEditorView -> view.didUpdateProps() }

      AsyncFunction("setText") { view: ChatyyNotesEditorView, text: String -> view.setText(text, true) }.runOnQueue(Queues.MAIN)
      AsyncFunction("getText") { view: ChatyyNotesEditorView -> view.currentText() }.runOnQueue(Queues.MAIN)
      AsyncFunction("exec") { view: ChatyyNotesEditorView, command: String, arg: String? -> view.exec(command, arg) }.runOnQueue(Queues.MAIN)
      AsyncFunction("focus") { view: ChatyyNotesEditorView -> view.focusEditor() }.runOnQueue(Queues.MAIN)
      AsyncFunction("blur") { view: ChatyyNotesEditorView -> view.blurEditor() }.runOnQueue(Queues.MAIN)
    }
  }
}

/** EditText: avisa seleção, cola como texto puro e trata o toque na caixa de tarefa. */
@SuppressLint("ViewConstructor", "AppCompatCustomView")
internal class CNEditText(ctx: Context) : EditText(ctx) {
  var onSel: ((Int, Int) -> Unit)? = null
  var hitTest: ((Float, Float) -> IntRange?)? = null
  var onToggle: ((IntRange) -> Unit)? = null
  private var downHit: IntRange? = null

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    onSel?.invoke(selStart, selEnd)
  }

  override fun onTextContextMenuItem(id: Int): Boolean {
    if (id == android.R.id.paste) return super.onTextContextMenuItem(android.R.id.pasteAsPlainText)
    return super.onTextContextMenuItem(id)
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downHit = hitTest?.invoke(event.x, event.y)
        if (downHit != null) return true
      }
      MotionEvent.ACTION_MOVE -> if (downHit != null) return true
      MotionEvent.ACTION_UP -> {
        val h = downHit
        downHit = null
        if (h != null) {
          if (hitTest?.invoke(event.x, event.y) == h) onToggle?.invoke(h)
          return true
        }
      }
      MotionEvent.ACTION_CANCEL -> if (downHit != null) { downHit = null; return true }
    }
    return super.onTouchEvent(event)
  }
}

@SuppressLint("ViewConstructor")
class ChatyyNotesEditorView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  internal val onChange by EventDispatcher()
  internal val onSelectionChange by EventDispatcher()
  internal val onFocusChange by EventDispatcher()
  internal val onSlash by EventDispatcher()

  var initialText: String? = null
  var placeholderText: String = ""
  var fontSizeSp: Float = 17f
  var theme = CNThemeRecord()
  var editableProp = true
  var autoFocus = false
  var paddingDp = 16f
  var bottomInsetDp = 0f

  private val density = resources.displayMetrics.density
  private val main = Handler(Looper.getMainLooper())
  private val scroll = ScrollView(context)
  private val edit = CNEditText(context)

  private var initialApplied = false
  private var autoFocused = false
  private var applying = false
  private var snapping = false
  private var lastCaret = 0
  private var slashActive = false
  private var slashQuery = ""
  private var lastSelKey = ""

  // TextWatcher
  private var insStart = 0
  private var insCount = 0
  private var delCount = 0
  private var pendingMarkerDel: IntRange? = null

  // desfazer/refazer (texto + seleção)
  private data class Snap(val text: String, val sel: Int)
  private val history = ArrayList<Snap>()
  private var historyIndex = -1
  private val snapshotRunnable = Runnable { commitSnapshot() }

  init {
    setBackgroundColor(Color.TRANSPARENT)
    scroll.isFillViewport = true
    scroll.isVerticalScrollBarEnabled = true
    scroll.clipToPadding = false
    edit.background = null
    edit.gravity = Gravity.TOP or Gravity.START
    edit.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
      InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    edit.isSingleLine = false
    edit.setHorizontallyScrolling(false)
    edit.isVerticalScrollBarEnabled = false
    edit.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSizeSp)
    edit.setLineSpacing(2f * density, 1.08f)
    edit.onSel = { s, e -> onSelection(s, e) }
    edit.hitTest = { x, y -> checkboxAt(x, y) }
    edit.onToggle = { r -> toggleBox(r) }
    edit.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
        if (applying) return
        pendingMarkerDel = null
        if (after == 0 && count > 0 && s is Spanned) {
          for (m in s.getSpans(start, start + count, CnMarker::class.java)) {
            val ms = s.getSpanStart(m)
            val me = s.getSpanEnd(m)
            if (start >= ms && start + count <= me) { pendingMarkerDel = ms until (me - count); break }
          }
        }
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
        var dirty = insStart until (insStart + insCount + 1)
        try {
          dirty = handleEdit(e)
          restyle(e, dirty)
        } catch (_: Throwable) {
        } finally {
          applying = false
        }
        afterEdit()
      }
    })
    edit.setOnFocusChangeListener { _, has ->
      if (!has) commitSnapshot()
      onFocusChange(mapOf("focused" to has))
    }
    scroll.addOnLayoutChangeListener { _, _, top, _, bottom, _, oldTop, _, oldBottom ->
      // teclado abriu/fechou (adjustResize) → cursor continua visível
      if ((bottom - top) != (oldBottom - oldTop) && edit.hasFocus()) main.post { ensureCaretVisible() }
    }
    scroll.addView(edit, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  private val ink get() = cnColor(theme.text, Color.BLACK)
  private val muted get() = cnColor(theme.secondary, Color.GRAY)
  private fun alpha(c: Int, a: Float): Int = (((Color.alpha(c) * a).toInt().coerceIn(0, 255)) shl 24) or (c and 0x00FFFFFF)
  private fun dp(v: Float): Int = (v * density).toInt()

  fun didUpdateProps() {
    edit.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSizeSp)
    edit.setTextColor(ink)
    edit.setHintTextColor(cnColor(theme.placeholder, Color.GRAY))
    edit.hint = placeholderText
    val p = dp(paddingDp)
    edit.setPadding(p, dp(8f), p, dp(24f) + dp(bottomInsetDp))
    edit.isEnabled = editableProp
    try {
      val tint = theme.tint
      if (tint != null && android.os.Build.VERSION.SDK_INT >= 29) {
        edit.textCursorDrawable?.setTint(cnColor(tint, Color.BLACK))
        edit.highlightColor = (cnColor(tint, Color.BLACK) and 0x00FFFFFF) or 0x40000000
      }
    } catch (_: Throwable) {}
    if (!initialApplied) {
      initialApplied = true
      setText(initialText ?: "", false)
    } else {
      edit.text?.let { e ->
        applying = true
        try { restyle(e, null) } catch (_: Throwable) {} finally { applying = false }
      }
    }
    if (autoFocus && !autoFocused) {
      autoFocused = true
      main.post { focusEditor() }
    }
  }

  // ── texto ──────────────────────────────────────────────────────────────────

  fun setText(text: String, caretAtEnd: Boolean) {
    applying = true
    try {
      edit.setText(text, android.widget.TextView.BufferType.EDITABLE)
      edit.text?.let { e ->
        restyle(e, null)
        edit.setSelection(if (caretAtEnd) e.length else 0)
      }
    } catch (_: Throwable) {
    } finally {
      applying = false
    }
    history.clear()
    history.add(Snap(currentText(), edit.selectionStart.coerceAtLeast(0)))
    historyIndex = 0
    detectSlash()
    emitSelection(true)
  }

  fun currentText(): String = edit.text?.toString() ?: ""

  private fun afterEdit() {
    onChange(mapOf("text" to currentText()))
    detectSlash()
    emitSelection(false)
    main.removeCallbacks(snapshotRunnable)
    main.postDelayed(snapshotRunnable, 450)
  }

  // ── edição (Enter em lista, apagar marcador) ─────────────────────────────────

  /** Devolve o trecho a reestilizar. */
  private fun handleEdit(e: Editable): IntRange {
    val del = pendingMarkerDel
    pendingMarkerDel = null
    if (del != null && insCount == 0 && delCount > 0) {
      // apagou dentro de um marcador transparente → apaga o marcador inteiro
      val a = del.first.coerceIn(0, e.length)
      val b = (del.last + 1).coerceIn(a, e.length)
      if (b > a) e.delete(a, b)
      edit.setSelection(a.coerceAtMost(e.length))
      return a until a + 1
    }
    if (insCount >= 1 && insCount - delCount == 1) {
      val nl = insStart + insCount - 1
      if (nl in 0 until e.length && e[nl] == '\n') {
        val line = CNMarkdown.lineRange(e, nl)
        if (!CNMarkdown.fenceOpen(e, line.first)) {
          val lineText = e.subSequence(line.first, nl).toString()
          val info = CNMarkdown.classify(lineText, false)
          val listy = info.kind == CNKind.BULLET || info.kind == CNKind.NUMBER || info.kind == CNKind.TODO ||
            info.kind == CNKind.DONE || info.kind == CNKind.QUOTE || info.kind == CNKind.TOGGLE
          if (listy && info.marker > 0 && nl >= line.first + info.marker) {
            val body = lineText.substring(info.marker).trim()
            val next = CNMarkdown.lineRange(e, nl + 1)
            if (body.isEmpty() && next.isEmpty()) {
              // item vazio + Enter → sai da lista (tira o marcador e o "\n")
              e.delete(line.first, nl + 1)
              edit.setSelection(line.first.coerceAtMost(e.length))
              return line.first until line.first + 1
            }
            var marker = lineText.substring(0, info.marker)
            if (info.kind == CNKind.NUMBER) {
              val lead = marker.takeWhile { it == ' ' || it == '\t' }
              val n = marker.trim().takeWhile { it.isDigit() }.toIntOrNull() ?: 0
              marker = "$lead${n + 1}. "
            } else if (info.kind == CNKind.DONE) {
              marker = CNMarkdown.reBox.replace(marker, "[]")
            }
            e.insert(nl + 1, marker)
            edit.setSelection((nl + 1 + marker.length).coerceAtMost(e.length))
            return line.first until (nl + 2 + marker.length)
          }
        }
      }
    }
    return insStart until (insStart + insCount + 1)
  }

  // ── estilo (só spans) ────────────────────────────────────────────────────────

  private fun setSpan(e: Editable, what: Any, a: Int, b: Int) {
    val s = a.coerceIn(0, e.length)
    val t = b.coerceIn(s, e.length)
    if (t > s) e.setSpan(what, s, t, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }

  /** dirty == null → documento inteiro. */
  private fun restyle(e: Editable, dirty: IntRange?) {
    val total = e.length
    var from = 0
    var to = total
    var inFence = false
    if (dirty != null && total > 8000) {
      val a = CNMarkdown.lineRange(e, dirty.first)
      val b = CNMarkdown.lineRange(e, (dirty.last).coerceIn(0, total))
      val touched = e.subSequence(a.first, (b.last + 1).coerceAtMost(total))
      if (!touched.contains('`')) {
        from = a.first
        to = (b.last + 1).coerceAtMost(total)
        inFence = CNMarkdown.fenceOpen(e, from)
      }
    }
    for (sp in e.getSpans(from, to, CnSpan::class.java)) {
      val ss = e.getSpanStart(sp)
      if (from == 0 && to == total || (ss >= from && ss <= to)) e.removeSpan(sp)
    }
    if (total == 0) return
    var loc = from
    while (loc <= to && loc < total) {
      var lineEnd = loc
      while (lineEnd < total && e[lineEnd] != '\n') lineEnd++
      val fullEnd = (lineEnd + 1).coerceAtMost(total)
      val info = CNMarkdown.classify(e.subSequence(loc, lineEnd), inFence)
      styleLine(e, info, loc, lineEnd, fullEnd)
      if (info.kind == CNKind.FENCE) inFence = !inFence
      if (lineEnd >= total) break
      loc = lineEnd + 1
    }
  }

  private fun measure(e: CharSequence, a: Int, b: Int): Int =
    if (b > a) Math.ceil(edit.paint.measureText(e, a, b).toDouble()).toInt() else 0

  private fun styleLine(e: Editable, info: CNLineInfo, ls: Int, le: Int, full: Int) {
    val mk = info.marker.coerceAtMost(le - ls)
    val bs = ls + mk
    val iconPx = edit.textSize * 1.1f
    val codeBg = cnColor(theme.codeBg, 0x1A808080)
    when (info.kind) {
      CNKind.PLAIN -> inline(e, bs, le)
      CNKind.H1, CNKind.H2, CNKind.H3 -> {
        val mult = if (info.kind == CNKind.H1) 1.6f else if (info.kind == CNKind.H2) 1.32f else 1.14f
        setSpan(e, CnSize(mult), ls, le)
        setSpan(e, CnStyle(Typeface.BOLD), ls, le)
        if (mk > 0) {
          setSpan(e, CnColor(alpha(muted, 0.45f)), ls, bs)
          setSpan(e, CnSize(0.5f), ls, bs)
        }
        inline(e, bs, le)
      }
      CNKind.BULLET, CNKind.TODO, CNKind.DONE -> {
        var sym = ls
        while (sym < bs && (e[sym] == ' ' || e[sym] == '\t')) sym++
        val leadW = measure(e, ls, sym)
        val unit = if (info.kind == CNKind.BULLET) Math.round(edit.textSize * 1.25f) else Math.round(iconPx + 9 * density)
        val w = leadW + maxOf(unit, measure(e, sym, bs))
        val kind = if (info.kind == CNKind.BULLET) "bullet" else if (info.kind == CNKind.DONE) "done" else "todo"
        if (mk > 0) {
          setSpan(e, CnMarker(kind, w, leadW.toFloat(), iconPx, ink, muted, cnColor(theme.accent, ink), cnColor(theme.onAccent, Color.WHITE)), ls, bs)
          setSpan(e, CnIndent(w), ls, full)
        }
        if (info.kind == CNKind.DONE && le > bs) {
          setSpan(e, CnColor(muted), bs, le)
          setSpan(e, CnStrike(), bs, le)
        }
        inline(e, bs, le)
      }
      CNKind.NUMBER -> {
        if (mk > 0) setSpan(e, CnColor(muted), ls, bs)
        setSpan(e, CnIndent(measure(e, ls, bs)), ls, full)
        inline(e, bs, le)
      }
      CNKind.QUOTE -> {
        val w = dp(16f)
        if (mk > 0) setSpan(e, CnMarker("quote", w, 0f, iconPx, ink, muted, ink, Color.WHITE), ls, bs)
        setSpan(e, CnLine(alpha(muted, 0.55f), 0f, 3f * density), ls, full)
        setSpan(e, CnIndent(w), ls, full)
        setSpan(e, CnColor(alpha(ink, 0.82f)), bs, le)
        inline(e, bs, le)
      }
      CNKind.DIVIDER -> {
        setSpan(e, CnColor(Color.TRANSPARENT), ls, le)
        setSpan(e, CnLine(alpha(muted, 0.45f), maxOf(1f, density * 0.75f), 0f), ls, full)
      }
      CNKind.FENCE -> {
        setSpan(e, CnMono(), ls, le)
        setSpan(e, CnSize(0.88f), ls, le)
        setSpan(e, CnColor(muted), ls, le)
        setSpan(e, CnBlockBg(codeBg), ls, full)
      }
      CNKind.CODE -> {
        setSpan(e, CnMono(), ls, le)
        setSpan(e, CnSize(0.88f), ls, le)
        setSpan(e, CnBlockBg(codeBg), ls, full)
      }
      CNKind.TOGGLE -> {
        if (mk > 0) setSpan(e, CnColor(muted), ls, bs)
        setSpan(e, CnIndent(measure(e, ls, bs)), ls, full)
        inline(e, bs, le)
      }
      CNKind.IMAGE -> {
        setSpan(e, CnColor(muted), ls, le)
        setSpan(e, CnMono(), ls, le)
      }
    }
  }

  private fun inline(e: Editable, a: Int, b: Int) {
    if (b - a < 2) return
    val dim = alpha(muted, 0.5f)
    for (r in CNMarkdown.inlineRuns(e, a, b)) {
      when (r.style) {
        "code" -> { setSpan(e, CnMono(), r.start, r.end); setSpan(e, CnBg(cnColor(theme.codeBg, 0x1F808080)), r.start, r.end) }
        "bold" -> setSpan(e, CnStyle(Typeface.BOLD), r.start, r.end)
        "italic" -> setSpan(e, CnStyle(Typeface.ITALIC), r.start, r.end)
        "underline" -> setSpan(e, CnUnder(), r.start, r.end)
        "strike" -> setSpan(e, CnStrike(), r.start, r.end)
        "mark" -> setSpan(e, CnBg(cnColor(theme.highlight, 0x38808080)), r.start, r.end)
        "link" -> { setSpan(e, CnColor(cnColor(theme.link, ink)), r.start, r.end); setSpan(e, CnUnder(), r.start, r.end) }
      }
      setSpan(e, CnColor(dim), r.start - r.open, r.start)
      setSpan(e, CnColor(dim), r.end, r.end + r.close)
    }
  }

  // ── seleção / cursor ────────────────────────────────────────────────────────

  private fun onSelection(s: Int, en: Int) {
    if (applying || snapping) return
    val e = edit.text ?: return
    if (s == en && s in 0 until e.length) {
      for (m in e.getSpans(s, s + 1, CnMarker::class.java)) {
        val ms = e.getSpanStart(m)
        val me = e.getSpanEnd(m)
        if (s in ms until me) {
          // cursor nunca fica dentro/antes de um marcador transparente
          val movingLeft = lastCaret == me && s < me
          val target = if (movingLeft && ms > 0) ms - 1 else me
          snapping = true
          try { edit.setSelection(target.coerceIn(0, e.length)) } catch (_: Throwable) {}
          snapping = false
          break
        }
      }
    }
    lastCaret = edit.selectionStart
    detectSlash()
    emitSelection(false)
  }

  private fun ensureCaretVisible() {
    val l = edit.layout ?: return
    val off = edit.selectionEnd.coerceAtLeast(0)
    val line = l.getLineForOffset(off)
    val top = edit.top + edit.totalPaddingTop + l.getLineTop(line)
    val bottom = edit.top + edit.totalPaddingTop + l.getLineBottom(line)
    val pad = dp(24f)
    val visible = scroll.height - dp(bottomInsetDp)
    if (visible <= 0) return
    if (bottom + pad > scroll.scrollY + visible) scroll.smoothScrollTo(0, bottom + pad - visible)
    else if (top < scroll.scrollY) scroll.smoothScrollTo(0, (top - pad).coerceAtLeast(0))
  }

  // ── tarefas ─────────────────────────────────────────────────────────────────

  private fun checkboxAt(x: Float, y: Float): IntRange? {
    val l = edit.layout ?: return null
    val e = edit.text ?: return null
    if (e.isEmpty()) return null
    val off = edit.getOffsetForPosition(x, y)
    val a = (off - 1).coerceAtLeast(0)
    val b = (off + 1).coerceAtMost(e.length)
    for (m in e.getSpans(a, b, CnMarker::class.java)) {
      if (m.kind != "todo" && m.kind != "done") continue
      val ms = e.getSpanStart(m)
      val me = e.getSpanEnd(m)
      val line = l.getLineForOffset(ms)
      val lx = l.getPrimaryHorizontal(ms) + edit.totalPaddingLeft - edit.scrollX + m.iconX
      val top = l.getLineTop(line) + edit.totalPaddingTop - edit.scrollY
      val bottom = l.getLineBottom(line) + edit.totalPaddingTop - edit.scrollY
      if (y >= top - dp(4f) && y <= bottom + dp(4f) && x >= lx - dp(10f) && x <= lx + m.icon + dp(12f)) return ms until me
    }
    return null
  }

  private fun toggleBox(r: IntRange) {
    if (!editableProp) return
    val e = edit.text ?: return
    if (r.last >= e.length) return
    val seg = e.subSequence(r.first, r.last + 1).toString()
    val m = CNMarkdown.reBox.find(seg) ?: return
    val done = m.value.lowercase().contains('x')
    commitSnapshot()
    e.replace(r.first + m.range.first, r.first + m.range.last + 1, if (done) "[]" else "[x]")
    edit.performHapticFeedback(if (done) HapticFeedbackConstants.CLOCK_TICK else HapticFeedbackConstants.VIRTUAL_KEY)
  }

  // ── comandos (toolbar / menu "/") ────────────────────────────────────────────

  fun exec(command: String, arg: String?) {
    val e = edit.text ?: return
    when (command) {
      "block" -> { commitSnapshot(); consumeSlash(e); setBlock(e, arg ?: "plain") }
      "wrap" -> { commitSnapshot(); wrap(e, arg ?: "**") }
      "link" -> { commitSnapshot(); wrapLink(e) }
      "insert" -> if (arg != null) {
        commitSnapshot()
        val s = edit.selectionStart.coerceAtLeast(0); val en = edit.selectionEnd.coerceAtLeast(s)
        e.replace(s, en, arg)
        edit.setSelection((s + arg.length).coerceAtMost(e.length))
      }
      "toggleTodo" -> {
        val line = CNMarkdown.lineRange(e, edit.selectionStart.coerceAtLeast(0))
        val info = CNMarkdown.classify(e.subSequence(line.first, line.last + 1), false)
        if (info.kind == CNKind.TODO || info.kind == CNKind.DONE) toggleBox(line.first until line.first + info.marker)
        else { commitSnapshot(); setBlock(e, "todo") }
      }
      "undo" -> { commitSnapshot(); if (historyIndex > 0) restore(historyIndex - 1) }
      "redo" -> if (historyIndex < history.size - 1) restore(historyIndex + 1)
      else -> return
    }
    edit.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
  }

  private fun consumeSlash(e: Editable) {
    if (!slashActive) return
    val s = edit.selectionStart
    val n = slashQuery.length + 1
    if (s == edit.selectionEnd && s >= n && e.subSequence(s - n, s).toString() == "/$slashQuery") {
      e.delete(s - n, s)
      edit.setSelection(s - n)
    }
  }

  private fun setBlock(e: Editable, kind: String) {
    val sel = edit.selectionStart.coerceAtLeast(0)
    val line = CNMarkdown.lineRange(e, sel)
    val ls = line.first
    val le = line.last + 1
    val text = e.subSequence(ls, le).toString()
    val info = CNMarkdown.classify(text, CNMarkdown.fenceOpen(e, ls))
    val emptyLine = text.substring(info.marker.coerceAtMost(text.length)).isBlank()
    if (kind == "code" || kind == "divider") {
      val block = if (kind == "code") "```\n\n```" else "---\n"
      val caretIn = if (kind == "code") 4 else 4
      if (emptyLine && info.marker == 0) {
        e.replace(ls, le, block)
        edit.setSelection((ls + caretIn).coerceAtMost(e.length))
      } else {
        e.insert(le, "\n" + block)
        edit.setSelection((le + 1 + caretIn).coerceAtMost(e.length))
      }
      return
    }
    if (info.kind == CNKind.FENCE || info.kind == CNKind.CODE || info.kind == CNKind.DIVIDER) return
    var pfx = when (kind) {
      "h1" -> "# "
      "h2" -> "## "
      "h3" -> "### "
      "bullet" -> "- "
      "todo" -> "[] "
      "quote" -> "> "
      "toggle" -> "▸ "
      "number" -> {
        var n = 1
        if (ls > 0) {
          val prev = CNMarkdown.lineRange(e, ls - 1)
          val pt = e.subSequence(prev.first, prev.last + 1).toString()
          if (CNMarkdown.classify(pt, false).kind == CNKind.NUMBER) n = (pt.trim().takeWhile { it.isDigit() }.toIntOrNull() ?: 0) + 1
        }
        "$n. "
      }
      else -> ""
    }
    if (info.kind.block == kind) pfx = ""
    e.replace(ls, ls + info.marker, pfx)
    val caret = maxOf(ls + pfx.length, sel - info.marker + pfx.length)
    edit.setSelection(caret.coerceIn(0, e.length))
  }

  private fun wrap(e: Editable, d: String) {
    val s = edit.selectionStart.coerceAtLeast(0)
    val en = edit.selectionEnd.coerceAtLeast(s)
    if (s == en) {
      e.insert(s, d + d)
      edit.setSelection(s + d.length)
      return
    }
    val dl = d.length
    if (s >= dl && en + dl <= e.length && e.subSequence(s - dl, s).toString() == d && e.subSequence(en, en + dl).toString() == d) {
      e.delete(en, en + dl)
      e.delete(s - dl, s)
      edit.setSelection(s - dl, en - dl)
      return
    }
    e.insert(en, d)
    e.insert(s, d)
    edit.setSelection(s + dl, en + dl)
  }

  private fun wrapLink(e: Editable) {
    val s = edit.selectionStart.coerceAtLeast(0)
    val en = edit.selectionEnd.coerceAtLeast(s)
    val inner = e.subSequence(s, en).toString()
    e.replace(s, en, "[$inner](url)")
    val u = s + inner.length + 3
    edit.setSelection(u.coerceAtMost(e.length), (u + 3).coerceAtMost(e.length))
  }

  // ── histórico ───────────────────────────────────────────────────────────────

  private fun commitSnapshot() {
    main.removeCallbacks(snapshotRunnable)
    val cur = currentText()
    if (historyIndex in history.indices && history[historyIndex].text == cur) return
    while (history.size > historyIndex + 1) history.removeAt(history.size - 1)
    history.add(Snap(cur, edit.selectionStart.coerceAtLeast(0)))
    while (history.size > 100) history.removeAt(0)
    historyIndex = history.size - 1
  }

  private fun restore(i: Int) {
    if (i !in history.indices) return
    historyIndex = i
    val s = history[i]
    applying = true
    try {
      edit.setText(s.text, android.widget.TextView.BufferType.EDITABLE)
      edit.text?.let { e ->
        restyle(e, null)
        edit.setSelection(s.sel.coerceIn(0, e.length))
      }
    } catch (_: Throwable) {
    } finally {
      applying = false
    }
    onChange(mapOf("text" to currentText()))
    detectSlash()
    emitSelection(true)
  }

  // ── foco ────────────────────────────────────────────────────────────────────

  fun focusEditor() {
    if (!edit.hasFocus()) edit.requestFocus()
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

  // ── eventos ─────────────────────────────────────────────────────────────────

  private fun detectSlash() {
    val e = edit.text
    val s = edit.selectionStart
    var active = false
    var q = ""
    if (e != null && s >= 0 && s == edit.selectionEnd && e.isNotEmpty()) {
      val line = CNMarkdown.lineRange(e, s)
      val headLen = s - line.first
      if (headLen in 1..64 && e.getSpans(line.first, line.first + 1, CnMono::class.java).isEmpty()) {
        val head = e.subSequence(line.first, s).toString()
        val m = CNMarkdown.reSlash.find(head)
        if (m != null) { active = true; q = m.groupValues[1] }
      }
    }
    if (active != slashActive || q != slashQuery) {
      slashActive = active
      slashQuery = q
      onSlash(mapOf("active" to active, "query" to q))
    }
  }

  private fun emitSelection(force: Boolean) {
    val e = edit.text ?: return
    val s = edit.selectionStart.coerceAtLeast(0)
    val en = edit.selectionEnd.coerceAtLeast(s)
    var block = "plain"
    if (e.isNotEmpty()) {
      val line = CNMarkdown.lineRange(e, s)
      block = CNMarkdown.classify(e.subSequence(line.first, line.last + 1), CNMarkdown.fenceOpen(e, line.first)).kind.block
    }
    val key = "${en > s}|$block"
    if (force || key != lastSelKey) {
      lastSelKey = key
      onSelectionChange(mapOf("start" to s, "end" to en, "block" to block))
    }
  }
}
