import UIKit

// [2026-10-14 native-list] Modelo de linha recebido do JS
// (components/chat/nativeThreadList.js → buildRow). Tudo opcional e tolerante:
// campo ausente/estranho vira default, nunca crash.

enum CMLKind: Int {
  case msg = 0, date, unread, system
}

struct CMLSpan {
  let start: Int
  let end: Int
  let flags: Int
  let url: String?
  var color: UInt32? = nil   // [fase 2] 5º elemento: cor do trecho / fundo do code inline

  static let bold = 1, italic = 2, strike = 4, mono = 8, link = 16, mention = 32, hashtag = 64
  // [fase 2]
  static let emoji = 128, spoiler = 256, code = 512

  /// Parse tolerante de `[start, end, flags, url?, color?]`.
  static func parseList(_ v: Any?) -> [CMLSpan] {
    var sp: [CMLSpan] = []
    guard let arr = v as? [Any] else { return sp }
    for a in arr {
      guard let t = a as? [Any], t.count >= 3,
            let s = CMLRow.num(t[0]), let e = CMLRow.num(t[1]), let f = CMLRow.num(t[2]),
            s.isFinite, e.isFinite, f.isFinite else { continue }
      let url = t.count > 3 ? (t[3] as? String) : nil
      var span = CMLSpan(start: Int(s), end: Int(e), flags: Int(f), url: url)
      if t.count > 4 { span.color = CMLRow.color(t[4]) }
      if e > s { sp.append(span) }
    }
    return sp
  }
}

struct CMLMedia {
  var kind: String = "image"   // image | video | gif | sticker
  var uri: String = ""
  var thumb: String = ""
  var w: CGFloat = 0
  var h: CGFloat = 0
  var dur: String = ""
  var up: Int? = nil           // nil = sem envio; -1 indeterminado; 0..100
  var id: String = ""
}

struct CMLReply {
  var id: String = ""
  var name: String = ""
  var text: String = ""
  var color: UInt32 = 0xFF888888
  var thumb: String = ""
  var italic: Bool = false
}

struct CMLReact {
  var emoji: String
  var count: Int
  var mine: Bool
}

struct CMLAudio {
  var duration: Int = 0
  var voice: Bool = true
  var wave: [CGFloat] = []
  var played: Bool = false
}

struct CMLFile {
  var name: String = ""
  var size: String = ""
  var ext: String = ""
}

final class CMLRow {
  let key: String
  let kind: CMLKind
  let id: String
  let own: Bool
  let first: Bool
  let last: Bool
  let time: String
  let status: Double?   // -1 falhou, 0 pendente, 1 enviado, 1.5 entregue, 2 lido
  let star: Bool
  let sel: Int          // 0 fora do modo seleção, 1 não selecionada, 2 selecionada
  let name: String
  let nameColor: UInt32
  let text: String
  let spans: [CMLSpan]
  let deleted: Bool
  let forwarded: String
  let reply: CMLReply?
  let edited: String
  let reacts: [CMLReact]
  let jumbo: CGFloat
  let media: CMLMedia?
  let album: [CMLMedia]
  let more: Int
  /// [hero] ids de TODO o álbum (só quando > 4: os de índice ≥ 4 voltam ao último tile)
  let albumIds: [String]
  let audio: CMLAudio?
  let file: CMLFile?
  // [fase 2] blocos / extras
  let blocks: [CMLNode]
  let pre: [CMLNode]
  let post: [CMLNode]
  let cw: CGFloat
  let bareFlag: Bool
  let pad: UIEdgeInsets?
  let metaPos: String      // "" (auto) | in | below | over | none
  let fail: Bool
  let pin: Bool
  let timer: Bool
  let bubbleBg: UInt32?  // bbg: fundo do balão recebido (menção a mim)
  let opacity: CGFloat

  init?(dict d: [String: Any]) {
    guard let k = d["k"] as? String, !k.isEmpty else { return nil }
    key = k
    switch (d["kind"] as? String) ?? "msg" {
    case "date": kind = .date
    case "unread": kind = .unread
    case "system": kind = .system
    default: kind = .msg
    }
    id = CMLRow.str(d["id"])
    own = CMLRow.bool(d["own"])
    first = d["first"] == nil ? true : CMLRow.bool(d["first"])
    last = d["last"] == nil ? true : CMLRow.bool(d["last"])
    time = CMLRow.str(d["time"])
    status = CMLRow.num(d["st"])
    star = CMLRow.bool(d["star"])
    sel = Int(CMLRow.num(d["sel"]) ?? 0)
    name = CMLRow.str(d["name"])
    nameColor = CMLRow.color(d["nc"]) ?? 0xFF888888
    text = CMLRow.str(d["text"])
    spans = CMLSpan.parseList(d["sp"])
    deleted = CMLRow.bool(d["del"])
    forwarded = CMLRow.str(d["fwd"])
    if let r = d["rp"] as? [String: Any] {
      var rp = CMLReply()
      rp.id = CMLRow.str(r["id"])
      rp.name = CMLRow.str(r["name"])
      rp.text = CMLRow.str(r["text"])
      rp.color = CMLRow.color(r["c"]) ?? 0xFF888888
      rp.thumb = CMLRow.str(r["th"])
      rp.italic = CMLRow.bool(r["it"])
      reply = rp
    } else {
      reply = nil
    }
    edited = CMLRow.str(d["ed"])
    var rx: [CMLReact] = []
    if let arr = d["rx"] as? [[String: Any]] {
      for r in arr {
        let e = CMLRow.str(r["e"])
        if e.isEmpty { continue }
        rx.append(CMLReact(emoji: e, count: max(1, Int(CMLRow.num(r["n"]) ?? 1)), mine: CMLRow.bool(r["me"])))
      }
    }
    reacts = rx
    jumbo = CGFloat(CMLRow.num(d["jumbo"]) ?? 0)
    media = (d["media"] as? [String: Any]).map { CMLRow.parseMedia($0) }
    album = ((d["album"] as? [[String: Any]]) ?? []).map { CMLRow.parseMedia($0) }
    more = Int(CMLRow.num(d["more"]) ?? 0)
    albumIds = ((d["aids"] as? [Any]) ?? []).map { CMLRow.str($0) }
    if let a = d["au"] as? [String: Any] {
      var au = CMLAudio()
      au.duration = Int(CMLRow.num(a["d"]) ?? 0)
      au.voice = a["v"] == nil ? true : CMLRow.bool(a["v"])
      au.played = CMLRow.bool(a["p"])
      if let w = a["w"] as? [Any] {
        au.wave = w.compactMap { CMLRow.num($0) }.map { CGFloat(max(8, min(100, $0))) / 100 }
      }
      audio = au
    } else {
      audio = nil
    }
    if let f = d["file"] as? [String: Any] {
      file = CMLFile(name: CMLRow.str(f["n"]), size: CMLRow.str(f["s"]), ext: CMLRow.str(f["x"]))
    } else {
      file = nil
    }
    blocks = CMLNode.list(d["bl"])
    pre = CMLNode.list(d["pre"])
    post = CMLNode.list(d["post"])
    cw = max(0, CGFloat(CMLRow.num(d["cw"]) ?? 0))
    bareFlag = CMLRow.bool(d["bare"])
    pad = CMLNode.insets(d["pad"])
    metaPos = CMLRow.str(d["mp"])
    fail = CMLRow.bool(d["fail"])
    pin = CMLRow.bool(d["pin"])
    timer = CMLRow.bool(d["tmr"])
    bubbleBg = CMLRow.color(d["bbg"])
    if let o = CMLRow.num(d["op"]), o.isFinite { opacity = CGFloat(max(0, min(1, o))) } else { opacity = 1 }
  }

  var isMessage: Bool { return kind == .msg }

  /// Texto p/ acessibilidade (inclui os blocos).
  var accessibilityText: String {
    var parts: [String] = []
    if !name.isEmpty { parts.append(name) }
    if !text.isEmpty { parts.append(text) }
    for n in pre + blocks + post { n.collectText(into: &parts) }
    if !time.isEmpty { parts.append(time) }
    return parts.joined(separator: ", ")
  }

  /// Linha "sem balão" (figurinha / emoji grande).
  var bare: Bool {
    if kind != .msg || deleted { return false }
    if bareFlag && !blocks.isEmpty { return true }
    if jumbo > 0 { return true }
    if let m = media, m.kind == "sticker" { return true }
    return false
  }

  static func parseMedia(_ m: [String: Any]) -> CMLMedia {
    var md = CMLMedia()
    md.kind = str(m["t"]).isEmpty ? "image" : str(m["t"])
    md.uri = str(m["uri"])
    md.thumb = str(m["th"])
    md.w = CGFloat(num(m["w"]) ?? 0)
    md.h = CGFloat(num(m["h"]) ?? 0)
    md.dur = str(m["dur"])
    if let u = num(m["up"]) { md.up = Int(u) }
    md.id = str(m["id"])
    return md
  }

  static func str(_ v: Any?) -> String {
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
  }

  static func num(_ v: Any?) -> Double? {
    if let n = v as? NSNumber { return n.doubleValue }
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    if let s = v as? String { return Double(s) }
    return nil
  }

  static func bool(_ v: Any?) -> Bool {
    if let b = v as? Bool { return b }
    if let n = num(v) { return n != 0 }
    return false
  }

  static func color(_ v: Any?) -> UInt32? {
    guard let n = num(v), n.isFinite, n >= 0 else { return nil }
    return UInt32(truncatingIfNeeded: Int64(n))
  }
}

/// Tema (ARGB do JS).
struct CMLTheme {
  var ownBubble = UIColor(white: 0.07, alpha: 1)
  var otherBubble = UIColor(red: 0.93, green: 0.93, blue: 0.94, alpha: 1)
  var ownText = UIColor.white
  var otherText = UIColor(white: 0.07, alpha: 1)
  var ownMeta = UIColor(white: 1, alpha: 0.62)
  var otherMeta = UIColor(red: 0.235, green: 0.235, blue: 0.263, alpha: 0.74)
  var link = UIColor(red: 0.2, green: 0.45, blue: 0.95, alpha: 1)
  var read = UIColor(red: 0.325, green: 0.741, blue: 0.922, alpha: 1)
  var wall = UIColor.white
  var pillBg = UIColor(white: 0, alpha: 0.06)
  var pillText = UIColor(white: 0.3, alpha: 1)
  var systemText = UIColor(white: 0.45, alpha: 1)
  var accent = UIColor(white: 0.07, alpha: 1)
  var ownQuote = UIColor(white: 1, alpha: 0.12)
  var otherQuote = UIColor(white: 0, alpha: 0.05)
  var unreadBg = UIColor(white: 0, alpha: 0.05)
  var unreadText = UIColor(white: 0.3, alpha: 1)
  var reactBg = UIColor(white: 0.96, alpha: 1)
  var reactBorder = UIColor(white: 1, alpha: 1)
  var selection = UIColor(white: 0.5, alpha: 0.18)
  var highlight = UIColor(white: 0.5, alpha: 0.28)
  var failed = UIColor(red: 0.9, green: 0.2, blue: 0.2, alpha: 1)

  static func uiColor(_ argb: UInt32) -> UIColor {
    let a = CGFloat((argb >> 24) & 0xFF) / 255
    let r = CGFloat((argb >> 16) & 0xFF) / 255
    let g = CGFloat((argb >> 8) & 0xFF) / 255
    let b = CGFloat(argb & 0xFF) / 255
    return UIColor(red: r, green: g, blue: b, alpha: a)
  }

  init() {}

  init(dict: [String: Any]) {
    func c(_ k: String, _ cur: UIColor) -> UIColor {
      guard let v = CMLRow.color(dict[k]) else { return cur }
      return CMLTheme.uiColor(v)
    }
    ownBubble = c("ownBubble", ownBubble)
    otherBubble = c("otherBubble", otherBubble)
    ownText = c("ownText", ownText)
    otherText = c("otherText", otherText)
    ownMeta = c("ownMeta", ownMeta)
    otherMeta = c("otherMeta", otherMeta)
    link = c("link", link)
    read = c("read", read)
    wall = c("wall", wall)
    pillBg = c("pillBg", pillBg)
    pillText = c("pillText", pillText)
    systemText = c("systemText", systemText)
    accent = c("accent", accent)
    ownQuote = c("ownQuote", ownQuote)
    otherQuote = c("otherQuote", otherQuote)
    unreadBg = c("unreadBg", unreadBg)
    unreadText = c("unreadText", unreadText)
    reactBg = c("reactBg", reactBg)
    reactBorder = c("reactBorder", reactBorder)
    selection = c("selection", selection)
    highlight = c("highlight", highlight)
    failed = c("failed", failed)
  }
}
