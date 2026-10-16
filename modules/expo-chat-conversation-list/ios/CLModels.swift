import UIKit

// [2026-10-14 native-home] Modelos da lista de conversas nativa.
// O JS (components/chatlist/nativeAdapter.js) manda as linhas JÁ normalizadas
// (textos traduzidos, prévia pronta, hora formatada) — o nativo só desenha.
// Chaves curtas e planas: o patch atravessa a ponte a cada mudança.

enum CLVal {
  static func str(_ v: Any?) -> String {
    if let s = v as? String { return s }
    if let n = v as? NSNumber {
      // Ids numéricos chegam como Double ("12.0" seria errado).
      let d = n.doubleValue
      if d == d.rounded() && abs(d) < 9.0e18 { return String(Int64(d)) } // ids Snowflake até 2^53-1
      return n.stringValue
    }
    return ""
  }

  static func bool(_ v: Any?) -> Bool {
    if let b = v as? Bool { return b }
    if let n = v as? NSNumber { return n.doubleValue != 0 }
    if let s = v as? String { return s == "1" || s == "true" }
    return false
  }

  static func int(_ v: Any?) -> Int {
    if let n = v as? NSNumber {
      let d = n.doubleValue
      if !d.isFinite { return 0 }
      return Int(max(-1e9, min(1e9, d)))
    }
    if let s = v as? String { return Int(s) ?? 0 }
    return 0
  }

  static func double(_ v: Any?) -> Double {
    if let n = v as? NSNumber { return n.doubleValue }
    if let s = v as? String { return Double(s) ?? 0 }
    return 0
  }
}

/// Um "ladrilho" do avatar: 1 = foto/iniciais; 2–4 = colagem do grupo.
struct CLTile {
  var url: String = ""
  var auth: Bool = false
  var initials: String = ""
  var grad: Int = 0

  init(_ d: [String: Any]) {
    url = CLVal.str(d["u"])
    auth = CLVal.bool(d["a"])
    initials = CLVal.str(d["i"])
    grad = CLVal.int(d["g"])
  }
}

struct CLRow {
  var id: String = ""
  var kind: String = "direct"        // direct | group | channel | saved
  var title: String = ""
  var unread: Int = 0
  var mention: Bool = false
  var pinned: Bool = false
  var muted: Bool = false
  var archived: Bool = false
  var locked: Bool = false
  var online: Bool = false
  var activity: String = ""          // "online" ao lado do nome
  var time: String = ""
  var timeBold: Bool = false
  var sender: String = ""            // "Você" / "Ana" (prefixo da prévia)
  var text: String = ""              // prévia sem o emoji inicial
  var icon: String = ""              // camera | video | mic | … (glifo da prévia)
  var receipt: Int = 0               // 0 nada · 1 enviado · 2 entregue · 3 lido
  var scheduled: Bool = false
  var typing: String = ""            // "Ana digitando..." (vazio = ninguém)
  var draft: String = ""
  var draftLabel: String = ""
  var draftFresh: Bool = false
  var draftAge: String = ""
  var note: String = ""
  var ring: String = ""              // um char por status: "1" visto, "0" novo
  var tiles: [CLTile] = []
  var tilesKey: String = ""
  var selected: Bool = false
  var a11y: String = ""
  var empty: String = ""             // texto quando não há mensagem
  var lockOn: Bool = false           // conversa trancada (rótulo Trancar/Destrancar)
  var blockLabel: String = ""        // "Bloquear Ana" (vazio = sem peer p/ bloquear)
  var smart: Bool = false            // fixada "inteligente" (fileira de fixados)

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    kind = CLVal.str(d["kind"])
    if kind.isEmpty { kind = "direct" }
    title = CLVal.str(d["title"])
    unread = CLVal.int(d["unread"])
    mention = CLVal.bool(d["mention"])
    pinned = CLVal.bool(d["pinned"])
    muted = CLVal.bool(d["muted"])
    archived = CLVal.bool(d["archived"])
    locked = CLVal.bool(d["locked"])
    online = CLVal.bool(d["online"])
    activity = CLVal.str(d["activity"])
    time = CLVal.str(d["time"])
    timeBold = CLVal.bool(d["timeBold"])
    sender = CLVal.str(d["sender"])
    text = CLVal.str(d["text"])
    icon = CLVal.str(d["icon"])
    receipt = CLVal.int(d["receipt"])
    scheduled = CLVal.bool(d["scheduled"])
    typing = CLVal.str(d["typing"])
    draft = CLVal.str(d["draft"])
    draftLabel = CLVal.str(d["draftLabel"])
    draftFresh = CLVal.bool(d["draftFresh"])
    draftAge = CLVal.str(d["draftAge"])
    note = CLVal.str(d["note"])
    ring = CLVal.str(d["ring"])
    if let arr = d["tiles"] as? [Any] {
      tiles = arr.compactMap { ($0 as? [String: Any]).map { CLTile($0) } }
    }
    tilesKey = kind + "|" + tiles.map { "\($0.url)#\($0.initials)#\($0.grad)" }.joined(separator: "|")
    selected = CLVal.bool(d["selected"])
    a11y = CLVal.str(d["a11y"])
    empty = CLVal.str(d["empty"])
    lockOn = CLVal.bool(d["lockOn"])
    blockLabel = CLVal.str(d["blockLabel"])
    smart = CLVal.bool(d["smart"])
  }

  var isGroupish: Bool { kind == "group" || kind == "channel" }
  var unreadVisible: Bool { unread > 0 }
}

/// Lista do usuário (filtro "Listas") para o submenu "Adicionar à lista".
struct CLFolder {
  let id: String
  let name: String
  let ids: Set<String>

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    name = CLVal.str(d["name"])
    ids = Set((d["ids"] as? [Any] ?? []).map { CLVal.str($0) })
  }
}

/// Textos fixos (traduzidos no JS) — botões de swipe, menu, acessibilidade.
struct CLLabels {
  var dict: [String: String] = [:]

  init() {}

  init(_ d: [String: Any]?) {
    guard let d = d else { return }
    for (k, v) in d {
      if let s = v as? String, !s.isEmpty { dict[k] = s }
    }
  }

  func get(_ key: String, _ fallback: String) -> String {
    return dict[key] ?? fallback
  }
}

extension UIColor {
  convenience init(clHex hex: UInt32, alpha: CGFloat = 1) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: alpha
    )
  }
}

/// Paleta P&B da lista — espelha LP_LIGHT / LP_DARK do ChatListTab.js.
struct CLTheme {
  let dark: Bool
  let bg: UIColor
  let text: UIColor
  let sub: UIColor
  let subStrong: UIColor
  let faint: UIColor
  let icon: UIColor
  let hair: UIColor
  let press: UIColor
  let pinnedBg: UIColor
  let pillBg: UIColor
  let pillTxt: UIColor
  let mutedPillBg: UIColor
  let mutedPillTxt: UIColor
  let card: UIColor
  let selectedBg: UIColor
  let checkBorder: UIColor
  let receiptSent: UIColor
  let receiptGray: UIColor
  let receiptRead: UIColor
  let ringHot: UIColor
  let ringCold: UIColor
  let online: UIColor

  init(dark: Bool) {
    self.dark = dark
    if dark {
      bg = UIColor(clHex: 0x0B0B0B)
      text = UIColor(clHex: 0xF5F5F5)
      sub = UIColor(clHex: 0x8E8E93)
      subStrong = UIColor(clHex: 0xE5E5EA)
      faint = UIColor(clHex: 0x636366)
      icon = UIColor(white: 1, alpha: 0.42)
      hair = UIColor(white: 1, alpha: 0.09)
      press = UIColor(white: 1, alpha: 0.06)
      pinnedBg = UIColor(clHex: 0x111111)
      pillBg = UIColor(clHex: 0xF5F5F5)
      pillTxt = UIColor(clHex: 0x0B0B0B)
      mutedPillBg = UIColor(clHex: 0x3A3A3C)
      mutedPillTxt = UIColor(clHex: 0xD1D1D6)
      card = UIColor(clHex: 0x1C1C1E)
      selectedBg = UIColor(white: 1, alpha: 0.10)
      checkBorder = UIColor(white: 1, alpha: 0.3)
      receiptSent = UIColor(white: 1, alpha: 0.35)
      receiptGray = UIColor(white: 1, alpha: 0.55)
      ringHot = UIColor.white
      ringCold = UIColor(white: 1, alpha: 0.32)
    } else {
      bg = UIColor.white
      text = UIColor(clHex: 0x0B0B0B)
      sub = UIColor(clHex: 0x737373)
      subStrong = UIColor(clHex: 0x262626)
      faint = UIColor(clHex: 0xA3A3A3)
      icon = UIColor(white: 0, alpha: 0.38)
      hair = UIColor(white: 0, alpha: 0.08)
      press = UIColor(white: 0, alpha: 0.045)
      pinnedBg = UIColor(clHex: 0xFAFAFA)
      pillBg = UIColor(clHex: 0x0B0B0B)
      pillTxt = UIColor.white
      mutedPillBg = UIColor(clHex: 0xE5E5EA)
      mutedPillTxt = UIColor(clHex: 0x48484A)
      card = UIColor(clHex: 0xF5F5F5)
      selectedBg = UIColor(white: 0, alpha: 0.06)
      checkBorder = UIColor(white: 0, alpha: 0.25)
      receiptSent = UIColor(white: 0, alpha: 0.3)
      receiptGray = UIColor(white: 0, alpha: 0.45)
      ringHot = UIColor(clHex: 0x111111)
      ringCold = UIColor(white: 0, alpha: 0.25)
    }
    receiptRead = UIColor(clHex: 0x53BDEB)
    online = UIColor(clHex: 0x22C55E)
  }

  /// Gradientes das iniciais — mesmos 8 pares cinza do AvatarCircle.js.
  static let gradients: [(UInt32, UInt32)] = [
    (0x5C5C5C, 0x333333),
    (0x636363, 0x3A3A3A),
    (0x545454, 0x2C2C2C),
    (0x6A6A6A, 0x404040),
    (0x4D4D4D, 0x262626),
    (0x5F5F5F, 0x363636),
    (0x575757, 0x303030),
    (0x666666, 0x3D3D3D),
  ]

  static func gradient(_ i: Int) -> (UIColor, UIColor) {
    let g = gradients[((i % gradients.count) + gradients.count) % gradients.count]
    return (UIColor(clHex: g.0), UIColor(clHex: g.1))
  }
}

/// Fontes do sistema escaladas pelo Dynamic Type, com o mesmo teto do JS
/// (maxFontSizeMultiplier 1.35 no nome/prévia, 1.3 na hora, 1.15 nos contadores).
enum CLFonts {
  static func scaled(_ size: CGFloat, _ weight: UIFont.Weight, cap: CGFloat, traits: UITraitCollection?, mono: Bool = false) -> UIFont {
    let base = mono
      ? UIFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
      : UIFont.systemFont(ofSize: size, weight: weight)
    return UIFontMetrics(forTextStyle: .body).scaledFont(for: base, maximumPointSize: size * cap, compatibleWith: traits)
  }
}

/// Glifos da prévia → SF Symbols (P&B, traço fino como os SVG do app).
enum CLSymbols {
  static func name(forPreviewIcon icon: String) -> String? {
    switch icon {
    case "camera": return "camera"
    case "video": return "video"
    case "phone": return "phone"
    case "phoneMissed": return "phone.arrow.down.left"
    case "videoMissed": return "video"
    case "mic": return "mic"
    case "paperclip": return "paperclip"
    case "film": return "film"
    case "music": return "music.note"
    case "pin": return "mappin.and.ellipse"
    case "user": return "person"
    case "chart": return "chart.bar"
    case "calendar": return "calendar"
    case "sticker": return "face.smiling"
    case "file": return "doc.text"
    case "lock": return "lock"
    case "gift": return "gift"
    default: return nil
    }
  }

  static func image(_ name: String, pointSize: CGFloat, weight: UIImage.SymbolWeight = .regular, color: UIColor) -> UIImage? {
    let cfg = UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
    return UIImage(systemName: name, withConfiguration: cfg)?.withTintColor(color, renderingMode: .alwaysOriginal)
  }
}
