import UIKit

// [2026-10-15 native-contacts] Modelos da lista de CONTATOS nativa (Contatos e
// Nova conversa). Mesmo contrato do Android (CTModels.kt). As linhas vêm
// PLANAS do JS (components/contacts/contactListAdapter.js): cabeçalhos de seção
// (k = "s") e contatos (k = "r") numa sequência só; o índice A–Z sai das seções
// com `ix`.

enum CTColor {
  /// processColor() do RN → número ARGB (0xAARRGGBB); nil quando ausente.
  static func of(_ v: Any?) -> UIColor? {
    guard let n = v as? NSNumber else { return nil }
    let d = n.doubleValue
    if !d.isFinite { return nil }
    let u = UInt32(truncatingIfNeeded: Int64(d))
    let a = CGFloat((u >> 24) & 0xFF) / 255
    return UIColor(clHex: u & 0xFFFFFF, alpha: a)
  }

  static func weight(_ w: Int) -> UIFont.Weight {
    switch w {
    case ..<350: return .regular
    case ..<450: return .regular
    case ..<550: return .medium
    case ..<650: return .semibold
    case ..<750: return .bold
    default: return .heavy
    }
  }

  /// Compõe `top` (translúcida) sobre `bottom` (o realce de toque).
  static func blend(_ top: UIColor, over bottom: UIColor) -> UIColor {
    var tr: CGFloat = 0, tg: CGFloat = 0, tb: CGFloat = 0, ta: CGFloat = 0
    var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
    guard top.getRed(&tr, green: &tg, blue: &tb, alpha: &ta),
          bottom.getRed(&br, green: &bg, blue: &bb, alpha: &ba) else { return bottom }
    return UIColor(red: tr * ta + br * (1 - ta), green: tg * ta + bg * (1 - ta),
                   blue: tb * ta + bb * (1 - ta), alpha: max(ba, ta))
  }
}

struct CTRow {
  var id: String = ""
  var kind: String = "r"
  // Seção
  var title: String = ""
  var sBg: UIColor?
  var sFg: UIColor?
  var sBar = false
  var sUpper = false
  var sSize: CGFloat = 13
  var sWeight: Int = 600
  var sPadTop: CGFloat = 8
  var sPadBottom: CGFloat = 8
  var sPadH: CGFloat = 16
  var sHair = false
  var sSpacing: CGFloat = 0
  var ix: String = ""
  // Contato
  var titleWeight: Int = 600
  var suffix: String = ""
  var verified = false
  var newBadge: String = ""
  var sub: String = ""
  var subTone: Int = 0
  var username: String = ""
  var sub2: String = ""
  var sub2Tone: Int = 0
  var sub2Italic = false
  var chip: String = ""
  var meta: String = ""
  var tilesRaw: [Any] = []
  var online = false
  var avatar: CGFloat = 40
  var avatarRing = false
  var glyph: String = ""
  var glyphBg: UIColor?
  var pill: String = ""
  var pillFilled = false
  var pillIcon = false
  var pillBusy = false
  var star: Int = 0
  var trash = false
  var check: Int = 0
  var swipe: String = ""
  var tap = true
  var longPress = false
  var a11y: String = ""

  init() {}

  init(_ d: [String: Any]) {
    func f(_ k: String, _ def: CGFloat) -> CGFloat { d[k] == nil ? def : CGFloat(CLVal.double(d[k])) }
    func i(_ k: String, _ def: Int) -> Int { d[k] == nil ? def : CLVal.int(d[k]) }
    id = CLVal.str(d["id"])
    kind = CLVal.str(d["k"])
    if kind.isEmpty { kind = "r" }
    title = CLVal.str(d["t"])
    sBg = CTColor.of(d["sbg"])
    sFg = CTColor.of(d["sfg"])
    sBar = CLVal.bool(d["bar"])
    sUpper = CLVal.bool(d["up"])
    sSize = f("fs", 13)
    sWeight = i("fw", 600)
    sPadTop = f("pt", 8)
    sPadBottom = f("pb", 8)
    sPadH = f("ph", 16)
    sHair = CLVal.bool(d["hl"])
    sSpacing = f("ls", 0)
    ix = CLVal.str(d["ix"])
    titleWeight = i("tw", 600)
    suffix = CLVal.str(d["sx"])
    verified = CLVal.bool(d["vb"])
    newBadge = CLVal.str(d["nb"])
    sub = CLVal.str(d["sb"])
    subTone = i("sbt", 0)
    username = CLVal.str(d["un"])
    sub2 = CLVal.str(d["s2"])
    sub2Tone = i("s2t", 0)
    sub2Italic = CLVal.bool(d["s2i"])
    chip = CLVal.str(d["ch"])
    meta = CLVal.str(d["me"])
    tilesRaw = (d["tiles"] as? [Any]) ?? []
    online = CLVal.bool(d["on"])
    avatar = f("av", 40)
    avatarRing = CLVal.bool(d["ar"])
    glyph = CLVal.str(d["gl"])
    glyphBg = CTColor.of(d["gbg"])
    pill = CLVal.str(d["pl"])
    pillFilled = CLVal.bool(d["pf"])
    pillIcon = CLVal.bool(d["pi"])
    pillBusy = CLVal.bool(d["pb"])
    star = i("st", 0)
    trash = CLVal.bool(d["tr"])
    check = i("ck", 0)
    swipe = CLVal.str(d["sw"])
    tap = d["tap"] == nil ? true : CLVal.bool(d["tap"])
    longPress = CLVal.bool(d["lp"])
    a11y = CLVal.str(d["a11y"])
  }

  var isSection: Bool { kind == "s" }

  /// CLRow só com o que o CLAvatarView desenha (foto/iniciais + online).
  func avatarRow() -> CLRow {
    return CLRow(["id": id, "kind": "direct", "title": title, "tiles": tilesRaw, "online": online])
  }
}

/// Cores da tela (colors do ThemeContext, ARGB via processColor).
struct CTColors {
  let dark: Bool
  let bg: UIColor
  let text: UIColor
  let sub: UIColor
  let faint: UIColor
  let hair: UIColor
  let primary: UIColor
  let onPrimary: UIColor
  let warning: UIColor
  let error: UIColor
  let press: UIColor
  let chipBg: UIColor
  let chipText: UIColor
  let indexText: UIColor
  let border: UIColor
  let theme: CLTheme

  init(_ d: [String: Any]? = nil) {
    let m = d ?? [:]
    dark = CLVal.bool(m["dark"])
    bg = CTColor.of(m["bg"]) ?? (dark ? .black : .white)
    text = CTColor.of(m["text"]) ?? (dark ? .white : UIColor(clHex: 0x111111))
    sub = CTColor.of(m["sub"]) ?? UIColor(clHex: 0x737373)
    faint = CTColor.of(m["faint"]) ?? UIColor(clHex: 0xA3A3A3)
    hair = CTColor.of(m["hair"]) ?? (dark ? UIColor(white: 1, alpha: 0.09) : UIColor(white: 0, alpha: 0.08))
    primary = CTColor.of(m["primary"]) ?? (dark ? .white : UIColor(clHex: 0x111111))
    onPrimary = CTColor.of(m["onPrimary"]) ?? (dark ? .black : .white)
    warning = CTColor.of(m["warning"]) ?? UIColor(clHex: 0xF59E0B)
    error = CTColor.of(m["error"]) ?? UIColor(clHex: 0xFF3B30)
    press = CTColor.of(m["press"]) ?? (dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.06))
    chipBg = CTColor.of(m["chipBg"]) ?? (dark ? UIColor(clHex: 0x2C2C2E) : UIColor(clHex: 0xF2F2F7))
    chipText = CTColor.of(m["chipText"]) ?? text
    indexText = CTColor.of(m["indexText"]) ?? primary
    border = CTColor.of(m["border"]) ?? (dark ? UIColor(white: 1, alpha: 0.3) : UIColor(white: 0, alpha: 0.25))
    theme = CLTheme(dark: dark)
  }
}

/// Medidas da linha (pt) — espelham os StyleSheets de cada tela.
struct CTMetrics {
  var padH: CGFloat = 16
  var padV: CGFloat = 14
  var gap: CGFloat = 14
  var minH: CGFloat = 0
  var nameSize: CGFloat = 16
  var subSize: CGFloat = 13
  var sub2Size: CGFloat = 12
  var metaSize: CGFloat = 10

  init(_ d: [String: Any]? = nil) {
    let m = d ?? [:]
    func f(_ k: String, _ def: CGFloat) -> CGFloat { m[k] == nil ? def : CGFloat(CLVal.double(m[k])) }
    padH = f("padH", 16)
    padV = f("padV", 14)
    gap = f("gap", 14)
    minH = f("minH", 0)
    nameSize = f("nameSize", 16)
    subSize = f("subSize", 13)
    sub2Size = f("sub2Size", 12)
    metaSize = f("metaSize", 10)
  }
}
