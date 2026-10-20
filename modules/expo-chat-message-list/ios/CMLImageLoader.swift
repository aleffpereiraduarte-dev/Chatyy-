import UIKit
import ImageIO
import CoreImage
import CryptoKit

// [2026-10-14 native-list] Carregador de imagem das células.
//   • memória: NSCache (custo = bytes decodificados), chave uri|maxPixel;
//   • disco: Caches/chatyy-media-viewer/<sha256(uri)> — MESMA pasta/chave do
//     visualizador nativo (expo-media-viewer): o que a lista baixou abre
//     instantâneo no viewer e vice-versa;
//   • decodificação SEMPRE fora da main (ImageIO, downsample p/ o tamanho da
//     célula + orientação EXIF); GIF animado → UIImage.animatedImage.
// Fontes: file:// / caminho absoluto, data:image/...;base64, http(s).
final class CMLImageLoader {
  static let shared = CMLImageLoader()

  private let memory = NSCache<NSString, UIImage>()
  private let decodeQueue = DispatchQueue(label: "br.com.chatyy.messagelist.decode", qos: .userInitiated, attributes: .concurrent)
  private let session: URLSession
  private let diskDir: URL
  private var waiters: [String: [(UIImage?) -> Void]] = [:] // só na main
  private var downloads: [String: [(URL?) -> Void]] = [:]   // só na main

  private init() {
    memory.totalCostLimit = 96 * 1024 * 1024
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

  func cached(_ uri: String, maxPixel: CGFloat, animated: Bool = false) -> UIImage? {
    if uri.isEmpty { return nil }
    return memory.object(forKey: key(uri, maxPixel, animated) as NSString)
  }

  /// completion SEMPRE na main.
  func load(_ uri: String, maxPixel: CGFloat, animated: Bool = false, completion: @escaping (UIImage?) -> Void) {
    if uri.isEmpty { completion(nil); return }
    let k = key(uri, maxPixel, animated)
    if let img = memory.object(forKey: k as NSString) { completion(img); return }
    if waiters[k] != nil { waiters[k]?.append(completion); return }
    waiters[k] = [completion]
    resolve(uri) { [weak self] src in
      guard let self = self else { return }
      guard let src = src else { self.finish(k, nil); return }
      self.decodeQueue.async {
        let img = CMLImageLoader.decode(src, maxPixel: maxPixel, animated: animated)
        DispatchQueue.main.async {
          if let img = img { self.memory.setObject(img, forKey: k as NSString, cost: CMLImageLoader.cost(img)) }
          self.finish(k, img)
        }
      }
    }
  }

  func prefetch(_ uri: String, maxPixel: CGFloat, animated: Bool = false) {
    load(uri, maxPixel: maxPixel, animated: animated) { _ in }
  }

  // [2026-10-18 lqip] miniatura (LQIP) com desfoque gaussiano: nunca "pixelada".
  // Blur na imagem pequena (64 px), fora da main, cacheado na mesma NSCache.
  private static let ciContext = CIContext(options: nil)

  func cachedBlurred(_ uri: String) -> UIImage? {
    if uri.isEmpty { return nil }
    return memory.object(forKey: ("blur|" + uri) as NSString)
  }

  /// completion SEMPRE na main.
  func loadBlurred(_ uri: String, completion: @escaping (UIImage?) -> Void) {
    if uri.isEmpty { completion(nil); return }
    let bk = "blur|" + uri
    if let img = memory.object(forKey: bk as NSString) { completion(img); return }
    load(uri, maxPixel: 96) { [weak self] small in
      guard let self = self, let small = small else { completion(nil); return }
      if let img = self.memory.object(forKey: bk as NSString) { completion(img); return }
      self.decodeQueue.async {
        let out = CMLImageLoader.blur(small) ?? small
        DispatchQueue.main.async {
          self.memory.setObject(out, forKey: bk as NSString, cost: CMLImageLoader.cost(out))
          completion(out)
        }
      }
    }
  }

  private static func blur(_ img: UIImage) -> UIImage? {
    guard let cg = img.cgImage else { return nil }
    let side = CGFloat(max(cg.width, cg.height))
    if side < 1 { return nil }
    let s: CGFloat = 64 / side
    let ci = CIImage(cgImage: cg).transformed(by: CGAffineTransform(scaleX: s, y: s))
    let extent = ci.extent.integral
    guard let f = CIFilter(name: "CIGaussianBlur") else { return nil }
    f.setValue(ci.clampedToExtent(), forKey: kCIInputImageKey)
    f.setValue(3.0, forKey: kCIInputRadiusKey)
    guard let out = f.outputImage?.cropped(to: extent) else { return nil }
    guard let res = ciContext.createCGImage(out, from: extent) else { return nil }
    return UIImage(cgImage: res, scale: 1, orientation: .up)
  }

  // [2026-10-19 sticker-anim] decodificação animada tem chave PRÓPRIA: antes o
  // prefetch (estático, mesma chave) deixava GIF/figurinha parada no 1º quadro.
  private func key(_ uri: String, _ maxPixel: CGFloat, _ animated: Bool = false) -> String {
    return animated ? "\(Int(maxPixel))|a|\(uri)" : "\(Int(maxPixel))|\(uri)"
  }

  private func finish(_ k: String, _ img: UIImage?) {
    let list = waiters.removeValue(forKey: k) ?? []
    for cb in list { cb(img) }
  }

  private enum Source { case file(URL), data(Data) }

  private func resolve(_ uri: String, _ done: @escaping (Source?) -> Void) {
    if uri.hasPrefix("data:") {
      decodeQueue.async {
        let d = CMLImageLoader.dataFromDataURI(uri)
        DispatchQueue.main.async { done(d.map { Source.data($0) }) }
      }
      return
    }
    if let f = CMLImageLoader.fileURL(uri) { done(.file(f)); return }
    guard let remote = CMLImageLoader.remoteURL(uri) else { done(nil); return }
    // [native-media-dl] chave SEM exp/sig (mesma regra do MVImageLoader do viewer):
    // a URL assinada do CDN muda a cada janela, o arquivo não.
    let dest = diskDir.appendingPathComponent(CMLImageLoader.sha256(CMLImageLoader.stableURI(uri)))
    if FileManager.default.fileExists(atPath: dest.path) { done(.file(dest)); return }
    let legacy = diskDir.appendingPathComponent(CMLImageLoader.sha256(uri))
    if FileManager.default.fileExists(atPath: legacy.path) { done(.file(legacy)); return }
    if downloads[uri] != nil {
      downloads[uri]?.append { u in done(u.map { Source.file($0) }) }
      return
    }
    downloads[uri] = [{ u in done(u.map { Source.file($0) }) }]
    let task = session.downloadTask(with: remote) { [weak self] tmp, resp, err in
      var ok = false
      if err == nil, let tmp = tmp {
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 200
        if (200..<300).contains(status) {
          try? FileManager.default.removeItem(at: dest)
          ok = (try? FileManager.default.moveItem(at: tmp, to: dest)) != nil
        }
      }
      DispatchQueue.main.async {
        guard let self = self else { return }
        let cbs = self.downloads.removeValue(forKey: uri) ?? []
        for cb in cbs { cb(ok ? dest : nil) }
      }
    }
    task.priority = URLSessionTask.highPriority
    task.resume()
  }

  static func fileURL(_ s: String) -> URL? {
    var url: URL?
    if s.hasPrefix("file://") {
      url = URL(string: s) ?? URL(string: s.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? "")
    } else if s.hasPrefix("/") {
      url = URL(fileURLWithPath: s)
    }
    guard let u = url, u.isFileURL, FileManager.default.fileExists(atPath: u.path) else { return nil }
    return u
  }

  /// [native-media-dl] URL sem os parâmetros voláteis de assinatura (exp/sig/
  /// token/expires/X-Amz-*) — mesma ideia do mediaCache.urlToKey (JS).
  static func stableURI(_ uri: String) -> String {
    guard uri.hasPrefix("http"), let q = uri.firstIndex(of: "?") else { return uri }
    let base = uri[..<q]
    let params = uri[uri.index(after: q)...].split(separator: "&").filter { kv in
      let k = kv.split(separator: "=", maxSplits: 1).first.map { String($0).lowercased() } ?? ""
      return !(k == "exp" || k == "sig" || k == "signature" || k == "token" || k == "expires" || k.hasPrefix("x-amz-"))
    }
    return params.isEmpty ? String(base) : String(base) + "?" + params.joined(separator: "&")
  }

  static func remoteURL(_ s: String) -> URL? {
    guard s.hasPrefix("http://") || s.hasPrefix("https://") else { return nil }
    if let u = URL(string: s) { return u }
    if let enc = s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { return URL(string: enc) }
    return nil
  }

  private static func dataFromDataURI(_ uri: String) -> Data? {
    guard let comma = uri.firstIndex(of: ",") else { return nil }
    let header = uri[uri.startIndex..<comma]
    let payload = String(uri[uri.index(after: comma)...])
    if header.contains(";base64") { return Data(base64Encoded: payload, options: .ignoreUnknownCharacters) }
    return payload.removingPercentEncoding?.data(using: .utf8)
  }

  private static func decode(_ source: Source, maxPixel: CGFloat, animated: Bool) -> UIImage? {
    let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
    let src: CGImageSource?
    switch source {
    case .file(let url): src = CGImageSourceCreateWithURL(url as CFURL, srcOpts)
    case .data(let d): src = CGImageSourceCreateWithData(d as CFData, srcOpts)
    }
    guard let s = src else { return nil }
    let count = CGImageSourceGetCount(s)
    if count == 0 { return nil }
    if animated && count > 1 {
      let n = min(count, 120)
      var frames: [UIImage] = []
      var total: Double = 0
      for i in 0..<n {
        guard let f = frame(s, i, min(maxPixel, 480)) else { continue }
        frames.append(f)
        var delay = 0.1
        if let props = CGImageSourceCopyPropertiesAtIndex(s, i, nil) as? [String: Any] {
          if let gif = props[kCGImagePropertyGIFDictionary as String] as? [String: Any] {
            if let d = (gif[kCGImagePropertyGIFUnclampedDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
            else if let d = (gif[kCGImagePropertyGIFDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
          } else if let wp = props[kCGImagePropertyWebPDictionary as String] as? [String: Any] {
            // [2026-10-19 sticker-anim] figurinha WebP animada tocava a 10 fps fixos (só lia GIF)
            if let d = (wp[kCGImagePropertyWebPUnclampedDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
            else if let d = (wp[kCGImagePropertyWebPDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
          } else if let png = props[kCGImagePropertyPNGDictionary as String] as? [String: Any] {
            // APNG
            if let d = (png[kCGImagePropertyAPNGUnclampedDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
            else if let d = (png[kCGImagePropertyAPNGDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 { delay = d }
          }
        }
        total += delay
      }
      if frames.count > 1 { return UIImage.animatedImage(with: frames, duration: total) }
      return frames.first
    }
    return frame(s, 0, maxPixel)
  }

  private static func frame(_ s: CGImageSource, _ index: Int, _ maxPixel: CGFloat) -> UIImage? {
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: Int(max(32, maxPixel)),
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(s, index, opts as CFDictionary) else { return nil }
    return UIImage(cgImage: cg, scale: 1, orientation: .up)
  }

  private static func cost(_ img: UIImage) -> Int {
    if let imgs = img.images, !imgs.isEmpty { return imgs.reduce(0) { $0 + cost($1) } }
    guard let cg = img.cgImage else { return 1 }
    return cg.bytesPerRow * cg.height
  }

  static func sha256(_ s: String) -> String {
    let digest = SHA256.hash(data: Data(s.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
  }
}
