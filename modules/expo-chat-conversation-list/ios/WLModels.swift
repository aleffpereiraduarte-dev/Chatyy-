import UIKit

// [2026-10-15 native-wallet] Modelos da CARTEIRA nativa (ChatyyWalletList):
// app/wallet.js e app/creator-earnings.js via components/native/NativeWalletList.js.
// Mesmo contrato do Android (WLModels.kt). Linhas PLANAS vindas do JS:
//   dia        → { id, k: 'd', t }
//   transação  → { id, k: 'x', sid, gl, t, sb, am, cr, dm, a2, ag, tiles?, a11y }
//                (linhas 'x' seguidas com o mesmo `sid` = um cartão)
//   vazio      → { id, k: 'e', gl, t, sb, b?, ba? }   (b = botão → onRowAction ba)
//   carregando → { id, k: 'l' }
//   nota       → { id, k: 'n', t, cr? }               (centralizado; cr = 13 pt secundário)
// Herói (prop `hero`): ver WLHero.

struct WLRow {
  var id: String = ""
  var kind: String = "x"
  var sid: String = ""
  var glyph: String = ""
  var title: String = ""
  var sub: String = ""
  var amount: String = ""
  var credit = false
  var diamond = false
  var amount2: String = ""
  var amountGlyph: String = ""
  var tilesRaw: [Any] = []
  var button: String = ""
  var buttonAction: String = ""
  var a11y: String = ""
  var tap = true

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    let k = CLVal.str(d["k"])
    kind = k.isEmpty ? "x" : k
    sid = CLVal.str(d["sid"])
    glyph = CLVal.str(d["gl"])
    title = CLVal.str(d["t"])
    sub = CLVal.str(d["sb"])
    amount = CLVal.str(d["am"])
    credit = CLVal.bool(d["cr"])
    diamond = CLVal.bool(d["dm"])
    amount2 = CLVal.str(d["a2"])
    amountGlyph = CLVal.str(d["ag"])
    tilesRaw = (d["tiles"] as? [Any]) ?? []
    button = CLVal.str(d["b"])
    buttonAction = CLVal.str(d["ba"])
    a11y = CLVal.str(d["a11y"])
    tap = d["tap"] == nil ? true : CLVal.bool(d["tap"])
  }

  var hasTiles: Bool { !tilesRaw.isEmpty }

  func avatarRow() -> CLRow {
    return CLRow(["id": id, "kind": "direct", "title": title, "tiles": tilesRaw])
  }
}

struct WLHeroStat {
  var label = ""
  var value = ""
  var sub = ""
}

struct WLHeroButton {
  var id = ""
  var label = ""
  var primary = false
  var disabled = false
  var a11y = ""
}

/// Cartão-herói grafite (igual nos 2 temas): saldo com contagem animada.
struct WLHero {
  var caps = ""
  var brand = ""
  var value: Double? = nil
  var format = "int"          // "int" (diamantes) | "brl" (centavos → R$)
  var text = ""               // texto final exato (formatado no JS)
  var locale = ""
  var diamond = false
  var danger = false
  var numSize: CGFloat = 46
  var sub = ""
  var note = ""
  var stats: [WLHeroStat] = []
  var progress: Double = -1
  var progressText = ""
  var notice = ""
  var buttons: [WLHeroButton] = []
  var foot = ""
  var glow = true
  var a11y = ""

  init() {}

  init(_ d: [String: Any]) {
    caps = CLVal.str(d["caps"])
    brand = CLVal.str(d["brand"])
    if let n = d["value"] as? NSNumber, n.doubleValue.isFinite { value = n.doubleValue }
    let f = CLVal.str(d["fmt"])
    format = f.isEmpty ? "int" : f
    text = CLVal.str(d["text"])
    locale = CLVal.str(d["loc"])
    diamond = CLVal.bool(d["dia"])
    danger = CLVal.bool(d["danger"])
    if d["numSize"] != nil { numSize = CGFloat(max(20, min(64, CLVal.double(d["numSize"])))) }
    sub = CLVal.str(d["sub"])
    note = CLVal.str(d["note"])
    for s in (d["stats"] as? [Any]) ?? [] {
      guard let m = s as? [String: Any] else { continue }
      stats.append(WLHeroStat(label: CLVal.str(m["l"]), value: CLVal.str(m["v"]), sub: CLVal.str(m["s"])))
    }
    progress = d["prog"] == nil ? -1 : CLVal.double(d["prog"])
    progressText = CLVal.str(d["progText"])
    notice = CLVal.str(d["notice"])
    for b in (d["buttons"] as? [Any]) ?? [] {
      guard let m = b as? [String: Any] else { continue }
      let id = CLVal.str(m["id"])
      if id.isEmpty { continue }
      buttons.append(WLHeroButton(id: id, label: CLVal.str(m["label"]), primary: CLVal.bool(m["primary"]),
                                  disabled: CLVal.bool(m["disabled"]), a11y: CLVal.str(m["a11y"])))
    }
    foot = CLVal.str(d["foot"])
    glow = d["glow"] == nil ? true : CLVal.bool(d["glow"])
    a11y = CLVal.str(d["a11y"])
  }
}

/// Paleta da tela (useSurface → processColor ARGB). Padrões = surfaceColors.
struct WLPalette {
  var dark: Bool
  var pageBg: UIColor
  var cardBg: UIColor
  var separator: UIColor
  var text: UIColor
  var secondary: UIColor
  var tertiary: UIColor
  var fill: UIColor
  var success: UIColor
  var danger: UIColor
  var ink: UIColor
  var onInk: UIColor
  var press: UIColor

  init(dark: Bool, colors d: [String: Any]? = nil) {
    self.dark = dark
    pageBg = dark ? .black : UIColor(clHex: 0xF2F2F7)
    cardBg = dark ? UIColor(clHex: 0x1C1C1E) : .white
    separator = dark ? UIColor(white: 1, alpha: 0.1) : UIColor(white: 0, alpha: 0.08)
    text = dark ? UIColor(clHex: 0xF5F5F7) : UIColor(clHex: 0x111111)
    secondary = UIColor(clHex: 0x8E8E93)
    tertiary = dark ? UIColor(clHex: 0x636366) : UIColor(clHex: 0xC4C4C7)
    fill = dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.05)
    success = UIColor(clHex: 0x16A34A)
    danger = UIColor(clHex: 0xDC2626)
    ink = dark ? .white : UIColor(clHex: 0x111111)
    onInk = dark ? .black : .white
    press = dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.05)
    guard let d = d else { return }
    if let c = CTColor.of(d["pageBg"]) { pageBg = c }
    if let c = CTColor.of(d["cardBg"]) { cardBg = c }
    if let c = CTColor.of(d["separator"]) { separator = c }
    if let c = CTColor.of(d["text"]) { text = c }
    if let c = CTColor.of(d["secondary"]) { secondary = c }
    if let c = CTColor.of(d["tertiary"]) { tertiary = c }
    if let c = CTColor.of(d["fill"]) { fill = c }
    if let c = CTColor.of(d["success"]) { success = c }
    if let c = CTColor.of(d["danger"]) { danger = c }
    if let c = CTColor.of(d["ink"]) { ink = c }
    if let c = CTColor.of(d["onInk"]) { onInk = c }
    if let c = CTColor.of(d["press"]) { press = c }
  }
}

/// Glifos das transações (nome lógico do JS, WalletKit.txCategory) → SF Symbols.
enum WLGlyphs {
  static func symbol(_ name: String) -> String {
    switch name {
    case "purchase": return "bag"
    case "gift": return "gift"
    case "cashout": return "building.columns"
    case "convert": return "arrow.left.arrow.right"
    case "refund": return "arrow.uturn.backward"
    case "promo": return "sparkles"
    case "receipt": return "doc.plaintext"
    case "user": return "person"
    default: return "arrow.up.right"
    }
  }

  static func image(_ name: String, size: CGFloat, color: UIColor, weight: UIImage.SymbolWeight = .regular) -> UIImage? {
    return CLSymbols.image(symbol(name), pointSize: size, weight: weight, color: color)
  }
}

/// Formatação do número durante a contagem (o texto final vem pronto do JS).
enum WLNumber {
  private static var cache: [String: NumberFormatter] = [:]

  private static func formatter(_ format: String, _ locale: String) -> NumberFormatter {
    let key = format + "|" + locale
    if let f = cache[key] { return f }
    let f = NumberFormatter()
    if format == "brl" {
      f.locale = Locale(identifier: "pt_BR")
      f.numberStyle = .currency
      f.currencyCode = "BRL"
      f.minimumFractionDigits = 2
      f.maximumFractionDigits = 2
    } else {
      f.locale = locale.isEmpty ? Locale.current : Locale(identifier: locale.replacingOccurrences(of: "-", with: "_"))
      f.numberStyle = .decimal
      f.maximumFractionDigits = 0
    }
    cache[key] = f
    return f
  }

  static func format(_ v: Double, format: String, locale: String) -> String {
    let f = formatter(format, locale)
    let n: Double = format == "brl" ? (v / 100.0) : v.rounded()
    return f.string(from: NSNumber(value: n)) ?? String(Int64(n))
  }
}

/// Cores fixas do herói (WalletKit.HERO).
enum WLHeroColors {
  static let text = UIColor.white
  static let sub = UIColor(white: 1, alpha: 0.62)
  static let faint = UIColor(white: 1, alpha: 0.38)
  static let line = UIColor(white: 1, alpha: 0.12)
  static let outline = UIColor(white: 1, alpha: 0.30)
  static let fill = UIColor(white: 1, alpha: 0.10)
  static let danger = UIColor(clHex: 0xFF6B63)
}
