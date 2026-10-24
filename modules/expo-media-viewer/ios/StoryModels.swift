import UIKit

// [2026-10-15 native-story] Modelos do visualizador de STATUS nativo
// (StoryViewerController). Vêm do JS já normalizados por
// components/status/nativeStories.js — aqui só convertemos tipos.
//
//   group = { key, owner:{email,name,avatar}, isSelf, startItem?, items:[item], menu?:[entry] }
//   item  = { id, type:'image'|'video'|'text', uri, localUri, thumb, text, caption,
//             bg, bgColors:[hex], font, duration(ms), timeLabel, viewed, viewsCount,
//             myReaction, music:{title,artist,url,startMs}, link:{url,label} }
//   entry = { id, label, destructive?, confirm?, labelAlt?, itemFlag? }
// apiVersion 2: item.type 'voice' (áudio em music.url), textAnim, loop
// (boomerang), translatable/translated, overlays:[overlay], paths:[path].
//   overlay = { kind:'text'|'emoji'|'gif'|'mention'|'poll'|'question'|'countdown'|'slider',
//               id, x, y (pontos; <0 = centralizado), text, color, url, w, h, email,
//               question, options, counts, myVote, correct, votable, hint, targetMs,
//               ended, emoji, value, avg }
//   path    = { color, width, points:[x0,y0,x1,y1…] }

enum SVItemType {
  case image
  case video
  case text
  case voice
}

/// Bloco sobre a mídia (figurinha / texto / GIF / enquete…). Mutável: votos.
final class SVOverlay {
  let kind: String
  let id: String
  let x: CGFloat
  let y: CGFloat
  let text: String
  let color: UIColor
  let url: String
  let w: CGFloat
  let h: CGFloat
  let email: String
  let question: String
  let options: [String]
  var counts: [Int]
  /// -1 = ainda não votou; -2 = dono (só mostra resultados).
  var myVote: Int
  let correct: Int
  let votable: Bool
  let hint: String
  let targetMs: Double
  let ended: String
  let emoji: String
  var value: Double
  var avg: Double

  init(dict: [String: Any]) {
    kind = (dict["kind"] as? String) ?? ""
    if let s = dict["id"] as? String { id = s } else if let n = dict["id"] as? NSNumber { id = SVItem.numberString(n) } else { id = "" }
    x = CGFloat(MVItem.doubleValue(dict["x"]) ?? 0)
    y = CGFloat(MVItem.doubleValue(dict["y"]) ?? 0)
    text = (dict["text"] as? String) ?? ""
    color = SVItem.color((dict["color"] as? String) ?? "") ?? .white
    url = (dict["url"] as? String) ?? ""
    w = CGFloat(MVItem.doubleValue(dict["w"]) ?? 0)
    h = CGFloat(MVItem.doubleValue(dict["h"]) ?? 0)
    email = (dict["email"] as? String) ?? ""
    question = (dict["question"] as? String) ?? ""
    options = ((dict["options"] as? [Any]) ?? []).compactMap { $0 as? String }
    counts = ((dict["counts"] as? [Any]) ?? []).map { MVItem.intValue($0) ?? 0 }
    myVote = MVItem.intValue(dict["myVote"]) ?? -1
    correct = MVItem.intValue(dict["correct"]) ?? -1
    votable = (dict["votable"] as? Bool) ?? false
    hint = (dict["hint"] as? String) ?? ""
    targetMs = MVItem.doubleValue(dict["targetMs"]) ?? 0
    ended = (dict["ended"] as? String) ?? ""
    emoji = (dict["emoji"] as? String) ?? ""
    value = MVItem.doubleValue(dict["value"]) ?? -1
    avg = MVItem.doubleValue(dict["avg"]) ?? -1
  }
}

struct SVPath {
  let color: UIColor
  let width: CGFloat
  let points: [CGPoint]
}

final class SVItem {
  let id: String
  let type: SVItemType
  let uri: String
  let localUri: String
  let thumb: String
  /// [status-zoom 2026-10-23] apiVersion 5: original em alta, trocado quando o zoom passa de 1.5x.
  let hires: String
  let text: String
  var caption: String
  let bg: UIColor
  let bgColors: [UIColor]
  let font: String
  let durationMs: Double
  let timeLabel: String
  var viewed: Bool
  var viewsCount: Int
  var myReaction: String
  let musicTitle: String
  let musicArtist: String
  let musicUrl: String
  let musicStartMs: Double
  let linkUrl: String
  let linkLabel: String
  let textAnim: String
  /// [status-texto 2026-10-16] alinhamento do status de texto: left | center | right.
  let textAlign: String
  let loop: Bool
  let translatable: Bool
  var translated: Bool
  let overlays: [SVOverlay]
  let paths: [SVPath]

  init(dict: [String: Any]) {
    if let s = dict["id"] as? String {
      id = s
    } else if let n = dict["id"] as? NSNumber {
      id = SVItem.numberString(n)
    } else {
      id = ""
    }
    switch (dict["type"] as? String) ?? "image" {
    case "video": type = .video
    case "text": type = .text
    case "voice": type = .voice
    default: type = .image
    }
    uri = (dict["uri"] as? String) ?? ""
    localUri = (dict["localUri"] as? String) ?? ""
    thumb = (dict["thumb"] as? String) ?? ""
    hires = (dict["hires"] as? String) ?? ""
    text = (dict["text"] as? String) ?? ""
    caption = (dict["caption"] as? String) ?? ""
    bg = SVItem.color((dict["bg"] as? String) ?? "") ?? UIColor(white: 0.07, alpha: 1)
    bgColors = ((dict["bgColors"] as? [Any]) ?? []).compactMap { ($0 as? String).flatMap { SVItem.color($0) } }
    font = (dict["font"] as? String) ?? "sans"
    let d = MVItem.doubleValue(dict["duration"]) ?? 0
    durationMs = d > 0 ? min(max(d, 1500), 60000) : 5000
    timeLabel = (dict["timeLabel"] as? String) ?? ""
    viewed = (dict["viewed"] as? Bool) ?? false
    viewsCount = MVItem.intValue(dict["viewsCount"]) ?? 0
    myReaction = (dict["myReaction"] as? String) ?? ""
    let music = dict["music"] as? [String: Any] ?? [:]
    musicTitle = (music["title"] as? String) ?? ""
    musicArtist = (music["artist"] as? String) ?? ""
    musicUrl = (music["url"] as? String) ?? ""
    musicStartMs = MVItem.doubleValue(music["startMs"]) ?? 0
    let link = dict["link"] as? [String: Any] ?? [:]
    linkUrl = (link["url"] as? String) ?? ""
    linkLabel = (link["label"] as? String) ?? ""
    textAnim = (dict["textAnim"] as? String) ?? ""
    textAlign = (dict["align"] as? String) ?? "center"
    loop = (dict["loop"] as? Bool) ?? false
    translatable = (dict["translatable"] as? Bool) ?? false
    translated = (dict["translated"] as? Bool) ?? false
    overlays = ((dict["overlays"] as? [Any]) ?? []).compactMap { ($0 as? [String: Any]).map { SVOverlay(dict: $0) } }
      .filter { !$0.kind.isEmpty }
    paths = ((dict["paths"] as? [Any]) ?? []).compactMap { raw -> SVPath? in
      guard let m = raw as? [String: Any] else { return nil }
      let nums = ((m["points"] as? [Any]) ?? []).compactMap { MVItem.doubleValue($0) }
      var pts: [CGPoint] = []
      var i = 0
      while i + 1 < nums.count {
        pts.append(CGPoint(x: nums[i], y: nums[i + 1]))
        i += 2
      }
      guard pts.count >= 2 else { return nil }
      let w = CGFloat(MVItem.doubleValue(m["width"]) ?? 3)
      return SVPath(color: SVItem.color((m["color"] as? String) ?? "") ?? .white, width: w > 0 ? w : 3, points: pts)
    }
  }

  func hasFlag(_ f: String) -> Bool {
    switch f {
    case "translatable": return translatable
    default: return false
    }
  }

  static func numberString(_ n: NSNumber) -> String {
    let d = n.doubleValue
    if d == d.rounded() && abs(d) < 9.0e18 { return String(Int64(d)) } // ids Snowflake até 2^53-1
    return n.stringValue
  }

  /// "#RGB" / "#RRGGBB" / "#RRGGBBAA" → UIColor.
  static func color(_ raw: String) -> UIColor? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard s.hasPrefix("#") else { return nil }
    s.removeFirst()
    if s.count == 3 {
      s = s.map { "\($0)\($0)" }.joined()
    }
    guard s.count == 6 || s.count == 8, let v = UInt64(s, radix: 16) else { return nil }
    let r, g, b, a: CGFloat
    if s.count == 6 {
      r = CGFloat((v >> 16) & 0xFF) / 255
      g = CGFloat((v >> 8) & 0xFF) / 255
      b = CGFloat(v & 0xFF) / 255
      a = 1
    } else {
      r = CGFloat((v >> 24) & 0xFF) / 255
      g = CGFloat((v >> 16) & 0xFF) / 255
      b = CGFloat((v >> 8) & 0xFF) / 255
      a = CGFloat(v & 0xFF) / 255
    }
    return UIColor(red: r, green: g, blue: b, alpha: a)
  }
}

struct SVMenuEntry {
  let id: String
  let label: String
  let destructive: Bool
  let confirm: String
  let labelAlt: String
  let itemFlag: String

  func visible(for item: SVItem) -> Bool {
    return itemFlag.isEmpty || item.hasFlag(itemFlag)
  }

  func title(for item: SVItem) -> String {
    return (item.translated && !labelAlt.isEmpty) ? labelAlt : label
  }
}

final class SVGroup {
  let key: String
  let ownerEmail: String
  let ownerName: String
  let avatar: String
  let isSelf: Bool
  var items: [SVItem]
  let menu: [SVMenuEntry]
  /// Item atual desta pessoa (mantido ao trocar de pessoa e voltar).
  var index: Int

  init(dict: [String: Any]) {
    // Locais primeiro: em classe não dá p/ ler self.x antes de inicializar tudo.
    let owner = dict["owner"] as? [String: Any] ?? [:]
    let email = (owner["email"] as? String) ?? ""
    ownerEmail = email
    ownerName = (owner["name"] as? String) ?? ""
    avatar = (owner["avatar"] as? String) ?? ""
    key = (dict["key"] as? String) ?? email
    isSelf = (dict["isSelf"] as? Bool) ?? false
    let list = ((dict["items"] as? [Any]) ?? []).compactMap { ($0 as? [String: Any]).map { SVItem(dict: $0) } }
      .filter { !$0.id.isEmpty }
    items = list
    menu = ((dict["menu"] as? [Any]) ?? []).compactMap { raw in
      guard let m = raw as? [String: Any], let id = m["id"] as? String, let label = m["label"] as? String else { return nil }
      return SVMenuEntry(
        id: id,
        label: label,
        destructive: (m["destructive"] as? Bool) ?? false,
        confirm: (m["confirm"] as? String) ?? "",
        labelAlt: (m["labelAlt"] as? String) ?? "",
        itemFlag: (m["itemFlag"] as? String) ?? ""
      )
    }
    var start: Int
    if let s = MVItem.intValue(dict["startItem"]), s >= 0 {
      start = s
    } else {
      // Instagram/WhatsApp: abre no primeiro ainda não visto.
      start = list.firstIndex(where: { !$0.viewed }) ?? 0
    }
    start = max(0, min(max(0, list.count - 1), start))
    index = start
  }
}

struct SVReaction {
  let emoji: String
  let kind: String
}

/// Textos (i18n) vindos do JS. `{name}` / `{count}` são substituídos aqui.
struct SVLabels {
  private let map: [String: String]

  init(_ raw: [String: Any]) {
    var m: [String: String] = [:]
    for (k, v) in raw {
      if let s = v as? String { m[k] = s }
    }
    map = m
  }

  func get(_ key: String, _ fallback: String) -> String {
    if let s = map[key], !s.isEmpty { return s }
    return fallback
  }

  func views(_ n: Int) -> String {
    let tpl = n == 1 ? get("viewsOne", "{count} visualização") : get("viewsOther", "{count} visualizações")
    return tpl.replacingOccurrences(of: "{count}", with: String(n))
  }
}
