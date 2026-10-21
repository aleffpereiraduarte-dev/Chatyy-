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
  /// [2026-10-21 lista-viva] `w` = índice 0–5 da paleta quente (JS); -1 = ausente (usa g).
  var warm: Int = -1

  init(_ d: [String: Any]) {
    url = CLVal.str(d["u"])
    auth = CLVal.bool(d["a"])
    initials = CLVal.str(d["i"])
    grad = CLVal.int(d["g"])
    if d["w"] is NSNumber { warm = CLVal.int(d["w"]) }
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
  var pending: Bool = false             // [2026-10-17] na fila sem rede → relógio (receipt 0)
  var failed: Bool = false              // [2026-10-18] última enviada falhou → "!" vermelho (receipt 0)
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
  // [2026-10-21 lista-viva, apiVersion 11] campos opcionais (só com a prop
  // `vivo`): tipo do "digitando" (typing | recording), miniatura da última
  // foto/vídeo. Binário/JS antigo: vazios → comportamento idêntico.
  var typingKind: String = ""        // "" | "typing" | "recording"
  var thumbUrl: String = ""
  var thumbAuth: Bool = false
  var thumbVideo: Bool = false       // thumbKind "video" → triângulo de play

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
    pending = CLVal.bool(d["pending"])
    failed = CLVal.bool(d["failed"])
    // `typing` aceita o texto pronto ("Ana digitando...") OU só o tipo
    // ("typing" / "recording"); `typingKind`/`recording` explícitos vencem.
    let tv = CLVal.str(d["typing"])
    if tv == "typing" || tv == "recording" {
      typingKind = tv
      typing = ""
    } else {
      typing = tv
      typingKind = CLVal.str(d["typingKind"])
      if typingKind != "typing" && typingKind != "recording" { typingKind = "" }
      if CLVal.bool(d["recording"]) && !typing.isEmpty { typingKind = "recording" }
      if typingKind.isEmpty && !typing.isEmpty {
        let low = typing.lowercased()
        typingKind = (low.contains("gravando") || low.contains("recording") || low.contains("grabando")) ? "recording" : "typing"
      }
    }
    thumbUrl = CLVal.str(d["thumbUrl"])
    thumbAuth = CLVal.bool(d["thumbAuth"])
    thumbVideo = CLVal.str(d["thumbKind"]) == "video"
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
  /// Alguém digitando/gravando (texto pronto ou só o tipo).
  var isTyping: Bool { !typing.isEmpty || !typingKind.isEmpty }
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
  var bg: UIColor
  var text: UIColor
  var sub: UIColor
  var subStrong: UIColor
  var faint: UIColor
  var icon: UIColor
  var hair: UIColor
  var press: UIColor
  var pinnedBg: UIColor
  var pillBg: UIColor
  var pillTxt: UIColor
  var mutedPillBg: UIColor
  var mutedPillTxt: UIColor
  var card: UIColor
  var selectedBg: UIColor
  var checkBorder: UIColor
  var receiptSent: UIColor
  var receiptGray: UIColor
  var receiptRead: UIColor
  var danger: UIColor
  var ringHot: UIColor
  var ringCold: UIColor
  var online: UIColor
  /// [2026-10-21 lista-viva] cartão das fixadas (palette `pinnedCard`).
  var pinnedCard: UIColor
  /// [2026-10-21 pitada-azul, apiVersion 12] cor dos DETALHES (palette `detail`/
  /// `onDetail`/`ringNew`/`ringNew2`): contador de não lidas, hora das não lidas,
  /// "digitando"/"gravando", selo @ e anel de status NÃO visto (gradiente
  /// ringNew → ringNew2). nil = desenho de antes (P&B/pillBg/ringHot).
  var detail: UIColor? = nil
  var onDetail: UIColor? = nil
  var ringNew: UIColor? = nil
  var ringNew2: UIColor? = nil

  init(dark: Bool) {
    self.dark = dark
    pinnedCard = dark ? UIColor(clHex: 0x1A1A1D) : UIColor(clHex: 0xF6F6F3)
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
    danger = dark ? UIColor(clHex: 0xFF453A) : UIColor(clHex: 0xFF3B30)
    online = UIColor(clHex: 0x22C55E)
  }

  /// [2026-10-20 grafite, apiVersion 10] prop `palette`: sobrescreve chaves do
  /// tema. Valor = número ARGB (processColor do RN) ou "#RRGGBB" / "#RRGGBBAA" /
  /// "rgba(r,g,b,a)". Chave ausente/inválida = valor padrão (sem palette = idêntico).
  init(dark: Bool, palette: [String: Any]?) {
    self.init(dark: dark)
    guard let p = palette, !p.isEmpty else { return }
    func c(_ k: String, _ cur: UIColor) -> UIColor { return CLTheme.paletteColor(p[k]) ?? cur }
    bg = c("bg", bg)
    text = c("text", text)
    sub = c("sub", sub)
    subStrong = c("subStrong", subStrong)
    faint = c("faint", faint)
    icon = c("icon", icon)
    hair = c("hair", hair)
    press = c("press", press)
    pinnedBg = c("pinnedBg", pinnedBg)
    pillBg = c("pillBg", pillBg)
    pillTxt = c("pillTxt", pillTxt)
    mutedPillBg = c("mutedPillBg", mutedPillBg)
    mutedPillTxt = c("mutedPillTxt", mutedPillTxt)
    card = c("card", card)
    selectedBg = c("selectedBg", selectedBg)
    ringHot = c("ringHot", ringHot)
    ringCold = c("ringCold", ringCold)
    online = c("online", online)
    pinnedCard = c("pinnedCard", pinnedCard)
    detail = CLTheme.paletteColor(p["detail"])
    onDetail = CLTheme.paletteColor(p["onDetail"])
    ringNew = CLTheme.paletteColor(p["ringNew"])
    ringNew2 = CLTheme.paletteColor(p["ringNew2"])
  }

  static func paletteColor(_ v: Any?) -> UIColor? {
    if let n = v as? NSNumber {
      let d = n.doubleValue
      if !d.isFinite { return nil }
      let u = UInt32(truncatingIfNeeded: Int64(d))
      let a = CGFloat((u >> 24) & 0xFF) / 255
      return UIColor(clHex: u & 0xFFFFFF, alpha: a)
    }
    guard var s = (v as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !s.isEmpty else { return nil }
    if s.hasPrefix("#") {
      s.removeFirst()
      if s.count == 6, let n = UInt32(s, radix: 16) { return UIColor(clHex: n) }
      if s.count == 8, let n = UInt32(s, radix: 16) {
        return UIColor(clHex: n >> 8, alpha: CGFloat(n & 0xFF) / 255)
      }
      return nil
    }
    if s.hasPrefix("rgba(") || s.hasPrefix("rgb(") {
      guard let open = s.firstIndex(of: "("), let close = s.lastIndex(of: ")"), open < close else { return nil }
      let inner = s[s.index(after: open)..<close]
      let parts: [Double] = inner.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
      if parts.count < 3 { return nil }
      let a: Double = parts.count >= 4 ? parts[3] : 1
      return UIColor(red: CGFloat(parts[0] / 255), green: CGFloat(parts[1] / 255), blue: CGFloat(parts[2] / 255), alpha: CGFloat(max(0, min(1, a))))
    }
    return nil
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

  /// [2026-10-21 lista-viva] Gradientes QUENTES do avatar sem foto (mockup
  /// preview-2026/lista.html: areia, terracota, oliva, ardósia, malva, trigo).
  /// Índice = `g` do ladrilho (hash do nome no JS) → mesma cor p/ a mesma pessoa.
  static let warmGradients: [(UInt32, UInt32)] = [
    (0xD8B89A, 0x9B6F52),
    (0xC9A28F, 0x8B5A4A),
    (0xB7B892, 0x6F7350),
    (0xA9B4BD, 0x5C6873),
    (0xC7B2C4, 0x7F6680),
    (0xBFAE8C, 0x7D6B48),
  ]

  static func warmGradient(_ i: Int) -> (UIColor, UIColor) {
    let n = warmGradients.count
    let g = warmGradients[((i % n) + n) % n]
    return (UIColor(clHex: g.0), UIColor(clHex: g.1))
  }

  /// Verde do ponto online na lista viva (#2FB36B).
  static let onlineVivo = UIColor(clHex: 0x2FB36B)
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
    case "ban": return "nosign"   // [wave13-C] mensagem apagada (⊘)
    default: return nil
    }
  }

  static func image(_ name: String, pointSize: CGFloat, weight: UIImage.SymbolWeight = .regular, color: UIColor) -> UIImage? {
    let cfg = UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
    return UIImage(systemName: name, withConfiguration: cfg)?.withTintColor(color, renderingMode: .alwaysOriginal)
  }
}
