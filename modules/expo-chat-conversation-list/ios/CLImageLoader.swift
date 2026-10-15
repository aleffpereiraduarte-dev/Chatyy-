import UIKit
import ImageIO
import CryptoKit

// [2026-10-14 native-home] Carregador de avatar da lista nativa.
// Cópia enxuta do MVImageLoader (expo-media-viewer) — copiado e não movido
// para não acoplar os dois pods. Diferenças: aceita cabeçalho Authorization
// (get_avatar de foto restrita), downsample pequeno fixo (avatar) e teto de
// disco menor.
//   • memória: NSCache (custo = bytes decodificados);
//   • disco: Caches/chatyy-conv-avatars/<sha256(url)>, LRU por mtime, ~80 MB;
//   • decodificação fora da main (ImageIO, orientação EXIF aplicada).
// Fontes: file:// / caminho absoluto, data:image/...;base64, http(s).
final class CLImageLoader {
  static let shared = CLImageLoader()

  static let avatarMaxPixel: CGFloat = 192

  /// Bearer da sessão (prop `authToken` da view). Só vai para URLs marcadas `a`.
  var authToken: String = ""

  private let memory = NSCache<NSString, UIImage>()
  private let decodeQueue = DispatchQueue(label: "br.com.chatyy.convlist.decode", qos: .userInitiated, attributes: .concurrent)
  private let session: URLSession
  private let diskDir: URL
  // Acessado só na main.
  private var waiters: [String: [(UIImage?) -> Void]] = [:]
  private var failedAt: [String: Date] = [:]
  private var trimmed = false

  private init() {
    memory.totalCostLimit = 40 * 1024 * 1024
    let cfg = URLSessionConfiguration.default
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = 20
    cfg.httpMaximumConnectionsPerHost = 6
    session = URLSession(configuration: cfg)
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    diskDir = base.appendingPathComponent("chatyy-conv-avatars", isDirectory: true)
    try? FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
  }

  func cachedImage(_ uri: String) -> UIImage? {
    if uri.isEmpty { return nil }
    return memory.object(forKey: uri as NSString)
  }

  /// completion SEMPRE na main.
  func load(_ uri: String, auth: Bool, completion: @escaping (UIImage?) -> Void) {
    if uri.isEmpty { completion(nil); return }
    if let img = memory.object(forKey: uri as NSString) { completion(img); return }
    // Falhou há pouco (404/offline): não martela o servidor a cada reuso de célula.
    if let t = failedAt[uri], Date().timeIntervalSince(t) < 30 { completion(nil); return }
    if waiters[uri] != nil {
      waiters[uri]?.append(completion)
      return
    }
    waiters[uri] = [completion]
    trimDiskOnce()
    let token = auth ? authToken : ""
    resolveSource(uri, token: token) { [weak self] source in
      guard let self = self else { return }
      guard let source = source else { self.finish(uri, nil); return }
      self.decodeQueue.async {
        let img = CLImageLoader.decode(source, maxPixel: CLImageLoader.avatarMaxPixel)
        DispatchQueue.main.async {
          if let img = img {
            self.memory.setObject(img, forKey: uri as NSString, cost: CLImageLoader.cost(img))
          }
          self.finish(uri, img)
        }
      }
    }
  }

  func clearMemory() {
    memory.removeAllObjects()
    failedAt.removeAll()
  }

  // MARK: - Internals

  private func finish(_ k: String, _ img: UIImage?) {
    if img == nil { failedAt[k] = Date() } else { failedAt.removeValue(forKey: k) }
    let list = waiters.removeValue(forKey: k) ?? []
    for cb in list { cb(img) }
  }

  private enum Source {
    case file(URL)
    case data(Data)
  }

  private static func existingFileURL(_ uri: String) -> URL? {
    var path: String? = nil
    if uri.hasPrefix("file://") {
      path = URL(string: uri)?.path ?? String(uri.dropFirst(7)).removingPercentEncoding
    } else if uri.hasPrefix("/") {
      path = uri
    }
    guard let p = path, !p.isEmpty, FileManager.default.fileExists(atPath: p) else { return nil }
    return URL(fileURLWithPath: p)
  }

  private static func remoteURL(_ uri: String) -> URL? {
    guard uri.hasPrefix("http://") || uri.hasPrefix("https://") else { return nil }
    if let u = URL(string: uri) { return u }
    if let enc = uri.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { return URL(string: enc) }
    return nil
  }

  /// Resolve a fonte para arquivo local ou bytes; callback na main.
  private func resolveSource(_ uri: String, token: String, _ done: @escaping (Source?) -> Void) {
    if uri.hasPrefix("data:") {
      decodeQueue.async {
        let d = CLImageLoader.dataFromDataURI(uri)
        DispatchQueue.main.async { done(d.map { Source.data($0) }) }
      }
      return
    }
    if let f = CLImageLoader.existingFileURL(uri) {
      done(.file(f))
      return
    }
    guard let remote = CLImageLoader.remoteURL(uri) else { done(nil); return }
    let dest = diskDir.appendingPathComponent(CLImageLoader.sha256(uri))
    if FileManager.default.fileExists(atPath: dest.path) {
      try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: dest.path)
      done(.file(dest))
      return
    }
    var req = URLRequest(url: remote)
    req.timeoutInterval = 20
    if !token.isEmpty {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    let task = session.downloadTask(with: req) { tmp, resp, err in
      var ok = false
      if err == nil, let tmp = tmp {
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 200
        if (200..<300).contains(status) {
          try? FileManager.default.removeItem(at: dest)
          do {
            try FileManager.default.moveItem(at: tmp, to: dest)
            ok = true
          } catch {
            ok = false
          }
        }
      }
      DispatchQueue.main.async { done(ok ? .file(dest) : nil) }
    }
    task.priority = URLSessionTask.highPriority
    task.resume()
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

  private static func decode(_ source: Source, maxPixel: CGFloat) -> UIImage? {
    let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
    let src: CGImageSource?
    switch source {
    case .file(let url): src = CGImageSourceCreateWithURL(url as CFURL, srcOpts)
    case .data(let d): src = CGImageSourceCreateWithData(d as CFData, srcOpts)
    }
    guard let s = src, CGImageSourceGetCount(s) > 0 else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: Int(maxPixel),
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(s, 0, opts as CFDictionary) else { return nil }
    return UIImage(cgImage: cg, scale: 1, orientation: .up)
  }

  private static func cost(_ img: UIImage) -> Int {
    guard let cg = img.cgImage else { return 1 }
    return cg.bytesPerRow * cg.height
  }

  private static func sha256(_ s: String) -> String {
    let digest = SHA256.hash(data: Data(s.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  private func trimDiskOnce() {
    if trimmed { return }
    trimmed = true
    let dir = diskDir
    DispatchQueue.global(qos: .utility).async {
      let fm = FileManager.default
      let keys: [URLResourceKey] = [.contentModificationDateKey, .totalFileAllocatedSizeKey, .fileSizeKey]
      guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
      var entries: [(URL, Date, Int)] = []
      var total = 0
      for f in files {
        let v = try? f.resourceValues(forKeys: Set(keys))
        let size = v?.totalFileAllocatedSize ?? v?.fileSize ?? 0
        entries.append((f, v?.contentModificationDate ?? .distantPast, size))
        total += size
      }
      let cap = 80 * 1024 * 1024
      if total <= cap { return }
      entries.sort { $0.1 < $1.1 }
      for (url, _, size) in entries {
        if total <= cap * 3 / 4 { break }
        try? fm.removeItem(at: url)
        total -= size
      }
    }
  }
}
