import ExpoModulesCore
import UIKit

// [2026-10-16 native-notes-editor] Editor NATIVO de notas (estilo Apple Notes,
// P&B). O conteúdo da nota é o MESMO texto markdown-leve que o app sempre
// gravou (chatyy_notes.content): o NSTextStorage guarda a string crua e só
// ATRIBUTOS mudam (títulos, listas, tarefas, citação, divisor, código,
// **negrito**, *itálico*, __sublinhado__, ~~tachado~~, ==marca==, `código`,
// [link](url)). Ida e volta = identidade (nenhuma conversão HTML/JSON).
//
// Marcadores de lista/tarefa/citação ficam no texto mas transparentes; o
// NSLayoutManager desenha •, ○ / ● com ✓, barra da citação e o divisor. Tocar
// na caixa marca/desmarca ("[]" ⇄ "[x]", mesmo formato do JS).
//
// Props:  initialText, placeholder, fontSize, theme {text, secondary,
//         placeholder, accent, onAccent, codeBg, highlight, link, tint},
//         editable, autoFocus, padding, bottomInset
// Eventos: onChange {text}, onSelectionChange {start, end, block},
//          onFocusChange {focused}, onSlash {active, query}
// Métodos: setText(text), getText(), exec(command, arg?), focus(), blur()
//   exec: block <h1|h2|h3|bullet|number|todo|quote|toggle|code|divider|plain>,
//         wrap <** | * | __ | ~~ | == | `>, link, insert <texto>, undo, redo

struct CNThemeRecord: Record {
  @Field var text: Double? = nil
  @Field var secondary: Double? = nil
  @Field var placeholder: Double? = nil
  @Field var accent: Double? = nil
  @Field var onAccent: Double? = nil
  @Field var codeBg: Double? = nil
  @Field var highlight: Double? = nil
  @Field var link: Double? = nil
  @Field var tint: Double? = nil
}

extension NSAttributedString.Key {
  /// Ícone desenhado no lugar do marcador: "bullet" | "todo" | "done" | "divider".
  static let cyNoteMark = NSAttributedString.Key("cyNoteMark")
  /// Marcador transparente (cursor não entra; apagar remove inteiro).
  static let cyNoteHidden = NSAttributedString.Key("cyNoteHidden")
  /// Parágrafo de citação (barra à esquerda).
  static let cyNoteQuote = NSAttributedString.Key("cyNoteQuote")
}

enum CNKind: String {
  case plain, h1, h2, h3, bullet, number, todo, done, quote, divider, fence, code, toggle, image
}

struct CNLineInfo {
  let kind: CNKind
  let marker: Int  // tamanho (UTF-16) do prefixo do bloco
}

/// Classificação de linha — MESMAS regras do renderPreview de app/notes.js.
enum CNMarkdown {
  static let reTodo = try! NSRegularExpression(pattern: "^\\s*(?:[-*]\\s+)?\\[\\s*\\]\\s*", options: [])
  static let reDone = try! NSRegularExpression(pattern: "^\\s*(?:[-*]\\s+)?\\[[xX]\\]\\s*", options: [])
  static let reH = try! NSRegularExpression(pattern: "^(#{1,3})\\s+", options: [])
  static let reBullet = try! NSRegularExpression(pattern: "^\\s*[-*]\\s+", options: [])
  static let reNumber = try! NSRegularExpression(pattern: "^\\s*\\d{1,4}\\.\\s+", options: [])
  static let reQuote = try! NSRegularExpression(pattern: "^>\\s+", options: [])
  static let reDivider = try! NSRegularExpression(pattern: "^---+\\s*$", options: [])
  static let reToggle = try! NSRegularExpression(pattern: "^\u{25B8}\\s+", options: [])
  static let reImage = try! NSRegularExpression(pattern: "^!\\[[^\\]]*\\]\\([^)]*\\)\\s*$", options: [])
  static let reSlash = try! NSRegularExpression(pattern: "(?:^|\\s)/([\\w-]{0,24})$", options: [])
  static let reBox = try! NSRegularExpression(pattern: "\\[(?:\\s*|[xX])\\]", options: [])

  static let reBold = try! NSRegularExpression(pattern: "\\*\\*(?=\\S)(.+?)(?<=\\S)\\*\\*", options: [])
  static let reItalic = try! NSRegularExpression(pattern: "(?<![*\\w])\\*(?=[^\\s*])([^*\\n]+?)(?<=[^\\s*])\\*(?![*\\w])", options: [])
  static let reUnder = try! NSRegularExpression(pattern: "__(?=\\S)(.+?)(?<=\\S)__", options: [])
  static let reStrike = try! NSRegularExpression(pattern: "~~(?=\\S)(.+?)(?<=\\S)~~", options: [])
  static let reMark = try! NSRegularExpression(pattern: "==(?=\\S)(.+?)(?<=\\S)==", options: [])
  static let reCode = try! NSRegularExpression(pattern: "`([^`\\n]+)`", options: [])
  static let reLink = try! NSRegularExpression(pattern: "\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)", options: [])

  static func classify(_ line: String, inFence: Bool) -> CNLineInfo {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.hasPrefix("```") { return CNLineInfo(kind: .fence, marker: 0) }
    if inFence { return CNLineInfo(kind: .code, marker: 0) }
    let r = NSRange(location: 0, length: (line as NSString).length)
    if r.length == 0 { return CNLineInfo(kind: .plain, marker: 0) }
    func m(_ re: NSRegularExpression) -> NSTextCheckingResult? {
      return re.firstMatch(in: line, options: [.anchored], range: r)
    }
    if let x = m(reTodo) { return CNLineInfo(kind: .todo, marker: x.range.length) }
    if let x = m(reDone) { return CNLineInfo(kind: .done, marker: x.range.length) }
    if let x = m(reH) {
      let n = x.range(at: 1).length
      return CNLineInfo(kind: n == 1 ? .h1 : (n == 2 ? .h2 : .h3), marker: x.range.length)
    }
    if m(reDivider) != nil { return CNLineInfo(kind: .divider, marker: 0) }
    if let x = m(reBullet) { return CNLineInfo(kind: .bullet, marker: x.range.length) }
    if let x = m(reNumber) { return CNLineInfo(kind: .number, marker: x.range.length) }
    if let x = m(reQuote) { return CNLineInfo(kind: .quote, marker: x.range.length) }
    if let x = m(reToggle) { return CNLineInfo(kind: .toggle, marker: x.range.length) }
    if m(reImage) != nil { return CNLineInfo(kind: .image, marker: 0) }
    return CNLineInfo(kind: .plain, marker: 0)
  }

  /// Linha (sem o "\n") que contém `loc`. Separador = só "\n" (igual ao split('\n') do JS).
  static func lineRange(_ ns: NSString, _ loc: Int) -> NSRange {
    let total = ns.length
    let l = max(0, min(loc, total))
    var start = 0
    if l > 0 {
      let r = ns.range(of: "\n", options: .backwards, range: NSRange(location: 0, length: l))
      start = r.location == NSNotFound ? 0 : r.location + 1
    }
    let rr = ns.range(of: "\n", options: [], range: NSRange(location: l, length: total - l))
    let end = rr.location == NSNotFound ? total : rr.location
    return NSRange(location: start, length: end - start)
  }

  /// Bloco de código aberto antes da linha que começa em `lineStart`?
  static func fenceOpen(_ ns: NSString, before lineStart: Int) -> Bool {
    var open = false
    var p = 0
    let stop = max(0, min(lineStart, ns.length))
    while p < stop {
      let r = ns.range(of: "\n", options: [], range: NSRange(location: p, length: stop - p))
      let end = r.location == NSNotFound ? stop : r.location
      let line = ns.substring(with: NSRange(location: p, length: end - p)).trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("```") { open.toggle() }
      p = end + 1
    }
    return open
  }
}

/// Desenha os ícones dos marcadores, a barra da citação e o divisor.
final class CNLayoutManager: NSLayoutManager {
  var ink: UIColor = .label
  var muted: UIColor = .secondaryLabel
  var accent: UIColor = .label
  var onAccent: UIColor = .systemBackground
  var iconSize: CGFloat = 18

  override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
    super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    guard let ts = textStorage, let tc = textContainers.first, ts.length > 0 else { return }
    let charRange = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
    guard charRange.length > 0 else { return }

    ts.enumerateAttribute(.cyNoteQuote, in: charRange, options: []) { v, r, _ in
      guard (v as? Bool) == true else { return }
      let gr = self.glyphRange(forCharacterRange: r, actualCharacterRange: nil)
      guard gr.length > 0 else { return }
      let rect = self.boundingRect(forGlyphRange: gr, in: tc)
      let bar = CGRect(x: origin.x + tc.lineFragmentPadding + 1, y: origin.y + rect.minY + 1,
                       width: 3, height: max(0, rect.height - 2))
      self.muted.withAlphaComponent(0.55).setFill()
      UIBezierPath(roundedRect: bar, cornerRadius: 1.5).fill()
    }

    ts.enumerateAttribute(.cyNoteMark, in: charRange, options: []) { v, r, _ in
      guard let kind = v as? String, r.length > 0 else { return }
      let gr = self.glyphRange(forCharacterRange: r, actualCharacterRange: nil)
      guard gr.length > 0 else { return }
      let first = self.boundingRect(forGlyphRange: NSRange(location: gr.location, length: 1), in: tc)
      let cy = origin.y + first.midY
      let x0 = origin.x + first.minX
      switch kind {
      case "bullet":
        let d = max(5, self.iconSize * 0.34)
        self.ink.setFill()
        UIBezierPath(ovalIn: CGRect(x: x0 + 3, y: cy - d / 2, width: d, height: d)).fill()
      case "todo":
        let s = self.iconSize
        let p = UIBezierPath(ovalIn: CGRect(x: x0 + 0.75, y: cy - s / 2 + 0.75, width: s - 1.5, height: s - 1.5))
        p.lineWidth = 1.5
        self.muted.setStroke()
        p.stroke()
      case "done":
        let s = self.iconSize
        let box = CGRect(x: x0, y: cy - s / 2, width: s, height: s)
        self.accent.setFill()
        UIBezierPath(ovalIn: box).fill()
        let ck = UIBezierPath()
        ck.move(to: CGPoint(x: box.minX + s * 0.28, y: box.minY + s * 0.52))
        ck.addLine(to: CGPoint(x: box.minX + s * 0.44, y: box.minY + s * 0.68))
        ck.addLine(to: CGPoint(x: box.minX + s * 0.73, y: box.minY + s * 0.35))
        ck.lineWidth = max(1.6, s * 0.1)
        ck.lineCapStyle = .round
        ck.lineJoinStyle = .round
        self.onAccent.setStroke()
        ck.stroke()
      case "divider":
        let scale = UIScreen.main.scale
        let h = max(1 / scale, 1)
        let line = CGRect(x: origin.x + tc.lineFragmentPadding, y: cy - h / 2,
                          width: max(0, tc.size.width - tc.lineFragmentPadding * 2), height: h)
        self.muted.withAlphaComponent(0.45).setFill()
        UIRectFill(line)
      default:
        break
      }
    }
  }
}

final class CNTextView: UITextView {
  weak var owner: ChatyyNotesEditorView?
  let checkTap = UITapGestureRecognizer()

  // Colar = texto puro (a nota é texto; formatação de fora viraria lixo).
  override func paste(_ sender: Any?) {
    if let s = UIPasteboard.general.string, !s.isEmpty {
      insertText(s)
    } else {
      super.paste(sender)
    }
  }

  // Toque numa caixa de tarefa: só o nosso tap reconhece (não posiciona o
  // cursor nem abre o teclado).
  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    if gestureRecognizer === checkTap {
      return owner?.checkboxRun(at: gestureRecognizer.location(in: self)) != nil
    }
    if gestureRecognizer is UITapGestureRecognizer,
       owner?.checkboxRun(at: gestureRecognizer.location(in: self)) != nil {
      return false
    }
    return super.gestureRecognizerShouldBegin(gestureRecognizer)
  }
}

public class ChatyyNotesEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyNotesEditor")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyNotesEditorView.self) {
      Events("onChange", "onSelectionChange", "onFocusChange", "onSlash")

      Prop("initialText") { (view: ChatyyNotesEditorView, v: String?) in view.initialText = v }
      Prop("placeholder") { (view: ChatyyNotesEditorView, v: String?) in view.placeholderText = v ?? "" }
      Prop("fontSize") { (view: ChatyyNotesEditorView, v: Double?) in view.fontSize = CGFloat(max(12, min(28, v ?? 17))) }
      Prop("theme") { (view: ChatyyNotesEditorView, v: CNThemeRecord?) in view.theme = v ?? CNThemeRecord() }
      Prop("editable") { (view: ChatyyNotesEditorView, v: Bool?) in view.editable = v ?? true }
      Prop("autoFocus") { (view: ChatyyNotesEditorView, v: Bool?) in view.autoFocus = v ?? false }
      Prop("padding") { (view: ChatyyNotesEditorView, v: Double?) in view.padding = CGFloat(max(0, v ?? 16)) }
      Prop("bottomInset") { (view: ChatyyNotesEditorView, v: Double?) in view.bottomInset = CGFloat(max(0, v ?? 0)) }

      OnViewDidUpdateProps { (view: ChatyyNotesEditorView) in
        view.didUpdateProps()
      }

      AsyncFunction("setText") { (view: ChatyyNotesEditorView, text: String) in
        view.setText(text)
      }.runOnQueue(.main)

      AsyncFunction("getText") { (view: ChatyyNotesEditorView) -> String in
        return view.currentText()
      }.runOnQueue(.main)

      AsyncFunction("exec") { (view: ChatyyNotesEditorView, command: String, arg: String?) in
        view.exec(command, arg)
      }.runOnQueue(.main)

      AsyncFunction("focus") { (view: ChatyyNotesEditorView) in
        view.focusEditor()
      }.runOnQueue(.main)

      AsyncFunction("blur") { (view: ChatyyNotesEditorView) in
        view.blurEditor()
      }.runOnQueue(.main)
    }
  }
}

public final class ChatyyNotesEditorView: ExpoView, UITextViewDelegate {
  let onChange = EventDispatcher()
  let onSelectionChange = EventDispatcher()
  let onFocusChange = EventDispatcher()
  let onSlash = EventDispatcher()

  var initialText: String? = nil
  var placeholderText: String = ""
  var fontSize: CGFloat = 17
  var theme = CNThemeRecord()
  var editable = true
  var autoFocus = false
  var padding: CGFloat = 16
  var bottomInset: CGFloat = 0

  private let storage = NSTextStorage()
  private let layout = CNLayoutManager()
  private let container = NSTextContainer(size: CGSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
  private var textView: CNTextView!
  private let placeholderLabel = UILabel()

  private var initialApplied = false
  private var autoFocused = false
  private var suppress = false
  private var snapping = false
  private var slashActive = false
  private var slashQuery = ""
  private var lastSelKey = ""
  private var lastFontSize: CGFloat = -1
  private var lastCaret = 0

  private var baseFont: UIFont { UIFont.systemFont(ofSize: fontSize) }
  private var monoFont: UIFont { UIFont.monospacedSystemFont(ofSize: fontSize * 0.88, weight: .regular) }
  private var inkColor: UIColor { cebColor(theme.text, .label) }
  private var mutedColor: UIColor { cebColor(theme.secondary, .secondaryLabel) }

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    storage.addLayoutManager(layout)
    container.widthTracksTextView = true
    layout.addTextContainer(container)
    let tv = CNTextView(frame: bounds, textContainer: container)
    tv.owner = self
    tv.delegate = self
    tv.backgroundColor = .clear
    tv.isScrollEnabled = true
    tv.alwaysBounceVertical = true
    tv.keyboardDismissMode = .interactive
    tv.dataDetectorTypes = []
    tv.autocorrectionType = .default
    tv.spellCheckingType = .default
    // "---" (divisor) e "--" não podem virar travessão; aspas retas no markdown.
    tv.smartDashesType = .no
    tv.smartQuotesType = .no
    tv.adjustsFontForContentSizeCategory = false
    tv.textContainerInset = UIEdgeInsets(top: 8, left: padding - 5, bottom: 24, right: padding - 5)
    tv.checkTap.addTarget(self, action: #selector(onCheckTap(_:)))
    tv.checkTap.cancelsTouchesInView = true
    tv.addGestureRecognizer(tv.checkTap)
    addSubview(tv)
    textView = tv

    placeholderLabel.numberOfLines = 0
    placeholderLabel.isUserInteractionEnabled = false
    tv.addSubview(placeholderLabel)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    layoutPlaceholder()
  }

  private func layoutPlaceholder() {
    let inset = textView.textContainerInset
    let x = inset.left + container.lineFragmentPadding
    let w = max(0, bounds.width - x - inset.right - container.lineFragmentPadding)
    let size = placeholderLabel.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude))
    placeholderLabel.frame = CGRect(x: x, y: inset.top, width: w, height: size.height)
  }

  // MARK: props

  func didUpdateProps() {
    textView.isEditable = editable
    textView.tintColor = cebColor(theme.tint, inkColor)
    let side = max(0, padding - 5)
    textView.textContainerInset = UIEdgeInsets(top: 8, left: side, bottom: 24 + bottomInset, right: side)
    textView.scrollIndicatorInsets = UIEdgeInsets(top: 0, left: 0, bottom: bottomInset, right: 0)
    layout.ink = inkColor
    layout.muted = mutedColor
    layout.accent = cebColor(theme.accent, inkColor)
    layout.onAccent = cebColor(theme.onAccent, .systemBackground)
    layout.iconSize = round(fontSize * 1.1)
    placeholderLabel.text = placeholderText
    placeholderLabel.font = baseFont
    placeholderLabel.textColor = cebColor(theme.placeholder, .placeholderText)
    if !initialApplied {
      initialApplied = true
      setText(initialText ?? "", caretAtEnd: false)
    } else {
      // tema/tamanho mudaram → reestiliza tudo
      restyle(nil)
      layout.invalidateDisplay(forCharacterRange: NSRange(location: 0, length: storage.length))
    }
    lastFontSize = fontSize
    fixTypingAttributes()
    updatePlaceholder()
    setNeedsLayout()
    if autoFocus && !autoFocused {
      autoFocused = true
      DispatchQueue.main.async { [weak self] in self?.focusEditor() }
    }
  }

  // MARK: texto

  func setText(_ text: String, caretAtEnd: Bool = true) {
    suppress = true
    storage.setAttributedString(NSAttributedString(string: text, attributes: baseAttrs()))
    restyle(nil)
    let loc = caretAtEnd ? storage.length : 0
    textView.selectedRange = NSRange(location: loc, length: 0)
    suppress = false
    textView.undoManager?.removeAllActions()
    fixTypingAttributes()
    updatePlaceholder()
    detectSlash()
    emitSelection(force: true)
  }

  func currentText() -> String {
    return storage.string
  }

  private func emitChange() {
    onChange(["text": storage.string])
  }

  private func updatePlaceholder() {
    placeholderLabel.isHidden = storage.length > 0
  }

  // MARK: estilo (só atributos — os caracteres nunca mudam aqui)

  private func baseParagraph() -> NSMutableParagraphStyle {
    let ps = NSMutableParagraphStyle()
    ps.lineSpacing = 2
    ps.paragraphSpacing = 4
    return ps
  }

  private func baseAttrs() -> [NSAttributedString.Key: Any] {
    return [.font: baseFont, .foregroundColor: inkColor, .paragraphStyle: baseParagraph()]
  }

  /// nil = documento inteiro; senão só as linhas que tocam o trecho.
  private func restyle(_ dirty: NSRange?) {
    if textView.markedTextRange != nil { return }
    let str = storage.string
    let ns = str as NSString
    let total = ns.length
    if total == 0 { return }
    var from = 0
    var to = total
    var inFence = false
    if let d = dirty, total > 8000 {
      let a = CNMarkdown.lineRange(ns, d.location)
      let b = CNMarkdown.lineRange(ns, min(total, NSMaxRange(d)))
      let touched = ns.substring(with: NSRange(location: a.location, length: NSMaxRange(b) - a.location))
      if !touched.contains("`") {
        from = a.location
        to = NSMaxRange(b)
        inFence = CNMarkdown.fenceOpen(ns, before: from)
      }
    }
    storage.beginEditing()
    let span = NSRange(location: from, length: min(total, to + 1) - from)
    storage.setAttributes(baseAttrs(), range: span)
    var loc = from
    while loc <= to && loc < total {
      let r = ns.range(of: "\n", options: [], range: NSRange(location: loc, length: total - loc))
      let lineEnd = r.location == NSNotFound ? total : r.location
      let line = NSRange(location: loc, length: lineEnd - loc)
      let full = NSRange(location: loc, length: min(total, lineEnd + 1) - loc)
      let info = CNMarkdown.classify(ns.substring(with: line), inFence: inFence)
      styleLine(info, line: line, full: full, str: str, ns: ns)
      if info.kind == .fence { inFence.toggle() }
      if r.location == NSNotFound { break }
      loc = lineEnd + 1
    }
    storage.endEditing()
  }

  private func markerWidth(_ s: String) -> CGFloat {
    return ceil((s as NSString).size(withAttributes: [.font: baseFont]).width)
  }

  /// Marcador transparente com largura fixa `w` (kern no último caractere).
  private func hideMarker(_ r: NSRange, ns: NSString, width w: CGFloat) -> CGFloat {
    guard r.length > 0 else { return 0 }
    let natural = markerWidth(ns.substring(with: r))
    let target = max(w, natural)
    storage.addAttribute(.foregroundColor, value: UIColor.clear, range: r)
    storage.addAttribute(.cyNoteHidden, value: true, range: r)
    if target > natural {
      storage.addAttribute(.kern, value: target - natural, range: NSRange(location: NSMaxRange(r) - 1, length: 1))
    }
    return target
  }

  /// Parte "símbolo" do marcador (sem o recuo inicial) — onde o ícone é desenhado.
  private func symbolRange(_ r: NSRange, ns: NSString) -> NSRange {
    var s = r.location
    let end = NSMaxRange(r)
    while s < end {
      let c = ns.character(at: s)
      if c != 0x20 && c != 0x09 { break }
      s += 1
    }
    return NSRange(location: s, length: max(0, end - s))
  }

  private func hanging(_ full: NSRange, indent: CGFloat) {
    let ps = baseParagraph()
    ps.headIndent = indent
    storage.addAttribute(.paragraphStyle, value: ps, range: full)
  }

  private func styleLine(_ info: CNLineInfo, line: NSRange, full: NSRange, str: String, ns: NSString) {
    let mk = min(info.marker, line.length)
    let markerR = NSRange(location: line.location, length: mk)
    let bodyR = NSRange(location: line.location + mk, length: line.length - mk)
    switch info.kind {
    case .plain:
      applyInline(bodyR, str: str)
    case .h1, .h2, .h3:
      let mult: CGFloat = info.kind == .h1 ? 1.6 : (info.kind == .h2 ? 1.32 : 1.14)
      let weight: UIFont.Weight = info.kind == .h3 ? .semibold : .bold
      let hf = UIFont.systemFont(ofSize: round(fontSize * mult), weight: weight)
      storage.addAttribute(.font, value: hf, range: full)
      let ps = baseParagraph()
      ps.paragraphSpacingBefore = info.kind == .h1 ? 8 : 4
      storage.addAttribute(.paragraphStyle, value: ps, range: full)
      if mk > 0 {
        storage.addAttribute(.foregroundColor, value: mutedColor.withAlphaComponent(0.45), range: markerR)
        storage.addAttribute(.font, value: UIFont.systemFont(ofSize: round(fontSize * 0.8), weight: .semibold), range: markerR)
      }
      applyInline(bodyR, str: str)
    case .bullet, .todo, .done:
      let sym = symbolRange(markerR, ns: ns)
      let lead = NSRange(location: markerR.location, length: sym.location - markerR.location)
      let leadW = lead.length > 0 ? markerWidth(ns.substring(with: lead)) : 0
      let unit = info.kind == .bullet ? round(fontSize * 1.25) : round(fontSize * 1.1) + 9
      if lead.length > 0 {
        storage.addAttribute(.foregroundColor, value: UIColor.clear, range: lead)
        storage.addAttribute(.cyNoteHidden, value: true, range: lead)
      }
      let w = hideMarker(sym, ns: ns, width: unit)
      if sym.length > 0 {
        storage.addAttribute(.cyNoteHidden, value: true, range: markerR)
        storage.addAttribute(.cyNoteMark, value: info.kind == .bullet ? "bullet" : (info.kind == .done ? "done" : "todo"), range: sym)
      }
      hanging(full, indent: leadW + w)
      if info.kind == .done && bodyR.length > 0 {
        storage.addAttribute(.foregroundColor, value: mutedColor, range: bodyR)
        storage.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: bodyR)
        storage.addAttribute(.strikethroughColor, value: mutedColor, range: bodyR)
      }
      applyInline(bodyR, str: str)
    case .number:
      if mk > 0 {
        storage.addAttribute(.foregroundColor, value: mutedColor, range: markerR)
        storage.addAttribute(.font, value: UIFont.monospacedDigitSystemFont(ofSize: fontSize, weight: .medium), range: markerR)
      }
      hanging(full, indent: markerWidth(ns.substring(with: markerR)))
      applyInline(bodyR, str: str)
    case .quote:
      _ = hideMarker(markerR, ns: ns, width: 16)
      storage.addAttribute(.cyNoteQuote, value: true, range: full)
      hanging(full, indent: 16)
      storage.addAttribute(.foregroundColor, value: inkColor.withAlphaComponent(0.82), range: bodyR)
      applyInline(bodyR, str: str)
    case .divider:
      if line.length > 0 {
        storage.addAttribute(.foregroundColor, value: UIColor.clear, range: line)
        storage.addAttribute(.cyNoteMark, value: "divider", range: line)
      }
    case .fence:
      storage.addAttribute(.font, value: monoFont, range: full)
      storage.addAttribute(.foregroundColor, value: mutedColor, range: full)
      storage.addAttribute(.backgroundColor, value: cebColor(theme.codeBg, UIColor(white: 0.5, alpha: 0.1)), range: full)
    case .code:
      storage.addAttribute(.font, value: monoFont, range: full)
      storage.addAttribute(.backgroundColor, value: cebColor(theme.codeBg, UIColor(white: 0.5, alpha: 0.1)), range: full)
    case .toggle:
      if mk > 0 { storage.addAttribute(.foregroundColor, value: mutedColor, range: markerR) }
      hanging(full, indent: markerWidth(ns.substring(with: markerR)))
      applyInline(bodyR, str: str)
    case .image:
      storage.addAttribute(.foregroundColor, value: mutedColor, range: line)
      storage.addAttribute(.font, value: monoFont, range: line)
    }
  }

  private func addTrait(_ trait: UIFontDescriptor.SymbolicTraits, _ r: NSRange) {
    storage.enumerateAttribute(.font, in: r, options: []) { v, rr, _ in
      let f = (v as? UIFont) ?? self.baseFont
      let t = f.fontDescriptor.symbolicTraits.union(trait)
      if let d = f.fontDescriptor.withSymbolicTraits(t) {
        self.storage.addAttribute(.font, value: UIFont(descriptor: d, size: f.pointSize), range: rr)
      }
    }
  }

  private func applyInline(_ body: NSRange, str: String) {
    guard body.length > 1 else { return }
    let dim = mutedColor.withAlphaComponent(0.5)
    func each(_ re: NSRegularExpression, _ delim: Int, _ apply: (NSRange) -> Void) {
      for m in re.matches(in: str, options: [], range: body) {
        let c = m.range(at: 1)
        guard c.location != NSNotFound, c.length > 0 else { continue }
        apply(c)
        self.storage.addAttribute(.foregroundColor, value: dim, range: NSRange(location: m.range.location, length: delim))
        self.storage.addAttribute(.foregroundColor, value: dim, range: NSRange(location: NSMaxRange(c), length: delim))
      }
    }
    each(CNMarkdown.reCode, 1) { c in
      self.storage.addAttribute(.font, value: self.monoFont, range: c)
      self.storage.addAttribute(.backgroundColor, value: cebColor(self.theme.codeBg, UIColor(white: 0.5, alpha: 0.12)), range: c)
    }
    each(CNMarkdown.reBold, 2) { c in self.addTrait(.traitBold, c) }
    each(CNMarkdown.reItalic, 1) { c in self.addTrait(.traitItalic, c) }
    each(CNMarkdown.reUnder, 2) { c in
      self.storage.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: c)
    }
    each(CNMarkdown.reStrike, 2) { c in
      self.storage.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: c)
    }
    each(CNMarkdown.reMark, 2) { c in
      self.storage.addAttribute(.backgroundColor, value: cebColor(self.theme.highlight, UIColor(white: 0.5, alpha: 0.22)), range: c)
    }
    let linkColor = cebColor(theme.link, inkColor)
    for m in CNMarkdown.reLink.matches(in: str, options: [], range: body) {
      let label = m.range(at: 1)
      guard label.location != NSNotFound else { continue }
      storage.addAttribute(.foregroundColor, value: linkColor, range: label)
      storage.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: label)
      storage.addAttribute(.foregroundColor, value: dim, range: NSRange(location: m.range.location, length: 1))
      let tailLoc = NSMaxRange(label)
      storage.addAttribute(.foregroundColor, value: dim, range: NSRange(location: tailLoc, length: NSMaxRange(m.range) - tailLoc))
    }
  }

  /// Atributos de digitação: nunca herdar a cor transparente do marcador.
  private func fixTypingAttributes() {
    let sel = textView.selectedRange
    var ta: [NSAttributedString.Key: Any] = baseAttrs()
    if sel.location > 0 && sel.location <= storage.length {
      let prev = storage.attributes(at: sel.location - 1, effectiveRange: nil)
      if prev[.cyNoteHidden] == nil, let f = prev[.font] as? UIFont {
        ta[.font] = f
        if let c = prev[.foregroundColor] as? UIColor { ta[.foregroundColor] = c }
      }
      if let ps = prev[.paragraphStyle] { ta[.paragraphStyle] = ps }
    }
    textView.typingAttributes = ta
  }

  private func afterEdit(_ dirty: NSRange?) {
    restyle(dirty)
    fixTypingAttributes()
    updatePlaceholder()
    emitChange()
    detectSlash()
    emitSelection(force: false)
  }

  // MARK: edição programática (passa pelo UITextInput → desfazer do sistema funciona)

  private func replaceChars(_ r: NSRange, _ s: String, caret: Int?) {
    let total = storage.length
    let rr = NSRange(location: max(0, min(r.location, total)), length: max(0, min(r.length, total - min(r.location, total))))
    guard let start = textView.position(from: textView.beginningOfDocument, offset: rr.location),
          let end = textView.position(from: start, offset: rr.length),
          let tr = textView.textRange(from: start, to: end) else { return }
    suppress = true
    textView.replace(tr, withText: s)
    suppress = false
    if let c = caret {
      let loc = max(0, min(storage.length, c))
      textView.selectedRange = NSRange(location: loc, length: 0)
    }
    afterEdit(NSRange(location: rr.location, length: (s as NSString).length))
  }

  // MARK: tarefas

  /// Trecho do marcador da tarefa sob o ponto (coordenadas do textView), ou nil.
  func checkboxRun(at p: CGPoint) -> NSRange? {
    guard storage.length > 0 else { return nil }
    let inset = textView.textContainerInset
    let pt = CGPoint(x: p.x - inset.left, y: p.y - inset.top)
    let gi = layout.glyphIndex(for: pt, in: container, fractionOfDistanceThroughGlyph: nil)
    guard gi < layout.numberOfGlyphs else { return nil }
    let ci = layout.characterIndexForGlyph(at: gi)
    guard ci < storage.length else { return nil }
    var eff = NSRange(location: 0, length: 0)
    guard let kind = storage.attribute(.cyNoteMark, at: ci, effectiveRange: &eff) as? String,
          kind == "todo" || kind == "done" else { return nil }
    let lineRect = layout.lineFragmentRect(forGlyphAt: gi, effectiveRange: nil)
    guard pt.y >= lineRect.minY - 4 && pt.y <= lineRect.maxY + 4 else { return nil }
    let gr = layout.glyphRange(forCharacterRange: eff, actualCharacterRange: nil)
    let mr = layout.boundingRect(forGlyphRange: gr, in: container)
    guard pt.x >= mr.minX - 10 && pt.x <= mr.minX + layout.iconSize + 12 else { return nil }
    return eff
  }

  @objc private func onCheckTap(_ g: UITapGestureRecognizer) {
    guard g.state == .ended, editable, let run = checkboxRun(at: g.location(in: textView)) else { return }
    toggleBox(in: run)
  }

  private func toggleBox(in run: NSRange) {
    let ns = storage.string as NSString
    let s = ns.substring(with: run)
    guard let m = CNMarkdown.reBox.firstMatch(in: s, options: [], range: NSRange(location: 0, length: (s as NSString).length)) else { return }
    let box = (s as NSString).substring(with: m.range)
    let done = box.lowercased().contains("x")
    let r = NSRange(location: run.location + m.range.location, length: m.range.length)
    let repl = done ? "[]" : "[x]"
    let sel = textView.selectedRange
    let delta = (repl as NSString).length - r.length
    let caret = sel.location >= NSMaxRange(r) ? sel.location + delta : sel.location
    replaceChars(r, repl, caret: textView.isFirstResponder ? caret : nil)
    if !done { UIImpactFeedbackGenerator(style: .light).impactOccurred() } else { UISelectionFeedbackGenerator().selectionChanged() }
  }

  // MARK: comandos (toolbar / menu "/")

  func exec(_ command: String, _ arg: String?) {
    switch command {
    case "block": consumeSlash(); setBlock(arg ?? "plain")
    case "wrap": wrap(arg ?? "**")
    case "link": wrapLink()
    case "insert": if let a = arg { let sel = textView.selectedRange; replaceChars(sel, a, caret: sel.location + (a as NSString).length) }
    case "toggleTodo":
      let ns = storage.string as NSString
      let line = CNMarkdown.lineRange(ns, textView.selectedRange.location)
      let info = CNMarkdown.classify(ns.substring(with: line), inFence: false)
      if info.kind == .todo || info.kind == .done {
        toggleBox(in: NSRange(location: line.location, length: info.marker))
      } else {
        setBlock("todo")
      }
    case "undo": textView.undoManager?.undo()
    case "redo": textView.undoManager?.redo()
    default: return
    }
    UISelectionFeedbackGenerator().selectionChanged()
  }

  /// Remove o "/consulta" antes do cursor (menu de blocos).
  private func consumeSlash() {
    guard slashActive else { return }
    let sel = textView.selectedRange
    let n = (slashQuery as NSString).length + 1
    if sel.length == 0 && sel.location >= n {
      let r = NSRange(location: sel.location - n, length: n)
      if (storage.string as NSString).substring(with: r) == "/" + slashQuery {
        replaceChars(r, "", caret: r.location)
      }
    }
  }

  private func blockKey(_ k: CNKind) -> String {
    switch k {
    case .done: return "todo"
    default: return k.rawValue
    }
  }

  private func setBlock(_ kind: String) {
    let ns = storage.string as NSString
    let sel = textView.selectedRange
    let line = CNMarkdown.lineRange(ns, sel.location)
    let text = ns.substring(with: line)
    let info = CNMarkdown.classify(text, inFence: CNMarkdown.fenceOpen(ns, before: line.location))
    let body = (text as NSString).substring(from: min(info.marker, (text as NSString).length))
    let emptyLine = body.trimmingCharacters(in: .whitespaces).isEmpty
    if kind == "code" {
      if emptyLine && info.marker == 0 {
        replaceChars(line, "```\n\n```", caret: line.location + 4)
      } else {
        let at = NSMaxRange(line)
        replaceChars(NSRange(location: at, length: 0), "\n```\n\n```", caret: at + 5)
      }
      return
    }
    if kind == "divider" {
      if emptyLine && info.marker == 0 {
        replaceChars(line, "---\n", caret: line.location + 4)
      } else {
        let at = NSMaxRange(line)
        replaceChars(NSRange(location: at, length: 0), "\n---\n", caret: at + 5)
      }
      return
    }
    if info.kind == .fence || info.kind == .code || info.kind == .divider { return }
    var pfx = ""
    switch kind {
    case "h1": pfx = "# "
    case "h2": pfx = "## "
    case "h3": pfx = "### "
    case "bullet": pfx = "- "
    case "todo": pfx = "[] "
    case "quote": pfx = "> "
    case "toggle": pfx = "\u{25B8} "
    case "number":
      var n = 1
      if line.location > 0 {
        let prev = CNMarkdown.lineRange(ns, line.location - 1)
        let pt = ns.substring(with: prev)
        if CNMarkdown.classify(pt, inFence: false).kind == .number {
          let digits = pt.trimmingCharacters(in: .whitespaces).prefix { $0.isNumber }
          n = (Int(digits) ?? 0) + 1
        }
      }
      pfx = "\(n). "
    default: pfx = ""
    }
    let markerLen = info.marker
    if blockKey(info.kind) == kind { pfx = "" }  // mesmo bloco → desliga
    let newLen = (pfx as NSString).length
    let caret = max(line.location + newLen, sel.location - markerLen + newLen)
    replaceChars(NSRange(location: line.location, length: markerLen), pfx, caret: caret)
  }

  private func wrap(_ d: String) {
    let sel = textView.selectedRange
    let ns = storage.string as NSString
    let dl = (d as NSString).length
    if sel.length == 0 {
      replaceChars(sel, d + d, caret: sel.location + dl)
      return
    }
    // já embrulhado → desembrulha
    if sel.location >= dl && NSMaxRange(sel) + dl <= ns.length,
       ns.substring(with: NSRange(location: sel.location - dl, length: dl)) == d,
       ns.substring(with: NSRange(location: NSMaxRange(sel), length: dl)) == d {
      let inner = ns.substring(with: sel)
      replaceChars(NSRange(location: sel.location - dl, length: sel.length + dl * 2), inner, caret: nil)
      textView.selectedRange = NSRange(location: sel.location - dl, length: sel.length)
      emitSelection(force: true)
      return
    }
    let inner = ns.substring(with: sel)
    replaceChars(sel, d + inner + d, caret: nil)
    textView.selectedRange = NSRange(location: sel.location + dl, length: sel.length)
    emitSelection(force: true)
  }

  private func wrapLink() {
    let sel = textView.selectedRange
    let ns = storage.string as NSString
    let inner = sel.length > 0 ? ns.substring(with: sel) : ""
    let out = "[\(inner)](url)"
    // cursor seleciona "url" p/ digitar o endereço por cima
    replaceChars(sel, out, caret: nil)
    let urlLoc = sel.location + (inner as NSString).length + 3
    textView.selectedRange = NSRange(location: urlLoc, length: 3)
    emitSelection(force: true)
  }

  // MARK: foco

  func focusEditor() {
    if !textView.isFirstResponder { textView.becomeFirstResponder() }
  }

  func blurEditor() {
    if textView.isFirstResponder { textView.resignFirstResponder() }
  }

  // MARK: eventos

  private func detectSlash() {
    let sel = textView.selectedRange
    var active = false
    var q = ""
    if sel.length == 0 && storage.length > 0 {
      let ns = storage.string as NSString
      let line = CNMarkdown.lineRange(ns, sel.location)
      let headLen = sel.location - line.location
      if headLen > 0 && headLen <= 64 {
        let head = ns.substring(with: NSRange(location: line.location, length: headLen))
        let isCode = (storage.attribute(.font, at: line.location, effectiveRange: nil) as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) == true
        if !isCode, let m = CNMarkdown.reSlash.firstMatch(in: head, options: [], range: NSRange(location: 0, length: (head as NSString).length)) {
          active = true
          q = (head as NSString).substring(with: m.range(at: 1))
        }
      }
    }
    if active != slashActive || q != slashQuery {
      slashActive = active
      slashQuery = q
      onSlash(["active": active, "query": q])
    }
  }

  private func emitSelection(force: Bool) {
    let sel = textView.selectedRange
    var block = "plain"
    if storage.length > 0 {
      let ns = storage.string as NSString
      let line = CNMarkdown.lineRange(ns, sel.location)
      let k = CNMarkdown.classify(ns.substring(with: line), inFence: CNMarkdown.fenceOpen(ns, before: line.location)).kind
      block = blockKey(k)
    }
    let key = "\(sel.length > 0)|\(block)"
    if force || key != lastSelKey {
      lastSelKey = key
      onSelectionChange(["start": sel.location, "end": NSMaxRange(sel), "block": block])
    }
  }

  // MARK: UITextViewDelegate

  public func textView(_ tv: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    if suppress || tv.markedTextRange != nil { return true }
    let ns = storage.string as NSString
    let total = ns.length
    let loc = min(range.location, total)
    let line = CNMarkdown.lineRange(ns, loc)

    if text == "\n" && range.length == 0 {
      if CNMarkdown.fenceOpen(ns, before: line.location) { return true }
      let lineText = ns.substring(with: line)
      let info = CNMarkdown.classify(lineText, inFence: false)
      let listy: Set<CNKind> = [.bullet, .number, .todo, .done, .quote, .toggle]
      guard listy.contains(info.kind), info.marker > 0, loc >= line.location + info.marker else { return true }
      let body = (lineText as NSString).substring(from: info.marker).trimmingCharacters(in: .whitespaces)
      if body.isEmpty && loc == NSMaxRange(line) {
        // item vazio + Enter → sai da lista
        replaceChars(NSRange(location: line.location, length: info.marker), "", caret: line.location)
        return false
      }
      var next = (lineText as NSString).substring(to: info.marker)
      if info.kind == .number {
        let lead = String(next.prefix { $0 == " " || $0 == "\t" })
        let digits = next.trimmingCharacters(in: .whitespaces).prefix { $0.isNumber }
        next = lead + "\((Int(digits) ?? 0) + 1). "
      } else if info.kind == .done {
        next = CNMarkdown.reBox.stringByReplacingMatches(in: next, options: [], range: NSRange(location: 0, length: (next as NSString).length), withTemplate: "[]")
      }
      let ins = "\n" + next
      replaceChars(range, ins, caret: range.location + (ins as NSString).length)
      return false
    }

    if text.isEmpty && range.length > 0 && range.location < NSMaxRange(line) {
      // apagar dentro de um marcador transparente apaga o marcador inteiro
      var eff = NSRange(location: 0, length: 0)
      if (storage.attribute(.cyNoteHidden, at: range.location, longestEffectiveRange: &eff, in: line) as? Bool) == true,
         NSMaxRange(range) <= NSMaxRange(eff), eff.location == line.location {
        replaceChars(eff, "", caret: eff.location)
        return false
      }
    }
    return true
  }

  public func textViewDidChange(_ tv: UITextView) {
    if suppress { return }
    let sel = tv.selectedRange
    afterEdit(NSRange(location: max(0, sel.location - 1), length: 1))
  }

  public func textViewDidChangeSelection(_ tv: UITextView) {
    if suppress || snapping { return }
    let sel = tv.selectedRange
    // Cursor nunca fica dentro/antes de um marcador transparente: indo p/ a
    // esquerda (setas/teclado físico) pula p/ o fim da linha anterior; senão
    // vai p/ o começo do texto do item.
    if sel.length == 0 && sel.location < storage.length && tv.markedTextRange == nil,
       (storage.attribute(.cyNoteHidden, at: sel.location, effectiveRange: nil) as? Bool) == true {
      let line = CNMarkdown.lineRange(storage.string as NSString, sel.location)
      if sel.location < NSMaxRange(line) {
        var full = NSRange(location: 0, length: 0)
        _ = storage.attribute(.cyNoteHidden, at: sel.location, longestEffectiveRange: &full, in: line)
        let movingLeft = lastCaret == NSMaxRange(full) && sel.location < lastCaret
        let target = (movingLeft && line.location > 0) ? line.location - 1 : NSMaxRange(full)
        snapping = true
        tv.selectedRange = NSRange(location: target, length: 0)
        snapping = false
      }
    }
    lastCaret = tv.selectedRange.location
    fixTypingAttributes()
    detectSlash()
    emitSelection(force: false)
  }

  public func textViewDidBeginEditing(_ tv: UITextView) {
    onFocusChange(["focused": true])
  }

  public func textViewDidEndEditing(_ tv: UITextView) {
    onFocusChange(["focused": false])
  }
}
