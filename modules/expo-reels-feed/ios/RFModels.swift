import UIKit
import CryptoKit

// [2026-10-15 native-reels] Modelo de um reel vindo do JS (applyItems).
// Todos os campos são opcionais no patch: `apply` só toca nas chaves presentes,
// então `op: "update"` pode mandar só {id, likes, liked}.

struct RFSubtitle {
  let start: Double // segundos
  let end: Double
  let text: String
}

final class RFItem {
  let id: String
  var videoUrl = ""
  var hlsUrl = ""
  var thumb = ""
  var avatar = ""
  var author = ""
  var caption = ""
  var music = ""
  var credit = ""
  var likes = 0
  var comments = 0
  var liked = false
  var saved = false
  var durationMs: Double = 0
  var canGift = false
  var canFollow = false
  var commentsDisabled = false
  /// [2026-10-15 reels-gaps] autor transmitindo agora → anel "ao vivo" no avatar.
  var live = false
  /// [2026-10-16 reels-rail-v2] contadores extras + selo + capa do áudio (JS api ≥ 2).
  var shares = 0
  var saves = 0
  var verified = false
  var musicCover = ""
  var width: Double = 0
  var height: Double = 0
  var subtitles: [RFSubtitle] = []

  init?(_ d: [String: Any]) {
    guard let id = RFItem.str(d["id"]), !id.isEmpty else { return nil }
    self.id = id
    apply(d)
  }

  func apply(_ d: [String: Any]) {
    if d.keys.contains("videoUrl") { videoUrl = RFItem.str(d["videoUrl"]) ?? "" }
    if d.keys.contains("hlsUrl") { hlsUrl = RFItem.str(d["hlsUrl"]) ?? "" }
    if d.keys.contains("thumb") { thumb = RFItem.str(d["thumb"]) ?? "" }
    if d.keys.contains("avatar") { avatar = RFItem.str(d["avatar"]) ?? "" }
    if d.keys.contains("author") { author = RFItem.str(d["author"]) ?? "" }
    if d.keys.contains("caption") { caption = RFItem.str(d["caption"]) ?? "" }
    if d.keys.contains("music") { music = RFItem.str(d["music"]) ?? "" }
    if d.keys.contains("credit") { credit = RFItem.str(d["credit"]) ?? "" }
    if d.keys.contains("likes") { likes = max(0, Int(RFItem.num(d["likes"]))) }
    if d.keys.contains("comments") { comments = max(0, Int(RFItem.num(d["comments"]))) }
    if d.keys.contains("liked") { liked = RFItem.bool(d["liked"]) }
    if d.keys.contains("saved") { saved = RFItem.bool(d["saved"]) }
    if d.keys.contains("durationMs") { durationMs = max(0, RFItem.num(d["durationMs"])) }
    if d.keys.contains("canGift") { canGift = RFItem.bool(d["canGift"]) }
    if d.keys.contains("canFollow") { canFollow = RFItem.bool(d["canFollow"]) }
    if d.keys.contains("commentsDisabled") { commentsDisabled = RFItem.bool(d["commentsDisabled"]) }
    if d.keys.contains("live") { live = RFItem.bool(d["live"]) }
    if d.keys.contains("shares") { shares = max(0, Int(RFItem.num(d["shares"]))) }
    if d.keys.contains("saves") { saves = max(0, Int(RFItem.num(d["saves"]))) }
    if d.keys.contains("verified") { verified = RFItem.bool(d["verified"]) }
    if d.keys.contains("musicCover") { musicCover = RFItem.str(d["musicCover"]) ?? "" }
    if d.keys.contains("width") { width = RFItem.num(d["width"]) }
    if d.keys.contains("height") { height = RFItem.num(d["height"]) }
    if d.keys.contains("subtitles") {
      var out: [RFSubtitle] = []
      if let arr = d["subtitles"] as? [Any] {
        for raw in arr.prefix(600) {
          guard let s = raw as? [String: Any] else { continue }
          let text = RFItem.str(s["text"]) ?? ""
          if text.isEmpty { continue }
          out.append(RFSubtitle(start: RFItem.num(s["start"]), end: RFItem.num(s["end"]), text: text))
        }
      }
      subtitles = out
    }
  }

  /// Chave do que precisa ser recarregado no player (troca de URL = novo AVPlayerItem).
  var mediaKey: String { return hlsUrl + "|" + videoUrl }

  func subtitle(at seconds: Double) -> String {
    if subtitles.isEmpty { return "" }
    for s in subtitles where seconds >= s.start && seconds <= s.end { return s.text }
    return ""
  }

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

  /// URL reproduzível: http(s), file:// ou caminho absoluto.
  static func url(_ s: String) -> URL? {
    if s.isEmpty { return nil }
    if s.hasPrefix("/") { return URL(fileURLWithPath: s) }
    guard let u = URL(string: s), let scheme = u.scheme?.lowercased() else { return nil }
    if scheme == "http" || scheme == "https" || scheme == "file" { return u }
    return nil
  }
}

struct RFLabels {
  var like = "Curtir"
  var comment = "Comentar"
  var gift = "Enviar presente"
  var share = "Compartilhar"
  var save = "Salvar"
  var saved = "Salvo"
  var more = "Mais"
  var mute = "Silenciar"
  var unmute = "Ativar som"
  var follow = "Seguir"
  var seeMore = "mais"
  var error = "Não foi possível reproduzir este vídeo"
  var retry = "Tentar de novo"
  var likers = "Ver curtidas"
  var sound = "Usar este som"
  var live = "AO VIVO"
  /// [2026-10-16 reels-rail-v2] 1 = trilho original (SF Symbols + spinner central);
  /// 2 = trilho novo (ícones de linha do app, contadores, buffer na barra). O JS
  /// só manda 2 com apiVersion ≥ 2 e sem o kill switch __chatyy_reels_rail_v2.
  var railStyle = 1
  /// Formato dos contadores ("{n} mil" / "{n} mi" / vírgula decimal) vindo do i18n.
  var countK = "{n} mil"
  var countM = "{n} mi"
  var decimalSep = ","

  init() {}

  init(_ d: [String: Any]) {
    func pick(_ k: String, _ cur: String) -> String {
      if let s = d[k] as? String, !s.isEmpty { return s }
      return cur
    }
    like = pick("like", like)
    comment = pick("comment", comment)
    gift = pick("gift", gift)
    share = pick("share", share)
    save = pick("save", save)
    saved = pick("saved", saved)
    more = pick("more", more)
    mute = pick("mute", mute)
    unmute = pick("unmute", unmute)
    follow = pick("follow", follow)
    seeMore = pick("seeMore", seeMore)
    error = pick("error", error)
    retry = pick("retry", retry)
    likers = pick("likers", likers)
    sound = pick("sound", sound)
    live = pick("live", live)
    countK = pick("countK", countK)
    countM = pick("countM", countM)
    decimalSep = pick("decimalSep", decimalSep)
    if let n = d["railStyle"] as? NSNumber { railStyle = n.intValue }
  }

  var v2: Bool { return railStyle >= 2 }
}

enum RFFormat {
  /// Igual ao formatCount do JS (1.2K / 3.4M); 0 → "" (o trilho esconde o número).
  static func compact(_ n: Int) -> String {
    if n <= 0 { return "" }
    if n >= 1_000_000 { return trim(Double(n) / 1_000_000) + "M" }
    if n >= 1000 { return trim(Double(n) / 1000) + "K" }
    return String(n)
  }

  /// Trilho v2: sempre mostra o número (0 inclusive), "1,2 mil" / "3,4 mi" no idioma.
  static func count(_ n: Int, _ l: RFLabels) -> String {
    let v = max(0, n)
    if v < 1000 { return String(v) }
    if v >= 1_000_000 {
      return l.countM.replacingOccurrences(of: "{n}", with: trim(Double(v) / 1_000_000).replacingOccurrences(of: ".", with: l.decimalSep))
    }
    // 10 mil+ sem casa decimal (TikTok: "12,3 mil" → "123 mil")
    let k = Double(v) / 1000
    let s = k >= 100 ? String(Int(k)) : trim(k).replacingOccurrences(of: ".", with: l.decimalSep)
    return l.countK.replacingOccurrences(of: "{n}", with: s)
  }

  /// "m:ss" para o rótulo do arrastar.
  static func clock(_ seconds: Double) -> String {
    let t = max(0, Int(seconds.isFinite ? seconds : 0))
    return String(format: "%d:%02d", t / 60, t % 60)
  }

  private static func trim(_ v: Double) -> String {
    let s = String(format: "%.1f", v)
    return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
  }

  static func sha256(_ s: String) -> String {
    return SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

enum RFDisk {
  /// LRU por data de modificação. Roda fora da main.
  static func trim(_ dir: URL, maxBytes: Int64) {
    let fm = FileManager.default
    let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
    guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return }
    var entries: [(URL, Date, Int64)] = []
    var total: Int64 = 0
    for f in files {
      guard let v = try? f.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { continue }
      let size = Int64(v.fileSize ?? 0)
      total += size
      entries.append((f, v.contentModificationDate ?? .distantPast, size))
    }
    if total <= maxBytes { return }
    entries.sort { $0.1 < $1.1 }
    for e in entries {
      if total <= maxBytes * 8 / 10 { break }
      if (try? fm.removeItem(at: e.0)) != nil { total -= e.2 }
    }
  }

  static func touch(_ f: URL) {
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: f.path)
  }
}
