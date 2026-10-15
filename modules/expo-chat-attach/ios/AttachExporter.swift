import AVFoundation
import Photos
import UIKit
import ImageIO
import UniformTypeIdentifiers

// [2026-10-15 native-attach] PHAsset → arquivo local (file://) no MESMO
// formato que o handleGallery do JS monta ({ uri, name, type, size, width,
// height, duration }). Baixa do iCloud quando preciso. A compressão/EXIF/HEIC
// continua no pipeline JS (mediaSendQueue) — aqui só "materializa" o arquivo.
//   • normal: foto = dados da versão atual (edições incluídas), vídeo = AVURLAsset
//     clonado (APFS clone, instantâneo) ou export (slow-mo / composição);
//   • asFile: recurso ORIGINAL (nome original, sem conversão).
enum AttachExporter {
  static let dirName = "chatyy-attach"

  static func outDir() -> URL {
    let d = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true).appendingPathComponent(dirName, isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
  }

  static func freshURL(ext: String) -> URL {
    let e = ext.isEmpty ? "bin" : ext.lowercased()
    return outDir().appendingPathComponent("\(UUID().uuidString).\(e)")
  }

  static func originalName(_ asset: PHAsset) -> String {
    let res = PHAssetResource.assetResources(for: asset)
    let primary = res.first(where: { $0.type == .photo || $0.type == .video }) ?? res.first
    return primary?.originalFilename ?? ""
  }

  static func mime(forExt ext: String, video: Bool) -> String {
    if let t = UTType(filenameExtension: ext.lowercased()), let m = t.preferredMIMEType { return m }
    return video ? "video/mp4" : "image/jpeg"
  }

  static func fileSize(_ url: URL) -> Int {
    let a = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (a?[.size] as? NSNumber)?.intValue ?? 0
  }

  static func renamed(_ original: String, ext: String, fallbackPrefix: String) -> String {
    let base = (original as NSString).deletingPathExtension
    let b = base.isEmpty ? "\(fallbackPrefix)_\(Int(Date().timeIntervalSince1970 * 1000))" : base
    return "\(b).\(ext)"
  }

  /// Exporta em ordem; concorrência 3. completion na main thread.
  static func export(_ assets: [PHAsset], asFile: Bool, completion: @escaping ([[String: Any]]) -> Void) {
    if assets.isEmpty { completion([]); return }
    var results = [[String: Any]?](repeating: nil, count: assets.count)
    let group = DispatchGroup()
    let sem = DispatchSemaphore(value: 3)
    let lock = NSLock()
    DispatchQueue.global(qos: .userInitiated).async {
      for (i, a) in assets.enumerated() {
        sem.wait()
        group.enter()
        exportOne(a, asFile: asFile) { item in
          lock.lock(); results[i] = item; lock.unlock()
          sem.signal()
          group.leave()
        }
      }
      group.notify(queue: .main) {
        completion(results.compactMap { $0 })
      }
    }
  }

  static func exportOne(_ asset: PHAsset, asFile: Bool, done: @escaping ([String: Any]?) -> Void) {
    let isVideo = asset.mediaType == .video
    if asFile { return exportOriginal(asset, done: done) }
    if isVideo { return exportVideo(asset, done: done) }
    exportImage(asset, done: done)
  }

  private static func baseItem(_ asset: PHAsset, url: URL, name: String, mime: String) -> [String: Any] {
    let isVideo = asset.mediaType == .video
    var w = asset.pixelWidth, h = asset.pixelHeight
    if !isVideo, let dims = imageDims(url) { w = dims.0; h = dims.1 }
    return [
      "uri": url.absoluteString,
      "name": name,
      "type": mime,
      "size": fileSize(url),
      "width": w,
      "height": h,
      "duration": isVideo ? NSNumber(value: asset.duration) : NSNull(),
      "mediaType": isVideo ? "video" : "image",
      "assetId": asset.localIdentifier,
    ]
  }

  /// Largura/altura JÁ com a orientação EXIF aplicada.
  static func imageDims(_ url: URL) -> (Int, Int)? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
          let w = (p[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
          let h = (p[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue else { return nil }
    let o = (p[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    return o >= 5 && o <= 8 ? (h, w) : (w, h)
  }

  private static func exportImage(_ asset: PHAsset, done: @escaping ([String: Any]?) -> Void) {
    let opts = PHImageRequestOptions()
    opts.isNetworkAccessAllowed = true
    opts.deliveryMode = .highQualityFormat
    opts.version = .current
    opts.isSynchronous = false
    PHImageManager.default().requestImageDataAndOrientation(for: asset, options: opts) { data, uti, _, _ in
      guard let data = data, !data.isEmpty else { done(nil); return }
      var ext = "jpg"
      if let u = uti, let t = UTType(u), let e = t.preferredFilenameExtension { ext = e == "jpeg" ? "jpg" : e }
      let url = freshURL(ext: ext)
      do { try data.write(to: url, options: .atomic) } catch { done(nil); return }
      let name = renamed(originalName(asset), ext: ext, fallbackPrefix: "IMG")
      done(baseItem(asset, url: url, name: name, mime: mime(forExt: ext, video: false)))
    }
  }

  private static func exportVideo(_ asset: PHAsset, done: @escaping ([String: Any]?) -> Void) {
    let opts = PHVideoRequestOptions()
    opts.isNetworkAccessAllowed = true
    opts.version = .current
    opts.deliveryMode = .highQualityFormat
    PHImageManager.default().requestAVAsset(forVideo: asset, options: opts) { av, _, _ in
      guard let av = av else { done(nil); return }
      if let urlAsset = av as? AVURLAsset {
        let ext = urlAsset.url.pathExtension.isEmpty ? "mov" : urlAsset.url.pathExtension.lowercased()
        let dst = freshURL(ext: ext)
        do {
          try FileManager.default.copyItem(at: urlAsset.url, to: dst)
          let name = renamed(originalName(asset), ext: ext, fallbackPrefix: "VID")
          done(baseItem(asset, url: dst, name: name, mime: mime(forExt: ext, video: true)))
          return
        } catch {
          // cai no export abaixo
        }
      }
      guard let ex = AVAssetExportSession(asset: av, presetName: AVAssetExportPresetHighestQuality) else { done(nil); return }
      let dst = freshURL(ext: "mp4")
      ex.outputURL = dst
      ex.outputFileType = .mp4
      ex.shouldOptimizeForNetworkUse = true
      ex.exportAsynchronously {
        guard ex.status == .completed else { done(nil); return }
        let name = renamed(originalName(asset), ext: "mp4", fallbackPrefix: "VID")
        done(baseItem(asset, url: dst, name: name, mime: "video/mp4"))
      }
    }
  }

  private static func exportOriginal(_ asset: PHAsset, done: @escaping ([String: Any]?) -> Void) {
    let isVideo = asset.mediaType == .video
    let res = PHAssetResource.assetResources(for: asset)
    let wanted: [PHAssetResourceType] = isVideo ? [.fullSizeVideo, .video] : [.fullSizePhoto, .photo]
    var chosen: PHAssetResource?
    for t in wanted { if let r = res.first(where: { $0.type == t }) { chosen = r; break } }
    guard let r = chosen ?? res.first else {
      // Sem recurso (raro) → caminho normal.
      return isVideo ? exportVideo(asset, done: done) : exportImage(asset, done: done)
    }
    var orig = r.originalFilename
    if orig.isEmpty { orig = isVideo ? "VID.mov" : "IMG.jpg" }
    let ext = (orig as NSString).pathExtension.isEmpty ? (isVideo ? "mov" : "jpg") : (orig as NSString).pathExtension
    let dst = freshURL(ext: ext)
    let opts = PHAssetResourceRequestOptions()
    opts.isNetworkAccessAllowed = true
    PHAssetResourceManager.default().writeData(for: r, toFile: dst, options: opts) { err in
      if err != nil {
        return isVideo ? exportVideo(asset, done: done) : exportImage(asset, done: done)
      }
      done(baseItem(asset, url: dst, name: orig, mime: mime(forExt: ext, video: isVideo)))
    }
  }

  // MARK: arquivos da câmera

  static func cameraPhotoItem(_ data: Data) -> [String: Any]? {
    let url = freshURL(ext: "jpg")
    do { try data.write(to: url, options: .atomic) } catch { return nil }
    let dims = imageDims(url) ?? (0, 0)
    return [
      "uri": url.absoluteString,
      "name": "camera_\(Int(Date().timeIntervalSince1970 * 1000)).jpg",
      "type": "image/jpeg",
      "size": fileSize(url),
      "width": dims.0,
      "height": dims.1,
      "duration": NSNull(),
      "mediaType": "image",
    ]
  }

  static func cameraVideoItem(_ url: URL) -> [String: Any] {
    let av = AVURLAsset(url: url)
    var w = 0, h = 0
    if let track = av.tracks(withMediaType: .video).first {
      let r = CGRect(origin: .zero, size: track.naturalSize).applying(track.preferredTransform)
      w = Int(abs(r.width).rounded()); h = Int(abs(r.height).rounded())
    }
    let dur = CMTimeGetSeconds(av.duration)
    return [
      "uri": url.absoluteString,
      "name": "camera_\(Int(Date().timeIntervalSince1970 * 1000)).\(url.pathExtension.isEmpty ? "mov" : url.pathExtension)",
      "type": url.pathExtension.lowercased() == "mp4" ? "video/mp4" : "video/quicktime",
      "size": fileSize(url),
      "width": w,
      "height": h,
      "duration": dur.isFinite ? NSNumber(value: dur) : NSNull(),
      "mediaType": "video",
    ]
  }
}
