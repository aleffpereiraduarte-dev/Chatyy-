import UIKit
import ImageIO
import CryptoKit
import Photos

// [2026-10-14 native-viewer] Carregador de imagem do viewer nativo.
//   • memória: NSCache (custo = bytes decodificados);
//   • disco: Caches/chatyy-media-viewer/<sha256(url)> (download inteiro, LRU
//     por data de modificação, teto ~350 MB);
//   • decodificação SEMPRE fora da main via ImageIO (downsample + orientação
//     EXIF aplicada), GIF animado vira UIImage.animatedImage.
// Fontes aceitas: file:// / caminho absoluto, data:image/...;base64, http(s).
final class MVImageLoader {
  static let shared = MVImageLoader()

  static let fullMaxPixel: CGFloat = 3072
  static let thumbMaxPixel: CGFloat = 640

  private let memory = NSCache<NSString, UIImage>()
  private let decodeQueue = DispatchQueue(label: "br.com.chatyy.mediaviewer.decode", qos: .userInitiated, attributes: .concurrent)
  private let session: URLSession
  private let diskDir: URL
  // Acessado só na main.
  private var waiters: [String: [(UIImage?) -> Void]] = [:]
  private var trimmed = false

  private init() {
    memory.totalCostLimit = 160 * 1024 * 1024
    let cfg = URLSessionConfiguration.default
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData // cache próprio em disco
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = 30
    cfg.httpMaximumConnectionsPerHost = 4
    session = URLSession(configuration: cfg)
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    diskDir = base.appendingPathComponent("chatyy-media-viewer", isDirectory: true)
    try? FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
  }

  // MARK: - Public

  func cachedImage(_ uri: String, maxPixel: CGFloat) -> UIImage? {
    if uri.isEmpty { return nil }
    return memory.object(forKey: key(uri, maxPixel) as NSString)
  }

  /// completion SEMPRE na main.
  func load(_ uri: String, maxPixel: CGFloat, completion: @escaping (UIImage?) -> Void) {
    if uri.isEmpty { completion(nil); return }
    let k = key(uri, maxPixel)
    if let img = memory.object(forKey: k as NSString) { completion(img); return }
    if waiters[k] != nil {
      waiters[k]?.append(completion)
      return
    }
    waiters[k] = [completion]
    trimDiskOnce()
    let allowAnimated = maxPixel >= MVImageLoader.fullMaxPixel
    // [2026-10-15 photos-native] ph://<localIdentifier> = foto da galeria (grade de Fotos).
    if uri.hasPrefix("ph://") {
      loadPhotoAsset(String(uri.dropFirst(5)), maxPixel: maxPixel) { [weak self] img in
        guard let self = self else { return }
        if let img = img { self.memory.setObject(img, forKey: k as NSString, cost: MVImageLoader.cost(img)) }
        self.finish(k, img)
      }
      return
    }
    resolveSource(uri) { [weak self] source in
      guard let self = self else { return }
      guard let source = source else { self.finish(k, nil); return }
      self.decodeQueue.async {
        let img = MVImageLoader.decode(source, maxPixel: maxPixel, allowAnimated: allowAnimated)
        DispatchQueue.main.async {
          if let img = img {
            self.memory.setObject(img, forKey: k as NSString, cost: MVImageLoader.cost(img))
          }
          self.finish(k, img)
        }
      }
    }
  }

  func prefetch(_ uri: String, maxPixel: CGFloat) {
    load(uri, maxPixel: maxPixel) { _ in }
  }

  // MARK: - Internals

  private func key(_ uri: String, _ maxPixel: CGFloat) -> String {
    return "\(Int(maxPixel))|\(MVImageLoader.stableURI(uri))"
  }

  /// [2026-10-15 photos-native] URL assinada do CDN muda `exp`/`sig` a cada janela
  /// de 6 h; o conteúdo é o mesmo → chave de cache sem esses parâmetros.
  static func stableURI(_ uri: String) -> String {
    guard uri.hasPrefix("http"), let q = uri.firstIndex(of: "?") else { return uri }
    let base = uri[..<q]
    let params = uri[uri.index(after: q)...].split(separator: "&").filter {
      !$0.hasPrefix("exp=") && !$0.hasPrefix("sig=")
    }
    return params.isEmpty ? String(base) : String(base) + "?" + params.joined(separator: "&")
  }

  /// Foto da galeria via PhotoKit (iCloud permitido); completion na main.
  private func loadPhotoAsset(_ localId: String, maxPixel: CGFloat, _ done: @escaping (UIImage?) -> Void) {
    let st = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard st == .authorized || st == .limited,
          let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil).firstObject else {
      done(nil); return
    }
    let o = PHImageRequestOptions()
    o.deliveryMode = .highQualityFormat
    o.resizeMode = .fast
    o.isNetworkAccessAllowed = true
    o.isSynchronous = false
    let size = CGSize(width: maxPixel, height: maxPixel)
    PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFit, options: o) { img, _ in
      if Thread.isMainThread { done(img) } else { DispatchQueue.main.async { done(img) } }
    }
  }

  private func finish(_ k: String, _ img: UIImage?) {
    let list = waiters.removeValue(forKey: k) ?? []
    for cb in list { cb(img) }
  }

  private enum Source {
    case file(URL)
    case data(Data)
  }

  /// Resolve a fonte para arquivo local ou bytes; callback na main.
  private func resolveSource(_ uri: String, _ done: @escaping (Source?) -> Void) {
    if uri.hasPrefix("data:") {
      decodeQueue.async {
        let d = MVImageLoader.dataFromDataURI(uri)
        DispatchQueue.main.async { done(d.map { Source.data($0) }) }
      }
      return
    }
    if let f = MVItem.existingFileURL(uri) {
      done(.file(f))
      return
    }
    guard let remote = MVItem.remoteURL(uri) else { done(nil); return }
    let dest = diskDir.appendingPathComponent(MVImageLoader.sha256(MVImageLoader.stableURI(uri)))
    if FileManager.default.fileExists(atPath: dest.path) {
      try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: dest.path)
      done(.file(dest))
      return
    }
    let task = session.downloadTask(with: remote) { tmp, resp, err in
      var ok = false
      if err == nil, let tmp = tmp {
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 200
        if (200..<300).contains(status) {
          // O arquivo temporário some quando este bloco retorna → move já.
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

  private static func decode(_ source: Source, maxPixel: CGFloat, allowAnimated: Bool) -> UIImage? {
    let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
    let src: CGImageSource?
    switch source {
    case .file(let url): src = CGImageSourceCreateWithURL(url as CFURL, srcOpts)
    case .data(let d): src = CGImageSourceCreateWithData(d as CFData, srcOpts)
    }
    guard let s = src else { return nil }
    let count = CGImageSourceGetCount(s)
    if count == 0 { return nil }
    if allowAnimated && count > 1, let anim = animated(s, count: count) {
      return anim
    }
    return frame(s, index: 0, maxPixel: maxPixel)
  }

  private static func frame(_ s: CGImageSource, index: Int, maxPixel: CGFloat) -> UIImage? {
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: Int(maxPixel),
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(s, index, opts as CFDictionary) else { return nil }
    return UIImage(cgImage: cg, scale: 1, orientation: .up)
  }

  private static func animated(_ s: CGImageSource, count: Int) -> UIImage? {
    let n = min(count, 150)
    var frames: [UIImage] = []
    frames.reserveCapacity(n)
    var total: Double = 0
    for i in 0..<n {
      guard let f = frame(s, index: i, maxPixel: 1024) else { continue }
      frames.append(f)
      var delay = 0.1
      if let props = CGImageSourceCopyPropertiesAtIndex(s, i, nil) as? [String: Any],
         let gif = props[kCGImagePropertyGIFDictionary as String] as? [String: Any] {
        if let d = (gif[kCGImagePropertyGIFUnclampedDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 {
          delay = d
        } else if let d = (gif[kCGImagePropertyGIFDelayTime as String] as? NSNumber)?.doubleValue, d > 0.011 {
          delay = d
        }
      }
      total += delay
    }
    if frames.count < 2 { return frames.first }
    return UIImage.animatedImage(with: frames, duration: total)
  }

  private static func cost(_ img: UIImage) -> Int {
    if let imgs = img.images, !imgs.isEmpty {
      return imgs.reduce(0) { $0 + cost($1) }
    }
    guard let cg = img.cgImage else { return 1 }
    return cg.bytesPerRow * cg.height
  }

  private static func sha256(_ s: String) -> String {
    let digest = SHA256.hash(data: Data(s.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  /// Teto do cache em disco (LRU por mtime). Uma vez por processo, em background.
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
      let cap = 350 * 1024 * 1024
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
