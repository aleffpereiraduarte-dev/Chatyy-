import UIKit
import AVFoundation

// [2026-10-14 native-viewer] Página do viewer: foto (UIScrollView com zoom
// 1…4 + UIImageView centralizada) ou vídeo (pôster + AVPlayerLayer).
// `page` é o conteúdo deslocado/escalado pelo arrasto de fechar.

final class MVPlayerView: UIView {
  override class var layerClass: AnyClass { return AVPlayerLayer.self }
  var playerLayer: AVPlayerLayer { return layer as! AVPlayerLayer }
}

enum MVAudio {
  private static var saved: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?

  /// Vídeo com som mesmo no silencioso (como Fotos/WhatsApp). Não mexe se uma
  /// ligação/gravação já está com a sessão (.playAndRecord / .record).
  static func prepareForPlayback() {
    let s = AVAudioSession.sharedInstance()
    if s.category == .playAndRecord || s.category == .record || s.category == .playback { return }
    if saved == nil { saved = (s.category, s.mode, s.categoryOptions) }
    try? s.setCategory(.playback, mode: .moviePlayback, options: [])
  }

  static func restore() {
    guard let sv = saved else { return }
    saved = nil
    let s = AVAudioSession.sharedInstance()
    if s.category != .playback { return } // alguém (ligação) trocou no meio — não pisa
    try? s.setCategory(sv.0, mode: sv.1, options: sv.2)
  }
}

final class MVPageCell: UICollectionViewCell, UIScrollViewDelegate {
  static let reuseId = "MVPageCell"
  static let pageSpacing: CGFloat = 12

  let page = UIView()
  let zoomView = UIScrollView()
  let imageView = UIImageView()
  private let posterView = UIImageView()
  private let playerView = MVPlayerView()
  private let spinner = UIActivityIndicatorView(style: .large)
  private let bigPlay = UIButton(type: .custom)
  private let errorStack = UIStackView()
  private let errorLabel = UILabel()
  private let retryButton = UIButton(type: .system)

  private(set) var item: MVItem?
  private var token = 0
  private var hasFull = false
  private var imageNatural: CGSize = .zero
  private var lastZoomBounds: CGSize = .zero

  private(set) var player: AVPlayer?
  private var readyObs: NSKeyValueObservation?
  private var statusObs: NSKeyValueObservation?
  private var tcsObs: NSKeyValueObservation?
  private var endObs: NSObjectProtocol?
  private var ended = false
  private(set) var isActive = false

  var onPlayerChanged: ((AVPlayer?) -> Void)?
  var onZoomChange: ((Bool) -> Void)?
  var labels: [String: String] = [:] {
    didSet {
      errorLabel.text = labels["loadFailed"] ?? ""
      if let r = labels["retry"], !r.isEmpty {
        retryButton.setTitle(r, for: .normal)
        retryButton.setImage(nil, for: .normal)
      } else {
        retryButton.setTitle(nil, for: .normal)
        retryButton.setImage(UIImage(systemName: "arrow.clockwise"), for: .normal)
      }
      bigPlay.accessibilityLabel = labels["play"]
    }
  }

  var isZoomed: Bool {
    return !zoomView.isHidden && zoomView.zoomScale > zoomView.minimumZoomScale + 0.01
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    setup()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    setup()
  }

  private func setup() {
    backgroundColor = .clear
    contentView.backgroundColor = .clear
    contentView.addSubview(page)
    page.backgroundColor = .clear

    zoomView.delegate = self
    zoomView.minimumZoomScale = 1
    zoomView.maximumZoomScale = 4
    zoomView.bouncesZoom = true
    zoomView.showsVerticalScrollIndicator = false
    zoomView.showsHorizontalScrollIndicator = false
    zoomView.contentInsetAdjustmentBehavior = .never
    zoomView.decelerationRate = .fast
    zoomView.isScrollEnabled = false
    zoomView.backgroundColor = .clear
    page.addSubview(zoomView)

    imageView.contentMode = .scaleAspectFit
    imageView.clipsToBounds = true
    imageView.isUserInteractionEnabled = false
    zoomView.addSubview(imageView)

    posterView.contentMode = .scaleAspectFit
    posterView.clipsToBounds = true
    page.addSubview(posterView)

    playerView.backgroundColor = .clear
    playerView.playerLayer.videoGravity = .resizeAspect
    page.addSubview(playerView)

    let cfg = UIImage.SymbolConfiguration(pointSize: 30, weight: .bold)
    bigPlay.setImage(UIImage(systemName: "play.fill", withConfiguration: cfg), for: .normal)
    bigPlay.tintColor = .white
    bigPlay.backgroundColor = UIColor.black.withAlphaComponent(0.45)
    bigPlay.layer.cornerRadius = 36
    bigPlay.contentEdgeInsets = UIEdgeInsets(top: 0, left: 4, bottom: 0, right: 0)
    bigPlay.addTarget(self, action: #selector(togglePlay), for: .touchUpInside)
    page.addSubview(bigPlay)

    spinner.color = .white
    spinner.hidesWhenStopped = true
    page.addSubview(spinner)

    errorStack.axis = .vertical
    errorStack.alignment = .center
    errorStack.spacing = 12
    errorLabel.textColor = UIColor.white.withAlphaComponent(0.85)
    errorLabel.font = .systemFont(ofSize: 15, weight: .medium)
    errorLabel.numberOfLines = 0
    errorLabel.textAlignment = .center
    retryButton.tintColor = .white
    retryButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
    retryButton.backgroundColor = UIColor.white.withAlphaComponent(0.18)
    retryButton.layer.cornerRadius = 18
    retryButton.contentEdgeInsets = UIEdgeInsets(top: 8, left: 18, bottom: 8, right: 18)
    retryButton.addTarget(self, action: #selector(retry), for: .touchUpInside)
    errorStack.addArrangedSubview(errorLabel)
    errorStack.addArrangedSubview(retryButton)
    errorStack.isHidden = true
    page.addSubview(errorStack)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let inset = MVPageCell.pageSpacing / 2
    let size = CGSize(width: max(0, contentView.bounds.width - inset * 2), height: contentView.bounds.height)
    // bounds + center (nunca frame): `page` pode estar com transform do arrasto.
    page.bounds = CGRect(origin: .zero, size: size)
    page.center = CGPoint(x: contentView.bounds.midX, y: contentView.bounds.midY)
    let b = page.bounds
    zoomView.frame = b
    posterView.frame = b
    playerView.frame = b
    bigPlay.bounds = CGRect(x: 0, y: 0, width: 72, height: 72)
    bigPlay.center = CGPoint(x: b.midX, y: b.midY)
    spinner.center = CGPoint(x: b.midX, y: b.midY)
    let es = errorStack.systemLayoutSizeFitting(CGSize(width: b.width - 48, height: b.height), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    errorStack.frame = CGRect(x: 24, y: (b.height - es.height) / 2, width: b.width - 48, height: es.height)
    if zoomView.bounds.size != lastZoomBounds {
      lastZoomBounds = zoomView.bounds.size
      fitImage(resetZoom: true)
    }
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    token += 1
    teardownPlayer()
    isActive = false
    zoomView.setZoomScale(1, animated: false)
    page.transform = .identity
    imageView.image = nil
    posterView.image = nil
    spinner.stopAnimating()
    errorStack.isHidden = true
  }

  // MARK: - Configure

  func configure(_ item: MVItem) {
    token += 1
    let t = token
    teardownPlayer()
    self.item = item
    hasFull = false
    ended = false
    isActive = false
    errorStack.isHidden = true
    spinner.stopAnimating()
    imageView.image = nil
    posterView.image = nil
    page.transform = .identity
    zoomView.setZoomScale(1, animated: false)
    imageNatural = (item.width > 0 && item.height > 0) ? CGSize(width: item.width, height: item.height) : .zero

    zoomView.isHidden = item.isVideo
    posterView.isHidden = !item.isVideo
    playerView.isHidden = !item.isVideo
    bigPlay.isHidden = !item.isVideo
    if item.isVideo {
      loadPoster(t)
    } else {
      fitImage(resetZoom: true)
      loadImage(t)
    }
    setNeedsLayout()
  }

  @objc private func retry() {
    guard let it = item else { return }
    let wasActive = isActive
    configure(it)
    if wasActive { activate() }
  }

  private func showError() {
    spinner.stopAnimating()
    bigPlay.isHidden = true
    errorStack.isHidden = false
    setNeedsLayout()
  }

  private func delayedSpinner(_ t: Int) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
      guard let self = self, self.token == t, !self.hasFull, self.errorStack.isHidden else { return }
      self.spinner.startAnimating()
    }
  }

  // MARK: - Image

  private func fullSources(_ item: MVItem) -> [String] {
    var out: [String] = []
    if !item.localUri.isEmpty { out.append(item.localUri) }
    if !item.uri.isEmpty && item.uri != item.localUri { out.append(item.uri) }
    return out
  }

  private func loadImage(_ t: Int) {
    guard let item = item else { return }
    let loader = MVImageLoader.shared
    let sources = fullSources(item)
    for s in sources {
      if let img = loader.cachedImage(s, maxPixel: MVImageLoader.fullMaxPixel) {
        applyFull(img, animated: false)
        return
      }
    }
    if !item.thumbUri.isEmpty {
      if let th = loader.cachedImage(item.thumbUri, maxPixel: MVImageLoader.thumbMaxPixel) {
        applyThumb(th)
      } else {
        loader.load(item.thumbUri, maxPixel: MVImageLoader.thumbMaxPixel) { [weak self] img in
          guard let self = self, self.token == t, !self.hasFull, let img = img else { return }
          self.applyThumb(img)
        }
      }
    }
    delayedSpinner(t)
    loadFull(sources, 0, t)
  }

  private func loadFull(_ sources: [String], _ i: Int, _ t: Int) {
    guard i < sources.count else {
      if token == t && !hasFull {
        // Sem a grande mas com miniatura: mostra a miniatura + aviso.
        showError()
      }
      return
    }
    MVImageLoader.shared.load(sources[i], maxPixel: MVImageLoader.fullMaxPixel) { [weak self] img in
      guard let self = self, self.token == t else { return }
      if let img = img {
        self.applyFull(img, animated: self.imageView.image != nil)
      } else {
        self.loadFull(sources, i + 1, t)
      }
    }
  }

  private func applyThumb(_ img: UIImage) {
    imageView.image = img
    if imageNatural == .zero {
      imageNatural = img.size
      if !isZoomed { fitImage(resetZoom: true) }
    }
  }

  private func applyFull(_ img: UIImage, animated: Bool) {
    hasFull = true
    spinner.stopAnimating()
    errorStack.isHidden = true
    let nat = img.size
    var changed = true
    if imageNatural.width > 0, imageNatural.height > 0, nat.width > 0, nat.height > 0 {
      changed = abs(imageNatural.width / imageNatural.height - nat.width / nat.height) > 0.01
    }
    if changed { imageNatural = nat }
    if animated {
      UIView.transition(with: imageView, duration: 0.18, options: [.transitionCrossDissolve, .allowUserInteraction], animations: {
        self.imageView.image = img
      }, completion: nil)
    } else {
      imageView.image = img
    }
    if changed && !isZoomed { fitImage(resetZoom: true) }
    if img.images != nil { imageView.startAnimating() }
  }

  private func fitImage(resetZoom: Bool) {
    let b = zoomView.bounds.size
    guard b.width > 0, b.height > 0 else { return }
    if resetZoom { zoomView.zoomScale = 1 }
    var nat = imageNatural
    if nat.width <= 0 || nat.height <= 0 { nat = b }
    let s = min(b.width / nat.width, b.height / nat.height)
    let sz = CGSize(width: max(1, floor(nat.width * s)), height: max(1, floor(nat.height * s)))
    imageView.frame = CGRect(origin: .zero, size: sz)
    zoomView.contentSize = sz
    centerContent()
    zoomView.contentOffset = CGPoint(x: -zoomView.contentInset.left, y: -zoomView.contentInset.top)
    zoomView.isScrollEnabled = false
  }

  private func centerContent() {
    let b = zoomView.bounds.size
    let c = zoomView.contentSize
    let ix = max(0, (b.width - c.width) / 2)
    let iy = max(0, (b.height - c.height) / 2)
    zoomView.contentInset = UIEdgeInsets(top: iy, left: ix, bottom: iy, right: ix)
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? {
    return imageView
  }

  func scrollViewDidZoom(_ scrollView: UIScrollView) {
    centerContent()
    let z = isZoomed
    // Ampliada → o arrasto é da foto (e, na borda, o pager assume — nested
    // UIScrollView nativo). Em 1× o pan interno fica desligado.
    zoomView.isScrollEnabled = z
    onZoomChange?(z)
  }

  func handleDoubleTap(_ g: UITapGestureRecognizer) {
    guard let item = item, !item.isVideo, imageView.image != nil else { return }
    if isZoomed {
      zoomView.setZoomScale(1, animated: true)
      return
    }
    let p = g.location(in: imageView)
    let scale: CGFloat = 2.5
    let w = zoomView.bounds.width / scale
    let h = zoomView.bounds.height / scale
    zoomView.zoom(to: CGRect(x: p.x - w / 2, y: p.y - h / 2, width: w, height: h), animated: true)
  }

  func resetZoom() {
    if isZoomed { zoomView.setZoomScale(1, animated: false) }
  }

  // MARK: - Video

  private func loadPoster(_ t: Int) {
    guard let item = item, !item.thumbUri.isEmpty else { return }
    let loader = MVImageLoader.shared
    if let img = loader.cachedImage(item.thumbUri, maxPixel: MVImageLoader.thumbMaxPixel) {
      posterView.image = img
      return
    }
    loader.load(item.thumbUri, maxPixel: MVImageLoader.thumbMaxPixel) { [weak self] img in
      guard let self = self, self.token == t, let img = img else { return }
      self.posterView.image = img
    }
  }

  func activate() {
    isActive = true
    guard let item = item, item.isVideo, errorStack.isHidden else { return }
    startPlayer()
  }

  func deactivate() {
    isActive = false
    player?.pause()
    resetZoom()
  }

  private func startPlayer() {
    guard let item = item, item.isVideo else { return }
    if player == nil {
      let url = MVItem.existingFileURL(item.localUri) ?? MVItem.existingFileURL(item.uri) ?? MVItem.remoteURL(item.uri)
      guard let u = url else { showError(); return }
      let p = AVPlayer(url: u)
      p.actionAtItemEnd = .pause
      playerView.playerLayer.player = p
      let t = token
      readyObs = playerView.playerLayer.observe(\.isReadyForDisplay, options: [.initial, .new]) { [weak self] layer, _ in
        let ready = layer.isReadyForDisplay
        DispatchQueue.main.async {
          guard let self = self, self.token == t, ready else { return }
          self.posterView.isHidden = true
          self.spinner.stopAnimating()
        }
      }
      statusObs = p.currentItem?.observe(\.status, options: [.new]) { [weak self] it, _ in
        let failed = it.status == .failed
        DispatchQueue.main.async {
          guard let self = self, self.token == t, failed else { return }
          self.showError()
        }
      }
      tcsObs = p.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] _, _ in
        DispatchQueue.main.async { self?.updatePlayUI() }
      }
      endObs = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main) { [weak self] _ in
        self?.ended = true
        self?.updatePlayUI()
      }
      player = p
      delayedSpinner(t)
      onPlayerChanged?(p)
    }
    MVAudio.prepareForPlayback()
    if ended {
      ended = false
      player?.seek(to: .zero)
    }
    player?.play()
  }

  @objc func togglePlay() {
    guard let item = item, item.isVideo else { return }
    guard let p = player else { startPlayer(); return }
    if p.timeControlStatus == .paused {
      MVAudio.prepareForPlayback()
      if ended {
        ended = false
        p.seek(to: .zero)
      }
      p.play()
    } else {
      p.pause()
    }
  }

  private func updatePlayUI() {
    guard let item = item, item.isVideo else { bigPlay.isHidden = true; return }
    let paused = player == nil || player?.timeControlStatus == .paused
    bigPlay.isHidden = !paused || !errorStack.isHidden
    if player?.timeControlStatus == .waitingToPlayAtSpecifiedRate && posterView.isHidden == false {
      spinner.startAnimating()
    } else if player?.timeControlStatus == .playing {
      spinner.stopAnimating()
    }
  }

  func pausePlayback() {
    player?.pause()
  }

  private func teardownPlayer() {
    let had = player != nil
    player?.pause()
    readyObs?.invalidate(); readyObs = nil
    statusObs?.invalidate(); statusObs = nil
    tcsObs?.invalidate(); tcsObs = nil
    if let o = endObs { NotificationCenter.default.removeObserver(o) }
    endObs = nil
    playerView.playerLayer.player = nil
    player = nil
    ended = false
    if had { onPlayerChanged?(nil) }
  }
}
