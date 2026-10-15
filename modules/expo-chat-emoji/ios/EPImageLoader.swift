import UIKit
import ImageIO
import CryptoKit

// [2026-10-15 native-emoji] Carregador de figurinhas / GIFs do painel.
//   • memória: NSCache (custo = bytes decodificados), chave uri|maxPixel;
//   • disco: Caches/chatyy-media-viewer/<sha256(uri)> — mesma pasta/chave da
//     lista nativa e do visualizador: figurinha já vista na conversa abre na hora;
//   • decodificação fora da main (ImageIO, downsample p/ a célula);
//     GIF / WebP animado (iOS 14+ decodifica WebP) → UIImage.animatedImage.
final class EPImageLoader {
  static let shared = EPImageLoader()

  private let memory = NSCache<NSString, UIImage>()
  private let decodeQueue = DispatchQueue(label: "br.com.chatyy.emojipanel.decode", qos: .userInitiated, attributes: .concurrent)
  private let session: URLSession
  private let diskDir: URL
  private var waiters: [String: [(UIImage?) -> Void]] = [:] // só na main

  private init() {
    memory.totalCostLimit = 64 * 1024 * 1024
    let cfg = URLSessionConfiguration.default
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = 30
    cfg.httpMaximumConnectionsPerHost = 6
    session = URLSession(configuration: cfg)
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    diskDir = base.appendingPathComponent("chatyy-media-viewer", isDirectory: true)
    try? FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
  }

  func cached(_ uri: String, maxPixel: CGFloat) -> UIImage? {
    if uri.isEmpty { return nil }
    return memory.object(forKey: key(uri, maxPixel) as NSString)
  }

  /// completion SEMPRE na main.
  func load(_ uri: String, maxPixel: CGFloat, completion: @escaping (UIImage?) -> Void) {
    if uri.isEmpty { completion(nil); return }
    let k = key(uri, maxPixel)
    if let img = memory.object(forKey: k as NSString) { completion(img); return }
    if waiters[k] != nil { waiters[k]?.append(completion); return }
    waiters[k] = [completion]
    resolveFile(uri) { [weak self] fileURL in
      guard let self = self else { return }
      guard let fileURL = fileURL else { self.finish(k, nil); return }
      self.decodeQueue.async {
        let img = EPImageLoader.decode(fileURL, maxPixel: maxPixel)
        DispatchQueue.main.async {
          if let img = img { self.memory.setObject(img, forKey: k as NSString, cost: EPImageLoader.cost(img)) }
          self.finish(k, img)
        }
      }
    }
  }

  private func finish(_ k: String, _ img: UIImage?) {
    let cbs = waiters.removeValue(forKey: k) ?? []
    for cb in cbs { cb(img) }
  }

  private func key(_ uri: String, _ maxPixel: CGFloat) -> String { "\(uri)|\(Int(maxPixel))" }

  private func diskURL(_ uri: String) -> URL {
    let digest = SHA256.hash(data: Data(uri.utf8)).map { String(format: "%02x", $0) }.joined()
    return diskDir.appendingPathComponent(digest)
  }

  /// file:// / caminho absoluto direto; http(s) → disco (baixa uma vez).
  private func resolveFile(_ uri: String, completion: @escaping (URL?) -> Void) {
    if uri.hasPrefix("file://") {
      completion(URL(string: uri))
      return
    }
    if uri.hasPrefix("/") {
      completion(URL(fileURLWithPath: uri))
      return
    }
    guard let remote = URL(string: uri), let scheme = remote.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
      completion(nil)
      return
    }
    let dest = diskURL(uri)
    if FileManager.default.fileExists(atPath: dest.path) {
      completion(dest)
      return
    }
    let task = session.downloadTask(with: remote) { tmp, resp, _ in
      var ok: URL? = nil
      if let tmp = tmp, let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
        try? FileManager.default.removeItem(at: dest)
        do {
          try FileManager.default.moveItem(at: tmp, to: dest)
          ok = dest
        } catch {
          ok = nil
        }
      }
      DispatchQueue.main.async { completion(ok) }
    }
    task.resume()
  }

  private static func cost(_ img: UIImage) -> Int {
    let frames = max(1, img.images?.count ?? 1)
    let px = img.size.width * img.scale * img.size.height * img.scale
    return Int(px) * 4 * frames
  }

  private static func decode(_ url: URL, maxPixel: CGFloat) -> UIImage? {
    let opts: [CFString: Any] = [kCGImageSourceShouldCache: false]
    guard let src = CGImageSourceCreateWithURL(url as CFURL, opts as CFDictionary) else { return nil }
    let count = CGImageSourceGetCount(src)
    if count == 0 { return nil }
    let thumbOpts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: max(32, maxPixel),
    ]
    if count > 1 {
      // Animado: limita a 60 quadros (figurinha / GIF curto) p/ não estourar memória.
      let step = count > 60 ? Int((Double(count) / 60.0).rounded(.up)) : 1
      var frames: [UIImage] = []
      var total: Double = 0
      var i = 0
      while i < count {
        if let cg = CGImageSourceCreateThumbnailAtIndex(src, i, thumbOpts as CFDictionary) {
          frames.append(UIImage(cgImage: cg))
          total += frameDelay(src, i) * Double(step)
        }
        i += step
      }
      if frames.count > 1 { return UIImage.animatedImage(with: frames, duration: max(0.1, total)) }
      return frames.first
    }
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, thumbOpts as CFDictionary) else { return nil }
    return UIImage(cgImage: cg)
  }

  private static func frameDelay(_ src: CGImageSource, _ i: Int) -> Double {
    var delay = 0.1
    guard let props = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [String: Any] else { return delay }
    if let gif = props[kCGImagePropertyGIFDictionary as String] as? [String: Any] {
      if let d = (gif[kCGImagePropertyGIFUnclampedDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
      else if let d = (gif[kCGImagePropertyGIFDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
    } else if #available(iOS 14.0, *), let webp = props[kCGImagePropertyWebPDictionary as String] as? [String: Any] {
      if let d = (webp[kCGImagePropertyWebPUnclampedDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
      else if let d = (webp[kCGImagePropertyWebPDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
    } else if let png = props[kCGImagePropertyPNGDictionary as String] as? [String: Any] {
      if let d = (png[kCGImagePropertyAPNGUnclampedDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
      else if let d = (png[kCGImagePropertyAPNGDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
    }
    return delay
  }
}
