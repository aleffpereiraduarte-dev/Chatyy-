import Foundation

// [2026-10-15 native-reels] Cache de vídeo em disco (só MP4/MOV progressivo;
// HLS fica com o buffer do AVPlayer). O feed baixa INTEIROS os reels que estão
// 2–3 posições à frente (fora da janela do pool de players, que já faz o
// próprio buffer do anterior/atual/próximo) — quando eles entram no pool, o
// AVPlayerItem nasce de um file:// e o 1º quadro sai na hora; voltar a um reel
// já visto também toca do disco.
//   • Caches/chatyy-reels-video/<sha256(url)>.<ext>, LRU ~400 MB;
//   • no máx. 2 downloads simultâneos; respeita o Modo Pouco Dado do iOS;
//   • arquivo > 60 MB é descartado (reel longo demais p/ valer o disco).
// Toda a API é chamada na main.
final class RFVideoCache {
  static let shared = RFVideoCache()

  private static let maxBytes: Int64 = 400 * 1024 * 1024
  private static let maxFile: Int64 = 60 * 1024 * 1024
  private static let maxParallel = 2

  private let dir: URL
  private let session: URLSession
  private var tasks: [String: URLSessionDownloadTask] = [:]
  private var failed = Set<String>()
  private var trimmed = false

  private init() {
    let cfg = URLSessionConfiguration.default
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = 30
    cfg.timeoutIntervalForResource = 120
    cfg.allowsConstrainedNetworkAccess = false
    cfg.httpMaximumConnectionsPerHost = 2
    session = URLSession(configuration: cfg)
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    dir = base.appendingPathComponent("chatyy-reels-video", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }

  static func isCacheable(_ remote: String) -> Bool {
    guard let u = RFItem.url(remote), !u.isFileURL else { return false }
    let ext = u.pathExtension.lowercased()
    if ext == "m3u8" || ext == "mpd" { return false }
    return true
  }

  private func fileURL(_ remote: String) -> URL {
    var ext = (URL(string: remote)?.pathExtension ?? "").lowercased()
    if !["mp4", "mov", "m4v"].contains(ext) { ext = "mp4" }
    return dir.appendingPathComponent(RFFormat.sha256(remote) + "." + ext)
  }

  /// file:// já baixado (completo) para esta URL, ou nil.
  func localURL(for remote: String) -> URL? {
    if !RFVideoCache.isCacheable(remote) { return nil }
    let f = fileURL(remote)
    if FileManager.default.fileExists(atPath: f.path) {
      RFDisk.touch(f)
      return f
    }
    return nil
  }

  func prefetch(_ remote: String) {
    if !RFVideoCache.isCacheable(remote) { return }
    if tasks[remote] != nil || failed.contains(remote) { return }
    if tasks.count >= RFVideoCache.maxParallel { return }
    let dest = fileURL(remote)
    if FileManager.default.fileExists(atPath: dest.path) { return }
    guard let u = URL(string: remote) else { return }
    trimOnce()
    let task = session.downloadTask(with: u) { [weak self] tmp, resp, err in
      var ok = false
      if err == nil, let tmp = tmp {
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 200
        let size = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? NSNumber)?.int64Value ?? 0
        if (200..<300).contains(status) && size > 0 && size <= RFVideoCache.maxFile {
          try? FileManager.default.removeItem(at: dest)
          ok = (try? FileManager.default.moveItem(at: tmp, to: dest)) != nil
        }
      }
      let cancelled = (err as NSError?)?.code == NSURLErrorCancelled
      DispatchQueue.main.async {
        guard let self = self else { return }
        self.tasks.removeValue(forKey: remote)
        if !ok && !cancelled { self.failed.insert(remote) }
      }
    }
    task.priority = URLSessionTask.lowPriority
    tasks[remote] = task
    task.resume()
  }

  /// Cancela downloads que saíram da janela de interesse.
  func cancel(except keep: Set<String>) {
    for (k, t) in tasks where !keep.contains(k) {
      t.cancel()
      tasks.removeValue(forKey: k)
    }
  }

  private func trimOnce() {
    if trimmed { return }
    trimmed = true
    let d = dir
    DispatchQueue.global(qos: .utility).async { RFDisk.trim(d, maxBytes: RFVideoCache.maxBytes) }
  }
}
