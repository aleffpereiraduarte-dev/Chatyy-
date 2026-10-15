import UIKit

// [2026-10-15 native-feed] Modelo de um post da aba FEED (linha plana vinda do
// JS — components/feed/NativePostFeed.js monta; o patcher da home compara só o
// 1º nível, então mídia/marcados chegam como strings).
//   m   = mídia: linhas "v\t<url>\t<pôster>" (vídeo) ou "i\t<url>" (foto)
//   tg  = marcados: e-mails separados por "\n"

struct FDMedia {
  let video: Bool
  let url: String
  let poster: String
}

final class FDRow {
  let id: String
  var authorName = ""
  var authorEmail = ""
  var avatar = ""
  var initials = ""
  var own = false
  var sponsored = false
  var location = ""
  var time = ""
  var media: [FDMedia] = []
  var caption = ""
  var translation = ""
  var translateState = 0 // 0 nada · 1 traduzindo · 2 erro
  var liked = false
  var likes = 0
  var saved = false
  var comments = 0
  var date = ""
  var repostAuthor = ""
  var repostCaption = ""
  var repostThumb = ""
  var hasRepost = false
  var derivative = ""
  var sound = ""
  var tags: [String] = []
  var gift = false
  var pinned = false
  var promote = false

  init?(_ d: [String: Any]) {
    guard let id = FDVal.str(d["id"]), !id.isEmpty else { return nil }
    self.id = id
    authorName = FDVal.str(d["an"]) ?? ""
    authorEmail = FDVal.str(d["ae"]) ?? ""
    avatar = FDVal.str(d["au"]) ?? ""
    initials = FDVal.str(d["ai"]) ?? ""
    own = FDVal.bool(d["own"])
    sponsored = FDVal.bool(d["sp"])
    location = FDVal.str(d["loc"]) ?? ""
    time = FDVal.str(d["tm"]) ?? ""
    media = FDRow.parseMedia(FDVal.str(d["m"]) ?? "")
    caption = FDVal.str(d["cap"]) ?? ""
    translation = FDVal.str(d["tr"]) ?? ""
    translateState = Int(FDVal.num(d["trs"]))
    liked = FDVal.bool(d["liked"])
    likes = max(0, Int(FDVal.num(d["lk"])))
    saved = FDVal.bool(d["sv"])
    comments = max(0, Int(FDVal.num(d["cc"])))
    date = FDVal.str(d["dt"]) ?? ""
    repostAuthor = FDVal.str(d["rpa"]) ?? ""
    repostCaption = FDVal.str(d["rpc"]) ?? ""
    repostThumb = FDVal.str(d["rpt"]) ?? ""
    hasRepost = FDVal.bool(d["rp"])
    derivative = FDVal.str(d["dl"]) ?? ""
    sound = FDVal.str(d["snd"]) ?? ""
    let tg = FDVal.str(d["tg"]) ?? ""
    tags = tg.isEmpty ? [] : tg.components(separatedBy: "\n").filter { !$0.isEmpty }
    gift = FDVal.bool(d["gift"])
    pinned = FDVal.bool(d["pin"])
    promote = FDVal.bool(d["prm"])
  }

  static func parseMedia(_ s: String) -> [FDMedia] {
    if s.isEmpty { return [] }
    var out: [FDMedia] = []
    for line in s.components(separatedBy: "\n") {
      let parts = line.components(separatedBy: "\t")
      guard parts.count >= 2, !parts[1].isEmpty else { continue }
      out.append(FDMedia(video: parts[0] == "v", url: parts[1], poster: parts.count > 2 ? parts[2] : ""))
    }
    return out
  }

  /// Chave do item de vídeo no pool de players (post + página do carrossel).
  func videoKey(_ page: Int) -> String { return "\(id)#\(page)" }
}

enum FDVal {
  static func str(_ v: Any?) -> String? {
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
  }

  static func num(_ v: Any?) -> Double {
    if let n = v as? NSNumber { return n.doubleValue }
    if let s = v as? String, let d = Double(s) { return d }
    return 0
  }

  static func bool(_ v: Any?) -> Bool {
    if let b = v as? Bool { return b }
    if let n = v as? NSNumber { return n.boolValue }
    if let s = v as? String { return s == "1" || s == "true" }
    return false
  }
}

struct FDPalette {
  var bg: UIColor
  var card: UIColor
  var text: UIColor
  var text2: UIColor
  var text3: UIColor
  var sep: UIColor
  var chip: UIColor
  var placeholder: UIColor
  let likeRed = UIColor(red: 0xEF / 255.0, green: 0x44 / 255.0, blue: 0x44 / 255.0, alpha: 1)

  init(dark: Bool, dict: [String: Any]? = nil) {
    bg = dark ? .black : .white
    card = dark ? UIColor(white: 0.07, alpha: 1) : .white
    text = dark ? UIColor(white: 0.96, alpha: 1) : UIColor(white: 0.067, alpha: 1)
    text2 = dark ? UIColor(white: 0.62, alpha: 1) : UIColor(white: 0.4, alpha: 1)
    text3 = dark ? UIColor(white: 0.45, alpha: 1) : UIColor(white: 0.55, alpha: 1)
    sep = dark ? UIColor(white: 1, alpha: 0.06) : UIColor(white: 0, alpha: 0.06)
    chip = dark ? UIColor(white: 1, alpha: 0.12) : UIColor(white: 0.067, alpha: 0.08)
    placeholder = dark ? UIColor(white: 0.12, alpha: 1) : UIColor(white: 0.93, alpha: 1)
    guard let d = dict else { return }
    if let c = FDPalette.parse(d["bg"]) { bg = c }
    if let c = FDPalette.parse(d["card"]) { card = c }
    if let c = FDPalette.parse(d["text"]) { text = c }
    if let c = FDPalette.parse(d["text2"]) { text2 = c }
    if let c = FDPalette.parse(d["text3"]) { text3 = c }
  }

  static func parse(_ v: Any?) -> UIColor? {
    guard var s = v as? String else { return nil }
    s = s.trimmingCharacters(in: .whitespaces)
    guard s.hasPrefix("#") else { return nil }
    s.removeFirst()
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    guard s.count == 6 || s.count == 8, let n = UInt64(s, radix: 16) else { return nil }
    if s.count == 8 {
      return UIColor(red: CGFloat((n >> 24) & 0xFF) / 255, green: CGFloat((n >> 16) & 0xFF) / 255,
                     blue: CGFloat((n >> 8) & 0xFF) / 255, alpha: CGFloat(n & 0xFF) / 255)
    }
    return UIColor(red: CGFloat((n >> 16) & 0xFF) / 255, green: CGFloat((n >> 8) & 0xFF) / 255,
                   blue: CGFloat(n & 0xFF) / 255, alpha: 1)
  }
}

struct FDLabels {
  private var d: [String: String] = [:]

  init(_ dict: [String: Any]? = nil) {
    guard let dict = dict else { return }
    for (k, v) in dict { if let s = v as? String, !s.isEmpty { d[k] = s } }
  }

  func get(_ k: String, _ def: String) -> String { return d[k] ?? def }

  /// Igual ao formatLikeCount do FeedPost.js.
  func likes(_ n: Int) -> String {
    if n <= 0 { return "" }
    if n == 1 { return get("oneLike", "1 curtida") }
    let word = get("likes", "curtidas")
    if n >= 1_000_000 { return FDLabels.trim(Double(n) / 1_000_000) + "M " + word }
    if n >= 1000 { return FDLabels.trim(Double(n) / 1000) + "K " + word }
    return "\(n) " + word
  }

  func comments(_ n: Int) -> String {
    if n <= 0 { return "" }
    if n == 1 { return get("viewOneComment", "Ver 1 comentário") }
    return get("viewAllComments", "Ver todos os {count} comentários").replacingOccurrences(of: "{count}", with: "\(n)")
  }

  private static func trim(_ v: Double) -> String {
    let s = String(format: "%.1f", v)
    return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
  }
}
