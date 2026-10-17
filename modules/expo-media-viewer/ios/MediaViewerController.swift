import UIKit
import AVFoundation

// [2026-10-14 native-viewer] Tela cheia do viewer nativo. Ver ChatyyMediaViewerModule.swift.

final class MVGradientView: UIView {
  override class var layerClass: AnyClass { return CAGradientLayer.self }

  init(fromTop: Bool) {
    super.init(frame: .zero)
    let g = layer as! CAGradientLayer
    let dark = UIColor.black.withAlphaComponent(0.62).cgColor
    let clear = UIColor.black.withAlphaComponent(0).cgColor
    g.colors = fromTop ? [dark, clear] : [clear, dark]
    g.locations = [0, 1]
    backgroundColor = .clear
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
  }
}

final class MVVideoBar: UIView {
  let playButton = UIButton(type: .system)
  let slider = UISlider()
  let timeLabel = UILabel()
  let durationLabel = UILabel()
  var onToggle: (() -> Void)?

  private var player: AVPlayer?
  private var timeObs: Any?
  private var tcsObs: NSKeyValueObservation?
  private var scrubbing = false
  private var wasPlaying = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    setup()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    setup()
  }

  private func setup() {
    playButton.tintColor = .white
    playButton.addTarget(self, action: #selector(tapToggle), for: .touchUpInside)
    setPlayIcon(playing: false)

    for l in [timeLabel, durationLabel] {
      l.textColor = .white
      l.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
      l.text = "0:00"
      l.setContentHuggingPriority(.required, for: .horizontal)
      l.setContentCompressionResistancePriority(.required, for: .horizontal)
    }
    slider.minimumValue = 0
    slider.maximumValue = 1
    slider.minimumTrackTintColor = .white
    slider.maximumTrackTintColor = UIColor.white.withAlphaComponent(0.35)
    slider.setThumbImage(MVVideoBar.thumbImage(), for: .normal)
    slider.addTarget(self, action: #selector(scrubBegan), for: .touchDown)
    slider.addTarget(self, action: #selector(scrubChanged), for: .valueChanged)
    slider.addTarget(self, action: #selector(scrubEnded), for: [.touchUpInside, .touchUpOutside, .touchCancel])

    let row = UIStackView(arrangedSubviews: [playButton, timeLabel, slider, durationLabel])
    row.axis = .horizontal
    row.alignment = .center
    row.spacing = 10
    row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: leadingAnchor),
      row.trailingAnchor.constraint(equalTo: trailingAnchor),
      row.topAnchor.constraint(equalTo: topAnchor),
      row.bottomAnchor.constraint(equalTo: bottomAnchor),
      playButton.widthAnchor.constraint(equalToConstant: 36),
      playButton.heightAnchor.constraint(equalToConstant: 36),
    ])
  }

  private static func thumbImage() -> UIImage {
    let d: CGFloat = 14
    let r = UIGraphicsImageRenderer(size: CGSize(width: d, height: d))
    return r.image { ctx in
      UIColor.white.setFill()
      ctx.cgContext.fillEllipse(in: CGRect(x: 0, y: 0, width: d, height: d))
    }
  }

  func setLabels(play: String?, pause: String?) {
    playLabel = play
    pauseLabel = pause
    setPlayIcon(playing: player?.timeControlStatus != nil && player?.timeControlStatus != .paused)
  }
  private var playLabel: String?
  private var pauseLabel: String?

  private func setPlayIcon(playing: Bool) {
    let cfg = UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)
    playButton.setImage(UIImage(systemName: playing ? "pause.fill" : "play.fill", withConfiguration: cfg), for: .normal)
    playButton.accessibilityLabel = playing ? pauseLabel : playLabel
  }

  func bind(_ p: AVPlayer?) {
    if p === player { return }
    unbind()
    player = p
    guard let p = p else {
      slider.value = 0
      timeLabel.text = "0:00"
      durationLabel.text = "0:00"
      setPlayIcon(playing: false)
      return
    }
    timeObs = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] t in
      self?.update(time: t)
    }
    tcsObs = p.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] pl, _ in
      let playing = pl.timeControlStatus != .paused
      DispatchQueue.main.async { self?.setPlayIcon(playing: playing) }
    }
    update(time: p.currentTime())
  }

  func unbind() {
    if let o = timeObs, let p = player { p.removeTimeObserver(o) }
    timeObs = nil
    tcsObs?.invalidate()
    tcsObs = nil
    player = nil
    scrubbing = false
  }

  private func durationSeconds() -> Double {
    guard let d = player?.currentItem?.duration, d.isNumeric else { return 0 }
    let s = CMTimeGetSeconds(d)
    return s.isFinite && s > 0 ? s : 0
  }

  private func update(time: CMTime) {
    if scrubbing { return }
    let cur = CMTimeGetSeconds(time)
    let dur = durationSeconds()
    timeLabel.text = MVVideoBar.fmt(cur.isFinite ? cur : 0)
    durationLabel.text = MVVideoBar.fmt(dur)
    slider.value = dur > 0 ? Float(max(0, min(1, cur / dur))) : 0
  }

  static func fmt(_ secs: Double) -> String {
    let s = max(0, Int(secs.rounded(.down)))
    if s >= 3600 {
      return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
    }
    return String(format: "%d:%02d", s / 60, s % 60)
  }

  @objc private func tapToggle() { onToggle?() }

  @objc private func scrubBegan() {
    guard let p = player else { return }
    scrubbing = true
    wasPlaying = p.timeControlStatus != .paused
    p.pause()
  }

  @objc private func scrubChanged() {
    guard let p = player else { return }
    let dur = durationSeconds()
    guard dur > 0 else { return }
    let target = Double(slider.value) * dur
    timeLabel.text = MVVideoBar.fmt(target)
    p.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
  }

  @objc private func scrubEnded() {
    guard let p = player else { scrubbing = false; return }
    scrubbing = false
    if wasPlaying { p.play() }
  }
}

final class MediaViewerController: UIViewController, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout, UIGestureRecognizerDelegate {
  var onIndexChange: ((Int) -> Void)?
  var onAction: ((String, Int, [String: Any]) -> Void)?
  var onClose: ((Int, String) -> Void)?

  private var items: [MVItem]
  private var currentIndex: Int
  private let labels: [String: String]
  private let flags: MVFlags

  private var chromeVisible = true
  private var closed = false
  private var relayouting = false
  private var lastSize: CGSize = .zero
  private var didInitialLayout = false
  private weak var panCell: MVPageCell?
  private var bgObserver: NSObjectProtocol?
  private var captureObserver: NSObjectProtocol?
  private var captureShield: UIView?

  private let backdrop = UIView()
  private let layout = UICollectionViewFlowLayout()
  private var collectionView: UICollectionView!

  private let topBar = MVGradientView(fromTop: true)
  private let bottomBar = MVGradientView(fromTop: false)
  private let closeButton = UIButton(type: .system)
  private let titleLabel = UILabel()
  private let subtitleLabel = UILabel()
  private let counterLabel = UILabel()
  private let captionLabel = UILabel()
  private let videoBar = MVVideoBar()
  private let actionsRow = UIStackView()
  private var actionButtons: [String: UIButton] = [:]
  private var actionSpinners: [String: UIActivityIndicatorView] = [:]
  private var actionResets: [String: DispatchWorkItem] = [:]

  private let singleTap = UITapGestureRecognizer()
  private let doubleTap = UITapGestureRecognizer()
  private let dismissPan = UIPanGestureRecognizer()

  // [2026-10-15 hero] Transição bolha ↔ viewer (Telegram/WhatsApp): a foto sai
  // do frame da miniatura (coordenadas de janela) e volta para a bolha da
  // página atual ao fechar. Sem frame de volta → fechamento normal.
  private var heroSource: CGRect?
  private var heroSourceRadius: CGFloat = 0
  private var heroOpenStarted = false
  private var returnRects: [Int: CGRect] = [:]
  private var returnRadii: [Int: CGFloat] = [:]
  private weak var heroView: UIImageView?

  init(items: [MVItem], index: Int, labels: [String: String], flags: MVFlags) {
    self.items = items
    self.currentIndex = index
    self.labels = labels
    self.flags = flags
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .overFullScreen
    modalTransitionStyle = .crossDissolve
    modalPresentationCapturesStatusBarAppearance = true
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) not supported")
  }

  /// Chamado ANTES do present (sem animação do sistema — o hero é a animação).
  func setHeroSource(_ rect: CGRect, radius: CGFloat) {
    heroSource = rect
    heroSourceRadius = max(0, radius)
    returnRects[currentIndex] = rect
    returnRadii[currentIndex] = max(0, radius)
  }

  func setReturnRect(index: Int, rect: CGRect?, radius: CGFloat) {
    if let r = rect {
      returnRects[index] = r
      returnRadii[index] = max(0, radius)
    } else {
      returnRects.removeValue(forKey: index)
      returnRadii.removeValue(forKey: index)
    }
  }

  override var prefersStatusBarHidden: Bool { return !chromeVisible }
  override var preferredStatusBarStyle: UIStatusBarStyle { return .lightContent }
  override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { return .fade }
  override var prefersHomeIndicatorAutoHidden: Bool { return !chromeVisible }

  // MARK: - Lifecycle

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear

    backdrop.backgroundColor = .black
    backdrop.frame = view.bounds
    backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(backdrop)

    layout.scrollDirection = .horizontal
    layout.minimumLineSpacing = 0
    layout.minimumInteritemSpacing = 0
    layout.sectionInset = .zero
    collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: layout)
    collectionView.backgroundColor = .clear
    collectionView.isPagingEnabled = true
    collectionView.showsHorizontalScrollIndicator = false
    collectionView.showsVerticalScrollIndicator = false
    collectionView.alwaysBounceVertical = false
    collectionView.contentInsetAdjustmentBehavior = .never
    collectionView.register(MVPageCell.self, forCellWithReuseIdentifier: MVPageCell.reuseId)
    collectionView.dataSource = self
    collectionView.delegate = self
    view.addSubview(collectionView)

    doubleTap.numberOfTapsRequired = 2
    doubleTap.addTarget(self, action: #selector(handleDoubleTap(_:)))
    doubleTap.delegate = self
    collectionView.addGestureRecognizer(doubleTap)

    singleTap.numberOfTapsRequired = 1
    singleTap.addTarget(self, action: #selector(handleSingleTap(_:)))
    singleTap.delegate = self
    singleTap.require(toFail: doubleTap)
    collectionView.addGestureRecognizer(singleTap)

    dismissPan.maximumNumberOfTouches = 1
    dismissPan.addTarget(self, action: #selector(handleDismissPan(_:)))
    dismissPan.delegate = self
    collectionView.addGestureRecognizer(dismissPan)
    // Arrasto vertical = fechar; o pan do pager só assume quando o de fechar
    // falha (horizontal / foto ampliada) — sem disputa no 1º movimento.
    collectionView.panGestureRecognizer.require(toFail: dismissPan)

    buildChrome()
    updateChrome()

    if heroSource != nil {
      // Tudo invisível até o hero começar (a bolha continua aparecendo por baixo).
      backdrop.alpha = 0
      collectionView.alpha = 0
      topBar.alpha = 0
      bottomBar.alpha = 0
    }

    // App foi p/ segundo plano: vídeo não segue tocando (o app tem modo de
    // áudio em background por causa das ligações).
    bgObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self = self, let cv = self.collectionView else { return }
      for c in cv.visibleCells { (c as? MVPageCell)?.pausePlayback() }
    }

    if flags.secure {
      captureObserver = NotificationCenter.default.addObserver(forName: UIScreen.capturedDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
        self?.updateCaptureShield()
      }
      updateCaptureShield()
    }
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    if heroSource != nil && !heroOpenStarted {
      heroOpenStarted = true
      runHeroOpen()
    }
  }

  // MARK: - Hero

  /// Imagem já disponível (memória) para a página `index`.
  private func cachedHeroImage(_ index: Int) -> UIImage? {
    guard index >= 0, index < items.count else { return nil }
    let it = items[index]
    let loader = MVImageLoader.shared
    if !it.isVideo {
      for s in [it.localUri, it.uri] where !s.isEmpty {
        if let img = loader.cachedImage(s, maxPixel: MVImageLoader.fullMaxPixel) { return img }
      }
    }
    if !it.thumbUri.isEmpty, let th = loader.cachedImage(it.thumbUri, maxPixel: MVImageLoader.thumbMaxPixel) {
      return th
    }
    return nil
  }

  /// Retângulo aspect-fit (coordenadas de `view`) — igual ao da página em 1×.
  private func heroFitRect(_ img: UIImage, index: Int) -> CGRect {
    let b = view.bounds
    var nat = img.size
    if index >= 0, index < items.count, items[index].width > 0, items[index].height > 0 {
      nat = CGSize(width: items[index].width, height: items[index].height)
    }
    guard nat.width > 0, nat.height > 0, b.width > 0, b.height > 0 else { return b }
    let s = min(b.width / nat.width, b.height / nat.height)
    let w = floor(nat.width * s)
    let h = floor(nat.height * s)
    return CGRect(x: b.midX - w / 2, y: b.midY - h / 2, width: w, height: h)
  }

  private func runHeroOpen() {
    if closed { return }
    let idx = currentIndex
    if let img = currentCell()?.heroImage ?? cachedHeroImage(idx) {
      animateHeroIn(img)
      return
    }
    // Ainda não decodificada: espera um pouco (miniatura costuma vir em
    // poucos ms do disco/base64); passou do prazo → fade normal.
    guard idx >= 0, idx < items.count else { fadeInPlain(); return }
    let it = items[idx]
    var src = it.thumbUri
    var px = MVImageLoader.thumbMaxPixel
    if src.isEmpty && !it.isVideo {
      src = MVItem.existingFileURL(it.localUri) != nil ? it.localUri : it.uri
      px = MVImageLoader.fullMaxPixel
    }
    if src.isEmpty { fadeInPlain(); return }
    var fired = false
    MVImageLoader.shared.load(src, maxPixel: px) { [weak self] img in
      guard let self = self, !fired else { return }
      fired = true
      if let img = img, !self.closed { self.animateHeroIn(img) } else { self.fadeInPlain() }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      guard let self = self, !fired else { return }
      fired = true
      self.fadeInPlain()
    }
  }

  private func fadeInPlain() {
    if closed { return }
    UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseOut, .allowUserInteraction], animations: {
      self.backdrop.alpha = 1
      self.collectionView.alpha = 1
      self.topBar.alpha = self.chromeVisible ? 1 : 0
      self.bottomBar.alpha = self.chromeVisible ? 1 : 0
    }, completion: nil)
  }

  private func animateHeroIn(_ img: UIImage) {
    guard !closed, let src = heroSource else { fadeInPlain(); return }
    let start = view.convert(src, from: nil)
    let target = heroFitRect(img, index: currentIndex)
    let hv = UIImageView(image: img)
    hv.contentMode = .scaleAspectFill
    hv.clipsToBounds = true
    hv.layer.cornerRadius = heroSourceRadius
    if #available(iOS 13.0, *) { hv.layer.cornerCurve = .continuous }
    hv.frame = start
    view.insertSubview(hv, aboveSubview: collectionView)
    heroView = hv
    collectionView.alpha = 0
    view.isUserInteractionEnabled = false
    UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0, options: [.curveEaseOut], animations: {
      hv.frame = target
      hv.layer.cornerRadius = 0
      self.backdrop.alpha = 1
    }, completion: { _ in
      self.view.isUserInteractionEnabled = true
      if !self.closed { self.collectionView.alpha = 1 }
      if self.heroView === hv { hv.removeFromSuperview() }
    })
    UIView.animate(withDuration: 0.22, delay: 0.14, options: [.curveEaseOut, .allowUserInteraction], animations: {
      self.topBar.alpha = self.chromeVisible ? 1 : 0
      self.bottomBar.alpha = self.chromeVisible ? 1 : 0
    }, completion: nil)
  }

  /// Frame de volta (coordenadas de `view`) da página atual, se a bolha está na tela.
  private func heroReturnTarget() -> (CGRect, CGFloat)? {
    guard let r = returnRects[currentIndex] else { return nil }
    let local = view.convert(r, from: nil)
    guard local.width >= 2, local.height >= 2, local.intersects(view.bounds) else { return nil }
    return (local, returnRadii[currentIndex] ?? 0)
  }

  private func teardownForClose() {
    videoBar.unbind()
    for c in collectionView?.visibleCells ?? [] {
      (c as? MVPageCell)?.pausePlayback()
    }
    MVAudio.restore()
  }

  /// Fecha encolhendo a foto até a bolha. false = sem destino/imagem → caller
  /// segue o fechamento normal.
  private func startHeroClose(reason: String, then: (() -> Void)?, velocityY: CGFloat = 0) -> Bool {
    guard !closed, !MVMotion.reduceMotion, presentingViewController != nil, isViewLoaded, view.window != nil,
          let ret = heroReturnTarget(),
          let cell = currentCell(), let img = cell.heroImage,
          let start = cell.heroFrame(in: view) else { return false }
    let target = ret.0
    let radius = ret.1
    closed = true
    teardownForClose()
    heroView?.removeFromSuperview()
    let hv = UIImageView(image: img)
    hv.contentMode = .scaleAspectFill
    hv.clipsToBounds = true
    if #available(iOS 13.0, *) { hv.layer.cornerCurve = .continuous }
    hv.frame = start
    view.insertSubview(hv, aboveSubview: collectionView)
    heroView = hv
    collectionView.alpha = 0
    cell.page.transform = .identity
    view.isUserInteractionEnabled = false
    let idx = currentIndex
    let cb = onClose
    // [2026-10-16 motion] Solto com força: a foto sai com a velocidade do dedo.
    let dy = target.midY - start.midY
    let v0: CGFloat = (velocityY != 0 && (dy > 0) == (velocityY > 0)) ? MVMotion.springVelocity(abs(velocityY), remaining: abs(dy)) : 0
    UIView.animate(withDuration: 0.36, delay: 0, usingSpringWithDamping: 0.92, initialSpringVelocity: max(0, v0), options: [.curveEaseOut, .beginFromCurrentState], animations: {
      hv.frame = target
      hv.layer.cornerRadius = radius
      self.backdrop.alpha = 0
      self.topBar.alpha = 0
      self.bottomBar.alpha = 0
      self.captureShield?.alpha = 0
    }, completion: { _ in
      let done = {
        then?()
        cb?(idx, reason)
      }
      if self.presentingViewController != nil {
        self.dismiss(animated: false) { done() }
      } else {
        done()
      }
    })
    return true
  }

  deinit {
    if let o = bgObserver { NotificationCenter.default.removeObserver(o) }
    if let o = captureObserver { NotificationCenter.default.removeObserver(o) }
  }

  // [2026-10-14 adv-privacy] Gravando/espelhando a tela → cobre tudo (inclusive
  // as barras) e pausa o vídeo (o áudio também seria gravado).
  private func updateCaptureShield() {
    guard flags.secure, isViewLoaded else { return }
    let capturing = UIScreen.main.isCaptured
    if capturing {
      if captureShield == nil {
        let shield = UIView(frame: view.bounds)
        shield.backgroundColor = .black
        shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        shield.isUserInteractionEnabled = false
        let label = UILabel()
        label.text = labels["protected"] ?? "Conteúdo protegido"
        label.textColor = .white
        label.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
        label.textAlignment = .center
        label.numberOfLines = 2
        label.translatesAutoresizingMaskIntoConstraints = false
        shield.addSubview(label)
        NSLayoutConstraint.activate([
          label.centerXAnchor.constraint(equalTo: shield.centerXAnchor),
          label.centerYAnchor.constraint(equalTo: shield.centerYAnchor),
          label.leadingAnchor.constraint(greaterThanOrEqualTo: shield.leadingAnchor, constant: 32),
          label.trailingAnchor.constraint(lessThanOrEqualTo: shield.trailingAnchor, constant: -32),
        ])
        captureShield = shield
      }
      if let shield = captureShield {
        shield.frame = view.bounds
        if shield.superview == nil { view.addSubview(shield) }
        view.bringSubviewToFront(shield)
      }
      if let cv = collectionView {
        for c in cv.visibleCells { (c as? MVPageCell)?.pausePlayback() }
      }
    } else {
      captureShield?.removeFromSuperview()
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let size = view.bounds.size
    guard size.width > 0, size.height > 0 else { return }
    if size != lastSize {
      lastSize = size
      relayouting = true
      let sp = MVPageCell.pageSpacing
      collectionView.frame = CGRect(x: -sp / 2, y: 0, width: size.width + sp, height: size.height)
      layout.invalidateLayout()
      collectionView.layoutIfNeeded()
      collectionView.contentOffset = CGPoint(x: CGFloat(currentIndex) * collectionView.bounds.width, y: 0)
      relayouting = false
      if !didInitialLayout {
        didInitialLayout = true
        DispatchQueue.main.async { [weak self] in self?.settle() }
      }
    }
  }

  override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
    super.viewWillTransition(to: size, with: coordinator)
    let idx = currentIndex
    coordinator.animate(alongsideTransition: nil) { [weak self] _ in
      guard let self = self else { return }
      self.currentIndex = idx
      self.collectionView.contentOffset = CGPoint(x: CGFloat(idx) * self.collectionView.bounds.width, y: 0)
    }
  }

  // MARK: - Chrome

  private func symbol(_ name: String, _ size: CGFloat = 20) -> UIImage? {
    let cfg = UIImage.SymbolConfiguration(pointSize: size, weight: .semibold)
    return UIImage(systemName: name, withConfiguration: cfg)
  }

  private func buildChrome() {
    for v in [topBar, bottomBar] as [UIView] {
      v.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(v)
    }
    let safe = view.safeAreaLayoutGuide

    closeButton.setImage(symbol("xmark", 19), for: .normal)
    closeButton.tintColor = .white
    closeButton.accessibilityLabel = labels["close"]
    closeButton.addTarget(self, action: #selector(tapClose), for: .touchUpInside)
    closeButton.translatesAutoresizingMaskIntoConstraints = false

    titleLabel.textColor = .white
    titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
    titleLabel.lineBreakMode = .byTruncatingTail
    subtitleLabel.textColor = UIColor.white.withAlphaComponent(0.75)
    subtitleLabel.font = .systemFont(ofSize: 12, weight: .regular)
    subtitleLabel.lineBreakMode = .byTruncatingTail
    let titles = UIStackView(arrangedSubviews: [titleLabel, subtitleLabel])
    titles.axis = .vertical
    titles.spacing = 1
    titles.alignment = .leading
    titles.translatesAutoresizingMaskIntoConstraints = false

    counterLabel.textColor = .white
    counterLabel.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
    counterLabel.setContentHuggingPriority(.required, for: .horizontal)
    counterLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    counterLabel.translatesAutoresizingMaskIntoConstraints = false

    topBar.addSubview(closeButton)
    topBar.addSubview(titles)
    topBar.addSubview(counterLabel)

    NSLayoutConstraint.activate([
      topBar.topAnchor.constraint(equalTo: view.topAnchor),
      topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      topBar.bottomAnchor.constraint(equalTo: safe.topAnchor, constant: 64),

      closeButton.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 6),
      closeButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 4),
      closeButton.widthAnchor.constraint(equalToConstant: 44),
      closeButton.heightAnchor.constraint(equalToConstant: 44),

      titles.leadingAnchor.constraint(equalTo: closeButton.trailingAnchor, constant: 6),
      titles.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
      titles.trailingAnchor.constraint(lessThanOrEqualTo: counterLabel.leadingAnchor, constant: -10),

      counterLabel.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),
      counterLabel.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
    ])

    // Bottom: legenda + barra de vídeo + ações.
    captionLabel.textColor = .white
    captionLabel.font = .systemFont(ofSize: 15, weight: .regular)
    captionLabel.numberOfLines = 4
    captionLabel.isUserInteractionEnabled = true
    captionLabel.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(toggleCaption)))

    videoBar.setLabels(play: labels["play"], pause: labels["pause"])
    videoBar.onToggle = { [weak self] in self?.currentCell()?.togglePlay() }
    videoBar.heightAnchor.constraint(equalToConstant: 36).isActive = true

    actionsRow.axis = .horizontal
    actionsRow.distribution = .fillEqually
    actionsRow.alignment = .center
    actionsRow.heightAnchor.constraint(equalToConstant: 48).isActive = true
    var acts: [String] = []
    if flags.allowShare { acts.append("share") }
    if flags.allowSave { acts.append("save") }
    if flags.allowForward { acts.append("forward") }
    if flags.allowStar { acts.append("star") }
    for a in acts {
      let b = UIButton(type: .system)
      b.tintColor = .white
      b.setImage(icon(for: a), for: .normal)
      b.accessibilityLabel = labels[a]
      b.addTarget(self, action: #selector(tapAction(_:)), for: .touchUpInside)
      b.accessibilityIdentifier = a
      let sp = UIActivityIndicatorView(style: .medium)
      sp.color = .white
      sp.hidesWhenStopped = true
      sp.translatesAutoresizingMaskIntoConstraints = false
      b.addSubview(sp)
      NSLayoutConstraint.activate([
        sp.centerXAnchor.constraint(equalTo: b.centerXAnchor),
        sp.centerYAnchor.constraint(equalTo: b.centerYAnchor),
        b.heightAnchor.constraint(equalToConstant: 48),
      ])
      actionButtons[a] = b
      actionSpinners[a] = sp
      actionsRow.addArrangedSubview(b)
    }

    let stack = UIStackView(arrangedSubviews: [captionLabel, videoBar, actionsRow])
    stack.axis = .vertical
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false
    bottomBar.addSubview(stack)
    actionsRow.isHidden = acts.isEmpty

    NSLayoutConstraint.activate([
      bottomBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      bottomBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      bottomBar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      stack.topAnchor.constraint(equalTo: bottomBar.topAnchor, constant: 28),
      stack.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),
      stack.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -4),
    ])
  }

  private func icon(for action: String) -> UIImage? {
    switch action {
    case "share": return symbol("square.and.arrow.up")
    case "save": return symbol("square.and.arrow.down")
    case "forward": return symbol("arrowshape.turn.up.right")
    case "star":
      let starred = currentIndex < items.count ? items[currentIndex].starred : false
      return symbol(starred ? "star.fill" : "star")
    case "done": return symbol("checkmark")
    default: return nil
    }
  }

  private func updateChrome() {
    guard currentIndex >= 0, currentIndex < items.count else { return }
    let it = items[currentIndex]
    titleLabel.text = it.senderName
    titleLabel.isHidden = it.senderName.isEmpty
    subtitleLabel.text = it.dateLabel
    subtitleLabel.isHidden = it.dateLabel.isEmpty
    counterLabel.text = items.count > 1 ? "\(currentIndex + 1) / \(items.count)" : ""
    captionLabel.text = it.caption
    captionLabel.numberOfLines = 4
    captionLabel.isHidden = it.caption.isEmpty
    videoBar.isHidden = !it.isVideo
    if let star = actionButtons["star"], actionSpinners["star"]?.isAnimating != true {
      star.setImage(icon(for: "star"), for: .normal)
      star.accessibilityLabel = it.starred ? (labels["unstar"] ?? labels["star"]) : labels["star"]
    }
    // Estados de "salvo ✓" etc. são da foto anterior — volta ao ícone normal.
    for (a, w) in actionResets {
      w.cancel()
      restoreAction(a)
    }
    actionResets.removeAll()
  }

  @objc private func toggleCaption() {
    captionLabel.numberOfLines = captionLabel.numberOfLines == 4 ? 14 : 4
    UIView.animate(withDuration: 0.2) { self.view.layoutIfNeeded() }
  }

  private func setChrome(visible: Bool, animated: Bool) {
    chromeVisible = visible
    // [2026-10-16 motion] Barras somem com fade + deslize (Telegram): a de cima
    // sobe, a de baixo desce. Kill switch: __chatyy_motion_media_chrome.
    let slide = animated && MVMotion.chromeSlide && !MVMotion.reduceMotion
    let apply = {
      self.topBar.alpha = visible ? 1 : 0
      self.bottomBar.alpha = visible ? 1 : 0
      if slide || visible {
        self.topBar.transform = (visible || !slide) ? .identity : CGAffineTransform(translationX: 0, y: -14)
        self.bottomBar.transform = (visible || !slide) ? .identity : CGAffineTransform(translationX: 0, y: 18)
      }
    }
    topBar.isUserInteractionEnabled = visible
    bottomBar.isUserInteractionEnabled = visible
    if slide {
      UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.92, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: apply, completion: nil)
    } else if animated {
      UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: apply, completion: nil)
    } else {
      apply()
    }
    UIView.animate(withDuration: 0.2) { self.setNeedsStatusBarAppearanceUpdate() }
    setNeedsUpdateOfHomeIndicatorAutoHidden()
  }

  // MARK: - Actions

  @objc private func tapClose() {
    finish(reason: "close", animated: true)
  }

  @objc private func tapAction(_ sender: UIButton) {
    guard let a = sender.accessibilityIdentifier else { return }
    let idx = currentIndex
    switch a {
    case "forward":
      let cb = onAction
      finish(reason: "forward", animated: true) {
        cb?("forward", idx, [:])
      }
    case "star":
      guard idx < items.count else { return }
      items[idx].starred.toggle()
      let starred = items[idx].starred
      sender.setImage(icon(for: "star"), for: .normal)
      sender.accessibilityLabel = starred ? (labels["unstar"] ?? labels["star"]) : labels["star"]
      onAction?("star", idx, ["starred": starred])
    default:
      onAction?(a, idx, [:])
    }
  }

  func setActionState(action: String, state: String) {
    guard let b = actionButtons[action], let sp = actionSpinners[action] else { return }
    actionResets[action]?.cancel()
    actionResets[action] = nil
    switch state {
    case "busy":
      b.isEnabled = false
      b.setImage(nil, for: .normal)
      sp.startAnimating()
    case "done":
      sp.stopAnimating()
      b.isEnabled = true
      b.setImage(icon(for: "done"), for: .normal)
      let w = DispatchWorkItem { [weak self] in
        self?.restoreAction(action)
        self?.actionResets[action] = nil
      }
      actionResets[action] = w
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: w)
    default:
      restoreAction(action)
    }
  }

  private func restoreAction(_ action: String) {
    guard let b = actionButtons[action] else { return }
    actionSpinners[action]?.stopAnimating()
    b.isEnabled = true
    b.setImage(icon(for: action), for: .normal)
  }

  // MARK: - Close

  func closeFromJS() {
    finish(reason: "js", animated: true)
  }

  func closeSilently() {
    finish(reason: "replaced", animated: false)
  }

  private func finish(reason: String, animated: Bool, then: (() -> Void)? = nil) {
    if closed { return }
    if animated && startHeroClose(reason: reason, then: then) { return }
    closed = true
    teardownForClose()
    let idx = currentIndex
    let cb = onClose
    let done = {
      then?()
      cb?(idx, reason)
    }
    if presentingViewController != nil {
      dismiss(animated: animated) { done() }
    } else {
      done()
    }
  }

  // MARK: - Gestures

  private func currentCell() -> MVPageCell? {
    guard let cv = collectionView else { return nil }
    return cv.cellForItem(at: IndexPath(item: currentIndex, section: 0)) as? MVPageCell
  }

  @objc private func handleSingleTap(_ g: UITapGestureRecognizer) {
    setChrome(visible: !chromeVisible, animated: true)
  }

  @objc private func handleDoubleTap(_ g: UITapGestureRecognizer) {
    guard let cell = currentCell() else { return }
    if cell.item?.isVideo == true {
      cell.togglePlay()
      return
    }
    cell.handleDoubleTap(g)
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    if touch.view is UIControl { return false }
    return true
  }

  func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    if g === dismissPan {
      guard let cell = currentCell(), !cell.isZoomed else { return false }
      if collectionView.isDecelerating { return false }
      let v = dismissPan.velocity(in: view)
      return abs(v.y) > abs(v.x) * 1.2
    }
    return true
  }

  @objc private func handleDismissPan(_ g: UIPanGestureRecognizer) {
    let t = g.translation(in: view)
    let h = max(1, view.bounds.height)
    switch g.state {
    case .began:
      panCell = currentCell()
      collectionView.isScrollEnabled = false
    case .changed:
      guard let cell = panCell else { return }
      let p = min(1, abs(t.y) / (h * 0.35))
      let s = 1 - 0.22 * p
      cell.page.transform = CGAffineTransform(translationX: t.x, y: t.y).scaledBy(x: s, y: s)
      backdrop.alpha = 1 - 0.9 * p
      let ca: CGFloat = chromeVisible ? max(0, 1 - p * 3) : 0
      topBar.alpha = ca
      bottomBar.alpha = ca
    default:
      guard let cell = panCell else {
        collectionView.isScrollEnabled = true
        return
      }
      let vy = g.velocity(in: view).y
      let sameDir = (t.y >= 0) == (vy >= 0) || abs(vy) < 200
      let shouldClose = g.state == .ended && sameDir && (abs(t.y) > 110 || abs(vy) > 900)
      if shouldClose && startHeroClose(reason: "swipe", then: nil, velocityY: vy) {
        panCell = nil
        return
      }
      if shouldClose {
        let dir: CGFloat = (abs(t.y) > 8 ? t.y : vy) >= 0 ? 1 : -1
        let cb = onClose
        let idx = currentIndex
        closed = true
        videoBar.unbind()
        cell.pausePlayback()
        MVAudio.restore()
        UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut], animations: {
          cell.page.transform = CGAffineTransform(translationX: t.x, y: dir * h).scaledBy(x: 0.78, y: 0.78)
          self.backdrop.alpha = 0
          self.topBar.alpha = 0
          self.bottomBar.alpha = 0
        }, completion: { _ in
          self.dismiss(animated: false) {
            cb?(idx, "swipe")
          }
        })
      } else {
        // [2026-10-16 motion] Mola de volta herdando a velocidade do dedo.
        let v0 = MVMotion.springVelocity(-vy, remaining: t.y)
        UIView.animate(withDuration: 0.34, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: v0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          cell.page.transform = .identity
          self.backdrop.alpha = 1
          self.topBar.alpha = self.chromeVisible ? 1 : 0
          self.bottomBar.alpha = self.chromeVisible ? 1 : 0
        }, completion: { _ in
          self.collectionView.isScrollEnabled = true
        })
      }
      panCell = nil
    }
  }

  // MARK: - Collection

  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    return items.count
  }

  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: MVPageCell.reuseId, for: indexPath) as! MVPageCell
    cell.labels = labels
    cell.configure(items[indexPath.item])
    cell.onPlayerChanged = { [weak self, weak cell] p in
      guard let self = self, let cell = cell, !self.closed, self.currentCell() === cell else { return }
      self.videoBar.bind(p)
    }
    return cell
  }

  func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    return collectionView.bounds.size
  }

  func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    guard let c = cell as? MVPageCell else { return }
    if indexPath.item == currentIndex && !collectionView.isDragging && !collectionView.isDecelerating && didInitialLayout && !closed {
      DispatchQueue.main.async { [weak self] in self?.settle() }
    } else if c.isActive {
      c.deactivate()
    }
  }

  func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    (cell as? MVPageCell)?.deactivate()
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    guard scrollView === collectionView, !relayouting, !closed else { return }
    let w = scrollView.bounds.width
    guard w > 0, !items.isEmpty else { return }
    applyParallax()
    let i = max(0, min(items.count - 1, Int((scrollView.contentOffset.x / w).rounded())))
    if i != currentIndex {
      currentIndex = i
      updateChrome()
      onIndexChange?(i)
      // Pausa o vídeo que saiu do centro já no meio do swipe.
      for c in collectionView.visibleCells {
        guard let pc = c as? MVPageCell, let ip = collectionView.indexPath(for: pc) else { continue }
        if ip.item != i && pc.isActive { pc.deactivate() }
      }
      videoBar.bind(nil)
    }
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    if scrollView === collectionView { settle() }
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if scrollView === collectionView && !decelerate { settle() }
  }

  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    if scrollView === collectionView { settle() }
  }

  /// Página assentada: ativa a atual (vídeo toca), desativa as outras,
  /// liga a barra de vídeo e pré-carrega as vizinhas.
  /// [2026-10-16 motion] Parallax: o conteúdo anda ~22% mais devagar que a
  /// página (recortado por ela). Kill switch: __chatyy_motion_media_parallax.
  private func applyParallax() {
    guard let cv = collectionView else { return }
    let w = cv.bounds.width
    guard w > 0 else { return }
    let on = MVMotion.parallax && !MVMotion.reduceMotion
    for c in cv.visibleCells {
      guard let pc = c as? MVPageCell else { continue }
      if !on { pc.setParallax(0); continue }
      let d = max(-1, min(1, (pc.frame.minX - cv.contentOffset.x) / w))
      pc.setParallax(abs(d) < 0.002 ? 0 : d * w * 0.22)
    }
  }

  private func settle() {
    guard !closed, let cv = collectionView else { return }
    applyParallax()
    for c in cv.visibleCells {
      guard let pc = c as? MVPageCell, let ip = cv.indexPath(for: pc) else { continue }
      if ip.item == currentIndex {
        if !pc.isActive { pc.activate() }
      } else if pc.isActive {
        pc.deactivate()
      }
    }
    if let cell = currentCell(), cell.item?.isVideo == true {
      videoBar.bind(cell.player)
    } else {
      videoBar.bind(nil)
    }
    prefetchNeighbors()
  }

  private func prefetchNeighbors() {
    let loader = MVImageLoader.shared
    for j in [currentIndex + 1, currentIndex - 1, currentIndex + 2] where j >= 0 && j < items.count {
      let it = items[j]
      if it.isVideo {
        if !it.thumbUri.isEmpty { loader.prefetch(it.thumbUri, maxPixel: MVImageLoader.thumbMaxPixel) }
        continue
      }
      if MVItem.existingFileURL(it.localUri) != nil {
        loader.prefetch(it.localUri, maxPixel: MVImageLoader.fullMaxPixel)
      } else if !it.uri.isEmpty {
        loader.prefetch(it.uri, maxPixel: MVImageLoader.fullMaxPixel)
      }
    }
  }
}
