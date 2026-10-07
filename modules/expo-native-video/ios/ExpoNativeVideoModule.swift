import ExpoModulesCore
import AVFoundation
import UIKit
import CoreMedia

// ExpoNativeVideoModule — Stage 1 (2026-05-16).
//
// Native helpers for the chat video upload pipeline. Three AsyncFunctions:
//
//   • getInfo(srcUri)                       — duration / dimensions / mime / size
//                                             via AVURLAsset.
//   • generateThumbnail(srcUri, atMs, dim)  — JPEG frame at the requested
//                                             timestamp via AVAssetImageGenerator,
//                                             written to NSTemporaryDirectory().
//   • compressVideo(srcUri, opts)           — H.264 / AAC MP4 re-encode via
//                                             AVAssetExportSession. Preset is
//                                             chosen from the requested
//                                             maxWidth/maxHeight (1280x720
//                                             default → AVAssetExportPreset1280x720;
//                                             smaller maxes → 960x540, 640x480).
//                                             If the source is already smaller
//                                             than the chosen preset the session
//                                             will pass-through, but for size
//                                             enforcement we still force MP4
//                                             container so recipients get a
//                                             consistent format.
//
// Why AVAssetExportSession instead of AVAssetWriter + AVAssetReader:
//   AVAssetExportSession bakes in all the decisions that matter for chat
//   video (H.264 baseline+, AAC stereo, faststart MP4 moov-at-front for
//   immediate playback during download). It's ~30 LOC vs ~400 for a manual
//   reader/writer pair. WhatsApp uses the same path for the inline compress
//   step before R2 upload.

public class ExpoNativeVideoModule: Module {

  public func definition() -> ModuleDefinition {
    Name("ExpoNativeVideo")

    AsyncFunction("getInfo") { (srcUri: String, promise: Promise) in
      Self.runGetInfo(srcUri: srcUri, promise: promise)
    }

    AsyncFunction("generateThumbnail") { (srcUri: String, atMs: Double, maxDim: Double, promise: Promise) in
      Self.runGenerateThumbnail(srcUri: srcUri, atMs: atMs, maxDim: maxDim, promise: promise)
    }

    AsyncFunction("compressVideo") { (srcUri: String, options: [String: Any], promise: Promise) in
      Self.runCompress(srcUri: srcUri, options: options, promise: promise)
    }

    // segmentVideo(srcUri, segmentMs) — split a long clip into back-to-back
    // ≤segmentMs chunks (WhatsApp status parity). Uses AVAssetExportSession
    // with a per-segment timeRange + passthrough preset (no re-encode). Resolves
    // { segments: [ { uri, index, durationMs } ], segmented: Bool }. Rejects
    // only on unrecoverable failure so JS falls back to posting the single clip.
    AsyncFunction("segmentVideo") { (srcUri: String, segmentMs: Double, promise: Promise) in
      Self.runSegment(srcUri: srcUri, segmentMs: segmentMs, promise: promise)
    }
  }

  // ─── URL helper ────────────────────────────────────────────────────────────

  /// Accepts `file:///...`, plain filesystem paths, and the rare `ph://` /
  /// `assets-library://` legacy URIs. The chat upload path always hands us a
  /// real file: URL from expo-image-picker / camera, so this is mostly a
  /// safety net.
  private static func resolveURL(_ srcUri: String) -> URL? {
    if srcUri.hasPrefix("file://") || srcUri.hasPrefix("http://") || srcUri.hasPrefix("https://") {
      return URL(string: srcUri)
    }
    if srcUri.hasPrefix("/") {
      return URL(fileURLWithPath: srcUri)
    }
    // Last resort — try as-is.
    return URL(string: srcUri)
  }

  // ─── getInfo ───────────────────────────────────────────────────────────────

  private static func runGetInfo(srcUri: String, promise: Promise) {
    guard let url = resolveURL(srcUri) else {
      promise.reject("E_INFO_URL", "Cannot parse srcUri: \(srcUri)")
      return
    }
    let asset = AVURLAsset(url: url)

    let durationMs = Int64(CMTimeGetSeconds(asset.duration) * 1000.0)
    var width = 0
    var height = 0
    if let track = asset.tracks(withMediaType: .video).first {
      // naturalSize gives the raw frame size; preferredTransform encodes
      // rotation (90°/180°/270° for portrait phones). Compose to surface
      // the orientation the user actually shot — same logic as the chat
      // bubble's aspect ratio calc.
      let size = track.naturalSize.applying(track.preferredTransform)
      width = Int(abs(size.width))
      height = Int(abs(size.height))
    }

    var sizeBytes: Int64 = 0
    if url.isFileURL {
      let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
      sizeBytes = (attrs?[.size] as? Int64) ?? 0
    }

    // AVURLAsset has no mime type field; we infer from the file extension
    // since the chat upload layer hands us .mp4/.mov/.m4v almost always.
    let ext = url.pathExtension.lowercased()
    let mime: String
    switch ext {
      case "mp4", "m4v": mime = "video/mp4"
      case "mov": mime = "video/quicktime"
      case "webm": mime = "video/webm"
      case "3gp": mime = "video/3gpp"
      default: mime = "video/mp4"
    }

    promise.resolve([
      "durationMs": durationMs,
      "width": width,
      "height": height,
      "sizeBytes": sizeBytes,
      "mimeType": mime,
    ])
  }

  // ─── generateThumbnail ─────────────────────────────────────────────────────

  private static func runGenerateThumbnail(srcUri: String, atMs: Double, maxDim: Double, promise: Promise) {
    guard let url = resolveURL(srcUri) else {
      promise.reject("E_THUMB_URL", "Cannot parse srcUri: \(srcUri)")
      return
    }
    let asset = AVURLAsset(url: url)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true // honour camera rotation
    // 50ms tolerance window on either side — picks the nearest sync frame,
    // ~10× faster than zero-tolerance which forces forward decode.
    generator.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 20)
    generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 20)
    let cap = maxDim > 0 ? maxDim : 480
    generator.maximumSize = CGSize(width: cap, height: cap)

    let seconds = max(0.0, atMs / 1000.0)
    let cmTime = CMTime(seconds: seconds, preferredTimescale: 600)

    do {
      let cgImage = try generator.copyCGImage(at: cmTime, actualTime: nil)
      let uiImage = UIImage(cgImage: cgImage)
      guard let jpeg = uiImage.jpegData(compressionQuality: 0.85) else {
        promise.reject("E_THUMB_ENCODE", "JPEG encode failed")
        return
      }
      let tmpDir = NSTemporaryDirectory()
      let fileName = "thumb_\(Int(Date().timeIntervalSince1970 * 1000))_\(Int.random(in: 0..<1000)).jpg"
      let outURL = URL(fileURLWithPath: tmpDir).appendingPathComponent(fileName)
      try jpeg.write(to: outURL, options: .atomic)
      promise.resolve([
        "uri": "file://\(outURL.path)",
        "width": uiImage.size.width,
        "height": uiImage.size.height,
      ])
    } catch {
      promise.reject("E_THUMB_DECODE", "Cannot decode frame at \(atMs)ms: \(error.localizedDescription)")
    }
  }

  // ─── compressVideo ─────────────────────────────────────────────────────────

  // [2026-10-07 send-media] Entry point: bitrate-controlled AVAssetWriter
  // transcode first (WhatsApp-like ~1.5 Mbps 720p H.264 + AAC), falling back to
  // the AVAssetExportSession preset path below on any failure. The preset path
  // ignores `bitrate` entirely (AVAssetExportPreset1280x720 writes ~5-8 Mbps),
  // so a 60s clip came out ~40-60MB instead of ~11MB.
  private static func runCompress(srcUri: String, options: [String: Any], promise: Promise) {
    guard let url = resolveURL(srcUri) else {
      promise.reject("E_COMP_URL", "Cannot parse srcUri: \(srcUri)")
      return
    }
    let asset = AVURLAsset(url: url)
    let maxWidth = (options["maxWidth"] as? NSNumber)?.intValue ?? 1280
    let maxHeight = (options["maxHeight"] as? NSNumber)?.intValue ?? 720
    let bitrate = (options["bitrate"] as? NSNumber)?.intValue ?? 1_500_000
    let audioBitrate = (options["audioBitrate"] as? NSNumber)?.intValue ?? 96_000
    let fps = (options["fps"] as? NSNumber)?.intValue ?? 30
    Self.writerCompress(asset: asset, url: url, srcUri: srcUri, maxWidth: maxWidth, maxHeight: maxHeight,
                   bitrate: bitrate, audioBitrate: audioBitrate, fps: fps) { result in
      if let result = result {
        promise.resolve(result)
      } else {
        Self.runExportCompress(srcUri: srcUri, options: options, promise: promise)
      }
    }
  }

  private static func fileSize(_ url: URL) -> Int64 {
    guard url.isFileURL else { return 0 }
    let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attrs?[.size] as? NSNumber)?.int64Value ?? 0
  }

  /// AVAssetReader → AVAssetWriter H.264/AAC transcode with explicit bitrate,
  /// fit-in-box scaling (never upscales), fps cap and faststart MP4.
  /// Calls completion(nil) on ANY failure so the caller can fall back.
  private static func writerCompress(asset: AVURLAsset, url: URL, srcUri: String,
                                     maxWidth: Int, maxHeight: Int, bitrate: Int,
                                     audioBitrate: Int, fps: Int,
                                     completion: @escaping ([String: Any]?) -> Void) {
    guard let vTrack = asset.tracks(withMediaType: .video).first else { completion(nil); return }
    let natural = vTrack.naturalSize
    let t = vTrack.preferredTransform
    let rotated = abs(t.b) == 1.0 && abs(t.c) == 1.0
    let dispW = rotated ? natural.height : natural.width
    let dispH = rotated ? natural.width : natural.height
    guard dispW > 0, dispH > 0 else { completion(nil); return }
    let boxLong = CGFloat(max(maxWidth, maxHeight))
    let boxShort = CGFloat(max(1, min(maxWidth, maxHeight)))
    let scale = min(1.0, boxLong / max(dispW, dispH), boxShort / min(dispW, dispH))
    func even(_ v: CGFloat) -> Int { return max(2, Int((v / 2.0).rounded(.down)) * 2) }
    let encW = even(natural.width * scale)
    let encH = even(natural.height * scale)
    let durationSec = CMTimeGetSeconds(asset.duration)
    let srcSize = Self.fileSize(url)
    let srcFps = Double(vTrack.nominalFrameRate)

    // Already inside the envelope (dims fit, bitrate ≤ target+15%, fps ok) →
    // hand back the source untouched (re-encoding would only lose quality).
    if scale >= 1.0, durationSec > 0, srcSize > 0,
       Double(srcSize) * 8.0 / durationSec <= Double(bitrate + audioBitrate) * 1.15,
       srcFps <= Double(fps) * 1.1 + 0.5 {
      completion([
        "uri": srcUri, "size": srcSize,
        "width": Int(dispW), "height": Int(dispH),
        "durationMs": Int64(durationSec * 1000.0),
      ])
      return
    }

    let outURL = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("compressed_\(Int(Date().timeIntervalSince1970 * 1000))_\(Int.random(in: 0..<100000)).mp4")
    try? FileManager.default.removeItem(at: outURL)

    let reader: AVAssetReader
    let writer: AVAssetWriter
    do {
      reader = try AVAssetReader(asset: asset)
      writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
    } catch { completion(nil); return }
    writer.shouldOptimizeForNetworkUse = true

    // Video: decode to NV12, writer scales + encodes.
    let vOut = AVAssetReaderTrackOutput(track: vTrack, outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    ])
    vOut.alwaysCopiesSampleData = false
    guard reader.canAdd(vOut) else { completion(nil); return }
    reader.add(vOut)
    let capFps = max(1, min(fps, Int(srcFps > 0 ? srcFps.rounded() : Double(fps))))
    let vSettings: [String: Any] = [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: encW,
      AVVideoHeightKey: encH,
      AVVideoScalingModeKey: AVVideoScalingModeResizeAspectFill,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: max(250_000, bitrate),
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: capFps * 2,
        AVVideoExpectedSourceFrameRateKey: capFps,
      ] as [String: Any],
    ]
    let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: vSettings)
    vIn.expectsMediaDataInRealTime = false
    vIn.transform = t
    guard writer.canAdd(vIn) else { completion(nil); return }
    writer.add(vIn)

    // Audio (optional): decode to 44.1k PCM, re-encode AAC at audioBitrate.
    var aOut: AVAssetReaderTrackOutput? = nil
    var aIn: AVAssetWriterInput? = nil
    if let aTrack = asset.tracks(withMediaType: .audio).first {
      var channels = 2
      if let fd = aTrack.formatDescriptions.first {
        let desc = fd as! CMAudioFormatDescription
        if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc)?.pointee {
          channels = max(1, min(2, Int(asbd.mChannelsPerFrame)))
        }
      }
      let ao = AVAssetReaderTrackOutput(track: aTrack, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 44100,
        AVNumberOfChannelsKey: channels,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
      ])
      ao.alwaysCopiesSampleData = false
      let abr = max(32_000, min(audioBitrate, channels == 1 ? 128_000 : 192_000))
      let ai = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 44100,
        AVNumberOfChannelsKey: channels,
        AVEncoderBitRateKey: abr,
      ])
      ai.expectsMediaDataInRealTime = false
      if reader.canAdd(ao) && writer.canAdd(ai) {
        reader.add(ao); writer.add(ai)
        aOut = ao; aIn = ai
      }
    }

    guard reader.startReading(), writer.startWriting() else {
      reader.cancelReading(); writer.cancelWriting()
      try? FileManager.default.removeItem(at: outURL)
      completion(nil); return
    }
    writer.startSession(atSourceTime: .zero)

    let group = DispatchGroup()
    let lock = NSLock()
    var failed = false
    func markFailed() { lock.lock(); failed = true; lock.unlock() }

    // Video pump (drops frames above the fps cap).
    group.enter()
    let vQueue = DispatchQueue(label: "expo.nativevideo.writer.video")
    var vDone = false
    var lastKept = -Double.infinity
    let minGap = srcFps > Double(capFps) * 1.1 ? (0.95 / Double(capFps)) : 0
    vIn.requestMediaDataWhenReady(on: vQueue) {
      if vDone { return }
      while vIn.isReadyForMoreMediaData {
        guard let sb = vOut.copyNextSampleBuffer() else {
          vDone = true; vIn.markAsFinished(); group.leave(); return
        }
        if minGap > 0 {
          let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
          if pts - lastKept < minGap { continue }
          lastKept = pts
        }
        if !vIn.append(sb) {
          markFailed(); vDone = true; vIn.markAsFinished(); group.leave(); return
        }
      }
    }
    if let ai = aIn, let ao = aOut {
      group.enter()
      let aQueue = DispatchQueue(label: "expo.nativevideo.writer.audio")
      var aDone = false
      ai.requestMediaDataWhenReady(on: aQueue) {
        if aDone { return }
        while ai.isReadyForMoreMediaData {
          guard let sb = ao.copyNextSampleBuffer() else {
            aDone = true; ai.markAsFinished(); group.leave(); return
          }
          if !ai.append(sb) {
            markFailed(); aDone = true; ai.markAsFinished(); group.leave(); return
          }
        }
      }
    }

    group.notify(queue: DispatchQueue.global(qos: .userInitiated)) {
      lock.lock(); let didFail = failed; lock.unlock()
      if didFail || reader.status == .failed || writer.status == .failed {
        reader.cancelReading(); writer.cancelWriting()
        try? FileManager.default.removeItem(at: outURL)
        completion(nil); return
      }
      writer.finishWriting {
        guard writer.status == .completed else {
          try? FileManager.default.removeItem(at: outURL)
          completion(nil); return
        }
        let outSize = Self.fileSize(outURL)
        if outSize <= 0 { completion(nil); return }
        if srcSize > 0 && outSize >= srcSize {
          // Re-encode didn't help (already efficient source) → keep source.
          try? FileManager.default.removeItem(at: outURL)
          completion([
            "uri": srcUri, "size": srcSize,
            "width": Int(dispW), "height": Int(dispH),
            "durationMs": Int64(durationSec * 1000.0),
          ])
          return
        }
        completion([
          "uri": "file://\(outURL.path)",
          "size": outSize,
          "width": rotated ? encH : encW,
          "height": rotated ? encW : encH,
          "durationMs": Int64(durationSec * 1000.0),
        ])
      }
    }
  }

  // Legacy preset-based path (fallback).
  private static func runExportCompress(srcUri: String, options: [String: Any], promise: Promise) {
    guard let url = resolveURL(srcUri) else {
      promise.reject("E_COMP_URL", "Cannot parse srcUri: \(srcUri)")
      return
    }

    let maxWidth = (options["maxWidth"] as? Int) ?? 1280
    let maxHeight = (options["maxHeight"] as? Int) ?? 720

    let asset = AVURLAsset(url: url)
    // Pick the smallest preset that still fits the requested max dims.
    // AVFoundation preset sizes (longest edge):
    //   AVAssetExportPreset640x480, 960x540, 1280x720, 1920x1080.
    // For video notes we want a smaller envelope (caller passes maxWidth=480);
    // for normal chat clips 1280x720 is the sweet spot (WhatsApp parity).
    let preset: String
    let longestEdge = max(maxWidth, maxHeight)
    switch longestEdge {
      case 0..<641: preset = AVAssetExportPreset640x480
      case 641..<961: preset = AVAssetExportPresetMediumQuality // ~ 960x540 on most devices
      case 961..<1281: preset = AVAssetExportPreset1280x720
      default: preset = AVAssetExportPreset1280x720 // cap at 720p — chat doesn't need 1080
    }

    // Bail if AVFoundation can't satisfy the preset for this asset (rare —
    // happens with exotic containers or DRM-protected sources). Let the JS
    // fallback handle it by uploading the raw file.
    guard AVAssetExportSession.allExportPresets().contains(preset) else {
      promise.reject("E_COMP_PRESET", "Preset \(preset) unsupported on this device")
      return
    }
    guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
      promise.reject("E_COMP_SESSION", "Cannot init AVAssetExportSession with preset \(preset)")
      return
    }

    let tmpDir = NSTemporaryDirectory()
    let fileName = "compressed_\(Int(Date().timeIntervalSince1970 * 1000))_\(Int.random(in: 0..<1000)).mp4"
    let outURL = URL(fileURLWithPath: tmpDir).appendingPathComponent(fileName)
    // Remove any stale file at the target path — AVAssetExportSession will
    // refuse to write over an existing file.
    try? FileManager.default.removeItem(at: outURL)

    session.outputURL = outURL
    session.outputFileType = .mp4
    // shouldOptimizeForNetworkUse=true writes moov atom at the front of the
    // file (faststart) so the recipient can start playing during download.
    // This is what WhatsApp/YouTube do — without it the client has to fully
    // download the file before the first frame plays.
    session.shouldOptimizeForNetworkUse = true

    let duration = CMTimeGetSeconds(asset.duration)
    let srcSize: Int64 = {
      if url.isFileURL {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.size] as? Int64) ?? 0
      }
      return 0
    }()
    var srcW = 0
    var srcH = 0
    if let track = asset.tracks(withMediaType: .video).first {
      let size = track.naturalSize.applying(track.preferredTransform)
      srcW = Int(abs(size.width))
      srcH = Int(abs(size.height))
    }

    session.exportAsynchronously {
      switch session.status {
      case .completed:
        let outSize: Int64 = {
          let attrs = try? FileManager.default.attributesOfItem(atPath: outURL.path)
          return (attrs?[.size] as? Int64) ?? 0
        }()
        // If for some reason the "compressed" output is LARGER than the
        // source (can happen on already-tiny clips where preset overhead
        // exceeds savings), return the source URI instead. The caller
        // doesn't care which file ends up uploaded — only that it's smaller.
        if outSize > 0 && srcSize > 0 && outSize >= srcSize {
          try? FileManager.default.removeItem(at: outURL)
          promise.resolve([
            "uri": srcUri,
            "size": srcSize,
            "width": srcW,
            "height": srcH,
            "durationMs": Int64(duration * 1000.0),
          ])
          return
        }
        // Read output dimensions from the freshly-written file so JS sees
        // what was actually written, not what we requested.
        let outAsset = AVURLAsset(url: outURL)
        var outW = srcW
        var outH = srcH
        if let track = outAsset.tracks(withMediaType: .video).first {
          let size = track.naturalSize.applying(track.preferredTransform)
          outW = Int(abs(size.width))
          outH = Int(abs(size.height))
        }
        promise.resolve([
          "uri": "file://\(outURL.path)",
          "size": outSize,
          "width": outW,
          "height": outH,
          "durationMs": Int64(duration * 1000.0),
        ])
      case .failed, .cancelled:
        let msg = session.error?.localizedDescription ?? "unknown"
        promise.reject("E_COMP_FAILED", "Export failed: \(msg)")
      default:
        promise.reject("E_COMP_STATE", "Unexpected export status: \(session.status.rawValue)")
      }
    }
  }

  // ─── segmentVideo ────────────────────────────────────────────────────────

  private static func runSegment(srcUri: String, segmentMs: Double, promise: Promise) {
    guard let url = resolveURL(srcUri) else {
      promise.reject("E_SEG_URL", "Cannot parse srcUri: \(srcUri)")
      return
    }
    let asset = AVURLAsset(url: url)
    let totalSeconds = CMTimeGetSeconds(asset.duration)
    let segSeconds = (segmentMs > 0 ? segmentMs : 30_000.0) / 1000.0

    // Short clip → return unchanged (JS uploads it as-is).
    if !totalSeconds.isFinite || totalSeconds <= 0 || totalSeconds <= segSeconds + 1.5 {
      promise.resolve([
        "segmented": false,
        "segments": [["uri": srcUri, "index": 0, "durationMs": Int64(max(0, totalSeconds) * 1000.0)]],
      ])
      return
    }

    // Passthrough preset = remux only, no re-encode. Fall back to the JS single
    // upload if the device can't offer it for this asset.
    let preset = AVAssetExportPresetPassthrough
    guard AVAssetExportSession.allExportPresets().contains(preset) else {
      promise.reject("E_SEG_PRESET", "Passthrough preset unsupported for this asset")
      return
    }

    let segmentCount = min(20, Int(ceil(totalSeconds / segSeconds)))
    let tmpDir = NSTemporaryDirectory()
    let stamp = Int(Date().timeIntervalSince1970 * 1000)
    var results: [[String: Any]] = []
    var writtenURLs: [URL] = []

    // Export segments sequentially — AVAssetExportSession is async, so we chain
    // via a recursive helper. On any failure we clean up + reject so JS falls
    // back to the single-clip path.
    func cleanup() {
      for u in writtenURLs { try? FileManager.default.removeItem(at: u) }
    }
    func exportSegment(_ index: Int) {
      if index >= segmentCount {
        promise.resolve(["segmented": true, "segments": results])
        return
      }
      let startSec = Double(index) * segSeconds
      let endSec = min(startSec + segSeconds, totalSeconds)
      let durSec = endSec - startSec
      if durSec <= 0 {
        promise.resolve(["segmented": true, "segments": results])
        return
      }

      guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
        cleanup()
        promise.reject("E_SEG_SESSION", "Cannot init export session for segment \(index)")
        return
      }
      let outURL = URL(fileURLWithPath: tmpDir).appendingPathComponent("seg_\(stamp)_\(index).mp4")
      try? FileManager.default.removeItem(at: outURL)
      session.outputURL = outURL
      session.outputFileType = .mp4
      session.shouldOptimizeForNetworkUse = true
      let start = CMTime(seconds: startSec, preferredTimescale: 600)
      let dur = CMTime(seconds: durSec, preferredTimescale: 600)
      session.timeRange = CMTimeRange(start: start, duration: dur)

      session.exportAsynchronously {
        switch session.status {
        case .completed:
          writtenURLs.append(outURL)
          results.append([
            "uri": "file://\(outURL.path)",
            "index": index,
            "durationMs": Int64(durSec * 1000.0),
          ])
          exportSegment(index + 1)
        default:
          cleanup()
          let msg = session.error?.localizedDescription ?? "unknown"
          promise.reject("E_SEG_FAILED", "Segment \(index) export failed: \(msg)")
        }
      }
    }

    exportSegment(0)
  }
}
