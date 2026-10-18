import UIKit

// [2026-10-15 settings-native] Modelos da lista NATIVA da raiz das
// Configurações (app/settings.js → components/settings/NativeSettingsList.js).
// Mesmo contrato do Android (STModels.kt). Linhas planas vindas do JS:
//   id, k ("c" categoria · "q" resultado de busca · "a" ação · "t" toggle),
//   sid (seção), hd (cabeçalho da seção), title, sub, icon, kw, dest, center, on.
// [2026-10-18 settings-sub-native] apiVersion 2 (sub-páginas das Configurações):
//   k "i" = linha só informativa (sem toque); val (texto de valor à direita),
//   acc ("" padrão · "c" seta · "n" nada · "k" check · "u" vazio · "s" spinner),
//   dis (desabilitada), tl / sl (linhas do título / subtítulo; 0 = sem limite),
//   ft (rodapé da seção — o 1º não vazio do grupo).

struct STRow {
  var id: String = ""
  var kind: String = "c"
  var sid: String = ""
  var header: String = ""
  var title: String = ""
  var sub: String = ""
  var icon: String = ""
  var keywords: String = ""
  var destructive = false
  var center = false
  var on = false
  var value: String = ""
  var acc: String = ""
  var disabled = false
  var titleLines = 1
  var subLines = 1
  var footer: String = ""
  /// Texto normalizado (minúsculas, sem acento) p/ a busca nativa.
  var hay: String = ""

  /// Acessório efetivo: "t" interruptor · "c" seta · "n" nada · "k" check ·
  /// "u" vazio (radio desmarcado) · "s" spinner. Sem `acc` = regra da api 1
  /// (seta, exceto centrada/destrutiva).
  var accessory: String {
    if kind == "t" { return "t" }
    if !acc.isEmpty { return acc }
    return (center || destructive) ? "n" : "c"
  }

  /// Toque abre/aciona (toggle alterna pelo próprio UISwitch).
  var pressable: Bool { return kind != "t" && kind != "i" && !disabled }

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    let k = CLVal.str(d["k"])
    kind = k.isEmpty ? "c" : k
    sid = CLVal.str(d["sid"])
    header = CLVal.str(d["hd"])
    title = CLVal.str(d["title"])
    sub = CLVal.str(d["sub"])
    icon = CLVal.str(d["icon"])
    keywords = CLVal.str(d["kw"])
    destructive = CLVal.bool(d["dest"])
    center = CLVal.bool(d["center"])
    on = CLVal.bool(d["on"])
    value = CLVal.str(d["val"])
    acc = CLVal.str(d["acc"])
    disabled = CLVal.bool(d["dis"])
    if d["tl"] != nil { titleLines = max(0, CLVal.int(d["tl"])) }
    if d["sl"] != nil { subLines = max(0, CLVal.int(d["sl"])) }
    footer = CLVal.str(d["ft"])
    hay = STText.normalize("\(title) \(sub) \(keywords)")
  }
}

enum STText {
  static func normalize(_ s: String) -> String {
    return s.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
      .lowercased()
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Ícone da categoria (nome lógico do JS) → SF Symbol.
  static func symbol(_ name: String) -> String? {
    switch name {
    case "user": return "person"
    case "shield": return "lock.shield"
    case "message": return "message"
    case "bell": return "bell"
    case "database": return "internaldrive"
    case "type": return "textformat.size"
    case "globe": return "globe"
    case "mail": return "envelope"
    case "sparkles": return "sparkles"
    case "help": return "questionmark.circle"
    case "userPlus": return "person.badge.plus"
    case "search": return "magnifyingglass"
    // [2026-10-18 settings-sub-native] atalhos da raiz + ícones das sub-páginas.
    case "wallet": return "creditcard"
    case "plus": return "plus"
    default: return CIText.symbol(name)
    }
  }
}

/// Paleta resolvida no JS (useGroupedColors → processColor ARGB). Os padrões
/// espelham SettingsKit p/ o 1º frame antes da prop chegar.
struct STPalette {
  var dark: Bool
  var pageBg: UIColor
  var cardBg: UIColor
  var separator: UIColor
  var header: UIColor
  var text: UIColor
  var secondary: UIColor
  var tertiary: UIColor
  var chipBg: UIColor
  var chipFg: UIColor
  var destructive: UIColor
  var press: UIColor

  init(dark: Bool) {
    self.dark = dark
    if dark {
      pageBg = UIColor.black
      cardBg = UIColor(clHex: 0x141416)
      separator = UIColor(white: 1, alpha: 0.07)
      header = UIColor(clHex: 0x7C7C82)
      text = UIColor(clHex: 0xF5F5F7)
      secondary = UIColor(clHex: 0x8E8E93)
      tertiary = UIColor(clHex: 0x636366)
      chipBg = UIColor(white: 1, alpha: 0.075)
      chipFg = UIColor(clHex: 0xEDEDF0)
      destructive = UIColor(clHex: 0xDC2626)
      press = UIColor(clHex: 0x26292C)
    } else {
      pageBg = UIColor(clHex: 0xF3F3F6)
      cardBg = UIColor.white
      separator = UIColor(red: 60 / 255, green: 60 / 255, blue: 67 / 255, alpha: 0.11)
      header = UIColor(clHex: 0x77777D)
      text = UIColor(clHex: 0x111111)
      secondary = UIColor(clHex: 0x8A8A8E)
      tertiary = UIColor(clHex: 0xC4C4C7)
      chipBg = UIColor(red: 17 / 255, green: 17 / 255, blue: 17 / 255, alpha: 0.055)
      chipFg = UIColor(clHex: 0x1A1A1C)
      destructive = UIColor(clHex: 0xDC2626)
      press = UIColor(clHex: 0xEBEBED)
    }
  }

  init(dark: Bool, colors d: [String: Any]?) {
    self.init(dark: dark)
    guard let d = d else { return }
    if let c = CTColor.of(d["pageBg"]) { pageBg = c }
    if let c = CTColor.of(d["cardBg"]) { cardBg = c }
    if let c = CTColor.of(d["separator"]) { separator = c }
    if let c = CTColor.of(d["header"]) { header = c }
    if let c = CTColor.of(d["text"]) { text = c }
    if let c = CTColor.of(d["secondary"]) { secondary = c }
    if let c = CTColor.of(d["tertiary"]) { tertiary = c }
    if let c = CTColor.of(d["chipBg"]) { chipBg = c }
    if let c = CTColor.of(d["chipFg"]) { chipFg = c }
    if let c = CTColor.of(d["destructive"]) { destructive = c }
    if let c = CTColor.of(d["press"]) { press = c }
  }

  // Interruptor igual ao NativeSwitch do JS (P&B).
  var switchOn: UIColor { return dark ? UIColor(clHex: 0xF5F5F7) : UIColor(clHex: 0x111111) }
  var switchOff: UIColor { return dark ? UIColor(clHex: 0x636366) : UIColor(clHex: 0xE9E9EA) }
  var switchThumb: UIColor { return dark ? UIColor(clHex: 0x0B0B0B) : UIColor.white }
}
