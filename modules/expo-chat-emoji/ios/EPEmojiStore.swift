import UIKit

// [2026-10-15 native-emoji] Catálogo de emoji (EPEmojiData), recentes e tom de
// pele preferido (UserDefaults "chatyy_emoji_panel.*"), busca por nome.

struct EPEmoji {
  let base: String
  let tone: Bool
  let name: String
  let words: [String]
}

final class EPEmojiStore {
  static let shared = EPEmojiStore()
  static let categoryCount = 8
  static let tones: [UInt32] = [0x1F3FB, 0x1F3FC, 0x1F3FD, 0x1F3FE, 0x1F3FF]

  private(set) var categories: [[EPEmoji]] = Array(repeating: [], count: EPEmojiStore.categoryCount)
  private var byBase: [String: EPEmoji] = [:]
  private(set) var recents: [String] = []
  private var preferredTone: [String: String] = [:] // base → variante escolhida
  private var loaded = false

  private let recentsKey = "chatyy_emoji_panel.recents"
  private let tonesKey = "chatyy_emoji_panel.tones"
  private let maxRecents = 32

  private init() {}

  func loadIfNeeded() {
    if loaded { return }
    loaded = true
    let maxVer: Int
    if #available(iOS 16.4, *) { maxVer = 150 }
    else if #available(iOS 15.4, *) { maxVer = 140 }
    else { maxVer = 131 }
    var cats: [[EPEmoji]] = Array(repeating: [], count: EPEmojiStore.categoryCount)
    for chunk in EPEmojiData.chunks {
      for line in chunk.split(separator: "\n", omittingEmptySubsequences: true) {
        let parts = line.split(separator: "\t", maxSplits: 4, omittingEmptySubsequences: false)
        if parts.count < 5 { continue }
        guard let cat = Int(parts[0]), cat >= 0, cat < EPEmojiStore.categoryCount else { continue }
        guard let ver = Int(parts[3]), ver <= maxVer else { continue }
        let base = String(parts[1])
        let name = String(parts[4]).lowercased()
        let words = name
          .replacingOccurrences(of: ":", with: " ")
          .replacingOccurrences(of: "-", with: " ")
          .split(separator: " ")
          .map { String($0) }
        let e = EPEmoji(base: base, tone: parts[2] == "1", name: name, words: words)
        cats[cat].append(e)
        byBase[base] = e
      }
    }
    categories = cats
    let d = UserDefaults.standard
    recents = (d.array(forKey: recentsKey) as? [String]) ?? []
    preferredTone = (d.dictionary(forKey: tonesKey) as? [String: String]) ?? [:]
  }

  func emoji(forBase base: String) -> EPEmoji? { byBase[base] }

  /// Emoji a inserir (com o tom preferido aplicado, se houver).
  func display(_ e: EPEmoji) -> String {
    if e.tone, let v = preferredTone[e.base] { return v }
    return e.base
  }

  /// Base de um emoji com tom (p/ recentes / busca do preferido).
  func baseOf(_ s: String) -> String {
    var scalars = Array(s.unicodeScalars)
    scalars.removeAll { EPEmojiStore.tones.contains($0.value) }
    let stripped = String(String.UnicodeScalarView(scalars))
    if byBase[stripped] != nil { return stripped }
    // tom removia também o FE0F do 1º code point (ex.: ☝️)
    if scalars.count >= 1 {
      var withVS = scalars
      if let vs = Unicode.Scalar(UInt32(0xFE0F)) { withVS.insert(vs, at: 1) }
      let s2 = String(String.UnicodeScalarView(withVS))
      if byBase[s2] != nil { return s2 }
    }
    return stripped
  }

  static func variant(_ base: String, tone: UInt32) -> String {
    var scalars = Array(base.unicodeScalars)
    if scalars.count > 1 && scalars[1].value == 0xFE0F { scalars.remove(at: 1) }
    if let t = Unicode.Scalar(tone) { scalars.insert(t, at: min(1, scalars.count)) }
    return String(String.UnicodeScalarView(scalars))
  }

  func variants(_ e: EPEmoji) -> [String] {
    return [e.base] + EPEmojiStore.tones.map { EPEmojiStore.variant(e.base, tone: $0) }
  }

  func setPreferred(_ variant: String, for base: String) {
    if variant == base { preferredTone.removeValue(forKey: base) } else { preferredTone[base] = variant }
    UserDefaults.standard.set(preferredTone, forKey: tonesKey)
  }

  func pushRecent(_ s: String) {
    recents.removeAll { $0 == s || baseOf($0) == baseOf(s) }
    recents.insert(s, at: 0)
    if recents.count > maxRecents { recents = Array(recents.prefix(maxRecents)) }
    UserDefaults.standard.set(recents, forKey: recentsKey)
  }

  /// Todas as palavras da busca precisam ser prefixo de alguma palavra do nome
  /// (ou o nome conter a busca inteira).
  func search(_ query: String, limit: Int = 120) -> [EPEmoji] {
    let q = query.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    if q.isEmpty { return [] }
    let tokens = q.split(separator: " ").map { String($0) }
    var out: [EPEmoji] = []
    var seen = Set<String>()
    for cat in categories {
      for e in cat {
        if seen.contains(e.base) { continue }
        var ok = true
        for t in tokens where !e.words.contains(where: { $0.hasPrefix(t) }) { ok = false; break }
        if !ok && e.name.contains(q) { ok = true }
        if ok {
          out.append(e)
          seen.insert(e.base)
          if out.count >= limit { return out }
        }
      }
    }
    return out
  }
}
