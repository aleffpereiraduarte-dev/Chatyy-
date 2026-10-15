import ExpoModulesCore
import UIKit

// [2026-10-15 native-email] Editor rico NATIVO do compositor de e-mail.
//
// UITextView (TextKit 1, NSLayoutManager próprio p/ a barra da citação) com
// NSAttributedString: negrito, itálico, sublinhado, tachado, link, lista com
// marcador, lista numerada e citação. Entra e sai HTML (CRERich.swift) — o
// envio/rascunho/outbox continuam no JS (app/compose.js via
// components/RichTextEditor.js). Toolbar = a mesma do JS (comandos por `exec`).
//
// Props:  initialHtml, placeholder, fontSize, theme {text, placeholder, link,
//         quoteBar, tint}, labels {linkTitle, linkPlaceholder, ok, cancel,
//         removeLink}, editable, autoFocus, padding
// Eventos: onChange {html, text, empty}, onSelectionChange {formats[]},
//          onHeightChange {height}, onFocusChange {focused}
// Métodos: setHtml(html), exec(command, arg?), focus(), blur(), getHtml()

struct CREThemeRecord: Record {
  @Field var text: Double? = nil
  @Field var placeholder: Double? = nil
  @Field var link: Double? = nil
  @Field var quoteBar: Double? = nil
  @Field var tint: Double? = nil
}

public class ChatyyRichEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyRichEditor")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyRichEditorView.self) {
      Events("onChange", "onSelectionChange", "onHeightChange", "onFocusChange")

      Prop("initialHtml") { (view: ChatyyRichEditorView, v: String?) in view.initialHtml = v }
      Prop("placeholder") { (view: ChatyyRichEditorView, v: String?) in view.placeholderText = v ?? "" }
      Prop("fontSize") { (view: ChatyyRichEditorView, v: Double?) in view.fontSize = CGFloat(max(10, min(30, v ?? 16))) }
      Prop("theme") { (view: ChatyyRichEditorView, v: CREThemeRecord?) in view.theme = v ?? CREThemeRecord() }
      Prop("labels") { (view: ChatyyRichEditorView, v: [String: String]?) in view.labels = v ?? [:] }
      Prop("editable") { (view: ChatyyRichEditorView, v: Bool?) in view.editable = v ?? true }
      Prop("autoFocus") { (view: ChatyyRichEditorView, v: Bool?) in view.autoFocus = v ?? false }
      Prop("padding") { (view: ChatyyRichEditorView, v: Double?) in view.padding = CGFloat(max(0, v ?? 12)) }

      OnViewDidUpdateProps { (view: ChatyyRichEditorView) in
        view.didUpdateProps()
      }

      AsyncFunction("setHtml") { (view: ChatyyRichEditorView, html: String) in
        view.setHtml(html)
      }.runOnQueue(.main)

      AsyncFunction("exec") { (view: ChatyyRichEditorView, command: String, arg: String?) in
        view.exec(command, arg)
      }.runOnQueue(.main)

      AsyncFunction("focus") { (view: ChatyyRichEditorView) in
        view.focusEditor()
      }.runOnQueue(.main)

      AsyncFunction("blur") { (view: ChatyyRichEditorView) in
        view.blurEditor()
      }.runOnQueue(.main)

      AsyncFunction("getHtml") { (view: ChatyyRichEditorView) -> String in
        return view.currentExport().html
      }.runOnQueue(.main)
    }
  }
}

/// Barra vertical à esquerda dos parágrafos com `cyQuote`.
final class CRELayoutManager: NSLayoutManager {
  var quoteColor: UIColor = UIColor(white: 0.8, alpha: 1)

  override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
    super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    guard let ts = textStorage, let tc = textContainers.first, ts.length > 0 else { return }
    let charRange = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
    guard charRange.length > 0 else { return }
    ts.enumerateAttribute(.cyQuote, in: charRange, options: []) { v, r, _ in
      guard (v as? Bool) == true else { return }
      let gr = self.glyphRange(forCharacterRange: r, actualCharacterRange: nil)
      let rect = self.boundingRect(forGlyphRange: gr, in: tc)
      let bar = CGRect(x: origin.x + tc.lineFragmentPadding + 1, y: origin.y + rect.minY,
                       width: 3, height: rect.height)
      self.quoteColor.setFill()
      UIBezierPath(roundedRect: bar, cornerRadius: 1.5).fill()
    }
  }
}

final class CRETextView: UITextView {
  // Colar = só texto (formatação de página web/Word não vira lixo no HTML).
  override func paste(_ sender: Any?) {
    if let s = UIPasteboard.general.string, !s.isEmpty {
      insertText(s)
    } else {
      super.paste(sender)
    }
  }
}

public final class ChatyyRichEditorView: ExpoView, UITextViewDelegate {
  let onChange = EventDispatcher()
  let onSelectionChange = EventDispatcher()
  let onHeightChange = EventDispatcher()
  let onFocusChange = EventDispatcher()

  var initialHtml: String? = nil
  var placeholderText: String = ""
  var fontSize: CGFloat = 16
  var theme = CREThemeRecord()
  var labels: [String: String] = [:]
  var editable = true
  var autoFocus = false
  var padding: CGFloat = 12

  private let storage = NSTextStorage()
  private let layout = CRELayoutManager()
  private let container = NSTextContainer(size: CGSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
  private var textView: CRETextView!
  private let placeholderLabel = UILabel()

  private var initialApplied = false
  private var autoFocused = false
  private var lastHeight: CGFloat = -1
  private var lastFormats: [String] = []
  private var suppress = false

  // Histórico próprio (desfazer/refazer da toolbar): instantâneos.
  private var history: [(NSAttributedString, NSRange)] = []
  private var historyIndex = -1
  private var snapshotWork: DispatchWorkItem?

  private var baseFont: UIFont { UIFont.systemFont(ofSize: fontSize) }
  private var textColor: UIColor { cebColor(theme.text, .label) }

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    storage.addLayoutManager(layout)
    container.widthTracksTextView = true
    layout.addTextContainer(container)
    let tv = CRETextView(frame: bounds, textContainer: container)
    tv.delegate = self
    tv.backgroundColor = .clear
    tv.isScrollEnabled = false
    tv.alwaysBounceVertical = false
    tv.allowsEditingTextAttributes = true
    tv.dataDetectorTypes = []
    tv.autocorrectionType = .default
    tv.spellCheckingType = .default
    tv.smartQuotesType = .default
    tv.keyboardDismissMode = .none
    tv.adjustsFontForContentSizeCategory = false
    tv.textContainerInset = UIEdgeInsets(top: padding, left: padding - 5, bottom: padding, right: padding - 5)
    addSubview(tv)
    textView = tv

    placeholderLabel.numberOfLines = 0
    placeholderLabel.isUserInteractionEnabled = false
    addSubview(placeholderLabel)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    layoutPlaceholder()
    reportHeight()
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
    textView.tintColor = cebColor(theme.tint, tintColor)
    textView.textContainerInset = UIEdgeInsets(top: padding, left: max(0, padding - 5), bottom: padding, right: max(0, padding - 5))
    textView.linkTextAttributes = [
      .foregroundColor: cebColor(theme.link, .systemBlue),
      .underlineStyle: NSUnderlineStyle.single.rawValue,
    ]
    layout.quoteColor = cebColor(theme.quoteBar, UIColor(white: 0.75, alpha: 1))
    placeholderLabel.text = placeholderText
    placeholderLabel.font = baseFont
    placeholderLabel.textColor = cebColor(theme.placeholder, .placeholderText)
    if !initialApplied {
      initialApplied = true
      setHtml(initialHtml ?? "", emitHeight: false)
    } else {
      // tema/tamanho mudaram → reaplica cor/fonte base preservando traços
      recolor()
    }
    var ta = textView.typingAttributes
    ta[.foregroundColor] = textColor
    if storage.length == 0 || ta[.font] == nil { ta[.font] = baseFont }
    textView.typingAttributes = ta
    updatePlaceholder()
    setNeedsLayout()
    if autoFocus && !autoFocused {
      autoFocused = true
      DispatchQueue.main.async { [weak self] in self?.focusEditor() }
    }
  }

  private func recolor() {
    guard storage.length > 0 else { return }
    let sel = textView.selectedRange
    storage.beginEditing()
    storage.enumerateAttribute(.font, in: NSRange(location: 0, length: storage.length), options: []) { v, r, _ in
      let f = (v as? UIFont) ?? self.baseFont
      let t = f.fontDescriptor.symbolicTraits
      self.storage.addAttribute(.font, value: CRERich.font(base: self.baseFont, bold: t.contains(.traitBold), italic: t.contains(.traitItalic)), range: r)
    }
    storage.addAttribute(.foregroundColor, value: textColor, range: NSRange(location: 0, length: storage.length))
    storage.endEditing()
    textView.selectedRange = sel
  }

  // MARK: HTML in/out

  func setHtml(_ html: String, emitHeight: Bool = true) {
    suppress = true
    let paras = CRERich.parse(html)
    let built = CRERich.build(paras, base: baseFont, color: textColor)
    let wasFocused = textView.isFirstResponder
    storage.setAttributedString(built)
    restyle()
    // Focado (IA/sugestão anexada) → cursor no fim; senão no começo (assinatura
    // inserida ao abrir: o usuário escreve ACIMA dela).
    textView.selectedRange = NSRange(location: wasFocused ? storage.length : 0, length: 0)
    if storage.length == 0 {
      textView.typingAttributes = [.font: baseFont, .foregroundColor: textColor]
    }
    suppress = false
    textView.undoManager?.removeAllActions()
    history = [(NSAttributedString(attributedString: storage), textView.selectedRange)]
    historyIndex = 0
    updatePlaceholder()
    if emitHeight { reportHeight() }
    emitFormats(force: true)
  }

  func currentExport() -> (html: String, text: String, empty: Bool) {
    return CRERich.export(storage)
  }

  private func emitChange() {
    let e = currentExport()
    onChange(["html": e.html, "text": e.text, "empty": e.empty])
  }

  private func updatePlaceholder() {
    placeholderLabel.isHidden = storage.length > 0
  }

  private func reportHeight() {
    let w = bounds.width
    guard w > 0 else { return }
    let h = ceil(textView.sizeThatFits(CGSize(width: w, height: CGFloat.greatestFiniteMagnitude)).height)
    let ph = ceil(placeholderLabel.isHidden ? 0 : placeholderLabel.frame.height + textView.textContainerInset.top + textView.textContainerInset.bottom)
    let hh = max(h, ph)
    if abs(hh - lastHeight) >= 1 {
      lastHeight = hh
      onHeightChange(["height": Double(hh)])
    }
  }

  // MARK: parágrafos (recuo de lista, citação, renumeração)

  private func restyle() {
    // Composição em andamento (IME/marcado): não mexe no storage.
    if textView.markedTextRange != nil { return }
    let ns = storage.string as NSString
    let total = ns.length
    if total == 0 { return }
    let sel = textView.selectedRange
    var shift = 0
    var olN = 0
    var edits: [(NSRange, String)] = []
    storage.beginEditing()
    for p in CRERich.paragraphs(ns) {
      let para = ns.substring(with: p) as NSString
      let (kind, plen) = CRERich.listPrefix(para)
      // range com o "\n" que fecha o parágrafo (estilo de parágrafo inteiro)
      var full = p
      if NSMaxRange(full) < total { full.length += 1 }
      if full.length > 0 {
        let quote = (storage.attribute(.cyQuote, at: full.location, effectiveRange: nil) as? Bool) == true
        let ps = NSMutableParagraphStyle()
        ps.paragraphSpacing = 2
        if kind != .none {
          let w = (para.substring(to: plen) as NSString).size(withAttributes: [.font: baseFont]).width
          ps.headIndent = ceil(w) + (quote ? 14 : 0)
          ps.firstLineHeadIndent = quote ? 14 : 0
        } else if quote {
          ps.headIndent = 14
          ps.firstLineHeadIndent = 14
        }
        var eff = NSRange(location: 0, length: 0)
        let cur = storage.attribute(.paragraphStyle, at: full.location, longestEffectiveRange: &eff, in: full) as? NSParagraphStyle
        if cur == nil || !(cur!.isEqual(ps)) || eff.length < full.length {
          storage.addAttribute(.paragraphStyle, value: ps, range: full)
        }
      }
      if kind == .ol {
        olN += 1
        let want = "\(olN). "
        if para.substring(to: plen) != want { edits.append((NSRange(location: p.location, length: plen), want)) }
      } else {
        olN = 0
      }
    }
    // renumeração de trás pra frente (ranges estáveis)
    for (r, str) in edits.reversed() {
      let attrs = storage.attributes(at: r.location, effectiveRange: nil)
      storage.replaceCharacters(in: r, with: NSAttributedString(string: str, attributes: attrs))
      if r.location < sel.location { shift += (str as NSString).length - r.length }
    }
    storage.endEditing()
    if !edits.isEmpty {
      let nl = max(0, min(storage.length, sel.location + shift))
      textView.selectedRange = NSRange(location: nl, length: min(sel.length, storage.length - nl))
      textView.undoManager?.removeAllActions()
    }
  }

  // MARK: histórico

  private func scheduleSnapshot() {
    snapshotWork?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.commitSnapshot() }
    snapshotWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: w)
  }

  private func commitSnapshot() {
    snapshotWork?.cancel()
    snapshotWork = nil
    let snap = NSAttributedString(attributedString: storage)
    if historyIndex >= 0, historyIndex < history.count, history[historyIndex].0.isEqual(to: snap) { return }
    if historyIndex < history.count - 1 { history.removeSubrange((historyIndex + 1)...) }
    history.append((snap, textView.selectedRange))
    if history.count > 80 { history.removeFirst(history.count - 80) }
    historyIndex = history.count - 1
  }

  private func restore(_ i: Int) {
    guard i >= 0, i < history.count else { return }
    historyIndex = i
    let (snap, sel) = history[i]
    suppress = true
    storage.setAttributedString(snap)
    let loc = min(sel.location, storage.length)
    textView.selectedRange = NSRange(location: loc, length: min(sel.length, storage.length - loc))
    suppress = false
    textView.undoManager?.removeAllActions()
    afterEdit(snapshot: false)
  }

  private func afterEdit(snapshot: Bool = true) {
    restyle()
    updatePlaceholder()
    emitChange()
    reportHeight()
    emitFormats(force: false)
    if snapshot { scheduleSnapshot() }
  }

  // MARK: comandos (toolbar)

  func exec(_ command: String, _ arg: String?) {
    commitSnapshot()
    switch command {
    case "bold": toggleTrait(bold: true)
    case "italic": toggleTrait(bold: false)
    case "underline": toggleAttr(.underlineStyle)
    case "strikeThrough": toggleAttr(.strikethroughStyle)
    case "insertUnorderedList": toggleList(.ul)
    case "insertOrderedList": toggleList(.ol)
    case "formatBlock": toggleQuote()
    case "createLink":
      if let a = arg, !a.isEmpty { applyLink(a) } else { promptLink() }
      return
    case "unlink": applyLink(nil)
    case "removeFormat": removeFormat()
    case "undo": if historyIndex > 0 { restore(historyIndex - 1) }; return
    case "redo": if historyIndex < history.count - 1 { restore(historyIndex + 1) }; return
    default: return
    }
    UISelectionFeedbackGenerator().selectionChanged()
  }

  private func toggleTrait(bold: Bool) {
    let sel = textView.selectedRange
    func has(_ f: UIFont) -> Bool {
      let t = f.fontDescriptor.symbolicTraits
      return bold ? t.contains(.traitBold) : t.contains(.traitItalic)
    }
    if sel.length == 0 {
      var ta = textView.typingAttributes
      let f = (ta[.font] as? UIFont) ?? baseFont
      let t = f.fontDescriptor.symbolicTraits
      let on = !has(f)
      ta[.font] = CRERich.font(base: baseFont,
                               bold: bold ? on : t.contains(.traitBold),
                               italic: bold ? t.contains(.traitItalic) : on)
      textView.typingAttributes = ta
      emitFormats(force: true)
      return
    }
    var all = true
    storage.enumerateAttribute(.font, in: sel, options: []) { v, _, stop in
      if !has((v as? UIFont) ?? self.baseFont) { all = false; stop.pointee = true }
    }
    let on = !all
    storage.beginEditing()
    storage.enumerateAttribute(.font, in: sel, options: []) { v, r, _ in
      let f = (v as? UIFont) ?? self.baseFont
      let t = f.fontDescriptor.symbolicTraits
      let nf = CRERich.font(base: self.baseFont,
                            bold: bold ? on : t.contains(.traitBold),
                            italic: bold ? t.contains(.traitItalic) : on)
      self.storage.addAttribute(.font, value: nf, range: r)
    }
    storage.endEditing()
    textView.selectedRange = sel
    textView.undoManager?.removeAllActions()
    afterEdit()
  }

  private func toggleAttr(_ key: NSAttributedString.Key) {
    let sel = textView.selectedRange
    func isOn(_ v: Any?) -> Bool {
      if let n = v as? NSNumber { return n.intValue != 0 }
      if let n = v as? Int { return n != 0 }
      return false
    }
    if sel.length == 0 {
      var ta = textView.typingAttributes
      if isOn(ta[key]) { ta.removeValue(forKey: key) } else { ta[key] = NSUnderlineStyle.single.rawValue }
      textView.typingAttributes = ta
      emitFormats(force: true)
      return
    }
    var all = true
    storage.enumerateAttribute(key, in: sel, options: []) { v, _, stop in
      if !isOn(v) { all = false; stop.pointee = true }
    }
    storage.beginEditing()
    if all { storage.removeAttribute(key, range: sel) } else { storage.addAttribute(key, value: NSUnderlineStyle.single.rawValue, range: sel) }
    storage.endEditing()
    textView.selectedRange = sel
    textView.undoManager?.removeAllActions()
    afterEdit()
  }

  /// Parágrafos tocados pela seleção (ranges sem o "\n" final).
  private func selectedParagraphs() -> [NSRange] {
    let ns = storage.string as NSString
    let sel = textView.selectedRange
    let selEnd = NSMaxRange(sel)
    let all = CRERich.paragraphs(ns)
    var out: [NSRange] = []
    for p in all {
      let pEnd = NSMaxRange(p)
      if sel.length == 0 {
        if p.location <= sel.location && sel.location <= pEnd { out.append(p); break }
      } else if p.location < selEnd && pEnd >= sel.location {
        // seleção que só encosta no início do parágrafo seguinte não o inclui
        if p.location == selEnd && p.length > 0 { continue }
        out.append(p)
      }
    }
    if out.isEmpty, let last = all.last { out.append(last) }
    return out
  }

  private func isQuote(_ p: NSRange) -> Bool {
    if p.length > 0 || p.location < storage.length {
      return (storage.attribute(.cyQuote, at: p.location, effectiveRange: nil) as? Bool) == true
    }
    return (textView.typingAttributes[.cyQuote] as? Bool) == true
  }

  private func toggleList(_ kind: CREBlock) {
    let paras = selectedParagraphs()
    let ns = storage.string as NSString
    var allKind = true
    for p in paras {
      let (k, _) = CRERich.listPrefix(ns.substring(with: p) as NSString)
      if k != kind { allKind = false; break }
    }
    let sel = textView.selectedRange
    var delta = 0
    storage.beginEditing()
    var n = 0
    for p in paras.reversed() {
      let para = (storage.string as NSString).substring(with: p) as NSString
      let (k, plen) = CRERich.listPrefix(para)
      let attrs: [NSAttributedString.Key: Any] = p.length > 0
        ? storage.attributes(at: p.location, effectiveRange: nil)
        : textView.typingAttributes
      var newPrefix = ""
      if !allKind {
        n += 1
        newPrefix = kind == .ul ? CRERich.bullet : "\(paras.count - n + 1). "
      }
      let r = NSRange(location: p.location, length: k != .none ? plen : 0)
      var clean = attrs
      clean[.font] = baseFont
      clean.removeValue(forKey: .underlineStyle)
      clean.removeValue(forKey: .strikethroughStyle)
      clean.removeValue(forKey: .link)
      storage.replaceCharacters(in: r, with: NSAttributedString(string: newPrefix, attributes: clean))
      delta += (newPrefix as NSString).length - r.length
    }
    storage.endEditing()
    let loc = max(0, min(storage.length, sel.location + (paras.count == 1 ? delta : 0)))
    textView.selectedRange = NSRange(location: loc, length: paras.count == 1 ? 0 : min(storage.length - loc, max(0, sel.length + delta)))
    textView.undoManager?.removeAllActions()
    afterEdit()
  }

  private func toggleQuote() {
    let paras = selectedParagraphs()
    let all = paras.allSatisfy { isQuote($0) }
    let total = storage.length
    storage.beginEditing()
    for p in paras {
      // inclui o "\n" que fecha o parágrafo (parágrafo vazio fica marcado)
      var r = p
      if NSMaxRange(r) < total { r.length += 1 }
      if r.length == 0 { continue }
      if all { storage.removeAttribute(.cyQuote, range: r) } else { storage.addAttribute(.cyQuote, value: true, range: r) }
    }
    storage.endEditing()
    var ta = textView.typingAttributes
    if all { ta.removeValue(forKey: .cyQuote) } else { ta[.cyQuote] = true }
    textView.typingAttributes = ta
    textView.undoManager?.removeAllActions()
    afterEdit()
    layout.invalidateDisplay(forCharacterRange: NSRange(location: 0, length: storage.length))
  }

  private func removeFormat() {
    let sel = textView.selectedRange
    if sel.length == 0 {
      textView.typingAttributes = [.font: baseFont, .foregroundColor: textColor]
      emitFormats(force: true)
      return
    }
    storage.beginEditing()
    storage.addAttribute(.font, value: baseFont, range: sel)
    storage.removeAttribute(.underlineStyle, range: sel)
    storage.removeAttribute(.strikethroughStyle, range: sel)
    storage.removeAttribute(.link, range: sel)
    storage.removeAttribute(.cyQuote, range: sel)
    storage.endEditing()
    textView.selectedRange = sel
    textView.undoManager?.removeAllActions()
    afterEdit()
  }

  private func normalizeUrl(_ raw: String) -> String? {
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return nil }
    let low = t.lowercased()
    if low.hasPrefix("http://") || low.hasPrefix("https://") || low.hasPrefix("mailto:") || low.hasPrefix("tel:") { return t }
    if t.contains("@") && !t.contains("/") { return "mailto:" + t }
    if low.hasPrefix("javascript:") || low.hasPrefix("data:") || low.hasPrefix("file:") { return nil }
    return "https://" + t
  }

  private func applyLink(_ raw: String?) {
    let sel = textView.selectedRange
    guard let raw = raw else {
      if sel.length > 0 {
        storage.removeAttribute(.link, range: sel)
        textView.undoManager?.removeAllActions()
        afterEdit()
      }
      return
    }
    guard let urlStr = normalizeUrl(raw), let url = URL(string: urlStr) else { return }
    if sel.length > 0 {
      storage.addAttribute(.link, value: url, range: sel)
      textView.selectedRange = NSRange(location: NSMaxRange(sel), length: 0)
    } else {
      var a = textView.typingAttributes
      a[.link] = url
      let shown = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      storage.replaceCharacters(in: sel, with: NSAttributedString(string: shown, attributes: a))
      let end = sel.location + (shown as NSString).length
      // espaço depois do link, fora do link
      var plain = textView.typingAttributes
      plain.removeValue(forKey: .link)
      storage.insert(NSAttributedString(string: " ", attributes: plain), at: end)
      textView.selectedRange = NSRange(location: end + 1, length: 0)
      textView.typingAttributes = plain
    }
    textView.undoManager?.removeAllActions()
    afterEdit()
  }

  private func promptLink() {
    guard let presenter = appContext?.utilities?.currentViewController() else { return }
    let sel = textView.selectedRange
    var existing: String? = nil
    if sel.length > 0 || sel.location > 0 {
      let probe = sel.length > 0 ? sel.location : sel.location - 1
      if probe >= 0 && probe < storage.length {
        if let u = storage.attribute(.link, at: probe, effectiveRange: nil) as? URL { existing = u.absoluteString }
      }
    }
    var seed = existing ?? ""
    if seed.isEmpty, sel.length > 0 {
      let s = (storage.string as NSString).substring(with: sel).trimmingCharacters(in: .whitespacesAndNewlines)
      if s.range(of: "^(https?://|www\\.)\\S+$", options: [.regularExpression, .caseInsensitive]) != nil { seed = s }
    }
    let alert = UIAlertController(title: labels["linkTitle"] ?? "Inserir link", message: nil, preferredStyle: .alert)
    alert.addTextField { tf in
      tf.placeholder = self.labels["linkPlaceholder"] ?? "https://"
      tf.text = seed
      tf.keyboardType = .URL
      tf.autocapitalizationType = .none
      tf.autocorrectionType = .no
      tf.clearButtonMode = .whileEditing
    }
    alert.addAction(UIAlertAction(title: labels["cancel"] ?? "Cancelar", style: .cancel) { [weak self] _ in
      self?.textView.becomeFirstResponder()
      self?.textView.selectedRange = sel
    })
    if existing != nil {
      alert.addAction(UIAlertAction(title: labels["removeLink"] ?? "Remover link", style: .destructive) { [weak self] _ in
        guard let self = self else { return }
        self.textView.becomeFirstResponder()
        var r = sel
        if r.length == 0, r.location > 0 {
          var eff = NSRange(location: 0, length: 0)
          _ = self.storage.attribute(.link, at: r.location - 1, longestEffectiveRange: &eff, in: NSRange(location: 0, length: self.storage.length))
          r = eff
        }
        self.textView.selectedRange = r
        self.applyLink(nil)
      })
    }
    alert.addAction(UIAlertAction(title: labels["ok"] ?? "OK", style: .default) { [weak self, weak alert] _ in
      guard let self = self else { return }
      let v = alert?.textFields?.first?.text ?? ""
      self.textView.becomeFirstResponder()
      self.textView.selectedRange = sel
      self.applyLink(v)
    })
    presenter.present(alert, animated: true, completion: nil)
  }

  // MARK: foco

  func focusEditor() {
    if !textView.isFirstResponder { textView.becomeFirstResponder() }
  }

  func blurEditor() {
    if textView.isFirstResponder { textView.resignFirstResponder() }
  }

  // MARK: estado de formatação (toolbar ativa)

  private func emitFormats(force: Bool) {
    var f: [String] = []
    let sel = textView.selectedRange
    let attrs: [NSAttributedString.Key: Any]
    if sel.length == 0 {
      attrs = textView.typingAttributes
    } else if sel.location < storage.length {
      attrs = storage.attributes(at: sel.location, effectiveRange: nil)
    } else {
      attrs = textView.typingAttributes
    }
    let fl = CRERich.flags(attrs)
    if fl.bold { f.append("bold") }
    if fl.italic { f.append("italic") }
    if fl.underline { f.append("underline") }
    if fl.strike { f.append("strikeThrough") }
    if fl.link != nil { f.append("createLink") }
    let ns = storage.string as NSString
    if ns.length > 0 {
      let pr = CRERich.paragraph(ns, at: sel.location)
      let (k, _) = CRERich.listPrefix(ns.substring(with: pr) as NSString)
      if k == .ul { f.append("insertUnorderedList") }
      if k == .ol { f.append("insertOrderedList") }
    }
    if (attrs[.cyQuote] as? Bool) == true { f.append("formatBlock") }
    if force || f != lastFormats {
      lastFormats = f
      onSelectionChange(["formats": f])
    }
  }

  // MARK: UITextViewDelegate

  public func textView(_ tv: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    if suppress { return true }
    let ns = storage.string as NSString
    let total = ns.length
    let loc = min(range.location, total)
    let pr = CRERich.paragraph(ns, at: loc)
    let para = ns.substring(with: pr) as NSString
    let (kind, plen) = CRERich.listPrefix(para)

    if text == "\n" && range.length == 0 {
      if kind != .none && loc >= pr.location + plen {
        commitSnapshot()
        if para.length == plen {
          // item vazio + Enter → sai da lista
          storage.replaceCharacters(in: NSRange(location: pr.location, length: plen), with: "")
          tv.selectedRange = NSRange(location: pr.location, length: 0)
        } else {
          var next = CRERich.bullet
          if kind == .ol {
            let num = Int(para.substring(to: plen).trimmingCharacters(in: CharacterSet(charactersIn: ". "))) ?? 0
            next = "\(num + 1). "
          }
          var a = tv.typingAttributes
          a.removeValue(forKey: .link)
          let ins = NSAttributedString(string: "\n" + next, attributes: a)
          storage.replaceCharacters(in: range, with: ins)
          tv.selectedRange = NSRange(location: range.location + ins.length, length: 0)
        }
        tv.undoManager?.removeAllActions()
        afterEdit()
        return false
      }
      let quoteHere = (tv.typingAttributes[.cyQuote] as? Bool) == true
      if quoteHere && para.length == 0 {
        // citação vazia + Enter → sai da citação
        commitSnapshot()
        var r = pr
        if r.length == 0 && r.location < total { r.length = 1 }
        if r.length > 0 { storage.removeAttribute(.cyQuote, range: r) }
        var ta = tv.typingAttributes
        ta.removeValue(forKey: .cyQuote)
        tv.typingAttributes = ta
        tv.undoManager?.removeAllActions()
        afterEdit()
        layout.invalidateDisplay(forCharacterRange: NSRange(location: 0, length: storage.length))
        return false
      }
    }
    if text.isEmpty && range.length > 0 && kind != .none {
      // apagar dentro do prefixo da lista apaga o prefixo inteiro
      if range.location >= pr.location && NSMaxRange(range) <= pr.location + plen {
        commitSnapshot()
        storage.replaceCharacters(in: NSRange(location: pr.location, length: plen), with: "")
        tv.selectedRange = NSRange(location: pr.location, length: 0)
        tv.undoManager?.removeAllActions()
        afterEdit()
        return false
      }
    }
    return true
  }

  public func textViewDidChange(_ tv: UITextView) {
    if suppress { return }
    afterEdit()
  }

  public func textViewDidChangeSelection(_ tv: UITextView) {
    if suppress { return }
    emitFormats(force: false)
  }

  public func textViewDidBeginEditing(_ tv: UITextView) {
    onFocusChange(["focused": true])
  }

  public func textViewDidEndEditing(_ tv: UITextView) {
    commitSnapshot()
    onFocusChange(["focused": false])
  }

  public func textView(_ tv: UITextView, shouldInteractWith URL: URL, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
    // Editando: tocar no link só posiciona o cursor.
    return false
  }
}
