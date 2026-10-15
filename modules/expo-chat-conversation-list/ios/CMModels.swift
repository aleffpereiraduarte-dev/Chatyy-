import UIKit

// [2026-10-15 native-social] COMUNIDADES em nativo — modelos.
// Lista da aba (components/CommunitiesTab.js) e tela da comunidade
// (app/community/[id].js) usam o MESMO motor (CMListCore) e o mesmo formato
// de linha plana vindo do JS (components/communities/communityRows.js):
//
//   id, kind  "card"    cabeçalho do cartão da comunidade (avatar quadrado
//                       arredondado 48, nome, meta, chevron expandir)
//             "group"   grupo dentro do cartão aberto (caixa interna, ponto,
//                       nome, membros, X remover p/ admin)
//             "row"     linha-caixa da tela da comunidade (tag à esquerda,
//                       título, subtítulo, tag de cargo à direita; center=1
//                       → botão tracejado "Adicionar sub-grupo")
//             "text"    texto (ts: label | desc | body | empty | hint | title)
//             "loading" spinner
//             "actions" pílulas de ação (b1/b1k/b1i, b2/b2k/b2i)
//   seg   "" (sem cartão) | one | top | mid | bot  → segmentos de UM cartão
//   cs    estilo do cartão: c (superfície + borda, raio 14) · b (caixa cheia,
//         raio 8) · d (tracejado, raio 8)
//   mt/mb margem acima/abaixo (fora do cartão), pb respiro interno embaixo,
//   px recuo horizontal do conteúdo, hx margem lateral do cartão.
//   title, sub, body, tag/tbg/tfg (antes do título), rtag/rbg/rfg (direita),
//   u/a/i (imagem/autenticada/inicial), x (aberto), chev, rm, div, center,
//   tap (tocável), lp (toque longo), ink (título na cor de destaque), a11y.

struct CMRow {
  var id = ""
  var kind = "row"
  var seg = ""
  var cs = "c"
  var mt: CGFloat = 0
  var mb: CGFloat = 0
  var pb: CGFloat = 0
  var px: CGFloat = 14
  var hx: CGFloat = 12
  var title = ""
  var sub = ""
  var body = ""
  var ts = "body"
  var tag = ""
  var tagBg = ""
  var tagFg = ""
  var rtag = ""
  var rtagBg = ""
  var rtagFg = ""
  var url = ""
  var auth = false
  var initial = ""
  var expanded = false
  var chevron = false
  var remove = false
  var div = false
  var center = false
  var tap = false
  var longPress = false
  var ink = false
  var b1 = ""
  var b1k = ""
  var b1i = ""
  var b2 = ""
  var b2k = ""
  var b2i = ""
  var a11y = ""

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    kind = CLVal.str(d["kind"]); if kind.isEmpty { kind = "row" }
    seg = CLVal.str(d["seg"])
    cs = CLVal.str(d["cs"]); if cs.isEmpty { cs = "c" }
    mt = CGFloat(CLVal.double(d["mt"]))
    mb = CGFloat(CLVal.double(d["mb"]))
    pb = CGFloat(CLVal.double(d["pb"]))
    if d["px"] != nil { px = CGFloat(CLVal.double(d["px"])) }
    if d["hx"] != nil { hx = CGFloat(CLVal.double(d["hx"])) }
    title = CLVal.str(d["title"])
    sub = CLVal.str(d["sub"])
    body = CLVal.str(d["body"])
    ts = CLVal.str(d["ts"]); if ts.isEmpty { ts = "body" }
    tag = CLVal.str(d["tag"])
    tagBg = CLVal.str(d["tbg"])
    tagFg = CLVal.str(d["tfg"])
    rtag = CLVal.str(d["rtag"])
    rtagBg = CLVal.str(d["rbg"])
    rtagFg = CLVal.str(d["rfg"])
    url = CLVal.str(d["u"])
    auth = CLVal.bool(d["a"])
    initial = CLVal.str(d["i"])
    expanded = CLVal.bool(d["x"])
    chevron = CLVal.bool(d["chev"])
    remove = CLVal.bool(d["rm"])
    div = CLVal.bool(d["div"])
    center = CLVal.bool(d["center"])
    tap = CLVal.bool(d["tap"])
    longPress = CLVal.bool(d["lp"])
    ink = CLVal.bool(d["ink"])
    b1 = CLVal.str(d["b1"]); b1k = CLVal.str(d["b1k"]); b1i = CLVal.str(d["b1i"])
    b2 = CLVal.str(d["b2"]); b2k = CLVal.str(d["b2k"]); b2i = CLVal.str(d["b2i"])
    a11y = CLVal.str(d["a11y"])
  }

  var hasCard: Bool { !seg.isEmpty }
  /// Margem de cima/baixo só existe nas pontas do cartão (ou sem cartão).
  var topGap: CGFloat { (seg.isEmpty || seg == "one" || seg == "top") ? mt : 0 }
  var bottomGap: CGFloat { (seg.isEmpty || seg == "one" || seg == "bot") ? mb : 0 }
}

/// Cores (o JS manda as do tema em `palette`, hex #RRGGBB ou #RRGGBBAA).
struct CMPalette {
  let dark: Bool
  var bg: UIColor
  var card: UIColor
  var border: UIColor
  var box: UIColor
  var inset: UIColor
  var text: UIColor
  var sub: UIColor
  var ter: UIColor
  var ink: UIColor
  var pill: UIColor
  var iconBg: UIColor
  var danger: UIColor
  var chevron: UIColor
  var divider: UIColor

  init(dark: Bool, dict: [String: Any]? = nil) {
    self.dark = dark
    if dark {
      bg = UIColor(clHex: 0x000000)
      card = UIColor(clHex: 0x161616)
      border = UIColor(white: 1, alpha: 0.06)
      box = UIColor(clHex: 0x1C1C1E)
      inset = UIColor(white: 1, alpha: 0.04)
      text = UIColor(clHex: 0xF5F5F7)
      sub = UIColor(clHex: 0x8B8FA3)
      ter = UIColor(clHex: 0x555555)
      ink = UIColor(clHex: 0xF5F5F7)
      pill = UIColor(white: 1, alpha: 0.10)
      iconBg = UIColor(white: 1, alpha: 0.08)
      chevron = UIColor(clHex: 0x666666)
    } else {
      bg = UIColor(clHex: 0xFFFFFF)
      card = UIColor.white
      border = UIColor(white: 0, alpha: 0.06)
      box = UIColor(clHex: 0xF8F8FA)
      inset = UIColor(white: 0, alpha: 0.02)
      text = UIColor(clHex: 0x111111)
      sub = UIColor(clHex: 0x6B7280)
      ter = UIColor(clHex: 0x999999)
      ink = UIColor(clHex: 0x111111)
      pill = UIColor(white: 0, alpha: 0.06)
      iconBg = UIColor(white: 0, alpha: 0.06)
      chevron = UIColor(clHex: 0x999999)
    }
    danger = UIColor(clHex: 0xEF4444)
    divider = border
    guard let d = dict else { return }
    func c(_ k: String) -> UIColor? { SLColor.parse(CLVal.str(d[k])) }
    if let v = c("bg") { bg = v }
    if let v = c("card") { card = v }
    if let v = c("border") { border = v; divider = v }
    if let v = c("box") { box = v }
    if let v = c("inset") { inset = v }
    if let v = c("text") { text = v }
    if let v = c("sub") { sub = v }
    if let v = c("ter") { ter = v }
    if let v = c("ink") { ink = v }
    if let v = c("pill") { pill = v }
    if let v = c("iconBg") { iconBg = v }
    if let v = c("danger") { danger = v }
    if let v = c("chevron") { chevron = v }
  }
}

/// Medidas e fontes (uma fonte só da verdade p/ altura e desenho).
enum CMMetrics {
  static let cardContent: CGFloat = 76        // 14 + 48 + 14
  static let avatar: CGFloat = 48
  static let groupBox: CGFloat = 53           // 10 + 17 + 1 + 15 + 10
  static let groupGap: CGFloat = 4
  static let rowPad: CGFloat = 14
  static let actionsTop: CGFloat = 12
  static let pillH: CGFloat = 34
  static let loadingH: CGFloat = 44

  static let cardTitle = UIFont.systemFont(ofSize: 16, weight: .semibold)
  static let cardSub = UIFont.systemFont(ofSize: 13, weight: .regular)
  static let groupTitle = UIFont.systemFont(ofSize: 14, weight: .medium)
  static let groupSub = UIFont.systemFont(ofSize: 12, weight: .regular)
  static let rowTitle = UIFont.systemFont(ofSize: 15, weight: .semibold)
  static let rowSub = UIFont.systemFont(ofSize: 13, weight: .regular)
  static let tag = UIFont.systemFont(ofSize: 11, weight: .bold)
  static let pill = UIFont.systemFont(ofSize: 13, weight: .semibold)
  static let initial = UIFont.systemFont(ofSize: 20, weight: .bold)

  /// (fonte, entrelinha, recuo de cima, recuo de baixo, centralizado, maiúsculas)
  static func textStyle(_ ts: String) -> (UIFont, CGFloat, CGFloat, CGFloat, Bool, Bool) {
    switch ts {
    case "label": return (UIFont.systemFont(ofSize: 12, weight: .semibold), 16, 10, 8, false, true)
    case "title": return (UIFont.systemFont(ofSize: 12, weight: .bold), 16, 0, 6, false, true)
    case "desc": return (UIFont.systemFont(ofSize: 13, weight: .regular), 18, 10, 0, false, false)
    case "empty": return (UIFont.systemFont(ofSize: 13, weight: .regular), 18, 12, 12, false, false)
    case "hint": return (UIFont.italicSystemFont(ofSize: 12), 16, 8, 8, true, false)
    default: return (UIFont.systemFont(ofSize: 14, weight: .regular), 20, 0, 2, false, false)
    }
  }

  static func attributed(_ s: String, ts: String, color: UIColor) -> NSAttributedString {
    let (font, lh, _, _, center, upper) = textStyle(ts)
    let ps = NSMutableParagraphStyle()
    ps.minimumLineHeight = lh
    ps.maximumLineHeight = lh
    ps.alignment = center ? .center : .natural
    ps.lineBreakMode = .byWordWrapping
    var attrs: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: ps, .foregroundColor: color]
    if upper { attrs[.kern] = 0.5 }
    return NSAttributedString(string: upper ? s.uppercased() : s, attributes: attrs)
  }

  static func textHeight(_ s: String, ts: String, width: CGFloat) -> CGFloat {
    if s.isEmpty || width <= 1 { return 0 }
    let a = attributed(s, ts: ts, color: .black)
    let r = a.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
                           options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    return ceil(r.height)
  }

  static func lineHeight(_ f: UIFont) -> CGFloat { ceil(f.lineHeight) }

  static func boundedHeight(_ s: String, font: UIFont, width: CGFloat, lines: Int) -> CGFloat {
    if s.isEmpty || width <= 1 { return 0 }
    let r = (s as NSString).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
                                         options: [.usesLineFragmentOrigin, .usesFontLeading],
                                         attributes: [.font: font], context: nil)
    return min(ceil(r.height), ceil(font.lineHeight) * CGFloat(lines))
  }

  static func tagWidth(_ s: String) -> CGFloat {
    if s.isEmpty { return 0 }
    let w = (s as NSString).size(withAttributes: [.font: tag]).width
    return ceil(w) + 16
  }

  /// Altura TOTAL da célula (margens + conteúdo + respiro).
  static func height(_ r: CMRow, width: CGFloat) -> CGFloat {
    let cardW = max(0, width - r.hx * 2)
    var content: CGFloat = 0
    switch r.kind {
    case "card":
      content = cardContent
    case "group":
      content = groupBox + groupGap
    case "loading":
      content = loadingH
    case "actions":
      content = actionsTop + pillH
    case "text":
      let (_, _, top, bottom, _, _) = textStyle(r.ts)
      let tw = max(0, cardW - r.px * 2)
      content = top + textHeight(r.body.isEmpty ? r.title : r.body, ts: r.ts, width: tw) + bottom
    default: // row
      let tw = rowTextWidth(r, cardW: cardW)
      var h = rowPad + lineHeight(rowTitle)
      if !r.sub.isEmpty { h += 2 + boundedHeight(r.sub, font: rowSub, width: tw, lines: 2) }
      content = h + rowPad
    }
    return ceil(r.topGap + content + r.pb + r.bottomGap)
  }

  static func rowTextWidth(_ r: CMRow, cardW: CGFloat) -> CGFloat {
    var w = cardW - rowPad * 2
    if !r.rtag.isEmpty { w -= tagWidth(r.rtag) + 8 }
    return max(0, w)
  }
}
