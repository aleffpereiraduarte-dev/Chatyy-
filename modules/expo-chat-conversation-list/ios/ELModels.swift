import UIKit

// [2026-10-15 native-inbox] Modelos da caixa de entrada NATIVA do e-mail.
// O JS (components/email/emailNativeAdapter.js) manda linhas já prontas
// (hora formatada, prévia limpa, rótulos com cor resolvida, textos traduzidos).
// Reaproveita CLVal / CLTile / CLRow (avatar) / CLLabels do módulo.

extension UIColor {
  /// Cor vinda do JS como número 0xAARRGGBB (já normalizada no adaptador).
  convenience init(elArgb v: UInt32) {
    self.init(
      red: CGFloat((v >> 16) & 0xFF) / 255.0,
      green: CGFloat((v >> 8) & 0xFF) / 255.0,
      blue: CGFloat(v & 0xFF) / 255.0,
      alpha: CGFloat((v >> 24) & 0xFF) / 255.0
    )
  }
}

enum ELColor {
  /// Lê um número ARGB do dicionário; nil quando ausente/ inválido.
  static func parse(_ v: Any?) -> UIColor? {
    guard let n = v as? NSNumber else { return nil }
    let d = n.doubleValue
    if !d.isFinite || d < 0 || d > 4294967295.0 { return nil }
    return UIColor(elArgb: UInt32(d))
  }
}

/// Chip de rótulo (nome + cores já resolvidas pelo LABEL_COLORS do JS).
struct ELChip {
  var name: String = ""
  var bg: UIColor = .clear
  var fg: UIColor = .gray
  var bd: UIColor = .clear

  init(_ d: [String: Any]) {
    name = CLVal.str(d["n"])
    bg = ELColor.parse(d["bg"]) ?? UIColor(white: 0.5, alpha: 0.12)
    fg = ELColor.parse(d["fg"]) ?? .gray
    bd = ELColor.parse(d["bd"]) ?? .clear
  }
}

struct ELRow {
  var id: String = ""
  var kind: String = "email"     // email | section
  var title: String = ""         // título da seção (Hoje, Ontem…)
  var from: String = ""
  var fromEmail: String = ""
  var subject: String = ""
  var preview: String = ""
  var time: String = ""
  var dateFull: String = ""
  var unread: Bool = false
  var starred: Bool = false
  var attach: Bool = false
  var muted: Bool = false
  var thread: Int = 0
  var chips: [ELChip] = []
  var checked: Bool = false
  var active: Bool = false
  var snoozed: String = ""       // rótulo "Adiado" (vazio = não mostra)
  var nudge: String = ""         // "Responder? N dias" (vazio = não mostra)
  var a11y: String = ""
  var avatar = CLRow()

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    kind = CLVal.str(d["kind"])
    if kind.isEmpty { kind = "email" }
    title = CLVal.str(d["title"])
    from = CLVal.str(d["from"])
    fromEmail = CLVal.str(d["fromEmail"])
    subject = CLVal.str(d["subject"])
    preview = CLVal.str(d["preview"])
    time = CLVal.str(d["time"])
    dateFull = CLVal.str(d["dateFull"])
    unread = CLVal.bool(d["unread"])
    starred = CLVal.bool(d["starred"])
    attach = CLVal.bool(d["attach"])
    muted = CLVal.bool(d["muted"])
    thread = CLVal.int(d["thread"])
    if let arr = d["chips"] as? [Any] {
      chips = arr.compactMap { ($0 as? [String: Any]).map { ELChip($0) } }.filter { !$0.name.isEmpty }
    }
    checked = CLVal.bool(d["checked"])
    active = CLVal.bool(d["active"])
    snoozed = CLVal.str(d["snoozed"])
    nudge = CLVal.str(d["nudge"])
    a11y = CLVal.str(d["a11y"])
    var av: [String: Any] = ["id": id, "kind": "direct", "title": from]
    if let tiles = d["tiles"] as? [Any] { av["tiles"] = tiles }
    avatar = CLRow(av)
  }

  var isSection: Bool { kind == "section" }
}

/// Paleta vinda do ThemeContext (mesmas cores do EmailRow JS).
struct ELPalette {
  var dark: Bool
  var bg: UIColor
  var sectionBg: UIColor
  var text: UIColor
  var sub: UIColor
  var faint: UIColor
  var hair: UIColor
  var selectedBg: UIColor
  var pressBg: UIColor
  var primary: UIColor
  var star: UIColor
  var starEmpty: UIColor
  var variant: UIColor
  var checkOn: UIColor
  var checkOff: UIColor

  init(dark: Bool, _ d: [String: Any]? = nil) {
    self.dark = dark
    let p = d ?? [:]
    func c(_ k: String, _ light: UInt32, _ darkHex: UInt32) -> UIColor {
      return ELColor.parse(p[k]) ?? UIColor(clHex: dark ? darkHex : light)
    }
    bg = c("bg", 0xFFFFFF, 0x0B0B0B)
    sectionBg = c("sectionBg", 0xFFFFFF, 0x000000)
    text = c("text", 0x0B0B0B, 0xF5F5F7)
    sub = c("sub", 0x5F6368, 0xA1A1A6)
    faint = c("faint", 0x8696A0, 0x6C6C70)
    hair = ELColor.parse(p["hair"]) ?? (dark ? UIColor(white: 1, alpha: 0.06) : UIColor(clHex: 0xF4F5F6))
    selectedBg = c("selectedBg", 0xF2F3F5, 0x1C1C1E)
    pressBg = dark ? UIColor(clHex: 0x1A1A1A) : UIColor(clHex: 0xF0F0F0)
    primary = c("primary", 0x111111, 0xF5F5F7)
    star = c("star", 0x111111, 0xF5F5F7)
    starEmpty = c("starEmpty", 0xCBD0D6, 0x4A4D52)
    variant = c("variant", 0xF1F3F4, 0x1C1C1E)
    checkOn = c("checkOn", 0x111111, 0xF5F5F7)
    checkOff = c("checkOff", 0x5F6368, 0xA1A1A6)
  }
}

/// Densidade (DENSITY_CONFIG do ThemeContext + espaçamentos do EmailRow).
struct ELDensity {
  var padV: CGFloat = 10
  var padH: CGFloat = 13
  var minH: CGFloat = 54
  var avatar: CGFloat = 38
  var gap: CGFloat = 10
  var preview: Bool = true

  init() {}

  init(_ d: [String: Any]?) {
    guard let d = d else { return }
    if d["padV"] != nil { padV = CGFloat(CLVal.double(d["padV"])) }
    if d["padH"] != nil { padH = CGFloat(CLVal.double(d["padH"])) }
    if d["minH"] != nil { minH = CGFloat(CLVal.double(d["minH"])) }
    if d["avatar"] != nil { avatar = max(20, CGFloat(CLVal.double(d["avatar"]))) }
    if d["gap"] != nil { gap = CGFloat(CLVal.double(d["gap"])) }
    if d["preview"] != nil { preview = CLVal.bool(d["preview"]) }
  }
}

/// Fontes da linha (escalam com o Dynamic Type, com teto — mesma regra da home).
struct ELFonts {
  let from: UIFont
  let fromBold: UIFont
  let date: UIFont
  let dateBold: UIFont
  let subject: UIFont
  let subjectBold: UIFont
  let preview: UIFont
  let chip: UIFont
  let badge: UIFont
  let small: UIFont
  let section: UIFont

  init(_ tc: UITraitCollection?) {
    from = CLFonts.scaled(16, .medium, cap: 1.3, traits: tc)
    fromBold = CLFonts.scaled(16, .bold, cap: 1.3, traits: tc)
    date = CLFonts.scaled(13, .regular, cap: 1.3, traits: tc, mono: true)
    dateBold = CLFonts.scaled(13, .semibold, cap: 1.3, traits: tc, mono: true)
    subject = CLFonts.scaled(15, .regular, cap: 1.3, traits: tc)
    subjectBold = CLFonts.scaled(15, .semibold, cap: 1.3, traits: tc)
    preview = CLFonts.scaled(14, .regular, cap: 1.3, traits: tc)
    chip = CLFonts.scaled(10, .bold, cap: 1.2, traits: tc)
    badge = CLFonts.scaled(12, .semibold, cap: 1.2, traits: tc, mono: true)
    small = CLFonts.scaled(12, .semibold, cap: 1.2, traits: tc)
    section = CLFonts.scaled(12, .semibold, cap: 1.2, traits: tc)
  }
}
