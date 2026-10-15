import UIKit

// [2026-10-15 native-search-notifs] Modelos da lista de RESULTADOS nativa
// (ChatyyResultList): busca global (components/GlobalSearch.js, app/search.js)
// e central de notificações (app/notifications.js, NotificationsHub,
// notifications-feed). Mesmo contrato do Android (RLModels.kt).
// Linhas PLANAS vindas de components/native/resultListAdapter.js:
//   seção   → { id, k: 's', t, ac? }                       (ac = "Ver todos"/"Limpar")
//   linha   → { id, k: 'r', t, tl, sb, sl, tm, tiles | th(+ta) | gl(+gs),
//               bd, pv, rt, un, b1, b1f, b1b, b2, sw, cv, hl, tap, a11y }
//   carregando → { id, k: 'l', t? }
//   aviso   → { id, k: 'n', t, gl? }                       (vazio / erro / dica)
// O nativo só desenha; ações voltam por id. O termo buscado vem na prop
// `highlight` e é destacado AQUI (sem caixa/acento) nas linhas com `hl`.

struct RLRow {
  var id: String = ""
  var kind: String = "r"
  var title: String = ""
  var titleLines: Int = 1
  var sub: String = ""
  var subLines: Int = 1
  var time: String = ""
  var tilesRaw: [Any] = []
  var thumb: String = ""
  var thumbAuth = false
  var glyph: String = ""
  var glyphRound = false          // gs = "r" → quadrado arredondado (arquivo, e-mail)
  var badge: String = ""
  var play = false
  var rightThumb: String = ""
  var unread = false
  var b1: String = ""
  var b1Filled = true
  var b1Busy = false
  var b2: String = ""
  var swipe: String = ""
  var chevron = false
  var highlight = false
  var tap = true
  var a11y: String = ""
  var action: String = ""

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    kind = CLVal.str(d["k"])
    if kind.isEmpty { kind = "r" }
    title = CLVal.str(d["t"])
    titleLines = d["tl"] == nil ? 1 : max(1, min(3, CLVal.int(d["tl"])))
    sub = CLVal.str(d["sb"])
    subLines = d["sl"] == nil ? 1 : max(1, min(3, CLVal.int(d["sl"])))
    time = CLVal.str(d["tm"])
    tilesRaw = (d["tiles"] as? [Any]) ?? []
    thumb = CLVal.str(d["th"])
    thumbAuth = CLVal.bool(d["ta"])
    glyph = CLVal.str(d["gl"])
    glyphRound = CLVal.str(d["gs"]) == "r"
    badge = CLVal.str(d["bd"])
    play = CLVal.bool(d["pv"])
    rightThumb = CLVal.str(d["rt"])
    unread = CLVal.bool(d["un"])
    b1 = CLVal.str(d["b1"])
    b1Filled = d["b1f"] == nil ? true : CLVal.bool(d["b1f"])
    b1Busy = CLVal.bool(d["b1b"])
    b2 = CLVal.str(d["b2"])
    swipe = CLVal.str(d["sw"])
    chevron = CLVal.bool(d["cv"])
    highlight = CLVal.bool(d["hl"])
    tap = d["tap"] == nil ? true : CLVal.bool(d["tap"])
    a11y = CLVal.str(d["a11y"])
    action = CLVal.str(d["ac"])
  }

  var isSection: Bool { kind == "s" }
  var hasTiles: Bool { !tilesRaw.isEmpty }
  var hasButtons: Bool { !b1.isEmpty || !b2.isEmpty }

  /// CLRow só com o que o CLAvatarView desenha (foto/iniciais).
  func avatarRow() -> CLRow {
    return CLRow(["id": id, "kind": "direct", "title": title, "tiles": tilesRaw])
  }
}

/// Glifos semânticos → SF Symbols (Android: drawables do mesmo nome lógico).
enum RLGlyphs {
  static func symbol(_ name: String) -> String {
    switch name {
    case "message": return "bubble.left"
    case "mail": return "envelope"
    case "user": return "person"
    case "userPlus": return "person.badge.plus"
    case "image": return "photo"
    case "film": return "film"
    case "video": return "video"
    case "file": return "doc.text"
    case "clock": return "clock"
    case "search": return "magnifyingglass"
    case "heart": return "heart.fill"
    case "at": return "at"
    case "bell": return "bell"
    case "hash": return "number"
    case "music": return "music.note"
    case "mic": return "mic"
    case "link": return "link"
    case "chart": return "chart.bar"
    case "calendar": return "calendar"
    case "play": return "play.fill"
    case "live": return "dot.radiowaves.left.and.right"
    default: return "circle"
    }
  }

  static func image(_ name: String, size: CGFloat, weight: UIImage.SymbolWeight = .medium, color: UIColor) -> UIImage? {
    return CLSymbols.image(symbol(name), pointSize: size, weight: weight, color: color)
  }
}

/// Destaque do termo: busca cada palavra do termo sem caixa/acento e devolve
/// os intervalos (NSRange) no texto original.
enum RLHighlight {
  static func tokens(_ q: String) -> [String] {
    let parts = q.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).map(String.init)
    var out: [String] = []
    for p in parts {
      let t = p.trimmingCharacters(in: CharacterSet(charactersIn: "#@\"'"))
      if t.count >= 1 && !out.contains(t) { out.append(t) }
    }
    // Termo inteiro primeiro (frases), depois as palavras; mais longas antes.
    let full = q.trimmingCharacters(in: .whitespacesAndNewlines)
    if out.count > 1 && !full.isEmpty { out.insert(full, at: 0) }
    return Array(out.prefix(6))
  }

  static func ranges(in text: String, tokens: [String]) -> [NSRange] {
    if text.isEmpty || tokens.isEmpty { return [] }
    let ns = text as NSString
    var out: [NSRange] = []
    let opts: NSString.CompareOptions = [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]
    for t in tokens {
      var start = 0
      var guardN = 0
      while start < ns.length && guardN < 20 {
        guardN += 1
        let r = ns.range(of: t, options: opts, range: NSRange(location: start, length: ns.length - start))
        if r.location == NSNotFound || r.length == 0 { break }
        if !out.contains(where: { NSIntersectionRange($0, r).length > 0 }) { out.append(r) }
        start = r.location + r.length
      }
    }
    return out
  }

  static func apply(_ s: NSMutableAttributedString, tokens: [String], font: UIFont, color: UIColor) {
    for r in ranges(in: s.string, tokens: tokens) {
      s.addAttributes([.font: font, .foregroundColor: color], range: r)
    }
  }
}
