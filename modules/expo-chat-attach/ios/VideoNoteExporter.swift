import AVFoundation
import UIKit

// [2026-10-15 native-vnote] Segmentos .mov da câmera → MP4 QUADRADO H.264
// (size×size, padrão 640) + AAC mono 44.1 kHz 64 kbps.
//
// Cada troca de câmera durante a gravação fecha um segmento (o
// AVCaptureMovieFileOutput não sobrevive à troca de entrada); aqui os
// segmentos viram uma AVMutableComposition e um AVAssetReader com
// AVAssetReaderVideoCompositionOutput aplica, por segmento, transformação de
// orientação + recorte CENTRAL quadrado + escala (o mesmo recorte que o preview
// redondo mostra: aspect-fill num quadrado). AVAssetWriter escreve com bitrate
// fixo (≈ 9 MB/min em 1.2 Mbps) e moov no início (shouldOptimizeForNetworkUse).
enum VideoNoteExporter {
  struct Output {
    let url: URL
    let duration: Double
    let size: Int
  }

  private static let workQueue = DispatchQueue(label: "br.com.chatyy.vnote.export", qos: .userInitiated)

  /// completion na main. nil = falhou (o chamador decide o fallback).
  static func export(segments: [URL], size: Int, bitrate: Int, completion: @escaping (Output?) -> Void) {
    workQueue.async {
      let out = run(segments: segments, size: max(160, min(size, 1080)), bitrate: max(300_000, min(bitrate, 6_000_000)))
      DispatchQueue.main.async { completion(out) }
    }
  }

  private static func run(segments: [URL], size: Int, bitrate: Int) -> Output? {
    let comp = AVMutableComposition()
    guard let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { return nil }
    var ca: AVMutableCompositionTrack? = nil
    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: cv)
    let side = CGFloat(size)
    var cursor = CMTime.zero

    for url in segments {
      let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
      guard let vt = asset.tracks(withMediaType: .video).first else { continue }
      let vr = vt.timeRange
      guard vr.duration.isValid, CMTimeGetSeconds(vr.duration) > 0.05 else { continue }
      do {
        try cv.insertTimeRange(vr, of: vt, at: cursor)
      } catch { continue }
      if let at = asset.tracks(withMediaType: .audio).first {
        if ca == nil { ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) }
        let ar = at.timeRange
        // áudio nunca passa do vídeo do segmento (sem "rabo" mudo/negro).
        let dur = CMTimeMinimum(ar.duration, vr.duration)
        if dur.isValid, CMTimeGetSeconds(dur) > 0.02 {
          try? ca?.insertTimeRange(CMTimeRange(start: ar.start, duration: dur), of: at, at: cursor)
        }
      }
      layer.setTransform(squareTransform(vt, side: side), at: cursor)
      cursor = CMTimeAdd(cursor, vr.duration)
    }
    let total = CMTimeGetSeconds(cursor)
    guard total > 0.1 else { return nil }

    let instr = AVMutableVideoCompositionInstruction()
    instr.timeRange = CMTimeRange(start: .zero, duration: cursor)
    instr.layerInstructions = [layer]
    let vc = AVMutableVideoComposition()
    vc.instructions = [instr]
    vc.renderSize = CGSize(width: side, height: side)
    vc.frameDuration = CMTime(value: 1, timescale: 30)

    let outURL = AttachExporter.outDir().appendingPathComponent("video_note_\(Int(Date().timeIntervalSince1970 * 1000)).mp4")
    try? FileManager.default.removeItem(at: outURL)

    guard let reader = try? AVAssetReader(asset: comp),
          let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else { return nil }
    writer.shouldOptimizeForNetworkUse = true

    let vOut = AVAssetReaderVideoCompositionOutput(videoTracks: [cv], videoSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    ])
    vOut.videoComposition = vc
    vOut.alwaysCopiesSampleData = false
    guard reader.canAdd(vOut) else { return nil }
    reader.add(vOut)

    let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: size,
      AVVideoHeightKey: size,
      AVVideoScalingModeKey: AVVideoScalingModeResizeAspectFill,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoMaxKeyFrameIntervalKey: 30,
        AVVideoExpectedSourceFrameRateKey: 30,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoAllowFrameReorderingKey: false,
      ] as [String: Any],
    ])
    vIn.expectsMediaDataInRealTime = false
    guard writer.canAdd(vIn) else { return nil }
    writer.add(vIn)

    var aOut: AVAssetReaderAudioMixOutput? = nil
    var aIn: AVAssetWriterInput? = nil
    if let ca = ca, ca.timeRange.duration.isValid, CMTimeGetSeconds(ca.timeRange.duration) > 0.05 {
      let o = AVAssetReaderAudioMixOutput(audioTracks: [ca], audioSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
      ])
      o.alwaysCopiesSampleData = false
      let i = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 64_000,
      ])
      i.expectsMediaDataInRealTime = false
      if reader.canAdd(o) && writer.canAdd(i) {
        reader.add(o)
        writer.add(i)
        aOut = o
        aIn = i
      }
    }

    guard reader.startReading(), writer.startWriting() else {
      reader.cancelReading()
      writer.cancelWriting()
      return nil
    }
    writer.startSession(atSourceTime: .zero)

    let group = DispatchGroup()
    pump(group: group, label: "v", input: vIn, output: vOut, reader: reader, writer: writer)
    if let ai = aIn, let ao = aOut {
      pump(group: group, label: "a", input: ai, output: ao, reader: reader, writer: writer)
    }
    group.wait()

    if reader.status == .failed || writer.status == .failed {
      reader.cancelReading()
      writer.cancelWriting()
      try? FileManager.default.removeItem(at: outURL)
      return nil
    }
    let sem = DispatchSemaphore(value: 0)
    writer.finishWriting { sem.signal() }
    sem.wait()
    guard writer.status == .completed, AttachExporter.fileSize(outURL) > 0 else {
      try? FileManager.default.removeItem(at: outURL)
      return nil
    }
    return Output(url: outURL, duration: total, size: size)
  }

  private static func pump(group: DispatchGroup, label: String, input: AVAssetWriterInput, output: AVAssetReaderOutput,
                           reader: AVAssetReader, writer: AVAssetWriter) {
    group.enter()
    let q = DispatchQueue(label: "br.com.chatyy.vnote.pump.\(label)")
    var finished = false
    input.requestMediaDataWhenReady(on: q) {
      if finished { return }
      while input.isReadyForMoreMediaData {
        if reader.status != .reading || writer.status != .writing {
          finished = true
          input.markAsFinished()
          group.leave()
          return
        }
        guard let sb = output.copyNextSampleBuffer() else {
          finished = true
          input.markAsFinished()
          group.leave()
          return
        }
        if !input.append(sb) {
          finished = true
          input.markAsFinished()
          group.leave()
          return
        }
      }
    }
  }

  /// Orientação (preferredTransform) → recorte central quadrado → escala p/ side.
  static func squareTransform(_ track: AVAssetTrack, side: CGFloat) -> CGAffineTransform {
    let n = track.naturalSize
    let t = track.preferredTransform
    let r = CGRect(origin: .zero, size: n).applying(t)
    let w = abs(r.width), h = abs(r.height)
    guard w > 0, h > 0 else { return t }
    var out = t.concatenating(CGAffineTransform(translationX: -r.minX, y: -r.minY))
    let sq = min(w, h)
    out = out.concatenating(CGAffineTransform(translationX: -(w - sq) / 2, y: -(h - sq) / 2))
    let s = side / sq
    out = out.concatenating(CGAffineTransform(scaleX: s, y: s))
    return out
  }
}
