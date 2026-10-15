import UIKit
import AVFoundation

// [2026-10-15 native-vnote] Gravador de VÍDEO-RECADO redondo (nível Telegram).
//
//   • preview circular da sessão ÚNICA do app (CAEngine — a mesma pré-aquecida
//     da folha de anexos / câmera do chat), anel de progresso (máx. maxSec);
//   • autoStart (padrão, pedido do founder em 10/10): abre já gravando em mãos
//     livres → Lixeira | ENVIAR. Sem autoStart: SEGURAR o botão grava, arrastar
//     p/ cima trava, p/ a esquerda cancela, soltar envia (toque curto = trava);
//   • duplo toque no círculo troca a câmera, inclusive DURANTE a gravação (cada
//     troca fecha um segmento; VideoNoteExporter junta tudo);
//   • flash: traseira = lanterna; frontal = tela branca + brilho máximo;
//   • permissão sem surpresa: card explicando ANTES do prompt do sistema;
//     negada → card com "Abrir Ajustes" (microfone é obrigatório);
//   • saída: MP4 quadrado H.264 size×size + AAC (VideoNoteExporter).
// Resultado (UM por apresentação): send {item} | cancel | error {message}.
final class VideoNoteController: UIViewController, AVCaptureFileOutputRecordingDelegate, UIGestureRecognizerDelegate {

  struct Config {
    let labels: [String: String]
    let maxSec: Double
    let size: Int
    let autoStart: Bool
    let withAudio: Bool
    let bitrate: Int

    init(_ o: [String: Any]) {
      var l: [String: String] = [:]
      if let raw = o["labels"] as? [String: Any] {
        for (k, v) in raw { if let s = v as? String, !s.isEmpty { l[k] = s } }
      }
      labels = l
      maxSec = min(120, max(3, AttachConfig.double(o["maxSec"]) ?? 60))
      size = min(1080, max(240, AttachConfig.int(o["size"]) ?? 640))
      autoStart = (o["autoStart"] as? Bool) ?? true
      withAudio = (o["withAudio"] as? Bool) ?? true
      bitrate = min(6_000_000, max(300_000, AttachConfig.int(o["bitrate"]) ?? 1_200_000))
    }

    func t(_ k: String, _ fb: String) -> String { return labels[k] ?? fb }
  }

  private enum Phase { case permission, starting, idle, recording, processing, done }

  var onFinish: (([String: Any]) -> Void)?

  private let cfg: Config
  private let engine = CAEngine.shared
  private var phase: Phase = .starting
  private var acquired = false
  private var finished = false
  private var originalPosition: AVCaptureDevice.Position = .back

  // gravação (segmentos)
  private var segments: [URL] = []
  private var doneSeconds: Double = 0
  private var segmentActive = false      // startRecording pedido e ainda sem didFinish
  private var segmentStartedAt: CFTimeInterval = 0
  private var segmentStarted = false     // didStartRecording chegou
  private var pendingFlip = false
  private enum StopIntent { case none, send, discard }
  private var stopIntent: StopIntent = .none
  private var locked = false
  private var cancelIntent = false
  private var holdBegan: CFTimeInterval = 0
  private var holdOrigin: CGPoint = .zero
  private var lastWarnSec = -1
  private var link: CADisplayLink?
  private var flashOn = false
  private var savedBrightness: CGFloat = -1
  private var sessionRunningObs = false

  // views
  private let backdrop = UIView()
  private let circleWrap = UIView()
  private let preview = CAPreviewView(frame: .zero)
  private let track = CAShapeLayer()
  private let ring = CAShapeLayer()
  private let spinner = UIActivityIndicatorView(style: .large)
  private let processingLabel = UILabel()
  private let timerPill = UIView()
  private let timerDot = UIView()
  private let timerLabel = UILabel()
  private let closeButton = UIButton(type: .system)
  private let flashButton = UIButton(type: .system)
  private let flipButton = UIButton(type: .system)
  private let hintLabel = UILabel()
  private let recordButton = UIView()
  private let recordInner = UIView()
  private let sendButton = UIButton(type: .custom)
  private let trashButton = UIButton(type: .system)
  private let lockPill = UIView()
  private let lockIcon = UIImageView()
  private let lockChevron = UIImageView()
  private let permCard = UIView()
  private let permTitle = UILabel()
  private let permBody = UILabel()
  private let permButton = UIButton(type: .system)

  private static let recordSize: CGFloat = 72
  private static let red = UIColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1)

  init(config: Config) {
    self.cfg = config
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    NotificationCenter.default.removeObserver(self)
    link?.invalidate()
  }

  override var prefersStatusBarHidden: Bool { return true }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { return .portrait }
  override var prefersHomeIndicatorAutoHidden: Bool { return true }

  private var diameter: CGFloat {
    let w = view.bounds.width > 0 ? view.bounds.width : UIScreen.main.bounds.width
    return min(w - 48, 320)
  }

  // MARK: ciclo de vida

  override func viewDidLoad() {
    super.viewDidLoad()
    overrideUserInterfaceStyle = .dark
    view.backgroundColor = .clear
    originalPosition = engine.position

    backdrop.backgroundColor = UIColor(white: 0, alpha: 0.88)
    backdrop.frame = view.bounds
    backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(backdrop)

    circleWrap.clipsToBounds = true
    circleWrap.backgroundColor = UIColor(white: 0.1, alpha: 1)
    view.addSubview(circleWrap)
    preview.alpha = 0
    preview.isUserInteractionEnabled = false
    circleWrap.addSubview(preview)
    let dbl = UITapGestureRecognizer(target: self, action: #selector(onDoubleTap))
    dbl.numberOfTapsRequired = 2
    circleWrap.addGestureRecognizer(dbl)
    circleWrap.isAccessibilityElement = true
    circleWrap.accessibilityTraits = .button
    circleWrap.accessibilityLabel = cfg.t("flip", "Trocar câmera")

    track.fillColor = UIColor.clear.cgColor
    track.strokeColor = UIColor(white: 1, alpha: 0.18).cgColor
    track.lineWidth = 4
    view.layer.addSublayer(track)
    ring.fillColor = UIColor.clear.cgColor
    ring.strokeColor = UIColor.white.cgColor
    ring.lineWidth = 4
    ring.lineCap = .round
    ring.strokeEnd = 0
    view.layer.addSublayer(ring)

    spinner.color = .white
    spinner.hidesWhenStopped = true
    view.addSubview(spinner)
    processingLabel.text = cfg.t("processing", "Preparando vídeo…")
    processingLabel.textColor = .white
    processingLabel.font = .systemFont(ofSize: 14, weight: .medium)
    processingLabel.textAlignment = .center
    processingLabel.isHidden = true
    view.addSubview(processingLabel)

    timerPill.backgroundColor = UIColor(white: 0, alpha: 0.55)
    timerPill.layer.cornerRadius = 15
    timerPill.isHidden = true
    timerDot.backgroundColor = VideoNoteController.red
    timerDot.layer.cornerRadius = 4
    timerPill.addSubview(timerDot)
    timerLabel.textColor = .white
    timerLabel.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
    timerLabel.text = "0:00"
    timerPill.addSubview(timerLabel)
    view.addSubview(timerPill)

    roundButton(closeButton, "xmark", cfg.t("close", "Fechar"))
    closeButton.addTarget(self, action: #selector(onClose), for: .touchUpInside)
    view.addSubview(closeButton)
    roundButton(flashButton, "bolt.slash.fill", cfg.t("flashOff", "Flash desligado"))
    flashButton.addTarget(self, action: #selector(onFlash), for: .touchUpInside)
    view.addSubview(flashButton)
    roundButton(flipButton, "arrow.triangle.2.circlepath", cfg.t("flip", "Trocar câmera"))
    flipButton.addTarget(self, action: #selector(onDoubleTap), for: .touchUpInside)
    view.addSubview(flipButton)

    hintLabel.textColor = UIColor(white: 1, alpha: 0.85)
    hintLabel.font = .systemFont(ofSize: 14, weight: .medium)
    hintLabel.textAlignment = .center
    hintLabel.numberOfLines = 2
    hintLabel.text = cfg.t("hold", "Segure para gravar")
    view.addSubview(hintLabel)

    // pílula do cadeado (só enquanto segura sem travar)
    lockPill.backgroundColor = UIColor(white: 0.15, alpha: 0.92)
    lockPill.layer.cornerRadius = 22
    lockPill.alpha = 0
    lockIcon.image = CAFormat.symbol("lock.open.fill", 17, .semibold)
    lockIcon.tintColor = .white
    lockIcon.contentMode = .center
    lockPill.addSubview(lockIcon)
    lockChevron.image = CAFormat.symbol("chevron.up", 14, .bold)
    lockChevron.tintColor = UIColor(white: 1, alpha: 0.7)
    lockChevron.contentMode = .center
    lockPill.addSubview(lockChevron)
    view.addSubview(lockPill)

    // botão gravar (segurar)
    recordButton.backgroundColor = UIColor(white: 1, alpha: 0.16)
    recordButton.layer.cornerRadius = VideoNoteController.recordSize / 2
    recordButton.layer.borderColor = UIColor.white.cgColor
    recordButton.layer.borderWidth = 3
    recordInner.backgroundColor = VideoNoteController.red
    recordInner.isUserInteractionEnabled = false
    recordButton.addSubview(recordInner)
    recordButton.isAccessibilityElement = true
    recordButton.accessibilityTraits = .button
    recordButton.accessibilityLabel = cfg.t("hold", "Segure para gravar")
    let hold = UILongPressGestureRecognizer(target: self, action: #selector(onHold(_:)))
    hold.minimumPressDuration = 0.12
    hold.allowableMovement = 600
    hold.delegate = self
    recordButton.addGestureRecognizer(hold)
    view.addSubview(recordButton)

    sendButton.backgroundColor = .white
    sendButton.layer.cornerRadius = VideoNoteController.recordSize / 2
    sendButton.setImage(CAFormat.symbol("arrow.up", 26, .bold), for: .normal)
    sendButton.tintColor = .black
    sendButton.accessibilityLabel = cfg.t("send", "Enviar")
    sendButton.addTarget(self, action: #selector(onSend), for: .touchUpInside)
    sendButton.isHidden = true
    view.addSubview(sendButton)

    roundButton(trashButton, "trash", cfg.t("cancel", "Descartar"))
    trashButton.addTarget(self, action: #selector(onTrash), for: .touchUpInside)
    trashButton.isHidden = true
    view.addSubview(trashButton)

    buildPermissionCard()
    refreshFlashButton()

    NotificationCenter.default.addObserver(self, selector: #selector(onSessionStarted), name: .AVCaptureSessionDidStartRunning, object: engine.session)
    NotificationCenter.default.addObserver(self, selector: #selector(onResignActive), name: UIApplication.willResignActiveNotification, object: nil)

    startFlow()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let b = view.bounds
    let safe = view.safeAreaInsets
    let d = diameter
    let cx = b.width / 2
    let cy = max(safe.top + 70 + d / 2, b.height * 0.40)
    circleWrap.frame = CGRect(x: cx - d / 2, y: cy - d / 2, width: d, height: d)
    circleWrap.layer.cornerRadius = d / 2
    preview.frame = circleWrap.bounds
    let r = d / 2 + 7
    let path = UIBezierPath(arcCenter: CGPoint(x: cx, y: cy), radius: r, startAngle: -.pi / 2, endAngle: .pi * 1.5, clockwise: true).cgPath
    track.path = path
    ring.path = path
    spinner.center = CGPoint(x: cx, y: cy)
    processingLabel.frame = CGRect(x: 16, y: cy + d / 2 + 22, width: b.width - 32, height: 22)

    timerLabel.sizeToFit()
    let tw = max(64, timerLabel.bounds.width + 36)
    timerPill.frame = CGRect(x: cx - tw / 2, y: cy - d / 2 - 52, width: tw, height: 30)
    timerDot.frame = CGRect(x: 12, y: 11, width: 8, height: 8)
    timerLabel.frame = CGRect(x: 26, y: 0, width: tw - 34, height: 30)

    let top = safe.top + 10
    closeButton.frame = CGRect(x: 16, y: top, width: 44, height: 44)
    flipButton.frame = CGRect(x: b.width - 16 - 44, y: top, width: 44, height: 44)
    flashButton.frame = CGRect(x: b.width - 16 - 44 - 12 - 44, y: top, width: 44, height: 44)

    let s = VideoNoteController.recordSize
    let by = b.height - max(safe.bottom, 16) - 24 - s
    if recordButton.transform == .identity {
      recordButton.frame = CGRect(x: b.width - 24 - s, y: by, width: s, height: s)
    }
    sendButton.frame = CGRect(x: b.width - 24 - s, y: by, width: s, height: s)
    trashButton.frame = CGRect(x: 24 + 8, y: by + (s - 44) / 2, width: 44, height: 44)
    layoutRecordInner()
    lockPill.frame = CGRect(x: b.width - 24 - s + (s - 44) / 2, y: by - 16 - 88, width: 44, height: 88)
    lockIcon.frame = CGRect(x: 0, y: 8, width: 44, height: 36)
    lockChevron.frame = CGRect(x: 0, y: 46, width: 44, height: 30)
    hintLabel.frame = CGRect(x: 24, y: by + (s - 44) / 2, width: b.width - 48 - s - 12, height: 44)
    if !permCard.isHidden {
      let cw = min(b.width - 48, 340)
      let th = permTitle.sizeThatFits(CGSize(width: cw - 40, height: 200)).height
      let bh = permBody.sizeThatFits(CGSize(width: cw - 40, height: 400)).height
      let ch = 24 + th + 10 + bh + 20 + 46 + 22
      permCard.frame = CGRect(x: (b.width - cw) / 2, y: (b.height - ch) / 2, width: cw, height: ch)
      permTitle.frame = CGRect(x: 20, y: 24, width: cw - 40, height: th)
      permBody.frame = CGRect(x: 20, y: permTitle.frame.maxY + 10, width: cw - 40, height: bh)
      permButton.frame = CGRect(x: 20, y: permBody.frame.maxY + 20, width: cw - 40, height: 46)
    }
  }

  private func layoutRecordInner() {
    let s = VideoNoteController.recordSize
    let rec = phase == .recording
    let inner: CGFloat = rec ? 28 : s - 18
    recordInner.frame = CGRect(x: (s - inner) / 2, y: (s - inner) / 2, width: inner, height: inner)
    recordInner.layer.cornerRadius = rec ? 7 : inner / 2
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    restoreBrightness()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    releaseCamera()
  }

  // MARK: UI helpers

  private func roundButton(_ b: UIButton, _ symbol: String, _ label: String) {
    b.setImage(CAFormat.symbol(symbol, 18, .semibold), for: .normal)
    b.tintColor = .white
    b.backgroundColor = UIColor(white: 0, alpha: 0.42)
    b.layer.cornerRadius = 22
    b.accessibilityLabel = label
  }

  private func buildPermissionCard() {
    permCard.backgroundColor = UIColor(white: 0.11, alpha: 1)
    permCard.layer.cornerRadius = 20
    permCard.isHidden = true
    permTitle.textColor = .white
    permTitle.font = .systemFont(ofSize: 18, weight: .bold)
    permTitle.textAlignment = .center
    permTitle.numberOfLines = 0
    permTitle.text = cfg.t("permTitle", "Vídeo-recado")
    permCard.addSubview(permTitle)
    permBody.textColor = UIColor(white: 1, alpha: 0.72)
    permBody.font = .systemFont(ofSize: 15)
    permBody.textAlignment = .center
    permBody.numberOfLines = 0
    permCard.addSubview(permBody)
    permButton.backgroundColor = .white
    permButton.setTitleColor(.black, for: .normal)
    permButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
    permButton.layer.cornerRadius = 23
    permButton.addTarget(self, action: #selector(onPermButton), for: .touchUpInside)
    permCard.addSubview(permButton)
    view.addSubview(permCard)
  }

  private func setControlsVisible(_ on: Bool) {
    for v in [flashButton, flipButton, recordButton, hintLabel] as [UIView] { v.isHidden = !on }
  }

  private func refreshFlashButton() {
    flashButton.setImage(CAFormat.symbol(flashOn ? "bolt.fill" : "bolt.slash.fill", 18, .semibold), for: .normal)
    flashButton.accessibilityLabel = flashOn ? cfg.t("flashOn", "Flash ligado") : cfg.t("flashOff", "Flash desligado")
    flashButton.tintColor = flashOn ? UIColor(red: 1, green: 0.84, blue: 0.2, alpha: 1) : .white
  }

  // MARK: permissão (sem surpresa)

  private func status() -> (cam: AVAuthorizationStatus, mic: AVAuthorizationStatus) {
    return (AVCaptureDevice.authorizationStatus(for: .video),
            cfg.withAudio ? AVCaptureDevice.authorizationStatus(for: .audio) : .authorized)
  }

  private func startFlow() {
    let s = status()
    if s.cam == .authorized && s.mic == .authorized { beginSession(); return }
    let denied = [s.cam, s.mic].contains(where: { $0 == .denied || $0 == .restricted })
    showPermission(denied: denied)
  }

  private var permDenied = false

  private func showPermission(denied: Bool) {
    phase = .permission
    permDenied = denied
    permBody.text = denied
      ? cfg.t("permDeniedBody", "A câmera ou o microfone estão bloqueados. Ative nos Ajustes.")
      : cfg.t("permBody", "Para gravar, o Chatyy precisa da câmera e do microfone.")
    permButton.setTitle(denied ? cfg.t("permSettings", "Abrir Ajustes") : cfg.t("permAllow", "Continuar"), for: .normal)
    permCard.isHidden = false
    circleWrap.isHidden = true
    track.isHidden = true
    ring.isHidden = true
    setControlsVisible(false)
    view.setNeedsLayout()
  }

  @objc private func onPermButton() {
    if permDenied {
      if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
      return
    }
    permButton.isEnabled = false
    requestCamera { [weak self] camOK in
      guard let self = self, !self.finished else { return }
      guard camOK else { self.permButton.isEnabled = true; self.showPermission(denied: true); return }
      self.requestMic { micOK in
        guard !self.finished else { return }
        self.permButton.isEnabled = true
        if micOK { self.beginSession() } else { self.showPermission(denied: true) }
      }
    }
  }

  private func requestCamera(_ cb: @escaping (Bool) -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: cb(true)
    case .notDetermined: AVCaptureDevice.requestAccess(for: .video) { ok in DispatchQueue.main.async { cb(ok) } }
    default: cb(false)
    }
  }

  private func requestMic(_ cb: @escaping (Bool) -> Void) {
    if !cfg.withAudio { cb(true); return }
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: cb(true)
    case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { cb(ok) } }
    default: cb(false)
    }
  }

  // MARK: sessão

  private func beginSession() {
    permCard.isHidden = true
    circleWrap.isHidden = false
    track.isHidden = false
    ring.isHidden = false
    setControlsVisible(true)
    phase = .starting
    guard !acquired else { return }
    acquired = true
    preview.attach()
    // Vídeo-recado nasce na câmera FRONTAL (a do chat continua onde estava:
    // releaseCamera devolve a posição original).
    if engine.position != .front { engine.flip { _ in } }
    // microfone entra ANTES do startRunning (evita reconfigurar a sessão rodando)
    if cfg.withAudio { engine.addAudio() }
    engine.acquire { [weak self] in
      guard let self = self else { return }
      if self.engine.session.isRunning { self.sessionReady() }
    }
    if cfg.autoStart {
      hintLabel.text = ""
    }
  }

  @objc private func onSessionStarted() {
    DispatchQueue.main.async { self.sessionReady() }
  }

  private func sessionReady() {
    guard acquired, !finished else { return }
    if preview.alpha < 1 { UIView.animate(withDuration: 0.2) { self.preview.alpha = 1 } }
    applyFlash()
    guard phase == .starting else { return }
    phase = .idle
    if cfg.autoStart {
      locked = true
      startRecording()
    }
  }

  private func releaseCamera() {
    guard acquired else { return }
    acquired = false
    link?.invalidate()
    link = nil
    if engine.movieOutput.isRecording { engine.queue.async { self.engine.movieOutput.stopRecording() } }
    engine.setTorch(false)
    preview.detach()
    engine.removeAudio()
    if engine.position != originalPosition { engine.flip { _ in } }
    engine.relinquish()
  }

  @objc private func onResignActive() {
    // App foi p/ segundo plano no meio da gravação → descarta (nunca envia sozinho).
    if phase == .recording { discardAndClose() }
  }

  // MARK: flash

  @objc private func onFlash() {
    flashOn.toggle()
    caHaptic("select")
    refreshFlashButton()
    applyFlash()
  }

  private func applyFlash() {
    let front = engine.position == .front
    if flashOn && front {
      engine.setTorch(false)
      if savedBrightness < 0 { savedBrightness = UIScreen.main.brightness }
      UIScreen.main.brightness = 1
      UIView.animate(withDuration: 0.2) { self.backdrop.backgroundColor = .white }
    } else {
      restoreBrightness()
      UIView.animate(withDuration: 0.2) { self.backdrop.backgroundColor = UIColor(white: 0, alpha: 0.88) }
      engine.queue.async { self.engine.setTorch(self.flashOn && !front) }
    }
  }

  private func restoreBrightness() {
    if savedBrightness >= 0 { UIScreen.main.brightness = savedBrightness; savedBrightness = -1 }
  }

  // MARK: trocar câmera

  @objc private func onDoubleTap() {
    guard acquired, phase == .idle || phase == .recording || phase == .starting else { return }
    // troca já em andamento (entre segmentos) → ignora
    if phase == .recording && (!segmentActive || pendingFlip) { return }
    caHaptic("select")
    UIView.transition(with: circleWrap, duration: 0.3, options: [.transitionFlipFromLeft, .allowAnimatedContent], animations: nil)
    if phase == .recording && segmentActive {
      // Fecha o segmento atual; didFinish troca a câmera e abre o próximo.
      pendingFlip = true
      engine.queue.async { if self.engine.movieOutput.isRecording { self.engine.movieOutput.stopRecording() } }
      return
    }
    engine.flip { [weak self] _ in self?.applyFlash() }
  }

  // MARK: gravação

  private func startRecording() {
    guard acquired, !finished, phase == .idle else { return }
    phase = .recording
    stopIntent = .none
    segments.removeAll()
    doneSeconds = 0
    lastWarnSec = -1
    caHaptic("heavy")
    setRecordingUI(true)
    startSegment()
    let l = CADisplayLink(target: self, selector: #selector(onTick))
    if #available(iOS 15.0, *) { l.preferredFrameRateRange = CAFrameRateRange(minimum: 20, maximum: 60, preferred: 30) }
    l.add(to: .main, forMode: .common)
    link = l
  }

  private func startSegment() {
    let remaining = cfg.maxSec - doneSeconds
    guard remaining > 0.3 else { finishRecording(.send); return }
    let url = AttachExporter.freshURL(ext: "mov")
    segmentActive = true
    segmentStarted = false
    engine.queue.async {
      guard self.segmentActive, !self.engine.movieOutput.isRecording else { return }
      // [2026-10-15 espelho] Vídeo-recado sai IGUAL ao preview (frontal
      // espelhada), como a nota circular do WhatsApp/Telegram.
      self.engine.setFrontOutputMirrored(true)
      self.engine.setCaptureOrientation(.portrait)
      self.engine.movieOutput.maxRecordedDuration = CMTime(seconds: remaining + 0.25, preferredTimescale: 600)
      self.engine.movieOutput.startRecording(to: url, recordingDelegate: self)
    }
  }

  private var elapsed: Double {
    guard segmentActive, segmentStarted else { return doneSeconds }
    return doneSeconds + max(0, CACurrentMediaTime() - segmentStartedAt)
  }

  @objc private func onTick() {
    guard phase == .recording else { return }
    let e = min(elapsed, cfg.maxSec)
    let p = CGFloat(e / cfg.maxSec)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    ring.strokeEnd = p
    CATransaction.commit()
    let warn = cfg.maxSec - e <= 10
    ring.strokeColor = (warn ? VideoNoteController.red : UIColor.white).cgColor
    let sec = Int(e)
    timerLabel.text = CAFormat.duration(floor(e))
    timerDot.alpha = (Int(e * 2) % 2 == 0) ? 1 : 0.3
    if warn && sec != lastWarnSec && e < cfg.maxSec {
      lastWarnSec = sec
      caHaptic("warn")
    }
    if e >= cfg.maxSec - 0.05 { finishRecording(.send) }
  }

  private func setRecordingUI(_ on: Bool) {
    timerPill.isHidden = !on
    closeButton.isHidden = false
    flashButton.isHidden = false
    if on {
      timerLabel.text = "0:00"
      view.setNeedsLayout()
    }
    refreshBottom()
  }

  /// Barra de baixo conforme o estado: ocioso (gravar) | segurando (gravar +
  /// cadeado + dica) | travado (lixeira + enviar).
  private func refreshBottom() {
    let rec = phase == .recording
    let lockedNow = rec && locked
    sendButton.isHidden = !lockedNow
    trashButton.isHidden = !lockedNow
    recordButton.isHidden = lockedNow || phase == .processing || phase == .permission
    if lockedNow {
      hintLabel.text = ""
    } else if rec {
      hintLabel.text = cancelIntent ? cfg.t("releaseToCancel", "Solte para cancelar") : cfg.t("slideHints", "Deslize ↑ travar • ← cancelar")
      hintLabel.textColor = cancelIntent ? VideoNoteController.red : UIColor(white: 1, alpha: 0.85)
    } else if phase == .idle {
      hintLabel.text = cfg.autoStart ? "" : cfg.t("hold", "Segure para gravar")
      hintLabel.textColor = UIColor(white: 1, alpha: 0.85)
    }
    UIView.animate(withDuration: 0.2) {
      self.lockPill.alpha = (rec && !self.locked) ? 1 : 0
      self.layoutRecordInner()
    }
  }

  @objc private func onHold(_ g: UILongPressGestureRecognizer) {
    switch g.state {
    case .began:
      guard phase == .idle else { return }
      holdBegan = CACurrentMediaTime()
      holdOrigin = g.location(in: view)
      locked = false
      cancelIntent = false
      startRecording()
      UIView.animate(withDuration: 0.2) { self.recordButton.transform = CGAffineTransform(scaleX: 1.25, y: 1.25) }
      animateLockChevron()
    case .changed:
      guard phase == .recording, !locked else { return }
      let p = g.location(in: view)
      let dx = p.x - holdOrigin.x
      let dy = p.y - holdOrigin.y
      if dy < 0 && abs(dy) > abs(dx) {
        let ty = max(dy, -120)
        recordButton.transform = CGAffineTransform(translationX: 0, y: ty).scaledBy(x: 1.25, y: 1.25)
        if cancelIntent { cancelIntent = false; refreshBottom() }
        if -dy >= 60 {
          locked = true
          caHaptic("heavy")
          recordButton.transform = .identity
          refreshBottom()
        }
      } else if dx < 0 && abs(dx) > abs(dy) {
        recordButton.transform = CGAffineTransform(translationX: max(dx, -160), y: 0).scaledBy(x: 1.25, y: 1.25)
        let past = -dx >= 90
        if past != cancelIntent {
          cancelIntent = past
          if past { caHaptic("select") }
          refreshBottom()
        }
      } else {
        recordButton.transform = CGAffineTransform(scaleX: 1.25, y: 1.25)
      }
    case .ended, .cancelled, .failed:
      UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0.3, options: [.beginFromCurrentState]) {
        self.recordButton.transform = .identity
      }
      guard phase == .recording, !locked else { return }
      if cancelIntent || g.state != .ended {
        discardAndClose()
        return
      }
      if CACurrentMediaTime() - holdBegan < 1.0 {
        // toque curto = mãos livres (igual ao gravador JS)
        locked = true
        caHaptic("heavy")
        refreshBottom()
      } else {
        finishRecording(.send)
      }
    default:
      break
    }
  }

  func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    return false
  }

  private func animateLockChevron() {
    lockChevron.layer.removeAllAnimations()
    let a = CABasicAnimation(keyPath: "transform.translation.y")
    a.fromValue = 4
    a.toValue = -4
    a.duration = 0.6
    a.autoreverses = true
    a.repeatCount = .greatestFiniteMagnitude
    lockChevron.layer.add(a, forKey: "bounce")
  }

  @objc private func onSend() {
    guard phase == .recording else { return }
    finishRecording(.send)
  }

  @objc private func onTrash() {
    caHaptic("heavy")
    discardAndClose()
  }

  @objc private func onClose() {
    if phase == .recording { discardAndClose(); return }
    if phase == .processing { return }
    finish(["action": "cancel"])
  }

  private func discardAndClose() {
    stopIntent = .discard
    pendingFlip = false
    link?.invalidate()
    link = nil
    if segmentActive {
      engine.queue.async { if self.engine.movieOutput.isRecording { self.engine.movieOutput.stopRecording() } }
    }
    cleanupSegments()
    finish(["action": "cancel"])
  }

  private func finishRecording(_ intent: StopIntent) {
    guard phase == .recording, stopIntent == .none else { return }
    stopIntent = intent
    pendingFlip = false
    link?.invalidate()
    link = nil
    caHaptic("select")
    if segmentActive {
      engine.queue.async { if self.engine.movieOutput.isRecording { self.engine.movieOutput.stopRecording() } }
      // didStart ainda não chegou → didFinish cuida (com erro / sem arquivo).
    } else {
      process()
    }
  }

  // MARK: AVCaptureFileOutputRecordingDelegate

  func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
    DispatchQueue.main.async {
      self.segmentStarted = true
      self.segmentStartedAt = CACurrentMediaTime()
      if self.stopIntent != .none || self.pendingFlip || self.finished {
        self.engine.queue.async { if self.engine.movieOutput.isRecording { self.engine.movieOutput.stopRecording() } }
      }
    }
  }

  func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
    var ok = error == nil
    var maxReached = false
    if let e = error as NSError? {
      if let fin = e.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool { ok = fin }
      if e.code == AVError.maximumDurationReached.rawValue { maxReached = true }
    }
    let dur = ok ? CMTimeGetSeconds(AVURLAsset(url: outputFileURL).duration) : 0
    DispatchQueue.main.async {
      self.segmentActive = false
      self.segmentStarted = false
      if ok && dur.isFinite && dur > 0.05 {
        self.segments.append(outputFileURL)
        self.doneSeconds += dur
      } else {
        try? FileManager.default.removeItem(at: outputFileURL)
      }
      if self.finished || self.stopIntent == .discard {
        self.cleanupSegments()
        return
      }
      if self.stopIntent == .send || maxReached || self.doneSeconds >= self.cfg.maxSec - 0.2 {
        if self.stopIntent == .none { self.stopIntent = .send; self.link?.invalidate(); self.link = nil }
        self.process()
        return
      }
      if self.pendingFlip {
        self.pendingFlip = false
        self.engine.flip { [weak self] _ in
          // enviar/descartar durante a troca: finishRecording/discard já cuidaram.
          guard let self = self, self.phase == .recording, self.stopIntent == .none else { return }
          self.applyFlash()
          self.startSegment()
        }
        return
      }
      // Parou sozinho (interrupção/erro): com algo gravado, envia o que tem;
      // sem nada, volta ao ocioso.
      if self.phase == .recording {
        if self.doneSeconds >= 0.6 {
          self.stopIntent = .send
          self.link?.invalidate(); self.link = nil
          self.process()
        } else {
          self.resetToIdle(error: true)
        }
      }
    }
  }

  private func resetToIdle(error: Bool) {
    link?.invalidate()
    link = nil
    cleanupSegments()
    phase = .idle
    locked = false
    cancelIntent = false
    stopIntent = .none
    ring.strokeEnd = 0
    timerPill.isHidden = true
    refreshBottom()
    // Depois de uma falha/curto demais o autoStart NÃO regrava sozinho: fica
    // o botão de segurar (sem surpresa).
    recordButton.isHidden = false
    hintLabel.text = error ? cfg.t("error", "Não foi possível gravar o vídeo") : cfg.t("hold", "Segure para gravar")
    if error { caHaptic("warn") }
  }

  private func cleanupSegments() {
    for u in segments { try? FileManager.default.removeItem(at: u) }
    segments.removeAll()
  }

  // MARK: exportar

  private func process() {
    guard phase == .recording || phase == .idle else { return }
    let segs = segments
    let total = doneSeconds
    guard !segs.isEmpty, total >= 0.6 else {
      // curto demais: volta ao ocioso (autoStart → oferece segurar p/ gravar)
      resetToIdle(error: false)
      hintLabel.text = cfg.t("hold", "Segure para gravar")
      recordButton.isHidden = false
      locked = false
      if cfg.autoStart { caHaptic("warn") }
      return
    }
    phase = .processing
    segments.removeAll()
    timerPill.isHidden = true
    recordButton.isHidden = true
    sendButton.isHidden = true
    trashButton.isHidden = true
    lockPill.alpha = 0
    hintLabel.text = ""
    flashButton.isHidden = true
    flipButton.isHidden = true
    spinner.startAnimating()
    processingLabel.isHidden = false
    ring.strokeEnd = 1
    // solta a câmera já (o usuário não vê mais nada ao vivo)
    preview.alpha = 0.35
    engine.setTorch(false)
    VideoNoteExporter.export(segments: segs, size: cfg.size, bitrate: cfg.bitrate) { [weak self] out in
      guard let self = self else { return }
      if let out = out {
        for u in segs { try? FileManager.default.removeItem(at: u) }
        let name = out.url.lastPathComponent
        self.finish(["action": "send", "item": [
          "uri": out.url.absoluteString,
          "name": name,
          "type": "video/mp4",
          "size": AttachExporter.fileSize(out.url),
          "width": out.size,
          "height": out.size,
          "duration": NSNumber(value: (out.duration * 10).rounded() / 10),
          "mediaType": "video",
        ] as [String: Any]])
        return
      }
      // Falhou o transcode: nunca perde a gravação — manda o 1º segmento como está.
      if let first = segs.first, FileManager.default.fileExists(atPath: first.path) {
        for u in segs.dropFirst() { try? FileManager.default.removeItem(at: u) }
        var item = AttachExporter.cameraVideoItem(first)
        item["name"] = "video_note_\(Int(Date().timeIntervalSince1970 * 1000)).\(first.pathExtension.isEmpty ? "mov" : first.pathExtension)"
        self.finish(["action": "send", "item": item])
      } else {
        self.finish(["action": "error", "message": "export_failed"])
      }
    }
  }

  // MARK: fim

  private func finish(_ result: [String: Any]) {
    guard !finished else { return }
    finished = true
    phase = .done
    link?.invalidate()
    link = nil
    restoreBrightness()
    releaseCamera()
    dismiss(animated: true) {
      self.onFinish?(result)
      self.onFinish = nil
    }
  }

  func closeFromJS() {
    if phase == .recording { discardAndClose(); return }
    finish(["action": "cancel"])
  }

  func finishSilently() {
    guard !finished else { return }
    finished = true
    stopIntent = .discard
    restoreBrightness()
    releaseCamera()
    cleanupSegments()
    let cb = onFinish
    onFinish = nil
    dismiss(animated: false) { cb?(["action": "cancel"]) }
  }
}
