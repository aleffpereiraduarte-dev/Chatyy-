import UIKit
import AVFoundation
import ImageIO

// [2026-10-18 vthumb, apiVersion 9] 1º frame de vídeo que chegou SEM pôster
// (thumbnail_url/thumb_b64 vazios — poster do servidor falhou). O JS manda o
// campo `vf` (URL remota ou file:// do vídeo) só nesse caso; a célula mantém o
// cinza + play e faz fade do frame quando ele fica pronto.
//   • AVAssetImageGenerator fora da main (generateCGImagesAsynchronously),
//     appliesPreferredTrackTransform, maximumSize = tamanho da bolha × escala;
//   • memória: NSCache; disco: Caches/chatyy-video-frames/<sha256(url)>.jpg;
//   • no máximo 2 extrações simultâneas; célula reutilizada → cancel(url);
//   • falha (ou 20 s sem resposta) cacheada por 10 min (não martela a rede).
final class CMLVideoFrameLoader {
  static let shared = CMLVideoFrameLoader()

  private struct Job {
    let url: URL
    let maxPixel: CGFloat
  }

  private let memory = NSCache<NSString, UIImage>()
  private let workQueue = DispatchQueue(label: "br.com.chatyy.messagelist.vframe", qos: .utility, attributes: .concurrent)
  private let diskDir: URL
  private let maxRunning = 2
  // Estado abaixo: SÓ na main.
  private var running = 0
  private var pending: [String] = []
  private var jobs: [String: Job] = [:]
  private var waiters: [String: [(UIImage?) -> Void]] = [:]
  private var interest: [String: Int] = [:]
  private var generators: [String: AVAssetImageGenerator] = [:]
  private var failedAt: [String: Date] = [:]

  private init() {
    memory.totalCostLimit = 32 * 1024 * 1024
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    diskDir = base.appendingPathComponent("chatyy-video-frames", isDirectory: true)
    try? FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
  }

  private func key(_ uri: String) -> String {
    return CMLImageLoader.stableURI(uri)
  }

  private func diskFile(_ k: String) -> URL {
    return diskDir.appendingPathComponent(CMLImageLoader.sha256(k) + ".jpg")
  }

  private static func sourceURL(_ uri: String) -> URL? {
    if uri.hasPrefix("http://") || uri.hasPrefix("https://") { return CMLImageLoader.remoteURL(uri) }
    return CMLImageLoader.fileURL(uri)
  }

  func cached(_ uri: String) -> UIImage? {
    if uri.isEmpty { return nil }
    return memory.object(forKey: key(uri) as NSString)
  }

  /// completion SEMPRE na main (nil = falhou ou cancelado). Chamar na main.
  func load(_ uri: String, maxPixel: CGFloat, completion: @escaping (UIImage?) -> Void) {
    guard !uri.isEmpty, let url = CMLVideoFrameLoader.sourceURL(uri) else { completion(nil); return }
    let k = key(uri)
    if let img = memory.object(forKey: k as NSString) { completion(img); return }
    if let f = failedAt[k], Date().timeIntervalSince(f) < 600 { completion(nil); return }
    interest[k, default: 0] += 1
    if waiters[k] != nil {
      waiters[k]?.append(completion)
      return
    }
    waiters[k] = [completion]
    let px = min(max(maxPixel, 96), 1280)
    jobs[k] = Job(url: url, maxPixel: px)
    let file = diskFile(k)
    workQueue.async { [weak self] in
      let img = CMLVideoFrameLoader.decodeFile(file, maxPixel: px)
      DispatchQueue.main.async {
        guard let self = self else { return }
        if let img = img {
          self.memory.setObject(img, forKey: k as NSString, cost: CMLVideoFrameLoader.cost(img))
          self.finish(k, img)
          return
        }
        guard self.waiters[k] != nil else { return }
        // todas as células desistiram durante a leitura do disco → não gasta rede
        if self.interest[k] == nil {
          self.finish(k, nil)
          return
        }
        self.pending.append(k)
        self.pump()
      }
    }
  }

  /// A célula desistiu (reuso / outra linha). Chamar na main.
  func cancel(_ uri: String) {
    if uri.isEmpty { return }
    let k = key(uri)
    guard let n = interest[k] else { return }
    if n > 1 {
      interest[k] = n - 1
      return
    }
    interest.removeValue(forKey: k)
    if let gen = generators[k] {
      gen.cancelAllCGImageGeneration()
      return
    }
    if let i = pending.firstIndex(of: k) {
      pending.remove(at: i)
      jobs.removeValue(forKey: k)
      waiters.removeValue(forKey: k)
    }
  }

  private func finish(_ k: String, _ img: UIImage?) {
    jobs.removeValue(forKey: k)
    interest.removeValue(forKey: k)
    let list = waiters.removeValue(forKey: k) ?? []
    for cb in list { cb(img) }
  }

  private func pump() {
    while running < maxRunning && !pending.isEmpty {
      let k = pending.removeFirst()
      guard waiters[k] != nil, let job = jobs[k] else { continue }
      running += 1
      let asset = AVURLAsset(url: job.url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
      let gen = AVAssetImageGenerator(asset: asset)
      gen.appliesPreferredTrackTransform = true
      gen.maximumSize = CGSize(width: job.maxPixel, height: job.maxPixel)
      gen.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 2)
      gen.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 2)
      generators[k] = gen
      generate(k, gen, at: CMTime(value: 1, timescale: 2), retry: true, maxPixel: job.maxPixel)
      // teto: rede ruim / servidor mudo não prende a vaga para sempre
      DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self, weak gen] in
        guard let self = self, let gen = gen, self.generators[k] === gen else { return }
        self.failedAt[k] = Date()
        gen.cancelAllCGImageGeneration()
      }
    }
  }

  private func generate(_ k: String, _ gen: AVAssetImageGenerator, at time: CMTime, retry: Bool, maxPixel: CGFloat) {
    gen.generateCGImagesAsynchronously(forTimes: [NSValue(time: time)]) { [weak self] _, cgImage, _, result, _ in
      if result == .succeeded, let cg = cgImage {
        let img = UIImage(cgImage: cg)
        let data = img.jpegData(compressionQuality: 0.8)
        DispatchQueue.main.async {
          guard let self = self else { return }
          let file = self.diskFile(k)
          if let data = data {
            self.workQueue.async { try? data.write(to: file, options: .atomic) }
          }
          self.memory.setObject(img, forKey: k as NSString, cost: CMLVideoFrameLoader.cost(img))
          self.done(k, img)
        }
        return
      }
      DispatchQueue.main.async {
        guard let self = self else { return }
        if result == .failed && retry && self.generators[k] === gen {
          // sem keyframe perto de 0,5 s (vídeo curto) → tenta o início
          self.generate(k, gen, at: .zero, retry: false, maxPixel: maxPixel)
          return
        }
        if result == .failed { self.failedAt[k] = Date() }
        self.done(k, nil)
      }
    }
  }

  private func done(_ k: String, _ img: UIImage?) {
    generators.removeValue(forKey: k)
    running = max(0, running - 1)
    if img != nil { failedAt.removeValue(forKey: k) }
    finish(k, img)
    pump()
  }

  private static func decodeFile(_ file: URL, maxPixel: CGFloat) -> UIImage? {
    guard FileManager.default.fileExists(atPath: file.path),
          let src = CGImageSourceCreateWithURL(file as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: Int(max(maxPixel, 96)),
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
    return UIImage(cgImage: cg)
  }

  private static func cost(_ img: UIImage) -> Int {
    guard let cg = img.cgImage else { return 1 }
    return cg.bytesPerRow * cg.height
  }
}
