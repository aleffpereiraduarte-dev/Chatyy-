import UIKit

// [2026-10-15 native-lists] Aba STATUS em nativo — modelos.
// JS: components/status/NativeStatusList.js (buildStatusRows).

/// Linha plana vinda do JS: cabeçalho de seção (kind "section") ou status de
/// um contato (kind "row").
struct SLRow {
  var id: String = ""
  var kind: String = "row"
  var section: String = ""
  var email: String = ""
  var title: String = ""
  var time: String = ""
  var count: Int = 0
  var ring: String = ""        // um char por item: "1" visto, "0" novo
  var muted: Bool = false
  var mine: Bool = false
  var notify: Bool = false
  var closeFriends: Bool = false
  var a11y: String = ""
  // avatar (mesmo formato do CLTile)
  var tileURL: String = ""
  var tileAuth: Bool = false
  var tileInitials: String = ""
  var tileGrad: Int = 0
  // miniatura do status de texto
  var thumbText: String = ""
  var thumbBg: String = ""
  var thumbFont: String = ""
  // prévia do toque longo (foto / pôster do vídeo)
  var peekURL: String = ""
  // seção
  var collapsible: Bool = false
  var expanded: Bool = false
  // [2026-10-18 status-telegram] "ld": anel girando (toque esperando o conteúdo)
  var loading: Bool = false

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    kind = CLVal.str(d["kind"])
    if kind.isEmpty { kind = "row" }
    section = CLVal.str(d["section"])
    email = CLVal.str(d["email"])
    title = CLVal.str(d["title"])
    time = CLVal.str(d["time"])
    count = CLVal.int(d["count"])
    ring = CLVal.str(d["ring"])
    muted = CLVal.bool(d["muted"])
    mine = CLVal.bool(d["mine"])
    notify = CLVal.bool(d["notify"])
    closeFriends = CLVal.bool(d["cf"])
    a11y = CLVal.str(d["a11y"])
    tileURL = CLVal.str(d["tu"])
    tileAuth = CLVal.bool(d["ta"])
    tileInitials = CLVal.str(d["ti"])
    tileGrad = CLVal.int(d["tg"])
    thumbText = CLVal.str(d["tt"])
    thumbBg = CLVal.str(d["tbg"])
    thumbFont = CLVal.str(d["tf"])
    peekURL = CLVal.str(d["peek"])
    collapsible = CLVal.bool(d["collapsible"])
    expanded = CLVal.bool(d["expanded"])
    loading = CLVal.bool(d["ld"])
  }

  var isSection: Bool { kind == "section" }

  var tile: CLTile {
    var d: [String: Any] = ["u": tileURL, "i": tileInitials, "g": tileGrad]
    if tileAuth { d["a"] = 1 }
    return CLTile(d)
  }
}

/// Cores da aba (mesmas do ChatStatusTab: fundo agrupado #f2f2f7 / cartão
/// branco no claro; fundo do tema / #1c1c1e no escuro). O JS manda `palette`
/// com as cores reais do tema; isto é o fallback.
struct SLPalette {
  let dark: Bool
  var bg: UIColor
  var card: UIColor
  var text: UIColor
  var sub: UIColor
  var pillBg: UIColor
  var press: UIColor
  var ink: UIColor
  var ringViewed: UIColor
  var closeFriends: UIColor
  /// [2026-10-21 pitada-azul, apiVersion 2] anel NÃO visto em gradiente (palette
  /// `ringNew` → `ringNew2`, "#RRGGBB"). nil = tinta P&B de antes.
  var ringNew: UIColor? = nil
  var ringNew2: UIColor? = nil

  init(dark: Bool, dict: [String: Any]? = nil) {
    self.dark = dark
    if dark {
      bg = UIColor(clHex: 0x000000)
      card = UIColor(clHex: 0x1C1C1E)
      text = UIColor(clHex: 0xF5F5F7)
      sub = UIColor(clHex: 0x8E8E93)
      pillBg = UIColor(clHex: 0x2C2C2E)
      press = UIColor(white: 1, alpha: 0.08)
      ink = UIColor(clHex: 0xF5F5F7)
    } else {
      bg = UIColor(clHex: 0xF2F2F7)
      card = UIColor.white
      text = UIColor(clHex: 0x111111)
      sub = UIColor(clHex: 0x737373)
      pillBg = UIColor(clHex: 0xF0F0F0)
      press = UIColor(white: 0, alpha: 0.05)
      ink = UIColor(clHex: 0x111111)
    }
    ringViewed = UIColor(red: 150 / 255, green: 150 / 255, blue: 150 / 255, alpha: 0.35)
    closeFriends = UIColor(clHex: 0x10B981)
    if let d = dict {
      if let c = SLColor.parse(CLVal.str(d["bg"])) { bg = c }
      if let c = SLColor.parse(CLVal.str(d["card"])) { card = c }
      if let c = SLColor.parse(CLVal.str(d["text"])) { text = c }
      if let c = SLColor.parse(CLVal.str(d["sub"])) { sub = c }
      if let c = SLColor.parse(CLVal.str(d["pill"])) { pillBg = c }
      ringNew = SLColor.parse(CLVal.str(d["ringNew"]))
      ringNew2 = SLColor.parse(CLVal.str(d["ringNew2"]))
    }
  }
}

enum SLColor {
  /// "#RGB", "#RRGGBB" ou "#RRGGBBAA" → UIColor (nil se não for hex).
  static func parse(_ s: String) -> UIColor? {
    var h = s.trimmingCharacters(in: .whitespaces)
    guard h.hasPrefix("#") else { return nil }
    h.removeFirst()
    if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
    guard h.count == 6 || h.count == 8, let v = UInt64(h, radix: 16) else { return nil }
    if h.count == 6 {
      return UIColor(clHex: UInt32(v & 0xFFFFFF))
    }
    let rgb = UInt32((v >> 8) & 0xFFFFFF)
    let a = CGFloat(v & 0xFF) / 255
    return UIColor(clHex: rgb, alpha: a)
  }

  /// Fonte da miniatura de texto (mesmo mapa do textStatusFontStyle no iOS).
  static func thumbFont(_ id: String, size: CGFloat) -> UIFont {
    let name: String?
    switch id {
    case "serif": name = "Georgia-Bold"
    case "mono": name = "Menlo-Bold"
    case "script": name = "Noteworthy-Bold"
    default: name = nil
    }
    if let n = name, let f = UIFont(name: n, size: size) { return f }
    return UIFont.systemFont(ofSize: size, weight: .bold)
  }
}
