import UIKit

// [2026-10-15 native-social] Aba CANAIS em nativo — modelos.
// JS: components/channels/NativeChannelList.js / NativeChannelFeed.js
//
// Linhas planas (o patcher do JS compara só o 1º nível):
//   kind "row"  — canal seguido: title, sub (prévia), time, meta
//                 ("12K seguidores"), tu/ti/tg/ta (avatar), ver, unread
//   kind "card" — canal do Descobrir: title, desc, meta, badge ("12K"),
//                 member, seed
//   kind "post" — post de canal: text, time, views, mu (mídia), mk
//                 ("image"|"video"), rx ("emoji\u{1F}contagem" separados
//                 por \u{1E}), mine (minha reação), q (barra rápida)

struct CHReaction {
  let emoji: String
  let count: Int
}

struct CHRow {
  var id = ""
  var kind = "row"
  var title = ""
  var sub = ""
  var time = ""
  var meta = ""
  var desc = ""
  var badge = ""
  var member = false
  var verified = false
  var unread = 0
  var a11y = ""
  var tileURL = ""
  var tileAuth = false
  var tileInitials = ""
  var tileGrad = 0
  // post
  var text = ""
  var views = ""
  var mediaURL = ""
  var mediaKind = ""
  var reactions: [CHReaction] = []
  var mine = ""
  var quick = false

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    kind = CLVal.str(d["kind"])
    if kind.isEmpty { kind = "row" }
    title = CLVal.str(d["title"])
    sub = CLVal.str(d["sub"])
    time = CLVal.str(d["time"])
    meta = CLVal.str(d["meta"])
    desc = CLVal.str(d["desc"])
    badge = CLVal.str(d["badge"])
    member = CLVal.bool(d["member"])
    verified = CLVal.bool(d["ver"])
    unread = CLVal.int(d["unread"])
    a11y = CLVal.str(d["a11y"])
    tileURL = CLVal.str(d["tu"])
    tileAuth = CLVal.bool(d["ta"])
    tileInitials = CLVal.str(d["ti"])
    tileGrad = CLVal.int(d["tg"])
    text = CLVal.str(d["text"])
    views = CLVal.str(d["views"])
    mediaURL = CLVal.str(d["mu"])
    mediaKind = CLVal.str(d["mk"])
    mine = CLVal.str(d["mine"])
    quick = CLVal.bool(d["q"])
    let rx = CLVal.str(d["rx"])
    if !rx.isEmpty {
      var out: [CHReaction] = []
      for rec in rx.split(separator: "\u{1E}", omittingEmptySubsequences: true) {
        let parts = rec.split(separator: "\u{1F}", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { continue }
        let e = String(parts[0])
        let c = Int(parts[1]) ?? 0
        if !e.isEmpty && c > 0 { out.append(CHReaction(emoji: e, count: c)) }
      }
      reactions = out
    }
  }

  var tile: CLTile {
    var d: [String: Any] = ["u": tileURL, "i": tileInitials, "g": tileGrad]
    if tileAuth { d["a"] = 1 }
    return CLTile(d)
  }
}

/// Cores P&B da aba (o JS manda `palette` com as cores do tema).
struct CHPalette {
  let dark: Bool
  var bg: UIColor
  var card: UIColor
  var text: UIColor
  var sub: UIColor
  var pill: UIColor
  var line: UIColor
  var ink: UIColor
  var inkText: UIColor
  var press: UIColor

  init(dark: Bool, dict: [String: Any]? = nil) {
    self.dark = dark
    if dark {
      bg = UIColor(clHex: 0x000000)
      card = UIColor(clHex: 0x1C1C1E)
      text = UIColor(clHex: 0xF5F5F7)
      sub = UIColor(clHex: 0x8E8E93)
      pill = UIColor(clHex: 0x1A1A24)
      line = UIColor(white: 1, alpha: 0.06)
      ink = UIColor(clHex: 0xF5F5F7)
      inkText = UIColor(clHex: 0x111111)
      press = UIColor(white: 1, alpha: 0.08)
    } else {
      bg = UIColor(clHex: 0xFFFFFF)
      card = UIColor(clHex: 0xFFFFFF)
      text = UIColor(clHex: 0x111111)
      sub = UIColor(clHex: 0x737373)
      pill = UIColor(clHex: 0xF0F0F5)
      line = UIColor(white: 0, alpha: 0.06)
      ink = UIColor(clHex: 0x111111)
      inkText = UIColor.white
      press = UIColor(white: 0, alpha: 0.05)
    }
    if let d = dict {
      if let c = SLColor.parse(CLVal.str(d["bg"])) { bg = c }
      if let c = SLColor.parse(CLVal.str(d["card"])) { card = c }
      if let c = SLColor.parse(CLVal.str(d["text"])) { text = c }
      if let c = SLColor.parse(CLVal.str(d["sub"])) { sub = c }
      if let c = SLColor.parse(CLVal.str(d["pill"])) { pill = c }
      if let c = SLColor.parse(CLVal.str(d["line"])) { line = c }
    }
  }
}
