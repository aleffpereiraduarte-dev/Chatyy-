import UIKit
import AVFoundation

// [2026-10-15 native-list fase 2] Nota de vídeo redonda (nó `vn`): pôster no
// círculo; toque toca INLINE (AVPlayerLayer recortado em círculo) com anel de
// progresso; toque de novo pausa; só 1 tocando no app inteiro; para ao
// reciclar/sair da tela; no fim volta ao pôster.

final class CMLVideoNoteView: UIView {
  private static weak var current: CMLVideoNoteView?

  private let poster = UIImageView()
  private let videoHost = UIView()
  private let playerLayer = AVPlayerLayer()
  private let track = CAShapeLayer()
  private let ring = CAShapeLayer()
  private let playIcon = CMLIconView()
  private let durView = CMLTextView()

  private var player: AVPlayer?
  private var timeObs: Any?
  private var endObs: NSObjectProtocol?
  private var uri = ""
  private var posterUri = ""
  private var posterToken = ""
  private var duration: Double = 0
  private(set) var playing = false

  /// "play" | "pause" | "end"
  var onEvent: ((String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    clipsToBounds = false
    poster.contentMode = .scaleAspectFill
    poster.clipsToBounds = true
    addSubview(poster)
    videoHost.clipsToBounds = true
    videoHost.isHidden = true
    videoHost.layer.addSublayer(playerLayer)
    playerLayer.videoGravity = .resizeAspectFill
    addSubview(videoHost)
    track.fillColor = UIColor.clear.cgColor
    track.strokeColor = UIColor(white: 1, alpha: 0.25).cgColor
    track.lineWidth = 3
    track.isHidden = true
    ring.fillColor = UIColor.clear.cgColor
    ring.strokeColor = UIColor.white.cgColor
    ring.lineWidth = 3
    ring.lineCap = .round
    ring.strokeEnd = 0
    ring.isHidden = true
    layer.addSublayer(track)
    layer.addSublayer(ring)
    playIcon.kind = .play
    playIcon.color = .white
    playIcon.disc = UIColor(white: 0, alpha: 0.45)
    addSubview(playIcon)
    addSubview(durView)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    teardown()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = bounds
    poster.frame = b
    poster.layer.cornerRadius = b.width / 2
    videoHost.frame = b
    videoHost.layer.cornerRadius = b.width / 2
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    playerLayer.frame = videoHost.bounds
    let p = UIBezierPath(arcCenter: CGPoint(x: b.midX, y: b.midY), radius: max(1, b.width / 2 - 1.5), startAngle: -.pi / 2, endAngle: .pi * 1.5, clockwise: true).cgPath
    track.frame = b
    ring.frame = b
    track.path = p
    ring.path = p
    CATransaction.commit()
    let s: CGFloat = 46
    playIcon.frame = CGRect(x: b.midX - s / 2, y: b.midY - s / 2, width: s, height: s)
    if let dl = durView.layout {
      durView.frame = durView.glowFrame(CGRect(x: b.midX - dl.size.width / 2, y: b.maxY - dl.size.height - 14, width: dl.size.width + 1, height: dl.size.height))
    }
  }

  func configure(_ n: CMLNode, bg: UIColor?) {
    if n.uri != uri { stop(); uri = n.uri }
    duration = n.duration
    poster.backgroundColor = n.bg ?? bg ?? UIColor(white: 0.5, alpha: 0.25)
    ring.strokeColor = (n.ring ?? .white).cgColor
    if posterUri != n.poster || poster.image == nil {
      posterUri = n.poster
      let tok = n.poster
      posterToken = tok
      let px = max(bounds.width, n.size) * UIScreen.main.scale
      if tok.isEmpty {
        poster.image = nil
      } else if let img = CMLImageLoader.shared.cached(tok, maxPixel: px) {
        poster.image = img
      } else {
        poster.image = nil
        CMLImageLoader.shared.load(tok, maxPixel: px) { [weak self] img in
          guard let self = self, self.posterToken == tok else { return }
          self.poster.image = img
        }
      }
    }
    updateDuration(remaining: duration)
    setNeedsLayout()
  }

  private func updateDuration(remaining: Double) {
    if duration <= 0 && !playing { durView.layout = nil; durView.isHidden = true; return }
    let sec = max(0, Int(remaining.rounded()))
    let txt = String(format: "%d:%02d", sec / 60, sec % 60)
    let dl = CMLLayoutBuilder.line(txt, font: UIFont.systemFont(ofSize: 12, weight: .semibold), color: .white, maxWidth: 80)
    durView.layout = dl
    durView.isHidden = false
    // [2026-10-19 perf-scroll] sombra pré-renderizada (era layer.shadow sem shadowPath)
    durView.glow = 4
    setNeedsLayout()
  }

  /// Toca/pausa; devolve o novo estado ("play" | "pause"), "" se sem vídeo.
  @discardableResult
  func toggle() -> String {
    if playing { pause(); return "pause" }
    return play() ? "play" : ""
  }

  private func play() -> Bool {
    guard let url = CMLImageLoader.fileURL(uri) ?? CMLImageLoader.remoteURL(uri) else { return false }
    if let cur = CMLVideoNoteView.current, cur !== self { cur.stop() }
    CMLVideoNoteView.current = self
    let ses = AVAudioSession.sharedInstance()
    if ses.category != .playAndRecord {
      try? ses.setCategory(.playback, mode: .moviePlayback, options: [])
      try? ses.setActive(true)
    }
    if player == nil {
      let item = AVPlayerItem(url: url)
      let p = AVPlayer(playerItem: item)
      p.actionAtItemEnd = .pause
      player = p
      playerLayer.player = p
      timeObs = p.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] t in
        self?.tick(t)
      }
      endObs = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
        self?.finish()
      }
    }
    player?.play()
    playing = true
    videoHost.isHidden = false
    track.isHidden = false
    ring.isHidden = false
    playIcon.isHidden = true
    return true
  }

  private func pause() {
    player?.pause()
    playing = false
    playIcon.isHidden = false
  }

  private func tick(_ t: CMTime) {
    guard let item = player?.currentItem else { return }
    let d = item.duration.seconds
    let total = (d.isFinite && d > 0) ? d : duration
    let pos = t.seconds.isFinite ? t.seconds : 0
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    ring.strokeEnd = total > 0 ? CGFloat(min(1, max(0, pos / total))) : 0
    CATransaction.commit()
    if total > 0 { updateDuration(remaining: max(0, total - pos)) }
  }

  private func finish() {
    stop()
    onEvent?("end")
  }

  /// Para e volta ao pôster (reciclagem, outra nota tocando, fim).
  func stop() {
    let was = player != nil
    teardown()
    playing = false
    videoHost.isHidden = true
    track.isHidden = true
    ring.isHidden = true
    ring.strokeEnd = 0
    playIcon.isHidden = false
    if was { updateDuration(remaining: duration) }
    if CMLVideoNoteView.current === self { CMLVideoNoteView.current = nil }
  }

  private func teardown() {
    if let o = timeObs, let p = player { p.removeTimeObserver(o) }
    timeObs = nil
    if let e = endObs { NotificationCenter.default.removeObserver(e) }
    endObs = nil
    player?.pause()
    playerLayer.player = nil
    player = nil
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil && playing { stop() }
  }
}
