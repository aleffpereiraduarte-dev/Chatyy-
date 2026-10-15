import AVFoundation
import UIKit

// [2026-10-15 native-reels] Pool FIXO de 3 AVPlayer (anterior / atual /
// próximo). Cada slot carrega o AVPlayerItem de um reel por id; o feed pede
// `assign([anterior, atual, próximo])` a cada troca de página e os slots que
// saíram da janela são reaproveitados (nunca mais de 3 decoders vivos).
//   • atual: preferredForwardBufferDuration = 0 (automático, máx. qualidade);
//   • vizinhos: 2,5 s de pré-buffer, mudos e pausados → o 1º quadro já está
//     decodificado quando o dedo solta.
// Tudo na main.
final class RFPlayerSlot {
  let player = AVPlayer()
  private(set) var itemId = ""
  private(set) var mediaKey = ""
  var failed = false
  var ready = false
  var loops = 0
  fileprivate var statusObs: NSKeyValueObservation?
  fileprivate var endToken: NSObjectProtocol?
  fileprivate var failToken: NSObjectProtocol?

  init() {
    player.automaticallyWaitsToMinimizeStalling = true
    player.actionAtItemEnd = .none
    player.isMuted = true
    player.preventsDisplaySleepDuringVideoPlayback = true
    player.allowsExternalPlayback = false
  }

  fileprivate func bind(_ id: String, _ key: String) {
    itemId = id
    mediaKey = key
  }

  var durationSeconds: Double {
    guard let d = player.currentItem?.duration, d.isNumeric else { return 0 }
    let s = CMTimeGetSeconds(d)
    return s.isFinite && s > 0 ? s : 0
  }

  var currentSeconds: Double {
    let s = CMTimeGetSeconds(player.currentTime())
    return s.isFinite && s > 0 ? s : 0
  }
}

final class RFPlayerPool {
  let slots: [RFPlayerSlot] = [RFPlayerSlot(), RFPlayerSlot(), RFPlayerSlot()]

  var onReady: ((RFPlayerSlot) -> Void)?
  var onEnd: ((RFPlayerSlot) -> Void)?
  var onFail: ((RFPlayerSlot) -> Void)?

  func slot(for id: String) -> RFPlayerSlot? {
    if id.isEmpty { return nil }
    return slots.first { $0.itemId == id }
  }

  /// `wanted` em ordem de prioridade (atual primeiro).
  func assign(_ wanted: [RFItem], currentId: String) {
    let wantedIds = Set(wanted.map { $0.id })
    var free = slots.filter { $0.itemId.isEmpty || !wantedIds.contains($0.itemId) }
    for it in wanted {
      if let s = slot(for: it.id) {
        if s.mediaKey != it.mediaKey { load(s, it) }
        continue
      }
      guard !free.isEmpty else { break }
      let s = free.removeFirst()
      load(s, it)
    }
    for s in slots where !s.itemId.isEmpty {
      let isCur = s.itemId == currentId
      s.player.currentItem?.preferredForwardBufferDuration = isCur ? 0 : 2.5
      if !isCur {
        s.player.isMuted = true
        if s.player.rate != 0 { s.player.pause() }
      }
    }
  }

  func reload(_ it: RFItem) {
    guard let s = slot(for: it.id) else { return }
    load(s, it)
  }

  func load(_ s: RFPlayerSlot, _ it: RFItem) {
    clear(s)
    s.bind(it.id, it.mediaKey)
    guard let url = RFPlayerPool.resolve(it) else {
      s.failed = true
      return
    }
    let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
    let item = AVPlayerItem(asset: asset)
    item.preferredForwardBufferDuration = 2.5
    item.canUseNetworkResourcesForLiveStreamingWhilePaused = false
    s.statusObs = item.observe(\.status, options: [.new]) { [weak self, weak s] obsItem, _ in
      DispatchQueue.main.async {
        guard let self = self, let s = s, s.player.currentItem === obsItem else { return }
        switch obsItem.status {
        case .readyToPlay:
          if !s.ready {
            s.ready = true
            self.onReady?(s)
          }
        case .failed:
          s.failed = true
          self.onFail?(s)
        default:
          break
        }
      }
    }
    s.endToken = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self, weak s] _ in
      guard let self = self, let s = s else { return }
      self.onEnd?(s)
    }
    s.failToken = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self, weak s] _ in
      guard let self = self, let s = s else { return }
      s.failed = true
      self.onFail?(s)
    }
    s.player.replaceCurrentItem(with: item)
  }

  func clear(_ s: RFPlayerSlot) {
    s.statusObs?.invalidate()
    s.statusObs = nil
    if let t = s.endToken { NotificationCenter.default.removeObserver(t) }
    if let t = s.failToken { NotificationCenter.default.removeObserver(t) }
    s.endToken = nil
    s.failToken = nil
    s.player.pause()
    s.player.replaceCurrentItem(with: nil)
    s.bind("", "")
    s.failed = false
    s.ready = false
    s.loops = 0
  }

  func releaseAll() {
    for s in slots { clear(s) }
  }

  func pauseAll() {
    for s in slots where s.player.rate != 0 { s.player.pause() }
  }

  /// file:// do cache em disco > HLS > MP4 remoto.
  static func resolve(_ it: RFItem) -> URL? {
    if let local = RFVideoCache.shared.localURL(for: it.videoUrl) { return local }
    if let h = RFItem.url(it.hlsUrl) { return h }
    return RFItem.url(it.videoUrl)
  }
}
