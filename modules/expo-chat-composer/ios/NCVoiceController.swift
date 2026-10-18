import AVFoundation
import UIKit

// [2026-10-14 native-composer] Gravação de voz DENTRO do composer (Telegram /
// WhatsApp): segurar o microfone grava (AVAudioRecorder AAC-LC mono 24 kHz
// 32 kbps — mesmo perfil do ExpoNativeAudio, todos os players/caches já
// entendem m4a); arrastar para a ESQUERDA cancela; para CIMA trava (mãos
// livres: lixeira + onda + enviar). Soltar envia. < 1 s = "curto demais".
// Nada sobe daqui: entrega {uri, durationMs, waveform} ao JS (fila/upload lá).

final class NCWaveformView: UIView {
  private var levels: [Float] = []
  var barColor: UIColor = .label { didSet { setNeedsDisplay() } }
  private let barW: CGFloat = 2.5
  private let barGap: CGFloat = 2
  // [2026-10-18 voz-pausa] Modo estático (gravação pausada): a onda inteira
  // reamostrada na largura, da esquerda p/ a direita, com o trecho já ouvido
  // na prévia pintado em `playedColor`. `staticSource == nil` = modo ao vivo.
  private var staticSource: [Float]? = nil
  var playedColor: UIColor = .systemBlue { didSet { setNeedsDisplay() } }
  var progress: CGFloat = 0 { didSet { setNeedsDisplay() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isUserInteractionEnabled = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func reset() {
    staticSource = nil
    progress = 0
    levels.removeAll()
    setNeedsDisplay()
  }

  /// [2026-10-18 voz-pausa] Onda inteira (pausado) — reamostrada na largura atual.
  func setStatic(_ src: [Float]) {
    staticSource = src
    progress = 0
    refitStatic()
  }

  private func refitStatic() {
    guard let src = staticSource else { return }
    let cap = max(8, Int(bounds.width / (barW + barGap)))
    levels = NCVoiceController.resample(src, bars: cap)
    setNeedsDisplay()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if staticSource != nil { refitStatic() }
  }

  func push(_ level: Float) {
    if staticSource != nil { return }
    levels.append(level)
    let cap = max(8, Int(bounds.width / (barW + barGap)) + 1)
    if levels.count > cap { levels.removeFirst(levels.count - cap) }
    setNeedsDisplay()
  }

  override func draw(_ rect: CGRect) {
    guard !levels.isEmpty else { return }
    let h = bounds.height
    if staticSource != nil {
      let n = levels.count
      var sx: CGFloat = 0
      for (i, lv) in levels.enumerated() {
        if sx + barW > bounds.width { break }
        let played = n > 0 && (CGFloat(i) + 0.5) / CGFloat(n) <= progress
        (played ? playedColor : barColor).setFill()
        let bh = max(3, CGFloat(lv) * h)
        let r = CGRect(x: sx, y: (h - bh) / 2, width: barW, height: bh)
        UIBezierPath(roundedRect: r, cornerRadius: barW / 2).fill()
        sx += barW + barGap
      }
      return
    }
    barColor.setFill()
    var x = bounds.width - barW
    for lv in levels.reversed() {
      if x < 0 { break }
      let bh = max(3, CGFloat(lv) * h)
      let r = CGRect(x: x, y: (h - bh) / 2, width: barW, height: bh)
      UIBezierPath(roundedRect: r, cornerRadius: barW / 2).fill()
      x -= barW + barGap
    }
  }
}

/// Camada sobre a janela durante o "segurar": círculo grande que segue o dedo
/// e a pílula do cadeado acima. Não recebe toques (o gesto continua no botão).
final class NCHoldOverlay: UIView {
  let halo2 = UIView() // [2026-10-16 motion-composer] anel externo, mais lento (Telegram)
  let halo = UIView()
  let circle = UIView()
  let mic = UIImageView()
  let lockPill = UIView()
  let lockIcon = UIImageView()
  let chevron = UIImageView()
  var origin: CGPoint = .zero

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = .clear
    halo.isUserInteractionEnabled = false
    halo2.isUserInteractionEnabled = false
    addSubview(halo2)
    addSubview(halo)
    addSubview(circle)
    mic.image = UIImage(systemName: "mic.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 28, weight: .semibold))
    mic.contentMode = .center
    circle.addSubview(mic)
    lockPill.layer.cornerRadius = 20
    lockPill.layer.borderWidth = 1
    lockPill.layer.shadowColor = UIColor.black.cgColor
    lockPill.layer.shadowOpacity = 0.12
    lockPill.layer.shadowRadius = 8
    lockPill.layer.shadowOffset = CGSize(width: 0, height: 2)
    addSubview(lockPill)
    lockIcon.image = UIImage(systemName: "lock.open.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
    lockIcon.contentMode = .center
    lockPill.addSubview(lockIcon)
    chevron.image = UIImage(systemName: "chevron.up", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .bold))
    chevron.contentMode = .center
    lockPill.addSubview(chevron)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func setup(origin o: CGPoint, theme: NCResolvedTheme) {
    origin = o
    let d: CGFloat = 92
    circle.bounds = CGRect(x: 0, y: 0, width: d, height: d)
    circle.layer.cornerRadius = d / 2
    circle.backgroundColor = theme.action
    mic.tintColor = theme.actionIcon
    mic.frame = circle.bounds
    halo.bounds = CGRect(x: 0, y: 0, width: d, height: d)
    halo.layer.cornerRadius = d / 2
    halo.backgroundColor = theme.action.withAlphaComponent(0.18)
    halo2.bounds = CGRect(x: 0, y: 0, width: d, height: d)
    halo2.layer.cornerRadius = d / 2
    halo2.backgroundColor = theme.action.withAlphaComponent(0.08)
    halo2.center = o
    lockPill.bounds = CGRect(x: 0, y: 0, width: 40, height: 78)
    lockPill.backgroundColor = theme.pill
    lockPill.layer.borderColor = theme.pillBorder.cgColor
    lockIcon.tintColor = theme.text
    chevron.tintColor = theme.icon
    lockIcon.frame = CGRect(x: 0, y: 8, width: 40, height: 26)
    chevron.frame = CGRect(x: 0, y: 40, width: 40, height: 26)
    circle.center = o
    halo.center = o
    lockPill.center = CGPoint(x: o.x, y: o.y - 64 - 39)
  }

  func update(dx: CGFloat, dy: CGFloat, lockProgress: CGFloat, level: Float) {
    var c = origin
    if abs(dx) > abs(dy) { c.x += min(0, dx) } else { c.y += min(0, dy) }
    circle.center = c
    halo.center = c
    halo2.center = c
    applyLevel(level, outer: level)
    lockPill.center = CGPoint(x: origin.x, y: origin.y - 64 - 39 + min(0, dy) * 0.35)
    chevron.alpha = 1 - lockProgress
    lockIcon.transform = CGAffineTransform(translationX: 0, y: lockProgress * 8)
  }

  /// [2026-10-16 motion-composer] Halo segue o volume (já suavizado no tick);
  /// anel externo cresce mais e responde mais devagar.
  func applyLevel(_ inner: Float, outer: Float) {
    let s = 1 + CGFloat(inner) * 0.55
    halo.transform = CGAffineTransform(scaleX: s, y: s)
    let s2 = 1 + CGFloat(outer) * 0.95
    halo2.transform = CGAffineTransform(scaleX: s2, y: s2)
  }
}

final class NCVoiceController: NSObject, UIGestureRecognizerDelegate, AVAudioRecorderDelegate, AVAudioPlayerDelegate {
  weak var host: ChatyyComposerView?
  weak var button: NCActionButton?
  var labels: [String: String] = [:] { didSet { applyLabels() } }

  private(set) var isActive = false
  private(set) var isLocked = false
  // [2026-10-18 voz-pausa] WhatsApp: travado → pausar (prévia ouvível) → continuar
  // gravando → enviar. Cada trecho gravado vira um arquivo (o m4a só fica
  // tocável depois do stop()); no envio com >1 trecho, junta num m4a só.
  private(set) var isPaused = false
  private var segments: [URL] = []
  private var segDurations: [TimeInterval] = []
  private var accumulated: CFTimeInterval = 0
  private var previewPlayer: AVAudioPlayer?
  private var previewIndex = 0
  private var previewTimer: Timer?

  private var recorder: AVAudioRecorder?
  private var fileURL: URL?
  private var startedAt: CFTimeInterval = 0
  private var samples: [Float] = []
  private var lastLevel: Float = 0
  // [2026-10-16 motion-composer] nível suavizado (ataque rápido, queda lenta)
  // só p/ o halo; samples/onda continuam com o valor cru (sem mudar o áudio).
  private var smoothLevel: Float = 0
  private var smoothOuter: Float = 0
  private var motionOn: Bool { return (host?.motion ?? true) && !UIAccessibility.isReduceMotionEnabled }
  private var link: CADisplayLink?
  private var startPoint: CGPoint = .zero
  private var lastDx: CGFloat = 0
  private var lockArmed = false
  private var overlay: NCHoldOverlay?
  private var theme = NCResolvedTheme()
  private var interruptionObs: NSObjectProtocol?
  private weak var holdGesture: UILongPressGestureRecognizer?

  // Painel no lugar do campo enquanto grava.
  let panel = UIView()
  private let dot = UIView()
  private let timeLabel = UILabel()
  private let slideLabel = UILabel()
  private let waveform = NCWaveformView(frame: .zero)
  private let trashButton = UIButton(type: .system)
  private let pauseButton = UIButton(type: .system)   // [voz-pausa] pausar ⇄ continuar (mic)
  private let playButton = UIButton(type: .system)    // [voz-pausa] prévia play/pause (só pausado)

  private let cancelDistance: CGFloat = 120
  private let lockDistance: CGFloat = 84
  private let maxDurationSec: CFTimeInterval = 15 * 60

  init(host: ChatyyComposerView) {
    self.host = host
    super.init()
    panel.isHidden = true
    panel.alpha = 0
    panel.clipsToBounds = true
    dot.layer.cornerRadius = 5
    panel.addSubview(dot)
    timeLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 16, weight: .regular)
    timeLabel.text = "0:00"
    panel.addSubview(timeLabel)
    slideLabel.font = UIFont.systemFont(ofSize: 15)
    slideLabel.textAlignment = .center
    panel.addSubview(slideLabel)
    panel.addSubview(waveform)
    trashButton.setImage(UIImage(systemName: "trash", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular)), for: .normal)
    trashButton.addTarget(self, action: #selector(trashTapped), for: .touchUpInside)
    panel.addSubview(trashButton)
    pauseButton.addTarget(self, action: #selector(pauseTapped), for: .touchUpInside)
    pauseButton.isHidden = true
    panel.addSubview(pauseButton)
    playButton.addTarget(self, action: #selector(playTapped), for: .touchUpInside)
    playButton.isHidden = true
    panel.addSubview(playButton)
    refreshPauseIcons()
    applyLabels()
  }

  deinit {
    link?.invalidate()
    previewTimer?.invalidate()
    if let o = interruptionObs { NotificationCenter.default.removeObserver(o) }
  }

  func attach(to b: NCActionButton) {
    button = b
    let lp = UILongPressGestureRecognizer(target: self, action: #selector(handleHold(_:)))
    lp.minimumPressDuration = 0.16
    lp.allowableMovement = .greatestFiniteMagnitude
    lp.delegate = self
    b.addGestureRecognizer(lp)
    holdGesture = lp
  }

  func applyTheme(_ t: NCResolvedTheme, dark: Bool) {
    theme = t
    panel.backgroundColor = t.surface
    dot.backgroundColor = t.recording
    timeLabel.textColor = t.text
    slideLabel.textColor = t.secondaryText
    waveform.barColor = isPaused ? t.secondaryText : t.text
    waveform.playedColor = t.accent
    trashButton.tintColor = t.recording
    pauseButton.tintColor = t.recording
    playButton.tintColor = t.text
  }

  private func applyLabels() {
    let slide = labels["slideToCancel"] ?? "Slide to cancel"
    slideLabel.text = "‹  " + slide
    trashButton.accessibilityLabel = labels["deleteRecording"] ?? labels["cancelRecording"]
    panel.accessibilityLabel = labels["recording"]
    pauseButton.accessibilityLabel = isPaused
      ? (labels["resumeRecording"] ?? "Continuar gravação")
      : (labels["pauseRecording"] ?? "Pausar gravação")
    let previewing = previewPlayer?.isPlaying ?? false
    playButton.accessibilityLabel = previewing
      ? (labels["pausePreview"] ?? "Pausar")
      : (labels["playPreview"] ?? "Ouvir gravação")
  }

  /// [voz-pausa] Ícones dos botões do painel travado conforme o estado.
  private func refreshPauseIcons() {
    let cfg = UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)
    pauseButton.setImage(UIImage(systemName: isPaused ? "mic.fill" : "pause.fill", withConfiguration: cfg), for: .normal)
    let previewing = previewPlayer?.isPlaying ?? false
    let pcfg = UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)
    playButton.setImage(UIImage(systemName: previewing ? "pause.fill" : "play.fill", withConfiguration: pcfg), for: .normal)
    applyLabels()
  }

  func layoutPanel(in bar: UIView, frame: CGRect) {
    if panel.superview !== bar { bar.addSubview(panel) }
    panel.frame = frame
    let h = frame.height
    if isLocked {
      trashButton.isHidden = false
      trashButton.frame = CGRect(x: 0, y: 0, width: 44, height: h)
      pauseButton.isHidden = false
      pauseButton.frame = CGRect(x: max(0, frame.width - 44), y: 0, width: 44, height: h)
      let waveRight = max(0, frame.width - 44 - 4)
      if isPaused {
        // [voz-pausa] [lixeira] [play] 0:07 [onda inteira] [mic = continuar]
        dot.isHidden = true
        playButton.isHidden = false
        playButton.frame = CGRect(x: 44, y: 0, width: 40, height: h)
        timeLabel.frame = CGRect(x: 86, y: 0, width: 50, height: h)
        waveform.isHidden = false
        waveform.frame = CGRect(x: 138, y: 8, width: max(0, waveRight - 138), height: h - 16)
      } else {
        dot.isHidden = false
        playButton.isHidden = true
        dot.frame = CGRect(x: 48, y: (h - 10) / 2, width: 10, height: 10)
        timeLabel.frame = CGRect(x: 64, y: 0, width: 56, height: h)
        waveform.isHidden = false
        waveform.frame = CGRect(x: 124, y: 8, width: max(0, waveRight - 124), height: h - 16)
      }
      slideLabel.isHidden = true
    } else {
      trashButton.isHidden = true
      pauseButton.isHidden = true
      playButton.isHidden = true
      dot.isHidden = false
      dot.frame = CGRect(x: 14, y: (h - 10) / 2, width: 10, height: 10)
      timeLabel.frame = CGRect(x: 32, y: 0, width: 56, height: h)
      waveform.isHidden = true
      slideLabel.isHidden = false
      let sx: CGFloat = 92
      slideLabel.frame = CGRect(x: sx + min(0, lastDx) * 0.6, y: 0, width: max(0, frame.width - sx), height: h)
    }
  }

  // MARK: Gesture

  func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    guard let host = host, let b = button else { return false }
    return b.mode == .mic && !isActive && host.voiceEnabled && !host.disabled
  }

  private func abortGesture() {
    holdGesture?.isEnabled = false
    holdGesture?.isEnabled = true
  }

  @objc private func handleHold(_ g: UILongPressGestureRecognizer) {
    guard let host = host else { return }
    let p = g.location(in: nil)
    switch g.state {
    case .began:
      if host.voiceBlocked {
        host.emitVoiceState("blocked")
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        abortGesture()
        return
      }
      let session = AVAudioSession.sharedInstance()
      switch session.recordPermission {
      case .granted:
        break
      case .denied:
        host.emitVoiceState("error", reason: "permission")
        abortGesture()
        return
      default:
        // 1ª vez: pede e NÃO grava neste toque (o dedo já saiu quando o alerta fecha).
        session.requestRecordPermission { granted in
          DispatchQueue.main.async {
            self.host?.emitVoiceState(granted ? "permissionGranted" : "error", reason: granted ? nil : "permission")
          }
        }
        abortGesture()
        return
      }
      do {
        try startRecording()
      } catch {
        host.emitVoiceState("error", reason: "start")
        abortGesture()
        return
      }
      startPoint = p
      lastDx = 0
      lockArmed = false
      isActive = true
      isLocked = false
      showOverlay()
      showPanel()
      host.voiceDidChangeActive()
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      host.emitVoiceState("recording")
    case .changed:
      guard isActive, !isLocked else { return }
      let dx = p.x - startPoint.x
      let dy = p.y - startPoint.y
      lastDx = dx
      let lockProgress = max(0, min(1, -dy / lockDistance))
      overlay?.update(dx: dx, dy: dy, lockProgress: lockProgress, level: motionOn ? smoothLevel : lastLevel)
      if motionOn { overlay?.applyLevel(smoothLevel, outer: smoothOuter) }
      let cancelProgress = max(0, min(1, -dx / cancelDistance))
      slideLabel.alpha = 1 - cancelProgress * 0.85
      if let bar = panel.superview { layoutPanel(in: bar, frame: panel.frame) }
      if lockProgress > 0.6 && !lockArmed {
        lockArmed = true
        UISelectionFeedbackGenerator().selectionChanged()
      } else if lockProgress < 0.4 {
        lockArmed = false
      }
      if dx <= -cancelDistance {
        cancel(reason: "slide")
        abortGesture()
      } else if dy <= -lockDistance {
        lock()
      }
    case .ended:
      guard isActive, !isLocked else { return }
      finish(send: true)
    case .cancelled, .failed:
      guard isActive, !isLocked else { return }
      cancel(reason: "gesture")
    default:
      break
    }
  }

  func tapWithoutHold() {
    guard let host = host else { return }
    if host.voiceBlocked {
      host.emitVoiceState("blocked")
      return
    }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    host.emitVoiceState("tapHint")
  }

  // MARK: Recording

  private func startRecording() throws {
    segments.removeAll()
    segDurations.removeAll()
    accumulated = 0
    isPaused = false
    samples.removeAll()
    lastLevel = 0
    smoothLevel = 0
    smoothOuter = 0
    waveform.reset()
    try startSegment()
  }

  /// [2026-10-18 voz-pausa] Um trecho novo: início da gravação ou "continuar"
  /// depois de pausar. Cada trecho = um m4a próprio (tocável após o stop()).
  private func startSegment() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
    try session.setActive(true)
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
    let url = dir.appendingPathComponent("voice_\(UUID().uuidString).m4a")
    let settings: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: 24000,
      AVNumberOfChannelsKey: 1,
      AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
      AVEncoderBitRateKey: 32000,
    ]
    let r = try AVAudioRecorder(url: url, settings: settings)
    r.isMeteringEnabled = true
    r.delegate = self
    guard r.prepareToRecord(), r.record() else {
      if segments.isEmpty { deactivateSession() }
      throw NSError(domain: "ChatyyComposer", code: 2, userInfo: [NSLocalizedDescriptionKey: "record() failed"])
    }
    recorder = r
    fileURL = url
    startedAt = CACurrentMediaTime()
    link?.invalidate()
    let l = CADisplayLink(target: NCVoiceTick(self), selector: #selector(NCVoiceTick.tick))
    l.preferredFramesPerSecond = 30
    l.add(to: .main, forMode: .common)
    link = l
    if interruptionObs == nil {
      interruptionObs = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
        self?.handleInterruption()
      }
    }
  }

  /// Ligação/Siri no meio: segurando = cancela (como antes); travado = PAUSA e
  /// guarda o que já foi gravado (WhatsApp).
  private func handleInterruption() {
    guard isActive else { return }
    if isLocked {
      if isPaused {
        stopPreview()
      } else {
        pause()
      }
    } else {
      cancel(reason: "interrupted")
    }
  }

  fileprivate func tick() {
    guard let r = recorder, isActive else { return }
    r.updateMeters()
    let db = r.averagePower(forChannel: 0)
    let level = max(0, min(1, (db + 50) / 50))
    lastLevel = level
    samples.append(level)
    if isLocked { waveform.push(level) }
    let elapsed = accumulated + (CACurrentMediaTime() - startedAt)
    let secs = Int(elapsed)
    timeLabel.text = String(format: "%d:%02d", secs / 60, secs % 60)
    if !isLocked, let o = overlay {
      if motionOn {
        smoothLevel += (level - smoothLevel) * (level > smoothLevel ? 0.55 : 0.18)
        smoothOuter += (level - smoothOuter) * (level > smoothOuter ? 0.30 : 0.08)
        let a = smoothLevel, b = smoothOuter
        // Interpola entre os ticks (30 Hz) → halo liso a 60/120 Hz.
        UIView.animate(withDuration: 1.0 / 30.0, delay: 0, options: [.beginFromCurrentState, .curveLinear, .allowUserInteraction], animations: {
          o.applyLevel(a, outer: b)
        }, completion: nil)
      } else {
        let s = 1 + CGFloat(level) * 0.55
        o.halo.transform = CGAffineTransform(scaleX: s, y: s)
      }
    }
    if elapsed >= maxDurationSec { finish(send: true) }
  }

  /// Fecha o trecho atual (arquivo fica tocável) e soma a duração dele.
  private func stopSegment() {
    link?.invalidate()
    link = nil
    guard let r = recorder else { return }
    let d = CACurrentMediaTime() - startedAt
    accumulated += d
    r.stop()
    recorder = nil
    if let u = fileURL {
      segments.append(u)
      segDurations.append(d)
    }
    fileURL = nil
  }

  private func stopRecorder() -> (urls: [URL], durationMs: Int) {
    stopPreview()
    stopSegment()
    deactivateSession()
    let urls = segments
    let durationMs = Int(accumulated * 1000)
    segments.removeAll()
    segDurations.removeAll()
    accumulated = 0
    return (urls, durationMs)
  }

  private func deactivateSession() {
    do {
      try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    } catch {}
  }

  func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self, self.isActive else { return }
      self.host?.emitVoiceState("error", reason: "encoder")
      self.cancel(reason: "encoder", silent: true)
    }
  }

  func finish(send: Bool) {
    guard isActive else { return }
    let (urls, durationMs) = stopRecorder()
    let snapshot = samples
    teardownUI()
    if urls.isEmpty { return }
    if !send {
      NCVoiceController.removeFiles(urls)
      return
    }
    if durationMs < 1000 {
      NCVoiceController.removeFiles(urls)
      UINotificationFeedbackGenerator().notificationOccurred(.warning)
      host?.emitVoiceState("tooShort")
      return
    }
    if urls.count == 1 {
      deliver(urls[0], durationMs: durationMs, snapshot: snapshot)
      return
    }
    // [voz-pausa] >1 trecho (pausou e continuou) → um m4a só antes de entregar.
    NCVoiceController.merge(urls) { [weak self] merged in
      NCVoiceController.removeFiles(urls)
      guard let self = self else {
        if let m = merged { try? FileManager.default.removeItem(at: m) }
        return
      }
      guard let m = merged else {
        self.host?.emitVoiceState("error", reason: "merge")
        return
      }
      self.deliver(m, durationMs: durationMs, snapshot: snapshot)
    }
  }

  private func deliver(_ fileUrl: URL, durationMs: Int, snapshot: [Float]) {
    var size = 0
    if let attrs = try? FileManager.default.attributesOfItem(atPath: fileUrl.path), let n = attrs[.size] as? NSNumber {
      size = n.intValue
    }
    if size < 1500 {
      try? FileManager.default.removeItem(at: fileUrl)
      host?.emitVoiceState("error", reason: "empty")
      return
    }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    host?.emitVoiceRecorded([
      "uri": fileUrl.absoluteString,
      "durationMs": durationMs,
      "sizeBytes": size,
      "waveform": NCVoiceController.resample(snapshot, bars: 40).map { Double($0) },
      "mimeType": "audio/mp4",
      "name": "audio_\(Int(Date().timeIntervalSince1970 * 1000)).m4a",
    ])
    host?.emitVoiceState("sent")
  }

  private static func removeFiles(_ urls: [URL]) {
    for u in urls { try? FileManager.default.removeItem(at: u) }
  }

  /// Junta os trechos (mesmo perfil AAC) num m4a só. Conclusão na main.
  private static func merge(_ urls: [URL], completion: @escaping (URL?) -> Void) {
    let comp = AVMutableComposition()
    guard let track = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
      completion(nil)
      return
    }
    var cursor = CMTime.zero
    for u in urls {
      let asset = AVURLAsset(url: u, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
      guard let src = asset.tracks(withMediaType: .audio).first else { continue }
      let range = src.timeRange
      guard range.duration.isValid, CMTimeGetSeconds(range.duration) > 0.02 else { continue }
      do {
        try track.insertTimeRange(range, of: src, at: cursor)
        cursor = CMTimeAdd(cursor, range.duration)
      } catch {
        continue
      }
    }
    guard CMTimeCompare(cursor, .zero) > 0,
          let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetAppleM4A) else {
      completion(nil)
      return
    }
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
    let out = dir.appendingPathComponent("voice_\(UUID().uuidString).m4a")
    ex.outputURL = out
    ex.outputFileType = .m4a
    ex.exportAsynchronously {
      let ok = ex.status == .completed
      DispatchQueue.main.async {
        if !ok { try? FileManager.default.removeItem(at: out) }
        completion(ok ? out : nil)
      }
    }
  }

  func finishLocked() {
    guard isActive, isLocked else { return }
    finish(send: true)
  }

  func cancel(reason: String, silent: Bool = false) {
    guard isActive else { return }
    let (urls, _) = stopRecorder()
    NCVoiceController.removeFiles(urls)
    teardownUI()
    if !silent && reason != "unmount" && reason != "js" {
      UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
    if reason != "unmount" { host?.emitVoiceState("cancelled", reason: reason) }
  }

  @objc private func trashTapped() {
    cancel(reason: "trash")
  }

  // MARK: Pausa / prévia (travado) — [2026-10-18 voz-pausa]

  @objc private func pauseTapped() {
    if isPaused { resume() } else { pause() }
  }

  private func pause() {
    guard isActive, isLocked, !isPaused else { return }
    stopSegment()
    isPaused = true
    dot.layer.removeAnimation(forKey: "blink")
    waveform.barColor = theme.secondaryText
    waveform.setStatic(samples)
    setTimeLabel(accumulated)
    refreshPauseIcons()
    if let bar = panel.superview { layoutPanel(in: bar, frame: panel.frame) }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    host?.emitVoiceState("paused")
  }

  private func resume() {
    guard isActive, isLocked, isPaused else { return }
    stopPreview()
    do {
      try startSegment()
    } catch {
      // Continua pausado: o que já foi gravado segue enviável.
      host?.emitVoiceState("error", reason: "start")
      return
    }
    isPaused = false
    waveform.reset()
    waveform.barColor = theme.text
    for s in samples.suffix(120) { waveform.push(s) }
    startBlink()
    refreshPauseIcons()
    if let bar = panel.superview { layoutPanel(in: bar, frame: panel.frame) }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    host?.emitVoiceState("resumed")
  }

  @objc private func playTapped() {
    guard isActive, isPaused else { return }
    if let p = previewPlayer {
      if p.isPlaying {
        p.pause()
        previewTimer?.invalidate()
        previewTimer = nil
      } else {
        p.play()
        startPreviewTimer()
      }
      refreshPauseIcons()
      return
    }
    playSegment(0)
  }

  private func playSegment(_ i: Int) {
    guard i < segments.count else {
      stopPreview()
      return
    }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
      try session.setActive(true)
      let p = try AVAudioPlayer(contentsOf: segments[i])
      p.delegate = self
      p.prepareToPlay()
      previewPlayer = p
      previewIndex = i
      p.play()
      startPreviewTimer()
      refreshPauseIcons()
    } catch {
      stopPreview()
    }
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self, player === self.previewPlayer else { return }
      let next = self.previewIndex + 1
      if flag && next < self.segments.count {
        self.playSegment(next)
      } else {
        self.stopPreview()
      }
    }
  }

  private func startPreviewTimer() {
    previewTimer?.invalidate()
    let t = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
      self?.previewTick()
    }
    RunLoop.main.add(t, forMode: .common)
    previewTimer = t
  }

  private func previewTick() {
    guard let p = previewPlayer else { return }
    var played: TimeInterval = 0
    let upto = min(previewIndex, segDurations.count)
    for j in 0..<upto { played += segDurations[j] }
    played += p.currentTime
    let total = max(0.001, accumulated)
    waveform.progress = CGFloat(min(1, played / total))
    setTimeLabel(played)
  }

  private func stopPreview() {
    previewTimer?.invalidate()
    previewTimer = nil
    if let p = previewPlayer {
      p.delegate = nil
      p.stop()
    }
    previewPlayer = nil
    previewIndex = 0
    if isPaused {
      waveform.progress = 0
      setTimeLabel(accumulated)
    }
    refreshPauseIcons()
  }

  private func setTimeLabel(_ t: TimeInterval) {
    let secs = max(0, Int(t))
    timeLabel.text = String(format: "%d:%02d", secs / 60, secs % 60)
  }

  private func lock() {
    guard isActive, !isLocked else { return }
    isLocked = true
    UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
    if let o = overlay {
      overlay = nil
      o.lockIcon.image = UIImage(systemName: "lock.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
      UIView.animate(withDuration: 0.2, animations: {
        o.alpha = 0
        o.circle.transform = CGAffineTransform(scaleX: 0.5, y: 0.5)
      }, completion: { _ in o.removeFromSuperview() })
    }
    // Onda com o histórico já gravado.
    waveform.reset()
    for s in samples.suffix(120) { waveform.push(s) }
    refreshPauseIcons()
    if let bar = panel.superview { layoutPanel(in: bar, frame: panel.frame) }
    host?.voiceDidLock()
    host?.emitVoiceState("locked")
  }

  // MARK: UI

  private func showOverlay() {
    guard let b = button, let win = b.window else { return }
    let o = NCHoldOverlay(frame: win.bounds)
    o.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    let center = b.convert(CGPoint(x: b.bounds.midX, y: b.bounds.midY), to: win)
    o.setup(origin: center, theme: theme)
    win.addSubview(o)
    overlay = o
    o.circle.transform = CGAffineTransform(scaleX: 0.45, y: 0.45)
    o.halo.alpha = 0
    o.halo2.alpha = 0
    o.halo2.isHidden = !motionOn
    o.lockPill.alpha = 0
    o.lockPill.transform = CGAffineTransform(translationX: 0, y: 24)
    UIView.animate(withDuration: 0.36, delay: 0, usingSpringWithDamping: 0.62, initialSpringVelocity: 0.4,
                   options: [.beginFromCurrentState], animations: {
      o.circle.transform = .identity
      o.halo.alpha = 1
      o.halo2.alpha = 1
      o.lockPill.alpha = 1
      o.lockPill.transform = .identity
    }, completion: nil)
  }

  private func showPanel() {
    panel.isHidden = false
    slideLabel.alpha = 1
    timeLabel.text = "0:00"
    startBlink()
    // [2026-10-16 motion-composer] seta/texto "deslize p/ cancelar" cutuca p/
    // a esquerda (Telegram). Só a camada de apresentação: o frame que segue o
    // dedo (layoutPanel) não muda.
    slideLabel.layer.removeAnimation(forKey: "nudge")
    if motionOn {
      let nudge = CABasicAnimation(keyPath: "transform.translation.x")
      nudge.fromValue = 0
      nudge.toValue = -7
      nudge.duration = 0.75
      nudge.autoreverses = true
      nudge.repeatCount = .infinity
      nudge.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      nudge.isAdditive = true
      slideLabel.layer.add(nudge, forKey: "nudge")
    }
    panel.transform = CGAffineTransform(translationX: 24, y: 0)
    UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .curveEaseOut], animations: {
      self.panel.alpha = 1
      self.panel.transform = .identity
    }, completion: nil)
  }

  /// Ponto vermelho piscando (gravando).
  private func startBlink() {
    dot.layer.removeAnimation(forKey: "blink")
    let blink = CABasicAnimation(keyPath: "opacity")
    blink.fromValue = 1
    blink.toValue = 0.15
    blink.duration = 0.55
    blink.autoreverses = true
    blink.repeatCount = .infinity
    dot.layer.add(blink, forKey: "blink")
  }

  private func teardownUI() {
    let wasActive = isActive
    isActive = false
    isLocked = false
    isPaused = false
    lastDx = 0
    waveform.barColor = theme.text
    refreshPauseIcons()
    if let o = overlay {
      overlay = nil
      UIView.animate(withDuration: 0.18, animations: {
        o.alpha = 0
        o.circle.transform = CGAffineTransform(scaleX: 0.4, y: 0.4)
      }, completion: { _ in o.removeFromSuperview() })
    }
    dot.layer.removeAnimation(forKey: "blink")
    slideLabel.layer.removeAnimation(forKey: "nudge")
    UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState], animations: {
      self.panel.alpha = 0
    }, completion: { _ in
      if !self.isActive { self.panel.isHidden = true }
    })
    if wasActive {
      host?.voiceDidEnd()
      host?.voiceDidChangeActive()
    }
  }

  static func resample(_ src: [Float], bars: Int) -> [Float] {
    guard !src.isEmpty, bars > 0 else { return [] }
    if src.count <= bars {
      return src.map { max(0.04, min(1, $0)) }
    }
    var out: [Float] = []
    out.reserveCapacity(bars)
    let step = Double(src.count) / Double(bars)
    for i in 0..<bars {
      let a = Int(Double(i) * step)
      let b = max(a + 1, min(src.count, Int(Double(i + 1) * step)))
      var peak: Float = 0
      for j in a..<b { peak = max(peak, src[j]) }
      out.append(max(0.04, min(1, peak)))
    }
    return out
  }
}

final class NCVoiceTick: NSObject {
  weak var owner: NCVoiceController?
  init(_ o: NCVoiceController) { owner = o }
  @objc func tick() { owner?.tick() }
}
