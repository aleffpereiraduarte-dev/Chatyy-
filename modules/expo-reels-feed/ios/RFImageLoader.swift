import UIKit
import ImageIO

// [2026-10-15 native-reels] Capas e avatares do feed.
//   • memória: NSCache (custo = bytes decodificados);
//   • disco: Caches/chatyy-reels-img/<sha256(url)> (LRU ~120 MB);
//   • decodificação fora da main via ImageIO (downsample + orientação EXIF).
// Toda a API pública é chamada na main; completion SEMPRE na main.
final class RFImageLoader {
  static let shared = RFImageLoader()

  private let memory = NSCache<NSString, UIImage>()
  private let decodeQueue = DispatchQueue(label: "br.com.chatyy.reels.img", qos: .userInitiated, attributes: .concurrent)
  private let session: URLSession
  private let diskDir: URL
  private var waiters: [String: [(UIImage?) -> Void]] = [:]
  private var trimmed = false
  /// Bearer p/ get_avatar do nosso host (foto restrita "meus contatos").
  var authHeaders: [String: String] = [:]

  private init() {
    memory.totalCostLimit = 72 * 1024 * 1024
    let cfg = URLSessionConfiguration.default
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = 20
    cfg.httpMaximumConnectionsPerHost = 4
    session = URLSession(configuration: cfg)
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    diskDir = base.appendingPathComponent("chatyy-reels-img", isDirectory: true)
    try? FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
  }

  func cached(_ uri: String, maxPixel: CGFloat) -> UIImage? {
    if uri.isEmpty { return nil }
    return memory.object(forKey: key(uri, maxPixel) as NSString)
  }

  func load(_ uri: String, maxPixel: CGFloat, completion: @escaping (UIImage?) -> Void) {
    if uri.isEmpty { completion(nil); return }
    let k = key(uri, maxPixel)
    if let img = memory.object(forKey: k as NSString) { completion(img); return }
    if waiters[k] != nil {
      waiters[k]?.append(completion)
      return
    }
    waiters[k] = [completion]
    trimOnce()
    fetchFile(uri) { [weak self] file in
      guard let self = self else { return }
      guard let file = file else { self.finish(k, nil); return }
      self.decodeQueue.async {
        let img = RFImageLoader.decode(file, maxPixel: maxPixel)
        DispatchQueue.main.async {
          if let img = img {
            let px = img.size.width * img.scale * img.size.height * img.scale
            self.memory.setObject(img, forKey: k as NSString, cost: Int(px * 4))
          }
          self.finish(k, img)
        }
      }
    }
  }

  func prefetch(_ uri: String, maxPixel: CGFloat) {
    if uri.isEmpty || cached(uri, maxPixel: maxPixel) != nil { return }
    load(uri, maxPixel: maxPixel) { _ in }
  }

  // MARK: - Internals

  private func key(_ uri: String, _ maxPixel: CGFloat) -> String {
    return "\(Int(maxPixel))|\(uri)"
  }

  private func finish(_ k: String, _ img: UIImage?) {
    let list = waiters.removeValue(forKey: k) ?? []
    for cb in list { cb(img) }
  }

  private func trimOnce() {
    if trimmed { return }
    trimmed = true
    let dir = diskDir
    DispatchQueue.global(qos: .utility).async { RFDisk.trim(dir, maxBytes: 120 * 1024 * 1024) }
  }

  /// Resolve para arquivo local; callback na main.
  private func fetchFile(_ uri: String, _ done: @escaping (URL?) -> Void) {
    guard let u = RFItem.url(uri) else { done(nil); return }
    if u.isFileURL {
      done(FileManager.default.fileExists(atPath: u.path) ? u : nil)
      return
    }
    let dest = diskDir.appendingPathComponent(RFFormat.sha256(uri))
    if FileManager.default.fileExists(atPath: dest.path) {
      RFDisk.touch(dest)
      done(dest)
      return
    }
    var req = URLRequest(url: u)
    if !authHeaders.isEmpty, RFImageLoader.needsAuth(u) {
      for (k, v) in authHeaders { req.setValue(v, forHTTPHeaderField: k) }
    }
    let task = session.downloadTask(with: req) { tmp, resp, err in
      var ok = false
      if err == nil, let tmp = tmp {
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 200
        if (200..<300).contains(status) {
          try? FileManager.default.removeItem(at: dest)
          ok = (try? FileManager.default.moveItem(at: tmp, to: dest)) != nil
        }
      }
      DispatchQueue.main.async { done(ok ? dest : nil) }
    }
    task.priority = URLSessionTask.highPriority
    task.resume()
  }

  static func needsAuth(_ u: URL) -> Bool {
    guard u.scheme?.lowercased() == "https", let host = u.host?.lowercased() else { return false }
    let ours = host == "chatyy.com.br" || host.hasSuffix(".chatyy.com.br")
    return ours && u.absoluteString.contains("get_avatar")
  }

  static func decode(_ url: URL, maxPixel: CGFloat) -> UIImage? {
    let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let src = CGImageSourceCreateWithURL(url as CFURL, srcOpts) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
    return UIImage(cgImage: cg)
  }
}
