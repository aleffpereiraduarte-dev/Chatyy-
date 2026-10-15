import UIKit
import AVFoundation
import Photos

// [2026-10-15 native-attach] Câmera do chat (WhatsApp):
//   • toque no obturador = foto; segurar (>0.25 s) = vídeo enquanto segura,
//     deslizar o dedo p/ cima = zoom; soltar = para (limite maxVideoSec com
//     anel de progresso);
//   • duplo toque no preview = troca câmera; toque = foco; pinça = zoom;
//   • flash desligado / automático / ligado (frontal = "flash de tela");
//   • faixa de recentes embaixo: toque = envia aquele item, toque longo =
//     seleção múltipla numerada + botão enviar; botão galeria = picker do JS.
// Sessão: CAEngine (pré-configurada; se a folha estava com o tile ao vivo a
// sessão já está rodando → abre "quente").
final class ChatCameraController: UIViewController, AVCapturePhotoCaptureDelegate,
  AVCaptureFileOutputRecordingDelegate, UICollectionViewDataSource, UICollectionViewDelegate,
  UIGestureRecognizerDelegate {

  var onFinish: (([String: Any]) -> Void)?

  private let config: AttachConfig
  private let engine = CAEngine.shared
  private var acquired = false
  private var finished = false
  private var flashMode: AVCaptureDevice.FlashMode = .off
  private var capturing = false
  private var recording = false
  private var wantsRecording = false
  private var recordStart: Date?
  private var recordTimer: Timer?
  private var zoomBase: CGFloat = 1
  private var pinchBase: CGFloat = 1
  private var holdStartY: CGFloat = 0
  private var savedBrightness: CGFloat = -1
  private var exporting = false

  // recentes
  private var recent: PHFetchResult<PHAsset>?
  private let thumbManager = PHCachingImageManager()
  private var multiSelect = false
  private var picked: [String] = []
  private var pickedAssets: [String: PHAsset] = [:]

  // views
  private let preview = CAPreviewView(frame: .zero)
  private let screenFlash = UIView()
  private let closeButton = UIButton(type: .system)
  private let flashButton = UIButton(type: .system)
  private let timerPill = UIView()
  private let timerDot = UIView()
  private let timerLabel = UILabel()
  private let zoomLabel = UILabel()
  private let stripLayout = UICollectionViewFlowLayout()
  private lazy var strip = UICollectionView(frame: .zero, collectionViewLayout: stripLayout)
  private let stripSend = UIButton(type: .custom)
  private let stripSendCount = UILabel()
  private let galleryButton = UIButton(type: .system)
  private let flipButton = UIButton(type: .system)
  private let shutter = UIView()
  private let shutterInner = UIView()
  private let ring = CAShapeLayer()
  private let hintLabel = UILabel()
  private let focusSquare = UIView()
  private let permView = UIView()
  private let permTitle = UILabel()
  private let permBody = UILabel()
  private let permButton = UIButton(type: .system)

  private static let shutterSize: CGFloat = 78

  init(config: AttachConfig) {
    self.config = config
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    NotificationCenter.default.removeObserver(self)
    recordTimer?.invalidate()
  }

  override var prefersStatusBarHidden: Bool { return true }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { return .portrait }
  override var prefersHomeIndicatorAutoHidden: Bool { return true }

  // MARK: ciclo de vida

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    overrideUserInterfaceStyle = .dark

    preview.alpha = 0
    preview.frame = view.bounds
    preview.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(preview)

    let tap = UITapGestureRecognizer(target: self, action: #selector(onPreviewTap(_:)))
    let dbl = UITapGestureRecognizer(target: self, action: #selector(onPreviewDoubleTap))
    dbl.numberOfTapsRequired = 2
    tap.require(toFail: dbl)
    let pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch(_:)))
    preview.addGestureRecognizer(tap)
    preview.addGestureRecognizer(dbl)
    preview.addGestureRecognizer(pinch)

    focusSquare.layer.borderColor = UIColor.white.cgColor
    focusSquare.layer.borderWidth = 1.5
    focusSquare.layer.cornerRadius = 6
    focusSquare.alpha = 0
    focusSquare.isUserInteractionEnabled = false
    focusSquare.frame = CGRect(x: 0, y: 0, width: 72, height: 72)
    view.addSubview(focusSquare)

    screenFlash.backgroundColor = .white
    screenFlash.alpha = 0
    screenFlash.isUserInteractionEnabled = false
    screenFlash.frame = view.bounds
    screenFlash.autoresizingMask = [.flexibleWidth, .flexibleHeight]

    buildTop()
    buildBottom()
    buildPermission()
    view.addSubview(screenFlash)

    NotificationCenter.default.addObserver(self, selector: #selector(onSessionStarted), name: .AVCaptureSessionDidStartRunning, object: engine.session)
    NotificationCenter.default.addObserver(self, selector: #selector(onSubjectChanged), name: .AVCaptureDeviceSubjectAreaDidChange, object: nil)

    startCameraFlow()
    loadRecents()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if savedBrightness >= 0 { UIScreen.main.brightness = savedBrightness; savedBrightness = -1 }
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    releaseCamera()
  }

  private func releaseCamera() {
    guard acquired else { return }
    acquired = false
    if engine.movieOutput.isRecording { engine.queue.async { self.engine.movieOutput.stopRecording() } }
    engine.setTorch(false)
    preview.detach()
    engine.removeAudio()
    engine.relinquish()
  }

  // MARK: permissão / sessão

  private func startCameraFlow() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      beginSession()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { ok in
        DispatchQueue.main.async {
          guard !self.finished else { return }
          if ok { self.beginSession() } else { self.showPermission() }
        }
      }
    default:
      showPermission()
    }
  }

  private func beginSession() {
    permView.isHidden = true
    guard !acquired else { return }
    acquired = true
    preview.attach()
    if engine.session.isRunning { revealPreview() }
    engine.acquire { [weak self] in
      guard let self = self else { return }
      self.refreshFlashButton()
      self.zoomBase = self.engine.zoom
      if self.engine.session.isRunning { self.revealPreview() }
    }
    if config.withAudio {
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized:
        engine.addAudio()
      case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { ok in
          if ok { self.engine.addAudio() }
        }
      default:
        break
      }
    }
  }

  @objc private func onSessionStarted() {
    DispatchQueue.main.async { self.revealPreview() }
  }

  private func revealPreview() {
    guard preview.alpha < 1 else { return }
    UIView.animate(withDuration: 0.18) { self.preview.alpha = 1 }
  }

  private func showPermission() {
    permView.isHidden = false
    shutter.isHidden = true
    flipButton.isHidden = true
    flashButton.isHidden = true
  }

  // MARK: construção

  private func circleButton(_ b: UIButton, symbol: String, size: CGFloat, label: String) {
    b.setImage(CAFormat.symbol(symbol, size, .semibold), for: .normal)
    b.tintColor = .white
    b.backgroundColor = UIColor(white: 0, alpha: 0.28)
    b.accessibilityLabel = label
    b.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(b)
  }

  private func buildTop() {
    circleButton(closeButton, symbol: "xmark", size: 18, label: config.t("close", "Fechar"))
    closeButton.layer.cornerRadius = 22
    closeButton.addTarget(self, action: #selector(onClose), for: .touchUpInside)
    circleButton(flashButton, symbol: "bolt.slash.fill", size: 18, label: config.t("flashOff", "Flash desligado"))
    flashButton.layer.cornerRadius = 22
    flashButton.addTarget(self, action: #selector(onFlash), for: .touchUpInside)

    timerPill.backgroundColor = UIColor(white: 0, alpha: 0.45)
    timerPill.layer.cornerRadius = 15
    timerPill.isHidden = true
    timerPill.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(timerPill)
    timerDot.backgroundColor = UIColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1)
    timerDot.layer.cornerRadius = 4.5
    timerDot.translatesAutoresizingMaskIntoConstraints = false
    timerPill.addSubview(timerDot)
    timerLabel.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
    timerLabel.textColor = .white
    timerLabel.text = "0:00"
    timerLabel.translatesAutoresizingMaskIntoConstraints = false
    timerPill.addSubview(timerLabel)

    zoomLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
    zoomLabel.textColor = .white
    zoomLabel.textAlignment = .center
    zoomLabel.backgroundColor = UIColor(white: 0, alpha: 0.4)
    zoomLabel.layer.cornerRadius = 14
    zoomLabel.clipsToBounds = true
    zoomLabel.alpha = 0
    zoomLabel.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(zoomLabel)

    let g = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      closeButton.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 12),
      closeButton.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
      closeButton.widthAnchor.constraint(equalToConstant: 44),
      closeButton.heightAnchor.constraint(equalToConstant: 44),
      flashButton.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -12),
      flashButton.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
      flashButton.widthAnchor.constraint(equalToConstant: 44),
      flashButton.heightAnchor.constraint(equalToConstant: 44),
      timerPill.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      timerPill.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
      timerPill.heightAnchor.constraint(equalToConstant: 30),
      timerDot.leadingAnchor.constraint(equalTo: timerPill.leadingAnchor, constant: 12),
      timerDot.centerYAnchor.constraint(equalTo: timerPill.centerYAnchor),
      timerDot.widthAnchor.constraint(equalToConstant: 9),
      timerDot.heightAnchor.constraint(equalToConstant: 9),
      timerLabel.leadingAnchor.constraint(equalTo: timerDot.trailingAnchor, constant: 7),
      timerLabel.trailingAnchor.constraint(equalTo: timerPill.trailingAnchor, constant: -12),
      timerLabel.centerYAnchor.constraint(equalTo: timerPill.centerYAnchor),
    ])
  }

  private func buildBottom() {
    // Faixa de recentes.
    stripLayout.scrollDirection = .horizontal
    stripLayout.itemSize = CGSize(width: 62, height: 62)
    stripLayout.minimumLineSpacing = 4
    stripLayout.sectionInset = UIEdgeInsets(top: 0, left: 10, bottom: 0, right: 10)
    strip.backgroundColor = .clear
    strip.showsHorizontalScrollIndicator = false
    strip.dataSource = self
    strip.delegate = self
    strip.register(CAAssetCell.self, forCellWithReuseIdentifier: CAAssetCell.reuseId)
    strip.translatesAutoresizingMaskIntoConstraints = false
    let lp = UILongPressGestureRecognizer(target: self, action: #selector(onStripLongPress(_:)))
    lp.minimumPressDuration = 0.35
    strip.addGestureRecognizer(lp)
    view.addSubview(strip)

    stripSend.backgroundColor = .white
    stripSend.layer.cornerRadius = 24
    stripSend.setImage(CAFormat.symbol("paperplane.fill", 18, .semibold), for: .normal)
    stripSend.tintColor = .black
    stripSend.accessibilityLabel = config.t("send", "Enviar")
    stripSend.isHidden = true
    stripSend.addTarget(self, action: #selector(onStripSend), for: .touchUpInside)
    stripSend.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stripSend)
    stripSendCount.font = .systemFont(ofSize: 12, weight: .bold)
    stripSendCount.textColor = .white
    stripSendCount.backgroundColor = .black
    stripSendCount.textAlignment = .center
    stripSendCount.layer.cornerRadius = 10
    stripSendCount.layer.borderColor = UIColor.white.cgColor
    stripSendCount.layer.borderWidth = 1.5
    stripSendCount.clipsToBounds = true
    stripSendCount.translatesAutoresizingMaskIntoConstraints = false
    stripSend.addSubview(stripSendCount)

    // Obturador.
    let s = ChatCameraController.shutterSize
    shutter.translatesAutoresizingMaskIntoConstraints = false
    shutter.layer.cornerRadius = s / 2
    shutter.layer.borderColor = UIColor.white.cgColor
    shutter.layer.borderWidth = 5
    shutter.isAccessibilityElement = true
    shutter.accessibilityLabel = config.t("shutter", "Toque para foto, segure para vídeo")
    shutter.accessibilityTraits = .button
    view.addSubview(shutter)
    shutterInner.isUserInteractionEnabled = false
    shutterInner.backgroundColor = UIColor(white: 1, alpha: 0.0)
    shutterInner.layer.cornerRadius = (s - 18) / 2
    shutterInner.frame = CGRect(x: 9, y: 9, width: s - 18, height: s - 18)
    shutter.addSubview(shutterInner)
    ring.fillColor = UIColor.clear.cgColor
    ring.strokeColor = UIColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1).cgColor
    ring.lineWidth = 5
    ring.lineCap = .round
    ring.strokeEnd = 0
    ring.path = UIBezierPath(arcCenter: CGPoint(x: s / 2, y: s / 2), radius: s / 2 - 2.5,
                             startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: true).cgPath
    shutter.layer.addSublayer(ring)
    let shutterTap = UITapGestureRecognizer(target: self, action: #selector(onShutterTap))
    let shutterHold = UILongPressGestureRecognizer(target: self, action: #selector(onShutterHold(_:)))
    shutterHold.minimumPressDuration = 0.25
    shutterHold.allowableMovement = 4000
    shutter.addGestureRecognizer(shutterTap)
    shutter.addGestureRecognizer(shutterHold)

    circleButton(galleryButton, symbol: "photo.on.rectangle", size: 20, label: config.t("gallery", "Galeria"))
    galleryButton.layer.cornerRadius = 24
    galleryButton.addTarget(self, action: #selector(onGallery), for: .touchUpInside)
    circleButton(flipButton, symbol: "arrow.triangle.2.circlepath.camera", size: 20, label: config.t("flip", "Trocar câmera"))
    flipButton.layer.cornerRadius = 24
    flipButton.addTarget(self, action: #selector(onPreviewDoubleTap), for: .touchUpInside)

    hintLabel.text = config.t("hint", "Segure para vídeo, toque para foto")
    hintLabel.font = .systemFont(ofSize: 13, weight: .medium)
    hintLabel.textColor = UIColor(white: 1, alpha: 0.85)
    hintLabel.textAlignment = .center
    hintLabel.layer.shadowColor = UIColor.black.cgColor
    hintLabel.layer.shadowOpacity = 0.5
    hintLabel.layer.shadowRadius = 3
    hintLabel.layer.shadowOffset = .zero
    hintLabel.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(hintLabel)

    let g = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      hintLabel.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -10),
      hintLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      shutter.bottomAnchor.constraint(equalTo: hintLabel.topAnchor, constant: -14),
      shutter.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      shutter.widthAnchor.constraint(equalToConstant: s),
      shutter.heightAnchor.constraint(equalToConstant: s),
      galleryButton.centerYAnchor.constraint(equalTo: shutter.centerYAnchor),
      galleryButton.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 32),
      galleryButton.widthAnchor.constraint(equalToConstant: 48),
      galleryButton.heightAnchor.constraint(equalToConstant: 48),
      flipButton.centerYAnchor.constraint(equalTo: shutter.centerYAnchor),
      flipButton.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -32),
      flipButton.widthAnchor.constraint(equalToConstant: 48),
      flipButton.heightAnchor.constraint(equalToConstant: 48),
      strip.bottomAnchor.constraint(equalTo: shutter.topAnchor, constant: -18),
      strip.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      strip.trailingAnchor.constraint(equalTo: stripSend.leadingAnchor, constant: -4),
      strip.heightAnchor.constraint(equalToConstant: 62),
      stripSend.centerYAnchor.constraint(equalTo: strip.centerYAnchor),
      stripSend.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
      stripSend.heightAnchor.constraint(equalToConstant: 48),
      stripSendCount.topAnchor.constraint(equalTo: stripSend.topAnchor, constant: -4),
      stripSendCount.trailingAnchor.constraint(equalTo: stripSend.trailingAnchor, constant: 4),
      stripSendCount.heightAnchor.constraint(equalToConstant: 20),
      stripSendCount.widthAnchor.constraint(greaterThanOrEqualToConstant: 20),
      zoomLabel.bottomAnchor.constraint(equalTo: strip.topAnchor, constant: -10),
      zoomLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      zoomLabel.heightAnchor.constraint(equalToConstant: 28),
      zoomLabel.widthAnchor.constraint(equalToConstant: 56),
    ])
    stripSendWidth = stripSend.widthAnchor.constraint(equalToConstant: 0)
    stripSendWidth.isActive = true
  }

  private var stripSendWidth: NSLayoutConstraint!

  private func buildPermission() {
    permView.backgroundColor = .black
    permView.isHidden = true
    permView.translatesAutoresizingMaskIntoConstraints = false
    view.insertSubview(permView, belowSubview: closeButton)
    let icon = UIImageView(image: CAFormat.symbol("camera", 40, .light))
    icon.tintColor = UIColor(white: 1, alpha: 0.85)
    icon.translatesAutoresizingMaskIntoConstraints = false
    permView.addSubview(icon)
    permTitle.text = config.t("permCamTitle", "Permita o acesso à câmera")
    permTitle.font = .systemFont(ofSize: 19, weight: .semibold)
    permTitle.textColor = .white
    permTitle.textAlignment = .center
    permTitle.numberOfLines = 0
    permTitle.translatesAutoresizingMaskIntoConstraints = false
    permView.addSubview(permTitle)
    permBody.text = config.t("permCamBody", "Para tirar fotos e gravar vídeos no chat, ative a câmera nos Ajustes.")
    permBody.font = .systemFont(ofSize: 15)
    permBody.textColor = UIColor(white: 1, alpha: 0.7)
    permBody.textAlignment = .center
    permBody.numberOfLines = 0
    permBody.translatesAutoresizingMaskIntoConstraints = false
    permView.addSubview(permBody)
    permButton.setTitle(config.t("permSettings", "Abrir Ajustes"), for: .normal)
    permButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
    permButton.setTitleColor(.black, for: .normal)
    permButton.backgroundColor = .white
    permButton.layer.cornerRadius = 22
    permButton.contentEdgeInsets = UIEdgeInsets(top: 0, left: 24, bottom: 0, right: 24)
    permButton.addTarget(self, action: #selector(onOpenSettings), for: .touchUpInside)
    permButton.translatesAutoresizingMaskIntoConstraints = false
    permView.addSubview(permButton)
    NSLayoutConstraint.activate([
      permView.topAnchor.constraint(equalTo: view.topAnchor),
      permView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      permView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      permView.bottomAnchor.constraint(equalTo: strip.topAnchor, constant: -8),
      icon.centerXAnchor.constraint(equalTo: permView.centerXAnchor),
      icon.bottomAnchor.constraint(equalTo: permTitle.topAnchor, constant: -16),
      permTitle.centerYAnchor.constraint(equalTo: permView.centerYAnchor, constant: -20),
      permTitle.leadingAnchor.constraint(equalTo: permView.leadingAnchor, constant: 32),
      permTitle.trailingAnchor.constraint(equalTo: permView.trailingAnchor, constant: -32),
      permBody.topAnchor.constraint(equalTo: permTitle.bottomAnchor, constant: 8),
      permBody.leadingAnchor.constraint(equalTo: permTitle.leadingAnchor),
      permBody.trailingAnchor.constraint(equalTo: permTitle.trailingAnchor),
      permButton.topAnchor.constraint(equalTo: permBody.bottomAnchor, constant: 20),
      permButton.centerXAnchor.constraint(equalTo: permView.centerXAnchor),
      permButton.heightAnchor.constraint(equalToConstant: 44),
    ])
  }

  // MARK: flash

  private func refreshFlashButton() {
    let name: String, label: String
    switch flashMode {
    case .on: name = "bolt.fill"; label = config.t("flashOn", "Flash ligado")
    case .auto: name = "bolt.badge.a.fill"; label = config.t("flashAuto", "Flash automático")
    default: name = "bolt.slash.fill"; label = config.t("flashOff", "Flash desligado")
    }
    flashButton.setImage(CAFormat.symbol(name, 18, .semibold), for: .normal)
    flashButton.accessibilityLabel = label
  }

  @objc private func onFlash() {
    switch flashMode {
    case .off: flashMode = .auto
    case .auto: flashMode = .on
    default: flashMode = .off
    }
    caHaptic("select")
    refreshFlashButton()
  }

  // MARK: gestos do preview

  @objc private func onPreviewTap(_ g: UITapGestureRecognizer) {
    guard acquired else { return }
    let p = g.location(in: preview)
    let dp = preview.previewLayer.captureDevicePointConverted(fromLayerPoint: p)
    engine.focus(at: dp)
    focusSquare.center = p
    focusSquare.transform = CGAffineTransform(scaleX: 1.4, y: 1.4)
    focusSquare.alpha = 1
    UIView.animate(withDuration: 0.25, animations: { self.focusSquare.transform = .identity }) { _ in
      UIView.animate(withDuration: 0.3, delay: 0.7, options: []) { self.focusSquare.alpha = 0 }
    }
  }

  @objc private func onSubjectChanged() {
    engine.resetFocus()
  }

  @objc private func onPreviewDoubleTap() {
    guard acquired, !recording, !capturing else { return }
    caHaptic("light")
    UIView.transition(with: preview, duration: 0.35, options: [.transitionFlipFromLeft, .allowAnimatedContent], animations: nil)
    engine.flip { [weak self] _ in
      self?.zoomBase = self?.engine.zoom ?? 1
    }
  }

  @objc private func onPinch(_ g: UIPinchGestureRecognizer) {
    guard acquired else { return }
    switch g.state {
    case .began:
      pinchBase = engine.zoom
    case .changed:
      let z = pinchBase * g.scale
      engine.setZoom(z)
      showZoom(engine.zoom)
    default:
      break
    }
  }

  private func showZoom(_ z: CGFloat) {
    zoomLabel.text = String(format: "%.1f×", z)
    zoomLabel.alpha = 1
    NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(hideZoom), object: nil)
    perform(#selector(hideZoom), with: nil, afterDelay: 0.9)
  }

  @objc private func hideZoom() {
    UIView.animate(withDuration: 0.25) { self.zoomLabel.alpha = 0 }
  }

  // MARK: foto

  @objc private func onShutterTap() {
    guard acquired, !capturing, !recording, engine.session.isRunning else { return }
    capturing = true
    caHaptic("light")
    UIView.animate(withDuration: 0.08, animations: { self.shutter.transform = CGAffineTransform(scaleX: 0.88, y: 0.88) }) { _ in
      UIView.animate(withDuration: 0.12) { self.shutter.transform = .identity }
    }
    let front = engine.position == .front
    if front && flashMode != .off {
      savedBrightness = UIScreen.main.brightness
      UIScreen.main.brightness = 1
      screenFlash.alpha = 1
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) { self.capturePhoto(screenFlashed: true) }
    } else {
      capturePhoto(screenFlashed: false)
    }
  }

  private func capturePhoto(screenFlashed: Bool) {
    let out = engine.photoOutput
    let flash = flashMode
    let orientation = CAEngine.orientationFromDevice()
    engine.queue.async {
      self.engine.setCaptureOrientation(orientation)
      let settings: AVCapturePhotoSettings
      if out.availablePhotoCodecTypes.contains(.jpeg) {
        settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
      } else {
        settings = AVCapturePhotoSettings()
      }
      if #available(iOS 16.0, *) {
        let md = out.maxPhotoDimensions
        if md.width > 0 && md.height > 0 { settings.maxPhotoDimensions = md }
      }
      settings.photoQualityPrioritization = .balanced
      if !screenFlashed && out.supportedFlashModes.contains(flash) { settings.flashMode = flash }
      out.capturePhoto(with: settings, delegate: self)
    }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, willCapturePhotoFor resolvedSettings: AVCaptureResolvedPhotoSettings) {
    DispatchQueue.main.async {
      // "Piscada" de captura.
      self.preview.alpha = 0.25
      UIView.animate(withDuration: 0.22) { self.preview.alpha = 1 }
    }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    let data = photo.fileDataRepresentation()
    let item = data.flatMap { AttachExporter.cameraPhotoItem($0) }
    DispatchQueue.main.async {
      self.capturing = false
      if self.screenFlash.alpha > 0 {
        UIView.animate(withDuration: 0.2) { self.screenFlash.alpha = 0 }
      }
      if self.savedBrightness >= 0 { UIScreen.main.brightness = self.savedBrightness; self.savedBrightness = -1 }
      guard let item = item else { caHaptic("warn"); return }
      self.finish(["action": "capture", "items": [item]])
    }
  }

  // MARK: vídeo

  @objc private func onShutterHold(_ g: UILongPressGestureRecognizer) {
    guard acquired else { return }
    switch g.state {
    case .began:
      guard !capturing, !recording, engine.session.isRunning else { return }
      holdStartY = g.location(in: view).y
      zoomBase = engine.zoom
      startRecording()
    case .changed:
      guard wantsRecording else { return }
      let dy = holdStartY - g.location(in: view).y
      let travel = max(120, view.bounds.height * 0.45)
      let p = max(0, min(1, dy / travel))
      let maxZ = min(engine.maxZoom, 8)
      let z = zoomBase + (max(zoomBase, maxZ) - zoomBase) * p
      engine.setZoom(z)
      if p > 0 { showZoom(engine.zoom) }
    case .ended, .cancelled, .failed:
      stopRecording()
    default:
      break
    }
  }

  private func startRecording() {
    wantsRecording = true
    caHaptic("heavy")
    let url = AttachExporter.freshURL(ext: "mov")
    let maxSec = config.maxVideoSec
    let orientation = CAEngine.orientationFromDevice()
    let torch = flashMode == .on && engine.position == .back
    if torch { engine.setTorch(true) }
    setRecordingUI(true)
    engine.queue.async {
      guard self.wantsRecording else { return }
      self.engine.setCaptureOrientation(orientation)
      self.engine.movieOutput.maxRecordedDuration = CMTime(seconds: maxSec, preferredTimescale: 600)
      if !self.engine.movieOutput.isRecording {
        self.engine.movieOutput.startRecording(to: url, recordingDelegate: self)
      }
    }
  }

  private func stopRecording() {
    guard wantsRecording else { return }
    wantsRecording = false
    engine.queue.async {
      if self.engine.movieOutput.isRecording { self.engine.movieOutput.stopRecording() }
    }
    // Soltou antes de a gravação começar de fato → só volta a UI.
    if !recording { setRecordingUI(false); engine.setTorch(false) }
  }

  private func setRecordingUI(_ on: Bool) {
    timerPill.isHidden = !on
    hintLabel.isHidden = on
    strip.isHidden = on
    stripSend.isHidden = on || picked.isEmpty
    galleryButton.isHidden = on
    flipButton.isHidden = on
    flashButton.isHidden = on
    closeButton.isHidden = on
    let s = ChatCameraController.shutterSize
    UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.75, initialSpringVelocity: 0.4, options: [.beginFromCurrentState]) {
      self.shutter.transform = on ? CGAffineTransform(scaleX: 1.3, y: 1.3) : .identity
      self.shutterInner.backgroundColor = on ? UIColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1) : UIColor(white: 1, alpha: 0)
      self.shutterInner.layer.cornerRadius = on ? 8 : (s - 18) / 2
      self.shutterInner.frame = on ? CGRect(x: (s - 30) / 2, y: (s - 30) / 2, width: 30, height: 30) : CGRect(x: 9, y: 9, width: s - 18, height: s - 18)
    }
    shutter.layer.borderColor = on ? UIColor(white: 1, alpha: 0.85).cgColor : UIColor.white.cgColor
    if !on {
      ring.removeAllAnimations()
      ring.strokeEnd = 0
      recordTimer?.invalidate()
      recordTimer = nil
      timerLabel.text = "0:00"
    }
  }

  func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
    DispatchQueue.main.async {
      self.recording = true
      self.recordStart = Date()
      let anim = CABasicAnimation(keyPath: "strokeEnd")
      anim.fromValue = 0
      anim.toValue = 1
      anim.duration = self.config.maxVideoSec
      anim.fillMode = .forwards
      anim.isRemovedOnCompletion = false
      self.ring.add(anim, forKey: "progress")
      self.recordTimer?.invalidate()
      self.recordTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
        guard let self = self, let st = self.recordStart else { return }
        self.timerLabel.text = CAFormat.duration(floor(Date().timeIntervalSince(st)))
        self.timerDot.alpha = self.timerDot.alpha > 0.5 ? 0.3 : 1
      }
      if !self.wantsRecording {
        self.engine.queue.async { if self.engine.movieOutput.isRecording { self.engine.movieOutput.stopRecording() } }
      }
    }
  }

  func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
    var ok = error == nil
    if let e = error as NSError?, let fin = e.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool { ok = fin }
    let item = ok ? AttachExporter.cameraVideoItem(outputFileURL) : nil
    DispatchQueue.main.async {
      self.recording = false
      self.wantsRecording = false
      self.engine.setTorch(false)
      self.setRecordingUI(false)
      self.engine.setZoom(1)
      guard let item = item, let dur = item["duration"] as? NSNumber, dur.doubleValue >= 0.6 else {
        try? FileManager.default.removeItem(at: outputFileURL)
        self.flashHint()
        return
      }
      self.finish(["action": "capture", "items": [item]])
    }
  }

  private func flashHint() {
    hintLabel.transform = CGAffineTransform(scaleX: 1.12, y: 1.12)
    UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.5, initialSpringVelocity: 0.6, options: []) {
      self.hintLabel.transform = .identity
    }
  }

  // MARK: recentes

  private func loadRecents() {
    let st = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard st == .authorized || st == .limited else { strip.isHidden = true; return }
    let opts = PHFetchOptions()
    opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    opts.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
    opts.fetchLimit = 40
    recent = PHAsset.fetchAssets(with: opts)
    strip.reloadData()
  }

  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    return recent?.count ?? 0
  }

  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: CAAssetCell.reuseId, for: indexPath) as! CAAssetCell
    cell.contentView.layer.cornerRadius = 6
    cell.badge.setTheme(fill: .white, ink: .black)
    guard let a = recent?.object(at: indexPath.item) else { return cell }
    cell.assetId = a.localIdentifier
    cell.configure(video: a.mediaType == .video, duration: a.duration)
    cell.badge.isHidden = !multiSelect
    let n = picked.firstIndex(of: a.localIdentifier).map { $0 + 1 }
    cell.setSelected(number: n, animated: false)
    cell.accessibilityLabel = a.mediaType == .video ? config.t("video", "Vídeo") : config.t("photo", "Foto")
    let opts = PHImageRequestOptions()
    opts.deliveryMode = .opportunistic
    opts.resizeMode = .fast
    opts.isNetworkAccessAllowed = true
    let id = a.localIdentifier
    let px = 62 * UIScreen.main.scale
    cell.requestId = thumbManager.requestImage(for: a, targetSize: CGSize(width: px, height: px), contentMode: .aspectFill, options: opts) { [weak cell] img, _ in
      guard let cell = cell, cell.assetId == id else { return }
      cell.imageView.image = img
    }
    return cell
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    guard !exporting, !recording, let a = recent?.object(at: indexPath.item) else { return }
    if multiSelect {
      togglePick(a)
    } else {
      caHaptic("light")
      exportPicks([a])
    }
  }

  @objc private func onStripLongPress(_ g: UILongPressGestureRecognizer) {
    guard g.state == .began, !exporting, !recording else { return }
    guard let ip = strip.indexPathForItem(at: g.location(in: strip)), let a = recent?.object(at: ip.item) else { return }
    caHaptic("heavy")
    if !multiSelect {
      multiSelect = true
      for c in strip.visibleCells { (c as? CAAssetCell)?.badge.isHidden = false }
    }
    if !picked.contains(a.localIdentifier) { togglePick(a) }
  }

  private func togglePick(_ a: PHAsset) {
    let id = a.localIdentifier
    if let i = picked.firstIndex(of: id) {
      picked.remove(at: i)
      pickedAssets[id] = nil
    } else {
      guard picked.count < config.maxSelect else { caHaptic("warn"); return }
      picked.append(id)
      pickedAssets[id] = a
    }
    caHaptic("select")
    for c in strip.visibleCells {
      guard let cell = c as? CAAssetCell else { continue }
      let n = picked.firstIndex(of: cell.assetId).map { $0 + 1 }
      cell.setSelected(number: n, animated: cell.assetId == id)
    }
    let show = !picked.isEmpty
    stripSendCount.text = "\(picked.count)"
    stripSend.isHidden = !show
    stripSendWidth.constant = show ? 48 : 0
    UIView.animate(withDuration: 0.25) { self.view.layoutIfNeeded() }
  }

  @objc private func onStripSend() {
    let list = picked.compactMap { pickedAssets[$0] }
    guard !list.isEmpty else { return }
    exportPicks(list)
  }

  private func exportPicks(_ assets: [PHAsset]) {
    exporting = true
    stripSend.isEnabled = false
    AttachExporter.export(assets, asFile: false) { [weak self] items in
      guard let self = self, !self.finished else { return }
      self.exporting = false
      self.stripSend.isEnabled = true
      guard !items.isEmpty else { caHaptic("warn"); return }
      self.finish(["action": "pick", "items": items])
    }
  }

  // MARK: ações

  @objc private func onGallery() {
    guard !recording else { return }
    finish(["action": "gallery"])
  }

  @objc private func onClose() {
    guard !recording else { return }
    finish(["action": "cancel"])
  }

  @objc private func onOpenSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
  }

  private func finish(_ result: [String: Any]) {
    guard !finished else { return }
    finished = true
    releaseCamera()
    dismiss(animated: true) {
      self.onFinish?(result)
      self.onFinish = nil
    }
  }

  func closeFromJS() {
    if recording { engine.queue.async { self.engine.movieOutput.stopRecording() } }
    finish(["action": "cancel"])
  }

  func finishSilently() {
    guard !finished else { return }
    finished = true
    releaseCamera()
    let cb = onFinish
    onFinish = nil
    dismiss(animated: false) { cb?(["action": "cancel"]) }
  }
}
