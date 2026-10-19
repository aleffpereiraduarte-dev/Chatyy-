import UIKit
import CoreText

// [2026-10-14 native-list] Motor de layout das linhas — roda na fila de fundo.
// Só usa CoreText/CoreGraphics + objetos imutáveis (UIFont/UIColor/CGPath),
// que são seguros fora da main. Resultado = frames prontos; a célula só aplica.

let CMLStrikeKey = NSAttributedString.Key("cmlStrike")
let CMLLinkKey = NSAttributedString.Key("cmlLink")
let CMLCTColorKey = NSAttributedString.Key(kCTForegroundColorAttributeName as String)
// [fase 2] emoji customizado (url), spoiler (NSNumber), fundo de code inline (UIColor)
let CMLEmojiKey = NSAttributedString.Key("cmlEmoji")
let CMLEmojiSizeKey = NSAttributedString.Key("cmlEmojiSize")
let CMLSpoilerKey = NSAttributedString.Key("cmlSpoiler")
let CMLCodeBgKey = NSAttributedString.Key("cmlCodeBg")
let CMLRunDelegateKey = NSAttributedString.Key(kCTRunDelegateAttributeName as String)

/// Caixa do emoji customizado (CTRunDelegate). Retida pelo delegate (passRetained) e
/// liberada no callback dealloc.
final class CMLEmojiBox {
  let width: CGFloat
  let ascent: CGFloat
  let descent: CGFloat
  init(width: CGFloat, ascent: CGFloat, descent: CGFloat) {
    self.width = width
    self.ascent = ascent
    self.descent = descent
  }
}

enum CMLRunDelegates {
  static func make(_ box: CMLEmojiBox) -> CTRunDelegate? {
    var cb = CTRunDelegateCallbacks(
      version: kCTRunDelegateVersion1,
      dealloc: { ref in
        Unmanaged<CMLEmojiBox>.fromOpaque(ref).release()
      },
      getAscent: { ref in
        return Unmanaged<CMLEmojiBox>.fromOpaque(ref).takeUnretainedValue().ascent
      },
      getDescent: { ref in
        return Unmanaged<CMLEmojiBox>.fromOpaque(ref).takeUnretainedValue().descent
      },
      getWidth: { ref in
        return Unmanaged<CMLEmojiBox>.fromOpaque(ref).takeUnretainedValue().width
      }
    )
    let ptr = Unmanaged.passRetained(box).toOpaque()
    guard let d = CTRunDelegateCreate(&cb, ptr) else {
      Unmanaged<CMLEmojiBox>.fromOpaque(ptr).release()
      return nil
    }
    return d
  }
}

/// Estilo imutável (fontes criadas na main, depois só lidas).
final class CMLStyle {
  let width: CGFloat
  let fontSize: CGFloat
  let lineHeight: CGFloat
  let radius: CGFloat
  let theme: CMLTheme
  let version: Int
  /// Dynamic Type (0,85…1,4) — aplicado às fontes dos blocos (fs do JS).
  let scale: CGFloat
  /// [2026-10-18 tg-look] visual Telegram (CMLLook.tg no momento da criação)
  let tg: Bool
  /// [2026-10-19 tg-style, apiVersion 12] polimento Telegram (CMLLook.style na criação)
  let ts: Bool

  let body: UIFont
  let bodyBold: UIFont
  let bodyItalic: UIFont
  let bodyBoldItalic: UIFont
  let mono: UIFont
  let meta: UIFont
  let name: UIFont
  let fwd: UIFont
  let quoteName: UIFont
  let quoteText: UIFont
  let quoteItalic: UIFont
  let pill: UIFont
  let system: UIFont
  let unread: UIFont
  let react: UIFont
  let fileName: UIFont
  let small: UIFont

  init(width: CGFloat, fontSize: CGFloat, lineHeight: CGFloat, radius: CGFloat, theme: CMLTheme, version: Int) {
    self.width = width
    // Dynamic Type como o RN (allowFontScaling) com teto 1,4×.
    let scale = min(1.4, max(0.85, UIFontMetrics(forTextStyle: .body).scaledValue(for: 100) / 100))
    self.scale = scale
    let fs = max(10, fontSize) * scale
    self.fontSize = fs
    self.lineHeight = max(ceil(fs * 1.25), lineHeight * scale)
    self.radius = radius
    // [wave13-C a11y] contraste reforçado com "Escurecer cores"
    self.theme = UIAccessibility.isDarkerSystemColorsEnabled ? theme.boostedContrast() : theme
    self.version = version
    self.tg = CMLLook.tg
    let tsOn = CMLLook.style
    self.ts = tsOn
    body = UIFont.systemFont(ofSize: fs)
    bodyBold = UIFont.systemFont(ofSize: fs, weight: .semibold)
    bodyItalic = UIFont.italicSystemFont(ofSize: fs)
    if let d = body.fontDescriptor.withSymbolicTraits([.traitBold, .traitItalic]) {
      bodyBoldItalic = UIFont(descriptor: d, size: fs)
    } else {
      bodyBoldItalic = bodyBold
    }
    mono = UIFont.monospacedSystemFont(ofSize: fs * 0.88, weight: .regular)
    meta = UIFont.systemFont(ofSize: 11 * scale)
    name = UIFont.systemFont(ofSize: 13 * scale, weight: .semibold)
    // [tg-style] "Encaminhada de …" 13 regular (Telegram) — antes 12 itálico
    fwd = tsOn ? UIFont.systemFont(ofSize: 13 * scale) : UIFont.italicSystemFont(ofSize: 12 * scale)
    quoteName = UIFont.systemFont(ofSize: 13 * scale, weight: .semibold)
    quoteText = UIFont.systemFont(ofSize: 13 * scale)
    quoteItalic = UIFont.italicSystemFont(ofSize: 13 * scale)
    // [2026-10-17 wa-pills] data e sistema = 12,5 medium (WhatsApp iOS)
    // [tg-style] cápsula com desfoque, fonte menor (12)
    pill = UIFont.systemFont(ofSize: (tsOn ? 12 : 12.5) * scale, weight: .medium)
    system = UIFont.systemFont(ofSize: (tsOn ? 12 : 12.5) * scale, weight: .medium)
    unread = UIFont.systemFont(ofSize: 13 * scale, weight: .semibold)
    react = UIFont.systemFont(ofSize: 13 * scale)
    fileName = UIFont.systemFont(ofSize: 14 * scale, weight: .medium)
    small = UIFont.systemFont(ofSize: 12 * scale)
  }

  func with(width w: CGFloat) -> CMLStyle {
    return CMLStyle(width: w, fontSize: fontSize, lineHeight: lineHeight, radius: radius, theme: theme, version: version, prebuilt: self)
  }

  // Cópia com outra largura reaproveitando as fontes.
  private init(width: CGFloat, fontSize: CGFloat, lineHeight: CGFloat, radius: CGFloat, theme: CMLTheme, version: Int, prebuilt p: CMLStyle) {
    self.width = width
    self.fontSize = fontSize
    self.lineHeight = lineHeight
    self.radius = radius
    self.theme = theme
    self.version = version
    self.scale = p.scale
    self.tg = p.tg
    self.ts = p.ts
    body = p.body; bodyBold = p.bodyBold; bodyItalic = p.bodyItalic; bodyBoldItalic = p.bodyBoldItalic
    mono = p.mono; meta = p.meta; name = p.name; fwd = p.fwd; quoteName = p.quoteName
    quoteText = p.quoteText; quoteItalic = p.quoteItalic; pill = p.pill; system = p.system
    unread = p.unread; react = p.react; fileName = p.fileName; small = p.small
  }

  var bubbleMax: CGFloat { return floor(min(width, 620) * 0.78) }
}

/// Texto já quebrado em linhas (CTLine imutável = seguro entre threads).
final class CMLTextLayout {
  let lines: [CTLine]
  let lineWidths: [CGFloat]
  let lineHeight: CGFloat
  let baseline: CGFloat
  let size: CGSize
  let attr: NSAttributedString
  /// [fase 2] 0 esquerda, 1 centro, 2 direita — relativo a `alignWidth`.
  var align: Int = 0
  var alignWidth: CGFloat = 0
  /// [fase 2] tem emoji/spoiler/code (desenho extra).
  var hasExtras = false

  func lineOffset(_ i: Int) -> CGFloat {
    guard align != 0, alignWidth > 0, i >= 0, i < lineWidths.count else { return 0 }
    let free = max(0, alignWidth - lineWidths[i])
    return align == 1 ? floor(free / 2) : free
  }

  var lastLineWidth: CGFloat { return lineWidths.last ?? 0 }
  var lineCount: Int { return lines.count }

  init(lines: [CTLine], widths: [CGFloat], lineHeight: CGFloat, baseline: CGFloat, attr: NSAttributedString) {
    self.lines = lines
    self.lineWidths = widths
    self.lineHeight = lineHeight
    self.baseline = baseline
    self.attr = attr
    let w = widths.max() ?? 0
    self.size = CGSize(width: ceil(w), height: CGFloat(lines.count) * lineHeight)
    var extras = false
    if attr.length > 0 {
      attr.enumerateAttributes(in: NSRange(location: 0, length: attr.length), options: []) { a, _, stop in
        if a[CMLEmojiKey] != nil || a[CMLSpoilerKey] != nil || a[CMLCodeBgKey] != nil { extras = true; stop.pointee = true }
      }
    }
    self.hasExtras = extras
  }

  static func make(_ attr: NSAttributedString, maxWidth: CGFloat, lineHeight: CGFloat, font: UIFont, maxLines: Int = 0) -> CMLTextLayout {
    let len = attr.length
    var lines: [CTLine] = []
    var widths: [CGFloat] = []
    let mw = max(10, Double(maxWidth))
    if len > 0 {
      let ts = CTTypesetterCreateWithAttributedString(attr as CFAttributedString)
      var start = 0
      var guardCount = 0
      while start < len && guardCount < 2000 {
        guardCount += 1
        var count = CTTypesetterSuggestLineBreak(ts, start, mw)
        if count <= 0 { count = len - start }
        let isLastAllowed = maxLines > 0 && lines.count == maxLines - 1
        if isLastAllowed && start + count < len {
          let rest = CTTypesetterCreateLine(ts, CFRange(location: start, length: len - start))
          let tokAttrs = attr.attributes(at: min(start, len - 1), effectiveRange: nil)
          let token = CTLineCreateWithAttributedString(NSAttributedString(string: "\u{2026}", attributes: tokAttrs) as CFAttributedString)
          let line = CTLineCreateTruncatedLine(rest, mw, .end, token) ?? CTTypesetterCreateLine(ts, CFRange(location: start, length: count))
          lines.append(line)
          widths.append(CMLTextLayout.width(of: line))
          break
        }
        let line = CTTypesetterCreateLine(ts, CFRange(location: start, length: count))
        lines.append(line)
        widths.append(CMLTextLayout.width(of: line))
        start += count
      }
    }
    let asc = font.ascender
    let desc = -font.descender
    let lh = max(lineHeight, ceil(asc + desc))
    let baseline = floor((lh - (asc + desc)) / 2 + asc)
    return CMLTextLayout(lines: lines, widths: widths, lineHeight: lh, baseline: baseline, attr: attr)
  }

  static func width(of line: CTLine) -> CGFloat {
    var a: CGFloat = 0, d: CGFloat = 0, l: CGFloat = 0
    let w = CTLineGetTypographicBounds(line, &a, &d, &l)
    let tw = CTLineGetTrailingWhitespaceWidth(line)
    return CGFloat(max(0, w - tw))
  }

  /// Índice do caractere no ponto (coordenadas da view do texto, y p/ baixo).
  func characterIndex(at p: CGPoint) -> Int? {
    if lines.isEmpty || p.y < 0 || p.y > size.height + 4 { return nil }
    let i = min(lines.count - 1, max(0, Int(p.y / lineHeight)))
    let x = p.x - lineOffset(i)
    if x < -4 || x > lineWidths[i] + 8 { return nil }
    let idx = CTLineGetStringIndexForPosition(lines[i], CGPoint(x: max(0, x), y: 0))
    if idx == kCFNotFound || idx < 0 { return nil }
    return min(idx, max(0, attr.length - 1))
  }

  func link(at p: CGPoint) -> (String, Int)? {
    guard let i = characterIndex(at: p), i < attr.length else { return nil }
    if let u = attr.attribute(CMLLinkKey, at: i, effectiveRange: nil) as? String, !u.isEmpty {
      return (u, i)
    }
    // Toque logo depois do fim do link (CTLineGetStringIndexForPosition arredonda p/ o próximo).
    if i > 0, let u = attr.attribute(CMLLinkKey, at: i - 1, effectiveRange: nil) as? String, !u.isEmpty {
      return (u, i - 1)
    }
    return nil
  }

  /// [fase 2] O ponto cai num trecho de spoiler?
  func spoiler(at p: CGPoint) -> Bool {
    guard let i = characterIndex(at: p), i < attr.length else { return false }
    if attr.attribute(CMLSpoilerKey, at: i, effectiveRange: nil) != nil { return true }
    if i > 0, attr.attribute(CMLSpoilerKey, at: i - 1, effectiveRange: nil) != nil { return true }
    return false
  }
}

/// Hora + editado + estrela + ✓✓ (medido no fundo, desenhado pela CMLMetaView).
struct CMLMeta {
  var text: CMLTextLayout?
  var star: Bool = false
  var pin: Bool = false     // [fase 2]
  var timer: Bool = false   // [fase 2]
  var status: Double? = nil
  var width: CGFloat = 0
  var height: CGFloat = 15
  var color: UIColor = .gray
  var onMedia: Bool = false

  static let tickSingle: CGFloat = 13
  static let tickDouble: CGFloat = 17

  static func tickWidth(_ s: Double?) -> CGFloat {
    guard let s = s else { return 0 }
    if s >= 1.5 { return tickDouble }
    return tickSingle
  }
}

final class CMLRowLayout {
  var height: CGFloat = 0
  var kind: CMLKind = .msg
  // msg
  var bubbleFrame: CGRect = .zero
  var bubblePath: CGPath? = nil
  var showBubble = true
  var nameFrame: CGRect = .zero
  var name: CMLTextLayout? = nil
  var fwdFrame: CGRect = .zero
  var fwd: CMLTextLayout? = nil
  var replyFrame: CGRect = .zero
  var replyName: CMLTextLayout? = nil
  var replyText: CMLTextLayout? = nil
  var replyThumb = false
  var mediaFrame: CGRect = .zero
  var mediaRadius: CGFloat = 12
  /// [2026-10-18 tg-look] cantos por canto da mídia única [tl, tr, br, bl] (vazio = mediaRadius uniforme)
  var mediaCorners: [CGFloat] = []
  /// [2026-10-18 tg-look] idem por célula do álbum (vazio = 4 uniforme)
  var albumCorners: [[CGFloat]] = []
  /// [2026-10-18 tg-look] mídia rente à bolha (sem moldura); `mediaCaption` = tem legenda
  var mediaFlush = false
  /// [2026-10-18 tg-look] cantos externos da área de mídia rente (snapshot do menu)
  var mediaOuter: [CGFloat] = []
  var mediaCaption = false
  var albumFrames: [CGRect] = []
  var textFrame: CGRect = .zero
  var text: CMLTextLayout? = nil
  var deletedIcon = false
  var metaFrame: CGRect = .zero
  var meta = CMLMeta()
  var reactsFrame: CGRect = .zero
  var reactChips: [(CGRect, CTLine)] = []
  var audioFrame: CGRect = .zero
  var fileFrame: CGRect = .zero
  var fileName: CMLTextLayout? = nil
  var fileSize: CMLTextLayout? = nil
  var fileExt: CMLTextLayout? = nil
  var selCircle: CGRect = .zero
  var replyIconX: CGFloat = 0
  // date / unread / system
  var pillFrame: CGRect = .zero
  var pillText: CMLTextLayout? = nil
  var pillTextFrame: CGRect = .zero
  // [fase 2]
  var blocks: CMLBlocksLayout? = nil
  var failFrame: CGRect = .zero
}

enum CMLLayoutBuilder {
  static let side: CGFloat = 8
  static let tail: CGFloat = 6
  static let padH: CGFloat = 12
  static let padV: CGFloat = 7   // [2026-10-17 wa-bubble] 7/12 (WhatsApp iOS)
  static let mediaInset: CGFloat = 3
  static let metaGap: CGFloat = 6
  static let selGutter: CGFloat = 38

  static func build(_ row: CMLRow, _ s: CMLStyle) -> CMLRowLayout {
    switch row.kind {
    case .date: return buildPill(row, s, font: s.pill, color: s.theme.pillText, bg: true)
    case .system: return buildPill(row, s, font: s.system, color: s.theme.systemText, bg: true)
    case .unread: return buildUnread(row, s)
    case .msg: return buildMessage(row, s)
    }
  }

  // MARK: texto

  static func attributed(_ text: String, spans: [CMLSpan], font: UIFont, color: UIColor, linkColor: UIColor, s: CMLStyle) -> NSAttributedString {
    let m = NSMutableAttributedString(string: text, attributes: [
      .font: font,
      .foregroundColor: color,
      CMLCTColorKey: color.cgColor,
    ])
    let len = (text as NSString).length
    for sp in spans {
      let a = max(0, min(len, sp.start))
      let b = max(a, min(len, sp.end))
      if b <= a { continue }
      let r = NSRange(location: a, length: b - a)
      let f = sp.flags
      let bold = (f & CMLSpan.bold) != 0 || (f & (CMLSpan.mention | CMLSpan.hashtag)) != 0
      let ital = (f & CMLSpan.italic) != 0
      // [fase 2] emoji customizado: 1 char U+FFFC desenhado como imagem.
      if (f & CMLSpan.emoji) != 0, let u = sp.url, !u.isEmpty {
        let side = ceil(font.pointSize * 1.2)
        let fontH = font.ascender - font.descender
        let asc = font.ascender + (side - fontH) / 2
        if let d = CMLRunDelegates.make(CMLEmojiBox(width: side + 1, ascent: asc, descent: max(0, side - asc))) {
          m.addAttribute(CMLRunDelegateKey, value: d, range: r)
          m.addAttribute(CMLEmojiKey, value: u, range: r)
          m.addAttribute(CMLEmojiSizeKey, value: NSNumber(value: Double(side)), range: r)
          // glyph invisível (o delegate dá a largura)
          m.addAttribute(.foregroundColor, value: UIColor.clear, range: r)
          m.addAttribute(CMLCTColorKey, value: UIColor.clear.cgColor, range: r)
        }
        continue
      }
      if (f & CMLSpan.spoiler) != 0 { m.addAttribute(CMLSpoilerKey, value: NSNumber(value: 1), range: r) }
      if (f & CMLSpan.code) != 0 {
        let monoF = font === s.body ? s.mono : UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.92, weight: .regular)
        m.addAttribute(.font, value: monoF, range: r)
        let bgc: UIColor = sp.color.map { CMLTheme.uiColor($0) } ?? color.withAlphaComponent(0.1)
        m.addAttribute(CMLCodeBgKey, value: bgc, range: r)
      } else if let c = sp.color {
        let uc = CMLTheme.uiColor(c)
        m.addAttribute(.foregroundColor, value: uc, range: r)
        m.addAttribute(CMLCTColorKey, value: uc.cgColor, range: r)
      }
      if (f & CMLSpan.code) != 0 {
        // fonte já aplicada
      } else if (f & CMLSpan.mono) != 0 {
        let monoF = font === s.body ? s.mono : UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.92, weight: .regular)
        m.addAttribute(.font, value: monoF, range: r)
      } else if bold && ital {
        m.addAttribute(.font, value: s.bodyBoldItalic, range: r)
      } else if bold {
        m.addAttribute(.font, value: font === s.body ? s.bodyBold : UIFont.systemFont(ofSize: font.pointSize, weight: .semibold), range: r)
      } else if ital {
        m.addAttribute(.font, value: font === s.body ? s.bodyItalic : UIFont.italicSystemFont(ofSize: font.pointSize), range: r)
      }
      if (f & CMLSpan.strike) != 0 { m.addAttribute(CMLStrikeKey, value: NSNumber(value: 1), range: r) }
      if (f & (CMLSpan.link | CMLSpan.mention | CMLSpan.hashtag)) != 0 {
        let prefix = (f & CMLSpan.mention) != 0 ? "mention:" : ((f & CMLSpan.hashtag) != 0 ? "hashtag:" : "")
        let url = prefix + (sp.url ?? (text as NSString).substring(with: r))
        m.addAttribute(CMLLinkKey, value: url, range: r)
        m.addAttribute(.foregroundColor, value: linkColor, range: r)
        m.addAttribute(CMLCTColorKey, value: linkColor.cgColor, range: r)
        if (f & CMLSpan.link) != 0 {
          m.addAttribute(NSAttributedString.Key(kCTUnderlineStyleAttributeName as String), value: NSNumber(value: CTUnderlineStyle.single.rawValue), range: r)
        }
      }
    }
    return m
  }

  static func plain(_ text: String, font: UIFont, color: UIColor) -> NSAttributedString {
    return NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color, CMLCTColorKey: color.cgColor])
  }

  static func line(_ text: String, font: UIFont, color: UIColor, maxWidth: CGFloat) -> CMLTextLayout {
    return CMLTextLayout.make(plain(text, font: font, color: color), maxWidth: maxWidth, lineHeight: ceil(font.lineHeight), font: font, maxLines: 1)
  }

  // MARK: pílulas

  static func buildPill(_ row: CMLRow, _ s: CMLStyle, font: UIFont, color: UIColor, bg: Bool) -> CMLRowLayout {
    let L = CMLRowLayout()
    L.kind = row.kind
    let maxW = floor(s.width * 0.8) - 24
    // [2026-10-17 wa-pills] padding ~5 vertical / 12 horizontal
    // [2026-10-19 tg-style] cápsula Telegram: ~3,5 vertical / 10 horizontal, mín. 22
    let lh = ceil(font.lineHeight + 1)
    let t = CMLTextLayout.make(plain(row.text, font: font, color: color), maxWidth: maxW, lineHeight: lh, font: font, maxLines: row.kind == .date ? 1 : 6)
    L.pillText = t
    let pw = min(s.width - 32, t.size.width + (s.ts ? 20 : 24))
    let ph = s.ts ? max(22, t.size.height + 7) : max(24, t.size.height + 10)
    let top: CGFloat = row.kind == .date ? 8 : 6
    L.pillFrame = CGRect(x: floor((s.width - pw) / 2), y: top, width: pw, height: ph)
    L.pillTextFrame = CGRect(x: L.pillFrame.minX + floor((pw - t.size.width) / 2), y: L.pillFrame.minY + floor((ph - t.size.height) / 2), width: t.size.width + 1, height: t.size.height)
    L.height = row.text.isEmpty ? 1 : (top + ph + (row.kind == .date ? 8 : 6))
    return L
  }

  static func buildUnread(_ row: CMLRow, _ s: CMLStyle) -> CMLRowLayout {
    let L = CMLRowLayout()
    L.kind = .unread
    let t = line(row.text, font: s.unread, color: s.theme.unreadText, maxWidth: s.width - 32)
    L.pillText = t
    L.pillFrame = CGRect(x: 0, y: 8, width: s.width, height: 30)
    L.pillTextFrame = CGRect(x: floor((s.width - t.size.width) / 2), y: 8 + floor((30 - t.size.height) / 2), width: t.size.width + 1, height: t.size.height)
    L.height = 46
    return L
  }

  // MARK: meta

  static func makeMeta(_ row: CMLRow, _ s: CMLStyle, onMedia: Bool) -> CMLMeta {
    var m = CMLMeta()
    m.onMedia = onMedia
    let color: UIColor = onMedia ? UIColor(white: 1, alpha: 0.95) : (row.own ? s.theme.ownMeta : s.theme.otherMeta)
    m.color = color
    var str = row.time
    if !row.edited.isEmpty { str = row.edited + "  " + str }
    let t = line(str, font: s.meta, color: color, maxWidth: 160)
    m.text = t
    m.star = row.star
    m.pin = row.pin
    m.timer = row.timer
    m.status = row.own ? row.status : nil
    var w = t.size.width
    if m.star { w += 13 }
    if m.pin { w += 13 }
    if m.timer { w += 13 }
    if m.status != nil { w += 3 + CMLMeta.tickWidth(m.status) }
    m.width = ceil(w)
    m.height = max(14, t.size.height)
    return m
  }

  // MARK: mensagem

  /// [2026-10-17 fwd-label] largura reservada p/ a seta do "Encaminhada" (dupla se ≥ 5).
  static func fwdIconW(_ row: CMLRow) -> CGFloat { row.forwardedMany ? 21 : 16 } // ícone 12 + ~4 de respiro

  static func buildMessage(_ row: CMLRow, _ s: CMLStyle) -> CMLRowLayout {
    let L = CMLRowLayout()
    L.kind = .msg
    let th = s.theme
    let textColor = row.own ? th.ownText : th.otherText
    let gutter: CGFloat = row.sel > 0 ? selGutter : 0
    let bubbleMax = max(120, s.bubbleMax - (row.own ? 0 : gutter))
    let contentMax = bubbleMax - padH * 2

    var bubbleW: CGFloat = 0
    var bubbleH: CGFloat = 0
    var y: CGFloat = 0
    var showBubble = !row.bare

    // ---- peças do topo (nome, encaminhada, citação) — medidas contra contentMax
    var nameL: CMLTextLayout? = nil
    var fwdL: CMLTextLayout? = nil
    var rName: CMLTextLayout? = nil
    var rText: CMLTextLayout? = nil
    let hasThumb = !(row.reply?.thumb.isEmpty ?? true)
    if !row.name.isEmpty {
      nameL = line(row.name, font: s.name, color: CMLTheme.uiColor(row.nameColor), maxWidth: contentMax)
    }
    if !row.forwarded.isEmpty && !row.deleted {
      // [2026-10-17 fwd-label] seta (desenhada, sem emoji) à esquerda do rótulo
      fwdL = line(row.forwarded, font: s.fwd, color: row.own ? th.ownMeta : th.otherMeta, maxWidth: max(40, contentMax - CMLLayoutBuilder.fwdIconW(row)))
    }
    if let rp = row.reply, !row.deleted {
      let qMax = contentMax + padH * 2 - 8 - 3 - 16 - (hasThumb ? 48 : 0)
      rName = line(rp.name, font: s.quoteName, color: CMLTheme.uiColor(rp.color), maxWidth: qMax)
      rText = line(rp.text.isEmpty ? " " : rp.text, font: rp.italic ? s.quoteItalic : s.quoteText, color: row.own ? th.ownMeta : th.otherMeta, maxWidth: qMax)
    }
    var topMinW: CGFloat = 0
    if let n = nameL { topMinW = max(topMinW, n.size.width) }
    if let f = fwdL { topMinW = max(topMinW, f.size.width + CMLLayoutBuilder.fwdIconW(row)) }
    if let a = rName, let b = rText {
      topMinW = max(topMinW, max(a.size.width, b.size.width) + 3 + 16 + (hasThumb ? 48 : 0) - 8)
      topMinW = max(topMinW, 140)
    }
    topMinW = min(topMinW, contentMax)

    // posições relativas ao balão (preenchidas abaixo, depois do bubbleW)
    var nameY: CGFloat = 0, fwdY: CGFloat = 0, replyY: CGFloat = 0
    func layTop(inset: CGFloat) {
      y = inset > padH ? padV : padV
      if let n = nameL { nameY = y; y += n.size.height + 1 }
      if let f = fwdL { fwdY = y; y += f.size.height + 2 }
      if rName != nil { if y > padV { y += 1 }; replyY = y; y += 50 + 5 }
    }
    let hasTop = nameL != nil || fwdL != nil || rName != nil

    let meta: CMLMeta
    if row.deleted {
      // ---- apagada: texto itálico com ícone, meta inline
      let iconW: CGFloat = 20
      let attr = plain(row.text, font: s.bodyItalic, color: row.own ? th.ownMeta : th.otherMeta)
      let t = CMLTextLayout.make(attr, maxWidth: contentMax - iconW, lineHeight: s.lineHeight, font: s.body)
      L.text = t
      L.deletedIcon = true
      var m = makeMeta(row, s, onMedia: false)
      m.status = nil
      m.width = m.text.map { ceil($0.size.width) } ?? 0
      meta = m
      layTop(inset: padH)
      let fits = t.lastLineWidth + iconW + metaGap + meta.width <= contentMax
      var cw = max(t.size.width + iconW, topMinW)
      if fits { cw = max(cw, t.lastLineWidth + iconW + metaGap + meta.width) } else { cw = max(cw, meta.width) }
      bubbleW = cw + padH * 2
      L.textFrame = CGRect(x: padH + iconW, y: y, width: t.size.width + 1, height: t.size.height)
      y += t.size.height
      if !fits { y += meta.height }
      bubbleH = y + padV
      L.metaFrame = CGRect(x: bubbleW - padH - meta.width + 2, y: bubbleH - padV - meta.height + 1, width: meta.width + 2, height: meta.height)
    } else if !row.blocks.isEmpty {
      // ---- [fase 2] cartão em blocos (enquete, localização, contato, código…)
      let isBare = row.bare
      showBubble = !isBare
      let pad = row.pad ?? (isBare ? .zero : UIEdgeInsets(top: padV, left: padH, bottom: padV, right: padH))
      let nctx = CMLNodeCtx(style: s, textColor: textColor, linkColor: row.own ? th.ownText : th.link)
      let room = max(60, bubbleMax - pad.left - pad.right)
      let maxContent = row.cw > 0 ? min(row.cw, room) : room
      let measured = CMLNodeLayout.measureRoots(row.blocks, maxW: maxContent, nctx)
      var mp = row.metaPos
      if mp.isEmpty {
        if let last = row.blocks.last, last.kind == .tx, last.metaInline { mp = "in" } else { mp = "below" }
      }
      var m = makeMeta(row, s, onMedia: mp == "over" || isBare)
      m.onMedia = mp == "over" || isBare
      var contentW = row.cw > 0 ? maxContent : min(maxContent, measured.width)
      if hasTop && !isBare { contentW = max(contentW, min(maxContent, topMinW)) }
      if (mp == "below" || mp == "in") && !isBare { contentW = max(contentW, min(maxContent, m.width)) }
      contentW = ceil(contentW)
      if hasTop && !isBare {
        y = padV
        if let n = nameL { nameY = y; y += n.size.height + 1 }
        if let f = fwdL { fwdY = y; y += f.size.height + 2 }
        if rName != nil { if y > padV { y += 1 }; replyY = y; y += 50 + 5 }
      } else {
        y = pad.top
      }
      let bl = CMLNodeLayout.placeRoots(measured.kids, x: pad.left, y: y, width: contentW)
      y = bl.bottom
      bubbleW = contentW + pad.left + pad.right
      if mp == "none" {
        bubbleH = y + pad.bottom
        L.metaFrame = .zero
      } else if mp == "over" {
        bubbleH = y + pad.bottom
        let pw = m.width + 12
        let r = bl.lastRootFrame
        L.metaFrame = CGRect(x: r.maxX - pw - 5, y: r.maxY - 18 - 5, width: pw, height: 18)
      } else if isBare {
        let pw = m.width + 12
        L.metaFrame = CGRect(x: row.own ? bubbleW - pw : 0, y: y + 2, width: pw, height: 18)
        bubbleH = y + 2 + 18
      } else {
        var fits = false
        if mp == "in", let hi = bl.metaHost, hi < bl.ops.count, let t = bl.ops[hi].text {
          let fr = bl.ops[hi].frame
          let lineEnd = fr.minX + t.lineOffset(t.lineCount - 1) + t.lastLineWidth
          fits = abs(fr.maxY - y) < 1.5 && lineEnd + metaGap + m.width <= pad.left + contentW
        }
        if !fits { y += m.height }
        bubbleH = y + pad.bottom
        L.metaFrame = CGRect(x: bubbleW - pad.right - m.width + 2, y: bubbleH - pad.bottom - m.height + 1, width: m.width + 2, height: m.height)
      }
      meta = m
      L.blocks = bl
    } else if row.jumbo > 0 {
      // ---- emoji grande sem balão
      showBubble = false
      let f = UIFont.systemFont(ofSize: row.jumbo)
      let t = CMLTextLayout.make(plain(row.text, font: f, color: row.own ? th.otherText : th.otherText), maxWidth: contentMax, lineHeight: row.jumbo + 8, font: f)
      L.text = t
      var m = makeMeta(row, s, onMedia: true)
      m.onMedia = true
      meta = m
      bubbleW = max(t.size.width, meta.width + 14)
      L.textFrame = CGRect(x: row.own ? bubbleW - t.size.width : 0, y: 0, width: t.size.width + 1, height: t.size.height)
      let mw = meta.width + 12
      L.metaFrame = CGRect(x: row.own ? bubbleW - mw : 0, y: t.size.height + 2, width: mw, height: 18)
      bubbleH = t.size.height + 2 + 18
    } else if let md = row.media, md.kind == "sticker" {
      showBubble = false
      let side: CGFloat = 130
      var m = makeMeta(row, s, onMedia: true)
      m.onMedia = true
      meta = m
      bubbleW = side
      L.mediaFrame = CGRect(x: 0, y: 0, width: side, height: side)
      L.mediaRadius = 0
      let mw = meta.width + 12
      L.metaFrame = CGRect(x: row.own ? side - mw : 0, y: side + 2, width: mw, height: 18)
      bubbleH = side + 2 + 18
    } else if row.media != nil || !row.album.isEmpty {
      // ---- mídia (foto / vídeo / gif / álbum) + legenda opcional
      // [2026-10-18 tg-look] sem peças no topo → mídia rente à bolha (mi 0)
      let flush = s.tg && !hasTop && row.pre.isEmpty && row.post.isEmpty
      let mi: CGFloat = flush ? 0 : mediaInset
      L.mediaFlush = flush
      L.mediaCaption = !row.text.isEmpty
      let maxMediaW = min(bubbleMax - mi * 2, 280)
      var mw: CGFloat = maxMediaW
      var mh: CGFloat = maxMediaW
      if let md = row.media {
        if md.w > 0 && md.h > 0 {
          let ratio = md.h / md.w
          mw = maxMediaW
          mh = mw * ratio
          if mh > 360 { mh = 360; mw = max(150, min(maxMediaW, mh / ratio)) }
          if mh < 110 { mh = 110 }
        } else {
          mw = min(maxMediaW, 240); mh = mw
        }
        mw = max(mw, min(maxMediaW, topMinW + padH * 2 - mi * 2))
      } else {
        let n = row.album.count
        mw = maxMediaW
        let g: CGFloat = 2
        var frames: [CGRect] = []
        switch n {
        case 1:
          mh = mw
          frames = [CGRect(x: 0, y: 0, width: mw, height: mh)]
        case 2:
          let cw = floor((mw - g) / 2)
          mh = floor(cw * 1.3)
          frames = [CGRect(x: 0, y: 0, width: cw, height: mh), CGRect(x: cw + g, y: 0, width: mw - cw - g, height: mh)]
        case 3:
          let top = floor(mw * 0.62)
          let cw = floor((mw - g) / 2)
          let bh = floor(cw * 0.8)
          mh = top + g + bh
          frames = [CGRect(x: 0, y: 0, width: mw, height: top),
                    CGRect(x: 0, y: top + g, width: cw, height: bh),
                    CGRect(x: cw + g, y: top + g, width: mw - cw - g, height: bh)]
        default:
          let cw = floor((mw - g) / 2)
          mh = cw * 2 + g
          frames = [CGRect(x: 0, y: 0, width: cw, height: cw),
                    CGRect(x: cw + g, y: 0, width: mw - cw - g, height: cw),
                    CGRect(x: 0, y: cw + g, width: cw, height: cw),
                    CGRect(x: cw + g, y: cw + g, width: mw - cw - g, height: cw)]
        }
        L.albumFrames = frames
      }
      mw = floor(mw); mh = floor(mh)
      bubbleW = mw + mi * 2
      let capMax = bubbleW - 18
      if hasTop {
        y = padV
        if let n = nameL { nameY = y; y += n.size.height + 1 }
        if let f = fwdL { fwdY = y; y += f.size.height + 2 }
        if rName != nil { replyY = y; y += 50 + 4 }
      } else {
        y = mi
      }
      L.mediaFrame = CGRect(x: mi, y: y, width: mw, height: mh)
      L.mediaRadius = max(4, s.radius - mi)
      // offset das células do álbum para coordenadas do balão
      L.albumFrames = L.albumFrames.map { $0.offsetBy(dx: mi, dy: y) }
      y += mh
      if !row.text.isEmpty {
        let attr = attributed(row.text, spans: row.spans, font: s.body, color: textColor, linkColor: row.own ? th.ownText : th.link, s: s)
        let t = CMLTextLayout.make(attr, maxWidth: capMax, lineHeight: s.lineHeight, font: s.body)
        L.text = t
        let m = makeMeta(row, s, onMedia: false)
        meta = m
        y += 5
        L.textFrame = CGRect(x: 9, y: y, width: t.size.width + 1, height: t.size.height)
        y += t.size.height
        let fits = t.lastLineWidth + metaGap + m.width <= capMax
        if !fits { y += m.height }
        bubbleH = y + padV
        L.metaFrame = CGRect(x: bubbleW - 9 - m.width, y: bubbleH - padV - m.height + 1, width: m.width + 2, height: m.height)
      } else {
        var m = makeMeta(row, s, onMedia: true)
        m.onMedia = true
        meta = m
        bubbleH = y + mi
        let pw = m.width + 12
        L.metaFrame = CGRect(x: L.mediaFrame.maxX - pw - 5, y: L.mediaFrame.maxY - 18 - 5, width: pw, height: 18)
      }
    } else if row.audio != nil {
      let m = makeMeta(row, s, onMedia: false)
      meta = m
      layTop(inset: padH)
      let cw = max(min(contentMax, 236), topMinW)
      bubbleW = cw + padH * 2 - 4
      L.audioFrame = CGRect(x: padH - 4, y: y, width: cw, height: 44)
      y += 44
      bubbleH = y + padV
      L.metaFrame = CGRect(x: bubbleW - padH - m.width + 2, y: bubbleH - padV - m.height, width: m.width + 2, height: m.height)
    } else if let f = row.file {
      let m = makeMeta(row, s, onMedia: false)
      meta = m
      layTop(inset: padH)
      let cw = max(min(contentMax, 250), topMinW)
      let nameMax = cw - 52
      let nl = CMLTextLayout.make(plain(f.name, font: s.fileName, color: textColor), maxWidth: nameMax, lineHeight: ceil(s.fileName.lineHeight + 1), font: s.fileName, maxLines: 2)
      let sl = line([f.size, f.ext].filter { !$0.isEmpty }.joined(separator: " · "), font: s.small, color: row.own ? th.ownMeta : th.otherMeta, maxWidth: nameMax)
      let el = line(f.ext.isEmpty ? "FILE" : String(f.ext.prefix(4)), font: UIFont.systemFont(ofSize: 10, weight: .bold), color: .white, maxWidth: 40)
      L.fileName = nl
      L.fileSize = sl
      L.fileExt = el
      let fh = max(46, nl.size.height + 2 + sl.size.height)
      bubbleW = cw + padH * 2
      L.fileFrame = CGRect(x: padH, y: y, width: cw, height: fh)
      y += fh
      if !row.text.isEmpty {
        let attr = attributed(row.text, spans: row.spans, font: s.body, color: textColor, linkColor: row.own ? th.ownText : th.link, s: s)
        let t = CMLTextLayout.make(attr, maxWidth: cw, lineHeight: s.lineHeight, font: s.body)
        L.text = t
        y += 4
        L.textFrame = CGRect(x: padH, y: y, width: t.size.width + 1, height: t.size.height)
        y += t.size.height
        if !(t.lastLineWidth + metaGap + m.width <= cw) { y += m.height }
      } else {
        y += m.height
      }
      bubbleH = y + padV
      L.metaFrame = CGRect(x: bubbleW - padH - m.width + 2, y: bubbleH - padV - m.height + 1, width: m.width + 2, height: m.height)
    } else {
      // ---- texto
      let attr = attributed(row.text, spans: row.spans, font: s.body, color: textColor, linkColor: row.own ? th.ownText : th.link, s: s)
      let t = CMLTextLayout.make(attr, maxWidth: contentMax, lineHeight: s.lineHeight, font: s.body)
      L.text = t
      let m = makeMeta(row, s, onMedia: false)
      meta = m
      layTop(inset: padH)
      let fits = t.lastLineWidth + metaGap + m.width <= contentMax
      var cw = max(t.size.width, topMinW)
      if fits { cw = max(cw, t.lastLineWidth + metaGap + m.width) } else { cw = max(cw, m.width) }
      cw = min(contentMax, ceil(cw))
      bubbleW = cw + padH * 2
      L.textFrame = CGRect(x: padH, y: y, width: t.size.width + 1, height: t.size.height)
      y += t.size.height
      if !fits { y += m.height }
      bubbleH = y + padV
      L.metaFrame = CGRect(x: bubbleW - padH - m.width + 2, y: bubbleH - padV - m.height + 1, width: m.width + 2, height: m.height)
    }
    L.meta = meta

    // ---- [fase 2] blocos antes/depois do conteúdo padrão (status respondido,
    // prévia de link, smart actions, "Ver original"…)
    if row.blocks.isEmpty && !row.deleted && showBubble && (!row.pre.isEmpty || !row.post.isEmpty) {
      let isMedia = row.media != nil || !row.album.isEmpty
      let inset: CGFloat = isMedia ? 9 : padH
      let nctx = CMLNodeCtx(style: s, textColor: textColor, linkColor: row.own ? th.ownText : th.link)
      let maxW = isMedia ? max(40, bubbleW - inset * 2) : max(60, bubbleMax - inset * 2)
      let preM = row.pre.isEmpty ? nil : CMLNodeLayout.measureRoots(row.pre, maxW: maxW, nctx)
      let postM = row.post.isEmpty ? nil : CMLNodeLayout.measureRoots(row.post, maxW: maxW, nctx)
      if !isMedia {
        let need = min(bubbleMax, max(preM?.width ?? 0, postM?.width ?? 0) + inset * 2)
        if need > bubbleW {
          let dx = need - bubbleW
          bubbleW = need
          L.metaFrame = L.metaFrame.offsetBy(dx: dx, dy: 0)
        }
      }
      let cw = max(0, bubbleW - inset * 2)
      let combined = CMLBlocksLayout()
      if let pm = preM {
        var y0: CGFloat = .greatestFiniteMagnitude
        for f in [L.textFrame, L.mediaFrame, L.audioFrame, L.fileFrame] where !f.isEmpty { y0 = min(y0, f.minY) }
        if y0 == .greatestFiniteMagnitude { y0 = padV }
        let dy = pm.height + 4
        func shift(_ r: CGRect) -> CGRect { return (!r.isEmpty && r.minY >= y0 - 0.5) ? r.offsetBy(dx: 0, dy: dy) : r }
        L.textFrame = shift(L.textFrame)
        L.mediaFrame = shift(L.mediaFrame)
        L.albumFrames = L.albumFrames.map { shift($0) }
        L.audioFrame = shift(L.audioFrame)
        L.fileFrame = shift(L.fileFrame)
        L.metaFrame = shift(L.metaFrame)
        bubbleH += dy
        combined.merge(CMLNodeLayout.placeRoots(pm.kids, x: inset, y: y0, width: cw))
      }
      if let qm = postM {
        var cb: CGFloat = 0
        for f in [L.textFrame, L.mediaFrame, L.audioFrame, L.fileFrame] where !f.isEmpty { cb = max(cb, f.maxY) }
        for f in L.albumFrames { cb = max(cb, f.maxY) }
        if L.meta.onMedia {
          L.meta = makeMeta(row, s, onMedia: false)
        }
        let m = L.meta
        let b = CMLNodeLayout.placeRoots(qm.kids, x: inset, y: cb + 4, width: cw)
        var yy = b.bottom
        var fits = false
        if let hi = b.metaHost, hi < b.ops.count, let t = b.ops[hi].text {
          let fr = b.ops[hi].frame
          let lineEnd = fr.minX + t.lineOffset(t.lineCount - 1) + t.lastLineWidth
          fits = abs(fr.maxY - yy) < 1.5 && lineEnd + metaGap + m.width <= inset + cw
        }
        if !fits { yy += m.height }
        bubbleH = yy + padV
        L.metaFrame = CGRect(x: bubbleW - inset - m.width + 2, y: bubbleH - padV - m.height + 1, width: m.width + 2, height: m.height)
        combined.merge(b)
      }
      L.blocks = combined
    }

    // peças do topo: largura total do conteúdo
    if hasTop && showBubble {
      let inner = bubbleW - padH * 2
      if let n = nameL { L.name = n; L.nameFrame = CGRect(x: padH, y: nameY, width: min(inner, n.size.width + 1), height: n.size.height) }
      if let f = fwdL { let iw = CMLLayoutBuilder.fwdIconW(row); L.fwd = f; L.fwdFrame = CGRect(x: padH + iw, y: fwdY, width: max(0, min(inner - iw, f.size.width + 1)), height: f.size.height) }
      if rName != nil {
        L.replyName = rName
        L.replyText = rText
        L.replyThumb = hasThumb
        L.replyFrame = CGRect(x: 4, y: replyY, width: bubbleW - 8, height: 50)
      }
    }

    // ---- posição horizontal + altura da linha
    let x: CGFloat = row.own ? (s.width - side - tail - bubbleW) : (side + tail + gutter)
    let top: CGFloat = row.first ? 2 : 0
    L.bubbleFrame = CGRect(x: x, y: top, width: bubbleW, height: bubbleH)
    L.showBubble = showBubble
    var h = top + bubbleH
    if !row.reacts.isEmpty {
      var chips: [(CGRect, CTLine)] = []
      var cx: CGFloat = 0
      for r in row.reacts {
        let str = r.count > 1 ? "\(r.emoji) \(r.count)" : r.emoji
        let ln = CTLineCreateWithAttributedString(plain(str, font: s.react, color: th.otherText) as CFAttributedString)
        let w = ceil(CMLTextLayout.width(of: ln)) + 14
        chips.append((CGRect(x: cx, y: 0, width: w, height: 24), ln))
        cx += w + 4
      }
      let total = max(0, cx - 4)
      let rx = row.own ? (L.bubbleFrame.maxX - 6 - total) : (L.bubbleFrame.minX + 6)
      L.reactsFrame = CGRect(x: max(side, rx), y: L.bubbleFrame.maxY - 5, width: total, height: 24)
      L.reactChips = chips
      h = L.reactsFrame.maxY
    }
    // [2026-10-19 tg-style] 2 pt dentro do grupo, 8 pt entre grupos (6 + 2 do topo da 1ª)
    h += row.last ? (s.ts ? 6 : 7) : 2
    L.height = ceil(h)
    if row.sel > 0 {
      L.selCircle = CGRect(x: 10, y: L.bubbleFrame.midY - 11, width: 22, height: 22)
    }
    L.replyIconX = row.own ? (s.width - 44) : (side + gutter)
    if row.fail {
      let fx = row.own ? L.bubbleFrame.minX - 6 - 22 : L.bubbleFrame.maxX + 6
      L.failFrame = CGRect(x: fx, y: L.bubbleFrame.midY - 11, width: 22, height: 22)
    }
    if s.tg {
      // [2026-10-18 tg-look] mídia rente sem legenda = só a mídia (sem fundo/rabicho)
      let mediaOnly = L.mediaFlush && !L.mediaCaption
      if mediaOnly { L.showBubble = false }
      let c = tgCorners(L.bubbleFrame, own: row.own, first: row.first, last: row.last, radius: s.radius, tail: !mediaOnly)
      if L.mediaFlush {
        let mc: [CGFloat] = L.mediaCaption ? [c[0], c[1], 0, 0] : c
        let mf = L.mediaFrame
        L.mediaOuter = mc
        if row.album.isEmpty {
          L.mediaCorners = mc
        } else {
          let inner: CGFloat = 4
          L.albumCorners = L.albumFrames.map { (f: CGRect) -> [CGFloat] in
            let l = f.minX <= mf.minX + 0.5, r = f.maxX >= mf.maxX - 0.5
            let t = f.minY <= mf.minY + 0.5, b = f.maxY >= mf.maxY - 0.5
            return [(t && l) ? mc[0] : inner, (t && r) ? mc[1] : inner, (b && r) ? mc[2] : inner, (b && l) ? mc[3] : inner]
          }
        }
      }
      if L.showBubble {
        L.bubblePath = tgBubblePath(L.bubbleFrame, own: row.own, first: row.first, last: row.last, radius: s.radius, tail: !mediaOnly)
      }
      return L
    }
    if showBubble {
      L.bubblePath = bubblePath(L.bubbleFrame, own: row.own, first: row.first, last: row.last, radius: s.radius)
    }
    return L
  }

  /// [2026-10-18 tg-look] Cantos [tl, tr, br, bl] da bolha estilo Telegram: lado do
  /// autor justo dentro do grupo (6 pt); a última do grupo leva o rabicho embaixo
  /// (canto 0, o rabicho completa) — sem rabicho (mídia pura) fica redonda.
  static func tgCorners(_ r: CGRect, own: Bool, first: Bool, last: Bool, radius: CGFloat, tail: Bool) -> [CGFloat] {
    let big = max(0, min(radius, r.height / 2, r.width / 2))
    let small = min(CMLLook.groupRadius, big)
    let aTop: CGFloat = first ? big : small
    let aBot: CGFloat = last ? (tail ? 0 : big) : small
    return own ? [big, aTop, aBot, big] : [aTop, big, big, aBot]
  }

  /// [2026-10-18 tg-look] Balão estilo Telegram: rabicho curvo saindo do canto de
  /// baixo do lado do autor (só na última do grupo), cantos por posição.
  static func tgBubblePath(_ r: CGRect, own: Bool, first: Bool, last: Bool, radius: CGFloat, tail: Bool) -> CGPath {
    let c = tgCorners(r, own: own, first: first, last: last, radius: radius, tail: tail)
    let tl = c[0], tr = c[1], br = c[2], bl = c[3]
    let withTail = tail && last
    let w = CMLLayoutBuilder.tail
    let p = CGMutablePath()
    p.move(to: CGPoint(x: r.minX + tl, y: r.minY))
    p.addLine(to: CGPoint(x: r.maxX - tr, y: r.minY))
    if tr > 0 { p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.minY), tangent2End: CGPoint(x: r.maxX, y: r.minY + tr), radius: tr) }
    if own && withTail {
      let ty = max(r.minY + tr, r.maxY - CMLLook.tailRise)
      p.addLine(to: CGPoint(x: r.maxX, y: ty))
      p.addCurve(to: CGPoint(x: r.maxX + w, y: r.maxY - 0.6),
                 control1: CGPoint(x: r.maxX, y: r.maxY - 4.5),
                 control2: CGPoint(x: r.maxX + w * 0.5, y: r.maxY - 1.4))
      p.addQuadCurve(to: CGPoint(x: r.maxX + w - 2.4, y: r.maxY), control: CGPoint(x: r.maxX + w + 0.4, y: r.maxY))
    } else {
      p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - br))
      if br > 0 { p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.maxY), tangent2End: CGPoint(x: r.maxX - br, y: r.maxY), radius: br) }
    }
    if !own && withTail {
      let ty = max(r.minY + tl, r.maxY - CMLLook.tailRise)
      p.addLine(to: CGPoint(x: r.minX - w + 2.4, y: r.maxY))
      p.addQuadCurve(to: CGPoint(x: r.minX - w, y: r.maxY - 0.6), control: CGPoint(x: r.minX - w - 0.4, y: r.maxY))
      p.addCurve(to: CGPoint(x: r.minX, y: ty),
                 control1: CGPoint(x: r.minX - w * 0.5, y: r.maxY - 1.4),
                 control2: CGPoint(x: r.minX, y: r.maxY - 4.5))
    } else {
      p.addLine(to: CGPoint(x: r.minX + bl, y: r.maxY))
      if bl > 0 { p.addArc(tangent1End: CGPoint(x: r.minX, y: r.maxY), tangent2End: CGPoint(x: r.minX, y: r.maxY - bl), radius: bl) }
    }
    p.addLine(to: CGPoint(x: r.minX, y: r.minY + tl))
    if tl > 0 { p.addArc(tangent1End: CGPoint(x: r.minX, y: r.minY), tangent2End: CGPoint(x: r.minX + tl, y: r.minY), radius: tl) }
    p.closeSubpath()
    return p
  }

  /// [2026-10-18 tg-look] Retângulo com raio por canto [tl, tr, br, bl].
  static func roundedPath(_ r: CGRect, _ c: [CGFloat]) -> CGPath {
    guard c.count == 4 else { return CGPath(rect: r, transform: nil) }
    let lim = min(r.width, r.height) / 2
    let tl = max(0, min(c[0], lim)), tr = max(0, min(c[1], lim)), br = max(0, min(c[2], lim)), bl = max(0, min(c[3], lim))
    let p = CGMutablePath()
    p.move(to: CGPoint(x: r.minX + tl, y: r.minY))
    p.addLine(to: CGPoint(x: r.maxX - tr, y: r.minY))
    if tr > 0 { p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.minY), tangent2End: CGPoint(x: r.maxX, y: r.minY + tr), radius: tr) }
    p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - br))
    if br > 0 { p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.maxY), tangent2End: CGPoint(x: r.maxX - br, y: r.maxY), radius: br) }
    p.addLine(to: CGPoint(x: r.minX + bl, y: r.maxY))
    if bl > 0 { p.addArc(tangent1End: CGPoint(x: r.minX, y: r.maxY), tangent2End: CGPoint(x: r.minX, y: r.maxY - bl), radius: bl) }
    p.addLine(to: CGPoint(x: r.minX, y: r.minY + tl))
    if tl > 0 { p.addArc(tangent1End: CGPoint(x: r.minX, y: r.minY), tangent2End: CGPoint(x: r.minX + tl, y: r.minY), radius: tl) }
    p.closeSubpath()
    return p
  }

  /// Balão com cantos por posição no grupo + rabicho na 1ª do grupo (WhatsApp).
  static func bubblePath(_ r: CGRect, own: Bool, first: Bool, last: Bool, radius: CGFloat) -> CGPath {
    let big = min(radius, r.height / 2, r.width / 2)
    let small = min(5, big)
    let authorTop: CGFloat = first ? 0 : small
    let authorBottom: CGFloat = last ? big : small
    // tl, tr, br, bl
    let tl = own ? big : authorTop
    let tr = own ? authorTop : big
    let br = own ? authorBottom : big
    let bl = own ? big : authorBottom
    let p = CGMutablePath()
    p.move(to: CGPoint(x: r.minX + tl, y: r.minY))
    if own && first {
      p.addLine(to: CGPoint(x: r.maxX + tail, y: r.minY))
      p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.minY + 9), control: CGPoint(x: r.maxX + 1, y: r.minY + 2))
    } else {
      p.addLine(to: CGPoint(x: r.maxX - tr, y: r.minY))
      if tr > 0 { p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.minY), tangent2End: CGPoint(x: r.maxX, y: r.minY + tr), radius: tr) }
    }
    p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - br))
    if br > 0 { p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.maxY), tangent2End: CGPoint(x: r.maxX - br, y: r.maxY), radius: br) }
    p.addLine(to: CGPoint(x: r.minX + bl, y: r.maxY))
    if bl > 0 { p.addArc(tangent1End: CGPoint(x: r.minX, y: r.maxY), tangent2End: CGPoint(x: r.minX, y: r.maxY - bl), radius: bl) }
    if !own && first {
      p.addLine(to: CGPoint(x: r.minX, y: r.minY + 9))
      p.addQuadCurve(to: CGPoint(x: r.minX - tail, y: r.minY), control: CGPoint(x: r.minX - 1, y: r.minY + 2))
      p.closeSubpath()
    } else {
      p.addLine(to: CGPoint(x: r.minX, y: r.minY + tl))
      if tl > 0 { p.addArc(tangent1End: CGPoint(x: r.minX, y: r.minY), tangent2End: CGPoint(x: r.minX + tl, y: r.minY), radius: tl) }
      p.closeSubpath()
    }
    return p
  }
}
