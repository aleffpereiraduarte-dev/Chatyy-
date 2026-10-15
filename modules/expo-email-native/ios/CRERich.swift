import UIKit

// [2026-10-15 native-email] Modelo do editor rico do e-mail (iOS).
//
// Formatos suportados (o que o compositor de e-mail precisa; o mesmo conjunto
// no Android, android/.../CRERich.kt):
//   inline   negrito, itálico, sublinhado, tachado, link
//   bloco    lista com marcador ("• "), lista numerada ("1. "), citação
// A lista vive no PRÓPRIO texto (prefixo) — o que se vê é o que sai no HTML; a
// citação é o atributo `cyQuote` no parágrafo. HTML de entrada fora desse
// conjunto vira texto (o JS só abre o editor nativo quando o HTML é simples).

extension NSAttributedString.Key {
  static let cyQuote = NSAttributedString.Key("cyQuote")
}

enum CREBlock: Equatable {
  case none, ul, ol, quote
}

struct CRERunFlags: Equatable {
  var bold = false
  var italic = false
  var underline = false
  var strike = false
  var link: String? = nil
}

enum CRERich {
  static let bullet = "\u{2022} "
  static let olRegex = try! NSRegularExpression(pattern: "^[0-9]{1,3}\\. ", options: [])

  // MARK: prefixos de lista

  /// Tamanho (UTF-16) do prefixo de lista no início do parágrafo, e o tipo.
  static func listPrefix(_ para: NSString) -> (CREBlock, Int) {
    if para.hasPrefix(bullet) { return (.ul, (bullet as NSString).length) }
    if let m = olRegex.firstMatch(in: para as String, options: [], range: NSRange(location: 0, length: min(para.length, 6))) {
      return (.ol, m.range.length)
    }
    return (.none, 0)
  }

  // MARK: parágrafos (ranges SEM o "\n" final)

  /// Parágrafo que contém `loc` (cursor logo após um "\n" = parágrafo seguinte).
  static func paragraph(_ ns: NSString, at loc: Int) -> NSRange {
    let total = ns.length
    let l = max(0, min(loc, total))
    var s = l
    while s > 0 && ns.character(at: s - 1) != 10 { s -= 1 }
    var e = l
    while e < total && ns.character(at: e) != 10 { e += 1 }
    return NSRange(location: s, length: e - s)
  }

  /// Todos os parágrafos (texto vazio = 1 parágrafo vazio; "\n" final = +1 vazio).
  static func paragraphs(_ ns: NSString) -> [NSRange] {
    var out: [NSRange] = []
    let total = ns.length
    var s = 0
    var i = 0
    while i < total {
      if ns.character(at: i) == 10 {
        out.append(NSRange(location: s, length: i - s))
        s = i + 1
      }
      i += 1
    }
    out.append(NSRange(location: s, length: total - s))
    return out
  }

  // MARK: fontes

  static func font(base: UIFont, bold: Bool, italic: Bool) -> UIFont {
    var traits: UIFontDescriptor.SymbolicTraits = []
    if bold { traits.insert(.traitBold) }
    if italic { traits.insert(.traitItalic) }
    if traits.isEmpty { return base }
    if let d = base.fontDescriptor.withSymbolicTraits(traits) {
      return UIFont(descriptor: d, size: base.pointSize)
    }
    return base
  }

  static func flags(_ attrs: [NSAttributedString.Key: Any]) -> CRERunFlags {
    var f = CRERunFlags()
    if let font = attrs[.font] as? UIFont {
      let t = font.fontDescriptor.symbolicTraits
      f.bold = t.contains(.traitBold)
      f.italic = t.contains(.traitItalic)
    }
    if let u = attrs[.underlineStyle] as? Int, u != 0 { f.underline = true }
    if let u = attrs[.underlineStyle] as? NSNumber, u.intValue != 0 { f.underline = true }
    if let s = attrs[.strikethroughStyle] as? Int, s != 0 { f.strike = true }
    if let s = attrs[.strikethroughStyle] as? NSNumber, s.intValue != 0 { f.strike = true }
    if let l = attrs[.link] as? URL { f.link = l.absoluteString }
    else if let l = attrs[.link] as? String, !l.isEmpty { f.link = l }
    return f
  }

  static func attrs(_ f: CRERunFlags, base: UIFont, color: UIColor, quote: Bool) -> [NSAttributedString.Key: Any] {
    var a: [NSAttributedString.Key: Any] = [
      .font: font(base: base, bold: f.bold, italic: f.italic),
      .foregroundColor: color,
    ]
    if f.underline { a[.underlineStyle] = NSUnderlineStyle.single.rawValue }
    if f.strike { a[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
    if let l = f.link, let u = URL(string: l) { a[.link] = u }
    if quote { a[.cyQuote] = true }
    return a
  }

  // MARK: HTML → modelo

  struct Para {
    var block: CREBlock = .none
    var runs: [(String, CRERunFlags)] = []
    var isEmpty: Bool { runs.allSatisfy { $0.0.isEmpty } }
  }

  private struct Frame {
    var name: String
    var bold = false
    var italic = false
    var underline = false
    var strike = false
    var link: String? = nil
    var list: CREBlock? = nil
    var quote = false
  }

  private static let blockTags: Set<String> = [
    "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "blockquote",
    "pre", "table", "tr", "section", "article", "header", "footer", "hr", "dl", "dt", "dd",
  ]
  private static let voidTags: Set<String> = [
    "br", "img", "hr", "meta", "link", "input", "wbr", "col", "area", "base", "source", "embed",
  ]
  private static let skipTags: Set<String> = ["style", "script", "head", "title", "template", "noscript", "svg", "math"]

  static func looksLikeHtml(_ s: String) -> Bool {
    return s.range(of: "<[a-zA-Z!/][^>]*>", options: .regularExpression) != nil
  }

  static func parse(_ input: String) -> [Para] {
    if !looksLikeHtml(input) {
      // Texto puro (resposta sugerida, IA): quebras de linha preservadas.
      return input.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n").map {
        var p = Para()
        let s = $0 as NSString
        let (kind, _) = listPrefix(s)
        p.block = kind
        p.runs = [($0, CRERunFlags())]
        return p
      }
    }
    var paras: [Para] = []
    var cur = Para()
    var stack: [Frame] = []
    var olCounters: [Int] = []
    let chars = Array(input.unicodeScalars)
    var i = 0
    let n = chars.count
    var skipUntil: String? = nil

    func ctx() -> CRERunFlags {
      var f = CRERunFlags()
      for fr in stack {
        if fr.bold { f.bold = true }
        if fr.italic { f.italic = true }
        if fr.underline { f.underline = true }
        if fr.strike { f.strike = true }
        if let l = fr.link { f.link = l }
      }
      return f
    }
    func quoteDepth() -> Bool { stack.contains { $0.quote } }
    func endPara() {
      paras.append(cur)
      cur = Para()
      cur.block = quoteDepth() ? .quote : .none
    }
    func ensureBreak() {
      if !cur.isEmpty { endPara() } else { cur.block = quoteDepth() ? .quote : .none }
    }
    func appendText(_ raw: String) {
      var t = raw.replacingOccurrences(of: "[\\t\\n\\r\\f ]+", with: " ", options: .regularExpression)
      if cur.isEmpty { t = String(t.drop(while: { $0 == " " })) }
      if t.isEmpty { return }
      cur.runs.append((t, ctx()))
    }

    var textBuf = ""
    while i < n {
      let c = chars[i]
      if c == "<" {
        // fim do texto acumulado
        if skipUntil == nil, !textBuf.isEmpty { appendText(decodeEntities(textBuf)) }
        textBuf = ""
        // comentário
        if i + 3 < n, chars[i + 1] == "!", chars[i + 2] == "-", chars[i + 3] == "-" {
          var j = i + 4
          while j + 2 < n && !(chars[j] == "-" && chars[j + 1] == "-" && chars[j + 2] == ">") { j += 1 }
          i = min(n, j + 3)
          continue
        }
        var j = i + 1
        var quoteCh: Unicode.Scalar? = nil
        while j < n {
          let d = chars[j]
          if let q = quoteCh { if d == q { quoteCh = nil } }
          else if d == "\"" || d == "'" { quoteCh = d }
          else if d == ">" { break }
          j += 1
        }
        if j >= n { textBuf.append(String(String.UnicodeScalarView(chars[i..<n]))); break }
        let tagSrc = String(String.UnicodeScalarView(chars[(i + 1)..<j]))
        i = j + 1
        let closing = tagSrc.hasPrefix("/")
        let body = closing ? String(tagSrc.dropFirst()) : tagSrc
        let name = String(body.prefix(while: { $0.isLetter || $0.isNumber })).lowercased()
        if name.isEmpty { continue }
        if let s = skipUntil {
          if closing && name == s { skipUntil = nil }
          continue
        }
        if !closing && skipTags.contains(name) {
          if !body.hasSuffix("/") { skipUntil = name }
          continue
        }
        if closing {
          if blockTags.contains(name) { ensureBreak() }
          if let idx = stack.lastIndex(where: { $0.name == name }) {
            let fr = stack[idx]
            stack.removeSubrange(idx...)
            if fr.list == .ol, !olCounters.isEmpty { olCounters.removeLast() }
          }
          if name == "blockquote" || name == "ul" || name == "ol" { cur.block = quoteDepth() ? .quote : .none }
          continue
        }
        // abertura
        if name == "br" {
          endPara()
          continue
        }
        if name == "hr" { ensureBreak(); continue }
        if name == "img" {
          if let alt = attr(body, "alt"), !alt.isEmpty { appendText(alt) }
          continue
        }
        if blockTags.contains(name) { ensureBreak() }
        var fr = Frame(name: name)
        switch name {
        case "b", "strong": fr.bold = true
        case "i", "em", "cite": fr.italic = true
        case "u", "ins": fr.underline = true
        case "s", "strike", "del": fr.strike = true
        case "a": fr.link = attr(body, "href").flatMap { sanitizeHref($0) }
        case "ul": fr.list = .ul
        case "ol": fr.list = .ol; olCounters.append(0)
        case "blockquote": fr.quote = true
        case "h1", "h2", "h3", "h4", "h5", "h6", "th": fr.bold = true
        default: break
        }
        if let st = attr(body, "style")?.lowercased() {
          if st.range(of: "font-weight\\s*:\\s*(bold|[6-9]00)", options: .regularExpression) != nil { fr.bold = true }
          if st.range(of: "font-style\\s*:\\s*italic", options: .regularExpression) != nil { fr.italic = true }
          if st.range(of: "text-decoration[^;]*underline", options: .regularExpression) != nil { fr.underline = true }
          if st.range(of: "text-decoration[^;]*line-through", options: .regularExpression) != nil { fr.strike = true }
        }
        if name == "li" {
          let kind = stack.last(where: { $0.list != nil })?.list ?? .ul
          cur.block = kind
          if kind == .ol, !olCounters.isEmpty { olCounters[olCounters.count - 1] += 1 }
        } else if name == "blockquote" {
          cur.block = .quote
        }
        if !voidTags.contains(name) && !body.hasSuffix("/") { stack.append(fr) }
      } else {
        textBuf.unicodeScalars.append(c)
        i += 1
      }
    }
    if skipUntil == nil, !textBuf.isEmpty { appendText(decodeEntities(textBuf)) }
    if !cur.isEmpty || paras.isEmpty { paras.append(cur) }
    // Sem parágrafos vazios sobrando no fim (o <div><br></div> final do web).
    while paras.count > 1, let last = paras.last, last.isEmpty, last.block == .none { paras.removeLast() }
    return paras
  }

  static func build(_ paras: [Para], base: UIFont, color: UIColor) -> NSMutableAttributedString {
    let out = NSMutableAttributedString()
    var olN = 0
    for (idx, p) in paras.enumerated() {
      let quote = p.block == .quote
      var prefix = ""
      switch p.block {
      case .ul:
        olN = 0
        let first = (p.runs.first?.0 ?? "") as NSString
        if !first.hasPrefix(bullet) { prefix = bullet }
      case .ol:
        olN += 1
        let first = (p.runs.first?.0 ?? "") as NSString
        if listPrefix(first).0 != .ol { prefix = "\(olN). " }
      default:
        olN = 0
      }
      if !prefix.isEmpty {
        out.append(NSAttributedString(string: prefix, attributes: attrs(CRERunFlags(), base: base, color: color, quote: quote)))
      }
      for (t, f) in p.runs where !t.isEmpty {
        out.append(NSAttributedString(string: t, attributes: attrs(f, base: base, color: color, quote: quote)))
      }
      if idx < paras.count - 1 {
        out.append(NSAttributedString(string: "\n", attributes: attrs(CRERunFlags(), base: base, color: color, quote: quote)))
      }
    }
    return out
  }

  static func attr(_ tagBody: String, _ name: String) -> String? {
    let pattern = "(?i)(?:^|\\s)" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))"
    guard let re = try? NSRegularExpression(pattern: pattern, options: []) else { return nil }
    let ns = tagBody as NSString
    guard let m = re.firstMatch(in: tagBody, options: [], range: NSRange(location: 0, length: ns.length)) else { return nil }
    for g in 2...4 {
      let r = m.range(at: g)
      if r.location != NSNotFound { return decodeEntities(ns.substring(with: r)) }
    }
    return nil
  }

  static func sanitizeHref(_ h: String) -> String? {
    let t = h.trimmingCharacters(in: .whitespacesAndNewlines)
    let low = t.lowercased()
    if low.hasPrefix("http://") || low.hasPrefix("https://") || low.hasPrefix("mailto:") || low.hasPrefix("tel:") { return t }
    return nil
  }

  static func decodeEntities(_ s: String) -> String {
    if !s.contains("&") { return s }
    var out = ""
    var i = s.startIndex
    while i < s.endIndex {
      let c = s[i]
      if c == "&", let semi = s[i...].prefix(12).firstIndex(of: ";") {
        let ent = String(s[s.index(after: i)..<semi])
        var rep: String? = nil
        switch ent.lowercased() {
        case "amp": rep = "&"
        case "lt": rep = "<"
        case "gt": rep = ">"
        case "quot": rep = "\""
        case "apos", "#39": rep = "'"
        case "nbsp": rep = "\u{00A0}"
        default:
          if ent.hasPrefix("#x") || ent.hasPrefix("#X"), let v = UInt32(ent.dropFirst(2), radix: 16), let u = Unicode.Scalar(v) { rep = String(Character(u)) }
          else if ent.hasPrefix("#"), let v = UInt32(ent.dropFirst()), let u = Unicode.Scalar(v) { rep = String(Character(u)) }
        }
        if let r = rep { out += r; i = s.index(after: semi); continue }
      }
      out.append(c)
      i = s.index(after: i)
    }
    return out
  }

  // MARK: modelo → HTML / texto

  static func escape(_ s: String) -> String {
    var o = ""
    o.reserveCapacity(s.count)
    for ch in s {
      switch ch {
      case "&": o += "&amp;"
      case "<": o += "&lt;"
      case ">": o += "&gt;"
      case "\"": o += "&quot;"
      case "\u{00A0}": o += "&nbsp;"
      default: o.append(ch)
      }
    }
    // Espaços múltiplos não colapsam no destinatário.
    return o.replacingOccurrences(of: "  ", with: " &nbsp;")
  }

  static func export(_ s: NSAttributedString) -> (html: String, text: String, empty: Bool) {
    let ns = s.string as NSString
    let total = ns.length
    if total == 0 { return ("", "", true) }
    var html = ""
    var textLines: [String] = []
    var openBlock: CREBlock = .none
    var anyContent = false

    func closeBlock() {
      switch openBlock {
      case .ul: html += "</ul>"
      case .ol: html += "</ol>"
      case .quote: html += "</blockquote>"
      case .none: break
      }
      openBlock = .none
    }

    var start = 0
    while start <= total {
      var end = start
      while end < total && ns.character(at: end) != 10 { end += 1 }
      let paraRange = NSRange(location: start, length: end - start)
      let para = ns.substring(with: paraRange) as NSString
      let (kind, plen) = listPrefix(para)
      // atributo de parágrafo: 1º caractere do conteúdo ou o "\n" que o fecha
      var quote = false
      let probe = paraRange.length > 0 ? start : (end < total ? end : -1)
      if probe >= 0, s.attribute(.cyQuote, at: probe, effectiveRange: nil) as? Bool == true { quote = true }
      let block: CREBlock = kind != .none ? kind : (quote ? .quote : .none)
      if block != openBlock {
        closeBlock()
        switch block {
        case .ul: html += "<ul>"
        case .ol: html += "<ol>"
        case .quote: html += "<blockquote style=\"margin:0 0 0 2px;padding-left:12px;border-left:3px solid #cccccc;color:#555555\">"
        case .none: break
        }
        openBlock = block
      }
      let contentRange = NSRange(location: start + plen, length: max(0, paraRange.length - plen))
      var inner = ""
      if contentRange.length > 0 {
        s.enumerateAttributes(in: contentRange, options: []) { a, r, _ in
          let t = ns.substring(with: r)
          if t.isEmpty { return }
          let f = flags(a)
          var piece = escape(t)
          if f.strike { piece = "<s>" + piece + "</s>" }
          if f.underline { piece = "<u>" + piece + "</u>" }
          if f.italic { piece = "<i>" + piece + "</i>" }
          if f.bold { piece = "<b>" + piece + "</b>" }
          if let l = f.link { piece = "<a href=\"" + escape(l) + "\">" + piece + "</a>" }
          inner += piece
        }
      }
      let plain = ns.substring(with: contentRange)
      if !plain.trimmingCharacters(in: .whitespaces).isEmpty { anyContent = true }
      switch block {
      case .ul, .ol: html += "<li>" + (inner.isEmpty ? "<br>" : inner) + "</li>"
      case .quote, .none: html += "<div>" + (inner.isEmpty ? "<br>" : inner) + "</div>"
      }
      textLines.append((quote && kind == .none ? "> " : "") + (para as String))
      if end >= total { break }
      start = end + 1
    }
    closeBlock()
    if !anyContent { return ("", "", true) }
    return (html, textLines.joined(separator: "\n"), false)
  }
}
