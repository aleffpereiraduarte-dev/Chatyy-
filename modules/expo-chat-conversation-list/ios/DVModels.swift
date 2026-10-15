import UIKit
import ImageIO
import CryptoKit

// [2026-10-15 native-drive] Modelos da lista de ARQUIVOS nativa
// (ChatyyDriveList): app/drive.js e app/files.js. Mesmo contrato do Android
// (DVModels.kt). Linhas PLANAS vindas de components/native/driveListAdapter.js:
//   seção → { id, k: 's', t }
//   item  → { id, k: 'r', t, sb, gl, bd, th, vd, st, sh, wn, wu, cv, sw, sl, mn, sel, a11y }
// Ações (sw/sl/mn = "a,b,c"): open | download | share | rename | move | star |
// delete | restore | purge | more. Títulos vêm da prop `labels`.

struct DVRow {
  var id: String = ""
  var kind: String = "r"
  var title: String = ""
  var sub: String = ""
  var glyph: String = "file"
  var badge: String = ""
  var thumb: String = ""
  var video = false
  var starred = false
  var shared = false
  var warn: String = ""
  var warnUrgent = false
  var chevron = false
  var swipe: [String] = []
  var swipeLeft: [String] = []
  var menu: [String] = []
  var selectable = true
  var a11y: String = ""

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    kind = CLVal.str(d["k"])
    if kind.isEmpty { kind = "r" }
    title = CLVal.str(d["t"])
    sub = CLVal.str(d["sb"])
    glyph = CLVal.str(d["gl"])
    if glyph.isEmpty { glyph = "file" }
    badge = CLVal.str(d["bd"])
    thumb = CLVal.str(d["th"])
    video = CLVal.bool(d["vd"])
    starred = CLVal.bool(d["st"])
    shared = CLVal.bool(d["sh"])
    warn = CLVal.str(d["wn"])
    warnUrgent = CLVal.bool(d["wu"])
    chevron = CLVal.bool(d["cv"])
    swipe = DVRow.list(d["sw"])
    swipeLeft = DVRow.list(d["sl"])
    menu = DVRow.list(d["mn"])
    selectable = d["sel"] == nil ? true : CLVal.bool(d["sel"])
    a11y = CLVal.str(d["a11y"])
  }

  static func list(_ v: Any?) -> [String] {
    let s = CLVal.str(v)
    if s.isEmpty { return [] }
    return s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
  }

  var isSection: Bool { kind == "s" }
  var isFolder: Bool { glyph == "folder" }
}

struct DVStyle {
  var colors = CTColors()
  var card: UIColor = .white
  var selBg: UIColor = UIColor(white: 0, alpha: 0.06)
  var tokens: [String] = []
  var selectionMode = false
  var selected = Set<String>()
}

/// Títulos das ações (i18n da tela) com padrão pt-BR.
struct DVLabels {
  var map: [String: String] = [:]

  init(_ d: [String: Any]? = nil) {
    for (k, v) in d ?? [:] {
      let s = CLVal.str(v)
      if !s.isEmpty { map[k] = s }
    }
  }

  func get(_ k: String, _ def: String) -> String { map[k] ?? def }

  func action(_ a: String, starred: Bool) -> String {
    switch a {
    case "open": return get("open", "Abrir")
    case "download": return get("download", "Baixar")
    case "share": return get("share", "Compartilhar")
    case "rename": return get("rename", "Renomear")
    case "move": return get("move", "Mover para...")
    case "star": return starred ? get("unstar", "Desfavoritar") : get("star", "Favoritar")
    case "delete": return get("delete", "Excluir")
    case "restore": return get("restore", "Restaurar")
    case "purge": return get("purge", "Excluir permanentemente")
    case "more": return get("more", "Mais")
    default: return get(a, a)
    }
  }
}

enum DVGlyphs {
  /// Glifo do tipo → SF Symbol (traço fino, P&B).
  static func symbol(_ g: String) -> String {
    switch g {
    case "folder": return "folder.fill"
    case "image": return "photo"
    case "video": return "film"
    case "audio": return "music.note"
    case "pdf": return "doc.richtext"
    case "doc": return "doc.text"
    case "sheet": return "tablecells"
    case "slides": return "rectangle.on.rectangle"
    case "zip": return "archivebox"
    case "code": return "chevron.left.forwardslash.chevron.right"
    case "text": return "text.alignleft"
    default: return "doc"
    }
  }

  static func actionSymbol(_ a: String, starred: Bool) -> String {
    switch a {
    case "open": return "eye"
    case "download": return "arrow.down.circle"
    case "share": return "person.crop.circle.badge.plus"
    case "rename": return "pencil"
    case "move": return "folder"
    case "star": return starred ? "star.slash" : "star"
    case "delete": return "trash"
    case "restore": return "arrow.uturn.backward"
    case "purge": return "trash"
    case "more": return "ellipsis.circle"
    default: return "circle"
    }
  }

  static func isDestructive(_ a: String) -> Bool { a == "delete" || a == "purge" }

  static func image(_ name: String, size: CGFloat, weight: UIImage.SymbolWeight = .regular, color: UIColor) -> UIImage? {
    return CLSymbols.image(name, pointSize: size, weight: weight, color: color)
  }
}

// MARK: - Miniaturas (cache em disco)

/// Miniaturas do Drive. Cópia enxuta do CLImageLoader (avatar, 192 px) com
/// tamanho maior e o JPEG JÁ REDUZIDO no disco (não o original de vários MB):
///   • memória: NSCache (custo = bytes decodificados), chave = url + px;
///   • disco: Caches/chatyy-drive-thumbs/<sha256(url sem token + px)>.jpg,
///     LRU por mtime (~150 MB → 100 MB);
///   • download em arquivo temporário (downloadTask) + ImageIO fora da main.
/// A chave ignora `token`/`dl` da URL: o mesmo arquivo não baixa de novo
/// quando o bearer gira.
final class DVThumbLoader {
  static let shared = DVThumbLoader()

  private let memory = NSCache<NSString, UIImage>()
  private let io = DispatchQueue(label: "br.com.chatyy.drive.thumbs", qos: .userInitiated, attributes: .concurrent)
  private let session: URLSession
  private let diskDir: URL
  // Acessados só na main.
  private var waiters: [String: [(UIImage?) -> Void]] = [:]
  private var failedAt: [String: Date] = [:]
  private var trimmed = false

  private init() {
    memory.totalCostLimit = 60 * 1024 * 1024
    let cfg = URLSessionConfiguration.default
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = 30
    cfg.httpMaximumConnectionsPerHost = 4
    session = URLSession(configuration: cfg)
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    diskDir = base.appendingPathComponent("chatyy-drive-thumbs", isDirectory: true)
    try? FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
  }

  static func cacheKey(_ uri: String, px: Int) -> String {
    var norm = uri
    if uri.hasPrefix("http"), var comps = URLComponents(string: uri) {
      if let items = comps.queryItems {
        let kept = items.filter { $0.name != "token" && $0.name != "dl" }
        comps.queryItems = kept.isEmpty ? nil : kept
      }
      norm = comps.string ?? uri
    }
    return "\(norm)#\(px)"
  }

  func cached(_ uri: String, px: Int) -> UIImage? {
    if uri.isEmpty { return nil }
    return memory.object(forKey: DVThumbLoader.cacheKey(uri, px: px) as NSString)
  }

  /// completion SEMPRE na main.
  func load(_ uri: String, px: Int, completion: @escaping (UIImage?) -> Void) {
    if uri.isEmpty { completion(nil); return }
    let key = DVThumbLoader.cacheKey(uri, px: px)
    if let img = memory.object(forKey: key as NSString) { completion(img); return }
    if let t = failedAt[key], Date().timeIntervalSince(t) < 30 { completion(nil); return }
    if waiters[key] != nil {
      waiters[key]?.append(completion)
      return
    }
    waiters[key] = [completion]
    trimDiskOnce()
    let diskURL = diskDir.appendingPathComponent(DVThumbLoader.sha256(key) + ".jpg")
    io.async { [weak self] in
      guard let self = self else { return }
      // 1) disco
      if FileManager.default.fileExists(atPath: diskURL.path),
         let img = DVThumbLoader.decode(fileURL: diskURL, maxPixel: CGFloat(px)) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: diskURL.path)
        DispatchQueue.main.async { self.store(key, img) }
        return
      }
      // 2) arquivo local / data URI
      if let local = DVThumbLoader.localURL(uri) {
        let img = DVThumbLoader.decode(fileURL: local, maxPixel: CGFloat(px))
        DispatchQueue.main.async { self.store(key, img) }
        return
      }
      if uri.hasPrefix("data:") {
        var img: UIImage? = nil
        if let data = DVThumbLoader.dataFromDataURI(uri) { img = DVThumbLoader.decode(data: data, maxPixel: CGFloat(px)) }
        DispatchQueue.main.async { self.store(key, img) }
        return
      }
      // 3) rede → arquivo temporário → reduz → JPEG no disco
      guard uri.hasPrefix("http://") || uri.hasPrefix("https://"), let url = URL(string: uri) else {
        DispatchQueue.main.async { self.store(key, nil) }
        return
      }
      var req = URLRequest(url: url)
      req.setValue("image/*,*/*;q=0.8", forHTTPHeaderField: "Accept")
      let task = self.session.downloadTask(with: req) { tmp, resp, _ in
        var img: UIImage? = nil
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if let tmp = tmp, (200..<300).contains(code) {
          img = DVThumbLoader.decode(fileURL: tmp, maxPixel: CGFloat(px))
          if let i = img, let jpg = i.jpegData(compressionQuality: 0.82) {
            try? jpg.write(to: diskURL, options: .atomic)
          }
        }
        DispatchQueue.main.async { self.store(key, img) }
      }
      task.resume()
    }
  }

  func clearMemory() {
    memory.removeAllObjects()
    failedAt.removeAll()
  }

  private func store(_ key: String, _ img: UIImage?) {
    if let img = img {
      memory.setObject(img, forKey: key as NSString, cost: DVThumbLoader.cost(img))
      failedAt.removeValue(forKey: key)
    } else {
      failedAt[key] = Date()
    }
    let list = waiters.removeValue(forKey: key) ?? []
    for cb in list { cb(img) }
  }

  private static func localURL(_ uri: String) -> URL? {
    var path: String? = nil
    if uri.hasPrefix("file://") {
      path = URL(string: uri)?.path ?? String(uri.dropFirst(7)).removingPercentEncoding
    } else if uri.hasPrefix("/") {
      path = uri
    }
    guard let p = path, FileManager.default.fileExists(atPath: p) else { return nil }
    return URL(fileURLWithPath: p)
  }

  private static func dataFromDataURI(_ uri: String) -> Data? {
    guard let comma = uri.firstIndex(of: ",") else { return nil }
    let header = uri[uri.startIndex..<comma]
    let payload = String(uri[uri.index(after: comma)...])
    if header.contains(";base64") {
      return Data(base64Encoded: payload, options: .ignoreUnknownCharacters)
    }
    return payload.removingPercentEncoding?.data(using: .utf8)
  }

  private static func thumbnail(_ s: CGImageSource, maxPixel: CGFloat) -> UIImage? {
    guard CGImageSourceGetCount(s) > 0 else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: Int(maxPixel),
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(s, 0, opts as CFDictionary) else { return nil }
    return UIImage(cgImage: cg, scale: 1, orientation: .up)
  }

  private static func decode(fileURL: URL, maxPixel: CGFloat) -> UIImage? {
    let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let s = CGImageSourceCreateWithURL(fileURL as CFURL, srcOpts) else { return nil }
    return thumbnail(s, maxPixel: maxPixel)
  }

  private static func decode(data: Data, maxPixel: CGFloat) -> UIImage? {
    let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let s = CGImageSourceCreateWithData(data as CFData, srcOpts) else { return nil }
    return thumbnail(s, maxPixel: maxPixel)
  }

  private static func cost(_ img: UIImage) -> Int {
    guard let cg = img.cgImage else { return 1 }
    return cg.bytesPerRow * cg.height
  }

  private static func sha256(_ s: String) -> String {
    let d = SHA256.hash(data: Data(s.utf8))
    return d.map { String(format: "%02x", $0) }.joined()
  }

  private func trimDiskOnce() {
    if trimmed { return }
    trimmed = true
    let dir = diskDir
    io.async {
      let fm = FileManager.default
      let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
      guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return }
      var entries: [(URL, Date, Int)] = []
      var total = 0
      for f in files {
        let v = try? f.resourceValues(forKeys: Set(keys))
        let size = v?.fileSize ?? 0
        total += size
        entries.append((f, v?.contentModificationDate ?? .distantPast, size))
      }
      if total <= 150 * 1024 * 1024 { return }
      entries.sort { $0.1 < $1.1 }
      for (url, _, size) in entries {
        if total <= 100 * 1024 * 1024 { break }
        try? fm.removeItem(at: url)
        total -= size
      }
    }
  }
}
