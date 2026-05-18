import ExpoModulesCore
import UIKit
import AVFoundation

// -----------------------------------------------------------------------------
// ShortsPlayerView — Stage 2 (2026-05-16)
//
// UIView hosting an AVPlayerLayer whose player is loaned from
// AVPoolManager. Mirrors ShortsPlayerView.kt on Android.
//
// Lifecycle:
//   - setVideoUrl       → ask pool for an AVPlayer bound to that URL,
//                          attach our layer to it, install KVO + loop
//                          observers, resync mute/rate, kick play/pause.
//   - setPlayWhenInFocus → play() / pause(); player stays attached.
//   - deinit / view removal → drop KVO + loop observer, layer.player = nil.
//                              Do NOT release the player — pool owns it.
//
// Fallback: if anything throws, show a placeholder label (Stage 1 vibe)
// and emit onError to JS.
// -----------------------------------------------------------------------------

public class ShortsPlayerView: ExpoView {

  // Expo event dispatchers (declared as ExpoModulesCore EventDispatchers).
  let onPlaybackReady = EventDispatcher()
  let onBuffering = EventDispatcher()
  let onError = EventDispatcher()
  // Stage 3 (2026-05-18): periodic time update so the JS scrubber can stay
  // in sync without polling the WebView (now killed). Emits {ms,dur} ~10fps.
  let onTime = EventDispatcher()

  private let containerView = UIView()
  private let playerLayer = AVPlayerLayer()
  private let fallbackLabel = UILabel()

  private var videoUrl: String?
  private var playWhenInFocus: Bool = false
  private var mutedFlag: Bool = true // WhatsApp/IG default
  private var playbackRate: Double = 1.0

  private weak var boundPlayer: AVPlayer?
  private var timeControlStatusObs: NSKeyValueObservation?
  private var statusObs: NSKeyValueObservation?
  private var loopObserver: NSObjectProtocol?
  private var periodicTimeObs: Any?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    setupUI()
  }

  deinit {
    teardownObservers()
    playerLayer.player = nil
  }

  // ---------------------------------------------------------------------------
  // setup
  // ---------------------------------------------------------------------------

  private func setupUI() {
    backgroundColor = .black
    clipsToBounds = true

    containerView.backgroundColor = .black
    containerView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(containerView)
    NSLayoutConstraint.activate([
      containerView.leadingAnchor.constraint(equalTo: leadingAnchor),
      containerView.trailingAnchor.constraint(equalTo: trailingAnchor),
      containerView.topAnchor.constraint(equalTo: topAnchor),
      containerView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])

    playerLayer.videoGravity = .resizeAspectFill
    playerLayer.backgroundColor = UIColor.black.cgColor
    containerView.layer.addSublayer(playerLayer)

    fallbackLabel.text = "Shorts player"
    fallbackLabel.textColor = .white
    fallbackLabel.font = .systemFont(ofSize: 14)
    fallbackLabel.textAlignment = .center
    fallbackLabel.isHidden = true
    fallbackLabel.translatesAutoresizingMaskIntoConstraints = false
    addSubview(fallbackLabel)
    NSLayoutConstraint.activate([
      fallbackLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
      fallbackLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    playerLayer.frame = containerView.bounds
  }

  // ---------------------------------------------------------------------------
  // prop setters
  // ---------------------------------------------------------------------------

  func setVideoUrl(_ url: String?) {
    if url == videoUrl && boundPlayer != nil { return }
    videoUrl = url
    guard let url = url, !url.isEmpty else {
      detachPlayer()
      return
    }
    attachPlayer(for: url)
  }

  func setPlayWhenInFocus(_ enabled: Bool) {
    playWhenInFocus = enabled
    guard let p = boundPlayer else { return }
    if enabled {
      p.play()
      if playbackRate != 1.0 { p.rate = Float(playbackRate) }
    } else {
      p.pause()
    }
  }

  func setMuted(_ value: Bool) {
    mutedFlag = value
    boundPlayer?.isMuted = value
  }

  func setPlaybackRate(_ rate: Double) {
    playbackRate = rate
    if let p = boundPlayer, p.timeControlStatus == .playing {
      p.rate = Float(rate)
    }
  }

  /// Seek the bound player to the given offset in milliseconds. No-op when
  /// nothing is bound yet. Called via ExpoShortsModule.seek(viewTag, ms).
  func seek(toMillis ms: Double) {
    guard let p = boundPlayer else { return }
    let secs = max(0, ms / 1000.0)
    let t = CMTime(seconds: secs, preferredTimescale: 600)
    p.seek(to: t, toleranceBefore: .zero, toleranceAfter: .zero)
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private func attachPlayer(for urlString: String) {
    guard let player = AVPoolManager.shared.getPlayer(forUrlString: urlString) else {
      showFallback(message: "pool init failed")
      return
    }
    // Same player as before? Just resync state.
    if boundPlayer !== player {
      teardownObservers()
      boundPlayer = player
      playerLayer.player = player
      installObservers(on: player)
    } else {
      playerLayer.player = player
    }
    player.isMuted = mutedFlag
    if playWhenInFocus {
      player.play()
      if playbackRate != 1.0 { player.rate = Float(playbackRate) }
    } else {
      player.pause()
    }
    fallbackLabel.isHidden = true
    playerLayer.isHidden = false
  }

  private func detachPlayer() {
    teardownObservers()
    boundPlayer = nil
    playerLayer.player = nil
  }

  private func installObservers(on player: AVPlayer) {
    // timeControlStatus tells us playing / paused / waitingToPlay (buffer).
    timeControlStatusObs = player.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
      guard let self = self else { return }
      switch p.timeControlStatus {
      case .waitingToPlayAtSpecifiedRate:
        self.onBuffering(["progress": 0.0])
      case .playing, .paused:
        break
      @unknown default: break
      }
    }

    // currentItem.status flips to .readyToPlay when first frame is decodable.
    if let item = player.currentItem {
      statusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
        guard let self = self else { return }
        switch it.status {
        case .readyToPlay:
          self.onPlaybackReady([:])
        case .failed:
          let msg = it.error?.localizedDescription ?? "player item failed"
          self.onError(["message": msg])
        default: break
        }
      }
    }

    // Loop forever — Reels behaviour.
    loopObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: player.currentItem,
      queue: .main
    ) { [weak player] _ in
      player?.seek(to: .zero)
      player?.play()
    }

    // Periodic time observer for the JS scrubber. 120ms ≈ 8fps — matches the
    // old WebView watchdog and is light on main thread.
    let interval = CMTime(seconds: 0.12, preferredTimescale: 600)
    periodicTimeObs = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self, weak player] time in
      guard let self = self, let p = player else { return }
      let ms = CMTimeGetSeconds(time) * 1000.0
      let durSec = CMTimeGetSeconds(p.currentItem?.duration ?? .zero)
      let durMs = durSec.isFinite ? durSec * 1000.0 : 0
      self.onTime(["ms": ms, "dur": durMs])
    }
  }

  private func teardownObservers() {
    timeControlStatusObs?.invalidate()
    timeControlStatusObs = nil
    statusObs?.invalidate()
    statusObs = nil
    if let obs = loopObserver {
      NotificationCenter.default.removeObserver(obs)
      loopObserver = nil
    }
    if let obs = periodicTimeObs, let p = boundPlayer {
      p.removeTimeObserver(obs)
    }
    periodicTimeObs = nil
  }

  private func showFallback(message: String) {
    playerLayer.isHidden = true
    fallbackLabel.isHidden = false
    onError(["message": message])
  }
}
